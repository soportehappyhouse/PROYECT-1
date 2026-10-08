import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import websocket from "@fastify/websocket";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { nanoid } from "nanoid";
import { validateEditPlan, type AgentPlanRecord } from "@studio/shared";
import { z } from "zod";
import { REPO_ROOT } from "../config.js";
import {
  CLAUDE_INSTALL_COMMAND,
  CLAUDE_LOGIN_COMMAND,
  detectClaude,
  type ClaudeInfo,
} from "../console/detect.js";
import { consoleEnv } from "../console/env.js";
import { renderProjectFrame } from "../console/frame.js";
import { ConsoleManager, type ConsoleSocket, type SpawnPty } from "../console/sessions.js";
import { isAllowedOrigin } from "../lib/cors.js";
import { errorBody, HttpError } from "../lib/errors.js";
import { resolvePlan } from "../services/agent/resolve.js";

/**
 * Sprint 3b — Consola Claude (docs/trabajo/sprint3b-contratos.md §A): the Claude Code CLI runs in a
 * PTY inside Studio with the user's Claude.ai subscription (no API key). Loopback only.
 *
 *   GET  /api/console/status            → ConsoleStatus (claude found? version, login)
 *   POST /api/console/session {cols?, rows?} → {token, cwd, claudeInstalled, version, …}
 *   GET  /api/console/ws?token=         → WebSocket (JSON frames, see console/sessions.ts)
 *   POST /api/console/resize {token?, cols, rows}
 *   DELETE /api/console/session/:token  → kills the process
 *   POST /api/console/plans {plan, projectId?, command?, cursor?, save?} → validates + resolves an
 *        EditPlan written by Claude; with save (default) it is stored as an Assistant plan
 *        (status proposed) and applied with POST /api/agent/apply like any other plan
 *   GET  /api/projects/:id/frame?t=&format=json|png → PNG of the project at t (studio-mcp)
 */
export const CONSOLE_ROUTES = {
  status: "/api/console/status",
  session: "/api/console/session",
  sessionItem: "/api/console/session/:token",
  ws: "/api/console/ws",
  resize: "/api/console/resize",
  plans: "/api/console/plans",
  frame: "/api/projects/:id/frame",
} as const;

export interface ConsoleStatus {
  claudeInstalled: boolean;
  version: string | null;
  loggedIn: boolean | null;
  authMethod: string | null;
  bin: string | null;
  cwd: string;
  /** Absolute STORAGE_DIR (studio-mcp turns relative media paths into absolute ones). */
  storageDir: string;
  /** .mcp.json at the repo root and packages/studio-mcp/dist/index.js built. */
  mcpReady: boolean;
  installCommand: string;
  loginCommand: string;
}

export interface ConsoleRoutesOptions {
  /** Tests: replaces node-pty. */
  spawn?: SpawnPty;
  /** Tests: environment used to find `claude` (default process.env). */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/** 127.0.0.0/8, ::1 and IPv4-mapped loopback. */
export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.replace(/^::ffff:/i, "");
  return a === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

const SessionBody = z
  .object({
    cols: z.number().int().min(20).max(500).optional(),
    rows: z.number().int().min(5).max(200).optional(),
  })
  .default({});
const ResizeBody = z.object({
  token: z.string().min(10).optional(),
  cols: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(200),
});
const PlanBody = z.object({
  plan: z.unknown(),
  projectId: z.string().min(1).optional(),
  command: z.string().max(2000).optional(),
  cursor: z.number().min(0).optional(),
  save: z.boolean().default(true),
});
const FrameQuery = z.object({
  t: z.coerce.number().min(0).default(0),
  format: z.enum(["png", "json"]).default("png"),
});

export const consoleRoutes: FastifyPluginAsync<ConsoleRoutesOptions> = async (app, opts) => {
  const ctx = app.ctx;
  const cwd = opts.cwd ?? REPO_ROOT;
  const baseEnv = () => opts.env ?? process.env;
  const childEnv = () =>
    consoleEnv(baseEnv(), {
      STUDIO_API_URL: `http://127.0.0.1:${ctx.config.port}`,
      STUDIO_CONSOLE: "1",
    });
  const detect = (force = false): Promise<ClaudeInfo> =>
    detectClaude({ env: consoleEnv(baseEnv()), force });

  const manager = new ConsoleManager({
    cwd,
    env: childEnv,
    detect: () => detect(),
    ...(opts.spawn && { spawn: opts.spawn }),
    log: (msg, extra) => app.log.info(extra ?? {}, msg),
  });

  const mcpReady = () =>
    existsSync(path.join(cwd, ".mcp.json")) &&
    existsSync(path.join(cwd, "packages", "studio-mcp", "dist", "index.js"));

  const status = async (force = false): Promise<ConsoleStatus> => {
    const c = await detect(force);
    return {
      claudeInstalled: c.installed,
      version: c.version ?? null,
      loggedIn: c.loggedIn,
      authMethod: c.authMethod ?? null,
      bin: c.bin ?? null,
      cwd,
      storageDir: ctx.config.storageDir,
      mcpReady: mcpReady(),
      installCommand: CLAUDE_INSTALL_COMMAND,
      loginCommand: CLAUDE_LOGIN_COMMAND,
    };
  };

  /** Loopback only + (when the browser sends one) an allowed Origin. */
  const guard = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isLoopback(req.socket.remoteAddress))
      return reply
        .code(403)
        .send(
          errorBody("CONSOLE_LOOPBACK_ONLY", "La Consola Claude solo acepta conexiones locales"),
        );
    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(ctx.config, origin))
      return reply
        .code(403)
        .send(errorBody("CONSOLE_ORIGIN", "Origen no permitido para la Consola Claude"));
  };

  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
  app.addHook("onClose", async () => manager.closeAll());

  app.get(CONSOLE_ROUTES.status, { preHandler: guard }, async (req) => {
    const q = req.query as { refresh?: string };
    return status(q.refresh === "1" || q.refresh === "true");
  });

  app.post(CONSOLE_ROUTES.session, { preHandler: guard }, async (req, reply) => {
    const body = SessionBody.parse(req.body ?? {});
    const st = await status(true);
    const s = manager.create(body);
    return reply.code(201).send({ token: s.token, cols: s.cols, rows: s.rows, ...st });
  });

  app.delete<{ Params: { token: string } }>(
    CONSOLE_ROUTES.sessionItem,
    { preHandler: guard },
    async (req) => {
      manager.close(req.params.token, "Sesión cerrada");
      return { closed: true };
    },
  );

  app.post(CONSOLE_ROUTES.resize, { preHandler: guard }, async (req) => {
    const body = ResizeBody.parse(req.body);
    const s = manager.resize(body.token, body.cols, body.rows);
    if (!s) throw new HttpError(404, "CONSOLE_NO_SESSION", "No hay una sesión de consola abierta");
    return { ok: true, cols: s.cols, rows: s.rows };
  });

  app.get(CONSOLE_ROUTES.ws, { websocket: true, preValidation: guard }, (socket, req) => {
    const token = (req.query as { token?: string }).token ?? "";
    void manager.attach(token, socket as unknown as ConsoleSocket);
  });

  app.post(CONSOLE_ROUTES.plans, { preHandler: guard }, async (req, reply) => {
    const body = PlanBody.parse(req.body);
    const { repos, workers } = ctx;
    const projectId = body.projectId ?? repos.projects.list()[0]?.id ?? "";
    const project = repos.projects.get(projectId);
    if (!project) return reply.code(404).send(errorBody("NOT_FOUND", "Proyecto no encontrado"));
    const validation = validateEditPlan(body.plan);
    if (!validation.ok)
      return reply.code(400).send({
        ...errorBody("PLAN_INVALID", "El plan no es válido", { errors: validation.errors }),
        ok: false,
        errors: validation.errors,
      });
    const packs = await workers.packs().catch(() => undefined);
    const r = resolvePlan(validation.plan, {
      project,
      media: (id) => repos.media.get(id),
      ...(body.cursor !== undefined && { cursor: body.cursor }),
      presets: repos.presets.list(),
      assets: repos.media.list({ limit: 500 }),
      ...(packs && { packs }),
    });
    const record: AgentPlanRecord = {
      id: nanoid(),
      projectId,
      command: body.command?.trim() || `Consola Claude: ${validation.plan.summary_es}`,
      status: "proposed",
      created_at: new Date().toISOString(),
      model: "claude-code",
      route: null,
      latency_ms: null,
      attempts: null,
      warnings: [],
      ok: r.unresolved.length === 0 && validation.plan.ops.length > 0,
      plan: validation.plan,
      added: [],
      choices: [],
      ...r,
      errors: [],
    };
    if (!body.save) return { ...record, id: null, saved: false };
    repos.agentPlans.insert(record);
    req.log.info({ plan: record.id, ok: record.ok }, "Plan de la Consola Claude guardado");
    return reply.code(201).send({ ...record, saved: true });
  });

  app.get<{ Params: { id: string } }>(CONSOLE_ROUTES.frame, async (req, reply) => {
    const q = FrameQuery.parse(req.query);
    const project = ctx.repos.projects.get(req.params.id);
    if (!project) return reply.code(404).send(errorBody("NOT_FOUND", "Proyecto no encontrado"));
    let frame;
    try {
      frame = await renderProjectFrame(ctx, project, q.t);
    } catch (err) {
      throw new HttpError(
        422,
        "FRAME_FAILED",
        err instanceof Error ? err.message.split("\n")[0]! : String(err),
      );
    }
    if (q.format === "json") return frame;
    return reply
      .header("content-type", "image/png")
      .header("x-studio-frame-path", encodeURIComponent(frame.path))
      .header("x-studio-frame-method", frame.method)
      .send(createReadStream(frame.path));
  });
};

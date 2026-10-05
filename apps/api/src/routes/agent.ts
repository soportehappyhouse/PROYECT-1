import os from "node:os";
import {
  AGENT_DEFAULT_MODEL,
  AGENT_LLM_PACK_ID,
  AgentApplyRequestSchema,
  AgentBugreportRequestSchema,
  AgentEvalRequestSchema,
  AgentPlanRequestSchema,
  API_ROUTES,
  PACK_REQUIRED,
  validateEditPlan,
  type AgentBugreportResponse,
  type AgentPlanRecord,
  type AgentStatus,
  type Pack,
} from "@studio/shared";
import type { FastifyPluginAsync } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import { appendToReport, readAgentEval } from "../jobs/handlers/agent.js";
import { errorBody, HttpError, PackRequiredError } from "../lib/errors.js";
import { resolvePlan } from "../services/agent/resolve.js";
import { buildProjectSummary } from "../services/agent/summary.js";
import { WorkersError } from "../services/workers-client.js";

/** Spanish hint shown when the local LLM is missing (Ollama + model, decision 8: local only). */
export function ollamaHint(model = AGENT_DEFAULT_MODEL): string {
  return (
    `Falta el asistente local: instalá Ollama (winget install Ollama.Ollama, o https://ollama.com), ` +
    `abrilo y descargá el modelo «${model}» (≈5 GB) desde Ajustes → Paquetes («Asistente local»). ` +
    `Todo corre en tu PC, sin API key.`
  );
}

/** PACK_REQUIRED for `agent-llm` with the Ollama instructions as message. */
export function agentPackRequired(
  packs: readonly Pack[] | undefined,
  model?: string,
): PackRequiredError {
  const pack = packs?.find((p) => p.id === AGENT_LLM_PACK_ID);
  const err = new PackRequiredError(
    AGENT_LLM_PACK_ID,
    pack?.name_es ?? `Asistente local (${model ?? AGENT_DEFAULT_MODEL})`,
    pack?.size_bytes ?? 5.2e9,
  );
  err.message = ollamaHint(model);
  return err;
}

const isOllamaError = (err: WorkersError) =>
  /ollama|llm|model.*(not found|missing)|modelo/i.test(`${err.code} ${err.message}`) &&
  err.statusCode !== 422;

function bugreportTemplate(req: {
  title?: string;
  steps_text: string;
  breadcrumbs: unknown[];
  errors: unknown[];
}): string {
  const steps = req.steps_text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const crumbs = req.breadcrumbs
    .slice(-8)
    .map((b) =>
      b && typeof b === "object" && "message" in b
        ? String((b as { message: unknown }).message)
        : JSON.stringify(b),
    );
  const errors = req.errors
    .slice(-5)
    .map((e) =>
      e && typeof e === "object" && "message" in e
        ? String((e as { message: unknown }).message)
        : JSON.stringify(e),
    );
  return [
    `## ${req.title?.trim() || "Problema en Studio"}`,
    "",
    "### Pasos para reproducir",
    ...(steps.length
      ? steps.map((s, i) => `${i + 1}. ${s.replace(/^\d+[.)]\s*/, "")}`)
      : ["1. (completar)"]),
    "",
    "### Qué esperaba",
    "(completar)",
    "",
    "### Qué pasó",
    ...(errors.length ? errors.map((e) => `- ${e}`) : ["(completar)"]),
    ...(crumbs.length ? ["", "### Últimas acciones", ...crumbs.map((c) => `- ${c}`)] : []),
    "",
  ].join("\n");
}

/**
 * Sprint 3 routes (/api/agent/*, docs/trabajo/sprint3-contratos.md): the local LLM (workers +
 * Ollama) proposes an EditPlan; the api validates it (zod, Spanish errors), resolves clip/time
 * references against the project, stores it (agent_plans) and applies the confirmed ops with the
 * job agent.apply (undo snapshot). Nothing leaves the PC.
 */
export const agentRoutes: FastifyPluginAsync = async (app) => {
  const { workers, queue, repos, config } = app.ctx;
  const notFound = () => errorBody("NOT_FOUND", "Plan no encontrado");

  app.post(API_ROUTES.agentPlan, async (req, reply) => {
    const body = AgentPlanRequestSchema.parse(req.body);
    const projectId = body.projectId ?? repos.projects.list()[0]?.id ?? "";
    const project = repos.projects.get(projectId);
    if (!project) return reply.code(404).send(errorBody("NOT_FOUND", "Proyecto no encontrado"));
    const media = (id: string) => repos.media.get(id);
    const assets = repos.media.list({ limit: 500 });
    const summary = buildProjectSummary(project, media, {
      ...(body.cursor !== undefined && { cursor: body.cursor }),
      assets,
    });
    const packsP = workers.packs().catch(() => undefined);
    let res;
    try {
      res = await workers.agentPlan({
        command: body.command,
        project_summary: summary,
        settings: { temperature: 0.2, ...body.settings },
      });
    } catch (err) {
      if (err instanceof WorkersError) {
        if (err.code === PACK_REQUIRED || err.packRequired || isOllamaError(err))
          throw agentPackRequired(await packsP, body.settings?.model);
        throw new HttpError(err.statusCode, err.code, err.message);
      }
      throw err;
    }
    const packs = await packsP;
    const validation = validateEditPlan(res.plan);
    const base = {
      id: nanoid(),
      projectId,
      command: body.command,
      status: "proposed" as const,
      created_at: new Date().toISOString(),
      model: res.model ?? null,
      route: res.route,
      latency_ms: res.latency_ms,
      attempts: res.attempts,
      warnings: res.warnings,
    };
    let record: AgentPlanRecord;
    if (!validation.ok) {
      record = {
        ...base,
        ok: false,
        plan: null,
        resolved: [],
        preview_es: [],
        risks: [],
        unresolved: [],
        errors: validation.errors,
      };
    } else {
      const r = resolvePlan(validation.plan, {
        project,
        media,
        ...(body.cursor !== undefined && { cursor: body.cursor }),
        presets: repos.presets.list(),
        assets,
        ...(packs && { packs }),
      });
      record = {
        ...base,
        ok: r.unresolved.length === 0 && validation.plan.ops.length > 0,
        plan: validation.plan,
        ...r,
        errors: [],
      };
    }
    repos.agentPlans.insert(record);
    req.log.info(
      {
        plan: record.id,
        ok: record.ok,
        route: record.route,
        model: record.model,
        ops: record.plan?.ops.length,
      },
      "Plan del asistente propuesto",
    );
    return reply.code(201).send(record);
  });

  app.post(API_ROUTES.agentApply, async (req, reply) => {
    const body = AgentApplyRequestSchema.parse(req.body);
    const record = repos.agentPlans.get(body.planId);
    if (!record) return reply.code(404).send(notFound());
    if (record.status === "rejected")
      throw new HttpError(409, "PLAN_REJECTED", "El plan fue descartado");
    if (!record.plan) throw new HttpError(409, "PLAN_INVALID", "El plan no es válido: pedí otro");
    if (!repos.projects.get(record.projectId))
      return reply.code(404).send(errorBody("NOT_FOUND", "Proyecto no encontrado"));
    const total = record.plan.ops.length;
    const ops = body.ops
      ? [...new Set(body.ops)].sort((a, b) => a - b)
      : record.plan.ops.map((_, i) => i);
    if (ops.length === 0) throw new HttpError(400, "BAD_REQUEST", "No hay operaciones confirmadas");
    const outOfRange = ops.filter((i) => i >= total);
    if (outOfRange.length)
      throw new HttpError(400, "BAD_REQUEST", `Operaciones inexistentes: ${outOfRange.join(", ")}`);
    const pending = ops.filter((i) => record.resolved[i] == null);
    if (pending.length)
      throw new HttpError(
        409,
        "PLAN_UNRESOLVED",
        `Faltan datos en las operaciones ${pending.map((i) => i + 1).join(", ")}: respondé las preguntas o desmarcalas`,
        { unresolved: record.unresolved },
      );
    const active = queue.activeJob("agent.apply", (p) => p.projectId === record.projectId);
    if (active)
      throw new HttpError(
        409,
        "AGENT_BUSY",
        "El asistente ya está aplicando un plan en este proyecto",
        {
          jobId: active.id,
        },
      );
    const job = queue.enqueue({
      type: "agent.apply",
      payload: { planId: record.id, ops, projectId: record.projectId },
      projectId: record.projectId,
      priority: 2,
    });
    repos.agentPlans.update(record.id, { applyJobId: job.id });
    return reply.code(202).send({ jobId: job.id });
  });

  app.get(API_ROUTES.agentPlans, async (req) => {
    const q = z
      .object({
        projectId: z.string().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      })
      .parse(req.query);
    return repos.agentPlans.list({
      ...(q.projectId && { projectId: q.projectId }),
      ...(q.limit && { limit: q.limit }),
    });
  });

  app.post<{ Params: { id: string } }>(API_ROUTES.agentPlanReject, async (req, reply) => {
    const record = repos.agentPlans.get(req.params.id);
    if (!record) return reply.code(404).send(notFound());
    if (record.status === "applied")
      throw new HttpError(409, "PLAN_APPLIED", "El plan ya se aplicó: usá «Deshacer todo»");
    return repos.agentPlans.setStatus(record.id, "rejected");
  });

  app.post<{ Params: { id: string } }>(API_ROUTES.agentPlanUndo, async (req, reply) => {
    const body = z.object({ undoSnapshotId: z.string().min(1).optional() }).parse(req.body ?? {});
    const record = repos.agentPlans.get(req.params.id);
    if (!record) return reply.code(404).send(notFound());
    const snapId = body.undoSnapshotId ?? record.undoSnapshotId;
    const snap = snapId ? repos.agentPlans.getSnapshot(snapId) : undefined;
    if (!snap || snap.projectId !== record.projectId)
      return reply.code(404).send(errorBody("NOT_FOUND", "No hay nada para deshacer en este plan"));
    const running = record.applyJobId ? app.ctx.jobs.get(record.applyJobId) : undefined;
    if (running && (running.status === "running" || running.status === "queued"))
      throw new HttpError(
        409,
        "AGENT_BUSY",
        "Esperá a que termine de aplicarse el plan (o cancelalo)",
      );
    const project = repos.projects.save(record.projectId, snap.project);
    if (!project) return reply.code(404).send(errorBody("NOT_FOUND", "Proyecto no encontrado"));
    const plan = repos.agentPlans.update(record.id, {
      status: "proposed",
      undoneAt: new Date().toISOString(),
    });
    return { project, plan };
  });

  app.get(API_ROUTES.agentStatus, async (): Promise<AgentStatus> => {
    const [st, packs] = await Promise.all([
      workers.agentStatus().catch(() => undefined),
      workers.packs().catch(() => undefined),
    ]);
    const pack = packs?.find((p) => p.id === AGENT_LLM_PACK_ID);
    const reachable = st !== undefined || packs !== undefined;
    const model = st?.model ?? null;
    const hint_es = !reachable
      ? "Los workers de IA no responden (¿está corriendo start.ps1?)."
      : !st
        ? "Los workers no tienen el asistente (actualizá con setup.ps1 -Update)."
        : !st.ollama || !st.ready
          ? ollamaHint(model ?? AGENT_DEFAULT_MODEL)
          : null;
    return {
      workers: reachable,
      ollama: st?.ollama ?? false,
      model,
      models_installed: st?.models_installed ?? [],
      ready: st?.ready ?? false,
      gpu_mode: st?.gpu_mode ?? null,
      pack: pack ? { id: pack.id, installed: pack.installed, name_es: pack.name_es } : null,
      hint_es,
    };
  });

  app.post(API_ROUTES.agentEval, async (req, reply) => {
    const body = AgentEvalRequestSchema.parse(req.body ?? {});
    const active = queue.activeJob("agent.eval", () => true);
    if (active) return reply.code(202).send({ jobId: active.id });
    const job = queue.enqueue({ type: "agent.eval", payload: body });
    return reply.code(202).send({ jobId: job.id });
  });

  app.get(API_ROUTES.agentEval, async (_req, reply) => {
    const result = await readAgentEval(config.storageDir);
    return (
      result ?? reply.code(404).send(errorBody("NOT_FOUND", "Todavía no se evaluaron modelos"))
    );
  });

  app.post(API_ROUTES.agentBugreport, async (req): Promise<AgentBugreportResponse> => {
    const body = AgentBugreportRequestSchema.parse(req.body ?? {});
    let markdown: string | undefined;
    let source: AgentBugreportResponse["source"] = "llm";
    try {
      const res = await workers.agentBugreport({
        ...(body.title && { title: body.title }),
        steps_text: body.steps_text,
        breadcrumbs: body.breadcrumbs,
        errors: body.errors,
        env: {
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          os: os.release(),
        },
      });
      markdown = res.markdown_es.trim() || undefined;
    } catch (err) {
      req.log.warn({ err: String(err) }, "Asistente sin respuesta: plantilla de reporte");
    }
    if (!markdown) {
      markdown = bugreportTemplate(body);
      source = "template";
    }
    const appended = body.reportId
      ? await appendToReport(config.storageDir, body.reportId, markdown)
      : false;
    return {
      markdown_es: markdown,
      source,
      ...(appended && body.reportId && { reportId: body.reportId }),
    };
  });
};

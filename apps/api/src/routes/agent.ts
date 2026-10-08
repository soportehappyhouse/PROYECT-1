import os from "node:os";
import {
  AGENT_DEFAULT_MODEL,
  AGENT_LLM_PACK_ID,
  AgentApplyRequestSchema,
  AgentBugreportRequestSchema,
  AgentEvalRequestSchema,
  AgentPlanRequestSchema,
  AgentUndoRequestSchema,
  ALWAYS_CONFIRM_OPS,
  API_ROUTES,
  PACK_REQUIRED,
  WORKERS_DOWN_ES,
  validateEditPlan,
  type AgentBugreportResponse,
  type AgentPlanRecord,
  type AgentStatus,
  type Pack,
  type Project,
} from "@studio/shared";
import type { FastifyPluginAsync } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import { appendToReport, readAgentEval } from "../jobs/handlers/agent.js";
import { errorBody, HttpError, PackRequiredError } from "../lib/errors.js";
import { projectContentHash } from "../services/agent/project-hash.js";
import { opTitle, resolvePlan, type ResolveContext } from "../services/agent/resolve.js";
// BEGIN sprint5:M3
import { AGENT_PLAN_CHOOSE_ROUTE, AgentPlanChooseRequestSchema } from "@studio/shared";
import {
  applyPlanChoice,
  resolveExpandedPlan,
  resolvePlanForRecord,
} from "../services/agent/aspect.js";
// END sprint5:M3
import { buildProjectSummary } from "../services/agent/summary.js";
import { WorkersError } from "../services/workers-client.js";

/** Spanish hint shown when the local LLM is missing (Ollama + model, decision 8: local only). */
export function ollamaHint(model = AGENT_DEFAULT_MODEL): string {
  return (
    `Falta el asistente local: instalá Ollama (winget install Ollama.Ollama, o https://ollama.com) y ` +
    `abrilo desde el menú Inicio (queda en la bandeja del sistema, junto al reloj). Descargá el ` +
    `modelo «${model}» una sola vez en Ajustes → Asistente local («Descargar modelo») o en una terminal: ` +
    `\`ollama pull ${model}\`. Para revisar la instalación: scripts\\windows\\doctor.cmd. ` +
    `Todo corre en tu PC, sin API key.`
  );
}

const MODEL_LABELS: Record<string, string> = {
  "qwen3:8b": "Qwen3 8B",
  "hermes3:8b": "Hermes 3 8B",
  "qwen3:0.6b": "Qwen3 0.6B",
};

/** Name of the agent-llm pack after the model (AGENT_MODEL): Qwen3 8B / Hermes 3 8B / custom tag. */
export const agentPackName = (model = AGENT_DEFAULT_MODEL) =>
  `Asistente local (Ollama + ${MODEL_LABELS[model.trim()] ?? model.trim()})`;

/**
 * PACK_REQUIRED for `agent-llm`. The message is the workers' own text when they sent one (they
 * check /api/version: "Ollama is not running, open the tray app" vs "ollama pull <model>", both
 * with doctor.cmd); otherwise the generic Ollama instructions.
 */
export function agentPackRequired(
  packs: readonly Pack[] | undefined,
  model?: string,
  detail?: string,
): PackRequiredError {
  const pack = packs?.find((p) => p.id === AGENT_LLM_PACK_ID);
  const err = new PackRequiredError(
    AGENT_LLM_PACK_ID,
    pack?.name_es ?? agentPackName(model),
    pack?.size_bytes ?? 5.2e9,
  );
  err.message = detail && /ollama/i.test(detail) ? detail : ollamaHint(model);
  return err;
}

/** The workers refuse a non-loopback OLLAMA_URL unless AGENT_ALLOW_REMOTE_OLLAMA=true. */
const OLLAMA_REMOTE_REFUSED = "OLLAMA_REMOTE_REFUSED";

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
  const resolveContext = (
    project: Project,
    cursor?: number,
    assets = repos.media.list({ limit: 500 }),
  ): ResolveContext => ({
    project,
    media: (id) => repos.media.get(id),
    ...(cursor !== undefined && { cursor }),
    presets: repos.presets.list(),
    assets,
  });

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
    // Sprint 5 (H18): the web «Cancelar» closes the request → stop waiting for the model (the
    // workers see the disconnect and cancel the planner, so Ollama stops generating).
    const planAbort = new AbortController();
    const onClientGone = () => {
      if (!reply.raw.writableFinished) planAbort.abort();
    };
    reply.raw.once("close", onClientGone);
    let res;
    try {
      res = await workers.agentPlan(
        {
          command: body.command,
          project_summary: summary,
          settings: {
            model: config.agent.model,
            temperature: config.agent.temperature,
            ...body.settings,
          },
        },
        planAbort.signal,
      );
    } catch (err) {
      if (planAbort.signal.aborted)
        throw new HttpError(499, "CLIENT_CLOSED", "Pedido cancelado por el usuario");
      if (err instanceof WorkersError) {
        if (err.code === OLLAMA_REMOTE_REFUSED) throw new HttpError(403, err.code, err.message);
        if (err.code === PACK_REQUIRED || err.packRequired || isOllamaError(err))
          throw agentPackRequired(
            await packsP,
            body.settings?.model ?? config.agent.model,
            err.code === PACK_REQUIRED ? err.message : undefined,
          );
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
        added: [],
        choices: [],
      };
    } else {
      // BEGIN sprint5:M3 (plan expanded for 9:16: reframe added or a PlanChoice)
      const r = resolvePlanForRecord(
        validation.plan,
        {
          ...resolveContext(project, body.cursor, assets),
          ...(packs && { packs }),
        },
        resolvePlan,
      );
      // END sprint5:M3
      record = {
        ...base,
        ok: r.unresolved.length === 0 && validation.plan.ops.length > 0,
        plan: validation.plan,
        added: [],
        choices: [],
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
        ...(res.prompt_tokens !== undefined && { promptTokens: res.prompt_tokens }),
      },
      "Plan del asistente propuesto",
    );
    return reply.code(201).send(record);
  });

  app.post(API_ROUTES.agentApply, async (req, reply) => {
    const body = AgentApplyRequestSchema.parse(req.body);
    let record = repos.agentPlans.get(body.planId);
    if (!record) return reply.code(404).send(notFound());
    if (record.status === "rejected")
      throw new HttpError(409, "PLAN_REJECTED", "El plan fue descartado");
    if (!record.plan) throw new HttpError(409, "PLAN_INVALID", "El plan no es válido: pedí otro");
    const project = repos.projects.get(record.projectId);
    if (!project) return reply.code(404).send(errorBody("NOT_FOUND", "Proyecto no encontrado"));
    if (body.edited_ops) {
      // Inline edits of the web: validate each op, resolve again on the current project and store
      // them as the plan's final ops (agent.apply runs exactly what the user saw).
      const current = record.plan;
      if (body.edited_ops.length !== current.ops.length)
        throw new HttpError(
          400,
          "BAD_REQUEST",
          `edited_ops tiene ${body.edited_ops.length} operaciones y el plan ${current.ops.length}`,
        );
      const validation = validateEditPlan({ ...current, ops: body.edited_ops });
      if (!validation.ok)
        throw new HttpError(
          400,
          "PLAN_INVALID",
          `Los cambios no son válidos: ${validation.errors.join("; ")}`,
          { errors: validation.errors },
        );
      const packs = await workers.packs().catch(() => undefined);
      // BEGIN sprint5:M3 (plan expanded for 9:16: reframe added or a PlanChoice)
      const r = resolvePlanForRecord(
        validation.plan,
        {
          ...resolveContext(project, body.cursor),
          ...(packs && { packs }),
        },
        resolvePlan,
      );
      // END sprint5:M3
      record =
        repos.agentPlans.update(record.id, {
          plan: validation.plan,
          ...r,
          ok: r.unresolved.length === 0 && validation.plan.ops.length > 0,
          errors: [],
          edited: true,
        }) ?? record;
      req.log.info({ plan: record.id, ok: record.ok }, "Plan del asistente editado");
    }
    const plan = record.plan!;
    const total = plan.ops.length;
    const ops = body.ops ? [...new Set(body.ops)].sort((a, b) => a - b) : plan.ops.map((_, i) => i);
    if (ops.length === 0) throw new HttpError(400, "BAD_REQUEST", "No hay operaciones confirmadas");
    const outOfRange = ops.filter((i) => i >= total);
    if (outOfRange.length)
      throw new HttpError(400, "BAD_REQUEST", `Operaciones inexistentes: ${outOfRange.join(", ")}`);
    // Destructive ops (delete_clip / export) run only with the separate confirmation click.
    const confirmed = new Set(body.confirmedIndexes ?? []);
    const unconfirmed = ops.filter(
      (i) => ALWAYS_CONFIRM_OPS.includes(plan.ops[i]!.op) && !confirmed.has(i),
    );
    if (unconfirmed.length)
      throw new HttpError(
        409,
        "CONFIRM_REQUIRED",
        `Confirmá aparte ${unconfirmed
          .map((i) => `la operación ${i + 1} (${opTitle(plan.ops[i]!).toLowerCase()})`)
          .join(" y ")}: borrar y exportar necesitan «Confirmar borrado/exportación».`,
        { indexes: unconfirmed },
      );
    const pending = ops.filter((i) => record.resolved[i] == null);
    if (pending.length)
      throw new HttpError(
        409,
        "PLAN_UNRESOLVED",
        `Faltan datos en las operaciones ${pending.map((i) => i + 1).join(", ")}: respondé las preguntas o desmarcalas`,
        { unresolved: record.unresolved, plan: record },
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
    const stored = repos.agentPlans.update(record.id, { applyJobId: job.id });
    // `plan`: the stored record (with the re-resolved preview when edited_ops were sent).
    return reply.code(202).send({ jobId: job.id, plan: stored });
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
    const body = AgentUndoRequestSchema.parse(req.body ?? {});
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
    const current = repos.projects.get(record.projectId);
    if (!current) return reply.code(404).send(errorBody("NOT_FOUND", "Proyecto no encontrado"));
    // Edits made after the apply would be lost: ask first (the web: «¿restaurar igual?»).
    if (
      !body.force &&
      record.postApplyHash &&
      (!body.undoSnapshotId || body.undoSnapshotId === record.undoSnapshotId) &&
      projectContentHash(current) !== record.postApplyHash
    )
      throw new HttpError(
        409,
        "PROJECT_CHANGED",
        "El proyecto cambió después de aplicar el plan; si lo restaurás se pierden esos cambios. " +
          "Mandá force: true para restaurar igual. (Deshacer no borra los archivos exportados ni " +
          "los medios que creó el plan.)",
        {
          postApplyUpdatedAt: record.postApplyUpdatedAt ?? null,
          updatedAt: current.updatedAt,
        },
      );
    const project = repos.projects.save(record.projectId, snap.project);
    if (!project) return reply.code(404).send(errorBody("NOT_FOUND", "Proyecto no encontrado"));
    const plan = repos.agentPlans.update(record.id, {
      status: "proposed",
      undoneAt: new Date().toISOString(),
      postApplyHash: null,
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
      ? WORKERS_DOWN_ES
      : !st
        ? "Los workers no tienen el asistente (actualizá con setup.ps1 -Update)."
        : !st.ollama || !st.ready
          ? (st.hint_es ?? ollamaHint(model ?? AGENT_DEFAULT_MODEL))
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
      loaded: st?.loaded ?? false,
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
        ...(body.model && { model: body.model }),
        env: {
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          os: os.release(),
        },
      });
      markdown = res.markdown_es.trim() || undefined;
      // The workers fall back to their own template when the model is missing.
      if (res.source === "template") source = "template";
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

  // BEGIN sprint5:M3
  /**
   * Sprint 5 (PlanChoices): pick an option of a pending choice (e.g. how to frame horizontal ->
   * 9:16). The option is applied to the stored plan (patch, then insert), the plan is expanded and
   * resolved again on the current project and the updated record is returned for a new preview.
   */
  app.post<{ Params: { id: string } }>(AGENT_PLAN_CHOOSE_ROUTE, async (req, reply) => {
    const body = AgentPlanChooseRequestSchema.parse(req.body);
    const record = repos.agentPlans.get(req.params.id);
    if (!record) return reply.code(404).send(notFound());
    if (record.status !== "proposed" || !record.plan)
      throw new HttpError(409, "PLAN_NOT_PROPOSED", "Este plan ya no se puede cambiar");
    const choice = (record.choices ?? []).find((c) => c.id === body.choiceId);
    const option = choice?.options.find((o) => o.id === body.optionId);
    if (!choice || !option)
      throw new HttpError(404, "NOT_FOUND", "Esa elección ya no está en el plan: pedí otro plan");
    const project = repos.projects.get(record.projectId);
    if (!project) return reply.code(404).send(errorBody("NOT_FOUND", "Proyecto no encontrado"));
    const validation = validateEditPlan(applyPlanChoice(record.plan, option));
    if (!validation.ok)
      throw new HttpError(
        400,
        "PLAN_INVALID",
        `El plan no es válido: ${validation.errors.join("; ")}`,
      );
    const packs = await workers.packs().catch(() => undefined);
    const r = resolveExpandedPlan(
      validation.plan,
      { ...resolveContext(project), ...(packs && { packs }) },
      resolvePlan,
    );
    const updated = repos.agentPlans.update(record.id, {
      ...r,
      ok: r.unresolved.length === 0 && r.plan.ops.length > 0,
      errors: [],
      edited: true,
    });
    req.log.info(
      { plan: record.id, choice: body.choiceId, option: body.optionId },
      "Elección del plan",
    );
    return updated ?? record;
  });
  // END sprint5:M3
};

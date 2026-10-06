import {
  STYLE_API_ROUTES,
  STYLE_VISION_DEFAULT_MODEL,
  STYLE_VISION_PACK_ID,
  StyleAnalyzeRequestSchema,
  StyleApplyRequestSchema,
  StyleInferRequestSchema,
  StylePresetSaveRequestSchema,
  compileStylePreset,
  stylePlanNotes,
  validateEditPlan,
  type AgentPlanRecord,
  type MediaAsset,
  type Project,
  type StyleAnalysisRecord,
  type StyleApplyResponse,
} from "@studio/shared";
import type { FastifyPluginAsync } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import { readAnalysis } from "../jobs/handlers/style.js";
import { errorBody, HttpError, PackRequiredError } from "../lib/errors.js";
import { resolvePlan } from "../services/agent/resolve.js";
import { StylePresetRepo } from "../services/style/presets.js";

/** Text of the 409 when the local vision model is missing (the console needs no download). */
export function visionPackMessage(model = STYLE_VISION_DEFAULT_MODEL): string {
  return (
    `Falta el modelo de visión local «${model}» (paquete «Modelo de visión local», ~3,2 GB): ` +
    `descargalo en Ajustes → Paquetes o con \`ollama pull ${model}\` (Ollama abierto en la ` +
    `bandeja del sistema), o usá la Consola Claude («Deducir con Consola Claude»): no necesita ` +
    `descargar nada.`
  );
}

/** Scene starts of the project's video clips, in timeline seconds (for the lower third). */
export function projectSceneStarts(
  project: Project,
  media: (id: string) => MediaAsset | undefined,
): number[] {
  const out: number[] = [];
  for (const track of project.tracks) {
    if (track.kind !== "video") continue;
    for (const clip of track.clips) {
      const speed = clip.speed || 1;
      const end = clip.start + (clip.out - clip.in) / speed;
      out.push(clip.start);
      for (const s of (clip.assetId && media(clip.assetId)?.scenes) || []) {
        const t = clip.start + (s.start - clip.in) / speed;
        if (t > clip.start + 0.04 && t < end - 0.04) out.push(Math.round(t * 1000) / 1000);
      }
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * Sprint 3b «Perfil de estilo» (/api/style/*, docs/trabajo/sprint3b-contratos.md B): analyze a
 * reference video (job style.analyze -> asset kind "analysis" + contact sheet under /files),
 * deduce a preset with the local vision model (job style.infer) or the Claude console, keep
 * presets (SQLite style_presets) and apply one to a project: compileStylePreset -> EditPlan stored
 * as an Assistant plan (status proposed) that the user confirms in the Asistente panel.
 */
export const styleRoutes: FastifyPluginAsync = async (app) => {
  const { repos, queue, workers, config } = app.ctx;
  const presets = new StylePresetRepo(app.ctx.db);

  async function analysisRecord(asset: MediaAsset): Promise<StyleAnalysisRecord> {
    const analysis = await readAnalysis(config.storageDir, asset);
    return {
      id: asset.id,
      name: asset.name,
      path: asset.path,
      ...(analysis.source_asset_id && { sourceAssetId: analysis.source_asset_id }),
      createdAt: asset.createdAt,
      analysis,
    };
  }

  app.post(STYLE_API_ROUTES.analyze, async (req, reply) => {
    const body = StyleAnalyzeRequestSchema.parse(req.body);
    const asset = repos.media.get(body.assetId);
    if (!asset) return reply.code(404).send(errorBody("NOT_FOUND", "Video no encontrado"));
    if (asset.kind !== "video")
      throw new HttpError(400, "BAD_REQUEST", "Elegí un video como referencia de estilo");
    const active = queue.activeJob(
      "style.analyze",
      (p) => (p as { assetId?: string }).assetId === asset.id,
    );
    if (active) return reply.code(202).send({ jobId: active.id });
    const job = queue.enqueue({ type: "style.analyze", payload: body, priority: 1 });
    return reply.code(202).send({ jobId: job.id });
  });

  app.get(STYLE_API_ROUTES.analyses, async (req) => {
    const q = z.object({ assetId: z.string().min(1).optional() }).parse(req.query);
    const out: StyleAnalysisRecord[] = [];
    for (const asset of repos.media.list({ kind: "analysis", limit: 100 })) {
      try {
        const rec = await analysisRecord(asset);
        if (!q.assetId || rec.sourceAssetId === q.assetId) out.push(rec);
      } catch (err) {
        req.log.warn({ asset: asset.id, err: String(err) }, "Análisis de estilo ilegible");
      }
    }
    return out;
  });

  app.get<{ Params: { id: string } }>(STYLE_API_ROUTES.analysis, async (req, reply) => {
    const asset = repos.media.get(req.params.id);
    if (!asset || asset.kind !== "analysis")
      return reply.code(404).send(errorBody("NOT_FOUND", "Análisis no encontrado"));
    return analysisRecord(asset);
  });

  app.post(STYLE_API_ROUTES.infer, async (req, reply) => {
    const body = StyleInferRequestSchema.parse(req.body);
    const asset = repos.media.get(body.analysisId);
    if (!asset || asset.kind !== "analysis")
      return reply.code(404).send(errorBody("NOT_FOUND", "Análisis no encontrado"));
    // Preflight: the vision pack (Ollama + qwen2.5vl:3b) listed as missing -> 409 right away.
    const pack = (await workers.packs().catch(() => undefined))?.find(
      (p) => p.id === STYLE_VISION_PACK_ID,
    );
    if (pack && !pack.installed) {
      const err = new PackRequiredError(pack.id, pack.name_es, pack.size_bytes);
      err.message = visionPackMessage(body.model);
      throw err;
    }
    const job = queue.enqueue({ type: "style.infer", payload: body });
    return reply.code(202).send({ jobId: job.id });
  });

  app.get(STYLE_API_ROUTES.presets, async () => presets.list());

  app.post(STYLE_API_ROUTES.presets, async (req, reply) => {
    const parsed = StylePresetSaveRequestSchema.safeParse(req.body, {
      error: z.locales.es().localeError,
    });
    if (!parsed.success)
      throw new HttpError(
        400,
        "PRESET_INVALID",
        `El perfil no es válido: ${parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
        { issues: parsed.error.issues },
      );
    const existed = parsed.data.id ? !!presets.get(parsed.data.id) : false;
    return reply.code(existed ? 200 : 201).send(presets.save(parsed.data));
  });

  app.get<{ Params: { id: string } }>(STYLE_API_ROUTES.preset, async (req, reply) => {
    return (
      presets.get(req.params.id) ??
      reply.code(404).send(errorBody("NOT_FOUND", "Perfil de estilo no encontrado"))
    );
  });

  app.delete<{ Params: { id: string } }>(STYLE_API_ROUTES.preset, async (req, reply) => {
    if (!presets.delete(req.params.id))
      return reply.code(404).send(errorBody("NOT_FOUND", "Perfil de estilo no encontrado"));
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>(STYLE_API_ROUTES.apply, async (req, reply) => {
    const body = StyleApplyRequestSchema.parse(req.body);
    const preset = presets.get(req.params.id);
    if (!preset)
      return reply.code(404).send(errorBody("NOT_FOUND", "Perfil de estilo no encontrado"));
    const project = repos.projects.get(body.projectId);
    if (!project) return reply.code(404).send(errorBody("NOT_FOUND", "Proyecto no encontrado"));
    const media = (id: string) => repos.media.get(id);
    const plan = compileStylePreset(preset, project, {
      scenes: projectSceneStarts(project, media),
      asset: media,
    });
    const validation = validateEditPlan(plan);
    if (!validation.ok)
      throw new HttpError(500, "PLAN_INVALID", `Plan inválido: ${validation.errors.join("; ")}`);
    const packs = await workers.packs().catch(() => undefined);
    const r = resolvePlan(validation.plan, {
      project,
      media,
      presets: repos.presets.list(),
      assets: repos.media.list({ limit: 500 }),
      ...(packs && { packs }),
    });
    const record: AgentPlanRecord = {
      id: nanoid(),
      projectId: project.id,
      command: `Aplicar el perfil de estilo «${preset.name}»`,
      status: "proposed",
      created_at: new Date().toISOString(),
      model: null,
      route: "deterministic",
      latency_ms: 0,
      attempts: 0,
      warnings: [`style_preset:${preset.id}`],
      ok: r.unresolved.length === 0 && validation.plan.ops.length > 0,
      plan: validation.plan,
      ...r,
      errors: [],
    };
    repos.agentPlans.insert(record);
    req.log.info(
      { plan: record.id, preset: preset.id, ops: validation.plan.ops.length, ok: record.ok },
      "Perfil de estilo compilado como plan del asistente",
    );
    const res: StyleApplyResponse = {
      planId: record.id,
      preview_es: record.preview_es,
      risks: record.risks,
      unresolved: record.unresolved,
      notes_es: stylePlanNotes(validation.plan),
      plan: record,
    };
    return reply.code(201).send(res);
  });
};

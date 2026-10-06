import { validateEditPlan } from "@studio/shared";
import { z } from "zod";
import { StudioApiError, type StudioApi } from "./api.js";
import {
  absStorage,
  compactAsset,
  compactJob,
  compactProject,
  type AssetLike,
  type JobLike,
  type ProjectLike,
} from "./compact.js";

/**
 * Herramientas MCP de Studio (docs/trabajo/sprint3b-contratos.md §A). Cada una llama a la API local;
 * devuelven JSON compacto y rutas absolutas cuando hay archivos (imágenes, análisis, exportaciones).
 */

export interface ToolDeps {
  api: StudioApi;
  /** Absolute STORAGE_DIR (from GET /api/console/status); undefined = paths stay relative. */
  storageDir: () => Promise<string | undefined>;
  sleep?: (ms: number) => Promise<void>;
  /** Poll interval of studio_wait_job (ms). */
  pollMs?: number;
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: S;
  /** Read-only tools are marked so Claude Code can run them without asking. */
  readOnly?: boolean;
  destructive?: boolean;
  run: (args: z.infer<z.ZodObject<S>>, deps: ToolDeps) => Promise<unknown>;
}

const defineTool = <S extends z.ZodRawShape>(t: ToolDef<S>): ToolDef<S> => t;

const TERMINAL = new Set(["succeeded", "failed", "canceled"]);

/**
 * Jobs studio_run_job may start: type → route (+ how the payload is sent). Nothing destructive:
 * cutting the timeline (`timeline.apply-cuts`) is left out on purpose, it would skip the
 * confirmation gate; cuts go through an EditPlan (`cut_silences`, `delete_clip`) + studio_apply_plan.
 */
export const RUNNABLE_JOBS: Record<string, { route: string; note_es: string; param?: string }> = {
  "subtitles.transcribe": {
    route: "/api/subtitles/transcribe",
    note_es: "Transcribir (Whisper). payload: {projectId, clipId} o {assetId}, language?",
  },
  "analyze.scenes": {
    route: "/api/ai/analyze/scenes",
    note_es: "Detectar escenas. payload: {assetId, threshold?}",
  },
  "analyze.silences": {
    route: "/api/ai/analyze/silences",
    note_es: "Analizar silencios/muletillas. payload: {projectId, clipId, options?}",
  },
  "audio.denoise": {
    route: "/api/ai/audio/denoise",
    note_es: "Limpiar voz. payload: {assetId, target?}",
  },
  "vision.matte": {
    route: "/api/ai/vision/matte",
    note_es:
      "Quitar fondo. payload: {assetId, model?, background?, target?{projectId,clipId}, quality?}",
  },
  "vision.reframe": {
    route: "/api/ai/vision/reframe",
    note_es: "Reencuadrar. payload: {projectId, target: 9:16|1:1|4:5, subject: face|track}",
  },
  "motion.render": {
    route: "/api/motion/render",
    note_es: "Renderizar motion graphics. payload: MotionSpec + target?",
  },
  "voice.tts": { route: "/api/voice/tts", note_es: "Texto a voz. payload: TtsRequest" },
  "voice.effect": {
    route: "/api/voice/effects",
    note_es: "Efectos de voz. payload: VoiceEffectRequest",
  },
  "media.proxy": {
    route: "/api/media/:assetId/proxy",
    param: "assetId",
    note_es: "Regenerar proxy. payload: {assetId}",
  },
  "audio.stems": {
    route: "/api/audio/stems",
    note_es: "Separar voz/música (pack stems). payload: {assetId|clipId, mode: two|four, target?}",
  },
  "style.infer": {
    route: "/api/style/infer",
    note_es: "Deducir estilo con el modelo local (pack vision-llm). payload: {analysisId}",
  },
};

async function resolveProjectId(api: StudioApi, projectId?: string): Promise<string> {
  if (projectId) return projectId;
  const list = await api.get<ProjectLike[]>("/api/projects");
  const latest = [...list].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0];
  if (!latest) throw new StudioApiError(404, "NO_PROJECT", "No hay proyectos: creá uno en Studio");
  return latest.id;
}

async function getJob(deps: ToolDeps, id: string) {
  const job = await deps.api.get<JobLike>(`/api/jobs/${encodeURIComponent(id)}`);
  return compactJob(job, await deps.storageDir());
}

export async function waitJob(deps: ToolDeps, id: string, timeoutSec = 600) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const t0 = Date.now();
  for (;;) {
    const job = await getJob(deps, id);
    if (TERMINAL.has(job.status)) return job;
    if (Date.now() - t0 > timeoutSec * 1000)
      return { ...job, timeout: true, hint_es: "Sigue corriendo: volvé a llamar studio_wait_job" };
    await sleep(deps.pollMs ?? 1000);
  }
}

interface PlanRecordLike {
  id: string | null;
  ok: boolean;
  status?: string;
  plan: { summary_es?: string; ops: { op: string }[]; questions?: string[] } | null;
  preview_es: string[];
  risks: string[];
  unresolved: string[];
  errors?: string[];
  route?: string | null;
  model?: string | null;
}

const ALWAYS_CONFIRM = new Set(["delete_clip", "export"]);

function compactPlan(r: PlanRecordLike) {
  const ops = r.plan?.ops ?? [];
  return {
    planId: r.id,
    ok: r.ok,
    ...(r.status && { status: r.status }),
    summary_es: r.plan?.summary_es,
    ops: ops.map((op, i) => ({ index: i, op: op.op, preview_es: r.preview_es[i] })),
    ...(r.risks.length && { risks: r.risks }),
    ...(r.unresolved.length && { unresolved: r.unresolved }),
    ...(r.plan?.questions?.length && { questions: r.plan.questions }),
    ...(r.errors?.length && { errors: r.errors }),
    needsConfirmation: ops
      .map((op, i) => (ALWAYS_CONFIRM.has(op.op) ? i : -1))
      .filter((i) => i >= 0),
    ...(r.model && { model: r.model }),
  };
}

const projectIdArg = z
  .string()
  .min(1)
  .optional()
  .describe("Id del proyecto. Si falta, se usa el proyecto modificado más recientemente.");

export const TOOLS = [
  defineTool({
    name: "studio_get_project",
    title: "Ver proyecto",
    description:
      "Devuelve el proyecto de Studio en formato compacto: lienzo, duración, pistas y clips " +
      "(id, inicio/fin en segundos de la línea de tiempo, asset, texto), cantidad de subtítulos y " +
      "ajustes de publicación. Usalo primero para conocer los ids antes de proponer un plan.",
    input: { projectId: projectIdArg },
    readOnly: true,
    run: async ({ projectId }, { api }) => {
      const id = await resolveProjectId(api, projectId);
      return compactProject(await api.get<ProjectLike>(`/api/projects/${encodeURIComponent(id)}`));
    },
  }),
  defineTool({
    name: "studio_list_assets",
    title: "Listar medios",
    description:
      "Lista los medios importados (video, audio, imagen, análisis…) con id, nombre, duración, " +
      "tamaño y la ruta absoluta del archivo y de la miniatura (podés abrir las imágenes).",
    input: {
      kind: z
        .string()
        .optional()
        .describe("Filtrar por tipo: video, audio, image, motion, analysis, mask, track…"),
      limit: z.number().int().min(1).max(500).optional().describe("Máximo (por defecto 100)."),
    },
    readOnly: true,
    run: async ({ kind, limit }, deps) => {
      const list = await deps.api.get<AssetLike[]>("/api/media", { kind, limit: limit ?? 100 });
      const dir = await deps.storageDir();
      return { count: list.length, assets: list.map((a) => compactAsset(a, dir)) };
    },
  }),
  defineTool({
    name: "studio_read_transcript",
    title: "Leer transcripción",
    description:
      "Lee los subtítulos/transcripción del proyecto (segmentos con inicio y fin en segundos). " +
      "Filtrá por rango para no traer todo. Si está vacío, transcribí con studio_run_job " +
      "{type: 'subtitles.transcribe'}.",
    input: {
      projectId: projectIdArg,
      from: z.number().min(0).optional().describe("Desde (s)."),
      to: z.number().min(0).optional().describe("Hasta (s)."),
      maxSegments: z.number().int().min(1).max(2000).optional().describe("Por defecto 400."),
    },
    readOnly: true,
    run: async ({ projectId, from, to, maxSegments }, { api }) => {
      const id = await resolveProjectId(api, projectId);
      const p = await api.get<ProjectLike>(`/api/projects/${encodeURIComponent(id)}`);
      const all = p.subtitles ?? [];
      const segs = all.filter(
        (s) => (from === undefined || s.end >= from) && (to === undefined || s.start <= to),
      );
      const max = maxSegments ?? 400;
      return {
        projectId: id,
        total: all.length,
        segments: segs
          .slice(0, max)
          .map((s) => [Math.round(s.start * 100) / 100, Math.round(s.end * 100) / 100, s.text]),
        format: "[inicio_s, fin_s, texto]",
        ...(segs.length > max && { truncated: segs.length - max }),
      };
    },
  }),
  defineTool({
    name: "studio_propose_plan",
    title: "Proponer plan (asistente local)",
    description:
      "Le pide al asistente local de Studio (reglas deterministas + modelo de Ollama) un EditPlan " +
      "para un comando en español («cortá los silencios», «exportá para Reels»). Queda guardado " +
      "como plan propuesto y visible en el panel Asistente. Devuelve planId, ops con su vista " +
      "previa, riesgos, preguntas y qué índices necesitan confirmación aparte. Si preferís escribir " +
      "el plan vos mismo, usá studio_validate_plan.",
    input: {
      command: z.string().min(1).max(2000).describe("Pedido en español."),
      projectId: projectIdArg,
      cursor: z.number().min(0).optional().describe("Posición del cursor en segundos."),
    },
    run: async ({ command, projectId, cursor }, { api }) => {
      const rec = await api.post<PlanRecordLike>("/api/agent/plan", {
        command,
        ...(projectId && { projectId }),
        ...(cursor !== undefined && { cursor }),
      });
      return compactPlan(rec);
    },
  }),
  defineTool({
    name: "studio_validate_plan",
    title: "Validar plan escrito por Claude",
    description:
      "Valida un EditPlan que escribiste vos ({version: 1, summary_es, ops: [...], questions?}) con " +
      "el mismo esquema y resolvedor que el Asistente: ids de clips, tiempos, riesgos. Si es válido " +
      "y save=true (por defecto) queda guardado como plan propuesto (aparece en el panel Asistente) " +
      "y devuelve planId para studio_apply_plan. Los errores vienen en español con la ruta del campo.",
    input: {
      plan: z.record(z.string(), z.unknown()).describe("EditPlan JSON."),
      projectId: projectIdArg,
      command: z.string().max(2000).optional().describe("Pedido original del usuario (historial)."),
      cursor: z.number().min(0).optional(),
      save: z.boolean().optional().describe("Guardarlo como plan propuesto (por defecto true)."),
    },
    run: async ({ plan, projectId, command, cursor, save }, { api }) => {
      const local = validateEditPlan(plan);
      if (!local.ok) return { ok: false, errors: local.errors };
      const rec = await api.post<PlanRecordLike & { saved?: boolean }>("/api/console/plans", {
        plan: local.plan,
        ...(projectId && { projectId }),
        ...(command && { command }),
        ...(cursor !== undefined && { cursor }),
        save: save ?? true,
      });
      return { ...compactPlan(rec), saved: rec.saved ?? false };
    },
  }),
  defineTool({
    name: "studio_apply_plan",
    title: "Aplicar plan",
    description:
      "Aplica un plan propuesto (job agent.apply, con instantánea para «Deshacer todo» en el panel " +
      "Asistente). `ops`: índices a aplicar (por defecto todos). Borrar clips y exportar SOLO se " +
      "aplican si su índice está en `confirmedIndexes`: preguntale antes al usuario en la consola y " +
      "pasá únicamente los índices que confirmó. Espera el resultado (wait=true por defecto).",
    input: {
      planId: z.string().min(1),
      ops: z.array(z.number().int().min(0)).optional().describe("Índices a aplicar."),
      confirmedIndexes: z
        .array(z.number().int().min(0))
        .optional()
        .describe("Índices de borrados/exportaciones que el usuario confirmó explícitamente."),
      wait: z.boolean().optional(),
      timeoutSec: z.number().int().min(5).max(3600).optional(),
    },
    destructive: true,
    run: async ({ planId, ops, confirmedIndexes, wait, timeoutSec }, deps) => {
      const res = await deps.api.post<{ jobId: string }>("/api/agent/apply", {
        planId,
        ...(ops && { ops }),
        ...(confirmedIndexes && { confirmedIndexes }),
      });
      if (wait === false) return { jobId: res.jobId, status: "queued" };
      return { jobId: res.jobId, job: await waitJob(deps, res.jobId, timeoutSec ?? 900) };
    },
  }),
  defineTool({
    name: "studio_run_job",
    title: "Lanzar trabajo",
    description:
      "Lanza un trabajo de Studio y devuelve su jobId (seguilo con studio_wait_job). Tipos: " +
      Object.entries(RUNNABLE_JOBS)
        .map(([k, v]) => `${k} — ${v.note_es}`)
        .join("; ") +
      ". No corta ni borra clips: para eso armá un plan (cut_silences, delete_clip) y aplicalo con " +
      "studio_apply_plan. Si falta un paquete de IA responde PACK_REQUIRED con instrucciones.",
    input: {
      type: z.enum(Object.keys(RUNNABLE_JOBS) as [string, ...string[]]),
      payload: z.record(z.string(), z.unknown()).describe("Cuerpo JSON del pedido."),
    },
    run: async ({ type, payload }, { api }) => {
      const spec = RUNNABLE_JOBS[type]!;
      let route = spec.route;
      if (spec.param) {
        const v = payload[spec.param];
        if (typeof v !== "string" || !v)
          throw new StudioApiError(400, "BAD_REQUEST", `Falta payload.${spec.param}`);
        route = route.replace(`:${spec.param}`, encodeURIComponent(v));
      }
      const res = await api.post<{ jobId?: string; id?: string }>(route, payload);
      return { type, jobId: res.jobId ?? res.id, accepted: res };
    },
  }),
  defineTool({
    name: "studio_get_job",
    title: "Estado de un trabajo",
    description:
      "Estado de un trabajo (queued/running/succeeded/failed/canceled), progreso 0..1, mensaje, " +
      "error y resultado; `files` trae las rutas absolutas de los archivos que produjo.",
    input: { id: z.string().min(1) },
    readOnly: true,
    run: async ({ id }, deps) => getJob(deps, id),
  }),
  defineTool({
    name: "studio_wait_job",
    title: "Esperar un trabajo",
    description:
      "Espera a que un trabajo termine (o hasta timeoutSec, por defecto 600) y devuelve su estado " +
      "final con resultado y rutas absolutas en `files`.",
    input: {
      id: z.string().min(1),
      timeoutSec: z.number().int().min(1).max(3600).optional(),
    },
    readOnly: true,
    run: async ({ id, timeoutSec }, deps) => waitJob(deps, id, timeoutSec ?? 600),
  }),
  defineTool({
    name: "studio_export",
    title: "Exportar",
    description:
      "Exporta el proyecto con un preset (youtube-1080p, youtube-4k, reels-tiktok, youtube-shorts, " +
      "gif-480, webm-alpha o uno propio). Exportar escribe un archivo nuevo: confirmalo antes con " +
      "el usuario y pasá confirmed=true solo si dijo que sí. Espera el resultado y devuelve la ruta.",
    input: {
      preset: z.string().min(1).describe("Id del preset de exportación."),
      confirmed: z.literal(true).describe("true = el usuario confirmó la exportación."),
      projectId: projectIdArg,
      fileName: z.string().max(120).optional(),
      range: z.object({ start: z.number().min(0), end: z.number().positive() }).optional(),
      burnSubtitles: z.boolean().optional(),
      wait: z.boolean().optional(),
    },
    destructive: true,
    run: async ({ preset, projectId, fileName, range, burnSubtitles, wait }, deps) => {
      const id = await resolveProjectId(deps.api, projectId);
      const res = await deps.api.post<{ jobId: string }>(
        `/api/projects/${encodeURIComponent(id)}/export`,
        {
          presetId: preset,
          ...(fileName && { fileName }),
          ...(range && { range }),
          ...(burnSubtitles !== undefined && { burnSubtitles }),
        },
      );
      if (wait === false) return { jobId: res.jobId, status: "queued" };
      return { jobId: res.jobId, job: await waitJob(deps, res.jobId, 3600) };
    },
  }),
  defineTool({
    name: "studio_preview_frame",
    title: "Fotograma de la vista previa",
    description:
      "Renderiza el fotograma del proyecto en t segundos y devuelve la ruta absoluta de un PNG que " +
      "podés abrir para mirar el resultado (textos, subtítulos, recortes, capas). Método «export»: " +
      "mismo compilador que la exportación; «proxy»: solo el clip de video superior bajo t.",
    input: {
      t: z.number().min(0).describe("Tiempo en segundos de la línea de tiempo."),
      projectId: projectIdArg,
    },
    readOnly: true,
    run: async ({ t, projectId }, { api }) => {
      const id = await resolveProjectId(api, projectId);
      return api.get(`/api/projects/${encodeURIComponent(id)}/frame`, { t, format: "json" });
    },
  }),
  defineTool({
    name: "studio_style_analyze",
    title: "Analizar video de referencia",
    description:
      "Analiza un video de referencia (job style.analyze): escenas, duración de planos, cortes por " +
      "minuto, movimiento, audio (loudness, voz, música, silencios), textos en pantalla (pack ocr) " +
      "y una hoja de contactos PNG 4×6 con tiempos. Espera el resultado y devuelve analysisId, la " +
      "ruta absoluta de la hoja de contactos (abrila para ver el estilo) y el análisis resumido.",
    input: {
      assetId: z.string().min(1).describe("Id del video de referencia (studio_list_assets)."),
      ocr: z.boolean().optional().describe("Leer textos en pantalla (pack ocr)."),
      timeoutSec: z.number().int().min(10).max(3600).optional(),
    },
    run: async ({ assetId, ocr, timeoutSec }, deps) => {
      const res = await deps.api.post<{ jobId: string }>("/api/style/analyze", {
        assetId,
        ...(ocr !== undefined && { ocr }),
      });
      const job = await waitJob(deps, res.jobId, timeoutSec ?? 900);
      if (job.status !== "succeeded") return { jobId: res.jobId, job };
      const dir = await deps.storageDir();
      const r = (job.result ?? {}) as {
        analysisId?: string;
        path?: string;
        contactSheetPath?: string;
        analysis?: Record<string, unknown>;
      };
      const { thumbnails, ...analysis } = (r.analysis ?? {}) as { thumbnails?: unknown };
      return {
        jobId: res.jobId,
        analysisId: r.analysisId,
        analysisFile: absStorage(dir, r.path),
        contactSheet: absStorage(dir, r.contactSheetPath),
        analysis,
        ...(Array.isArray(thumbnails) && {
          thumbnails: thumbnails.slice(0, 24).map((p) => absStorage(dir, String(p))),
        }),
      };
    },
  }),
  defineTool({
    name: "studio_style_save_preset",
    title: "Guardar perfil de estilo",
    description:
      "Guarda un StylePreset (perfil de estilo) deducido por vos: {name, canvas: 16:9|9:16|1:1, " +
      "cut_rhythm: {target_shot_s, remove_silences, min_silence_ms}, captions: {style, animated, " +
      "position}, titles: {template, params?}, lower_third?, transitions: {type, every_n_cuts?}, " +
      "music: {duck, volume_db}, zoom_punch_in?, ai_label?, export_preset, notes_es}. Agregá " +
      "source: {assetId, analysisId, via: 'claude'}. La API valida y devuelve el preset con su id " +
      "o los errores en español.",
    input: {
      preset: z.record(z.string(), z.unknown()).describe("StylePreset (sin id para uno nuevo)."),
    },
    run: async ({ preset }, { api }) => {
      const source = (preset.source ?? {}) as Record<string, unknown>;
      return api.post("/api/style/presets", { ...preset, source: { via: "claude", ...source } });
    },
  }),
  defineTool({
    name: "studio_style_apply",
    title: "Aplicar perfil de estilo",
    description:
      "Convierte un perfil de estilo guardado en un EditPlan para el proyecto (determinista) y lo " +
      "deja como plan propuesto en el Asistente. Devuelve planId y la vista previa: revisala con el " +
      "usuario y aplicala con studio_apply_plan (la exportación necesita confirmación aparte).",
    input: { presetId: z.string().min(1), projectId: projectIdArg },
    run: async ({ presetId, projectId }, { api }) => {
      const id = await resolveProjectId(api, projectId);
      const res = await api.post<{
        planId: string;
        notes_es?: string[];
        plan?: PlanRecordLike;
        preview_es?: string[];
        risks?: string[];
        unresolved?: string[];
      }>(`/api/style/presets/${encodeURIComponent(presetId)}/apply`, { projectId: id });
      return res.plan
        ? { ...compactPlan(res.plan), planId: res.planId, notes_es: res.notes_es }
        : res;
    },
  }),
  defineTool({
    name: "studio_bug_report",
    title: "Reportar un error",
    description:
      "Crea un reporte de error de Studio (carpeta + zip en storage/reports con logs, " +
      "diagnóstico de trabajos y proyecto) y devuelve la ruta del zip y el reporte.md. Escribí " +
      "título y pasos en español; incluí jobIds de los trabajos que fallaron.",
    input: {
      title: z.string().min(1).max(200),
      steps: z.string().max(20_000).describe("Pasos, qué esperabas y qué pasó."),
      severity: z.enum(["low", "medium", "high", "blocker"]).optional(),
      jobIds: z.array(z.string()).max(50).optional(),
      projectId: z.string().optional(),
      includeMedia: z.boolean().optional(),
    },
    run: async (args, { api }) => {
      const res = await api.post<{
        id: string;
        dir: string;
        zipPath: string;
        markdown?: string;
        prompt?: string;
      }>("/api/reports", { ...args, severity: args.severity ?? "medium" });
      return {
        id: res.id,
        dir: res.dir,
        zipPath: res.zipPath,
        markdown: res.markdown?.slice(0, 4000),
      };
    },
  }),
  defineTool({
    name: "studio_search_library",
    title: "Buscar en la biblioteca",
    description:
      "Busca efectos de sonido y música en la biblioteca local (o en Freesound/Pixabay si hay key " +
      "configurada en Studio). Devuelve id, nombre, duración y licencia; importalo desde el panel " +
      "Biblioteca o con un plan add_audio {query}.",
    input: {
      q: z.string().max(200).describe("Texto a buscar."),
      kind: z.enum(["sfx", "music", "ambience"]).optional(),
      provider: z.enum(["local", "freesound", "pixabay"]).optional(),
      pageSize: z.number().int().min(1).max(100).optional(),
    },
    readOnly: true,
    run: async ({ q, kind, provider, pageSize }, { api }) => {
      const res = await api.get<{ items?: Record<string, unknown>[]; total?: number }>(
        "/api/library",
        { q, kind, provider, pageSize: pageSize ?? 20 },
      );
      return {
        total: res.total,
        items: (res.items ?? []).map((i) => ({
          id: i.id,
          name: i.name,
          kind: i.kind,
          provider: i.provider,
          duration_s: i.durationSec,
          license: i.license,
          tags: Array.isArray(i.tags) ? i.tags.slice(0, 8) : undefined,
        })),
      };
    },
  }),
] as const;

export const TOOL_NAMES = TOOLS.map((t) => t.name);

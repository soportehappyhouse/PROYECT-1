import { readFile, stat } from "node:fs/promises";
import {
  AnalyzeScenesRequestSchema,
  AnalyzeSilencesRequestSchema,
  ApplyCutsRequestSchema,
  DenoiseRequestSchema,
  PackDownloadPayloadSchema,
  PERF_RESULT_PATH,
  PerfResultSchema,
  PerfRunPayloadSchema,
  type AnalyzeScenesRequest,
  type AnalyzeScenesResult,
  type AnalyzeSilencesRequest,
  type AnalyzeSilencesResult,
  type ApplyCutsRequest,
  type ApplyCutsResult,
  type AudioJobResult,
  type Clip,
  type DenoiseRequest,
  type PackDownloadPayload,
  type PackDownloadResult,
  type PackTask,
  type PerfResult,
  type PerfRunPayload,
  type SilenceCut,
} from "@studio/shared";
import { nanoid } from "nanoid";
import type { AppContext } from "../../context.js";
import { HttpError, PackRequiredError } from "../../lib/errors.js";
import { applyInheritedAiProvenance } from "../../services/ai-provenance.js";
import { createConsentGate } from "../../services/persons/gate.js";
import { resolveStoragePath } from "../../services/storage.js";
import { applyCuts } from "../../services/timeline-edit.js";
import { WorkersError, type WorkersClient } from "../../services/workers-client.js";
import { registerAudioAsset, requireMediaAsset } from "../../voice-ai/media-bridge.js";
import { JobAbortedError } from "../state.js";
import type { JobContext, JobHandler } from "../types.js";

/** Dependencies of the Sprint 1 AI handlers (subset of AppContext, easy to fake in tests). */
export type AiDeps = Pick<AppContext, "config" | "repos" | "queue" | "workers">;

export interface AiHandlerOptions {
  /** Polling interval of workers tasks (ms, default 1000). */
  pollMs?: number;
  /** Give up polling after this long (ms, default 2 h for downloads, 30 min for perf). */
  timeoutMs?: number;
}

/** A workers PACK_REQUIRED answer becomes PackRequiredError (409 / failed job with the body). */
export function toPackRequired(err: unknown): unknown {
  if (err instanceof WorkersError && err.packRequired) {
    const p = err.packRequired;
    return new PackRequiredError(p.packId, p.name_es, p.size_bytes);
  }
  return err;
}

export async function viaPacks<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toPackRequired(err);
  }
}

/**
 * Route preflight: when the workers list `packId` as not installed, answer 409 PACK_REQUIRED before
 * enqueueing. Unreachable workers or unknown packs are not an error here (the job reports it).
 */
export async function requirePack(workers: WorkersClient, packId: string): Promise<void> {
  const packs = await workers.packs().catch(() => undefined);
  const pack = packs?.find((p) => p.id === packId);
  if (pack && !pack.installed) throw new PackRequiredError(pack.id, pack.name_es, pack.size_bytes);
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new JobAbortedError());
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new JobAbortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

const gb = (bytes: number) => (bytes / 1e9).toFixed(2).replace(".", ",");

/** Spanish progress line of a pack download task. */
export function packTaskMessage(name: string, t: PackTask): string {
  const bytes = t.bytes_total > 0 ? ` · ${gb(t.bytes_done)} / ${gb(t.bytes_total)} GB` : "";
  const file = t.current_file ? ` · ${t.current_file}` : "";
  return t.status === "queued"
    ? `En espera: «${name}»`
    : `Descargando «${name}» ${Math.round(t.progress * 100)} %${bytes}${file}`;
}

/**
 * Poll a workers task (GET /packs/tasks/{id} or /perf/tasks/{id}) until done/error. Transient failures (workers restarting) are
 * tolerated up to `maxFailures` consecutive polls.
 */
async function pollTask(
  workers: WorkersClient,
  taskId: string,
  ctx: JobContext,
  opts: { pollMs: number; timeoutMs: number; maxFailures?: number; kind?: "pack" | "perf" },
  onTask: (t: PackTask) => void,
): Promise<PackTask> {
  const t0 = Date.now();
  let failures = 0;
  for (;;) {
    let task: PackTask | undefined;
    try {
      task =
        opts.kind === "perf"
          ? await workers.perfTask(taskId, ctx.signal)
          : await workers.packTask(taskId, ctx.signal);
      failures = 0;
    } catch (err) {
      if (ctx.signal.aborted) throw new JobAbortedError();
      if (err instanceof WorkersError && err.statusCode === 404) throw err;
      if (++failures >= (opts.maxFailures ?? 10)) throw toPackRequired(err);
    }
    if (task) {
      onTask(task);
      if (task.status === "done" || task.status === "error") return task;
    }
    if (Date.now() - t0 > opts.timeoutMs)
      throw new Error("La tarea de los workers no terminó a tiempo");
    await sleep(opts.pollMs, ctx.signal);
  }
}

/** packs.download: POST /packs/{id}/download, then poll the task and report progress over SSE. */
export function createPackDownloadHandler(
  deps: AiDeps,
  o: AiHandlerOptions = {},
): JobHandler<PackDownloadPayload, PackDownloadResult> {
  return {
    type: "packs.download",
    parse: (p) => PackDownloadPayloadSchema.parse(p),
    async run({ packId }, ctx) {
      const packs = await deps.workers.packs().catch(() => []);
      const name = packs.find((p) => p.id === packId)?.name_es ?? packId;
      ctx.reportProgress(0.01, `Preparando descarga de «${name}»`);
      const { task_id } = await viaPacks(() => deps.workers.packDownload(packId));
      ctx.log(`Tarea de descarga ${task_id} (${packId})`);
      const task = await pollTask(
        deps.workers,
        task_id,
        ctx,
        { pollMs: o.pollMs ?? 1000, timeoutMs: o.timeoutMs ?? 2 * 3600_000 },
        (t) => ctx.reportProgress(0.01 + t.progress * 0.98, packTaskMessage(name, t)),
      );
      if (task.status === "error")
        throw new Error(`No se pudo descargar «${name}»: ${task.error ?? "error desconocido"}`);
      return { packId, installed: true };
    },
  };
}

/** analyze.scenes: PySceneDetect in the workers; the scenes are stored on the asset. */
export function createAnalyzeScenesHandler(
  deps: AiDeps,
): JobHandler<AnalyzeScenesRequest, AnalyzeScenesResult> {
  return {
    type: "analyze.scenes",
    parse: (p) => AnalyzeScenesRequestSchema.parse(p),
    async run(req, ctx) {
      const asset = requireMediaAsset(deps, req.assetId);
      ctx.reportProgress(0.05, "Detectando escenas");
      const res = await viaPacks(() =>
        deps.workers.analyzeScenes(
          {
            path: asset.path,
            ...(req.threshold !== undefined && { threshold: req.threshold }),
            ...(req.minSceneLenSec !== undefined && { min_scene_len_s: req.minSceneLenSec }),
          },
          { signal: ctx.signal },
        ),
      );
      const scenes = res.scenes.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
      deps.repos.media.update(asset.id, { scenes });
      return { assetId: asset.id, scenes };
    },
  };
}

function findClip(deps: AiDeps, projectId: string, clipId: string) {
  const project = deps.repos.projects.get(projectId);
  if (!project) throw new HttpError(404, "NOT_FOUND", "Proyecto no encontrado");
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { project, track, clip };
  }
  throw new HttpError(404, "NOT_FOUND", "Clip no encontrado en el proyecto");
}

/** Whisper words of the project subtitles inside the clip, in SOURCE seconds ({w, s, e}). */
export function clipWords(
  subtitles: readonly { words?: { start: number; end: number; word: string }[] }[],
  clip: Clip,
): { w: string; s: number; e: number }[] {
  const speed = clip.speed || 1;
  const end = clip.start + (clip.out - clip.in) / speed;
  const src = (t: number) => Math.round((clip.in + (t - clip.start) * speed) * 1000) / 1000;
  return subtitles
    .flatMap((s) => s.words ?? [])
    .filter((w) => w.end > clip.start && w.start < end)
    .map((w) => ({
      w: w.word.trim(),
      s: src(Math.max(w.start, clip.start)),
      e: src(Math.min(w.end, end)),
    }))
    .filter((w) => w.w !== "" && w.e > w.s);
}

/** Clamp cuts to [in, out], sort, drop slivers; total = union length. */
export function normalizeCuts(
  cuts: readonly SilenceCut[],
  range: { in: number; out: number },
): { cuts: SilenceCut[]; total: number } {
  const out = cuts
    .map((c) => ({ ...c, start: Math.max(range.in, c.start), end: Math.min(range.out, c.end) }))
    .filter((c) => c.end - c.start >= 0.05)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let reach = -Infinity;
  for (const c of out) {
    const s = Math.max(c.start, reach);
    if (c.end > s) total += c.end - s;
    reach = Math.max(reach, c.end);
  }
  return { cuts: out, total: Math.round(total * 1000) / 1000 };
}

/** analyze.silences: silencedetect + fillers in the workers; proposes cuts (never applies them). */
export function createAnalyzeSilencesHandler(
  deps: AiDeps,
): JobHandler<AnalyzeSilencesRequest, AnalyzeSilencesResult> {
  return {
    type: "analyze.silences",
    parse: (p) => AnalyzeSilencesRequestSchema.parse(p),
    async run(req, ctx) {
      const { project, clip } = findClip(deps, req.projectId, req.clipId);
      if (!clip.assetId) throw new HttpError(400, "BAD_REQUEST", "El clip no tiene medio");
      const asset = requireMediaAsset(deps, clip.assetId);
      if (asset.hasAudio === false)
        throw new HttpError(400, "BAD_REQUEST", "El clip no tiene audio para analizar");
      // vad:false = skip the project subtitles (VAD usually dropped the fillers) and let the
      // workers re-transcribe the clip with Whisper's VAD off.
      const words =
        req.options.fillers && req.options.vad !== false ? clipWords(project.subtitles, clip) : [];
      ctx.reportProgress(0.05, "Buscando silencios y muletillas");
      const res = await viaPacks(() =>
        deps.workers.analyzeSilences(
          {
            path: asset.path,
            min_silence_ms: req.options.minSilenceMs,
            noise_db: req.options.noiseDb,
            padding_ms: req.options.paddingMs,
            fillers: req.options.fillers,
            ...(words.length > 0 && { transcript: { words } }),
            ...(req.options.vad !== undefined && { vad: req.options.vad }),
          },
          { signal: ctx.signal },
        ),
      );
      const { cuts, total } = normalizeCuts(res.cuts, clip);
      return {
        projectId: req.projectId,
        clipId: req.clipId,
        assetId: asset.id,
        timeBase: "source",
        cuts,
        total_removed_s: total,
      };
    },
  };
}

/** timeline.apply-cuts: split + ripple server-side and save; the web undoes by PUTting its copy. */
export function createApplyCutsHandler(
  deps: AiDeps,
): JobHandler<ApplyCutsRequest, ApplyCutsResult> {
  return {
    type: "timeline.apply-cuts",
    parse: (p) => ApplyCutsRequestSchema.parse(p),
    async run(req, ctx) {
      const project = deps.repos.projects.get(req.projectId);
      if (!project) throw new HttpError(404, "NOT_FOUND", "Proyecto no encontrado");
      ctx.reportProgress(0.2, "Aplicando cortes");
      const out = applyCuts(project, req.clipId, req.cuts, () => nanoid());
      const saved = deps.repos.projects.save(req.projectId, out.project);
      if (!saved) throw new HttpError(404, "NOT_FOUND", "Proyecto no encontrado");
      ctx.log(`Quitados ${out.removedSec.toFixed(2)} s en ${out.pieceIds.length} tramos`);
      return { project: saved, removedSec: out.removedSec, pieceIds: out.pieceIds };
    },
  };
}

/** audio.denoise: DeepFilterNet in the workers -> new audio asset (+ media.probe). */
export function createDenoiseHandler(deps: AiDeps): JobHandler<DenoiseRequest, AudioJobResult> {
  return {
    type: "audio.denoise",
    parse: (p) => DenoiseRequestSchema.parse(p),
    async run(req, ctx, job) {
      const source = requireMediaAsset(deps, req.assetId);
      if (source.hasAudio === false || source.kind === "image")
        throw new HttpError(400, "BAD_REQUEST", "El medio no tiene audio");
      ctx.reportProgress(0.05, "Limpiando voz (DeepFilterNet)");
      const res = await viaPacks(() =>
        deps.workers.audioDenoise(
          { path: source.path, output_base: `renders/${job.id}` },
          { signal: ctx.signal },
        ),
      );
      for (const w of res.warnings ?? []) ctx.log(`AVISO: ${w}`);
      const registered = await registerAudioAsset(deps, {
        path: res.path,
        name: `${source.name} (voz limpia)`,
        ...(source.durationSec !== undefined && { durationSec: source.durationSec }),
      });
      // Sprint 4: a cleaned synthetic/cloned voice keeps its AI provenance.
      const asset = applyInheritedAiProvenance(deps, registered, source, { jobId: job.id });
      return {
        assetId: asset.id,
        path: res.path,
        ...(source.durationSec !== undefined && { durationSec: source.durationSec }),
        ...(res.warnings?.length && { warnings: res.warnings }),
      };
    },
  };
}

/**
 * Last perf test result (storage/run/perf.json) or undefined. Unknown keys are kept (sprint 4:
 * `tools` = states of the isolated tool venvs, shown by Ajustes → Paquetes de IA).
 */
export async function readPerfResult(storageDir: string): Promise<PerfResult | undefined> {
  try {
    const raw = await readFile(resolveStoragePath(storageDir, PERF_RESULT_PATH), "utf8");
    return PerfResultSchema.loose().parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/**
 * Sprint 4 (M3) body of POST /perf/run: the photo of the first Person with a valid face consent
 * and the accepted licences, so the workers measure FaceFusion only with both (never a face-swap
 * model without the on-screen acceptance). The handler gets the full AppContext in app.ts.
 */
export function perfRunBody(deps: AiDeps): {
  face_source_path?: string;
  face_consent_id?: string;
  licences: string[];
} {
  const db = (deps as Partial<Pick<AppContext, "db">>).db;
  if (!db) return { licences: [] };
  const gate = createConsentGate(db, deps.config.storageDir);
  const licences = gate.isLicenceAccepted("faceswap") ? ["faceswap"] : [];
  const source = licences.length > 0 ? gate.benchFaceSource() : null;
  return {
    ...(source && { face_source_path: source.photoPath, face_consent_id: source.consentId }),
    licences,
  };
}

async function perfMtime(storageDir: string): Promise<number> {
  return stat(resolveStoragePath(storageDir, PERF_RESULT_PATH))
    .then((s) => s.mtimeMs)
    .catch(() => 0);
}

/**
 * perf.run: POST /perf/run, then wait for the task (GET /perf/tasks/{id}) or, when the workers do
 * not expose it (404, older workers), for storage/run/perf.json to change.
 */
export function createPerfRunHandler(
  deps: AiDeps,
  o: AiHandlerOptions = {},
): JobHandler<PerfRunPayload, PerfResult> {
  return {
    type: "perf.run",
    parse: (p) => PerfRunPayloadSchema.parse(p ?? {}),
    async run(_req, ctx) {
      const storage = deps.config.storageDir;
      const before = await perfMtime(storage);
      ctx.reportProgress(0.02, "Iniciando test de rendimiento IA");
      const { task_id } = await viaPacks(() => deps.workers.perfRun(perfRunBody(deps)));
      const pollMs = o.pollMs ?? 1000;
      const timeoutMs = o.timeoutMs ?? 30 * 60_000;
      try {
        const task = await pollTask(
          deps.workers,
          task_id,
          ctx,
          { pollMs, timeoutMs, kind: "perf" },
          (t) =>
            ctx.reportProgress(
              0.02 + t.progress * 0.96,
              `Midiendo rendimiento ${Math.round(t.progress * 100)} %${t.current_file ? ` · ${t.current_file}` : ""}`,
            ),
        );
        if (task.status === "error")
          throw new Error(`El test de rendimiento falló: ${task.error ?? "error desconocido"}`);
      } catch (err) {
        if (!(err instanceof WorkersError && err.statusCode === 404)) throw err;
        ctx.log("Sin endpoint de tareas: esperando storage/run/perf.json");
        const t0 = Date.now();
        while ((await perfMtime(storage)) <= before) {
          if (Date.now() - t0 > timeoutMs)
            throw new Error("El test de rendimiento no terminó a tiempo");
          ctx.reportProgress(0.5, "Midiendo rendimiento");
          await sleep(pollMs, ctx.signal);
        }
      }
      const result = await readPerfResult(storage);
      if (!result) throw new Error("El test terminó sin resultado (storage/run/perf.json)");
      return result;
    },
  };
}

/** Register the Sprint 1 handlers on the queue. */
export function registerAiHandlers(deps: AiDeps, o: AiHandlerOptions = {}): void {
  deps.queue
    .register(createPackDownloadHandler(deps, o) as JobHandler)
    .register(createAnalyzeScenesHandler(deps) as JobHandler)
    .register(createAnalyzeSilencesHandler(deps) as JobHandler)
    .register(createApplyCutsHandler(deps) as JobHandler)
    .register(createDenoiseHandler(deps) as JobHandler)
    .register(createPerfRunHandler(deps, o) as JobHandler);
}

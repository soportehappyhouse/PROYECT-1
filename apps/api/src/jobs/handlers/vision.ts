import { readFile } from "node:fs/promises";
import {
  fitRect,
  normalizeCropRect,
  sortKeyframes,
  TrackFileSchema,
  trackRefKeyframes,
  TrackToKeyframesRequestSchema,
  VisionMaskPayloadSchema,
  VisionMatteRequestSchema,
  VisionReframeRequestSchema,
  VisionTrackRequestSchema,
  WorkerMatteResultSchema,
  WorkerPropagateResultSchema,
  WorkerReframeResultSchema,
  WorkerTrackResultSchema,
  type Clip,
  type CropRect,
  type Keyframe,
  type MediaAsset,
  type Project,
  type ProjectReframe,
  type TrackFile,
  type TrackMethod,
  type TrackRequestMethod,
  type TrackToKeyframesRequest,
  type TrackToKeyframesResult,
  type VisionMaskPayload,
  type VisionMaskResult,
  type VisionMatteRequest,
  type VisionMatteResult,
  type VisionReframeRequest,
  type VisionReframeResult,
  type VisionTask,
  type VisionTrackRequest,
  type VisionTrackResult,
} from "@studio/shared";
import type { z } from "zod";
import { HttpError } from "../../lib/errors.js";
import { resolveStoragePath } from "../../services/storage.js";
import {
  copyIntoMasks,
  maskPngOf,
  readTrackFile,
  registerFileAsset,
  registerTrackAsset,
} from "../../services/vision-assets.js";
import { WorkersError, type WorkersClient } from "../../services/workers-client.js";
import { requireMaskAsset, requireMediaAsset } from "../../voice-ai/media-bridge.js";
import { JobAbortedError } from "../state.js";
import type { JobContext, JobHandler } from "../types.js";
import { toPackRequired, viaPacks, type AiDeps, type AiHandlerOptions } from "./ai.js";

/**
 * Sprint 2 vision jobs (docs/trabajo/sprint2-contratos.md): vision.matte, vision.mask (SAM 2
 * propagate), vision.track, vision.reframe and timeline.track-to-keyframes. Worker tasks are
 * polled on GET /vision/tasks/{id}; PACK_REQUIRED fails the job with the flat 409 body.
 */

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

/** Poll GET /vision/tasks/{id} until done/error; returns the parsed `result`. */
export async function pollVisionTask<T>(
  deps: AiDeps,
  taskId: string,
  ctx: JobContext,
  schema: z.ZodType<T>,
  o: AiHandlerOptions & { label: string; from?: number; to?: number },
): Promise<{ result: T; warnings: string[] }> {
  const t0 = Date.now();
  const timeoutMs = o.timeoutMs ?? 3 * 3600_000;
  const from = o.from ?? 0.05;
  const to = o.to ?? 0.95;
  let failures = 0;
  for (;;) {
    let task: VisionTask | undefined;
    try {
      task = await deps.workers.visionTask(taskId, ctx.signal);
      failures = 0;
    } catch (err) {
      if (ctx.signal.aborted) throw new JobAbortedError();
      if (err instanceof WorkersError && err.statusCode === 404) throw toPackRequired(err);
      if (err instanceof WorkersError && err.packRequired) throw toPackRequired(err);
      if (++failures >= 10) throw toPackRequired(err);
    }
    if (task) {
      const pct = Math.round(task.progress * 100);
      ctx.reportProgress(
        from + task.progress * (to - from),
        `${o.label} ${pct} %${task.message ? ` · ${task.message}` : ""}`,
      );
      if (task.status === "error")
        throw new Error(`${o.label}: ${task.error ?? "error desconocido en los workers"}`);
      if (task.status === "done") {
        const warnings = task.warnings ?? [];
        for (const w of warnings) ctx.log(`AVISO: ${w}`);
        return { result: schema.parse(task.result ?? {}), warnings };
      }
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`${o.label}: la tarea no terminó a tiempo`);
    await sleep(o.pollMs ?? 1000, ctx.signal);
  }
}

function findClip(project: Project, clipId: string): { clip: Clip; kind: string } {
  for (const t of project.tracks) {
    const clip = t.clips.find((c) => c.id === clipId);
    if (clip) return { clip, kind: t.kind };
  }
  throw new HttpError(404, "NOT_FOUND", "Clip no encontrado en el proyecto");
}

const requireProject = (deps: AiDeps, id: string): Project => {
  const p = deps.repos.projects.get(id);
  if (!p) throw new HttpError(404, "NOT_FOUND", "Proyecto no encontrado");
  return p;
};

const sizeOf = (deps: AiDeps) => (id: string) => {
  const a = deps.repos.media.get(id);
  return a?.width && a.height ? { width: a.width, height: a.height } : undefined;
};

/** vision.matte: RVM (video, alpha WebM) or BiRefNet (image, PNG RGBA) -> new asset (+ clip.matte). */
export function createVisionMatteHandler(
  deps: AiDeps,
  o: AiHandlerOptions = {},
): JobHandler<VisionMatteRequest, VisionMatteResult> {
  return {
    type: "vision.matte",
    parse: (p) => VisionMatteRequestSchema.parse(p),
    async run(req, ctx, job) {
      const src = requireMediaAsset(deps, req.assetId);
      const image = src.kind === "image";
      const model = req.model ?? (image ? "birefnet" : "rvm");
      const outputBase = `renders/${job.id}`;
      let asset: MediaAsset;
      let previewPath: string | undefined;
      const hq: Pick<VisionMatteResult, "quality" | "previewComparePath" | "halo" | "refine"> = {};
      const warnings: string[] = [];
      if (image) {
        ctx.reportProgress(0.1, "Quitando el fondo de la imagen (BiRefNet)");
        const res = await viaPacks(() =>
          deps.workers.visionMatteImage(
            { path: src.path, output_base: outputBase },
            { signal: ctx.signal },
          ),
        );
        warnings.push(...(res.warnings ?? []));
        asset = await registerFileAsset(deps, {
          kind: "image",
          path: res.path,
          name: `${src.name} (sin fondo)`,
          mimeType: "image/png",
          hasAlpha: true,
          ...(src.width && src.height && { width: src.width, height: src.height }),
          probe: true,
        });
      } else {
        if (src.kind !== "video" || src.hasVideo === false)
          throw new HttpError(400, "BAD_REQUEST", "Quitar el fondo necesita un video o una imagen");
        if (model !== "rvm")
          throw new HttpError(400, "BAD_REQUEST", "Para video se usa RobustVideoMatting (rvm)");
        const high = req.quality === "high";
        ctx.reportProgress(
          0.03,
          `Quitando el fondo (RobustVideoMatting${high ? ", alta calidad" : ""})`,
        );
        // sprint 3b: quality / refinement / SAM mask guide pass straight to the workers
        const maskPath = req.maskAssetId ? requireMaskAsset(deps, req.maskAssetId).path : undefined;
        const r = req.refine;
        const refine = r && {
          ...(r.erode !== undefined && { erode: r.erode }),
          ...(r.feather !== undefined && { feather: r.feather }),
          ...(r.despill !== undefined && { despill: r.despill }),
          ...(r.temporal !== undefined && { temporal: r.temporal }),
          ...(r.maskDilate !== undefined && { mask_dilate: r.maskDilate }),
        };
        const { task_id } = await viaPacks(() =>
          deps.workers.visionMatte({
            path: src.path,
            model,
            output_base: outputBase,
            ...(req.downsample !== undefined && { downsample: req.downsample }),
            ...(req.chunkFrames !== undefined && { chunk_frames: req.chunkFrames }),
            ...(req.quality && { quality: req.quality }),
            ...(refine && Object.keys(refine).length > 0 && { refine }),
            ...(maskPath && { mask_path: maskPath }),
          }),
        );
        ctx.log(`Tarea de recorte ${task_id}`);
        const done = await pollVisionTask(deps, task_id, ctx, WorkerMatteResultSchema, {
          ...o,
          label: "Quitando el fondo",
        });
        warnings.push(...done.warnings, ...(done.result.warnings ?? []));
        previewPath = done.result.preview_path ?? undefined;
        const q = done.result.quality;
        if (q === "fast" || q === "high") hq.quality = q;
        if (done.result.preview_compare_path)
          hq.previewComparePath = done.result.preview_compare_path;
        if (done.result.halo) hq.halo = done.result.halo;
        if (done.result.refine) hq.refine = done.result.refine;
        asset = await registerFileAsset(deps, {
          kind: "video",
          path: done.result.alpha_path,
          name: `${src.name} (recorte)`,
          mimeType: "video/webm",
          hasVideo: true,
          hasAudio: false,
          hasAlpha: true,
          videoCodec: "vp9",
          ...(src.durationSec !== undefined && { durationSec: src.durationSec }),
          ...(src.width && src.height && { width: src.width, height: src.height }),
          ...((done.result.fps ?? src.fps) && { fps: (done.result.fps ?? src.fps)! }),
          probe: true,
        });
      }
      let linkedClip: VisionMatteResult["linkedClip"];
      if (req.target) {
        const matte = { assetId: asset.id, ...(req.background && { background: req.background }) };
        if (deps.repos.projects.patchClip(req.target.projectId, req.target.clipId, { matte }))
          linkedClip = req.target;
        else ctx.log(`Clip ${req.target.clipId} no encontrado: el recorte queda en Medios`);
      }
      return {
        assetId: asset.id,
        path: asset.path,
        sourceAssetId: src.id,
        ...(previewPath && { previewPath }),
        ...hq,
        ...(linkedClip && { linkedClip }),
        ...(warnings.length > 0 && { warnings }),
      };
    },
  };
}

/** Ensure a TrackFile names its source asset (the workers only know the path). */
function withSource(track: unknown, assetId: string, method: string): TrackFile {
  const t = (track ?? {}) as Record<string, unknown>;
  return TrackFileSchema.parse({
    ...t,
    source: { method, ...(t.source as object | undefined), assetId },
  });
}

/** vision.mask: SAM 2 propagate -> track asset + mask folder asset (+ alpha WebM when produced). */
export function createVisionMaskHandler(
  deps: AiDeps,
  o: AiHandlerOptions = {},
): JobHandler<VisionMaskPayload, VisionMaskResult> {
  return {
    type: "vision.mask",
    parse: (p) => VisionMaskPayloadSchema.parse(p),
    async run(req, ctx, job) {
      const src = req.assetId ? requireMediaAsset(deps, req.assetId) : undefined;
      ctx.reportProgress(0.03, "Propagando la máscara (SAM 2)");
      const { task_id } = await viaPacks(() =>
        deps.workers.samPropagate(req.sessionId, {
          ...(req.chunkFrames !== undefined && { chunk_frames: req.chunkFrames }),
        }),
      );
      const { result } = await pollVisionTask(deps, task_id, ctx, WorkerPropagateResultSchema, {
        ...o,
        label: "Propagando la máscara",
        to: 0.9,
      });
      const out: VisionMaskResult = { sessionId: req.sessionId };
      const name = src?.name ?? "Máscara";
      const rawTrack =
        result.track ??
        (result.track_path
          ? await readTrackFile(deps.config.storageDir, result.track_path).catch(() => undefined)
          : undefined);
      if (rawTrack) {
        const track = withSource(rawTrack, src?.id ?? "", "sam2");
        out.trackAssetId = (
          await registerTrackAsset(deps, track, { jobId: job.id, name: `Seguimiento · ${name}` })
        ).id;
      }
      if (result.masks_dir) {
        const rel = await copyIntoMasks(deps.config.storageDir, result.masks_dir, job.id);
        out.maskAssetId = (
          await registerFileAsset(deps, { kind: "mask", path: rel, name: `Máscara · ${name}` })
        ).id;
      }
      if (result.alpha_path) {
        out.alphaAssetId = (
          await registerFileAsset(deps, {
            kind: "video",
            path: result.alpha_path,
            name: `${name} (máscara alfa)`,
            mimeType: "video/webm",
            hasVideo: true,
            hasAudio: false,
            hasAlpha: true,
            videoCodec: "vp9",
            ...(src?.durationSec !== undefined && { durationSec: src.durationSec }),
            ...(src?.width && src.height && { width: src.width, height: src.height }),
            probe: true,
          })
        ).id;
      }
      return out;
    },
  };
}

/**
 * Tracker for a vision.track request: "auto" -> "sam2" when the workers list the sam2 pack as
 * installed (GET /packs), else "csrt" (OpenCV CSRT, or template matching on headless builds).
 * Unreachable workers = "csrt" (the job then reports the real error).
 */
export async function resolveTrackMethod(
  workers: Pick<WorkersClient, "packs">,
  method: TrackRequestMethod,
): Promise<TrackMethod> {
  if (method !== "auto") return method;
  const packs = await workers.packs().catch(() => undefined);
  return packs?.some((p) => p.id === "sam2" && p.installed) ? "sam2" : "csrt";
}

/** vision.track: CSRT / SAM 2 tracking -> asset kind "track" (+ clip.trackRef with a target). */
export function createVisionTrackHandler(
  deps: AiDeps,
  o: AiHandlerOptions = {},
): JobHandler<VisionTrackRequest, VisionTrackResult> {
  return {
    type: "vision.track",
    parse: (p) => VisionTrackRequestSchema.parse(p),
    async run(req, ctx, job) {
      const src = requireMediaAsset(deps, req.assetId);
      if (src.kind !== "video")
        throw new HttpError(400, "BAD_REQUEST", "El seguimiento necesita un video");
      const mask = req.maskAssetId
        ? await maskPngOf(deps.config.storageDir, requireMediaAsset(deps, req.maskAssetId))
        : undefined;
      const method = await resolveTrackMethod(deps.workers, req.method);
      ctx.reportProgress(
        0.03,
        method === "sam2" ? "Siguiendo el objeto (SAM 2)" : "Siguiendo el objeto",
      );
      const { task_id } = await viaPacks(() =>
        deps.workers.visionTrack({
          path: src.path,
          method,
          ...(req.bbox && !mask && { bbox: req.bbox }),
          ...(mask && { mask_png: mask }),
          ...(req.frameRange && { frame_range: req.frameRange }),
        }),
      );
      const { result } = await pollVisionTask(deps, task_id, ctx, WorkerTrackResultSchema, {
        ...o,
        label: "Siguiendo el objeto",
      });
      const raw = JSON.parse(
        await readFile(resolveStoragePath(deps.config.storageDir, result.track_path), "utf8"),
      ) as unknown;
      const track = withSource(raw, src.id, method);
      if (track.frames.length === 0) throw new Error("El seguimiento no encontró el objeto");
      const asset = await registerTrackAsset(deps, track, {
        jobId: job.id,
        name: `Seguimiento · ${src.name}`,
      });
      let linkedClip: VisionTrackResult["linkedClip"];
      if (req.target) {
        const { projectId, clipId, anchor, offset } = req.target;
        const trackRef = { assetId: asset.id, anchor, offset };
        if (deps.repos.projects.patchClip(projectId, clipId, { trackRef }))
          linkedClip = { projectId, clipId };
        else ctx.log(`Clip ${clipId} no encontrado: el seguimiento queda en Medios`);
      }
      return {
        assetId: asset.id,
        path: asset.path,
        frames: track.frames.length,
        smoothed: track.smoothed || result.smoothed,
        method: track.source.method,
        ...(linkedClip && { linkedClip }),
      };
    },
  };
}

/** Video clip analyzed by vision.reframe: `clipId` or the first visible video clip with media. */
export function reframeSourceClip(project: Project, clipId?: string): Clip {
  if (clipId) {
    const { clip } = findClip(project, clipId);
    if (!clip.assetId) throw new HttpError(400, "BAD_REQUEST", "El clip no tiene medio");
    return clip;
  }
  const clip = project.tracks
    .filter((t) => t.kind === "video" && !t.hidden)
    .flatMap((t) => [...t.clips].sort((a, b) => a.start - b.start))
    .find((c) => c.assetId);
  if (!clip) throw new HttpError(400, "BAD_REQUEST", "El proyecto no tiene clips de video");
  return clip;
}

/**
 * Worker crop keyframes (source seconds, fractions or percent of the source) -> project.reframe
 * keyframes (absolute timeline seconds, fractions of the canvas through the clip's rect).
 */
export function reframeKeyframesToTimeline(
  project: Pick<Project, "settings">,
  clip: Clip,
  media: { width: number; height: number } | undefined,
  keyframes: readonly Keyframe[],
): Keyframe<CropRect>[] {
  const canvas = { width: project.settings.width, height: project.settings.height };
  const rect = fitRect(canvas, media, clip);
  const speed = clip.speed || 1;
  const end = clip.start + (clip.out - clip.in) / speed;
  const out: Keyframe<CropRect>[] = [];
  for (const k of sortKeyframes(keyframes)) {
    if (typeof k.v !== "object" || !("w" in k.v)) continue;
    const r = normalizeCropRect(k.v);
    const t = clip.start + (k.t - clip.in) / speed;
    if (t < clip.start - 1e-6 || t > end + 1e-6) continue;
    out.push({
      t: Math.round(t * 1e6) / 1e6,
      ease: k.ease ?? "linear",
      v: {
        x: (rect.x + r.x * rect.width) / canvas.width,
        y: (rect.y + r.y * rect.height) / canvas.height,
        w: (r.w * rect.width) / canvas.width,
        h: (r.h * rect.height) / canvas.height,
      },
    });
  }
  return out;
}

/** vision.reframe: YuNet (face) or a track -> project.reframe (crop keyframes), saved. */
export function createVisionReframeHandler(
  deps: AiDeps,
  o: AiHandlerOptions = {},
): JobHandler<VisionReframeRequest, VisionReframeResult> {
  return {
    type: "vision.reframe",
    parse: (p) => VisionReframeRequestSchema.parse(p),
    async run(req, ctx) {
      const project = requireProject(deps, req.projectId);
      const clip = reframeSourceClip(project, req.clipId);
      const asset = requireMediaAsset(deps, clip.assetId!);
      let trackPath: string | undefined;
      if (req.subject === "track") {
        if (!req.trackAssetId)
          throw new HttpError(400, "BAD_REQUEST", "Elegí un seguimiento (trackAssetId)");
        trackPath = requireMediaAsset(deps, req.trackAssetId).path;
      }
      const scenes = (asset.scenes ?? [])
        .filter((s) => s.end > clip.in && s.start < clip.out)
        .map((s) => ({ start: s.start, end: s.end }));
      ctx.reportProgress(0.03, `Reencuadrando a ${req.target}`);
      const { task_id } = await viaPacks(() =>
        deps.workers.visionReframe({
          path: asset.path,
          target: req.target,
          subject: req.subject,
          ...(scenes.length > 0 && { scenes }),
          ...(trackPath && { track_path: trackPath }),
        }),
      );
      const { result } = await pollVisionTask(deps, task_id, ctx, WorkerReframeResultSchema, {
        ...o,
        label: "Reencuadrando",
      });
      const media =
        asset.width && asset.height ? { width: asset.width, height: asset.height } : undefined;
      const keyframes = reframeKeyframesToTimeline(project, clip, media, result.keyframes);
      if (keyframes.length === 0) throw new Error("El reencuadre no devolvió keyframes de recorte");
      const reframe: ProjectReframe = { target: req.target, keyframes, mode: "auto" };
      // Re-read: the user may have saved while the workers ran.
      const latest = requireProject(deps, req.projectId);
      const saved = deps.repos.projects.save(req.projectId, { ...latest, reframe });
      if (!saved) throw new HttpError(404, "NOT_FOUND", "Proyecto no encontrado");
      ctx.log(`Reencuadre ${req.target}: ${keyframes.length} keyframes`);
      return { project: saved, reframe, clipId: clip.id, assetId: asset.id };
    },
  };
}

/** timeline.track-to-keyframes: trackRef -> keyframes.position (RDP, ≤ perSecond per second). */
export function createTrackToKeyframesHandler(
  deps: AiDeps,
): JobHandler<TrackToKeyframesRequest, TrackToKeyframesResult> {
  return {
    type: "timeline.track-to-keyframes",
    parse: (p) => TrackToKeyframesRequestSchema.parse(p),
    async run(req, ctx) {
      const project = requireProject(deps, req.projectId);
      const { clip } = findClip(project, req.clipId);
      if (!clip.trackRef) throw new HttpError(400, "BAD_REQUEST", "El clip no sigue ningún objeto");
      const trackAsset = requireMediaAsset(deps, clip.trackRef.assetId);
      const track = await readTrackFile(deps.config.storageDir, trackAsset.path);
      ctx.reportProgress(0.3, "Convirtiendo el seguimiento en keyframes");
      const position = trackRefKeyframes(project, clip, track, sizeOf(deps), req.perSecond, 0.001);
      if (position.length === 0)
        throw new Error("El seguimiento no cubre el clip: no hay keyframes que crear");
      const { trackRef: _ref, ...rest } = clip;
      const next: Clip = { ...rest, keyframes: { ...clip.keyframes, position } };
      const updated = {
        ...project,
        tracks: project.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) => (c.id === clip.id ? next : c)),
        })),
      };
      const saved = deps.repos.projects.save(req.projectId, updated);
      if (!saved) throw new HttpError(404, "NOT_FOUND", "Proyecto no encontrado");
      return { project: saved, clipId: clip.id, keyframes: position.length };
    },
  };
}

/** Register the Sprint 2 vision handlers on the queue. */
export function registerVisionHandlers(deps: AiDeps, o: AiHandlerOptions = {}): void {
  deps.queue
    .register(createVisionMatteHandler(deps, o) as JobHandler)
    .register(createVisionMaskHandler(deps, o) as JobHandler)
    .register(createVisionTrackHandler(deps, o) as JobHandler)
    .register(createVisionReframeHandler(deps, o) as JobHandler)
    .register(createTrackToKeyframesHandler(deps) as JobHandler);
}

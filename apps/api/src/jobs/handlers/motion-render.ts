import { nanoid } from "nanoid";
import {
  TRACK_AWARE_TEMPLATES,
  trackToCanvas,
  type Clip,
  type MotionSpec,
  type Project,
  type Size,
  type TrackFile,
  type FileJobResult,
  type MotionEngineId,
  type MotionOutputFormat,
  MotionRenderRequestSchema,
  type MotionRenderRequest,
  type MotionRenderTarget,
} from "@studio/shared";
import { outputExtension, overallProgress } from "@studio/motion-engines";
import type { ApiConfig } from "../../config.js";
import type { AppContext } from "../../context.js";
import { storageRelative } from "../../services/storage.js";
import { readTrackFile } from "../../services/vision-assets.js";
import type { JobHandler } from "../types.js";
import { absPath, checkAborted, fileSize, jobTmpDir } from "./util.js";

/** FileJobResult + render metadata (shown in the Jobs panel / used by the timeline). */
export interface MotionRenderJobResult extends FileJobResult {
  engine: MotionEngineId;
  format: MotionOutputFormat;
  hasAlpha: boolean;
  durationSec: number;
  width: number;
  height: number;
  renderTimeMs: number;
  /** Clip whose `renderedAssetId` was set to `assetId` (when the request had a target). */
  linkedClip?: MotionRenderTarget;
}

const MIME: Record<Exclude<MotionOutputFormat, "png-sequence">, string> = {
  "mp4-h264": "video/mp4",
  "webm-vp9-alpha": "video/webm",
  "prores-4444": "video/quicktime",
};

/**
 * Sprint 2: props that make a track-aware template (animated-captions, lower-third) follow the
 * clip's trackRef: the TrackFile mapped onto the canvas (shared trackToCanvas) with times in
 * composition seconds (clip.in + clip-local time × speed), plus anchor and offset.
 */
export function trackPropsFor(
  project: Pick<Project, "tracks" | "settings">,
  clip: Clip,
  track: TrackFile,
  mediaSize: (assetId: string) => Size | undefined,
): Record<string, unknown> {
  if (!clip.trackRef) return {};
  const ct = trackToCanvas(project, clip, track, mediaSize);
  const speed = clip.speed || 1;
  return {
    track: { ...ct, frames: ct.frames.map((f) => ({ ...f, t: clip.in + f.t * speed })) },
    trackAnchor: clip.trackRef.anchor,
    trackOffset: clip.trackRef.offset,
  };
}

/** The spec with track props when the target clip follows a track (else unchanged). */
export async function withTrackProps(
  app: Pick<AppContext, "repos" | "config">,
  spec: MotionSpec,
  target: MotionRenderTarget | undefined,
  log: (line: string) => void = () => {},
): Promise<MotionSpec> {
  if (!target || !(TRACK_AWARE_TEMPLATES as readonly string[]).includes(spec.template)) return spec;
  const project = app.repos.projects.get(target.projectId);
  const clip = project?.tracks.flatMap((t) => t.clips).find((c) => c.id === target.clipId);
  if (!project || !clip?.trackRef) return spec;
  const asset = app.repos.media.get(clip.trackRef.assetId);
  if (!asset) {
    log(`Seguimiento ${clip.trackRef.assetId} no encontrado: posición fija`);
    return spec;
  }
  try {
    const track = await readTrackFile(app.config.storageDir, asset.path);
    const size = (id: string) => {
      const a = app.repos.media.get(id);
      return a?.width && a.height ? { width: a.width, height: a.height } : undefined;
    };
    log(`Siguiendo el seguimiento ${asset.id} (${track.frames.length} cuadros)`);
    return { ...spec, props: { ...spec.props, ...trackPropsFor(project, clip, track, size) } };
  } catch (err) {
    log(`Seguimiento ${asset.id} ilegible (${String(err)}): posición fija`);
    return spec;
  }
}

/** URL serving STORAGE_DIR (`/files/`) as seen by headless browsers on this PC. */
export function motionMediaBaseUrl(config: Pick<ApiConfig, "host" | "port">): string {
  const host = ["0.0.0.0", "::", ""].includes(config.host) ? "127.0.0.1" : config.host;
  return `http://${host.includes(":") ? `[${host}]` : host}:${config.port}/files/`;
}

/**
 * motion.render (module c): validate MotionSpec -> registry (remotion / ffmpeg-lottie / ...) ->
 * storage/renders/<jobId>.<ext> (folder for png-sequence) -> new video MediaAsset (hasAlpha for
 * overlays) so the timeline can use it right away. With `target {projectId, clipId}` the stored
 * project's clip gets `renderedAssetId`, which is what project.export composites.
 */
export function createMotionRenderHandler(
  app: AppContext,
): JobHandler<MotionRenderRequest, MotionRenderJobResult> {
  return {
    type: "motion.render",
    parse: (payload) => MotionRenderRequestSchema.parse(payload),
    async run({ target, ...rawSpec }, ctx, job) {
      const spec = await withTrackProps(app, rawSpec, target, ctx.log);
      const outputPath = storageRelative("renders", `${job.id}${outputExtension(spec.format)}`);
      const tmp = await jobTmpDir(app, job.id);
      ctx.reportProgress(0, "En cola de render");
      let result;
      try {
        result = await app.motion.render(spec, {
          jobId: job.id,
          storageDir: app.config.storageDir,
          outputPath,
          tmpDir: tmp.dir,
          mediaBaseUrl: motionMediaBaseUrl(app.config),
          signal: ctx.signal,
          onProgress: (p) => ctx.reportProgress(overallProgress(p), p.message),
        });
      } catch (err) {
        checkAborted(ctx);
        ctx.log(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
        throw err;
      } finally {
        await tmp.cleanup();
      }

      let assetId: string | undefined;
      if (result.format !== "png-sequence") {
        const asset = app.repos.media.insert({
          id: nanoid(),
          kind: "video",
          name: `Motion · ${spec.template}`,
          path: result.path,
          mimeType: MIME[result.format],
          sizeBytes: await fileSize(absPath(app, result.path)),
          durationSec: result.durationSec,
          width: result.width,
          height: result.height,
          fps: spec.fps,
          hasVideo: true,
          hasAudio: spec.includeAudio,
          hasAlpha: result.hasAlpha,
          createdAt: new Date().toISOString(),
        });
        assetId = asset.id;
        if (app.queue.hasHandler("media.probe"))
          app.queue.enqueue({ type: "media.probe", payload: { assetId }, priority: 1 });
      }
      let linkedClip: MotionRenderTarget | undefined;
      if (assetId && target) {
        if (
          app.repos.projects.patchClip(target.projectId, target.clipId, {
            renderedAssetId: assetId,
          })
        )
          linkedClip = target;
        else ctx.log(`Clip ${target.clipId} no encontrado en el proyecto ${target.projectId}`);
      }
      return {
        ...(assetId && { assetId }),
        path: result.path,
        engine: result.engine,
        format: result.format,
        hasAlpha: result.hasAlpha,
        durationSec: result.durationSec,
        width: result.width,
        height: result.height,
        renderTimeMs: result.renderTimeMs,
        ...(linkedClip && { linkedClip }),
      };
    },
  };
}

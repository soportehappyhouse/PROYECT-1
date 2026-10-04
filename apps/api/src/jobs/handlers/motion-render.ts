import { nanoid } from "nanoid";
import {
  type FileJobResult,
  type MotionEngineId,
  type MotionOutputFormat,
  MotionSpecSchema,
  type MotionSpec,
} from "@studio/shared";
import { outputExtension, overallProgress } from "@studio/motion-engines";
import type { ApiConfig } from "../../config.js";
import type { AppContext } from "../../context.js";
import { storageRelative } from "../../services/storage.js";
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
}

const MIME: Record<Exclude<MotionOutputFormat, "png-sequence">, string> = {
  "mp4-h264": "video/mp4",
  "webm-vp9-alpha": "video/webm",
  "prores-4444": "video/quicktime",
};

/** URL serving STORAGE_DIR (`/files/`) as seen by headless browsers on this PC. */
export function motionMediaBaseUrl(config: Pick<ApiConfig, "host" | "port">): string {
  const host = ["0.0.0.0", "::", ""].includes(config.host) ? "127.0.0.1" : config.host;
  return `http://${host.includes(":") ? `[${host}]` : host}:${config.port}/files/`;
}

/**
 * motion.render (module c): validate MotionSpec -> registry (remotion / ffmpeg-lottie / ...) ->
 * storage/renders/<jobId>.<ext> (folder for png-sequence) -> new video MediaAsset (hasAlpha for
 * overlays) so the timeline can use it right away.
 */
export function createMotionRenderHandler(
  app: AppContext,
): JobHandler<MotionSpec, MotionRenderJobResult> {
  return {
    type: "motion.render",
    parse: (payload) => MotionSpecSchema.parse(payload),
    async run(spec, ctx, job) {
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
      };
    },
  };
}

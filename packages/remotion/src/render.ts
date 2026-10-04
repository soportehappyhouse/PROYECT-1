import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALPHA_OUTPUT_FORMATS, type MotionOutputFormat, type MotionSpec } from "@studio/shared";
import type { MotionRenderContext, MotionRenderResult } from "@studio/motion-engines";
import type { RenderMediaOptions } from "@remotion/renderer";
import { webpackOverride } from "./webpack-override.js";

/** Absolute path to the Remotion entry (works from src/ and dist/). */
export const REMOTION_ENTRY = fileURLToPath(new URL("../src/entry.ts", import.meta.url));

let bundlePromise: Promise<string> | undefined;

/** Bundle the compositions once per process (webpack); cached afterwards. */
export async function getServeUrl(): Promise<string> {
  // TODO(module-c): cache bundle on disk keyed by a hash of packages/remotion/src.
  bundlePromise ??= import("@remotion/bundler").then(({ bundle }) =>
    bundle({ entryPoint: REMOTION_ENTRY, webpackOverride }),
  );
  return bundlePromise;
}

type CodecOptions = Pick<RenderMediaOptions, "codec" | "imageFormat" | "pixelFormat"> & {
  proResProfile?: "4444";
};

/** Output format -> Remotion codec settings (see docs/trabajo/fuentes-motion.md §1). */
function codecOptions(format: MotionOutputFormat): CodecOptions {
  switch (format) {
    case "mp4-h264":
      return { codec: "h264", imageFormat: "jpeg" };
    case "webm-vp9-alpha":
      return { codec: "vp9", imageFormat: "png", pixelFormat: "yuva420p" };
    case "prores-4444":
      return {
        codec: "prores",
        imageFormat: "png",
        pixelFormat: "yuva444p10le",
        proResProfile: "4444",
      };
    case "png-sequence":
      // TODO(module-c): use renderFrames() for image sequences.
      throw new Error("png-sequence not implemented yet (module-c)");
  }
}

/**
 * Render a MotionSpec with Remotion into ctx.storageDir/ctx.outputPath.
 * Plugged into @studio/motion-engines via createRemotionEngine({ render: renderMotion }).
 */
export async function renderMotion(
  spec: MotionSpec,
  ctx: MotionRenderContext,
): Promise<MotionRenderResult> {
  const started = Date.now();
  const { selectComposition, renderMedia, makeCancelSignal } = await import("@remotion/renderer");
  ctx.onProgress?.({ phase: "bundling", ratio: 0, message: "Preparando plantillas" });
  const serveUrl = await getServeUrl();
  // TODO(module-c): translate spec.media refs to `${ctx.mediaBaseUrl}${ref.path}` URLs in props.
  const inputProps = {
    ...spec.props,
    __width: spec.width,
    __height: spec.height,
    __fps: spec.fps,
    __durationInFrames: Math.round(spec.durationSec * spec.fps),
  };
  const composition = await selectComposition({ serveUrl, id: spec.template, inputProps });
  const { cancelSignal, cancel } = makeCancelSignal();
  ctx.signal?.addEventListener("abort", () => cancel(), { once: true });

  // TODO(module-c): concurrency (50% CPU), hardwareAcceleration flag, Chrome path from setup.
  await renderMedia({
    composition,
    serveUrl,
    ...codecOptions(spec.format),
    muted: !spec.includeAudio,
    outputLocation: path.resolve(ctx.storageDir, ctx.outputPath),
    inputProps,
    cancelSignal,
    onProgress: ({ progress }) =>
      ctx.onProgress?.({ phase: "rendering", ratio: progress, message: "Renderizando" }),
  });
  ctx.onProgress?.({ phase: "done", ratio: 1 });

  return {
    path: ctx.outputPath,
    format: spec.format,
    hasAlpha: ALPHA_OUTPUT_FORMATS.includes(spec.format),
    durationSec: spec.durationSec,
    width: spec.width,
    height: spec.height,
    engine: "remotion",
    renderTimeMs: Date.now() - started,
  };
}

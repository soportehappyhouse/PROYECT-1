import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { ALPHA_OUTPUT_FORMATS, type MotionOutputFormat, type MotionSpec } from "@studio/shared";
import {
  MotionEngineError,
  type MotionRenderContext,
  type MotionRenderResult,
  type RemotionEngineOptions,
} from "@studio/motion-engines";
import type { RenderMediaOptions } from "@remotion/renderer";
import {
  checkRemotionAvailable,
  RemotionBrowserMissingError,
  resolveBrowserExecutable,
} from "./browser.js";
import { clearBundleCache, getServeUrl } from "./bundle.js";
import { buildInputProps } from "./props.js";
import { REMOTION_TEMPLATES, validateRemotionProps } from "./templates.js";

export { REMOTION_ENTRY, getServeUrl } from "./bundle.js";

export interface RemotionRendererSettings {
  /** Number of tabs or "50%" of CPU threads (Remotion default). Env: REMOTION_CONCURRENCY. */
  concurrency: number | string | null;
  /** Chrome Headless Shell path. Env: REMOTION_BROWSER_EXECUTABLE. Null = auto-detect. */
  browserExecutable: string | null;
  /** NVENC etc. Env: REMOTION_HW_ACCEL=true -> "if-possible". CPU only by default. */
  hardwareAcceleration: "disable" | "if-possible";
  /** "system" (default) never downloads Google Fonts; "google" is opt-in. Env: REMOTION_FONTS. */
  fontMode: "google" | "system";
  /** Bundle cache root. Null = `<storageDir>/tmp/remotion-bundle`. Env: REMOTION_BUNDLE_CACHE. */
  bundleCacheDir: string | null;
  /** delayRender timeout (fonts, media). Env: REMOTION_TIMEOUT_MS. */
  timeoutInMilliseconds: number;
}

function fromEnv(env: NodeJS.ProcessEnv = process.env): RemotionRendererSettings {
  const c = env.REMOTION_CONCURRENCY?.trim();
  return {
    concurrency: c ? (/^\d+$/.test(c) ? Number(c) : c) : "50%",
    browserExecutable: env.REMOTION_BROWSER_EXECUTABLE?.trim() || null,
    hardwareAcceleration: /^(1|true)$/i.test(env.REMOTION_HW_ACCEL ?? "")
      ? "if-possible"
      : "disable",
    fontMode: env.REMOTION_FONTS?.trim() === "google" ? "google" : "system",
    bundleCacheDir: env.REMOTION_BUNDLE_CACHE?.trim() || null,
    timeoutInMilliseconds:
      Number(env.REMOTION_TIMEOUT_MS) > 0 ? Number(env.REMOTION_TIMEOUT_MS) : 60_000,
  };
}

let overrides: Partial<RemotionRendererSettings> = {};

/** Override renderer settings (otherwise read from env at render time, after .env is loaded). */
export function configureRemotionRenderer(partial: Partial<RemotionRendererSettings>): void {
  overrides = { ...overrides, ...partial };
}

export function getRendererSettings(): RemotionRendererSettings {
  return { ...fromEnv(), ...overrides };
}

type CodecOptions = Pick<RenderMediaOptions, "codec" | "imageFormat" | "pixelFormat"> & {
  proResProfile?: "4444";
};

/** Output format -> Remotion codec settings (docs/trabajo/fuentes-motion.md §1). */
export function codecOptions(format: Exclude<MotionOutputFormat, "png-sequence">): CodecOptions {
  switch (format) {
    case "mp4-h264":
      return { codec: "h264", imageFormat: "jpeg", pixelFormat: "yuv420p" };
    case "webm-vp9-alpha":
      return { codec: "vp9", imageFormat: "png", pixelFormat: "yuva420p" };
    case "prores-4444":
      return {
        codec: "prores",
        imageFormat: "png",
        pixelFormat: "yuva444p10le",
        proResProfile: "4444",
      };
  }
}

/**
 * Render a MotionSpec with Remotion into ctx.storageDir/ctx.outputPath (folder for png-sequence).
 * Plugged into @studio/motion-engines via createRemotionEngine(REMOTION_ENGINE_OPTIONS).
 */
export async function renderMotion(
  spec: MotionSpec,
  ctx: MotionRenderContext,
): Promise<MotionRenderResult> {
  const started = Date.now();
  const settings = getRendererSettings();
  ctx.onProgress?.({ phase: "preparing", ratio: 0, message: "Preparando render" });

  const browserExecutable = resolveBrowserExecutable(settings.browserExecutable);
  if (!browserExecutable) throw new RemotionBrowserMissingError();

  const inputProps = await buildInputProps(spec, {
    storageDir: ctx.storageDir,
    mediaBaseUrl: ctx.mediaBaseUrl,
    fontMode: settings.fontMode,
  });

  const serveUrl = await getServeUrl({
    cacheDir: settings.bundleCacheDir ?? path.join(ctx.storageDir, "tmp", "remotion-bundle"),
    onProgress: (ratio) =>
      ctx.onProgress?.({ phase: "bundling", ratio, message: "Preparando plantillas" }),
  });
  if (ctx.signal?.aborted) throw new MotionEngineError("Render cancelado", "remotion");

  const { selectComposition, renderMedia, renderFrames, makeCancelSignal } =
    await import("@remotion/renderer");
  const common = {
    serveUrl,
    inputProps,
    browserExecutable,
    timeoutInMilliseconds: settings.timeoutInMilliseconds,
    logLevel: "warn" as const,
    chromeMode: "headless-shell" as const,
  };
  const composition = await selectComposition({ ...common, id: spec.template });
  const { cancelSignal, cancel } = makeCancelSignal();
  ctx.signal?.addEventListener("abort", () => cancel(), { once: true });

  const output = path.resolve(ctx.storageDir, ctx.outputPath);
  const total = composition.durationInFrames;
  if (spec.format === "png-sequence") {
    await rm(output, { recursive: true, force: true });
    await mkdir(output, { recursive: true });
    await renderFrames({
      ...common,
      composition,
      outputDir: output,
      imageFormat: "png",
      concurrency: settings.concurrency,
      cancelSignal,
      onStart: () => undefined,
      onFrameUpdate: (rendered) =>
        ctx.onProgress?.({ phase: "rendering", ratio: rendered / total, message: "Renderizando" }),
    });
  } else {
    await mkdir(path.dirname(output), { recursive: true });
    await renderMedia({
      ...common,
      composition,
      ...codecOptions(spec.format),
      outputLocation: output,
      overwrite: true,
      muted: !spec.includeAudio,
      concurrency: settings.concurrency,
      hardwareAcceleration: settings.hardwareAcceleration,
      cancelSignal,
      onProgress: ({ progress, stitchStage }) =>
        ctx.onProgress?.({
          phase: stitchStage === "muxing" ? "encoding" : "rendering",
          ratio: progress,
          message: stitchStage === "muxing" ? "Codificando" : "Renderizando",
        }),
    });
  }
  ctx.onProgress?.({ phase: "done", ratio: 1, message: "Listo" });

  return {
    path: ctx.outputPath,
    format: spec.format,
    hasAlpha: ALPHA_OUTPUT_FORMATS.includes(spec.format),
    durationSec: total / composition.fps,
    width: composition.width,
    height: composition.height,
    engine: "remotion",
    renderTimeMs: Date.now() - started,
  };
}

export async function disposeRemotion(): Promise<void> {
  clearBundleCache();
}

/**
 * Everything the remotion MotionEngine adapter needs. apps/api:
 * `createDefaultRegistry({ remotion: REMOTION_ENGINE_OPTIONS, ffmpegPath })`.
 */
export const REMOTION_ENGINE_OPTIONS: RemotionEngineOptions = {
  templates: REMOTION_TEMPLATES,
  render: renderMotion,
  validateProps: (templateId, props) => {
    const v = validateRemotionProps(templateId, props);
    return v.ok ? { ok: true } : v;
  },
  checkAvailable: () => checkRemotionAvailable(getRendererSettings().browserExecutable),
  dispose: disposeRemotion,
};

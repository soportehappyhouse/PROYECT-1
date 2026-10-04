import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ALPHA_OUTPUT_FORMATS, type MotionSpec, type MotionTemplateInfo } from "@studio/shared";
import { z } from "zod";
import { MotionEngineError } from "../errors.js";
import { ffmpegOutput, runFfmpeg } from "../ffmpeg/run.js";
import { buildTitleArgs, defaultFontFile, ffmpegTitleSchema } from "../ffmpeg/title.js";
import type { MotionAvailability, MotionEngine, MotionValidation } from "../types.js";

export const FFMPEG_TITLE_TEMPLATE: MotionTemplateInfo = {
  engine: "ffmpeg-lottie",
  id: "ffmpeg-title",
  name: "Título con fundido (FFmpeg)",
  description:
    "Título drawtext con fundido y subida, sobre color, transparente o un video. Admite un overlay " +
    "con alpha (p. ej. un Lottie renderizado con la plantilla Remotion lottie-overlay en WebM).",
  propsSchema: z.toJSONSchema(ffmpegTitleSchema, { io: "input", unrepresentable: "any" }),
  defaultProps: ffmpegTitleSchema.parse({}),
  defaultDurationSec: 3,
  supportsAlpha: true,
};

export interface FfmpegLottieEngineOptions {
  /** Absolute ffmpeg path ("ffmpeg" = from PATH). Must be the SYSTEM ffmpeg (needs drawtext). */
  ffmpegPath: string;
  /** Override the platform default font used by drawtext. */
  defaultFontFile?: string | null;
}

/** Validates props + media refs for the ffmpeg-title template. */
export function validateFfmpegTitle(spec: MotionSpec): MotionValidation {
  const errors: string[] = [];
  const parsed = ffmpegTitleSchema.safeParse(spec.props);
  if (!parsed.success)
    errors.push(...parsed.error.issues.map((i) => `${i.path.join(".") || "props"}: ${i.message}`));
  for (const [key, ref] of Object.entries(spec.media ?? {})) {
    if (key === "background" && ref.kind !== "video" && ref.kind !== "image")
      errors.push("media.background debe ser video o imagen");
    else if (key === "overlay" && ref.kind !== "video")
      errors.push(
        "media.overlay debe ser un video con alpha (WebM/MOV). Un .json Lottie se renderiza antes con la plantilla Remotion lottie-overlay",
      );
    else if (key !== "background" && key !== "overlay")
      errors.push(`media.${key} no se usa en ffmpeg-title (usa background u overlay)`);
    if (ref.path.split(/[\\/]/).includes("..")) errors.push(`Ruta no permitida: ${ref.path}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

/**
 * FFmpeg + Lottie adapter (docs/trabajo/fuentes-motion.md §4). Real, minimal implementation:
 * drawtext title with fade/rise + optional alpha overlay, encoded with the SYSTEM ffmpeg.
 * Lottie JSON itself is rasterized by Remotion (@remotion/lottie, template `lottie-overlay`,
 * webm-vp9-alpha); this engine composites that WebM. A puppeteer+lottie-web rasterizer would
 * plug in here later without changing the interface.
 */
export function createFfmpegLottieEngine(options: FfmpegLottieEngineOptions): MotionEngine {
  let availability: Promise<MotionAvailability> | undefined;
  const fontFile = () =>
    options.defaultFontFile !== undefined ? options.defaultFontFile : defaultFontFile();

  return {
    id: "ffmpeg-lottie",
    displayName: "FFmpeg + Lottie",
    capabilities: () => ({
      formats: ["mp4-h264", "webm-vp9-alpha", "prores-4444", "png-sequence"],
      templates: [FFMPEG_TITLE_TEMPLATE.id],
      supportsAlpha: true,
      maxFps: 60,
      maxDurationSec: 600,
      cpuOnly: true,
      needsSystemFfmpeg: true,
    }),
    checkAvailable: () =>
      (availability ??= ffmpegOutput(options.ffmpegPath, ["-hide_banner", "-filters"])
        .then((out): MotionAvailability => {
          const missing = ["drawtext", "overlay"].filter(
            (f) => !new RegExp(`\\s${f}\\s`).test(out),
          );
          return missing.length
            ? {
                ok: false,
                reason: `El FFmpeg de sistema no trae ${missing.join(", ")}. Instala la build completa: winget install -e --id Gyan.FFmpeg`,
              }
            : { ok: true };
        })
        .catch(() => ({
          ok: false,
          reason: `FFmpeg no encontrado (${options.ffmpegPath}). Instálalo con winget install -e --id Gyan.FFmpeg o define FFMPEG_PATH`,
        }))),
    listTemplates: () => Promise.resolve([FFMPEG_TITLE_TEMPLATE]),
    validate: (spec) =>
      spec.template === FFMPEG_TITLE_TEMPLATE.id
        ? validateFfmpegTitle(spec)
        : { ok: false, errors: [`Plantilla FFmpeg desconocida: ${spec.template}`] },
    async render(spec, ctx) {
      const started = Date.now();
      const props = ffmpegTitleSchema.parse(spec.props);
      ctx.onProgress?.({ phase: "preparing", ratio: 0, message: "Preparando FFmpeg" });
      await mkdir(ctx.tmpDir, { recursive: true });
      const titleFile = path.join(ctx.tmpDir, "title.txt");
      await writeFile(titleFile, props.text, "utf8");
      let subtitleFile: string | undefined;
      if (props.subtitle.trim()) {
        subtitleFile = path.join(ctx.tmpDir, "subtitle.txt");
        await writeFile(subtitleFile, props.subtitle, "utf8");
      }
      const abs = (rel: string) => path.resolve(ctx.storageDir, rel);
      const bg = spec.media?.background;
      const output = abs(ctx.outputPath);
      if (spec.format === "png-sequence") {
        await rm(output, { recursive: true, force: true });
        await mkdir(output, { recursive: true });
      } else {
        await mkdir(path.dirname(output), { recursive: true });
      }
      const args = buildTitleArgs({
        spec,
        props,
        output,
        titleFile,
        ...(subtitleFile && { subtitleFile }),
        fontFile: props.fontFile ?? fontFile(),
        ...(bg && {
          backgroundMedia: { path: abs(bg.path), kind: bg.kind === "image" ? "image" : "video" },
        }),
        ...(spec.media?.overlay && { overlay: abs(spec.media.overlay.path) }),
      });
      try {
        await runFfmpeg({
          ffmpegPath: options.ffmpegPath,
          args,
          durationSec: spec.durationSec,
          ...(ctx.signal && { signal: ctx.signal }),
          onProgress: (ratio) =>
            ctx.onProgress?.({ phase: "rendering", ratio, message: "Renderizando con FFmpeg" }),
        });
      } catch (err) {
        throw new MotionEngineError((err as Error).message, "ffmpeg-lottie");
      }
      ctx.onProgress?.({ phase: "done", ratio: 1, message: "Listo" });
      return {
        path: ctx.outputPath,
        format: spec.format,
        hasAlpha:
          ALPHA_OUTPUT_FORMATS.includes(spec.format) &&
          !bg &&
          (props.background === "transparent" || props.background.includes("@")),
        durationSec: spec.durationSec,
        width: spec.width,
        height: spec.height,
        engine: "ffmpeg-lottie",
        renderTimeMs: Date.now() - started,
      };
    },
  };
}

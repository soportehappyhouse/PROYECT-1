import type { MotionTemplateInfo } from "@studio/shared";
import { MotionEngineNotImplementedError } from "../errors.js";
import type { MotionEngine } from "../types.js";

const TEMPLATES: MotionTemplateInfo[] = [
  {
    engine: "ffmpeg-lottie",
    id: "lottie-overlay",
    name: "Overlay Lottie (ejemplo)",
    description: "Renders a Lottie JSON animation to a transparent overlay video.",
    defaultProps: { lottiePath: "library/lottie/example.json", loop: false },
    defaultDurationSec: 2,
    supportsAlpha: true,
  },
];

export interface FfmpegLottieEngineOptions {
  /** Absolute ffmpeg path ("ffmpeg" = from PATH). Must be the SYSTEM ffmpeg. */
  ffmpegPath: string;
}

/**
 * FFmpeg + Lottie adapter — SKELETON.
 * TODO(module-c): per docs/trabajo/fuentes-motion.md, rasterize Lottie to PNG frames
 * (own puppeteer + lottie-web script, or @remotion/lottie) then encode with ffmpeg to
 * WebM VP9 yuva420p / ProRes 4444 at ctx.outputPath. One example animation required.
 */
export function createFfmpegLottieEngine(_options: FfmpegLottieEngineOptions): MotionEngine {
  return {
    id: "ffmpeg-lottie",
    displayName: "FFmpeg + Lottie",
    capabilities: () => ({
      formats: ["webm-vp9-alpha", "prores-4444"],
      templates: TEMPLATES.map((t) => t.id),
      cpuOnly: true,
      needsSystemFfmpeg: true,
    }),
    // TODO(module-c): check `${ffmpegPath} -version` + rasterizer availability.
    checkAvailable: () =>
      Promise.resolve({ ok: false, reason: "Adaptador FFmpeg+Lottie pendiente (module-c)" }),
    listTemplates: () => Promise.resolve(TEMPLATES),
    validate: () => ({ ok: true }),
    render: () => Promise.reject(new MotionEngineNotImplementedError("ffmpeg-lottie")),
  };
}

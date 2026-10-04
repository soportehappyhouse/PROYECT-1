export * from "./types.js";
export * from "./errors.js";
export * from "./registry.js";
export * from "./adapters/remotion.js";
export * from "./adapters/motion-canvas.js";
export * from "./adapters/ffmpeg-lottie.js";
export { filterExpr, filterPath, FFMPEG_COLOR } from "./ffmpeg/escape.js";
export { parseProgressLine, runFfmpeg } from "./ffmpeg/run.js";
export {
  buildTitleArgs,
  defaultFontFile,
  encoderArgs,
  fadeAlphaExpr,
  ffmpegTitleSchema,
  type FfmpegTitleProps,
  type TitleCommandInput,
} from "./ffmpeg/title.js";

import { createFfmpegLottieEngine } from "./adapters/ffmpeg-lottie.js";
import { createMotionCanvasEngine } from "./adapters/motion-canvas.js";
import { createRemotionEngine, type RemotionEngineOptions } from "./adapters/remotion.js";
import { MotionEngineRegistry } from "./registry.js";

export interface DefaultRegistryOptions {
  /** Pass `REMOTION_ENGINE_OPTIONS` from @studio/remotion (or at least `{ templates, render }`). */
  remotion: RemotionEngineOptions;
  /** System ffmpeg used by the ffmpeg-lottie engine. */
  ffmpegPath: string;
}

/** Registry with all three engines, used by apps/api. */
export function createDefaultRegistry(options: DefaultRegistryOptions): MotionEngineRegistry {
  return new MotionEngineRegistry()
    .register(createRemotionEngine(options.remotion))
    .register(createMotionCanvasEngine())
    .register(createFfmpegLottieEngine({ ffmpegPath: options.ffmpegPath }));
}

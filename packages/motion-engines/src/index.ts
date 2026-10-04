export * from "./types.js";
export * from "./errors.js";
export * from "./registry.js";
export * from "./adapters/remotion.js";
export * from "./adapters/motion-canvas.js";
export * from "./adapters/ffmpeg-lottie.js";

import { createFfmpegLottieEngine } from "./adapters/ffmpeg-lottie.js";
import { createMotionCanvasEngine } from "./adapters/motion-canvas.js";
import { createRemotionEngine, type RemotionEngineOptions } from "./adapters/remotion.js";
import { MotionEngineRegistry } from "./registry.js";

export interface DefaultRegistryOptions {
  remotion: RemotionEngineOptions;
  ffmpegPath: string;
}

/** Registry with all three engines, used by apps/api. */
export function createDefaultRegistry(options: DefaultRegistryOptions): MotionEngineRegistry {
  return new MotionEngineRegistry()
    .register(createRemotionEngine(options.remotion))
    .register(createMotionCanvasEngine())
    .register(createFfmpegLottieEngine({ ffmpegPath: options.ffmpegPath }));
}

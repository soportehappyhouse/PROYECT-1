import type { AppContext } from "../../context.js";
import type { JobHandler } from "../types.js";
import { createMediaProbeHandler } from "./media-probe.js";
import { createMediaProxyHandler } from "./media-proxy.js";
import { createProjectExportHandler } from "./project-export.js";
import { createVoiceEffectHandler } from "./voice-effect.js";

/** Factory signature every module uses for its job handlers. */
export type JobHandlerFactory = (app: AppContext) => JobHandler;

/**
 * Module (b) handlers. Modules (c)/(d) add theirs (motion.render, voice.tts, voice.rvc,
 * subtitles.transcribe) in their own files under jobs/handlers/ and register them in app.ts with
 * `queue.register(createXHandler(ctx))`. Dispatch is by `handler.type`; the lane comes from
 * DEFAULT_JOB_LANES (motion -> "motion", workers-backed -> "workers") unless `lane` is set.
 * Jobs of a type without a registered handler stay queued.
 */
export const MODULE_B_HANDLERS: readonly JobHandlerFactory[] = [
  createMediaProbeHandler,
  createMediaProxyHandler,
  createVoiceEffectHandler,
  createProjectExportHandler,
];

export function registerModuleBHandlers(app: AppContext): void {
  for (const factory of MODULE_B_HANDLERS) app.queue.register(factory(app));
}

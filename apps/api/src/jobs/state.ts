import type { JobStatus, JobType } from "@studio/shared";
import type { JobLane } from "./types.js";

/**
 * Job state machine (docs/ARQUITECTURA.md §4):
 *   queued  -> running | canceled
 *   running -> succeeded | failed | canceled | queued (re-queued on restart / shutdown)
 *   succeeded | failed | canceled -> (terminal)
 */
const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["running", "canceled"],
  running: ["succeeded", "failed", "canceled", "queued"],
  succeeded: [],
  failed: [],
  canceled: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: JobStatus,
    readonly to: JobStatus,
  ) {
    super(`Invalid job transition ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(status: JobStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Lane per job type: CPU-heavy FFmpeg, headless-Chrome motion renders, Python workers. */
export const DEFAULT_JOB_LANES: Record<JobType, JobLane> = {
  "media.probe": "ffmpeg",
  "media.proxy": "ffmpeg",
  "voice.effect": "ffmpeg",
  "project.export": "ffmpeg",
  "motion.render": "motion",
  "voice.tts": "workers",
  "voice.rvc": "workers",
  "subtitles.transcribe": "workers",
  "packs.download": "workers",
  "analyze.scenes": "workers",
  "analyze.silences": "workers",
  "audio.denoise": "workers",
  "perf.run": "workers",
  "vision.matte": "workers",
  "vision.mask": "workers",
  "vision.track": "workers",
  "vision.reframe": "workers",
  // Pure project edit (no ffmpeg): own lane so it never waits behind exports or renders.
  "timeline.apply-cuts": "edit",
  "timeline.track-to-keyframes": "edit",
  // Sprint 3: runs edits inline and waits for sub-jobs of other lanes (never edit-lane jobs).
  "agent.apply": "edit",
  "agent.eval": "workers",
};

/** Raised by handlers (or the runner) when ctx.signal aborts. */
export class JobAbortedError extends Error {
  constructor(message = "Cancelado") {
    super(message);
    this.name = "AbortError";
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err instanceof JobAbortedError);
}

import type { Job, JobDiagnostics, JobStatus, JobType } from "@studio/shared";

export interface CreateJobInput {
  type: JobType;
  payload: unknown;
  projectId?: string;
  /** Higher runs first within a lane (default 0). Thumbnails/probes use 1, exports 0. */
  priority?: number;
}

export interface JobPatch {
  status?: JobStatus;
  progress?: number;
  message?: string;
  result?: unknown;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  logTail?: string;
  /** Command lines, stderr tail and timings (stored as JSON in jobs.diagnostics). */
  diagnostics?: JobDiagnostics;
}

export interface JobListFilter {
  status?: JobStatus;
  type?: JobType;
  limit?: number;
}

export interface RecoveryResult {
  requeued: number;
  failed: number;
}

/** Persistence contract for jobs (SQLite implementation in store.ts). */
export interface JobStore {
  create(input: CreateJobInput): Job;
  get(id: string): Job | undefined;
  list(filter?: JobListFilter): Job[];
  update(id: string, patch: JobPatch): Job;
  /** Oldest queued job, or undefined. */
  nextQueued(): Job | undefined;
  /**
   * Atomically take the next queued job whose type is in `types` (priority DESC, created_at ASC),
   * mark it running, bump attempts and return it.
   */
  claimNext(types: readonly JobType[]): Job | undefined;
  /** Number of execution attempts so far. */
  attempts(id: string): number;
  /** Last log lines stored for a job. */
  logTail(id: string): string[];
  /** Commands, stderr tail and timings recorded while the job ran (undefined if none). */
  diagnostics(id: string): JobDiagnostics | undefined;
  /**
   * On startup: jobs left `running` by a crash/restart are re-queued while attempts < maxAttempts,
   * otherwise marked failed. Returns how many were re-queued.
   */
  recoverInterrupted(maxAttempts?: number): number;
}

/** Execution lanes; each lane has its own concurrency limit. */
export type JobLane = "ffmpeg" | "motion" | "workers";

export interface JobContext {
  jobId: string;
  signal: AbortSignal;
  /** progress 0..1; message in Spanish for the Jobs panel. Throttled by the queue. */
  reportProgress(progress: number, message?: string): void;
  /** Append a diagnostic line (kept as a rolling tail in the DB, shown on failure). */
  log(line: string): void;
  /** Absolute STORAGE_DIR. */
  storageDir: string;
}

/**
 * One handler per JobType, registered in the JobQueue (see jobs/handlers/index.ts).
 * Stable contract for modules (b), (c) and (d):
 *   - parse(): validate the raw payload with the shared zod schema (throws ZodError -> HTTP 400).
 *   - run(): do the work; honour ctx.signal (throw when aborted); return the job result
 *     (FileJobResult for jobs producing a file).
 */
export interface JobHandler<P = unknown, R = unknown> {
  type: JobType;
  /** Defaults to DEFAULT_JOB_LANES[type]. */
  lane?: JobLane;
  parse(payload: unknown): P;
  run(payload: P, ctx: JobContext, job: Job): Promise<R>;
}

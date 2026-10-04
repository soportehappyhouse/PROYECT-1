import type { Job, JobStatus, JobType } from "@studio/shared";

export interface CreateJobInput {
  type: JobType;
  payload: unknown;
  projectId?: string;
}

export interface JobPatch {
  status?: JobStatus;
  progress?: number;
  message?: string;
  result?: unknown;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface JobListFilter {
  status?: JobStatus;
  type?: JobType;
  limit?: number;
}

/** Persistence contract for jobs (SQLite implementation in store.ts). */
export interface JobStore {
  create(input: CreateJobInput): Job;
  get(id: string): Job | undefined;
  list(filter?: JobListFilter): Job[];
  update(id: string, patch: JobPatch): Job;
  /** Oldest queued job, or undefined. */
  nextQueued(): Job | undefined;
  /** On startup: mark jobs left `running` by a crash as failed. */
  recoverInterrupted(): number;
}

export interface JobContext {
  signal: AbortSignal;
  /** progress 0..1; message in Spanish for the Jobs panel. */
  reportProgress(progress: number, message?: string): void;
  storageDir: string;
}

/** One handler per JobType, registered in the JobQueue. */
export interface JobHandler<P = unknown, R = unknown> {
  type: JobType;
  /** Parse/validate the raw payload (zod schema from @studio/shared). */
  parse(payload: unknown): P;
  run(payload: P, ctx: JobContext, job: Job): Promise<R>;
}

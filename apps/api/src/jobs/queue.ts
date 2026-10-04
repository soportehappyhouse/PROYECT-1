import { EventEmitter } from "node:events";
import PQueue from "p-queue";
import type { Job, JobEvent, JobType } from "@studio/shared";
import type { CreateJobInput, JobHandler, JobStore } from "./types.js";

export interface JobQueueOptions {
  store: JobStore;
  storageDir: string;
  /** Max jobs running at once (ffmpeg/remotion are CPU heavy). */
  concurrency?: number;
}

/**
 * In-process job queue backed by JobStore.
 * Emits "job" events (JobEvent) consumed by the SSE endpoint.
 */
export class JobQueue extends EventEmitter<{ job: [JobEvent] }> {
  readonly #handlers = new Map<JobType, JobHandler>();
  readonly #running = new Map<string, AbortController>();
  /** Concurrency limiter for handler executions. */
  readonly #pool: PQueue;

  constructor(private readonly options: JobQueueOptions) {
    super();
    this.#pool = new PQueue({ concurrency: options.concurrency ?? 1 });
  }

  register(handler: JobHandler): this {
    this.#handlers.set(handler.type, handler as JobHandler);
    return this;
  }

  hasHandler(type: JobType): boolean {
    return this.#handlers.has(type);
  }

  /** Validate payload with the handler, persist as queued and wake the worker loop. */
  enqueue(input: CreateJobInput): Job {
    const handler = this.#handlers.get(input.type);
    const payload = handler ? handler.parse(input.payload) : input.payload;
    const job = this.options.store.create({ ...input, payload });
    this.#emit(job);
    this.#tick();
    return job;
  }

  cancel(id: string): Job | undefined {
    const job = this.options.store.get(id);
    if (!job) return undefined;
    // TODO(module-b): abort running job via this.#running.get(id)?.abort() and mark canceled.
    return job;
  }

  /** Recover interrupted jobs and start processing. */
  start(): void {
    this.options.store.recoverInterrupted();
    this.#tick();
  }

  async stop(): Promise<void> {
    this.#pool.clear();
    for (const controller of this.#running.values()) controller.abort();
    this.#running.clear();
    await this.#pool.onIdle();
  }

  #emit(job: Job): void {
    this.emit("job", {
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      ...(job.message !== undefined && { message: job.message }),
    });
  }

  #tick(): void {
    // TODO(module-b): while this.#pool has free slots, take store.nextQueued(), mark running,
    // this.#pool.add(() => handler.run(payload, ctx)) with AbortController + reportProgress
    // (throttled), persist succeeded/failed/canceled + result/error, emit events, tick again.
    void this.#pool;
  }
}

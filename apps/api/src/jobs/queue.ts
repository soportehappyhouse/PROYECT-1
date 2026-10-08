import { EventEmitter } from "node:events";
import PQueue from "p-queue";
import {
  estimateEtaS,
  isStalled,
  type Job,
  type JobEvent,
  type JobProgressDetail,
  type JobStatus,
  type JobType,
} from "@studio/shared";
import { HttpError } from "../lib/errors.js";
import { JobDiagnosticsRecorder, runWithDiagnostics } from "./diagnostics.js";
import { assertTransition, DEFAULT_JOB_LANES, isAbortError, isTerminal } from "./state.js";
import type { CreateJobInput, JobContext, JobHandler, JobLane, JobStore } from "./types.js";

export interface JobQueueOptions {
  store: JobStore;
  storageDir: string;
  /** Max concurrent jobs per lane. Defaults: ffmpeg 2, motion 1, workers 1, edit 2. */
  lanes?: Partial<Record<JobLane, number>>;
  /** @deprecated use `lanes`; when set, applies to every lane without an explicit limit. */
  concurrency?: number;
  /** Attempts before a job interrupted by a restart is marked failed (default 2). */
  maxAttempts?: number;
  /** Min ms between persisted/emitted progress updates of one job (default 500). */
  progressThrottleMs?: number;
  /** Max log lines kept per job (default 40). */
  logTailLines?: number;
  /** Sprint 5: ms between ETA/stall re-checks of a running job (default 15 000). */
  stallCheckMs?: number;
}

/** Sprint 5: job types that finish in seconds and cannot be canceled (409 JOB_NOT_CANCELLABLE). */
export const NON_CANCELLABLE_JOB_TYPES: ReadonlySet<JobType> = new Set<JobType>([
  "timeline.apply-cuts",
  "media.probe",
]);

export const JOB_NOT_CANCELLABLE_ES = "Este trabajo termina en segundos y no se puede cancelar.";

/** Machine code of an error (HttpError/WorkersError/PackRequiredError `code`), if any. */
export function errorCodeOf(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : undefined;
}

/** Fields of a JobEvent built from a Job (SSE replay and live events). */
export function jobEventOf(job: Job): JobEvent {
  return {
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    ...(job.message !== undefined && { message: job.message }),
    ...(job.error !== undefined && { error: job.error }),
    ...(job.errorCode !== undefined && { errorCode: job.errorCode }),
    ...(job.detail !== undefined && { detail: job.detail }),
  };
}

interface RunningJob {
  controller: AbortController;
  lane: JobLane;
  /** Set when the abort comes from stop() (re-queue instead of cancel). */
  shuttingDown: boolean;
}

const LANES: readonly JobLane[] = ["ffmpeg", "motion", "workers", "edit"];
const DEFAULT_LANE_LIMITS: Record<JobLane, number> = { ffmpeg: 2, motion: 1, workers: 1, edit: 2 };

/**
 * In-process job queue backed by the SQLite JobStore (source of truth).
 * One p-queue per lane limits concurrency; the worker loop (`#tick`) atomically claims queued jobs
 * of registered types while a lane has free slots. Emits "job" (JobEvent) for the SSE endpoint.
 */
export class JobQueue extends EventEmitter<{ job: [JobEvent] }> {
  readonly #handlers = new Map<JobType, JobHandler>();
  readonly #running = new Map<string, RunningJob>();
  readonly #pools: Record<JobLane, PQueue>;
  readonly #limits: Record<JobLane, number>;
  readonly #active: Record<JobLane, number> = { ffmpeg: 0, motion: 0, workers: 0, edit: 0 };
  readonly #logs = new Map<string, string[]>();
  #started = false;
  #stopping = false;

  constructor(private readonly options: JobQueueOptions) {
    super();
    this.setMaxListeners(0);
    const fallback = options.concurrency;
    this.#limits = Object.fromEntries(
      LANES.map((lane) => [
        lane,
        Math.max(1, options.lanes?.[lane] ?? fallback ?? DEFAULT_LANE_LIMITS[lane]),
      ]),
    ) as Record<JobLane, number>;
    this.#pools = Object.fromEntries(
      LANES.map((lane) => [lane, new PQueue({ concurrency: this.#limits[lane] })]),
    ) as Record<JobLane, PQueue>;
  }

  register(handler: JobHandler): this {
    this.#handlers.set(handler.type, handler);
    if (this.#started) this.#tick();
    return this;
  }

  hasHandler(type: JobType): boolean {
    return this.#handlers.has(type);
  }

  laneOf(type: JobType): JobLane {
    return this.#handlers.get(type)?.lane ?? DEFAULT_JOB_LANES[type];
  }

  /** A queued or running job of `type` whose payload matches (e.g. one download per pack). */
  activeJob(type: JobType, match: (payload: Record<string, unknown>) => boolean): Job | undefined {
    for (const status of ["running", "queued"] as const) {
      const job = this.options.store
        .list({ status, type, limit: 100 })
        .find(
          (j) =>
            j.payload &&
            typeof j.payload === "object" &&
            match(j.payload as Record<string, unknown>),
        );
      if (job) return job;
    }
    return undefined;
  }

  /** Snapshot of lane usage (for health/debug). */
  lanes(): Record<JobLane, { active: number; limit: number }> {
    return Object.fromEntries(
      LANES.map((l) => [l, { active: this.#active[l], limit: this.#limits[l] }]),
    ) as Record<JobLane, { active: number; limit: number }>;
  }

  /**
   * Validate payload with the handler, persist as queued and wake the worker loop.
   * Jobs whose type has no registered handler stay queued until one is registered.
   */
  enqueue(input: CreateJobInput): Job {
    const handler = this.#handlers.get(input.type);
    const payload = handler ? handler.parse(input.payload) : input.payload;
    const job = this.options.store.create({ ...input, payload });
    this.#emit(job);
    this.#tick();
    return job;
  }

  /**
   * Cancel a job: queued -> canceled immediately; running -> abort its signal (the FFmpeg runner
   * sends "q" then kills the process) and the job is marked canceled when the handler settles.
   * Terminal jobs are returned unchanged.
   */
  cancel(id: string): Job | undefined {
    const job = this.options.store.get(id);
    if (!job) return undefined;
    if (
      job.status === "running" &&
      (job.detail?.cancellable === false || NON_CANCELLABLE_JOB_TYPES.has(job.type))
    )
      throw new HttpError(409, "JOB_NOT_CANCELLABLE", JOB_NOT_CANCELLABLE_ES);
    if (job.status === "queued") return this.#transition(job, "canceled", { message: "Cancelado" });
    if (job.status === "running") {
      const running = this.#running.get(id);
      if (running) {
        running.controller.abort();
        return this.options.store.update(id, { message: "Cancelando…" });
      }
      // Running in the DB but not in this process (should not happen after recovery).
      return this.#transition(job, "canceled", { message: "Cancelado" });
    }
    return job;
  }

  /** Recover interrupted jobs (re-queue for retry) and start processing. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#stopping = false;
    this.options.store.recoverInterrupted(this.options.maxAttempts ?? 2);
    this.#tick();
  }

  /** Stop taking jobs; abort running ones and leave them queued so they retry on next start. */
  async stop(): Promise<void> {
    this.#stopping = true;
    for (const pool of Object.values(this.#pools)) pool.clear();
    for (const running of this.#running.values()) {
      running.shuttingDown = true;
      running.controller.abort();
    }
    await Promise.all(Object.values(this.#pools).map((p) => p.onIdle()));
    this.#started = false;
  }

  /** Resolve when every lane is idle and nothing claimable is queued (tests). */
  async onIdle(): Promise<void> {
    for (;;) {
      await Promise.all(Object.values(this.#pools).map((p) => p.onIdle()));
      if (this.#running.size === 0) return;
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  #emit(job: Job): void {
    this.emit("job", jobEventOf(job));
  }

  #transition(job: Job, to: JobStatus, patch: Parameters<JobStore["update"]>[1] = {}): Job {
    assertTransition(job.status, to);
    const now = new Date().toISOString();
    const updated = this.options.store.update(job.id, {
      ...patch,
      status: to,
      ...(isTerminal(to) && { finishedAt: now }),
    });
    this.#emit(updated);
    return updated;
  }

  #tick(): void {
    if (!this.#started || this.#stopping) return;
    for (const lane of LANES) {
      const types = [...this.#handlers.keys()].filter((t) => this.laneOf(t) === lane);
      while (this.#active[lane] < this.#limits[lane]) {
        const job = this.options.store.claimNext(types);
        if (!job) break;
        this.#active[lane]++;
        this.#emit(job);
        void this.#pools[lane].add(() => this.#execute(job, lane));
      }
    }
  }

  async #execute(job: Job, lane: JobLane): Promise<void> {
    const handler = this.#handlers.get(job.type)!;
    const controller = new AbortController();
    const entry: RunningJob = { controller, lane, shuttingDown: false };
    this.#running.set(job.id, entry);
    const throttle = this.options.progressThrottleMs ?? 500;
    let lastFlush = 0;
    let pending: { progress: number; message?: string } | undefined;
    let timer: NodeJS.Timeout | undefined;
    let current = job;
    const startedAt = job.startedAt ?? new Date().toISOString();
    // Sprint 5 progress detail: counts/stage from the handler + progressAt/eta_s/stalled.
    let detail: JobProgressDetail = {
      cancellable: !NON_CANCELLABLE_JOB_TYPES.has(job.type),
      eta_s: null,
      progressAt: startedAt,
    };
    let lastProgress = job.progress;
    let firstItemAt: string | undefined;
    const withEta = (
      d: JobProgressDetail,
      progress: number,
      now = Date.now(),
    ): JobProgressDetail => {
      const eta = estimateEtaS({
        progress,
        startedAt,
        now,
        ...(d.done !== undefined && { done: d.done }),
        ...(d.total !== undefined && { total: d.total }),
        ...(firstItemAt && { firstItemAt }),
      });
      return { ...d, eta_s: eta, stalled: isStalled(d.progressAt, now) };
    };
    const stallTimer = setInterval(() => {
      if (controller.signal.aborted) return;
      const next = withEta(detail, lastProgress);
      if (next.stalled === detail.stalled && next.eta_s === detail.eta_s) return;
      detail = next;
      current = this.options.store.update(job.id, { detail });
      this.#emit(current);
    }, this.options.stallCheckMs ?? 15_000);
    stallTimer.unref?.();
    current = this.options.store.update(job.id, { detail });
    if (!detail.cancellable) this.#emit(current);
    const diagnostics = new JobDiagnosticsRecorder();
    const endPatch = () => ({
      ...this.#logPatch(job.id),
      detail: { ...detail, stalled: false },
      diagnostics: diagnostics.snapshot({
        createdAt: job.createdAt,
        ...(job.startedAt && { startedAt: job.startedAt }),
        finishedAt: new Date().toISOString(),
      }),
    });

    const flush = () => {
      timer = undefined;
      if (!pending || controller.signal.aborted) return;
      const p = pending;
      pending = undefined;
      lastFlush = Date.now();
      detail = withEta(detail, p.progress);
      current = this.options.store.update(job.id, {
        progress: p.progress,
        ...(p.message !== undefined && { message: p.message }),
        detail,
      });
      this.#emit(current);
    };

    const ctx: JobContext = {
      jobId: job.id,
      signal: controller.signal,
      storageDir: this.options.storageDir,
      reportProgress: (progress, message, extra) => {
        const clamped = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
        const nowIso = new Date().toISOString();
        if (extra) {
          const clean = Object.fromEntries(
            Object.entries(extra).filter(([, v]) => v !== undefined),
          ) as Partial<JobProgressDetail>;
          if (clean.stage_es !== undefined) clean.stage_es = clean.stage_es.slice(0, 120);
          if (clean.done !== undefined) clean.done = Math.max(0, Math.round(clean.done));
          if (clean.total !== undefined) {
            clean.total = Math.round(clean.total);
            if (clean.total <= 0) delete clean.total;
          }
          if (clean.total !== undefined && firstItemAt === undefined)
            firstItemAt = (clean.done ?? 0) > 0 ? startedAt : nowIso;
          const changedItems = clean.done !== undefined && clean.done !== detail.done;
          detail = { ...detail, ...clean, ...(changedItems && { progressAt: nowIso }) };
        }
        if (clamped !== lastProgress) {
          lastProgress = clamped;
          detail = { ...detail, progressAt: nowIso };
        }
        pending = { progress: clamped, ...(message !== undefined && { message }) };
        const wait = throttle - (Date.now() - lastFlush);
        if (wait <= 0) flush();
        else timer ??= setTimeout(flush, wait);
      },
      log: (line) => this.#log(job.id, line),
    };

    try {
      const payload = handler.parse(job.payload);
      const result = await runWithDiagnostics(diagnostics, () => handler.run(payload, ctx, job));
      clearTimeout(timer);
      // Trailing edge of the throttle: a job that finishes inside the window must still publish
      // its last progress step (e.g. "3/3 bloques (3 en caché)") before "Completado".
      flush();
      if (controller.signal.aborted)
        throw Object.assign(new Error("Cancelado"), { name: "AbortError" });
      this.#transition(this.options.store.get(job.id)!, "succeeded", {
        progress: 1,
        message: "Completado",
        result: result ?? null,
        ...endPatch(),
      });
    } catch (err) {
      clearTimeout(timer);
      const latest = this.options.store.get(job.id);
      if (latest && latest.status === "running") {
        if (entry.shuttingDown) {
          this.#transition(latest, "queued", {
            progress: 0,
            message: "En cola (servidor reiniciado)",
            ...endPatch(),
          });
        } else if (controller.signal.aborted || isAbortError(err)) {
          this.#transition(latest, "canceled", { message: "Cancelado", ...endPatch() });
        } else {
          const message = err instanceof Error ? err.message : String(err);
          this.#log(job.id, `ERROR: ${message}`);
          if (err instanceof Error) {
            // Message first line + stack frames (the full message may repeat the stderr tail).
            const frames = (err.stack ?? "").split("\n").filter((l) => /^\s+at /.test(l));
            diagnostics.stderrLine(`[api] ${err.name}: ${message.split(/\r?\n/)[0] ?? ""}`);
            for (const f of frames.slice(0, 15)) diagnostics.stderrLine(`[api] ${f}`);
          }
          // Errors may carry a structured body for the client (e.g. PACK_REQUIRED) as `jobResult`.
          const jobResult =
            err && typeof err === "object" && "jobResult" in err
              ? (err as { jobResult: unknown }).jobResult
              : undefined;
          const errorCode = errorCodeOf(err);
          this.#transition(latest, "failed", {
            error: message,
            ...(errorCode && { errorCode }),
            message: "Error",
            ...(jobResult !== undefined && { result: jobResult }),
            ...endPatch(),
          });
        }
      }
    } finally {
      clearInterval(stallTimer);
      this.#running.delete(job.id);
      this.#logs.delete(job.id);
      this.#active[lane]--;
      this.#tick();
    }
  }

  #log(jobId: string, line: string): void {
    const max = this.options.logTailLines ?? 40;
    const lines = this.#logs.get(jobId) ?? [];
    for (const l of line.split(/\r?\n/)) if (l.trim()) lines.push(l);
    if (lines.length > max) lines.splice(0, lines.length - max);
    this.#logs.set(jobId, lines);
  }

  #logPatch(jobId: string): { logTail?: string } {
    const lines = this.#logs.get(jobId);
    return lines?.length ? { logTail: lines.join("\n") } : {};
  }
}

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { DesignTokens, MotionStillRequest } from "@studio/shared";

const run = promisify(execFile);

/** Still cache: renders/stills/<hash>.png|jpg, least recently used dropped over 200 MB. */
export const STILLS_DIR_REL = "renders/stills";
export const STILLS_MAX_BYTES = 200 * 1024 * 1024;

export interface StillRenderArgs {
  template: string;
  props: Record<string, unknown>;
  width: number;
  height: number;
  frame?: number;
  format: "png" | "jpeg";
  output: string;
  tokens: DesignTokens | null;
}

/** The engine call (Remotion renderStill in production; a fake in tests). */
export type StillRenderer = (args: StillRenderArgs) => Promise<void>;

export interface StillServiceOptions {
  storageDir: string;
  render: StillRenderer;
  ffmpegPath: string;
  /** Absolute path of a media asset (background frame). */
  assetPath?: (assetId: string) => string | undefined;
  /** Changes when the templates change (bundle hash), so old stills are not reused. */
  version?: () => Promise<string> | string;
  maxBytes?: number;
  /** Renders at the same time (audit S6 E6: each one is a Chrome tab; default 2). */
  maxConcurrent?: number;
}

/** Default number of stills rendered at once (the rest wait in a queue). */
export const STILL_MAX_CONCURRENT = 2;

function abortError(): Error {
  const err = new Error("Vista previa cancelada");
  err.name = "AbortError";
  return err;
}

interface InFlight {
  promise: Promise<StillResult>;
  /** Requests still waiting for it; when all abort before it starts, it is dropped. */
  waiters: number;
  ctrl: AbortController;
}

export interface StillResult {
  file: string;
  cached: boolean;
  ms: number;
  contentType: "image/png" | "image/jpeg";
}

/** POST /api/motion/still: one frame of a template, cached by hash of request + kit. */
export class StillService {
  /** Renders actually run (tests: the 2nd identical request must not render). */
  renders = 0;
  private readonly inFlight = new Map<string, InFlight>();
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly o: StillServiceOptions) {}

  private dir(): string {
    return path.join(this.o.storageDir, STILLS_DIR_REL);
  }

  async key(req: MotionStillRequest, tokens: DesignTokens | null): Promise<string> {
    const version = (await this.o.version?.()) ?? "";
    return createHash("sha256")
      .update(JSON.stringify({ v: version, req, tokens: req.brand ? tokens : null }))
      .digest("hex")
      .slice(0, 32);
  }

  /**
   * The still for `req` (cache, shared in-flight render, or a new render). At most
   * `maxConcurrent` renders run at once; `signal` (the HTTP request closing: the web aborts the
   * previous preview when a control changes) drops the request, and a queued render nobody waits
   * for any more never starts — dragging a slider keeps only the last value (audit S6 E6).
   */
  async get(
    req: MotionStillRequest,
    tokens: DesignTokens | null,
    signal?: AbortSignal,
  ): Promise<StillResult> {
    if (signal?.aborted) throw abortError();
    const key = await this.key(req, tokens);
    const ext = req.format === "jpeg" ? "jpg" : "png";
    const file = path.join(this.dir(), `${key}.${ext}`);
    const contentType = req.format === "jpeg" ? "image/jpeg" : "image/png";
    if (existsSync(file)) {
      const now = new Date();
      await utimes(file, now, now).catch(() => undefined);
      return { file, cached: true, ms: 0, contentType };
    }
    if (signal?.aborted) throw abortError();
    let entry = this.inFlight.get(key);
    if (!entry) {
      const ctrl = new AbortController();
      const created: InFlight = {
        ctrl,
        waiters: 0,
        promise: this.slot(ctrl.signal, () => this.produce(req, tokens, file, contentType)),
      };
      created.promise.then(
        () => this.inFlight.delete(key),
        () => this.inFlight.delete(key),
      );
      this.inFlight.set(key, created);
      entry = created;
    }
    const e = entry;
    e.waiters++;
    if (!signal) return e.promise.finally(() => e.waiters--);
    return new Promise<StillResult>((resolve, reject) => {
      const onAbort = () => {
        e.waiters--;
        if (e.waiters <= 0) e.ctrl.abort();
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      e.promise.then(
        (r) => {
          signal.removeEventListener("abort", onAbort);
          e.waiters--;
          resolve(r);
        },
        (err: unknown) => {
          signal.removeEventListener("abort", onAbort);
          e.waiters--;
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  /** Run `work` when a render slot is free; rejects without running if `signal` aborts first. */
  private async slot<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    const max = Math.max(1, this.o.maxConcurrent ?? STILL_MAX_CONCURRENT);
    if (this.active >= max)
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          signal.removeEventListener("abort", drop);
          resolve();
        };
        const drop = () => {
          const i = this.waiting.indexOf(go);
          if (i >= 0) this.waiting.splice(i, 1);
          reject(abortError());
        };
        this.waiting.push(go);
        signal.addEventListener("abort", drop, { once: true });
      });
    else if (signal.aborted) throw abortError();
    this.active++;
    try {
      return await work();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  private async produce(
    req: MotionStillRequest,
    tokens: DesignTokens | null,
    file: string,
    contentType: StillResult["contentType"],
  ): Promise<StillResult> {
    const t0 = Date.now();
    await mkdir(this.dir(), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.part.${req.format === "jpeg" ? "jpg" : "png"}`;
    const bgPath = req.background_asset_id
      ? this.o.assetPath?.(req.background_asset_id)
      : undefined;
    const fps = 30;
    const frame = req.frame ?? (req.t_s !== undefined ? Math.round(req.t_s * fps) : undefined);
    this.renders++;
    try {
      // With a background the template is rendered as PNG (alpha) and laid over the video frame.
      const overlay = bgPath ? `${tmp}.fg.png` : tmp;
      await this.o.render({
        template: req.template,
        props: req.props,
        width: req.width,
        height: req.height,
        ...(frame !== undefined && { frame }),
        format: bgPath ? "png" : req.format,
        output: overlay,
        tokens: req.brand ? tokens : null,
      });
      if (bgPath) {
        await run(this.o.ffmpegPath, [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-ss",
          String(req.t_s ?? 0),
          "-i",
          bgPath,
          "-i",
          overlay,
          "-filter_complex",
          `[0:v]scale=${req.width}:${req.height}:force_original_aspect_ratio=increase,crop=${req.width}:${req.height}[bg];[bg][1:v]overlay=0:0`,
          "-frames:v",
          "1",
          tmp,
        ]);
        await rm(overlay, { force: true });
      }
      await rename(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    await this.prune().catch(() => undefined);
    return { file, cached: false, ms: Date.now() - t0, contentType };
  }

  /** Drop the least recently used stills until the folder is under the budget. */
  async prune(): Promise<void> {
    const max = this.o.maxBytes ?? STILLS_MAX_BYTES;
    const names = await readdir(this.dir());
    const files = await Promise.all(
      names
        .filter((n) => !n.includes(".part"))
        .map(async (n) => {
          const p = path.join(this.dir(), n);
          const s = await stat(p);
          return { p, size: s.size, used: s.mtimeMs };
        }),
    );
    let total = files.reduce((n, f) => n + f.size, 0);
    for (const f of files.sort((a, b) => a.used - b.used)) {
      if (total <= max) break;
      await rm(f.p, { force: true });
      total -= f.size;
    }
  }
}

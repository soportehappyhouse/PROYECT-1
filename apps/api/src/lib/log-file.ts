import {
  createWriteStream,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  type WriteStream,
} from "node:fs";
import path from "node:path";
import { redactText, type RedactOptions } from "./redact.js";

/** File name pattern of the api logs: storage/logs/api-YYYY-MM-DD.log. */
export const API_LOG_PATTERN = /^api-(\d{4}-\d{2}-\d{2})\.log$/;

export interface DailyLogStreamOptions {
  /** Absolute folder (storage/logs). */
  dir: string;
  /** File prefix (default "api"). */
  prefix?: string;
  /** Delete files of this prefix older than N days (default 7). */
  retentionDays?: number;
  /** Also write every line to process.stdout (default true). */
  stdout?: boolean;
  /** Secrets to hide in every line (plus the generic patterns of redact.ts). */
  redact?: RedactOptions;
  /** Clock (tests). */
  now?: () => Date;
}

/** Local calendar date YYYY-MM-DD (the log rotates at local midnight). */
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Remove `<prefix>-YYYY-MM-DD.log` files older than `retentionDays`. Returns deleted names. */
export function cleanupOldLogs(
  dir: string,
  prefix: string,
  retentionDays: number,
  now: Date,
): string[] {
  const pattern = new RegExp(`^${prefix}-(\\d{4})-(\\d{2})-(\\d{2})\\.log$`);
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - retentionDays);
  const deleted: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return deleted;
  }
  for (const name of names) {
    const m = pattern.exec(name);
    if (!m) continue;
    const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (day < cutoff) {
      try {
        if (statSync(path.join(dir, name)).isFile()) unlinkSync(path.join(dir, name));
        deleted.push(name);
      } catch {
        // locked by another process (Windows): try again tomorrow
      }
    }
  }
  return deleted;
}

/**
 * pino destination (`{ write(line) }`) that tees each JSON line to stdout and to a daily file
 * storage/logs/<prefix>-YYYY-MM-DD.log, redacting secrets first. Rotation happens on the first
 * line of a new day; files older than `retentionDays` are deleted at startup and on rotation.
 */
export class DailyLogStream {
  readonly #dir: string;
  readonly #prefix: string;
  readonly #retention: number;
  readonly #stdout: boolean;
  readonly #redact: RedactOptions;
  readonly #now: () => Date;
  #day = "";
  #file: WriteStream | undefined;
  /** Files of previous days still flushing (rotation does not wait for them; end() does). */
  readonly #closing = new Set<Promise<void>>();

  constructor(opts: DailyLogStreamOptions) {
    this.#dir = opts.dir;
    this.#prefix = opts.prefix ?? "api";
    this.#retention = opts.retentionDays ?? 7;
    this.#stdout = opts.stdout ?? true;
    this.#redact = opts.redact ?? {};
    this.#now = opts.now ?? (() => new Date());
    mkdirSync(this.#dir, { recursive: true });
  }

  /** Current file path. */
  get currentFile(): string {
    return path.join(this.#dir, `${this.#prefix}-${this.#day || localDay(this.#now())}.log`);
  }

  write(chunk: string): boolean {
    const line = redactText(chunk, { secrets: this.#redact.secrets });
    if (this.#stdout) process.stdout.write(line);
    const day = localDay(this.#now());
    if (day !== this.#day) this.#rotate(day);
    this.#file?.write(line);
    return true;
  }

  #rotate(day: string): void {
    if (this.#file) {
      const closing = closeStream(this.#file);
      this.#closing.add(closing);
      void closing.then(() => this.#closing.delete(closing));
    }
    this.#day = day;
    this.#file = createWriteStream(this.currentFile, { flags: "a" });
    // A broken disk must never crash the api: drop file logging and keep stdout.
    this.#file.on("error", () => {
      this.#file = undefined;
    });
    cleanupOldLogs(this.#dir, this.#prefix, this.#retention, this.#now());
  }

  /**
   * Flush and close the current file AND the files of previous days rotated away: writes are
   * asynchronous, so a day-1 line may still be in flight after the rotation (slow disks and
   * Windows: the day-1 file was read back empty).
   */
  async end(): Promise<void> {
    const f = this.#file;
    this.#file = undefined;
    await Promise.all([...this.#closing, ...(f ? [closeStream(f)] : [])]);
  }
}

/** end() a write stream and resolve once its data is written and the fd closed (or it failed). */
function closeStream(f: WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (f.closed || f.destroyed) {
      resolve();
      return;
    }
    f.once("close", () => resolve());
    f.once("error", () => resolve());
    f.end();
  });
}

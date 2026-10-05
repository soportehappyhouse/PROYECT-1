import { spawn } from "node:child_process";
import { currentDiagnostics, formatCommand } from "../../jobs/diagnostics.js";
import { ProgressParser, progressRatio, type ProgressBlock } from "./progress.js";

export interface RunFfmpegOptions {
  signal?: AbortSignal;
  /** Expected output duration (seconds) to turn out_time into a 0..1 ratio. */
  durationSec?: number;
  onProgress?: (ratio: number, block: ProgressBlock) => void;
  /** Working directory (lets filters use simple relative file names: no escaping). */
  cwd?: string;
  /** Called for every stderr line (job log). */
  onStderrLine?: (line: string) => void;
  /** Receive raw stdout (disables `-progress pipe:1`). */
  onStdout?: (chunk: Buffer) => void;
  /** ffmpeg -loglevel (default "error"; loudnorm measurement needs "info"). */
  logLevel?: "error" | "warning" | "info";
  /** Grace period after sending "q" before killing the process tree (ms, default 3000). */
  killAfterMs?: number;
  /** Prepend `-y` (default true). */
  overwrite?: boolean;
}

export interface RunResult {
  code: number;
  /** Full stderr (bounded to the last ~256 KB). */
  stderr: string;
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderrTail: string[],
  ) {
    super(message);
    this.name = "FfmpegError";
  }
}

const STDERR_LIMIT = 256 * 1024;

/** Global flags prepended to every ffmpeg invocation by runFfmpeg. */
export function globalArgs(opts: Pick<RunFfmpegOptions, "logLevel" | "onStdout" | "overwrite">) {
  return [
    "-hide_banner",
    "-nostats",
    "-loglevel",
    opts.logLevel ?? "error",
    ...(opts.onStdout ? [] : ["-progress", "pipe:1"]),
    ...(opts.overwrite === false ? [] : ["-y"]),
  ];
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // already gone
  }
}

/**
 * Spawn ffmpeg directly (no shell). Progress via `-progress pipe:1`; cancel via AbortSignal:
 * writes "q" to stdin (ffmpeg finalizes and exits), then kills the tree after `killAfterMs`.
 * Rejects with AbortError on cancel and FfmpegError (with stderr tail) on non-zero exit.
 */
export function runFfmpeg(
  bin: string,
  args: readonly string[],
  opts: RunFfmpegOptions = {},
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(Object.assign(new Error("Cancelado"), { name: "AbortError" }));
      return;
    }
    const fullArgs = [...globalArgs(opts), ...args];
    const diag = currentDiagnostics();
    const record = diag?.command("process", formatCommand(bin, fullArgs), opts.cwd);
    const child = spawn(bin, fullArgs, {
      cwd: opts.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let stderrPartial = "";
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;
    const parser = new ProgressParser();

    const onAbort = () => {
      aborted = true;
      try {
        child.stdin.write("q\n");
        child.stdin.end();
      } catch {
        // stdin closed
      }
      killTimer = setTimeout(() => killTree(child.pid), opts.killAfterMs ?? 3000);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdin.on("error", () => undefined);

    child.stdout.on("data", (chunk: Buffer) => {
      if (opts.onStdout) {
        opts.onStdout(chunk);
        return;
      }
      for (const block of parser.push(chunk.toString("utf8"))) {
        opts.onProgress?.(progressRatio(block, opts.durationSec), block);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      if (stderr.length > STDERR_LIMIT) stderr = stderr.slice(-STDERR_LIMIT);
      if (opts.onStderrLine || diag) {
        const lines = (stderrPartial + text).split(/\r?\n/);
        stderrPartial = lines.pop() ?? "";
        for (const l of lines) {
          if (!l.trim()) continue;
          opts.onStderrLine?.(l);
          diag?.stderrLine(l);
        }
      }
    });

    child.on("error", (err) => {
      opts.signal?.removeEventListener("abort", onAbort);
      clearTimeout(killTimer);
      record?.end(null, err.message);
      reject(
        new FfmpegError(
          `No se pudo ejecutar ${bin}: ${(err as NodeJS.ErrnoException).code ?? err.message}`,
          null,
          [],
        ),
      );
    });
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      clearTimeout(killTimer);
      if (stderrPartial.trim()) {
        opts.onStderrLine?.(stderrPartial);
        diag?.stderrLine(stderrPartial);
      }
      record?.end(code, aborted ? "Cancelado" : undefined);
      if (aborted) {
        reject(Object.assign(new Error("Cancelado"), { name: "AbortError" }));
        return;
      }
      if (code === 0) {
        resolve({ code: 0, stderr });
        return;
      }
      const tail = stderr.split(/\r?\n/).filter(Boolean).slice(-40);
      const last = tail.at(-1) ?? "sin salida";
      reject(new FfmpegError(`ffmpeg terminó con código ${code}: ${last}`, code, tail));
    });
  });
}

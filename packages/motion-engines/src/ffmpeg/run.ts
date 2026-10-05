import { spawn } from "node:child_process";

export interface RunFfmpegOptions {
  ffmpegPath: string;
  args: string[];
  /** Expected output duration, to turn `out_time_us` into a 0..1 ratio. */
  durationSec: number;
  signal?: AbortSignal;
  onProgress?: (ratio: number) => void;
}

/** Parse one `-progress pipe:1` line; returns seconds of output written, if present. */
export function parseProgressLine(line: string): number | undefined {
  const m = /^out_time_(?:us|ms)=(\d+)$/.exec(line.trim());
  return m ? Number(m[1]) / 1_000_000 : undefined;
}

/** Spawn ffmpeg (no shell), report progress, kill on abort, reject with stderr tail on failure. */
export function runFfmpeg(opts: RunFfmpegOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new Error("Render cancelado"));
    const child = spawn(opts.ffmpegPath, opts.args, { windowsHide: true });
    let stderr = "";
    let buffer = "";
    const onAbort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const sec = parseProgressLine(line);
        if (sec !== undefined && opts.durationSec > 0)
          opts.onProgress?.(Math.min(1, sec / opts.durationSec));
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on("error", (err) => {
      opts.signal?.removeEventListener("abort", onAbort);
      reject(new Error(`No se pudo ejecutar FFmpeg (${opts.ffmpegPath}): ${err.message}`));
    });
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (opts.signal?.aborted) return reject(new Error("Render cancelado"));
      if (code === 0) return resolve();
      reject(new Error(`FFmpeg terminó con código ${code}: ${stderr.trim() || "(sin salida)"}`));
    });
  });
}

/** Captures stdout of a short ffmpeg invocation (e.g. `-filters`). */
export function ffmpegOutput(ffmpegPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => (out += c));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`ffmpeg ${args.join(" ")} -> ${code}`)),
    );
  });
}

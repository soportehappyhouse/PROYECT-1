import { spawn } from "node:child_process";

export interface RunResult {
  stdout: Buffer;
  stderr: string;
}

/** Spawn a binary directly (no shell). Rejects on non-zero exit; kills the process on abort. */
export function runProcess(
  command: string,
  args: readonly string[],
  opts: { signal?: AbortSignal; cwd?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let err = "";
    const onAbort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => {
      err = (err + c.toString("utf8")).slice(-4000);
    });
    child.on("error", (e) => {
      opts.signal?.removeEventListener("abort", onAbort);
      reject(e);
    });
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (opts.signal?.aborted) return reject(new Error("Cancelado"));
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err });
      else reject(new Error(`${command} terminó con código ${code}: ${err.trim().slice(-500)}`));
    });
  });
}

/** Extract a 16 kHz mono PCM WAV (what whisper expects) from any audio/video file. */
export async function extractSpeechWav(
  ffmpegPath: string,
  inputAbs: string,
  outputAbs: string,
  signal?: AbortSignal,
): Promise<void> {
  await runProcess(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      inputAbs,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      outputAbs,
    ],
    { signal },
  );
}

/** One block of `-progress pipe:1` output (key=value lines ending with progress=continue|end). */
export interface ProgressBlock {
  /** Output time in seconds, when known. */
  outTimeSec?: number;
  frame?: number;
  fps?: number;
  /** Encoding speed multiplier (e.g. 2.5 for "2.5x"). */
  speed?: number;
  done: boolean;
}

function parseClock(v: string): number | undefined {
  const m = /^(-?)(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(v.trim());
  if (!m) return undefined;
  const s = Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
  return m[1] ? -s : s;
}

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Incremental parser for ffmpeg `-progress` output. Feed raw chunks; get completed blocks. */
export class ProgressParser {
  #buffer = "";
  #current: Record<string, string> = {};

  push(chunk: string): ProgressBlock[] {
    this.#buffer += chunk;
    const lines = this.#buffer.split(/\r?\n/);
    this.#buffer = lines.pop() ?? "";
    const blocks: ProgressBlock[] = [];
    for (const line of lines) {
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      this.#current[key] = value;
      if (key === "progress") {
        blocks.push(toBlock(this.#current));
        this.#current = {};
      }
    }
    return blocks;
  }
}

function toBlock(kv: Record<string, string>): ProgressBlock {
  // out_time_ms is (historically) also microseconds; prefer out_time_us, then out_time.
  const us = num(kv.out_time_us) ?? num(kv.out_time_ms);
  const outTimeSec =
    us !== undefined && us >= 0 ? us / 1e6 : kv.out_time ? parseClock(kv.out_time) : undefined;
  const speed = kv.speed ? num(kv.speed.replace(/x$/, "")) : undefined;
  return {
    ...(outTimeSec !== undefined && outTimeSec >= 0 && { outTimeSec }),
    ...(num(kv.frame) !== undefined && { frame: num(kv.frame)! }),
    ...(num(kv.fps) !== undefined && { fps: num(kv.fps)! }),
    ...(speed !== undefined && { speed }),
    done: kv.progress === "end",
  };
}

/** Ratio 0..1 of a block against the expected output duration. */
export function progressRatio(block: ProgressBlock, durationSec: number | undefined): number {
  if (block.done) return 1;
  if (!durationSec || durationSec <= 0 || block.outTimeSec === undefined) return 0;
  return Math.min(0.999, Math.max(0, block.outTimeSec / durationSec));
}

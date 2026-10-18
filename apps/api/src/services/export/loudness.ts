import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { LoudnessTarget } from "@studio/shared";

/**
 * Sprint 5 (M3): two-pass EBU R128 normalization of the export mix (loudnorm) and the ffprobe
 * `ebur128` measurement used by tests and the e2e. loudnorm prints its JSON on stderr (CRLF on
 * Windows): the last `{…}` block is parsed without depending on line breaks.
 */

const execFileAsync = promisify(execFile);

/** Below this the mix is digital silence (loudnorm reports -inf): nothing to normalize. */
export const SILENCE_LUFS = -70;

/** Numbers of a loudnorm JSON block (pass 1: input_*; pass 2 also output_*). */
export interface LoudnormStats {
  input_i: number;
  input_tp: number;
  input_lra: number;
  input_thresh: number;
  target_offset: number;
  output_i?: number;
  output_tp?: number;
  normalization_type?: string;
}

/** Parse the last `{…}` loudnorm block of stderr; -inf/NaN become SILENCE_LUFS (offset 0). */
export function parseLoudnormStats(stderr: string): LoudnormStats {
  const end = stderr.lastIndexOf("}");
  const start = end < 0 ? -1 : stderr.lastIndexOf("{", end);
  if (start < 0) throw new Error("loudnorm no devolvió la medición");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(stderr.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new Error("la medición de loudnorm no se pudo leer");
  }
  const num = (k: string, fallback: number) => {
    const v = Number(raw[k]);
    return Number.isFinite(v) ? v : fallback;
  };
  for (const k of ["input_i", "input_tp", "input_lra", "input_thresh"])
    if (raw[k] === undefined) throw new Error(`loudnorm: falta ${k}`);
  return {
    input_i: num("input_i", SILENCE_LUFS),
    input_tp: num("input_tp", SILENCE_LUFS),
    input_lra: num("input_lra", 0),
    input_thresh: num("input_thresh", SILENCE_LUFS),
    target_offset: num("target_offset", 0),
    ...(raw.output_i !== undefined && { output_i: num("output_i", SILENCE_LUFS) }),
    ...(raw.output_tp !== undefined && { output_tp: num("output_tp", SILENCE_LUFS) }),
    ...(typeof raw.normalization_type === "string" && {
      normalization_type: raw.normalization_type,
    }),
  };
}

const base = (t: LoudnessTarget) => `loudnorm=I=${t.integrated}:TP=${t.truePeak}:LRA=${t.lra}`;

/** Pass 1: measure (`-af` of a `-f null` run at log level info). */
export function loudnormMeasureFilter(t: LoudnessTarget): string {
  return `${base(t)}:print_format=json`;
}

/** Pass 2: linear normalization with the measured values (JSON again, for output_i / output_tp). */
export function loudnormApplyFilter(t: LoudnessTarget, m: LoudnormStats): string {
  const f = (n: number) => String(+n.toFixed(2));
  return (
    `${base(t)}:measured_I=${f(m.input_i)}:measured_TP=${f(m.input_tp)}` +
    `:measured_LRA=${f(m.input_lra)}:measured_thresh=${f(m.input_thresh)}` +
    `:offset=${f(m.target_offset)}:linear=true:print_format=json`
  );
}

/** argv of pass 1 over a mix file (output discarded). */
export function loudnormMeasureArgs(input: string, t: LoudnessTarget): string[] {
  return ["-i", input, "-af", loudnormMeasureFilter(t), "-f", "null", "-"];
}

export interface Ebur128Measure {
  /** Integrated loudness (LUFS). */
  integrated: number;
  /** Max true peak over the channels (dBTP). */
  truePeak: number;
}

/**
 * ffprobe argv measuring a file with the lavfi `ebur128` filter (last frame = whole file). The
 * path goes relative with cwd = its folder: `C:\` and `\` break the filter parser on Windows.
 */
export function ebur128ProbeArgs(fileName: string): string[] {
  return [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `amovie=${fileName.replace(/\\/g, "/").replace(/([:,;'[\]])/g, "\\$1")},ebur128=metadata=1:peak=true`,
    "-show_entries",
    "frame_tags=lavfi.r128.I,lavfi.r128.true_peaks_ch0,lavfi.r128.true_peaks_ch1",
    "-of",
    "json",
  ];
}

/** Parse ffprobe's JSON of ebur128ProbeArgs (last frame carrying the tags). */
export function parseEbur128Probe(stdout: string): Ebur128Measure {
  const data = JSON.parse(stdout) as { frames?: { tags?: Record<string, string> }[] };
  const frames = (data.frames ?? []).filter((f) => f.tags?.["lavfi.r128.I"] !== undefined);
  const last = frames[frames.length - 1]?.tags;
  if (!last) throw new Error("ebur128 no devolvió medición");
  const peaks = ["lavfi.r128.true_peaks_ch0", "lavfi.r128.true_peaks_ch1"]
    .map((k) => Number(last[k]))
    .filter((v) => Number.isFinite(v));
  // ebur128 peaks are linear in some builds and dBTP in others: values > 0 are linear.
  const toDb = (v: number) => (v > 0 ? 20 * Math.log10(v) : v === 0 ? -Infinity : v);
  return {
    integrated: Number(last["lavfi.r128.I"]),
    truePeak: peaks.length ? Math.max(...peaks.map(toDb)) : Number.NaN,
  };
}

/** Measure a file with ffprobe + ebur128 (tests, e2e, «Revisión para redes» diagnostics). */
export async function measureEbur128(
  ffprobePath: string,
  absFile: string,
): Promise<Ebur128Measure> {
  const { stdout } = await execFileAsync(ffprobePath, ebur128ProbeArgs(path.basename(absFile)), {
    cwd: path.dirname(absFile),
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return parseEbur128Probe(stdout);
}

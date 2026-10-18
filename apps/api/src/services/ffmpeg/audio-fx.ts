import type { VoiceEffect } from "@studio/shared";
import { sec } from "./escape.js";

/**
 * Voice/audio effect filter chains — exact recipes from docs/trabajo/fuentes-audio.md §4
 * (verified on FFmpeg 6.1.1). All chains normalise to 48 kHz where the recipe does.
 */
export interface AudioFxOptions {
  /** librubberband available (`ffmpeg -filters`): better pitch with preserved formants. */
  rubberband?: boolean;
}

/** Semitones -> frequency ratio r = 2^(n/12). */
export function semitoneRatio(semitones: number): number {
  return 2 ** (semitones / 12);
}

/** Format a ratio with 6 decimals (as in the cookbook: 1.259921, 0.793701, 0.666667). */
export function ratio6(n: number): string {
  return n.toFixed(6);
}

/**
 * Split a tempo factor into a chain of `atempo` filters each within [0.5, 2] (safe on every
 * FFmpeg version). 4 -> "atempo=2,atempo=2"; 0.25 -> "atempo=0.5,atempo=0.5".
 */
export function atempoChain(factor: number): string {
  if (!(factor > 0) || !Number.isFinite(factor)) throw new Error(`Invalid tempo ${factor}`);
  const parts: string[] = [];
  let f = factor;
  while (f > 2) {
    parts.push("atempo=2");
    f /= 2;
  }
  while (f < 0.5) {
    parts.push("atempo=0.5");
    f /= 0.5;
  }
  if (Math.abs(f - 1) > 1e-9 || parts.length === 0) parts.push(`atempo=${+f.toFixed(6)}`);
  return parts.join(",");
}

/** Pitch shift preserving duration: asetrate=48000*R + atempo=1/R (or rubberband). */
export function pitchChain(semitones: number, opts: AudioFxOptions = {}): string {
  const r = semitoneRatio(semitones);
  if (opts.rubberband) return `rubberband=pitch=${ratio6(r)}:formant=preserved`;
  return `aresample=48000,asetrate=48000*${ratio6(r)},aresample=48000,${atempoChain(1 / r)}`;
}

const ROBOT_FFT =
  "afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75";

/** Effects that need two inputs or two passes and cannot be expressed as a single -af chain. */
export type SpecialEffect = Extract<VoiceEffect, { type: "ducking" | "loudnorm" }>;

export function isSpecialEffect(e: VoiceEffect): e is SpecialEffect {
  return e.type === "ducking" || e.type === "loudnorm";
}

/**
 * A graph fragment transforming `[in]` into `[out]`. Most effects are a plain comma chain; robot
 * with intensity < 1 needs a dry/wet split (labels are prefixed to stay unique in big graphs).
 */
export function effectFragment(
  effect: Exclude<VoiceEffect, SpecialEffect>,
  inLabel: string,
  outLabel: string,
  prefix: string,
  opts: AudioFxOptions = {},
): string {
  const chain = (c: string) => `[${inLabel}]${c}[${outLabel}]`;
  switch (effect.type) {
    case "pitch":
      return chain(pitchChain(effect.semitones, opts));
    case "speed":
      return chain(
        opts.rubberband
          ? `rubberband=tempo=${+effect.factor.toFixed(6)}`
          : atempoChain(effect.factor),
      );
    case "robot": {
      const wet = `aresample=48000,${ROBOT_FFT},volume=1.5`;
      if (effect.intensity >= 0.99) return chain(wet);
      const w = +effect.intensity.toFixed(3);
      const d = +(1 - effect.intensity).toFixed(3);
      return (
        `[${inLabel}]aresample=48000,asplit=2[${prefix}d][${prefix}w];` +
        `[${prefix}w]${ROBOT_FFT},volume=1.5[${prefix}r];` +
        `[${prefix}d][${prefix}r]amix=inputs=2:weights='${d} ${w}':normalize=0[${outLabel}]`
      );
    }
    case "telephone":
      return chain("highpass=f=300,lowpass=f=3400,acompressor=threshold=-18dB:ratio=4,volume=1.5");
    case "radio":
      return chain(
        "highpass=f=400,lowpass=f=3000,acrusher=bits=8:mix=0.3:mode=log:aa=1,compand=attacks=0:points=-80/-80|-30/-10|0/-3,volume=1.2",
      );
    case "megaphone":
      return chain(
        "highpass=f=500,lowpass=f=4000,acrusher=bits=10:mix=0.4,acompressor=threshold=-20dB:ratio=6:makeup=6",
      );
    case "underwater":
      return chain("lowpass=f=800,aecho=0.8:0.8:40:0.5,vibrato=f=4:d=0.3");
    case "reverb": {
      // "Reverb de sala" multitap aecho; defaults (roomSize 0.5, wet 0.3) give the exact recipe
      // aecho=0.8:0.7:20|40|60|80:0.4|0.3|0.2|0.1.
      const size = 0.5 + effect.roomSize;
      const gain = effect.wet / 0.3;
      const delays = [20, 40, 60, 80].map((d) => Math.max(1, Math.round(d * size)));
      const decays = [0.4, 0.3, 0.2, 0.1].map((d) => +Math.min(0.9, d * gain).toFixed(3));
      return chain(`aecho=0.8:0.7:${delays.join("|")}:${decays.join("|")}`);
    }
    case "echo":
      return chain(`aecho=0.8:0.88:${Math.round(effect.delayMs)}:${+effect.decay.toFixed(3)}`);
    case "chipmunk":
      return chain(
        opts.rubberband
          ? "rubberband=pitch=1.6:formant=preserved"
          : "aresample=48000,asetrate=48000*1.5,aresample=48000,atempo=0.666667",
      );
    case "deep":
      return chain(
        opts.rubberband
          ? "rubberband=pitch=0.7:formant=shifted,lowpass=f=7000"
          : "aresample=48000,asetrate=48000*0.75,aresample=48000,atempo=1.333333,lowpass=f=6000",
      );
    case "denoise":
      return chain(
        `highpass=f=80,afftdn=nr=${+effect.reductionDb.toFixed(2)}:nf=${+effect.noiseFloorDb.toFixed(2)}:tn=1`,
      );
  }
}

/** Measured values from loudnorm pass 1 (`print_format=json`, all strings). */
export interface LoudnormMeasurement {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
  normalization_type?: string;
}

type Loudnorm = Extract<VoiceEffect, { type: "loudnorm" }>;

/** loudnorm filter: pass 1 (measure), pass 2 (apply measured, linear) or single dynamic pass. */
export function loudnormFilter(
  e: Pick<Loudnorm, "integrated" | "truePeak" | "lra">,
  mode: "measure" | "single" | { measured: LoudnormMeasurement },
): string {
  const base = `loudnorm=I=${e.integrated}:TP=${e.truePeak}:LRA=${e.lra}`;
  if (mode === "measure") return `${base}:print_format=json`;
  if (mode === "single") return base;
  const m = mode.measured;
  return (
    `${base}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}` +
    `:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true:print_format=summary`
  );
}

/** Extract the last `{...}` JSON block printed by loudnorm on stderr. */
export function parseLoudnormJson(stderr: string): LoudnormMeasurement {
  const end = stderr.lastIndexOf("}");
  const start = stderr.lastIndexOf("{", end);
  if (start < 0 || end < 0) throw new Error("loudnorm no devolvió medición JSON");
  const parsed = JSON.parse(stderr.slice(start, end + 1)) as Partial<LoudnormMeasurement>;
  for (const k of ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"] as const) {
    if (typeof parsed[k] !== "string") throw new Error(`loudnorm: falta ${k}`);
    // "-inf" happens on digital silence: linear mode cannot apply, fall back to safe values.
    if (!Number.isFinite(Number(parsed[k]))) parsed[k] = k === "target_offset" ? "0" : "-70";
  }
  return parsed as LoudnormMeasurement;
}

type Ducking = Extract<VoiceEffect, { type: "ducking" }>;

/** Sprint 5 (automatic ducking at export) extras of duckingFragment. */
export interface DuckingOptions {
  /** Pad the sidechain with `apad=whole_dur=<s>` instead of an endless `apad`. */
  padWholeDur?: number;
  /** sidechaincompress `level_sc` (sidechain gain). */
  levelSc?: number;
}

/**
 * Ducking (fuentes-audio §4.9): music ducked by the voice via sidechaincompress, then mixed.
 * `[voice]` and `[music]` are input labels.
 */
export function duckingFragment(
  e: Ducking,
  voiceLabel: string,
  musicLabel: string,
  outLabel: string,
  prefix: string,
  opts: DuckingOptions = {},
): string {
  const vol = e.musicVolume !== 1 ? `volume=${+e.musicVolume.toFixed(3)},` : "";
  // Sprint 5: bounded pad (whole_dur) inside the export mix: an endless apad can stall FFmpeg
  // once every input ended (see the final amix of compileExport).
  const pad = opts.padWholeDur !== undefined ? `apad=whole_dur=${sec(opts.padWholeDur)}` : "apad";
  const levelSc =
    opts.levelSc !== undefined && Math.abs(opts.levelSc - 1) > 1e-9
      ? `:level_sc=${opts.levelSc}`
      : "";
  return (
    // apad on the sidechain keeps the music running after the voice ends.
    `[${voiceLabel}]asplit=2[${prefix}sc][${prefix}vo];[${prefix}sc]${pad}[${prefix}scp];` +
    `[${musicLabel}]${vol}aresample=48000[${prefix}m];` +
    `[${prefix}m][${prefix}scp]sidechaincompress=threshold=${e.threshold}:ratio=${e.ratio}` +
    `:attack=${e.attackMs}:release=${e.releaseMs}:makeup=1${levelSc}[${prefix}duck];` +
    `[${prefix}duck][${prefix}vo]amix=inputs=2:duration=longest:normalize=0[${outLabel}]`
  );
}

export interface AudioFxGraph {
  /** filter_complex fragment from `[in]` to `[out]`. */
  graph: string;
  /** loudnorm effect to run as a two-pass on the result (standalone jobs only). */
  loudnorm?: Loudnorm;
  /** Ducking effect needing a second input (standalone jobs only). */
  ducking?: Ducking;
  warnings: string[];
}

/**
 * Chain effects from `[inLabel]` to `[outLabel]`. In `timeline` mode two-pass loudnorm degrades to
 * a single dynamic pass and ducking is skipped (needs its own job); in `standalone` mode they are
 * returned separately for the caller (two passes / extra input). loudnorm always runs last.
 */
export function buildAudioFxGraph(
  effects: readonly VoiceEffect[],
  inLabel: string,
  outLabel: string,
  opts: AudioFxOptions & { prefix?: string; mode?: "timeline" | "standalone" } = {},
): AudioFxGraph {
  const prefix = opts.prefix ?? "fx";
  const warnings: string[] = [];
  const parts: string[] = [];
  let loudnorm: Loudnorm | undefined;
  let ducking: Ducking | undefined;
  let current = inLabel;
  let n = 0;
  const regular = effects.filter(
    (e): e is Exclude<VoiceEffect, SpecialEffect> => !isSpecialEffect(e),
  );
  for (const e of effects) {
    if (e.type === "loudnorm") loudnorm = e;
    if (e.type === "ducking") ducking = e;
  }
  for (const e of regular) {
    const next = `${prefix}${n}`;
    parts.push(effectFragment(e, current, next, `${prefix}${n}_`, opts));
    current = next;
    n++;
  }
  if (opts.mode !== "standalone") {
    if (ducking) {
      warnings.push("Ducking se aplica solo como efecto independiente (no en el timeline)");
      ducking = undefined;
    }
    if (loudnorm) {
      const next = `${prefix}${n}`;
      parts.push(`[${current}]${loudnormFilter(loudnorm, "single")}[${next}]`);
      current = next;
      loudnorm = undefined;
    }
  }
  parts.push(`[${current}]anull[${outLabel}]`);
  return {
    graph: parts.join(";"),
    ...(loudnorm && { loudnorm }),
    ...(ducking && { ducking }),
    warnings,
  };
}

/** Seconds helper re-export for callers composing audio graphs. */
export { sec };

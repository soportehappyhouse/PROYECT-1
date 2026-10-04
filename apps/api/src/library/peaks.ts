import type { WaveformPeaks } from "@studio/shared";
import { runProcess } from "../voice-ai/proc.js";

const DECODE_RATE = 8000;
const MAX_PEAKS = 6000;

/** Bucket count per second: 100 for short SFX, fewer for long music (max MAX_PEAKS values). */
export function bucketsPerSecond(durationSec: number): number {
  if (durationSec <= 0) return 100;
  return Math.max(1, Math.min(100, Math.floor(MAX_PEAKS / durationSec)));
}

/** Max-abs peaks (0..1) from signed 16-bit mono PCM. */
export function peaksFromPcm(pcm: Buffer, sampleRate = DECODE_RATE): WaveformPeaks {
  const samples = Math.floor(pcm.length / 2);
  const durationSec = samples / sampleRate;
  const bps = bucketsPerSecond(durationSec);
  const perBucket = Math.max(1, Math.round(sampleRate / bps));
  const peaks: number[] = [];
  for (let start = 0; start < samples; start += perBucket) {
    const end = Math.min(samples, start + perBucket);
    let max = 0;
    for (let i = start; i < end; i++) {
      const v = Math.abs(pcm.readInt16LE(i * 2));
      if (v > max) max = v;
    }
    peaks.push(Math.round((Math.min(max, 32767) / 32767) * 1000) / 1000);
  }
  return {
    version: 1,
    durationSec: Math.round(durationSec * 1000) / 1000,
    bucketsPerSecond: bps,
    peaks,
  };
}

/** Decode with FFmpeg to 8 kHz mono s16le and compute peaks + duration in one pass. */
export async function computePeaks(
  ffmpegPath: string,
  inputAbs: string,
  signal?: AbortSignal,
): Promise<WaveformPeaks> {
  const { stdout } = await runProcess(
    ffmpegPath,
    [
      "-v",
      "error",
      "-i",
      inputAbs,
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(DECODE_RATE),
      "-f",
      "s16le",
      "-",
    ],
    { signal },
  );
  return peaksFromPcm(stdout);
}

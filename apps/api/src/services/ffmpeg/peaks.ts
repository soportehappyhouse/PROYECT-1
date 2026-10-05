import type { WaveformPeaks } from "@studio/shared";

/** Buckets per second so that long files stay below ~60k peaks (max 100/s). */
export function bucketsPerSecondFor(durationSec: number | undefined): number {
  if (!durationSec || durationSec <= 0) return 100;
  return Math.max(1, Math.min(100, Math.floor(60_000 / durationSec)));
}

/**
 * Streaming max-abs peak accumulator over mono s16le PCM (as produced by pcmArgs()).
 * Result matches the dashboard contract WaveformPeaks v1 (0..1 per bucket).
 */
export class PeakAccumulator {
  readonly #samplesPerBucket: number;
  readonly #peaks: number[] = [];
  #current = 0;
  #count = 0;
  #samples = 0;
  #carry: Buffer | undefined;

  constructor(
    readonly sampleRate: number,
    readonly bucketsPerSecond: number,
  ) {
    this.#samplesPerBucket = Math.max(1, Math.round(sampleRate / bucketsPerSecond));
  }

  push(chunk: Buffer): void {
    let buf = chunk;
    if (this.#carry) {
      buf = Buffer.concat([this.#carry, chunk]);
      this.#carry = undefined;
    }
    const usable = buf.length - (buf.length % 2);
    for (let i = 0; i < usable; i += 2) {
      const v = Math.abs(buf.readInt16LE(i));
      if (v > this.#current) this.#current = v;
      this.#samples++;
      if (++this.#count >= this.#samplesPerBucket) this.#close();
    }
    if (usable < buf.length) this.#carry = buf.subarray(usable);
  }

  #close(): void {
    this.#peaks.push(Math.round((Math.min(this.#current, 32767) / 32767) * 1000) / 1000);
    this.#current = 0;
    this.#count = 0;
  }

  result(): WaveformPeaks {
    if (this.#count > 0) this.#close();
    return {
      version: 1,
      durationSec: Math.round((this.#samples / this.sampleRate) * 1000) / 1000,
      bucketsPerSecond: this.bucketsPerSecond,
      peaks: this.#peaks,
    };
  }
}

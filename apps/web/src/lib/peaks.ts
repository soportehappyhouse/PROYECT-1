import { WaveformPeaksSchema, waveformPeaksPath, type WaveformPeaks } from "@studio/shared";
import { assetPreviewUrl, fileUrl } from "./api";

/** Buckets per second used when peaks are computed in the browser. */
export const BROWSER_PEAKS_PER_SECOND = 50;
/** Don't decode files bigger than this in the browser (fallback path only). */
export const MAX_BROWSER_DECODE_BYTES = 80 * 1024 * 1024;

/** Max-abs per bucket of mono-mixed channels, normalized to 0..1. */
export function computePeaks(channels: readonly Float32Array[], buckets: number): number[] {
  const length = channels[0]?.length ?? 0;
  if (!length || buckets <= 0) return [];
  const size = Math.max(1, Math.floor(length / buckets));
  const out: number[] = new Array<number>(Math.ceil(length / size)).fill(0);
  for (const data of channels) {
    for (let b = 0; b < out.length; b++) {
      let max = out[b]!;
      const end = Math.min(length, (b + 1) * size);
      for (let i = b * size; i < end; i++) {
        const v = Math.abs(data[i]!);
        if (v > max) max = v;
      }
      out[b] = max;
    }
  }
  let peak = 0;
  for (const v of out) if (v > peak) peak = v;
  return peak > 0 ? out.map((v) => Math.min(1, v / peak)) : out;
}

/** Peaks of the [inSec, outSec] window of the source. */
export function slicePeaks(p: WaveformPeaks, inSec: number, outSec: number): number[] {
  const from = Math.max(0, Math.floor(inSec * p.bucketsPerSecond));
  const to = Math.min(p.peaks.length, Math.ceil(outSec * p.bucketsPerSecond));
  return to > from ? p.peaks.slice(from, to) : [];
}

const cache = new Map<string, Promise<WaveformPeaks | undefined>>();

async function fetchServerPeaks(path: string): Promise<WaveformPeaks | undefined> {
  try {
    const res = await fetch(fileUrl(path));
    if (!res.ok) return undefined;
    const parsed = WaveformPeaksSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function decodeInBrowser(asset: {
  id: string;
  proxyPath?: string;
  sizeBytes?: number;
}): Promise<WaveformPeaks | undefined> {
  if (typeof window === "undefined" || typeof AudioContext === "undefined") return undefined;
  if (asset.sizeBytes && asset.sizeBytes > MAX_BROWSER_DECODE_BYTES) return undefined;
  try {
    const res = await fetch(assetPreviewUrl(asset));
    if (!res.ok) return undefined;
    const buffer = await res.arrayBuffer();
    // A low sample rate is plenty for peaks and keeps memory down.
    const ctx = new OfflineAudioContext(1, 1, 8000);
    const audio = await ctx.decodeAudioData(buffer);
    const channels: Float32Array[] = [];
    for (let c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c));
    const buckets = Math.max(1, Math.round(audio.duration * BROWSER_PEAKS_PER_SECOND));
    const peaks = computePeaks(channels, buckets);
    return {
      version: 1,
      durationSec: audio.duration,
      bucketsPerSecond: peaks.length / Math.max(audio.duration, 1e-6),
      peaks,
    };
  } catch {
    return undefined;
  }
}

export interface PeaksSource {
  id: string;
  proxyPath?: string;
  sizeBytes?: number;
  /** `MediaAsset.waveformPath` from the api (module b), when present. */
  waveformPath?: string;
}

/**
 * Peaks for an asset: the api's `waveformPath` / `proxies/<id>.peaks.json` (written by the
 * `media.proxy` job) when available, otherwise decoded in the browser. Cached per asset + path so
 * a later proxy job (new `waveformPath`) triggers a refetch.
 */
export function loadPeaks(asset: PeaksSource): Promise<WaveformPeaks | undefined> {
  const key = `${asset.id}|${asset.waveformPath ?? ""}`;
  let p = cache.get(key);
  if (!p) {
    p = fetchServerPeaks(asset.waveformPath ?? waveformPeaksPath(asset.id)).then(
      (server) => server ?? decodeInBrowser(asset),
    );
    cache.set(key, p);
  }
  return p;
}

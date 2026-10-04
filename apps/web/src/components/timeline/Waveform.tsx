"use client";

import type { MediaAsset } from "@studio/shared";
import { useEffect, useRef, useState } from "react";
import { loadPeaks, slicePeaks } from "@/lib/peaks";

/**
 * Waveform of the [inSec, outSec] window of an audio asset, drawn by wavesurfer.js from
 * pre-computed peaks (never decodes the media itself).
 */
export function Waveform({
  asset,
  inSec,
  outSec,
  height,
  color = "currentColor",
}: {
  asset: Pick<MediaAsset, "id" | "proxyPath" | "sizeBytes"> & { waveformPath?: string };
  inSec: number;
  outSec: number;
  height: number;
  color?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [peaks, setPeaks] = useState<number[] | undefined>(undefined);
  const { id, proxyPath, sizeBytes, waveformPath } = asset;

  useEffect(() => {
    let alive = true;
    void loadPeaks({
      id,
      sizeBytes,
      ...(proxyPath ? { proxyPath } : {}),
      ...(waveformPath ? { waveformPath } : {}),
    }).then((p) => {
      if (alive) setPeaks(p ? slicePeaks(p, inSec, outSec) : undefined);
    });
    return () => {
      alive = false;
    };
  }, [id, proxyPath, sizeBytes, waveformPath, inSec, outSec]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !peaks || peaks.length === 0) return;
    let destroyed = false;
    let instance: { destroy: () => void } | undefined;
    void import("wavesurfer.js").then(({ default: WaveSurfer }) => {
      if (destroyed) return;
      instance = WaveSurfer.create({
        container: el,
        height,
        waveColor: color,
        progressColor: color,
        cursorWidth: 0,
        interact: false,
        normalize: true,
        barWidth: 2,
        barGap: 1,
        barRadius: 1,
        hideScrollbar: true,
        peaks: [peaks],
        duration: Math.max(0.01, outSec - inSec),
      });
    });
    return () => {
      destroyed = true;
      instance?.destroy();
    };
  }, [peaks, height, color, inSec, outSec]);

  if (!peaks) return null;
  return (
    <div
      ref={containerRef}
      className="pointer-events-none absolute inset-x-0 bottom-0 opacity-70"
      aria-hidden
    />
  );
}

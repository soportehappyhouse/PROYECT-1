"use client";

import type { MediaAsset } from "@studio/shared";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { fileUrl, mediaFileUrl } from "@/lib/api";
import {
  composeAt,
  compositionSources,
  drawComposition,
  driverSource,
  type LayerSource,
} from "@/lib/compositor";
import { MasterClock, masterClock } from "@/lib/master-clock";
import { MediaPool, type MediaUrls } from "@/lib/media-pool";
import { findClip } from "@/lib/timeline";
import { cachedTrack, loadTrack } from "@/lib/vision-api";
import { useCaptionStyleStore } from "@/stores/caption-style-store";
import { useMediaStore } from "@/stores/media-store";
import { shouldDropToProxy, usePreviewStore, wantsProxy } from "@/stores/preview-store";
import { useProjectStore } from "@/stores/project-store";

/** Without a fresh requestVideoFrameCallback frame for this long, rAF draws instead. */
const VFC_STALE_MS = 60;
const PRELOAD_EVERY_MS = 250;
const PRELOAD_AHEAD_S = 1;

type VideoWithVfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
  cancelVideoFrameCallback?: (id: number) => void;
};

/** URL of a layer source: original or proxy, with the other one as fallback. */
export function sourceUrls(
  asset: MediaAsset | undefined,
  src: Pick<LayerSource, "assetId" | "keepOriginal" | "element">,
  proxy: { wanted: boolean; auto: boolean },
): MediaUrls {
  const original = mediaFileUrl(src.assetId);
  const proxyUrl = asset?.proxyPath ? fileUrl(asset.proxyPath) : undefined;
  if (src.keepOriginal || src.element === "image" || !proxyUrl) return { primary: original };
  // Auto quality starts on originals up to 1080p; bigger media start on the proxy.
  const useProxy = proxy.wanted || (proxy.auto && (asset?.height ?? 0) > 1080);
  return useProxy
    ? { primary: proxyUrl, fallback: original }
    : { primary: original, fallback: proxyUrl };
}

/**
 * Multilayer preview (Sprint 2): canvas 2D compositor driven by the master clock. Draws on
 * requestVideoFrameCallback of the driver video while playing (rAF otherwise / as fallback), and
 * on demand while paused (playhead, project, media or a decoded frame changed).
 */
export function CompositorStage({ width, height }: { width: number; height: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const poolRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef({ width, height });
  sizeRef.current = { width, height };
  /** Ask the loop for a redraw (set by the effect). */
  const nudgeRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = poolRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext("2d");
    let dirty = true;
    let raf = 0;
    let disposed = false;
    let lastVfc = 0;
    let vfcEl: VideoWithVfc | undefined;
    let vfcId: number | undefined;
    let preload: LayerSource[] = [];
    let lastPreload = 0;
    let windowStart = performance.now();
    let windowFrames = 0;
    let windowDrawMs = 0;
    const fpsWindows: number[] = [];
    let warnedMissing = false;

    const pool = new MediaPool(
      container,
      (src) => {
        const p = usePreviewStore.getState();
        return sourceUrls(useMediaStore.getState().assets[src.assetId], src, {
          wanted: wantsProxy(p),
          auto: p.quality === "auto",
        });
      },
      () => {
        dirty = true;
      },
      (src) => {
        if (warnedMissing) return;
        warnedMissing = true;
        const name = useMediaStore.getState().assets[src.assetId]?.name ?? src.assetId;
        toast.warning(`La vista previa no puede reproducir «${name}»`, {
          description: "Genera un proxy desde el panel Media o probá la «Vista previa clásica».",
        });
      },
    );

    const draw = (at?: number) => {
      const t0 = performance.now();
      const st = useProjectStore.getState();
      const playing = st.playing;
      const time = at ?? (playing ? masterClock.now() : st.playhead);
      const assets = useMediaStore.getState().assets;
      const input = { project: st.project, assets, time, trackFile: cachedTrack };
      const comp = composeAt(input);
      if (playing && t0 - lastPreload > PRELOAD_EVERY_MS) {
        lastPreload = t0;
        const ahead = composeAt({ ...input, time: time + PRELOAD_AHEAD_S });
        const now = new Set(compositionSources(comp).map((s) => s.key));
        preload = compositionSources(ahead).filter((s) => !now.has(s.key));
      } else if (!playing) preload = [];
      const driver = driverSource(comp);
      pool.sync(compositionSources(comp), preload, {
        playing,
        rate: st.playbackRate,
        driverKey: driver?.key,
      });
      // Master clock driver = the bottom-most video element.
      const el = driver ? (pool.video(driver.key) as VideoWithVfc | undefined) : undefined;
      const clip = driver ? findClip(st.project, driver.clipId)?.clip : undefined;
      masterClock.setDriver(
        el && clip
          ? { el, clipStart: clip.start, clipIn: clip.in, speed: clip.speed || 1 }
          : undefined,
      );
      if (playing && el && el !== vfcEl && el.requestVideoFrameCallback) {
        if (vfcEl && vfcId !== undefined) vfcEl.cancelVideoFrameCallback?.(vfcId);
        vfcEl = el;
        const onVfc = (_now: number, meta: { mediaTime: number }) => {
          if (disposed || vfcEl !== el) return;
          lastVfc = performance.now();
          const d = masterClock.getDriver();
          const st2 = useProjectStore.getState();
          if (st2.playing && d?.el === el) render(MasterClock.timelineTime(d, meta.mediaTime));
          vfcId = el.requestVideoFrameCallback!(onVfc);
        };
        vfcId = el.requestVideoFrameCallback(onVfc);
      }
      if (ctx) {
        const { width: W, height: H } = st.project.settings;
        const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
        const bw = Math.max(1, Math.round(Math.min(W, sizeRef.current.width * dpr)));
        const bh = Math.max(1, Math.round(Math.min(H, sizeRef.current.height * dpr)));
        if (canvas.width !== bw || canvas.height !== bh) {
          canvas.width = bw;
          canvas.height = bh;
        }
        ctx.setTransform(bw / W, 0, 0, bh / H, 0, 0);
        drawComposition(
          ctx,
          comp,
          (key) => pool.get(key),
          { width: W, height: H },
          st.project.captionStyle ?? useCaptionStyleStore.getState().style,
        );
      }
      const spent = performance.now() - t0;
      if (playing) {
        windowFrames++;
        windowDrawMs += spent;
      }
      const now = performance.now();
      if (now - windowStart >= 1000) {
        const fps = playing ? (windowFrames * 1000) / (now - windowStart) : 0;
        const p = usePreviewStore.getState();
        if (playing) fpsWindows.push(fps);
        if (fpsWindows.length > 5) fpsWindows.shift();
        p.setPerf({
          fps: Math.round(fps * 10) / 10,
          drawMs: windowFrames ? Math.round((windowDrawMs / windowFrames) * 10) / 10 : 0,
          layers: comp.layers.length,
          clock: masterClock.source,
          usingProxy: wantsProxy(p),
        });
        const driverAsset = driver ? assets[driver.assetId] : undefined;
        const hasProxy = comp.layers.some((l) => l.source && assets[l.source.assetId]?.proxyPath);
        if (
          playing &&
          p.quality === "auto" &&
          !p.autoProxy &&
          hasProxy &&
          shouldDropToProxy(fpsWindows, driverAsset?.fps ?? st.project.settings.fps)
        ) {
          p.setAutoProxy(true);
          fpsWindows.length = 0;
          toast.message("Vista previa: pasé a proxies para mantener la fluidez", {
            description: "Iba a menos de 24 fps. Cambialo en Opciones de la vista previa.",
          });
        }
        windowStart = now;
        windowFrames = 0;
        windowDrawMs = 0;
      }
      dirty = false;
    };

    const render = (at?: number) => {
      try {
        draw(at);
      } catch (err) {
        // A broken frame must never kill the loop.
        console.error(err);
      }
    };

    const loop = () => {
      if (disposed) return;
      const playing = useProjectStore.getState().playing;
      if (playing) {
        if (performance.now() - lastVfc > VFC_STALE_MS) render();
      } else if (dirty) render();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const markDirty = () => {
      dirty = true;
    };
    nudgeRef.current = markDirty;
    const unsubs = [
      useProjectStore.subscribe(markDirty),
      useMediaStore.subscribe(markDirty),
      usePreviewStore.subscribe((s, prev) => {
        if (s.quality !== prev.quality || s.autoProxy !== prev.autoProxy) dirty = true;
      }),
    ];
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      if (vfcEl && vfcId !== undefined) vfcEl.cancelVideoFrameCallback?.(vfcId);
      for (const u of unsubs) u();
      masterClock.setDriver(undefined);
      pool.dispose();
    };
  }, []);

  // Track files of followers: load once, then redraw.
  const project = useProjectStore((s) => s.project);
  const assets = useMediaStore((s) => s.assets);
  // Size changes need a redraw while paused.
  useEffect(() => nudgeRef.current(), [width, height]);
  useEffect(() => {
    for (const t of project.tracks)
      for (const c of t.clips)
        if (c.trackRef && !cachedTrack(c.trackRef.assetId))
          void loadTrack(assets[c.trackRef.assetId]).then((f) => {
            if (f) nudgeRef.current();
          });
  }, [project.tracks, assets]);

  return (
    <>
      {/* Media elements sit UNDER the opaque canvas: on screen for the browser (offscreen muted
          videos may be paused or skip frame callbacks), invisible for the user. */}
      <div
        ref={poolRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden"
      />
      <canvas
        ref={canvasRef}
        data-testid="preview-canvas"
        aria-label="Vista previa multicapa"
        className="absolute inset-0 size-full"
      />
    </>
  );
}

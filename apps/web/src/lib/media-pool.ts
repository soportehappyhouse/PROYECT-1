import type { LayerSource } from "./compositor";

/**
 * One media element per layer source (key = clip id, `<clip>:alpha`, `<clip>:bg`), kept in sync
 * with the master clock. Video elements play while the timeline plays; small drift is corrected
 * by nudging playbackRate, large drift by seeking (audio tolerance: 60 ms).
 */

/** Drift above this is corrected (contract: simple sync, 60 ms). */
export const SYNC_TOLERANCE_S = 0.06;
/** Drift above this is fixed with a seek instead of a rate nudge. */
export const HARD_SYNC_S = 0.5;

export type PoolElement = HTMLVideoElement | HTMLImageElement;

export interface MediaUrls {
  primary: string;
  /** Used when the primary URL fails (original codec the browser cannot play → proxy). */
  fallback?: string;
}

/**
 * Corrected playbackRate for a drift (element time − target, seconds): 1 inside the tolerance,
 * up to ±10 % beyond it; `undefined` = seek instead.
 */
export function syncRate(drift: number, base: number): number | undefined {
  const a = Math.abs(drift);
  if (a > HARD_SYNC_S) return undefined;
  if (a <= SYNC_TOLERANCE_S) return base;
  const k = Math.min(0.1, a * 0.5);
  return base * (drift > 0 ? 1 - k : 1 + k);
}

interface Entry {
  key: string;
  assetId: string;
  el: PoolElement;
  urls: MediaUrls;
  failed: boolean;
  /** Shown in the last sync (false = preloaded for the next second). */
  live: boolean;
}

export class MediaPool {
  private entries = new Map<string, Entry>();

  constructor(
    private readonly container: HTMLElement,
    private readonly urlFor: (src: LayerSource) => MediaUrls,
    /** A frame became available (loaded / seeked): redraw while paused. */
    private readonly onFrame: () => void,
    private readonly onError?: (src: LayerSource) => void,
  ) {}

  get(key: string): PoolElement | undefined {
    return this.entries.get(key)?.el;
  }

  video(key: string): HTMLVideoElement | undefined {
    const el = this.get(key);
    return el instanceof HTMLVideoElement ? el : undefined;
  }

  /** Keys currently alive (tests / HUD). */
  keys(): string[] {
    return [...this.entries.keys()];
  }

  private create(src: LayerSource): Entry {
    const urls = this.urlFor(src);
    let el: PoolElement;
    if (src.element === "image") {
      const img = document.createElement("img");
      img.crossOrigin = "anonymous";
      img.decoding = "async";
      img.onload = () => this.onFrame();
      el = img;
    } else {
      const v = document.createElement("video");
      v.crossOrigin = "anonymous";
      v.preload = "auto";
      v.playsInline = true;
      v.muted = !src.audible;
      v.loop = !!src.loop;
      v.addEventListener("loadeddata", () => this.onFrame());
      v.addEventListener("seeked", () => this.onFrame());
      el = v;
    }
    el.dataset.poolKey = src.key;
    el.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none";
    const entry: Entry = {
      key: src.key,
      assetId: src.assetId,
      el,
      urls,
      failed: false,
      live: false,
    };
    el.addEventListener("error", () => {
      // 1) CORS-less retry (canvas becomes tainted but the media shows); 2) proxy fallback.
      if (el.crossOrigin) {
        el.removeAttribute("crossorigin");
        el.src = entry.urls.primary;
        return;
      }
      if (entry.urls.fallback && el.src !== entry.urls.fallback) {
        el.src = entry.urls.fallback;
        return;
      }
      entry.failed = true;
      this.onError?.(src);
    });
    el.src = urls.primary;
    this.container.appendChild(el);
    this.entries.set(src.key, entry);
    return entry;
  }

  private destroy(entry: Entry): void {
    const el = entry.el;
    if (el instanceof HTMLVideoElement) {
      el.pause();
      el.removeAttribute("src");
      el.load();
    }
    el.remove();
    this.entries.delete(entry.key);
  }

  failed(key: string): boolean {
    return this.entries.get(key)?.failed ?? false;
  }

  /**
   * Make the pool match `active` (shown now) + `preload` (next second, kept paused at their first
   * frame). `driverKey` is never rate-corrected: it IS the clock.
   */
  sync(
    active: readonly LayerSource[],
    preload: readonly LayerSource[],
    opts: { playing: boolean; rate: number; driverKey?: string | undefined },
  ): void {
    const wanted = new Map<string, { src: LayerSource; live: boolean }>();
    for (const s of preload) wanted.set(s.key, { src: s, live: false });
    for (const s of active) wanted.set(s.key, { src: s, live: true });

    for (const e of [...this.entries.values()]) {
      const w = wanted.get(e.key);
      const urls = w ? this.urlFor(w.src) : undefined;
      // Gone, or the clip now shows another asset / quality: rebuild.
      if (
        !w ||
        w.src.assetId !== e.assetId ||
        (urls && urls.primary !== e.urls.primary && !e.failed)
      )
        this.destroy(e);
    }

    const forward = opts.playing && opts.rate > 0;
    for (const { src, live } of wanted.values()) {
      const entry = this.entries.get(src.key) ?? this.create(src);
      const el = entry.el;
      if (!(el instanceof HTMLVideoElement)) continue;
      const base = src.rate * Math.abs(opts.rate || 1);
      const vol = Math.min(1, Math.max(0, src.volume));
      if (el.volume !== vol) el.volume = vol;
      const muted = !src.audible || !live;
      if (el.muted !== muted) el.muted = muted;
      if (el.readyState < 1) continue; // no metadata yet: seek later
      const target = src.loop && el.duration > 0 ? src.time % el.duration : src.time;
      const drift = el.currentTime - target;
      // A preloaded element that just became visible jumps to its exact time (no slow nudge).
      const becameLive = live && !entry.live;
      entry.live = live;
      if (becameLive && Math.abs(drift) > SYNC_TOLERANCE_S && !el.seeking) {
        el.currentTime = target;
        if (forward && el.paused) void el.play().catch(() => undefined);
        continue;
      }
      if (!live || !forward) {
        if (!el.paused) el.pause();
        if (Math.abs(drift) > 0.01 && !el.seeking) el.currentTime = target;
        continue;
      }
      if (src.key === opts.driverKey) {
        if (el.playbackRate !== base) el.playbackRate = base;
        if (Math.abs(drift) > HARD_SYNC_S && !el.seeking) el.currentTime = target;
      } else if (!el.seeking) {
        const r = syncRate(drift, base);
        if (r === undefined) el.currentTime = target;
        else if (Math.abs(el.playbackRate - r) > 1e-3) el.playbackRate = Math.max(0.0625, r);
      }
      if (el.paused && !el.ended) void el.play().catch(() => undefined);
    }
  }

  dispose(): void {
    for (const e of [...this.entries.values()]) this.destroy(e);
  }
}

/**
 * Master clock of the preview (Sprint 2). Concept ported from HeyGen HyperFrames
 * `core/src/runtime/clock.ts` (Apache-2.0): while playing, the time comes from the «driver» media
 * element (the bottom-most visible video) and is never reported behind what was already shown; when
 * there is no usable driver (gap, buffering, reverse shuttle) a monotonic clock takes over, and a
 * long main-thread stall is folded out instead of being reported as played time. Code is ours.
 */

export interface ClockDriver {
  el: HTMLMediaElement;
  /** Timeline second where the driver clip starts, its source in point and speed. */
  clipStart: number;
  clipIn: number;
  speed: number;
}

const STALL_MS = 500;
const STALL_LAG_MS = 33;
/** Driver this much behind what was shown: hold (buffering); more = ignore the driver. */
const HOLD_BEHIND_S = 0.25;
/** Driver this much ahead (stale seek, other clip): ignore it. */
const MAX_AHEAD_S = 0.5;
const HAVE_FUTURE_DATA = 3;

export class MasterClock {
  private base = 0;
  private startMs: number | null = null;
  private lastReadMs: number | null = null;
  private lastNow = 0;
  private rate = 1;
  private driver: ClockDriver | undefined;
  /** "driver" when the last now() came from the media element (HUD). */
  source: "driver" | "monotonic" = "monotonic";

  constructor(private readonly nowMs: () => number = () => performance.now()) {}

  get playing(): boolean {
    return this.startMs !== null;
  }

  play(at: number, rate = 1): void {
    this.base = at;
    this.lastNow = at;
    this.rate = rate;
    this.startMs = this.nowMs();
    this.lastReadMs = null;
  }

  pause(at?: number): void {
    this.base = at ?? this.now();
    this.lastNow = this.base;
    this.startMs = null;
    this.lastReadMs = null;
  }

  seek(t: number): void {
    this.base = t;
    this.lastNow = t;
    if (this.startMs !== null) this.startMs = this.nowMs();
    this.lastReadMs = null;
  }

  setRate(rate: number): void {
    if (this.startMs !== null) this.play(this.now(), rate);
    else this.rate = rate;
  }

  setDriver(driver: ClockDriver | undefined): void {
    this.driver = driver;
  }

  getDriver(): ClockDriver | undefined {
    return this.driver;
  }

  /** Timeline time of a driver media time (requestVideoFrameCallback `mediaTime`). */
  static timelineTime(
    d: Pick<ClockDriver, "clipStart" | "clipIn" | "speed">,
    media: number,
  ): number {
    return d.clipStart + (media - d.clipIn) / (d.speed || 1);
  }

  private driverTime(): number | undefined {
    const d = this.driver;
    if (!d || this.rate <= 0) return undefined;
    const el = d.el;
    if (el.paused || el.seeking || !Number.isFinite(el.currentTime)) return undefined;
    const t = MasterClock.timelineTime(d, el.currentTime);
    if (t >= this.lastNow) return t - this.lastNow > MAX_AHEAD_S ? undefined : t;
    const behind = this.lastNow - t;
    if (el.readyState < HAVE_FUTURE_DATA || behind <= HOLD_BEHIND_S) return this.lastNow;
    return undefined;
  }

  now(): number {
    if (this.startMs === null) return this.base;
    const fromDriver = this.driverTime();
    if (fromDriver !== undefined) {
      this.source = "driver";
      this.base = fromDriver;
      this.startMs = this.nowMs();
      this.lastReadMs = null;
      this.lastNow = fromDriver;
      return fromDriver;
    }
    this.source = "monotonic";
    const now = this.nowMs();
    if (this.lastReadMs !== null && now - this.lastReadMs > STALL_MS)
      this.startMs += now - this.lastReadMs - STALL_LAG_MS;
    this.lastReadMs = now;
    const t = Math.max(0, this.base + ((now - this.startMs) / 1000) * this.rate);
    this.lastNow = t;
    return t;
  }
}

/** The preview's single clock (the transport hook and the compositor share it). */
export const masterClock = new MasterClock();

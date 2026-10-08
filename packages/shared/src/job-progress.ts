/**
 * Sprint 5 (M1): ETA, stall detection and the Spanish ETA text of a job, shared by the api queue
 * (which stores `detail.eta_s`/`stalled`) and the web Jobs center (which re-computes them live).
 */
import { JOB_ETA_MIN_ELAPSED_S, JOB_ETA_MIN_PROGRESS, JOB_STALL_S } from "./job.js";

export interface EtaInput {
  /** Bar progress 0..1. */
  progress: number;
  /** When the job started running (ISO). */
  startedAt: string;
  /** Now, in ms since epoch. */
  now: number;
  /** Items done / total, from the worker (optional). */
  done?: number;
  total?: number;
  /** When the first item started being counted (ISO); defaults to `startedAt`. */
  firstItemAt?: string;
}

const parseMs = (iso: string | undefined): number | undefined => {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
};

/**
 * Seconds left, or null («calculando…»).
 * - With items: elapsed since the first item / done × (total − done).
 * - Without: elapsed × (1 − p) / p, only after JOB_ETA_MIN_ELAPSED_S and p ≥ JOB_ETA_MIN_PROGRESS.
 */
export function estimateEtaS(o: EtaInput): number | null {
  const started = parseMs(o.startedAt);
  if (started === undefined) return null;
  const elapsedS = Math.max(0, (o.now - started) / 1000);
  const { done, total } = o;
  if (done !== undefined && total !== undefined && total > 0) {
    if (done >= total) return 0;
    if (done > 0) {
      const from = parseMs(o.firstItemAt) ?? started;
      const itemsElapsedS = Math.max(0, (o.now - from) / 1000);
      if (itemsElapsedS <= 0) return null;
      return Math.round((itemsElapsedS / done) * (total - done));
    }
    return null;
  }
  const p = Number.isFinite(o.progress) ? o.progress : 0;
  if (p >= 1) return 0;
  if (elapsedS < JOB_ETA_MIN_ELAPSED_S || p < JOB_ETA_MIN_PROGRESS) return null;
  return Math.round((elapsedS * (1 - p)) / p);
}

/** True when the progress did not change for JOB_STALL_S seconds or more. */
export function isStalled(progressAt: string | undefined, now: number): boolean {
  const t = parseMs(progressAt);
  if (t === undefined) return false;
  return (now - t) / 1000 >= JOB_STALL_S;
}

/** «faltan ~6 min», «faltan ~40 s», «faltan ~1 h 20 min», «calculando…». */
export function formatEtaEs(s: number | null): string {
  if (s === null || !Number.isFinite(s) || s < 0) return "calculando…";
  if (s < 60) return `faltan ~${Math.max(1, Math.round(s / 5) * 5 || Math.round(s))} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `faltan ~${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `faltan ~${h} h ${rest} min` : `faltan ~${h} h`;
}

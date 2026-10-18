import type { EditOp, EditPlan } from "./agent.js";
import type { CutRange } from "./ai.js";
import type { MediaAsset } from "./media.js";
import {
  SUGGESTION_THRESHOLDS,
  type ImportAnalysis,
  type ImportSuggestion,
  type SuggestionKind,
} from "./suggestions.js";
import { SUGGESTION_TEXTS_ES } from "./texts-es.js";
import type { Clip, Project } from "./timeline.js";

/**
 * Sprint 6 M3 (docs/trabajo/sprint6-contratos.md, M3 P1.3): turn one ImportAnalysis (source
 * seconds of the asset) into the suggestion cards of a project. Pure and deterministic: the api
 * stores the result, the web only shows it. Each card carries an EditPlan that the api validates
 * with resolvePlan before the user applies it (nothing is applied here).
 */

/** What suggestionsFromAnalysis returns (the api adds id, status and the dates). */
export type SuggestionDraft = Omit<ImportSuggestion, "id" | "status" | "created_at" | "updated_at">;

/** UI texts of the cards (Pedido cruzado: move to texts-es.ts in the integration). */
export const SUGGESTION_UI_ES = {
  section: "Sugerencias",
  sectionHelp:
    "Studio revisó los medios que importaste y encontró cosas que se pueden mejorar. Nada se aplica solo.",
  apply: "Aplicar",
  applyTip: "Arma el plan de esta sugerencia y te muestra la vista previa antes de aplicarlo",
  dismiss: "Ignorar",
  dismissTip: "Oculta esta sugerencia (no se vuelve a mostrar para este clip)",
  mute: "No sugerir más",
  muteTip: "No vuelve a sugerir este tipo de cambio en ningún proyecto (se reactiva en Ajustes)",
  stale: "El clip cambió desde el análisis",
  staleTip: "Volvé a analizar el medio (Medios → Analizar) para actualizar la sugerencia",
  evidenceTip: "Tramos detectados a lo largo del clip",
  silencesDetail:
    "Cortar silencios de {min} ms o más con un margen corto antes y después de cada corte.",
  lowVoiceTitle: "La voz está baja ({lufs} LUFS)",
  lowVoiceDetail:
    "Subir {gain} dB la deja cerca de {target} LUFS (nivel normal en redes) sin saturar.",
  clippingTitle: "El audio satura (pico de {tp} dBTP)",
  clippingDetail: "Bajar {gain} dB deja el pico en {limit} dBTP (sin distorsión al exportar).",
  analyzeAction: "Analizar",
  analyzeTip: "Mide silencios y volumen para proponer sugerencias (trabajo de fondo)",
  empty: "No hay sugerencias para este proyecto.",
  analyzingTip: "Trabajo de fondo: nunca demora lo que pedís vos",
} as const;

/** «3,5» (one decimal, comma). */
export function fmtNumEs(n: number, digits = 1): string {
  return n.toFixed(digits).replace(".", ",").replace(/,0+$/, "");
}

/** «2:05» for seconds ≥ 60, «45 s» below. */
export function fmtDurEs(s: number): string {
  if (s < 60) return `${fmtNumEs(s)} s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return r === 60 ? `${m + 1}:00` : `${m}:${String(r).padStart(2, "0")}`;
}

export function fillTemplate(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{(\w+)\}/g, (all, k: string) => (k in vars ? String(vars[k]) : all));
}

/** Linear clip volume (0..4) in dB; 0 → -60. */
export function volumeToDb(volume: number | undefined): number {
  const v = volume ?? 1;
  return v <= 0 ? -60 : 20 * Math.log10(v);
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Clips of the project that play this asset with sound (in timeline order). */
export function clipsOfAsset(project: Project, assetId: string): Clip[] {
  const out: Clip[] = [];
  for (const track of project.tracks) {
    if (track.muted || (track.kind !== "video" && track.kind !== "audio")) continue;
    for (const clip of track.clips) if (clip.assetId === assetId) out.push(clip);
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Stable signature of the clips of a suggestion (source range, speed, volume): when it changes
 * after the analysis the suggestion becomes `stale` (SUGGESTION_STALE on «Aplicar»).
 */
export function clipsSignature(project: Project, clipIds: readonly string[]): string {
  const byId = new Map<string, Clip>();
  for (const t of project.tracks) for (const c of t.clips) byId.set(c.id, c);
  return clipIds
    .map((id) => {
      const c = byId.get(id);
      return c
        ? `${id}:${round3(c.in)}-${round3(c.out)}x${round3(c.speed)}v${round3(c.volume)}`
        : `${id}:gone`;
    })
    .join("|");
}

/** Silences of the analysis inside the clip's source range -> timeline seconds. */
export function silencesInClip(analysis: ImportAnalysis, clip: Clip): CutRange[] {
  const out: CutRange[] = [];
  for (const s of analysis.silences) {
    const a = Math.max(s.start, clip.in);
    const b = Math.min(s.end, clip.out);
    if (b - a < SUGGESTION_THRESHOLDS.silence_min_ms / 1000) continue;
    out.push({
      start: round3(clip.start + (a - clip.in) / clip.speed),
      end: round3(clip.start + (b - clip.in) / clip.speed),
    });
  }
  return out;
}

function plan(summary_es: string, ops: EditOp[]): EditPlan {
  return { version: 1, summary_es, ops: ops.slice(0, 20) };
}

/** Ranking score (higher first): seconds saved relative to the clip, then dB of fix. */
export function suggestionScore(s: Pick<SuggestionDraft, "kind" | "impact">): number {
  if (s.kind === "silences") return 50 + (s.impact.seconds_saved ?? 0);
  if (s.kind === "clipping") return 40 + Math.abs(s.impact.gain_db ?? 0) * 5;
  return 30 + Math.abs(s.impact.gain_db ?? 0);
}

/**
 * The suggestions of `project` for this analysis of `asset` (open cards, at most one per kind).
 * - silences: removable ≥ 8 % of the clips' duration, or ≥ 5 s in ≥ 3 silences → cut_silences.
 * - low_voice: integrated loudness (+ the clip volume) < −24 LUFS → set_volume up to −14 LUFS,
 *   never past −1 dBTP (and never above +12 dB, the op limit).
 * - clipping: true peak (+ the clip volume) > −1 dBTP → set_volume down to −1 dBTP.
 * `muted` kinds («No sugerir más») are left out.
 */
export function suggestionsFromAnalysis(
  analysis: ImportAnalysis,
  project: Project,
  asset: Pick<MediaAsset, "id" | "name">,
  muted: readonly SuggestionKind[] = [],
): SuggestionDraft[] {
  const T = SUGGESTION_THRESHOLDS;
  const clips = clipsOfAsset(project, asset.id);
  if (!clips.length) return [];
  const base = {
    projectId: project.id,
    assetId: asset.id,
    params_version: analysis.params_version,
  };
  const out: SuggestionDraft[] = [];

  // ---- silences
  if (!muted.includes("silences")) {
    const perClip = clips.map((clip) => ({ clip, ranges: silencesInClip(analysis, clip) }));
    const ranges = perClip.flatMap((p) => p.ranges);
    const total = clips.reduce((acc, c) => acc + (c.out - c.in) / c.speed, 0);
    const silent = ranges.reduce((acc, r) => acc + (r.end - r.start), 0);
    const offer =
      total > 0 &&
      ranges.length > 0 &&
      (silent / total >= T.offer_ratio ||
        (silent >= T.offer_min_s && ranges.length >= T.offer_min_count));
    if (offer) {
      const withSil = perClip.filter((p) => p.ranges.length).map((p) => p.clip);
      const title = fillTemplate(SUGGESTION_TEXTS_ES.silences, {
        n: ranges.length,
        s: fmtNumEs(silent),
        total: fmtDurEs(total),
      }).replace(/^1 silencios largos/, "1 silencio largo");
      out.push({
        ...base,
        clipIds: withSil.map((c) => c.id),
        kind: "silences",
        title_es: title.slice(0, 120),
        detail_es: fillTemplate(SUGGESTION_UI_ES.silencesDetail, { min: T.silence_min_ms }),
        impact: { seconds_saved: round1(silent), count: ranges.length },
        evidence: { ranges: ranges.slice(0, 200) },
        plan: plan(
          `Cortar ${ranges.length === 1 ? "1 silencio largo" : `${ranges.length} silencios largos`} (${fmtNumEs(silent)} s) de «${asset.name}»`,
          withSil.map((c) => ({
            op: "cut_silences",
            clip: { id: c.id },
            min_silence_ms: T.silence_min_ms,
            fillers: false,
          })),
        ),
      });
    }
  }

  // ---- loudness (one of low_voice / clipping per clip group, same current volume assumed)
  const currentDb = volumeToDb(clips[0]!.volume);
  const lufs = analysis.lufs_i === null ? null : analysis.lufs_i + currentDb;
  const tp = analysis.true_peak_db === null ? null : analysis.true_peak_db + currentDb;
  const sameVolume = clips.every((c) => Math.abs(volumeToDb(c.volume) - currentDb) < 0.05);
  if (sameVolume && lufs !== null && analysis.lufs_i !== null) {
    const srcLufs = analysis.lufs_i;
    const srcTp = analysis.true_peak_db;
    if (!muted.includes("low_voice") && lufs < T.low_voice_lufs) {
      const byLufs = T.target_lufs - srcLufs;
      const byPeak = srcTp === null ? Infinity : T.target_true_peak_db - srcTp;
      const target = Math.min(byLufs, byPeak, 12);
      const gain = Math.floor(target * 10) / 10;
      if (gain - currentDb >= 1) {
        out.push({
          ...base,
          clipIds: clips.map((c) => c.id),
          kind: "low_voice",
          title_es: fillTemplate(SUGGESTION_UI_ES.lowVoiceTitle, { lufs: fmtNumEs(lufs) }),
          detail_es: fillTemplate(SUGGESTION_UI_ES.lowVoiceDetail, {
            gain: fmtNumEs(gain - currentDb),
            target: fmtNumEs(Math.min(T.target_lufs, srcLufs + gain)),
          }),
          impact: {
            lufs: round1(lufs),
            target_lufs: round1(srcLufs + gain),
            gain_db: round1(gain - currentDb),
            ...(srcTp !== null && { true_peak_db: round1(srcTp + gain) }),
          },
          plan: plan(
            fillTemplate(SUGGESTION_TEXTS_ES.lowVoice, { lufs: fmtNumEs(lufs) }),
            clips.map((c) => ({ op: "set_volume", clip: { id: c.id }, volume_db: gain })),
          ),
        });
      }
    }
    if (
      !muted.includes("clipping") &&
      tp !== null &&
      srcTp !== null &&
      tp > T.clipping_true_peak_db
    ) {
      const gain = Math.max(-60, Math.floor((T.target_true_peak_db - srcTp) * 10) / 10);
      if (gain < currentDb) {
        out.push({
          ...base,
          clipIds: clips.map((c) => c.id),
          kind: "clipping",
          title_es: fillTemplate(SUGGESTION_UI_ES.clippingTitle, { tp: fmtNumEs(tp) }),
          detail_es: fillTemplate(SUGGESTION_UI_ES.clippingDetail, {
            gain: fmtNumEs(Math.abs(gain - currentDb)),
            limit: fmtNumEs(T.target_true_peak_db),
          }),
          impact: {
            true_peak_db: round1(tp),
            gain_db: round1(gain - currentDb),
            lufs: round1(lufs),
          },
          plan: plan(
            fillTemplate(SUGGESTION_TEXTS_ES.clipping, { tp: fmtNumEs(tp) }),
            clips.map((c) => ({ op: "set_volume", clip: { id: c.id }, volume_db: gain })),
          ),
        });
      }
    }
  }
  return out.sort((a, b) => suggestionScore(b) - suggestionScore(a));
}

/** The cards to show: open first by score, at most `max_cards`. */
export function visibleSuggestions<S extends Pick<ImportSuggestion, "status" | "kind" | "impact">>(
  list: readonly S[],
  max: number = SUGGESTION_THRESHOLDS.max_cards,
): S[] {
  return list
    .filter((s) => s.status === "open" || s.status === "stale")
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "open" ? -1 : 1;
      return suggestionScore(b) - suggestionScore(a);
    })
    .slice(0, max);
}

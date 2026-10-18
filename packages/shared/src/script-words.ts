import type { EditOp, EditPlan } from "./agent.js";
import type { CutRange } from "./ai.js";
import {
  FILLER_LEXICON_ES,
  SCRIPT_RULES,
  type FillerLevel,
  type FitDurationPreview,
  type FitDurationRequest,
  type FitLevel,
  type Script,
  type ScriptAudioGap,
  type ScriptCut,
  type ScriptCutReason,
  type ScriptCutsRequest,
  type ScriptCutsResponse,
  type ScriptFiller,
  type ScriptPause,
  type Word,
} from "./script.js";
import type { SubtitleSegment, SubtitleWord } from "./subtitles.js";
import type { Clip, Project, Track } from "./timeline.js";

/**
 * Sprint 6 M1 «Guion editable por palabras» (docs/trabajo/sprint6-contratos.md, M1;
 * docs/trabajo/fuentes-sprint6.md §1.3–§1.6). Pure functions shared by the web panel, the api
 * routes and the agent ops:
 *
 * - `buildScript`: the computed Script view of `project.subtitles[].words` (+ acoustic gaps).
 * - `detectFillers`: Rioplatense lexicon + context rules + repetitions + acoustic gaps (3 levels).
 * - `planWordCuts` / `refineCutsWithEnergy`: deleted words -> timeline cuts in the middle of the
 *   gap, pad ≤ 60 ms, < 40 ms not cut, «evitar cortes bruscos», 12 ms join fades.
 * - `cutTimeline`: ripple those cuts on every unlocked track + subtitles in one pure step.
 * - `fitDuration`: greedy by levels («dejalo en 45 s»), never mid-word, never below the target.
 * - `fixWords`: text correction keeping the measured timings (word diff).
 */

const R = SCRIPT_RULES;
const EPS = 1e-6;
const ms = (s: number) => s * 1000;
const sec = (m: number) => m / 1000;
const round = (t: number) => Math.round(t * 1e6) / 1e6;
const round3 = (t: number) => Math.round(t * 1000) / 1000;

/** Word index offset of acoustic pseudo-words ("<seg>:<ACOUSTIC_WORD_BASE + k>"). */
export const ACOUSTIC_WORD_BASE = 100000;
/** Shortest pause listed in `Script.pauses` (shorter gaps are natural speech). */
export const SCRIPT_PAUSE_MIN_MS = 250;
/** A filler «needs_pause» when it has at least this much silence before or after. */
export const FILLER_CONTEXT_PAUSE_MS = 120;

/** Extra Spanish texts of the Guion panel (SCRIPT_TEXTS_ES lives in texts-es.ts, Paso 0). */
export const SCRIPT_PANEL_TEXTS_ES = {
  title: "Guion",
  transcribe: "Transcribir para el guion",
  transcribing: "Transcribiendo palabras…",
  removeSafe: "Quitar seguras ({n})",
  reviewDoubtful: "Revisar dudosas ({n})",
  shortenPauses: "Acortar pausas largas ({n})",
  fitLabel: "Dejalo en",
  fitPreview: "Ver propuesta",
  fitApply: "Aplicar",
  deleteSelection: "Borrar selección",
  noAudioArtifact:
    "Sin el análisis de audio no se detectan los «eh» que Whisper no escribe: volvé a transcribir desde el Guion.",
  acoustic: "(eh)",
  fixPrompt: "Corregí el texto (los tiempos no se mueven)",
  deleted: "Borré {n} palabras (−{s} s).",
  nothingToCut: "No hay nada para cortar con esa selección.",
  stale:
    "El guion no coincide con la línea de tiempo. Volvé a transcribir o deshacé el último cambio.",
  harsh: "Corte brusco: queda sin cortar para no comerse la palabra vecina",
} as const;

/** Lowercase, no accents, no punctuation (diff and lexicon key). Keeps ñ as n. */
export function normWord(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const VOCALIZATION_RE = /^(e+h+|e{2,}|e+m+|m{2,}|h+m+|a+h+|e+h+m+)$/;
const SENTENCE_END_RE = /[.?!…]["'”»)\]]*$/;

// ------------------------------------------------------------------------------------------------
// buildScript

/** Acoustic artifact of script.transcribe with the gaps already in TIMELINE seconds. */
export interface ScriptBuildAudio {
  jobId: string;
  noise_floor_db: number;
  gaps: readonly ScriptAudioGap[];
}

export interface BuildScriptOptions {
  language?: string;
  stale?: boolean;
}

const clipEndOf = (c: Pick<Clip, "start" | "in" | "out" | "speed">) =>
  c.start + Math.max(0, (c.out - c.in) / (c.speed || 1));

/** Timeline duration (end of the last clip). */
export function timelineDuration(project: Pick<Project, "tracks">): number {
  let end = 0;
  for (const t of project.tracks) for (const c of t.clips) end = Math.max(end, clipEndOf(c));
  return round3(end);
}

/** Words of a segment; a segment without `words` gets estimated ones (by letters, corrected). */
function segmentWords(seg: SubtitleSegment): SubtitleWord[] {
  if (seg.words?.length) return seg.words;
  const tokens = seg.text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  return spreadByLetters(tokens, seg.start, seg.end).map((w) => ({ ...w, corrected: true }));
}

/**
 * The Script view: words sorted by time (ids "<segment index in project.subtitles>:<word index>"),
 * pauses between words, «harsh» marks, fillers and stats. Acoustic gaps (timeline seconds) become
 * pseudo-words (filler `acoustic`) between the words they sit in.
 */
export function buildScript(
  project: Pick<Project, "id" | "tracks" | "subtitles">,
  audio?: ScriptBuildAudio,
  opts: BuildScriptOptions = {},
): Script {
  const raw: Word[] = [];
  project.subtitles.forEach((seg, si) => {
    segmentWords(seg).forEach((w, wi) => {
      const text = w.word.trim();
      if (!text) return;
      const start = Math.max(0, w.start);
      raw.push({
        id: `${si}:${wi}`,
        text,
        norm: normWord(text),
        start: round(start),
        end: round(Math.max(start, w.end)),
        segment: si,
        ...(w.probability !== undefined && { probability: w.probability }),
        ...(w.corrected && { corrected: true }),
      });
    });
  });
  raw.sort((a, b) => a.start - b.start || a.end - b.end);
  const withAcoustic = audio ? insertAcoustic(raw, audio) : raw;
  const words = markHarsh(detectFillers(withAcoustic, audio));
  const pauses = scriptPauses(words);
  const fillers = { safe: 0, probable: 0, doubtful: 0 };
  for (const w of words) if (w.filler) fillers[w.filler.level]++;
  return {
    version: 1,
    projectId: project.id,
    language: opts.language ?? "es",
    words,
    pauses,
    stats: {
      words: words.filter((w) => !isAcoustic(w)).length,
      duration_s: timelineDuration(project),
      long_pauses: pauses.filter((p) => p.long).length,
      fillers,
    },
    ...(audio && { audio: { jobId: audio.jobId, noise_floor_db: audio.noise_floor_db } }),
    stale: opts.stale ?? false,
  };
}

/** True for the pseudo-words made from acoustic gaps (no subtitle word behind them). */
export function isAcoustic(w: Pick<Word, "id">): boolean {
  const idx = Number(w.id.split(":")[1]);
  return idx >= ACOUSTIC_WORD_BASE;
}

function insertAcoustic(words: Word[], audio: ScriptBuildAudio): Word[] {
  const pad = sec(R.cut_pad_max_ms);
  const out: Word[] = [];
  let k = 0;
  const gaps = [...audio.gaps].sort((a, b) => a.start - b.start);
  let gi = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    out.push(w);
    const next = words[i + 1];
    if (!next) break;
    while (gi < gaps.length && gaps[gi]!.end <= w.end + EPS) gi++;
    for (let j = gi; j < gaps.length && gaps[j]!.start < next.start - EPS; j++) {
      const g = gaps[j]!;
      const a = Math.max(g.start, w.end);
      const b = Math.min(g.end, next.start);
      if (ms(b - a) < R.acoustic_min_ms) continue;
      if (!g.voiced || g.rms_db < audio.noise_floor_db + R.acoustic_db_over_floor) continue;
      out.push({
        id: `${w.segment}:${ACOUSTIC_WORD_BASE + k++}`,
        text: SCRIPT_PANEL_TEXTS_ES.acoustic,
        norm: "eh",
        start: round(a + pad),
        end: round(b - pad),
        segment: w.segment,
        filler: {
          category: "acoustic",
          level: "safe",
          confidence: 0.75,
          reason_es: "Sonido sin palabra (probable «eh» o «em»)",
        },
      });
    }
  }
  return out;
}

function markHarsh(words: Word[]): Word[] {
  return words.map((w, i) => {
    const prev = words[i - 1];
    const next = words[i + 1];
    const tight =
      (prev && ms(w.start - prev.end) < R.harsh_gap_ms) ||
      (next && ms(next.start - w.end) < R.harsh_gap_ms);
    const unsure = w.probability !== undefined && w.probability < R.harsh_probability;
    const { harsh: _h, ...rest } = w;
    return tight || unsure ? { ...rest, harsh: true } : rest;
  });
}

function scriptPauses(words: readonly Word[]): ScriptPause[] {
  const out: ScriptPause[] = [];
  for (let i = 0; i + 1 < words.length; i++) {
    const a = words[i]!;
    const b = words[i + 1]!;
    const gap = ms(b.start - a.end);
    if (gap < SCRIPT_PAUSE_MIN_MS) continue;
    out.push({
      kind: "pause",
      after: a.id,
      start: a.end,
      end: b.start,
      long: gap > R.pause_long_ms,
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// detectFillers

const lexicon = new Map(FILLER_LEXICON_ES.map((e) => [e.text, e]));
const VISTE_BLOCKERS = new Set(["lo", "la", "los", "las", "le", "les", "me", "te", "se", "ya"]);
const TIPO_BLOCKERS = new Set([
  "un",
  "el",
  "de",
  "que",
  "ese",
  "este",
  "otro",
  "mismo",
  "ningun",
  "algun",
  "cualquier",
  "cada",
]);
const NADA_BLOCKERS = new Set(["no", "casi", "para", "de", "por"]);
const CONFIDENCE: Record<FillerLevel, number> = { safe: 0.9, probable: 0.65, doubtful: 0.5 };

function filler(
  category: ScriptFiller["category"],
  level: FillerLevel,
  reason_es: string,
  confidence = CONFIDENCE[level],
): ScriptFiller {
  return { category, level, confidence, reason_es };
}

/**
 * Mark fillers on the words (returns new objects; acoustic pseudo-words keep theirs). Rules
 * (fuentes §1.3): vocalizations and exact repetitions = safe; «o sea», «digamos», «este»/«bueno»
 * with a pause = probable; closing tags and wildcards = doubtful (with their context rules); false
 * starts = doubtful. Only `safe` is preselected by the panel.
 */
export function detectFillers(
  words: readonly Word[],
  _audio?: Pick<ScriptBuildAudio, "noise_floor_db">,
): Word[] {
  const out = words.map((w) => (isAcoustic(w) ? w : stripFiller(w)));
  const n = out.length;
  const gapBefore = (i: number) => (i > 0 ? ms(out[i]!.start - out[i - 1]!.end) : Infinity);
  const gapAfter = (i: number) => (i + 1 < n ? ms(out[i + 1]!.start - out[i]!.end) : Infinity);
  const sentenceStart = (i: number) =>
    i === 0 ||
    SENTENCE_END_RE.test(out[i - 1]!.text) ||
    gapBefore(i) >= R.sentence_pause_ms ||
    out[i - 1]!.segment !== out[i]!.segment;
  const clauseEnd = (i: number) =>
    i + 1 >= n ||
    /[.?!…,;:]["'”»)\]]*$/.test(out[i]!.text) ||
    gapAfter(i) >= FILLER_CONTEXT_PAUSE_MS;
  const pausedAround = (i: number) =>
    (i > 0 && gapBefore(i) >= FILLER_CONTEXT_PAUSE_MS) ||
    (i + 1 < n && gapAfter(i) >= FILLER_CONTEXT_PAUSE_MS) ||
    /[,…]$/.test(out[i]!.text);
  const set = (i: number, f: ScriptFiller) => {
    if (!out[i]!.filler) out[i] = { ...out[i]!, filler: f };
  };
  const real = (i: number) => i >= 0 && i < n && !isAcoustic(out[i]!);

  // Repetitions first (exact n-grams of 1–3 words): delete the FIRST occurrence.
  for (let i = 0; i < n; i++) {
    if (!real(i)) continue;
    for (let len = 3; len >= 1; len--) {
      if (i + 2 * len > n) continue;
      let same = true;
      for (let k = 0; k < len && same; k++) {
        const a = out[i + k]!;
        const b = out[i + len + k]!;
        same = !isAcoustic(a) && !isAcoustic(b) && a.norm !== "" && a.norm === b.norm;
      }
      // «no, no» / «sí sí» are emphasis more often than stutter: one-word repeats of those are
      // left to the closing-tag rule.
      if (same && len === 1 && ["no", "si"].includes(out[i]!.norm)) same = false;
      if (!same) continue;
      for (let k = 0; k < len; k++)
        set(
          i + k,
          filler(
            "repetition",
            "safe",
            `Repetición: «${out
              .slice(i, i + len)
              .map((w) => w.text)
              .join(" ")}» dos veces`,
            0.85,
          ),
        );
      break;
    }
  }

  for (let i = 0; i < n; i++) {
    const w = out[i]!;
    if (!real(i) || w.filler) continue;
    const key = w.norm;
    const prev = real(i - 1) ? out[i - 1]!.norm : "";
    const next = real(i + 1) ? out[i + 1]!.norm : "";
    if (VOCALIZATION_RE.test(key) || lexicon.get(key)?.category === "vocalization") {
      set(i, filler("vocalization", "safe", "Vocalización («eh», «em»)"));
      continue;
    }
    if (key === "o" && next === "sea") {
      const f = filler("empty_connector", "probable", "Conector vacío «o sea»", 0.7);
      set(i, f);
      set(i + 1, f);
      continue;
    }
    switch (key) {
      case "digamos":
        set(i, filler("empty_connector", "probable", "Conector vacío «digamos»", 0.7));
        continue;
      case "este":
        if (pausedAround(i))
          set(i, filler("empty_connector", "probable", "«Este» de relleno (con pausa)", 0.65));
        continue;
      case "bueno":
        if (sentenceStart(i) && (gapAfter(i) >= FILLER_CONTEXT_PAUSE_MS || /,$/.test(w.text)))
          set(i, filler("empty_connector", "probable", "«Bueno» al arrancar la frase", 0.6));
        continue;
      case "viste":
      case "entendes":
        if (!VISTE_BLOCKERS.has(prev) && clauseEnd(i))
          set(i, filler("closing_tag", "doubtful", `Apoyo de cierre «¿${w.norm}?»`));
        continue;
      case "no":
      case "si":
        if (/\?/.test(w.text) && clauseEnd(i) && !sentenceStart(i))
          set(i, filler("closing_tag", "doubtful", `Apoyo de cierre «¿${w.norm}?»`, 0.45));
        continue;
      case "tipo":
        if (!TIPO_BLOCKERS.has(prev) && next !== "de")
          set(i, filler("wildcard", "doubtful", "Comodín «tipo»"));
        continue;
      case "nada":
        if (sentenceStart(i) && !NADA_BLOCKERS.has(prev) && (/,$/.test(w.text) || next === "que"))
          set(i, filler("wildcard", "doubtful", "«Nada» de relleno al inicio", 0.55));
        continue;
      case "literal":
      case "basicamente":
      case "mira":
      case "dale":
        if (pausedAround(i) || sentenceStart(i))
          set(i, filler("wildcard", "doubtful", `Comodín «${w.text.replace(/[,.…]$/, "")}»`, 0.45));
        continue;
      default:
        break;
    }
    // False start: unsure word, then a pause, then a word with the same stem.
    if (
      w.probability !== undefined &&
      w.probability < R.harsh_probability &&
      real(i + 1) &&
      gapAfter(i) >= FILLER_CONTEXT_PAUSE_MS &&
      key.length >= 2 &&
      next.startsWith(key.slice(0, Math.min(3, key.length)))
    )
      set(
        i,
        filler("false_start", "doubtful", "Arranque falso (se corta y vuelve a empezar)", 0.4),
      );
  }
  return out;
}

function stripFiller(w: Word): Word {
  if (!w.filler) return w;
  const { filler: _f, ...rest } = w;
  return rest;
}

// ------------------------------------------------------------------------------------------------
// planWordCuts

const LEVEL_RANK: Record<FillerLevel, number> = { safe: 0, probable: 1, doubtful: 2 };

/** Fillers included by a `fillers` choice (cumulative: probable = safe + probable). */
export function fillerSelected(w: Pick<Word, "filler">, level: FillerLevel | "all"): boolean {
  if (!w.filler) return false;
  if (level === "all") return true;
  return LEVEL_RANK[w.filler.level] <= LEVEL_RANK[level];
}

interface Run {
  i: number;
  j: number;
  reason: ScriptCutReason;
}

export interface CutWithBounds extends ScriptCut {
  /** Gap limits each edge may move in (energy refinement never crosses into a word). */
  lo: [number, number];
  hi: [number, number];
}

const fadeFor = (keptS: number) =>
  Math.max(0, Math.min(R.join_fade_ms, R.join_fade_max_ms, Math.floor(ms(keptS) / 2)));

/**
 * Selection -> timeline cuts (not applied). Deleted words merge into runs; each run is cut from
 * `prev.end + min(60 ms, gap/2)` to `next.start − min(60 ms, gap/2)`. A cut < 40 ms is skipped;
 * with `avoidHarsh` a run glued to a neighbour (< 30 ms) or a filler with probability < 0.4 is
 * skipped too (listed in `skipped`). `ranges` select the words whose middle is inside them; a range
 * with no word (a pause) is cut as is, kept ≥ 30 ms away from the words around it.
 */
export function planWordCuts(script: Pick<Script, "words" | "pauses">, req: ScriptCutsRequest) {
  return planCutsInternal(script, req).response;
}

/** planWordCuts + the gap limits of every edge (for `refineCutsWithEnergy`). */
export function planCutsInternal(
  script: Pick<Script, "words" | "pauses">,
  req: ScriptCutsRequest,
): { response: ScriptCutsResponse; bounded: CutWithBounds[] } {
  const words = script.words;
  const avoidHarsh = req.avoidHarsh ?? true;
  const chosen = new Map<number, ScriptCutReason>();
  const byId = new Map(words.map((w, i) => [w.id, i]));
  for (const id of req.wordIds ?? []) {
    const i = byId.get(id);
    if (i !== undefined) chosen.set(i, "words");
  }
  if (req.fillers)
    words.forEach((w, i) => {
      if (fillerSelected(w, req.fillers!) && !chosen.has(i)) chosen.set(i, "filler");
    });
  const pauseRanges: CutRange[] = [];
  for (const r of req.ranges ?? []) {
    const a = Math.min(r.start, r.end);
    const b = Math.max(r.start, r.end);
    let any = false;
    words.forEach((w, i) => {
      const mid = (w.start + w.end) / 2;
      if (mid > a + EPS && mid < b - EPS) {
        any = true;
        if (!chosen.has(i)) chosen.set(i, w.filler ? "filler" : "words");
      }
    });
    if (!any && b - a > EPS) pauseRanges.push({ start: a, end: b });
  }

  const skipped: { wordId: string; reason_es: string }[] = [];
  const bounded: CutWithBounds[] = [];
  const order = [...chosen.keys()].sort((x, y) => x - y);
  const runs: Run[] = [];
  for (const i of order) {
    const last = runs[runs.length - 1];
    const reason = chosen.get(i)!;
    if (last && last.j === i - 1) {
      last.j = i;
      if (reason === "words") last.reason = "words";
    } else runs.push({ i, j: i, reason });
  }
  const pad = sec(R.cut_pad_max_ms);
  for (const run of runs) {
    const first = words[run.i]!;
    const last = words[run.j]!;
    const prev = words[run.i - 1];
    const next = words[run.j + 1];
    const gapIn = prev ? first.start - prev.end : Math.min(pad * 2, first.start);
    const gapOut = next ? next.start - last.end : pad;
    const ids = words.slice(run.i, run.j + 1).map((w) => w.id);
    const skip = (reason_es: string) => {
      for (const id of ids) skipped.push({ wordId: id, reason_es });
    };
    if (avoidHarsh) {
      const tight = (prev && ms(gapIn) < R.harsh_gap_ms) || (next && ms(gapOut) < R.harsh_gap_ms);
      const unsure =
        run.reason === "filler" &&
        words
          .slice(run.i, run.j + 1)
          .some((w) => w.probability !== undefined && w.probability < R.harsh_probability);
      if (tight || unsure) {
        skip(SCRIPT_PANEL_TEXTS_ES.harsh);
        continue;
      }
    }
    const padIn = Math.min(pad, Math.max(0, gapIn) / 2);
    const padOut = Math.min(pad, Math.max(0, gapOut) / 2);
    const start = prev ? prev.end + padIn : Math.max(0, first.start - padIn);
    const end = next ? next.start - padOut : last.end + padOut;
    if (ms(end - start) < R.min_cut_ms) {
      skip("El corte quedaría demasiado corto (menos de 40 ms)");
      continue;
    }
    bounded.push({
      start: round(start),
      end: round(end),
      fade_ms: fadeFor(padIn + padOut),
      reason: run.reason,
      lo: [prev ? prev.end : Math.max(0, first.start - pad * 2), first.start],
      hi: [last.end, next ? next.start : last.end + pad * 2],
    });
  }

  // Long pauses shortened to 250 ms (kept centered: 125 ms after the word, 125 ms before the next).
  const keepHalf = sec(R.pause_target_ms) / 2;
  if (req.shortenLongPauses)
    for (const p of script.pauses) {
      if (!p.long) continue;
      const a = p.start + keepHalf;
      const b = p.end - keepHalf;
      if (ms(b - a) < R.min_cut_ms) continue;
      bounded.push({
        start: round(a),
        end: round(b),
        fade_ms: fadeFor(2 * keepHalf),
        reason: "pause",
        lo: [p.start + sec(R.harsh_gap_ms), b],
        hi: [a, p.end - sec(R.harsh_gap_ms)],
      });
    }
  for (const r of pauseRanges) {
    // Keep 30 ms off any word the range touches.
    const before = [...words].reverse().find((w) => w.end <= r.end + EPS && w.start < r.start);
    const after = words.find((w) => w.start >= r.start - EPS && w.end > r.end);
    const guard = sec(R.harsh_gap_ms);
    const a = Math.max(r.start, before ? before.end + guard : r.start);
    const b = Math.min(r.end, after ? after.start - guard : r.end);
    if (ms(b - a) < R.min_cut_ms) continue;
    bounded.push({
      start: round(a),
      end: round(b),
      fade_ms: fadeFor(a - (before?.end ?? a) + ((after?.start ?? b) - b)),
      reason: "pause",
      lo: [before ? before.end + guard : a, b],
      hi: [a, after ? after.start - guard : b],
    });
  }

  const merged = mergeBounded(bounded);
  const cuts = merged.map(({ lo: _lo, hi: _hi, ...c }) => c);
  return {
    response: {
      cuts,
      removed_s: round3(cuts.reduce((s, c) => s + (c.end - c.start), 0)),
      skipped,
    },
    bounded: merged,
  };
}

function mergeBounded(list: CutWithBounds[]): CutWithBounds[] {
  const sorted = [...list].sort((a, b) => a.start - b.start);
  const out: CutWithBounds[] = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && c.start <= last.end + EPS) {
      if (c.end > last.end) {
        last.end = c.end;
        last.hi = c.hi;
      }
      last.fade_ms = Math.min(last.fade_ms, c.fade_ms);
      if (last.reason !== c.reason) last.reason = last.reason === "pause" ? c.reason : last.reason;
    } else out.push({ ...c, lo: [...c.lo], hi: [...c.hi] });
  }
  return out;
}

/**
 * Move each cut edge to the quietest 5 ms window within ±60 ms, never into a word (`lo`/`hi`
 * limits from planCutsInternal). `energyDb(t)` = RMS dB at timeline time t (undefined = unknown:
 * the edge stays). Cuts that end up < 40 ms are dropped.
 */
export function refineCutsWithEnergy(
  bounded: readonly CutWithBounds[],
  energyDb: (t: number) => number | undefined,
): ScriptCut[] {
  const step = sec(R.energy_window_ms);
  const reach = sec(R.energy_search_ms);
  const best = (t: number, lim: readonly [number, number]) => {
    const a = Math.max(lim[0], t - reach);
    const b = Math.min(lim[1], t + reach);
    let at = t;
    let low = energyDb(t);
    if (low === undefined) return t;
    for (let x = a; x <= b + EPS; x += step) {
      const e = energyDb(x);
      if (e !== undefined && e < low - 1e-9) {
        low = e;
        at = x;
      }
    }
    return round(at);
  };
  const out: ScriptCut[] = [];
  for (const c of bounded) {
    const start = best(c.start, c.lo);
    const end = best(c.end, c.hi);
    if (ms(end - start) < R.min_cut_ms) continue;
    out.push({ start, end, fade_ms: c.fade_ms, reason: c.reason });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// cutTimeline

export interface CutTimelineOptions {
  /** Audio fade (ms) at every join (Clip.audioFade); default SCRIPT_RULES.join_fade_ms. */
  fadeMs?: number;
  newId: () => string;
}

export interface CutTimelineOutcome<P> {
  project: P;
  removed_s: number;
  /** Clips created by the cuts (all pieces after the first of each split clip). */
  newClipIds: string[];
}

/** Sorted, merged, non-empty ranges. */
export function mergeCutRanges(ranges: readonly CutRange[]): CutRange[] {
  const sorted = ranges
    .map((r) => ({ start: Math.min(r.start, r.end), end: Math.max(r.start, r.end) }))
    .filter((r) => r.end - r.start > EPS)
    .sort((a, b) => a.start - b.start);
  const out: CutRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + EPS) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** Ripple mapping of a set of removed timeline ranges. */
export function cutMapping(ranges: readonly CutRange[]) {
  const merged = mergeCutRanges(ranges);
  /** New time; a time inside a removed range snaps to where the range was. */
  const map = (t: number) => {
    let removed = 0;
    for (const r of merged) {
      if (t <= r.start + EPS) break;
      if (t < r.end) return round(r.start - removed);
      removed += r.end - r.start;
    }
    return round(t - removed);
  };
  const inside = (t: number) => merged.some((r) => t > r.start + EPS && t < r.end - EPS);
  /** Timeline time removed inside [a, b]. */
  const overlap = (a: number, b: number) =>
    merged.reduce((s, r) => s + Math.max(0, Math.min(b, r.end) - Math.max(a, r.start)), 0);
  return { ranges: merged, map, inside, overlap };
}

const MIN_PIECE_S = 0.04;

/**
 * Remove timeline `ranges` from every unlocked track (sync ripple, one undo step for the caller):
 * video/audio clips are split around each range (12 ms `audioFade` on the new joins, video stays a
 * hard cut), text/motion overlays shrink by the time removed under them (animated captions are
 * re-timed and lose their render), and subtitles (+ words) and reframe keyframes are re-timed.
 * Locked tracks do not move.
 */
export function cutTimeline<P extends Pick<Project, "tracks" | "subtitles"> & Partial<Project>>(
  project: P,
  ranges: readonly CutRange[],
  opts: CutTimelineOptions,
): CutTimelineOutcome<P> {
  const m = cutMapping(ranges);
  const fade = Math.max(0, Math.min(200, Math.round(opts.fadeMs ?? R.join_fade_ms)));
  const newClipIds: string[] = [];
  if (m.ranges.length === 0) return { project, removed_s: 0, newClipIds };
  const tracks = project.tracks.map((t): Track => {
    if (t.locked) return t;
    const clips: Clip[] = [];
    for (const c of t.clips) {
      if (t.kind === "video" || t.kind === "audio")
        clips.push(...splitAround(c, m, fade, opts, newClipIds));
      else {
        const o = shrinkOverlay(c, m);
        if (o) clips.push(o);
      }
    }
    return { ...t, clips: clips.sort((a, b) => a.start - b.start) };
  });
  const subtitles = project.subtitles
    .map((s) => retimeSegment(s, m))
    .filter((s): s is SubtitleSegment => s !== undefined);
  const removed_s = round3(m.ranges.reduce((s, r) => s + (r.end - r.start), 0));
  const next = { ...project, tracks, subtitles } as P;
  if (project.reframe)
    (next as Partial<Project>).reframe = {
      ...project.reframe,
      keyframes: project.reframe.keyframes.map((k) => ({ ...k, t: m.map(k.t) })),
    };
  return { project: next, removed_s, newClipIds };
}

function splitAround(
  c: Clip,
  m: ReturnType<typeof cutMapping>,
  fade: number,
  opts: CutTimelineOptions,
  created: string[],
): Clip[] {
  const start = c.start;
  const end = clipEndOf(c);
  const speed = c.speed || 1;
  if (m.overlap(start, end) <= EPS) {
    const s = m.map(start);
    return [Math.abs(s - start) <= EPS ? c : { ...c, start: s }];
  }
  const keep: CutRange[] = [];
  let cursor = start;
  for (const r of m.ranges) {
    if (r.end <= start + EPS || r.start >= end - EPS) continue;
    if (r.start - cursor > EPS) keep.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (end - cursor > EPS) keep.push({ start: cursor, end });
  const kept = keep.filter((k) => k.end - k.start >= MIN_PIECE_S);
  return kept.map((k, i) => {
    const atStart = Math.abs(k.start - start) <= EPS;
    const atEnd = Math.abs(k.end - end) <= EPS;
    const id = i === 0 ? c.id : opts.newId();
    if (i > 0) created.push(id);
    const piece: Clip = {
      ...c,
      id,
      start: m.map(k.start),
      in: round(c.in + (k.start - start) * speed),
      out: round(c.in + (k.end - start) * speed),
    };
    delete piece.transitionIn;
    delete piece.transitionOut;
    if (atStart && c.transitionIn) piece.transitionIn = c.transitionIn;
    if (atEnd && c.transitionOut) piece.transitionOut = c.transitionOut;
    const inMs = atStart ? (c.audioFade?.inMs ?? 0) : fade;
    const outMs = atEnd ? (c.audioFade?.outMs ?? 0) : fade;
    if (inMs > 0 || outMs > 0) piece.audioFade = { inMs, outMs };
    else delete piece.audioFade;
    return piece;
  });
}

interface CaptionTranscriptLike {
  durationSec?: number;
  segments?: { start: number; end: number; text?: string; words?: SubtitleWord[] }[];
}

function shrinkOverlay(c: Clip, m: ReturnType<typeof cutMapping>): Clip | undefined {
  const start = c.start;
  const end = clipEndOf(c);
  const removed = m.overlap(start, end);
  if (removed <= EPS) {
    const s = m.map(start);
    return Math.abs(s - start) <= EPS ? c : { ...c, start: s };
  }
  const dur = end - start - removed;
  if (dur < MIN_PIECE_S) return undefined;
  const speed = c.speed || 1;
  const s = m.map(start);
  const next: Clip = { ...c, start: s, out: round(c.in + dur * speed) };
  if (c.motion) {
    next.motion = { ...c.motion, durationSec: round3(dur) };
    if (c.motion.template === "animated-captions") {
      const tr = c.motion.props.transcript as CaptionTranscriptLike | undefined;
      if (tr?.segments) {
        const rel = (abs: number) => round(Math.max(0, m.map(abs) - s));
        const segments = tr.segments
          .map((seg) => {
            const a = rel(start + seg.start);
            const b = rel(start + seg.end);
            if (b - a < 0.05) return undefined;
            const words = seg.words
              ?.filter((w) => !m.inside((2 * start + w.start + w.end) / 2))
              .map((w) => ({ ...w, start: rel(start + w.start), end: rel(start + w.end) }))
              .filter((w) => w.end - w.start > 0.01);
            return { ...seg, start: a, end: b, ...(words && { words }) };
          })
          .filter((x) => x !== undefined);
        next.motion.props = {
          ...c.motion.props,
          transcript: { ...tr, durationSec: round3(dur), segments },
        };
      }
      delete next.renderedAssetId;
    }
  }
  return next;
}

function retimeSegment(
  s: SubtitleSegment,
  m: ReturnType<typeof cutMapping>,
): SubtitleSegment | undefined {
  const a = m.map(s.start);
  const b = m.map(s.end);
  if (b - a < 0.05) return undefined;
  if (!s.words) return { ...s, start: a, end: b };
  const words = s.words
    .filter((w) => !m.inside((w.start + w.end) / 2))
    .map((w) => ({ ...w, start: m.map(w.start), end: m.map(w.end) }))
    .filter((w) => w.end - w.start > 0.005);
  if (words.length === 0) return undefined;
  const text = words.length === s.words.length ? s.text : words.map((w) => w.word).join(" ");
  return { ...s, start: a, end: b, text, words };
}

/**
 * Uniform speed-up of the whole timeline (fit_duration, allow_speedup): every unlocked clip plays
 * `factor`× faster and every time is divided by it (subtitles too).
 */
export function speedUpTimeline<P extends Pick<Project, "tracks" | "subtitles">>(
  project: P,
  factor: number,
): P {
  if (!(factor > 1 + EPS)) return project;
  const f = factor;
  const tracks = project.tracks.map((t) =>
    t.locked
      ? t
      : {
          ...t,
          clips: t.clips.map((c) =>
            t.kind === "video" || t.kind === "audio"
              ? { ...c, start: round(c.start / f), speed: round3((c.speed || 1) * f) }
              : {
                  ...c,
                  start: round(c.start / f),
                  out: round(c.in + (c.out - c.in) / f),
                  ...(c.motion && {
                    motion: { ...c.motion, durationSec: round3(c.motion.durationSec / f) },
                  }),
                },
          ),
        },
  );
  const subtitles = project.subtitles.map((s) => ({
    ...s,
    start: round(s.start / f),
    end: round(s.end / f),
    ...(s.words && {
      words: s.words.map((w) => ({ ...w, start: round(w.start / f), end: round(w.end / f) })),
    }),
  }));
  return { ...project, tracks, subtitles };
}

// ------------------------------------------------------------------------------------------------
// fitDuration

interface Candidate {
  level: FitLevel;
  cut: CutWithBounds;
  saving: number;
  /** A pause can be shortened only partly to land on the target. */
  partial?: { min: number; maxEnd: number };
}

const LEVEL_LABEL: Record<FitLevel, (n: number, s: string) => string> = {
  pauses: (n, s) => `−${s} s en ${n} pausa${n === 1 ? "" : "s"}`,
  fillers_safe: (n, s) =>
    `−${s} s en ${n} muletilla${n === 1 ? "" : "s"} segura${n === 1 ? "" : "s"}`,
  fillers_other: (n, s) =>
    `−${s} s en ${n} muletilla${n === 1 ? "" : "s"} probable${n === 1 ? "" : "s"} o dudosa${n === 1 ? "" : "s"}`,
  sentences: (n, s) => `−${s} s en ${n} oraci${n === 1 ? "ón" : "ones"} (quita contenido)`,
  speed: (_n, s) => `−${s} s acelerando`,
};

/** Spanish seconds with one decimal («6,1»). */
export function fmtS(s: number): string {
  return (Math.round(s * 10) / 10).toFixed(1).replace(".", ",");
}

const CONTENT_STOPWORDS = new Set(
  (
    "el la los las un una unos unas de del a al en y o u que es son por para con sin se lo le " +
    "les me te nos mi tu su sus pero como mas ya muy bien entonces asi eso esto este esta ese " +
    "esa ahi aca alla no si tambien porque cuando donde hay"
  ).split(" "),
);
const CONTEXT_OPENERS = ["eso", "esto", "ahi", "por eso", "entonces eso"];

/** Sentences of the script (index ranges over `words`, acoustic pseudo-words included). */
export function scriptSentences(words: readonly Word[]): { i: number; j: number }[] {
  const out: { i: number; j: number }[] = [];
  let i = 0;
  for (let k = 0; k < words.length; k++) {
    const w = words[k]!;
    const next = words[k + 1];
    const end =
      !next || SENTENCE_END_RE.test(w.text) || ms(next.start - w.end) >= R.sentence_pause_ms;
    if (end) {
      out.push({ i, j: k });
      i = k + 1;
    }
  }
  return out;
}

/**
 * «Dejalo en N s» (fuentes §1.4): greedy by levels — long pauses (longest first, the last one
 * possibly only partly) → safe fillers → probable/doubtful fillers with confidence ≥ 0.6 →
 * sentences (only with `allow_sentences`) → speed-up ≤ max_speed (only with `allow_speedup`).
 * A candidate that would go below `target − tolerance` is skipped (never over-cuts); cuts always
 * fall in gaps between words. Not reaching the target returns what it got plus `question_es`.
 */
export function fitDuration(
  script: Pick<Script, "words" | "pauses"> & { stats: Pick<Script["stats"], "duration_s"> },
  reqIn: Partial<FitDurationRequest> & Pick<FitDurationRequest, "target_s">,
): FitDurationPreview {
  const req = {
    tolerance_s: R.fit_tolerance_s,
    allow_speedup: false,
    max_speed: R.fit_max_speed,
    allow_sentences: false,
    ...reqIn,
  };
  const from = script.stats.duration_s;
  const target = req.target_s;
  const tol = req.tolerance_s;
  const floor = target - tol;
  const done = (d: number) => d <= target + tol + EPS;
  const groupsOut: FitDurationPreview["groups"] = [];
  if (done(from))
    return {
      from_s: round3(from),
      to_s: round3(from),
      reached: true,
      groups: [],
      cuts: [],
      question_es: `Ya dura ${fmtS(from)} s: no hace falta cortar.`,
    };

  const cands: Candidate[] = [];
  const pauseCuts = planCutsInternal(script, { shortenLongPauses: true, avoidHarsh: true }).bounded;
  for (const c of pauseCuts.sort((a, b) => b.end - b.start - (a.end - a.start)))
    cands.push({
      level: "pauses",
      cut: c,
      saving: c.end - c.start,
      partial: { min: sec(R.min_cut_ms), maxEnd: c.end },
    });
  const runCands = (level: FitLevel, pick: (w: Word) => boolean) => {
    const ids = script.words.filter(pick).map((w) => w.id);
    if (ids.length === 0) return;
    // One candidate per run of consecutive chosen words.
    const { bounded } = planCutsInternal(script, { wordIds: ids, avoidHarsh: true });
    for (const c of bounded.sort((a, b) => b.end - b.start - (a.end - a.start)))
      cands.push({ level, cut: { ...c, reason: "filler" }, saving: c.end - c.start });
  };
  runCands("fillers_safe", (w) => w.filler?.level === "safe");
  runCands(
    "fillers_other",
    (w) => !!w.filler && w.filler.level !== "safe" && w.filler.confidence >= R.fit_min_confidence,
  );
  if (req.allow_sentences) {
    const sentences = scriptSentences(script.words);
    const scored = sentences
      .map((s, k) => ({ s, k, score: sentenceScore(script.words, s) }))
      .filter(({ k }) => k > 0 && k < sentences.length - 1)
      .filter(({ k }) => {
        const nxt = sentences[k + 1];
        if (!nxt) return true;
        const head = script.words
          .slice(nxt.i, nxt.i + 2)
          .map((w) => w.norm)
          .join(" ");
        return !CONTEXT_OPENERS.some((o) => head === o || head.startsWith(`${o} `));
      })
      .sort((a, b) => a.score - b.score);
    for (const { s } of scored) {
      const ids = script.words.slice(s.i, s.j + 1).map((w) => w.id);
      const { bounded } = planCutsInternal(script, { wordIds: ids, avoidHarsh: false });
      for (const c of bounded)
        cands.push({
          level: "sentences",
          cut: { ...c, reason: "sentence" },
          saving: c.end - c.start,
        });
    }
  }

  const chosen: Candidate[] = [];
  const unionLen = (list: readonly CutWithBounds[]) =>
    mergeCutRanges(list).reduce((s, r) => s + (r.end - r.start), 0);
  let current = from;
  for (const c of cands) {
    if (done(current)) break;
    const before = unionLen(chosen.map((x) => x.cut));
    const gain = unionLen([...chosen.map((x) => x.cut), c.cut]) - before;
    if (gain <= EPS) continue;
    if (current - gain >= floor - EPS) {
      chosen.push(c);
      current -= gain;
      continue;
    }
    if (c.partial) {
      const need = current - target;
      if (need >= c.partial.min - EPS) {
        const end = round(c.cut.start + need);
        const part = { ...c, cut: { ...c.cut, end }, saving: need };
        const g = unionLen([...chosen.map((x) => x.cut), part.cut]) - before;
        if (g > EPS && current - g >= floor - EPS) {
          chosen.push(part);
          current -= g;
        }
      }
    }
  }

  let speed: number | undefined;
  if (!done(current) && req.allow_speedup) {
    const want = current / target;
    speed = round3(Math.min(req.max_speed, Math.max(1, want)));
    if (speed <= 1 + EPS) speed = undefined;
  }
  const afterCuts = current;
  if (speed) current = current / speed;

  const levels: FitLevel[] = ["pauses", "fillers_safe", "fillers_other", "sentences"];
  for (const level of levels) {
    const list = chosen.filter((c) => c.level === level);
    if (list.length === 0) continue;
    const removed = list.reduce((s, c) => s + (c.cut.end - c.cut.start), 0);
    groupsOut.push({
      level,
      removed_s: round3(removed),
      count: list.length,
      label_es: LEVEL_LABEL[level](list.length, fmtS(removed)),
    });
  }
  if (speed) {
    const removed = afterCuts - current;
    groupsOut.push({
      level: "speed",
      removed_s: round3(removed),
      count: 1,
      label_es: `${LEVEL_LABEL.speed(1, fmtS(removed))} ${String(speed).replace(".", ",")}×`,
    });
  }
  const merged = mergeBounded(chosen.map((c) => c.cut));
  const cuts: ScriptCut[] = merged.map(({ lo: _l, hi: _h, ...c }) => c);
  const reached = done(current);
  const to = round3(current);
  let question_es: string | undefined;
  if (!reached) {
    const opts = [
      !req.allow_speedup && `acelero hasta ${String(req.max_speed).replace(".", ",")}×`,
      !req.allow_sentences && "quito oraciones enteras",
    ].filter(Boolean);
    question_es =
      opts.length > 0
        ? `Llego a ${fmtS(to)} s sin tocar contenido; ¿${opts.join(" o ")}?`
        : `Llego a ${fmtS(to)} s como mucho; para ${fmtS(target)} s hay que recortar a mano.`;
  }
  const preview: FitDurationPreview = {
    from_s: round3(from),
    to_s: to,
    reached,
    groups: groupsOut,
    cuts,
    ...(speed && { speed }),
    ...(question_es && { question_es }),
  };
  const plan = fitPlan(preview, req);
  if (plan) preview.plan = plan;
  return preview;
}

function sentenceScore(words: readonly Word[], s: { i: number; j: number }): number {
  const list = words.slice(s.i, s.j + 1).filter((w) => !isAcoustic(w));
  if (list.length === 0) return 0;
  const content = list.filter((w) => w.norm.length > 3 && !CONTENT_STOPWORDS.has(w.norm)).length;
  const density = content / list.length;
  const fillers = list.filter((w) => w.filler).length / list.length;
  // 0.35·density + 0.25·position (ends are excluded before) + 0.2·energy + 0.2·face (unknown = 0.5).
  return 0.35 * density + 0.25 * 0.5 + 0.2 * 0.5 + 0.2 * 0.5 - 0.2 * fillers;
}

/** EditPlan for a fit preview (null when nothing to do). */
export function fitPlan(
  preview: Pick<FitDurationPreview, "cuts" | "from_s" | "to_s" | "groups" | "speed" | "reached">,
  req: Partial<FitDurationRequest> & Pick<FitDurationRequest, "target_s">,
): EditPlan | undefined {
  const summary = `${fmtS(preview.from_s)} s → ${fmtS(preview.to_s)} s: ${
    preview.groups.map((g) => g.label_es).join(", ") || "sin cambios"
  }`.slice(0, 500);
  if (preview.speed) {
    const op: EditOp = {
      op: "fit_duration",
      target_s: req.target_s,
      ...(req.tolerance_s !== undefined && { tolerance_s: req.tolerance_s }),
      allow_speedup: true,
      ...(req.allow_sentences && { allow_sentences: true, confirm: true }),
    };
    return { version: 1, summary_es: summary, ops: [op] };
  }
  return deleteRangesPlan(
    preview.cuts,
    summary,
    preview.groups.some((g) => g.level === "sentences"),
  );
}

/** `delete_words {ranges}` ops (≤ 200 ranges each) for a list of cuts. */
export function deleteRangesPlan(
  cuts: readonly CutRange[],
  summary_es: string,
  confirm = false,
): EditPlan | undefined {
  if (cuts.length === 0) return undefined;
  const ops: EditOp[] = [];
  // Chunks of 200 from the END of the timeline backwards: applying a later chunk first never moves
  // the ranges of the chunks before it.
  const sorted = [...cuts].sort((a, b) => a.start - b.start);
  for (let hi = sorted.length; hi > 0 && ops.length < 20; hi -= 200)
    ops.push({
      op: "delete_words",
      ranges: sorted
        .slice(Math.max(0, hi - 200), hi)
        .map((c) => ({ start: round3(c.start), end: round3(c.end) })),
      ...(confirm && { confirm: true }),
    });
  return { version: 1, summary_es: summary_es.slice(0, 500), ops };
}

// ------------------------------------------------------------------------------------------------
// fixWords

function spreadByLetters(tokens: readonly string[], a: number, b: number): SubtitleWord[] {
  const min = sec(R.corrected_min_word_ms);
  const span = Math.max(0, b - a);
  const letters = tokens.map((t) => Math.max(1, normWord(t).length || t.length));
  const total = letters.reduce((s, x) => s + x, 0);
  const even = span < min * tokens.length;
  let at = a;
  // Proportional with a floor of 80 ms each (when the span allows it).
  const raw = letters.map((l) => (even ? span / tokens.length : (span * l) / total));
  if (!even) {
    let short = 0;
    let longTotal = 0;
    raw.forEach((d) => {
      if (d < min) short += min - d;
      else longTotal += d;
    });
    for (let k = 0; k < raw.length; k++) {
      if (raw[k]! < min) raw[k] = min;
      else raw[k] = raw[k]! - (short * raw[k]!) / Math.max(EPS, longTotal);
    }
  }
  return tokens.map((t, k) => {
    const start = at;
    const end = k === tokens.length - 1 ? b : Math.min(b, at + raw[k]!);
    at = end;
    return { word: t, start: round3(start), end: round3(Math.max(start, end)) };
  });
}

export type WordOpcode = {
  tag: "equal" | "replace" | "insert" | "delete";
  i1: number;
  i2: number;
  j1: number;
  j2: number;
};

/** Word-level opcodes (like difflib.SequenceMatcher.get_opcodes) from an LCS over `norm` keys. */
export function wordOpcodes(a: readonly string[], b: readonly string[]): WordOpcode[] {
  const n = a.length;
  const m = b.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i]![j] = a[i] === b[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (L[i + 1]![j]! >= L[i]![j + 1]!) i++;
    else j++;
  }
  const ops: WordOpcode[] = [];
  let pi = 0;
  let pj = 0;
  const flush = (ei: number, ej: number) => {
    if (ei > pi && ej > pj) ops.push({ tag: "replace", i1: pi, i2: ei, j1: pj, j2: ej });
    else if (ei > pi) ops.push({ tag: "delete", i1: pi, i2: ei, j1: pj, j2: pj });
    else if (ej > pj) ops.push({ tag: "insert", i1: pi, i2: pi, j1: pj, j2: ej });
  };
  for (const [x, y] of pairs) {
    flush(x, y);
    const last = ops[ops.length - 1];
    if (last?.tag === "equal" && last.i2 === x && last.j2 === y) {
      last.i2++;
      last.j2++;
    } else ops.push({ tag: "equal", i1: x, i2: x + 1, j1: y, j2: y + 1 });
    pi = x + 1;
    pj = y + 1;
  }
  flush(n, m);
  return ops;
}

/**
 * Text correction keeping timings (fuentes §1.6): `equal` keeps start/end/probability (new
 * spelling), `replace` spreads the old interval over the new words by letters (≥ 80 ms each),
 * `insert` takes ≤ 60 % of the gap between its neighbours (zero length glued to the neighbour when
 * there is none), `delete` drops the word and leaves its time as a gap (no cut). Touched words get
 * `corrected: true`. `oldText` is only used when `words` is empty (nothing to keep).
 */
export function fixWords(
  words: readonly SubtitleWord[],
  oldText: string,
  newText: string,
): SubtitleWord[] {
  const tokens = newText.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    void oldText;
    return [];
  }
  const a = words.map((w) => normWord(w.word));
  const b = tokens.map((t) => normWord(t));
  const out: SubtitleWord[] = [];
  for (const op of wordOpcodes(a, b)) {
    if (op.tag === "equal") {
      for (let k = 0; k < op.i2 - op.i1; k++) {
        const w = words[op.i1 + k]!;
        out.push({ ...w, word: tokens[op.j1 + k]! });
      }
    } else if (op.tag === "replace") {
      const s = words[op.i1]!.start;
      const e = words[op.i2 - 1]!.end;
      for (const w of spreadByLetters(tokens.slice(op.j1, op.j2), s, e))
        out.push({ ...w, corrected: true });
    } else if (op.tag === "insert") {
      const prev = words[op.i1 - 1];
      const next = words[op.i1];
      const list = tokens.slice(op.j1, op.j2);
      if (prev && next && next.start - prev.end > EPS) {
        const gap = next.start - prev.end;
        const span = gap * R.insert_max_gap_ratio;
        const s = prev.end + (gap - span) / 2;
        for (const w of spreadByLetters(list, s, s + span)) out.push({ ...w, corrected: true });
      } else {
        const at = prev ? prev.end : (next?.start ?? 0);
        for (const t of list) out.push({ word: t, start: at, end: at, corrected: true });
      }
    }
    // delete: dropped; its time stays as a gap.
  }
  return out;
}

/**
 * Apply a correction to a segment: new text + `fixWords` words (segment start/end unchanged).
 */
export function fixSegmentText(seg: SubtitleSegment, newText: string): SubtitleSegment {
  const text = newText;
  if (!seg.words?.length) return { ...seg, text };
  return { ...seg, text, words: fixWords(seg.words, seg.text, newText) };
}

// ------------------------------------------------------------------------------------------------
// helpers for fix_text / delete_words {text}

/** Word ids whose normalized sequence matches `phrase` (all occurrences, no accents/case). */
export function findPhrase(words: readonly Word[], phrase: string): string[][] {
  const key = normWord(phrase).split(" ").filter(Boolean);
  if (key.length === 0) return [];
  const real = words.filter((w) => !isAcoustic(w));
  const hits: string[][] = [];
  for (let i = 0; i + key.length <= real.length; i++) {
    let ok = true;
    for (let k = 0; k < key.length && ok; k++) ok = real[i + k]!.norm === key[k];
    if (ok) {
      hits.push(real.slice(i, i + key.length).map((w) => w.id));
      i += key.length - 1;
    }
  }
  return hits;
}

/** Subtitles with `wordIds` corrected to `replacement` (one gesture; ids from buildScript). */
export function replaceWordsText(
  subtitles: readonly SubtitleSegment[],
  wordIds: readonly string[],
  replacement: string,
): SubtitleSegment[] {
  const bySeg = new Map<number, number[]>();
  for (const id of wordIds) {
    const [s, w] = id.split(":").map(Number) as [number, number];
    if (w >= ACOUSTIC_WORD_BASE) continue;
    bySeg.set(s, [...(bySeg.get(s) ?? []), w]);
  }
  const segs = [...bySeg.keys()].sort((x, y) => x - y);
  return subtitles.map((seg, si) => {
    const idx = bySeg.get(si);
    if (!idx) return seg;
    const words = segmentWords(seg);
    const lo = Math.min(...idx);
    const hi = Math.max(...idx);
    // The replacement goes in the first touched segment; the others lose their words.
    const insert = si === segs[0] ? replacement : "";
    const tokens = [
      ...words.slice(0, lo).map((w) => w.word),
      ...insert.split(/\s+/).filter(Boolean),
      ...words.slice(hi + 1).map((w) => w.word),
    ];
    const text = tokens.join(" ");
    return seg.words?.length
      ? { ...seg, text, words: fixWords(seg.words, seg.text, text) }
      : { ...seg, text };
  });
}

/** Map source-time gaps of a clip's asset to timeline gaps through the clips that show it. */
export function gapsToTimeline(
  gaps: readonly ScriptAudioGap[],
  clips: readonly Pick<Clip, "start" | "in" | "out" | "speed" | "assetId">[],
  assetId: string,
): ScriptAudioGap[] {
  const out: ScriptAudioGap[] = [];
  const own = clips.filter((c) => c.assetId === assetId);
  for (const g of gaps)
    for (const c of own) {
      const a = Math.max(g.start, c.in);
      const b = Math.min(g.end, c.out);
      if (b - a <= EPS) continue;
      const speed = c.speed || 1;
      out.push({
        ...g,
        start: round(c.start + (a - c.in) / speed),
        end: round(c.start + (b - c.in) / speed),
      });
    }
  return out.sort((x, y) => x.start - y.start);
}

/** Timeline time -> source time of `assetId` (undefined when no clip of it is there). */
export function timelineToSource(
  t: number,
  clips: readonly Pick<Clip, "start" | "in" | "out" | "speed" | "assetId">[],
  assetId: string,
): number | undefined {
  for (const c of clips) {
    if (c.assetId !== assetId) continue;
    const end = clipEndOf(c);
    if (t >= c.start - EPS && t <= end + EPS) return c.in + (t - c.start) * (c.speed || 1);
  }
  return undefined;
}

/**
 * Heuristic «stale» (subtitles no longer match the timeline): more than 10 % of the words are not
 * over any media clip, or the last word ends after the end of the timeline.
 */
export function scriptIsStale(project: Pick<Project, "tracks" | "subtitles">): boolean {
  const media = project.tracks
    .filter((t) => t.kind === "video" || t.kind === "audio")
    .flatMap((t) => t.clips.filter((c) => c.assetId));
  const words = project.subtitles.flatMap((s) => s.words ?? []);
  if (words.length === 0) return false;
  const dur = timelineDuration(project);
  if (words[words.length - 1]!.end > dur + 0.5) return true;
  const outside = words.filter((w) => {
    const mid = (w.start + w.end) / 2;
    return !media.some((c) => mid >= c.start - EPS && mid <= clipEndOf(c) + EPS);
  }).length;
  return outside > words.length * 0.1;
}

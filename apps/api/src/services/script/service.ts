import { readFileSync, statSync } from "node:fs";
import {
  buildScript,
  fitDuration,
  fitPlan,
  fmtS,
  SCRIPT_RULES,
  formatErrorEs,
  gapsToTimeline,
  planCutsInternal,
  refineCutsWithEnergy,
  scriptIsStale,
  ScriptAudioSchema,
  timelineToSource,
  type Clip,
  type FitDurationPreview,
  type FitDurationRequest,
  type Project,
  type Script,
  type ScriptAudio,
  type ScriptAudioGap,
  type ScriptBuildAudio,
  type ScriptCutsRequest,
  type ScriptCutsResponse,
} from "@studio/shared";
import type { Db } from "../../db/database.js";
import { HttpError } from "../../lib/errors.js";
import { resolveStoragePath } from "../storage.js";
import { listScriptAudio, type ScriptAudioRow } from "./store.js";

/**
 * Sprint 6 M1: the Guion services shared by routes/script.ts, the agent ops (resolve.ts /
 * handlers/agent.ts) and the job script.transcribe. The Script is always computed from the
 * project (`buildScript`); the audio artifacts (gaps + RMS envelope, SOURCE seconds of each asset)
 * are mapped to the timeline through the clips that show that asset.
 */

export interface ScriptDeps {
  db: Db;
  storageDir: string;
}

const WINDOW_S = 0.005;

interface Artifact {
  audio: ScriptAudio;
  rms?: Float32Array;
}

const cache = new Map<string, { mtimeMs: number; value: Artifact | undefined }>();

function readArtifact(storageDir: string, rel: string): Artifact | undefined {
  let abs: string;
  try {
    abs = resolveStoragePath(storageDir, rel);
  } catch {
    return undefined;
  }
  let mtimeMs: number;
  try {
    mtimeMs = statSync(abs).mtimeMs;
  } catch {
    return undefined;
  }
  const hit = cache.get(abs);
  if (hit && hit.mtimeMs === mtimeMs) return hit.value;
  let value: Artifact | undefined;
  try {
    const audio = ScriptAudioSchema.parse(JSON.parse(readFileSync(abs, "utf8")));
    let rms: Float32Array | undefined;
    try {
      const buf = readFileSync(resolveStoragePath(storageDir, audio.rms_db_path));
      rms = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    } catch {
      rms = undefined; // no envelope: no energy refinement
    }
    value = { audio, ...(rms && { rms }) };
  } catch {
    value = undefined;
  }
  cache.set(abs, { mtimeMs, value });
  if (cache.size > 32) cache.delete(cache.keys().next().value!);
  return value;
}

const mediaClips = (project: Pick<Project, "tracks">): Clip[] =>
  project.tracks
    .filter((t) => t.kind === "video" || t.kind === "audio")
    .flatMap((t) => t.clips.filter((c) => c.assetId));

interface Loaded {
  row: ScriptAudioRow;
  artifact: Artifact;
}

function loadArtifacts(deps: ScriptDeps, project: Project): Loaded[] {
  const used = new Set(mediaClips(project).map((c) => c.assetId!));
  return listScriptAudio(deps.db, project.id)
    .filter((r) => used.has(r.asset_id))
    .map((row) => ({ row, artifact: readArtifact(deps.storageDir, row.path) }))
    .filter((x): x is Loaded => x.artifact !== undefined);
}

/** Acoustic gaps of every transcribed asset of the project, in timeline seconds. */
export function scriptAudioFor(deps: ScriptDeps, project: Project): ScriptBuildAudio | undefined {
  const list = loadArtifacts(deps, project);
  if (list.length === 0) return undefined;
  const clips = mediaClips(project);
  const gaps: ScriptAudioGap[] = list.flatMap(({ row, artifact }) =>
    gapsToTimeline(artifact.audio.gaps, clips, row.asset_id),
  );
  const latest = list[0]!;
  return {
    jobId: latest.row.job_id,
    noise_floor_db: latest.artifact.audio.noise_floor_db,
    gaps: gaps.sort((a, b) => a.start - b.start),
  };
}

/** RMS dB at a timeline time (undefined: no envelope there). */
export function energyLookup(
  deps: ScriptDeps,
  project: Project,
): ((t: number) => number | undefined) | undefined {
  const list = loadArtifacts(deps, project).filter((x) => x.artifact.rms);
  if (list.length === 0) return undefined;
  const clips = mediaClips(project);
  return (t: number) => {
    for (const { row, artifact } of list) {
      const src = timelineToSource(t, clips, row.asset_id);
      if (src === undefined) continue;
      const i = Math.floor(src / WINDOW_S);
      const v = artifact.rms![i];
      if (v !== undefined && Number.isFinite(v)) return v;
    }
    return undefined;
  };
}

export function getScript(deps: ScriptDeps, project: Project): Script {
  return buildScript(project, scriptAudioFor(deps, project), {
    stale: scriptIsStale(project),
  });
}

export function scriptError(
  code: "SCRIPT_EMPTY" | "SCRIPT_STALE" | "SCRIPT_NOTHING_TO_CUT",
  details?: unknown,
) {
  const status = code === "SCRIPT_NOTHING_TO_CUT" ? 422 : 409;
  return new HttpError(status, code, formatErrorEs(code), details);
}

/** Script ready to cut: SCRIPT_EMPTY without words, SCRIPT_STALE when it no longer fits. */
export function requireScript(deps: ScriptDeps, project: Project): Script {
  const script = getScript(deps, project);
  if (script.words.length === 0) throw scriptError("SCRIPT_EMPTY");
  if (script.stale) throw scriptError("SCRIPT_STALE");
  return script;
}

/** POST …/script/cuts: planWordCuts + energy refinement (does not apply). */
export function computeCuts(
  deps: ScriptDeps,
  project: Project,
  req: ScriptCutsRequest,
  opts: { allowEmpty?: boolean } = {},
): ScriptCutsResponse {
  const script = requireScript(deps, project);
  const { response, bounded } = planCutsInternal(script, req);
  const energy = energyLookup(deps, project);
  const cuts = energy ? refineCutsWithEnergy(bounded, energy) : response.cuts;
  const removed_s = Math.round(cuts.reduce((s, c) => s + (c.end - c.start), 0) * 1000) / 1000;
  if (cuts.length === 0 && !opts.allowEmpty)
    throw scriptError("SCRIPT_NOTHING_TO_CUT", { skipped: response.skipped });
  return { cuts, removed_s, skipped: response.skipped };
}

/**
 * The cuts a fit preview really makes once applied: its ranges go through the same path as
 * `delete_words {ranges}` (word runs at the gap middle + energy refinement). Integration S6: the
 * preview used to skip the refinement and differed ~0,2 s from the apply.
 */
export function refinedFitCuts(
  deps: ScriptDeps,
  project: Project,
  cuts: readonly { start: number; end: number }[],
): ScriptCutsResponse | undefined {
  if (cuts.length === 0 || !energyLookup(deps, project)) return undefined;
  return computeCuts(
    deps,
    project,
    { ranges: cuts.map(({ start, end }) => ({ start, end })), avoidHarsh: true },
    { allowEmpty: true },
  );
}

/** POST …/script/fit: fitDuration preview + plan (does not apply); `to_s` as the apply gives. */
export function computeFit(
  deps: ScriptDeps,
  project: Project,
  req: Partial<FitDurationRequest> & Pick<FitDurationRequest, "target_s">,
): FitDurationPreview {
  const script = requireScript(deps, project);
  const first = fitDuration(script, req);
  if (first.speed) return first; // re-planned at apply time (fit_duration op)
  const refine = (p: FitDurationPreview) => {
    const r = refinedFitCuts(deps, project, p.cuts);
    return r ? Math.round((p.from_s - r.removed_s) * 1000) / 1000 : p.to_s;
  };
  let preview = first;
  let to_s = refine(first);
  if (to_s === first.to_s) return first;
  // The energy refinement moves the edges a few ms inwards: when that leaves the result above
  // the tolerance, plan once more for the missing seconds (never below target − tolerance).
  const tol = req.tolerance_s ?? SCRIPT_RULES.fit_tolerance_s;
  const deficit = to_s - first.to_s;
  if (to_s > req.target_s + tol + 1e-6 && deficit > 0) {
    const again = fitDuration(script, { ...req, target_s: req.target_s - deficit });
    const againTo = again.speed ? to_s : refine(again);
    if (!again.speed && Math.abs(againTo - req.target_s) < Math.abs(to_s - req.target_s)) {
      preview = again;
      to_s = againTo;
    }
  }
  // `cuts` (and the plan ranges) stay the unrefined ones: the apply refines them once.
  const reached = to_s <= req.target_s + tol + 1e-6;
  const next: FitDurationPreview = { ...preview, to_s, reached };
  if (reached) delete next.question_es;
  else next.question_es ??= `Llego a ${fmtS(to_s)} s sin tocar contenido.`;
  const plan = fitPlan(next, { ...req });
  return { ...next, ...(plan && { plan }) };
}

import type { AgentProjectSummary, Clip, MediaAsset, Project } from "@studio/shared";

/**
 * Sprint 3: compact, deterministic project summary sent to the local LLM as `project_summary`
 * (docs/trabajo/sprint3-contratos.md: ≤ ~1500 tokens). Same JSON shape as the dataset rows
 * (AgentProjectSummary: canvas, cursor_s, tracks with clips {id, name, start, end}, scenes, assets,
 * first transcript lines); the workers render it as prompt text (`summary.as_text`). Same input →
 * same JSON (tracks in project order, clips by start then id, assets used first then by name).
 */

export const SUMMARY_MAX_CHARS = 6000; // ≈ 1500 tokens (≈ 4 chars/token)
const MAX_CLIPS_PER_TRACK = 20;
const MAX_ASSETS = 12;
const MAX_SCENES = 30;
const MAX_TRANSCRIPT_LINES = 10;
const MAX_LABEL = 48;

export type MediaLookup = (id: string) => MediaAsset | undefined;

export const round3 = (t: number) => Math.round(t * 1000) / 1000;
export const clipDuration = (c: Pick<Clip, "in" | "out" | "speed">) =>
  Math.max(0, (c.out - c.in) / (c.speed || 1));
export const clipEnd = (c: Pick<Clip, "start" | "in" | "out" | "speed">) =>
  c.start + clipDuration(c);

/** Seconds with one decimal and no trailing ".0" noise in the summary ("12.5", "3"). */
export const sec = (t: number) => String(Math.round(t * 10) / 10);

/** Spanish display of seconds for previews: "12,5 s". */
export const fmtSec = (t: number) => `${(Math.round(t * 10) / 10).toString().replace(".", ",")} s`;

export function projectDuration(project: Pick<Project, "tracks">): number {
  let end = 0;
  for (const t of project.tracks) for (const c of t.clips) end = Math.max(end, clipEnd(c));
  return round3(end);
}

const clean = (s: string, max = MAX_LABEL) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** Human label of a clip: asset name, text content or motion template (+ title prop). */
export function clipLabel(clip: Clip, media: MediaLookup): string {
  if (clip.text !== undefined) return clean(clip.text) || "texto";
  if (clip.motion) {
    const p = clip.motion.props as Record<string, unknown>;
    const title = [p.title, p.text, p.name].find((v) => typeof v === "string" && v.trim());
    return clean(`${clip.motion.template}${title ? `: ${String(title)}` : ""}`);
  }
  const asset = clip.assetId ? media(clip.assetId) : undefined;
  return clean(asset?.name ?? clip.assetId ?? "clip");
}

/** Short track codes in project order: V1, V2, A1, T1, M1. */
export function trackCodes(project: Pick<Project, "tracks">): Map<string, string> {
  const letter = { video: "V", audio: "A", text: "T", motion: "M" } as const;
  const counts: Record<string, number> = {};
  const out = new Map<string, string>();
  for (const t of project.tracks) {
    counts[t.kind] = (counts[t.kind] ?? 0) + 1;
    out.set(t.id, `${letter[t.kind]}${counts[t.kind]}`);
  }
  return out;
}

export const sortClips = (clips: readonly Clip[]) =>
  [...clips].sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/**
 * Scene starts on the TIMELINE (sorted, deduplicated): every analyzed scene start of the assets
 * shown by visible video clips, mapped through the clip's in/out/speed, plus the start of every
 * video clip (a cut). Empty while no asset was analyzed (analyze.scenes). Scene 1 = first entry.
 */
export function timelineScenes(project: Pick<Project, "tracks">, media: MediaLookup): number[] {
  const out = new Set<number>();
  const starts: number[] = [];
  for (const track of project.tracks) {
    if (track.kind !== "video" || track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.assetId) starts.push(round3(clip.start));
      const scenes = clip.assetId ? media(clip.assetId)?.scenes : undefined;
      if (!scenes?.length) continue;
      const speed = clip.speed || 1;
      for (const s of scenes) {
        if (s.start < clip.in - 1e-3 || s.start >= clip.out - 1e-3) continue;
        out.add(round3(clip.start + (s.start - clip.in) / speed));
      }
    }
  }
  // Once something was analyzed, every cut between video clips is a scene boundary too.
  if (out.size > 0) for (const s of starts) out.add(s);
  return [...out].sort((a, b) => a - b);
}

const r2 = (t: number) => Math.round(t * 100) / 100;

export interface SummaryOptions {
  /** Playhead in seconds (Time "cursor"; 0 when unknown). */
  cursor?: number;
  /** Assets of the library to list (default: the ones used by the project). */
  assets?: readonly MediaAsset[];
  /** Budget of the serialized JSON (default SUMMARY_MAX_CHARS ≈ 1500 tokens). */
  maxChars?: number;
}

/** Size the workers paste in the prompt (summary.as_text = compact JSON). */
export const summaryChars = (s: AgentProjectSummary) => JSON.stringify(s).length;

/**
 * Build the compact summary (see module doc) in the dataset's JSON shape. Over budget, it trims in
 * this order: transcript lines, unused assets, all assets, scenes, then the last clips of the
 * longest tracks (clips are what the model needs most to reference things).
 */
export function buildProjectSummary(
  project: Project,
  media: MediaLookup,
  opts: SummaryOptions = {},
): AgentProjectSummary {
  const { width, height, fps } = project.settings;
  const max = opts.maxChars ?? SUMMARY_MAX_CHARS;
  const tracks = project.tracks.map((t) => ({
    kind: t.kind,
    clips: sortClips(t.clips)
      .slice(0, MAX_CLIPS_PER_TRACK)
      .map((c) => ({
        id: c.id,
        name: clipLabel(c, media),
        start: r2(c.start),
        end: r2(clipEnd(c)),
      })),
  }));

  const scenes = timelineScenes(project, media)
    .slice(0, MAX_SCENES)
    .map((start, i) => ({ n: i + 1, start: r2(start) }));

  const used = new Set(project.tracks.flatMap((t) => t.clips.map((c) => c.assetId ?? "")));
  const pool = (opts.assets ?? [...used].map((id) => (id ? media(id) : undefined)))
    .filter((a): a is MediaAsset => !!a && ["video", "audio", "image"].includes(a.kind))
    .sort(
      (a, b) =>
        Number(used.has(b.id)) - Number(used.has(a.id)) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1),
    )
    .slice(0, MAX_ASSETS);
  let assets = pool.map((a) => ({ id: a.id, name: clean(a.name, 60), kind: a.kind }));

  let transcript = [...project.subtitles]
    .sort((a, b) => a.start - b.start)
    .slice(0, MAX_TRANSCRIPT_LINES)
    .map((s) => ({ start: r2(s.start), end: r2(s.end), text: clean(s.text, 90) }));

  let sceneList = scenes;
  const build = (): AgentProjectSummary => ({
    canvas: { w: width, h: height, fps },
    cursor_s: r2(opts.cursor ?? 0),
    tracks,
    ...(sceneList.length && { scenes: sceneList }),
    ...(assets.length && { assets }),
    ...(transcript.length && { transcript_excerpt: transcript }),
  });

  let out = build();
  while (summaryChars(out) > max && transcript.length) {
    transcript = transcript.slice(0, -1);
    out = build();
  }
  while (summaryChars(out) > max && assets.length) {
    const unused = assets.findLastIndex((a) => !used.has(a.id));
    assets = assets.filter((_, i) => i !== (unused >= 0 ? unused : assets.length - 1));
    out = build();
  }
  if (summaryChars(out) > max) {
    sceneList = sceneList.slice(0, 5);
    out = build();
  }
  while (summaryChars(out) > max) {
    const longest = tracks.reduce((a, b) => (b.clips.length > a.clips.length ? b : a));
    if (longest.clips.length <= 1) break;
    longest.clips = longest.clips.slice(0, -1);
    out = build();
  }
  return out;
}

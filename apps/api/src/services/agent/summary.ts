import type { Clip, MediaAsset, Project, Track } from "@studio/shared";

/**
 * Sprint 3: compact, deterministic project summary sent to the local LLM as `project_summary`
 * (docs/trabajo/sprint3-contratos.md: ≤ ~1500 tokens — canvas, tracks, clips with id/name/duration,
 * scenes, assets, first 10 transcript lines, cursor). Plain text lines in Spanish; same input →
 * same text (tracks in project order, clips by start then id, assets by name then id).
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

function aspectLabel(w: number, h: number): string {
  const r = w / h;
  const known: [string, number][] = [
    ["16:9", 16 / 9],
    ["9:16", 9 / 16],
    ["1:1", 1],
    ["4:5", 4 / 5],
    ["4:3", 4 / 3],
  ];
  const hit = known.find(([, v]) => Math.abs(v - r) < 0.01);
  return hit ? hit[0] : `${w}:${h}`;
}

function clipLine(clip: Clip, index: number, media: MediaLookup): string {
  const parts = [
    `${index}. id=${clip.id}`,
    `"${clipLabel(clip, media)}"`,
    `${sec(clip.start)}-${sec(clipEnd(clip))}s (${sec(clipDuration(clip))}s)`,
  ];
  if ((clip.speed || 1) !== 1) parts.push(`x${clip.speed}`);
  if (clip.volume === 0) parts.push("mudo");
  if (clip.matte) parts.push("fondo-quitado");
  if (clip.trackRef) parts.push("sigue-objeto");
  if (clip.voiceEffects?.length) parts.push(`efectos:${clip.voiceEffects.map((e) => e.type)}`);
  if (clip.motion && !clip.renderedAssetId) parts.push("sin-render");
  return `  ${parts.join(" ")}`;
}

function trackBlock(track: Track, code: string, media: MediaLookup): string[] {
  const flags = [track.muted && "silenciada", track.locked && "bloqueada", track.hidden && "oculta"]
    .filter(Boolean)
    .join(",");
  const clips = sortClips(track.clips);
  const head = `- ${code} ${track.kind} "${clean(track.name, 30)}"${flags ? ` [${flags}]` : ""}: ${
    clips.length
  } clip${clips.length === 1 ? "" : "s"}`;
  const lines = [head];
  clips.slice(0, MAX_CLIPS_PER_TRACK).forEach((c, i) => lines.push(clipLine(c, i + 1, media)));
  if (clips.length > MAX_CLIPS_PER_TRACK)
    lines.push(`  … y ${clips.length - MAX_CLIPS_PER_TRACK} clips más`);
  return lines;
}

export interface SummaryOptions {
  /** Playhead in seconds (Time "cursor"). */
  cursor?: number;
  /** Assets of the library to list (default: the ones used by the project). */
  assets?: readonly MediaAsset[];
  maxChars?: number;
}

/** Build the compact summary (see module doc). */
export function buildProjectSummary(
  project: Project,
  media: MediaLookup,
  opts: SummaryOptions = {},
): string {
  const { width, height, fps } = project.settings;
  const lines: string[] = [];
  lines.push(
    `PROYECTO "${clean(project.name, 60)}" · lienzo ${width}x${height} (${aspectLabel(width, height)}) · ${fps} fps · duración ${sec(projectDuration(project))}s · cursor ${
      opts.cursor !== undefined ? `${sec(opts.cursor)}s` : "desconocido"
    }`,
  );
  const codes = trackCodes(project);
  lines.push("PISTAS (clips por orden de inicio; tiempos en segundos de la línea de tiempo):");
  for (const t of project.tracks) lines.push(...trackBlock(t, codes.get(t.id)!, media));

  const scenes = timelineScenes(project, media);
  lines.push(
    scenes.length
      ? `ESCENAS: ${scenes
          .slice(0, MAX_SCENES)
          .map((s, i) => `${i + 1}@${sec(s)}`)
          .join(" ")}${scenes.length > MAX_SCENES ? ` … (${scenes.length})` : ""}`
      : "ESCENAS: sin detectar",
  );

  const used = new Set(project.tracks.flatMap((t) => t.clips.map((c) => c.assetId ?? "")));
  const pool = (opts.assets ?? [...used].map((id) => (id ? media(id) : undefined)))
    .filter((a): a is MediaAsset => !!a && ["video", "audio", "image"].includes(a.kind))
    .sort(
      (a, b) =>
        Number(used.has(b.id)) - Number(used.has(a.id)) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1),
    );
  lines.push(
    pool.length
      ? `ARCHIVOS: ${pool
          .slice(0, MAX_ASSETS)
          .map(
            (a) =>
              `${a.kind} "${clean(a.name, 40)}" id=${a.id}${a.durationSec ? ` ${sec(a.durationSec)}s` : ""}${
                used.has(a.id) ? "" : " (sin usar)"
              }`,
          )
          .join(" · ")}${pool.length > MAX_ASSETS ? ` … (${pool.length})` : ""}`
      : "ARCHIVOS: ninguno",
  );

  const subs = [...project.subtitles].sort((a, b) => a.start - b.start);
  if (subs.length) {
    lines.push(`TRANSCRIPCIÓN (${subs.length} segmentos; primeras ${MAX_TRANSCRIPT_LINES}):`);
    for (const s of subs.slice(0, MAX_TRANSCRIPT_LINES))
      lines.push(`  [${sec(s.start)}-${sec(s.end)}] ${clean(s.text, 90)}`);
  } else lines.push("TRANSCRIPCIÓN: no hay");

  const pub = project.publish;
  lines.push(
    `ESTADO: subtítulos-quemados=${project.burnSubtitles ?? "auto"} · reencuadre=${
      project.reframe ? project.reframe.target : "no"
    } · para-redes=${pub?.forSocial ? "sí" : "no"} · etiqueta-IA=${pub?.aiLabel ? "sí" : "no"}`,
  );

  let text = lines.join("\n");
  const max = opts.maxChars ?? SUMMARY_MAX_CHARS;
  if (text.length > max) text = `${text.slice(0, max - 20).trimEnd()}\n… (resumen recortado)`;
  return text;
}

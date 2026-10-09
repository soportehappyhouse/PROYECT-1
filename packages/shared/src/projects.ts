import type { MediaAsset } from "./media.js";
import type { ProjectSummary } from "./api.js";
import type { Project } from "./timeline.js";

/**
 * Sprint 5 (M2): project list helpers shared by the api (GET /api/projects?view=summary) and the
 * web (ProjectsMenu, automatic name on the first imported video).
 */

/** Name given to new projects by the web and the api. */
export const UNTITLED_PROJECT_NAME = "Proyecto sin título";

/** Max length of a project name (ProjectPatchSchema). */
export const PROJECT_NAME_MAX = 120;

type AssetLike = Pick<MediaAsset, "id"> & Partial<Pick<MediaAsset, "thumbnailPath" | "kind">>;
type AssetLookup = readonly AssetLike[] | ((id: string) => AssetLike | undefined);

function lookup(assets: AssetLookup): (id: string) => AssetLike | undefined {
  if (typeof assets === "function") return assets;
  const byId = new Map(assets.map((a) => [a.id, a]));
  return (id) => byId.get(id);
}

/** End of a clip on the timeline: start + (out − in) / speed. */
function clipEndS(c: { start: number; in: number; out: number; speed?: number }): number {
  return c.start + Math.max(0, (c.out - c.in) / (c.speed || 1));
}

/**
 * List item of a project: duration (end of the last clip), canvas size, clip count and the
 * thumbnail of the asset of the first video clip (earliest start on any video track).
 */
export function projectSummary(project: Project, assets: AssetLookup): ProjectSummary {
  const assetOf = lookup(assets);
  let durationS = 0;
  let clips = 0;
  let first: { start: number; assetId: string } | undefined;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      clips++;
      durationS = Math.max(durationS, clipEndS(clip));
      if (track.kind === "video" && clip.assetId && (!first || clip.start < first.start))
        first = { start: clip.start, assetId: clip.assetId };
    }
  }
  const thumbnailPath = first ? assetOf(first.assetId)?.thumbnailPath : undefined;
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    durationS: Math.round(durationS * 1000) / 1000,
    width: project.settings.width,
    height: project.settings.height,
    clips,
    ...(thumbnailPath ? { thumbnailPath } : {}),
  };
}

/** True for the default name (also «Proyecto sin título 2», empty or whitespace). */
export function isUntitledProjectName(name: string): boolean {
  const n = name.trim();
  return n === "" || /^Proyecto sin t[ií]tulo(\s*\(?\d+\)?)?$/i.test(n);
}

/**
 * New name for a project when its first video is imported: the file name without extension
 * (underscores/dashes as spaces) while the project is still «Proyecto sin título»; undefined =
 * keep the current name.
 */
export function autoProjectName(
  name: string,
  firstVideo: Pick<MediaAsset, "name"> | undefined,
): string | undefined {
  if (!firstVideo || !isUntitledProjectName(name)) return undefined;
  const base = firstVideo.name
    .replace(/^.*[\\/]/, "")
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PROJECT_NAME_MAX)
    .trim();
  return base && base !== name ? base : undefined;
}

/** «{nombre} (copia)» for a duplicate, within the max length. */
export function duplicateProjectName(name: string): string {
  const suffix = " (copia)";
  return `${name.slice(0, PROJECT_NAME_MAX - suffix.length).trim()}${suffix}`;
}

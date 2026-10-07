import {
  aiContentComment,
  detectAiContent,
  inheritedAiProvenance,
  type AiContentAsset,
  type AiProvenance,
  type MediaAsset,
  type Project,
} from "@studio/shared";
import type { AppContext } from "../context.js";

/**
 * Sprint 4 (M3) AI provenance in the api: what a derived asset inherits from its source and the
 * invisible `comment` metadata of exports (docs/trabajo/sprint4-contratos.md, decision 9).
 */
type ProvenanceFields = Pick<MediaAsset, "aiAltered" | "aiProvenance">;

/**
 * Fields a derived asset (voice.effect, audio.denoise, audio.stems, vision.matte) copies from its
 * source: `aiAltered` + `aiProvenance` with `sourceAssetId` = the source (+ `extra`, e.g. jobId).
 * `{}` when the source is plain media, so it can always be spread into a new asset.
 */
export function inheritAiProvenance(
  source: Pick<MediaAsset, "id" | "aiAltered" | "aiProvenance">,
  extra: Partial<Omit<AiProvenance, "kind" | "createdAt">> = {},
): ProvenanceFields {
  const inherited = inheritedAiProvenance(source);
  if (!inherited.aiProvenance) return inherited;
  return { aiAltered: true, aiProvenance: { ...inherited.aiProvenance, ...extra } };
}

/** After registering a derived asset: copy the source provenance onto it (no-op for plain media). */
export function applyInheritedAiProvenance(
  ctx: Pick<AppContext, "repos">,
  asset: MediaAsset,
  source: Pick<MediaAsset, "id" | "aiAltered" | "aiProvenance">,
  extra: Partial<Omit<AiProvenance, "kind" | "createdAt">> = {},
): MediaAsset {
  const fields = inheritAiProvenance(source, extra);
  if (!fields.aiAltered && !fields.aiProvenance) return asset;
  return ctx.repos.media.update(asset.id, fields);
}

/** The project's media (clip assets, rendered motion, cut-outs) for detectAiContent(). */
export function projectAiAssets(
  ctx: Pick<AppContext, "repos">,
  project: Pick<Project, "tracks">,
): Map<string, AiContentAsset> {
  const out = new Map<string, AiContentAsset>();
  for (const t of project.tracks)
    for (const c of t.clips)
      for (const id of [c.assetId, c.renderedAssetId, c.matte?.assetId]) {
        if (!id || out.has(id)) continue;
        const a = ctx.repos.media.get(id);
        if (a) out.set(id, a);
      }
  return out;
}

/**
 * `-metadata comment=<...>` of an export: written whenever AI content reaches the export, even with
 * the visible label off (decision 9; no ids or names). Undefined when nothing was detected.
 */
export function exportAiComment(
  ctx: Pick<AppContext, "repos">,
  project: Pick<Project, "tracks">,
): string | undefined {
  return aiContentComment(detectAiContent(project, projectAiAssets(ctx, project)));
}

import type { AiProvenance, AiProvenanceKind } from "./consent.js";
import type { MediaAsset } from "./media.js";
import type { Project, Track } from "./timeline.js";

/**
 * Sprint 4 (M3) «Revisión para redes»: AI content that reaches the export, detected from the
 * provenance of the media (MediaAsset.aiProvenance, written by face.swap / voice.tts / RVC and
 * inherited by voice.effect, audio.denoise, audio.stems and vision.matte).
 *
 * - The web marks `aiFace` / `aiVoice` by itself and locks them while there is a detection
 *   (a cloned voice locks `aiVoice`; a voice that is only synthetic is marked but editable).
 * - The export writes `aiContentComment()` into the file's `comment` metadata ALWAYS when something
 *   was detected, even with the visible label off (decision 9: invisible traceability, without
 *   ids or names). The visible label stays optional (decision 4: forSocial && aiLabel).
 */
export interface AiContentHit {
  clipId: string;
  trackId: string;
  assetId: string;
  personId?: string;
  label_es: string;
}

export interface AiContentReport {
  face: AiContentHit[];
  voiceCloned: AiContentHit[];
  voiceSynthetic: AiContentHit[];
}

export type AiContentAsset = Pick<MediaAsset, "id" | "name" | "aiAltered" | "aiProvenance">;

/** The visual part of a track reaches the export (video/text/motion tracks that are not hidden). */
export function trackIsVisible(track: Pick<Track, "kind" | "hidden">): boolean {
  return track.kind !== "audio" && !track.hidden;
}

/** The sound of a track reaches the export (audio not muted; video not hidden nor muted). */
export function trackIsAudible(track: Pick<Track, "kind" | "hidden" | "muted">): boolean {
  if (track.kind === "audio") return !track.muted;
  return track.kind === "video" && !track.hidden && !track.muted;
}

export function emptyAiContentReport(): AiContentReport {
  return { face: [], voiceCloned: [], voiceSynthetic: [] };
}

/**
 * Clips that reach the export (video track not hidden, audio track not muted) whose asset (the
 * clip media, its rendered motion or its cut-out) has `aiProvenance`. One hit per clip and kind.
 */
export function detectAiContent(
  project: Pick<Project, "tracks">,
  assets: ReadonlyMap<string, AiContentAsset>,
): AiContentReport {
  const report = emptyAiContentReport();
  const seen = new Set<string>();
  for (const track of project.tracks) {
    const visible = trackIsVisible(track);
    const audible = trackIsAudible(track);
    if (!visible && !audible) continue;
    for (const clip of track.clips) {
      const ids = [clip.assetId, clip.renderedAssetId, clip.matte?.assetId].filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      );
      for (const id of new Set(ids)) {
        const asset = assets.get(id);
        const prov = asset?.aiProvenance;
        if (!asset || !prov) continue;
        for (const kind of new Set([prov.kind, ...(prov.extraKinds ?? [])])) {
          const bucket =
            kind === "face"
              ? visible
                ? report.face
                : undefined
              : audible
                ? kind === "voice-cloned"
                  ? report.voiceCloned
                  : report.voiceSynthetic
                : undefined;
          if (!bucket) continue;
          const key = `${kind}:${clip.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          bucket.push({
            clipId: clip.id,
            trackId: track.id,
            assetId: asset.id,
            ...(prov.personId && { personId: prov.personId }),
            label_es: `«${asset.name}» (pista «${track.name}»)`,
          });
        }
      }
    }
  }
  return report;
}

export function hasAiContentHits(r: AiContentReport): boolean {
  return r.face.length + r.voiceCloned.length + r.voiceSynthetic.length > 0;
}

/**
 * Invisible traceability for the exported file's `comment` metadata, e.g.
 * "Editado con Studio; contenido alterado con IA: cara sintética: sí; voz clonada: no; voz
 * sintética: sí". No ids, names or paths. Undefined when nothing was detected.
 */
export function aiContentComment(r: AiContentReport): string | undefined {
  if (!hasAiContentHits(r)) return undefined;
  const yes = (n: number) => (n > 0 ? "sí" : "no");
  return (
    "Editado con Studio; contenido alterado con IA: " +
    `cara sintética: ${yes(r.face.length)}; ` +
    `voz clonada: ${yes(r.voiceCloned.length)}; ` +
    `voz sintética: ${yes(r.voiceSynthetic.length)}`
  );
}

/**
 * Audit fix 10: the kinds written by aiContentComment() in an exported file's `comment` tag
 * («contenido alterado con IA: cara sintética: sí; voz clonada: no; …»), or undefined when the
 * comment does not say so. A comment that says it but cannot be parsed counts as «synthetic voice»
 * so the asset is still marked.
 */
export function parseAiContentComment(comment: string | undefined): AiProvenanceKind[] | undefined {
  if (!comment || !/contenido alterado con ia/i.test(comment)) return undefined;
  const yes = (label: string) => new RegExp(`${label}\\s*:\\s*s[ií]`, "i").test(comment);
  const kinds: AiProvenanceKind[] = [];
  if (yes("cara sint[eé]tica")) kinds.push("face");
  if (yes("voz clonada")) kinds.push("voice-cloned");
  if (yes("voz sint[eé]tica")) kinds.push("voice-synthetic");
  return kinds.length > 0 ? kinds : ["voice-synthetic"];
}

/**
 * Minimal provenance of a file re-imported into Studio that carries the AI `comment` of an earlier
 * export: no Person, consent or job (they belong to the original project), only the kinds.
 */
export function reimportedAiProvenance(
  kinds: readonly AiProvenanceKind[],
  createdAt: string = new Date().toISOString(),
): Pick<MediaAsset, "aiAltered" | "aiProvenance"> {
  const [kind = "voice-synthetic", ...rest] = kinds;
  const provenance: AiProvenance = {
    kind,
    tool: "reimportado (metadato comment de una exportación con IA)",
    ...(rest.length > 0 && { extraKinds: [...rest] }),
    createdAt,
  };
  return { aiAltered: true, aiProvenance: provenance };
}

/** Checklist flags the detection implies: `locked` ones cannot be unchecked while detected. */
export interface DetectedPublishFlags {
  aiFace: boolean;
  aiVoice: boolean;
  locked: { aiFace: boolean; aiVoice: boolean };
}

export function detectedPublishFlags(r: AiContentReport): DetectedPublishFlags {
  return {
    aiFace: r.face.length > 0,
    aiVoice: r.voiceCloned.length > 0 || r.voiceSynthetic.length > 0,
    locked: { aiFace: r.face.length > 0, aiVoice: r.voiceCloned.length > 0 },
  };
}

/**
 * The AI provenance a derived asset inherits from its source (voice.effect, audio.denoise,
 * audio.stems, vision.matte): `aiAltered` + `aiProvenance` with `sourceAssetId` = the source.
 * Empty object when the source has no provenance.
 */
export function inheritedAiProvenance(
  source: Pick<MediaAsset, "id" | "aiAltered" | "aiProvenance">,
): Pick<MediaAsset, "aiAltered" | "aiProvenance"> {
  if (!source.aiProvenance) return source.aiAltered ? { aiAltered: true } : {};
  return {
    aiAltered: true,
    aiProvenance: { ...source.aiProvenance, sourceAssetId: source.id },
  };
}

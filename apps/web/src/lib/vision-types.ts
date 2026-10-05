import type { MediaAsset } from "@studio/shared";

/**
 * Sprint 2 data model (docs/trabajo/sprint2-contratos.md, «Modelo de datos»). The types live in
 * @studio/shared (keyframes.ts, vision.ts, track.ts); this module only adds web aliases, labels
 * and colors.
 *
 * Semantics (shared): keyframe `t` = seconds from the clip start (project.reframe: absolute
 * timeline seconds); position = CENTER of the clip/text in canvas fractions; crop = fractions 0..1
 * of the source (percent accepted); the ease of keyframe i shapes the segment i → i+1.
 */
export type {
  ClipKeyframes,
  ClipMatte,
  CropRect as CropBox,
  Easing as Ease,
  Keyframe,
  KeyframeProperty as KeyframeProp,
  KeyframeValue,
  MatteBackground,
  MatteBackgroundType,
  ProjectReframe as ReframeSettings,
  ReframeTarget,
  TrackAnchor,
  TrackFile,
  TrackFrame,
  TrackRef,
  Vec2,
} from "@studio/shared";
import type {
  Clip,
  Easing,
  KeyframeProperty,
  Project,
  ProjectReframe,
  ReframeTarget,
} from "@studio/shared";
export { EASINGS as EASES, reframeAspect as targetRatio } from "@studio/shared";

export const KEYFRAME_PROPS: readonly KeyframeProperty[] = ["position", "scale", "opacity", "crop"];
export const REFRAME_TARGETS: readonly ReframeTarget[] = ["9:16", "1:1", "4:5"];

/** Kept for readability at call sites: Clip already carries keyframes/trackRef/matte. */
export type VisionClip = Clip;
export type VisionProject = Project;

/** MediaAsset (kind admits "track" and "mask" in Sprint 2). */
export type VisionAsset = MediaAsset;

export function projectReframe(project: Project): ProjectReframe | undefined {
  return project.reframe;
}

export const PROP_LABELS: Record<KeyframeProperty, string> = {
  position: "Posición",
  scale: "Escala",
  opacity: "Opacidad",
  crop: "Recorte",
};

export const EASE_LABELS: Record<Easing, string> = {
  linear: "Lineal",
  easeIn: "Acelerar (ease in)",
  easeOut: "Frenar (ease out)",
  easeInOut: "Suave (ease in-out)",
  hold: "Mantener (salto)",
};

/** Diamond colors per property (timeline + inspector). */
export const PROP_COLORS: Record<KeyframeProperty, string> = {
  position: "#38bdf8",
  scale: "#4ade80",
  opacity: "#facc15",
  crop: "#fb7185",
};

/**
 * Tracker that ran (TrackFile.source.method / VisionTrackResult.method). "template" = fallback of
 * the workers when OpenCV has no CSRT (headless build): normalized template matching.
 */
export const TRACK_METHOD_LABELS: Record<string, string> = {
  csrt: "CSRT",
  template: "template matching",
  sam2: "SAM 2",
};

export function trackMethodLabel(method: string | undefined): string | undefined {
  return method ? (TRACK_METHOD_LABELS[method] ?? method) : undefined;
}

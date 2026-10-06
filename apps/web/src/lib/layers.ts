import {
  BLEND_MODES,
  defaultMaskShape,
  moveTrackZ,
  tracksInZOrder,
  type BlendMode,
  type Clip,
  type ClipMask,
  type ClipMaskShape,
  type MediaAsset,
  type Project,
  type Rect,
  type Track,
} from "@studio/shared";
import type { CSSProperties } from "react";
import { fileUrl } from "@/lib/api";
import { addBreadcrumb } from "@/stores/breadcrumbs-store";
import { useProjectStore } from "@/stores/project-store";

/**
 * Sprint 3b «Capas y fusiones» (docs/trabajo/sprint3b-contratos.md §E): blend modes, masks and
 * track z-order on the web side — labels, undoable store operations, the shape-mask editor math
 * and the mask image helpers of the preview compositor. Export = apps/api ffmpeg/timeline.ts.
 */

export { BLEND_MODES };

export const BLEND_MODE_LABELS: Record<BlendMode, string> = {
  normal: "Normal",
  multiply: "Multiplicar",
  screen: "Trama (aclarar suave)",
  overlay: "Superponer",
  add: "Sumar (luz)",
  difference: "Diferencia",
  lighten: "Aclarar",
  darken: "Oscurecer",
};

export const BLEND_MODE_HINTS: Record<BlendMode, string> = {
  normal: "La capa tapa lo de abajo (según su opacidad).",
  multiply: "Oscurece: el blanco desaparece, el negro queda. Ideal para sombras y texturas.",
  screen: "Aclara: el negro desaparece. Ideal para luces, destellos y humo sobre fondo negro.",
  overlay: "Contraste: aclara los claros y oscurece los oscuros del fondo.",
  add: "Suma la luz de las dos capas (puede quemar a blanco).",
  difference: "Resta los colores: igual = negro. Útil para comparar dos tomas.",
  lighten: "Se queda con el píxel más claro de las dos capas.",
  darken: "Se queda con el píxel más oscuro de las dos capas.",
};

/** CSS mix-blend-mode of a blend mode («Vista previa clásica»; "add" = plus-lighter). */
export function blendModeToCss(mode: BlendMode | undefined): CSSProperties["mixBlendMode"] {
  if (!mode || mode === "normal") return undefined;
  return mode === "add" ? "plus-lighter" : mode;
}

export type MaskChoice = "none" | "rect" | "ellipse" | "asset";

export const MASK_CHOICE_LABELS: Record<MaskChoice, string> = {
  none: "Ninguna",
  rect: "Rectángulo",
  ellipse: "Elipse",
  asset: "Máscara SAM / imagen",
};

export function maskChoiceOf(mask: ClipMask | undefined): MaskChoice {
  if (!mask) return "none";
  return mask.type === "asset" ? "asset" : mask.shape;
}

/** Assets usable as a clip mask: SAM masks, images and alpha videos («máscara alfa»). */
export function maskAssets(assets: Record<string, MediaAsset>): MediaAsset[] {
  return Object.values(assets)
    .filter((a) => a.kind === "mask" || a.kind === "image" || (a.kind === "video" && a.hasAlpha))
    .sort((a, b) => (a.kind === "mask" ? 0 : 1) - (b.kind === "mask" ? 0 : 1));
}

// ---------- undoable store operations ----------

/** Blend mode of a clip ("normal" removes the field). One undo step. */
export function setClipBlendMode(clipId: string, mode: BlendMode): void {
  useProjectStore
    .getState()
    .updateClip(clipId, { blendMode: mode === "normal" ? undefined : mode });
}

/** Mask of a clip (undefined = none). One undo step. */
export function setClipMask(clipId: string, mask: ClipMask | undefined): void {
  useProjectStore.getState().updateClip(clipId, { maskRef: mask });
}

/**
 * Inspector choice -> mask: a shape keeps the geometry / feather / invert of the current shape,
 * "asset" needs `assetId`.
 */
export function maskForChoice(
  current: ClipMask | undefined,
  choice: MaskChoice,
  assetId?: string,
): ClipMask | undefined {
  if (choice === "none") return undefined;
  if (choice === "asset") return assetId ? { type: "asset", assetId } : undefined;
  if (current?.type === "shape") return { ...current, shape: choice };
  return defaultMaskShape(choice);
}

/** z position (0 = bottom) of every track. */
export function zPositions(tracks: readonly Track[]): Map<string, number> {
  return new Map(tracksInZOrder(tracks).map((t, i) => [t.id, i]));
}

/**
 * Move a track to z position `to` (0 = bottom, drawn first). The tracks array is re-sorted to the
 * z-order and `order` rewritten (timeline rows = z-order). One undo step.
 */
export function moveTrackTo(trackId: string, to: number): void {
  const st = useProjectStore.getState();
  const { project } = st;
  const next = moveTrackZ(project.tracks, trackId, to);
  const same =
    next.every((t, i) => t.id === project.tracks[i]?.id && t.order === project.tracks[i]?.order) &&
    next.length === project.tracks.length;
  if (same) return;
  const track = project.tracks.find((t) => t.id === trackId);
  addBreadcrumb("track", `Movió la pista «${track?.name ?? trackId}» a la capa ${to + 1}`, {
    trackId,
    to,
  });
  st.checkpoint();
  useProjectStore.setState({
    project: { ...project, tracks: next, updatedAt: new Date().toISOString() },
    saveState: "dirty",
  });
}

/** Move a track `delta` z positions (+1 = one layer more to the front). */
export function moveTrackBy(trackId: string, delta: number): void {
  const z = zPositions(useProjectStore.getState().project.tracks).get(trackId);
  if (z !== undefined) moveTrackTo(trackId, z + delta);
}

/** Rows of the timeline in z-order (bottom layer first). */
export function timelineRows(project: Pick<Project, "tracks">): Track[] {
  return tracksInZOrder(project.tracks);
}

// ---------- shape mask editor (preview overlay) ----------

export type MaskHandle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const MASK_HANDLES: readonly Exclude<MaskHandle, "move">[] = [
  "nw",
  "n",
  "ne",
  "e",
  "se",
  "s",
  "sw",
  "w",
];

const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** Smallest shape side, fraction of the clip. */
export const MIN_MASK_SIZE = 0.02;

/** Canvas position (px) of a handle on the shape rect. */
export function handlePoint(r: Rect, h: Exclude<MaskHandle, "move">): { x: number; y: number } {
  const x = h.includes("w") ? r.x : h.includes("e") ? r.x + r.width : r.x + r.width / 2;
  const y = h.includes("n") ? r.y : h.includes("s") ? r.y + r.height : r.y + r.height / 2;
  return { x, y };
}

/**
 * Shape after dragging `handle` by (dx, dy) canvas px over a clip shown at `clipRect`: "move"
 * translates, edges/corners resize (the opposite side stays), min size MIN_MASK_SIZE, kept
 * inside -0.5..1.5 of the clip so a handle never gets lost.
 */
export function dragMaskShape(
  start: ClipMaskShape,
  handle: MaskHandle,
  dx: number,
  dy: number,
  clipRect: Pick<Rect, "width" | "height">,
): ClipMaskShape {
  const fx = clipRect.width > 0 ? dx / clipRect.width : 0;
  const fy = clipRect.height > 0 ? dy / clipRect.height : 0;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  let { x, y, w, h } = start;
  if (handle === "move") {
    x = clamp(x + fx, -0.5, 1.5 - w);
    y = clamp(y + fy, -0.5, 1.5 - h);
    return { ...start, x: round4(x), y: round4(y) };
  }
  if (handle.includes("w")) {
    const right = x + w;
    x = clamp(x + fx, -0.5, right - MIN_MASK_SIZE);
    w = right - x;
  }
  if (handle.includes("e")) w = clamp(w + fx, MIN_MASK_SIZE, 1.5 - x);
  if (handle.includes("n")) {
    const bottom = y + h;
    y = clamp(y + fy, -0.5, bottom - MIN_MASK_SIZE);
    h = bottom - y;
  }
  if (handle.includes("s")) h = clamp(h + fy, MIN_MASK_SIZE, 1.5 - y);
  return { ...start, x: round4(x), y: round4(y), w: round4(w), h: round4(h) };
}

// ---------- mask images (preview) ----------

/**
 * URL of the mask image of an asset mask at source time `t`: a SAM mask folder holds one
 * %05d.png per source frame (numbered from the clip source start, `fps` = mask, else source,
 * else project frame rate); a single PNG is used as is.
 */
export function maskImageUrl(mask: Pick<MediaAsset, "path">, t: number, fps: number): string {
  if (/\.png$/i.test(mask.path)) return fileUrl(mask.path);
  const frame = Math.max(0, Math.round(t * fps));
  return fileUrl(`${mask.path.replace(/\/+$/, "")}/${String(frame).padStart(5, "0")}.png`);
}

/** In place: alpha = luma (Rec. 601) and colour = white — a gray mask made usable as alpha. */
export function lumaToAlpha(data: Uint8ClampedArray): Uint8ClampedArray {
  for (let i = 0; i < data.length; i += 4) {
    const y = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    data[i + 3] = Math.round((y * data[i + 3]!) / 255);
    data[i] = data[i + 1] = data[i + 2] = 255;
  }
  return data;
}

/**
 * Loader of mask images by URL (SAM frames change every frame). `get` returns the image once
 * loaded — or, while a new frame of the same folder loads, the last loaded one (no flicker).
 */
export class MaskImageCache {
  private images = new Map<string, HTMLImageElement>();
  private lastByFolder = new Map<string, HTMLImageElement>();

  constructor(
    private readonly onLoad: () => void,
    private readonly max = 48,
  ) {}

  get(url: string): HTMLImageElement | undefined {
    const folder = url.replace(/\/[^/]*$/, "");
    let img = this.images.get(url);
    if (!img) {
      if (typeof Image === "undefined") return undefined;
      img = new Image();
      img.crossOrigin = "anonymous";
      img.decoding = "async";
      const el = img;
      img.onload = () => {
        this.lastByFolder.set(folder, el);
        this.onLoad();
      };
      img.src = url;
      this.images.set(url, img);
      if (this.images.size > this.max) {
        const oldest = this.images.keys().next().value;
        if (oldest !== undefined && oldest !== url) this.images.delete(oldest);
      }
    }
    if (img.complete && img.naturalWidth > 0) return img;
    return this.lastByFolder.get(folder);
  }

  clear(): void {
    this.images.clear();
    this.lastByFolder.clear();
  }
}

/** Short Spanish summary of a clip's layer settings (timeline tooltip / badges). */
export function layerSummary(clip: Pick<Clip, "blendMode" | "maskRef" | "opacity">): string {
  const parts: string[] = [];
  if (clip.blendMode && clip.blendMode !== "normal")
    parts.push(`Fusión: ${BLEND_MODE_LABELS[clip.blendMode]}`);
  if (clip.maskRef) {
    const m = clip.maskRef;
    parts.push(
      m.type === "asset"
        ? "Máscara de medio"
        : `Máscara ${m.shape === "rect" ? "rectangular" : "elíptica"}${m.invert ? " invertida" : ""}`,
    );
  }
  if (clip.opacity < 1) parts.push(`Opacidad ${Math.round(clip.opacity * 100)} %`);
  return parts.join(" · ");
}

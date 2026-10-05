import type { MediaAsset, Project } from "@studio/shared";
import { toast } from "sonner";
import { useMediaStore } from "@/stores/media-store";
import { useProjectStore } from "@/stores/project-store";

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Canvas for a video: its aspect ratio, scaled up so the short side is at least 1080 px (a
 * 478×850 WhatsApp clip becomes 1080×1920, the Reels size) and never above 4K.
 */
export function canvasForVideo(size: { width: number; height: number }): {
  width: number;
  height: number;
} {
  const short = Math.min(size.width, size.height);
  const k = Math.min(Math.max(1, 1080 / short), 3840 / Math.max(size.width, size.height));
  return { width: even(size.width * k), height: even(size.height * k) };
}

/** First video clip of the project with a known media size (bottom track first). */
export function firstVideoAsset(
  project: Pick<Project, "tracks">,
  assets: Record<string, MediaAsset>,
): MediaAsset | undefined {
  for (const t of project.tracks) {
    if (t.kind !== "video") continue;
    for (const c of [...t.clips].sort((a, b) => a.start - b.start)) {
      const a = c.assetId ? assets[c.assetId] : undefined;
      if (a?.width && a.height) return a;
    }
  }
  return undefined;
}

/** Feedback 4: "Ajustar lienzo al video". Returns the new size, or undefined without a video. */
export function fitCanvasToVideo(
  asset?: MediaAsset,
): { width: number; height: number } | undefined {
  const store = useProjectStore.getState();
  const a = asset ?? firstVideoAsset(store.project, useMediaStore.getState().assets);
  if (!a?.width || !a.height) return undefined;
  const size = canvasForVideo({ width: a.width, height: a.height });
  store.updateProjectSettings(size);
  return size;
}

/** Orientation differs enough to waste most of the canvas (vertical clip in 16:9 or vice versa). */
export function orientationMismatch(
  canvas: { width: number; height: number },
  media: { width?: number; height?: number },
): boolean {
  if (!media.width || !media.height) return false;
  const c = canvas.width / canvas.height;
  const m = media.width / media.height;
  return (c > 1.05 && m < 0.95) || (c < 0.95 && m > 1.05);
}

const suggested = new Set<string>();

/** After adding a video whose orientation fights the canvas, offer to fit the canvas once. */
export function suggestCanvasFit(asset: MediaAsset): void {
  if (asset.kind !== "video" || suggested.has(asset.id)) return;
  const { settings } = useProjectStore.getState().project;
  if (!orientationMismatch(settings, asset)) return;
  suggested.add(asset.id);
  const size = canvasForVideo({ width: asset.width!, height: asset.height! });
  toast.message(
    `El video es ${asset.width! < asset.height! ? "vertical" : "horizontal"} y el lienzo es ${settings.width}×${settings.height}`,
    {
      description: `¿Ajustar el lienzo al video (${size.width}×${size.height})? Los subtítulos y motion se adaptan al video igual.`,
      duration: 12_000,
      action: {
        label: "Ajustar lienzo",
        onClick: () => {
          fitCanvasToVideo(asset);
          toast.success(`Lienzo ${size.width}×${size.height}`);
        },
      },
    },
  );
}

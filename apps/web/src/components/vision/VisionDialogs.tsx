"use client";

import type {
  MatteBackground,
  MatteBackgroundType,
  MatteQuality,
  MatteRefine,
  MediaAsset,
  TrackAnchor,
} from "@studio/shared";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Input, Label, Range, Select } from "@/components/ui/input";
import { fileUrl } from "@/lib/api";
import { clipEnd, findClip } from "@/lib/timeline";
import { useMaskStore } from "@/stores/mask-store";
import { useMediaStore } from "@/stores/media-store";
import { usePacksStore } from "@/stores/packs-store";
import { useProjectStore } from "@/stores/project-store";
import { useVisionStore, type MatteOptions } from "@/stores/vision-store";

export const BACKGROUND_LABELS: Record<MatteBackgroundType | "none", string> = {
  none: "Transparente (se ven las pistas de abajo)",
  color: "Color",
  image: "Imagen",
  video: "Video",
  blur: "Desenfoque del propio video",
};

/** Background chooser shared by the dialog and the inspector. */
export function BackgroundFields({
  value,
  onChange,
}: {
  value: MatteBackground | undefined;
  onChange: (bg: MatteBackground | undefined) => void;
}) {
  const assets = useMediaStore((s) => s.assets);
  const type = value?.type ?? "none";
  const media = useMemo(
    () =>
      Object.values(assets).filter((a) =>
        type === "image" ? a.kind === "image" : type === "video" ? a.kind === "video" : false,
      ),
    [assets, type],
  );
  return (
    <div className="flex flex-col gap-2">
      <Label>
        Fondo
        <Select
          aria-label="Tipo de fondo"
          value={type}
          onChange={(e) => {
            const t = e.target.value as MatteBackgroundType | "none";
            onChange(
              t === "none"
                ? undefined
                : {
                    type: t,
                    ...(t === "color" ? { value: "#00b140" } : t === "blur" ? { value: "25" } : {}),
                  },
            );
          }}
        >
          {(Object.keys(BACKGROUND_LABELS) as (MatteBackgroundType | "none")[]).map((k) => (
            <option key={k} value={k}>
              {BACKGROUND_LABELS[k]}
            </option>
          ))}
        </Select>
      </Label>
      {value?.type === "color" ? (
        <Label>
          Color
          <Input
            type="color"
            value={value.value ?? "#00b140"}
            onChange={(e) => onChange({ type: "color", value: e.target.value })}
          />
        </Label>
      ) : null}
      {value?.type === "image" || value?.type === "video" ? (
        <Label>
          {value.type === "image" ? "Imagen de Media" : "Video de Media"}
          <Select
            value={value.value ?? ""}
            onChange={(e) => onChange({ type: value.type, value: e.target.value || undefined })}
          >
            <option value="">Elegí…</option>
            {media.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Label>
      ) : null}
      {value?.type === "blur" ? (
        <Label>
          Desenfoque: {value.value ?? "25"}
          <Range
            min={5}
            max={60}
            step={1}
            value={Number(value.value ?? 25)}
            onChange={(e) => onChange({ type: "blur", value: e.target.value })}
          />
        </Label>
      ) : null}
    </div>
  );
}

/** Sprint 3b: refinement defaults per quality (vision_gpl/refine.py HIGH_DEFAULTS). */
export const MATTE_DEFAULTS: Record<
  MatteQuality,
  Required<Pick<MatteRefine, "erode" | "feather" | "despill">>
> = {
  fast: { erode: 0, feather: 0, despill: false },
  high: { erode: 1, feather: 0.7, despill: true },
};

/**
 * Request options of the dialog: nothing for «Rápido» with the defaults (the sprint 2 request),
 * else the quality + the edge refinement (+ the SAM mask guide).
 */
export function matteOptions(
  quality: MatteQuality,
  refine: Required<Pick<MatteRefine, "erode" | "feather" | "despill">>,
  maskAssetId?: string,
): MatteOptions {
  const d = MATTE_DEFAULTS[quality];
  const changed =
    refine.erode !== d.erode || refine.feather !== d.feather || refine.despill !== d.despill;
  return {
    ...(quality === "high" && { quality }),
    ...((quality === "high" || changed) && { refine: { ...refine } }),
    ...(maskAssetId && { maskAssetId }),
  };
}

/** SAM mask of this asset: the one just propagated with «Máscara», else the newest mask asset
 * named after it («Máscara · <nombre>», what the api registers). */
export function samMaskFor(
  asset: Pick<MediaAsset, "id" | "name"> | undefined,
  assets: Record<string, MediaAsset>,
  mask: { assetId?: string | undefined; result?: { maskAssetId?: string } | undefined },
): string | undefined {
  if (!asset) return undefined;
  if (mask.assetId === asset.id && mask.result?.maskAssetId) return mask.result.maskAssetId;
  return Object.values(assets)
    .filter((a) => a.kind === "mask" && a.name === `Máscara · ${asset.name}`)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.id;
}

const dec1 = (n: number) => n.toFixed(1).replace(".", ",");

/** Before | after frame of the last refined matte of this clip (preview_compare_path). */
function MatteComparePreview({ clipId }: { clipId: string | undefined }) {
  const compare = useVisionStore((s) => s.matteCompare);
  if (!compare || compare.clipId !== clipId) return null;
  const halo = compare.halo;
  return (
    <figure className="flex flex-col gap-1" data-testid="matte-compare">
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>Antes</span>
        <span>Después</span>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element -- local /files URL of the api */}
      <img
        src={fileUrl(compare.path)}
        alt="Comparación antes y después del recorte"
        className="w-full rounded border border-border"
      />
      {halo ? (
        <figcaption className="text-[10px] text-muted-foreground">
          Halo de color en el borde: {dec1(halo.before)} → {dec1(halo.after)}
          {halo.before > 0 ? ` (−${Math.round((1 - halo.after / halo.before) * 100)} %)` : ""}
        </figcaption>
      ) : null}
    </figure>
  );
}

/** «Quitar fondo»: background chooser → job vision.matte (or the mask's alpha, no job). */
function MatteDialog() {
  const dialog = useVisionStore((s) => s.matteDialog);
  const project = useProjectStore((s) => s.project);
  const assets = useMediaStore((s) => s.assets);
  const maskAsset = useMaskStore((s) => s.assetId);
  const maskResult = useMaskStore((s) => s.result);
  const hqPack = usePacksStore((s) => s.packs.find((p) => p.id === "matting-hq"));
  const [bg, setBg] = useState<MatteBackground | undefined>({ type: "color", value: "#00b140" });
  const [quality, setQuality] = useState<MatteQuality>("fast");
  const [refine, setRefine] = useState(MATTE_DEFAULTS.fast);
  const [useMask, setUseMask] = useState(true);
  const found = dialog ? findClip(project, dialog.clipId) : undefined;
  const asset = found?.clip.assetId ? assets[found.clip.assetId] : undefined;
  const video = asset?.kind !== "image";
  const maskAssetId = video
    ? samMaskFor(asset, assets, { assetId: maskAsset, result: maskResult })
    : undefined;
  const close = () => useVisionStore.getState().openMatte(undefined);
  const incomplete = (bg?.type === "image" || bg?.type === "video") && !bg.value;
  const pickQuality = (q: MatteQuality) => {
    setQuality(q);
    setRefine(MATTE_DEFAULTS[q]);
  };
  return (
    <Dialog open={!!dialog} onClose={close} title="Quitar fondo" className="max-w-md">
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-xs text-muted-foreground">
          {dialog?.alphaAssetId
            ? "Se usa el recorte de la máscara que calculaste."
            : asset?.kind === "image"
              ? "Recorta la imagen con BiRefNet (paquete «Quitar fondo (imágenes)»)."
              : quality === "high"
                ? "Alta calidad: modelo grande (RobustVideoMatting resnet50) + limpieza de bordes. Más lento; usalo con fondos coloridos, pelo o bordes sucios."
                : "Recorta a la persona del video con RobustVideoMatting (paquete «Quitar fondo»). En la GPU de la notebook va a unos 15 cuadros por segundo o más."}
        </p>
        <p className="truncate text-xs font-medium">{asset?.name ?? "Clip"}</p>
        {video && !dialog?.alphaAssetId ? (
          <div className="flex flex-col gap-2 rounded-md border border-border p-2">
            <Label>
              Calidad del recorte
              <Select
                aria-label="Calidad del recorte"
                value={quality}
                onChange={(e) => pickQuality(e.target.value as MatteQuality)}
              >
                <option value="fast">Rápido</option>
                <option value="high">Alta calidad</option>
              </Select>
            </Label>
            {quality === "high" && hqPack && !hqPack.installed ? (
              <p className="text-[10px] text-amber-600 dark:text-amber-400">
                Necesita el paquete «{hqPack.name_es}»: se ofrece descargarlo al continuar.
              </p>
            ) : null}
            <Label>
              Suavizado de borde: {dec1(refine.feather)} px
              <Range
                aria-label="Suavizado de borde"
                min={0}
                max={4}
                step={0.1}
                value={refine.feather}
                onChange={(e) => setRefine({ ...refine, feather: Number(e.target.value) })}
              />
            </Label>
            <Label>
              Reducción de borde: {refine.erode} px
              <Range
                aria-label="Reducción de borde"
                min={0}
                max={5}
                step={1}
                value={refine.erode}
                onChange={(e) => setRefine({ ...refine, erode: Number(e.target.value) })}
              />
            </Label>
            <label className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={refine.despill}
                onChange={(e) => setRefine({ ...refine, despill: e.target.checked })}
              />
              Eliminar halos de color
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={useMask && !!maskAssetId}
                disabled={!maskAssetId}
                onChange={(e) => setUseMask(e.target.checked)}
              />
              Usar máscara SAM si existe
              {maskAssetId ? null : (
                <span className="text-[10px] text-muted-foreground">(este clip no tiene)</span>
              )}
            </label>
          </div>
        ) : null}
        <MatteComparePreview clipId={dialog?.clipId} />
        <BackgroundFields value={bg} onChange={setBg} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="xs" onClick={close}>
            Cancelar
          </Button>
          <Button
            size="xs"
            disabled={!dialog || incomplete}
            onClick={() => {
              if (!dialog) return;
              const v = useVisionStore.getState();
              if (dialog.alphaAssetId) v.applyAlpha(dialog.clipId, dialog.alphaAssetId, bg);
              else
                void v.removeBackground(
                  dialog.clipId,
                  bg,
                  video ? matteOptions(quality, refine, useMask ? maskAssetId : undefined) : {},
                );
            }}
          >
            Quitar fondo
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

const ANCHOR_LABELS: Record<TrackAnchor, string> = {
  center: "Centro del objeto",
  top: "Arriba del objeto",
  bottom: "Debajo del objeto",
};

/** Anchor + offset editor (dialog and inspector). Offset in % of the canvas. */
export function TrackRefFields({
  anchor,
  offset,
  onChange,
}: {
  anchor: TrackAnchor;
  offset: { x: number; y: number };
  onChange: (anchor: TrackAnchor, offset: { x: number; y: number }) => void;
}) {
  const pct = (v: number) => Math.round(v * 1000) / 10;
  return (
    <div className="grid grid-cols-3 gap-2">
      <Label>
        Ancla
        <Select value={anchor} onChange={(e) => onChange(e.target.value as TrackAnchor, offset)}>
          {(Object.keys(ANCHOR_LABELS) as TrackAnchor[]).map((a) => (
            <option key={a} value={a}>
              {ANCHOR_LABELS[a]}
            </option>
          ))}
        </Select>
      </Label>
      <Label>
        Desvío X (%)
        <Input
          type="number"
          step={1}
          value={pct(offset.x)}
          onChange={(e) => onChange(anchor, { ...offset, x: Number(e.target.value) / 100 || 0 })}
        />
      </Label>
      <Label>
        Desvío Y (%)
        <Input
          type="number"
          step={1}
          value={pct(offset.y)}
          onChange={(e) => onChange(anchor, { ...offset, y: Number(e.target.value) / 100 || 0 })}
        />
      </Label>
    </div>
  );
}

/** «Seguir objeto» → «Asignar a…»: which text/motion clip follows the track. */
function TrackAssignDialog() {
  const assign = useVisionStore((s) => s.trackAssign);
  const project = useProjectStore((s) => s.project);
  const [target, setTarget] = useState("");
  const [anchor, setAnchor] = useState<TrackAnchor>("top");
  const [offset, setOffset] = useState({ x: 0, y: -0.05 });
  const source = assign?.sourceClipId ? findClip(project, assign.sourceClipId)?.clip : undefined;
  const candidates = project.tracks
    .filter((t) => t.kind === "text" || t.kind === "motion")
    .flatMap((t) => t.clips.map((c) => ({ clip: c, track: t })))
    .filter(
      ({ clip }) => !source || (clip.start < clipEnd(source) && clipEnd(clip) > source.start),
    );
  const close = () => useVisionStore.getState().openTrackAssign(undefined);
  const chosen = target || candidates[0]?.clip.id || "";
  return (
    <Dialog open={!!assign} onClose={close} title="Seguir objeto: asignar" className="max-w-md">
      <div className="flex flex-col gap-3 text-sm">
        {candidates.length === 0 ? (
          <div className="flex flex-col gap-2 text-xs">
            <p>No hay textos ni motion graphics en el tramo del objeto.</p>
            <Button
              size="xs"
              className="w-fit"
              onClick={() => {
                const clip = useProjectStore.getState().addTextClip({
                  start: source?.start ?? useProjectStore.getState().playhead,
                  text: "Texto que sigue",
                });
                setTarget(clip.id);
              }}
            >
              Crear un texto
            </Button>
          </div>
        ) : (
          <Label>
            Clip que sigue al objeto
            <Select value={chosen} onChange={(e) => setTarget(e.target.value)}>
              {candidates.map(({ clip, track }) => (
                <option key={clip.id} value={clip.id}>
                  {track.name}: {clip.text ?? clip.motion?.template ?? clip.id}
                </option>
              ))}
            </Select>
          </Label>
        )}
        <TrackRefFields
          anchor={anchor}
          offset={offset}
          onChange={(a, o) => {
            setAnchor(a);
            setOffset(o);
          }}
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="xs" onClick={close}>
            Cancelar
          </Button>
          <Button
            size="xs"
            disabled={!assign || !chosen}
            onClick={() =>
              assign &&
              useVisionStore.getState().assignTrack(chosen, assign.trackAssetId, anchor, offset)
            }
          >
            Asignar
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Mounted once in the dashboard. */
export function VisionDialogs() {
  return (
    <>
      <MatteDialog />
      <TrackAssignDialog />
    </>
  );
}

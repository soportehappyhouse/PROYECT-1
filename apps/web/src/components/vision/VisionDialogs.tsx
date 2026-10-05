"use client";

import type { MatteBackground, MatteBackgroundType, TrackAnchor } from "@studio/shared";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Range, Select } from "@/components/ui/input";
import { clipEnd, findClip } from "@/lib/timeline";
import { useMediaStore } from "@/stores/media-store";
import { useProjectStore } from "@/stores/project-store";
import { useVisionStore } from "@/stores/vision-store";

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

/** «Quitar fondo»: background chooser → job vision.matte (or the mask's alpha, no job). */
function MatteDialog() {
  const dialog = useVisionStore((s) => s.matteDialog);
  const project = useProjectStore((s) => s.project);
  const assets = useMediaStore((s) => s.assets);
  const [bg, setBg] = useState<MatteBackground | undefined>({ type: "color", value: "#00b140" });
  const found = dialog ? findClip(project, dialog.clipId) : undefined;
  const asset = found?.clip.assetId ? assets[found.clip.assetId] : undefined;
  const close = () => useVisionStore.getState().openMatte(undefined);
  const incomplete = (bg?.type === "image" || bg?.type === "video") && !bg.value;
  return (
    <Dialog open={!!dialog} onClose={close} title="Quitar fondo" className="max-w-md">
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-xs text-muted-foreground">
          {dialog?.alphaAssetId
            ? "Se usa el recorte de la máscara que calculaste."
            : asset?.kind === "image"
              ? "Recorta la imagen con BiRefNet (paquete «Quitar fondo (imágenes)»)."
              : "Recorta a la persona del video con RobustVideoMatting (paquete «Quitar fondo»). En la GPU de la notebook va a unos 15 cuadros por segundo o más."}
        </p>
        <p className="truncate text-xs font-medium">{asset?.name ?? "Clip"}</p>
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
              else void v.removeBackground(dialog.clipId, bg);
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

"use client";

import type { BlendMode, Clip, ClipMaskShape, Track } from "@studio/shared";
import { Contrast, SquareDashedMousePointer } from "lucide-react";
import { useMaskEditorStore } from "@/components/preview/mask-editor-store";
import { Button } from "@/components/ui/button";
import { Label, Range, Select } from "@/components/ui/input";
import { Section } from "@/components/ui/misc";
import {
  BLEND_MODE_HINTS,
  BLEND_MODE_LABELS,
  BLEND_MODES,
  MASK_CHOICE_LABELS,
  maskAssets,
  maskChoiceOf,
  maskForChoice,
  setClipBlendMode,
  setClipMask,
  zPositions,
  type MaskChoice,
} from "@/lib/layers";
import { useMediaStore } from "@/stores/media-store";
import { useProjectStore } from "@/stores/project-store";

const MASK_CHOICES: MaskChoice[] = ["none", "rect", "ellipse", "asset"];

/**
 * Sprint 3b inspector «Capa» (video / motion clips): blend mode, mask (none / rectangle / ellipse
 * / SAM mask or image) with feather, invert and the shape editor on the preview, and the layer
 * position of the track. Every change is one undo step (updateClip).
 */
export function LayerSection({ clip, track }: { clip: Clip; track: Track }) {
  const assets = useMediaStore((s) => s.assets);
  const tracks = useProjectStore((s) => s.project.tracks);
  const editing = useMaskEditorStore((s) => s.clipId === clip.id);
  if (track.kind !== "video" && track.kind !== "motion") return null;
  const mode: BlendMode = clip.blendMode ?? "normal";
  const mask = clip.maskRef;
  const choice = maskChoiceOf(mask);
  const candidates = maskAssets(assets);
  const z = (zPositions(tracks).get(track.id) ?? 0) + 1;
  const shape: ClipMaskShape | undefined = mask?.type === "shape" ? mask : undefined;
  const setShape = (patch: Partial<ClipMaskShape>) =>
    shape && setClipMask(clip.id, { ...shape, ...patch });
  const pct = (v: number) => Math.round(v * 100);

  return (
    <Section
      title="Capa"
      actions={
        <span
          className="text-[11px] text-muted-foreground"
          title="Posición de la pista en la pila de capas: 1 = fondo. Cambiala arrastrando la cabecera de la pista o con su menú."
        >
          Capa {z} de {tracks.length}
        </span>
      }
    >
      <Label title={BLEND_MODE_HINTS[mode]}>
        Modo de fusión
        <Select
          aria-label="Modo de fusión"
          value={mode}
          disabled={track.locked}
          onChange={(e) => setClipBlendMode(clip.id, e.target.value as BlendMode)}
        >
          {BLEND_MODES.map((m) => (
            <option key={m} value={m} title={BLEND_MODE_HINTS[m]}>
              {BLEND_MODE_LABELS[m]}
            </option>
          ))}
        </Select>
      </Label>
      <p className="text-[11px] text-muted-foreground">{BLEND_MODE_HINTS[mode]}</p>

      <Label title="Recorta el clip con una forma o con una máscara de SAM (Segmentar objeto)">
        Máscara
        <Select
          aria-label="Máscara"
          value={choice}
          disabled={track.locked}
          onChange={(e) => {
            const next = e.target.value as MaskChoice;
            const m = maskForChoice(mask, next, candidates[0]?.id);
            setClipMask(clip.id, m);
            useMaskEditorStore
              .getState()
              .setEditing(next === "rect" || next === "ellipse" ? clip.id : undefined);
          }}
        >
          {MASK_CHOICES.map((c) => (
            <option key={c} value={c} disabled={c === "asset" && candidates.length === 0}>
              {MASK_CHOICE_LABELS[c]}
              {c === "asset" && candidates.length === 0 ? " (no hay máscaras)" : ""}
            </option>
          ))}
        </Select>
      </Label>

      {mask?.type === "asset" ? (
        <Label>
          Medio de la máscara
          <Select
            aria-label="Medio de la máscara"
            value={mask.assetId}
            onChange={(e) => setClipMask(clip.id, { type: "asset", assetId: e.target.value })}
          >
            {assets[mask.assetId] ? null : <option value={mask.assetId}>(borrado)</option>}
            {candidates.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
          <span className="text-[11px] text-muted-foreground">
            Blanco = se ve, negro = transparente. Las máscaras SAM siguen al objeto fotograma a
            fotograma.
          </span>
        </Label>
      ) : null}

      {shape ? (
        <div className="flex flex-col gap-2">
          <Label title="Suaviza el borde de la máscara (píxeles del lienzo con el clip al 100 %)">
            Difuminado: {Math.round(shape.feather)} px
            <Range
              aria-label="Difuminado"
              min={0}
              max={200}
              step={1}
              value={shape.feather}
              onChange={(e) => setShape({ feather: Number(e.target.value) })}
            />
          </Label>
          <p className="text-[11px] text-muted-foreground">
            Forma: X {pct(shape.x)} % · Y {pct(shape.y)} % · {pct(shape.w)} × {pct(shape.h)} % del
            clip
          </p>
          <div className="flex flex-wrap gap-1">
            <Button
              size="xs"
              variant={shape.invert ? "secondary" : "outline"}
              aria-pressed={shape.invert}
              tooltip="Invertir: deja ver lo de afuera de la forma y oculta lo de adentro"
              onClick={() => setShape({ invert: !shape.invert })}
            >
              <Contrast /> Invertir
            </Button>
            <Button
              size="xs"
              variant={editing ? "secondary" : "outline"}
              aria-pressed={editing}
              tooltip="Muestra los tiradores sobre la vista previa: arrastrá la forma o sus bordes"
              onClick={() =>
                useMaskEditorStore.getState().setEditing(editing ? undefined : clip.id)
              }
            >
              <SquareDashedMousePointer /> {editing ? "Terminar edición" : "Editar forma"}
            </Button>
          </div>
        </div>
      ) : null}
    </Section>
  );
}

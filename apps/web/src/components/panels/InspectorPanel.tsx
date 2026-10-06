"use client";

import type { Clip, TextStyle, Transition } from "@studio/shared";
import { Maximize, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useSelectedClip } from "@/components/common/SelectedClipInfo";
import { Button } from "@/components/ui/button";
import { Input, Label, Range, Select, Textarea } from "@/components/ui/input";
import { Badge, Section } from "@/components/ui/misc";
import { canvasForVideo, firstVideoAsset, fitCanvasToVideo } from "@/lib/canvas-fit";
import { formatTime, roundTime } from "@/lib/format";
import { clipDuration, clipEnd, TRACK_KIND_LABELS } from "@/lib/timeline";
import { effectSummary } from "@/lib/voice-effects";
import { useMediaStore } from "@/stores/media-store";
import { useProjectStore } from "@/stores/project-store";
import { assetMeta } from "./MediaPanel";
import { Panel } from "./Panel";
import { LayerSection } from "./LayerSection";
import { KeyframesSection, MatteSection, ReframeSection, TrackingSection } from "./VisionSections";
import { FaceSwapSection } from "@/components/face/FaceSwapSection";

const TRANSITIONS: Transition["type"][] = ["fade", "crossfade", "wipe", "slide", "zoom"];
const TRANSITION_LABELS: Record<Transition["type"], string> = {
  fade: "Fundido",
  crossfade: "Fundido cruzado",
  wipe: "Barrido",
  slide: "Deslizar",
  zoom: "Zoom",
};

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 0.01,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <Label>
      {label}
      <Input
        type="number"
        value={Number(value.toFixed(3))}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
      />
    </Label>
  );
}

function TransitionField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Transition | undefined;
  onChange: (t: Transition | undefined) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <Label>
        {label}
        <Select
          value={value?.type ?? ""}
          onChange={(e) =>
            onChange(
              e.target.value
                ? {
                    type: e.target.value as Transition["type"],
                    durationSec: value?.durationSec ?? 0.5,
                  }
                : undefined,
            )
          }
        >
          <option value="">Ninguna</option>
          {TRANSITIONS.map((t) => (
            <option key={t} value={t}>
              {TRANSITION_LABELS[t]}
            </option>
          ))}
        </Select>
      </Label>
      {value ? (
        <NumberField
          label="Duración (s)"
          value={value.durationSec}
          min={0.05}
          max={10}
          step={0.05}
          onChange={(d) => onChange({ ...value, durationSec: Math.min(10, Math.max(0.05, d)) })}
        />
      ) : null}
    </div>
  );
}

/** Anchor presets (feedback 7): position of the scaled clip inside the free canvas space. */
const ANCHORS: { label: string; x: number; y: number }[] = [
  { label: "Arriba izquierda", x: 0, y: 0 },
  { label: "Arriba", x: 0.5, y: 0 },
  { label: "Arriba derecha", x: 1, y: 0 },
  { label: "Izquierda", x: 0, y: 0.5 },
  { label: "Centro", x: 0.5, y: 0.5 },
  { label: "Derecha", x: 1, y: 0.5 },
  { label: "Abajo izquierda", x: 0, y: 1 },
  { label: "Abajo", x: 0.5, y: 1 },
  { label: "Abajo derecha", x: 1, y: 1 },
];
const ANCHOR_GLYPHS = ["↖", "↑", "↗", "←", "•", "→", "↙", "↓", "↘"];

/**
 * Feedback 7: free placement of video/motion clips — scale and X/Y in % plus anchor presets.
 * Applied on export by the PiP builder (pipPlacementFilters) and drawn in the preview.
 */
function PlacementFields({
  clip,
  update,
}: {
  clip: Clip;
  update: (patch: Partial<Omit<Clip, "id" | "trackId">>) => void;
}) {
  const scale = clip.scale ?? 1;
  const pos = clip.position ?? { x: 0.5, y: 0.5 };
  const pct = (v: number) => Math.round(v * 100);
  const setPos = (p: { x: number; y: number }) =>
    update({
      position: { x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) },
      // At 100 % the clip fills the canvas and cannot move: shrink it so the anchor is visible.
      ...(scale >= 1 && (p.x !== 0.5 || p.y !== 0.5) ? { scale: 0.5 } : {}),
    });
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-3 gap-2">
        <NumberField
          label="Escala (%)"
          value={pct(scale)}
          min={5}
          max={100}
          step={5}
          onChange={(v) => update({ scale: Math.min(1, Math.max(0.05, v / 100)) })}
        />
        <NumberField
          label="Posición X (%)"
          value={pct(pos.x)}
          min={0}
          max={100}
          step={5}
          onChange={(v) => setPos({ x: v / 100, y: pos.y })}
        />
        <NumberField
          label="Posición Y (%)"
          value={pct(pos.y)}
          min={0}
          max={100}
          step={5}
          onChange={(v) => setPos({ x: pos.x, y: v / 100 })}
        />
      </div>
      <div className="flex items-center gap-2">
        <div role="group" aria-label="Anclaje" className="grid w-fit grid-cols-3 gap-0.5">
          {ANCHORS.map((a, i) => (
            <Button
              key={a.label}
              size="icon-sm"
              variant={pos.x === a.x && pos.y === a.y ? "secondary" : "ghost"}
              aria-label={`Anclar: ${a.label.toLowerCase()}`}
              aria-pressed={pos.x === a.x && pos.y === a.y}
              onClick={() => setPos(a)}
            >
              <span className="text-xs leading-none">{ANCHOR_GLYPHS[i]}</span>
            </Button>
          ))}
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-[11px] text-muted-foreground">
            X/Y: 0 % = izquierda/arriba, 100 % = derecha/abajo.
            {scale >= 1 ? " Con escala 100 % el clip ocupa todo el lienzo." : ""}
          </p>
          {clip.scale !== undefined || clip.position ? (
            <Button
              size="xs"
              variant="outline"
              className="w-fit"
              onClick={() => update({ scale: undefined, position: undefined })}
            >
              Restablecer
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ProjectSettings() {
  const project = useProjectStore((s) => s.project);
  const { renameProject, updateProjectSettings } = useProjectStore.getState();
  const selectedAssetId = useProjectStore((s) => s.selectedAssetId);
  const asset = useMediaStore((s) => (selectedAssetId ? s.assets[selectedAssetId] : undefined));
  const assets = useMediaStore((s) => s.assets);
  const video = firstVideoAsset(project, assets);
  const fit =
    video?.width && video.height
      ? canvasForVideo({ width: video.width, height: video.height })
      : undefined;
  return (
    <div className="flex flex-col gap-4">
      <Section title="Proyecto">
        <Label>
          Nombre
          <Input value={project.name} onChange={(e) => renameProject(e.target.value)} />
        </Label>
        <div className="grid grid-cols-3 gap-2">
          <NumberField
            label="Ancho"
            value={project.settings.width}
            step={2}
            min={16}
            onChange={(v) => updateProjectSettings({ width: Math.max(16, Math.round(v)) })}
          />
          <NumberField
            label="Alto"
            value={project.settings.height}
            step={2}
            min={16}
            onChange={(v) => updateProjectSettings({ height: Math.max(16, Math.round(v)) })}
          />
          <NumberField
            label="FPS"
            value={project.settings.fps}
            step={1}
            min={1}
            onChange={(v) => updateProjectSettings({ fps: Math.max(1, v) })}
          />
        </div>
        <div className="flex flex-wrap gap-1">
          <Button
            size="xs"
            variant="outline"
            onClick={() => updateProjectSettings({ width: 1920, height: 1080 })}
          >
            16:9 1080p
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={() => updateProjectSettings({ width: 1080, height: 1920 })}
          >
            9:16 vertical
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={() => updateProjectSettings({ width: 1080, height: 1080 })}
          >
            1:1
          </Button>
          <Button
            size="xs"
            variant="secondary"
            disabled={!video}
            tooltip={
              video
                ? `Lienzo con la forma de «${video.name}» (${video.width}×${video.height}): ${fit?.width}×${fit?.height}`
                : "Añade un video a la línea de tiempo primero"
            }
            onClick={() => {
              const size = fitCanvasToVideo(video);
              if (size) toast.success(`Lienzo ${size.width}×${size.height}`);
            }}
          >
            <Maximize /> Ajustar lienzo al video
          </Button>
        </div>
      </Section>
      <ReframeSection />
      {asset ? (
        <Section title="Medio seleccionado">
          <p className="text-xs font-medium">{asset.name}</p>
          <p className="text-xs text-muted-foreground">{assetMeta(asset)}</p>
          <p className="text-[11px] text-muted-foreground">
            {asset.mimeType ?? asset.kind} · {asset.path}
          </p>
        </Section>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Selecciona un clip en la línea de tiempo para editar sus propiedades.
      </p>
    </div>
  );
}

export function InspectorPanel() {
  const sel = useSelectedClip();
  if (!sel) {
    return (
      <Panel title="Propiedades">
        <ProjectSettings />
      </Panel>
    );
  }
  const { clip, track, asset } = sel;
  const update = (patch: Partial<Omit<Clip, "id" | "trackId">>) =>
    useProjectStore.getState().updateClip(clip.id, patch);
  const style: TextStyle = clip.textStyle ?? {
    fontFamily: "Inter",
    fontSize: 64,
    color: "#ffffff",
    position: "bottom",
  };

  return (
    <Panel title="Propiedades">
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Badge>{TRACK_KIND_LABELS[track.kind]}</Badge>
          <span className="truncate text-xs font-medium">
            {asset?.name ?? clip.text ?? clip.motion?.template ?? "Clip"}
          </span>
          <Button
            size="icon-sm"
            variant="ghost"
            className="ml-auto"
            aria-label="Eliminar clip"
            onClick={() => useProjectStore.getState().deleteClip(clip.id)}
          >
            <Trash2 />
          </Button>
        </div>
        <Section title="Tiempo">
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Inicio en timeline (s)"
              value={clip.start}
              min={0}
              onChange={(v) => useProjectStore.getState().moveClip(clip.id, Math.max(0, v))}
            />
            <Label>
              Duración
              <Input readOnly value={formatTime(clipDuration(clip))} />
            </Label>
            <NumberField
              label="Entrada (s)"
              value={clip.in}
              min={0}
              onChange={(v) => update({ in: roundTime(Math.min(Math.max(0, v), clip.out - 0.05)) })}
            />
            <NumberField
              label="Salida (s)"
              value={clip.out}
              min={0}
              max={asset?.durationSec}
              onChange={(v) =>
                update({
                  out: roundTime(
                    Math.max(
                      clip.in + 0.05,
                      asset?.durationSec ? Math.min(v, asset.durationSec) : v,
                    ),
                  ),
                })
              }
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            {formatTime(clip.start)} → {formatTime(clipEnd(clip))}
          </p>
          <Label>
            Velocidad: {clip.speed.toFixed(2)}×
            <Range
              min={0.1}
              max={4}
              step={0.05}
              value={clip.speed}
              onChange={(e) => update({ speed: Number(e.target.value) })}
            />
          </Label>
        </Section>

        {track.kind === "video" || track.kind === "motion" || track.kind === "text" ? (
          <Section title="Imagen">
            <Label>
              Opacidad: {Math.round(clip.opacity * 100)}%
              <Range
                min={0}
                max={1}
                step={0.01}
                value={clip.opacity}
                onChange={(e) => update({ opacity: Number(e.target.value) })}
              />
            </Label>
            {track.kind !== "text" ? <PlacementFields clip={clip} update={update} /> : null}
            <TransitionField
              label="Transición de entrada"
              value={clip.transitionIn}
              onChange={(t) => update({ transitionIn: t })}
            />
            <TransitionField
              label="Transición de salida"
              value={clip.transitionOut}
              onChange={(t) => update({ transitionOut: t })}
            />
          </Section>
        ) : null}

        <LayerSection clip={clip} track={track} />

        {track.kind === "video" || track.kind === "motion" || track.kind === "text" ? (
          <KeyframesSection clip={clip} track={track} />
        ) : null}
        <TrackingSection clip={clip} track={track} />
        <MatteSection clip={clip} track={track} asset={asset} />
        <FaceSwapSection clip={clip} track={track} asset={asset} />

        {track.kind === "audio" || track.kind === "video" ? (
          <Section title="Audio">
            <Label>
              Volumen: {Math.round(clip.volume * 100)}%
              <Range
                min={0}
                max={4}
                step={0.01}
                value={clip.volume}
                onChange={(e) => update({ volume: Number(e.target.value) })}
              />
            </Label>
            {clip.voiceEffects.length > 0 ? (
              <div className="flex items-start gap-2 text-xs">
                <span className="flex-1">
                  Efectos al exportar: {clip.voiceEffects.map(effectSummary).join(" → ")}
                </span>
                <Button size="xs" variant="ghost" onClick={() => update({ voiceEffects: [] })}>
                  Quitar
                </Button>
              </div>
            ) : null}
          </Section>
        ) : null}

        {track.kind === "text" ? (
          <Section title="Texto">
            <Textarea
              value={clip.text ?? ""}
              onChange={(e) => update({ text: e.target.value })}
              aria-label="Texto"
            />
            <div className="grid grid-cols-2 gap-2">
              <Label>
                Fuente
                <Select
                  value={style.fontFamily}
                  onChange={(e) => update({ textStyle: { ...style, fontFamily: e.target.value } })}
                >
                  {["Inter", "Arial", "Georgia", "Impact", "Courier New", "Verdana"].map((f) => (
                    <option key={f}>{f}</option>
                  ))}
                </Select>
              </Label>
              <NumberField
                label="Tamaño"
                value={style.fontSize}
                min={8}
                step={1}
                onChange={(v) => update({ textStyle: { ...style, fontSize: Math.max(8, v) } })}
              />
              <Label>
                Color
                <Input
                  type="color"
                  value={style.color}
                  onChange={(e) => update({ textStyle: { ...style, color: e.target.value } })}
                />
              </Label>
              <Label>
                Posición
                <Select
                  value={style.position}
                  onChange={(e) =>
                    update({
                      textStyle: { ...style, position: e.target.value as TextStyle["position"] },
                    })
                  }
                >
                  <option value="top">Arriba</option>
                  <option value="center">Centro</option>
                  <option value="bottom">Abajo</option>
                </Select>
              </Label>
            </div>
          </Section>
        ) : null}

        {track.kind === "motion" && clip.motion ? (
          <Section title="Motion">
            <p className="text-xs">
              {clip.motion.template} · {clip.motion.engine ?? "auto"} · {clip.motion.format}
            </p>
            <p className="text-xs text-muted-foreground">
              {clip.renderedAssetId || clip.assetId
                ? "Renderizado"
                : "Sin renderizar — usa el panel Motion graphics"}
            </p>
          </Section>
        ) : null}

        <Section title="Pista">
          <p className="text-xs">{track.name}</p>
        </Section>
      </div>
    </Panel>
  );
}

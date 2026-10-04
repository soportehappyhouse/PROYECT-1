"use client";

import type { Clip, TextStyle, Transition } from "@studio/shared";
import { Trash2 } from "lucide-react";
import { useSelectedClip } from "@/components/common/SelectedClipInfo";
import { Button } from "@/components/ui/button";
import { Input, Label, Range, Select, Textarea } from "@/components/ui/input";
import { Badge, Section } from "@/components/ui/misc";
import { formatTime, roundTime } from "@/lib/format";
import { clipDuration, clipEnd, TRACK_KIND_LABELS } from "@/lib/timeline";
import { effectSummary } from "@/lib/voice-effects";
import { useMediaStore } from "@/stores/media-store";
import { useProjectStore } from "@/stores/project-store";
import { assetMeta } from "./MediaPanel";
import { Panel } from "./Panel";

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

function ProjectSettings() {
  const project = useProjectStore((s) => s.project);
  const { renameProject, updateProjectSettings } = useProjectStore.getState();
  const selectedAssetId = useProjectStore((s) => s.selectedAssetId);
  const asset = useMediaStore((s) => (selectedAssetId ? s.assets[selectedAssetId] : undefined));
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
        </div>
      </Section>
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
              {clip.renderedAssetId
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

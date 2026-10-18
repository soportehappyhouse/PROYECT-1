"use client";

import { rendersOwnTrack, type Clip, type MediaAsset, type Track } from "@studio/shared";
import { ClipboardPaste, Copy, Crosshair, Diamond, Loader2, Trash2 } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";
import { BackgroundFields, TrackRefFields } from "@/components/vision/VisionDialogs";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Section, Tabs } from "@/components/ui/misc";
import { cropFraction } from "@/lib/interpolate";
import { keyframeProps, keyframesOf } from "@/lib/keyframes";
import { cachedTrack } from "@/lib/vision-api";
import {
  EASE_LABELS,
  EASES,
  PROP_COLORS,
  PROP_LABELS,
  trackMethodLabel,
  type CropBox,
  type Ease,
  type Keyframe,
  type KeyframeProp,
  type KeyframeValue,
  type Vec2,
} from "@/lib/vision-types";
import { REFRAME_OWNER, useKeyframeStore } from "@/stores/keyframe-store";
import { useMediaStore } from "@/stores/media-store";
import { usePreviewStore } from "@/stores/preview-store";
import { useProjectStore } from "@/stores/project-store";
import { useVisionStore } from "@/stores/vision-store";

const pct = (v: number) => Math.round(v * 1000) / 10;

function Num({
  label,
  value,
  onChange,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
}) {
  return (
    <Input
      aria-label={label}
      title={label}
      type="number"
      step={step}
      className="h-6 px-1 text-xs"
      value={Number(value.toFixed(3))}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v)) onChange(v);
      }}
    />
  );
}

/** Value editor of one keyframe (percent for fractions). */
function ValueFields({
  prop,
  value,
  onChange,
}: {
  prop: KeyframeProp;
  value: KeyframeValue;
  onChange: (v: KeyframeValue) => void;
}) {
  if (prop === "position") {
    const v = value as Vec2;
    return (
      <div className="grid grid-cols-2 gap-1">
        <Num label="X (%)" value={pct(v.x)} onChange={(x) => onChange({ ...v, x: x / 100 })} />
        <Num label="Y (%)" value={pct(v.y)} onChange={(y) => onChange({ ...v, y: y / 100 })} />
      </div>
    );
  }
  if (prop === "crop") {
    const v = cropFraction(value as CropBox);
    return (
      <div className="grid grid-cols-4 gap-1">
        {(["x", "y", "w", "h"] as const).map((k) => (
          <Num
            key={k}
            label={`${k.toUpperCase()} (%)`}
            value={pct(v[k])}
            onChange={(n) => onChange({ ...v, [k]: n / 100 })}
          />
        ))}
      </div>
    );
  }
  const n = value as number;
  return (
    <Num
      label={prop === "scale" ? "Escala (%)" : "Opacidad (%)"}
      value={pct(n)}
      step={prop === "scale" ? 5 : 1}
      onChange={(v) =>
        onChange(prop === "opacity" ? Math.min(1, Math.max(0, v / 100)) : Math.max(0.01, v / 100))
      }
    />
  );
}

/** One keyframe row: time, value, ease, go-to and delete. */
function KeyframeRow({
  kf,
  prop,
  selected,
  base,
  onSelect,
  onTime,
  onValue,
  onEase,
  onDelete,
}: {
  kf: Keyframe;
  prop: KeyframeProp;
  selected: boolean;
  /** Timeline second of t = 0 (clip start; 0 for the reframe). */
  base: number;
  onSelect: () => void;
  onTime: (t: number) => void;
  onValue: (v: KeyframeValue) => void;
  onEase: (e: Ease) => void;
  onDelete: () => void;
}) {
  return (
    <li
      className={`flex flex-col gap-1 rounded border p-1.5 ${selected ? "border-primary bg-primary/5" : ""}`}
      onClick={onSelect}
    >
      <div className="flex items-center gap-1">
        <span
          aria-hidden
          className="size-2.5 shrink-0 rotate-45"
          style={{ background: PROP_COLORS[prop] }}
        />
        <div className="w-20">
          <Num
            label="Tiempo (s)"
            value={kf.t}
            step={0.04}
            onChange={(t) => onTime(Math.max(0, t))}
          />
        </div>
        <Select
          aria-label="Curva"
          className="h-6 flex-1 px-1 text-xs"
          value={kf.ease}
          onChange={(e) => onEase(e.target.value as Ease)}
        >
          {EASES.map((e) => (
            <option key={e} value={e}>
              {EASE_LABELS[e]}
            </option>
          ))}
        </Select>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Ir al keyframe"
          tooltip="Llevar el cursor a este keyframe para verlo en la vista previa"
          onClick={(e) => {
            e.stopPropagation();
            useProjectStore.getState().setPlayhead(base + kf.t);
          }}
        >
          <Diamond />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Eliminar keyframe"
          tooltip="Borrar este keyframe (el clip vuelve a interpolar sin él)"
          onClick={onDelete}
        >
          <Trash2 />
        </Button>
      </div>
      <ValueFields prop={prop} value={kf.v} onChange={onValue} />
    </li>
  );
}

/** Inspector «Keyframes»: property tabs, list with value + easing, add (K), copy/paste. */
export function KeyframesSection({ clip, track }: { clip: Clip; track: Track }) {
  const allowed = keyframeProps(track.kind);
  const active = useKeyframeStore((s) => s.activeProp);
  const selected = useKeyframeStore((s) => s.selected);
  const hasBoard = useKeyframeStore((s) => !!s.clipboard);
  const prop = allowed.includes(active) ? active : allowed[0]!;
  const list = useMemo(() => [...keyframesOf(clip, prop)].sort((a, b) => a.t - b.t), [clip, prop]);
  const kf = useKeyframeStore.getState;
  if (allowed.length === 0) return null;
  return (
    <Section
      title="Keyframes"
      actions={
        <div className="flex gap-0.5">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Copiar keyframes"
            tip="kfCopy"
            onClick={() =>
              kf().copy(clip.id)
                ? toast.message("Keyframes copiados")
                : toast.message("El clip no tiene keyframes")
            }
          >
            <Copy />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Pegar keyframes en el cursor"
            tip="kfPaste"
            disabled={!hasBoard || track.locked}
            disabledReason={
              track.locked ? "La pista está bloqueada" : "Primero copiá keyframes de un clip"
            }
            onClick={() => {
              if (!kf().paste(clip.id))
                toast.message("No se pudo pegar: nada aplicable a este clip");
            }}
          >
            <ClipboardPaste />
          </Button>
        </div>
      }
    >
      <Tabs
        value={prop}
        onChange={(p) => kf().setActiveProp(p)}
        items={allowed.map((p) => ({
          value: p,
          label: `${PROP_LABELS[p]}${keyframesOf(clip, p).length ? ` (${keyframesOf(clip, p).length})` : ""}`,
        }))}
      />
      <div className="flex flex-wrap items-center gap-1">
        <Button
          size="xs"
          variant="secondary"
          shortcut="playback.pause"
          disabled={track.locked}
          onClick={() => {
            if (!kf().addAtPlayhead(prop, clip.id))
              toast.message("Poné el cursor sobre el clip para agregar un keyframe");
          }}
        >
          <Diamond /> Agregar en el cursor
        </Button>
        {list.length > 0 ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={track.locked}
            onClick={() => kf().clearProp(clip.id, prop)}
          >
            Borrar todos
          </Button>
        ) : null}
      </div>
      {list.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {list.map((k, i) => (
            <KeyframeRow
              key={`${i}:${k.t}`}
              kf={k}
              prop={prop}
              base={clip.start}
              selected={
                selected?.clipId === clip.id && selected.prop === prop && selected.index === i
              }
              onSelect={() => kf().select({ clipId: clip.id, prop, index: i })}
              onTime={(t) => kf().setTime(clip.id, prop, i, t)}
              onValue={(v) => kf().setValue(clip.id, prop, i, v)}
              onEase={(e) => kf().setEase(clip.id, prop, i, e)}
              onDelete={() => kf().remove(clip.id, prop, i)}
            />
          ))}
        </ul>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          Sin keyframes de {PROP_LABELS[prop].toLowerCase()}. Con el video detenido y el clip
          elegido, <kbd>K</kbd> agrega uno en el cursor con el valor actual.
        </p>
      )}
      {list.length > 0 ? (
        <p className="text-[11px] text-muted-foreground">
          {prop === "position"
            ? "Posición = centro del clip en % del lienzo. "
            : prop === "crop"
              ? "Recorte en % del video original (el ancho/alto del primero se mantiene). "
              : ""}
          Con keyframes, el valor fijo de {PROP_LABELS[prop].toLowerCase()} se ignora. Arrastrá los
          rombos en la línea de tiempo para moverlos.
        </p>
      ) : null}
    </Section>
  );
}

/** Inspector «Seguimiento» for text/motion clips (trackRef: anchor + offset). */
export function TrackingSection({ clip, track }: { clip: Clip; track: Track }) {
  const assets = useMediaStore((s) => s.assets);
  const busy = useVisionStore((s) => !!s.busy.toKeyframes);
  const tracks = useMemo(() => Object.values(assets).filter((a) => a.kind === "track"), [assets]);
  const ref = clip.trackRef;
  const method = ref ? trackMethodLabel(cachedTrack(ref.assetId)?.source.method) : undefined;
  const update = (patch: Partial<Clip>) => useProjectStore.getState().updateClip(clip.id, patch);
  if (track.kind !== "text" && track.kind !== "motion") return null;
  return (
    <Section title="Seguimiento">
      {ref ? (
        <>
          <p className="text-xs">
            Sigue a «{assets[ref.assetId]?.name ?? ref.assetId}».
            {method ? ` Método: ${method}.` : ""}
            {rendersOwnTrack(clip)
              ? " La plantilla se posiciona sola: volvé a renderizar el motion para verlo."
              : ""}
          </p>
          <TrackRefFields
            anchor={ref.anchor}
            offset={ref.offset}
            onChange={(anchor, offset) => update({ trackRef: { ...ref, anchor, offset } })}
          />
          <div className="flex flex-wrap gap-1">
            <Button
              size="xs"
              variant="secondary"
              disabled={busy || track.locked}
              tooltip="Crea keyframes de posición editables y deja de usar el seguimiento"
              onClick={() => void useVisionStore.getState().convertTrackToKeyframes(clip.id)}
            >
              {busy ? <Loader2 className="animate-spin" /> : <Diamond />} Convertir seguimiento a
              keyframes
            </Button>
            <Button size="xs" variant="ghost" onClick={() => update({ trackRef: undefined })}>
              Dejar de seguir
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-[11px] text-muted-foreground">
            Para que este clip siga a una persona u objeto: «Seguir objeto» (
            <Crosshair className="inline size-3" />) en la vista previa y dibujá una caja sobre el
            video.
          </p>
          {tracks.length > 0 ? (
            <Select
              aria-label="Usar un seguimiento existente"
              value=""
              onChange={(e) =>
                e.target.value &&
                useVisionStore
                  .getState()
                  .assignTrack(clip.id, e.target.value, "center", { x: 0, y: 0 })
              }
            >
              <option value="">Usar un seguimiento existente…</option>
              {tracks.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          ) : null}
        </>
      )}
    </Section>
  );
}

/** Inspector «Quitar fondo» for video/image clips (clip.matte + background). */
export function MatteSection({
  clip,
  track,
  asset,
}: {
  clip: Clip;
  track: Track;
  asset: MediaAsset | undefined;
}) {
  const busy = useVisionStore((s) => !!s.busy.matte);
  if (track.kind !== "video" || !asset) return null;
  const matte = clip.matte;
  return (
    <Section title="Quitar fondo">
      {matte ? (
        <>
          <BackgroundFields
            value={matte.background}
            onChange={(background) =>
              useProjectStore.getState().updateClip(clip.id, {
                matte: { assetId: matte.assetId, ...(background && { background }) },
              })
            }
          />
          <Button
            size="xs"
            variant="ghost"
            className="w-fit"
            onClick={() => useProjectStore.getState().updateClip(clip.id, { matte: undefined })}
          >
            Volver al video original
          </Button>
        </>
      ) : (
        <Button
          size="xs"
          variant="secondary"
          className="w-fit"
          disabled={busy || track.locked}
          onClick={() => useVisionStore.getState().openMatte({ clipId: clip.id })}
        >
          {busy ? <Loader2 className="animate-spin" /> : null}
          {busy ? "Quitando el fondo…" : "Quitar fondo…"}
        </Button>
      )}
    </Section>
  );
}

/** Project settings «Reencuadre»: project.reframe crop keyframes (absolute timeline seconds). */
export function ReframeSection() {
  const reframe = useProjectStore((s) => s.project.reframe);
  const selected = useKeyframeStore((s) =>
    s.selected?.clipId === REFRAME_OWNER ? s.selected : undefined,
  );
  const kf = useKeyframeStore.getState;
  if (!reframe) {
    return (
      <Section title="Reencuadre">
        <Button
          size="xs"
          variant="outline"
          className="w-fit"
          onClick={() => usePreviewStore.getState().setReframeOpen(true)}
        >
          Reencuadrar a 9:16 / 1:1 / 4:5…
        </Button>
      </Section>
    );
  }
  return (
    <Section
      title={`Reencuadre ${reframe.target}`}
      actions={
        <Button
          size="xs"
          variant="ghost"
          onClick={() => useProjectStore.getState().setReframe(undefined)}
        >
          Quitar
        </Button>
      }
    >
      <p className="text-[11px] text-muted-foreground">
        {reframe.mode === "manual" ? "Editado a mano" : "Automático"} · {reframe.keyframes.length}{" "}
        keyframes de recorte (fracción del lienzo, tiempo absoluto). El recuadro celeste de la vista
        previa muestra lo que queda al exportar en {reframe.target}.
      </p>
      <Button
        size="xs"
        variant="secondary"
        className="w-fit"
        onClick={() => kf().addReframeAtPlayhead()}
      >
        <Diamond /> Agregar en el cursor
      </Button>
      <ul className="flex max-h-64 flex-col gap-1 overflow-auto">
        {reframe.keyframes.map((k, i) => (
          <KeyframeRow
            key={`${i}:${k.t}`}
            kf={k}
            prop="crop"
            base={0}
            selected={selected?.index === i}
            onSelect={() => kf().select({ clipId: REFRAME_OWNER, prop: "crop", index: i })}
            onTime={(t) => kf().updateReframe(i, { t })}
            onValue={(v) => kf().updateReframe(i, { v: v as CropBox })}
            onEase={(ease) => kf().updateReframe(i, { ease })}
            onDelete={() => kf().removeReframe(i)}
          />
        ))}
      </ul>
    </Section>
  );
}

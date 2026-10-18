"use client";

import {
  ALPHA_OUTPUT_FORMATS,
  GLOSSARY_ES,
  MotionOutputFormatSchema,
  type BrandKit,
  type Clip,
  type MotionEngineId,
  type MotionEngineInfo,
  type MotionOutputFormat,
  type MotionTemplateInfo,
} from "@studio/shared";
import { Film, RotateCcw, Wrench } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Label, Select, Textarea } from "@/components/ui/input";
import { Badge, Section } from "@/components/ui/misc";
import { useApiResource } from "@/hooks/use-api-resource";
import { useStillPreview } from "@/hooks/use-design";
import { TIPS } from "@/lib/tooltips";
import { api, errorMessage } from "@/lib/api";
import { designApi } from "@/lib/api-design";
import {
  coerceFieldValue,
  fieldsFromSchema,
  optionLabel,
  splitAdvanced,
  type FormField,
} from "@/lib/motion-form";
import { useJobsStore } from "@/stores/jobs-store";
import { useProjectStore } from "@/stores/project-store";
import { SafeZoneOverlay } from "./SafeZoneCalibrator";

/** Spanish names of the built-in templates (raw ids are never shown). */
export const TEMPLATE_NAMES_ES: Record<string, string> = {
  "title-card": "Título",
  "lower-third": "Rótulo",
  "animated-captions": "Subtítulos animados",
  transition: "Transición",
  "audio-visualizer": "Visualizador de audio",
  "lottie-overlay": "Animación Lottie",
  "end-screen": "Pantalla final",
  "progress-bar": "Barra de progreso",
  "kinetic-typography": "Tipografía cinética",
};

export function templateNameEs(id: string | undefined): string {
  return (id && TEMPLATE_NAMES_ES[id]) ?? "Gráfico";
}

/** Output formats in plain Spanish (shown only inside «Avanzado»). */
export const FORMAT_LABELS_ES: Record<MotionOutputFormat, string> = {
  "mp4-h264": "Video sin transparencia (MP4)",
  "webm-vp9-alpha": "Video con transparencia (WebM, recomendado)",
  "prores-4444": "Para otros editores (MOV con transparencia)",
  "png-sequence": "Imágenes sueltas (PNG con transparencia)",
};

/** Engines in plain Spanish (the tech name stays inside «Avanzado»). */
export const ENGINE_LABELS_ES: Record<MotionEngineId, string> = {
  remotion: "Plantillas de Studio",
  "motion-canvas": "Motor alternativo",
  "ffmpeg-lottie": "Animaciones Lottie",
};

/** «Arreglar» for an unavailable engine: what to run, in Spanish. */
export function engineFixHint(engine: MotionEngineInfo): string {
  if (engine.id === "remotion")
    return "Cerrá Studio y corré scripts\\windows\\setup.ps1 (instala el navegador de las plantillas). Después abrilo con scripts\\windows\\start.cmd.";
  if (engine.id === "ffmpeg-lottie")
    return "Instalá FFmpeg completo: winget install -e --id Gyan.FFmpeg, y volvé a abrir Studio.";
  return "Este motor todavía no está disponible: usá las plantillas de Studio.";
}

function kitValue(kit: BrandKit | undefined, token: string | undefined): unknown {
  if (!kit || !token) return undefined;
  const [group, key] = token.split(".");
  if (group === "color") return kit.tokens.color[key as keyof BrandKit["tokens"]["color"]];
  if (group === "font") return kit.tokens.font[key as keyof BrandKit["tokens"]["font"]]?.family;
  return undefined;
}

/** One field of a template form (Spanish labels, «Del kit» for token-backed props). */
export function MotionFieldInput({
  field,
  value,
  onChange,
  kit,
}: {
  field: FormField;
  value: unknown;
  onChange: (v: unknown) => void;
  kit?: BrandKit | undefined;
}) {
  const fromKit = value === undefined && field.token !== undefined;
  const shown = fromKit ? kitValue(kit, field.token) : value;
  const label = (
    <span className="flex items-center gap-1">
      {field.label}
      {fromKit ? <Badge tone="muted">Del kit</Badge> : null}
      {!fromKit && field.token ? (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          title={TIPS.kitResetToken}
          aria-label={`${field.label}: usar el del kit`}
          onClick={() => onChange(undefined)}
        >
          <RotateCcw className="size-3" />
        </button>
      ) : null}
    </span>
  );
  switch (field.kind) {
    case "boolean":
      return (
        <label className="flex items-center gap-2 text-xs" title={field.description}>
          <Checkbox checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
          {field.label}
        </label>
      );
    case "select":
      return (
        <Label title={field.description}>
          {label}
          <Select
            value={value === undefined ? "" : String(value)}
            onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
          >
            {field.token || value === undefined ? (
              <option value="">
                {field.token ? `Del kit${shown ? ` (${String(shown)})` : ""}` : "Elegí…"}
              </option>
            ) : null}
            {field.options?.map((o) => (
              <option key={o} value={o}>
                {optionLabel(field, o)}
              </option>
            ))}
          </Select>
        </Label>
      );
    case "number":
      return (
        <Label title={field.description}>
          {label}
          <Input
            type="number"
            min={field.min}
            max={field.max}
            step={field.step}
            placeholder={field.token || value === undefined ? "Del kit" : undefined}
            value={typeof value === "number" ? value : ""}
            onChange={(e) =>
              onChange(e.target.value === "" ? undefined : coerceFieldValue(field, e.target.value))
            }
          />
        </Label>
      );
    case "color": {
      const hex =
        typeof shown === "string" && shown.startsWith("#") ? shown.slice(0, 7) : "#ffffff";
      return (
        <Label title={field.description}>
          {label}
          <div className="flex gap-1">
            <Input
              type="color"
              className="w-10 p-0.5"
              aria-label={field.label}
              value={hex}
              onChange={(e) => onChange(e.target.value)}
            />
            <Input
              aria-label={`${field.label} (código)`}
              placeholder={fromKit ? String(shown ?? "") : undefined}
              value={fromKit ? "" : String(value ?? "")}
              onChange={(e) => onChange(e.target.value || undefined)}
            />
          </div>
        </Label>
      );
    }
    case "textarea":
      return (
        <Label title={field.description}>
          {label}
          <Textarea
            rows={2}
            value={String(value ?? "")}
            onChange={(e) => onChange(e.target.value)}
          />
        </Label>
      );
    case "json":
      return (
        <Label title={field.description}>
          {field.label} (datos)
          <Textarea
            rows={3}
            className="font-mono text-[11px]"
            defaultValue={JSON.stringify(value ?? null, null, 2)}
            onBlur={(e) => {
              const parsed = coerceFieldValue(field, e.target.value);
              if (parsed === undefined) toast.error(`Formato inválido en «${field.label}»`);
              else onChange(parsed);
            }}
          />
        </Label>
      );
    default:
      return (
        <Label title={field.description}>
          {label}
          <Input value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />
        </Label>
      );
  }
}

/** Main fields + folded «Avanzado» (advanced fields + extra content such as engine/format). */
export function MotionFields({
  fields,
  props,
  onChange,
  kit,
  advancedExtra,
  defaults = {},
}: {
  fields: FormField[];
  props: Record<string, unknown>;
  /** Template defaults (shown when the clip does not set the prop). */
  defaults?: Record<string, unknown>;
  onChange: (key: string, v: unknown) => void;
  kit?: BrandKit | undefined;
  advancedExtra?: React.ReactNode;
}) {
  const { main, advanced } = splitAdvanced(fields);
  return (
    <div className="flex flex-col gap-2" data-testid="motion-fields">
      {main.map((f) => (
        <MotionFieldInput
          key={f.key}
          field={f}
          value={props[f.key] ?? (f.token ? undefined : defaults[f.key])}
          kit={kit}
          onChange={(v) => onChange(f.key, v)}
        />
      ))}
      {advanced.length || advancedExtra ? (
        <details className="studio-advanced" data-testid="motion-advanced">
          <summary>{GLOSSARY_ES.actions.advanced}</summary>
          <div className="mt-2 flex flex-col gap-2">
            {advanced.map((f) => (
              <MotionFieldInput
                key={f.key}
                field={f}
                value={props[f.key] ?? (f.token ? undefined : defaults[f.key])}
                kit={kit}
                onChange={(v) => onChange(f.key, v)}
              />
            ))}
            {advancedExtra}
          </div>
        </details>
      ) : null}
    </div>
  );
}

const PREVIEW_MAX = 540;

/**
 * Sprint 6 M2 (H13): the template form of a motion clip INSIDE Propiedades, with a renderStill
 * preview (debounce 400 ms, cached by the api). The real render runs only on «Renderizar ahora»
 * (and the export asks for it when the clip has none).
 */
export function MotionPropsSection({ clip }: { clip: Clip }) {
  const motion = clip.motion!;
  const templates = useApiResource(() => api.motionTemplates());
  const engines = useApiResource(() => api.motionEngines());
  const kit = useApiResource(() => designApi.brandKit());
  const settings = useProjectStore((s) => s.project.settings);
  const template: MotionTemplateInfo | undefined = (templates.data ?? []).find(
    (t) => t.id === motion.template && (!motion.engine || t.engine === motion.engine),
  );
  const fields = useMemo(
    () => (template ? fieldsFromSchema(template.propsSchema, template.defaultProps) : []),
    [template],
  );
  const props = motion.props as Record<string, unknown>;
  const engine = engines.data?.find(
    (e) => e.id === (template?.engine ?? motion.engine ?? "remotion"),
  );
  const scale = Math.min(1, PREVIEW_MAX / Math.max(settings.width, settings.height));
  const w = Math.max(16, Math.round(settings.width * scale));
  const h = Math.max(16, Math.round(settings.height * scale));
  const still = useStillPreview(
    template?.engine === "remotion"
      ? { template: motion.template, props, width: w, height: h }
      : null,
  );
  const aspect =
    settings.width < settings.height * 0.8
      ? "9:16"
      : settings.width > settings.height * 1.25
        ? "16:9"
        : "1:1";

  const setProp = (key: string, v: unknown) => {
    const next = { ...props };
    if (v === undefined) delete next[key];
    else next[key] = v;
    useProjectStore.getState().updateClip(clip.id, {
      motion: { ...motion, props: next },
      renderedAssetId: undefined,
    });
  };
  const setSpec = (patch: Partial<typeof motion>) =>
    useProjectStore
      .getState()
      .updateClip(clip.id, { motion: { ...motion, ...patch }, renderedAssetId: undefined });

  const renderNow = async () => {
    try {
      const projectId = useProjectStore.getState().project.id;
      const spec = {
        ...motion,
        durationSec: Math.max(0.1, (clip.out - clip.in) / (clip.speed || 1)),
        width: settings.width,
        height: settings.height,
        fps: Math.round(settings.fps),
      };
      const { jobId } = await api.renderMotion(spec, { projectId, clipId: clip.id });
      useJobsStore
        .getState()
        .track(jobId, "motion.render", { kind: "setMotionRender", clipId: clip.id });
      toast.info("Renderizando el gráfico…");
    } catch (err) {
      toast.error("No se pudo renderizar", { description: errorMessage(err) });
    }
  };

  return (
    <Section title={template?.name ?? "Gráfico"}>
      <div data-testid="inspector-motion" className="flex flex-col gap-2">
        {engine && !engine.ok ? (
          <div
            className="flex items-start gap-2 rounded-md border border-[var(--warning)] p-2 text-xs"
            role="alert"
          >
            <span className="flex-1">
              {engine.reason ?? "El motor de animación no está disponible."}
            </span>
            <Button
              size="xs"
              variant="outline"
              tip="engineFix"
              onClick={() =>
                toast.info(GLOSSARY_ES.actions.fix, { description: engineFixHint(engine) })
              }
            >
              <Wrench /> {GLOSSARY_ES.actions.fix}
            </Button>
          </div>
        ) : null}
        <div
          className="relative w-full overflow-hidden rounded-md bg-[conic-gradient(#333_25%,#222_0_50%,#333_0_75%,#222_0)] bg-[length:16px_16px]"
          style={{ aspectRatio: `${w} / ${h}` }}
        >
          {still.url ? (
            // eslint-disable-next-line @next/next/no-img-element -- object URL of the api still
            <img
              src={still.url}
              alt="Vista previa del gráfico"
              className="absolute inset-0 size-full"
            />
          ) : (
            <p className="absolute inset-0 flex items-center justify-center p-3 text-center text-[11px] text-neutral-300">
              {still.loading ? "Generando la vista previa…" : (still.error ?? "Vista previa")}
            </p>
          )}
          {kit.data ? <SafeZoneOverlay zone={kit.data.tokens.safe_zone[aspect]} /> : null}
        </div>
        <p className="text-[11px] text-muted-foreground">
          {clip.renderedAssetId || clip.assetId
            ? "Renderizado: listo para exportar."
            : "Sin renderizar: la vista previa es un fotograma. Renderizalo antes de exportar."}
        </p>
        {templates.status === "ready" && !template ? (
          <p className="text-xs text-destructive">No encontré la plantilla de este gráfico.</p>
        ) : null}
        <MotionFields
          fields={fields}
          props={props}
          defaults={template?.defaultProps ?? {}}
          kit={kit.data}
          onChange={setProp}
          advancedExtra={
            <>
              <Label>
                Formato
                <Select
                  value={motion.format}
                  onChange={(e) => setSpec({ format: e.target.value as MotionOutputFormat })}
                >
                  {MotionOutputFormatSchema.options.map((f) => (
                    <option
                      key={f}
                      value={f}
                      disabled={!template?.supportsAlpha && ALPHA_OUTPUT_FORMATS.includes(f)}
                    >
                      {FORMAT_LABELS_ES[f]}
                    </option>
                  ))}
                </Select>
              </Label>
              <p className="text-[11px] text-muted-foreground">
                Motor: {ENGINE_LABELS_ES[template?.engine ?? motion.engine ?? "remotion"]} (
                {template?.engine ?? motion.engine ?? "remotion"})
              </p>
            </>
          }
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => void renderNow()}
          disabled={engine ? !engine.ok : false}
          tip="motionRenderNow"
          {...(engine && !engine.ok && engine.reason && { disabledReason: engine.reason })}
        >
          <Film /> Renderizar ahora
        </Button>
      </div>
    </Section>
  );
}

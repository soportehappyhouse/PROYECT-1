"use client";

import {
  ALPHA_OUTPUT_FORMATS,
  MotionOutputFormatSchema,
  MotionSpecSchema,
  type MotionOutputFormat,
  type MotionSpec,
  type MotionTemplateInfo,
} from "@studio/shared";
import { Film, Plus, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useSelectedClip } from "@/components/common/SelectedClipInfo";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Label, Select, Textarea } from "@/components/ui/input";
import {
  Badge,
  EmptyState,
  ErrorNotice,
  NotImplementedNotice,
  Section,
  Spinner,
} from "@/components/ui/misc";
import { useApiResource } from "@/hooks/use-api-resource";
import { api, errorMessage, fileUrl, isNotImplemented } from "@/lib/api";
import { createId } from "@/lib/ids";
import { coerceFieldValue, fieldsFromSchema, type FormField } from "@/lib/motion-form";
import { jobOutputPath, useJobsStore } from "@/stores/jobs-store";
import { useProjectStore } from "@/stores/project-store";
import { Panel } from "./Panel";

const FORMAT_LABELS: Record<MotionOutputFormat, string> = {
  "mp4-h264": "MP4 H.264 (sin alfa)",
  "webm-vp9-alpha": "WebM VP9 con alfa (overlay)",
  "prores-4444": "ProRes 4444 con alfa",
  "png-sequence": "Secuencia PNG",
};

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const label = (
    <>
      {field.label}
      {field.required ? " *" : ""}
    </>
  );
  switch (field.kind) {
    case "boolean":
      return (
        <label className="flex items-center gap-2 text-xs" title={field.description}>
          <Checkbox checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
          {label}
        </label>
      );
    case "select":
      return (
        <Label title={field.description}>
          {label}
          <Select value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
            {field.options?.map((o) => (
              <option key={o} value={o}>
                {o}
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
            value={typeof value === "number" ? value : ""}
            onChange={(e) => onChange(coerceFieldValue(field, e.target.value))}
          />
        </Label>
      );
    case "color":
      return (
        <Label title={field.description}>
          {label}
          <div className="flex gap-1">
            <Input
              type="color"
              className="w-10 p-0.5"
              value={
                typeof value === "string" && value.startsWith("#") ? value.slice(0, 7) : "#ffffff"
              }
              onChange={(e) => onChange(e.target.value)}
            />
            <Input value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />
          </div>
        </Label>
      );
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
          {label} (JSON)
          <Textarea
            rows={3}
            className="font-mono text-[11px]"
            defaultValue={JSON.stringify(value ?? null, null, 2)}
            onBlur={(e) => {
              const parsed = coerceFieldValue(field, e.target.value);
              if (parsed === undefined) toast.error(`JSON inválido en «${field.label}»`);
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

/** Rough DOM preview of the template props (the real frames come from the motion engine). */
function ApproxPreview({
  props,
  width,
  height,
}: {
  props: Record<string, unknown>;
  width: number;
  height: number;
}) {
  const texts = Object.entries(props)
    .filter(
      ([k, v]) =>
        typeof v === "string" &&
        !/colou?r|font|background|path|url/i.test(k) &&
        !String(v).startsWith("#"),
    )
    .slice(0, 3)
    .map(([, v]) => String(v));
  const color = Object.entries(props).find(
    ([k, v]) => /colou?r/i.test(k) && typeof v === "string",
  )?.[1] as string | undefined;
  return (
    <div
      className="relative w-full overflow-hidden rounded-md bg-[conic-gradient(#333_25%,#222_0_50%,#333_0_75%,#222_0)] bg-[length:16px_16px]"
      style={{ aspectRatio: `${width} / ${height}` }}
    >
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-4 text-center">
        {texts.length === 0 ? <span className="text-xs text-neutral-400">Sin textos</span> : null}
        {texts.map((t, i) => (
          <span
            key={i}
            className={i === 0 ? "text-lg font-bold" : "text-xs"}
            style={{ color: color ?? "#fff", textShadow: "0 2px 6px rgba(0,0,0,.7)" }}
          >
            {t}
          </span>
        ))}
      </div>
      <Badge tone="muted" className="absolute bottom-1 left-1">
        Vista previa aproximada
      </Badge>
    </div>
  );
}

export function MotionPanel() {
  const engines = useApiResource(() => api.motionEngines());
  const templates = useApiResource(() => api.motionTemplates());
  const settings = useProjectStore((s) => s.project.settings);
  const sel = useSelectedClip();
  const jobs = useJobsStore((s) => s.jobs);
  const [templateKey, setTemplateKey] = useState("");
  const [props, setProps] = useState<Record<string, unknown>>({});
  const [duration, setDuration] = useState(5);
  const [format, setFormat] = useState<MotionOutputFormat>("webm-vp9-alpha");
  const [lastJobId, setLastJobId] = useState<string | undefined>(undefined);

  const list = useMemo(() => templates.data ?? [], [templates.data]);
  const template: MotionTemplateInfo | undefined = list.find(
    (t) => `${t.engine}:${t.id}` === templateKey,
  );
  const fields = useMemo(
    () => (template ? fieldsFromSchema(template.propsSchema, template.defaultProps) : []),
    [template],
  );
  const engineAvailable = (id: string) => engines.data?.find((e) => e.id === id)?.available ?? true;

  const choose = (key: string) => {
    setTemplateKey(key);
    const t = list.find((x) => `${x.engine}:${x.id}` === key);
    if (!t) return;
    setProps({ ...t.defaultProps });
    setDuration(t.defaultDurationSec);
    setFormat(t.supportsAlpha ? "webm-vp9-alpha" : "mp4-h264");
  };

  // Editing an existing motion clip: load its spec into the form.
  const selectedMotion = sel?.clip.motion;
  const loadFromClip = () => {
    if (!selectedMotion) return;
    const t = list.find(
      (x) =>
        x.id === selectedMotion.template &&
        (!selectedMotion.engine || x.engine === selectedMotion.engine),
    );
    if (t) setTemplateKey(`${t.engine}:${t.id}`);
    setProps({ ...selectedMotion.props });
    setDuration(selectedMotion.durationSec);
    setFormat(selectedMotion.format);
  };

  const buildSpec = (): MotionSpec | undefined => {
    if (!template) return undefined;
    const parsed = MotionSpecSchema.safeParse({
      engine: template.engine,
      template: template.id,
      props,
      durationSec: duration,
      fps: Math.round(settings.fps),
      width: settings.width,
      height: settings.height,
      format,
    });
    if (!parsed.success) {
      toast.error("Parámetros inválidos", { description: parsed.error.issues[0]?.message });
      return undefined;
    }
    return parsed.data;
  };

  const addClip = (spec: MotionSpec) =>
    useProjectStore.getState().addClip("motion", {
      id: createId("clp"),
      start: useProjectStore.getState().playhead,
      in: 0,
      out: spec.durationSec,
      speed: 1,
      volume: 1,
      opacity: 1,
      voiceEffects: [],
      motion: spec,
    });

  const render = async (clipId: string | undefined, spec: MotionSpec) => {
    try {
      const projectId = useProjectStore.getState().project.id;
      const { jobId } = await api.renderMotion(spec, clipId ? { projectId, clipId } : undefined);
      useJobsStore
        .getState()
        .track(jobId, "motion.render", clipId ? { kind: "setMotionRender", clipId } : undefined);
      setLastJobId(jobId);
      toast.info("Renderizando motion…");
    } catch (err) {
      if (isNotImplemented(err)) toast.info("Render de motion: módulo en desarrollo");
      else toast.error("No se pudo renderizar", { description: errorMessage(err) });
    }
  };

  const lastJob = lastJobId ? jobs[lastJobId] : undefined;
  const lastOutput = lastJob ? jobOutputPath(lastJob) : undefined;

  return (
    <Panel
      title="Motion graphics"
      toolbar={
        <>
          <span className="text-xs text-muted-foreground">Motores:</span>
          {engines.data?.map((e) => (
            <Badge key={e.id} tone={e.available ? "success" : "muted"} title={e.reason}>
              {e.displayName}
            </Badge>
          ))}
          {engines.status === "not-implemented" ? (
            <Badge tone="warning">en desarrollo</Badge>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label="Recargar plantillas"
            onClick={() => {
              engines.reload();
              templates.reload();
            }}
          >
            <RefreshCw />
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {templates.status === "loading" ? <Spinner /> : null}
        {templates.status === "not-implemented" ? (
          <NotImplementedNotice what="El catálogo de plantillas" />
        ) : null}
        {templates.status === "error" && templates.error ? (
          <ErrorNotice message={templates.error} />
        ) : null}
        {templates.status === "ready" && list.length === 0 ? (
          <EmptyState>No hay plantillas registradas.</EmptyState>
        ) : null}

        {list.length > 0 ? (
          <Label>
            Plantilla
            <Select value={templateKey} onChange={(e) => choose(e.target.value)}>
              <option value="">Elige una plantilla…</option>
              {list.map((t) => (
                <option
                  key={`${t.engine}:${t.id}`}
                  value={`${t.engine}:${t.id}`}
                  disabled={!engineAvailable(t.engine)}
                >
                  {t.name} · {t.engine}
                  {engineAvailable(t.engine) ? "" : " (no disponible)"}
                </option>
              ))}
            </Select>
          </Label>
        ) : null}

        {selectedMotion ? (
          <Button size="xs" variant="outline" onClick={loadFromClip}>
            Editar el clip motion seleccionado ({selectedMotion.template})
          </Button>
        ) : null}

        {template ? (
          <>
            {template.description ? (
              <p className="text-xs text-muted-foreground">{template.description}</p>
            ) : null}
            <ApproxPreview props={props} width={settings.width} height={settings.height} />
            {lastOutput ? (
              <video
                src={fileUrl(lastOutput)}
                controls
                loop
                className="w-full rounded-md bg-black"
                aria-label="Último render"
              />
            ) : null}
            <Section title="Parámetros">
              {fields.map((f) => (
                <FieldInput
                  key={f.key}
                  field={f}
                  value={props[f.key]}
                  onChange={(v) => setProps((p) => ({ ...p, [f.key]: v }))}
                />
              ))}
            </Section>
            <div className="grid grid-cols-2 gap-2">
              <Label>
                Duración (s)
                <Input
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={duration}
                  onChange={(e) => setDuration(Math.max(0.1, Number(e.target.value) || 0.1))}
                />
              </Label>
              <Label>
                Formato
                <Select
                  value={format}
                  onChange={(e) => setFormat(e.target.value as MotionOutputFormat)}
                >
                  {MotionOutputFormatSchema.options.map((f) => (
                    <option
                      key={f}
                      value={f}
                      disabled={!template.supportsAlpha && ALPHA_OUTPUT_FORMATS.includes(f)}
                    >
                      {FORMAT_LABELS[f]}
                    </option>
                  ))}
                </Select>
              </Label>
            </div>
            <div className="flex flex-wrap gap-1">
              <Button
                size="sm"
                onClick={() => {
                  const spec = buildSpec();
                  if (spec) void render(addClip(spec).id, spec);
                }}
              >
                <Film /> Renderizar y añadir
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const spec = buildSpec();
                  if (spec) addClip(spec);
                }}
              >
                <Plus /> Añadir sin render
              </Button>
              {selectedMotion && sel ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const spec = buildSpec();
                    if (!spec) return;
                    useProjectStore.getState().updateClip(sel.clip.id, {
                      motion: spec,
                      out: sel.clip.in + spec.durationSec,
                      renderedAssetId: undefined,
                    });
                    void render(sel.clip.id, spec);
                  }}
                >
                  Actualizar clip y renderizar
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </Panel>
  );
}

"use client";

import {
  ALPHA_OUTPUT_FORMATS,
  GLOSSARY_ES,
  MotionOutputFormatSchema,
  MotionSpecSchema,
  type MotionOutputFormat,
  type MotionSpec,
  type MotionTemplateInfo,
} from "@studio/shared";
import { Film, Plus, RefreshCw, Wrench } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useSelectedClip } from "@/components/common/SelectedClipInfo";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import {
  EmptyState,
  ErrorNotice,
  NotImplementedNotice,
  Section,
  Spinner,
} from "@/components/ui/misc";
import {
  ENGINE_LABELS_ES,
  engineFixHint,
  FORMAT_LABELS_ES,
  MotionFields,
  templateNameEs,
} from "@/components/design/MotionForm";
import { useStillPreview } from "@/hooks/use-design";
import { designApi } from "@/lib/api-design";
import { useApiResource } from "@/hooks/use-api-resource";
import { api, errorMessage, fileUrl, isNotImplemented } from "@/lib/api";
import { createId } from "@/lib/ids";
import { fieldsFromSchema } from "@/lib/motion-form";
import { jobOutputPath, useJobsStore } from "@/stores/jobs-store";
import { useProjectStore } from "@/stores/project-store";
import { Panel } from "./Panel";

/** Still preview of the template being configured (api renderStill, debounce 400 ms). */
function StillPreview({
  template,
  props,
  width,
  height,
}: {
  template: MotionTemplateInfo;
  props: Record<string, unknown>;
  width: number;
  height: number;
}) {
  const scale = Math.min(1, 540 / Math.max(width, height));
  const w = Math.max(16, Math.round(width * scale));
  const h = Math.max(16, Math.round(height * scale));
  const still = useStillPreview(
    template.engine === "remotion" ? { template: template.id, props, width: w, height: h } : null,
  );
  return (
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
  const kit = useApiResource(() => designApi.brandKit());

  const list = useMemo(() => templates.data ?? [], [templates.data]);
  const template: MotionTemplateInfo | undefined = list.find(
    (t) => `${t.engine}:${t.id}` === templateKey,
  );
  const fields = useMemo(
    () => (template ? fieldsFromSchema(template.propsSchema, template.defaultProps) : []),
    [template],
  );
  // Until the engine list loads every template is selectable; afterwards only engines with ok=true
  // (B2: the stub motion-canvas engine reports ok=false and must not be chosen).
  const engineAvailable = (id: string) =>
    engines.data ? (engines.data.find((e) => e.id === id)?.ok ?? false) : true;

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
    if (!engineAvailable(template.engine)) {
      const eng = engines.data?.find((e) => e.id === template.engine);
      toast.error("Este gráfico no se puede hacer ahora", {
        description: eng ? `${eng.reason ?? ""} ${engineFixHint(eng)}`.trim() : undefined,
      });
      return undefined;
    }
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
      toast.info("Renderizando el gráfico…");
    } catch (err) {
      if (isNotImplemented(err)) toast.info("Todavía no se pueden renderizar gráficos");
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
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label="Recargar plantillas"
            tip="motionReload"
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

        {/* Sprint 6 M2 (B11): an unavailable engine says why, in Spanish, with «Arreglar». */}
        {(engines.data ?? [])
          .filter((e) => !e.ok && e.id === "remotion")
          .map((e) => (
            <div
              key={e.id}
              role="alert"
              className="flex items-start gap-2 rounded-md border border-[var(--warning)] p-2 text-xs"
            >
              <span className="flex-1">{e.reason ?? "Las plantillas no están disponibles."}</span>
              <Button
                size="xs"
                variant="outline"
                tip="engineFix"
                onClick={() =>
                  toast.info(GLOSSARY_ES.actions.fix, { description: engineFixHint(e) })
                }
              >
                <Wrench /> {GLOSSARY_ES.actions.fix}
              </Button>
            </div>
          ))}
        {list.length > 0 ? (
          <Label>
            Plantilla
            <Select value={templateKey} onChange={(e) => choose(e.target.value)}>
              <option value="">Elegí una plantilla…</option>
              {list.map((t) => (
                <option
                  key={`${t.engine}:${t.id}`}
                  value={`${t.engine}:${t.id}`}
                  disabled={!engineAvailable(t.engine)}
                >
                  {t.name}
                  {engineAvailable(t.engine) ? "" : " (no disponible)"}
                </option>
              ))}
            </Select>
          </Label>
        ) : null}

        {selectedMotion ? (
          <Button size="xs" variant="outline" onClick={loadFromClip}>
            Editar el gráfico elegido ({templateNameEs(selectedMotion.template)})
          </Button>
        ) : null}

        {template ? (
          <>
            {template.description ? (
              <p className="text-xs text-muted-foreground">{template.description}</p>
            ) : null}
            <StillPreview
              template={template}
              props={props}
              width={settings.width}
              height={settings.height}
            />
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
              <MotionFields
                fields={fields}
                props={props}
                kit={kit.data}
                onChange={(key, v) =>
                  setProps((p) => {
                    const next = { ...p };
                    if (v === undefined) delete next[key];
                    else next[key] = v;
                    return next;
                  })
                }
                advancedExtra={
                  <>
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
                            {FORMAT_LABELS_ES[f]}
                          </option>
                        ))}
                      </Select>
                    </Label>
                    <p className="text-[11px] text-muted-foreground">
                      Motor: {ENGINE_LABELS_ES[template.engine]} ({template.engine})
                    </p>
                  </>
                }
              />
            </Section>
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
                <Plus /> Añadir sin renderizar
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

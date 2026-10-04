"use client";

import {
  AspectRatioSchema,
  defaultBurnSubtitles,
  hasAnimatedCaptions,
  type ExportPreset,
} from "@studio/shared";
import { Copy, Download, Rocket, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Label, Select } from "@/components/ui/input";
import { Badge, ErrorNotice, Progress, Section, Spinner } from "@/components/ui/misc";
import { saveProjectNow } from "@/hooks/use-project-sync";
import { api, errorMessage, fileUrl, isNotImplemented } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { createId } from "@/lib/ids";
import { projectDuration } from "@/lib/timeline";
import { useExportPresetsStore } from "@/stores/export-presets-store";
import {
  isTerminal,
  JOB_STATUS_LABELS,
  jobOutputPath,
  sortedJobs,
  useJobsStore,
} from "@/stores/jobs-store";
import { useProjectStore } from "@/stores/project-store";
import { Panel } from "./Panel";

const DEFAULT_PRESET_ID = "youtube-1080p";

function PresetEditor({
  preset,
  onChange,
}: {
  preset: ExportPreset;
  onChange: (p: ExportPreset) => void;
}) {
  const disabled = preset.builtIn;
  const num = (v: string) => (v === "" ? undefined : Number(v));
  return (
    <div className="grid grid-cols-2 gap-2">
      <Label className="col-span-2">
        Nombre
        <Input
          disabled={disabled}
          value={preset.name}
          onChange={(e) => onChange({ ...preset, name: e.target.value })}
        />
      </Label>
      <Label>
        Aspecto
        <Select
          disabled={disabled}
          value={preset.aspect}
          onChange={(e) =>
            onChange({ ...preset, aspect: e.target.value as ExportPreset["aspect"] })
          }
        >
          {AspectRatioSchema.options.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </Select>
      </Label>
      <Label>
        FPS
        <Input
          disabled={disabled}
          type="number"
          min={1}
          max={120}
          value={preset.fps}
          onChange={(e) => onChange({ ...preset, fps: Number(e.target.value) || preset.fps })}
        />
      </Label>
      <Label>
        Ancho
        <Input
          disabled={disabled}
          type="number"
          min={16}
          step={2}
          value={preset.width}
          onChange={(e) => onChange({ ...preset, width: Number(e.target.value) || preset.width })}
        />
      </Label>
      <Label>
        Alto
        <Input
          disabled={disabled}
          type="number"
          min={16}
          step={2}
          value={preset.height}
          onChange={(e) => onChange({ ...preset, height: Number(e.target.value) || preset.height })}
        />
      </Label>
      <Label>
        Contenedor
        <Select
          disabled={disabled}
          value={preset.container}
          onChange={(e) =>
            onChange({ ...preset, container: e.target.value as ExportPreset["container"] })
          }
        >
          <option value="mp4">MP4</option>
          <option value="webm">WebM</option>
          <option value="mov">MOV</option>
          <option value="gif">GIF</option>
        </Select>
      </Label>
      <Label>
        Códec de video
        <Select
          disabled={disabled}
          value={preset.videoCodec}
          onChange={(e) =>
            onChange({ ...preset, videoCodec: e.target.value as ExportPreset["videoCodec"] })
          }
        >
          <option value="h264">H.264</option>
          <option value="h265">H.265</option>
          <option value="vp9">VP9</option>
          <option value="prores">ProRes</option>
          <option value="gif">GIF</option>
        </Select>
      </Label>
      <Label>
        Calidad CRF (0–51)
        <Input
          disabled={disabled}
          type="number"
          min={0}
          max={51}
          value={preset.crf ?? ""}
          onChange={(e) => onChange({ ...preset, crf: num(e.target.value) })}
        />
      </Label>
      <Label>
        Bitrate video (kbps)
        <Input
          disabled={disabled}
          type="number"
          min={1}
          value={preset.videoBitrateKbps ?? ""}
          placeholder="usa CRF"
          onChange={(e) => onChange({ ...preset, videoBitrateKbps: num(e.target.value) })}
        />
      </Label>
      <Label>
        Códec de audio
        <Select
          disabled={disabled}
          value={preset.audioCodec}
          onChange={(e) =>
            onChange({ ...preset, audioCodec: e.target.value as ExportPreset["audioCodec"] })
          }
        >
          <option value="aac">AAC</option>
          <option value="opus">Opus</option>
          <option value="pcm">PCM</option>
        </Select>
      </Label>
      <Label>
        Bitrate audio (kbps)
        <Input
          disabled={disabled}
          type="number"
          min={32}
          value={preset.audioBitrateKbps}
          onChange={(e) =>
            onChange({
              ...preset,
              audioBitrateKbps: Number(e.target.value) || preset.audioBitrateKbps,
            })
          }
        />
      </Label>
      <label className="col-span-2 flex items-center gap-2 text-xs">
        <Checkbox
          disabled={disabled}
          checked={preset.alpha}
          onChange={(e) => onChange({ ...preset, alpha: e.target.checked })}
        />
        Transparencia (canal alfa: WebM VP9 o ProRes 4444)
      </label>
    </div>
  );
}

export function ExportPanel() {
  const { presets, source, error, load, save, remove } = useExportPresetsStore();
  const project = useProjectStore((s) => s.project);
  const jobs = useJobsStore((s) => s.jobs);
  // B5: start on YouTube 1080p (the list order comes from the api and may start elsewhere).
  const [presetId, setPresetId] = useState<string>(DEFAULT_PRESET_ID);
  const [draft, setDraft] = useState<ExportPreset | undefined>(undefined);
  const [useRange, setUseRange] = useState(false);
  const [range, setRange] = useState({ start: 0, end: 10 });
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  // undefined = automatic: burn subtitles unless an animated-captions clip already shows them.
  const [burnOverride, setBurnOverride] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    if (useExportPresetsStore.getState().source === "loading") void load();
  }, [load]);

  const selected = presets.find((p) => p.id === presetId) ?? presets[0];
  const editing = draft && draft.id === selected?.id ? draft : selected;
  const duration = projectDuration(project);
  const hasSubtitles = project.subtitles.length > 0;
  const animatedCaptions = hasAnimatedCaptions(project);
  const burnSubtitles = burnOverride ?? defaultBurnSubtitles(project);
  const exportJobs = useMemo(
    () =>
      sortedJobs(jobs)
        .filter((j) => j.type === "project.export")
        .slice(0, 5),
    [jobs],
  );

  const duplicate = () => {
    if (!selected) return;
    const copy: ExportPreset = {
      ...selected,
      id: createId("preset"),
      name: `${selected.name} (copia)`,
      builtIn: false,
    };
    void save(copy)
      .then(() => {
        setPresetId(copy.id);
        setDraft(copy);
      })
      .catch((err: unknown) =>
        toast.error("No se pudo duplicar", { description: errorMessage(err) }),
      );
  };

  const persist = () => {
    if (!editing || editing.builtIn) return;
    void save(editing)
      .then(() => toast.success("Preset guardado"))
      .catch((err: unknown) =>
        toast.error("No se pudo guardar", { description: errorMessage(err) }),
      );
  };

  const startExport = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await saveProjectNow();
      // The api may have assigned a new id while saving: read it after the save.
      const { jobId } = await api.exportProject(useProjectStore.getState().project.id, {
        presetId: selected.id,
        ...(useRange && range.end > range.start ? { range } : {}),
        ...(fileName.trim() ? { fileName: fileName.trim() } : {}),
        ...(hasSubtitles ? { burnSubtitles } : {}),
      });
      useJobsStore.getState().track(jobId, "project.export", { kind: "export" });
      toast.info("Exportación iniciada");
    } catch (err) {
      if (isNotImplemented(err)) toast.info("Exportar: módulo en desarrollo");
      else toast.error("No se pudo exportar", { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Exportar">
      <div className="flex flex-col gap-4">
        {error ? <ErrorNotice message={error} /> : null}
        <Section
          title="Preset"
          actions={
            source === "local" ? (
              <Badge tone="warning" title="La API de presets está en desarrollo">
                guardado local
              </Badge>
            ) : null
          }
        >
          <div className="flex gap-1">
            <Select
              aria-label="Preset de exportación"
              value={selected?.id ?? ""}
              onChange={(e) => {
                setPresetId(e.target.value);
                setDraft(undefined);
              }}
            >
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.builtIn ? "" : " ★"}
                </option>
              ))}
            </Select>
            <Button size="icon" variant="outline" aria-label="Duplicar preset" onClick={duplicate}>
              <Copy />
            </Button>
            {selected && !selected.builtIn ? (
              <Button
                size="icon"
                variant="outline"
                aria-label="Eliminar preset"
                onClick={() => {
                  void remove(selected.id).catch((err: unknown) =>
                    toast.error("No se pudo eliminar", { description: errorMessage(err) }),
                  );
                  setPresetId(DEFAULT_PRESET_ID);
                }}
              >
                <Trash2 />
              </Button>
            ) : null}
          </div>
          {editing ? <PresetEditor preset={editing} onChange={setDraft} /> : null}
          {editing?.builtIn ? (
            <p className="text-[11px] text-muted-foreground">
              Los presets incluidos no se editan: duplícalo para personalizarlo.
            </p>
          ) : (
            <Button size="sm" variant="outline" onClick={persist}>
              <Save /> Guardar preset
            </Button>
          )}
        </Section>

        <Section title="Exportación">
          <Label>
            Nombre del archivo (opcional)
            <Input
              value={fileName}
              placeholder={project.name}
              onChange={(e) => setFileName(e.target.value)}
            />
          </Label>
          {hasSubtitles ? (
            <label className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={burnSubtitles}
                onChange={(e) => setBurnOverride(e.target.checked)}
              />
              Quemar subtítulos en el video
              {animatedCaptions && burnSubtitles ? (
                <Badge tone="warning" title="Ya hay un clip de subtítulos animados en Motion">
                  saldrán dos veces
                </Badge>
              ) : null}
            </label>
          ) : null}
          <label className="flex items-center gap-2 text-xs">
            <Checkbox checked={useRange} onChange={(e) => setUseRange(e.target.checked)} />
            Exportar solo un rango (duración total {formatTime(duration)})
          </label>
          {useRange ? (
            <div className="grid grid-cols-2 gap-2">
              <Label>
                Desde (s)
                <Input
                  type="number"
                  min={0}
                  step={0.1}
                  value={range.start}
                  onChange={(e) =>
                    setRange((r) => ({ ...r, start: Math.max(0, Number(e.target.value)) }))
                  }
                />
              </Label>
              <Label>
                Hasta (s)
                <Input
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={range.end}
                  onChange={(e) =>
                    setRange((r) => ({ ...r, end: Math.max(0.1, Number(e.target.value)) }))
                  }
                />
              </Label>
            </div>
          ) : null}
          <Button disabled={busy || !selected || duration === 0} onClick={() => void startExport()}>
            {busy ? <Spinner /> : <Rocket />} Exportar
          </Button>
          {duration === 0 ? (
            <p className="text-[11px] text-muted-foreground">La línea de tiempo está vacía.</p>
          ) : null}
        </Section>

        {exportJobs.length > 0 ? (
          <Section title="Exportaciones recientes">
            <ul className="flex flex-col gap-1">
              {exportJobs.map((j) => {
                const path = jobOutputPath(j);
                return (
                  <li key={j.id} className="rounded-md border p-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span>{JOB_STATUS_LABELS[j.status]}</span>
                      {path ? (
                        <a
                          className="inline-flex items-center gap-1 text-primary hover:underline"
                          href={fileUrl(path)}
                          download
                        >
                          <Download className="size-3.5" /> Descargar
                        </a>
                      ) : null}
                    </div>
                    {!isTerminal(j) ? <Progress value={j.progress} className="mt-1" /> : null}
                  </li>
                );
              })}
            </ul>
          </Section>
        ) : null}
      </div>
    </Panel>
  );
}

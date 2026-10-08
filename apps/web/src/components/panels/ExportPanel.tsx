"use client";

import {
  ASPECT_FIT_HELP_ES,
  ASPECT_FIT_LABELS_ES,
  ASPECT_FIT_OPTIONS,
  AspectRatioSchema,
  aspectLabel,
  effectiveBurnSubtitles,
  formatErrorEs,
  formatLufsEs,
  hasAnimatedCaptions,
  inferTrackRole,
  loudnessFor,
  needsAspectChoice,
  orientationEs,
  sameAspect,
  TRACK_ROLE_LABELS_ES,
  TrackRoleSchema,
  type AspectFit,
  type ExportPreset,
  type Job,
  type TrackRole,
} from "@studio/shared";
import {
  Copy,
  Download,
  FolderOpen,
  Rocket,
  Save,
  ScanFace,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Label, Select } from "@/components/ui/input";
import { Badge, ErrorNotice, Progress, Section, Spinner } from "@/components/ui/misc";
import { saveProjectNow } from "@/hooks/use-project-sync";
import { api, errorMessage, fileUrl, isNotImplemented } from "@/lib/api";
import { aspectChoiceDetails, exportResultOf, formatBytesEs, revealExport } from "@/lib/api-export";
import { formatTime } from "@/lib/format";
import { createId } from "@/lib/ids";
import { cn } from "@/lib/utils";
import { projectDuration } from "@/lib/timeline";
import { useExportPresetsStore } from "@/stores/export-presets-store";
import {
  isTerminal,
  JOB_STATUS_LABELS,
  jobOutputPath,
  sortedJobs,
  useJobsStore,
} from "@/stores/jobs-store";
import { useMediaStore } from "@/stores/media-store";
import { usePreviewStore } from "@/stores/preview-store";
import { useProjectStore } from "@/stores/project-store";
import { Panel } from "./Panel";
import { SocialReview } from "./SocialReview";

/** Decision «9:16 principal» (PLAN-BASE v3): Reels / TikTok is the first card and the default. */
const DEFAULT_PRESET_ID = "reels-tiktok";

/** «¿Dónde lo vas a publicar?» cards (H17); «Otro» shows the full preset list. */
export const DESTINATIONS = [
  { id: "reels-tiktok", label: "Reels / TikTok", hint: "Vertical 9:16" },
  { id: "youtube-shorts", label: "YouTube Shorts", hint: "Vertical 9:16" },
  { id: "youtube-1080p", label: "YouTube 1080p", hint: "Horizontal 16:9" },
  { id: "youtube-4k", label: "YouTube 4K", hint: "Horizontal 16:9" },
] as const;
const DESTINATION_IDS: readonly string[] = DESTINATIONS.map((d) => d.id);

/** Last export jobs of the project (newest first). */
export function lastExportJob(jobs: Record<string, Job>, projectId: string): Job | undefined {
  return sortedJobs(jobs).find(
    (j) =>
      j.type === "project.export" &&
      j.status === "succeeded" &&
      (j.projectId === undefined || j.projectId === projectId),
  );
}

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
  const inOut = useProjectStore((s) => s.inOut);
  const assets = useMediaStore((s) => s.assets);
  const jobs = useJobsStore((s) => s.jobs);
  const [presetId, setPresetId] = useState<string>(DEFAULT_PRESET_ID);
  const [other, setOther] = useState(false);
  const [draft, setDraft] = useState<ExportPreset | undefined>(undefined);
  const [useRange, setUseRange] = useState(false);
  const [useInOut, setUseInOut] = useState(false);
  const [range, setRange] = useState({ start: 0, end: 10 });
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [aspectFit, setAspectFit] = useState<AspectFit | undefined>(undefined);
  const [normalize, setNormalize] = useState(true);
  // Integration (M3 ↔ M2): saved in project.audioMix so «Bajar la música» persists.
  const autoDuck = project.audioMix?.autoDuck ?? true;
  const setAutoDuck = (on: boolean) => useProjectStore.getState().setAudioMix({ autoDuck: on });
  const socialRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (useExportPresetsStore.getState().source === "loading") void load();
  }, [load]);

  const selected = presets.find((p) => p.id === presetId) ?? presets[0];
  const editing = draft && draft.id === selected?.id ? draft : selected;
  const duration = projectDuration(project);
  const hasSubtitles = project.subtitles.length > 0;
  const animatedCaptions = hasAnimatedCaptions(project);
  // Stored in the project so the preview shows exactly what the export burns (feedback 2).
  const burnSubtitles = effectiveBurnSubtitles(project);
  const exportJobs = useMemo(
    () =>
      sortedJobs(jobs)
        .filter((j) => j.type === "project.export")
        .slice(0, 5),
    [jobs],
  );
  const last = useMemo(() => lastExportJob(jobs, project.id), [jobs, project.id]);
  const canvas = { width: project.settings.width, height: project.settings.height };
  const hasReframe = (project.reframe?.keyframes.length ?? 0) > 0;
  const choiceNeeded = selected ? needsAspectChoice(canvas, selected, project.reframe) : false;
  const usesReframe =
    !!selected &&
    hasReframe &&
    !sameAspect(canvas, selected) &&
    !needsAspectChoice(canvas, selected);
  const reframeMissing = choiceNeeded && aspectFit === "reframe";
  const target = selected ? loudnessFor(selected) : null;
  const audioTracks = project.tracks.filter(
    (t) => (t.kind === "audio" || t.kind === "video") && t.clips.length > 0,
  );
  const assetOf = (id: string) => assets[id];
  const blockedReason =
    duration === 0
      ? "La línea de tiempo está vacía."
      : choiceNeeded && !aspectFit
        ? "Elegí cómo encuadrar el video antes de exportar."
        : reframeMissing
          ? "Primero reencuadrá el video siguiendo la cara."
          : undefined;

  const choosePreset = (id: string) => {
    setPresetId(id);
    setDraft(undefined);
    setAspectFit(undefined);
  };

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
        setOther(true);
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

  const exportRange = () => {
    if (useInOut && inOut && inOut.out > inOut.in) return { start: inOut.in, end: inOut.out };
    if (useRange && range.end > range.start) return range;
    return undefined;
  };

  const startExport = async () => {
    if (!selected || blockedReason) return;
    setBusy(true);
    try {
      await saveProjectNow();
      // The api may have assigned a new id while saving: read it after the save.
      const r = exportRange();
      const { jobId } = await api.exportProject(useProjectStore.getState().project.id, {
        presetId: selected.id,
        ...(r ? { range: r } : {}),
        ...(fileName.trim() ? { fileName: fileName.trim() } : {}),
        ...(hasSubtitles ? { burnSubtitles } : {}),
        ...(choiceNeeded && aspectFit ? { aspectFit } : {}),
        ...(target && !normalize ? { normalizeLoudness: false } : {}),
        autoDuck,
      });
      useJobsStore.getState().track(jobId, "project.export", { kind: "export" });
      toast.info("Exportación iniciada");
    } catch (err) {
      if (isNotImplemented(err)) toast.info("Exportar: módulo en desarrollo");
      else if (aspectChoiceDetails(err)) {
        setAspectFit(undefined);
        toast.warning("Elegí cómo encuadrar el video", { description: errorMessage(err) });
      } else toast.error("No se pudo exportar", { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const destinationCard = (d: (typeof DESTINATIONS)[number]) => {
    const active = !other && selected?.id === d.id;
    return (
      <button
        key={d.id}
        type="button"
        aria-pressed={active}
        data-testid={`export-dest-${d.id}`}
        onClick={() => {
          setOther(false);
          choosePreset(d.id);
        }}
        className={cn(
          "flex flex-col items-start rounded-md border p-2 text-left text-xs transition-colors",
          active ? "border-primary bg-primary/10" : "hover:bg-accent",
        )}
      >
        <span className="font-medium">{d.label}</span>
        <span className="text-[11px] text-muted-foreground">{d.hint}</span>
      </button>
    );
  };

  return (
    <Panel title="Exportar">
      <div className="flex flex-col gap-4">
        {error ? <ErrorNotice message={error} /> : null}
        <Section
          title="¿Dónde lo vas a publicar?"
          actions={
            source === "local" ? (
              <Badge tone="warning" title="La API de presets está en desarrollo">
                guardado local
              </Badge>
            ) : null
          }
        >
          <div className="grid grid-cols-2 gap-1" role="group" aria-label="Destino">
            {DESTINATIONS.map(destinationCard)}
            <button
              type="button"
              aria-pressed={other || !DESTINATION_IDS.includes(selected?.id ?? "")}
              data-testid="export-dest-other"
              onClick={() => setOther(true)}
              className={cn(
                "flex flex-col items-start rounded-md border p-2 text-left text-xs transition-colors",
                other ? "border-primary bg-primary/10" : "hover:bg-accent",
              )}
            >
              <span className="font-medium">Otro</span>
              <span className="text-[11px] text-muted-foreground">GIF, WebM, propios…</span>
            </button>
          </div>
          {other ? (
            <div className="flex gap-1">
              <Select
                aria-label="Preset de exportación"
                value={selected?.id ?? ""}
                onChange={(e) => choosePreset(e.target.value)}
              >
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.builtIn ? "" : " ★"}
                  </option>
                ))}
              </Select>
              <Button
                size="icon"
                variant="outline"
                aria-label="Duplicar preset"
                onClick={duplicate}
              >
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
                    choosePreset(DEFAULT_PRESET_ID);
                  }}
                >
                  <Trash2 />
                </Button>
              ) : null}
            </div>
          ) : null}
          {selected ? (
            <p className="text-[11px] text-muted-foreground" data-testid="export-preset-summary">
              {selected.name}: {selected.width}×{selected.height}, {selected.fps} fps,{" "}
              {selected.container.toUpperCase()}
            </p>
          ) : null}

          {choiceNeeded ? (
            <fieldset
              className="flex flex-col gap-1 rounded-md border border-amber-500/50 bg-amber-500/5 p-2"
              data-testid="export-aspect-choice"
            >
              <legend className="px-1 text-xs font-medium">
                El video es {orientationEs(canvas.width, canvas.height)} y «{selected?.name}» es{" "}
                {selected ? aspectLabel(selected.width, selected.height) : ""}: ¿cómo lo encuadro?
              </legend>
              {ASPECT_FIT_OPTIONS.map((fit) => (
                <label key={fit} className="flex items-start gap-2 text-xs">
                  <input
                    type="radio"
                    name="aspect-fit"
                    className="mt-0.5"
                    checked={aspectFit === fit}
                    onChange={() => setAspectFit(fit)}
                  />
                  <span>
                    <span className="font-medium">{ASPECT_FIT_LABELS_ES[fit]}</span>
                    {fit === "reframe" ? " (recomendado)" : ""}
                    <span className="block text-[11px] text-muted-foreground">
                      {ASPECT_FIT_HELP_ES[fit]}
                    </span>
                  </span>
                </label>
              ))}
              {reframeMissing ? (
                <div className="flex flex-wrap items-center gap-2 rounded bg-background p-1.5 text-[11px]">
                  <span className="flex-1">
                    {formatErrorEs("REFRAME_REQUIRED")} Cuando termine, volvé acá y exportá.
                  </span>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => usePreviewStore.getState().setReframeOpen(true)}
                  >
                    <ScanFace /> Abrir Reencuadrar
                  </Button>
                </div>
              ) : null}
            </fieldset>
          ) : usesReframe ? (
            <p className="text-[11px] text-muted-foreground" data-testid="export-uses-reframe">
              Usa el reencuadre del proyecto ({project.reframe?.target}): sigue al sujeto, sin
              franjas.
            </p>
          ) : null}

          <details className="rounded-md border p-2 text-xs" data-testid="export-advanced">
            <summary className="cursor-pointer font-medium">Avanzado</summary>
            <div className="mt-2 flex flex-col gap-2">
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
              {!other ? (
                <Button size="sm" variant="ghost" onClick={duplicate}>
                  <Copy /> Duplicar este preset
                </Button>
              ) : null}
            </div>
          </details>
        </Section>

        <Section title="Sonido">
          {target ? (
            <label className="flex items-center gap-2 text-xs">
              <Checkbox checked={normalize} onChange={(e) => setNormalize(e.target.checked)} />
              Normalizar a {formatLufsEs(target.integrated)} (recomendado para redes)
            </label>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Este formato no normaliza el sonido.
            </p>
          )}
          <label className="flex items-center gap-2 text-xs">
            <Checkbox checked={autoDuck} onChange={(e) => setAutoDuck(e.target.checked)} />
            Bajar la música cuando hay voz
          </label>
          {audioTracks.length > 0 ? (
            <ul className="flex flex-col gap-1" aria-label="Rol de cada pista">
              {audioTracks.map((t) => {
                const auto = inferTrackRole({ ...t, role: undefined }, assetOf);
                return (
                  <li key={t.id} className="flex items-center gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate">{t.name}</span>
                    <Select
                      aria-label={`Rol de la pista ${t.name}`}
                      className="h-7 w-36 text-xs"
                      value={t.role ?? ""}
                      onChange={(e) =>
                        useProjectStore.getState().updateTrack(t.id, {
                          role: (e.target.value || undefined) as TrackRole | undefined,
                        })
                      }
                    >
                      <option value="">Automático ({TRACK_ROLE_LABELS_ES[auto]})</option>
                      {TrackRoleSchema.options.map((r) => (
                        <option key={r} value={r}>
                          {TRACK_ROLE_LABELS_ES[r]}
                        </option>
                      ))}
                    </Select>
                  </li>
                );
              })}
            </ul>
          ) : null}
          <p className="text-[10px] text-muted-foreground">
            La música baja unos 12 dB mientras suena una pista de Voz (las de video cuentan como
            voz).
          </p>
        </Section>

        <div ref={socialRef}>
          <SocialReview lastExport={last} />
        </div>

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
                onChange={(e) => useProjectStore.getState().setBurnSubtitles(e.target.checked)}
              />
              Quemar subtítulos en el video
              {animatedCaptions && burnSubtitles ? (
                <Badge
                  tone="muted"
                  title="Los tramos que ya muestra un clip de subtítulos animados no se queman otra vez"
                >
                  salvo bajo los animados
                </Badge>
              ) : null}
            </label>
          ) : null}
          {inOut && inOut.out > inOut.in ? (
            <label className="flex items-center gap-2 text-xs">
              <Checkbox checked={useInOut} onChange={(e) => setUseInOut(e.target.checked)} />
              Solo el rango I–O ({formatTime(inOut.in)} – {formatTime(inOut.out)})
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
          <Button
            disabled={busy || !selected || !!blockedReason}
            title={blockedReason}
            onClick={() => void startExport()}
          >
            {busy ? <Spinner /> : <Rocket />} Exportar
          </Button>
          {blockedReason ? (
            <p className="text-[11px] text-muted-foreground" data-testid="export-blocked">
              {blockedReason}
            </p>
          ) : null}
        </Section>

        {last ? (
          <ExportResultCard
            job={last}
            onReview={() => socialRef.current?.scrollIntoView({ behavior: "smooth" })}
          />
        ) : null}

        {exportJobs.length > 0 ? (
          <Section title="Exportaciones recientes">
            <ul className="flex flex-col gap-1">
              {exportJobs.map((j) => {
                const path = jobOutputPath(j);
                return (
                  <li key={j.id} className="rounded-md border p-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span>
                        {JOB_STATUS_LABELS[j.status]}
                        {!isTerminal(j) && j.message ? ` · ${j.message}` : ""}
                      </span>
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

/** Result of the last export: thumbnail, path, duration, size, loudness, «Abrir carpeta», «Revisar». */
function ExportResultCard({ job, onReview }: { job: Job; onReview: () => void }) {
  const result = exportResultOf(job);
  if (!result) return null;
  const reveal = () =>
    void revealExport(result.path).catch((err: unknown) =>
      toast.error("No se pudo abrir la carpeta", { description: errorMessage(err) }),
    );
  return (
    <Section title="Último resultado">
      <div className="flex gap-2 rounded-md border p-2 text-xs" data-testid="export-result">
        <video
          src={`${fileUrl(result.path)}#t=0.5`}
          preload="metadata"
          muted
          className="h-20 w-20 shrink-0 rounded bg-black object-contain"
          aria-label="Miniatura del video exportado"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate font-mono text-[11px]" title={result.path}>
            {result.path}
          </span>
          <span className="flex flex-wrap gap-1">
            {result.durationS !== undefined ? (
              <Badge tone="muted">{formatTime(result.durationS)}</Badge>
            ) : null}
            {result.sizeBytes !== undefined ? (
              <Badge tone="muted">{formatBytesEs(result.sizeBytes)}</Badge>
            ) : null}
            {result.loudness ? (
              <Badge tone="success" data-testid="export-result-lufs">
                {formatLufsEs(result.loudness.output_i)}
              </Badge>
            ) : null}
            {result.ducked ? <Badge tone="muted">Música bajo la voz</Badge> : null}
            {result.aspectFit ? (
              <Badge tone={result.aspectFit === "blur" ? "warning" : "muted"}>
                {ASPECT_FIT_LABELS_ES[result.aspectFit]}
              </Badge>
            ) : null}
          </span>
          {(result.warnings ?? []).includes("LOUDNESS_MEASURE_FAILED") ? (
            <span className="text-[11px] text-amber-700 dark:text-amber-300">
              {formatErrorEs("LOUDNESS_MEASURE_FAILED", { causa: "ver el registro del trabajo" })}
            </span>
          ) : null}
          <span className="flex flex-wrap gap-1">
            <Button size="xs" variant="outline" onClick={reveal}>
              <FolderOpen /> Abrir carpeta
            </Button>
            <Button size="xs" variant="outline" onClick={onReview}>
              <ShieldCheck /> Revisar
            </Button>
            <a
              className="inline-flex items-center gap-1 text-primary hover:underline"
              href={fileUrl(result.path)}
              download
            >
              <Download className="size-3.5" /> Descargar
            </a>
          </span>
        </div>
      </div>
    </Section>
  );
}

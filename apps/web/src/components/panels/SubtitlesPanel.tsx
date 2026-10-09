"use client";

import {
  MotionSpecSchema,
  videoRectAt,
  WhisperModelSchema,
  type MotionSpecInput,
  type WhisperModel,
} from "@studio/shared";
import { Download, Plus, Scissors, Sparkles, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  hasAudio,
  SelectedClipHint,
  useSelectedClip,
  type SelectedClip,
} from "@/components/common/SelectedClipInfo";
import { useAiAvailability } from "@/hooks/use-ai-availability";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Label, Select } from "@/components/ui/input";
import { EmptyState, Section, Spinner } from "@/components/ui/misc";
import { api, errorMessage, isNotImplemented } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { warnIfCpu } from "@/lib/gpu-preflight";
import { createId } from "@/lib/ids";
import { animatedCaptionsProps, toSrt } from "@/lib/subtitles";
import {
  CAPTION_STYLES,
  useCaptionStyleStore,
  type CaptionStyle,
} from "@/stores/caption-style-store";
import { useJobsStore } from "@/stores/jobs-store";
import { useMediaStore } from "@/stores/media-store";
import { useProjectStore } from "@/stores/project-store";
import { useSilencesStore } from "@/stores/silences-store";
import { Panel } from "./Panel";

const LANGUAGES = [
  { value: "es", label: "Español" },
  { value: "en", label: "Inglés" },
  { value: "pt", label: "Portugués" },
  { value: "fr", label: "Francés" },
  { value: "it", label: "Italiano" },
  { value: "de", label: "Alemán" },
  { value: "auto", label: "Detectar" },
];

function StylePicker() {
  const style = useCaptionStyleStore((s) => s.style);
  const { setStyle, patch } = useCaptionStyleStore.getState();
  return (
    <Section title="Estilo de subtítulos">
      <div className="grid grid-cols-2 gap-1">
        {CAPTION_STYLES.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-pressed={style.id === s.id}
            onClick={() => setStyle(s)}
            className="rounded-md border bg-neutral-900 p-2 text-center aria-pressed:ring-2 aria-pressed:ring-primary"
          >
            <span
              className="rounded px-1 text-xs font-bold"
              style={{
                fontFamily: s.fontFamily,
                color: s.color,
                background: s.background || undefined,
                textTransform: s.uppercase ? "uppercase" : undefined,
              }}
            >
              {s.name.split(" ")[0]} <span style={{ color: s.highlightColor }}>Aa</span>
            </span>
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Label>
          Tamaño
          <Input
            type="number"
            min={12}
            max={200}
            value={style.fontSize}
            onChange={(e) => patch({ fontSize: Number(e.target.value) || style.fontSize })}
          />
        </Label>
        <Label>
          Posición
          <Select
            value={style.position}
            onChange={(e) => patch({ position: e.target.value as CaptionStyle["position"] })}
          >
            <option value="top">Arriba</option>
            <option value="center">Centro</option>
            <option value="bottom">Abajo</option>
          </Select>
        </Label>
        <Label>
          Color
          <Input
            type="color"
            value={style.color}
            onChange={(e) => patch({ color: e.target.value })}
          />
        </Label>
        <Label>
          Resaltado
          <Input
            type="color"
            value={style.highlightColor}
            onChange={(e) => patch({ highlightColor: e.target.value })}
          />
        </Label>
        <Label>
          Animación
          <Select
            value={style.animation}
            onChange={(e) => patch({ animation: e.target.value as CaptionStyle["animation"] })}
          >
            <option value="none">Ninguna</option>
            <option value="fade">Fundido</option>
            <option value="pop">Pop</option>
            <option value="karaoke">Karaoke</option>
          </Select>
        </Label>
        <label className="flex items-center gap-2 self-end pb-1 text-xs">
          <Checkbox
            checked={style.uppercase}
            onChange={(e) => patch({ uppercase: e.target.checked })}
          />
          Mayúsculas
        </label>
      </div>
    </Section>
  );
}

export function SubtitlesPanel() {
  const sel = useSelectedClip();
  const subtitles = useProjectStore((s) => s.project.subtitles);
  const settings = useProjectStore((s) => s.project.settings);
  const [language, setLanguage] = useState("es");
  const [model, setModel] = useState<WhisperModel | "">("");
  const [busy, setBusy] = useState(false);
  const [gapMs, setGapMs] = useState(600);
  const store = useProjectStore.getState;
  const hasWords = subtitles.some((s) => s.words?.length);

  const removeSilences = () => {
    if (!sel) return;
    const removed = store().removeSilences(sel.clip.id, gapMs / 1000);
    if (removed > 0)
      toast.success(`Se quitaron ${removed.toFixed(1).replace(".", ",")} s de silencios`, {
        description: "Si había subtítulos animados renderizados, vuelve a renderizarlos.",
      });
    else toast.message(`No hay pausas de más de ${gapMs} ms en el clip seleccionado`);
  };

  // Sprint 5 (H26): the empty state transcribes the first video/audio clip when none is selected.
  const project = useProjectStore((s) => s.project);
  const assets = useMediaStore((s) => s.assets);
  const firstWithVoice = useMemo((): SelectedClip | undefined => {
    for (const track of project.tracks) {
      if (track.kind !== "video" && track.kind !== "audio") continue;
      const clip = [...track.clips].sort((a, b) => a.start - b.start).find((c) => c.assetId);
      if (clip) return { clip, track, asset: assets[clip.assetId!] };
    }
    return undefined;
  }, [project, assets]);
  const ai = useAiAvailability("transcribe");
  const transcribeTarget = hasAudio(sel) ? sel : firstWithVoice;

  const transcribe = async (target: SelectedClip | undefined = sel) => {
    const sel = target;
    if (!hasAudio(sel)) return;
    setBusy(true);
    try {
      await warnIfCpu("transcribe");
      const { jobId } = await api.transcribe({
        assetId: sel.clip.assetId,
        language,
        wordTimestamps: true,
        ...(model ? { model } : {}),
      });
      useJobsStore
        .getState()
        .track(jobId, "subtitles.transcribe", { kind: "transcript", clipId: sel.clip.id });
      toast.info("Transcribiendo…");
    } catch (err) {
      if (isNotImplemented(err)) toast.info("Transcripción: módulo en desarrollo");
      else toast.error("No se pudo transcribir", { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const renderAsMotion = async () => {
    // A valid MotionSpec for `animated-captions`: word-level `transcript` (not `segments`) and the
    // caption style mapped to template props (not the CaptionStyle object).
    const built = animatedCaptionsProps(
      subtitles,
      useCaptionStyleStore.getState().style,
      language === "auto" ? undefined : language,
    );
    if (!built) return;
    const span = { start: built.start, end: built.start + built.durationSec };
    // Feedback 4: lay the captions out inside the video (e.g. a vertical clip in a 16:9 canvas).
    const assets = useMediaStore.getState().assets;
    const rect = videoRectAt(
      store().project,
      (id) => {
        const a = assets[id];
        return a?.width && a.height ? { width: a.width, height: a.height } : undefined;
      },
      span.start,
    );
    const pct = (v: number, of: number) => Math.round((v / of) * 10_000) / 100;
    const videoRect = {
      x: pct(rect.x, settings.width),
      y: pct(rect.y, settings.height),
      width: Math.max(1, pct(rect.width, settings.width)),
      height: Math.max(1, pct(rect.height, settings.height)),
    };
    if (videoRect.width < 99.5 || videoRect.height < 99.5) built.props.videoRect = videoRect;
    const spec: MotionSpecInput = {
      engine: "remotion",
      template: "animated-captions",
      props: built.props,
      durationSec: built.durationSec,
      fps: Math.round(settings.fps),
      width: settings.width,
      height: settings.height,
      format: "webm-vp9-alpha",
    };
    const clip = store().addClip("motion", {
      id: createId("clp"),
      start: span.start,
      in: 0,
      out: span.end - span.start,
      speed: 1,
      volume: 1,
      opacity: 1,
      voiceEffects: [],
      motion: MotionSpecSchema.parse(spec),
    });
    try {
      const { jobId } = await api.renderMotion(spec, {
        projectId: store().project.id,
        clipId: clip.id,
      });
      useJobsStore
        .getState()
        .track(jobId, "motion.render", { kind: "setMotionRender", clipId: clip.id });
      toast.info("Renderizando subtítulos animados…");
    } catch (err) {
      if (isNotImplemented(err))
        toast.info("Render de motion: módulo en desarrollo (el clip quedó en la pista Motion)");
      else toast.error("No se pudo renderizar", { description: errorMessage(err) });
    }
  };

  const downloadSrt = () => {
    const blob = new Blob([toSrt(subtitles)], { type: "application/x-subrip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "subtitulos.srt";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Panel title="Subtítulos">
      <div className="flex flex-col gap-4">
        <Section title="Transcribir (Whisper)">
          <SelectedClipHint sel={sel} need="Selecciona un clip con voz para transcribirlo." />
          <div className="grid grid-cols-2 gap-2">
            <Label>
              Idioma
              <Select value={language} onChange={(e) => setLanguage(e.target.value)}>
                {LANGUAGES.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </Select>
            </Label>
            <Label>
              Modelo
              <Select value={model} onChange={(e) => setModel(e.target.value as WhisperModel | "")}>
                <option value="">Por defecto</option>
                {WhisperModelSchema.options.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
            </Label>
          </div>
          <Button
            size="sm"
            disabled={busy || !hasAudio(sel) || !ai.enabled}
            disabledReason={ai.reason_es}
            onClick={() => void transcribe()}
          >
            {busy ? <Spinner /> : null} Transcribir clip
          </Button>
        </Section>

        <Section title="Quitar silencios y muletillas">
          <p className="text-[11px] text-muted-foreground">
            Analiza el clip seleccionado (pausas y muletillas como «eh», «este», «o sea»), te
            muestra cada corte para revisarlo y escucharlo, y aplica solo los que marques.
          </p>
          <Button
            size="sm"
            disabled={!hasAudio(sel)}
            tooltip={hasAudio(sel) ? undefined : "Selecciona un clip con voz"}
            onClick={() => sel && useSilencesStore.getState().open(sel.clip.id)}
          >
            <Scissors /> Quitar silencios y muletillas…
          </Button>
          <div className="flex items-end gap-2">
            <Label className="w-32">
              Pausa mínima (ms)
              <Input
                type="number"
                min={150}
                step={50}
                value={gapMs}
                onChange={(e) => setGapMs(Math.max(150, Number(e.target.value) || 600))}
              />
            </Label>
            <Button
              size="sm"
              variant="outline"
              disabled={!hasAudio(sel) || !hasWords}
              tooltip={
                hasWords
                  ? "Sin revisión: quita las pausas entre palabras de la transcripción"
                  : "Transcribe el clip primero"
              }
              onClick={removeSilences}
            >
              Corte rápido
            </Button>
          </div>
        </Section>

        <Section
          title={`Segmentos (${subtitles.length})`}
          actions={
            <div className="flex gap-1">
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Añadir segmento en el cursor"
                tip="subAdd"
                onClick={() => store().addSubtitle()}
              >
                <Plus />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Descargar SRT"
                tip="subSrt"
                disabled={subtitles.length === 0}
                disabledReason="Todavía no hay subtítulos"
                onClick={downloadSrt}
              >
                <Download />
              </Button>
            </div>
          }
        >
          {subtitles.length === 0 ? (
            <EmptyState>
              <span data-testid="subtitles-empty" className="flex flex-col items-center gap-2">
                <span>
                  Todavía no hay subtítulos. Transcribí el video para generarlos (o agregá uno con
                  +).
                </span>
                <Button
                  size="sm"
                  disabled={busy || !ai.enabled || !hasAudio(transcribeTarget)}
                  disabledReason={
                    !ai.enabled
                      ? ai.reason_es
                      : !hasAudio(transcribeTarget)
                        ? "Primero agregá un video o un audio con voz a la línea de tiempo"
                        : undefined
                  }
                  tooltip="Transcribe con Whisper el clip elegido (o el primero con voz)"
                  onClick={() => void transcribe(transcribeTarget)}
                >
                  Transcribir el video
                </Button>
              </span>
            </EmptyState>
          ) : null}
          <ol className="flex flex-col gap-1">
            {subtitles.map((s, i) => (
              <li key={i} className="rounded-md border p-1.5">
                <div className="mb-1 flex items-center gap-1">
                  <button
                    type="button"
                    className="font-mono text-[11px] text-primary hover:underline"
                    onClick={() => store().setPlayhead(s.start)}
                  >
                    {formatTime(s.start)}
                  </button>
                  <Input
                    aria-label="Inicio (s)"
                    type="number"
                    step={0.01}
                    min={0}
                    className="h-6 w-20 text-xs"
                    value={Number(s.start.toFixed(2))}
                    onChange={(e) =>
                      store().updateSubtitle(i, { start: Math.max(0, Number(e.target.value)) })
                    }
                  />
                  <span className="text-xs">→</span>
                  <Input
                    aria-label="Fin (s)"
                    type="number"
                    step={0.01}
                    min={0}
                    className="h-6 w-20 text-xs"
                    value={Number(s.end.toFixed(2))}
                    onChange={(e) =>
                      store().updateSubtitle(i, { end: Math.max(0, Number(e.target.value)) })
                    }
                  />
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="ml-auto"
                    aria-label="Eliminar segmento"
                    tip="subDel"
                    onClick={() => store().removeSubtitle(i)}
                  >
                    <Trash2 />
                  </Button>
                </div>
                <Input
                  aria-label="Texto del segmento"
                  className="text-xs"
                  value={s.text}
                  // Editing text invalidates word timings.
                  onChange={(e) =>
                    store().updateSubtitle(i, { text: e.target.value, words: undefined })
                  }
                />
              </li>
            ))}
          </ol>
        </Section>

        <StylePicker />

        <Button size="sm" disabled={subtitles.length === 0} onClick={() => void renderAsMotion()}>
          <Sparkles /> Renderizar subtítulos como motion
        </Button>
      </div>
    </Panel>
  );
}

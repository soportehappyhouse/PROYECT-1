"use client";

import {
  MotionSpecSchema,
  WhisperModelSchema,
  type MotionSpecInput,
  type WhisperModel,
} from "@studio/shared";
import { Download, Plus, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { hasAudio, SelectedClipHint, useSelectedClip } from "@/components/common/SelectedClipInfo";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Label, Select } from "@/components/ui/input";
import { EmptyState, Section, Spinner } from "@/components/ui/misc";
import { api, errorMessage, isNotImplemented } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { createId } from "@/lib/ids";
import { subtitlesSpan, toSrt } from "@/lib/subtitles";
import {
  CAPTION_STYLES,
  useCaptionStyleStore,
  type CaptionStyle,
} from "@/stores/caption-style-store";
import { useJobsStore } from "@/stores/jobs-store";
import { useProjectStore } from "@/stores/project-store";
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
  const store = useProjectStore.getState;

  const transcribe = async () => {
    if (!hasAudio(sel)) return;
    setBusy(true);
    try {
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
    const span = subtitlesSpan(subtitles);
    if (!span) return;
    const style = useCaptionStyleStore.getState().style;
    const spec: MotionSpecInput = {
      engine: "remotion",
      template: "animated-captions",
      props: {
        segments: subtitles.map((s) => ({
          ...s,
          start: s.start - span.start,
          end: s.end - span.start,
          words: s.words?.map((w) => ({
            ...w,
            start: w.start - span.start,
            end: w.end - span.start,
          })),
        })),
        style,
      },
      durationSec: span.end - span.start,
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
          <Button size="sm" disabled={busy || !hasAudio(sel)} onClick={() => void transcribe()}>
            {busy ? <Spinner /> : null} Transcribir clip
          </Button>
        </Section>

        <Section
          title={`Segmentos (${subtitles.length})`}
          actions={
            <div className="flex gap-1">
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Añadir segmento en el cursor"
                onClick={() => store().addSubtitle()}
              >
                <Plus />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Descargar SRT"
                disabled={subtitles.length === 0}
                onClick={downloadSrt}
              >
                <Download />
              </Button>
            </div>
          }
        >
          {subtitles.length === 0 ? <EmptyState>Sin subtítulos todavía.</EmptyState> : null}
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

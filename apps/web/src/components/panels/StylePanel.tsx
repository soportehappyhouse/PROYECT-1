"use client";

import {
  AGENT_KNOWN_PRESET_IDS,
  CAPTION_STYLE_IDS,
  STYLE_CANVASES,
  STYLE_TRANSITION_TYPES,
  STYLE_VISION_DEFAULT_MODEL,
  type StyleAnalysisRecord,
  type StylePreset,
  type StylePresetDraft,
} from "@studio/shared";
import {
  Bot,
  Clapperboard,
  Pencil,
  Plus,
  RefreshCw,
  ScanSearch,
  Sparkles,
  TerminalSquare,
  Trash2,
  Wand2,
} from "lucide-react";
import { useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Label, Select, Textarea } from "@/components/ui/input";
import {
  Badge,
  EmptyState,
  ErrorNotice,
  NotImplementedNotice,
  Progress,
  Section,
  Spinner,
} from "@/components/ui/misc";
import { fileUrl } from "@/lib/api";
import { useJobsStore } from "@/stores/jobs-store";
import { useMediaStore } from "@/stores/media-store";
import { useStyleStore, type StyleDraftOrigin } from "@/stores/style-store";
import { Panel } from "./Panel";

const ORIGIN_LABELS: Record<StyleDraftOrigin, string> = {
  manual: "a mano",
  "local-llm": "modelo local",
  claude: "Consola Claude",
};

const POSITION_LABELS = { top: "Arriba", center: "Centro", bottom: "Abajo" } as const;
const TRANSITION_LABELS: Record<(typeof STYLE_TRANSITION_TYPES)[number], string> = {
  cut: "Corte seco",
  fade: "Fundido",
  crossfade: "Fundido cruzado",
  wipe: "Barrido",
  slide: "Deslizamiento",
  zoom: "Zoom",
};
const MOTION_LEVEL = { static: "cámara fija", low: "poco movimiento", high: "mucho movimiento" };

const pct = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(n * 100)} %`);
const sec = (n: number) => `${n.toFixed(1).replace(".", ",")} s`;
const yesNo = (b: boolean | null | undefined) => (b == null ? "no se sabe" : b ? "sí" : "no");

/** One-line summary of a preset for the list. */
export function presetSummary(p: StylePresetDraft): string {
  const parts = [
    p.canvas,
    `plano ~${sec(p.cut_rhythm.target_shot_s)}`,
    p.cut_rhythm.remove_silences ? `silencios ≥ ${p.cut_rhythm.min_silence_ms} ms` : null,
    p.captions.enabled === false
      ? "sin subtítulos"
      : `subtítulos ${p.captions.style}${p.captions.animated ? " animados" : ""}`,
    p.music.volume_db > -60 ? `música ${p.music.volume_db} dB` : null,
    `→ ${p.export_preset}`,
  ];
  return parts.filter(Boolean).join(" · ");
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border p-2" title={hint}>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-sm font-medium">{value}</div>
    </div>
  );
}

function AnalysisView({ record }: { record: StyleAnalysisRecord }) {
  const a = record.analysis;
  const s = a.shot_stats;
  const zooms = a.motion.zoom_events;
  const punch = zooms.filter((z) => z.kind === "punch_in").length;
  const maxBucket = Math.max(1, ...s.histogram.map((h) => h.count));
  return (
    <div className="flex flex-col gap-2" data-testid="style-analysis">
      <a href={fileUrl(a.contact_sheet_path)} target="_blank" rel="noreferrer">
        {/* eslint-disable-next-line @next/next/no-img-element -- served by the local api */}
        <img
          src={fileUrl(a.contact_sheet_path)}
          alt="Hoja de contactos del video de referencia (24 cuadros con la hora)"
          className="w-full rounded-md border bg-black object-contain"
        />
      </a>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        <Stat label="Duración" value={sec(a.duration_s)} />
        <Stat label="Lienzo" value={`${a.canvas.aspect} (${a.canvas.w}×${a.canvas.h})`} />
        <Stat
          label="Planos"
          value={`${s.count} · mediana ${sec(s.median_s)}`}
          hint={`Detector: ${a.scenes_method ?? "?"}`}
        />
        <Stat label="Ritmo" value={`${s.cuts_per_min.toFixed(1).replace(".", ",")} cortes/min`} />
        <Stat
          label="Movimiento"
          value={`${MOTION_LEVEL[a.motion.pan_estimate.level]}${zooms.length ? ` · ${zooms.length} zoom${punch ? ` (${punch} de golpe)` : ""}` : ""}`}
          hint="Estimación por diferencia de cuadros (heurística)"
        />
        <Stat
          label="Volumen"
          value={a.audio.loudness_lufs == null ? "—" : `${a.audio.loudness_lufs} LUFS`}
        />
        <Stat
          label="Voz"
          value={pct(a.audio.speech_ratio)}
          hint={a.audio.speech_method ?? undefined}
        />
        <Stat label="Silencio" value={pct(a.audio.silence_ratio)} />
        <Stat
          label="Música"
          value={yesNo(a.audio.music_detected)}
          hint="Heurística de planitud espectral"
        />
      </div>
      <div aria-label="Duración de los planos" className="flex items-end gap-1">
        {s.histogram.map((h, i) => (
          <div key={i} className="flex flex-1 flex-col items-center gap-0.5">
            <div
              className="w-full rounded-sm bg-primary/60"
              style={{ height: `${4 + (h.count / maxBucket) * 36}px` }}
              title={`${h.count} planos`}
            />
            <span className="text-[10px] text-muted-foreground">
              {h.max_s == null ? "más" : `<${h.max_s}s`}
            </span>
          </div>
        ))}
      </div>
      {a.text_on_screen?.length ? (
        <div className="text-xs">
          <p className="font-medium">Textos en pantalla</p>
          <ul className="list-inside list-disc text-muted-foreground">
            {a.text_on_screen.slice(0, 12).map((t, i) => (
              <li key={i}>
                {sec(t.t)}: «{t.text}»
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          {a.warnings.includes("ocr_pack_missing")
            ? "Textos en pantalla: instalá el paquete «Texto en pantalla (RapidOCR)» en Ajustes → Paquetes."
            : "Sin textos en pantalla detectados."}
        </p>
      )}
      {a.transcript_excerpt ? (
        <p className="text-xs text-muted-foreground">«{a.transcript_excerpt}»</p>
      ) : null}
    </div>
  );
}

function DraftForm() {
  const draft = useStyleStore((s) => s.draft);
  const origin = useStyleStore((s) => s.draftOrigin);
  const draftId = useStyleStore((s) => s.draftId);
  const update = useStyleStore((s) => s.updateDraft);
  if (!draft) return null;
  const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  return (
    <Section
      title={draftId ? "Editar perfil" : "Perfil nuevo"}
      actions={origin ? <Badge tone="muted">Deducido: {ORIGIN_LABELS[origin]}</Badge> : null}
    >
      <form
        aria-label="Perfil de estilo"
        className="grid grid-cols-2 gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void useStyleStore.getState().saveDraft();
        }}
      >
        <Label className="col-span-2">
          Nombre
          <Input
            value={draft.name}
            onChange={(e) => update((d) => ({ ...d, name: e.target.value }))}
          />
        </Label>
        <Label>
          Lienzo
          <Select
            value={draft.canvas}
            onChange={(e) =>
              update((d) => ({ ...d, canvas: e.target.value as StylePresetDraft["canvas"] }))
            }
          >
            {STYLE_CANVASES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </Label>
        <Label>
          Plano típico (s)
          <Input
            type="number"
            min={0.3}
            max={120}
            step={0.1}
            value={draft.cut_rhythm.target_shot_s}
            onChange={(e) =>
              update((d) => ({
                ...d,
                cut_rhythm: {
                  ...d.cut_rhythm,
                  target_shot_s: num(e.target.value, d.cut_rhythm.target_shot_s),
                },
              }))
            }
          />
        </Label>
        <label className="flex items-center gap-2 text-xs">
          <Checkbox
            checked={draft.cut_rhythm.remove_silences}
            onChange={(e) =>
              update((d) => ({
                ...d,
                cut_rhythm: { ...d.cut_rhythm, remove_silences: e.target.checked },
              }))
            }
          />
          Cortar silencios
        </label>
        <Label>
          Silencio mínimo (ms)
          <Input
            type="number"
            min={100}
            max={10000}
            step={50}
            value={draft.cut_rhythm.min_silence_ms}
            onChange={(e) =>
              update((d) => ({
                ...d,
                cut_rhythm: {
                  ...d.cut_rhythm,
                  min_silence_ms: Math.round(num(e.target.value, d.cut_rhythm.min_silence_ms)),
                },
              }))
            }
          />
        </Label>
        <label className="flex items-center gap-2 text-xs">
          <Checkbox
            checked={draft.captions.enabled !== false}
            onChange={(e) =>
              update((d) => ({ ...d, captions: { ...d.captions, enabled: e.target.checked } }))
            }
          />
          Subtítulos
        </label>
        <label className="flex items-center gap-2 text-xs">
          <Checkbox
            checked={draft.captions.animated}
            onChange={(e) =>
              update((d) => ({ ...d, captions: { ...d.captions, animated: e.target.checked } }))
            }
          />
          Animados (palabra a palabra)
        </label>
        <Label>
          Estilo de subtítulos
          <Select
            value={draft.captions.style}
            onChange={(e) =>
              update((d) => ({
                ...d,
                captions: {
                  ...d.captions,
                  style: e.target.value as StylePresetDraft["captions"]["style"],
                },
              }))
            }
          >
            {CAPTION_STYLE_IDS.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </Label>
        <Label>
          Posición
          <Select
            value={draft.captions.position}
            onChange={(e) =>
              update((d) => ({
                ...d,
                captions: {
                  ...d.captions,
                  position: e.target.value as StylePresetDraft["captions"]["position"],
                },
              }))
            }
          >
            {Object.entries(POSITION_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Label>
        <label className="flex items-center gap-2 text-xs">
          <Checkbox
            checked={draft.titles.enabled !== false}
            onChange={(e) =>
              update((d) => ({ ...d, titles: { ...d.titles, enabled: e.target.checked } }))
            }
          />
          Título al inicio
        </label>
        <Label>
          Texto del título
          <Input
            value={String(draft.titles.params?.title ?? "")}
            onChange={(e) =>
              update((d) => ({
                ...d,
                titles: { ...d.titles, params: { ...d.titles.params, title: e.target.value } },
              }))
            }
          />
        </Label>
        <label className="flex items-center gap-2 text-xs">
          <Checkbox
            checked={!!draft.lower_third && draft.lower_third.enabled !== false}
            onChange={(e) =>
              update((d) => ({
                ...d,
                lower_third: e.target.checked
                  ? { ...(d.lower_third ?? {}), enabled: true }
                  : d.lower_third
                    ? { ...d.lower_third, enabled: false }
                    : undefined,
              }))
            }
          />
          Rótulo con nombre
        </label>
        <Label>
          Nombre del rótulo
          <Input
            value={String(draft.lower_third?.params?.name ?? "")}
            disabled={!draft.lower_third || draft.lower_third.enabled === false}
            onChange={(e) =>
              update((d) => ({
                ...d,
                lower_third: {
                  ...(d.lower_third ?? {}),
                  params: { ...d.lower_third?.params, name: e.target.value },
                },
              }))
            }
          />
        </Label>
        <Label>
          Transiciones
          <Select
            value={draft.transitions.type}
            onChange={(e) =>
              update((d) => ({
                ...d,
                transitions: {
                  ...d.transitions,
                  type: e.target.value as StylePresetDraft["transitions"]["type"],
                },
              }))
            }
          >
            {STYLE_TRANSITION_TYPES.map((t) => (
              <option key={t} value={t}>
                {TRANSITION_LABELS[t]}
              </option>
            ))}
          </Select>
        </Label>
        <Label>
          Música (dB)
          <Input
            type="number"
            min={-60}
            max={12}
            step={1}
            value={draft.music.volume_db}
            onChange={(e) =>
              update((d) => ({
                ...d,
                music: { ...d.music, volume_db: num(e.target.value, d.music.volume_db) },
              }))
            }
          />
        </Label>
        <label className="flex items-center gap-2 text-xs">
          <Checkbox
            checked={draft.music.duck}
            onChange={(e) =>
              update((d) => ({ ...d, music: { ...d.music, duck: e.target.checked } }))
            }
          />
          Música de fondo bajo la voz
        </label>
        <label className="flex items-center gap-2 text-xs">
          <Checkbox
            checked={!!draft.ai_label}
            onChange={(e) => update((d) => ({ ...d, ai_label: e.target.checked }))}
          />
          Etiqueta «alterado con IA»
        </label>
        <Label className="col-span-2">
          Exportar con
          <Select
            value={draft.export_preset}
            onChange={(e) => update((d) => ({ ...d, export_preset: e.target.value }))}
          >
            {[...new Set([draft.export_preset, ...AGENT_KNOWN_PRESET_IDS])].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </Select>
        </Label>
        {draft.zoom_punch_in ? (
          <p className="col-span-2 text-[11px] text-muted-foreground">
            Zoom de golpe ×{draft.zoom_punch_in.scale} cada {draft.zoom_punch_in.every_s} s (queda
            como nota del plan: hacelo con keyframes de escala).
          </p>
        ) : null}
        <Label className="col-span-2">
          Notas
          <Textarea
            value={draft.notes_es}
            maxLength={1000}
            onChange={(e) => update((d) => ({ ...d, notes_es: e.target.value }))}
          />
        </Label>
        <div className="col-span-2 flex gap-2">
          <Button type="submit" size="sm">
            Guardar perfil
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => useStyleStore.getState().discardDraft()}
          >
            Descartar
          </Button>
        </div>
      </form>
    </Section>
  );
}

function PresetItem({ preset }: { preset: StylePreset }) {
  const applying = useStyleStore((s) => s.applyingId);
  return (
    <li className="flex flex-col gap-1 rounded-md border p-2" data-testid="style-preset">
      <div className="flex items-center gap-2">
        <span className="flex-1 truncate font-medium">{preset.name}</span>
        {preset.source?.via ? <Badge tone="muted">{ORIGIN_LABELS[preset.source.via]}</Badge> : null}
      </div>
      <p className="text-[11px] text-muted-foreground">{presetSummary(preset)}</p>
      {preset.notes_es ? <p className="text-xs">{preset.notes_es}</p> : null}
      <div className="flex flex-wrap gap-1">
        <Button
          size="xs"
          disabled={!!applying}
          onClick={() => void useStyleStore.getState().applyPreset(preset.id)}
        >
          {applying === preset.id ? <Spinner className="size-3" /> : <Wand2 aria-hidden />}
          Aplicar a este proyecto
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={() => useStyleStore.getState().editPreset(preset)}
        >
          <Pencil aria-hidden /> Editar
        </Button>
        <Button
          size="xs"
          variant="ghost"
          aria-label={`Borrar el perfil ${preset.name}`}
          onClick={() => void useStyleStore.getState().deletePreset(preset.id)}
        >
          <Trash2 aria-hidden />
        </Button>
      </div>
    </li>
  );
}

export function StylePanel() {
  const assets = useMediaStore((s) => s.assets);
  const order = useMediaStore((s) => s.order);
  const referenceId = useStyleStore((s) => s.referenceId);
  const analysis = useStyleStore((s) => s.analysis);
  const analyzing = useStyleStore((s) => s.analyzing);
  const analyzeError = useStyleStore((s) => s.analyzeError);
  const analyzeJobId = useStyleStore((s) => s.analyzeJobId);
  const inferring = useStyleStore((s) => s.inferring);
  const inferError = useStyleStore((s) => s.inferError);
  const inferJobId = useStyleStore((s) => s.inferJobId);
  const presets = useStyleStore((s) => s.presets);
  const presetsLoad = useStyleStore((s) => s.presetsLoad);
  const analyzeJob = useJobsStore((s) => (analyzeJobId ? s.jobs[analyzeJobId] : undefined));
  const inferJob = useJobsStore((s) => (inferJobId ? s.jobs[inferJobId] : undefined));
  const videos = useMemo(
    () => order.map((id) => assets[id]).filter((a) => a?.kind === "video"),
    [assets, order],
  );
  const reference = referenceId ? assets[referenceId] : undefined;

  useEffect(() => {
    if (useStyleStore.getState().presetsLoad === "idle")
      void useStyleStore.getState().loadPresets();
  }, []);

  const store = useStyleStore.getState;
  return (
    <Panel title="Perfil de estilo">
      <div className="flex flex-col gap-4">
        <Section title="Video de referencia">
          <p className="text-xs text-muted-foreground">
            Elegí un video cuyo estilo quieras copiar (ritmo de cortes, subtítulos, títulos,
            música). Se analiza en tu PC.
          </p>
          <div className="flex gap-2">
            <Select
              aria-label="Video de referencia"
              value={referenceId ?? ""}
              onChange={(e) => void store().setReference(e.target.value || undefined)}
            >
              <option value="">— Elegí un video importado —</option>
              {videos.map((v) => (
                <option key={v!.id} value={v!.id}>
                  {v!.name}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              disabled={!referenceId || analyzing}
              onClick={() => void store().analyze()}
            >
              {analyzing ? <Spinner /> : <ScanSearch aria-hidden />}
              Analizar
            </Button>
          </div>
          {videos.length === 0 ? (
            <EmptyState>Importá un video en Media para usarlo como referencia.</EmptyState>
          ) : null}
          {analyzing ? (
            <div className="flex flex-col gap-1" aria-live="polite">
              <Progress value={analyzeJob?.progress ?? 0} />
              <span className="text-[11px] text-muted-foreground">
                {analyzeJob?.message ?? "Analizando la referencia…"}
              </span>
            </div>
          ) : null}
          {analyzeError ? <ErrorNotice message={analyzeError} /> : null}
        </Section>

        {analysis ? (
          <Section title="Análisis">
            <AnalysisView record={analysis} />
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={inferring}
                onClick={() => void store().inferLocal()}
                tooltip={`Ollama + ${STYLE_VISION_DEFAULT_MODEL}, en tu PC (paquete «Modelo de visión local»)`}
              >
                {inferring ? <Spinner /> : <Bot aria-hidden />}
                Deducir con modelo local
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => store().askClaude(reference?.name)}
                tooltip="Pega el pedido con las rutas de la hoja de contactos y del análisis en la Consola Claude"
              >
                <TerminalSquare aria-hidden />
                Deducir con Consola Claude
              </Button>
            </div>
            {inferring ? (
              <div className="flex flex-col gap-1" aria-live="polite">
                <Progress value={inferJob?.progress ?? 0.05} />
                <span className="text-[11px] text-muted-foreground">
                  {inferJob?.message ?? "El modelo local está mirando la hoja de contactos…"}
                </span>
              </div>
            ) : null}
            {inferError ? <ErrorNotice message={inferError} /> : null}
          </Section>
        ) : null}

        <DraftForm />

        <Section
          title="Perfiles guardados"
          actions={
            <div className="flex gap-1">
              <Button
                size="xs"
                variant="ghost"
                aria-label="Actualizar perfiles"
                onClick={() => void store().loadPresets()}
              >
                <RefreshCw aria-hidden />
              </Button>
              <Button size="xs" variant="outline" onClick={() => store().newDraft()}>
                <Plus aria-hidden /> Nuevo a mano
              </Button>
            </div>
          }
        >
          {presetsLoad === "not-implemented" ? (
            <NotImplementedNotice what="Perfil de estilo" />
          ) : presetsLoad === "error" ? (
            <ErrorNotice message="No se pudieron leer los perfiles (¿está corriendo la API?)" />
          ) : presets.length === 0 ? (
            <EmptyState>
              <Sparkles className="mx-auto mb-1 size-4" aria-hidden />
              Todavía no hay perfiles: deducí uno desde una referencia o creá uno a mano.
            </EmptyState>
          ) : (
            <ul className="flex flex-col gap-2">
              {presets.map((p) => (
                <PresetItem key={p.id} preset={p} />
              ))}
            </ul>
          )}
          <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Clapperboard className="size-3" aria-hidden />
            «Aplicar» arma un plan en el Asistente: revisás cada paso y confirmás la exportación.
          </p>
        </Section>
      </div>
    </Panel>
  );
}

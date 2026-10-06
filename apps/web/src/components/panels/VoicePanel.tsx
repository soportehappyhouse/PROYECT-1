"use client";

import {
  STEMS_MODE_LABELS_ES,
  type RvcRequest,
  type StemsMode,
  type TtsProvider,
  type TtsVoiceInfo,
} from "@studio/shared";
import { Download, Eraser, Plus, Split, Trash2, Undo2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { hasAudio, SelectedClipHint, useSelectedClip } from "@/components/common/SelectedClipInfo";
import { Button } from "@/components/ui/button";
import { Checkbox, Label, Range, Select, Textarea } from "@/components/ui/input";
import {
  Badge,
  ErrorNotice,
  NotImplementedNotice,
  Progress,
  Section,
  Spinner,
  Tabs,
} from "@/components/ui/misc";
import { useApiResource } from "@/hooks/use-api-resource";
import { aiApi, api, ApiRequestError, errorMessage, isNotImplemented } from "@/lib/api";
import {
  defaultEffect,
  EFFECT_DEFS,
  EFFECT_TYPES,
  effectSummary,
  isBaseVoiceChain,
  VOICE_PRESETS,
  type EditableEffect,
  type EditableEffectType,
} from "@/lib/voice-effects";
import { warnIfCpu } from "@/lib/gpu-preflight";
import { formatMb, withPiperCatalog } from "@/lib/voices";
import { useJobsStore } from "@/stores/jobs-store";
import { runWithPack, usePacksStore } from "@/stores/packs-store";
import { useProjectStore } from "@/stores/project-store";
import { useStemsStore } from "@/stores/stems-store";
import { Panel } from "./Panel";

type Tab = "tts" | "effects" | "rvc";

/** Model pack with the 7 extra Spanish Piper voices (models/packs.json). */
const VOICES_PACK_ID = "voces-es";

function reportError(action: string, err: unknown) {
  if (isNotImplemented(err)) toast.info(`${action}: módulo en desarrollo`);
  else toast.error(`${action}: error`, { description: errorMessage(err) });
}

/**
 * Feedback 6: every catalog voice (es_AR / es_ES / es_MX) with «Descargar». The download runs in
 * the workers (POST /api/voice/models/download, verified size/md5); progress is read from the
 * `.part` file the workers write.
 */
function VoiceDownloads({
  voices,
  onInstalled,
  onPackInstalled,
}: {
  voices: TtsVoiceInfo[];
  onInstalled: (id: string) => void;
  /** The whole `voces-es` pack finished (packs route + «Paquete requerido» dialog). */
  onPackInstalled: () => void;
}) {
  const [busy, setBusy] = useState<Record<string, number | null>>({});
  const missing = voices.filter((v) => !v.installed);
  if (voices.length === 0) return null;

  // Decision 6: the 7 extra voices are the `voces-es` pack; same dialog/progress as other packs.
  const downloadPack = () => {
    const packs = usePacksStore.getState();
    const pack = packs.packs.find((p) => p.id === VOICES_PACK_ID);
    packs.openRequest({
      packId: VOICES_PACK_ID,
      ...(pack && { name_es: pack.name_es, size_bytes: pack.size_bytes }),
    });
    packs.attachRetry(VOICES_PACK_ID, onPackInstalled);
  };

  const download = async (v: TtsVoiceInfo) => {
    setBusy((b) => ({ ...b, [v.id]: null }));
    const poll = setInterval(() => {
      void api
        .modelDownloadProgress(v.id)
        .then((p) => {
          if (p.active && v.sizeBytes)
            setBusy((b) =>
              v.id in b ? { ...b, [v.id]: Math.min(0.99, p.bytes / v.sizeBytes!) } : b,
            );
        })
        .catch(() => undefined);
    }, 700);
    try {
      const res = await api.downloadModel({ kind: "piper", id: v.id });
      const skipped = res.files.every((f) => f.skipped);
      toast.success(`Voz «${v.name}» ${skipped ? "ya estaba instalada" : "descargada"}`);
      onInstalled(v.id);
    } catch (err) {
      toast.error(`No se pudo descargar «${v.name}»`, { description: downloadErrorMessage(err) });
    } finally {
      clearInterval(poll);
      setBusy((b) => {
        const next = { ...b };
        delete next[v.id];
        return next;
      });
    }
  };

  return (
    <Section title={`Voces Piper (${voices.length - missing.length}/${voices.length} instaladas)`}>
      {missing.length > 1 ? (
        <Button
          size="xs"
          variant="outline"
          className="self-start"
          tooltip="Paquete «voces-es»: descarga en secuencia con progreso (Ajustes → Paquetes de IA)"
          onClick={downloadPack}
        >
          <Download /> Descargar las {missing.length} que faltan (paquete voces-es)
        </Button>
      ) : null}
      <ul className="flex flex-col gap-1">
        {voices.map((v) => {
          const progress = busy[v.id];
          const downloading = v.id in busy;
          return (
            <li key={v.id} className="flex items-center gap-2 rounded-md border px-2 py-1 text-xs">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{v.name}</span>
                <span className="text-[11px] text-muted-foreground">
                  {v.language}
                  {v.quality ? ` · ${v.quality}` : ""}
                  {v.sizeBytes ? ` · ${formatMb(v.sizeBytes)}` : ""}
                </span>
                {downloading ? (
                  <Progress
                    value={progress ?? 0}
                    className={progress == null ? "animate-pulse" : ""}
                  />
                ) : null}
              </span>
              {v.installed ? <Badge tone="success">Instalada</Badge> : null}
              {!v.installed && !downloading ? <Badge tone="muted">No instalada</Badge> : null}
              {v.installed ? null : (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={downloading}
                  tooltip={`Descargar de Hugging Face (rhasspy/piper-voices)${v.sizeBytes ? `, ${formatMb(v.sizeBytes)}` : ""}`}
                  onClick={() => void download(v)}
                >
                  {downloading ? <Spinner className="size-3" /> : <Download />}
                  {downloading
                    ? progress != null
                      ? `${Math.round(progress * 100)} %`
                      : "Descargando…"
                    : "Descargar"}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/** Spanish explanation for a failed voice download (codes from the api). */
export function downloadErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.code === "WORKERS_UNAVAILABLE" || err.status === 503)
      return "Los workers de voz no están corriendo: inicia Studio con start.ps1 y reintenta.";
    if (err.code === "DOWNLOAD_OFFLINE")
      return "Sin conexión a Internet (o un proxy bloquea huggingface.co). " + err.message;
    if (err.code === "DOWNLOAD_FORBIDDEN") return err.message;
    if (err.code === "DOWNLOAD_CHECKSUM") return err.message;
  }
  return errorMessage(err);
}

function TtsForm() {
  const config = useApiResource(() => api.config());
  const voices = useApiResource(() => api.ttsVoices());
  const [provider, setProvider] = useState<TtsProvider>("piper");
  const [voice, setVoice] = useState("");
  const [text, setText] = useState("");
  const [speed, setSpeed] = useState(1);
  const [busy, setBusy] = useState(false);

  const providerEnabled: Record<TtsProvider, boolean> = {
    piper: true,
    elevenlabs: config.data?.providers.elevenlabs ?? false,
    openai: config.data?.providers.openai ?? false,
    // Sprint 4 Paso 0 stub: the voice module (M2) enables it from GET /api/voice/tts/providers.
    chatterbox: false,
  };
  const all = provider === "piper" ? withPiperCatalog(voices.data ?? []) : (voices.data ?? []);
  const list = all.filter((v) => v.provider === provider);
  const installed = list.filter((v) => v.installed);
  const selectedVoice =
    (voice && installed.some((v) => v.id === voice) ? voice : undefined) ?? installed[0]?.id ?? "";

  const submit = async () => {
    if (!text.trim() || !selectedVoice) return;
    setBusy(true);
    try {
      const { jobId } = await api.tts({
        provider,
        text,
        voice: selectedVoice,
        speed,
        format: "wav",
      });
      useJobsStore.getState().track(jobId, "voice.tts", {
        kind: "addToTimeline",
        start: useProjectStore.getState().playhead,
      });
      toast.info("Generando voz…");
    } catch (err) {
      reportError("Texto a voz", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Label>
        Proveedor
        <Select value={provider} onChange={(e) => setProvider(e.target.value as TtsProvider)}>
          <option value="piper">Piper (local)</option>
          <option value="elevenlabs" disabled={!providerEnabled.elevenlabs}>
            ElevenLabs{providerEnabled.elevenlabs ? "" : " (sin API key)"}
          </option>
          <option value="openai" disabled={!providerEnabled.openai}>
            OpenAI{providerEnabled.openai ? "" : " (sin API key)"}
          </option>
        </Select>
      </Label>
      {voices.status === "not-implemented" ? (
        <NotImplementedNotice what="La lista de voces" />
      ) : null}
      {voices.status === "error" && voices.error ? <ErrorNotice message={voices.error} /> : null}
      <Label>
        Voz
        <Select
          value={selectedVoice}
          onChange={(e) => setVoice(e.target.value)}
          disabled={installed.length === 0}
        >
          {installed.length === 0 ? <option value="">Sin voces instaladas</option> : null}
          {installed.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} · {v.language}
            </option>
          ))}
        </Select>
      </Label>
      {provider === "piper" ? (
        <VoiceDownloads
          voices={list}
          onInstalled={(id) => {
            setVoice(id);
            voices.reload();
          }}
          onPackInstalled={() => voices.reload()}
        />
      ) : null}
      <Label>
        Texto
        <Textarea
          rows={4}
          value={text}
          maxLength={20_000}
          onChange={(e) => setText(e.target.value)}
          placeholder="Escribe lo que quieres que diga la voz…"
        />
      </Label>
      <Label>
        Velocidad: {speed.toFixed(2)}×
        <Range
          min={0.5}
          max={2}
          step={0.05}
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
        />
      </Label>
      <Button
        size="sm"
        disabled={busy || !text.trim() || !selectedVoice}
        onClick={() => void submit()}
      >
        {busy ? <Spinner /> : null} Generar y añadir al cursor
      </Button>
    </div>
  );
}

/** «Limpiar voz (IA)»: DeepFilterNet (job audio.denoise, pack voz-limpia) → new audio asset. */
function DenoiseSection() {
  const sel = useSelectedClip();
  const [replace, setReplace] = useState(true);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!hasAudio(sel)) return;
    const { clip } = sel;
    const assetId = clip.assetId;
    setBusy(true);
    try {
      // Wrapped whole: after a «Paquete requerido» download the same request runs again.
      await warnIfCpu("denoise");
      await runWithPack(async () => {
        const { jobId } = await aiApi.denoise(assetId);
        useJobsStore
          .getState()
          .track(
            jobId,
            "audio.denoise",
            replace ? { kind: "replaceClipAsset", clipId: clip.id } : { kind: "refreshMedia" },
          );
        toast.info("Limpiando la voz…");
      });
    } catch (err) {
      reportError("Limpiar voz", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Limpiar voz (IA)">
      <p className="text-[11px] text-muted-foreground">
        Quita ruido de fondo, zumbidos y eco leve de la voz con DeepFilterNet (la primera vez baja
        el paquete «Voz limpia», unos 200 MB).
      </p>
      <label className="flex items-center gap-2 text-xs">
        <Checkbox checked={replace} onChange={(e) => setReplace(e.target.checked)} />
        Reemplazar el audio del clip (si no, el resultado queda en Media)
      </label>
      <Button size="sm" disabled={busy || !hasAudio(sel)} onClick={() => void run()}>
        {busy ? <Spinner /> : <Eraser />} Limpiar voz (IA)
      </Button>
    </Section>
  );
}

/**
 * Sprint 3b «Separar audio» (job audio.stems, pack stems): Demucs htdemucs splits the selected
 * clip into new tracks («Voz» + «Música», or 4) aligned to it; the clip is muted. Reversible with
 * «Deshacer separación» (api snapshot).
 */
export function StemsSection() {
  const sel = useSelectedClip();
  const mode = useStemsStore((s) => s.mode);
  const setMode = useStemsStore((s) => s.setMode);
  const run = useStemsStore((s) => s.run);
  const undoConflict = useStemsStore((s) => s.undoConflict);
  const separate = useStemsStore((s) => s.separate);
  const undo = useStemsStore((s) => s.undo);
  const job = useJobsStore((s) => (run?.jobId ? s.jobs[run.jobId] : undefined));
  const busy = run?.status === "starting" || run?.status === "running";
  const canUndo = run?.status === "done" && !!run.result?.undoSnapshotId;

  return (
    <Section title="Separar audio">
      <p className="text-[11px] text-muted-foreground">
        Separa la voz de la música (o voz, batería, bajo y otros) con Demucs y las pone en pistas
        nuevas alineadas al clip, que queda silenciado. Usa ~2 GB de GPU (sin GPU corre en CPU, más
        lento); la primera vez baja el paquete «Separar audio», unos 90 MB.
      </p>
      <Label>
        Modo
        <Select
          aria-label="Modo de separación"
          value={mode}
          disabled={busy}
          onChange={(e) => setMode(e.target.value as StemsMode)}
        >
          <option value="two">{STEMS_MODE_LABELS_ES.two}</option>
          <option value="four">{STEMS_MODE_LABELS_ES.four}</option>
        </Select>
      </Label>
      <Button
        size="sm"
        disabled={busy || !hasAudio(sel)}
        onClick={() => sel && void separate(sel.clip.id)}
      >
        {busy ? <Spinner /> : <Split />} Separar audio
      </Button>
      {busy ? (
        <div className="flex flex-col gap-1" data-testid="stems-progress">
          <Progress value={job?.progress ?? 0} />
          <span className="text-[11px] text-muted-foreground">
            {job?.message ?? "Preparando la separación…"}
          </span>
        </div>
      ) : null}
      {run?.status === "failed" && run.error ? (
        <p className="text-[11px] text-destructive">{run.error}</p>
      ) : null}
      {run?.result && (run.status === "done" || run.status === "undoing") ? (
        <p className="text-[11px] text-muted-foreground" data-testid="stems-result">
          {run.result.sourceClipId ? "Pistas nuevas" : "Audios nuevos en Media"}:{" "}
          {run.result.stems.map((s) => s.label).join(", ")}
        </p>
      ) : null}
      {run?.status === "undone" ? (
        <p className="text-[11px] text-muted-foreground">Separación deshecha.</p>
      ) : null}
      {canUndo || run?.status === "undoing" ? (
        <Button
          size="sm"
          variant="outline"
          disabled={run?.status === "undoing"}
          onClick={() => void undo()}
        >
          {run?.status === "undoing" ? <Spinner /> : <Undo2 />} Deshacer separación
        </Button>
      ) : null}
      {undoConflict ? (
        <div className="flex flex-col gap-1 rounded-md bg-muted p-2 text-[11px]">
          <span>{undoConflict}</span>
          <Button size="xs" variant="destructive" onClick={() => void undo(true)}>
            Deshacer igual
          </Button>
        </div>
      ) : null}
    </Section>
  );
}

function EffectsForm() {
  const sel = useSelectedClip();
  const [chain, setChain] = useState<EditableEffect[]>([]);
  const [busy, setBusy] = useState(false);
  const [addType, setAddType] = useState<EditableEffectType>("pitch");

  const setParam = (index: number, key: string, value: number) =>
    setChain((c) =>
      c.map((e, i) => (i === index ? ({ ...e, [key]: value } as EditableEffect) : e)),
    );

  const apply = async () => {
    if (!hasAudio(sel) || chain.length === 0) return;
    setBusy(true);
    try {
      const { jobId } = await api.voiceEffects({ assetId: sel.clip.assetId, effects: chain });
      useJobsStore
        .getState()
        .track(jobId, "voice.effect", { kind: "replaceClipAsset", clipId: sel.clip.id });
      toast.info("Aplicando efectos…");
    } catch (err) {
      reportError("Efectos de voz", err);
    } finally {
      setBusy(false);
    }
  };

  const applyOnExport = () => {
    if (!sel || !isBaseVoiceChain(chain)) return;
    useProjectStore.getState().updateClip(sel.clip.id, { voiceEffects: chain });
    toast.success("Efectos guardados en el clip (se aplican al exportar)");
  };

  return (
    <div className="flex flex-col gap-3">
      <SelectedClipHint
        sel={sel}
        need="Selecciona un clip de audio o video en la línea de tiempo."
      />
      <DenoiseSection />
      <StemsSection />
      <Section title="Presets">
        <div className="flex flex-wrap gap-1">
          {VOICE_PRESETS.map((p) => (
            <Button key={p.id} size="xs" variant="outline" onClick={() => setChain(p.effects)}>
              {p.name}
            </Button>
          ))}
        </div>
      </Section>
      <Section
        title="Cadena de efectos"
        actions={
          <div className="flex items-center gap-1">
            <Select
              aria-label="Tipo de efecto"
              className="h-6 w-auto text-xs"
              value={addType}
              onChange={(e) => setAddType(e.target.value as EditableEffectType)}
            >
              {EFFECT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {EFFECT_DEFS[t].label}
                </option>
              ))}
            </Select>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Añadir efecto"
              onClick={() => setChain((c) => [...c, defaultEffect(addType)])}
            >
              <Plus />
            </Button>
          </div>
        }
      >
        {chain.length === 0 ? (
          <p className="text-xs text-muted-foreground">Elige un preset o añade efectos.</p>
        ) : null}
        {chain.map((effect, i) => (
          <div key={i} className="rounded-md border p-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">{EFFECT_DEFS[effect.type].label}</span>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Quitar efecto"
                onClick={() => setChain((c) => c.filter((_, j) => j !== i))}
              >
                <Trash2 />
              </Button>
            </div>
            {EFFECT_DEFS[effect.type].params.map((p) => {
              const value = (effect as Record<string, unknown>)[p.key] as number;
              return (
                <Label key={p.key}>
                  {p.label}: {value}
                  <Range
                    min={p.min}
                    max={p.max}
                    step={p.step}
                    value={value}
                    onChange={(e) => setParam(i, p.key, Number(e.target.value))}
                  />
                </Label>
              );
            })}
          </div>
        ))}
      </Section>
      <div className="flex flex-wrap gap-1">
        <Button
          size="sm"
          disabled={busy || !hasAudio(sel) || chain.length === 0}
          onClick={() => void apply()}
        >
          {busy ? <Spinner /> : null} Aplicar (crea un nuevo audio)
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!sel || chain.length === 0 || !isBaseVoiceChain(chain)}
          title={
            isBaseVoiceChain(chain)
              ? "Guarda la cadena en el clip; se aplica al exportar"
              : "Algunos efectos solo se pueden aplicar creando un nuevo audio"
          }
          onClick={applyOnExport}
        >
          Aplicar al exportar
        </Button>
      </div>
      {sel && sel.clip.voiceEffects.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          En el clip: {sel.clip.voiceEffects.map(effectSummary).join(" → ")}
        </p>
      ) : null}
    </div>
  );
}

function RvcForm() {
  const sel = useSelectedClip();
  const config = useApiResource(() => api.config());
  const models = useApiResource(() => api.rvcModels());
  const [modelId, setModelId] = useState("");
  const [pitchShift, setPitchShift] = useState(0);
  const [indexRate, setIndexRate] = useState(0.75);
  const [f0Method, setF0Method] = useState<RvcRequest["f0Method"]>("rmvpe");
  const [useCuda, setUseCuda] = useState(false);
  const [busy, setBusy] = useState(false);
  const model = modelId || models.data?.[0]?.id || "";

  const submit = async () => {
    if (!hasAudio(sel) || !model) return;
    setBusy(true);
    const { assetId } = sel.clip;
    const clipId = sel.clip.id;
    try {
      // CPU chosen on purpose: the «puede tardar en CPU» toast already says it.
      if (useCuda) await warnIfCpu("rvc");
      // 409 PACK_REQUIRED (rvc-base: hubert + rmvpe) opens «Paquete requerido» and retries.
      await runWithPack(async () => {
        const { jobId } = await api.rvc({
          assetId,
          modelId: model,
          pitchShift,
          indexRate,
          f0Method,
          device: useCuda ? "cuda" : "cpu",
        });
        useJobsStore.getState().track(jobId, "voice.rvc", { kind: "replaceClipAsset", clipId });
        toast.info("Convirtiendo voz (puede tardar en CPU)…");
      });
    } catch (err) {
      reportError("RVC", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <SelectedClipHint sel={sel} need="Selecciona un clip con voz en la línea de tiempo." />
      {models.status === "not-implemented" ? (
        <NotImplementedNotice what="La lista de modelos RVC" />
      ) : null}
      {models.status === "error" && models.error ? <ErrorNotice message={models.error} /> : null}
      <Label>
        Modelo
        <Select
          value={model}
          onChange={(e) => setModelId(e.target.value)}
          disabled={!models.data?.length}
        >
          {!models.data?.length ? <option value="">Sin modelos en models/rvc</option> : null}
          {models.data?.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>
      </Label>
      <Label>
        Cambio de tono: {pitchShift > 0 ? `+${pitchShift}` : pitchShift} semitonos
        <Range
          min={-24}
          max={24}
          step={1}
          value={pitchShift}
          onChange={(e) => setPitchShift(Number(e.target.value))}
        />
      </Label>
      <Label>
        Índice de rasgos: {indexRate.toFixed(2)}
        <Range
          min={0}
          max={1}
          step={0.05}
          value={indexRate}
          onChange={(e) => setIndexRate(Number(e.target.value))}
        />
      </Label>
      <Label>
        Método F0
        <Select
          value={f0Method}
          onChange={(e) => setF0Method(e.target.value as RvcRequest["f0Method"])}
        >
          <option value="rmvpe">rmvpe (recomendado)</option>
          <option value="harvest">harvest</option>
          <option value="pm">pm (rápido)</option>
          <option value="crepe">crepe</option>
        </Select>
      </Label>
      <label className="flex items-center gap-2 text-xs">
        <Checkbox
          checked={useCuda}
          disabled={!config.data?.useCuda}
          onChange={(e) => setUseCuda(e.target.checked)}
        />
        Usar GPU (CUDA){config.data?.useCuda ? "" : " — no disponible"}
      </label>
      <Button size="sm" disabled={busy || !hasAudio(sel) || !model} onClick={() => void submit()}>
        {busy ? <Spinner /> : null} Convertir voz
      </Button>
    </div>
  );
}

export function VoicePanel() {
  const [tab, setTab] = useState<Tab>("tts");
  return (
    <Panel title="Voz y audio">
      <div className="flex flex-col gap-3">
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { value: "tts", label: "Texto a voz" },
            { value: "effects", label: "Efectos" },
            { value: "rvc", label: "RVC" },
          ]}
        />
        {tab === "tts" ? <TtsForm /> : tab === "effects" ? <EffectsForm /> : <RvcForm />}
      </div>
    </Panel>
  );
}

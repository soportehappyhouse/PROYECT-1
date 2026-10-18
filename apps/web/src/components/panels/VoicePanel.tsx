"use client";

import {
  CHATTERBOX_MAX_TEXT,
  CHATTERBOX_PACK_ID,
  SELF_VOICE_PROMPT_ES,
  SELF_VOICE_RECORD_SEC,
  STEMS_MODE_LABELS_ES,
  type AudioJobResult,
  type RvcRequest,
  type StemsMode,
  type TtsProvider,
  type TtsVoiceInfo,
  WORKERS_DOWN_ES,
} from "@studio/shared";
import { Download, Eraser, Mic, Plus, Split, Trash2, Undo2, Upload } from "lucide-react";
import { useEffect, useState } from "react";
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
import { useAiAvailability, type AiAvailability } from "@/hooks/use-ai-availability";
import { useApiResource } from "@/hooks/use-api-resource";
import { aiApi, api, ApiRequestError, errorMessage, fileUrl, isNotImplemented } from "@/lib/api";
import { PERSONS_CHANGED_EVENT } from "@/lib/api-persons";
import { JobFailedError, waitForJob } from "@/lib/job-runner";
import { cn } from "@/lib/utils";
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
import { useSettingsStore } from "@/stores/settings-store";
import { useStemsStore } from "@/stores/stems-store";
import {
  chatterboxErrorMessage,
  chatterboxOnCpu,
  chatterboxRequest,
  chatterboxRow,
  cloneOptions,
  currentProvider,
  estimateLabel,
  modelLabel,
  textTooLong,
  useVoiceCloneStore,
  type CloneSource,
} from "@/stores/voice-clone-store";
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
  const ai = useAiAvailability("workers");
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
          disabled={!ai.enabled}
          disabledReason={ai.reason_es}
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
                  disabled={downloading || !ai.enabled}
                  disabledReason={ai.reason_es}
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
    // The api text already says «… abrilo con scripts\windows\start.cmd» (and the banner too).
    if (err.code === "WORKERS_UNAVAILABLE")
      return err.message.includes("start.cmd") ? err.message : WORKERS_DOWN_ES;
    if (err.code === "DOWNLOAD_OFFLINE")
      return "Sin conexión a Internet (o un proxy bloquea huggingface.co). " + err.message;
    if (err.code === "DOWNLOAD_FORBIDDEN") return err.message;
    if (err.code === "DOWNLOAD_CHECKSUM") return err.message;
  }
  return errorMessage(err);
}

/** Spanish GB size: "6,2 GB". */
function gbLabel(bytes: number | undefined): string {
  return bytes ? `${(bytes / 1e9).toFixed(1).replace(".", ",")} GB` : "";
}

function openPersons() {
  // Ajustes → Personas (tab of the faces module).
  useSettingsStore.getState().setSettingsOpen(true, "persons");
}

/** Sprint 4: toast for a Chatterbox failure, with «Abrir Personas» when a consent is missing. */
function reportTtsError(err: unknown) {
  const raw =
    err instanceof JobFailedError
      ? (err.job.result as { error?: { code?: string; message?: string } } | undefined)?.error
      : undefined;
  const code = err instanceof ApiRequestError ? err.code : raw?.code;
  const message = raw?.message ?? chatterboxErrorMessage(err);
  const personSource = useVoiceCloneStore.getState().source.startsWith("person:");
  const personIssue =
    code === "CONSENT_REQUIRED" ||
    code === "PERSON_NOT_FOUND" ||
    (code === "VOICE_SAMPLE_MISSING" && personSource);
  if (personIssue)
    toast.error("Texto a voz", {
      description: message,
      action: { label: "Abrir Personas", onClick: openPersons },
    });
  else if (code === "TOOL_MISSING")
    toast.error("Texto a voz", {
      description: message,
      action: {
        label: "Paquetes de IA",
        onClick: () => useSettingsStore.getState().setSettingsOpen(true, "ai-packs"),
      },
    });
  else reportError("Texto a voz", err);
}

/** Sprint 4 «Voz propia»: record 10 s (MediaRecorder) or upload; «Soy yo» is mandatory. */
function SelfVoiceSection() {
  const selfRefs = useVoiceCloneStore((s) => s.selfRefs);
  const attest = useVoiceCloneStore((s) => s.attestSelf);
  const record = useVoiceCloneStore((s) => s.record);
  const elapsed = useVoiceCloneStore((s) => s.recordElapsed);
  const lastError = useVoiceCloneStore((s) => s.lastError);
  const store = useVoiceCloneStore.getState;
  const busy = record !== "idle";

  const done = (asset: { name: string } | undefined) => {
    if (asset) toast.success(`Guardada: «${asset.name}»`);
  };

  return (
    <Section title="Voz propia">
      <p className="text-[11px] text-muted-foreground">
        Grabá unos {SELF_VOICE_RECORD_SEC} s leyendo esta frase con tu tonada, en un lugar callado y
        sin música. Chatterbox copia la voz y el acento de la muestra.
      </p>
      <blockquote className="rounded-md border-l-2 bg-muted px-2 py-1 text-xs italic">
        «{SELF_VOICE_PROMPT_ES}»
      </blockquote>
      <label className="flex items-center gap-2 text-xs">
        <Checkbox
          checked={attest}
          aria-label="Soy yo: es mi propia voz"
          onChange={(e) => store().setAttestSelf(e.target.checked)}
        />
        Soy yo: es mi propia voz
      </label>
      <div className="flex flex-wrap gap-1">
        <Button
          size="xs"
          variant="outline"
          disabled={!attest || busy}
          tooltip="Graba con el micrófono de la PC (el navegador pide permiso)"
          onClick={() => void store().recordSelfRef().then(done)}
        >
          {record === "recording" ? <Spinner className="size-3" /> : <Mic />}
          {record === "recording"
            ? `Grabando… ${Math.floor(elapsed)} / ${SELF_VOICE_RECORD_SEC} s`
            : `Grabar ${SELF_VOICE_RECORD_SEC} s`}
        </Button>
        <label
          className={cn(
            "inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-0.5 text-xs",
            (!attest || busy) && "pointer-events-none opacity-50",
          )}
        >
          <Upload className="size-3" /> Subir archivo
          <input
            type="file"
            accept="audio/*,video/webm,.wav,.mp3,.m4a,.ogg,.webm,.flac"
            aria-label="Subir muestra de voz propia"
            className="hidden"
            disabled={!attest || busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void store().uploadSelfRef(file, file.name).then(done);
            }}
          />
        </label>
        {record === "uploading" ? <Spinner className="size-3" /> : null}
      </div>
      {record === "recording" ? <Progress value={elapsed / SELF_VOICE_RECORD_SEC} /> : null}
      {lastError ? <p className="text-[11px] text-destructive">{lastError}</p> : null}
      {selfRefs.length > 0 ? (
        <ul className="flex flex-col gap-1" aria-label="Muestras de voz propia">
          {selfRefs.map((a) => (
            <li key={a.id} className="flex flex-col gap-1 rounded-md border px-2 py-1 text-xs">
              <span className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-medium">{a.name}</span>
                {a.durationSec ? (
                  <span className="text-muted-foreground">{a.durationSec.toFixed(1)} s</span>
                ) : null}
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Borrar ${a.name}`}
                  tooltip="Borrar esta muestra de tu voz (el audio ya generado no cambia)"
                  onClick={() => void store().deleteSelfRef(a.id)}
                >
                  <Trash2 />
                </Button>
              </span>
              <audio controls preload="none" src={fileUrl(a.path)} className="h-7 w-full" />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[11px] text-muted-foreground">Todavía no grabaste tu voz.</p>
      )}
    </Section>
  );
}

/** Sprint 4: Chatterbox options (language fixed to Spanish, clone source, sliders, notes). */
function ChatterboxOptions({ text }: { text: string }) {
  const providers = useVoiceCloneStore((s) => s.providers);
  const selfRefs = useVoiceCloneStore((s) => s.selfRefs);
  const persons = useVoiceCloneStore((s) => s.persons);
  const source = useVoiceCloneStore((s) => s.source);
  const selfRefId = useVoiceCloneStore((s) => s.selfRefId);
  const exaggeration = useVoiceCloneStore((s) => s.exaggeration);
  const cfg = useVoiceCloneStore((s) => s.cfg);
  const gpu = useVoiceCloneStore((s) => s.gpu);
  const perf = useVoiceCloneStore((s) => s.perf);
  const store = useVoiceCloneStore.getState;
  const row = chatterboxRow(providers);
  const options = cloneOptions(selfRefs, persons);
  const estimate = text.trim() ? estimateLabel(text, perf) : undefined;
  const model = modelLabel(row);

  return (
    <div className="flex flex-col gap-2" data-testid="chatterbox-options">
      <Label>
        Idioma
        <Select value="es" disabled aria-label="Idioma">
          <option value="es">Español (es)</option>
        </Select>
      </Label>
      <Label>
        Voz a clonar
        <Select
          aria-label="Voz a clonar"
          value={source}
          onFocus={() => void store().loadPersons()}
          onChange={(e) => store().setSource(e.target.value as CloneSource)}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Label>
      {source === "self" && selfRefs.length > 1 ? (
        <Label>
          Muestra
          <Select
            aria-label="Muestra de voz propia"
            value={selfRefId ?? ""}
            onChange={(e) => store().setSelfRefId(e.target.value || undefined)}
          >
            <option value="">La más reciente</option>
            {selfRefs.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Label>
      ) : null}
      <p className="text-[11px] text-muted-foreground">
        Solo aparecen las Personas con consentimiento de voz vigente.{" "}
        <button type="button" className="underline" onClick={openPersons}>
          Registrar una persona
        </button>
      </p>
      <Label>
        Expresividad: {exaggeration.toFixed(2)}
        <Range
          aria-label="Expresividad"
          min={0.25}
          max={2}
          step={0.05}
          value={exaggeration}
          onChange={(e) => store().setExaggeration(Number(e.target.value))}
        />
      </Label>
      <Label>
        Fidelidad al acento de la referencia: {cfg.toFixed(2)}
        <Range
          aria-label="Fidelidad al acento de la referencia"
          min={0}
          max={1}
          step={0.05}
          value={cfg}
          onChange={(e) => store().setCfg(Number(e.target.value))}
        />
      </Label>
      <p className="text-[11px] text-muted-foreground">
        0,5 conserva bien la tonada de la muestra; bajala a 0,3 si la referencia habla rápido.
      </p>
      {chatterboxOnCpu(gpu) ? (
        <p className="rounded-md bg-muted p-2 text-[11px]" data-testid="chatterbox-cpu">
          Va a correr en CPU: bastante más lento que en GPU (puede tardar varios minutos).
        </p>
      ) : null}
      <p className="text-[11px] text-muted-foreground">
        Lleva una marca de agua inaudible (PerTh).
        {model ? ` Modelo: ${model}.` : ""}
        {estimate ? ` Tiempo estimado: ${estimate}.` : ""}
      </p>
    </div>
  );
}

function TtsForm() {
  const config = useApiResource(() => api.config());
  const voices = useApiResource(() => api.ttsVoices());
  const providers = useVoiceCloneStore((s) => s.providers);
  const provider = useVoiceCloneStore(currentProvider);
  const [voice, setVoice] = useState("");
  const [text, setText] = useState("");
  const [speed, setSpeed] = useState(1);
  const [busy, setBusy] = useState(false);
  const localAi = useAiAvailability(provider === "chatterbox" ? "chatterbox" : "workers");
  // Cloud voices (ElevenLabs/OpenAI) do not need the local workers.
  const ai: AiAvailability =
    provider === "piper" || provider === "chatterbox" ? localAi : { enabled: true };

  useEffect(() => {
    void useVoiceCloneStore.getState().load();
    // The panel stays mounted: Persons registered or revoked meanwhile must show up / go away.
    const reload = () => void useVoiceCloneStore.getState().loadPersons();
    window.addEventListener(PERSONS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(PERSONS_CHANGED_EVENT, reload);
  }, []);

  const chatterbox = chatterboxRow(providers);
  const isChatterbox = provider === "chatterbox";
  const providerEnabled: Record<TtsProvider, boolean> = {
    piper: true,
    elevenlabs: config.data?.providers.elevenlabs ?? false,
    openai: config.data?.providers.openai ?? false,
    chatterbox: chatterbox?.enabled ?? false,
  };
  const all = provider === "piper" ? withPiperCatalog(voices.data ?? []) : (voices.data ?? []);
  const list = all.filter((v) => v.provider === provider);
  const installed = list.filter((v) => v.installed);
  const selectedVoice =
    (voice && installed.some((v) => v.id === voice) ? voice : undefined) ?? installed[0]?.id ?? "";
  const packSize = usePacksStore(
    (s) => s.packs.find((p) => p.id === CHATTERBOX_PACK_ID)?.size_bytes,
  );

  const downloadPack = () => {
    const packs = usePacksStore.getState();
    packs.openRequest({
      packId: CHATTERBOX_PACK_ID,
      name_es: "Voz avanzada (Chatterbox: español y clonación)",
      ...((packSize ?? 0) > 0 && { size_bytes: packSize }),
    });
    packs.attachRetry(CHATTERBOX_PACK_ID, () => void useVoiceCloneStore.getState().load());
  };

  const submitChatterbox = async () => {
    await warnIfCpu("chatterbox");
    const start = useProjectStore.getState().playhead;
    // Wrapped whole (request + wait): after a «Paquete requerido» download it runs again.
    await runWithPack(async () => {
      const state = useVoiceCloneStore.getState();
      const { jobId } = await api.tts(chatterboxRequest(state, text));
      toast.info(state.source === "none" ? "Generando voz con Chatterbox…" : "Clonando la voz…");
      const job = await waitForJob(jobId, "voice.tts", { kind: "addToTimeline", start });
      const result = job.result as AudioJobResult | undefined;
      if (result?.aiVoice === "cloned")
        toast.success("Voz clonada agregada al cursor", {
          description: "Marcado como voz clonada (Revisión para redes).",
        });
      if (result?.warnings?.includes("gpu_arch_unsupported"))
        toast.warning("Chatterbox corrió en CPU", {
          description: "Esta GPU no es compatible con la versión de torch de Chatterbox.",
        });
    });
  };

  const submit = async () => {
    if (!text.trim()) return;
    if (!isChatterbox && !selectedVoice) return;
    setBusy(true);
    try {
      if (isChatterbox) {
        await submitChatterbox();
        return;
      }
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
      reportTtsError(err);
    } finally {
      setBusy(false);
    }
  };

  const tooLong = isChatterbox && textTooLong(text);
  const canSubmit = isChatterbox
    ? Boolean(chatterbox?.installed) && !tooLong
    : Boolean(selectedVoice);

  return (
    <div className="flex flex-col gap-2">
      <Label>
        Motor
        <Select
          aria-label="Motor"
          value={provider}
          onChange={(e) => {
            const next = e.target.value as TtsProvider;
            useVoiceCloneStore.getState().setProvider(next);
            if (next === "chatterbox") {
              void useVoiceCloneStore.getState().loadPersons();
              void useVoiceCloneStore.getState().loadSelfRefs();
            }
          }}
        >
          <option value="piper">Piper (local, rápido)</option>
          <option value="chatterbox">
            Chatterbox (local, GPU){chatterbox?.installed ? "" : " — falta paquete"}
          </option>
          <option value="elevenlabs" disabled={!providerEnabled.elevenlabs}>
            ElevenLabs{providerEnabled.elevenlabs ? "" : " (sin API key)"}
          </option>
          <option value="openai" disabled={!providerEnabled.openai}>
            OpenAI{providerEnabled.openai ? "" : " (sin API key)"}
          </option>
        </Select>
      </Label>
      {isChatterbox && !chatterbox?.installed ? (
        <div
          className="flex flex-col gap-1 rounded-md border p-2 text-xs"
          data-testid="chatterbox-missing"
        >
          <span>
            Chatterbox lee en español con mejor calidad y clona una voz desde ~10 s de muestra.
            Necesita el paquete «Voz avanzada»{packSize ? ` (${gbLabel(packSize)})` : ""}.
          </span>
          <div className="flex gap-1">
            <Button size="xs" onClick={downloadPack}>
              <Download /> Descargar paquete{packSize ? ` (${gbLabel(packSize)})` : ""}
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => useVoiceCloneStore.getState().setProvider("piper")}
            >
              Usar Piper
            </Button>
          </div>
        </div>
      ) : null}
      {isChatterbox && chatterbox?.installed ? <ChatterboxOptions text={text} /> : null}
      {!isChatterbox && voices.status === "not-implemented" ? (
        <NotImplementedNotice what="La lista de voces" />
      ) : null}
      {!isChatterbox && voices.status === "error" && voices.error ? (
        <ErrorNotice message={voices.error} />
      ) : null}
      {!isChatterbox ? (
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
      ) : null}
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
      {isChatterbox ? (
        <span className={cn("text-[11px]", tooLong ? "text-destructive" : "text-muted-foreground")}>
          {text.length} / {CHATTERBOX_MAX_TEXT} caracteres
          {tooLong ? ": dividí el texto" : ""}
        </span>
      ) : (
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
      )}
      <Button
        size="sm"
        disabled={busy || !text.trim() || !canSubmit || !ai.enabled}
        disabledReason={ai.reason_es}
        onClick={() => void submit()}
      >
        {busy ? <Spinner /> : null} Generar y añadir al cursor
      </Button>
      {isChatterbox ? <SelfVoiceSection /> : null}
    </div>
  );
}

/** «Limpiar voz (IA)»: DeepFilterNet (job audio.denoise, pack voz-limpia) → new audio asset. */
function DenoiseSection() {
  const sel = useSelectedClip();
  const [replace, setReplace] = useState(true);
  const [busy, setBusy] = useState(false);
  const ai = useAiAvailability("denoise");

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
      <Button
        size="sm"
        disabled={busy || !hasAudio(sel) || !ai.enabled}
        disabledReason={ai.reason_es}
        onClick={() => void run()}
      >
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
  const ai = useAiAvailability("stems");

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
        disabled={busy || !hasAudio(sel) || !ai.enabled}
        disabledReason={ai.reason_es}
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
              tooltip="Sumar el efecto elegido al final de la cadena"
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
                tooltip="Quitar este efecto de la cadena"
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
  const ai = useAiAvailability("rvc");
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
      <Button
        size="sm"
        disabled={busy || !hasAudio(sel) || !model || !ai.enabled}
        disabledReason={ai.reason_es}
        onClick={() => void submit()}
      >
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

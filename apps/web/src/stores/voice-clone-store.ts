import {
  API_ROUTES,
  CHATTERBOX_DEFAULTS,
  CHATTERBOX_MAX_TEXT,
  CHATTERBOX_MODEL_LABELS_ES,
  CHATTERBOX_VOICE_MULTILINGUAL,
  chatterboxVoiceId,
  estimateChatterboxSeconds,
  SELF_VOICE_RECORD_SEC,
  VOICE_SAMPLE_LIMITS,
  willRunOnCpu,
  type ChatterboxModel,
  type MediaAsset,
  type PersonSummary,
  type TtsProvider,
  type TtsProviderInfo,
  type TtsRequestInput,
} from "@studio/shared";
import { create } from "zustand";
import { aiApi, api, apiFetch, ApiRequestError, errorMessage } from "@/lib/api";
import type { GpuStatus, PerfResult } from "@/lib/ai-types";

/**
 * Sprint 4 M2 «Voces»: Chatterbox engine state of «Texto a voz» (docs/trabajo/sprint4-contratos.md
 * «M2 · Web»): providers with the pack state, the clone source (none · «Voz propia» · Person with
 * voice consent, read-only list from GET /api/persons?scope=voice), exaggeration / cfg, the
 * «Voz propia» samples (record 10 s with MediaRecorder or upload, «Soy yo» mandatory) and the
 * request that goes to POST /api/voice/tts.
 */

/** "none" = the model's multilingual voice; "self" = a «Voz propia»; "person:<id>". */
export type CloneSource = "none" | "self" | `person:${string}`;

export interface CloneOption {
  value: CloneSource;
  label: string;
}

export type RecordState = "idle" | "recording" | "uploading";

interface VoiceCloneState {
  providers: TtsProviderInfo[] | undefined;
  providersError: string | undefined;
  /** Engine chosen by the user; undefined = the api's default (decision 10). */
  chosen: TtsProvider | undefined;
  selfRefs: MediaAsset[];
  persons: PersonSummary[];
  gpu: GpuStatus | undefined;
  perf: PerfResult | undefined;
  source: CloneSource;
  /** «Voz propia» sample to clone (undefined = the most recent one). */
  selfRefId: string | undefined;
  exaggeration: number;
  cfg: number;
  attestSelf: boolean;
  record: RecordState;
  /** Seconds recorded so far while recording. */
  recordElapsed: number;
  lastError: string | undefined;
  load: () => Promise<void>;
  loadSelfRefs: () => Promise<void>;
  setProvider: (p: TtsProvider) => void;
  setSource: (s: CloneSource) => void;
  setSelfRefId: (id: string | undefined) => void;
  setExaggeration: (v: number) => void;
  setCfg: (v: number) => void;
  setAttestSelf: (v: boolean) => void;
  /** Upload a sample (recording or file) as «Voz propia» (needs attestSelf). */
  uploadSelfRef: (file: Blob, name?: string) => Promise<MediaAsset | undefined>;
  deleteSelfRef: (id: string) => Promise<void>;
  /** Record SELF_VOICE_RECORD_SEC seconds in the browser and upload them. */
  recordSelfRef: (seconds?: number) => Promise<MediaAsset | undefined>;
  reset: () => void;
}

const INITIAL = {
  providers: undefined,
  providersError: undefined,
  chosen: undefined,
  selfRefs: [],
  persons: [],
  gpu: undefined,
  perf: undefined,
  source: "none" as CloneSource,
  selfRefId: undefined,
  exaggeration: CHATTERBOX_DEFAULTS.exaggeration,
  cfg: CHATTERBOX_DEFAULTS.cfg,
  attestSelf: false,
  record: "idle" as RecordState,
  recordElapsed: 0,
  lastError: undefined,
};

// ------------------------------------------------------------------------------- pure helpers

/** Decision 10: the row flagged `default` (Chatterbox with pack + GPU), else Piper. */
export function defaultProvider(providers: readonly TtsProviderInfo[] | undefined): TtsProvider {
  const flagged = providers?.find((p) => p.default && p.enabled);
  return flagged?.id ?? "piper";
}

export function chatterboxRow(
  providers: readonly TtsProviderInfo[] | undefined,
): TtsProviderInfo | undefined {
  return providers?.find((p) => p.id === "chatterbox");
}

/** The checkpoint shown in the panel (V3 / V2 fallback) when the pack is installed. */
export function installedModel(row: TtsProviderInfo | undefined): ChatterboxModel | undefined {
  return row?.installed && row.models?.length === 1 ? row.models[0] : undefined;
}

export function modelLabel(row: TtsProviderInfo | undefined): string | undefined {
  const m = installedModel(row);
  return m ? CHATTERBOX_MODEL_LABELS_ES[m] : undefined;
}

/** «Ninguna» + «Voz propia» (when there is one) + every Person with a valid voice consent. */
export function cloneOptions(
  selfRefs: readonly MediaAsset[],
  persons: readonly PersonSummary[],
): CloneOption[] {
  const out: CloneOption[] = [{ value: "none", label: "Ninguna (voz multilingüe del modelo)" }];
  if (selfRefs.length > 0) out.push({ value: "self", label: "Voz propia" });
  for (const p of persons)
    if (p.voice === "vigente" && p.voiceSamples > 0)
      out.push({ value: `person:${p.id}`, label: `Persona: ${p.name}` });
  return out;
}

/** POST /api/voice/tts body of the Chatterbox engine (language fixed to Spanish). */
export function chatterboxRequest(
  s: Pick<VoiceCloneState, "source" | "selfRefId" | "exaggeration" | "cfg">,
  text: string,
): TtsRequestInput {
  const base = {
    provider: "chatterbox" as const,
    text,
    language: CHATTERBOX_DEFAULTS.language,
    exaggeration: s.exaggeration,
    cfg: s.cfg,
    temperature: CHATTERBOX_DEFAULTS.temperature,
    format: "wav" as const,
  };
  if (s.source === "self")
    return s.selfRefId
      ? {
          ...base,
          voice: chatterboxVoiceId("self"),
          voiceRef: { assetId: s.selfRefId, self: true },
        }
      : { ...base, voice: chatterboxVoiceId("self") };
  if (s.source.startsWith("person:")) {
    const personId = s.source.slice("person:".length);
    return { ...base, voice: chatterboxVoiceId({ personId }), voiceRef: { personId } };
  }
  return { ...base, voice: CHATTERBOX_VOICE_MULTILINGUAL };
}

/** «≈ 12 s» from the performance test's chatterbox_rtf (undefined without a measurement). */
export function estimateLabel(text: string, perf: PerfResult | undefined): string | undefined {
  const s = estimateChatterboxSeconds(text, perf?.chatterbox_rtf);
  if (s === undefined) return undefined;
  return s < 60 ? `≈ ${s} s` : `≈ ${Math.round(s / 6) / 10} min`;
}

/** Chatterbox will run on the CPU (the panel warns BEFORE generating). */
export function chatterboxOnCpu(gpu: GpuStatus | undefined): boolean {
  return willRunOnCpu(gpu, "chatterbox");
}

export function textTooLong(text: string): boolean {
  return text.length > CHATTERBOX_MAX_TEXT;
}

/** Spanish message for the Chatterbox errors the panel explains itself. */
export function chatterboxErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.code === "CONSENT_REQUIRED") return err.message;
    if (err.code === "VOICE_SAMPLE_INVALID")
      return "La muestra tiene que durar entre 5 y 60 s y tener voz.";
    if (err.code === "ATTEST_SELF_REQUIRED") return err.message;
    if (err.code === "FILE_TOO_LARGE")
      return `La muestra supera ${Math.round(VOICE_SAMPLE_LIMITS.maxBytes / 2 ** 20)} MB.`;
  }
  return errorMessage(err);
}

// ------------------------------------------------------------------------------- recording

/** Record `seconds` of microphone audio (MediaRecorder; WebM/Opus in Chrome/Edge). */
export async function recordMicrophone(
  seconds: number,
  onTick?: (elapsed: number) => void,
): Promise<Blob> {
  const media = globalThis.navigator?.mediaDevices;
  if (!media?.getUserMedia || typeof MediaRecorder === "undefined")
    throw new Error("Este navegador no puede grabar audio: subí un archivo.");
  const stream = await media.getUserMedia({ audio: true });
  try {
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.start(250);
    const t0 = Date.now();
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        const elapsed = (Date.now() - t0) / 1000;
        onTick?.(Math.min(seconds, elapsed));
        if (elapsed >= seconds) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
    recorder.stop();
    await stopped;
    return new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}

function extensionOf(type: string): string {
  if (type.includes("ogg")) return "ogg";
  if (type.includes("mp4") || type.includes("aac")) return "m4a";
  if (type.includes("wav")) return "wav";
  if (type.includes("mpeg")) return "mp3";
  return "webm";
}

// ------------------------------------------------------------------------------- store

export const useVoiceCloneStore = create<VoiceCloneState>()((set, get) => ({
  ...INITIAL,

  load: async () => {
    const [providers, selfRefs, persons, gpu, perf] = await Promise.allSettled([
      apiFetch<TtsProviderInfo[]>(API_ROUTES.ttsProviders),
      apiFetch<MediaAsset[]>(API_ROUTES.voiceSelfRefs),
      apiFetch<PersonSummary[]>(API_ROUTES.persons, { query: { scope: "voice" } }),
      aiApi.gpu(),
      aiApi.lastPerf(),
    ]);
    set({
      ...(providers.status === "fulfilled"
        ? { providers: providers.value, providersError: undefined }
        : { providersError: errorMessage(providers.reason) }),
      ...(selfRefs.status === "fulfilled" && { selfRefs: selfRefs.value }),
      ...(persons.status === "fulfilled" && { persons: persons.value }),
      ...(gpu.status === "fulfilled" && { gpu: gpu.value }),
      ...(perf.status === "fulfilled" && { perf: perf.value }),
    });
    // A Person whose consent was revoked / a deleted sample is no longer offered.
    const s = get();
    if (!cloneOptions(s.selfRefs, s.persons).some((o) => o.value === s.source))
      set({ source: "none" });
  },

  loadSelfRefs: async () => {
    try {
      set({ selfRefs: await apiFetch<MediaAsset[]>(API_ROUTES.voiceSelfRefs) });
    } catch {
      // keep the current list
    }
  },

  setProvider: (p) => set({ chosen: p }),
  setSource: (source) => set({ source }),
  setSelfRefId: (selfRefId) => set({ selfRefId }),
  setExaggeration: (exaggeration) => set({ exaggeration }),
  setCfg: (cfg) => set({ cfg }),
  setAttestSelf: (attestSelf) => set({ attestSelf }),

  uploadSelfRef: async (file, name) => {
    if (!get().attestSelf) {
      set({ lastError: "Marcá «Soy yo: es mi propia voz» antes de guardar la muestra." });
      return undefined;
    }
    if (file.size > VOICE_SAMPLE_LIMITS.maxBytes) {
      set({
        lastError: `La muestra supera ${Math.round(VOICE_SAMPLE_LIMITS.maxBytes / 2 ** 20)} MB.`,
      });
      return undefined;
    }
    set({ record: "uploading", lastError: undefined });
    try {
      const form = new FormData();
      form.append("attestSelf", "true");
      form.append("audio", file, name ?? `voz-propia.${extensionOf(file.type)}`);
      const asset = await apiFetch<MediaAsset>(API_ROUTES.voiceSelfRefs, {
        method: "POST",
        body: form,
      });
      set((s) => ({
        selfRefs: [asset, ...s.selfRefs.filter((a) => a.id !== asset.id)],
        source: "self",
        selfRefId: undefined,
        record: "idle",
      }));
      return asset;
    } catch (err) {
      set({ record: "idle", lastError: chatterboxErrorMessage(err) });
      return undefined;
    }
  },

  deleteSelfRef: async (id) => {
    try {
      await api.deleteMedia(id);
    } catch (err) {
      set({ lastError: errorMessage(err) });
      return;
    }
    set((s) => {
      const selfRefs = s.selfRefs.filter((a) => a.id !== id);
      return {
        selfRefs,
        selfRefId: s.selfRefId === id ? undefined : s.selfRefId,
        source: s.source === "self" && selfRefs.length === 0 ? "none" : s.source,
      };
    });
  },

  recordSelfRef: async (seconds = SELF_VOICE_RECORD_SEC) => {
    if (!get().attestSelf) {
      set({ lastError: "Marcá «Soy yo: es mi propia voz» antes de grabar." });
      return undefined;
    }
    set({ record: "recording", recordElapsed: 0, lastError: undefined });
    let blob: Blob;
    try {
      blob = await recordMicrophone(seconds, (recordElapsed) => set({ recordElapsed }));
    } catch (err) {
      const denied =
        err instanceof Error && /denied|permission|NotAllowed/i.test(err.name + err.message);
      set({
        record: "idle",
        lastError: denied
          ? "No hay permiso para usar el micrófono: habilitalo en el navegador o subí un archivo."
          : errorMessage(err),
      });
      return undefined;
    }
    return get().uploadSelfRef(blob);
  },

  reset: () => set({ ...INITIAL }),
}));

/** Engine shown in the selector: the user's choice, else the api's default. */
export function currentProvider(s: Pick<VoiceCloneState, "chosen" | "providers">): TtsProvider {
  return s.chosen ?? defaultProvider(s.providers);
}

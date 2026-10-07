import {
  CHATTERBOX_PACK_ID,
  CHATTERBOX_LANGUAGES,
  CHATTERBOX_VOICE_MULTILINGUAL,
  PACK_REQUIRED,
  validateChatterboxRequest,
  type AiProvenance,
  type ChatterboxModel,
  type MediaAsset,
  type ResolvedChatterboxRequest,
  type TtsProviderInfo,
  type TtsRequest,
  type TtsVoiceInfo,
  type WorkerChatterboxFields,
  type WorkerTtsRequest,
} from "@studio/shared";
import type { AppContext } from "../context.js";
import { requirePack } from "../jobs/handlers/ai.js";
import { errorBody, HttpError } from "../lib/errors.js";
import { createConsentGate, type ConsentGate } from "../services/persons/gate.js";
import { WorkersError, type WorkersClient } from "../services/workers-client.js";

/**
 * Sprint 4 M2 «Voz»: Chatterbox TTS + zero-shot cloning on the api side (docs/trabajo/
 * sprint4-contratos.md «M2»): provider row, voice row, request validation, the clone source
 * (Person with voice consent through M1's ConsentGate, or a «Voz propia» `voice-ref` asset). The
 * workers call is the shared `WorkersClient.tts` (its WorkerTtsResultSchema keeps device, warnings,
 * watermark, rtf and model; open point C of the audit).
 */

export type ChatterboxDeps = Pick<AppContext, "config" | "repos" | "workers"> &
  Partial<Pick<AppContext, "db">> & {
    /** Tests inject a fake gate; the app builds M1's from `db`. */
    gate?: ConsentGate;
  };

/** The clone source after the checks (what the workers get + what the provenance records). */
export interface ResolvedVoiceRef {
  /** Relative to STORAGE_DIR. */
  path: string;
  /** "self" or the consentId (workers log it). */
  consent: string;
  name: string;
  personId?: string;
  consentId?: string;
  self?: true;
  sourceAssetId?: string;
}

const gates = new WeakMap<object, ConsentGate>();

/** M1's consent gate for this app (created lazily: ensurePersonsSchema is idempotent). */
export function consentGate(deps: ChatterboxDeps): ConsentGate {
  if (deps.gate) return deps.gate;
  if (!deps.db)
    throw new HttpError(503, "PERSONS_UNAVAILABLE", "El registro de Personas no está listo");
  let gate = gates.get(deps.db);
  if (!gate) {
    gate = createConsentGate(deps.db, deps.config.storageDir);
    gates.set(deps.db, gate);
  }
  return gate;
}

/** A failed job keeps the error code/details in `result` (the web shows «Abrir Personas»…). */
export function asJobError(err: unknown): unknown {
  if (err instanceof HttpError && !("jobResult" in err))
    Object.assign(err, { jobResult: errorBody(err.code, err.message, err.details) });
  return err;
}

/** Text ≤ 5000, language, voice id → defaults filled; 400 otherwise. */
export function validateOr400(body: TtsRequest): ResolvedChatterboxRequest {
  const v = validateChatterboxRequest(body);
  if (!v.ok) throw new HttpError(400, v.code, v.message);
  return v.value;
}

/**
 * Clone source of a Chatterbox request: Person → `gate.assertConsent(id, "voice")` (404/403) and
 * `gate.voiceSamplePath` (409 VOICE_SAMPLE_MISSING); «Voz propia» → the `voice-ref` asset (explicit
 * id, or the most recent for `chatterbox:self`). No reference → undefined (the model's voice).
 */
export function resolveVoiceRef(
  deps: ChatterboxDeps,
  value: ResolvedChatterboxRequest,
): ResolvedVoiceRef | undefined {
  const ref = value.voiceRef;
  if (ref && "personId" in ref) {
    const gate = consentGate(deps);
    const { person, consent } = gate.assertConsent(ref.personId, "voice");
    const samplePath = gate.voiceSamplePath(ref.personId);
    return {
      path: samplePath,
      consent: consent.id,
      name: person.name,
      personId: person.id,
      consentId: consent.id,
    };
  }
  if (!ref && !value.selfLatest) return undefined;
  let asset: MediaAsset | undefined;
  if (ref) {
    asset = deps.repos.media.get(ref.assetId);
    if (!asset) throw new HttpError(404, "NOT_FOUND", `Medio ${ref.assetId} no encontrado`);
    if (asset.kind !== "voice-ref")
      throw new HttpError(
        400,
        "INVALID_VOICE_REF",
        `«${asset.name}» no es una muestra de «Voz propia»: grabala o subila en Texto a voz`,
      );
  } else {
    asset = deps.repos.media.list({ kind: "voice-ref", limit: 1 })[0];
    if (!asset)
      throw new HttpError(
        409,
        "VOICE_SAMPLE_MISSING",
        "Todavía no tenés una «Voz propia»: grabá 10 s o subí una muestra en Voz y audio → Texto a voz.",
      );
  }
  return {
    path: asset.path,
    consent: "self",
    name: "Voz propia",
    self: true,
    sourceAssetId: asset.id,
  };
}

/**
 * Route preflight (and job start): validation (400) → pack tts-chatterbox (409 PACK_REQUIRED) →
 * clone source (gate). Returns what the job sends to the workers.
 */
export async function prepareChatterbox(
  deps: ChatterboxDeps,
  body: TtsRequest,
): Promise<{ value: ResolvedChatterboxRequest; ref: ResolvedVoiceRef | undefined }> {
  const value = validateOr400(body);
  await requirePack(deps.workers, CHATTERBOX_PACK_ID);
  const ref = resolveVoiceRef(deps, value);
  return { value, ref };
}

/** Workers POST /tts body for Chatterbox (camelCase, paths relative to STORAGE_DIR). */
export function workerChatterboxBody(
  payload: TtsRequest,
  value: ResolvedChatterboxRequest,
  ref: ResolvedVoiceRef | undefined,
  outputPath: string,
  jobId: string,
): WorkerTtsRequest & WorkerChatterboxFields {
  return {
    text: payload.text,
    voice: payload.voice,
    speed: payload.speed,
    outputPath,
    provider: "chatterbox",
    format: payload.format,
    jobId,
    language: value.language,
    ...(value.model && { model: value.model }),
    ...(ref && { voiceRef: { path: ref.path, consent: ref.consent } }),
    exaggeration: value.exaggeration,
    cfg: value.cfg,
    temperature: value.temperature,
    ...(value.seed !== undefined && { seed: value.seed }),
  };
}

/** aiProvenance of a generated voice (decision 9: every TTS voice is synthetic; a clone, cloned). */
export function voiceProvenance(tool: string, jobId: string, ref?: ResolvedVoiceRef): AiProvenance {
  return {
    kind: ref ? "voice-cloned" : "voice-synthetic",
    tool: tool.slice(0, 120),
    ...(ref?.personId && { personId: ref.personId }),
    ...(ref?.consentId && { consentId: ref.consentId }),
    ...(ref?.self && { self: true }),
    ...(ref?.sourceAssetId && { sourceAssetId: ref.sourceAssetId }),
    jobId,
    createdAt: new Date().toISOString(),
  };
}

// ----------------------------------------------------------------------------- listing

/** Fallback row while the workers are down (state unknown = not installed). */
const OFFLINE_ROW: TtsProviderInfo = {
  id: "chatterbox",
  name: "Chatterbox (local, GPU)",
  enabled: false,
  status: "falta paquete",
  packId: CHATTERBOX_PACK_ID,
  installed: false,
  supportsClone: true,
  models: ["mtl-v3", "mtl-v2"],
  languages: [...CHATTERBOX_LANGUAGES],
  gpu: true,
};

/**
 * GET /api/voice/tts/providers Chatterbox row (workers /tts/providers) + decision 10: the default
 * provider of the UI is Chatterbox when its pack is installed and the workers run in GPU mode.
 */
export async function chatterboxProviderRow(
  workers: Pick<WorkersClient, "ttsProviders" | "gpuStatus">,
): Promise<TtsProviderInfo> {
  const safe = <T>(fn: () => Promise<T>) =>
    Promise.resolve()
      .then(fn)
      .catch(() => undefined);
  const [rows, gpu] = await Promise.all([
    safe(() => workers.ttsProviders()),
    safe(() => workers.gpuStatus()),
  ]);
  const row = rows?.find((p) => p.id === "chatterbox");
  const merged: TtsProviderInfo = { ...OFFLINE_ROW, ...(row ?? {}), packId: CHATTERBOX_PACK_ID };
  const installed = Boolean(row?.installed ?? row?.enabled);
  return {
    ...merged,
    enabled: installed,
    installed,
    status: installed ? "local" : "falta paquete",
    default: installed && gpu?.mode === "gpu",
  };
}

/** The built-in Chatterbox voice (added to the workers' voice list when missing). */
export function chatterboxVoiceRow(installed: boolean): TtsVoiceInfo {
  return {
    provider: "chatterbox",
    id: CHATTERBOX_VOICE_MULTILINGUAL,
    name: "Chatterbox multilingüe",
    language: "es",
    installed,
  };
}

export function installedModel(row: TtsProviderInfo): ChatterboxModel | undefined {
  return row.installed && row.models?.length === 1 ? row.models[0] : undefined;
}

// ----------------------------------------------------------------------------- workers call

/** Worker failure → HttpError with the same code/details (job `result` keeps them). */
export function workersToHttp(err: unknown): unknown {
  if (err instanceof WorkersError && err.code !== PACK_REQUIRED && err.details !== undefined)
    return asJobError(new HttpError(err.statusCode, err.code, err.message, err.details));
  if (err instanceof WorkersError && err.code !== PACK_REQUIRED && !/^WORKERS_/.test(err.code))
    return asJobError(new HttpError(err.statusCode, err.code, err.message));
  return err;
}

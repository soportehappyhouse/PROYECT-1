import http from "node:http";
import {
  CHATTERBOX_PACK_ID,
  CHATTERBOX_LANGUAGES,
  CHATTERBOX_VOICE_MULTILINGUAL,
  validateChatterboxRequest,
  WorkerTtsResultSchema,
  type AiProvenance,
  type ChatterboxModel,
  type MediaAsset,
  type ResolvedChatterboxRequest,
  type TtsProviderInfo,
  type TtsRequest,
  type TtsVoiceInfo,
  type WorkerChatterboxFields,
  type WorkerTtsRequest,
  type WorkerTtsResult,
} from "@studio/shared";
import type { AppContext } from "../context.js";
import { requirePack } from "../jobs/handlers/ai.js";
import { currentDiagnostics } from "../jobs/diagnostics.js";
import { errorBody, HttpError } from "../lib/errors.js";
import { createConsentGate, type ConsentGate } from "../services/persons/gate.js";
import {
  packRequiredFromBody,
  WorkersError,
  type WorkerCallOptions,
  type WorkersClient,
} from "../services/workers-client.js";

/**
 * Sprint 4 M2 «Voz»: Chatterbox TTS + zero-shot cloning on the api side (docs/trabajo/
 * sprint4-contratos.md «M2»): provider row, voice row, request validation, the clone source
 * (Person with voice consent through M1's ConsentGate, or a «Voz propia» `voice-ref` asset) and the
 * workers call that keeps the Sprint 4 result fields (device, warnings, watermark, rtf, model).
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

/** Derived asset (RVC...) keeps the AI marks of its source, pointing back at it. */
export function inheritVoiceProvenance(
  source: Pick<MediaAsset, "id" | "aiAltered" | "aiProvenance">,
): { aiAltered?: true; aiProvenance?: AiProvenance } {
  if (!source.aiAltered && !source.aiProvenance) return {};
  return {
    aiAltered: true,
    ...(source.aiProvenance && {
      aiProvenance: { ...source.aiProvenance, sourceAssetId: source.id },
    }),
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

/** A workers error with its `{code, details}` (TOOL_FAILED logTail, CONSENT_REQUIRED...). */
export class WorkersCodedError extends WorkersError {
  constructor(
    message: string,
    statusCode: number,
    code: string,
    readonly details?: unknown,
  ) {
    super(message, statusCode, code);
    this.name = "WorkersCodedError";
  }
}

export type TtsExtendedCall = (
  req: WorkerTtsRequest & WorkerChatterboxFields,
  opts?: WorkerCallOptions,
) => Promise<WorkerTtsResult>;

function rawPost(
  target: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      target,
      {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", "content-length": payload.length },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/** Python `None` -> absent. */
function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).flatMap(([k, v]) => (v === null ? [] : [[k, stripNulls(v)]])),
    );
  return value;
}

/**
 * POST <workers>/tts keeping the Sprint 4 fields (the shared WorkersClient.tts schema strips them).
 * node:http (no 300 s undici timeout: CPU synthesis of 5000 characters can take long); progress
 * polled from GET /jobs/:jobId like the other long worker calls.
 */
export function createTtsExtendedCall(
  baseUrl: string,
  workers: Pick<WorkersClient, "jobProgress">,
): TtsExtendedCall {
  return async (req, opts) => {
    const url = new URL("/tts", baseUrl).toString();
    const diag = currentDiagnostics();
    const record = diag?.command("http", `POST ${url} ${JSON.stringify(req).slice(0, 2000)}`);
    let timer: NodeJS.Timeout | undefined;
    if (req.jobId && opts?.onProgress) {
      const onProgress = opts.onProgress;
      let last = -1;
      timer = setInterval(() => {
        void workers
          .jobProgress(req.jobId!)
          .then((p) => {
            if (p && p.status === "running" && p.progress !== last) {
              last = p.progress;
              onProgress(p.progress, p.message ?? undefined);
            }
          })
          .catch(() => undefined);
      }, opts.pollMs ?? 1000);
    }
    let res: { status: number; text: string };
    try {
      res = await rawPost(url, req, opts?.signal);
    } catch (err) {
      record?.end(null, String(err));
      if (opts?.signal?.aborted) throw err;
      throw new WorkersError(
        `Workers Python no disponibles en ${baseUrl} (¿está corriendo start.ps1?): ${String(err)}`,
        503,
        "WORKERS_UNAVAILABLE",
      );
    } finally {
      if (timer) clearInterval(timer);
    }
    record?.end(res.status);
    let json: unknown;
    try {
      json = res.text ? JSON.parse(res.text) : undefined;
    } catch {
      json = undefined;
    }
    if (res.status < 200 || res.status >= 300) {
      diag?.stderrLine(`[workers] HTTP ${res.status} POST /tts: ${res.text.slice(0, 4000)}`);
      const o = (json ?? {}) as { detail?: unknown; code?: string; details?: unknown };
      const message =
        typeof o.detail === "string"
          ? o.detail
          : o.detail !== undefined
            ? JSON.stringify(o.detail)
            : res.text.slice(0, 300) || `HTTP ${res.status}`;
      const pack = packRequiredFromBody(json);
      if (pack) throw new WorkersError(message, res.status, "PACK_REQUIRED", pack);
      throw new WorkersCodedError(
        message,
        res.status,
        o.code ?? `WORKERS_HTTP_${res.status}`,
        o.details,
      );
    }
    return WorkerTtsResultSchema.parse(stripNulls(json));
  };
}

/** Worker failure → HttpError with the same code/details (job `result` keeps them). */
export function workersToHttp(err: unknown): unknown {
  if (err instanceof WorkersCodedError)
    return asJobError(new HttpError(err.statusCode, err.code, err.message, err.details));
  return err;
}

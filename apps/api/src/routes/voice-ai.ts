import { stat } from "node:fs/promises";
import path from "node:path";
import {
  API_ROUTES,
  FEATURE_PACKS,
  ModelDownloadRequestSchema,
  RvcRequestSchema,
  TtsRequestSchema,
  type ModelDownloadProgress,
  type TtsProviderInfo,
} from "@studio/shared";
import type { FastifyInstance } from "fastify";
import { requirePack } from "../jobs/handlers/ai.js";
import { HttpError } from "../lib/errors.js";
import { WorkersError } from "../services/workers-client.js";
import { requireMediaAsset } from "../voice-ai/media-bridge.js";

/** Re-throw worker failures as uniform ApiError responses. */
export async function viaWorkers<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof WorkersError) throw new HttpError(err.statusCode, err.code, err.message);
    throw err;
  }
}

/**
 * Feedback 6: turn a failed model download into a clear Spanish message with a stable code
 * (offline / blocked by a proxy, HTTP 403, checksum mismatch, workers down).
 */
export function classifyDownloadError(err: WorkersError): HttpError {
  const m = err.message;
  if (err.code === "WORKERS_UNAVAILABLE")
    return new HttpError(503, "WORKERS_UNAVAILABLE", `No se pudo descargar: ${m}`);
  if (/HTTP 40[13]\b|\b403\b|Forbidden/i.test(m))
    return new HttpError(
      502,
      "DOWNLOAD_FORBIDDEN",
      "Hugging Face rechazó la descarga (HTTP 403). Puede ser un proxy o firewall de la red; " +
        "prueba otra conexión o descarga la voz con setup.ps1 -Models. Detalle: " +
        m,
    );
  if (/md5|sha256|tama[nñ]o|incompleta|vac[ií]o/i.test(m))
    return new HttpError(
      502,
      "DOWNLOAD_CHECKSUM",
      "El archivo descargado no coincide con el catálogo (checksum o tamaño): se descartó. " +
        "Vuelve a intentarlo. Detalle: " +
        m,
    );
  if (/red|network|connect|timed? ?out|resolve|proxy|getaddrinfo|ENOTFOUND/i.test(m))
    return new HttpError(
      502,
      "DOWNLOAD_OFFLINE",
      "Sin conexión con Hugging Face (¿estás sin Internet o detrás de un proxy?). Detalle: " + m,
    );
  return new HttpError(err.statusCode, err.code, m);
}

const PIPER_ID = /^[a-z]{2}_[A-Z]{2}-[A-Za-z0-9_]+-[a-z_]+$/;

/** Module (d) voice routes: Piper/cloud TTS and RVC through the Python workers. */
export function registerVoiceAiRoutes(app: FastifyInstance): void {
  const { config, queue, workers } = app.ctx;

  const providers = (): TtsProviderInfo[] => [
    { id: "piper", name: "Piper (local)", enabled: true, status: "local" },
    {
      id: "elevenlabs",
      name: "ElevenLabs",
      enabled: Boolean(config.keys.elevenlabs),
      status: config.keys.elevenlabs ? "configurado" : "no configurado",
    },
    {
      id: "openai",
      name: "OpenAI TTS",
      enabled: Boolean(config.keys.openai),
      status: config.keys.openai ? "configurado" : "no configurado",
    },
  ];

  app.get(API_ROUTES.ttsVoices, async () => viaWorkers(() => workers.ttsVoices()));
  app.get(API_ROUTES.ttsProviders, async () => providers());

  app.post(API_ROUTES.tts, async (req, reply) => {
    const body = TtsRequestSchema.parse(req.body);
    const provider = providers().find((p) => p.id === body.provider);
    if (!provider?.enabled)
      throw new HttpError(
        409,
        "PROVIDER_NOT_CONFIGURED",
        `${provider?.name ?? body.provider}: no configurado (agregá la key en .env)`,
      );
    const job = queue.enqueue({ type: "voice.tts", payload: body });
    return reply.code(202).send({ jobId: job.id });
  });

  app.get(API_ROUTES.rvcModels, async () => viaWorkers(() => workers.rvcModels()));

  app.post(API_ROUTES.rvc, async (req, reply) => {
    const body = RvcRequestSchema.parse(req.body);
    requireMediaAsset(app.ctx, body.assetId);
    await requirePack(workers, FEATURE_PACKS.rvc); // 409 PACK_REQUIRED (hubert + rmvpe)
    const job = queue.enqueue({ type: "voice.rvc", payload: body });
    return reply.code(202).send({ jobId: job.id });
  });

  app.post(API_ROUTES.voiceModelDownload, async (req) => {
    const body = ModelDownloadRequestSchema.parse(req.body);
    try {
      return await workers.downloadModel(body);
    } catch (err) {
      if (err instanceof WorkersError) throw classifyDownloadError(err);
      throw err;
    }
  });

  /** Progress of a running Piper download: size of models/piper/<id>.onnx(.part). */
  app.get<{ Querystring: { kind?: string; id?: string } }>(
    API_ROUTES.voiceModelDownloadProgress,
    async (req): Promise<ModelDownloadProgress> => {
      const { kind, id } = req.query;
      if (kind !== "piper" || !id || !PIPER_ID.test(id))
        throw new HttpError(400, "BAD_REQUEST", "Solo voces Piper (kind=piper&id=es_AR-…)");
      const base = path.join(config.modelsDir, "piper", `${id}.onnx`);
      const part = await stat(`${base}.part`).catch(() => undefined);
      if (part) return { bytes: part.size, active: true };
      const done = await stat(base).catch(() => undefined);
      return { bytes: done?.size ?? 0, active: false };
    },
  );
}

import {
  API_ROUTES,
  ModelDownloadRequestSchema,
  RvcRequestSchema,
  TtsRequestSchema,
  type TtsProviderInfo,
} from "@studio/shared";
import type { FastifyInstance } from "fastify";
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
    const job = queue.enqueue({ type: "voice.rvc", payload: body });
    return reply.code(202).send({ jobId: job.id });
  });

  app.post(API_ROUTES.voiceModelDownload, async (req) => {
    const body = ModelDownloadRequestSchema.parse(req.body);
    return viaWorkers(() => workers.downloadModel(body));
  });
}

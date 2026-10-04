import type { FastifyPluginAsync } from "fastify";
import { API_ROUTES, TranscribeRequestSchema } from "@studio/shared";
import { HttpError } from "../lib/errors.js";
import { requireMediaAsset } from "../voice-ai/media-bridge.js";

export const subtitleRoutes: FastifyPluginAsync = async (app) => {
  // Job "subtitles.transcribe": ffmpeg extracts 16 kHz mono WAV -> workers /transcribe
  // -> renders/<jobId>.{json,srt,ass}; the job result carries the Transcript (module d).
  app.post(API_ROUTES.transcribe, async (req, reply) => {
    const body = TranscribeRequestSchema.parse(req.body);
    const asset = requireMediaAsset(app.ctx, body.assetId);
    if (asset.kind !== "video" && asset.kind !== "audio")
      throw new HttpError(400, "BAD_REQUEST", "Solo se pueden transcribir medios de audio o video");
    const job = app.ctx.queue.enqueue({ type: "subtitles.transcribe", payload: body });
    return reply.code(202).send({ jobId: job.id });
  });
};

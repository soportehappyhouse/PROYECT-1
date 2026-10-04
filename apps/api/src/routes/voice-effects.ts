import type { FastifyReply, FastifyRequest } from "fastify";
import { AudioEffectRequestSchema } from "@studio/shared";
import { errorBody } from "../lib/errors.js";

/**
 * POST /api/voice/effects handler (module b): validates AudioEffectRequest (superset of the
 * contract's VoiceEffectRequest) and enqueues "voice.effect". Mounted from routes/voice.ts.
 */
export async function handleVoiceEffects(req: FastifyRequest, reply: FastifyReply) {
  const { repos, queue } = req.server.ctx;
  const body = AudioEffectRequestSchema.parse(req.body);
  if (!repos.media.get(body.assetId))
    return reply.code(404).send(errorBody("NOT_FOUND", "Media no encontrado"));
  for (const e of body.effects) {
    if (e.type === "ducking" && !repos.media.get(e.musicAssetId))
      return reply.code(404).send(errorBody("NOT_FOUND", "Música para ducking no encontrada"));
  }
  const job = queue.enqueue({ type: "voice.effect", payload: body });
  return reply.code(202).send({ jobId: job.id });
}

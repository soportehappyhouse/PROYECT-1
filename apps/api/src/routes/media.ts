import type { FastifyPluginAsync } from "fastify";
import { API_ROUTES } from "@studio/shared";
import { notImplemented } from "../lib/errors.js";

/**
 * TODO(module-b): multipart upload -> storage/media/<id>.<ext>, insert MediaAsset,
 * enqueue "media.probe" + "media.proxy"; stream files with HTTP Range support.
 */
export const mediaRoutes: FastifyPluginAsync = async (app) => {
  app.get(API_ROUTES.media, async (_req, reply) => notImplemented(reply, "module-b"));
  app.post(API_ROUTES.media, async (_req, reply) => notImplemented(reply, "module-b"));
  app.get(API_ROUTES.mediaItem, async (_req, reply) => notImplemented(reply, "module-b"));
  app.delete(API_ROUTES.mediaItem, async (_req, reply) => notImplemented(reply, "module-b"));
  app.get(API_ROUTES.mediaFile, async (_req, reply) => notImplemented(reply, "module-b"));
  app.post(API_ROUTES.mediaProxy, async (_req, reply) => notImplemented(reply, "module-b"));
};

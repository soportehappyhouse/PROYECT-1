import type { FastifyPluginAsync } from "fastify";
import { API_ROUTES } from "@studio/shared";
import { notImplemented } from "../lib/errors.js";

export const libraryRoutes: FastifyPluginAsync = async (app) => {
  app.get(API_ROUTES.libraryProviders, async () => {
    const { keys } = app.ctx.config;
    return [
      { id: "local", enabled: true },
      { id: "freesound", enabled: Boolean(keys.freesound) },
      { id: "pixabay", enabled: Boolean(keys.pixabay) },
    ];
  });
  // TODO(module-d): LibrarySearchQuerySchema; local = SQLite FTS5 over library_items; remote = Freesound
  // (token, previews only). Pixabay has no audio API (see docs/trabajo/fuentes-audio.md §7.11).
  app.get(API_ROUTES.library, async (_req, reply) => notImplemented(reply, "module-d"));
  // TODO(module-d): import local file or download remote item into storage/library with license metadata.
  app.post(API_ROUTES.libraryImport, async (_req, reply) => notImplemented(reply, "module-d"));
};

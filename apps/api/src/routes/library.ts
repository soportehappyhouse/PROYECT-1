import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  API_ROUTES,
  API_ROUTES_VOICE_AI,
  LibraryImportRequestSchema,
  LibraryItemKindSchema,
  LibraryItemUpdateSchema,
  LibrarySearchQuerySchema,
  type LibraryItemDetails,
  type MediaAsset,
} from "@studio/shared";
import { nanoid } from "nanoid";
import { z } from "zod";
import { HttpError } from "../lib/errors.js";
import { FreesoundProvider } from "../library/freesound.js";
import { LibraryIndex } from "../library/index-db.js";
import type { LibraryProviderAdapter } from "../library/types.js";
import { resolveStoragePath } from "../services/storage.js";
import { registerAudioAsset } from "../voice-ai/media-bridge.js";

const IdParams = z.object({ id: z.string().min(1) });

/**
 * Sound library (module d): local index over storage/library (SQLite FTS5 + waveform peaks) and
 * an optional Freesound connector (token in .env, previews only). Pixabay has no audio API.
 */
export const libraryRoutes: FastifyPluginAsync = async (app) => {
  const { config, db } = app.ctx;
  const index = new LibraryIndex(db, config.storageDir, config.ffmpegPath);
  const freesound = new FreesoundProvider(config.keys.freesound);
  const providers: Record<string, LibraryProviderAdapter> = { local: index, freesound };

  app.get(API_ROUTES.libraryProviders, async () => [
    { id: "local", enabled: true, status: index.status() },
    { id: "freesound", enabled: freesound.enabled(), status: freesound.status() },
    { id: "pixabay", enabled: false, status: "sin API de audio (importar a mano)" },
  ]);

  app.get(API_ROUTES.library, async (req) => {
    const query = LibrarySearchQuerySchema.parse(req.query);
    const provider = providers[query.provider];
    if (!provider)
      throw new HttpError(
        400,
        "PROVIDER_UNSUPPORTED",
        "Pixabay no ofrece API de audio: descargá el archivo y subilo a la biblioteca",
      );
    if (!provider.enabled())
      throw new HttpError(409, "PROVIDER_NOT_CONFIGURED", `${query.provider}: no configurado`);
    return provider.search(query);
  });

  app.post(API_ROUTES_VOICE_AI.libraryScan, async (req) => {
    const force = (req.query as { force?: string } | undefined)?.force === "true";
    return index.scan({ force });
  });

  app.get(API_ROUTES_VOICE_AI.libraryItem, async (req) => {
    const { id } = IdParams.parse(req.params);
    const item = index.details(id);
    if (!item) throw new HttpError(404, "NOT_FOUND", `Item de biblioteca ${id} no encontrado`);
    return item;
  });

  app.patch(API_ROUTES_VOICE_AI.libraryItem, async (req) => {
    const { id } = IdParams.parse(req.params);
    return index.update(id, LibraryItemUpdateSchema.parse(req.body));
  });

  app.delete(API_ROUTES_VOICE_AI.libraryItem, async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const deleteFile = (req.query as { deleteFile?: string } | undefined)?.deleteFile === "true";
    if (!(await index.remove(id, deleteFile)))
      throw new HttpError(404, "NOT_FOUND", `Item de biblioteca ${id} no encontrado`);
    return reply.code(204).send();
  });

  app.get(API_ROUTES_VOICE_AI.libraryPeaks, async (req) => {
    const { id } = IdParams.parse(req.params);
    return index.peaks(id);
  });

  /** Copy a library file into storage/media and register it as a MediaAsset for the timeline. */
  async function toMediaAsset(item: LibraryItemDetails): Promise<MediaAsset> {
    if (!item.path) throw new HttpError(400, "BAD_REQUEST", "El item no tiene archivo local");
    const id = nanoid();
    const rel = `media/${id}${path.extname(item.path).toLowerCase()}`;
    const dest = resolveStoragePath(config.storageDir, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(resolveStoragePath(config.storageDir, item.path), dest);
    return registerAudioAsset(app.ctx, {
      id,
      path: rel,
      name: item.name,
      ...(item.durationSec !== undefined && { durationSec: item.durationSec }),
    });
  }

  async function importUpload(req: FastifyRequest, reply: FastifyReply) {
    const file = await req.file();
    if (!file) throw new HttpError(400, "BAD_REQUEST", "Falta el archivo (campo 'file')");
    const field = (name: string): string | undefined => {
      const f = file.fields[name];
      const one = Array.isArray(f) ? f[0] : f;
      return one && one.type === "field" ? String(one.value) : undefined;
    };
    const kind = LibraryItemKindSchema.catch("sfx").parse(field("kind") ?? "sfx");
    const tags = (field("tags") ?? "")
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const data = await file.toBuffer();
    const name = field("name");
    const attribution = field("attribution");
    const { item, duplicate } = await index.importBuffer(data, {
      fileName: file.filename,
      kind,
      source: "upload",
      license: field("license") ?? "unknown",
      ...(name && { name }),
      ...(attribution && { attribution }),
      ...(tags.length && { tags }),
    });
    return reply.code(duplicate ? 200 : 201).send(item);
  }

  /**
   * multipart (field `file` + optional kind/tags/license/attribution/name) -> LibraryItemDetails;
   * JSON {provider, remoteId} -> MediaAsset ready for the timeline (remote items are first
   * downloaded into storage/library with their license metadata).
   */
  app.post(API_ROUTES.libraryImport, async (req, reply) => {
    if (req.isMultipart()) return importUpload(req, reply);
    const body = LibraryImportRequestSchema.parse(req.body);
    if (body.provider === "pixabay")
      throw new HttpError(400, "PROVIDER_UNSUPPORTED", "Pixabay no ofrece API de audio");
    if (body.provider === "local") {
      const item = index.details(body.remoteId);
      if (!item) throw new HttpError(404, "NOT_FOUND", `Item ${body.remoteId} no encontrado`);
      return reply.code(201).send(await toMediaAsset(item));
    }
    if (!freesound.enabled())
      throw new HttpError(409, "PROVIDER_NOT_CONFIGURED", "Freesound: falta FREESOUND_API_KEY");
    const remote = await freesound.fetch(body.remoteId);
    const data = await remote.download();
    const remoteNum = body.remoteId.replace(/^freesound:/, "");
    const { id: _remoteItemId, provider: _p, previewUrl: _u, ...meta } = remote.item;
    const { item } = await index.importBuffer(data, {
      ...meta,
      fileName: `${remoteNum}-${remote.item.name}.${remote.ext}`,
      kind: remote.item.kind,
      source: "freesound",
    });
    return reply.code(201).send(await toMediaAsset(item));
  });
};

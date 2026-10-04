import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { nanoid } from "nanoid";
import { API_ROUTES, MediaKindSchema, type MediaAssetDetails } from "@studio/shared";
import { z } from "zod";
import { errorBody, HttpError } from "../lib/errors.js";
import { sendFileWithRange } from "../lib/range.js";
import {
  derivativePaths,
  EXT_MIME,
  kindFor,
  safeDisplayName,
  safeExtension,
} from "../services/media-files.js";
import { resolveStoragePath, storageRelative } from "../services/storage.js";

const ListQuery = z.object({
  kind: MediaKindSchema.optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
});
const FileQuery = z.object({
  /** Serve the editing proxy instead of the original when it exists. */
  proxy: z.enum(["0", "1", "true", "false"]).optional(),
  download: z.enum(["0", "1", "true", "false"]).optional(),
});

/**
 * Media library: multipart upload -> storage/media/<id>.<ext> (the client name is only a label),
 * MediaAsset row, then `media.probe` (metadata, thumbnail, sprite, peaks) and `media.proxy` jobs.
 */
export const mediaRoutes: FastifyPluginAsync = async (app) => {
  const { repos, config, queue } = app.ctx;
  const abs = (rel: string) => resolveStoragePath(config.storageDir, rel);

  app.get(API_ROUTES.media, async (req) => {
    const q = ListQuery.parse(req.query);
    return repos.media.list({
      ...(q.kind && { kind: q.kind }),
      ...(q.limit && { limit: q.limit }),
    });
  });

  app.post(API_ROUTES.media, async (req, reply) => {
    if (!req.isMultipart())
      throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Se espera multipart/form-data");
    const file = await req.file();
    if (!file) throw new HttpError(400, "NO_FILE", "Falta el archivo (campo 'file')");
    const ext = safeExtension(file.filename, file.mimetype);
    const kind = kindFor(ext, file.mimetype);
    if (!ext || !kind) {
      file.file.resume();
      throw new HttpError(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        `Tipo de archivo no soportado: ${file.filename}`,
      );
    }
    const id = nanoid();
    const rel = storageRelative("media", `${id}.${ext}`);
    const target = abs(rel);
    const part = `${target}.part`;
    let size = 0;
    file.file.on("data", (chunk: Buffer) => (size += chunk.length));
    try {
      await pipeline(file.file, createWriteStream(part));
      if (file.file.truncated)
        throw new HttpError(413, "FILE_TOO_LARGE", "El archivo supera el límite");
      await rename(part, target);
    } catch (err) {
      await rm(part, { force: true });
      throw err;
    }
    const asset = repos.media.insert({
      id,
      kind,
      name: safeDisplayName(file.filename),
      path: rel,
      mimeType: EXT_MIME[ext] ?? file.mimetype,
      sizeBytes: size,
      createdAt: new Date().toISOString(),
    });
    if (kind === "video" || kind === "audio" || kind === "image") {
      queue.enqueue({ type: "media.probe", payload: { assetId: id }, priority: 1 });
      if (kind === "video") queue.enqueue({ type: "media.proxy", payload: { assetId: id } });
    }
    return reply.code(201).send(asset);
  });

  app.get<{ Params: { id: string } }>(API_ROUTES.mediaItem, async (req, reply) => {
    const asset = repos.media.get(req.params.id);
    return asset ?? reply.code(404).send(errorBody("NOT_FOUND", "Media no encontrado"));
  });

  app.delete<{ Params: { id: string } }>(API_ROUTES.mediaItem, async (req, reply) => {
    const asset = repos.media.get(req.params.id);
    if (!asset) return reply.code(404).send(errorBody("NOT_FOUND", "Media no encontrado"));
    for (const job of app.ctx.jobs.list({ limit: 500 })) {
      const payload = job.payload as { assetId?: string } | null;
      if (payload?.assetId === asset.id && (job.status === "queued" || job.status === "running"))
        queue.cancel(job.id);
    }
    repos.media.delete(asset.id);
    const d = derivativePaths(asset.id);
    const files = [
      asset.path,
      d.proxy,
      d.thumbnail,
      d.sprite,
      d.peaks,
      asset.proxyPath,
      asset.thumbnailPath,
    ];
    await Promise.all(
      [...new Set(files.filter((f): f is string => !!f))].map((f) =>
        rm(abs(f), { force: true }).catch(() => undefined),
      ),
    );
    return reply.code(204).send();
  });

  const serveFile = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const asset: MediaAssetDetails | undefined = repos.media.get(req.params.id);
    if (!asset) return reply.code(404).send(errorBody("NOT_FOUND", "Media no encontrado"));
    const q = FileQuery.parse(req.query);
    const wantProxy = (q.proxy === "1" || q.proxy === "true") && asset.proxyPath;
    const rel = wantProxy ? asset.proxyPath! : asset.path;
    const download = q.download === "1" || q.download === "true";
    const ext = rel.split(".").pop() ?? "";
    try {
      return await sendFileWithRange(
        req,
        reply,
        abs(rel),
        (wantProxy ? "video/mp4" : asset.mimeType) ?? EXT_MIME[ext] ?? "application/octet-stream",
        download ? asset.name : undefined,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT")
        return reply.code(404).send(errorBody("NOT_FOUND", "Archivo no encontrado en disco"));
      throw err;
    }
  };
  // GET (Fastify also exposes HEAD automatically; sendFileWithRange skips the body for HEAD).
  app.get(API_ROUTES.mediaFile, serveFile);

  app.post<{ Params: { id: string } }>(API_ROUTES.mediaProxy, async (req, reply) => {
    const asset = repos.media.get(req.params.id);
    if (!asset) return reply.code(404).send(errorBody("NOT_FOUND", "Media no encontrado"));
    if (asset.kind !== "video")
      return reply.code(400).send(errorBody("NOT_VIDEO", "Solo se generan proxies para video"));
    const job = queue.enqueue({ type: "media.proxy", payload: { assetId: asset.id } });
    return reply.code(202).send({ jobId: job.id });
  });
};

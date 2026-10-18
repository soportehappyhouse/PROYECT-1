import { createWriteStream } from "node:fs";
import { readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import fastifyStatic from "@fastify/static";
import {
  BUNDLED_FONTS_DIR,
  computeSourceHash,
  RemotionBrowserMissingError,
  closeStillBrowser,
  renderTemplateStill,
  setDesignTokensProvider,
} from "@studio/remotion";
import {
  API_ROUTES,
  canvasForAspect,
  checkDesignWithFix,
  DesignAspectSchema,
  DesignCheckRequestSchema,
  formatErrorEs,
  MotionStillRequestSchema,
  resolveDesign,
  SPRINT6_ERRORS,
  type DesignCheckResult,
} from "@studio/shared";
import type { FastifyPluginAsync } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import { motionMediaBaseUrl } from "../jobs/handlers/motion-render.js";
import { errorBody, HttpError } from "../lib/errors.js";
import { setAssDesign } from "../services/ffmpeg/ass.js";
import { ensureAssFontsDir } from "../services/design/fonts.js";
import { BrandKitRepo } from "../services/design/kit.js";
import { StillService, type StillRenderer } from "../services/design/still.js";
import { resolveStoragePath, storageRelative } from "../services/storage.js";

const LOGO_MAX_BYTES = 5 * 1024 * 1024;
/** PNG / JPEG by signature; SVG as text without scripts, event handlers or external links. */
export function logoContentOk(ext: string, buf: Buffer): boolean {
  if (ext === "png") return buf.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (ext === "jpg") return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const text = buf.toString("utf8");
  if (!/<svg[\s>]/i.test(text)) return false;
  return !/<script|<foreignobject|<!entity|\son\w+\s*=|javascript:|(?:xlink:)?href\s*=\s*["']?(?!#|data:image\/)/i.test(
    text,
  );
}

const LOGO_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
};

const TokensQuerySchema = z.object({
  aspect: DesignAspectSchema.optional(),
  w: z.coerce.number().int().min(16).max(8192).optional(),
  h: z.coerce.number().int().min(16).max(8192).optional(),
});

function logoInvalid(details?: unknown): HttpError {
  return new HttpError(
    SPRINT6_ERRORS.BRAND_LOGO_INVALID.status,
    "BRAND_LOGO_INVALID",
    formatErrorEs("BRAND_LOGO_INVALID"),
    details,
  );
}

/** Short Spanish reason of a failed still (shown inside «No se pudo generar la vista previa (…)»). */
export function stillReason(err: unknown): string {
  if (err instanceof RemotionBrowserMissingError)
    return "falta Chrome Headless Shell para Remotion";
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+/g, " ").slice(0, 160) || "error del motor";
}

/**
 * Sprint 6 M2 Sistema de diseño (docs/trabajo/sprint6-contratos.md §M2):
 *   GET | PUT brandKit       -> BrandKit (PUT BrandKitUpdate: only the fields sent)
 *   POST brandKitLogo        multipart `logo` (PNG/JPG/SVG ≤ 5 MB) -> BrandKit
 *   GET  designTokens        ?aspect=&w=&h= -> ResolvedDesign
 *   POST designCheck         DesignCheckRequest -> DesignCheckResult (+ project with fix:true)
 *   POST motionStill         MotionStillRequest -> image/png | image/jpeg (cache renders/stills)
 *   GET  /fonts/*            bundled OFL fonts (packages/remotion/public/fonts, immutable cache)
 * Registers the kit as the token source of the ASS burn-in and of Remotion renders.
 */
export const designRoutes: FastifyPluginAsync = async (app) => {
  const { ctx } = app;
  const kits = new BrandKitRepo(ctx.repos.settings);
  const fontsDir = ensureAssFontsDir(ctx.config.storageDir);
  if (!fontsDir)
    app.log.warn("No se pudieron preparar las tipografías para los subtítulos (tmp/fonts-ass)");
  setAssDesign({ tokens: () => kits.get().tokens, fontsDir });
  setDesignTokensProvider(() => kits.get().tokens);

  let version: Promise<string> | undefined;
  const render: StillRenderer = async (a) => {
    await renderTemplateStill({
      ...a,
      storageDir: ctx.config.storageDir,
      mediaBaseUrl: motionMediaBaseUrl(ctx.config),
    });
  };
  app.addHook("onClose", async () => closeStillBrowser());
  const stills = new StillService({
    storageDir: ctx.config.storageDir,
    render,
    ffmpegPath: ctx.config.ffmpegPath,
    assetPath: (id) => {
      const a = ctx.repos.media.get(id);
      return a ? resolveStoragePath(ctx.config.storageDir, a.path) : undefined;
    },
    version: () => (version ??= computeSourceHash().catch(() => "dev")),
  });

  app.get(API_ROUTES.brandKit, async () => kits.get());
  app.put(API_ROUTES.brandKit, async (req) => kits.update(req.body));

  app.post(API_ROUTES.brandKitLogo, async (req) => {
    if (!req.isMultipart()) throw logoInvalid({ reason: "multipart" });
    const file = await req.file({ limits: { fileSize: LOGO_MAX_BYTES } });
    if (!file) throw logoInvalid({ reason: "missing" });
    const ext = LOGO_TYPES[file.mimetype];
    if (!ext) {
      file.file.resume();
      throw logoInvalid({ type: file.mimetype });
    }
    const id = nanoid();
    const rel = storageRelative("media", `${id}.${ext}`);
    const target = resolveStoragePath(ctx.config.storageDir, rel);
    const part = `${target}.part`;
    let size = 0;
    file.file.on("data", (c: Buffer) => (size += c.length));
    try {
      await pipeline(file.file, createWriteStream(part));
      if (file.file.truncated || size > LOGO_MAX_BYTES) throw logoInvalid({ size });
      if (size === 0) throw logoInvalid({ size });
      // Audit S6 E20: the content must be what the type says; SVG without scripts or links out.
      const head = await readFile(part);
      if (!logoContentOk(ext, head))
        throw logoInvalid({ type: file.mimetype, content: "mismatch" });
      await rename(part, target);
    } catch (err) {
      await rm(part, { force: true });
      throw err;
    }
    // Audit S6 E13: replacing the logo deletes the previous one (it was only the kit's).
    const previous = kits.get().logo_asset_id;
    const old = previous ? ctx.repos.media.get(previous) : undefined;
    if (old && old.name.startsWith("Logo del kit")) {
      ctx.repos.media.delete(old.id);
      await rm(resolveStoragePath(ctx.config.storageDir, old.path), { force: true });
    }
    ctx.repos.media.insert({
      id,
      kind: "image",
      name: `Logo del kit${path.extname(file.filename || `.${ext}`) || `.${ext}`}`,
      path: rel,
      mimeType: file.mimetype,
      sizeBytes: size,
      createdAt: new Date().toISOString(),
    });
    return kits.update({ logo_asset_id: id });
  });

  app.get(API_ROUTES.designTokens, async (req) => {
    const q = TokensQuerySchema.parse(req.query ?? {});
    const canvas = q.w && q.h ? { w: q.w, h: q.h } : canvasForAspect(q.aspect ?? "9:16");
    return resolveDesign(kits.get().tokens, canvas, q.aspect);
  });

  app.post(API_ROUTES.designCheck, async (req, reply) => {
    const body = DesignCheckRequestSchema.parse(req.body ?? {});
    const project = ctx.repos.projects.get(body.projectId);
    if (!project)
      return reply.code(404).send(
        errorBody("PROJECT_NOT_FOUND", `No existe el proyecto ${body.projectId} (¿se borró?).`, {
          id: body.projectId,
        }),
      );
    const kit = kits.get();
    const first = checkDesignWithFix(project, kit, body.aspect);
    if (!body.fix || first.fixedCount === 0) return first.result;
    // fix:true -> the fixed project (not saved: the web applies it as one undo step).
    const again = checkDesignWithFix(first.fixed, kit, body.aspect);
    return {
      ...again.result,
      fixed: first.fixedCount,
      project: first.fixed,
    } satisfies DesignCheckResult;
  });

  app.post(API_ROUTES.motionStill, async (req, reply) => {
    const body = MotionStillRequestSchema.parse(req.body ?? {});
    const validation = ctx.motion.validate({
      schemaVersion: 1,
      engine: "remotion",
      template: body.template,
      props: body.props,
      durationSec: 1,
      fps: 30,
      width: body.width,
      height: body.height,
      format: body.format === "png" ? "webm-vp9-alpha" : "mp4-h264",
      includeAudio: false,
    });
    if (!validation.ok)
      throw new HttpError(400, "VALIDATION_ERROR", "Parámetros de la plantilla inválidos", {
        errors: validation.errors,
      });
    // The web aborts the previous preview when a control changes: drop it if still queued (E6).
    const ctrl = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) ctrl.abort();
    });
    try {
      const res = await stills.get(body, kits.get().tokens, ctrl.signal);
      return reply
        .header("content-type", res.contentType)
        .header("cache-control", "no-cache")
        .header("x-still-cache", res.cached ? "hit" : "miss")
        .header("x-still-ms", String(res.ms))
        .send(await readFile(res.file));
    } catch (err) {
      if ((err as Error).name === "AbortError" && ctrl.signal.aborted)
        return reply.code(499).send(errorBody("STILL_CANCELED", "Vista previa cancelada"));
      const reason = stillReason(err);
      return reply.code(SPRINT6_ERRORS.STILL_UNAVAILABLE.status).send(
        errorBody("STILL_UNAVAILABLE", formatErrorEs("STILL_UNAVAILABLE", { motivo: reason }), {
          reason,
        }),
      );
    }
  });

  // Bundled fonts for the web preview (@font-face) — same files as Remotion and libass.
  await app.register(fastifyStatic, {
    root: BUNDLED_FONTS_DIR,
    prefix: "/fonts/",
    decorateReply: false,
    immutable: true,
    maxAge: "365d",
    allowedPath: (p) => /\.(ttf|woff2?|txt|json)$/i.test(p),
  });
};

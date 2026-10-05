import { readFile } from "node:fs/promises";
import path from "node:path";
import { MotionEngineError } from "@studio/motion-engines";
import type { MotionMediaRef, MotionSpec } from "@studio/shared";
import type { RenderMetaProps } from "./schemas/common.js";
import { validateRemotionProps } from "./templates.js";

export interface InputPropsIo {
  readText(absPath: string): Promise<string>;
}

const defaultIo: InputPropsIo = { readText: (p) => readFile(p, "utf8") };

export interface InputPropsOptions {
  /** Absolute STORAGE_DIR. */
  storageDir: string;
  /** e.g. http://127.0.0.1:3001/files/ (serves STORAGE_DIR). */
  mediaBaseUrl: string;
  fontMode?: "google" | "system";
}

/** Normalize a STORAGE_DIR-relative path; rejects absolute paths and `..` segments. */
export function safeRelativePath(p: string): string {
  const posix = p.replace(/\\/g, "/").replace(/^\.\//, "");
  if (posix.startsWith("/") || /^[a-z]:/i.test(posix) || posix.split("/").includes("..")) {
    throw new MotionEngineError(`Ruta de medio no permitida: ${p}`, "remotion");
  }
  return posix;
}

/** STORAGE_DIR-relative path -> URL served by the api (`/files/`), each segment URL-encoded. */
export function mediaUrl(mediaBaseUrl: string, relPath: string): string {
  const base = mediaBaseUrl.endsWith("/") ? mediaBaseUrl : `${mediaBaseUrl}/`;
  return base + safeRelativePath(relPath).split("/").map(encodeURIComponent).join("/");
}

async function resolveMedia(
  key: string,
  ref: MotionMediaRef,
  opts: InputPropsOptions,
  io: InputPropsIo,
): Promise<Record<string, unknown>> {
  if (ref.kind === "captions") {
    // Transcript JSON (faster-whisper / shared Transcript) or Remotion Caption[]: inline it so
    // the composition does not need to fetch and the props get validated here.
    const abs = path.resolve(opts.storageDir, safeRelativePath(ref.path));
    let json: unknown;
    try {
      json = JSON.parse(await io.readText(abs));
    } catch (err) {
      throw new MotionEngineError(
        `No se pudo leer la transcripción ${ref.path}: ${(err as Error).message}`,
        "remotion",
      );
    }
    return Array.isArray(json) ? { captions: json } : { transcript: json };
  }
  return { [key]: mediaUrl(opts.mediaBaseUrl, ref.path) };
}

/**
 * MotionSpec -> Remotion inputProps: media refs become URLs (or inlined captions), props are
 * validated against the template's zod schema (defaults applied) and render meta is appended.
 * Throws MotionEngineError with Spanish messages on invalid props.
 */
export async function buildInputProps(
  spec: MotionSpec,
  opts: InputPropsOptions,
  io: InputPropsIo = defaultIo,
): Promise<Record<string, unknown> & RenderMetaProps> {
  let props: Record<string, unknown> = { ...spec.props };
  for (const [key, ref] of Object.entries(spec.media ?? {})) {
    props = { ...props, ...(await resolveMedia(key, ref, opts, io)) };
  }
  const validation = validateRemotionProps(spec.template, props);
  if (!validation.ok) throw new MotionEngineError(validation.errors.join("; "), "remotion");
  const meta: RenderMetaProps = {
    __width: spec.width,
    __height: spec.height,
    __fps: spec.fps,
    __durationInFrames: Math.max(1, Math.round(spec.durationSec * spec.fps)),
    __fontMode: opts.fontMode ?? "google",
  };
  return { ...validation.props, ...meta };
}

import { readFile } from "node:fs/promises";
import path from "node:path";
import { MotionEngineError } from "@studio/motion-engines";
import {
  aspectOfCanvas,
  captionMaxChars,
  DEFAULT_DESIGN_TOKENS,
  paginateSegments,
  resolveDesign,
  templateDesign,
  type CaptionStyle,
  type DesignTokens,
  type MotionMediaRef,
  type MotionSpec,
  type SubtitleSegment,
} from "@studio/shared";
import type { CaptionPageMeta, DesignMeta, RenderMetaProps } from "./schemas/common.js";
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
  /**
   * Sprint 6 M2: brand-kit tokens for the template (`__design`) and the caption pagination.
   * Absent = the provider set with setDesignTokensProvider (the api's kit); null = no kit.
   */
  tokens?: DesignTokens | null;
}

let designProvider: (() => DesignTokens | undefined) | null = null;

/** The api registers the brand kit here once (routes/design.ts); renders and stills read it. */
export function setDesignTokensProvider(fn: (() => DesignTokens | undefined) | null): void {
  designProvider = fn;
}

function currentTokens(opts: InputPropsOptions): DesignTokens | undefined {
  if (opts.tokens === null) return undefined;
  if (opts.tokens) return opts.tokens;
  try {
    return designProvider?.() ?? undefined;
  } catch {
    return undefined;
  }
}

/** Segments of the animated-captions input (transcript, or Remotion Caption[] as one-word segments). */
function captionSegments(props: Record<string, unknown>): SubtitleSegment[] {
  const caps = props.captions as { text: string; startMs: number; endMs: number }[] | undefined;
  if (caps && caps.length) {
    const words = caps.map((c) => ({
      word: c.text.trim(),
      start: c.startMs / 1000,
      end: c.endMs / 1000,
    }));
    return [
      {
        start: words[0]!.start,
        end: words.at(-1)!.end,
        text: words.map((w) => w.word).join(" "),
        words,
      },
    ];
  }
  const t = props.transcript as { segments?: SubtitleSegment[] } | undefined;
  return t?.segments ?? [];
}

/** Caption pages of an animated-captions clip by the design rules (≤ 2 lines, pauses, balance). */
export function animatedCaptionPages(
  props: Record<string, unknown>,
  width: number,
  height: number,
  tokens: DesignTokens = DEFAULT_DESIGN_TOKENS,
): CaptionPageMeta[] {
  const aspect = aspectOfCanvas(width, height);
  const resolved = resolveDesign(tokens, { w: width, h: height }, aspect);
  const style = {
    fontSize: typeof props.fontSize === "number" ? props.fontSize : 88,
    fontFamily:
      typeof props.fontFamily === "string" ? props.fontFamily : tokens.font.caption.family,
    uppercase: props.uppercase !== false,
  } as CaptionStyle;
  const pages = paginateSegments(captionSegments(props), tokens.caption, aspect, {
    maxChars: captionMaxChars(style, resolved),
    karaoke: props.style === "karaoke",
  });
  return pages.map((p) => {
    const first = p.lines[0].split(" ").length;
    return {
      startMs: Math.round(p.start * 1000),
      endMs: Math.round(p.end * 1000),
      lines: p.lines.length > 1 ? [first, p.words.length - first] : [p.words.length],
      tokens: p.words.map((w) => ({
        text: w.text,
        fromMs: Math.round(w.start * 1000),
        toMs: Math.round(w.end * 1000),
      })),
    };
  });
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
    __fontMode: opts.fontMode ?? "system",
  };
  const tokens = currentTokens(opts);
  if (tokens) {
    meta.__design = templateDesign(tokens, aspectOfCanvas(spec.width, spec.height)) as DesignMeta;
    if (spec.template === "animated-captions")
      meta.__pages = animatedCaptionPages(validation.props, spec.width, spec.height, tokens);
  }
  return { ...validation.props, ...meta };
}

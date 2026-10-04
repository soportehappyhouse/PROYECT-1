import path from "node:path";
import type { MediaKind } from "@studio/shared";

const EXT_KIND: Record<string, MediaKind> = {
  mp4: "video",
  mov: "video",
  mkv: "video",
  webm: "video",
  avi: "video",
  m4v: "video",
  mts: "video",
  m2ts: "video",
  ts: "video",
  wmv: "video",
  flv: "video",
  mpg: "video",
  mpeg: "video",
  "3gp": "video",
  gif: "video",
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
  aac: "audio",
  flac: "audio",
  ogg: "audio",
  opus: "audio",
  wma: "audio",
  aif: "audio",
  aiff: "audio",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  bmp: "image",
  tif: "image",
  tiff: "image",
  srt: "subtitle",
  ass: "subtitle",
  vtt: "subtitle",
  json: "lottie",
  lottie: "lottie",
};

const MIME_EXT: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/aac": "aac",
  "audio/webm": "webm",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/x-subrip": "srt",
  "text/vtt": "vtt",
  "application/json": "json",
};

export const EXT_MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  gif: "image/gif",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  bmp: "image/bmp",
  srt: "application/x-subrip",
  vtt: "text/vtt",
  ass: "text/plain",
  json: "application/json",
  lottie: "application/json",
  txt: "text/plain",
};

/** Lowercase, [a-z0-9] only, max 8 chars. */
export function safeExtension(fileName: string, mimeType?: string): string | undefined {
  const raw = path.extname(fileName).slice(1).toLowerCase();
  if (/^[a-z0-9]{1,8}$/.test(raw)) return raw;
  return mimeType ? MIME_EXT[mimeType.toLowerCase()] : undefined;
}

/** Media kind from extension (fallback: mime prefix). */
export function kindFor(ext: string | undefined, mimeType?: string): MediaKind | undefined {
  if (ext && EXT_KIND[ext]) return EXT_KIND[ext];
  const prefix = mimeType?.split("/")[0];
  if (prefix === "video" || prefix === "audio" || prefix === "image") return prefix;
  return undefined;
}

/**
 * Display name for an uploaded file: basename only (no directories), control chars and
 * Windows-reserved characters removed, trimmed to 200 chars. Never used as a storage path.
 */
export function safeDisplayName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const cleaned = [...base]
    .filter(
      (ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f && !'<>:"|?*'.includes(ch),
    )
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "archivo").slice(0, 200);
}

/** Slug usable as a file name on Windows and Linux ("Mi vídeo: final" -> "mi-video-final"). */
export function slugify(name: string, fallback = "export"): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
  return slug && !reserved.test(slug) ? slug : fallback;
}

/** 2026-10-04T15:30:12Z -> "20261004-153012" */
export function fileStamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

/** Derivative paths (relative to STORAGE_DIR) for an asset. */
export function derivativePaths(assetId: string) {
  return {
    proxy: `proxies/${assetId}.mp4`,
    thumbnail: `proxies/${assetId}.jpg`,
    sprite: `proxies/${assetId}.sprite.jpg`,
    peaks: `proxies/${assetId}.peaks.json`,
  };
}

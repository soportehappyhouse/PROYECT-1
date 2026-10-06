import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AGENT_DEFAULT_MODEL, DEFAULT_PORTS } from "@studio/shared";

/** Monorepo root (apps/api/src|dist -> ../../..). */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

const boolish = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

const EnvSchema = z.object({
  API_PORT: z.coerce.number().int().positive().default(DEFAULT_PORTS.api),
  API_HOST: z.string().default("127.0.0.1"),
  WEB_PORT: z.coerce.number().int().positive().default(DEFAULT_PORTS.web),
  WORKERS_URL: z.string().default(`http://127.0.0.1:${DEFAULT_PORTS.workers}`),
  STORAGE_DIR: z.string().default("./storage"),
  MODELS_DIR: z.string().default("./models"),
  FFMPEG_PATH: z.string().optional(),
  FFPROBE_PATH: z.string().optional(),
  USE_CUDA: boolish,
  /** Hardware H.264 encoder: auto-detect (nvenc/qsv/amf) or force libx264 with "off". */
  HW_ENCODER: z.enum(["auto", "off"]).default("auto"),
  /** Segment cache of the block render (storage/cache/segments), LRU-trimmed to this size. */
  SEGMENT_CACHE_MAX_GB: z.coerce.number().min(0).default(10),
  QUEUE_FFMPEG_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  QUEUE_MOTION_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  QUEUE_WORKERS_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  /** Remotion renderer (packages/remotion render.ts). Empty = Remotion defaults. */
  REMOTION_CONCURRENCY: z.string().optional(),
  REMOTION_BROWSER_EXECUTABLE: z.string().optional(),
  REMOTION_HW_ACCEL: boolish,
  /** "system" (default) never downloads fonts, so the first render works offline. */
  REMOTION_FONTS: z.enum(["google", "system"]).default("system"),
  REMOTION_BUNDLE_CACHE: z.string().optional(),
  REMOTION_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  /** Sprint 3 local agent (same keys the workers read; the workers talk to Ollama). */
  OLLAMA_URL: z.string().default("http://127.0.0.1:11434"),
  AGENT_MODEL: z.string().default(AGENT_DEFAULT_MODEL),
  AGENT_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  ELEVENLABS_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  FREESOUND_API_KEY: z.string().optional(),
  PIXABAY_API_KEY: z.string().optional(),
});

export interface ApiConfig {
  port: number;
  host: string;
  webOrigin: string;
  workersUrl: string;
  /** Absolute. */
  storageDir: string;
  /** Absolute. */
  modelsDir: string;
  ffmpegPath: string;
  ffprobePath: string;
  useCuda: boolean;
  hwEncoder: "auto" | "off";
  /** Max bytes kept in storage/cache/segments (0 = keep nothing after each export). */
  segmentCacheMaxBytes: number;
  /** Max concurrent jobs per queue lane. */
  queue: { ffmpeg: number; motion: number; workers: number };
  /** Remotion renderer overrides (only keys set in .env; see RemotionRendererSettings). */
  remotion: {
    concurrency?: number | string;
    browserExecutable?: string;
    hardwareAcceleration?: "disable" | "if-possible";
    fontMode?: "google" | "system";
    bundleCacheDir?: string;
    timeoutInMilliseconds?: number;
  };
  /** Sprint 3 local agent: OLLAMA_URL / AGENT_MODEL / AGENT_TEMPERATURE (.env). */
  agent: { ollamaUrl: string; model: string; temperature: number };
  logLevel: string;
  /** Secrets: never sent to the client; only `Boolean(key)` is exposed via /api/config. */
  keys: {
    elevenlabs?: string;
    openai?: string;
    anthropic?: string;
    freesound?: string;
    pixabay?: string;
  };
}

const empty = (v: string | undefined) => (v && v.trim() !== "" ? v : undefined);

/** Load `.env` from the repo root (if present) and build a typed config. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const envFile = path.join(REPO_ROOT, ".env");
  if (env === process.env && existsSync(envFile)) process.loadEnvFile(envFile);

  const e = EnvSchema.parse(Object.fromEntries(Object.entries(env).map(([k, v]) => [k, empty(v)])));
  return {
    port: e.API_PORT,
    host: e.API_HOST,
    webOrigin: `http://localhost:${e.WEB_PORT}`,
    workersUrl: e.WORKERS_URL,
    storageDir: path.resolve(REPO_ROOT, e.STORAGE_DIR),
    modelsDir: path.resolve(REPO_ROOT, e.MODELS_DIR),
    ffmpegPath: e.FFMPEG_PATH ?? "ffmpeg",
    ffprobePath: e.FFPROBE_PATH ?? "ffprobe",
    useCuda: e.USE_CUDA,
    hwEncoder: e.HW_ENCODER,
    segmentCacheMaxBytes: Math.round(e.SEGMENT_CACHE_MAX_GB * 1024 ** 3),
    queue: {
      ffmpeg: e.QUEUE_FFMPEG_CONCURRENCY,
      motion: e.QUEUE_MOTION_CONCURRENCY,
      workers: e.QUEUE_WORKERS_CONCURRENCY,
    },
    remotion: {
      ...(e.REMOTION_CONCURRENCY && {
        concurrency: /^\d+$/.test(e.REMOTION_CONCURRENCY)
          ? Number(e.REMOTION_CONCURRENCY)
          : e.REMOTION_CONCURRENCY,
      }),
      ...(e.REMOTION_BROWSER_EXECUTABLE && {
        browserExecutable: path.resolve(REPO_ROOT, e.REMOTION_BROWSER_EXECUTABLE),
      }),
      ...(e.REMOTION_HW_ACCEL && { hardwareAcceleration: "if-possible" as const }),
      fontMode: e.REMOTION_FONTS,
      ...(e.REMOTION_BUNDLE_CACHE && {
        bundleCacheDir: path.resolve(REPO_ROOT, e.REMOTION_BUNDLE_CACHE),
      }),
      ...(e.REMOTION_TIMEOUT_MS && { timeoutInMilliseconds: e.REMOTION_TIMEOUT_MS }),
    },
    agent: { ollamaUrl: e.OLLAMA_URL, model: e.AGENT_MODEL, temperature: e.AGENT_TEMPERATURE },
    logLevel: e.LOG_LEVEL,
    keys: {
      elevenlabs: e.ELEVENLABS_API_KEY,
      openai: e.OPENAI_API_KEY,
      anthropic: e.ANTHROPIC_API_KEY,
      freesound: e.FREESOUND_API_KEY,
      pixabay: e.PIXABAY_API_KEY,
    },
  };
}

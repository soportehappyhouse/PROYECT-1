import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_PORTS } from "@studio/shared";

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

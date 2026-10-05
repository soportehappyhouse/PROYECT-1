import { z } from "zod";
import { IdSchema, SecondsSchema } from "./common.js";
import { LibraryItemKindSchema, LibraryItemSchema } from "./library.js";
import { TranscriptSchema } from "./subtitles.js";
import { TtsProviderSchema, TtsVoiceSchema } from "./voice.js";

/** Workers-backed voice/subtitle job results and the local sound library (module d). */
export const TtsVoiceInfoSchema = TtsVoiceSchema.extend({
  quality: z.string().nullish(),
  sizeBytes: z.number().int().nonnegative().nullish(),
  /** True for PIPER_DEFAULT_VOICE. */
  default: z.boolean().optional(),
});
export type TtsVoiceInfo = z.infer<typeof TtsVoiceInfoSchema>;

export const TtsProviderStatusSchema = z.enum(["local", "configurado", "no configurado"]);

export const TtsProviderInfoSchema = z.object({
  id: TtsProviderSchema,
  name: z.string(),
  enabled: z.boolean(),
  status: TtsProviderStatusSchema,
});
export type TtsProviderInfo = z.infer<typeof TtsProviderInfoSchema>;

export const ModelDownloadRequestSchema = z.object({
  kind: z.enum(["piper", "whisper", "rvc-base"]),
  /** Piper voice id (es_AR-daniela-high) or whisper size (base). Unused for rvc-base. */
  id: z.string().min(1).optional(),
  force: z.boolean().default(false),
  includeLegacy: z.boolean().default(false),
});
export type ModelDownloadRequest = z.infer<typeof ModelDownloadRequestSchema>;
export type ModelDownloadRequestInput = z.input<typeof ModelDownloadRequestSchema>;

export const ModelDownloadResultSchema = z.object({
  kind: z.string(),
  id: z.string().nullish(),
  files: z.array(
    z.object({
      /** Relative to MODELS_DIR. */
      path: z.string(),
      sizeBytes: z.number().int().nonnegative(),
      skipped: z.boolean(),
    }),
  ),
});
export type ModelDownloadResult = z.infer<typeof ModelDownloadResultSchema>;

/** Bytes already written for an in-flight model download (the `.part` file in MODELS_DIR). */
export const ModelDownloadProgressSchema = z.object({
  bytes: z.number().int().nonnegative(),
  /** True while the `.part` file exists (download running). */
  active: z.boolean(),
});
export type ModelDownloadProgress = z.infer<typeof ModelDownloadProgressSchema>;

export const WorkerJobProgressSchema = z.object({
  jobId: z.string(),
  status: z.enum(["running", "succeeded", "failed"]),
  progress: z.number().min(0).max(1),
  message: z.string().nullish(),
  error: z.string().nullish(),
});
export type WorkerJobProgress = z.infer<typeof WorkerJobProgressSchema>;

/** Subtitle files written next to each other (relative to STORAGE_DIR). */
export const TranscriptFilesSchema = z.object({
  jsonPath: z.string(),
  srt: z.string(),
  ass: z.string(),
});
export type TranscriptFiles = z.infer<typeof TranscriptFilesSchema>;

export const TranscriptWithFilesSchema = TranscriptSchema.extend({
  model: z.string().nullish(),
  device: z.string().nullish(),
  files: TranscriptFilesSchema.nullish(),
});
export type TranscriptWithFiles = z.infer<typeof TranscriptWithFilesSchema>;

/** Result of a `subtitles.transcribe` job. `path` = word-level JSON (source of truth). */
export const TranscribeJobResultSchema = z.object({
  assetId: IdSchema,
  path: z.string(),
  srtPath: z.string(),
  assPath: z.string(),
  transcript: TranscriptSchema,
});
export type TranscribeJobResult = z.infer<typeof TranscribeJobResultSchema>;

/** Result of `voice.tts` / `voice.rvc` jobs (FileJobResult + duration). */
export const AudioJobResultSchema = z.object({
  assetId: IdSchema.optional(),
  path: z.string(),
  durationSec: SecondsSchema.optional(),
});
export type AudioJobResult = z.infer<typeof AudioJobResultSchema>;

/** Local library item with indexing metadata (GET /api/library/:id). */
export const LibraryItemDetailsSchema = LibraryItemSchema.extend({
  /** Relative to STORAGE_DIR (WaveformPeaks JSON). */
  peaksPath: z.string().optional(),
  sha256: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  author: z.string().optional(),
  sourceUrl: z.string().optional(),
  /** Pack / connector the file came from, e.g. "kenney", "freesound", "upload". */
  source: z.string().optional(),
});
export type LibraryItemDetails = z.infer<typeof LibraryItemDetailsSchema>;

export const LibraryItemUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  kind: LibraryItemKindSchema.optional(),
  tags: z.array(z.string().min(1)).optional(),
  license: z.string().min(1).optional(),
  attribution: z.string().optional(),
});
export type LibraryItemUpdate = z.infer<typeof LibraryItemUpdateSchema>;

export const LibraryScanResultSchema = z.object({
  scanned: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  errors: z.array(z.object({ path: z.string(), error: z.string() })),
});
export type LibraryScanResult = z.infer<typeof LibraryScanResultSchema>;

/** Body of POST /api/library/import when importing an indexed or remote item into the project. */
export const LibraryImportRequestSchema = z.object({
  provider: z.enum(["local", "freesound", "pixabay"]),
  /** Local item id, or provider id (e.g. "12345" or "freesound:12345"). */
  remoteId: z.string().min(1),
});
export type LibraryImportRequest = z.infer<typeof LibraryImportRequestSchema>;

/**
 * `_pack.json` manifest placed in a folder of storage/library (written by
 * scripts/library/import-cc0.ps1); applies to every audio file below it.
 */
export const LibraryPackManifestSchema = z.object({
  source: z.string().optional(),
  kind: LibraryItemKindSchema.optional(),
  license: z.string().optional(),
  attribution: z.string().optional(),
  author: z.string().optional(),
  url: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
export type LibraryPackManifest = z.infer<typeof LibraryPackManifestSchema>;

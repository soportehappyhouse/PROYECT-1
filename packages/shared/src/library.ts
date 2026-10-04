import { z } from "zod";
import { IdSchema, SecondsSchema } from "./common.js";

export const LibraryItemKindSchema = z.enum(["sfx", "music", "ambience"]);
export type LibraryItemKind = z.infer<typeof LibraryItemKindSchema>;

export const LibraryProviderSchema = z.enum(["local", "freesound", "pixabay"]);
export type LibraryProvider = z.infer<typeof LibraryProviderSchema>;

export const LibraryItemSchema = z.object({
  id: IdSchema,
  kind: LibraryItemKindSchema,
  name: z.string(),
  /** Relative to STORAGE_DIR (local items) — absent for remote search results. */
  path: z.string().optional(),
  previewUrl: z.url().optional(),
  tags: z.array(z.string()).default([]),
  durationSec: SecondsSchema.optional(),
  provider: LibraryProviderSchema,
  /** SPDX-ish license id (e.g. "CC0-1.0", "CC-BY-4.0", "Pixabay"). */
  license: z.string(),
  attribution: z.string().optional(),
});
export type LibraryItem = z.infer<typeof LibraryItemSchema>;

export const LibrarySearchQuerySchema = z.object({
  q: z.string().default(""),
  kind: LibraryItemKindSchema.optional(),
  provider: LibraryProviderSchema.default("local"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
});
export type LibrarySearchQuery = z.infer<typeof LibrarySearchQuerySchema>;

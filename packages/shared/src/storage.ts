/**
 * Storage layout contract (relative to STORAGE_DIR).
 * All paths exchanged between api <-> workers are RELATIVE to STORAGE_DIR (posix separators);
 * each service resolves them against its own STORAGE_DIR.
 */
export const STORAGE_SUBDIRS = {
  /** Original imported media (video/audio/images). */
  media: "media",
  /** Low-res editing proxies + thumbnails + waveforms. */
  proxies: "proxies",
  /** Intermediate renders (motion graphics, TTS, voice effects, RVC). */
  renders: "renders",
  /** Final exported files. */
  exports: "exports",
  /** Local SFX / music library. */
  library: "library",
} as const;

export type StorageArea = keyof typeof STORAGE_SUBDIRS;

/** SQLite file holding projects, jobs, settings, presets (inside STORAGE_DIR). */
export const DB_FILENAME = "studio.db";

/** Scratch folder for temp files (inside STORAGE_DIR). */
export const TMP_SUBDIR = "tmp";

/** Service logs (api-YYYY-MM-DD.log, kept 7 days; start.ps1 -SingleConsole also writes here). */
export const LOGS_SUBDIR = "logs";

/** Error reports: reports/<yyyyMMdd-HHmmss>-<slug>/ + reports/<same>.zip. Never served by /files. */
export const REPORTS_SUBDIR = "reports";

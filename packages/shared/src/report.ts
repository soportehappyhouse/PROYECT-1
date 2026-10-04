import { z } from "zod";
import { TimestampSchema } from "./common.js";

/**
 * Error reports (POST /api/reports): a pasteable diagnostic bundle written to
 * storage/reports/<yyyyMMdd-HHmmss>-<slug>/ and zipped next to it. See docs/REPORTAR-ERRORES.md.
 */

export const ReportSeveritySchema = z.enum(["low", "medium", "high", "blocker"]);
export type ReportSeverity = z.infer<typeof ReportSeveritySchema>;

/** UI labels (Spanish) shared by the web form and the generated reporte.md. */
export const REPORT_SEVERITY_LABELS: Record<ReportSeverity, string> = {
  low: "Baja (molestia menor)",
  medium: "Media (hay un rodeo)",
  high: "Alta (no puedo terminar lo que hacía)",
  blocker: "Bloqueante (la app no sirve)",
};

export const BreadcrumbCategorySchema = z.enum([
  "panel",
  "project",
  "track",
  "clip",
  "job",
  "settings",
  "api",
  "error",
  "ui",
]);
export type BreadcrumbCategory = z.infer<typeof BreadcrumbCategorySchema>;

/** One user action / event recorded by the dashboard (ring buffer of the last 50). */
export const UiBreadcrumbSchema = z.object({
  at: TimestampSchema,
  category: BreadcrumbCategorySchema,
  message: z.string().max(500),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type UiBreadcrumb = z.infer<typeof UiBreadcrumbSchema>;

/** A crash caught by the dashboard error boundary (or window.onerror). */
export const ClientErrorSchema = z.object({
  message: z.string().max(2000),
  stack: z.string().max(20_000).optional(),
  componentStack: z.string().max(20_000).optional(),
});
export type ClientError = z.infer<typeof ClientErrorSchema>;

export const CreateReportRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  /** What the user was doing: steps, expected vs. actual (free text, Spanish template). */
  steps: z.string().max(20_000).default(""),
  severity: ReportSeveritySchema.default("medium"),
  /** Copy thumbnails and small media files (<= 25 MB each) into the bundle. */
  includeMedia: z.boolean().default(false),
  uiBreadcrumbs: z.array(UiBreadcrumbSchema).max(200).default([]),
  /** Snapshot of dashboard state (settings without layout, browser info, panels, jobs). */
  uiState: z.record(z.string(), z.unknown()).optional(),
  jobIds: z.array(z.string().min(1).max(64)).max(50).default([]),
  projectId: z.string().min(1).max(64).optional(),
  /** Current in-memory project (may contain unsaved edits); falls back to the saved one. */
  project: z.unknown().optional(),
  clientError: ClientErrorSchema.optional(),
});
export type CreateReportRequest = z.infer<typeof CreateReportRequestSchema>;
export type CreateReportRequestInput = z.input<typeof CreateReportRequestSchema>;

export const ReportSummarySchema = z.object({
  /** Folder name: yyyyMMdd-HHmmss-<slug>. */
  id: z.string(),
  title: z.string(),
  severity: ReportSeveritySchema,
  createdAt: TimestampSchema,
  /** Absolute folder path (on the user's PC). */
  dir: z.string(),
  /** Absolute path of the .zip. */
  zipPath: z.string(),
  /** Relative to STORAGE_DIR, e.g. "reports/20261004-153012-exportar". */
  relativeDir: z.string(),
  zipBytes: z.number().int().nonnegative(),
});
export type ReportSummary = z.infer<typeof ReportSummarySchema>;

export const CreateReportResponseSchema = ReportSummarySchema.extend({
  /** Full reporte.md. */
  markdown: z.string(),
  /** Ready-to-paste "Prompt para Claude" block (also at the top of reporte.md). */
  prompt: z.string(),
  /** Files inside the folder (relative, posix). */
  files: z.array(z.string()),
});
export type CreateReportResponse = z.infer<typeof CreateReportResponseSchema>;

/** One external command or worker call made while a job ran (stored per job). */
export const JobCommandRecordSchema = z.object({
  kind: z.enum(["process", "http"]),
  /** Full command line (ffmpeg ...) or "POST http://127.0.0.1:8001/tts {json}". */
  command: z.string(),
  cwd: z.string().optional(),
  startedAt: TimestampSchema,
  durationMs: z.number().nonnegative().optional(),
  /** Process exit code or HTTP status; null when it could not start. */
  exitCode: z.number().int().nullable().optional(),
  error: z.string().optional(),
});
export type JobCommandRecord = z.infer<typeof JobCommandRecordSchema>;

/** Diagnostics persisted in jobs.diagnostics (GET /api/jobs/:id/diagnostics). */
export const JobDiagnosticsSchema = z.object({
  commands: z.array(JobCommandRecordSchema),
  /** Last 200 stderr lines of every process (and worker error bodies). */
  stderrTail: z.array(z.string()),
  timings: z.object({
    queuedMs: z.number().nonnegative().optional(),
    runMs: z.number().nonnegative().optional(),
    startedAt: TimestampSchema.optional(),
    finishedAt: TimestampSchema.optional(),
  }),
});
export type JobDiagnostics = z.infer<typeof JobDiagnosticsSchema>;

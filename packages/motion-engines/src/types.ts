import type {
  MotionEngineId,
  MotionOutputFormat,
  MotionSpec,
  MotionTemplateInfo,
} from "@studio/shared";

export interface MotionRenderProgress {
  phase: "preparing" | "bundling" | "rendering" | "encoding" | "done";
  /** 0..1 */
  ratio: number;
  message?: string;
}

export interface MotionRenderContext {
  jobId: string;
  /** Absolute STORAGE_DIR. */
  storageDir: string;
  /** Output file (or folder for png-sequence) RELATIVE to storageDir, e.g. "renders/<jobId>.webm". */
  outputPath: string;
  /** Absolute scratch dir for this job (inside storage/tmp). */
  tmpDir: string;
  /** Base URL serving STORAGE_DIR over HTTP (api `/files/`), for MediaRefs in headless browsers. */
  mediaBaseUrl: string;
  /** Aborted when the job is canceled. */
  signal?: AbortSignal;
  onProgress?: (progress: MotionRenderProgress) => void;
}

export interface MotionRenderResult {
  /** Relative to STORAGE_DIR. */
  path: string;
  format: MotionOutputFormat;
  hasAlpha: boolean;
  durationSec: number;
  width: number;
  height: number;
  engine: MotionEngineId;
  renderTimeMs: number;
}

export interface MotionEngineCapabilities {
  formats: MotionOutputFormat[];
  templates: string[];
  /** Can produce transparent output (webm-vp9-alpha / prores-4444 / png-sequence). */
  supportsAlpha: boolean;
  /** Highest fps accepted by the engine. */
  maxFps: number;
  /** Longest render accepted (seconds). */
  maxDurationSec: number;
  /** Runs without a GPU. */
  cpuOnly: boolean;
  /** Requires the system FFmpeg (not the one bundled by Remotion). */
  needsSystemFfmpeg: boolean;
}

export interface MotionAvailability {
  ok: boolean;
  /** Spanish, user-facing reason when ok=false (e.g. "Falta Chrome Headless Shell"). */
  reason?: string;
}

export type MotionValidation = { ok: true } | { ok: false; errors: string[] };

/**
 * Contract every motion-graphics engine adapter implements.
 * The api's `motion.render` job handler only talks to the registry / this interface.
 */
export interface MotionEngine {
  readonly id: MotionEngineId;
  readonly displayName: string;
  capabilities(): MotionEngineCapabilities;
  /** Checks prerequisites (headless browser, FFmpeg...). Never throws. */
  checkAvailable(): Promise<MotionAvailability>;
  listTemplates(): Promise<MotionTemplateInfo[]>;
  /** Validate props/format against the template before enqueueing. */
  validate(spec: MotionSpec): MotionValidation;
  render(spec: MotionSpec, ctx: MotionRenderContext): Promise<MotionRenderResult>;
  /** Release cached resources (bundle, browser). */
  dispose?(): Promise<void>;
}

export interface MotionEngineStatus extends MotionAvailability {
  id: MotionEngineId;
  displayName: string;
  capabilities: MotionEngineCapabilities;
}

/** File extension for a format ("" for png-sequence, which is a folder). */
export function outputExtension(format: MotionOutputFormat): string {
  switch (format) {
    case "mp4-h264":
      return ".mp4";
    case "webm-vp9-alpha":
      return ".webm";
    case "prores-4444":
      return ".mov";
    case "png-sequence":
      return "";
  }
}

const PHASE_WEIGHTS: Record<MotionRenderProgress["phase"], [number, number]> = {
  preparing: [0, 0.02],
  bundling: [0.02, 0.15],
  rendering: [0.15, 0.95],
  encoding: [0.95, 0.99],
  done: [1, 1],
};

/**
 * Collapse phase-local progress into one 0..1 value for the Jobs panel.
 * Remotion's renderMedia progress already covers render+encode, so "rendering" spans most of it.
 */
export function overallProgress(p: MotionRenderProgress): number {
  const [from, to] = PHASE_WEIGHTS[p.phase];
  const r = Math.min(1, Math.max(0, Number.isFinite(p.ratio) ? p.ratio : 0));
  return from + (to - from) * r;
}

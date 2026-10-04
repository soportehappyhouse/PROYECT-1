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

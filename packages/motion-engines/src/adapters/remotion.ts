import type { MotionSpec, MotionTemplateInfo } from "@studio/shared";
import type {
  MotionAvailability,
  MotionEngine,
  MotionRenderContext,
  MotionRenderResult,
  MotionValidation,
} from "../types.js";

/**
 * Render function provided by @studio/remotion (`renderMotion`).
 * Injected to keep this package free of the heavy Remotion/Chrome dependency tree.
 */
export type RemotionRenderFn = (
  spec: MotionSpec,
  ctx: MotionRenderContext,
) => Promise<MotionRenderResult>;

export interface RemotionEngineOptions {
  render: RemotionRenderFn;
  templates: readonly MotionTemplateInfo[];
  /** Template zod validation (@studio/remotion `validateRemotionProps`). */
  validateProps?: (templateId: string, props: unknown) => MotionValidation;
  /** e.g. check Chrome Headless Shell (`pnpm --filter @studio/remotion browser:ensure`). */
  checkAvailable?: () => Promise<MotionAvailability>;
  dispose?: () => Promise<void>;
}

export const REMOTION_CAPABILITIES = {
  formats: ["mp4-h264", "webm-vp9-alpha", "prores-4444", "png-sequence"],
  supportsAlpha: true,
  maxFps: 120,
  maxDurationSec: 60 * 30,
  cpuOnly: true,
  needsSystemFfmpeg: false,
} as const;

/** Primary, fully supported engine. All options come from @studio/remotion REMOTION_ENGINE_OPTIONS. */
export function createRemotionEngine(options: RemotionEngineOptions): MotionEngine {
  const templateIds = options.templates.map((t) => t.id);
  return {
    id: "remotion",
    displayName: "Remotion",
    capabilities: () => ({
      ...REMOTION_CAPABILITIES,
      formats: [...REMOTION_CAPABILITIES.formats],
      templates: templateIds,
    }),
    checkAvailable: options.checkAvailable ?? (() => Promise.resolve({ ok: true })),
    listTemplates: () => Promise.resolve([...options.templates]),
    validate: (spec) => {
      if (!templateIds.includes(spec.template))
        return { ok: false, errors: [`Plantilla Remotion desconocida: ${spec.template}`] };
      return options.validateProps?.(spec.template, spec.props) ?? { ok: true };
    },
    render: (spec, ctx) => options.render(spec, ctx),
    ...(options.dispose && { dispose: options.dispose }),
  };
}

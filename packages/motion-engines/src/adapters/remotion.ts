import type { MotionSpec, MotionTemplateInfo } from "@studio/shared";
import type {
  MotionAvailability,
  MotionEngine,
  MotionRenderContext,
  MotionRenderResult,
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
  /** e.g. check Chrome Headless Shell (`npx remotion browser ensure`). */
  checkAvailable?: () => Promise<MotionAvailability>;
  dispose?: () => Promise<void>;
}

/** Primary, fully supported engine. */
export function createRemotionEngine(options: RemotionEngineOptions): MotionEngine {
  const templateIds = options.templates.map((t) => t.id);
  return {
    id: "remotion",
    displayName: "Remotion",
    capabilities: () => ({
      formats: ["mp4-h264", "webm-vp9-alpha", "prores-4444", "png-sequence"],
      templates: templateIds,
      cpuOnly: true,
      needsSystemFfmpeg: false,
    }),
    checkAvailable: options.checkAvailable ?? (() => Promise.resolve({ ok: true })),
    listTemplates: () => Promise.resolve([...options.templates]),
    validate: (spec) =>
      templateIds.includes(spec.template)
        ? // TODO(module-c): validate spec.props with the template's zod schema.
          { ok: true }
        : { ok: false, errors: [`Plantilla Remotion desconocida: ${spec.template}`] },
    render: (spec, ctx) => options.render(spec, ctx),
    ...(options.dispose && { dispose: options.dispose }),
  };
}

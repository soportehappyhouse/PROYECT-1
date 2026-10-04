import type { MotionTemplateInfo } from "@studio/shared";
import { MotionEngineNotImplementedError } from "../errors.js";
import type { MotionEngine } from "../types.js";

const TEMPLATES: MotionTemplateInfo[] = [
  {
    engine: "motion-canvas",
    id: "hello-circle",
    name: "Círculo animado (ejemplo)",
    description: "Example scene: a circle that scales in and changes color.",
    defaultProps: { color: "#e13238", text: "Hola" },
    defaultDurationSec: 3,
    supportsAlpha: false,
  },
];

/**
 * Motion Canvas adapter — SKELETON.
 * TODO(module-c): per docs/trabajo/fuentes-motion.md, implement on top of Revideo `renderVideo`
 * (MIT, mp4 only) or a PNG-sequence export + FFmpeg for alpha. One example scene required.
 */
export function createMotionCanvasEngine(): MotionEngine {
  return {
    id: "motion-canvas",
    displayName: "Motion Canvas",
    capabilities: () => ({
      formats: ["mp4-h264"],
      templates: TEMPLATES.map((t) => t.id),
      cpuOnly: true,
      needsSystemFfmpeg: true,
    }),
    checkAvailable: () =>
      Promise.resolve({ ok: false, reason: "Adaptador Motion Canvas pendiente (module-c)" }),
    listTemplates: () => Promise.resolve(TEMPLATES),
    validate: () => ({ ok: true }),
    render: () => Promise.reject(new MotionEngineNotImplementedError("motion-canvas")),
  };
}

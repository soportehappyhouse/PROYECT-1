import type { MotionSpecInput, MotionTemplateInfo } from "@studio/shared";
import { z } from "zod";
import { MotionEngineNotImplementedError } from "../errors.js";
import type { MotionEngine } from "../types.js";

/** Props of the example scene (what a Revideo `variables` object would receive). */
export const helloCircleSchema = z.object({
  text: z.string().max(80).meta({ title: "Texto" }).default("Hola"),
  color: z.string().meta({ title: "Color", format: "color" }).default("#e13238"),
});

const TEMPLATES: MotionTemplateInfo[] = [
  {
    engine: "motion-canvas",
    id: "hello-circle",
    name: "Círculo animado (ejemplo)",
    description:
      "Escena de ejemplo: un círculo que crece y cambia de color. Motor aún no disponible.",
    propsSchema: z.toJSONSchema(helloCircleSchema, { io: "input" }),
    defaultProps: helloCircleSchema.parse({}),
    defaultDurationSec: 3,
    supportsAlpha: false,
  },
];

/** Minimal spec for this engine (used in docs/tests; renders once the adapter is implemented). */
export const MOTION_CANVAS_EXAMPLE_SPEC: MotionSpecInput = {
  engine: "motion-canvas",
  template: "hello-circle",
  props: { text: "Hola", color: "#e13238" },
  durationSec: 3,
  fps: 30,
  width: 1920,
  height: 1080,
  format: "mp4-h264",
};

/**
 * Motion Canvas adapter — DOCUMENTED STUB (render throws NOT_IMPLEMENTED).
 *
 * Motion Canvas 3.x has no official headless render API and its FFmpeg exporter emits mp4 without
 * alpha (docs/trabajo/fuentes-motion.md §3). The planned path is **Revideo** (MIT fork,
 * `@revideo/renderer`):
 *   1. Add a `packages/motion-canvas-scenes` Vite project with `src/scenes/hello-circle.tsx`
 *      reading `useScene().variables.get("text"|"color")`.
 *   2. In render(): `renderVideo({ projectFile, variables: spec.props, settings: { outFile:
 *      <ctx.outputPath>.mp4, ffmpeg: { ffmpegPath }, progressCallback: (_, p) => ctx.onProgress } })`.
 *   3. For alpha: export a PNG sequence and encode with the system ffmpeg
 *      (`-c:v libvpx-vp9 -pix_fmt yuva420p`), reusing ../ffmpeg/title.ts `encoderArgs`.
 * `checkAvailable` reports ok:false until then, so the dashboard greys it out.
 */
export function createMotionCanvasEngine(): MotionEngine {
  return {
    id: "motion-canvas",
    displayName: "Motion Canvas (Revideo)",
    capabilities: () => ({
      formats: ["mp4-h264"],
      templates: TEMPLATES.map((t) => t.id),
      supportsAlpha: false,
      maxFps: 60,
      maxDurationSec: 600,
      cpuOnly: true,
      needsSystemFfmpeg: true,
    }),
    checkAvailable: () =>
      Promise.resolve({
        ok: false,
        reason: "Motor Motion Canvas no implementado todavía (se hará sobre Revideo).",
      }),
    listTemplates: () => Promise.resolve(TEMPLATES),
    validate: (spec) => {
      const parsed = helloCircleSchema.safeParse(spec.props);
      return parsed.success
        ? { ok: true }
        : {
            ok: false,
            errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
          };
    },
    render: () => Promise.reject(new MotionEngineNotImplementedError("motion-canvas")),
  };
}

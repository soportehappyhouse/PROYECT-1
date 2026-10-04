import { MotionSpecSchema } from "@studio/shared";
import { describe, expect, it } from "vitest";
import {
  createDefaultRegistry,
  MotionEngineError,
  MotionEngineNotImplementedError,
  MotionEngineRegistry,
  type MotionRenderContext,
  UnknownMotionEngineError,
} from "../src/index.js";

const ctx: MotionRenderContext = {
  jobId: "job1",
  storageDir: "/tmp/storage",
  outputPath: "renders/test.mp4",
  tmpDir: "/tmp/storage/tmp/job1",
  mediaBaseUrl: "http://127.0.0.1:3001/files/",
};

describe("MotionEngineRegistry", () => {
  const registry = createDefaultRegistry({
    ffmpegPath: "ffmpeg",
    remotion: {
      templates: [
        {
          engine: "remotion",
          id: "title-card",
          name: "Título",
          defaultProps: {},
          defaultDurationSec: 3,
          supportsAlpha: true,
        },
      ],
      render: (spec, c) =>
        Promise.resolve({
          path: c.outputPath,
          format: spec.format,
          hasAlpha: false,
          durationSec: spec.durationSec,
          width: spec.width,
          height: spec.height,
          engine: "remotion",
          renderTimeMs: 1,
        }),
    },
  });

  it("registers the three engines", () => {
    expect(registry.list().map((e) => e.id)).toEqual([
      "remotion",
      "motion-canvas",
      "ffmpeg-lottie",
    ]);
  });

  it("resolves the engine from the template when spec.engine is absent", async () => {
    const spec = MotionSpecSchema.parse({ template: "title-card", durationSec: 2 });
    expect(registry.resolve(spec).id).toBe("remotion");
    await expect(registry.render(spec, ctx)).resolves.toMatchObject({ path: "renders/test.mp4" });
  });

  it("rejects unknown templates", () => {
    const spec = MotionSpecSchema.parse({ template: "nope", durationSec: 2 });
    expect(() => registry.resolve(spec)).toThrow(MotionEngineError);
  });

  it("stub engines reject with NotImplemented", async () => {
    const spec = MotionSpecSchema.parse({
      engine: "motion-canvas",
      template: "hello-circle",
      durationSec: 2,
    });
    await expect(registry.render(spec, ctx)).rejects.toBeInstanceOf(
      MotionEngineNotImplementedError,
    );
  });

  it("reports status without throwing", async () => {
    const status = await registry.status();
    expect(status.find((s) => s.id === "motion-canvas")).toMatchObject({ ok: false });
  });

  it("throws on unknown engine", () => {
    expect(() => new MotionEngineRegistry().get("remotion")).toThrow(UnknownMotionEngineError);
  });
});

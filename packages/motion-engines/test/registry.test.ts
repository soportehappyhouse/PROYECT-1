import { MotionSpecSchema, type MotionTemplateInfo } from "@studio/shared";
import { describe, expect, it } from "vitest";
import {
  checkCapabilities,
  createDefaultRegistry,
  createMotionCanvasEngine,
  MOTION_CANVAS_EXAMPLE_SPEC,
  MotionEngineError,
  MotionEngineNotImplementedError,
  MotionEngineRegistry,
  type MotionRenderContext,
  MotionValidationError,
  outputExtension,
  overallProgress,
  UnknownMotionEngineError,
} from "../src/index.js";

const ctx: MotionRenderContext = {
  jobId: "job1",
  storageDir: "/tmp/storage",
  outputPath: "renders/test.mp4",
  tmpDir: "/tmp/storage/tmp/job1",
  mediaBaseUrl: "http://127.0.0.1:3001/files/",
};

const titleTemplate: MotionTemplateInfo = {
  engine: "remotion",
  id: "title-card",
  name: "Título",
  defaultProps: {},
  defaultDurationSec: 3,
  supportsAlpha: true,
};

function makeRegistry(
  validateProps?: (id: string, props: unknown) => { ok: true } | { ok: false; errors: string[] },
) {
  return createDefaultRegistry({
    ffmpegPath: "ffmpeg-that-does-not-exist",
    remotion: {
      templates: [titleTemplate],
      ...(validateProps && { validateProps }),
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
}

describe("MotionEngineRegistry", () => {
  const registry = makeRegistry();

  it("registers the three engines", () => {
    expect(registry.list().map((e) => e.id)).toEqual([
      "remotion",
      "motion-canvas",
      "ffmpeg-lottie",
    ]);
  });

  it("exposes capability flags per engine", () => {
    const caps = Object.fromEntries(registry.list().map((e) => [e.id, e.capabilities()]));
    expect(caps.remotion).toMatchObject({ supportsAlpha: true, needsSystemFfmpeg: false });
    expect(caps.remotion?.formats).toContain("webm-vp9-alpha");
    expect(caps["motion-canvas"]).toMatchObject({ supportsAlpha: false, formats: ["mp4-h264"] });
    expect(caps["ffmpeg-lottie"]).toMatchObject({ supportsAlpha: true, needsSystemFfmpeg: true });
    for (const c of Object.values(caps)) expect(c.maxFps).toBeGreaterThanOrEqual(60);
  });

  it("resolves the engine from the template when spec.engine is absent", async () => {
    const spec = MotionSpecSchema.parse({ template: "title-card", durationSec: 2 });
    expect(registry.resolve(spec).id).toBe("remotion");
    await expect(registry.render(spec, ctx)).resolves.toMatchObject({ path: "renders/test.mp4" });
    const ff = MotionSpecSchema.parse({ template: "ffmpeg-title", durationSec: 2 });
    expect(registry.resolve(ff).id).toBe("ffmpeg-lottie");
  });

  it("rejects unknown templates", () => {
    const spec = MotionSpecSchema.parse({ template: "nope", durationSec: 2 });
    expect(() => registry.resolve(spec)).toThrow(MotionEngineError);
    expect(registry.validate(spec)).toMatchObject({ ok: false });
  });

  it("validate() checks capabilities: format, fps and template per engine", () => {
    const mc = MotionSpecSchema.parse({ ...MOTION_CANVAS_EXAMPLE_SPEC, format: "prores-4444" });
    const v = registry.validate(mc);
    expect(v).toMatchObject({ ok: false, engine: "motion-canvas" });
    const fps = MotionSpecSchema.parse({ template: "title-card", durationSec: 1, fps: 500 });
    expect(registry.validate(fps).ok).toBe(false);
    const wrongEngine = MotionSpecSchema.parse({
      engine: "ffmpeg-lottie",
      template: "title-card",
      durationSec: 1,
    });
    expect(registry.validate(wrongEngine).ok).toBe(false);
  });

  it("delegates props validation to the engine and render throws MotionValidationError", async () => {
    const strict = makeRegistry((id, props) =>
      (props as { title?: unknown }).title === 1
        ? { ok: false, errors: [`${id}: title inválido`] }
        : { ok: true },
    );
    const bad = MotionSpecSchema.parse({
      template: "title-card",
      props: { title: 1 },
      durationSec: 1,
    });
    expect(strict.validate(bad)).toEqual({
      ok: false,
      errors: ["title-card: title inválido"],
      engine: "remotion",
    });
    await expect(strict.render(bad, ctx)).rejects.toBeInstanceOf(MotionValidationError);
  });

  it("stub engines reject with NotImplemented (code NOT_IMPLEMENTED)", async () => {
    const spec = MotionSpecSchema.parse(MOTION_CANVAS_EXAMPLE_SPEC);
    const err = await registry.render(spec, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MotionEngineNotImplementedError);
    expect((err as MotionEngineNotImplementedError).code).toBe("NOT_IMPLEMENTED");
  });

  it("reports status without throwing (missing ffmpeg -> ok:false + reason)", async () => {
    const status = await registry.status();
    expect(status.find((s) => s.id === "motion-canvas")).toMatchObject({ ok: false });
    expect(status.find((s) => s.id === "ffmpeg-lottie")?.reason).toMatch(/FFmpeg/);
    expect(status.find((s) => s.id === "remotion")).toMatchObject({ ok: true });
  });

  it("lists templates of every engine with engine id and JSON schema", async () => {
    const templates = await registry.listTemplates();
    expect(templates.map((t) => `${t.engine}:${t.id}`)).toEqual([
      "remotion:title-card",
      "motion-canvas:hello-circle",
      "ffmpeg-lottie:ffmpeg-title",
    ]);
    expect(templates.find((t) => t.id === "ffmpeg-title")?.propsSchema).toMatchObject({
      type: "object",
    });
  });

  it("register() replaces an engine with the same id keeping its position", () => {
    const r = makeRegistry();
    r.register({ ...createMotionCanvasEngine(), displayName: "MC v2" });
    expect(r.list().map((e) => e.id)).toEqual(["remotion", "motion-canvas", "ffmpeg-lottie"]);
    expect(r.get("motion-canvas").displayName).toBe("MC v2");
  });

  it("throws on unknown engine", () => {
    expect(() => new MotionEngineRegistry().get("remotion")).toThrow(UnknownMotionEngineError);
  });
});

describe("helpers", () => {
  it("checkCapabilities", () => {
    const spec = MotionSpecSchema.parse({ template: "x", durationSec: 1000 });
    const v = checkCapabilities(
      spec,
      {
        formats: [],
        templates: [],
        supportsAlpha: false,
        maxFps: 30,
        maxDurationSec: 10,
        cpuOnly: true,
        needsSystemFfmpeg: false,
      },
      "e",
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors).toHaveLength(3);
  });

  it("outputExtension + overallProgress", () => {
    expect(outputExtension("prores-4444")).toBe(".mov");
    expect(outputExtension("png-sequence")).toBe("");
    expect(overallProgress({ phase: "preparing", ratio: 0 })).toBe(0);
    expect(overallProgress({ phase: "rendering", ratio: 0.5 })).toBeCloseTo(0.55);
    expect(overallProgress({ phase: "done", ratio: 1 })).toBe(1);
    expect(overallProgress({ phase: "rendering", ratio: Number.NaN })).toBeCloseTo(0.15);
  });
});

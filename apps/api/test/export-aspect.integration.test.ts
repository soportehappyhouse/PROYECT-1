import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AspectChoiceRequiredDetailsSchema, type ExportPreset, type Project } from "@studio/shared";
import { clip, gen, harness, hasFfmpeg, probeVideo, type Harness } from "./export-harness.js";

/**
 * Sprint 5 (M3, decision «9:16 principal»): a horizontal canvas exported to a vertical preset needs
 * an explicit framing: 409 ASPECT_CHOICE_REQUIRED without it, `center` = centered crop without
 * bars, `blur` = the old blurred background, `reframe` without keyframes = 409 REFRAME_REQUIRED.
 */

/** RGB of the pixel (x, y) (fractions of the frame) at `t`. */
function pixelAt(file: string, t: number, fx: number, fy: number): [number, number, number] {
  const raw = execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    String(t),
    "-i",
    file,
    "-frames:v",
    "1",
    "-vf",
    `crop=8:8:(iw-8)*${fx}:(ih-8)*${fy},scale=1:1:flags=area,format=rgb24`,
    "-f",
    "rawvideo",
    "pipe:1",
  ]);
  return [raw[0]!, raw[1]!, raw[2]!];
}

describe.skipIf(!hasFfmpeg)("export to another aspect", { timeout: 300_000 }, () => {
  let h: Harness;
  let project: Project;
  let vertical: ExportPreset;

  beforeAll(async () => {
    h = await harness("studio-aspect-");
    gen([
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=106x180:r=25:d=2",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x00FF00:s=108x180:r=25:d=2",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=106x180:r=25:d=2",
      "-filter_complex",
      "[0:v][1:v][2:v]hstack=inputs=3",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      h.file("h.mp4"),
    ]);
    const a = await h.upload(h.file("h.mp4"), "video/mp4");
    await h.idle();
    const created = await h.app.inject({
      method: "POST",
      url: "/api/export-presets",
      payload: {
        name: "Vertical chico",
        aspect: "9:16",
        width: 180,
        height: 320,
        fps: 25,
        crf: 30,
      },
    });
    expect(created.statusCode).toBe(201);
    vertical = created.json<ExportPreset>();
    const p = await h.create("Horizontal", 320, 180);
    const video = p.tracks.find((t) => t.kind === "video")!;
    project = await h.save({
      ...p,
      tracks: p.tracks.map((t) =>
        t.id === video.id ? ({ ...t, clips: [clip(t.id, "v1", a.id, 0, 2)] } as never) : t,
      ),
    });
  }, 120_000);
  afterAll(() => h?.app.close());

  it("without a choice: 409 ASPECT_CHOICE_REQUIRED with the canvas, preset and 3 options", async () => {
    const res = await h.exportRaw(project.id, { presetId: "reels-tiktok" });
    expect(res.statusCode).toBe(409);
    const body = res.json<{ error: { code: string; message: string; details: unknown } }>();
    expect(body.error.code).toBe("ASPECT_CHOICE_REQUIRED");
    expect(body.error.message).toMatch(/horizontal y «Reels.*» es 9:16/);
    const details = AspectChoiceRequiredDetailsSchema.parse(body.error.details);
    expect(details).toEqual({
      canvas: { w: 320, h: 180 },
      preset: { id: "reels-tiktok", w: 1080, h: 1920 },
      options: ["reframe", "center", "blur"],
      reframeReady: true,
    });
    // Same aspect: no choice needed.
    const same = await h.exportRaw(project.id, {
      presetId: "youtube-1080p",
      range: { start: 0, end: 0.5 },
    });
    expect(same.statusCode).toBe(202);
    await h.idle();
  });

  it("reframe without keyframes: 409 REFRAME_REQUIRED", async () => {
    const res = await h.exportRaw(project.id, { presetId: "reels-tiktok", aspectFit: "reframe" });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("REFRAME_REQUIRED");
  });

  it("center: reels-tiktok 1080×1920 cropped, no bars", async () => {
    const { result, abs } = await h.exportNow(project.id, {
      presetId: "reels-tiktok",
      aspectFit: "center",
      range: { start: 0, end: 1 },
    });
    expect(result.aspectFit).toBe("center");
    const v = probeVideo(abs);
    expect([v.width, v.height]).toEqual([1080, 1920]);
    // Red | green | blue thirds: the centered 9:16 crop is all green, top to bottom.
    for (const fy of [0.02, 0.5, 0.98]) {
      const [r, g, b] = pixelAt(abs, 0.5, 0.05, fy);
      expect(g).toBeGreaterThan(180);
      expect(Math.max(r, b)).toBeLessThan(60);
    }
  });

  it("center keeps only the middle; blur keeps the whole frame (old behavior)", async () => {
    const center = await h.exportNow(project.id, { presetId: vertical.id, aspectFit: "center" });
    const blur = await h.exportNow(project.id, { presetId: vertical.id, aspectFit: "blur" });
    expect(blur.result.aspectFit).toBe("blur");
    expect(probeVideo(center.abs)).toMatchObject({ width: 180, height: 320 });
    expect(probeVideo(blur.abs)).toMatchObject({ width: 180, height: 320 });
    // Left edge, middle row: blur shows the whole frame (red third at the left), center only green.
    const [cr, cg] = pixelAt(center.abs, 1, 0.05, 0.5);
    const [br, bg] = pixelAt(blur.abs, 1, 0.05, 0.5);
    expect(cg).toBeGreaterThan(180);
    expect(cr).toBeLessThan(60);
    expect(br).toBeGreaterThan(180);
    expect(bg).toBeLessThan(60);
  });
});

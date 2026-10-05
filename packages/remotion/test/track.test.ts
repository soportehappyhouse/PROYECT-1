import { MotionSpecSchema, trackPointAt } from "@studio/shared";
import { describe, expect, it } from "vitest";
import { trackPoint } from "../src/lib/track.js";
import { buildInputProps } from "../src/props.js";
import { INTERNAL_PROP } from "../src/schemas/common.js";
import { REMOTION_TEMPLATES } from "../src/templates.js";

const opts = { storageDir: "/data/storage", mediaBaseUrl: "http://127.0.0.1:3001/files/" };
const track = {
  version: 1 as const,
  fps: 10,
  frames: [
    { t: 0, x: 0.1, y: 0.2, w: 0.2, h: 0.1, conf: 1 },
    { t: 1, x: 0.5, y: 0.6, w: 0.2, h: 0.3, conf: 1 },
  ],
  smoothed: true,
  source: { assetId: "a", method: "csrt" },
};

describe("Sprint 2: templates following a track", () => {
  it("trackPoint interpolates the box, applies anchor + offset and matches @studio/shared", () => {
    const close = (p: { x: number; y: number } | undefined, x: number, y: number) => {
      expect(p!.x).toBeCloseTo(x, 12);
      expect(p!.y).toBeCloseTo(y, 12);
    };
    close(trackPoint(track, 0.5, "center"), 0.4, 0.5);
    expect(trackPoint(track, 0.5, "top", { x: 0.1, y: -0.1 })!.y).toBeCloseTo(0.3, 12);
    close(trackPoint(track, 5, "bottom"), 0.6, 0.9);
    close(trackPoint(track, -1), 0.2, 0.25);
    expect(trackPoint({ frames: [] }, 0)).toBeUndefined();
    for (const t of [0, 0.25, 0.7, 2])
      for (const anchor of ["center", "top", "bottom"] as const) {
        const a = trackPoint(track, t, anchor, { x: 0.01, y: 0.02 })!;
        const b = trackPointAt(track, t, anchor, { x: 0.01, y: 0.02 })!;
        expect(a.x).toBeCloseTo(b.x, 12);
        expect(a.y).toBeCloseTo(b.y, 12);
      }
  });

  it.each(["lower-third", "animated-captions"])(
    "%s keeps track / trackAnchor / trackOffset in the input props",
    async (template) => {
      const spec = MotionSpecSchema.parse({
        template,
        durationSec: 1,
        props: { track, trackAnchor: "top", trackOffset: { x: 0, y: -0.05 } },
      });
      const props = await buildInputProps(spec, opts);
      expect(props.track).toMatchObject({ fps: 10, frames: track.frames });
      expect(props.trackAnchor).toBe("top");
      expect(props.trackOffset).toEqual({ x: 0, y: -0.05 });
    },
  );

  it("rejects a malformed track with a Spanish-path error", async () => {
    const spec = MotionSpecSchema.parse({
      template: "lower-third",
      durationSec: 1,
      props: { track: { fps: 10, frames: [{ t: 0 }] } },
    });
    await expect(buildInputProps(spec, opts)).rejects.toThrow(/track\.frames/);
  });

  it("marks track / trackAnchor / trackOffset as internal in the JSON schema (hidden by forms)", () => {
    for (const id of ["lower-third", "animated-captions"]) {
      const schema = REMOTION_TEMPLATES.find((t) => t.id === id)!.propsSchema as {
        properties: Record<string, Record<string, unknown>>;
      };
      const props = schema.properties;
      for (const key of ["track", "trackAnchor", "trackOffset"])
        expect(props[key]?.[INTERNAL_PROP], `${id}.${key}`).toBe(true);
      expect(Object.values(props).filter((p) => p[INTERNAL_PROP]).length).toBe(3);
    }
  });
});

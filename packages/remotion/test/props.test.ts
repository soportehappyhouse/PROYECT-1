import { MotionSpecSchema } from "@studio/shared";
import { describe, expect, it } from "vitest";
import { buildInputProps, mediaUrl, safeRelativePath } from "../src/props.js";

const opts = { storageDir: "/data/storage", mediaBaseUrl: "http://127.0.0.1:3001/files/" };

describe("MotionSpec -> inputProps", () => {
  it("validates props, applies defaults and appends render meta", async () => {
    const spec = MotionSpecSchema.parse({
      template: "lower-third",
      props: { name: "Ana" },
      durationSec: 2.5,
      fps: 25,
      width: 1080,
      height: 1920,
    });
    const props = await buildInputProps(spec, opts);
    expect(props).toMatchObject({
      name: "Ana",
      role: "Cargo o descripción",
      __width: 1080,
      __height: 1920,
      __fps: 25,
      __durationInFrames: 63,
      __fontMode: "google",
    });
  });

  it("turns media refs into encoded /files URLs", async () => {
    const spec = MotionSpecSchema.parse({
      template: "transition",
      durationSec: 3,
      media: {
        fromSrc: { kind: "video", path: "media/mi clip.mp4" },
        toSrc: { kind: "image", path: "media\\foto.jpg" },
      },
    });
    const props = await buildInputProps(spec, opts);
    expect(props.fromSrc).toBe("http://127.0.0.1:3001/files/media/mi%20clip.mp4");
    expect(props.toSrc).toBe("http://127.0.0.1:3001/files/media/foto.jpg");
  });

  it("inlines captions media (transcript object or Caption[])", async () => {
    const transcript = { segments: [{ start: 0, end: 1, text: "Hola" }] };
    const spec = MotionSpecSchema.parse({
      template: "animated-captions",
      durationSec: 1,
      media: { subs: { kind: "captions", path: "renders/t.json" } },
    });
    const read: string[] = [];
    const props = await buildInputProps(spec, opts, {
      readText: (p) => {
        read.push(p);
        return Promise.resolve(JSON.stringify(transcript));
      },
    });
    expect(read[0]?.replace(/\\/g, "/")).toMatch(/\/data\/storage\/renders\/t\.json$/);
    expect(props.transcript).toMatchObject(transcript);

    const caps = [{ text: " Hola", startMs: 0, endMs: 500 }];
    const props2 = await buildInputProps(spec, opts, {
      readText: () => Promise.resolve(JSON.stringify(caps)),
    });
    expect(props2.captions).toEqual([{ ...caps[0], timestampMs: null, confidence: null }]);
  });

  it("rejects invalid props with Spanish, path-prefixed errors", async () => {
    const spec = MotionSpecSchema.parse({
      template: "title-card",
      props: { style: "nope" },
      durationSec: 1,
    });
    await expect(buildInputProps(spec, opts)).rejects.toThrow(/style/);
  });

  it("rejects path traversal and absolute media paths", () => {
    expect(() => safeRelativePath("../etc/passwd")).toThrow();
    expect(() => safeRelativePath("/etc/passwd")).toThrow();
    expect(() => safeRelativePath("C:\\Windows\\x.mp4")).toThrow();
    expect(mediaUrl("http://h/files", "./media/a b.mp4")).toBe("http://h/files/media/a%20b.mp4");
  });
});

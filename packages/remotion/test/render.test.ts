import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkRemotionAvailable,
  RemotionBrowserMissingError,
  resolveBrowserExecutable,
} from "../src/browser.js";
import { computeSourceHash } from "../src/bundle.js";
import { codecOptions, configureRemotionRenderer, getRendererSettings } from "../src/render.js";

describe("render settings", () => {
  afterEach(() => configureRemotionRenderer({ concurrency: "50%" }));

  it("maps MotionSpec formats to Remotion codecs (alpha where needed)", () => {
    expect(codecOptions("mp4-h264")).toMatchObject({ codec: "h264", imageFormat: "jpeg" });
    expect(codecOptions("webm-vp9-alpha")).toEqual({
      codec: "vp9",
      imageFormat: "png",
      pixelFormat: "yuva420p",
    });
    expect(codecOptions("prores-4444")).toEqual({
      codec: "prores",
      imageFormat: "png",
      pixelFormat: "yuva444p10le",
      proResProfile: "4444",
    });
  });

  it("defaults to 50% concurrency, CPU only, and accepts overrides", () => {
    const s = getRendererSettings();
    expect(s.hardwareAcceleration).toMatch(/disable|if-possible/);
    configureRemotionRenderer({ concurrency: 2 });
    expect(getRendererSettings().concurrency).toBe(2);
  });

  it("explicit browser path that does not exist -> clear error; availability never throws", async () => {
    expect(() => resolveBrowserExecutable("/nope/chrome-headless-shell")).toThrow(
      RemotionBrowserMissingError,
    );
    const status = await checkRemotionAvailable("/nope/chrome-headless-shell");
    expect(status.ok).toBe(false);
    expect(status.reason).toMatch(/Chrome Headless Shell/);
  });

  it("bundle cache key is stable for unchanged sources", async () => {
    expect(await computeSourceHash()).toBe(await computeSourceHash());
    // Audit S6 E19: a changed file under public/ (fonts) changes the hash.
    const tmp = mkdtempSync(path.join(os.tmpdir(), "studio-hash-"));
    mkdirSync(path.join(tmp, "src"));
    mkdirSync(path.join(tmp, "public", "fonts"), { recursive: true });
    writeFileSync(path.join(tmp, "src", "a.ts"), "export {};");
    writeFileSync(path.join(tmp, "public", "fonts", "x.ttf"), "v1");
    const h1 = await computeSourceHash(path.join(tmp, "src"), path.join(tmp, "public"));
    writeFileSync(path.join(tmp, "public", "fonts", "x.ttf"), "v2");
    expect(await computeSourceHash(path.join(tmp, "src"), path.join(tmp, "public"))).not.toBe(h1);
    rmSync(tmp, { recursive: true, force: true });
  });
});

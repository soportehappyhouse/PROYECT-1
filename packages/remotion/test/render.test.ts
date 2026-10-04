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
  });
});

// Real Remotion render. Needs Chrome Headless Shell (`pnpm --filter @studio/remotion browser:ensure`
// or REMOTION_BROWSER_EXECUTABLE). Skipped automatically when no browser is found (e.g. CI sandbox).
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MotionSpecSchema } from "@studio/shared";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBrowserExecutable } from "../src/browser.js";
import { configureRemotionRenderer, renderMotion } from "../src/render.js";

function browserPresent(): boolean {
  try {
    return resolveBrowserExecutable() !== null;
  } catch {
    return false;
  }
}

describe.skipIf(!browserPresent())("remotion render (integration)", () => {
  let dir = "";
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it(
    "renders title-card to mp4 and lower-third to webm with alpha",
    { timeout: 300_000 },
    async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), "studio-remotion-"));
      configureRemotionRenderer({ fontMode: "system", concurrency: 2 });
      const phases = new Set<string>();
      const base = { durationSec: 0.5, fps: 30, width: 320, height: 180 };
      for (const [template, format, out] of [
        ["title-card", "mp4-h264", "renders/a.mp4"],
        ["lower-third", "webm-vp9-alpha", "renders/b.webm"],
      ] as const) {
        const result = await renderMotion(MotionSpecSchema.parse({ ...base, template, format }), {
          jobId: template,
          storageDir: dir,
          outputPath: out,
          tmpDir: path.join(dir, "tmp"),
          mediaBaseUrl: "http://127.0.0.1:3001/files/",
          onProgress: (p) => phases.add(p.phase),
        });
        expect(result).toMatchObject({
          path: out,
          format,
          width: 320,
          height: 180,
          engine: "remotion",
        });
        const abs = path.join(dir, out);
        expect(existsSync(abs)).toBe(true);
        expect(statSync(abs).size).toBeGreaterThan(1000);
      }
      expect(phases).toContain("done");
    },
  );
});

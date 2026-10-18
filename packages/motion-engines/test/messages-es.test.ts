import { describe, expect, it } from "vitest";
import {
  createDefaultRegistry,
  MotionEngineNotImplementedError,
  UnknownMotionEngineError,
} from "../src/index.js";

/** MEJORAS B11: an unavailable/unknown engine answers in Spanish (never «Motion engine "m…»). */
describe("motion engines speak Spanish (B11)", () => {
  it("errors", () => {
    expect(new UnknownMotionEngineError("magic").message).toBe(
      "No conozco el motor de animación «magic».",
    );
    expect(new MotionEngineNotImplementedError("motion-canvas").message).toMatch(
      /todavía no permite renderizar/,
    );
  });

  it("status reasons have no English", async () => {
    const reg = createDefaultRegistry({
      ffmpegPath: "ffmpeg-falta",
      remotion: { templates: [], render: () => Promise.reject(new Error("x")) },
    });
    for (const s of await reg.status()) {
      if (s.ok) continue;
      expect(s.reason, s.id).toBeTruthy();
      expect(s.reason, s.reason).not.toMatch(
        /Motion engine|not implemented|does not|Unknown|Error:/i,
      );
    }
    expect(() => reg.get("nope" as never)).toThrow(/No conozco el motor/);
  });
});

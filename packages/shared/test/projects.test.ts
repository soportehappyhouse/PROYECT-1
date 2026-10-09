import { describe, expect, it } from "vitest";
import {
  autoProjectName,
  duplicateProjectName,
  isUntitledProjectName,
  projectSummary,
  ProjectSchema,
  ProjectSummarySchema,
  UNTITLED_PROJECT_NAME,
} from "../src/index.js";

const now = "2026-10-08T10:00:00.000Z";
const project = ProjectSchema.parse({
  id: "p1",
  name: "Mi video",
  settings: { width: 1280, height: 720, fps: 30, sampleRate: 48000 },
  tracks: [
    {
      id: "t-text",
      kind: "text",
      name: "Texto 1",
      clips: [{ id: "c0", trackId: "t-text", start: 0, in: 0, out: 2, text: "Hola" }],
    },
    {
      id: "t-video",
      kind: "video",
      name: "Video 1",
      clips: [
        { id: "c2", trackId: "t-video", start: 4, in: 0, out: 6, assetId: "a2", speed: 2 },
        { id: "c1", trackId: "t-video", start: 1, in: 0, out: 3, assetId: "a1" },
      ],
    },
  ],
  subtitles: [],
  createdAt: now,
  updatedAt: now,
});

describe("projectSummary", () => {
  it("counts clips, measures duration and takes the thumbnail of the first video clip", () => {
    const s = projectSummary(project, [
      { id: "a1", thumbnailPath: "thumbs/a1.jpg" },
      { id: "a2", thumbnailPath: "thumbs/a2.jpg" },
    ]);
    expect(ProjectSummarySchema.parse(s)).toEqual(s);
    expect(s).toMatchObject({ id: "p1", clips: 3, durationS: 7, width: 1280, height: 720 });
    expect(s.thumbnailPath).toBe("thumbs/a1.jpg");
  });

  it("accepts a lookup function and omits a missing thumbnail", () => {
    const s = projectSummary(project, () => undefined);
    expect(s.thumbnailPath).toBeUndefined();
    expect("thumbnailPath" in s).toBe(false);
  });
});

describe("autoProjectName", () => {
  it("renames an untitled project after the first video", () => {
    expect(autoProjectName(UNTITLED_PROJECT_NAME, { name: "viaje_a_salta.mp4" })).toBe(
      "viaje a salta",
    );
    expect(autoProjectName("Proyecto sin título 2", { name: "C:\\Videos\\clip.MOV" })).toBe("clip");
    expect(autoProjectName("  ", { name: "algo.webm" })).toBe("algo");
  });

  it("keeps a name the user chose and does nothing without a video", () => {
    expect(autoProjectName("Mi canal", { name: "x.mp4" })).toBeUndefined();
    expect(autoProjectName(UNTITLED_PROJECT_NAME, undefined)).toBeUndefined();
    expect(isUntitledProjectName("Proyecto sin titulo")).toBe(true);
  });

  it("caps the length at 120", () => {
    const long = `${"a".repeat(200)}.mp4`;
    expect(autoProjectName(UNTITLED_PROJECT_NAME, { name: long })).toHaveLength(120);
    expect(duplicateProjectName("b".repeat(130)).length).toBeLessThanOrEqual(120);
    expect(duplicateProjectName("Mi video")).toBe("Mi video (copia)");
  });
});

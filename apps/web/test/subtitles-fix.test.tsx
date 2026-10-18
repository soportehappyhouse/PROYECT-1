import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubtitlesPanel } from "@/components/panels/SubtitlesPanel";
import { editSubtitleText, resetTextEditBurst, TEXT_EDIT_GROUP_MS } from "@/lib/script";
import { createEmptyProject, useProjectStore } from "@/stores/project-store";

/** Sprint 6 M1 (H11): editing a subtitle's text keeps `words` (fixWords) in one undo step. */
function setup(): void {
  const p = createEmptyProject("H11");
  p.subtitles = [
    {
      start: 0,
      end: 1.3,
      text: "hola como estas",
      words: [
        { word: "hola", start: 0, end: 0.4, probability: 0.9 },
        { word: "como", start: 0.5, end: 0.8, probability: 0.9 },
        { word: "estas", start: 0.9, end: 1.3, probability: 0.9 },
      ],
    },
  ];
  useProjectStore.setState({ project: p, past: [], future: [], saveState: "saved" });
  resetTextEditBurst();
}

const seg = () => useProjectStore.getState().project.subtitles[0]!;

describe("H11: subtitle text edits keep the word timings", () => {
  beforeEach(setup);
  afterEach(() => vi.restoreAllMocks());

  it("typing in Subtítulos: words kept 1:1 with their timings, one undo step per edit", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 404, headers: { "content-type": "application/json" } }),
    );
    render(<SubtitlesPanel />);
    const input = screen.getByLabelText("Texto del segmento");
    fireEvent.change(input, { target: { value: "hola cómo estas" } });
    fireEvent.change(input, { target: { value: "hola cómo estás" } });
    expect(seg().text).toBe("hola cómo estás");
    expect(seg().words!.map((w) => [w.word, w.start, w.end])).toEqual([
      ["hola", 0, 0.4],
      ["cómo", 0.5, 0.8],
      ["estás", 0.9, 1.3],
    ]);
    expect(useProjectStore.getState().past).toHaveLength(1);
    useProjectStore.getState().undo();
    expect(seg().text).toBe("hola como estas");
  });

  it("keystrokes > 800 ms apart are separate steps; estimates never compound", () => {
    editSubtitleText(0, "hola qué tal estas", 1000);
    editSubtitleText(0, "hola qué tal estás", 1000 + TEXT_EDIT_GROUP_MS - 1);
    expect(useProjectStore.getState().past).toHaveLength(1);
    const words = seg().words!;
    expect(words.map((w) => w.word)).toEqual(["hola", "qué", "tal", "estás"]);
    expect(words.filter((w) => w.corrected).map((w) => w.word)).toEqual(["qué", "tal"]);
    expect(words[3]).toMatchObject({ start: 0.9, end: 1.3 });
    editSubtitleText(0, "hola qué tal, estás", 5000);
    expect(useProjectStore.getState().past).toHaveLength(2);
  });
});

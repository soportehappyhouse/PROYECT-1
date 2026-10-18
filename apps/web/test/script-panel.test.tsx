import {
  buildScript,
  planWordCuts,
  type Project,
  type ScriptCutsRequest,
  type SubtitleSegment,
} from "@studio/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScriptPanel } from "@/components/panels/ScriptPanel";
import { createEmptyProject, useProjectStore } from "@/stores/project-store";
import { useScriptStore } from "@/stores/script-store";

/** Sprint 6 M1 (web): panel «Guion». The api is mocked (cuts = the shared planWordCuts). */

/** 10 sentences «fraseK [eh] importanteK.» (8 «eh»), 1.5 s pauses between them. */
function segments(): SubtitleSegment[] {
  const segs: SubtitleSegment[] = [];
  let t = 0;
  const r = (x: number) => Math.round(x * 1000) / 1000;
  for (let k = 0; k < 10; k++) {
    const words = [{ word: `frase${k}`, start: r(t), end: r(t + 1), probability: 0.9 }];
    t += 1.2;
    if (k < 8) {
      words.push({ word: "eh", start: r(t), end: r(t + 0.4), probability: 0.9 });
      t += 0.6;
    }
    words.push({ word: `importante${k}.`, start: r(t), end: r(t + 2), probability: 0.9 });
    t += 2 + (k < 9 ? 1.5 : 0);
    segs.push({
      start: words[0]!.start,
      end: words[words.length - 1]!.end,
      text: words.map((w) => w.word).join(" "),
      words,
    });
  }
  return segs;
}

function setup(): Project {
  const p = createEmptyProject("Guion");
  const video = p.tracks.find((t) => t.kind === "video")!;
  video.clips.push({
    id: "c1",
    trackId: video.id,
    assetId: "a1",
    start: 0,
    in: 0,
    out: 60,
    speed: 1,
    volume: 1,
    opacity: 1,
    voiceEffects: [],
  });
  p.subtitles = segments();
  useProjectStore.setState({ project: p, past: [], future: [], saveState: "saved" });
  useScriptStore.setState({ selected: [], anchor: undefined, active: undefined, fit: undefined });
  return p;
}

function mockApi(): { cuts: ScriptCutsRequest[] } {
  const seen = { cuts: [] as ScriptCutsRequest[] };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
      });
    const project = useProjectStore.getState().project;
    if (url.pathname === `/api/projects/${project.id}` && method === "PUT") return json(body);
    if (url.pathname.endsWith("/script/cuts")) {
      seen.cuts.push(body as ScriptCutsRequest);
      return json(planWordCuts(buildScript(project), body as ScriptCutsRequest));
    }
    return json({ error: { code: "NOT_FOUND", message: "x" } }, 404);
  });
  return seen;
}

const words = () => screen.getAllByTestId("script-word");
const word = (text: string) => words().find((w) => w.textContent === text)!;
const allWords = () => useProjectStore.getState().project.subtitles.flatMap((s) => s.words ?? []);

describe("ScriptPanel", () => {
  beforeEach(() => {
    setup();
  });
  afterEach(() => vi.restoreAllMocks());

  it("shows the words with the 8 safe fillers marked and the live counters", () => {
    mockApi();
    render(<ScriptPanel />);
    expect(words()).toHaveLength(28);
    expect(words().filter((w) => w.dataset.filler === "safe")).toHaveLength(8);
    expect(screen.getByTestId("script-remove-safe").textContent).toContain("Quitar seguras (8)");
    expect(screen.getByTestId("script-stats").textContent).toContain("9 pausas de más de 0,6 s");
    expect(screen.getAllByTestId("script-pause")).toHaveLength(9);
  });

  it("selection (Mayús+clic) + Supr = one cut and ONE undo step", async () => {
    const seen = mockApi();
    render(<ScriptPanel />);
    const before = useProjectStore.getState().past.length;
    fireEvent.mouseDown(word("frase1"));
    fireEvent.mouseDown(word("eh"), { shiftKey: false });
    fireEvent.mouseDown(word("frase1"));
    fireEvent.mouseDown(screen.getAllByText("eh")[1]!, { shiftKey: true });
    expect(useScriptStore.getState().selected).toEqual(["1:0", "1:1"]);
    fireEvent.keyDown(screen.getByTestId("script-words"), { key: "Delete" });
    await waitFor(() => expect(allWords().some((w) => w.word === "frase1")).toBe(false));
    expect(seen.cuts[0]).toMatchObject({ wordIds: ["1:0", "1:1"] });
    expect(useProjectStore.getState().past.length).toBe(before + 1);
    // The video clip is split around the cut with the 12 ms join fades.
    const video = useProjectStore.getState().project.tracks.find((t) => t.kind === "video")!;
    expect(video.clips).toHaveLength(2);
    expect(video.clips[1]!.audioFade).toEqual({ inMs: 12, outMs: 0 });
    act(() => useProjectStore.getState().undo());
    expect(allWords().some((w) => w.word === "frase1")).toBe(true);
  });

  it("«Quitar seguras» removes the 8 safe fillers in one step", async () => {
    const seen = mockApi();
    render(<ScriptPanel />);
    const before = useProjectStore.getState().past.length;
    fireEvent.click(screen.getByTestId("script-remove-safe"));
    await waitFor(() => expect(allWords().filter((w) => w.word === "eh")).toHaveLength(0));
    expect(seen.cuts[0]).toMatchObject({ fillers: "safe" });
    expect(useProjectStore.getState().past.length).toBe(before + 1);
    const video = useProjectStore.getState().project.tracks.find((t) => t.kind === "video")!;
    expect(video.clips).toHaveLength(9);
  });

  it("F2 corrects a word without moving its timings", async () => {
    mockApi();
    render(<ScriptPanel />);
    const orig = allWords().find((w) => w.word === "importante2.")!;
    fireEvent.mouseDown(word("importante2."));
    fireEvent.keyDown(screen.getByTestId("script-words"), { key: "F2" });
    const input = await screen.findByTestId("script-fix-input");
    fireEvent.change(input, { target: { value: "importantísimo2." } });
    fireEvent.keyDown(input, { key: "Enter" });
    const fixed = allWords().find((w) => w.word === "importantísimo2.")!;
    expect(fixed).toBeTruthy();
    expect([fixed.start, fixed.end]).toEqual([orig.start, orig.end]);
    expect(allWords()).toHaveLength(28);
  });

  it("«.» jumps to the next long pause / doubtful filler", () => {
    mockApi();
    render(<ScriptPanel />);
    fireEvent.mouseDown(word("frase0"));
    fireEvent.keyDown(screen.getByTestId("script-words"), { key: "." });
    // The word before the first long pause.
    expect(useScriptStore.getState().selected).toEqual(["0:2"]);
  });
});

import { describe, expect, it, vi } from "vitest";
import { shouldToastSuccess, transcriptToTimeline } from "@/hooks/use-job-events";
import { api, ApiRequestError, apiUrl, errorMessage, fileUrl, isNotImplemented } from "@/lib/api";
import { coerceFieldValue, fieldsFromSchema } from "@/lib/motion-form";
import { computePeaks, slicePeaks } from "@/lib/peaks";
import {
  defaultShortcutMap,
  displayKeys,
  findConflicts,
  keysFromEvent,
  normalizeKeys,
  toHotkeyString,
} from "@/lib/shortcuts";
import { animatedCaptionsProps, segmentWords, toSrt } from "@/lib/subtitles";
import { MotionSpecSchema } from "@studio/shared";
import { CAPTION_STYLES } from "@/stores/caption-style-store";
// The real template schema (zod only, browser-safe) so the test fails if the props drift.
import { animatedCaptionsSchema } from "../../../packages/remotion/src/schemas/animated-captions";
import { defaultEffect } from "@/lib/voice-effects";

describe("api client", () => {
  it("builds urls with params and query", () => {
    expect(apiUrl("/api/jobs/:id", { id: "a b" })).toMatch(/\/api\/jobs\/a%20b$/);
    expect(apiUrl("/api/library", undefined, { q: "boom", page: 2, kind: undefined })).toMatch(
      /\/api\/library\?q=boom&page=2$/,
    );
    expect(fileUrl("/exports/mi video.mp4")).toMatch(/\/files\/exports\/mi%20video\.mp4$/);
  });

  it("maps 501 to a 'módulo en desarrollo' error instead of crashing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "NOT_IMPLEMENTED", message: "module-d" } }), {
        status: 501,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const err = await api.ttsVoices().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(isNotImplemented(err)).toBe(true);
    expect(errorMessage(err)).toBe("Módulo en desarrollo");
    vi.unstubAllGlobals();
  });

  it("sends JSON bodies and parses responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ jobId: "j1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      api.voiceEffects({ assetId: "a", effects: [{ type: "telephone" }] }),
    ).resolves.toEqual({ jobId: "j1" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/voice\/effects$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      assetId: "a",
      effects: [{ type: "telephone" }],
    });
    vi.unstubAllGlobals();
  });

  it("reports network failures as offline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const err = await api.health().catch((e: unknown) => e);
    expect((err as ApiRequestError).status).toBe(0);
    expect(errorMessage(err)).toMatch(/No se pudo conectar/);
    vi.unstubAllGlobals();
  });
});

describe("shortcuts", () => {
  it("normalizes and converts combos", () => {
    expect(normalizeKeys("shift+ctrl+z")).toBe("Ctrl+Shift+Z");
    expect(normalizeKeys("del")).toBe("Delete");
    expect(toHotkeyString("Ctrl+Shift+Z")).toBe("ctrl+shift+z");
    expect(toHotkeyString("Space")).toBe("space");
    expect(displayKeys("Ctrl+Space")).toBe("Ctrl + Espacio");
  });

  it("captures combos from keyboard events by physical code", () => {
    expect(
      keysFromEvent({
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        code: "KeyK",
        key: "K",
      }),
    ).toBe("Ctrl+Shift+K");
    expect(
      keysFromEvent({
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        code: "Digit1",
        key: "1",
      }),
    ).toBe("1");
    expect(
      keysFromEvent({
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        code: "ControlLeft",
        key: "Control",
      }),
    ).toBeUndefined();
  });

  it("detects conflicts", () => {
    const map = defaultShortcutMap();
    expect(findConflicts(map)).toEqual({});
    map["timeline.split"] = "ctrl+z";
    expect(findConflicts(map)["Ctrl+Z"]).toEqual(["timeline.split", "edit.undo"]);
  });
});

describe("waveform peaks", () => {
  it("computes normalized max-abs peaks across channels", () => {
    const l = new Float32Array([0, 0.5, -0.25, 0.1]);
    const r = new Float32Array([0, -1, 0.2, 0]);
    expect(computePeaks([l, r], 2)).toEqual([1, 0.25]);
    expect(computePeaks([], 4)).toEqual([]);
  });

  it("slices the peaks of a trimmed window", () => {
    const p = {
      version: 1 as const,
      durationSec: 4,
      bucketsPerSecond: 2,
      peaks: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
    };
    expect(slicePeaks(p, 1, 2)).toEqual([0.3, 0.4]);
    expect(slicePeaks(p, 3.9, 10)).toEqual([0.8]);
  });
});

describe("motion template form", () => {
  it("derives fields from a JSON schema", () => {
    const schema = {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string" },
        accentColor: { type: "string" },
        size: { type: "integer", minimum: 10, maximum: 200 },
        align: { type: "string", enum: ["left", "center"] },
        animate: { type: "boolean" },
        subtitle: { anyOf: [{ type: "string" }, { type: "null" }] },
        items: { type: "array", items: { type: "string" } },
      },
    };
    const fields = fieldsFromSchema(schema);
    expect(fields.map((f) => [f.key, f.kind])).toEqual([
      ["title", "text"],
      ["accentColor", "color"],
      ["size", "number"],
      ["align", "select"],
      ["animate", "boolean"],
      ["subtitle", "text"],
      ["items", "json"],
    ]);
    expect(fields[0]!.required).toBe(true);
    expect(fields[2]).toMatchObject({ min: 10, max: 200, step: 1 });
  });

  it("hides props the api fills (x-internal: track, trackAnchor, trackOffset)", () => {
    const schema = {
      type: "object",
      properties: {
        title: { type: "string" },
        track: { type: "object", "x-internal": true },
        trackAnchor: { type: "string", enum: ["center"], "x-internal": true },
        trackOffset: { anyOf: [{ type: "object", "x-internal": true }, { type: "null" }] },
      },
    };
    expect(fieldsFromSchema(schema).map((f) => f.key)).toEqual(["title"]);
  });

  it("falls back to inferring from default props", () => {
    const fields = fieldsFromSchema(undefined, {
      text: "Hola",
      color: "#fff",
      delay: 0.5,
      loop: true,
    });
    expect(fields.map((f) => f.kind)).toEqual(["textarea", "color", "number", "boolean"]);
    expect(coerceFieldValue(fields[2]!, "1.5")).toBe(1.5);
    expect(
      coerceFieldValue({ key: "x", label: "x", kind: "json", required: false }, "[1,2]"),
    ).toEqual([1, 2]);
  });
});

describe("subtitles", () => {
  it("maps transcript times from source to timeline", () => {
    const mapped = transcriptToTimeline(
      [
        { start: 0, end: 1, text: "fuera" },
        { start: 2, end: 4, text: "dentro", words: [{ start: 2, end: 3, word: "den" }] },
      ],
      { start: 10, in: 1.5, out: 6, speed: 1 },
    );
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({ start: 10.5, end: 12.5, text: "dentro" });
    expect(mapped[0]!.words?.[0]).toMatchObject({ start: 10.5, end: 11.5 });
  });

  it("only toasts successes of jobs the user started (U3)", () => {
    expect(shouldToastSuccess("media.probe", false)).toBe(false);
    expect(shouldToastSuccess("media.proxy", false)).toBe(false);
    expect(shouldToastSuccess("media.proxy", true)).toBe(true);
    expect(shouldToastSuccess("project.export", false)).toBe(true);
  });

  it("exports SRT", () => {
    expect(toSrt([{ start: 1.5, end: 3.25, text: " Hola " }])).toBe(
      "1\n00:00:01,500 --> 00:00:03,250\nHola\n",
    );
  });

  it("builds a valid animated-captions MotionSpec from subtitles (word-level transcript)", () => {
    const subs = [
      { start: 10, end: 12, text: "Hola mundo feliz" },
      {
        start: 12.5,
        end: 14,
        text: "con palabras",
        words: [
          { start: 12.5, end: 13, word: " con" },
          { start: 13.1, end: 14, word: " palabras" },
        ],
      },
    ];
    expect(segmentWords(subs[0]!)).toEqual([
      { start: 10, end: 10 + 2 / 3, word: " Hola" },
      { start: 10 + 2 / 3, end: 10 + 4 / 3, word: " mundo" },
      { start: 10 + 4 / 3, end: 12, word: " feliz" },
    ]);
    const style = CAPTION_STYLES.find((s) => s.id === "clasico")!;
    const built = animatedCaptionsProps(subs, style, "es")!;
    expect(built).toMatchObject({ start: 10, durationSec: 4 });
    expect(built.props).not.toHaveProperty("segments");
    expect(typeof built.props.style).toBe("string");
    const parsed = animatedCaptionsSchema.safeParse(built.props);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    const t = parsed.data!.transcript;
    expect(t.segments[0]!.words?.map((w) => w.word)).toEqual([" Hola", " mundo", " feliz"]);
    expect(t.segments[1]).toMatchObject({ start: 2.5, end: 4 });
    expect(t.segments[1]!.words![0]).toMatchObject({ start: 2.5, end: 3, word: " con" });
    expect(parsed.data).toMatchObject({ style: "highlight", boxColor: "rgba(0,0,0,0.6)" });
    // A style with an unbundled font still yields valid props (font falls back to the default).
    const minimal = animatedCaptionsProps(
      subs,
      CAPTION_STYLES.find((s) => s.id === "minimal")!,
    );
    expect(animatedCaptionsSchema.safeParse(minimal!.props).success).toBe(true);
    expect(
      MotionSpecSchema.safeParse({
        engine: "remotion",
        template: "animated-captions",
        props: built.props,
        durationSec: built.durationSec,
      }).success,
    ).toBe(true);
  });

  it("builds default voice effects that satisfy the shared schema", () => {
    expect(defaultEffect("reverb")).toEqual({ type: "reverb", roomSize: 0.5, wet: 0.3 });
    expect(defaultEffect("telephone")).toEqual({ type: "telephone" });
  });
});

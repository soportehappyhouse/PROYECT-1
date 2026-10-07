import { describe, expect, it } from "vitest";
import {
  aiContentComment,
  detectAiContent,
  detectedPublishFlags,
  hasAiContentHits,
  inheritedAiProvenance,
  parseAiContentComment,
  reimportedAiProvenance,
  MediaAssetSchema,
  TrackSchema,
  type AiContentAsset,
  type AiProvenance,
  type MediaAsset,
  type Project,
} from "../src/index.js";

const now = "2026-10-06T00:00:00.000Z";

function prov(kind: AiProvenance["kind"], extra: Partial<AiProvenance> = {}): AiProvenance {
  return {
    kind,
    tool: kind === "face" ? "facefusion 3.9.1" : "chatterbox mtl-v3",
    createdAt: now,
    ...extra,
  };
}

function asset(id: string, p?: AiProvenance, name = id): MediaAsset {
  return MediaAssetSchema.parse({
    id,
    kind: p?.kind === "face" ? "video" : "audio",
    name,
    path: `media/${id}`,
    sizeBytes: 1,
    createdAt: now,
    ...(p && { aiAltered: true, aiProvenance: p }),
  });
}

function project(tracks: unknown[]): Pick<Project, "tracks"> {
  return { tracks: tracks.map((t) => TrackSchema.parse(t)) };
}

const clip = (id: string, trackId: string, assetId: string, extra: object = {}) => ({
  id,
  trackId,
  assetId,
  start: 0,
  out: 5,
  ...extra,
});

const assets = new Map<string, AiContentAsset>(
  [
    asset("swap", prov("face", { personId: "per1", consentId: "c1" }), "Doble (cara IA)"),
    asset("tts", prov("voice-synthetic"), "Locución"),
    asset("clone", prov("voice-cloned", { personId: "per2" }), "Voz de Ana"),
    asset("plain"),
    asset("matte", prov("face", { personId: "per1", sourceAssetId: "swap" }), "Recorte"),
  ].map((a) => [a.id, a]),
);

describe("detectAiContent (Revisión para redes, sprint 4)", () => {
  it("finds face, cloned and synthetic voice in the clips that reach the export", () => {
    const p = project([
      {
        id: "v1",
        kind: "video",
        name: "Video",
        clips: [clip("c1", "v1", "swap"), clip("c2", "v1", "plain")],
      },
      {
        id: "a1",
        kind: "audio",
        name: "Voz",
        clips: [clip("c3", "a1", "tts"), clip("c4", "a1", "clone")],
      },
    ]);
    const r = detectAiContent(p, assets);
    expect(r.face).toEqual([
      {
        clipId: "c1",
        trackId: "v1",
        assetId: "swap",
        personId: "per1",
        label_es: "«Doble (cara IA)» (pista «Video»)",
      },
    ]);
    expect(r.voiceSynthetic.map((h) => h.clipId)).toEqual(["c3"]);
    expect(r.voiceCloned).toEqual([
      {
        clipId: "c4",
        trackId: "a1",
        assetId: "clone",
        personId: "per2",
        label_es: "«Voz de Ana» (pista «Voz»)",
      },
    ]);
    expect(hasAiContentHits(r)).toBe(true);
  });

  it("ignores hidden video tracks and muted audio tracks", () => {
    const p = project([
      { id: "v1", kind: "video", name: "V", hidden: true, clips: [clip("c1", "v1", "swap")] },
      { id: "a1", kind: "audio", name: "A", muted: true, clips: [clip("c2", "a1", "clone")] },
    ]);
    const r = detectAiContent(p, assets);
    expect(hasAiContentHits(r)).toBe(false);
    expect(aiContentComment(r)).toBeUndefined();
  });

  it("a cloned voice on a muted video track does not count, its face does", () => {
    const voiceOnVideo = asset("vclone", prov("voice-cloned"));
    const map = new Map(assets).set(voiceOnVideo.id, voiceOnVideo);
    const p = project([
      {
        id: "v1",
        kind: "video",
        name: "V",
        muted: true,
        clips: [clip("c1", "v1", "swap"), clip("c2", "v1", "vclone")],
      },
    ]);
    const r = detectAiContent(p, map);
    expect(r.face).toHaveLength(1);
    expect(r.voiceCloned).toHaveLength(0);
  });

  it("looks at the cut-out (matte) of a clip and reports one hit per clip and kind", () => {
    const p = project([
      {
        id: "v1",
        kind: "video",
        name: "V",
        clips: [
          clip("c1", "v1", "plain", { matte: { assetId: "matte" } }),
          clip("c2", "v1", "swap", { matte: { assetId: "matte" } }),
        ],
      },
    ]);
    const r = detectAiContent(p, assets);
    expect(r.face.map((h) => [h.clipId, h.assetId])).toEqual([
      ["c1", "matte"],
      ["c2", "swap"],
    ]);
  });

  it("assets without provenance (or unknown ids) are not AI content", () => {
    const p = project([
      {
        id: "v1",
        kind: "video",
        name: "V",
        clips: [clip("c1", "v1", "plain"), clip("c2", "v1", "gone")],
      },
    ]);
    expect(hasAiContentHits(detectAiContent(p, assets))).toBe(false);
  });
});

describe("aiContentComment (export metadata, decision 9)", () => {
  it("says what was detected without ids, names or paths", () => {
    const p = project([
      { id: "v1", kind: "video", name: "Video secreto", clips: [clip("c1", "v1", "swap")] },
      { id: "a1", kind: "audio", name: "A", clips: [clip("c2", "a1", "tts")] },
    ]);
    const comment = aiContentComment(detectAiContent(p, assets));
    expect(comment).toBe(
      "Editado con Studio; contenido alterado con IA: cara sintética: sí; voz clonada: no; voz sintética: sí",
    );
    for (const secret of ["per1", "c1", "swap", "Doble", "Video secreto", "media/"])
      expect(comment).not.toContain(secret);
  });
});

describe("detectedPublishFlags", () => {
  it("locks aiFace and aiVoice for face / cloned voice; synthetic only proposes aiVoice", () => {
    const base = { face: [], voiceCloned: [], voiceSynthetic: [] };
    const hit = { clipId: "c", trackId: "t", assetId: "a", label_es: "x" };
    expect(detectedPublishFlags({ ...base, voiceSynthetic: [hit] })).toEqual({
      aiFace: false,
      aiVoice: true,
      locked: { aiFace: false, aiVoice: false },
    });
    expect(detectedPublishFlags({ ...base, face: [hit], voiceCloned: [hit] })).toEqual({
      aiFace: true,
      aiVoice: true,
      locked: { aiFace: true, aiVoice: true },
    });
  });
});

describe("inheritedAiProvenance", () => {
  it("copies the provenance with the source id; nothing for plain media", () => {
    const src = asset("swap", prov("face", { personId: "per1", sourceAssetId: "orig" }));
    expect(inheritedAiProvenance(src)).toEqual({
      aiAltered: true,
      aiProvenance: { ...src.aiProvenance, sourceAssetId: "swap" },
    });
    expect(inheritedAiProvenance(asset("plain"))).toEqual({});
    expect(inheritedAiProvenance({ id: "x", aiAltered: true })).toEqual({ aiAltered: true });
  });
});

describe("re-imported exports (audit fix 10)", () => {
  it("parses the comment of an export and rebuilds a minimal provenance", () => {
    const c = aiContentComment({
      face: [{ clipId: "c", trackId: "t", assetId: "a", label_es: "x" }],
      voiceCloned: [],
      voiceSynthetic: [{ clipId: "c", trackId: "t", assetId: "a", label_es: "x" }],
    });
    expect(parseAiContentComment(c)).toEqual(["face", "voice-synthetic"]);
    expect(parseAiContentComment("Editado con Studio")).toBeUndefined();
    expect(parseAiContentComment(undefined)).toBeUndefined();
    expect(parseAiContentComment("Contenido alterado con IA")).toEqual(["voice-synthetic"]);
    const p = reimportedAiProvenance(["face", "voice-cloned"], "2026-10-06T00:00:00.000Z");
    expect(p).toMatchObject({
      aiAltered: true,
      aiProvenance: { kind: "face", extraKinds: ["voice-cloned"] },
    });
    const report = detectAiContent(
      {
        tracks: [
          {
            id: "t",
            kind: "video",
            name: "V",
            clips: [{ id: "c", trackId: "t", assetId: "a", start: 0, in: 0, out: 1 }],
          },
        ] as never,
      },
      new Map([["a", { id: "a", name: "x", ...p }]]),
    );
    expect(report.face).toHaveLength(1);
    expect(report.voiceCloned).toHaveLength(1);
    expect(aiContentComment(report)).toContain("voz clonada: sí");
  });
});

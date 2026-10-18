import { describe, expect, it } from "vitest";
import {
  AgentProjectSummarySchema,
  DEFAULT_EXPORT_PRESETS,
  ProjectSchema,
  tracksInZOrder,
  validateEditPlan,
  type EditPlanInput,
  type MediaAsset,
  type Project,
} from "@studio/shared";
import { canvasSize, nameScore, resolveOp, resolvePlan } from "../src/services/agent/resolve.js";
import { dbToVolume, moveClip, setClipVolume } from "../src/services/timeline-edit.js";
import {
  buildProjectSummary,
  SUMMARY_MAX_CHARS,
  summaryChars,
  timelineScenes,
} from "../src/services/agent/summary.js";

const now = "2026-10-05T12:00:00.000Z";
const asset = (
  id: string,
  name: string,
  kind: MediaAsset["kind"],
  extra: Partial<MediaAsset> = {},
): MediaAsset => ({
  id,
  kind,
  name,
  path: `media/${id}`,
  sizeBytes: 1,
  createdAt: now,
  ...extra,
});
const MEDIA: Record<string, MediaAsset> = {
  a1: asset("a1", "entrevista.mp4", "video", {
    durationSec: 60,
    hasAudio: true,
    scenes: [
      { start: 0, end: 12 },
      { start: 12, end: 30 },
      { start: 30, end: 60 },
    ],
  }),
  a2: asset("a2", "toma-b.mp4", "video", { durationSec: 20, hasAudio: true }),
  m1: asset("m1", "musica alegre.mp3", "audio", { durationSec: 90 }),
  bg: asset("bg", "playa.jpg", "image"),
};
const media = (id: string) => MEDIA[id];

function project(): Project {
  return ProjectSchema.parse({
    id: "p1",
    name: "Mi video",
    settings: { width: 1920, height: 1080, fps: 30 },
    tracks: [
      {
        id: "tv",
        kind: "video",
        name: "Video 1",
        clips: [
          { id: "c1", trackId: "tv", assetId: "a1", start: 0, in: 0, out: 40 },
          { id: "c2", trackId: "tv", assetId: "a2", start: 40, in: 0, out: 20 },
        ],
      },
      {
        id: "tt",
        kind: "text",
        name: "Texto 1",
        clips: [{ id: "t1", trackId: "tt", start: 5, in: 0, out: 3, text: "Bienvenidos" }],
      },
      {
        id: "ta",
        kind: "audio",
        name: "Audio 1",
        clips: [{ id: "m", trackId: "ta", assetId: "m1", start: 0, in: 0, out: 60, volume: 0.5 }],
      },
    ],
    subtitles: [
      { id: "s1", start: 1, end: 3, text: "Hola a todos" },
      { id: "s2", start: 3, end: 6, text: "hoy hablamos de edición" },
    ],
    createdAt: now,
    updatedAt: now,
  });
}

const ctx = (p = project(), extra = {}) => ({
  project: p,
  media,
  cursor: 10,
  presets: DEFAULT_EXPORT_PRESETS,
  ...extra,
});

const plan = (ops: EditPlanInput["ops"]) => {
  const v = validateEditPlan({ version: 1, summary_es: "test", ops });
  if (!v.ok) throw new Error(v.errors.join("; "));
  return v.plan;
};

describe("agent project summary", () => {
  it("has the dataset JSON shape, is deterministic and lists canvas, clips, scenes, assets, transcript", () => {
    const p = project();
    const s = buildProjectSummary(p, media, { cursor: 10, assets: Object.values(MEDIA) });
    expect(s).toEqual(
      buildProjectSummary(structuredClone(p), media, {
        cursor: 10,
        assets: Object.values(MEDIA).reverse(),
      }),
    );
    // Same shape the dataset/validator and the workers use (strict: no extra keys).
    expect(AgentProjectSummarySchema.parse(s)).toEqual(s);
    expect(Object.keys(s)).toEqual([
      "canvas",
      "cursor_s",
      "tracks",
      "scenes",
      "assets",
      "transcript_excerpt",
    ]);
    expect(s.canvas).toEqual({ w: 1920, h: 1080, fps: 30 });
    expect(s.cursor_s).toBe(10);
    expect(s.tracks.map((t) => t.kind)).toEqual(["video", "text", "audio"]);
    expect(s.tracks[0]!.clips).toEqual([
      { id: "c1", name: "entrevista.mp4", start: 0, end: 40 },
      { id: "c2", name: "toma-b.mp4", start: 40, end: 60 },
    ]);
    expect(s.tracks[1]!.clips).toEqual([{ id: "t1", name: "Bienvenidos", start: 5, end: 8 }]);
    expect(s.scenes).toEqual([
      { n: 1, start: 0 },
      { n: 2, start: 12 },
      { n: 3, start: 30 },
      { n: 4, start: 40 },
    ]);
    // used assets first, then by name
    expect(s.assets!.map((a) => a.id)).toEqual(["a1", "m1", "a2", "bg"]);
    expect(s.assets![3]).toEqual({ id: "bg", name: "playa.jpg", kind: "image" });
    expect(s.transcript_excerpt).toEqual([
      { start: 1, end: 3, text: "Hola a todos" },
      { start: 3, end: 6, text: "hoy hablamos de edición" },
    ]);
    expect(summaryChars(s)).toBeLessThan(SUMMARY_MAX_CHARS);
  });

  it("stays under the budget with a huge project (trims transcript and assets first)", () => {
    const p = project();
    p.tracks[0]!.clips = Array.from({ length: 300 }, (_, i) => ({
      ...p.tracks[0]!.clips[0]!,
      id: `x${i}`,
      start: i * 2,
      out: 2,
    }));
    p.subtitles = Array.from({ length: 500 }, (_, i) => ({
      id: `s${i}`,
      start: i,
      end: i + 1,
      text: "bla ".repeat(40),
    }));
    const s = buildProjectSummary(p, media);
    expect(summaryChars(s)).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(s.tracks[0]!.clips).toHaveLength(20);
    expect(s.transcript_excerpt).toHaveLength(10);
    expect(s.cursor_s).toBe(0);
    const tight = buildProjectSummary(p, media, { maxChars: 1500 });
    expect(summaryChars(tight)).toBeLessThanOrEqual(1500);
    expect(tight.transcript_excerpt).toBeUndefined();
    expect(tight.tracks[0]!.clips.length).toBeGreaterThan(5);
  });
});

describe("agent resolver", () => {
  it("fuzzy names, indexes, tracks and times", () => {
    expect(nameScore("Entrevista Final.mp4", "entrevista")).toBe(3);
    expect(nameScore("toma-b.mp4", "toma b")).toBe(4);
    const r = resolvePlan(
      plan([
        { op: "split", clip: { name: "entrevista" }, t: 12.5 },
        { op: "delete_clip", clip: { index: 2, track: "video" } },
        { op: "set_speed", clip: { index: -1, track: "video" }, speed: 2 },
        { op: "voice_effect", clip: { at: "cursor" }, effect: "robot" },
        { op: "add_text", text: "Fin", t: "end", duration_s: 2 },
        { op: "add_text", text: "Después", t: { after_clip: { name: "bienvenidos" } } },
        { op: "trim", clip: { id: "c2" }, out: 55 },
        { op: "export", preset: "reels", confirm: false },
      ]),
      ctx(),
    );
    expect(r.unresolved).toEqual([]);
    expect(r.resolved.map((o) => (o && "clip" in o ? o.clip : undefined))).toEqual([
      { id: "c1" },
      { id: "c2" },
      { id: "c2" },
      { id: "c1" },
      undefined,
      undefined,
      { id: "c2" },
      undefined,
    ]);
    expect(r.resolved[4]).toMatchObject({ t: 60 });
    expect(r.resolved[5]).toMatchObject({ t: 8 });
    expect(r.resolved[7]).toMatchObject({ preset: "reels-tiktok", confirm: true });
    expect(r.preview_es[0]).toBe("Dividir «entrevista.mp4» en 12,5 s");
    expect(r.preview_es[2]).toBe("Velocidad x2 en «toma-b.mp4» (dura 10 s)");
    expect(r.preview_es[7]).toMatch(/^Exportar con «Reels \/ TikTok/);
    expect(r.risks.some((x) => x.startsWith("Borra el clip «toma-b.mp4»"))).toBe(true);
    expect(r.risks.some((x) => x.includes("nunca sobrescribe"))).toBe(true);
  });

  it("scenes on the timeline and deferred scenes after detect_scenes", () => {
    const p = project();
    expect(timelineScenes(p, media)).toEqual([0, 12, 30, 40]);
    const r = resolvePlan(plan([{ op: "split", clip: { index: 1 }, t: { scene: 2 } }]), ctx(p));
    expect(r.resolved[0]).toMatchObject({ clip: { id: "c1" }, t: 12 });
    const noScenes = (id: string) => ({ ...MEDIA[id]!, scenes: undefined }) as MediaAsset;
    const q = resolvePlan(
      plan([{ op: "add_text", text: "x", t: { scene: 2 } }]),
      ctx(p, { media: noScenes }),
    );
    expect(q.unresolved[0]).toMatch(/^Operación 1: .*¿Detecto las escenas primero\?/);
    const d = resolvePlan(
      plan([
        { op: "detect_scenes" },
        { op: "add_motion", template: "title-card", t: { scene: 2 } },
      ]),
      ctx(p, { media: noScenes }),
    );
    expect(d.unresolved).toEqual([]);
    expect(d.resolved[1]).toMatchObject({ t: { scene: 2 } });
    expect(d.preview_es[1]).toContain("la escena indicada");
  });

  it("ambiguity and missing data become Spanish questions", () => {
    const r = resolvePlan(
      plan([
        { op: "delete_clip", clip: { track: "video" } },
        { op: "split", clip: { name: "inexistente" }, t: 3 },
        { op: "split", clip: { index: 1 }, t: 50 },
        { op: "set_speed", clip: { index: 9 }, speed: 2 },
        { op: "export", preset: "cine-imax" },
      ]),
      ctx(project(), { cursor: undefined }),
    );
    expect(r.resolved).toEqual([null, null, null, null, null]);
    expect(r.unresolved[0]).toBe(
      "Operación 1: ¿Qué clip querés usar para borrar? Hay 2 posibles: 1) «entrevista.mp4» (V1, 0 s–40 s), 2) «toma-b.mp4» (V1, 40 s–60 s).",
    );
    expect(r.unresolved[1]).toMatch(/No encontré un clip llamado «inexistente»/);
    expect(r.unresolved[2]).toMatch(/El corte en 50 s cae fuera de «entrevista.mp4»/);
    expect(r.unresolved[3]).toMatch(/pediste el número 9/);
    expect(r.unresolved[4]).toMatch(/No conozco el preset «cine-imax»/);
    expect(r.preview_es[0]).toBe("Borrar clip: falta un dato");
    const c = resolveOp(
      plan([{ op: "add_text", text: "x", t: "cursor" }]).ops[0]!,
      ctx(project(), { cursor: undefined }),
    );
    expect(c.unresolved[0]).toMatch(/No sé dónde está el cabezal/);
  });

  it("quality gate: times past the end, clips past 1 h, speeds and inverted trims become questions", () => {
    // project duration = 60 s; tolerance 2 s
    const r = resolvePlan(
      plan([
        { op: "add_text", text: "fuera", t: 75 },
        { op: "add_text", text: "justo", t: 61.5 },
        { op: "move_clip", clip: { id: "t1" }, t: 300 },
        { op: "split", clip: { index: 1, track: "video" }, t: { scene: 2 } },
        { op: "add_motion", template: "title-card", t: 30, duration_s: 3590 },
        { op: "add_text", text: "larga", t: 50, duration_s: 3555 },
        { op: "set_speed", clip: { id: "c2" }, speed: 12 },
        { op: "set_speed", clip: { id: "c2" }, speed: 0.1 },
        { op: "set_speed", clip: { id: "c2" }, speed: 8 },
        { op: "trim", clip: { id: "c1" }, in: 20, out: 10 },
        { op: "trim", clip: { id: "c1" }, in: 10, out: 10 },
        { op: "add_audio", query: "aplausos", t: { after_clip: { id: "c2" } } },
      ]),
      ctx(),
    );
    const bad = r.resolved.map((op, i) => (op === null ? i : -1)).filter((i) => i >= 0);
    expect(bad).toEqual([0, 2, 4, 5, 6, 9, 10]);
    expect(r.unresolved[0]).toBe(
      "Operación 1: El momento del texto (75 s) queda después del final del proyecto (60 s). ¿En qué segundo va?",
    );
    expect(r.unresolved[1]).toMatch(/^Operación 3: El momento del nuevo inicio \(300 s\)/);
    expect(r.unresolved[2]).toMatch(/^Operación 5: El gráfico terminaría en 3620 s.*¿Cuánto/);
    expect(r.unresolved[3]).toMatch(/^Operación 6: El texto terminaría en 3605 s/);
    expect(r.unresolved[4]).toMatch(
      /^Operación 7: La velocidad ×12 .*×0,1 a ×8\)\. ¿Qué velocidad/,
    );
    expect(r.unresolved[5]).toMatch(
      /^Operación 10: El recorte de «entrevista.mp4» empieza en 20 s/,
    );
    expect(r.unresolved[6]).toMatch(/^Operación 11: .*empieza en 10 s y termina antes/);
    expect(r.resolved[1]).toMatchObject({ t: 61.5 }); // within the tolerance
    expect(r.resolved[11]).toMatchObject({ t: 60 }); // after the last clip = the end
    // the cursor past the end is a question too
    const c = resolveOp(
      plan([{ op: "add_text", text: "x", t: "cursor" }]).ops[0]!,
      ctx(project(), { cursor: 90 }),
    );
    expect(c.unresolved[0]).toMatch(/\(90 s\) queda después del final/);
    // an unknown export preset was already a question
    expect(resolveOp(plan([{ op: "export", preset: "nada" }]).ops[0]!, ctx()).op).toBeNull();
  });

  it("optional clips, filters, pack risks and backgrounds", () => {
    const packs = [
      { id: "scenes", name_es: "Escenas", size_bytes: 1e8, installed: false },
      { id: "matting", name_es: "Recorte", size_bytes: 2e8, installed: true },
    ];
    const r = resolvePlan(
      plan([
        { op: "cut_silences" },
        { op: "detect_scenes" },
        { op: "voice_effect", clip: { name: "bienvenidos" }, effect: "robot" },
        {
          op: "remove_background",
          clip: { index: 1 },
          background: { type: "image", value: "playa" },
        },
        { op: "add_audio", asset: { name: "musica" }, t: 0, volume_db: -12 },
        { op: "add_captions", style: "reels" },
      ]),
      ctx(project(), { packs, assets: Object.values(MEDIA) }),
    );
    expect(r.preview_es[0]).toBe(
      "Cortar silencios (≥ 500 ms, margen 120 ms, con muletillas) en 2 clips («entrevista.mp4», «toma-b.mp4»)",
    );
    expect(r.resolved[0]).not.toHaveProperty("clip");
    expect(r.risks).toContain(
      "Falta el paquete de IA «Escenas» (0,10 GB): hay que descargarlo antes (Ajustes → Paquetes de IA).",
    );
    expect(r.unresolved[0]).toMatch(
      /^Operación 3: El clip «Bienvenidos» \(T1, 5 s–8 s\) no sirve para el efecto de voz: con audio/,
    );
    expect(r.resolved[3]).toMatchObject({ background: { type: "image", value: "bg" } });
    expect(r.resolved[4]).toMatchObject({ asset: { id: "m1" } });
    expect(r.preview_es[5]).toMatch(/Subtítulos estilo «Reels \(palabra a palabra\)»/);
  });

  it("canvas presets keep the long side", () => {
    const p = project();
    expect(canvasSize(p, "9:16")).toEqual({ w: 1080, h: 1920 });
    expect(canvasSize(p, "1:1")).toEqual({ w: 1080, h: 1080 });
    expect(canvasSize(p, "16:9")).toEqual({ w: 1920, h: 1080 });
    expect(canvasSize(p, { w: 720, h: 1280 })).toEqual({ w: 720, h: 1280 });
  });
});

describe("set_volume / move_clip timeline edits", () => {
  it("dB to gain (≤ -60 = muted) and move to a free track when the range is taken", () => {
    expect(dbToVolume(0)).toBe(1);
    expect(dbToVolume(-12)).toBeCloseTo(0.251, 3);
    expect(dbToVolume(-60)).toBe(0);
    expect(dbToVolume(12)).toBeCloseTo(3.981, 3);
    const p = project();
    const v = setClipVolume(p, "m", -6);
    expect(v.project.tracks[2]!.clips[0]!.volume).toBeCloseTo(0.501, 3);
    expect(p.tracks[2]!.clips[0]!.volume).toBe(0.5); // pure
    // c2 (40-60) to 10 overlaps c1 (0-40) on V1 -> new video track
    let n = 0;
    const moved = moveClip(p, "c2", 10, () => `new${++n}`);
    expect(moved.trackId).toBe("new1");
    expect(moved.project.tracks.map((t) => t.id)).toEqual(["tv", "tt", "ta", "new1"]);
    expect(moved.project.tracks[3]!.clips[0]).toMatchObject({
      id: "c2",
      trackId: "new1",
      start: 10,
    });
    // explicit z-order (sprint 3b layers): the new track does not copy the source's `order`,
    // it gets max(order) + 1 (on top)
    const zp = { ...p, tracks: p.tracks.map((t, i) => ({ ...t, order: i })) };
    const zMoved = moveClip(zp, "c2", 10, () => "z1");
    expect(zMoved.project.tracks[3]!.order).toBe(3);
    expect(tracksInZOrder(zMoved.project.tracks).at(-1)!.id).toBe("z1"); // on top
    // orders 0..4 and the two lowest tracks deleted: remaining 2,3,4 at indexes 0..2. The new
    // track (index 3) would tie with order 3 without max+1 and end up below the top track.
    const gap = { ...p, tracks: p.tracks.map((t, i) => ({ ...t, order: i + 2 })) };
    const gMoved = moveClip(gap, "c2", 10, () => "g1");
    expect(gMoved.project.tracks[3]!.order).toBe(5);
    expect(tracksInZOrder(gMoved.project.tracks).at(-1)!.id).toBe("g1");
    // free range on the same track: stays there
    const same = moveClip(p, "c2", 45, () => "x");
    expect(same.trackId).toBe("tv");
    expect(same.project.tracks[0]!.clips.find((c) => c.id === "c2")!.start).toBe(45);
    const r = resolveOp(
      plan([{ op: "move_clip", clip: { name: "toma-b" }, t: 10 }]).ops[0]!,
      ctx(),
    );
    expect(r.preview_es).toBe("Mover «toma-b.mp4» a 10 s");
    expect(r.risks.join(" ")).toMatch(/se superpone con «entrevista.mp4»/);
    const vol = resolveOp(
      plan([{ op: "set_volume", clip: { track: "audio", index: 1 }, volume_db: -60 }]).ops[0]!,
      ctx(),
    );
    expect(vol.op).toMatchObject({ clip: { id: "m" } });
    expect(vol.preview_es).toBe("Volumen de «musica alegre.mp3»: silenciado");
  });
});

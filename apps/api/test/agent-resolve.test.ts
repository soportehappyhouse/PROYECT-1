import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPORT_PRESETS,
  ProjectSchema,
  validateEditPlan,
  type EditPlanInput,
  type MediaAsset,
  type Project,
} from "@studio/shared";
import { canvasSize, nameScore, resolveOp, resolvePlan } from "../src/services/agent/resolve.js";
import {
  buildProjectSummary,
  SUMMARY_MAX_CHARS,
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
  it("is compact, deterministic and lists canvas, tracks, clips, scenes, assets, transcript", () => {
    const p = project();
    const s = buildProjectSummary(p, media, { cursor: 10, assets: Object.values(MEDIA) });
    expect(s).toBe(
      buildProjectSummary(structuredClone(p), media, {
        cursor: 10,
        assets: Object.values(MEDIA).reverse(),
      }),
    );
    expect(s.split("\n")[0]).toBe(
      'PROYECTO "Mi video" · lienzo 1920x1080 (16:9) · 30 fps · duración 60s · cursor 10s',
    );
    expect(s).toContain('- V1 video "Video 1": 2 clips');
    expect(s).toContain('  1. id=c1 "entrevista.mp4" 0-40s (40s)');
    expect(s).toContain('  1. id=t1 "Bienvenidos" 5-8s (3s)');
    expect(s).toContain("ESCENAS: 1@0 2@12 3@30 4@40");
    expect(s).toMatch(/ARCHIVOS: video "entrevista.mp4" id=a1 60s · audio "musica alegre.mp3"/);
    expect(s).toContain('image "playa.jpg" id=bg (sin usar)');
    expect(s).toContain("TRANSCRIPCIÓN (2 segmentos; primeras 10):");
    expect(s).toContain("  [1-3] Hola a todos");
    expect(s.length).toBeLessThan(SUMMARY_MAX_CHARS);
  });

  it("stays under the budget with a huge project", () => {
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
    expect(s.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(s).toContain("… y 280 clips más");
    expect(s).toContain("cursor desconocido");
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
      "Falta el paquete de IA «Escenas» (0,10 GB): hay que descargarlo antes (Ajustes → Paquetes).",
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

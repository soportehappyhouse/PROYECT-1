import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  API_ROUTES,
  buildRoute,
  SEGMENT_CACHE_SUBDIR,
  type ExportJobResult,
  type ExportPreset,
  type Job,
  type MediaAsset,
  type Project,
} from "@studio/shared";
import { makeApp, multipart, tempStorage, waitFor } from "./helpers.js";

/**
 * Sprint 1 «render por bloques»: the segment cache must skip unchanged blocks, re-render only the
 * blocks a change touches, and produce the same video as the single pass (duration, size, frames,
 * pixels). Also checks the burned AI label of «Revisión para redes» in both paths.
 */

const hasFfmpeg =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
const gen = (args: string[]) =>
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);

function probe(file: string): { duration: number; width: number; height: number; frames: number } {
  const out = execFileSync("ffprobe", [
    "-v",
    "error",
    "-count_frames",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,nb_read_frames:format=duration",
    "-of",
    "json",
    file,
  ]).toString();
  const j = JSON.parse(out) as {
    streams: { width: number; height: number; nb_read_frames: string }[];
    format: { duration: string };
  };
  const s = j.streams[0]!;
  return {
    duration: Number(j.format.duration),
    width: s.width,
    height: s.height,
    frames: Number(s.nb_read_frames),
  };
}

/** Gray pixels of the frame at `t`. */
function grayFrame(file: string, t: number, w: number, h: number): Buffer {
  return execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    String(t),
    "-i",
    file,
    "-frames:v",
    "1",
    "-vf",
    `scale=${w}:${h},format=gray`,
    "-f",
    "rawvideo",
    "pipe:1",
  ]);
}

const meanAbsDiff = (a: Buffer, b: Buffer) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return a.length ? sum / a.length : 255;
};

/** Pixels brighter than 200 in a region (white label text on a gray background). */
function brightPixels(file: string, t: number, r: { x: number; y: number; w: number; h: number }) {
  const raw = execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    String(t),
    "-i",
    file,
    "-frames:v",
    "1",
    "-vf",
    `crop=${r.w}:${r.h}:${r.x}:${r.y},format=gray`,
    "-f",
    "rawvideo",
    "pipe:1",
  ]);
  let n = 0;
  for (const v of raw) if (v > 200) n++;
  return n;
}

describe.skipIf(!hasFfmpeg)("segment cache export (lavfi media)", { timeout: 300_000 }, () => {
  const dir = tempStorage("studio-seg-");
  const f = (n: string) => path.join(dir, n);
  let app: FastifyInstance;
  let storage: string;
  let preset: ExportPreset;
  let project: Project;
  const messages: string[] = [];
  const details: {
    done?: number;
    total?: number;
    unit?: string;
    cached?: number;
    eta_s?: number | null;
  }[] = [];

  beforeAll(async () => {
    gen([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=25:duration=14",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=14",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-g",
      "50",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      f("a.mp4"),
    ]);
    gen([
      "-f",
      "lavfi",
      "-i",
      "mandelbrot=size=320x180:rate=25",
      "-t",
      "8",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      f("b.mp4"),
    ]);
    gen([
      "-f",
      "lavfi",
      "-i",
      "color=c=gray:size=320x180:rate=25:duration=3",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      f("gray.mp4"),
    ]);
    ({ app, storage } = await makeApp({ FFMPEG_PATH: "ffmpeg", FFPROBE_PATH: "ffprobe" }));
    app.ctx.queue.on("job", (e) => {
      if (e.message) messages.push(e.message);
      if (e.detail) details.push(e.detail);
    });
    const created = await app.inject({
      method: "POST",
      url: API_ROUTES.exportPresets,
      payload: { name: "Test 180p", aspect: "16:9", width: 320, height: 180, fps: 25, crf: 23 },
    });
    expect(created.statusCode).toBe(201);
    preset = created.json<ExportPreset>();
  }, 120_000);
  afterAll(() => app?.close());

  const upload = async (file: string, type: string) => {
    const { payload, headers } = await multipart(path.basename(file), readFileSync(file), type);
    const res = await app.inject({ method: "POST", url: API_ROUTES.media, payload, headers });
    expect(res.statusCode).toBe(201);
    return res.json<MediaAsset>();
  };
  const jobDone = async (id: string): Promise<Job> => {
    await waitFor(
      () => ["succeeded", "failed", "canceled"].includes(app.ctx.jobs.get(id)!.status),
      240_000,
    );
    const job = app.ctx.jobs.get(id)!;
    if (job.status === "failed")
      throw new Error(`${job.type} failed: ${job.error}\n${app.ctx.jobs.logTail(id).join("\n")}`);
    return job;
  };
  const idle = () =>
    waitFor(
      () =>
        app.ctx.jobs.list({ status: "running" }).length +
          app.ctx.jobs.list({ status: "queued" }).length ===
        0,
      240_000,
    );
  const save = async (p: Project) => {
    const res = await app.inject({
      method: "PUT",
      url: buildRoute(API_ROUTES.project, { id: p.id }),
      payload: p,
    });
    expect(res.statusCode).toBe(200);
    return res.json<Project>();
  };
  const exportNow = async (extra: Record<string, unknown> = {}) => {
    const res = await app.inject({
      method: "POST",
      url: buildRoute(API_ROUTES.projectExport, { id: project.id }),
      payload: { presetId: preset.id, ...extra },
    });
    expect(res.statusCode, res.body).toBe(202);
    const job = await jobDone(res.json<{ jobId: string }>().jobId);
    const result = job.result as ExportJobResult;
    return { result, abs: path.join(storage, result.path) };
  };

  it("caches blocks, re-renders only what changed and matches the single pass", async () => {
    const a = await upload(f("a.mp4"), "video/mp4");
    const b = await upload(f("b.mp4"), "video/mp4");
    await idle();
    const created = await app.inject({
      method: "POST",
      url: API_ROUTES.projects,
      payload: { name: "Bloques", settings: { width: 320, height: 180, fps: 25 } },
    });
    const p = created.json<Project>();
    const [video, text, audio] = p.tracks;
    project = await save({
      ...p,
      subtitles: [{ start: 5, end: 7, text: "Subtítulo del medio" }],
      tracks: [
        {
          ...video!,
          clips: [
            {
              id: "v1",
              trackId: video!.id,
              assetId: a.id,
              start: 0,
              in: 0,
              out: 14,
              speed: 1,
              volume: 1,
              opacity: 1,
              voiceEffects: [],
            },
            {
              id: "v2",
              trackId: video!.id,
              assetId: b.id,
              start: 14,
              in: 0,
              out: 6,
              speed: 1,
              volume: 1,
              opacity: 1,
              voiceEffects: [],
              transitionOut: { type: "fade", durationSec: 0.5 },
            },
          ],
        },
        {
          ...text!,
          clips: [
            {
              id: "t1",
              trackId: text!.id,
              start: 1,
              in: 0,
              out: 2,
              text: "Hola",
              speed: 1,
              volume: 1,
              opacity: 1,
              voiceEffects: [],
              transitionIn: { type: "fade", durationSec: 0.4 },
            },
            {
              id: "t2",
              trackId: text!.id,
              start: 15,
              in: 0,
              out: 3,
              text: "Chau",
              speed: 1,
              volume: 1,
              opacity: 1,
              voiceEffects: [],
            },
          ],
        },
        audio!,
      ],
    });

    // 1st export: everything rendered.
    const first = await exportNow();
    expect(first.result.mode).toBe("segments");
    const total = first.result.segments!.total;
    expect(total).toBeGreaterThanOrEqual(2);
    expect(first.result.segments).toEqual({ total, cached: 0, rendered: total });
    expect(messages.some((m) => /^(Video: )?\d+\/\d+ bloques \(\d+ en caché\)/.test(m))).toBe(true);
    // Integration (M1 ↔ M3): the blocks are the job items (+1 audio/mux step) for the ETA.
    expect(details.some((d) => d.unit === "blocks" && d.total === total + 1)).toBe(true);
    const cacheDir = path.join(storage, SEGMENT_CACHE_SUBDIR);
    expect(
      readdirSync(cacheDir).filter((n) => n.endsWith(".mp4") && !n.includes(".part")),
    ).toHaveLength(total);

    // 2nd export, nothing changed: every block comes from the cache.
    details.length = 0;
    const second = await exportNow();
    expect(second.result.segments).toEqual({ total, cached: total, rendered: 0 });
    // Audit D3: cached blocks are flagged and give no ETA («calculando…», not «faltan ~1 s»).
    const allCached = details.filter((d) => d.unit === "blocks" && d.done === total);
    expect(allCached.length).toBeGreaterThan(0);
    expect(allCached.every((d) => d.cached === total && d.eta_s === null)).toBe(true);
    expect(messages.some((m) => m.includes(`bloques (${total} en caché)`))).toBe(true);

    // Change the text of the last clip: only the blocks under it are rendered again.
    project = await save({
      ...project,
      tracks: project.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === "t2" ? { ...c, text: "Chau, che" } : c)),
      })),
    });
    const third = await exportNow();
    expect(third.result.segments!.rendered).toBeGreaterThanOrEqual(1);
    expect(third.result.segments!.rendered).toBeLessThan(total);
    expect(third.result.segments!.cached).toBe(total - third.result.segments!.rendered);

    // Same project in one pass: same duration, size, frame count and (almost) the same pixels.
    const single = await exportNow({ useSegmentCache: false });
    expect(single.result.mode).toBe("single");
    const ps = probe(single.abs);
    const pc = probe(third.abs);
    expect(pc.width).toBe(ps.width);
    expect(pc.height).toBe(ps.height);
    expect(Math.abs(pc.duration - ps.duration)).toBeLessThan(0.1);
    expect(Math.abs(pc.frames - ps.frames)).toBeLessThanOrEqual(1);
    for (const t of [0.5, 1.2, 6, 9.96, 10.04, 13.9, 14.1, 16, 19.7]) {
      const diff = meanAbsDiff(grayFrame(single.abs, t, 160, 90), grayFrame(third.abs, t, 160, 90));
      expect(diff, `frame diff at ${t}s`).toBeLessThan(4);
    }
  });

  it("burns the AI label bottom-left in the single pass and in the block render", async () => {
    const gray = await upload(f("gray.mp4"), "video/mp4");
    await idle();
    const created = await app.inject({
      method: "POST",
      url: API_ROUTES.projects,
      payload: { name: "Etiqueta", settings: { width: 320, height: 180, fps: 25 } },
    });
    const p = created.json<Project>();
    const [video] = p.tracks;
    const base: Project = {
      ...p,
      captionStyle: {
        id: "s",
        name: "s",
        fontFamily: "DejaVu Sans",
        fontSize: 150,
        color: "#ffffff",
        background: "",
        highlightColor: "#ffff00",
        position: "bottom",
        uppercase: false,
        animation: "none",
      },
      tracks: [
        {
          ...video!,
          clips: [
            {
              id: "g",
              trackId: video!.id,
              assetId: gray.id,
              start: 0,
              in: 0,
              out: 3,
              speed: 1,
              volume: 1,
              opacity: 1,
              voiceEffects: [],
            },
          ],
        },
        ...p.tracks.slice(1),
      ],
    };
    const region = { x: 0, y: 130, w: 200, h: 50 };
    project = await save(base);
    const off = await exportNow({ useSegmentCache: false });
    expect(brightPixels(off.abs, 1.5, region)).toBe(0);

    project = await save({
      ...base,
      publish: {
        forSocial: true,
        flags: { aiFace: true, aiVoice: false, aiOther: false, music: false, thirdParty: false },
        aiLabel: true,
      },
    });
    expect(project.publish?.aiLabel).toBe(true);
    const single = await exportNow({ useSegmentCache: false });
    const blocks = await exportNow();
    expect(blocks.result.mode).toBe("segments");
    for (const out of [single.abs, blocks.abs]) {
      expect(brightPixels(out, 0.2, region)).toBeGreaterThan(20);
      expect(brightPixels(out, 2.8, region)).toBeGreaterThan(20);
      // only bottom-left: the top-right corner stays gray
      expect(brightPixels(out, 1.5, { x: 160, y: 0, w: 160, h: 60 })).toBe(0);
    }
  });
});

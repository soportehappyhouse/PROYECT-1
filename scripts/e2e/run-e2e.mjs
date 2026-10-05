#!/usr/bin/env node
// Studio end-to-end check against a running api (no dependencies: Node >= 22, ffmpeg + ffprobe).
//
//   node scripts/e2e/run-e2e.mjs --api http://127.0.0.1:3001
//
// Options:
//   --api <url>        api base URL (default http://127.0.0.1:3001)
//   --storage <dir>    api STORAGE_DIR, used to copy a wav into storage/library for the scan test
//                      (default: <repo>/storage). If missing, the library is fed via upload instead.
//   --work <dir>       scratch folder for generated media and downloads (default: OS temp)
//   --out <file>       JSON report path (default: <work>/report.json)
//   --ffmpeg <path>    ffmpeg binary (default: ffmpeg on PATH); --ffprobe likewise
//   --skip-motion      skip the Remotion renders (no Chrome Headless Shell installed)
//   --timeout <sec>    max wait per job (default 900)
//
// Exit code 0 = every required step passed. Steps marked "expected-fail" (e.g. Whisper without
// models) only record the observed behaviour.

import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const API = opt("api", "http://127.0.0.1:3001").replace(/\/+$/, "");
const STORAGE = path.resolve(opt("storage", path.join(REPO, "storage")));
const WORK = path.resolve(opt("work", path.join(os.tmpdir(), `studio-e2e-${Date.now()}`)));
const OUT = path.resolve(opt("out", path.join(WORK, "report.json")));
const FFMPEG = opt("ffmpeg", "ffmpeg");
const FFPROBE = opt("ffprobe", "ffprobe");
const SKIP_MOTION = flag("skip-motion");
const JOB_TIMEOUT_MS = Number(opt("timeout", "900")) * 1000;

// ---------------------------------------------------------------- helpers
const results = [];
const t0 = Date.now();
const fmt = (ms) => `${(ms / 1000).toFixed(2)} s`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Fail extends Error {}
function assert(cond, msg) {
  if (!cond) throw new Fail(msg);
}

/** Run a named step; `kind`: "required" | "optional" | "expected-fail". */
async function step(name, fn, kind = "required") {
  const start = Date.now();
  process.stdout.write(`… ${name}\n`);
  try {
    const detail = await fn();
    const ms = Date.now() - start;
    results.push({ name, status: "PASS", ms, kind, detail: detail ?? null });
    console.log(
      `  PASS  ${fmt(ms)}${detail ? `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`,
    );
    return detail;
  } catch (err) {
    const ms = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, status: "FAIL", ms, kind, detail: msg });
    console.log(`  FAIL  ${fmt(ms)}  ${msg}`);
    return undefined;
  }
}

function run(bin, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd, windowsHide: true });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${bin} exited ${code}: ${err.slice(-800)}`)),
    );
  });
}

async function api(method, route, body, { raw = false, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["content-type"] = "application/json";
  }
  const res = await fetch(`${API}${route}`, init);
  if (raw) return res;
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

async function ok(method, route, body, expect = [200, 201, 202, 204]) {
  const r = await api(method, route, body);
  assert(
    expect.includes(r.status),
    `${method} ${route} -> ${r.status} ${JSON.stringify(r.json)?.slice(0, 400)}`,
  );
  return r.json;
}

async function upload(file, mime) {
  const fd = new FormData();
  fd.append("file", new Blob([await readFile(file)], { type: mime }), path.basename(file));
  return ok("POST", "/api/media", fd, [201]);
}

/** Poll a job until terminal (SSE is checked separately). */
async function waitJob(id, { timeoutMs = JOB_TIMEOUT_MS, onProgress } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const { json: job } = await api("GET", `/api/jobs/${id}`);
    if (onProgress) await onProgress(job);
    if (["succeeded", "failed", "canceled"].includes(job.status)) return job;
    if (Date.now() > end) throw new Fail(`job ${id} (${job.type}) timeout in ${job.status}`);
    await sleep(400);
  }
}
async function waitOk(id, opts) {
  const job = await waitJob(id, opts);
  if (job.status !== "succeeded") {
    const log = await api("GET", `/api/jobs/${id}/log`);
    throw new Fail(
      `job ${job.type} ${job.status}: ${job.error ?? job.message} | log: ${(log.json?.lines ?? []).slice(-5).join(" / ")}`,
    );
  }
  return job;
}

/** Jobs auto-enqueued by an upload (probe/proxy) for one asset. */
async function waitAssetJobs(assetId, types) {
  const end = Date.now() + JOB_TIMEOUT_MS;
  const found = new Map();
  for (;;) {
    const { json: jobs } = await api("GET", `/api/jobs?limit=500`);
    for (const j of jobs)
      if (j.payload?.assetId === assetId && types.includes(j.type)) found.set(j.type, j);
    const done = types.every(
      (t) => found.get(t) && ["succeeded", "failed", "canceled"].includes(found.get(t).status),
    );
    if (done) return [...found.values()];
    if (Date.now() > end) throw new Fail(`timeout waiting ${types.join(",")} for ${assetId}`);
    await sleep(400);
  }
}

async function ffprobe(file) {
  return JSON.parse(
    await run(FFPROBE, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]),
  );
}

async function download(rel, name) {
  const res = await fetch(`${API}/files/${rel.split("/").map(encodeURIComponent).join("/")}`);
  assert(res.ok, `GET /files/${rel} -> ${res.status}`);
  const dest = path.join(WORK, name ?? path.basename(rel));
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;
/** JSON with sorted keys (zod re-orders object keys; order is not meaningful). */
const canon = (v) =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );
let nid = 0;
const id = (p) => `${p}${++nid}${Math.random().toString(36).slice(2, 7)}`;

// ---------------------------------------------------------------- SSE collector
const sse = { events: [], open: false, error: undefined, controller: new AbortController() };
async function startSse() {
  const res = await fetch(`${API}/api/jobs/events`, {
    signal: sse.controller.signal,
    headers: { accept: "text/event-stream", origin: "http://localhost:3000" },
  });
  assert(res.ok, `SSE status ${res.status}`);
  assert((res.headers.get("content-type") ?? "").includes("text/event-stream"), "SSE content-type");
  sse.open = true;
  sse.cors = res.headers.get("access-control-allow-origin");
  (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("");
          if (data) sse.events.push({ at: Date.now(), ...JSON.parse(data) });
        }
      }
    } catch (err) {
      if (err?.name !== "AbortError") sse.error = String(err);
    }
  })();
}
const sseFor = (jobId) => sse.events.filter((e) => e.jobId === jobId);

// ---------------------------------------------------------------- main
await mkdir(WORK, { recursive: true });
console.log(`Studio e2e · api ${API} · work ${WORK}`);
const ctx = {};

await step("health + config + encoders", async () => {
  const h = await ok("GET", "/api/health");
  assert(h.ffmpeg.available, "ffmpeg not available in api");
  const cfg = await ok("GET", "/api/config");
  assert(!JSON.stringify(cfg).match(/sk-|key_/i), "config leaks a key?");
  const enc = await ok("GET", "/api/system/encoders");
  const engines = await ok("GET", "/api/motion/engines");
  ctx.remotionOk = engines.find((e) => e.id === "remotion")?.ok;
  return {
    status: h.status,
    workers: h.workers.reachable,
    encoders: enc,
    remotion: ctx.remotionOk,
  };
});

await step("SSE /api/jobs/events connects (CORS header)", async () => {
  await startSse();
  return { cors: sse.cors };
});

await step("generate test media with ffmpeg -f lavfi", async () => {
  ctx.video = path.join(WORK, "e2e-video.mp4");
  ctx.sfx = path.join(WORK, "e2e-sfx.wav");
  ctx.image = path.join(WORK, "e2e-image.png");
  ctx.libWav = path.join(WORK, "e2e-campana-biblioteca.wav");
  ctx.bad = path.join(WORK, "e2e-corrupto.mp4");
  await run(FFMPEG, [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=1280x720:r=30:d=10",
    "-f",
    "lavfi",
    "-i",
    "sine=f=440:sample_rate=48000:d=10",
    "-shortest",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "veryfast",
    "-c:a",
    "aac",
    ctx.video,
  ]);
  await run(FFMPEG, [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=f=880:sample_rate=48000:d=3,afade=t=out:st=2:d=1",
    ctx.sfx,
  ]);
  await run(FFMPEG, [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=s=640x360:d=1",
    "-frames:v",
    "1",
    ctx.image,
  ]);
  await run(FFMPEG, [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=f=1320:sample_rate=44100:d=1.5,afade=t=out:st=0.5:d=1",
    ctx.libWav,
  ]);
  await writeFile(ctx.bad, Buffer.from("this is not a video file".repeat(100)));
  const v = await ffprobe(ctx.video);
  return { videoSec: +(+v.format.duration).toFixed(2) };
});

await step("upload video/sfx/image (multipart)", async () => {
  ctx.vAsset = await upload(ctx.video, "video/mp4");
  ctx.sAsset = await upload(ctx.sfx, "audio/wav");
  ctx.iAsset = await upload(ctx.image, "image/png");
  return { video: ctx.vAsset.id, sfx: ctx.sAsset.id, image: ctx.iAsset.id };
});

await step("probe + proxy jobs (metadata, thumbnail, sprite, peaks)", async () => {
  const jobs = [
    ...(await waitAssetJobs(ctx.vAsset.id, ["media.probe", "media.proxy"])),
    ...(await waitAssetJobs(ctx.sAsset.id, ["media.probe"])),
    ...(await waitAssetJobs(ctx.iAsset.id, ["media.probe"])),
  ];
  for (const j of jobs) assert(j.status === "succeeded", `${j.type} ${j.status}: ${j.error}`);
  const v = await ok("GET", `/api/media/${ctx.vAsset.id}`);
  const s = await ok("GET", `/api/media/${ctx.sAsset.id}`);
  const i = await ok("GET", `/api/media/${ctx.iAsset.id}`);
  assert(near(v.durationSec, 10, 0.1) && v.width === 1280 && v.height === 720, "video meta");
  assert(
    v.hasAudio && v.hasVideo && v.proxyPath && v.thumbnailPath && v.sprite && v.waveformPath,
    "video derivatives",
  );
  assert(near(s.durationSec, 3, 0.05) && s.hasAudio && !s.hasVideo && s.waveformPath, "sfx meta");
  assert(i.kind === "image" && i.width === 640, "image meta");
  ctx.vAsset = v;
  ctx.sAsset = s;
  ctx.iAsset = i;
  return { jobs: jobs.length, proxy: v.proxyPath, codec: v.videoCodec };
});

await step("SSE delivered probe job events", async () => {
  await sleep(300);
  const ids = new Set(sse.events.map((e) => e.jobId));
  const terminal = sse.events.filter((e) => e.status === "succeeded");
  assert(
    ids.size >= 4 && terminal.length >= 4,
    `only ${ids.size} jobs / ${terminal.length} succeeded events`,
  );
  return { events: sse.events.length, jobs: ids.size };
});

await step("media file streaming with HTTP Range (206)", async () => {
  const res = await api("GET", `/api/media/${ctx.vAsset.id}/file`, undefined, {
    raw: true,
    headers: { range: "bytes=0-1023" },
  });
  assert(res.status === 206, `status ${res.status}`);
  const len = (await res.arrayBuffer()).byteLength;
  assert(len === 1024, `len ${len}`);
  const proxy = await api("GET", `/api/media/${ctx.vAsset.id}/file?proxy=1`, undefined, {
    raw: true,
    headers: { range: "bytes=0-99" },
  });
  await proxy.arrayBuffer();
  assert(proxy.status === 206, `proxy ${proxy.status}`);
  return "206 original + proxy";
});

await step("voice effect job (robot) on the video's audio", async () => {
  const { jobId } = await ok("POST", "/api/voice/effects", {
    assetId: ctx.vAsset.id,
    effects: [{ type: "robot", intensity: 1 }],
  });
  const job = await waitOk(jobId);
  ctx.robot = await ok("GET", `/api/media/${job.result.assetId}`);
  const f = await ffprobe(await download(job.result.path, "robot.wav"));
  const a = f.streams.find((s) => s.codec_type === "audio");
  assert(a && near(+f.format.duration, 10, 0.2), `robot duration ${f.format.duration}`);
  return {
    asset: ctx.robot.id,
    sec: +(+f.format.duration).toFixed(2),
    codec: a.codec_name,
    rate: a.sample_rate,
  };
});

await step(
  "create project + timeline (trim 2–7 s, speed x2, text, PiP image, SFX, robot audio)",
  async () => {
    const p = await ok(
      "POST",
      "/api/projects",
      { name: "E2E Prueba Ñandú", settings: { width: 1920, height: 1080, fps: 30 } },
      [201],
    );
    ctx.project = p;
    const V = p.tracks.find((t) => t.kind === "video");
    const T = p.tracks.find((t) => t.kind === "text");
    const A = p.tracks.find((t) => t.kind === "audio");
    ctx.titleClip = id("mt");
    ctx.capClip = id("mc");
    V.clips = [
      // cut: source 2–7 s at timeline 0–5 (original audio low under the robot voice)
      { id: id("c"), trackId: V.id, assetId: ctx.vAsset.id, start: 0, in: 2, out: 7, volume: 0.2 },
      // speed x2: source 7–9 s -> 1 s on the timeline (5–6 s)
      {
        id: id("c"),
        trackId: V.id,
        assetId: ctx.vAsset.id,
        start: 5,
        in: 7,
        out: 9,
        speed: 2,
        volume: 0.2,
      },
    ];
    T.clips = [
      {
        id: id("c"),
        trackId: T.id,
        start: 0.5,
        in: 0,
        out: 3,
        text: "Prueba E2E · Ñandú ¿ok?",
        textStyle: {
          fontFamily: "Arial",
          fontSize: 56,
          color: "#ffffff",
          background: "#000000aa",
          position: "top",
        },
      },
    ];
    A.clips = [
      { id: id("c"), trackId: A.id, assetId: ctx.sAsset.id, start: 2, in: 0, out: 3, volume: 1 },
    ];
    const pip = { id: id("t"), kind: "video", name: "PiP imagen", clips: [] };
    pip.clips = [
      {
        id: id("c"),
        trackId: pip.id,
        assetId: ctx.iAsset.id,
        start: 3,
        in: 0,
        out: 2,
        scale: 0.3,
        position: { x: 1, y: 1 },
      },
    ];
    const voice = { id: id("t"), kind: "audio", name: "Voz robot", clips: [] };
    voice.clips = [
      { id: id("c"), trackId: voice.id, assetId: ctx.robot.id, start: 0, in: 2, out: 7, volume: 1 },
    ];
    const motion = { id: id("t"), kind: "motion", name: "Motion", clips: [] };
    motion.clips = [
      {
        id: ctx.titleClip,
        trackId: motion.id,
        start: 0,
        in: 0,
        out: 2.5,
        motion: { template: "title-card", durationSec: 2.5, format: "webm-vp9-alpha", props: {} },
      },
      {
        id: ctx.capClip,
        trackId: motion.id,
        start: 2.5,
        in: 0,
        out: 3.5,
        motion: {
          template: "animated-captions",
          durationSec: 3.5,
          format: "webm-vp9-alpha",
          props: {},
        },
      },
    ];
    // order = layering (bottom -> top): video, pip, motion, text, audio
    p.tracks = [V, pip, motion, T, A, voice];
    ctx.project = await ok("PUT", `/api/projects/${p.id}`, p);
    return { project: p.id, tracks: ctx.project.tracks.length };
  },
);

const transcript = {
  language: "es",
  durationSec: 3.5,
  segments: [
    {
      start: 0.1,
      end: 1.6,
      text: "Hola, esto es Studio.",
      words: [
        { start: 0.1, end: 0.5, word: " Hola," },
        { start: 0.55, end: 0.8, word: " esto" },
        { start: 0.85, end: 1.0, word: " es" },
        { start: 1.05, end: 1.6, word: " Studio." },
      ],
    },
    {
      start: 1.8,
      end: 3.3,
      text: "Subtítulos palabra a palabra.",
      words: [
        { start: 1.8, end: 2.4, word: " Subtítulos" },
        { start: 2.45, end: 2.8, word: " palabra" },
        { start: 2.85, end: 2.95, word: " a" },
        { start: 3.0, end: 3.3, word: " palabra." },
      ],
    },
  ],
};

async function motionRender(label, spec, clipId, file) {
  const t = Date.now();
  const { jobId } = await ok("POST", "/api/motion/render", {
    ...spec,
    target: { projectId: ctx.project.id, clipId },
  });
  const job = await waitOk(jobId);
  const elapsed = Date.now() - t;
  const local = await download(job.result.path, file);
  const f = await ffprobe(local);
  const v = f.streams.find((s) => s.codec_type === "video");
  const alphaTag = v.tags?.alpha_mode ?? v.tags?.ALPHA_MODE;
  assert(
    v.codec_name === "vp9" && alphaTag === "1",
    `${label}: codec ${v.codec_name} alpha_mode ${alphaTag}`,
  );
  assert(v.width === spec.width && v.height === spec.height, `${label}: ${v.width}x${v.height}`);
  assert(
    near(+f.format.duration, spec.durationSec, 0.15),
    `${label}: duration ${f.format.duration}`,
  );
  // decode with libvpx to confirm a real alpha plane (first frame -> PNG rgba)
  const png = local.replace(/\.webm$/, ".png");
  await run(FFMPEG, [
    "-y",
    "-v",
    "error",
    "-c:v",
    "libvpx-vp9",
    "-ss",
    "1",
    "-i",
    local,
    "-frames:v",
    "1",
    png,
  ]);
  const pf = await ffprobe(png);
  assert(/a/.test(pf.streams[0].pix_fmt), `${label}: decoded pix_fmt ${pf.streams[0].pix_fmt}`);
  const sse1 = sseFor(jobId);
  return {
    job,
    sec: +(+f.format.duration).toFixed(2),
    wall: fmt(elapsed),
    renderMs: job.result.renderTimeMs,
    size: `${v.width}x${v.height}`,
    alpha: pf.streams[0].pix_fmt,
    sseEvents: sse1.length,
  };
}

if (SKIP_MOTION) {
  results.push({
    name: "motion renders",
    status: "SKIP",
    ms: 0,
    kind: "optional",
    detail: "--skip-motion",
  });
} else {
  await step("motion.render title-card → WebM VP9 alpha, linked to clip", async () => {
    const r = await motionRender(
      "title-card",
      {
        template: "title-card",
        durationSec: 2.5,
        fps: 30,
        width: 1920,
        height: 1080,
        format: "webm-vp9-alpha",
        props: {
          title: "Prueba E2E",
          subtitle: "Studio · Ñandú",
          background: "transparent",
          style: "pop",
        },
      },
      ctx.titleClip,
      "title-card.webm",
    );
    ctx.titleJob = r.job;
    const { job: _j, ...rest } = r;
    return rest;
  });
  await step(
    "motion.render animated-captions (word-level transcript JSON) → alpha, linked",
    async () => {
      const r = await motionRender(
        "animated-captions",
        {
          template: "animated-captions",
          durationSec: 3.5,
          fps: 30,
          width: 1920,
          height: 1080,
          format: "webm-vp9-alpha",
          props: { transcript, style: "highlight", position: "bottom", background: "transparent" },
        },
        ctx.capClip,
        "captions.webm",
      );
      ctx.capJob = r.job;
      const { job: _j, ...rest } = r;
      return rest;
    },
  );
  await step("project clips got renderedAssetId (motion → timeline link)", async () => {
    const p = await ok("GET", `/api/projects/${ctx.project.id}`);
    const clips = p.tracks.flatMap((t) => t.clips);
    const a = clips.find((c) => c.id === ctx.titleClip);
    const b = clips.find((c) => c.id === ctx.capClip);
    assert(a?.renderedAssetId && b?.renderedAssetId, "renderedAssetId missing");
    const asset = await ok("GET", `/api/media/${a.renderedAssetId}`);
    assert(asset.hasAlpha === true, `render asset hasAlpha=${asset.hasAlpha}`);
    ctx.project = p;
    return { title: a.renderedAssetId, captions: b.renderedAssetId };
  });
  await step("SSE carried motion progress (>2 events per render)", async () => {
    const n = sseFor(ctx.titleJob.id).length;
    assert(n > 2, `only ${n} events`);
    return { events: n };
  });
}

async function exportWith(presetId, expect) {
  const t = Date.now();
  const { jobId } = await ok("POST", `/api/projects/${ctx.project.id}/export`, { presetId });
  const job = await waitOk(jobId);
  const elapsed = Date.now() - t;
  const local = await download(job.result.path, `${presetId}.${job.result.path.split(".").pop()}`);
  const f = await ffprobe(local);
  const v = f.streams.find((s) => s.codec_type === "video");
  const a = f.streams.find((s) => s.codec_type === "audio");
  assert(
    v && v.width === expect.w && v.height === expect.h,
    `${presetId}: ${v?.width}x${v?.height}`,
  );
  assert(
    v.codec_name === "h264" && a?.codec_name === "aac",
    `${presetId}: ${v.codec_name}/${a?.codec_name}`,
  );
  assert(near(+f.format.duration, expect.sec, 0.15), `${presetId}: duration ${f.format.duration}`);
  const fps = v.avg_frame_rate.split("/").reduce((x, y) => +x / +y);
  assert(near(fps, expect.fps, 0.1), `${presetId}: fps ${fps}`);
  // frame grabs for a human look (title at 1.2 s, PiP+SFX at 3.5 s, speed segment at 5.5 s)
  for (const at of [1.2, 3.5, 5.5])
    await run(FFMPEG, [
      "-y",
      "-v",
      "error",
      "-ss",
      String(at),
      "-i",
      local,
      "-frames:v",
      "1",
      "-vf",
      "scale=480:-2",
      path.join(WORK, `${presetId}-${at}s.jpg`),
    ]);
  // audio must not be silent (SFX + robot voice mixed)
  const vol = await new Promise((resolve) => {
    const p = spawn(FFMPEG, ["-v", "info", "-i", local, "-af", "volumedetect", "-f", "null", "-"], {
      windowsHide: true,
    });
    let e = "";
    p.stderr.on("data", (d) => (e += d));
    p.on("close", () => resolve(/mean_volume: (-?[\d.]+) dB/.exec(e)?.[1]));
  });
  assert(vol !== undefined && +vol > -60, `${presetId}: audio mean ${vol} dB`);
  return {
    file: job.result.path,
    wall: fmt(elapsed),
    size: `${v.width}x${v.height}`,
    sec: +(+f.format.duration).toFixed(2),
    fps,
    vcodec: v.codec_name,
    acodec: a.codec_name,
    meanVolDb: +vol,
    bytes: +f.format.size,
    sseEvents: sseFor(jobId).length,
  };
}

await step("export YouTube 1080p preset (youtube-1080p)", () =>
  exportWith("youtube-1080p", { w: 1920, h: 1080, sec: 6, fps: 30 }),
);
await step("export Reels 9:16 preset (reels-tiktok, blurred reframe)", () =>
  exportWith("reels-tiktok", { w: 1080, h: 1920, sec: 6, fps: 30 }),
);

/** Pixels of a frame region brighter than `min` (gray, scaled to `w` px wide). */
async function brightPixels(file, at, { w = 320, min = 170, region } = {}) {
  const probe = await ffprobe(file);
  const v = probe.streams.find((s) => s.codec_type === "video");
  const h = Math.round((v.height * w) / v.width / 2) * 2;
  const raw = await new Promise((resolve, reject) => {
    const p = spawn(
      FFMPEG,
      [
        "-v",
        "error",
        "-ss",
        String(at),
        "-i",
        file,
        "-frames:v",
        "1",
        "-vf",
        `scale=${w}:${h},format=gray`,
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { windowsHide: true },
    );
    const chunks = [];
    p.stdout.on("data", (d) => chunks.push(d));
    p.on("error", reject);
    p.on("close", () => resolve(Buffer.concat(chunks)));
  });
  const [y0, y1] = region ? [Math.round(region[0] * h), Math.round(region[1] * h)] : [0, h];
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) if (raw[y * w + x] > min) n++;
  return n;
}

// Feedback 2026-10-05 (docs/trabajo/feedback-usuario-2026-10-05.md): a vertical WhatsApp clip
// (478×850) on a 1920×1080 project, 2 animated-captions + 3 title-card clips on ONE Motion track
// (overlapping, as the dashboard created them), exported with YouTube 1080p and Reels 9:16. The
// motion overlays must be in both exports: the source is a flat dark gray, so bright pixels can
// only come from the overlays.
await step(
  "user scenario: vertical 478×850 + overlapping motion → overlays present in 16:9 and 9:16",
  async () => {
    assert(
      !SKIP_MOTION && ctx.titleJob && ctx.capJob,
      "needs the motion renders (no --skip-motion)",
    );
    const vertical = path.join(WORK, "whatsapp-vertical.mp4");
    await run(FFMPEG, [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x303030:s=478x850:r=30:d=6",
      "-f",
      "lavfi",
      "-i",
      "sine=f=300:sample_rate=48000:d=6",
      "-shortest",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "veryfast",
      "-c:a",
      "aac",
      vertical,
    ]);
    const asset = await upload(vertical, "video/mp4");
    await waitAssetJobs(asset.id, ["media.probe"]);
    const p = await ok(
      "POST",
      "/api/projects",
      { name: "E2E vertical WhatsApp", settings: { width: 1920, height: 1080, fps: 30 } },
      [201],
    );
    const V = p.tracks.find((t) => t.kind === "video");
    V.clips = [{ id: id("c"), trackId: V.id, assetId: asset.id, start: 0, in: 0, out: 6 }];
    const M = { id: id("t"), kind: "motion", name: "Motion 1", clips: [] };
    const caps = {
      template: "animated-captions",
      durationSec: 3.5,
      format: "webm-vp9-alpha",
      props: {},
    };
    const title = { template: "title-card", durationSec: 2.5, format: "webm-vp9-alpha", props: {} };
    const fresh = id("mt");
    M.clips = [
      // "Renderizar subtítulos como motion" ×2: same start, same span
      {
        id: id("mc"),
        trackId: M.id,
        start: 0,
        in: 0,
        out: 3.5,
        motion: caps,
        renderedAssetId: ctx.capJob.result.assetId,
      },
      {
        id: id("mc"),
        trackId: M.id,
        start: 0,
        in: 0,
        out: 3.5,
        motion: caps,
        renderedAssetId: ctx.capJob.result.assetId,
      },
      // title-card ×3 at the playhead: one rendered now with `target`, one linked, one from Media
      { id: fresh, trackId: M.id, start: 0, in: 0, out: 2.5, motion: title },
      {
        id: id("mt"),
        trackId: M.id,
        start: 0,
        in: 0,
        out: 2.5,
        motion: title,
        renderedAssetId: ctx.titleJob.result.assetId,
      },
      {
        id: id("mt"),
        trackId: M.id,
        start: 0.5,
        in: 0,
        out: 2.5,
        assetId: ctx.titleJob.result.assetId,
      },
    ];
    p.tracks = [V, M, ...p.tracks.filter((t) => t.kind !== "video")];
    await ok("PUT", `/api/projects/${p.id}`, p);
    const { jobId } = await ok("POST", "/api/motion/render", {
      template: "title-card",
      durationSec: 2.5,
      fps: 30,
      width: 1920,
      height: 1080,
      format: "webm-vp9-alpha",
      props: { title: "WhatsApp", subtitle: "vertical", background: "transparent" },
      target: { projectId: p.id, clipId: fresh },
    });
    await waitOk(jobId);
    const linked = (await ok("GET", `/api/projects/${p.id}`)).tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === fresh);
    assert(linked?.renderedAssetId, "fresh title-card not linked (renderedAssetId missing)");
    const out = {};
    for (const [presetId, w, h] of [
      ["youtube-1080p", 1920, 1080],
      ["reels-tiktok", 1080, 1920],
    ]) {
      const r = await ok("POST", `/api/projects/${p.id}/export`, { presetId });
      const job = await waitOk(r.jobId);
      const log = (await ok("GET", `/api/jobs/${r.jobId}/log`)).lines ?? [];
      assert(
        !log.some((l) => /se omite/.test(l)),
        `${presetId}: dropped clips: ${log.join(" / ")}`,
      );
      const file = await download(job.result.path, `vertical-${presetId}.mp4`);
      const f = await ffprobe(file);
      const v = f.streams.find((s) => s.codec_type === "video");
      assert(v.width === w && v.height === h, `${presetId}: ${v.width}x${v.height}`);
      assert(near(+f.format.duration, 6, 0.15), `${presetId}: duration ${f.format.duration}`);
      // 9:16: the 16:9 canvas sits in the middle third over the blurred background
      const mid = presetId === "reels-tiktok" ? [0.34, 0.66] : [0, 1];
      const titles = await brightPixels(file, 1.0, { region: mid });
      const captions = await brightPixels(file, 3.2, { region: mid });
      const bare = await brightPixels(file, 5.0, { region: mid });
      assert(titles > 150, `${presetId}: title overlays missing (${titles} bright px at 1 s)`);
      assert(
        captions > 60,
        `${presetId}: caption overlay missing (${captions} bright px at 3.2 s)`,
      );
      assert(bare < 20, `${presetId}: unexpected bright pixels without overlays (${bare})`);
      await run(FFMPEG, [
        "-y",
        "-v",
        "error",
        "-ss",
        "1",
        "-i",
        file,
        "-frames:v",
        "1",
        "-vf",
        "scale=480:-2",
        path.join(WORK, `vertical-${presetId}-1s.jpg`),
      ]);
      out[presetId] = {
        size: `${v.width}x${v.height}`,
        titles,
        captions,
        bare,
        lanes: log.find((l) => /capas/.test(l)) ?? null,
      };
    }
    return out;
  },
);

await step(
  "cancel a running job (motion render 60 s mp4)",
  async () => {
    const { jobId } = await ok("POST", "/api/motion/render", {
      template: "kinetic-typography",
      durationSec: 60,
      fps: 30,
      width: 1920,
      height: 1080,
      format: "mp4-h264",
    });
    let canceledAt;
    const job = await waitJob(jobId, {
      timeoutMs: 180_000,
      onProgress: async (j) => {
        if (!canceledAt && j.status === "running" && j.progress > 0.02) {
          canceledAt = Date.now();
          await ok("POST", `/api/jobs/${jobId}/cancel`);
        }
      },
    });
    assert(job.status === "canceled", `status ${job.status}`);
    await sleep(300);
    const ev = sseFor(jobId).at(-1);
    assert(ev?.status === "canceled", `SSE last status ${ev?.status}`);
    return { stopAfterCancel: fmt(Date.now() - canceledAt), progressAtCancel: job.progress };
  },
  SKIP_MOTION ? "optional" : "required",
);

await step("cancel a running export (youtube-4k) + partial file removed", async () => {
  const { jobId } = await ok("POST", `/api/projects/${ctx.project.id}/export`, {
    presetId: "youtube-4k",
    fileName: "cancelar",
  });
  let canceledAt;
  const job = await waitJob(jobId, {
    timeoutMs: 180_000,
    onProgress: async (j) => {
      if (!canceledAt && j.status === "running" && j.progress > 0.05) {
        canceledAt = Date.now();
        await ok("POST", `/api/jobs/${jobId}/cancel`);
      }
    },
  });
  assert(job.status === "canceled", `status ${job.status}`);
  const exports = existsSync(path.join(STORAGE, "exports"))
    ? (await import("node:fs/promises")).readdir(path.join(STORAGE, "exports"))
    : Promise.resolve(null);
  const list = await exports;
  if (list)
    assert(
      !list.some((f) => f.startsWith("cancelar")),
      `leftover ${list.filter((f) => f.startsWith("cancelar"))}`,
    );
  return { stopAfterCancel: fmt(Date.now() - canceledAt), checkedDisk: Boolean(list) };
});

await step("cancel a queued job (immediate)", async () => {
  // fill the ffmpeg lane, then cancel the last queued one
  const ids = [];
  for (let i = 0; i < 4; i++)
    ids.push((await ok("POST", `/api/media/${ctx.vAsset.id}/proxy`)).jobId);
  const last = ids.at(-1);
  const before = await ok("GET", `/api/jobs/${last}`);
  const after = await ok("POST", `/api/jobs/${last}/cancel`);
  for (const j of ids.slice(0, -1)) await waitJob(j);
  return { statusBefore: before.status, statusAfter: after.status };
});

await step("settings round-trip (theme, panels, ui.layout)", async () => {
  const s = await ok("GET", "/api/settings");
  const next = structuredClone(s);
  next.theme = "dark";
  next.panels = next.panels.map((p) => (p.id === "jobs" ? { ...p, visible: true } : p));
  next.ui = {
    accent: "#e13238",
    density: "compact",
    layout: { grid: { e2e: true, n: 3 } },
    layoutPresets: [
      { id: "e2e", name: "E2E", layout: { a: 1 }, createdAt: new Date().toISOString() },
    ],
    updatedAt: new Date().toISOString(),
  };
  await ok("PUT", "/api/settings", next);
  const back = await ok("GET", "/api/settings");
  assert(
    canon(back) === canon(next),
    `settings differ after round-trip: ${canon(back).slice(0, 200)}`,
  );
  const bad = await api("PUT", "/api/settings", { theme: "neon" });
  assert(bad.status === 400, `invalid settings -> ${bad.status}`);
  await ok("PUT", "/api/settings", s); // restore
  return "PUT/GET identical; invalid -> 400";
});

await step("library: copy wav into storage/library, scan, search, import to timeline", async () => {
  let mode;
  if (existsSync(STORAGE)) {
    const dir = path.join(STORAGE, "library", "sfx", "e2e");
    await mkdir(dir, { recursive: true });
    await copyFile(ctx.libWav, path.join(dir, path.basename(ctx.libWav)));
    mode = "copy+scan";
  } else {
    const fd = new FormData();
    fd.append("kind", "sfx");
    fd.append("tags", "campana,e2e");
    fd.append("license", "CC0");
    fd.append(
      "file",
      new Blob([await readFile(ctx.libWav)], { type: "audio/wav" }),
      path.basename(ctx.libWav),
    );
    await ok("POST", "/api/library/import", fd, [200, 201]);
    mode = "upload (storage dir not found)";
  }
  const scan = await ok("POST", "/api/library/scan");
  const found = await ok("GET", "/api/library?q=campana");
  assert(found.items?.length >= 1, `search 'campana' -> ${found.items?.length} items`);
  const item = found.items[0];
  const peaks = await api("GET", `/api/library/${encodeURIComponent(item.id)}/peaks`);
  const asset = await ok(
    "POST",
    "/api/library/import",
    { provider: "local", remoteId: item.id },
    [201],
  );
  assert(asset.kind === "audio", "imported asset kind");
  return { mode, scan, hits: found.items.length, peaks: peaks.status, asset: asset.id };
});

await step("project autosave (snapshot ≠ saved; cleared on PUT)", async () => {
  const p = await ok("GET", `/api/projects/${ctx.project.id}`);
  const snap = { ...p, name: "E2E autosave borrador" };
  const info = await ok("PUT", `/api/projects/${p.id}/autosave`, snap);
  const got = await ok("GET", `/api/projects/${p.id}/autosave`);
  assert(got.project.name === snap.name && got.savedAt === info.savedAt, "autosave read-back");
  const saved = await ok("GET", `/api/projects/${p.id}`);
  assert(saved.name === p.name, "autosave modified the saved project");
  await ok("PUT", `/api/projects/${p.id}`, saved);
  const gone = await api("GET", `/api/projects/${p.id}/autosave`);
  assert(gone.status === 404, `autosave after PUT -> ${gone.status}`);
  return { savedAt: info.savedAt };
});

await step(
  "negative: unsupported upload -> 415, bad motion spec -> 400, unknown preset -> 404",
  async () => {
    const fd = new FormData();
    fd.append(
      "file",
      new Blob([Buffer.from("MZ")], { type: "application/octet-stream" }),
      "virus.exe",
    );
    const r1 = await api("POST", "/api/media", fd);
    const r2 = await api("POST", "/api/motion/render", { template: "no-existe", durationSec: 1 });
    const r3 = await api("POST", `/api/projects/${ctx.project.id}/export`, { presetId: "nope" });
    const r4 = await api("POST", "/api/media", { not: "multipart" });
    assert(
      r1.status === 415 && r2.status === 400 && r3.status === 404 && r4.status === 415,
      `got ${r1.status}/${r2.status}/${r3.status}/${r4.status}`,
    );
    return { exe: r1.status, motion: r2.status, preset: r3.status, json: r4.status };
  },
);

await step("negative: corrupt .mp4 upload -> probe job fails cleanly", async () => {
  const a = await upload(ctx.bad, "video/mp4");
  const jobs = await waitAssetJobs(a.id, ["media.probe", "media.proxy"]);
  const probe = jobs.find((j) => j.type === "media.probe");
  assert(probe.status === "failed", `probe ${probe.status}`);
  const del = await api("DELETE", `/api/media/${a.id}`);
  return { probe: probe.status, error: (probe.error ?? "").slice(0, 120), delete: del.status };
});

await step(
  "Whisper transcription without models (records behaviour)",
  async () => {
    const { jobId } = await ok("POST", "/api/subtitles/transcribe", {
      assetId: ctx.vAsset.id,
      language: "es",
    });
    const job = await waitJob(jobId, { timeoutMs: 120_000 });
    assert(job.status === "succeeded", `${job.status}: ${job.error}`);
    return job.result;
  },
  "expected-fail",
);

await step(
  "Piper TTS without voices (records behaviour)",
  async () => {
    const r = await api("POST", "/api/voice/tts", {
      text: "Hola mundo",
      voice: "es_AR-daniela-high",
    });
    assert(r.status === 202, `POST -> ${r.status} ${JSON.stringify(r.json)}`);
    const job = await waitJob(r.json.jobId, { timeoutMs: 120_000 });
    assert(job.status === "succeeded", `${job.status}: ${job.error}`);
    return job.result;
  },
  "expected-fail",
);

// ---------------------------------------------------------------- report
sse.controller.abort();
const required = results.filter((r) => r.kind === "required");
const failed = required.filter((r) => r.status === "FAIL");
const report = {
  api: API,
  work: WORK,
  startedAt: new Date(t0).toISOString(),
  totalMs: Date.now() - t0,
  node: process.version,
  platform: `${process.platform} ${os.release()} · ${os.cpus().length} CPU · ${(os.totalmem() / 2 ** 30).toFixed(1)} GB`,
  sseEvents: sse.events.length,
  sseError: sse.error ?? null,
  passed: required.length - failed.length,
  failed: failed.length,
  results,
};
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(report, null, 2));
console.log(`\n${"Paso".padEnd(78)} Estado  Tiempo`);
for (const r of results)
  console.log(
    `${r.name.slice(0, 77).padEnd(78)} ${(r.status + (r.kind !== "required" ? "*" : "")).padEnd(7)} ${fmt(r.ms)}`,
  );
console.log(
  `\n* = optional / expected-fail. Required: ${report.passed} PASS, ${report.failed} FAIL · total ${fmt(report.totalMs)}`,
);
console.log(`Report: ${OUT}`);
process.exit(failed.length ? 1 : 0);

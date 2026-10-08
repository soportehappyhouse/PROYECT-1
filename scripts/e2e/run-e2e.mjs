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
//   --download-models  also download a real model pack (core, ~0.26 GB from Hugging Face)
//   --only <regex>     run only the steps whose name matches (e.g. --only sprint2)
//   --hw               also export the 1-min project with the api's hardware encoder (HW_ENCODER=auto)
//                      in blocks and in one pass, and compare duration + frame count (NVENC
//                      -bf 0 -forced-idr 1); SKIP with the reason when there is no hw encoder
//
// Exit code 0 = every required step passed. Steps marked "expected-fail" (e.g. Whisper without
// models) only record the observed behaviour.

import { spawn } from "node:child_process";
import http from "node:http";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const API = opt("api", "http://127.0.0.1:3001").replace(/\/+$/, "");
/**
 * The exact Origin of the Studio web (HUMAN_ONLY routes: consents, licences, Person photos and voice
 * samples, «Voz propia»). This node client plays the web where a test needs it.
 */
const WEB_ORIGIN = { origin: opt("web-origin", "http://localhost:3000") };
const STORAGE = path.resolve(opt("storage", path.join(REPO, "storage")));
const WORK = path.resolve(opt("work", path.join(os.tmpdir(), `studio-e2e-${Date.now()}`)));
const OUT = path.resolve(opt("out", path.join(WORK, "report.json")));
const FFMPEG = opt("ffmpeg", "ffmpeg");
const FFPROBE = opt("ffprobe", "ffprobe");
const SKIP_MOTION = flag("skip-motion");
const DOWNLOAD_MODELS = flag("download-models");
const HW = flag("hw");
const JOB_TIMEOUT_MS = Number(opt("timeout", "900")) * 1000;
const ONLY = opt("only") ? new RegExp(opt("only"), "i") : undefined;

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
  if (ONLY && !ONLY.test(name)) return undefined;
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

/** Record a step that was not run, with the reason (only for real model downloads). */
function skip(name, reason) {
  if (ONLY && !ONLY.test(name)) return;
  results.push({ name, status: "SKIP", ms: 0, kind: "optional", detail: reason });
  console.log(`… ${name}\n  SKIP  ${reason}`);
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

async function ok(method, route, body, expect = [200, 201, 202, 204], opts = {}) {
  const r = await api(method, route, body, opts);
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

async function exportWith(presetId, expect, extra = {}) {
  const t = Date.now();
  const { jobId } = await ok("POST", `/api/projects/${ctx.project.id}/export`, {
    presetId,
    ...extra,
  });
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
  // Sprint 5: horizontal -> vertical needs an explicit aspectFit (blur = the old behavior).
  exportWith("reels-tiktok", { w: 1080, h: 1920, sec: 6, fps: 30 }, { aspectFit: "blur" }),
);

// Sprint 1 «render por bloques»: exporting the same project twice must take every block from
// storage/cache/segments (job result `segments: {total, cached, rendered}`).
await step("export twice with the segment cache: 2nd run all blocks cached", async () => {
  const runOnce = async () => {
    const { jobId } = await ok("POST", `/api/projects/${ctx.project.id}/export`, {
      presetId: "youtube-1080p",
      fileName: "bloques",
    });
    const t = Date.now();
    const job = await waitOk(jobId);
    return { job, ms: Date.now() - t, messages: sseFor(jobId).map((e) => e.message ?? "") };
  };
  const first = await runOnce();
  const second = await runOnce();
  const s1 = first.job.result?.segments;
  const s2 = second.job.result?.segments;
  assert(first.job.result?.mode === "segments", `1st mode ${first.job.result?.mode}`);
  assert(s1 && s1.total >= 1, `1st segments ${JSON.stringify(s1)}`);
  assert(
    s2 && s2.total === s1.total && s2.cached === s2.total && s2.rendered === 0,
    `2nd segments ${JSON.stringify(s2)}`,
  );
  assert(
    second.messages.some((m) => m.includes(`bloques (${s2.total} en caché)`)),
    `no "N/M bloques (K en caché)" progress: ${second.messages.join(" | ")}`,
  );
  const local = await download(second.job.result.path, "bloques-2.mp4");
  const f = await ffprobe(local);
  assert(near(+f.format.duration, 6, 0.15), `2nd duration ${f.format.duration}`);
  return { first: s1, second: s2, wall1: fmt(first.ms), wall2: fmt(second.ms) };
});

/** Video frames actually decoded (ffprobe -count_frames). */
async function frameCount(file) {
  const out = await run(FFPROBE, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-count_frames",
    "-show_entries",
    "stream=nb_read_frames",
    "-of",
    "csv=p=0",
    file,
  ]);
  return Number(out.trim());
}

/** Export a project and time it (wall clock from POST to the end of the job). */
async function timedExport(projectId, body) {
  const t = Date.now();
  const { jobId } = await ok("POST", `/api/projects/${projectId}/export`, body);
  const job = await waitOk(jobId);
  return { job, ms: Date.now() - t, jobId };
}

// Criterion 2 of docs/01-PLAN-BASE-v2.md, measured on a 1-min video (6 clips of 10 s = 6 blocks):
// analyze.silences seconds per minute of media, and (export with one small change) / (full export).
// Loose sandbox bounds: silences < 30 s/min, ratio < 0.5 (the plan targets < 0.2 on the real PC).
ctx.measurements = {};
await step(
  "sprint1: criterion 2 — silences s/min + re-export ratio (1 change / full)",
  async () => {
    const src = path.join(WORK, "e2e-1min.mp4");
    // tone with a 1 s silent gap every 10 s (at 4–5, 14–15, …)
    await run(FFMPEG, [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=1280x720:r=30:d=60",
      "-f",
      "lavfi",
      "-i",
      "aevalsrc='0.4*sin(2*PI*220*t)*(1-between(mod(t\\,10)\\,4\\,5))':s=48000:d=60",
      "-shortest",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      src,
    ]);
    const asset = await upload(src, "video/mp4");
    await waitAssetJobs(asset.id, ["media.probe", "media.proxy"]);
    const media = await ok("GET", `/api/media/${asset.id}`);
    const minutes = (media.durationSec ?? 60) / 60;

    // analyze.silences on the whole minute; the subtitles carry the words (no Whisper in the loop).
    const sp = await ok("POST", "/api/projects", { name: "E2E criterio 2 silencios" }, [201]);
    const SV = sp.tracks.find((t) => t.kind === "video");
    const longClip = id("c");
    SV.clips = [{ id: longClip, trackId: SV.id, assetId: asset.id, start: 0, in: 0, out: 60 }];
    sp.subtitles = Array.from({ length: 6 }, (_, i) => ({
      start: i * 10,
      end: i * 10 + 3,
      text: "hola eh listo",
      words: [
        { word: "hola", start: i * 10, end: i * 10 + 0.5 },
        { word: "eh", start: i * 10 + 1, end: i * 10 + 1.4 },
        { word: "listo", start: i * 10 + 2, end: i * 10 + 2.5 },
      ],
    }));
    await ok("PUT", `/api/projects/${sp.id}`, sp);
    const ts = Date.now();
    const r = await ok(
      "POST",
      "/api/ai/analyze/silences",
      { projectId: sp.id, clipId: longClip, options: { fillers: true } },
      [202],
    );
    const found = (await waitOk(r.jobId)).result;
    const silencesSec = (Date.now() - ts) / 1000;
    const silencesPerMin = silencesSec / minutes;
    assert(found.cuts.filter((c) => c.kind === "silence").length >= 5, JSON.stringify(found.cuts));
    assert(
      found.cuts.some((c) => c.kind === "filler"),
      "no filler cut from the subtitles",
    );

    // export: 6 blocks rendered, then one clip changed -> only its block re-rendered
    const ep = await ok("POST", "/api/projects", { name: "E2E criterio 2 export" }, [201]);
    const EV = ep.tracks.find((t) => t.kind === "video");
    EV.clips = Array.from({ length: 6 }, (_, i) => ({
      id: id("c"),
      trackId: EV.id,
      assetId: asset.id,
      start: i * 10,
      in: i * 10,
      out: (i + 1) * 10,
    }));
    await ok("PUT", `/api/projects/${ep.id}`, ep);
    const body = { presetId: "youtube-1080p", fileName: "criterio2" };
    const full = await timedExport(ep.id, body);
    const s1 = full.job.result?.segments;
    assert(full.job.result?.mode === "segments", `mode ${full.job.result?.mode}`);
    assert(s1 && s1.total >= 6 && s1.rendered === s1.total, `1st segments ${JSON.stringify(s1)}`);
    EV.clips[3] = { ...EV.clips[3], opacity: 0.8 }; // one small change inside one block
    await ok("PUT", `/api/projects/${ep.id}`, ep);
    const change = await timedExport(ep.id, body);
    const s2 = change.job.result?.segments;
    assert(
      s2 && s2.total === s1.total && s2.rendered === 1 && s2.cached === s1.total - 1,
      `2nd segments ${JSON.stringify(s2)}`,
    );
    const local = await download(change.job.result.path, "criterio2-cambio.mp4");
    const f = await ffprobe(local);
    assert(near(+f.format.duration, 60, 0.15), `duration ${f.format.duration}`);
    const ratio = change.ms / full.ms;
    ctx.measure = {
      projectId: ep.id,
      body,
      frames: await frameCount(local),
      duration: +f.format.duration,
    };
    ctx.measurements = {
      silencesSecPerMin: +silencesPerMin.toFixed(2),
      exportFullSec: +(full.ms / 1000).toFixed(2),
      exportOneChangeSec: +(change.ms / 1000).toFixed(2),
      reexportRatio: +ratio.toFixed(3),
      blocks: s1.total,
    };
    console.log(
      `  Mediciones: silencios ${silencesPerMin.toFixed(2)} s/min · export completo ${fmt(full.ms)} · con 1 cambio ${fmt(change.ms)} · ratio ${ratio.toFixed(3)} (${s2.rendered}/${s2.total} bloques)`,
    );
    assert(silencesPerMin < 30, `analyze.silences ${silencesPerMin.toFixed(2)} s/min (>= 30)`);
    assert(ratio < 0.5, `re-export ratio ${ratio.toFixed(3)} (>= 0.5)`);
    return ctx.measurements;
  },
);

// Risk 3 (NVENC blocks): with a hardware encoder, the block export (concat -c copy) must match a
// one-pass export (useSegmentCache:false) in duration and frame count.
{
  const name = "export --hw: hardware-encoder blocks vs one pass (duration + frames)";
  const enc = HW ? await api("GET", "/api/system/encoders") : undefined;
  const hw =
    enc?.json?.preferred && enc.json.preferred !== "libx264" ? enc.json.preferred : undefined;
  if (!HW) skip(name, "usar --hw (exporta con el encoder por hardware de la api, HW_ENCODER=auto)");
  else if (!hw)
    skip(
      name,
      `sin encoder por hardware (disponibles: ${(enc?.json?.available ?? []).join(", ") || "?"}; ¿HW_ENCODER=off?)`,
    );
  else if (!ctx.measure) skip(name, "falta el proyecto de 1 min del paso de criterio 2");
  else
    await step(
      name,
      async () => {
        const out = {};
        for (const [key, useSegmentCache] of [
          ["blocks", true],
          ["blocks2", true],
          ["onePass", false],
        ]) {
          const r = await timedExport(ctx.measure.projectId, {
            ...ctx.measure.body,
            fileName: `hw-${key}`,
            useSegmentCache,
          });
          const log = await api("GET", `/api/jobs/${r.jobId}/log`);
          const encoderLine = (log.json?.lines ?? []).find((l) => String(l).includes("Encoder:"));
          const file = await download(r.job.result.path, `hw-${key}.mp4`);
          const f = await ffprobe(file);
          out[key] = {
            mode: r.job.result?.mode,
            duration: +(+f.format.duration).toFixed(3),
            frames: await frameCount(file),
            encoder: encoderLine ? String(encoderLine).replace(/.*Encoder:\s*/, "") : undefined,
            wall: fmt(r.ms),
          };
        }
        const { blocks, blocks2, onePass } = out;
        assert(blocks.mode === "segments" && onePass.mode !== "segments", JSON.stringify(out));
        for (const b of [blocks, blocks2]) {
          assert(b.frames === onePass.frames, `frames ${b.frames} vs one pass ${onePass.frames}`);
          assert(
            near(b.duration, onePass.duration, 0.05),
            `duration ${b.duration} vs ${onePass.duration}`,
          );
        }
        return { hw, ...out };
      },
      "optional",
    );
}

/** Pixels of a frame region brighter than `min` (gray, scaled to `w` px wide). */
async function brightPixels(file, at, { w = 320, min = 170, region, cols } = {}) {
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
  const [x0, x1] = cols ? [Math.round(cols[0] * w), Math.round(cols[1] * w)] : [0, w];
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (raw[y * w + x] > min) n++;
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
      // Sprint 5: horizontal -> vertical needs an explicit aspectFit (blur = the old behavior).
      const r = await ok("POST", `/api/projects/${p.id}/export`, {
        presetId,
        ...(h > w && { aspectFit: "blur" }),
      });
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

// ---------------------------------------------------------------- Sprint 1 (IA local)
// docs/trabajo/sprint1-contratos.md: GPU + packs endpoints, packs.download, PACK_REQUIRED,
// analyze.scenes, analyze.silences + timeline.apply-cuts (ripple, linked overlays, undo) and the
// «Revisión para redes» AI label burned on export.
const SPRINT1_PACKS = ["core", "whisper-turbo", "voces-es", "rvc-base", "scenes", "voz-limpia"];

await step("sprint1: GPU status + release, packs list, unknown pack -> 404", async () => {
  const gpu = await ok("GET", "/api/ai/gpu");
  assert(typeof gpu.cuda === "boolean" && ["gpu", "cpu"].includes(gpu.mode), JSON.stringify(gpu));
  const released = await ok("POST", "/api/ai/gpu/release");
  assert(released.resident_model == null, `resident after release: ${released.resident_model}`);
  const packs = await ok("GET", "/api/ai/packs");
  const ids = packs.map((p) => p.id);
  for (const want of SPRINT1_PACKS) assert(ids.includes(want), `pack ${want} missing: ${ids}`);
  for (const p of packs)
    assert(
      p.size_bytes > 0 && Array.isArray(p.files) && typeof p.installed === "boolean" && p.name_es,
      `pack ${p.id}: ${JSON.stringify(p).slice(0, 200)}`,
    );
  const unknown = await api("POST", "/api/ai/packs/no-existe/download");
  assert(unknown.status === 404, `unknown pack -> ${unknown.status}`);
  ctx.packs = Object.fromEntries(packs.map((p) => [p.id, p]));
  return {
    mode: gpu.mode,
    cuda: gpu.cuda,
    installed: packs.filter((p) => p.installed).map((p) => p.id),
  };
});

await step("sprint1: perf.run (workers /perf/tasks) -> GET /api/ai/perf (perf.json)", async () => {
  const { jobId } = await ok("POST", "/api/ai/perf/run", {}, [202]);
  const job = await waitOk(jobId, { timeoutMs: 1_800_000 });
  const last = await ok("GET", "/api/ai/perf");
  assert(last.ran_at === job.result.ran_at, "GET /api/ai/perf ≠ job result");
  assert(
    typeof last.gpu === "string" && typeof last.cpu_fallback_ok === "boolean",
    `perf.json gpu/cpu_fallback_ok: ${JSON.stringify(last).slice(0, 300)}`,
  );
  assert(
    last.gpu_status && typeof last.skipped === "object",
    "perf.json without gpu_status/skipped",
  );
  return { gpu: last.gpu, scenes_fps: last.scenes_fps, skipped: Object.keys(last.skipped) };
});

await step("sprint1: pack «scenes» through the packs.download job (pip only, SSE)", async () => {
  const { jobId } = await ok("POST", "/api/ai/packs/scenes/download", {}, [202]);
  const job = await waitOk(jobId, { timeoutMs: 600_000 });
  assert(job.result?.installed === true, `result ${JSON.stringify(job.result)}`);
  const scenes = (await ok("GET", "/api/ai/packs")).find((p) => p.id === "scenes");
  assert(scenes.installed, "scenes not installed after the download job");
  await sleep(300);
  return { wasInstalled: ctx.packs?.scenes?.installed ?? null, sseEvents: sseFor(jobId).length };
});

if (DOWNLOAD_MODELS)
  await step(
    "sprint1: model pack «core» download (Hugging Face)",
    async () => {
      const { jobId } = await ok("POST", "/api/ai/packs/core/download", {}, [202]);
      const job = await waitOk(jobId, { timeoutMs: 3_600_000 });
      return job.result;
    },
    "optional",
  );
else
  skip(
    "sprint1: model pack download (core / whisper-turbo from Hugging Face)",
    "real model download (0.26–1.6 GB); run with --download-models",
  );

await step("sprint1: audio.denoise -> 409 PACK_REQUIRED (flat body) or a new asset", async () => {
  const r = await api("POST", "/api/ai/audio/denoise", { assetId: ctx.vAsset.id });
  if (!ctx.packs?.["voz-limpia"]?.installed) {
    assert(r.status === 409, `denoise without pack -> ${r.status} ${JSON.stringify(r.json)}`);
    const b = r.json;
    assert(
      b.error === "PACK_REQUIRED" &&
        b.packId === "voz-limpia" &&
        typeof b.name_es === "string" &&
        b.size_bytes > 0,
      `409 body not flat PackRequiredBody: ${JSON.stringify(b)}`,
    );
    return { status: 409, body: { packId: b.packId, name_es: b.name_es, size: b.size_bytes } };
  }
  assert(r.status === 202, `denoise -> ${r.status} ${JSON.stringify(r.json)}`);
  const job = await waitOk(r.json.jobId);
  const asset = await ok("GET", `/api/media/${job.result.assetId}`);
  assert(asset.kind === "audio", `denoised asset kind ${asset.kind}`);
  const f = await ffprobe(await download(job.result.path, "denoised.wav"));
  assert(near(+f.format.duration, 10, 0.3), `denoised duration ${f.format.duration}`);
  return { asset: asset.id, sec: +(+f.format.duration).toFixed(2), warnings: job.result.warnings };
});

await step("sprint1: analyze.scenes on a 4-shot lavfi video (3 hard cuts)", async () => {
  const file = path.join(WORK, "e2e-escenas.mp4");
  const shots = [
    "testsrc2=s=640x360:r=25:d=2",
    "smptebars=s=640x360:r=25:d=2",
    "mandelbrot=s=640x360:r=25,trim=duration=2,setpts=PTS-STARTPTS",
    "color=c=0xd06020:s=640x360:r=25:d=2",
  ];
  await run(FFMPEG, [
    "-y",
    "-v",
    "error",
    ...shots.flatMap((src) => ["-f", "lavfi", "-i", src]),
    "-filter_complex",
    `${shots.map((_, i) => `[${i}:v]`).join("")}concat=n=${shots.length}:v=1:a=0,format=yuv420p[v]`,
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    file,
  ]);
  const asset = await upload(file, "video/mp4");
  await waitAssetJobs(asset.id, ["media.probe"]);
  const { jobId } = await ok("POST", "/api/ai/analyze/scenes", { assetId: asset.id }, [202]);
  const job = await waitOk(jobId);
  const scenes = job.result.scenes;
  assert(scenes.length === 4, `scenes ${JSON.stringify(scenes)}`);
  const cuts = scenes.slice(1).map((sc) => sc.start);
  for (const [i, want] of [2, 4, 6].entries())
    assert(near(cuts[i], want, 0.1), `cut ${i + 1} at ${cuts[i]} (want ${want})`);
  const stored = await ok("GET", `/api/media/${asset.id}`);
  assert(stored.scenes?.length === 4, "scenes not stored on the asset");
  return { cuts, sseEvents: sseFor(jobId).length };
});

await step(
  "sprint1: analyze.silences (2 gaps + fillers) -> apply-cuts ripple, captions unrendered, undo",
  async () => {
    // 8 s tone with silent gaps at 2–3 s and 5–6.2 s; the subtitles carry "eh" and "mmm".
    const wav = path.join(WORK, "e2e-silencios.wav");
    await run(FFMPEG, [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "aevalsrc='0.5*sin(2*PI*220*t)*(lt(t\\,2)+between(t\\,3\\,5)+gte(t\\,6.2))':s=48000:d=8",
      wav,
    ]);
    const audio = await upload(wav, "audio/wav");
    await waitAssetJobs(audio.id, ["media.probe"]);
    const p = await ok("POST", "/api/projects", { name: "E2E silencios" }, [201]);
    const A = p.tracks.find((t) => t.kind === "audio");
    const clipId = id("cs");
    const afterId = id("ca");
    A.clips = [
      { id: clipId, trackId: A.id, assetId: audio.id, start: 0, in: 0, out: 8 },
      { id: afterId, trackId: A.id, assetId: ctx.sAsset.id, start: 9, in: 0, out: 1 },
    ];
    const words = [
      ["hola", 0.1, 0.5],
      ["eh", 0.8, 1.1],
      ["mundo", 1.4, 1.9],
      ["y", 3.1, 3.4],
      ["mmm", 3.65, 3.95],
      ["listo", 4.3, 4.9],
    ].map(([word, start, end]) => ({ word, start, end }));
    p.subtitles = [
      { start: 0.1, end: 1.9, text: "hola eh mundo", words: words.slice(0, 3) },
      { start: 3.1, end: 4.9, text: "y mmm listo", words: words.slice(3) },
    ];
    const M = { id: id("t"), kind: "motion", name: "Motion", clips: [] };
    const capsId = id("mc");
    const titleId = id("mt");
    M.clips = [
      {
        id: capsId,
        trackId: M.id,
        start: 0,
        in: 0,
        out: 8,
        renderedAssetId: ctx.iAsset.id,
        motion: {
          template: "animated-captions",
          durationSec: 8,
          format: "webm-vp9-alpha",
          props: {
            transcript: {
              language: "es",
              durationSec: 8,
              segments: p.subtitles,
            },
          },
        },
      },
      {
        id: titleId,
        trackId: M.id,
        start: 8.5,
        in: 0,
        out: 1,
        renderedAssetId: ctx.iAsset.id,
        motion: { template: "title-card", durationSec: 1, format: "webm-vp9-alpha", props: {} },
      },
    ];
    p.tracks = [...p.tracks, M];
    const before = await ok("PUT", `/api/projects/${p.id}`, p);

    const r1 = await ok(
      "POST",
      "/api/ai/analyze/silences",
      { projectId: p.id, clipId, options: { fillers: true } },
      [202],
    );
    const found = (await waitOk(r1.jobId)).result;
    const silences = found.cuts.filter((c) => c.kind === "silence");
    const fillers = found.cuts.filter((c) => c.kind === "filler");
    for (const [a, b] of [
      [2, 3],
      [5, 6.2],
    ])
      assert(
        silences.some((c) => c.start >= a - 0.05 && c.end <= b + 0.05 && c.end - c.start > 0.5),
        `no silence cut inside ${a}–${b}: ${JSON.stringify(found.cuts)}`,
      );
    assert(fillers.length >= 2, `fillers ${JSON.stringify(fillers)}`);
    assert(found.timeBase === "source" && found.total_removed_s > 1.5, JSON.stringify(found));

    const r2 = await ok(
      "POST",
      "/api/ai/timeline/apply-cuts",
      { projectId: p.id, clipId, cuts: found.cuts.map(({ start, end }) => ({ start, end })) },
      [202],
    );
    const edit = (await waitOk(r2.jobId)).result;
    assert(near(edit.removedSec, found.total_removed_s, 0.05), `removed ${edit.removedSec}`);
    const saved = await ok("GET", `/api/projects/${p.id}`);
    assert(canon(saved.tracks) === canon(edit.project.tracks), "job result ≠ saved project");
    const audioTrack = saved.tracks.find((t) => t.id === A.id);
    const pieces = audioTrack.clips.filter((c) => c.assetId === audio.id);
    assert(pieces.length === edit.pieceIds.length && pieces.length >= 3, `pieces ${pieces.length}`);
    let at = 0;
    for (const c of pieces) {
      assert(near(c.start, at, 0.002), `piece ${c.id} at ${c.start}, expected ${at} (no gaps)`);
      at = c.start + (c.out - c.in);
    }
    assert(near(at, 8 - edit.removedSec, 0.01), `pieces end ${at}`);
    const after = audioTrack.clips.find((c) => c.id === afterId);
    assert(near(after.start, 9 - edit.removedSec, 0.002), `ripple: next clip at ${after.start}`);
    const motion = saved.tracks.find((t) => t.id === M.id).clips;
    const caps = motion.find((c) => c.id === capsId);
    const title = motion.find((c) => c.id === titleId);
    assert(caps && !caps.renderedAssetId, "animated captions kept their render («Sin renderizar»)");
    assert(near(caps.out - caps.in, 8 - edit.removedSec, 0.05), `captions span ${caps.out}`);
    assert(
      title.renderedAssetId === ctx.iAsset.id && near(title.start, 8.5 - edit.removedSec, 0.002),
      `title after the cut: ${JSON.stringify(title)}`,
    );
    const spoken = saved.subtitles.flatMap((s) => (s.words ?? []).map((w) => w.word));
    assert(!spoken.includes("eh") && !spoken.includes("mmm"), `fillers kept: ${spoken}`);
    assert(spoken.includes("hola") && spoken.includes("listo"), `words lost: ${spoken}`);

    // The web undoes «Aplicar» as one step and saves its previous copy (PUT): the api must take it
    // back whole, render link included.
    await ok("PUT", `/api/projects/${p.id}`, before);
    const undone = await ok("GET", `/api/projects/${p.id}`);
    assert(canon(undone.tracks) === canon(before.tracks), "undo (PUT previous) not restored");
    return {
      cuts: found.cuts.map((c) => `${c.kind}:${c.start.toFixed(2)}-${c.end.toFixed(2)}`),
      removedSec: edit.removedSec,
      pieces: pieces.length,
    };
  },
);

await step("sprint1: export with project.publish.aiLabel -> label bottom-left", async () => {
  const src = path.join(WORK, "e2e-gris.mp4");
  await run(FFMPEG, [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x303030:s=1280x720:r=30:d=4",
    "-f",
    "lavfi",
    "-i",
    "sine=f=330:sample_rate=48000:d=4",
    "-shortest",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    src,
  ]);
  const asset = await upload(src, "video/mp4");
  await waitAssetJobs(asset.id, ["media.probe"]);
  const p = await ok("POST", "/api/projects", { name: "E2E etiqueta IA" }, [201]);
  const V = p.tracks.find((t) => t.kind === "video");
  V.clips = [{ id: id("c"), trackId: V.id, assetId: asset.id, start: 0, in: 0, out: 4 }];
  const flags = { aiFace: false, aiVoice: true, aiOther: false, music: false, thirdParty: false };
  const out = {};
  for (const aiLabel of [true, false]) {
    await ok("PUT", `/api/projects/${p.id}`, {
      ...p,
      publish: { forSocial: true, flags, aiLabel },
    });
    const { jobId } = await ok("POST", `/api/projects/${p.id}/export`, {
      presetId: "youtube-1080p",
      fileName: `etiqueta-${aiLabel}`,
    });
    const job = await waitOk(jobId);
    const file = await download(job.result.path, `etiqueta-${aiLabel}.mp4`);
    // the label is ~25 px tall at 1080p: sample at 960 px wide so the glyphs survive the scale
    const bottomLeft = await brightPixels(file, 2, {
      w: 960,
      min: 150,
      region: [0.85, 1],
      cols: [0, 0.5],
    });
    const elsewhere = await brightPixels(file, 2, {
      w: 960,
      min: 150,
      region: [0, 0.85],
      cols: [0, 1],
    });
    const bottomRight = await brightPixels(file, 2, {
      w: 960,
      min: 150,
      region: [0.85, 1],
      cols: [0.5, 1],
    });
    out[aiLabel ? "on" : "off"] = { bottomLeft, bottomRight, elsewhere, mode: job.result.mode };
  }
  assert(out.on.bottomLeft > 80, `label missing bottom-left: ${JSON.stringify(out.on)}`);
  assert(
    out.on.elsewhere === 0 && out.on.bottomRight === 0,
    `label elsewhere: ${JSON.stringify(out.on)}`,
  );
  assert(out.off.bottomLeft === 0, `label without aiLabel: ${JSON.stringify(out.off)}`);
  return out;
});

// ---------------------------------------------------------------- Sprint 2 (keyframes / track / reframe)
/** Bounding box (center) of the pixels brighter than `min` of the frame at `at`, scaled to `w` wide. */
async function brightBox(file, at, { w = 480, min = 170 } = {}) {
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
  let [x0, y0, x1, y1] = [w, h, -1, -1];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (raw[y * w + x] > min) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
  return x1 < 0
    ? undefined
    : {
        cx: (x0 + x1) / 2,
        cy: (y0 + y1) / 2,
        w: x1 - x0 + 1,
        h: y1 - y0 + 1,
        frameW: w,
        frameH: h,
      };
}

// A dim box (0x404040, 120×80) moving right on black: x = 80 + 200 t, y = 300 (1280×720, 30 fps, 4 s).
const S2 = {
  W: 1280,
  H: 720,
  fps: 30,
  dur: 4,
  box: (t) => ({ x: 80 + 200 * t, y: 300, w: 120, h: 80 }),
};
async function sprint2Media() {
  if (ctx.s2) return ctx.s2;
  const src = path.join(WORK, "e2e-caja-movil.mp4");
  await run(FFMPEG, [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=${S2.W}x${S2.H}:r=${S2.fps}:d=${S2.dur}[b];color=c=0x404040:s=120x80:r=${S2.fps}:d=${S2.dur}[w];[b][w]overlay=x='80+200*t':y=300`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    src,
  ]);
  const video = await upload(src, "video/mp4");
  await waitAssetJobs(video.id, ["media.probe"]);
  const track = {
    version: 1,
    fps: S2.fps,
    smoothed: true,
    source: { assetId: video.id, method: "csrt" },
    frames: Array.from({ length: S2.dur * S2.fps + 1 }, (_, i) => {
      const b = S2.box(i / S2.fps);
      return { t: i / S2.fps, x: b.x / S2.W, y: b.y / S2.H, w: b.w / S2.W, h: b.h / S2.H, conf: 1 };
    }),
  };
  const trackFile = path.join(WORK, "e2e-seguimiento.json");
  await writeFile(trackFile, JSON.stringify(track));
  const trackAsset = await upload(trackFile, "application/json");
  assert(trackAsset.kind === "track", `track.json imported as ${trackAsset.kind}`);
  ctx.s2 = { video, trackAsset };
  return ctx.s2;
}

await step(
  "sprint2: text follows a track (trackRef) -> export pixel check at 3 timestamps",
  async () => {
    const { video, trackAsset } = await sprint2Media();
    const p = await ok("POST", "/api/projects", { name: "E2E seguimiento" }, [201]);
    const V = p.tracks.find((t) => t.kind === "video");
    const T = p.tracks.find((t) => t.kind === "text");
    assert(T, "project without a text track");
    V.clips = [{ id: id("c"), trackId: V.id, assetId: video.id, start: 0, in: 0, out: S2.dur }];
    T.clips = [
      {
        id: id("t"),
        trackId: T.id,
        start: 0,
        in: 0,
        out: S2.dur,
        text: "II",
        textStyle: { fontSize: 72, color: "#ffffff", position: "bottom" },
        trackRef: { assetId: trackAsset.id, anchor: "center", offset: { x: 0, y: 0 } },
      },
    ];
    await ok("PUT", `/api/projects/${p.id}`, p);
    const { jobId } = await ok("POST", `/api/projects/${p.id}/export`, {
      presetId: "youtube-1080p",
      fileName: "seguimiento",
    });
    const job = await waitOk(jobId);
    const file = await download(job.result.path, "seguimiento.mp4");
    // 1280×720 source fitted to the 1920×1080 canvas (×1.5), sampled at 960 px wide (×0.5).
    const k = (1920 / S2.W) * 0.5;
    const checks = [];
    for (const t of [0.5, 1.5, 3]) {
      const b = await brightBox(file, t, { w: 960, min: 200 });
      const exp = S2.box(t);
      const ex = (exp.x + exp.w / 2) * k;
      const ey = (exp.y + exp.h / 2) * k;
      assert(b, `no text at t=${t}`);
      assert(
        near(b.cx, ex, 10) && near(b.cy, ey, 10),
        `t=${t}: text at ${b.cx},${b.cy}, box at ${ex},${ey}`,
      );
      checks.push({ t, text: [b.cx, b.cy], box: [ex, ey] });
    }
    return { mode: job.result.mode, checks };
  },
);

await step(
  "sprint2: reframe 9:16 export follows project.reframe keyframes (no blurred background)",
  async () => {
    const { video } = await sprint2Media();
    const p = await ok("POST", "/api/projects", { name: "E2E reencuadre" }, [201]);
    const V = p.tracks.find((t) => t.kind === "video");
    V.clips = [{ id: id("c"), trackId: V.id, assetId: video.id, start: 0, in: 0, out: S2.dur }];
    // crop 608×1080 of the 1920×1080 canvas centered on the box center (×1.5 on the canvas)
    const cw = 608 / 1920;
    const rect = (t) => {
      const b = S2.box(t);
      return { x: ((b.x + b.w / 2) * 1.5) / 1920 - cw / 2, y: 0, w: cw, h: 1 };
    };
    p.reframe = {
      target: "9:16",
      mode: "manual",
      keyframes: [
        { t: 0, v: rect(0), ease: "linear" },
        { t: S2.dur, v: rect(S2.dur), ease: "linear" },
      ],
    };
    await ok("PUT", `/api/projects/${p.id}`, p);
    const { jobId } = await ok("POST", `/api/projects/${p.id}/export`, {
      presetId: "reels-tiktok",
      fileName: "reencuadre",
    });
    const job = await waitOk(jobId);
    const file = await download(job.result.path, "reencuadre.mp4");
    const v = (await ffprobe(file)).streams.find((s) => s.codec_type === "video");
    assert(v.width === 1080 && v.height === 1920, `size ${v.width}x${v.height}`);
    const checks = [];
    for (const t of [1, 2, 3]) {
      const b = await brightBox(file, t, { w: 270, min: 40 });
      assert(b, `no box at t=${t}`);
      // box 120×80 ×1.5 ×(1080/608) ×0.25 ≈ 80 px wide, centered horizontally
      assert(near(b.cx, 135, 6), `t=${t}: box center ${b.cx} (expected 135)`);
      assert(near(b.w, 80, 8), `t=${t}: box width ${b.w}`);
      checks.push({ t, cx: b.cx, w: b.w });
    }
    return { mode: job.result.mode, checks };
  },
);

// ---- Sprint 2 integration: real OpenCV tracker, track -> keyframes, keyframe parity, SAM 2
// (mocked predictor, scripts/e2e/workers-with-mocks.py) -> matte export, RVM mock matte, reframe.

/** RGB frame at `at` scaled to `w` px wide: {w, h, px(x, y) -> [r, g, b]}. */
async function frameRgb(file, at, w = 960) {
  const v = (await ffprobe(file)).streams.find((s) => s.codec_type === "video");
  const h = Math.round((v.height * w) / v.width / 2) * 2;
  const raw = await new Promise((resolve, reject) => {
    const p = spawn(
      FFMPEG,
      ["-v", "error", "-ss", String(at), "-i", file, "-frames:v", "1", "-vf", `scale=${w}:${h}`,
        "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], // prettier-ignore
      { windowsHide: true },
    );
    const chunks = [];
    p.stdout.on("data", (d) => chunks.push(d));
    p.on("error", reject);
    p.on("close", () => resolve(Buffer.concat(chunks)));
  });
  assert(raw.length >= w * h * 3, `frame at ${at}: ${raw.length} bytes`);
  const px = (x, y) => {
    const i = (Math.round(y) * w + Math.round(x)) * 3;
    return [raw[i], raw[i + 1], raw[i + 2]];
  };
  return { w, h, px };
}

/** @studio/shared (built): the SAME interpolate() the export and the preview use. */
async function sharedLib() {
  const dist = path.join(REPO, "packages", "shared", "dist", "index.js");
  assert(existsSync(dist), "packages/shared/dist missing (pnpm build:packages)");
  return import(pathToFileURL(dist).href);
}

// A TEXTURED box (testsrc2, dimmed below the text-check threshold) moving right on black:
// trackable by a real OpenCV tracker (a flat box has no texture for CSRT / template matching).
async function sprint2TexturedMedia() {
  if (ctx.s2tex) return ctx.s2tex;
  const src = path.join(WORK, "e2e-caja-textura.mp4");
  await run(FFMPEG, [
    "-y", "-v", "error", "-f", "lavfi", "-i",
    `color=c=black:s=${S2.W}x${S2.H}:r=${S2.fps}:d=${S2.dur}[b];testsrc2=s=120x80:r=${S2.fps}:d=${S2.dur},lutyuv=y=val*0.6[w];[b][w]overlay=x='80+200*t':y=300`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", src,
  ]); // prettier-ignore
  const video = await upload(src, "video/mp4");
  await waitAssetJobs(video.id, ["media.probe"]);
  ctx.s2tex = { video };
  return ctx.s2tex;
}

/** Project: the video clip on V1 (0..dur) + one text clip on T1. */
async function sprint2Project(name, video, text) {
  const p = await ok("POST", "/api/projects", { name }, [201]);
  const V = p.tracks.find((t) => t.kind === "video");
  const T = p.tracks.find((t) => t.kind === "text");
  V.clips = [{ id: id("c"), trackId: V.id, assetId: video.id, start: 0, in: 0, out: S2.dur }];
  T.clips = text
    ? [
        {
          id: id("t"),
          trackId: T.id,
          start: 0,
          in: 0,
          out: S2.dur,
          text: "II",
          textStyle: { fontSize: 72, color: "#ffffff", position: "bottom" },
          ...text,
        },
      ]
    : [];
  return ok("PUT", `/api/projects/${p.id}`, p);
}

/** Export youtube-1080p and check the text center (960-px frame) at each [t, x, y]. */
async function exportTextAt(projectId, name, expected, tol = 10) {
  const { jobId } = await ok("POST", `/api/projects/${projectId}/export`, {
    presetId: "youtube-1080p",
    fileName: name,
  });
  const job = await waitOk(jobId);
  const file = await download(job.result.path, `${name}.mp4`);
  const checks = [];
  for (const [t, ex, ey] of expected) {
    const b = await brightBox(file, t, { w: 960, min: 200 });
    assert(b, `${name}: no text at t=${t}`);
    assert(
      near(b.cx, ex, tol) && near(b.cy, ey, tol),
      `${name} t=${t}: text at ${b.cx},${b.cy}, expected ${ex.toFixed(1)},${ey.toFixed(1)}`,
    );
    checks.push({ t, text: [b.cx, b.cy], expected: [+ex.toFixed(1), +ey.toFixed(1)] });
  }
  return { file, checks };
}

await step(
  "sprint2: vision.track real OpenCV tracker -> trackRef on a text clip -> export pixel check",
  async () => {
    const { video } = await sprint2TexturedMedia();
    const p = await sprint2Project("E2E seguimiento real", video);
    const T = p.tracks.find((t) => t.kind === "text");
    T.clips = [
      {
        id: id("t"),
        trackId: T.id,
        start: 0,
        in: 0,
        out: S2.dur,
        text: "II",
        textStyle: { fontSize: 72, color: "#ffffff", position: "bottom" },
      },
    ];
    await ok("PUT", `/api/projects/${p.id}`, p);
    const b0 = S2.box(0);
    const res = await ok("POST", "/api/ai/vision/track", {
      assetId: video.id,
      method: "csrt",
      bbox: { x: b0.x / S2.W, y: b0.y / S2.H, w: b0.w / S2.W, h: b0.h / S2.H },
      target: { projectId: p.id, clipId: T.clips[0].id, anchor: "center", offset: { x: 0, y: 0 } },
    });
    const job = await waitOk(res.jobId, { timeoutMs: 300_000 });
    const r = job.result;
    assert(["csrt", "template"].includes(r.method), `method ${r.method}`);
    assert(r.linkedClip?.clipId === T.clips[0].id, "trackRef not set on the text clip");
    // the TrackFile: top-left boxes in source fractions, close to the real box
    const tf = JSON.parse(await readFile(await download(r.path, "seguimiento-real.json"), "utf8"));
    assert(tf.source.assetId === video.id, `source ${JSON.stringify(tf.source)}`);
    let worst = 0;
    for (const f of tf.frames) {
      const b = S2.box(f.t);
      worst = Math.max(worst, Math.abs(f.x * S2.W - b.x), Math.abs(f.y * S2.H - b.y));
    }
    assert(worst <= 6, `tracked box drifts ${worst.toFixed(1)} px from the real one`);
    ctx.s2track = { project: p.id, clipId: T.clips[0].id, trackAssetId: r.assetId };
    const saved = await ok("GET", `/api/projects/${p.id}`);
    assert(
      saved.tracks.flatMap((t) => t.clips).find((c) => c.id === T.clips[0].id)?.trackRef,
      "saved project without trackRef",
    );
    // 1280×720 source fitted to 1920×1080 (×1.5), sampled at 960 px (×0.5)
    const k = (1920 / S2.W) * 0.5;
    const exp = [0.5, 2, 3.5].map((t) => {
      const b = S2.box(t);
      return [t, (b.x + b.w / 2) * k, (b.y + b.h / 2) * k];
    });
    const { checks } = await exportTextAt(p.id, "seguimiento-real", exp, 10);
    return { method: r.method, frames: r.frames, driftPx: +worst.toFixed(2), checks };
  },
);

await step(
  "sprint2: track -> keyframes (timeline.track-to-keyframes, ≤ 2/s) -> same export",
  async () => {
    assert(ctx.s2track, "needs the real tracking step");
    const { project, clipId } = ctx.s2track;
    const res = await ok("POST", "/api/ai/timeline/track-to-keyframes", {
      projectId: project,
      clipId,
    });
    const job = await waitOk(res.jobId);
    const clip = job.result.project.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
    assert(clip && !clip.trackRef, "trackRef still set");
    const kfs = clip.keyframes?.position ?? [];
    assert(kfs.length >= 2 && kfs.length <= 2 * S2.dur + 1, `${kfs.length} keyframes`);
    const { interpolate } = await sharedLib();
    let worst = 0;
    for (const t of [0.5, 1.5, 2.5, 3.5]) {
      const v = interpolate(kfs, t);
      const b = S2.box(t);
      worst = Math.max(
        worst,
        Math.abs(v.x * 1920 - (b.x + b.w / 2) * 1.5),
        Math.abs(v.y * 1080 - (b.y + b.h / 2) * 1.5),
      );
    }
    assert(worst <= 12, `keyframes ${worst.toFixed(1)} canvas px from the box center`);
    const exp = [1, 3].map((t) => {
      const v = interpolate(kfs, t);
      return [t, v.x * 960, v.y * 540];
    });
    const { checks } = await exportTextAt(project, "seguimiento-keyframes", exp, 8);
    return { keyframes: kfs.length, maxErrCanvasPx: +worst.toFixed(1), checks };
  },
);

await step(
  "sprint2: keyframes easeInOut/easeOut export = shared interpolate() (pixel parity)",
  async () => {
    const { video } = await sprint2Media();
    const position = [
      { t: 0, v: { x: 0.15, y: 0.3 }, ease: "easeInOut" },
      { t: 2, v: { x: 0.85, y: 0.3 }, ease: "easeOut" },
      { t: 4, v: { x: 0.5, y: 0.75 }, ease: "linear" },
    ];
    const p = await sprint2Project("E2E keyframes", video, { keyframes: { position } });
    const { interpolate } = await sharedLib();
    const exp = [0.5, 1, 1.5, 2.6, 3.4].map((t) => {
      const v = interpolate(position, t);
      return [t, v.x * 960, v.y * 540];
    });
    const { checks } = await exportTextAt(p.id, "keyframes-paridad", exp, 8);
    return { checks };
  },
);

await step(
  "sprint2: SAM 2 session (mock predictor) -> points -> propagate -> matte (color) export",
  async () => {
    const { video } = await sprint2Media();
    const s = await api("POST", "/api/ai/vision/sam/session", { assetId: video.id });
    assert(s.status === 201, `session -> ${s.status} ${JSON.stringify(s.json)}`);
    const { sessionId, frames, fps } = s.json;
    assert(frames === S2.dur * S2.fps && near(fps, S2.fps, 0.01), `frames ${frames} fps ${fps}`);
    const b = S2.box(0);
    const click = { x: (b.x + b.w / 2) / S2.W, y: (b.y + b.h / 2) / S2.H };
    const pts = await ok("POST", `/api/ai/vision/sam/session/${sessionId}/points`, {
      frame: 0,
      points: [{ ...click, label: 1 }],
    });
    const png = await fetch(`${API}${pts.maskUrl}`);
    assert(
      png.ok && (png.headers.get("content-type") ?? "").includes("png"),
      "mask PNG not served",
    );
    // mock mask: 30 % × 40 % box centered on the click (clamped inside the frame)
    const mw = 0.3;
    const mh = 0.4;
    const mx = Math.min(Math.max(0, click.x - mw / 2), 1 - mw);
    const my = Math.min(Math.max(0, click.y - mh / 2), 1 - mh);
    assert(
      near(pts.bbox.x, mx, 0.01) && near(pts.bbox.y, my, 0.01) && near(pts.bbox.w, mw, 0.01),
      `bbox ${JSON.stringify(pts.bbox)}`,
    );
    const prop = await ok("POST", `/api/ai/vision/sam/session/${sessionId}/propagate`, {});
    const job = await waitOk(prop.jobId, { timeoutMs: 300_000 });
    const r = job.result;
    assert(r.trackAssetId && r.maskAssetId && r.alphaAssetId, `assets ${JSON.stringify(r)}`);
    const del = await ok("DELETE", `/api/ai/vision/sam/session/${sessionId}`);
    assert(del.deleted === true, `delete ${JSON.stringify(del)}`);
    const gone = await fetch(`${API}${pts.maskUrl}`);
    assert(gone.status === 404, `click mask still served after DELETE (${gone.status})`);
    const again = await ok("DELETE", `/api/ai/vision/sam/session/${sessionId}`);
    assert(again.deleted === false, "second DELETE should answer deleted:false");
    await waitAssetJobs(r.alphaAssetId, ["media.probe"]);
    // clip.matte = SAM alpha over a green background -> export -> inside mask = source, outside green
    const p = await sprint2Project("E2E máscara SAM", video);
    p.tracks.find((t) => t.kind === "video").clips[0].matte = {
      assetId: r.alphaAssetId,
      background: { type: "color", value: "#00ff00" },
    };
    await ok("PUT", `/api/projects/${p.id}`, p);
    const ex = await ok("POST", `/api/projects/${p.id}/export`, {
      presetId: "youtube-1080p",
      fileName: "mascara-sam",
    });
    const file = await download((await waitOk(ex.jobId)).result.path, "mascara-sam.mp4");
    const f = await frameRgb(file, 1, 960);
    const inside = f.px((mx + mw / 2) * 960, (my + 0.05) * 540);
    const outside = f.px(0.8 * 960, 0.2 * 540);
    const green = (c) => c[1] > 180 && c[0] < 80 && c[2] < 80;
    assert(!green(inside) && inside[1] < 90, `inside the mask ${inside} (expected the source)`);
    assert(green(outside), `outside the mask ${outside} (expected green)`);
    ctx.s2sam = { alphaAssetId: r.alphaAssetId, maskAssetId: r.maskAssetId };
    return {
      sessionId,
      frames,
      inside,
      outside,
      assets: Object.keys(r).filter((k) => k.endsWith("Id")),
    };
  },
);

await step(
  "sprint2: «Quitar fondo» vision.matte (RVM, mocked alpha 200) with color background -> export",
  async () => {
    const { video } = await sprint2Media();
    const p = await sprint2Project("E2E quitar fondo", video);
    const clipId = p.tracks.find((t) => t.kind === "video").clips[0].id;
    const res = await ok("POST", "/api/ai/vision/matte", {
      assetId: video.id,
      model: "rvm",
      background: { type: "color", value: "#00ff00" },
      target: { projectId: p.id, clipId },
    });
    const job = await waitOk(res.jobId, { timeoutMs: 300_000 });
    assert(job.result.linkedClip?.clipId === clipId, "clip.matte not linked");
    await waitAssetJobs(job.result.assetId, ["media.probe"]);
    const saved = await ok("GET", `/api/projects/${p.id}`);
    const matte = saved.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)?.matte;
    assert(matte?.background?.value === "#00ff00", `matte ${JSON.stringify(matte)}`);
    const ex = await ok("POST", `/api/projects/${p.id}/export`, {
      presetId: "youtube-1080p",
      fileName: "quitar-fondo",
    });
    const file = await download((await waitOk(ex.jobId)).result.path, "quitar-fondo.mp4");
    const f = await frameRgb(file, 1, 960);
    // black source with alpha 200/255 over green: G ≈ 255 × 55/255 = 55
    const c = f.px(0.8 * 960, 0.2 * 540);
    assert(c[1] >= 35 && c[1] <= 80 && c[0] < 30 && c[2] < 30, `background pixel ${c}`);
    return { pixel: c, warnings: job.result.warnings ?? [] };
  },
);

await step(
  "sprint3b: «Quitar fondo» alta calidad (RVM mock, --quality high) -> refine + before/after PNG",
  async () => {
    const { video } = await sprint2Media();
    const res = await ok("POST", "/api/ai/vision/matte", {
      assetId: video.id,
      quality: "high",
      refine: { feather: 1, erode: 1, despill: true },
    });
    const job = await waitOk(res.jobId, { timeoutMs: 300_000 });
    const r = job.result;
    assert(r.quality === "high", `quality ${r.quality}`);
    assert(r.refine?.despill === true && r.refine?.feather === 1, JSON.stringify(r.refine));
    assert(r.previewComparePath?.endsWith(".compare.png"), `compare ${r.previewComparePath}`);
    const png = await fetch(`${API}/files/${r.previewComparePath}`);
    assert(png.ok, `GET compare ${png.status}`);
    return { previewComparePath: r.previewComparePath, halo: r.halo ?? null };
  },
);

await step(
  "sprint2: vision.reframe 9:16 (subject: track) -> project.reframe -> reels export follows the box",
  async () => {
    assert(ctx.s2track, "needs the real tracking step");
    const { video } = await sprint2TexturedMedia();
    const p = await sprint2Project("E2E reencuadre auto", video);
    const res = await ok("POST", "/api/ai/vision/reframe", {
      projectId: p.id,
      target: "9:16",
      subject: "track",
      trackAssetId: ctx.s2track.trackAssetId,
    });
    const job = await waitOk(res.jobId, { timeoutMs: 300_000 });
    const kfs = job.result.reframe.keyframes;
    assert(kfs.length >= 2, `${kfs.length} reframe keyframes`);
    for (const k of kfs)
      assert(
        k.v.w > 0 && k.v.w <= 1 && k.v.h <= 1,
        `keyframe not in canvas fractions ${JSON.stringify(k.v)}`,
      );
    const saved = await ok("GET", `/api/projects/${p.id}`);
    assert(saved.reframe?.keyframes?.length === kfs.length, "project.reframe not saved");
    const { reframeCropAt } = await sharedLib();
    const ex = await ok("POST", `/api/projects/${p.id}/export`, {
      presetId: "reels-tiktok",
      fileName: "reencuadre-auto",
    });
    const file = await download((await waitOk(ex.jobId)).result.path, "reencuadre-auto.mp4");
    const v = (await ffprobe(file)).streams.find((s) => s.codec_type === "video");
    assert(v.width === 1080 && v.height === 1920, `size ${v.width}x${v.height}`);
    const checks = [];
    for (const t of [0.5, 2, 3.5]) {
      const b = await brightBox(file, t, { w: 270, min: 25 });
      assert(b, `no box at t=${t}`);
      // expected: the box seen through the SAME window the preview draws (shared reframeCropAt)
      const win = reframeCropAt(saved.reframe, saved.settings, t);
      const box = S2.box(t);
      const ex = ((((box.x + box.w / 2) * 1.5) / 1920 - win.x) / win.w) * 270;
      assert(near(b.cx, ex, 8), `t=${t}: box at ${b.cx}, preview window predicts ${ex.toFixed(1)}`);
      assert(b.cx > 30 && b.cx < 240, `t=${t}: box at ${b.cx} near the edge (no follow)`);
      checks.push({ t, cx: b.cx, expected: +ex.toFixed(1) });
    }
    return { keyframes: kfs.length, checks };
  },
);

await step(
  "sprint3: agent plan (mocked workers, fixed plan) -> resolve -> apply -> project changed -> undo",
  async () => {
    const { video } = await sprint2Media();
    const p = await sprint2Project("E2E asistente", video);
    const clipId = p.tracks.find((t) => t.kind === "video").clips[0].id;
    const status = await ok("GET", "/api/agent/status");
    assert(status.workers === true, `agent status ${JSON.stringify(status)}`);
    // workers-with-mocks.py answers a fixed EditPlan to commands starting with "e2e:".
    const plan = await ok(
      "POST",
      "/api/agent/plan",
      { command: "e2e: dividí, poné un título y pasalo a vertical", projectId: p.id, cursor: 1 },
      [201],
    );
    assert(plan.ok === true, `plan not ok: ${JSON.stringify(plan).slice(0, 600)}`);
    assert(plan.preview_es.length === 3, `preview ${JSON.stringify(plan.preview_es)}`);
    assert(
      plan.resolved[0]?.clip?.id === clipId,
      `split resolved to ${JSON.stringify(plan.resolved[0])}`,
    );
    const listed = await ok("GET", `/api/agent/plans?projectId=${p.id}`);
    assert(listed[0]?.id === plan.id, "plan not listed");
    const { jobId } = await ok("POST", "/api/agent/apply", { planId: plan.id }, [202]);
    const job = await waitOk(jobId, { timeoutMs: 60_000 });
    assert(job.type === "agent.apply", `job type ${job.type}`);
    assert(job.result.applied === 3 && !job.result.failed, `apply ${JSON.stringify(job.result)}`);
    const saved = await ok("GET", `/api/projects/${p.id}`);
    const V = saved.tracks.find((t) => t.kind === "video").clips;
    assert(V.length === 2 && near(V[1].start, 1, 1e-6), `video clips ${JSON.stringify(V)}`);
    const texts = saved.tracks.flatMap((t) => (t.kind === "text" ? t.clips : []));
    assert(
      texts.some((c) => c.text === "Hola agente"),
      "text clip missing",
    );
    assert(
      saved.settings.width === 1080 && saved.settings.height === 1920,
      `canvas ${saved.settings.width}x${saved.settings.height}`,
    );
    const progress = sseFor(jobId).map((e) => e.message ?? "");
    const undo = await ok("POST", `/api/agent/plans/${plan.id}/undo`, {});
    assert(
      undo.project.settings.width === p.settings.width &&
        undo.project.tracks.find((t) => t.kind === "video").clips.length === 1,
      "undo did not restore the project",
    );
    return {
      preview: plan.preview_es,
      route: plan.route,
      progressEvents: progress.filter((m) => m.startsWith("op ")).length,
    };
  },
);

// Sprint 3 integration: the real workers router / Ollama (no mocked plan).
const AGENT_MODEL = process.env.AGENT_MODEL?.trim() || "";

await step(
  "sprint3: deterministic route «exportá para reels» -> plan without LLM -> apply -> export file",
  async () => {
    const { video } = await sprint2Media();
    const p = await sprint2Project("E2E asistente reels", video);
    const plan = await ok(
      "POST",
      "/api/agent/plan",
      { command: "exportá para reels", projectId: p.id },
      [201],
    );
    assert(plan.route === "deterministic", `route ${plan.route}`);
    assert(plan.model == null, `model ${plan.model} (the LLM must not be used)`);
    assert(
      plan.ok && plan.plan.ops.length === 1 && plan.resolved[0]?.preset === "reels-tiktok",
      `plan ${JSON.stringify(plan).slice(0, 400)}`,
    );
    assert(plan.resolved[0].confirm === true, "export must always ask for confirmation");
    // export is destructive: without the separate confirmation (confirmedIndexes) -> 409
    const unconfirmed = await api("POST", "/api/agent/apply", { planId: plan.id });
    assert(
      unconfirmed.status === 409 && unconfirmed.json?.error?.code === "CONFIRM_REQUIRED",
      `apply without confirmedIndexes -> ${unconfirmed.status}`,
    );
    const { jobId } = await ok(
      "POST",
      "/api/agent/apply",
      { planId: plan.id, confirmedIndexes: [0] },
      [202],
    );
    const job = await waitOk(jobId, { timeoutMs: 300_000 });
    assert(job.result.applied === 1 && !job.result.failed, `apply ${JSON.stringify(job.result)}`);
    const exported = job.result.steps[0].result;
    const file = await download(exported.path, "agente-reels.mp4");
    const v = (await ffprobe(file)).streams.find((x) => x.codec_type === "video");
    assert(v.width === 1080 && v.height === 1920, `export ${v.width}x${v.height}`);
    return { preview: plan.preview_es, latency_ms: plan.latency_ms, file: exported.path };
  },
);

await step(
  "sprint3: edited_ops -> api re-resolves (preview) -> apply -> project changed -> undo restores",
  async () => {
    const { video } = await sprint2Media();
    const p = await sprint2Project("E2E asistente editado", video);
    const plan = await ok(
      "POST",
      "/api/agent/plan",
      { command: "poné el lienzo vertical", projectId: p.id },
      [201],
    );
    assert(plan.route === "deterministic" && plan.ok, `plan ${JSON.stringify(plan).slice(0, 300)}`);
    assert(plan.plan.ops[0].preset === "9:16", `op ${JSON.stringify(plan.plan.ops[0])}`);
    // invalid edit -> 400 with the Spanish path
    const bad = await api("POST", "/api/agent/apply", {
      planId: plan.id,
      edited_ops: [{ op: "set_canvas", preset: "21:9" }],
    });
    assert(
      bad.status === 400 && /ops\[0\]\.preset/.test(bad.json?.error?.message),
      `bad ${bad.status}`,
    );
    const edited = [{ ...plan.plan.ops[0], preset: "1:1" }];
    const acc = await ok(
      "POST",
      "/api/agent/apply",
      { planId: plan.id, edited_ops: edited },
      [202],
    );
    assert(acc.plan?.edited === true, "apply did not answer the re-resolved plan");
    assert(
      acc.plan.preview_es[0] !== plan.preview_es[0] && /1080×1080/.test(acc.plan.preview_es[0]),
      `preview ${plan.preview_es[0]} -> ${acc.plan.preview_es[0]}`,
    );
    const job = await waitOk(acc.jobId, { timeoutMs: 60_000 });
    assert(job.result.applied === 1, `apply ${JSON.stringify(job.result)}`);
    const saved = await ok("GET", `/api/projects/${p.id}`);
    assert(
      saved.settings.width === 1080 && saved.settings.height === 1080,
      `canvas ${saved.settings.width}x${saved.settings.height}`,
    );
    // An edit after the apply: the undo asks first (409 PROJECT_CHANGED), force restores.
    await ok("PUT", `/api/projects/${p.id}`, { ...saved, name: `${saved.name} (editado)` });
    const changed = await api("POST", `/api/agent/plans/${plan.id}/undo`, {});
    assert(
      changed.status === 409 && changed.json?.error?.code === "PROJECT_CHANGED",
      `undo after an edit -> ${changed.status}`,
    );
    const undo = await ok("POST", `/api/agent/plans/${plan.id}/undo`, { force: true });
    const back = await ok("GET", `/api/projects/${p.id}`);
    assert(
      undo.plan.status === "proposed" &&
        back.settings.width === p.settings.width &&
        back.settings.height === p.settings.height,
      `undo -> ${back.settings.width}x${back.settings.height}`,
    );
    return { before: plan.preview_es[0], after: acc.plan.preview_es[0] };
  },
);

await step(
  "sprint3: PACK_REQUIRED agent-llm (bogus model) + bugreport template fallback",
  async () => {
    const p = await ok("GET", `/api/projects`);
    const r = await api("POST", "/api/agent/plan", {
      command: "poné un texto que diga Hola en el segundo 1",
      projectId: p[0].id,
      settings: { model: "no-existe:1b" },
    });
    assert(r.status === 409 && r.json?.error === "PACK_REQUIRED", `plan -> ${r.status}`);
    assert(r.json.packId === "agent-llm", `pack ${r.json.packId}`);
    assert(/Ollama/.test(r.json.message) && /no-existe:1b/.test(r.json.message), r.json.message);
    const bug = await ok("POST", "/api/agent/bugreport", {
      title: "Se colgó el export",
      steps_text: "Exporté para reels y se colgó",
      model: "no-existe:1b",
    });
    assert(bug.source === "template", `bugreport source ${bug.source}`);
    assert(/Pasos para reproducir/.test(bug.markdown_es), "template headings");
    return { message: r.json.message.slice(0, 90), bugreport: bug.source };
  },
);

if (AGENT_MODEL) {
  await step(
    `sprint3: LLM route with ${AGENT_MODEL} (api -> workers -> Ollama) -> plan -> apply`,
    async () => {
      const status = await ok("GET", "/api/agent/status");
      assert(status.ollama && status.ready, `status ${JSON.stringify(status)}`);
      const { video } = await sprint2Media();
      const p = await sprint2Project("E2E asistente LLM", video);
      const plan = await ok(
        "POST",
        "/api/agent/plan",
        {
          command: "poné un texto que diga Hola en el segundo 1",
          projectId: p.id,
          cursor: 0.5,
          settings: { model: AGENT_MODEL },
        },
        [201],
      );
      assert(
        plan.route === "llm" && plan.model === AGENT_MODEL,
        `route ${plan.route} ${plan.model}`,
      );
      // Ollama has the model in memory now (/api/ps): the web stops showing «Cargando modelo…»
      const after = await ok("GET", "/api/agent/status");
      assert(after.loaded === true, `loaded ${after.loaded}`);
      // Any schema-valid plan is fine (plan quality is measured on the user's PC).
      assert(plan.plan && plan.errors.length === 0, `invalid plan ${JSON.stringify(plan.errors)}`);
      assert(plan.preview_es.length === plan.plan.ops.length, "one preview line per op");
      const ready = plan.resolved.map((r, i) => (r ? i : -1)).filter((i) => i >= 0);
      let applied = null;
      if (ready.length) {
        // the user confirms delete/export apart (confirmedIndexes)
        const { jobId } = await ok(
          "POST",
          "/api/agent/apply",
          { planId: plan.id, ops: ready, confirmedIndexes: ready },
          [202],
        );
        const job = await waitJob(jobId, { timeoutMs: 300_000 });
        assert(job.status === "succeeded", `apply ${job.status} ${job.error}`);
        applied = job.result.applied;
        await ok("POST", `/api/agent/plans/${plan.id}/undo`, {});
      }
      return {
        ops: plan.plan.ops.map((o) => o.op),
        questions: plan.plan.questions?.length ?? 0,
        attempts: plan.attempts,
        latency_ms: plan.latency_ms,
        warnings: plan.warnings,
        applied,
      };
    },
  );

  await step(`sprint3: bugreport drafted by ${AGENT_MODEL}`, async () => {
    const bug = await ok("POST", "/api/agent/bugreport", {
      title: "La vista previa se congela",
      steps_text: "Muevo el cursor y la vista previa se congela",
      model: AGENT_MODEL,
    });
    assert(bug.source === "llm", `source ${bug.source}`);
    assert(/Pasos para reproducir/.test(bug.markdown_es), "headings");
    return { chars: bug.markdown_es.length };
  });

  await step(`sprint3: /api/agent/eval golden with ${AGENT_MODEL} -> agent-eval.json`, async () => {
    const { jobId } = await ok(
      "POST",
      "/api/agent/eval",
      { models: [AGENT_MODEL], dataset: "golden" },
      [202],
    );
    const job = await waitOk(jobId, { timeoutMs: 900_000 });
    const res = await ok("GET", "/api/agent/eval");
    const m = res.models?.[AGENT_MODEL];
    assert(res.n === 80 && m, `eval ${JSON.stringify(res).slice(0, 300)}`);
    for (const k of [
      "valid_json_rate",
      "schema_valid_rate",
      "exact_ops_rate",
      "semantic_rate",
      "semantic_rate_ops_only",
    ])
      assert(typeof m[k] === "number", `${k} missing`);
    if (existsSync(STORAGE))
      assert(existsSync(path.join(STORAGE, "run", "agent-eval.json")), "file");
    return {
      job: job.status,
      semantic_rate: m.semantic_rate,
      semantic_rate_ops_only: m.semantic_rate_ops_only,
      schema_valid_rate: m.schema_valid_rate,
      routes: m.routes,
      p50_latency_ms: m.p50_latency_ms,
    };
  });
} else {
  skip("sprint3: LLM route (api -> workers -> Ollama)", "AGENT_MODEL is not set (no local model)");
}

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

// ---------------------------------------------------------------- BEGIN sprint 3b stems
await step(
  "sprint3b: stems (lavfi tone+noise video) -> «Voz»/«Música» tracks aligned, clip muted -> undo",
  async () => {
    const src = path.join(WORK, "e2e-stems.mp4");
    await run(FFMPEG, [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x203040:s=320x180:r=25:d=6",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=6:sample_rate=48000",
      "-f",
      "lavfi",
      "-i",
      "anoisesrc=d=6:c=pink:a=0.08:r=48000",
      "-filter_complex",
      "[1:a][2:a]amix=inputs=2:normalize=0[a]",
      "-map",
      "0:v",
      "-map",
      "[a]",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      src,
    ]);
    const video = await upload(src, "video/mp4");
    await waitAssetJobs(video.id, ["media.probe"]);
    const p0 = await ok("POST", "/api/projects", { name: "E2E stems" }, [201]);
    const V = p0.tracks.find((t) => t.kind === "video");
    const clipId = id("c");
    V.clips = [
      { id: clipId, trackId: V.id, assetId: video.id, start: 1.5, in: 0.5, out: 5.5, volume: 0.9 },
    ];
    const p = await ok("PUT", `/api/projects/${p0.id}`, p0);
    const pack = (await ok("GET", "/api/ai/packs")).find((x) => x.id === "stems");
    assert(pack, "pack «stems» not listed by GET /api/ai/packs");
    const body = { clipId, mode: "two", target: { projectId: p.id } };
    const r = await api("POST", "/api/audio/stems", body);
    if (!pack.installed) {
      assert(
        r.status === 409 && r.json?.packId === "stems",
        `stems without pack -> ${r.status} ${JSON.stringify(r.json)}`,
      );
      return "409 PACK_REQUIRED (workers without the stems pack / mocks off)";
    }
    assert(r.status === 202, `stems -> ${r.status} ${JSON.stringify(r.json)}`);
    const job = await waitOk(r.json.jobId, { timeoutMs: 180_000 });
    const res = job.result;
    assert(
      res.stems.map((s) => s.label).join() === "Voz,Música",
      `stems ${JSON.stringify(res.stems)}`,
    );
    assert(res.undoSnapshotId && res.previousVolume === 0.9, `result ${JSON.stringify(res)}`);
    const saved = await ok("GET", `/api/projects/${p.id}`);
    const names = saved.tracks.map((t) => t.name);
    const srcClip = saved.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
    assert(srcClip?.volume === 0, `source clip volume ${srcClip?.volume}`);
    for (const s of res.stems) {
      const track = saved.tracks.find((t) => t.id === s.trackId);
      assert(track?.kind === "audio" && track.name === s.label, `track ${JSON.stringify(track)}`);
      const c = track.clips[0];
      assert(
        c.assetId === s.assetId && c.start === 1.5 && c.in === 0.5 && c.out === 5.5,
        `stem clip ${JSON.stringify(c)}`,
      );
      assert(c.volume === 0.9, `stem clip volume ${c.volume}`);
      const f = await ffprobe(await download(s.path, `stem-${s.name}.wav`));
      const a = f.streams.find((x) => x.codec_type === "audio");
      assert(
        a.sample_rate === "44100" && a.channels === 2,
        `stem ${a.sample_rate} Hz x${a.channels}`,
      );
      assert(near(+f.format.duration, 6, 0.2), `stem duration ${f.format.duration}`);
    }
    const progress = sseFor(r.json.jobId).filter((e) => (e.message ?? "").includes("Separando"));
    const undo = await ok("POST", "/api/audio/stems/undo", { undoSnapshotId: res.undoSnapshotId });
    const back = undo.project;
    assert(
      !back.tracks.some((t) => t.name === "Voz" || t.name === "Música") &&
        back.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)?.volume === 0.9,
      `undo did not restore: ${back.tracks.map((t) => t.name).join(", ")}`,
    );
    return { device: res.device, tracks: names, progressEvents: progress.length };
  },
);
// ------------------------------------------------------------------ END sprint 3b stems
// ---------------------------------------------------------------- BEGIN sprint 3b style
// «Perfil de estilo»: analysis of a lavfi reference (4 shots of 2 s + tone), local vision model
// (409 PACK_REQUIRED unless qwen2.5vl:3b is in Ollama), preset -> Assistant plan -> agent.apply.
const STYLE_SHEET = { w: 4 * 320 + 3 * 4 + 8, h: 6 * 180 + 5 * 4 + 8 }; // 4x6 tiles of 320x180

async function styleReference() {
  if (ctx.styleRef) return ctx.styleRef;
  const src = path.join(WORK, "e2e-estilo-ref.mp4");
  const shots = ["testsrc2=", "smptebars=", "color=c=red:", "color=c=blue:"];
  const args = ["-y", "-v", "error"];
  for (const s of shots) args.push("-f", "lavfi", "-i", `${s}s=640x360:r=25:d=2`);
  args.push("-f", "lavfi", "-i", "sine=f=440:d=8:sample_rate=48000");
  args.push(
    "-filter_complex",
    "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0,format=yuv420p[v]",
    "-map",
    "[v]",
    "-map",
    "4:a",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    "-shortest",
    src,
  );
  await run(FFMPEG, args);
  const video = await upload(src, "video/mp4");
  await waitAssetJobs(video.id, ["media.probe"]);
  ctx.styleRef = { video };
  return ctx.styleRef;
}

await step(
  "sprint3b: style.analyze (lavfi 4 shots) -> analysis asset + contact sheet 4x6",
  async () => {
    const { video } = await styleReference();
    const t0 = Date.now();
    const { jobId } = await ok("POST", "/api/style/analyze", { assetId: video.id }, [202]);
    const job = await waitOk(jobId, { timeoutMs: 180_000 });
    const ms = Date.now() - t0;
    const { analysisId, analysis, contactSheetPath } = job.result;
    const s = analysis.shot_stats;
    assert(s.count === 4, `shots ${s.count}: ${JSON.stringify(analysis.scenes)}`);
    assert(near(s.median_s, 2, 0.15), `median ${s.median_s}`);
    assert(analysis.audio.has_audio && analysis.audio.loudness_lufs < -10, "audio");
    assert(analysis.thumbnails.length === 24, `thumbnails ${analysis.thumbnails.length}`);
    const asset = (await ok("GET", "/api/media")).find((a) => a.id === analysisId);
    assert(
      asset?.kind === "analysis" && asset.thumbnailPath === contactSheetPath,
      "analysis asset",
    );
    const sheet = await ffprobe(await download(contactSheetPath, "estilo-hoja.png"));
    const v = sheet.streams[0];
    assert(
      v.width === STYLE_SHEET.w && v.height === STYLE_SHEET.h,
      `contact sheet ${v.width}x${v.height}`,
    );
    const listed = await ok("GET", `/api/style/analyses?assetId=${video.id}`);
    assert(
      listed.some((r) => r.id === analysisId),
      "analysis not listed",
    );
    ctx.styleRef.analysisId = analysisId;
    const progress = sseFor(jobId).filter((e) => e.status === "running").length;
    return {
      ms,
      method: analysis.scenes_method,
      cutsPerMin: s.cuts_per_min,
      lufs: analysis.audio.loudness_lufs,
      music: analysis.audio.music_detected,
      ocr: analysis.text_on_screen ? analysis.text_on_screen.length : "sin pack",
      sseRunning: progress,
    };
  },
);

await step(
  "sprint3b: style.infer -> 409 PACK_REQUIRED vision-llm (console hint) or a preset",
  async () => {
    const analysisId = ctx.styleRef?.analysisId;
    assert(analysisId, "no analysis from the previous step");
    const r = await api("POST", "/api/style/infer", { analysisId });
    if (r.status === 409) {
      assert(r.json?.packId === "vision-llm", `pack ${JSON.stringify(r.json)}`);
      assert(/Consola Claude/.test(r.json?.message ?? ""), `message ${r.json?.message}`);
      return "409 PACK_REQUIRED (sin qwen2.5vl:3b en Ollama)";
    }
    assert(r.status === 202, `infer -> ${r.status} ${JSON.stringify(r.json)}`);
    const job = await waitJob(r.json.jobId, { timeoutMs: 600_000 });
    if (job.status === "failed") {
      assert(
        job.result?.packId === "vision-llm" && /Consola Claude/.test(job.error ?? ""),
        `infer job ${job.error}`,
      );
      return "job failed with PACK_REQUIRED (console hint)";
    }
    assert(job.status === "succeeded" && job.result.preset?.canvas, `infer ${job.status}`);
    return { model: job.result.model, preset: job.result.preset.name };
  },
);

await step(
  "sprint3b: save a style preset -> apply -> Assistant plan proposed -> agent.apply (confirmed export)",
  async () => {
    const { video } = await styleReference();
    const wav = path.join(WORK, "e2e-estilo-musica.wav");
    await run(FFMPEG, ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=f=220:d=8", wav]);
    const music = await upload(wav, "audio/wav");
    await waitAssetJobs(music.id, ["media.probe"]);
    const p0 = await ok("POST", "/api/projects", { name: "E2E estilo" }, [201]);
    const V = p0.tracks.find((t) => t.kind === "video");
    const A = p0.tracks.find((t) => t.kind === "audio");
    V.clips = [{ id: id("c"), trackId: V.id, assetId: video.id, start: 0, in: 0, out: 8 }];
    const musicClip = id("m");
    A.clips = [{ id: musicClip, trackId: A.id, assetId: music.id, start: 0, in: 0, out: 8 }];
    const p = await ok("PUT", `/api/projects/${p0.id}`, p0);
    const preset = await ok(
      "POST",
      "/api/style/presets",
      {
        name: "E2E vertical",
        canvas: "9:16",
        cut_rhythm: { target_shot_s: 6, remove_silences: true, min_silence_ms: 400 },
        captions: { enabled: false, style: "reels", animated: true, position: "center" },
        titles: { enabled: false, template: "title-card" },
        transitions: { type: "fade" },
        music: { duck: true, volume_db: -14 },
        export_preset: "reels-tiktok",
        notes_es: "Preset de prueba e2e.",
        source: { via: "manual", assetId: video.id, analysisId: ctx.styleRef?.analysisId },
      },
      [201],
    );
    const res = await ok(
      "POST",
      `/api/style/presets/${preset.id}/apply`,
      { projectId: p.id },
      [201],
    );
    const ops = res.plan.plan.ops.map((o) => o.op);
    assert(
      ops.join() === "set_canvas,cut_silences,detect_scenes,set_volume,export",
      `ops ${ops.join()}`,
    );
    assert(res.plan.status === "proposed" && res.plan.ok, `plan ${JSON.stringify(res.plan)}`);
    assert(
      res.preview_es.length === ops.length && res.preview_es[0] === "Lienzo 1080×1920",
      "preview",
    );
    assert(
      res.notes_es.some((n) => /fundido/.test(n)),
      `notes ${res.notes_es}`,
    );
    const listed = await ok("GET", `/api/agent/plans?projectId=${p.id}`);
    assert(listed[0]?.id === res.planId, "style plan not in the Assistant history");
    // detect_scenes needs the scenes pack: leave it unchecked when the workers lack it.
    const scenesPack = (await ok("GET", "/api/ai/packs")).find((x) => x.id === "scenes");
    const chosen = ops
      .map((_, i) => i)
      .filter((i) => ops[i] !== "detect_scenes" || scenesPack?.installed);
    const exportIdx = ops.indexOf("export");
    const refused = await api("POST", "/api/agent/apply", { planId: res.planId, ops: chosen });
    assert(
      refused.status === 409 && refused.json?.error?.code === "CONFIRM_REQUIRED",
      `without confirmation -> ${refused.status} ${JSON.stringify(refused.json)}`,
    );
    const { jobId } = await ok(
      "POST",
      "/api/agent/apply",
      { planId: res.planId, ops: chosen, confirmedIndexes: [exportIdx] },
      [202],
    );
    const job = await waitOk(jobId, { timeoutMs: 300_000 });
    assert(
      job.result.applied === chosen.length && !job.result.failed,
      `apply ${JSON.stringify(job.result)}`,
    );
    const saved = await ok("GET", `/api/projects/${p.id}`);
    assert(saved.settings.width === 1080 && saved.settings.height === 1920, "canvas not 9:16");
    const mc = saved.tracks.flatMap((t) => t.clips).find((c) => c.id === musicClip);
    assert(near(mc.volume, 10 ** (-14 / 20), 1e-3), `music volume ${mc?.volume}`);
    const exp = job.result.steps.find((s) => s.index === exportIdx)?.result;
    assert(exp?.path, `export step ${JSON.stringify(job.result.steps)}`);
    const out = await ffprobe(await download(exp.path, "estilo-export.mp4"));
    const vs = out.streams.find((x) => x.codec_type === "video");
    assert(vs.width === 1080 && vs.height === 1920, `export ${vs.width}x${vs.height}`);
    const plan = (await ok("GET", `/api/agent/plans?projectId=${p.id}`)).find(
      (x) => x.id === res.planId,
    );
    assert(plan?.status === "applied", `plan status ${plan?.status}`);
    return {
      ops,
      applied: chosen.length,
      scenesPack: !!scenesPack?.installed,
      videoClips: saved.tracks.find((t) => t.kind === "video").clips.length,
    };
  },
);
// ------------------------------------------------------------------ END sprint 3b style

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

// ---- Sprint 3b «Capas y fusiones» (module E): blend mode / mask / z-order in the real export.
// Flat lavfi colours; the expected pixels come from @studio/shared blendRgb (the same reference the
// api pixel tests and the web preview parity tests use).

async function layersMedia() {
  if (ctx.s3bLayers) return ctx.s3bLayers;
  const lib = await sharedLib();
  const hex = (c) => c.map((v) => v.toString(16).padStart(2, "0")).join("");
  const make = async (name, rgb) => {
    const file = path.join(WORK, `e2e-capa-${name}.mp4`);
    await run(FFMPEG, [
      "-y", "-v", "error", "-f", "lavfi", "-i", `color=c=0x${hex(rgb)}:s=640x360:r=25:d=3`,
      "-c:v", "libx264", "-crf", "4", "-pix_fmt", "yuv420p", file,
    ]); // prettier-ignore
    const a = await upload(file, "video/mp4");
    await waitAssetJobs(a.id, ["media.probe"]);
    return a;
  };
  ctx.s3bLayers = {
    lib,
    base: await make("base", lib.LAYER_PARITY_BASE),
    top: await make("top", lib.LAYER_PARITY_TOP),
    red: await make("rojo", [255, 0, 0]),
    blue: await make("azul", [0, 0, 255]),
  };
  return ctx.s3bLayers;
}

/** Project 640×360 with two video tracks (bottom → top) of one 3 s clip each; export youtube-1080p. */
async function exportLayers(name, bottom, top, topExtra = {}, trackExtra = [{}, {}]) {
  const p = await ok(
    "POST",
    "/api/projects",
    { name, settings: { width: 640, height: 360, fps: 25 } },
    [201],
  );
  const V = p.tracks.find((t) => t.kind === "video");
  const V2 = { ...V, id: id("trk"), name: "Video 2", clips: [] };
  V.clips = [{ id: id("c"), trackId: V.id, assetId: bottom.id, start: 0, in: 0, out: 3 }];
  V2.clips = [
    { id: id("c"), trackId: V2.id, assetId: top.id, start: 0, in: 0, out: 3, ...topExtra },
  ];
  Object.assign(V, trackExtra[0]);
  Object.assign(V2, trackExtra[1]);
  p.tracks = [V, V2, ...p.tracks.filter((t) => t.id !== V.id)];
  await ok("PUT", `/api/projects/${p.id}`, p);
  const { jobId } = await ok("POST", `/api/projects/${p.id}/export`, {
    presetId: "youtube-1080p",
    fileName: name.replace(/\s+/g, "-"),
  });
  const job = await waitOk(jobId);
  return frameRgb(await download(job.result.path, `${name.replace(/\s+/g, "-")}.mp4`), 1.5, 640);
}

const rgbNear = (got, want, tol = 8) => got.every((v, i) => Math.abs(v - want[i]) <= tol);

await step(
  "sprint3b: export multiply / screen over the base track -> pixel = shared blendRgb",
  async () => {
    const { lib, base, top } = await layersMedia();
    const out = {};
    for (const mode of ["multiply", "screen"]) {
      const f = await exportLayers(`E2E capas ${mode}`, base, top, { blendMode: mode });
      const got = f.px(320, 180);
      const want = lib.blendRgb(mode, lib.LAYER_PARITY_BASE, lib.LAYER_PARITY_TOP);
      assert(rgbNear(got, want, lib.LAYER_PARITY_TOLERANCE), `${mode}: got ${got}, want ${want}`);
      out[mode] = { got, want };
    }
    return out;
  },
);

await step("sprint3b: export ellipse mask (feather 12) + Track.order swap", async () => {
  const { red, blue } = await layersMedia();
  const mask = { type: "shape", shape: "ellipse", x: 0.1, y: 0.1, w: 0.8, h: 0.8, feather: 12 };
  const f = await exportLayers("E2E capas elipse", blue, red, { maskRef: mask });
  const center = f.px(320, 180);
  const corner = f.px(4, 4);
  assert(rgbNear(center, [255, 0, 0]), `center ${center} (red expected)`);
  assert(rgbNear(corner, [0, 0, 255]), `corner ${corner} (blue expected)`);
  // same tracks with Track.order swapped: the blue (bottom row) is now drawn on top
  const g = await exportLayers("E2E capas orden", blue, red, {}, [{ order: 1 }, { order: 0 }]);
  const top = g.px(320, 180);
  assert(rgbNear(top, [0, 0, 255]), `reordered: ${top} (blue expected on top)`);
  return { center, corner, reordered: top };
});

// ---------------------------------------------------------------- BEGIN sprint 3b integration
// Cross-module checks: console routes + studio-mcp against the real api, SAM mask (sprint 2) as a
// layer mask, block-cache hashes with blend/mask/order, Track.order with stems and agent plans.

/** One-clip-per-track project (bottom → top) on a 640×360 canvas; returns the saved project. */
async function layersProject(name, bottom, top, topExtra = {}, dur = 3) {
  const p = await ok(
    "POST",
    "/api/projects",
    { name, settings: { width: 640, height: 360, fps: 25 } },
    [201],
  );
  const V = p.tracks.find((t) => t.kind === "video");
  const V2 = { ...V, id: id("trk"), name: "Video 2", clips: [] };
  V.clips = [{ id: id("c"), trackId: V.id, assetId: bottom.id, start: 0, in: 0, out: dur }];
  V2.clips = [
    { id: id("c"), trackId: V2.id, assetId: top.id, start: 0, in: 0, out: dur, ...topExtra },
  ];
  p.tracks = [V, V2, ...p.tracks.filter((t) => t.id !== V.id)];
  return ok("PUT", `/api/projects/${p.id}`, p);
}

await step(
  "sprint3b: console status + session/WS round-trip + /api/projects/:id/frame PNG",
  async () => {
    const st = await ok("GET", "/api/console/status");
    assert(
      typeof st.claudeInstalled === "boolean" && st.storageDir,
      `status ${JSON.stringify(st)}`,
    );
    const { red } = await layersMedia();
    const p = await layersProject("E2E consola fotograma", red, red);
    const res = await fetch(`${API}/api/projects/${p.id}/frame?t=1&format=png`);
    assert(
      res.ok && (res.headers.get("content-type") ?? "").includes("png"),
      `frame ${res.status}`,
    );
    const png = Buffer.from(await res.arrayBuffer());
    assert(png.subarray(1, 4).toString() === "PNG", "not a PNG");
    const method = res.headers.get("x-studio-frame-method");
    let ws = "claude not installed (status only)";
    if (st.claudeInstalled) {
      const s = await ok("POST", "/api/console/session", { cols: 100, rows: 30 }, [201]);
      const sock = new WebSocket(`${API.replace(/^http/, "ws")}/api/console/ws?token=${s.token}`);
      const seen = [];
      const out = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Fail(`WS timeout: ${seen.join("").slice(-200)}`)),
          20_000,
        );
        sock.onmessage = (ev) => {
          const m = JSON.parse(String(ev.data));
          if (m.type === "status" && m.state === "running")
            sock.send(JSON.stringify({ type: "input", data: "hola-e2e\r" }));
          if (m.type === "output") seen.push(m.data);
          if (seen.join("").includes("hola-e2e")) {
            clearTimeout(timer);
            resolve(seen.join(""));
          }
        };
        sock.onerror = () => reject(new Fail("WS error"));
      });
      sock.send(JSON.stringify({ type: "kill" }));
      sock.close();
      const reuse = new WebSocket(`${API.replace(/^http/, "ws")}/api/console/ws?token=${s.token}`);
      const code = await new Promise((resolve) => (reuse.onclose = (ev) => resolve(ev.code)));
      assert(code === 4401, `reused token closed with ${code} (4401 expected)`);
      ws = `echo ok (${out.length} B), token reuse -> 4401, claude ${st.version}`;
    }
    return { claudeInstalled: st.claudeInstalled, frame: `${png.length} B (${method})`, ws };
  },
);

await step(
  "sprint3b: studio-mcp (stdio) studio_style_save_preset + studio_style_apply -> Assistant plan",
  async () => {
    const entry = path.join(REPO, "packages", "studio-mcp", "dist", "index.js");
    assert(existsSync(entry), "packages/studio-mcp/dist missing (pnpm build:packages)");
    const { video } = await styleReference();
    const p0 = await ok("POST", "/api/projects", { name: "E2E MCP estilo" }, [201]);
    p0.tracks.find((t) => t.kind === "video").clips = [
      {
        id: id("c"),
        trackId: p0.tracks.find((t) => t.kind === "video").id,
        assetId: video.id,
        start: 0,
        in: 0,
        out: 8,
      },
    ];
    const p = await ok("PUT", `/api/projects/${p0.id}`, p0);
    const child = spawn(process.execPath, [entry], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, STUDIO_API_URL: API },
      windowsHide: true,
    });
    let buf = "";
    const waiting = new Map();
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) {
          const msg = JSON.parse(line);
          waiting.get(msg.id)?.(msg);
        }
      }
    });
    let n = 0;
    const rpc = (method, params) =>
      new Promise((resolve, reject) => {
        const rid = ++n;
        const timer = setTimeout(() => reject(new Fail(`MCP timeout: ${method}`)), 30_000);
        waiting.set(rid, (msg) => {
          clearTimeout(timer);
          if (msg.error) reject(new Fail(`${method}: ${msg.error.message}`));
          else resolve(msg.result);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }) + "\n");
      });
    const call = async (name, args) => {
      const r = await rpc("tools/call", { name, arguments: args });
      const text = r.content?.[0]?.text ?? "";
      assert(!r.isError, `${name} -> ${text.slice(0, 300)}`);
      return JSON.parse(text);
    };
    try {
      await rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "e2e", version: "1" },
      });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
      );
      const saved = await call("studio_style_save_preset", {
        preset: {
          name: "E2E Claude vertical",
          canvas: "9:16",
          cut_rhythm: { target_shot_s: 4, remove_silences: false, min_silence_ms: 400 },
          captions: { enabled: false, style: "reels", animated: true, position: "center" },
          titles: { enabled: false, template: "title-card" },
          transitions: { type: "cut" },
          music: { duck: false, volume_db: -12 },
          export_preset: "reels-tiktok",
          notes_es: "Deducido por la Consola Claude (e2e).",
          source: { assetId: video.id, analysisId: ctx.styleRef?.analysisId },
        },
      });
      assert(
        saved.id && saved.source?.via === "claude",
        `saved ${JSON.stringify(saved).slice(0, 300)}`,
      );
      const listed = await ok("GET", "/api/style/presets");
      assert(
        listed.some((x) => x.id === saved.id),
        "preset not in GET /api/style/presets",
      );
      const applied = await call("studio_style_apply", { presetId: saved.id, projectId: p.id });
      assert(applied.planId, `apply ${JSON.stringify(applied).slice(0, 300)}`);
      const plans = await ok("GET", `/api/agent/plans?projectId=${p.id}`);
      const rec = plans.find((x) => x.id === applied.planId);
      assert(
        rec?.status === "proposed" && rec.plan.ops[0].op === "set_canvas",
        `plan ${JSON.stringify(rec).slice(0, 300)}`,
      );
      return {
        presetId: saved.id,
        planId: applied.planId,
        ops: rec.plan.ops.map((o) => o.op).join(","),
      };
    } finally {
      child.kill();
    }
  },
);

await step(
  "sprint3b: SAM mask asset (sprint 2) as Clip.maskRef -> export shows the top clip only inside the mask",
  async () => {
    assert(ctx.s2sam?.maskAssetId, "needs the sprint 2 SAM step (mask asset)");
    const { video } = await sprint2Media();
    const { red } = await layersMedia();
    const p0 = await ok("POST", "/api/projects", { name: "E2E capa máscara SAM" }, [201]);
    const V = p0.tracks.find((t) => t.kind === "video");
    const V2 = { ...V, id: id("trk"), name: "Video 2", clips: [] };
    V.clips = [{ id: id("c"), trackId: V.id, assetId: red.id, start: 0, in: 0, out: 3 }];
    V2.clips = [
      {
        id: id("c"),
        trackId: V2.id,
        assetId: video.id,
        start: 0,
        in: 0,
        out: 3,
        maskRef: { type: "asset", assetId: ctx.s2sam.maskAssetId },
      },
    ];
    p0.tracks = [V, V2, ...p0.tracks.filter((t) => t.id !== V.id)];
    const p = await ok("PUT", `/api/projects/${p0.id}`, p0);
    const ex = await ok("POST", `/api/projects/${p.id}/export`, {
      presetId: "youtube-1080p",
      fileName: "capa-mascara-sam",
    });
    const f = await frameRgb(
      await download((await waitOk(ex.jobId)).result.path, "capa-mascara-sam.mp4"),
      1,
      960,
    );
    const b = S2.box(0);
    const click = { x: (b.x + b.w / 2) / S2.W, y: (b.y + b.h / 2) / S2.H };
    const mx = Math.min(Math.max(0, click.x - 0.15), 0.7);
    const my = Math.min(Math.max(0, click.y - 0.2), 0.6);
    const inside = f.px((mx + 0.15) * 960, (my + 0.05) * 540);
    const outside = f.px(0.8 * 960, 0.2 * 540);
    const isRed = (c) => c[0] > 200 && c[1] < 60 && c[2] < 60;
    assert(
      !isRed(inside) && inside[0] < 90,
      `inside the SAM mask ${inside} (expected the top clip)`,
    );
    assert(isRed(outside), `outside the SAM mask ${outside} (expected the red bottom track)`);
    return { inside, outside };
  },
);

await step(
  "sprint3b: block-cache hash: stable re-export; blend / mask / Track.order change -> re-render",
  async () => {
    const { base, top } = await layersMedia();
    const p = await layersProject("E2E capas hash", base, top);
    const exportSeg = async () => {
      const { jobId } = await ok("POST", `/api/projects/${p.id}/export`, {
        presetId: "youtube-1080p",
        fileName: "capas-hash",
      });
      const r = (await waitOk(jobId)).result;
      assert(r.mode === "segments" && r.segments, `mode ${r.mode}`);
      return r.segments;
    };
    const save = async (mut) => {
      const cur = await ok("GET", `/api/projects/${p.id}`);
      mut(cur.tracks);
      await ok("PUT", `/api/projects/${p.id}`, cur);
    };
    const topClip = (tracks) => tracks.find((t) => t.name === "Video 2").clips[0];
    const out = { first: await exportSeg(), again: await exportSeg() };
    assert(
      out.again.rendered === 0 && out.again.cached === out.first.total,
      `again ${JSON.stringify(out.again)}`,
    );
    // blocks are content-addressed: values no other step exports (difference, feather 7)
    await save((t) => (topClip(t).blendMode = "difference"));
    out.blend = await exportSeg();
    await save(
      (t) =>
        (topClip(t).maskRef = {
          type: "shape",
          shape: "ellipse",
          x: 0.1,
          y: 0.1,
          w: 0.8,
          h: 0.8,
          feather: 7,
          invert: false,
        }),
    );
    out.mask = await exportSeg();
    await save((t) =>
      t.filter((x) => x.kind === "video").forEach((x, i, all) => (x.order = all.length - 1 - i)),
    );
    out.order = await exportSeg();
    await save((t) => {
      delete topClip(t).blendMode;
      delete topClip(t).maskRef;
      t.forEach((x) => delete x.order);
    });
    out.back = await exportSeg();
    for (const k of ["blend", "mask", "order"])
      assert(out[k].rendered >= 1, `${k}: nothing re-rendered ${JSON.stringify(out[k])}`);
    assert(
      out.back.rendered === 0,
      `back to the original: re-rendered ${JSON.stringify(out.back)}`,
    );
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, `${v.rendered}/${v.total}`]));
  },
);

await step(
  "sprint3b: Track.order kept by agent EditPlan apply (new track on top) and by stems (next to the source)",
  async () => {
    const lib = await sharedLib();
    const p0 = await ok("POST", "/api/projects", { name: "E2E orden z" }, [201]);
    // explicit z-order that differs from the array order (as after dragging tracks in the timeline)
    p0.tracks = p0.tracks.map((t, i, all) => ({ ...t, order: all.length - 1 - i }));
    const p = await ok("PUT", `/api/projects/${p0.id}`, p0);
    const before = Object.fromEntries(p.tracks.map((t) => [t.id, t.order]));
    const plan = {
      version: 1,
      summary_es: "Dos textos superpuestos",
      ops: [
        { op: "add_text", text: "Uno", t: 0, duration_s: 2 },
        { op: "add_text", text: "Dos", t: 0, duration_s: 2 },
      ],
    };
    const rec = await ok("POST", "/api/console/plans", { plan, projectId: p.id }, [201]);
    assert(rec.ok && rec.id, `plan ${JSON.stringify(rec).slice(0, 300)}`);
    const { jobId } = await ok("POST", "/api/agent/apply", { planId: rec.id }, [202]);
    const job = await waitOk(jobId);
    assert(job.result.applied === 2, `apply ${JSON.stringify(job.result)}`);
    const after = await ok("GET", `/api/projects/${p.id}`);
    for (const [tid, o] of Object.entries(before))
      assert(after.tracks.find((t) => t.id === tid)?.order === o, `track ${tid} order changed`);
    const added = after.tracks.filter((t) => !(t.id in before));
    assert(
      added.length === 1 && added[0].kind === "text",
      `new tracks ${added.map((t) => t.name)}`,
    );
    const z = lib.tracksInZOrder(after.tracks);
    assert(z.at(-1).id === added[0].id, `new track z ${z.map((t) => t.name)}`);
    // stems with explicit order: the stem tracks go right above the source track in z-order
    const stemsPack = (await ok("GET", "/api/ai/packs")).find((x) => x.id === "stems");
    let stems = "pack stems missing (skipped)";
    if (stemsPack?.installed) {
      const wav = path.join(WORK, "e2e-orden-stems.wav");
      await run(FFMPEG, ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=f=330:d=4", wav]);
      const src = await upload(wav, "audio/wav");
      await waitAssetJobs(src.id, ["media.probe"]);
      const cur = await ok("GET", `/api/projects/${p.id}`);
      const V = cur.tracks.find((t) => t.kind === "audio");
      const clipId = id("c");
      V.clips = [{ id: clipId, trackId: V.id, assetId: src.id, start: 0, in: 0, out: 4 }];
      await ok("PUT", `/api/projects/${p.id}`, cur);
      const r = await ok(
        "POST",
        "/api/audio/stems",
        { clipId, mode: "two", target: { projectId: p.id } },
        [202],
      );
      await waitOk(r.jobId, { timeoutMs: 180_000 });
      const saved = await ok("GET", `/api/projects/${p.id}`);
      const zs = lib.tracksInZOrder(saved.tracks);
      const at = zs.findIndex((t) => t.id === V.id);
      assert(
        zs[at + 1]?.name === "Voz" && zs[at + 2]?.name === "Música",
        `z ${zs.map((t) => t.name)}`,
      );
      assert(
        zs.every((t, i) => t.order === i),
        `orders ${zs.map((t) => t.order)}`,
      );
      assert(
        saved.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId).volume === 0,
        "source not muted",
      );
      stems = zs.map((t) => t.name).join(" < ");
    }
    return { agent: z.map((t) => t.name).join(" < "), stems };
  },
);
// ------------------------------------------------------------------ END sprint 3b integration

// ---------------------------------------------------------------- BEGIN sprint4:M2
// «Voz»: Chatterbox TTS + clonación. With scripts/e2e/workers-with-mocks.py the pack
// tts-chatterbox is reported installed and the real bridge runs with --mock (sine WAV of 0.06 s
// per character, 220 Hz / 330 Hz with a reference); STUDIO_MOCK_CHATTERBOX=0 -> 409 checks only.
const m2 = {};
async function m2Pack() {
  const pack = (await ok("GET", "/api/ai/packs")).find((x) => x.id === "tts-chatterbox");
  assert(pack, "pack «tts-chatterbox» not listed by GET /api/ai/packs");
  return pack;
}
async function m2Tts(body, wait = true) {
  const r = await api("POST", "/api/voice/tts", {
    provider: "chatterbox",
    text: "Hola, che. ¿Viste que mañana llueve?",
    ...body,
  });
  if (!wait || r.status !== 202) return r;
  return { ...r, job: await waitOk(r.json.jobId, { timeoutMs: 180_000 }) };
}
async function m2SampleWav(name, seconds) {
  const file = path.join(WORK, name);
  await run(FFMPEG, [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=180:duration=${seconds}:sample_rate=44100`,
    "-af",
    "volume=0.5",
    file,
  ]);
  return file;
}

await step("sprint4: tts chatterbox (mock) → asset voice-synthetic", async () => {
  const pack = await m2Pack();
  const providers = await ok("GET", "/api/voice/tts/providers");
  const row = providers.find((p) => p.id === "chatterbox");
  assert(row?.packId === "tts-chatterbox" && row.supportsClone === true, JSON.stringify(row));
  if (!pack.installed) {
    const r = await m2Tts({ voice: "chatterbox:multilingual" }, false);
    assert(r.status === 409 && r.json?.packId === "tts-chatterbox", `-> ${r.status}`);
    return "409 PACK_REQUIRED (workers without the pack / mocks off)";
  }
  assert(row.installed && row.status === "local", `provider row ${JSON.stringify(row)}`);
  const voices = await ok("GET", "/api/voice/tts/voices");
  assert(
    voices.some((v) => v.id === "chatterbox:multilingual" && v.installed),
    "chatterbox:multilingual voice not listed",
  );
  const text = "Hola, che. ¿Viste que mañana llueve?";
  const { job } = await m2Tts({ voice: "chatterbox:multilingual", text });
  const res = job.result;
  assert(
    res.provider === "chatterbox" && res.aiVoice === "synthetic" && res.watermark === "perth",
    `result ${JSON.stringify(res)}`,
  );
  assert(res.device === "cpu" || res.device === "cuda", `device ${res.device}`);
  const asset = await ok("GET", `/api/media/${res.assetId}`);
  assert(
    asset.aiAltered === true &&
      asset.aiProvenance?.kind === "voice-synthetic" &&
      /^chatterbox mtl-v[23]$/.test(asset.aiProvenance.tool),
    `asset ${JSON.stringify(asset)}`,
  );
  const f = await ffprobe(await download(res.path, "e2e-chatterbox.wav"));
  const a = f.streams.find((x) => x.codec_type === "audio");
  assert(a.sample_rate === "24000" && a.channels === 1, `wav ${a.sample_rate} Hz x${a.channels}`);
  assert(near(+f.format.duration, text.length * 0.06, 0.5), `duration ${f.format.duration}`);
  const progress = sseFor(job.id).filter((e) => /Chatterbox/.test(e.message ?? ""));
  return { device: res.device, rtf: res.rtf, warnings: res.warnings, sse: progress.length };
});
await step("sprint4: Voz propia → voice-ref + clon → voice-cloned", async () => {
  const pack = await m2Pack();
  const sample = await m2SampleWav("e2e-voz-propia.wav", 9);
  const form = (attest) => {
    const fd = new FormData();
    if (attest) fd.append("attestSelf", "true");
    return fd;
  };
  const bytes = await readFile(sample);
  const noAttest = form(false);
  noAttest.append("audio", new Blob([bytes], { type: "audio/wav" }), "voz.wav");
  // audit fix 1: «Voz propia» is HUMAN_ONLY (the web Origin; this node client plays the web)
  const anon = form(true);
  anon.append("audio", new Blob([bytes], { type: "audio/wav" }), "voz.wav");
  const human = await api("POST", "/api/voice/self-refs", anon);
  assert(
    human.status === 403 && human.json?.error?.code === "HUMAN_ONLY",
    `no Origin -> ${human.status}`,
  );
  const refused = await api("POST", "/api/voice/self-refs", noAttest, { headers: WEB_ORIGIN });
  assert(
    refused.status === 400 && refused.json?.error?.code === "ATTEST_SELF_REQUIRED",
    `without attestSelf -> ${refused.status}`,
  );
  const short = form(true);
  short.append(
    "audio",
    new Blob([await readFile(await m2SampleWav("e2e-corta.wav", 3))], { type: "audio/wav" }),
    "corta.wav",
  );
  const tooShort = await api("POST", "/api/voice/self-refs", short, { headers: WEB_ORIGIN });
  assert(
    tooShort.status === 400 && tooShort.json?.error?.code === "VOICE_SAMPLE_INVALID",
    `3 s sample -> ${tooShort.status}`,
  );
  const good = form(true);
  good.append("audio", new Blob([bytes], { type: "audio/wav" }), "voz propia.wav");
  const ref = await ok("POST", "/api/voice/self-refs", good, [201], { headers: WEB_ORIGIN });
  assert(ref.kind === "voice-ref" && ref.sampleRate === 24000, `ref ${JSON.stringify(ref)}`);
  const f = await ffprobe(await download(ref.path, "e2e-voice-ref.wav"));
  const a = f.streams.find((x) => x.codec_type === "audio");
  assert(a.sample_rate === "24000" && a.channels === 1, `voice-ref ${a.sample_rate}x${a.channels}`);
  const listed = await ok("GET", "/api/voice/self-refs");
  assert(listed[0]?.id === ref.id, "the new voice-ref is not the first listed");
  m2.selfRef = ref;
  if (!pack.installed) return "voice-ref ok; clone skipped (no pack)";
  const { job } = await m2Tts({ voice: "chatterbox:self", cfg: 0.3 });
  assert(job.result.aiVoice === "cloned", `result ${JSON.stringify(job.result)}`);
  const asset = await ok("GET", `/api/media/${job.result.assetId}`);
  assert(
    asset.aiProvenance?.kind === "voice-cloned" &&
      asset.aiProvenance.self === true &&
      asset.aiProvenance.sourceAssetId === ref.id,
    `provenance ${JSON.stringify(asset.aiProvenance)}`,
  );
  // explicit voiceRef wins; a non voice-ref asset is refused
  const explicit = await m2Tts({ voice: "x", voiceRef: { assetId: ref.id, self: true } });
  assert(explicit.job.result.aiVoice === "cloned", "explicit voiceRef not cloned");
  const notRef = await m2Tts(
    { voice: "x", voiceRef: { assetId: job.result.assetId, self: true } },
    false,
  );
  assert(
    notRef.status === 400 && notRef.json?.error?.code === "INVALID_VOICE_REF",
    `audio asset as voiceRef -> ${notRef.status}`,
  );
  return { voiceRef: ref.id, durationSec: ref.durationSec, cloned: asset.id };
});

await step("sprint4: voiceRef Persona sin consentimiento de voz → 403", async () => {
  const person = await ok("POST", "/api/persons", { name: "E2E sin consentimiento" }, [200, 201]);
  const r = await m2Tts({ voice: `chatterbox:person:${person.id}` }, false);
  const pack = await m2Pack();
  if (!pack.installed) {
    assert(r.status === 409 && r.json?.packId === "tts-chatterbox", `-> ${r.status}`);
    return "409 PACK_REQUIRED first (no pack)";
  }
  assert(r.status === 403, `-> ${r.status} ${JSON.stringify(r.json)}`);
  assert(
    r.json.error.code === "CONSENT_REQUIRED" &&
      r.json.error.details?.personId === person.id &&
      r.json.error.details?.scope === "voice",
    JSON.stringify(r.json),
  );
  const viaRef = await m2Tts({ voice: "x", voiceRef: { personId: person.id } }, false);
  assert(viaRef.status === 403, `voiceRef.personId -> ${viaRef.status}`);
  const missing = await m2Tts({ voice: "chatterbox:person:no-existe" }, false);
  assert(
    missing.status === 404 && missing.json?.error?.code === "PERSON_NOT_FOUND",
    `unknown person -> ${missing.status}`,
  );
  await api("DELETE", `/api/persons/${person.id}?confirm=1`);
  return r.json.error.message;
});

await step(
  "sprint4: sin pack tts-chatterbox → 409; op tts del Asistente sigue en Piper",
  async () => {
    const pack = await m2Pack();
    let packCheck = "pack installed by the mocks (409 covered by api vitest)";
    if (!pack.installed) {
      const r = await m2Tts({ voice: "chatterbox:multilingual" }, false);
      assert(r.status === 409 && r.json?.error === "PACK_REQUIRED", `-> ${r.status}`);
      assert(r.json.packId === "tts-chatterbox", JSON.stringify(r.json));
      packCheck = "409 PACK_REQUIRED tts-chatterbox";
    }
    const p = await ok("POST", "/api/projects", { name: "E2E asistente voz" }, [201]);
    const before = new Set(
      (await ok("GET", "/api/jobs?type=voice.tts&limit=200")).map((j) => j.id),
    );
    const applyTts = async (op) => {
      const plan = { version: 1, summary_es: "Agrego una locución.", ops: [op] };
      const rec = await ok("POST", "/api/console/plans", { plan, projectId: p.id }, [201]);
      const { jobId } = await ok("POST", "/api/agent/apply", { planId: rec.id }, [202]);
      await waitJob(jobId, { timeoutMs: 180_000 });
      const sub = (await ok("GET", "/api/jobs?type=voice.tts&limit=200")).find(
        (j) => !before.has(j.id),
      );
      assert(sub, "agent.apply did not create a voice.tts sub-job");
      before.add(sub.id);
      return sub;
    };
    const piper = await applyTts({ op: "tts", text: "Hola desde el asistente", t: 0 });
    assert(piper.payload?.provider === "piper", `default op tts -> ${piper.payload?.provider}`);
    let chatter = "skipped (no pack or no «Voz propia»)";
    if (pack.installed && m2.selfRef) {
      const sub = await applyTts({
        op: "tts",
        text: "Hola con mi voz",
        t: 0,
        voice: "chatterbox:self",
      });
      assert(sub.payload?.provider === "chatterbox", `chatterbox:self -> ${sub.payload?.provider}`);
      const done = await waitJob(sub.id, { timeoutMs: 180_000 });
      assert(done.status === "succeeded", `sub-job ${done.status}: ${done.error}`);
      assert(done.result?.aiVoice === "cloned", `sub-job result ${JSON.stringify(done.result)}`);
      chatter = "chatterbox:self -> cloned";
    }
    return { packCheck, piperStatus: piper.status, chatter };
  },
);
// ------------------------------------------------------------------ END sprint4:M2

// ---------------------------------------------------------------- BEGIN sprint4:M1
// «Caras»: Personas + consentimiento + cambio de cara. With scripts/e2e/workers-with-mocks.py the
// packs faceswap / faceswap-extra are reported installed and FaceFusion is the fake
// scripts/e2e/fake_facefusion/facefusion.py (box on the face; a photo ending with NSFW-TEST ->
// content analyser rejection). STUDIO_MOCK_FACE=0 on the workers -> only the 403/409 checks.
const m1 = { origin: WEB_ORIGIN };
async function m1Png(name, color = "gray", extra) {
  const file = path.join(WORK, name);
  await run(FFMPEG, ["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=320x320`,
    "-frames:v", "1", "-update", "1", file]); // prettier-ignore
  if (extra) await writeFile(file, Buffer.concat([await readFile(file), Buffer.from(extra)]));
  return file;
}
async function m1Form(fields, files) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const [k, f] of Object.entries(files))
    fd.append(k, new Blob([await readFile(f.file)], { type: f.type }), f.name);
  return fd;
}
async function m1Person(name, { consent = true, marker } = {}) {
  const p = await ok("POST", "/api/persons", { name }, [201]);
  const photo = await m1Png(`m1-${p.id}.png`, "gray", marker);
  const fd = await m1Form({}, { photo: { file: photo, name: "cara.png", type: "image/png" } });
  // audit fix 3: Person photos are uploaded from the web only (HUMAN_ONLY)
  const up = await api("POST", `/api/persons/${p.id}/photos`, fd, { headers: m1.origin });
  assert(up.status === 200, `photo ${up.status} ${JSON.stringify(up.json).slice(0, 300)}`);
  if (consent) {
    const r = await m1Consent(p.id, m1.origin);
    assert(r.status === 201, `consent ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
  }
  return ok("GET", `/api/persons/${p.id}`);
}
async function m1Consent(personId, headers = {}, scope = "face") {
  // a real stroke: a blank (all white / transparent) signature is refused (audit fix 16)
  const sig = path.join(WORK, `m1-firma-${personId}.png`);
  await run(FFMPEG, ["-y", "-v", "error", "-f", "lavfi", "-i",
    "color=c=white:s=240x90,drawbox=x=20:y=40:w=200:h=6:color=black:t=fill",
    "-frames:v", "1", "-update", "1", sig]); // prettier-ignore
  const fd = await m1Form(
    { scope, method: "firma en pantalla", signer_name: "E2E Doble", text_version: "2026-10-06",
      accept: "true" }, // prettier-ignore
    { evidence: { file: sig, name: "firma.png", type: "image/png" } },
  );
  return api("POST", `/api/persons/${personId}/consents`, fd, { headers });
}
async function m1Licence(accept = true) {
  const route = `/api/ai/licences/faceswap/${accept ? "accept" : "revoke"}`;
  return api("POST", route, accept ? { text_version: "2026-10-06", accept: true } : undefined, {
    headers: m1.origin,
  });
}
async function m1Clip() {
  if (!m1.video) {
    const file = path.join(WORK, "m1-doble.mp4");
    await run(FFMPEG, ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=3",
      "-f", "lavfi", "-i", "sine=f=440:d=3", "-shortest", "-c:v", "libx264", "-preset", "ultrafast",
      "-pix_fmt", "yuv420p", "-c:a", "aac", file]); // prettier-ignore
    m1.video = await upload(file, "video/mp4");
    await waitAssetJobs(m1.video.id, ["media.probe"]);
  }
  const p0 = await ok("POST", "/api/projects", { name: `E2E cara ${id("p")}` }, [201]);
  const V = p0.tracks.find((t) => t.kind === "video");
  const clipId = id("c");
  V.clips = [{ id: clipId, trackId: V.id, assetId: m1.video.id, start: 0.5, in: 0.5, out: 2.5 }];
  return { project: await ok("PUT", `/api/projects/${p0.id}`, p0), clipId };
}
const m1Packs = async () => (await ok("GET", "/api/ai/packs")).find((x) => x.id === "faceswap");

await step("sprint4: persons CRUD + consentimiento firmado + HUMAN_ONLY", async () => {
  const p = await m1Person("E2E Persona", { consent: false });
  assert(p.photos.length === 1 && p.photos[0].width === 320, `photos ${JSON.stringify(p.photos)}`);
  const noOrigin = await m1Consent(p.id, {});
  assert(noOrigin.status === 403 && noOrigin.json.error.code === "HUMAN_ONLY", "no Origin");
  const mcp = await m1Consent(p.id, { ...m1.origin, "X-Studio-Client": "mcp" });
  assert(mcp.status === 403 && mcp.json.error.code === "HUMAN_ONLY", "X-Studio-Client: mcp");
  const okc = await m1Consent(p.id, m1.origin, "both");
  assert(okc.status === 201 && okc.json.text_sha256?.length === 64, `consent ${okc.status}`);
  const list = await ok("GET", "/api/persons?scope=face");
  const row = list.find((x) => x.id === p.id);
  assert(row?.face === "vigente" && row.voice === "vigente", `summary ${JSON.stringify(row)}`);
  const files = await fetch(`${API}/files/${okc.json.evidence_path}`);
  assert(files.status === 404, `/files/consent/... -> ${files.status} (404 expected)`);
  const lic = await fetch(`${API}/files/consent/licences.json`);
  assert(lic.status === 404, `/files/consent/licences.json -> ${lic.status}`);
  const del = await api("DELETE", `/api/persons/${p.id}`);
  assert(del.status === 409, `delete without confirm -> ${del.status}`);
  await ok("DELETE", `/api/persons/${p.id}?confirm=1`, undefined, [204]);
  const gone = await api("GET", `/api/persons/${p.id}`);
  assert(gone.status === 404 && gone.json.error.code === "PERSON_NOT_FOUND", "deleted person");
  return { consent: okc.json.id, faces: p.photos[0].faces };
});

await step("sprint4: face.swap 403 LICENCE_REQUIRED / CONSENT_REQUIRED / revocado", async () => {
  await m1Licence(false).catch(() => undefined);
  const { project, clipId } = await m1Clip();
  const nobody = await m1Person("E2E Sin consentimiento", { consent: false });
  const body = (personId) => ({
    personId,
    assetId: m1.video.id,
    target: { projectId: project.id, clipId },
    confirmed: true,
  });
  const lic = await api("POST", "/api/face/swap", body(nobody.id));
  assert(lic.status === 403 && lic.json.error.code === "LICENCE_REQUIRED", `licence ${lic.status}`);
  const gated = await api("POST", "/api/ai/packs/faceswap/download");
  assert(
    gated.status === 403 && gated.json.error.code === "LICENCE_REQUIRED",
    "pack download gate",
  );
  const accepted = await m1Licence(true);
  assert(accepted.status === 200, `accept ${accepted.status}`);
  const pack = await m1Packs();
  const noConsent = await api("POST", "/api/face/swap", body(nobody.id));
  if (pack?.installed) {
    assert(
      noConsent.status === 403 && noConsent.json.error.details.reason === "none",
      `consent ${noConsent.status} ${JSON.stringify(noConsent.json).slice(0, 200)}`,
    );
  } else assert(noConsent.status === 409, `pack missing -> ${noConsent.status}`);
  const rev = await m1Person("E2E Revocado");
  await ok("POST", `/api/persons/${rev.id}/consents/${rev.consents[0].id}/revoke`);
  const revoked = await api("POST", "/api/face/swap", body(rev.id));
  if (pack?.installed)
    assert(
      revoked.status === 403 && revoked.json.error.details.reason === "revoked",
      `revoked ${revoked.status}`,
    );
  const noConfirm = await api("POST", "/api/face/swap", { ...body(rev.id), confirmed: undefined });
  assert(noConfirm.status === 409 && noConfirm.json.error.code === "CONFIRM_REQUIRED", "confirm");
  return { packInstalled: !!pack?.installed, tool: pack?.tool?.state ?? null };
});

await step("sprint4: face.swap mock → asset aiAltered + clip.faceSwap + undo", async () => {
  const pack = await m1Packs();
  assert(pack?.installed, "pack faceswap not installed (workers-with-mocks STUDIO_MOCK_FACE)");
  await m1Licence(true);
  const person = await m1Person("E2E Doble Martín");
  const { project, clipId } = await m1Clip();
  const det = await ok("POST", "/api/face/detect", { assetId: m1.video.id, t: 1 });
  assert(det.faces.length >= 1 && det.framePath.endsWith(".png"), `detect ${JSON.stringify(det)}`);
  const pv = await ok("POST", "/api/face/preview", {
    personId: person.id,
    assetId: m1.video.id,
    t: 1,
    selector: { mode: "reference", t: 1, faceIndex: 0 },
  }, [202]); // prettier-ignore
  const preview = (await waitOk(pv.jobId, { timeoutMs: 120_000 })).result;
  await download(preview.afterPath, "m1-after.png");
  const r = await ok("POST", "/api/face/swap", {
    personId: person.id,
    assetId: m1.video.id,
    options: { strength: 0.8, enhancer: false },
    target: { projectId: project.id, clipId },
    confirmed: true,
  }, [202]); // prettier-ignore
  const res = (await waitOk(r.jobId, { timeoutMs: 180_000 })).result;
  const asset = await ok("GET", `/api/media/${res.assetId}`);
  assert(
    asset.aiAltered === true && asset.aiProvenance?.kind === "face" &&
      asset.aiProvenance.personId === person.id && asset.aiProvenance.licences[0] === "faceswap",
    `asset ${JSON.stringify(asset).slice(0, 400)}`,
  ); // prettier-ignore
  const out = await download(res.path, "m1-faceswap.mp4");
  const st = (await ffprobe(out)).streams;
  const dur = Number((await ffprobe(out)).format.duration);
  assert(st.some((s) => s.codec_type === "audio") && near(dur, 2, 0.2), `output ${dur} s`);
  const f = await frameRgb(out, 1, 320);
  const center = f.px(160, 60);
  assert(center[0] > 120 && center[1] < 110, `fake box not drawn: ${center}`);
  const saved = await ok("GET", `/api/projects/${project.id}`);
  const clip = saved.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
  assert(
    clip.assetId === res.assetId && clip.in === 0 && clip.faceSwap?.prev.assetId === m1.video.id,
    `clip ${JSON.stringify(clip).slice(0, 300)}`,
  );
  assert(saved.publish?.flags?.aiFace === true, "publish.flags.aiFace");
  const undone = await ok("POST", "/api/face/undo", { projectId: project.id, clipId });
  const back = undone.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
  assert(back.assetId === m1.video.id && back.in === 0.5 && !back.faceSwap, "undo");
  return { frames: res.frames, device: res.device, preview: preview.afterPath, center };
});

await step("sprint4: NSFW mock → CONTENT_BLOCKED", async () => {
  const pack = await m1Packs();
  assert(pack?.installed, "pack faceswap not installed (workers-with-mocks STUDIO_MOCK_FACE)");
  await m1Licence(true);
  // like the real analyser, the fake screens the TARGET video (never the Persona's photos): the
  // marker goes in the video's metadata (Studio's trim keeps it); the source photo is plain
  const person = await m1Person("E2E Contenido");
  const marked = path.join(WORK, "m1-nsfw.mp4");
  await run(FFMPEG, ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=3",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-metadata", "title=NSFW-TEST", marked]); // prettier-ignore
  const video = await upload(marked, "video/mp4");
  await waitAssetJobs(video.id, ["media.probe"]);
  const p0 = await ok("POST", "/api/projects", { name: `E2E nsfw ${id("p")}` }, [201]);
  const V = p0.tracks.find((t) => t.kind === "video");
  const clipId = id("c");
  V.clips = [{ id: clipId, trackId: V.id, assetId: video.id, start: 0, in: 0.5, out: 2.5 }];
  const project = await ok("PUT", `/api/projects/${p0.id}`, p0);
  const r = await ok("POST", "/api/face/swap", {
    personId: person.id,
    assetId: video.id,
    target: { projectId: project.id, clipId },
    confirmed: true,
  }, [202]); // prettier-ignore
  const job = await waitJob(r.jobId, { timeoutMs: 120_000 });
  assert(job.status === "failed", `status ${job.status}`);
  const full = await ok("GET", `/api/jobs/${r.jobId}`);
  assert(full.result?.error?.code === "CONTENT_BLOCKED", `result ${JSON.stringify(full.result)}`);
  const saved = await ok("GET", `/api/projects/${project.id}`);
  const clip = saved.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
  assert(!clip.faceSwap && clip.assetId === video.id, "clip untouched");
  // fail closed + audit fix 19: no asset and no partial files of the job
  const leftovers = await fetch(`${API}/files/renders/face/${r.jobId}/source.mp4`);
  assert(
    leftovers.status === 404,
    `renders/face/<job>/source.mp4 left behind (${leftovers.status})`,
  );
  return { error: job.error };
});

await step("sprint4: EditPlan face_swap sin confirmedIndexes → 409", async () => {
  await m1Licence(true);
  // unique name: a re-run on the same storage must not make the name ambiguous (a question)
  const name = `E2E Plan Lucía ${id("r")}`;
  const person = await m1Person(name);
  const { project, clipId } = await m1Clip();
  const plan = {
    version: 1,
    summary_es: "Cara de Lucía en el doble.",
    ops: [{ op: "face_swap", clip: { id: clipId }, person: { name: name.toLowerCase() } }],
  };
  const rec = await ok("POST", "/api/console/plans", { plan, projectId: project.id }, [201]);
  assert(
    rec.ok && rec.resolved[0].person.id === person.id,
    `plan ${JSON.stringify(rec).slice(0, 300)}`,
  );
  const r = await api("POST", "/api/agent/apply", { planId: rec.id });
  assert(r.status === 409 && r.json.error.code === "CONFIRM_REQUIRED", `apply ${r.status}`);
  return { preview: rec.preview_es[0] };
});

await step("sprint4: studio_face_swap por stdio sin confirmed → rechazado", async () => {
  const entry = path.join(REPO, "packages", "studio-mcp", "dist", "index.js");
  assert(existsSync(entry), "packages/studio-mcp/dist missing (pnpm build:packages)");
  const child = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, STUDIO_API_URL: API },
    windowsHide: true,
  });
  let buf = "";
  const waiting = new Map();
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) {
        const msg = JSON.parse(line);
        waiting.get(msg.id)?.(msg);
      }
    }
  });
  let n = 0;
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const rid = ++n;
      const timer = setTimeout(() => resolve({ error: { message: `timeout ${method}` } }), 30_000);
      waiting.set(rid, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }) + "\n");
    });
  try {
    await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "e2e", version: "1" },
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );
    const { project, clipId } = await m1Clip();
    const before = (await ok("GET", "/api/jobs?type=face.swap&limit=500")).length;
    const msg = await rpc("tools/call", {
      name: "studio_face_swap",
      arguments: { projectId: project.id, clipId, personId: "x" },
    });
    const rejected = !!msg.error || msg.result?.isError === true;
    assert(rejected, `not rejected: ${JSON.stringify(msg).slice(0, 300)}`);
    const after = (await ok("GET", "/api/jobs?type=face.swap&limit=500")).length;
    assert(after === before, "a face.swap job was created");
    const persons = await rpc("tools/call", { name: "studio_list_persons", arguments: {} });
    const text = persons.result?.content?.[0]?.text ?? "";
    assert(!persons.result?.isError && !text.includes("consent/"), `list ${text.slice(0, 200)}`);
    return { rejected: (msg.error?.message ?? msg.result?.content?.[0]?.text ?? "").slice(0, 120) };
  } finally {
    child.kill();
  }
});
// ------------------------------------------------------------------ END sprint4:M1

// ---------------------------------------------------------------- BEGIN sprint4:M3
// «Herramientas»: licence-gated face swap packs end to end, perf.json sprint 4 fields, the AI
// `comment` metadata of exports and the RVC device. With scripts/e2e/workers-with-mocks.py the
// faceswap pack download is a fake install (still behind the workers licence check), Chatterbox
// runs its --mock bridge and RVC has a fake voice «e2e-voz» (STUDIO_MOCK_RVC=0 turns it off).
const M3_WEB = { origin: "http://localhost:3000" }; // assertHumanOrigin: the Studio web
async function m3Licence() {
  const all = await ok("GET", "/api/ai/licences");
  const lic = all.find((l) => l.id === "faceswap");
  assert(lic, "GET /api/ai/licences without «faceswap»");
  return lic;
}
async function m3SetLicence(accepted) {
  const lic = await m3Licence();
  if (lic.accepted === accepted) return lic;
  const route = `/api/ai/licences/faceswap/${accepted ? "accept" : "revoke"}`;
  const r = await api(
    "POST",
    route,
    accepted ? { text_version: lic.text_version, accept: true } : {},
    { headers: M3_WEB },
  );
  assert(r.status === 200, `${route} -> ${r.status} ${JSON.stringify(r.json)?.slice(0, 300)}`);
  return m3Licence();
}

await step(
  "sprint4: licencia de cambio de cara de punta a punta (pack 403 → aceptar con Origin → descarga mock → revocar → face.swap 403)",
  async () => {
    const before = await m3Licence();
    await m3SetLicence(false);
    const pack = (await ok("GET", "/api/ai/packs")).find((p) => p.id === "faceswap");
    assert(
      pack?.licence_gate === "faceswap",
      `pack faceswap licence_gate: ${JSON.stringify(pack)}`,
    );
    const denied = await api("POST", "/api/ai/packs/faceswap/download", {});
    assert(
      denied.status === 403 && JSON.stringify(denied.json).includes("LICENCE_REQUIRED"),
      `download without licence -> ${denied.status} ${JSON.stringify(denied.json)?.slice(0, 300)}`,
    );
    // the MCP / console can never accept it (HUMAN_ONLY), the web can
    const mcp = await api(
      "POST",
      "/api/ai/licences/faceswap/accept",
      { text_version: before.text_version, accept: true },
      { headers: { ...M3_WEB, "x-studio-client": "mcp" } },
    );
    assert(mcp.status === 403, `accept from mcp -> ${mcp.status}`);
    const accepted = await m3SetLicence(true);
    assert(accepted.accepted && accepted.acceptance?.accepted_at, "licence not accepted");
    const { jobId } = await ok("POST", "/api/ai/packs/faceswap/download", {}, [202]);
    const job = await waitOk(jobId, { timeoutMs: 120_000 });
    await m3SetLicence(false);
    const swap = await api("POST", "/api/face/swap", {
      personId: "e2e-nadie",
      assetId: ctx.vAsset?.id ?? "e2e-nada",
      confirmed: true,
    });
    assert(
      swap.status === 403 && JSON.stringify(swap.json).includes("LICENCE_REQUIRED"),
      `face.swap after revoking -> ${swap.status} ${JSON.stringify(swap.json)?.slice(0, 300)}`,
    );
    if (before.accepted) await m3SetLicence(true); // leave it as it was
    return { download: job.status, mcpAccept: mcp.status, swapAfterRevoke: swap.status };
  },
);

await step("sprint4: perf.json con campos nuevos y motivos", async () => {
  const { jobId } = await ok("POST", "/api/ai/perf/run", {}, [202]);
  await waitOk(jobId, { timeoutMs: 1_200_000 });
  const perf = await ok("GET", "/api/ai/perf");
  for (const key of [
    "rvc_device",
    "chatterbox_rtf",
    "chatterbox_device",
    "facefusion_fps",
    "facefusion_enh_fps",
    "facefusion_device",
  ])
    assert(key in perf, `perf.json without ${key}: ${JSON.stringify(perf).slice(0, 300)}`);
  assert(
    perf.tools?.facefusion?.state && perf.tools?.chatterbox?.state,
    `perf.json tools: ${JSON.stringify(perf.tools)}`,
  );
  // every component is either measured or has a Spanish reason
  const cb = perf.chatterbox_rtf ?? perf.skipped?.chatterbox ?? perf.errors?.chatterbox;
  const ff = perf.facefusion_fps ?? perf.skipped?.facefusion ?? perf.errors?.facefusion;
  assert(cb != null && ff != null, `chatterbox/facefusion without value nor reason`);
  const lic = await m3Licence();
  if (!lic.accepted && perf.facefusion_fps == null && perf.skipped?.facefusion)
    assert(
      /licencia no aceptada|no instalado|Persona/.test(perf.skipped.facefusion),
      `facefusion reason: ${perf.skipped.facefusion}`,
    );
  return { chatterbox: cb, facefusion: ff, tools: perf.tools, rvc: perf.rvc_device ?? null };
});

await step("sprint4: export con metadato comment de IA", async () => {
  const pack = (await ok("GET", "/api/ai/packs")).find((p) => p.id === "tts-chatterbox");
  const src = path.join(WORK, "e2e-m3-gris.mp4");
  await run(FFMPEG, [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x404040:s=640x360:r=25:d=3",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    src,
  ]);
  const video = await upload(src, "video/mp4");
  await waitAssetJobs(video.id, ["media.probe"]);
  const p = await ok("POST", "/api/projects", { name: "E2E metadato IA" }, [201]);
  const V = p.tracks.find((t) => t.kind === "video");
  const A = p.tracks.find((t) => t.kind === "audio");
  V.clips = [{ id: id("c"), trackId: V.id, assetId: video.id, start: 0, in: 0, out: 3 }];
  const exportComment = async (name) => {
    await ok("PUT", `/api/projects/${p.id}`, p);
    const { jobId } = await ok("POST", `/api/projects/${p.id}/export`, {
      presetId: "youtube-1080p",
      fileName: name,
    });
    const job = await waitOk(jobId);
    const file = await download(job.result.path, `${name}.mp4`);
    return (await ffprobe(file)).format?.tags?.comment;
  };
  const plain = await exportComment("m3-sin-ia");
  assert(plain === undefined, `comment without AI content: ${plain}`);
  if (!pack?.installed) return "tts-chatterbox not installed (mocks off): only the no-AI case";
  const r = await ok("POST", "/api/voice/tts", {
    provider: "chatterbox",
    voice: "chatterbox:multilingual",
    text: "Hola, esto es una voz sintética.",
  });
  const tts = await waitOk(r.jobId, { timeoutMs: 180_000 });
  const voice = await ok("GET", `/api/media/${tts.result.assetId}`);
  assert(voice.aiProvenance?.kind === "voice-synthetic", `tts asset ${JSON.stringify(voice)}`);
  A.clips = [{ id: id("c"), trackId: A.id, assetId: voice.id, start: 0, in: 0, out: 2 }];
  // the visible label stays OFF (internal use): the comment is there anyway (decision 9)
  const comment = await exportComment("m3-con-ia");
  assert(
    comment ===
      "Editado con Studio; contenido alterado con IA: cara sintética: no; voz clonada: no; voz sintética: sí",
    `comment: ${comment}`,
  );
  return { comment };
});

await step("sprint4: RVC informa device (cpu en CI)", async () => {
  const models = await ok("GET", "/api/voice/rvc/models");
  if (!models.some((m) => m.id === "e2e-voz"))
    return "sin el mock de RVC (STUDIO_MOCK_RVC=0): no hay voz de prueba";
  const base = (await ok("GET", "/api/ai/packs")).find((p) => p.id === "rvc-base");
  if (!base?.installed) return "rvc-base no instalado (workers sin el mock de RVC)";
  const { jobId } = await ok("POST", "/api/voice/rvc", {
    assetId: ctx.sAsset.id,
    modelId: "e2e-voz",
    pitchShift: 2,
    f0Method: "pm",
  });
  const job = await waitOk(jobId, { timeoutMs: 120_000 });
  assert(["cpu", "cuda"].includes(job.result.device), `device: ${JSON.stringify(job.result)}`);
  return { device: job.result.device, warnings: job.result.warnings ?? [] };
});
// ------------------------------------------------------------------ END sprint4:M3

// ---------------------------------------------------------------- BEGIN sprint4:integración
// Seams no single module checks: the M1 face swap and the M2 cloned voice (and what RVC and the
// voice effects derive from it, with the provenance M3 inherits) -> «Revisión para redes»
// detection and the export `comment` (M3), before and after undoing the swap; and perf.run (M3)
// measuring FaceFusion through the workers' FaceEngine (M1) with the Persona the ConsentGate
// (M1) picks. Needs the mocks of scripts/e2e/workers-with-mocks.py (packs reported installed).
const S4I_AI = "Editado con Studio; contenido alterado con IA: ";
async function s4iComment(project, name) {
  await ok("PUT", `/api/projects/${project.id}`, project);
  const { jobId } = await ok("POST", `/api/projects/${project.id}/export`, {
    presetId: "youtube-1080p",
    fileName: name,
  });
  const job = await waitOk(jobId);
  const file = await download(job.result.path, `${name}.mp4`);
  return (await ffprobe(file)).format?.tags?.comment;
}
async function s4iSelfRef() {
  const refs = await ok("GET", "/api/voice/self-refs");
  if (refs.length) return refs[0];
  const fd = new FormData();
  fd.append("attestSelf", "true");
  const wav = await m2SampleWav("s4i-voz-propia.wav", 9);
  fd.append("audio", new Blob([await readFile(wav)], { type: "audio/wav" }), "voz.wav");
  return ok("POST", "/api/voice/self-refs", fd, [201], { headers: WEB_ORIGIN });
}

await step(
  "sprint4 integración: cara (M1) + voz clonada (M2) → RVC y efecto heredan → comment del export (M3) antes y después de deshacer",
  async () => {
    const face = await m1Packs();
    const voice = await m2Pack();
    if (!face?.installed || !voice.installed)
      return "packs faceswap / tts-chatterbox not installed (workers without the mocks)";
    const lic = await m3Licence();
    await m3SetLicence(true);
    try {
      const person = await m1Person(`E2E Integración ${id("n")}`);
      const { project, clipId } = await m1Clip();
      const r = await ok("POST", "/api/face/swap", {
        personId: person.id,
        assetId: m1.video.id,
        target: { projectId: project.id, clipId },
        confirmed: true,
      }, [202]); // prettier-ignore
      const swap = (await waitOk(r.jobId, { timeoutMs: 180_000 })).result;
      await s4iSelfRef();
      const { job } = await m2Tts({ voice: "chatterbox:self" });
      const cloned = job.result.assetId;
      assert(job.result.aiVoice === "cloned", `tts ${JSON.stringify(job.result)}`);
      // voice.effect (M3 inheritance) over the clone keeps «voice-cloned»
      const fxJob = await ok("POST", "/api/voice/effects", {
        assetId: cloned,
        effects: [{ type: "robot", intensity: 0.5 }],
      });
      const fx = await ok("GET", `/api/media/${(await waitOk(fxJob.jobId)).result.assetId}`);
      assert(
        fx.aiAltered === true &&
          fx.aiProvenance?.kind === "voice-cloned" &&
          fx.aiProvenance.sourceAssetId === cloned,
        `voice.effect provenance ${JSON.stringify(fx.aiProvenance)}`,
      );
      // RVC (M2 handler) over the clone: same kind, pointing back at it, with the RVC job id
      let rvc = "sin el mock de RVC";
      const models = await ok("GET", "/api/voice/rvc/models");
      const base = (await ok("GET", "/api/ai/packs")).find((p) => p.id === "rvc-base");
      if (models.some((m) => m.id === "e2e-voz") && base?.installed) {
        const rv = await ok("POST", "/api/voice/rvc", {
          assetId: cloned,
          modelId: "e2e-voz",
          pitchShift: 0,
          f0Method: "pm",
        });
        const rj = await waitOk(rv.jobId, { timeoutMs: 120_000 });
        const ra = await ok("GET", `/api/media/${rj.result.assetId}`);
        assert(
          ra.aiProvenance?.kind === "voice-cloned" &&
            ra.aiProvenance.sourceAssetId === cloned &&
            ra.aiProvenance.jobId === rv.jobId,
          `RVC provenance ${JSON.stringify(ra.aiProvenance)}`,
        );
        rvc = `${ra.aiProvenance.kind} (${rj.result.device})`;
      }
      const saved = await ok("GET", `/api/projects/${project.id}`);
      assert(saved.publish?.flags?.aiFace === true, "publish.flags.aiFace after the swap");
      assert(saved.publish?.aiLabel !== true, "the visible label must stay off (internal use)");
      const A = saved.tracks.find((t) => t.kind === "audio");
      A.clips = [{ id: id("c"), trackId: A.id, assetId: fx.id, start: 0, in: 0, out: 1.5 }];
      const both = await s4iComment(saved, "s4i-cara-voz");
      const want = (cara) => `${S4I_AI}cara sintética: ${cara}; voz clonada: sí; voz sintética: no`;
      assert(both === want("sí"), `comment with face + cloned voice: ${both}`);
      await ok("POST", "/api/face/undo", { projectId: project.id, clipId });
      const undone = await s4iComment(
        await ok("GET", `/api/projects/${project.id}`),
        "s4i-sin-cara",
      );
      assert(undone === want("no"), `comment after undoing the face swap: ${undone}`);
      return { swap: swap.assetId, effect: fx.aiProvenance.kind, rvc, both, undone };
    } finally {
      if (!lic.accepted) await m3SetLicence(false);
    }
  },
);

await step(
  "sprint4 integración: perf.run mide FaceFusion por el FaceEngine (M1) con la Persona del gate",
  async () => {
    const face = await m1Packs();
    if (!face?.installed) return "pack faceswap not installed (workers without the mocks)";
    const lic = await m3Licence();
    await m3SetLicence(true);
    // benchFaceSource() takes the first Persona by name with a face consent: «0 …» goes first
    // (the e2e «E2E Contenido» photo is the content-analyser one and would end CONTENT_BLOCKED).
    const person = await m1Person(`0 E2E Banco ${id("n")}`);
    try {
      const { jobId } = await ok("POST", "/api/ai/perf/run", {}, [202]);
      await waitOk(jobId, { timeoutMs: 1_200_000 });
      const perf = await ok("GET", "/api/ai/perf");
      const why = perf.errors?.facefusion ?? perf.skipped?.facefusion ?? null;
      assert(
        typeof perf.facefusion_fps === "number" && perf.facefusion_fps > 0,
        `facefusion_fps ${perf.facefusion_fps} (${why})`,
      );
      assert(
        ["cpu", "cuda"].includes(perf.facefusion_device) &&
          perf.facefusion_model === "hyperswap_1a_256",
        `facefusion device/model ${perf.facefusion_device} ${perf.facefusion_model}`,
      );
      assert(typeof perf.chatterbox_rtf === "number", `chatterbox_rtf ${perf.chatterbox_rtf}`);
      return {
        fps: perf.facefusion_fps,
        enh_fps: perf.facefusion_enh_fps,
        startup_s: perf.facefusion_startup_s,
        device: perf.facefusion_device,
        chatterbox_rtf: perf.chatterbox_rtf,
      };
    } finally {
      await api("DELETE", `/api/persons/${person.id}?confirm=1`);
      if (!lic.accepted) await m3SetLicence(false);
    }
  },
);
// ------------------------------------------------------------------ END sprint4:integración

// ---------------------------------------------------------------- BEGIN sprint4:auditoría
// Audit corrections of sprint 4 (docs/trabajo/integracion-sprint4.md «Correcciones de auditoría»):
// Host allowlist, biometric reads only for the web, consent bound to the photos it covered,
// «Revocar rostro» (the newest consent wins), the workers' mirror consent/active.json, the
// append-only hash-chained audit and the Persona-free asset names.
function rawGet(route, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${API}${route}`, { method: "GET", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

await step(
  "sprint4 auditoría: Host, lecturas biométricas, consentimiento atado a las fotos, revocar rostro, espejo y auditoría",
  async () => {
    const u = new URL(API);
    const bad = await rawGet("/api/persons", { host: `evil.example:${u.port}` });
    assert(bad === 403, `foreign Host -> ${bad} (403 BAD_HOST expected)`);
    const person = await m1Person(`E2E Auditoría ${id("n")}`);
    const photo = person.photos[0];
    const photoUrl = `/api/persons/${person.id}/photos/${photo.id}`;
    const anon = await api("GET", photoUrl, undefined, { raw: true });
    assert(anon.status === 403, `photo without Origin / Sec-Fetch-Site -> ${anon.status}`);
    const web = await api("GET", photoUrl, undefined, { raw: true, headers: WEB_ORIGIN });
    assert(web.status === 200, `photo with the web Origin -> ${web.status}`);
    const consent = person.consents[0];
    assert(consent.photo_ids?.length === 1 && consent.photo_ids[0].id === photo.id, "photo_ids");
    // a photo added AFTER the consent is not covered (and the mirror does not list it)
    const png = await m1Png(`m1-late-${person.id}.png`);
    const fd = await m1Form({}, { photo: { file: png, name: "otra.png", type: "image/png" } });
    const late = await api("POST", `/api/persons/${person.id}/photos`, fd, { headers: WEB_ORIGIN });
    assert(late.status === 200, `late photo -> ${late.status}`);
    let mirrorChecked = "storage not readable from here";
    const mirrorPath = path.join(STORAGE, "consent", "active.json");
    if (existsSync(mirrorPath)) {
      const mirror = JSON.parse(await readFile(mirrorPath, "utf8"));
      const entry = mirror.consents.find((e) => e.consentId === consent.id);
      assert(entry?.photo_paths?.length === 1 && entry.photo_paths[0] === photo.path, "mirror");
      mirrorChecked = "active.json lists only the covered photo";
    }
    // «Revocar rostro»: no valid face consent any more
    const after = await ok("POST", `/api/persons/${person.id}/consents/revoke`, { scope: "face" });
    assert(
      after.consents.every((c) => c.revoked_at),
      "revoke by scope",
    );
    const row = (await ok("GET", "/api/persons")).find((x) => x.id === person.id);
    assert(row.face === "revocado", `summary ${JSON.stringify(row)}`);
    // the audit: web only, hash chain intact
    const noWeb = await api("GET", `/api/persons/${person.id}/audit`);
    assert(noWeb.status === 403, `audit without Origin -> ${noWeb.status}`);
    const audit = await ok("GET", `/api/persons/${person.id}/audit`, undefined, [200], {
      headers: WEB_ORIGIN,
    });
    assert(audit.chain.ok === true, `audit chain ${JSON.stringify(audit.chain)}`);
    const actions = audit.rows.map((r) => r.action);
    for (const a of ["consent.create", "consent.revoke", "person.photo.add"])
      assert(actions.includes(a), `audit lacks ${a}: ${actions.join(", ")}`);
    return { badHost: bad, mirror: mirrorChecked, audit: audit.rows.length };
  },
);
// ------------------------------------------------------------------ END sprint4:auditoría

// ---------------------------------------------------------------- BEGIN sprint5:M2
await step("sprint5: projects summary + rename + duplicate", async () => {
  const a = await ok("POST", "/api/projects", { name: "S5 lista A" }, [201]);
  const b = await ok("POST", "/api/projects", { name: "S5 lista B" }, [201]);
  const list = await ok("GET", "/api/projects?view=summary", undefined, [200]);
  assert(
    Array.isArray(list) && list.length >= 2,
    `summary list ${JSON.stringify(list)?.slice(0, 200)}`,
  );
  for (const s of list.slice(0, 2))
    for (const k of ["id", "name", "updatedAt", "durationS", "width", "height", "clips"])
      assert(k in s, `summary item lacks ${k}: ${JSON.stringify(s)}`);
  assert(!("tracks" in list[0]), "summary must not carry the tracks");
  const order = list.map((s) => s.id);
  assert(order.indexOf(b.id) < order.indexOf(a.id), "summary is not newest first");
  const renamed = await ok("PATCH", `/api/projects/${a.id}`, { name: "S5 renombrado ñ" }, [200]);
  assert(renamed.name === "S5 renombrado ñ" && renamed.id === a.id, JSON.stringify(renamed));
  const bad = await api("PATCH", `/api/projects/${a.id}`, { name: "" });
  assert(bad.status === 400, `PATCH empty name -> ${bad.status}`);
  const missing = await api("PATCH", "/api/projects/no-existe", { name: "X" });
  assert(
    missing.status === 404 && missing.json?.error?.code === "PROJECT_NOT_FOUND",
    `PATCH unknown -> ${missing.status} ${JSON.stringify(missing.json)}`,
  );
  const dup = await ok("POST", `/api/projects/${a.id}/duplicate`, {}, [201]);
  assert(dup.name === "S5 renombrado ñ (copia)" && dup.id !== a.id, JSON.stringify(dup.name));
  const srcTracks = (await ok("GET", `/api/projects/${a.id}`)).tracks.map((t) => t.id);
  assert(
    dup.tracks.every((t) => !srcTracks.includes(t.id)),
    "duplicate kept old track ids",
  );
  for (const id of [a.id, b.id, dup.id])
    await ok("DELETE", `/api/projects/${id}`, undefined, [204]);
  const after = await ok("GET", "/api/projects?view=summary");
  assert(!after.some((s) => [a.id, b.id, dup.id].includes(s.id)), "deleted projects still listed");
  return { listed: list.length, duplicate: dup.name };
});
// ------------------------------------------------------------------ END sprint5:M2

// ---------------------------------------------------------------- BEGIN sprint5:M1
// Centro de trabajos y errores: agent.eval with real progress (mocked planner, 0.2 s per command,
// scripts/e2e/workers-with-mocks.py STUDIO_MOCK_AGENT_EVAL), cancel down to the worker task, and
// the Spanish WORKERS_UNAVAILABLE of an api whose workers are off.
const S5_WORKERS = opt("workers", "http://127.0.0.1:8001").replace(/\/+$/, "");

async function s5WorkerTask(area, taskId) {
  const res = await fetch(`${S5_WORKERS}/${area}/tasks/${taskId}`);
  return res.ok ? res.json() : { status: `HTTP ${res.status}` };
}

async function s5TaskIdFromLog(jobId, re) {
  const lines = (await ok("GET", `/api/jobs/${jobId}/log`)).lines ?? [];
  for (const l of lines) {
    const m = re.exec(l);
    if (m) return m[1];
  }
  return undefined;
}

await step("sprint5: agent.eval rápida (mock) 20 ítems con stage y ETA → completado", async () => {
  const { jobId } = await ok("POST", "/api/agent/eval", {}, [202]);
  const seen = [];
  const job = await waitJob(jobId, {
    timeoutMs: 120_000,
    onProgress: (j) => {
      if (j.status === "running" && j.detail) seen.push(j.detail);
    },
  });
  assert(job.status === "succeeded", `agent.eval ${job.status}: ${job.error ?? job.message}`);
  const staged = seen.filter((d) => /· \d+\/20$/.test(d.stage_es ?? ""));
  assert(staged.length > 0, `no stage «modelo · n/20»: ${JSON.stringify(seen.slice(-3))}`);
  assert(
    staged.some((d) => d.total === 20 && d.done > 0 && d.done < 20 && d.unit === "commands"),
    `no intermediate done/total: ${JSON.stringify(staged.slice(-3))}`,
  );
  assert(
    seen.some((d) => typeof d.eta_s === "number"),
    `no ETA while running: ${JSON.stringify(seen.slice(-2))}`,
  );
  assert(
    job.result?.mode === "quick" && job.result?.n === 20,
    JSON.stringify(job.result)?.slice(0, 200),
  );
  return { polls: seen.length, last: staged.at(-1)?.stage_es };
});

await step("sprint5: agent.eval cancelada → job canceled + tarea canceled", async () => {
  const { jobId } = await ok("POST", "/api/agent/eval", { mode: "full" }, [202]);
  const end = Date.now() + 60_000;
  for (;;) {
    const j = (await api("GET", `/api/jobs/${jobId}`)).json;
    if ((j.detail?.done ?? 0) >= 2) break;
    assert(!["succeeded", "failed", "canceled"].includes(j.status), `ended early: ${j.status}`);
    assert(Date.now() < end, "eval did not advance");
    await sleep(200);
  }
  const t = Date.now();
  await ok("POST", `/api/jobs/${jobId}/cancel`, {}, [200]);
  const job = await waitJob(jobId, { timeoutMs: 30_000 });
  assert(job.status === "canceled", `job ${job.status}`);
  const taskId = await s5TaskIdFromLog(jobId, /Tarea de evaluación (\w+)/);
  assert(taskId, "task id not in the job log");
  let task;
  for (let i = 0; i < 20; i++) {
    task = await s5WorkerTask("agent", taskId);
    if (task.status === "canceled") break;
    await sleep(150);
  }
  assert(task?.status === "canceled", `worker task ${JSON.stringify(task)?.slice(0, 200)}`);
  assert(task.done < task.total, `the worker went on: ${task.done}/${task.total}`);
  return { taskId, stoppedAt: `${task.done}/${task.total}`, ms: Date.now() - t };
});

await step(
  "sprint5: cancelar vision.reframe llega al worker",
  async () => {
    assert(ctx.s2track, "needs the sprint2 tracking step");
    const { video } = await sprint2TexturedMedia();
    const p = await sprint2Project("E2E S5 cancelar reencuadre", video);
    const res = await ok("POST", "/api/ai/vision/reframe", {
      projectId: p.id,
      target: "9:16",
      subject: "track",
      trackAssetId: ctx.s2track.trackAssetId,
    });
    let j;
    for (let i = 0; i < 200; i++) {
      j = (await api("GET", `/api/jobs/${res.jobId}`)).json;
      if (j.status !== "queued") break;
      await sleep(25);
    }
    const cancel = await api("POST", `/api/jobs/${res.jobId}/cancel`, {});
    assert(cancel.status === 200, `cancel -> ${cancel.status}`);
    const job = await waitJob(res.jobId, { timeoutMs: 60_000 });
    if (job.status === "succeeded") return "terminó antes de poder cancelarlo (video corto)";
    assert(job.status === "canceled", `job ${job.status}: ${job.error}`);
    const taskId = await s5TaskIdFromLog(res.jobId, /(?:tarea|Tarea)\s+(\w{8,})/);
    if (!taskId) return { job: "canceled", worker: "sin id de tarea en el log" };
    // Cooperative cancel: the worker stops at its next progress update.
    let task;
    for (let i = 0; i < 50; i++) {
      task = await s5WorkerTask("vision", taskId);
      if (["canceled", "done", "error"].includes(task.status)) break;
      await sleep(200);
    }
    assert(task.status === "canceled", `worker task ${task.status}`);
    return { job: job.status, worker: task.status };
  },
  "optional",
);

await step("sprint5: workers apagados → 503 WORKERS_UNAVAILABLE con start.cmd", async () => {
  const dist = path.join(REPO, "apps", "api", "dist", "index.js");
  assert(existsSync(dist), "apps/api/dist/index.js missing (pnpm -r build)");
  const port = 3000 + 90 + Math.floor(Math.random() * 9);
  const storage = path.join(WORK, "s5-workers-off");
  await mkdir(storage, { recursive: true });
  const child = spawn(process.execPath, [dist], {
    cwd: path.join(REPO, "apps", "api"),
    windowsHide: true,
    env: {
      ...process.env,
      API_PORT: String(port),
      API_HOST: "127.0.0.1",
      STORAGE_DIR: storage,
      WORKERS_URL: "http://127.0.0.1:1",
    },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    let health;
    for (let i = 0; i < 100 && !health; i++) {
      health = await fetch(`${base}/api/health`)
        .then((r) => (r.ok ? r.json() : undefined))
        .catch(() => undefined);
      if (!health) await sleep(150);
    }
    assert(health, "second api did not start");
    assert(health.workers?.reachable === false && health.checkedAt, JSON.stringify(health));
    const project = await (
      await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "S5 sin workers" }),
      })
    ).json();
    const res = await fetch(`${base}/api/agent/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, command: "poné un título que diga hola" }),
    });
    const body = await res.json();
    assert(res.status === 503, `plan -> ${res.status} ${JSON.stringify(body)}`);
    assert(body.error?.code === "WORKERS_UNAVAILABLE", JSON.stringify(body));
    assert(body.error.message.includes("scripts\\windows\\start.cmd"), body.error.message);
    assert(!/TypeError|ECONNREFUSED|start\.ps1/.test(body.error.message), body.error.message);
    return body.error.message;
  } finally {
    child.kill();
  }
});
// ------------------------------------------------------------------ END sprint5:M1

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
  measurements: ctx.measurements ?? null,
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
if (ctx.measurements?.reexportRatio !== undefined)
  console.log(
    `Mediciones (criterio 2): silencios ${ctx.measurements.silencesSecPerMin} s/min · ratio re-export ${ctx.measurements.reexportRatio}`,
  );
console.log(`Report: ${OUT}`);
process.exit(failed.length ? 1 : 0);

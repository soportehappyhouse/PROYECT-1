#!/usr/bin/env node
// Sprint 6 M2 — criterion C2: subtitles and titles pass the design rules WITHOUT touching anything.
// Against a running api (no dependencies: Node >= 22, ffmpeg + ffprobe):
//
//   node scripts/e2e/design-check.mjs --api http://127.0.0.1:3001
//
// For each aspect (9:16 Reels and 16:9 YouTube) it builds the default project of the contract —
// a talking clip + `add_captions reels` (9:16) / `clasico` (16:9) + `title-card` + `lower-third`,
// everything with the template/kit defaults — and then:
//   1. POST /api/design/check  -> must be 10/10 rules (DESIGN_RULES), 0 manual fixes;
//   2. exports it twice (with / without burned subtitles) and, on 5 frames, takes the bounding box
//      of the pixels that differ (= the captions): inside the kit safe zone and ≤ 2 lines tall;
//   3. checks the ASS burn-in used the bundled fonts (fontsdir in the export log, when exposed);
//   4. (audit S6 E4) repeats the checklist with faster speech (--rates, default 2.6 and 3 words/s:
//      the pixel checks use the first rate) and reports the rules per rate.
// Motion clips are rendered with Remotion when the engine is available; otherwise they are only
// checked by the rules (step 1) and the export drops them (reported as SKIP, Chrome missing).
//
// Options: --api <url> · --work <dir> · --out <file.json> · --ffmpeg/--ffprobe <bin> ·
//          --aspect 9:16|16:9 (one only) · --timeout <s> (per job, default 600) ·
//          --rates 2.6,3 (words per second of the synthetic speech; all must give 10/10)
// Exit code 0 = both aspects 10/10 and every pixel check passed.

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const API = opt("api", "http://127.0.0.1:3001").replace(/\/+$/, "");
const WORK = path.resolve(opt("work", path.join(os.tmpdir(), `studio-design-${Date.now()}`)));
const OUT = path.resolve(opt("out", path.join(WORK, "design-check.json")));
const FFMPEG = opt("ffmpeg", "ffmpeg");
const TIMEOUT = Number(opt("timeout", "600")) * 1000;
const ONLY = opt("aspect");
const RATES = opt("rates", "2.6,3")
  .split(",")
  .map(Number)
  .filter((r) => r > 0);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Fail extends Error {}
const assert = (c, m) => {
  if (!c) throw new Fail(m);
};

function run(bin, args, { binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    const out = [];
    let err = "";
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0
        ? resolve(binary ? Buffer.concat(out) : Buffer.concat(out).toString())
        : reject(new Error(`${bin} exited ${code}: ${err.slice(-600)}`)),
    );
  });
}

async function api(method, route, body) {
  const init = { method, headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["content-type"] = "application/json";
  }
  const res = await fetch(`${API}${route}`, init);
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}
async function ok(method, route, body, expect = [200, 201, 202]) {
  const r = await api(method, route, body);
  assert(
    expect.includes(r.status),
    `${method} ${route} -> ${r.status} ${JSON.stringify(r.json)?.slice(0, 300)}`,
  );
  return r.json;
}
async function waitJob(id) {
  const end = Date.now() + TIMEOUT;
  for (;;) {
    const { json: job } = await api("GET", `/api/jobs/${id}`);
    if (job.status === "succeeded") return job;
    if (["failed", "canceled"].includes(job.status))
      throw new Fail(`job ${job.type} ${job.status}: ${job.error ?? job.message}`);
    if (Date.now() > end) throw new Fail(`job ${id} timeout`);
    await sleep(400);
  }
}
async function download(rel, dest) {
  const res = await fetch(`${API}/files/${rel.split("/").map(encodeURIComponent).join("/")}`);
  assert(res.ok, `GET /files/${rel} -> ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

/** Natural Spanish speech (`wps` words/s, 0,45 s pauses between sentences) as subtitle segments. */
function speech(total, wps = RATES[0] ?? 2.6) {
  const sentences = [
    "Hola, hoy te muestro cómo editar un video para redes sin perder tiempo.",
    "Primero cortamos los silencios largos del principio.",
    "Después agregamos subtítulos grandes y fáciles de leer en el teléfono.",
    "Y al final exportamos en vertical para Reels y TikTok.",
  ];
  let t = 0.4;
  const segs = [];
  for (const s of sentences) {
    const words = s.split(" ").map((w) => {
      const d = (1 / wps) * Math.max(0.6, Math.min(1.6, w.length / 5));
      const x = { word: w, start: +t.toFixed(3), end: +(t + d * 0.9).toFixed(3) };
      t += d;
      return x;
    });
    if (words.at(-1).end > total - 0.3) break;
    segs.push({ start: words[0].start, end: words.at(-1).end, text: s, words });
    t += 0.45;
  }
  return segs;
}

const ASPECTS = {
  "9:16": { w: 1080, h: 1920, preset: "reels-tiktok", caption: "reels" },
  "16:9": { w: 1920, h: 1080, preset: "youtube-1080p", caption: "clasico" },
};
const DURATION = 15;

async function makeClip(aspect) {
  const a = ASPECTS[aspect];
  const file = path.join(WORK, `hablado-${aspect.replace(":", "x")}.mp4`);
  await run(FFMPEG, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x2b5d8a:s=${a.w}x${a.h}:r=30:d=${DURATION}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=220:sample_rate=48000:duration=${DURATION}`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    file,
  ]);
  const fd = new FormData();
  fd.append("file", new Blob([await readFile(file)], { type: "video/mp4" }), path.basename(file));
  const asset = await ok("POST", "/api/media", fd, [201]);
  // wait for the probe (duration/size are needed by the export)
  const end = Date.now() + TIMEOUT;
  for (;;) {
    const m = await ok("GET", `/api/media/${asset.id}`);
    if (m.durationSec) return m;
    if (Date.now() > end) throw new Fail("media.probe timeout");
    await sleep(300);
  }
}

async function buildProject(aspect, asset, presets, motionOk, wps = RATES[0]) {
  const a = ASPECTS[aspect];
  const created = await ok("POST", "/api/projects", {
    name: `Diseño ${aspect}`,
    settings: { width: a.w, height: a.h, fps: 30 },
  });
  const video = created.tracks.find((t) => t.kind === "video");
  const motionTrack = created.tracks.find((t) => t.kind === "motion") ?? {
    id: `trk_motion_${Date.now()}`,
    kind: "motion",
    name: "Motion",
    clips: [],
  };
  const tpl = (id) => presets.find((t) => t.id === id);
  const motion = (id, clipId, start, dur, props) => ({
    id: clipId,
    trackId: motionTrack.id,
    start,
    in: 0,
    out: dur,
    motion: {
      engine: "remotion",
      template: id,
      // template defaults only (+ the texts): the kit fills fonts, colors and safe zone
      props: { ...tpl(id).defaultProps, ...props },
      durationSec: dur,
      fps: 30,
      width: a.w,
      height: a.h,
      format: "webm-vp9-alpha",
    },
  });
  const project = {
    ...created,
    tracks: [
      ...created.tracks.filter((t) => t.id !== video.id && t.id !== motionTrack.id),
      {
        ...video,
        clips: [
          { id: "clp_voz", trackId: video.id, assetId: asset.id, start: 0, in: 0, out: DURATION },
        ],
      },
      {
        ...motionTrack,
        clips: [
          motion("title-card", "clp_titulo", 0, 3, { title: "Editá más rápido", subtitle: "" }),
          motion("lower-third", "clp_rotulo", 4, 4, { name: "Luis", role: "Happy House" }),
        ],
      },
    ],
    subtitles: speech(DURATION, wps),
  };
  // `add_captions {style}` = the CAPTION_STYLE_PRESETS object (the web Subtítulos panel does the same)
  project.captionStyle = CAPTION_STYLES[a.caption];
  await ok("PUT", `/api/projects/${created.id}`, project);
  if (motionOk)
    for (const c of project.tracks.find((t) => t.id === motionTrack.id).clips) {
      const { jobId } = await ok("POST", "/api/motion/render", {
        ...c.motion,
        target: { projectId: created.id, clipId: c.id },
      });
      await waitJob(jobId);
    }
  return ok("GET", `/api/projects/${created.id}`);
}

/** Built-in caption presets used by `add_captions` (mirror of CAPTION_STYLE_PRESETS). */
const CAPTION_STYLES = {
  reels: {
    id: "reels",
    name: "Reels (palabra a palabra)",
    fontFamily: "Inter",
    fontSize: 72,
    color: "#ffffff",
    background: "",
    highlightColor: "#22d3ee",
    position: "center",
    uppercase: true,
    animation: "pop",
  },
  clasico: {
    id: "clasico",
    name: "Clásico",
    fontFamily: "Inter",
    fontSize: 54,
    color: "#ffffff",
    background: "rgba(0,0,0,0.6)",
    highlightColor: "#ffd60a",
    position: "bottom",
    uppercase: false,
    animation: "fade",
  },
};

async function exportProject(project, aspect, burn, motionOk, tag) {
  const a = ASPECTS[aspect];
  // Without Remotion the motion clips cannot be composited: export a copy without them.
  let id = project.id;
  if (!motionOk) {
    const copy = await ok("POST", "/api/projects", {
      name: `${project.name} (sin motion)`,
      settings: project.settings,
    });
    await ok("PUT", `/api/projects/${copy.id}`, {
      ...project,
      id: copy.id,
      tracks: project.tracks.filter((t) => t.kind !== "motion"),
    });
    id = copy.id;
  }
  const { jobId } = await ok("POST", `/api/projects/${id}/export`, {
    presetId: a.preset,
    burnSubtitles: burn,
    fileName: `design-${aspect.replace(":", "x")}-${tag}`,
    useSegmentCache: false,
  });
  const job = await waitJob(jobId);
  return download(job.result.path, path.join(WORK, `${aspect.replace(":", "x")}-${tag}.mp4`));
}

async function grayFrame(file, t, w, h) {
  return run(
    FFMPEG,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      String(t),
      "-i",
      file,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-s",
      `${w}x${h}`,
      "-",
    ],
    { binary: true },
  );
}

/** Bounding box of the pixels that differ by more than 40 levels (captions on a flat background). */
function diffBox(a, b, w, h) {
  let x0 = w,
    y0 = h,
    x1 = -1,
    y1 = -1,
    n = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (Math.abs(a[i] - b[i]) > 40) {
        n++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  return n > 50 ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, pixels: n } : undefined;
}

async function checkAspect(aspect, presets, motionOk) {
  const a = ASPECTS[aspect];
  const out = {
    aspect,
    rules: undefined,
    frames: [],
    motion: motionOk ? "rendered" : "SKIP (sin Remotion)",
    pass: false,
  };
  const asset = await makeClip(aspect);
  const project = await buildProject(aspect, asset, presets, motionOk);

  // 1. checklist (no fixes)
  const check = await ok("POST", "/api/design/check", { projectId: project.id, aspect });
  out.rules = {
    passed: check.passed,
    failed: check.rules.filter((r) => !r.passed).map((r) => r.id),
    issues: check.issues,
  };
  console.log(
    `  ${aspect}: ${check.passed}/10 reglas${check.passed < 10 ? ` — fallan: ${out.rules.failed.join(", ")}` : ""}`,
  );

  // 2. pixels: with vs without burned captions, 5 frames inside 5 different pages
  const tokens = await ok("GET", `/api/design/tokens?w=${a.w}&h=${a.h}`);
  const withSubs = await exportProject(project, aspect, true, motionOk, "con");
  const without = await exportProject(project, aspect, false, motionOk, "sin");
  const sz = tokens.safe_zone_px;
  const size = (CAPTION_STYLES[a.caption].fontSize * Math.min(a.w, a.h)) / 1080;
  const lineH = size * 1.2 + 2 * tokens.caption_px.outline + 6;
  // 5 moments inside the speech (first and middle part of each sentence).
  const times = project.subtitles
    .flatMap((x) => [x.start + 0.35, (x.start + x.end) / 2, x.end - 0.35])
    .filter((t, k, all) => k === 0 || t - all[k - 1] > 0.8)
    .filter(
      (_, k, all) => all.length <= 5 || k % Math.ceil(all.length / 5) === 0 || k === all.length - 1,
    )
    .slice(0, 5);
  for (const t of times.slice(0, 5)) {
    const box = diffBox(
      await grayFrame(withSubs, t, a.w, a.h),
      await grayFrame(without, t, a.w, a.h),
      a.w,
      a.h,
    );
    const tol = 4;
    const inside =
      box &&
      box.x >= sz.left - tol &&
      box.y >= sz.top - tol &&
      box.x + box.w <= a.w - sz.right + tol &&
      box.y + box.h <= a.h - sz.bottom + tol;
    const lines = box ? Math.max(1, Math.round(box.h / lineH)) : 0;
    const frame = {
      t: +t.toFixed(2),
      box,
      insideSafeZone: Boolean(inside),
      linesByHeight: lines,
      pass: Boolean(inside) && lines <= 2,
    };
    out.frames.push(frame);
    console.log(
      `    t=${frame.t}s caja=${box ? `${box.x},${box.y} ${box.w}×${box.h}` : "—"} zona segura=${frame.insideSafeZone ? "sí" : "NO"} líneas≈${lines}`,
    );
  }
  // 4. checklist at the other speech rates (same project, other subtitles; no export).
  out.rates = [{ wps: RATES[0], passed: check.passed, failed: out.rules.failed }];
  for (const wps of RATES.slice(1)) {
    const p = await ok("GET", `/api/projects/${project.id}`);
    await ok("PUT", `/api/projects/${project.id}`, { ...p, subtitles: speech(DURATION, wps) });
    const c = await ok("POST", "/api/design/check", { projectId: project.id, aspect });
    const failed = c.rules.filter((r) => !r.passed).map((r) => r.id);
    const n = c.issues.length;
    out.rates.push({ wps, passed: c.passed, failed, issues: n });
    console.log(
      `  ${aspect} a ${wps} palabras/s: ${c.passed}/10 reglas${failed.length ? ` — fallan: ${failed.join(", ")} (${n} incidencias)` : ""}`,
    );
  }
  out.pass =
    out.rates.every((r) => r.passed === 10) &&
    out.frames.length === 5 &&
    out.frames.every((f) => f.pass);
  return out;
}

async function main() {
  await mkdir(WORK, { recursive: true });
  await ok("GET", "/api/health");
  const engines = await ok("GET", "/api/motion/engines");
  const motionOk = engines.some((e) => e.id === "remotion" && e.ok);
  const presets = await ok("GET", "/api/motion/templates");
  const report = { api: API, startedAt: new Date().toISOString(), motion: motionOk, aspects: [] };
  for (const aspect of Object.keys(ASPECTS)) {
    if (ONLY && ONLY !== aspect) continue;
    console.log(`… design-check ${aspect}`);
    try {
      report.aspects.push(await checkAspect(aspect, presets, motionOk));
    } catch (err) {
      console.log(`  FAIL ${aspect}: ${err.message}`);
      report.aspects.push({ aspect, pass: false, error: String(err.message ?? err) });
    }
  }
  report.pass = report.aspects.length > 0 && report.aspects.every((a) => a.pass);
  await writeFile(OUT, JSON.stringify(report, null, 2));
  console.log(`${report.pass ? "PASS" : "FAIL"} design-check — informe: ${OUT}`);
  process.exit(report.pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});

#!/usr/bin/env node
// Edge-case / limits probe for the Studio api (companion of run-e2e.mjs). Prints observed
// behaviour; it does not fail the process. Usage:
//   node scripts/e2e/probe-limits.mjs --api http://127.0.0.1:3001 [--storage <STORAGE_DIR>]

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const API = opt("api", "http://127.0.0.1:3001").replace(/\/+$/, "");
const WORK = path.resolve(opt("work", path.join(os.tmpdir(), `studio-probe-${Date.now()}`)));
const FFMPEG = opt("ffmpeg", "ffmpeg");
const FFPROBE = opt("ffprobe", "ffprobe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const note = (name, observed) => {
  rows.push({ name, observed });
  console.log(`- ${name}: ${typeof observed === "string" ? observed : JSON.stringify(observed)}`);
};

const run = (bin, args) =>
  new Promise((res, rej) => {
    const p = spawn(bin, args, { windowsHide: true });
    let o = "";
    let e = "";
    p.stdout.on("data", (d) => (o += d));
    p.stderr.on("data", (d) => (e += d));
    p.on("close", (c) => (c === 0 ? res(o) : rej(new Error(e.slice(-400)))));
  });
async function api(method, route, body, headers = {}) {
  const init = { method, headers };
  if (body instanceof FormData || typeof body === "string") init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { ...headers, "content-type": "application/json" };
  }
  const r = await fetch(`${API}${route}`, init);
  const t = await r.text();
  let json;
  try {
    json = t ? JSON.parse(t) : undefined;
  } catch {
    json = t.slice(0, 200);
  }
  return { status: r.status, json };
}
async function upload(file, name = path.basename(file), mime = "application/octet-stream") {
  const fd = new FormData();
  fd.append("file", new Blob([await readFile(file)], { type: mime }), name);
  return api("POST", "/api/media", fd);
}
async function waitJob(id, ms = 300_000) {
  const end = Date.now() + ms;
  for (;;) {
    const { json } = await api("GET", `/api/jobs/${id}`);
    if (["succeeded", "failed", "canceled"].includes(json.status)) return json;
    if (Date.now() > end) return json;
    await sleep(300);
  }
}
async function waitProbe(assetId) {
  for (let i = 0; i < 200; i++) {
    const { json } = await api("GET", `/api/jobs?type=media.probe&limit=100`);
    const j = json.find((x) => x.payload?.assetId === assetId);
    if (j && ["succeeded", "failed"].includes(j.status)) return j;
    await sleep(300);
  }
}
async function probeFile(rel) {
  const r = await fetch(`${API}/files/${rel}`);
  const f = path.join(WORK, path.basename(rel));
  await writeFile(f, Buffer.from(await r.arrayBuffer()));
  const j = JSON.parse(
    await run(FFPROBE, ["-v", "error", "-show_streams", "-show_format", "-of", "json", f]),
  );
  const v = j.streams.find((s) => s.codec_type === "video");
  return {
    sec: +(+j.format.duration).toFixed(2),
    size: v ? `${v.width}x${v.height}` : "-",
    v: v?.codec_name,
    pix: v?.pix_fmt,
    a: j.streams.find((s) => s.codec_type === "audio")?.codec_name ?? "-",
  };
}
async function exportProject(project, presetId, extra = {}) {
  const r = await api("POST", `/api/projects/${project.id}/export`, { presetId, ...extra });
  if (r.status !== 202) return { http: r.status, error: r.json?.error?.message };
  const t = Date.now();
  const job = await waitJob(r.json.jobId);
  const log = await api("GET", `/api/jobs/${job.id}/log`);
  const warnings = (log.json?.lines ?? []).filter((l) => /AVISO|warn/i.test(l));
  const out = {
    status: job.status,
    wallSec: +((Date.now() - t) / 1000).toFixed(1),
    result: job.result,
    error: job.error?.slice(0, 160),
    warningsInLog: warnings,
  };
  if (job.status === "succeeded") out.file = await probeFile(job.result.path);
  return out;
}
let n = 0;
const uid = (p) => `${p}${++n}${Math.random().toString(36).slice(2, 6)}`;
async function newProject(name, settings, build) {
  const { json: p } = await api("POST", "/api/projects", { name, settings });
  build(p);
  const r = await api("PUT", `/api/projects/${p.id}`, p);
  return r.status === 200 ? r.json : { ...p, putStatus: r.status, putError: r.json };
}

await mkdir(WORK, { recursive: true });
const video = path.join(WORK, "v.mp4");
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
  "sine=f=440:d=10",
  "-shortest",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  video,
]);
const empty = path.join(WORK, "empty.mp4");
await writeFile(empty, "");
const { json: va } = await upload(video, "v.mp4", "video/mp4");
await waitProbe(va.id);

// ---- uploads
const trav = await upload(video, "../../..\\evil<>.mp4", "video/mp4");
note("upload name '../../..\\evil<>.mp4'", {
  status: trav.status,
  storedPath: trav.json?.path,
  name: trav.json?.name,
});
const zero = await upload(empty, "empty.mp4", "video/mp4");
const zp = zero.status === 201 ? await waitProbe(zero.json.id) : undefined;
note("upload 0-byte .mp4", {
  status: zero.status,
  probe: zp?.status,
  error: zp?.error?.slice(0, 80),
});
const noext = await upload(video, "sin_extension", "video/mp4");
note("upload without extension (mime video/mp4)", {
  status: noext.status,
  kind: noext.json?.kind,
  path: noext.json?.path,
});
const txt = await upload(video, "nota.txt", "text/plain");
note("upload .txt", { status: txt.status, err: txt.json?.error?.code });
const srt = path.join(WORK, "s.srt");
await writeFile(srt, "1\n00:00:00,000 --> 00:00:01,000\nHola\n");
const srtUp = await upload(srt, "s.srt", "application/x-subrip");
note("upload .srt", { status: srtUp.status, kind: srtUp.json?.kind });
const big = "x".repeat(11 * 1024 * 1024);
const bigPut = await api("PUT", `/api/projects/whatever`, `{"name":"${big}"}`, {
  "content-type": "application/json",
});
note("JSON body 11 MB", { status: bigPut.status, code: bigPut.json?.error?.code });

// ---- static file exposure
for (const p of [
  "/files/studio.db",
  "/files/studio.db-wal",
  "/files/tmp/",
  "/files/../package.json",
  "/files/%2e%2e/package.json",
  "/files/media/",
])
  note(`GET ${p}`, (await fetch(`${API}${p}`)).status);

// ---- presets
note(
  "DELETE built-in preset youtube-1080p",
  (await api("DELETE", "/api/export-presets/youtube-1080p")).status,
);
const presets = (await api("GET", "/api/export-presets")).json;
note(
  "presets",
  presets.map(
    (p) =>
      `${p.id} ${p.width}x${p.height}@${p.fps} ${p.container}/${p.videoCodec}${p.alpha ? " alpha" : ""}`,
  ),
);

// ---- motion validation limits
for (const [label, spec] of [
  ["durationSec 1801 (remotion max 1800)", { template: "title-card", durationSec: 1801 }],
  ["fps 240", { template: "title-card", durationSec: 2, fps: 240 }],
  ["width 7680 x 4320", { template: "title-card", durationSec: 1, width: 7680, height: 4320 }],
  [
    "prop of wrong type (title: 5)",
    { template: "title-card", durationSec: 1, props: { title: 5 } },
  ],
]) {
  const r = await api("POST", "/api/motion/render", spec);
  note(`motion ${label}`, {
    status: r.status,
    msg: r.json?.error?.details?.errors?.slice?.(0, 2) ?? r.json?.error?.message,
  });
  if (r.status === 202) await api("POST", `/api/jobs/${r.json.jobId}/cancel`);
}

// ---- export edge cases
const p1 = await newProject("unrendered motion", {}, (p) => {
  const V = p.tracks[0];
  V.clips = [{ id: uid("c"), trackId: V.id, assetId: va.id, start: 0, in: 0, out: 3 }];
  const M = { id: uid("t"), kind: "motion", name: "M", clips: [] };
  M.clips = [
    {
      id: uid("c"),
      trackId: M.id,
      start: 0,
      in: 0,
      out: 2,
      motion: { template: "title-card", durationSec: 2, props: {} },
    },
  ];
  p.tracks.push(M);
});
note("export with motion clip never rendered", await exportProject(p1, "youtube-1080p"));

const { json: va2 } = await upload(video, "borrar.mp4", "video/mp4");
await waitProbe(va2.id);
const p2 = await newProject("deleted asset", {}, (p) => {
  const V = p.tracks[0];
  V.clips = [{ id: uid("c"), trackId: V.id, assetId: va2.id, start: 0, in: 0, out: 3 }];
});
note("DELETE media used by a project", (await api("DELETE", `/api/media/${va2.id}`)).status);
note("export after its only asset was deleted", await exportProject(p2, "youtube-1080p"));

const p3 = await newProject("out past source end", {}, (p) => {
  const V = p.tracks[0];
  V.clips = [{ id: uid("c"), trackId: V.id, assetId: va.id, start: 0, in: 8, out: 15 }];
});
note("clip in=8 out=15 on a 10 s source", await exportProject(p3, "youtube-1080p"));

const p4 = await newProject("speeds", {}, (p) => {
  const V = p.tracks[0];
  V.clips = [
    { id: uid("c"), trackId: V.id, assetId: va.id, start: 0, in: 0, out: 0.5, speed: 0.25 },
    { id: uid("c"), trackId: V.id, assetId: va.id, start: 2, in: 0, out: 10, speed: 16 },
  ];
});
note("speed 0.25 and 16 (with audio)", await exportProject(p4, "youtube-1080p"));

const p5 = await newProject("special text", {}, (p) => {
  const T = p.tracks[1];
  T.clips = [
    {
      id: uid("c"),
      trackId: T.id,
      start: 0,
      in: 0,
      out: 2,
      text: "50% off: it's {x} \\ done; [a] 'b' %{pts}",
      textStyle: { fontSize: 48 },
    },
  ];
});
note(
  "text with % : ' { } \\ ; [ ] (no font installed: Inter)",
  await exportProject(p5, "youtube-1080p"),
);

const p6 = await newProject("audio only", {}, (p) => {
  const A = p.tracks[2];
  A.clips = [{ id: uid("c"), trackId: A.id, assetId: va.id, start: 0, in: 0, out: 2 }];
});
note("audio-only timeline (video asset on audio track)", await exportProject(p6, "youtube-1080p"));

const p7 = await newProject("huge canvas", { width: 20000, height: 20000 }, (p) => {
  const V = p.tracks[0];
  V.clips = [{ id: uid("c"), trackId: V.id, assetId: va.id, start: 0, in: 0, out: 1 }];
});
note("project settings 20000x20000 accepted?", { putStatus: p7.putStatus ?? 200 });
note("export 20000x20000 project", await exportProject(p7, "youtube-1080p"));

const p8 = await newProject("empty", {}, () => {});
note("export empty project", await exportProject(p8, "youtube-1080p"));
note(
  "export range 1–2.5 s",
  await exportProject(p3, "youtube-1080p", { range: { start: 1, end: 2.5 } }),
);
note(
  "export range start>end",
  await exportProject(p3, "youtube-1080p", { range: { start: 5, end: 2 } }),
);
note("export gif-480", await exportProject(p3, "gif-480"));
note("export webm-alpha", await exportProject(p1, "webm-alpha"));
note("export youtube-shorts (60 fps)", await exportProject(p3, "youtube-shorts"));

const clipsNeg = await newProject("negative values", {}, (p) => {
  const V = p.tracks[0];
  V.clips = [{ id: uid("c"), trackId: V.id, assetId: va.id, start: -1, in: 5, out: 2 }];
});
note("clip start=-1, in=5 > out=2 accepted by PUT?", {
  putStatus: clipsNeg.putStatus ?? 200,
  err: clipsNeg.putError?.error?.code,
});

// ---- concurrency: 3 exports at once (ffmpeg lane default 2)
const ids = [];
for (let i = 0; i < 3; i++)
  ids.push(
    (await api("POST", `/api/projects/${p3.id}/export`, { presetId: "youtube-1080p" })).json.jobId,
  );
await sleep(800);
const states = [];
for (const id of ids) states.push((await api("GET", `/api/jobs/${id}`)).json.status);
note("3 simultaneous exports, states after 0.8 s", states);
for (const id of ids) await waitJob(id);

// ---- voice / transcription error paths
const img = path.join(WORK, "i.png");
await run(FFMPEG, [
  "-y",
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "color=red:s=64x64",
  "-frames:v",
  "1",
  img,
]);
const { json: ia } = await upload(img, "i.png", "image/png");
await waitProbe(ia.id);
const ve = await api("POST", "/api/voice/effects", {
  assetId: ia.id,
  effects: [{ type: "robot" }],
});
note(
  "voice effect on an image",
  ve.status === 202 ? { job: (await waitJob(ve.json.jobId)).error } : ve.status,
);
const tr = await api("POST", "/api/subtitles/transcribe", { assetId: ia.id });
note(
  "transcribe an image",
  tr.status === 202 ? { job: (await waitJob(tr.json.jobId)).error?.slice(0, 120) } : tr,
);

await writeFile(path.join(WORK, "probe-limits.json"), JSON.stringify(rows, null, 2));
console.log(`\nSaved ${path.join(WORK, "probe-limits.json")}`);

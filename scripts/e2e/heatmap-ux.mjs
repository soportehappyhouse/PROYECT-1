#!/usr/bin/env node
/* global document, getComputedStyle, requestAnimationFrame */
// Mapa de calor UX (docs/trabajo/protocolo-mapa-calor.md): runs the 9 flows of the protocol in a
// real browser on a running stack and writes the OBSERVATIONS (clicks, waits, dead ends, English
// on screen, icon buttons without tooltip, focus ring, UI fonts, screenshots) to <out>/heat.json.
// The 1–5 scores are still given by a person reading heat.json and the shots, as the protocol
// says; this script makes the measured part reproducible (audit S6 E22 / criterion C3).
//
//   node scripts/e2e/heatmap-ux.mjs --out <dir> [--media <dir>] [--web http://127.0.0.1:3000]
//        [--api http://127.0.0.1:3001] [--workers http://127.0.0.1:8001] [--storage <STORAGE_DIR>]
//        [--models <MODELS_DIR>] [--playwright <path to playwright/index.mjs>] [--only 1,2,5]
//
// Needs a FRESH storage, the web built against --api, the workers started with
// scripts/e2e/workers-with-mocks.py and STUDIO_MOCK_DENOISE=0 (flow 4 stops and restarts them:
// Linux/macOS only, it uses `fuser` and the repo .venv). Missing media in --media (clip.mp4 1280×720
// 12 s with sound, vertical.mp4 1080×1920 10 s, voz.wav 8 s, logo.png) are generated with ffmpeg.
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync, spawn } from "node:child_process";

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = path.resolve(opt("out", path.join(REPO, "heatmap-out")));
const MEDIA = path.resolve(opt("media", path.join(OUT, "media")));
const ONLY = opt("only") ? opt("only").split(",") : null;
const WEB = opt("web", "http://127.0.0.1:3000").replace(/\/+$/, "");
const API = opt("api", "http://127.0.0.1:3001").replace(/\/+$/, "");
const WORKERS = opt("workers", "http://127.0.0.1:8001").replace(/\/+$/, "");
const STORAGE = opt("storage", process.env.STORAGE_DIR ?? "");
const MODELS = opt("models", process.env.MODELS_DIR ?? "");
const PW = opt("playwright", "playwright");
const DAY = new Date().toISOString().slice(0, 10);
mkdirSync(path.join(OUT, "shots"), { recursive: true });
mkdirSync(MEDIA, { recursive: true });

/** Test media (generated once with ffmpeg lavfi when absent). */
function ensureMedia() {
  const ff = (name, args) => {
    const file = path.join(MEDIA, name);
    if (existsSync(file)) return;
    const r = spawnSync("ffmpeg", ["-y", "-v", "error", ...args, file]);
    if (r.status !== 0) throw new Error(`ffmpeg ${name}: ${r.stderr}`);
  };
  const h264 = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"];
  ff("clip.mp4", [
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=1280x720:r=30:d=12",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=330:sample_rate=48000:duration=12",
    ...h264,
  ]);
  ff("vertical.mp4", [
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=1080x1920:r=30:d=10",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:sample_rate=48000:duration=10",
    ...h264,
  ]);
  ff("voz.wav", ["-f", "lavfi", "-i", "sine=frequency=180:sample_rate=48000:duration=8"]);
  ff("logo.png", ["-f", "lavfi", "-i", "color=c=0xe13238:s=640x640", "-frames:v", "1"]);
}
ensureMedia();

const { chromium } = await import(PW.endsWith(".mjs") ? pathToFileURL(PW).href : PW);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const apiJson = async (r, init) => (await fetch(API + r, init)).json();
const apiSend = async (method, route, body) => {
  const res = await fetch(API + route, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => undefined) };
};
const DENY = (() => {
  const src = readFileSync(path.join(REPO, "packages/shared/src/texts-es.ts"), "utf8");
  const block = /UI_ENGLISH_DENYLIST[^=]*=\s*\[([\s\S]*?)\];/.exec(src)?.[1] ?? "";
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
})();

const report = {};
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1366, height: 820 },
  colorScheme: "dark",
  locale: "es-ES",
});
// Playwright Chromium has no H.264 decoder: transcode previews to VP9 like ui-smoke --vp9-preview.
await context.route(
  /\/(files\/proxies\/[^/]+\.mp4|api\/media\/[^/]+\/file)(\?.*)?$/,
  async (route) => {
    const res = await route.fetch({ headers: { ...route.request().headers(), range: "" } });
    const type = res.headers()["content-type"] ?? "";
    if (!/video\/(mp4|quicktime)/.test(type)) return route.fulfill({ response: res });
    const dir = path.join(OUT, "vp9");
    mkdirSync(dir, { recursive: true });
    const n = Math.random().toString(36).slice(2);
    const src = path.join(dir, `${n}.mp4`);
    const out = path.join(dir, `${n}.webm`);
    writeFileSync(src, await res.body());
    spawnSync("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-i",
      src,
      "-c:v",
      "libvpx-vp9",
      "-deadline",
      "realtime",
      "-cpu-used",
      "8",
      "-b:v",
      "1M",
      "-c:a",
      "libopus",
      out,
    ]);
    return route.fulfill({ status: 200, contentType: "video/webm", body: readFileSync(out) });
  },
);
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 160)));
const toasts = [];
async function collectToasts() {
  const t = await page
    .locator("[data-sonner-toast]")
    .allTextContents()
    .catch(() => []);
  for (const x of t) if (!toasts.includes(x)) toasts.push(x);
  return t;
}
async function shot(name) {
  const f = path.join(OUT, "shots", `mapa-${DAY}-${name}.png`);
  await page.screenshot({ path: f });
  return path.basename(f);
}
async function tab(title) {
  const t = page.locator(".dv-tab", { hasText: new RegExp(`^${title}$`) }).first();
  if (!(await t.count())) {
    await page.getByRole("button", { name: "Paneles" }).click();
    await page
      .getByRole("menuitemcheckbox", { name: title })
      .or(page.getByRole("menuitem", { name: title }))
      .first()
      .click();
    await page.keyboard.press("Escape");
  }
  await page
    .locator(".dv-tab", { hasText: new RegExp(`^${title}$`) })
    .first()
    .click();
  const sec = page.locator(`section[aria-label='${title}']`);
  await sec.waitFor({ timeout: 8_000 }).catch(() => {});
  return sec;
}
async function english(locator) {
  return locator.evaluate((root, terms) => {
    const copy = root.cloneNode(true);
    for (const d of copy.querySelectorAll("details:not([open]), style, script, .xterm-helpers"))
      d.remove();
    const parts = [copy.textContent ?? ""];
    for (const el of copy.querySelectorAll("[title],[aria-label],[placeholder],[data-tooltip]"))
      for (const a of ["title", "aria-label", "placeholder", "data-tooltip"])
        if (el.getAttribute(a)) parts.push(el.getAttribute(a));
    const text = parts.join(" \n ");
    return terms.filter((t) =>
      new RegExp(
        `(^|[^\\p{L}])${t.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}($|[^\\p{L}])`,
        "iu",
      ).test(text),
    );
  }, DENY);
}
async function waitJobs(types, ms = 180_000) {
  const end = Date.now() + ms;
  for (;;) {
    const jobs = await apiJson("/api/jobs?limit=100");
    const act = jobs.filter(
      (j) => (!types || types.includes(j.type)) && ["queued", "running"].includes(j.status),
    );
    if (!act.length || Date.now() > end) return jobs;
    await sleep(500);
  }
}
async function upload(file) {
  const form = new FormData();
  form.append("file", new Blob([readFileSync(file)]), path.basename(file));
  const res = await fetch(`${API}/api/media`, { method: "POST", body: form });
  return res.json();
}
async function openProject(id) {
  const proj = await apiJson(`/api/projects/${id}`);
  await page.evaluate((p) => localStorage.setItem("studio.project.v1", JSON.stringify(p)), proj);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".dv-tab", { timeout: 60_000 });
  await page
    .getByText("Guardado", { exact: true })
    .waitFor({ timeout: 20_000 })
    .catch(() => {});
}
async function flow(id, fn) {
  if (ONLY && !ONLY.includes(id)) return;
  const t = Date.now();
  const obs = { notes: [], deadEnds: [], waits: {}, shots: [] };
  try {
    await fn(obs);
    obs.ok = true;
  } catch (err) {
    obs.ok = false;
    obs.error = String(err?.message ?? err)
      .split("\n")[0]
      .slice(0, 300);
    obs.shots.push(await shot(`f${id}-error`).catch(() => null));
  }
  obs.ms = Date.now() - t;
  obs.toasts = [...toasts];
  toasts.length = 0;
  report[id] = obs;
  console.log(
    `FLOW ${id} ${obs.ok ? "ok" : "ERR " + obs.error} ${JSON.stringify(obs).slice(0, 600)}`,
  );
  writeFileSync(path.join(OUT, "heat.json"), JSON.stringify(report, null, 1));
}

await page.goto(WEB, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".dv-tab", { timeout: 60_000 });

// ---------------------------------------------------------------- 1. Primer proyecto -> exportar
await flow("1", async (o) => {
  let clicks = 0;
  await page.mouse.click(700, 5);
  await page.keyboard.press("Control+Alt+n");
  clicks++;
  await page
    .getByTestId("project-name")
    .filter({ hasText: "Proyecto sin título" })
    .waitFor({ timeout: 15_000 });
  await tab("Vista previa");
  clicks++;
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("preview-empty").getByRole("button", { name: "Importar" }).click();
  clicks++;
  const t0 = Date.now();
  await (await chooser).setFiles(path.join(MEDIA, "vertical.mp4"));
  await page.locator("[data-clip-id]").first().waitFor({ timeout: 90_000 });
  o.waits.importToTimeline_s = +((Date.now() - t0) / 1000).toFixed(1);
  const exp = await tab("Exportar");
  clicks++;
  const reels = exp.getByRole("button", { name: /Reels \/ TikTok/ });
  if (!(await reels.getAttribute("aria-pressed").catch(() => null))?.includes("true")) {
    await reels.click();
    clicks++;
  }
  const go = exp.getByRole("button", { name: "Exportar", exact: true });
  for (let i = 0; i < 120 && (await go.isDisabled()); i++) await sleep(500);
  if (
    await exp
      .getByTestId("export-aspect-choice")
      .isVisible()
      .catch(() => false)
  ) {
    o.deadEnds.push("pidió elegir encuadre con un video vertical");
    await exp.getByTestId("export-aspect-choice").locator("input[type=radio]").nth(1).check();
    clicks++;
  }
  await go.click();
  clicks++;
  const t1 = Date.now();
  await exp.getByTestId("export-result").waitFor({ timeout: 240_000 });
  o.waits.export_s = +((Date.now() - t1) / 1000).toFixed(1);
  o.resultText = (await exp.getByTestId("export-result").textContent()).slice(0, 300);
  o.hasOpen = await exp
    .getByTestId("export-result")
    .getByRole("button", { name: /Abrir carpeta/ })
    .isVisible();
  o.clicks = clicks;
  o.shots.push(await shot("f1-export-resultado"));
  o.english = await english(exp);
  await collectToasts();
});

// ---------------------------------------------------------------- 2. Subtítulos / edición por texto
let p2;
await flow("2", async (o) => {
  const asset = await upload(path.join(MEDIA, "clip.mp4"));
  await waitJobs(["media.probe", "media.proxy"]);
  const created = (
    await apiSend("POST", "/api/projects", {
      name: "Mapa flujo 2",
      settings: { width: 1080, height: 1920, fps: 30 },
    })
  ).json;
  const v = created.tracks.find((t) => t.kind === "video");
  v.clips = [
    {
      id: "f2v",
      trackId: v.id,
      assetId: asset.id,
      start: 0,
      in: 0,
      out: 12,
      speed: 1,
      volume: 1,
      opacity: 1,
      voiceEffects: [],
    },
  ];
  await apiSend("PUT", `/api/projects/${created.id}`, created);
  p2 = created.id;
  await openProject(created.id);
  await tab("Línea de tiempo");
  await page.locator("[data-clip-id='f2v']").first().click();
  let clicks = 1;
  const subs = await tab("Subtítulos");
  clicks++;
  const tr = subs.getByRole("button", { name: /Transcribir clip/ });
  o.transcribeEnabled = await tr.isEnabled().catch(() => false);
  o.transcribeTip = await tr.getAttribute("data-tooltip").catch(() => null);
  if (o.transcribeEnabled) {
    await tr.click();
    clicks++;
    const t0 = Date.now();
    await waitJobs(["subtitles.transcribe"], 120_000);
    o.waits.transcribe_s = +((Date.now() - t0) / 1000).toFixed(1);
    await sleep(1500);
    o.transcribeToasts = await collectToasts();
    o.shots.push(await shot("f2-transcribir"));
  }
  // Guion (Whisper real is not in the sandbox: the script transcription is the mock of M1)
  const g = await tab("Guion");
  clicks++;
  const tg = g.getByRole("button", { name: /Transcribir para el guion/ });
  await tg
    .or(g.locator("[data-testid='script-word']").first())
    .first()
    .waitFor({ timeout: 15_000 });
  if (await tg.isVisible().catch(() => false)) {
    await tg.click();
    clicks++;
    const t0 = Date.now();
    await g.locator("[data-testid='script-word']").first().waitFor({ timeout: 120_000 });
    o.waits.scriptTranscribe_s = +((Date.now() - t0) / 1000).toFixed(1);
  }
  const safe = g.getByTestId("script-remove-safe");
  o.safeLabel = await safe.textContent();
  const before = await g.locator("[data-testid='script-word']").count();
  await safe.click();
  clicks++;
  await sleep(800);
  o.wordsBeforeAfter = [before, await g.locator("[data-testid='script-word']").count()];
  const w = g.locator("[data-testid='script-word']").nth(3);
  await w.click();
  await page.keyboard.press("F2");
  clicks += 2;
  const input = g.getByTestId("script-fix-input");
  await input.fill("corregida");
  await input.press("Enter");
  clicks++;
  o.shots.push(await shot("f2-guion"));
  // estilo «Reels» y exportar 9:16
  const subs2 = await tab("Subtítulos");
  clicks++;
  o.styleOptions = await subs2
    .locator("select")
    .first()
    .locator("option")
    .allTextContents()
    .catch(() => []);
  o.englishSubs = await english(subs2);
  const exp = await tab("Exportar");
  clicks++;
  await exp.getByRole("button", { name: /Reels \/ TikTok/ }).click();
  clicks++;
  const go = exp.getByRole("button", { name: "Exportar", exact: true });
  for (let i = 0; i < 60 && (await go.isDisabled()); i++) await sleep(500);
  await go.click();
  clicks++;
  const t1 = Date.now();
  await exp.getByTestId("export-result").waitFor({ timeout: 240_000 });
  o.waits.export_s = +((Date.now() - t1) / 1000).toFixed(1);
  o.resultText = (await exp.getByTestId("export-result").textContent()).slice(0, 300);
  o.clicks = clicks;
  const jobs = await apiJson("/api/jobs?type=project.export&limit=5");
  const job = await apiJson(`/api/jobs/${jobs[0].id}`);
  o.exportResult = job.result;
  const check = await apiSend("POST", "/api/design/check", {
    projectId: created.id,
    aspect: "9:16",
  });
  o.designCheck = {
    passed: check.json?.passed,
    failed: check.json?.rules?.filter((r) => !r.passed).map((r) => r.id),
  };
  // 3 frames of the export
  const abs = path.join(STORAGE, job.result.path);
  for (const [i, t] of [1, 5, 9].entries()) {
    const f = path.join(OUT, "shots", `mapa-${DAY}-f2-fotograma-${i + 1}.png`);
    spawnSync("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-ss",
      String(t),
      "-i",
      abs,
      "-frames:v",
      "1",
      "-vf",
      "scale=540:-1",
      f,
    ]);
    o.shots.push(path.basename(f));
  }
  o.shots.push(await shot("f2-export"));
});

// ---------------------------------------------------------------- 3a. Asistente / Consola
await flow("3a", async (o) => {
  if (p2) await openProject(p2);
  const a = await tab("Asistente");
  let clicks = 1;
  o.sugerencias = await a.getByTestId("suggestion-card").count();
  o.sugerenciasText = (await a.getByTestId("suggestion-card").allTextContents()).map((x) =>
    x.slice(0, 80),
  );
  const box = a.getByLabel("Comando para el asistente");
  await box.fill("cortá los silencios y exportá para Reels");
  const t0 = Date.now();
  await a.getByRole("button", { name: /Proponer/ }).click();
  clicks++;
  await a
    .getByTestId("agent-plan")
    .or(a.locator("[role=alert]"))
    .first()
    .waitFor({ timeout: 120_000 });
  o.waits.propose_s = +((Date.now() - t0) / 1000).toFixed(1);
  const plan = a.getByTestId("agent-plan");
  o.planText = (await plan.textContent().catch(() => "")).slice(0, 500);
  o.shots.push(await shot("f3a-plan"));
  // choose framing if asked
  const choice = plan.getByRole("button", { name: /Recortar al centro|centro/i }).first();
  if (await choice.isVisible().catch(() => false)) {
    await choice.click();
    clicks++;
    await sleep(1500);
  }
  // check every op and confirm
  for (const cb of await plan.getByRole("checkbox").all())
    if (!(await cb.isChecked())) {
      await cb.check();
      clicks++;
    }
  const confirm = plan.getByRole("button", { name: /^Confirmar/ });
  if (await confirm.isVisible().catch(() => false)) {
    await confirm.click();
    clicks++;
  }
  const apply = plan.getByRole("button", { name: /^Aplicar \(/ });
  const t1 = Date.now();
  await apply.click();
  clicks++;
  await plan.getByRole("button", { name: /Deshacer todo/ }).waitFor({ timeout: 300_000 });
  o.waits.apply_s = +((Date.now() - t1) / 1000).toFixed(1);
  o.afterApply = (await plan.textContent()).slice(0, 400);
  o.shots.push(await shot("f3a-aplicado"));
  await plan.getByRole("button", { name: /Deshacer todo/ }).click();
  clicks++;
  await sleep(2500);
  o.afterUndo = (await plan.textContent()).slice(0, 200);
  o.clicks = clicks;
  // Consola
  const c = await tab("Consola Claude");
  await sleep(1500);
  o.console = (await c.textContent()).slice(0, 300);
  o.shots.push(await shot("f3a-consola"));
  o.english = await english(a);
  await collectToasts();
});

// ---------------------------------------------------------------- 3b. Evaluar modelos
await flow("3b", async (o) => {
  await page.getByRole("button", { name: "Ajustes" }).click();
  await page.getByRole("tab", { name: "Asistente local" }).click();
  let clicks = 2;
  const q = page.getByTestId("eval-quick");
  await q.waitFor({ timeout: 10_000 });
  o.quickEnabled = await q.isEnabled();
  o.quickTip = await q.getAttribute("data-tooltip");
  if (o.quickEnabled) {
    const t0 = Date.now();
    await q.click();
    clicks++;
    await page
      .getByTestId("eval-progress")
      .waitFor({ timeout: 20_000 })
      .catch(() => {});
    o.progressText = await page
      .getByTestId("eval-progress")
      .textContent()
      .catch(() => null);
    await page.getByTestId("agent-eval").waitFor({ timeout: 180_000 });
    o.waits.eval_s = +((Date.now() - t0) / 1000).toFixed(1);
    o.evalText = (await page.getByTestId("agent-eval").textContent()).slice(0, 300);
  }
  o.suggestionSettings = (
    await page
      .getByTestId("suggestion-settings")
      .textContent()
      .catch(() => "")
  ).slice(0, 200);
  o.shots.push(await shot("f3b-evaluar"));
  o.english = await english(page.locator("[role=dialog]").first());
  o.clicks = clicks;
  await page.keyboard.press("Escape");
});

// ---------------------------------------------------------------- 4. Servicios caídos y paquetes
await flow("4", async (o) => {
  // workers down: kill the mock workers (same command line restarts them)
  spawnSync("fuser", ["-k", "-n", "tcp", new URL(WORKERS).port || "8001"]);
  await sleep(1500);
  if (p2) await openProject(p2);
  const t0 = Date.now();
  await page
    .getByTestId("service-banner")
    .or(page.getByRole("alert").filter({ hasText: /IA local/ }))
    .first()
    .waitFor({ timeout: 30_000 })
    .catch(() => {});
  o.waits.bannerAfterDown_s = +((Date.now() - t0) / 1000).toFixed(1);
  o.banner = (
    await page
      .getByRole("alert")
      .filter({ hasText: /IA local|Studio/ })
      .first()
      .textContent()
      .catch(() => null)
  )?.slice(0, 200);
  await tab("Línea de tiempo");
  await page
    .locator("[data-clip-id='f2v']")
    .first()
    .click()
    .catch(() => {});
  const subs = await tab("Subtítulos");
  const tr = subs.getByRole("button", { name: /Transcribir clip/ });
  o.transcribeDisabledWhenDown = await tr.isDisabled().catch(() => null);
  o.transcribeReason = await tr.getAttribute("data-tooltip").catch(() => null);
  o.shots.push(await shot("f4-ia-apagada"));
  // restart workers
  const py = path.join(REPO, "apps/workers/.venv/bin/python");
  const w = spawn(py, [path.join(REPO, "scripts/e2e/workers-with-mocks.py")], {
    cwd: REPO,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, STUDIO_MOCK_DENOISE: "0", STORAGE_DIR: STORAGE, MODELS_DIR: MODELS },
  });
  w.unref();
  const t1 = Date.now();
  for (let i = 0; i < 120; i++) {
    if (
      await fetch(`${WORKERS}/health`)
        .then((r) => r.ok)
        .catch(() => false)
    )
      break;
    await sleep(500);
  }
  await page
    .getByRole("button", { name: /Reintentar/ })
    .first()
    .click()
    .catch(() => {});
  for (let i = 0; i < 60 && (await tr.isDisabled().catch(() => true)); i++) await sleep(500);
  o.waits.backAfterRestart_s = +((Date.now() - t1) / 1000).toFixed(1);
  o.transcribeEnabledAgain = await tr.isEnabled().catch(() => null);
  o.transcribeReasonAfter = await tr.getAttribute("data-tooltip").catch(() => null);
  // Limpiar voz without the pack (workers restarted with STUDIO_MOCK_DENOISE=0)
  const voz = await tab("Voz y audio");
  const clean = voz.getByRole("button", { name: /Limpiar voz/ }).first();
  if (await clean.isVisible().catch(() => false)) {
    await clean.click();
    await page
      .getByRole("dialog")
      .filter({ hasText: /Paquete requerido/ })
      .waitFor({ timeout: 20_000 })
      .catch(() => {});
    o.packDialog = (
      await page
        .getByRole("dialog")
        .filter({ hasText: /Paquete requerido/ })
        .textContent()
        .catch(() => null)
    )?.slice(0, 200);
    o.shots.push(await shot("f4-paquete-requerido"));
    await page.keyboard.press("Escape");
  } else o.notes.push("sin botón Limpiar voz visible");
  await collectToasts();
});

// ---------------------------------------------------------------- 5. Motion, perfil de estilo, kit
await flow("5", async (o) => {
  if (p2) await openProject(p2);
  const m = await tab("Motion graphics");
  let clicks = 1;
  const sel = m.getByRole("combobox").first();
  o.templates = await sel
    .locator("option")
    .allTextContents()
    .catch(() => []);
  const lt = o.templates.find((t) => /Rótulo/.test(t));
  if (lt) {
    await sel.selectOption({ label: lt });
    clicks++;
  }
  o.englishMotion = await english(m);
  const style = m.getByRole("combobox", { name: /Estilo/ }).first();
  if (await style.isVisible().catch(() => false)) {
    o.styleOptions = await style.locator("option").allTextContents();
    await style.selectOption({ index: 1 });
    clicks++;
  }
  const pos = m.getByRole("combobox", { name: /Posición/ }).first();
  if (await pos.isVisible().catch(() => false)) {
    o.posOptions = await pos.locator("option").allTextContents();
    await pos.selectOption({ index: 1 });
    clicks++;
  }
  await m.getByRole("button", { name: /Añadir sin renderizar/ }).click();
  clicks++;
  await sleep(800);
  await tab("Línea de tiempo");
  const clip = page
    .locator("[data-clip-id]")
    .filter({ hasText: /Rótulo/ })
    .first();
  o.clipLabel = await clip.textContent().catch(() => null);
  await clip.dblclick();
  clicks++;
  const insp = page.locator("section[aria-label='Propiedades']");
  await insp.getByTestId("inspector-motion").waitFor({ timeout: 15_000 });
  const t0 = Date.now();
  await insp
    .locator("img")
    .first()
    .waitFor({ timeout: 20_000 })
    .catch(() => {});
  o.waits.stillPreview_s = +((Date.now() - t0) / 1000).toFixed(1);
  o.englishProps = await english(insp);
  o.shots.push(await shot("f5-propiedades"));
  const rn = insp.getByRole("button", { name: /Renderizar ahora/ });
  const t1 = Date.now();
  await rn.click();
  clicks++;
  await sleep(1500);
  await waitJobs(["motion.render"], 180_000);
  o.waits.render_s = +((Date.now() - t1) / 1000).toFixed(1);
  o.afterRender = (await insp.getByTestId("inspector-motion").textContent()).slice(0, 200);
  // Perfil de estilo: analizar clip.mp4
  const st = await tab("Perfil de estilo").catch(() => tab("Estilo"));
  o.styleTabText = (await st.textContent().catch(() => "")).slice(0, 200);
  await st
    .locator("select")
    .first()
    .selectOption({ label: "clip.mp4" })
    .catch(() => {});
  clicks++;
  const an = st.getByRole("button", { name: /^Analizar/ }).first();
  if (await an.isEnabled().catch(() => false)) {
    const t2 = Date.now();
    await an.click();
    clicks++;
    await st
      .getByTestId("style-analysis")
      .waitFor({ timeout: 180_000 })
      .catch(() => {});
    o.waits.styleAnalyze_s = +((Date.now() - t2) / 1000).toFixed(1);
    o.styleAnalysis = (
      await st
        .getByTestId("style-analysis")
        .textContent()
        .catch(() => null)
    )?.slice(0, 200);
    o.shots.push(await shot("f5-perfil"));
  } else o.notes.push("Analizar no visible en Perfil de estilo");
  // Kit de marca
  await page.getByRole("button", { name: "Ajustes" }).click();
  await page.getByRole("tab", { name: "Kit de marca" }).click();
  clicks += 2;
  await page.getByTestId("token-preview").waitFor({ timeout: 20_000 });
  await page.getByLabel("Color Acento").fill("#ff3b6b");
  clicks++;
  await sleep(2500);
  o.shots.push(await shot("f5-kit"));
  o.englishKit = await english(page.locator("[role=dialog]").first());
  await page.keyboard.press("Escape");
  o.clicks = clicks;
  await collectToasts();
});

// ---------------------------------------------------------------- 6. Voz
await flow("6", async (o) => {
  const v = await tab("Voz y audio");
  const picker = v.getByTestId("voice-picker");
  await picker.waitFor({ timeout: 15_000 });
  o.tabs = await picker.getByRole("tab").allTextContents();
  await picker.getByRole("tab", { name: "Voces de Studio" }).click();
  o.voices = (
    await v
      .getByRole("combobox")
      .first()
      .locator("option")
      .allTextContents()
      .catch(() => [])
  ).slice(0, 12);
  const ta0 = v.locator("textarea").first();
  if (await ta0.isVisible().catch(() => false)) await ta0.fill("Hola, esto es una prueba de voz.");
  const gen = v.getByRole("button", { name: /Generar/ }).first();
  o.generateEnabled = await gen.isEnabled().catch(() => null);
  o.generateTip =
    (await gen.getAttribute("data-tooltip").catch(() => null)) ??
    (await gen.getAttribute("title").catch(() => null));
  o.generateWhy = (
    await v
      .locator("p, span")
      .filter({ hasText: /instal|descarg|voz|Paquete/i })
      .allTextContents()
      .catch(() => [])
  ).slice(0, 4);
  const ta = v.locator("textarea").first();
  if (await ta.isVisible().catch(() => false)) await ta.fill("Hola, esto es una prueba de voz.");
  if (o.generateEnabled) {
    await gen.click();
    await sleep(4000);
    o.genToasts = await collectToasts();
  }
  o.shots.push(await shot("f6-voces-studio"));
  await picker.getByRole("tab", { name: "Mis voces" }).click();
  await sleep(500);
  o.misVoces = (await v.textContent()).slice(0, 300);
  await picker.getByRole("tab", { name: "Convertir mi grabación" }).click();
  await sleep(500);
  o.convertir = (await v.textContent()).slice(0, 300);
  o.shots.push(await shot("f6-convertir"));
  o.english = await english(v);
});

// ---------------------------------------------------------------- 7. Timeline 26 clips
await flow("7", async (o) => {
  const asset = (await apiJson("/api/media?limit=50")).find((a) => a.name === "clip.mp4");
  const created = (await apiSend("POST", "/api/projects", { name: "Mapa flujo 7" })).json;
  const v = created.tracks.find((t) => t.kind === "video");
  v.clips = Array.from({ length: 26 }, (_, i) => ({
    id: `t7c${i}`,
    trackId: v.id,
    assetId: asset.id,
    start: i * 2,
    in: 0,
    out: 2,
    speed: 1,
    volume: 1,
    opacity: 1,
    voiceEffects: [],
  }));
  await apiSend("PUT", `/api/projects/${created.id}`, created);
  await openProject(created.id);
  await tab("Línea de tiempo");
  const lat = {};
  const measure = async (name, fn) => {
    const t = await page.evaluate(() => performance.now());
    await fn();
    const d = await page.evaluate(
      (t0) =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now() - t0))),
        ),
      t,
    );
    lat[name] = Math.round(d);
  };
  const c = (i) => page.locator(`[data-clip-id='t7c${i}']`).first();
  await measure("select", () => c(2).click());
  await measure("shiftSelect", () => c(3).click({ modifiers: ["Shift"] }));
  await measure("rippleDelete", () => page.keyboard.press("Shift+Delete"));
  const n1 = await page.locator("[data-clip-id^='t7c']").count();
  await measure("undo", () => page.keyboard.press("Control+z"));
  await measure("redo", () => page.keyboard.press("Control+Shift+z"));
  await page.keyboard.press("Control+z");
  await c(5).click();
  await measure("splitS", () => page.keyboard.press("s"));
  const box = await c(8).boundingBox();
  await measure("drag", async () => {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
  });
  o.latency_ms = lat;
  o.clipsAfterRipple = n1;
  o.shots.push(await shot("f7-timeline"));
});

// ---------------------------------------------------------------- 8. Consistencia general
await flow("8", async (o) => {
  const panels = [
    "Media",
    "Vista previa",
    "Propiedades",
    "Línea de tiempo",
    "Subtítulos",
    "Guion",
    "Voz y audio",
    "Motion graphics",
    "Exportar",
    "Trabajos",
    "Asistente",
    "Biblioteca",
    "Perfil de estilo",
    "Consola Claude",
  ];
  o.english = {};
  o.iconNoTip = {};
  o.empty = {};
  for (const p of panels) {
    const sec = await tab(p).catch(() => null);
    if (!sec || !(await sec.count())) {
      o.english[p] = ["(no se abrió)"];
      continue;
    }
    await sleep(400);
    o.english[p] = await english(sec);
    o.iconNoTip[p] = await sec.evaluate((root) =>
      [...root.querySelectorAll("button[aria-label]")]
        .filter((b) => !b.textContent?.trim() && b.offsetParent !== null)
        .filter((b) => {
          const tip = b.dataset.tooltip ?? b.getAttribute("title") ?? "";
          return tip.length < 20 || tip === b.getAttribute("aria-label");
        })
        .map((b) => b.getAttribute("aria-label")),
    );
  }
  // Ajustes tabs
  await page.getByRole("button", { name: "Ajustes" }).click();
  const dlg = page.locator("[role=dialog]").first();
  // Only the dialog sections (the first tablist): Apariencia also has tabs for theme and density.
  o.settingsTabs = await dlg.getByRole("tablist").first().getByRole("tab").allTextContents();
  o.englishSettings = {};
  for (const t of o.settingsTabs) {
    await dlg.getByRole("tab", { name: t }).click();
    await sleep(500);
    o.englishSettings[t] = await english(dlg);
  }
  await page.keyboard.press("Escape");
  // focus visible with Tab
  await page.mouse.click(700, 5);
  const focus = [];
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    focus.push(
      await page.evaluate(() => {
        const e = document.activeElement;
        if (!e || e === document.body) return null;
        const s = getComputedStyle(e);
        return {
          tag: e.tagName,
          label: (e.getAttribute("aria-label") ?? e.textContent ?? "").trim().slice(0, 30),
          ring: s.outlineStyle !== "none" || s.boxShadow !== "none",
        };
      }),
    );
  }
  o.focus = focus;
  o.fonts = await page.evaluate(() => {
    const f = new Set();
    for (const el of document.querySelectorAll("body *")) {
      if (el.closest("[data-testid='token-preview'],canvas,svg")) continue;
      if (el.offsetParent === null || !el.textContent?.trim()) continue;
      f.add(getComputedStyle(el).fontFamily.split(",")[0].replace(/["']/g, "").trim());
    }
    return [...f];
  });
  o.shots.push(await shot("f8-general"));
});

report.consoleErrors = consoleErrors.slice(0, 40);
writeFileSync(path.join(OUT, "heat.json"), JSON.stringify(report, null, 1));
await browser.close();
console.log("DONE");

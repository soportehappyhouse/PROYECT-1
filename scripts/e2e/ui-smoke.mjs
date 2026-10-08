#!/usr/bin/env node
/* global document, window */
// Headless UI smoke test of the Studio dashboard with Playwright (Chromium).
//
//   node scripts/e2e/ui-smoke.mjs --web http://127.0.0.1:3000 --api http://127.0.0.1:3001 \
//        --media <folder with a .mp4/.wav/.png> [--shots docs/trabajo/capturas] [--headed] [--vp9-preview]
//        [--only <regex>]
//
// Needs the `playwright` package (global: `npm i -g playwright && npx playwright install chromium`,
// or set --playwright <path to playwright/index.mjs>). The web must be built with
// NEXT_PUBLIC_API_URL pointing at --api. It does not fail fast: each step is reported.

import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const WEB = opt("web", "http://127.0.0.1:3000").replace(/\/+$/, "");
const API = opt("api", "http://127.0.0.1:3001").replace(/\/+$/, "");
const MEDIA = path.resolve(opt("media", "."));
const SHOTS = path.resolve(opt("shots", "docs/trabajo/capturas"));
const PW = opt("playwright", "playwright");
const HEADED = argv.includes("--headed");
const MAX_SHOT_BYTES = 300 * 1024;

const { chromium } = await import(PW.endsWith(".mjs") ? pathToFileURL(PW).href : PW);
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** --only <regex>: run only the matching steps (each step must then set up its own state). */
const ONLY = opt("only") ? new RegExp(opt("only"), "i") : undefined;
async function step(name, fn) {
  if (ONLY && !ONLY.test(name)) return;
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ name, status: "PASS", ms: Date.now() - t, detail: detail ?? null });
    console.log(
      `PASS ${((Date.now() - t) / 1000).toFixed(1)} s  ${name}${detail ? `  ${JSON.stringify(detail)}` : ""}`,
    );
  } catch (err) {
    results.push({
      name,
      status: "FAIL",
      ms: Date.now() - t,
      detail: String(err?.message ?? err).slice(0, 300),
    });
    console.log(
      `FAIL ${((Date.now() - t) / 1000).toFixed(1)} s  ${name}  ${String(err?.message ?? err).split("\n")[0]}`,
    );
  }
}
const apiJson = async (route, init) => (await fetch(`${API}${route}`, init)).json();

/** Move the playhead by clicking the ruler (px/s measured from the "00:00" and "00:02" ticks). */
async function seek(page, sec) {
  const ruler = page.getByLabel("Regla de tiempo");
  const box = await ruler.boundingBox();
  const x0 = (await ruler.getByText("00:00", { exact: true }).boundingBox())?.x ?? box.x;
  const x2 = (await ruler.getByText("00:02", { exact: true }).boundingBox())?.x ?? box.x + 120;
  await page.mouse.click(x0 + ((x2 - x0) / 2) * sec + 1, box.y + box.height / 2);
}

/** Screenshot; if the PNG is above 300 KB re-encode it as 8-bit palette PNG with ffmpeg. */
async function shot(page, name, opts = {}) {
  const file = path.join(SHOTS, name);
  // notifications are transient: hide them (CSS only, React owns the DOM) so captures show panels
  await page.evaluate(() => {
    const st = document.createElement("style");
    st.id = "e2e-hide-toasts";
    st.textContent = "[data-sonner-toaster]{display:none!important}";
    document.head.appendChild(st);
  });
  await page.screenshot({ path: file, ...opts });
  await page.evaluate(() => document.getElementById("e2e-hide-toasts")?.remove());
  if ((await stat(file)).size > MAX_SHOT_BYTES) {
    const tmp = `${file}.tmp.png`;
    spawnSync("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-i",
      file,
      "-vf",
      "split[a][b];[a]palettegen=max_colors=192[p];[b][p]paletteuse=dither=none",
      tmp,
    ]);
    if (existsSync(tmp)) {
      const { rename } = await import("node:fs/promises");
      await rename(tmp, file);
    }
  }
  return `${name} ${Math.round((await stat(file)).size / 1024)} KB`;
}

const files = await readdir(MEDIA);
const pick = (re) => files.map((f) => path.join(MEDIA, f)).find((f) => re.test(f));
const VIDEO = pick(/\.(mp4|mov|webm|mkv)$/i);
const AUDIO = pick(/\.(wav|mp3|m4a|ogg)$/i);
const IMAGE = pick(/\.(png|jpe?g|webp)$/i);

const browser = await chromium.launch({ headless: !HEADED });
const context = await browser.newContext({
  viewport: { width: 1366, height: 820 },
  colorScheme: "dark",
  locale: "es-ES",
});
// --vp9-preview: Playwright's open-source Chromium has no H.264/AAC decoder (Chrome/Edge do), so
// for the captures the H.264 proxies/originals are transcoded on the fly to VP9 WebM.
const VP9 = argv.includes("--vp9-preview");
const vp9Cache = new Map();
async function routeVp9(ctx) {
  const { mkdtemp, readFile, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const dir = await mkdtemp(path.join(os.tmpdir(), "studio-vp9-"));
  await ctx.route(
    /\/(files\/proxies\/[^/]+\.mp4|api\/media\/[^/]+\/file)(\?.*)?$/,
    async (route) => {
      const url = route.request().url();
      if (!vp9Cache.has(url)) {
        const res = await route.fetch({ headers: { ...route.request().headers(), range: "" } });
        const type = res.headers()["content-type"] ?? "";
        if (!/video\/(mp4|quicktime)/.test(type)) return route.fulfill({ response: res });
        const src = path.join(dir, `${vp9Cache.size}.mp4`);
        const out = path.join(dir, `${vp9Cache.size}.webm`);
        await writeFile(src, await res.body());
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
        vp9Cache.set(url, await readFile(out));
      }
      // The canvas preview loads media with crossOrigin="anonymous" (keep the CORS header) and
      // seeks it: answer byte ranges (a 200 without Accept-Ranges is not seekable in Chromium).
      const body = vp9Cache.get(url);
      const range = /bytes=(\d*)-(\d*)/.exec(route.request().headers().range ?? "");
      const headers = { "access-control-allow-origin": "*", "accept-ranges": "bytes" };
      if (!range) return route.fulfill({ status: 200, contentType: "video/webm", headers, body });
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
      return route.fulfill({
        status: 206,
        contentType: "video/webm",
        headers: { ...headers, "content-range": `bytes ${start}-${end}/${body.length}` },
        body: body.subarray(start, end + 1),
      });
    },
  );
}
if (VP9) await routeVp9(context);
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 200)));
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 200)}`));

const tabs = () => page.$$eval(".dv-tab", (els) => els.map((e) => e.textContent?.trim()));
const groups = () =>
  page.$$eval(".dv-groupview", (gs) =>
    gs.map((g) => [...g.querySelectorAll(".dv-tab")].map((t) => t.textContent?.trim())),
  );

await step("dashboard loads and core panels render", async () => {
  await page.goto(WEB, { waitUntil: "domcontentloaded" }); // SSE keeps the network busy
  await page.waitForSelector("section[aria-label='Línea de tiempo']", { timeout: 60_000 });
  await page.getByText("Guardado", { exact: true }).waitFor({ timeout: 15_000 });
  const t = await tabs();
  for (const name of [
    "Media",
    "Vista previa",
    "Línea de tiempo",
    "Motion graphics",
    "Exportar",
    "Trabajos",
  ])
    if (!t.includes(name)) throw new Error(`tab ${name} missing: ${t}`);
  return { tabs: t.length, groups: (await groups()).length };
});

await step("upload video, audio and image through the Media panel", async () => {
  const input = page.locator("section[aria-label='Media'] input[type=file]");
  await input.setInputFiles([VIDEO, AUDIO, IMAGE].filter(Boolean));
  for (const f of [VIDEO, AUDIO, IMAGE].filter(Boolean))
    await page
      .locator("section[aria-label='Media'] li", { hasText: path.basename(f) })
      .waitFor({ timeout: 60_000 });
  // wait for probe/proxy so the thumbnail shows
  for (let i = 0; i < 60; i++) {
    const jobs = await apiJson("/api/jobs?limit=50");
    if (jobs.length && jobs.every((j) => !["queued", "running"].includes(j.status))) break;
    await sleep(500);
  }
  await page.getByRole("button", { name: "Recargar medios" }).click();
  await page.locator("section[aria-label='Media'] li img").first().waitFor({ timeout: 20_000 });
  return { items: await page.locator("section[aria-label='Media'] li").count() };
});

await step("drag the video from Media onto the Video 1 track", async () => {
  const item = page.locator("section[aria-label='Media'] li", { hasText: path.basename(VIDEO) });
  const track = page.locator("[data-track-kind='video']").first();
  const a = await item.boundingBox();
  const b = await track.boundingBox();
  await page.mouse.move(a.x + 30, a.y + a.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(a.x + 30 + i * 3, a.y + a.height / 2 + i * 2);
  await page.mouse.move(b.x + 4, b.y + b.height / 2, { steps: 15 }); // ~0 s
  await page.mouse.up();
  await page
    .locator("[data-track-kind='video'] [data-clip-id]")
    .first()
    .waitFor({ timeout: 5_000 });
  // audio + image with the "+" button (keyboard-free alternative to dragging)
  if (AUDIO)
    await page
      .getByRole("button", {
        name: `Añadir ${path.basename(AUDIO)} a la línea de tiempo`,
        exact: true,
      })
      .click();
  return { clips: await page.locator("[data-clip-id]").count() };
});

await step("screenshot: dashboard with media and timeline", async () => {
  await page.locator("[data-track-kind='video'] [data-clip-id]").first().click();
  await seek(page, 3);
  await sleep(1500);
  return shot(page, "01-dashboard.png");
});

await step("hide a panel (Voz y audio) and move another (Biblioteca → centre group)", async () => {
  await page.getByRole("button", { name: "Paneles" }).click();
  await page
    .getByRole("menuitemcheckbox", { name: "Voz y audio" })
    .or(page.getByRole("menuitem", { name: "Voz y audio" }))
    .click();
  await page.keyboard.press("Escape");
  await sleep(300);
  if ((await tabs()).includes("Voz y audio")) throw new Error("Voz y audio still visible");
  // dockview uses native HTML5 drag & drop: drag the tab onto the centre of the target group
  const src = await page.locator(".dv-tab", { hasText: "Biblioteca" }).boundingBox();
  const dst = await page
    .locator(".dv-groupview", { has: page.locator(".dv-tab", { hasText: "Vista previa" }) })
    .locator(".dv-content-container")
    .boundingBox();
  await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
  await page.mouse.down();
  await page.mouse.move(src.x + 40, src.y + 20, { steps: 5 });
  await page.mouse.move(dst.x + dst.width / 2, dst.y + dst.height / 2, { steps: 20 });
  await sleep(300);
  await page.mouse.up();
  await sleep(500);
  const g = await groups();
  const moved = g.some((x) => x.includes("Biblioteca") && x.includes("Vista previa"));
  if (!moved) throw new Error(`Biblioteca not moved: ${JSON.stringify(g)}`);
  await sleep(2500); // settings are saved debounced
  return { groups: g };
});

await step("layout persists after reload (localStorage) and in a fresh browser (api)", async () => {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("section[aria-label='Línea de tiempo']");
  await sleep(1000);
  const g1 = await groups();
  const ok1 =
    !g1.flat().includes("Voz y audio") &&
    g1.some((x) => x.includes("Biblioteca") && x.includes("Vista previa"));
  const fresh = await browser.newContext({
    viewport: { width: 1366, height: 820 },
    colorScheme: "dark",
  });
  const p2 = await fresh.newPage();
  await p2.goto(WEB, { waitUntil: "domcontentloaded" });
  await p2.waitForSelector("section[aria-label='Línea de tiempo']");
  await sleep(1500);
  const g2 = await p2.$$eval(".dv-groupview", (gs) =>
    gs.map((g) => [...g.querySelectorAll(".dv-tab")].map((t) => t.textContent?.trim())),
  );
  await fresh.close();
  const ok2 =
    !g2.flat().includes("Voz y audio") &&
    g2.some((x) => x.includes("Biblioteca") && x.includes("Vista previa"));
  const settings = await apiJson("/api/settings");
  if (!ok1) throw new Error(`after reload: ${JSON.stringify(g1)}`);
  if (!ok2)
    throw new Error(
      `fresh browser (api copy): ${JSON.stringify(g2)} · api ui.layout ${settings.ui?.layout ? "set" : "absent"}`,
    );
  return { reload: ok1, freshBrowser: ok2 };
});

await step("restore default layout", async () => {
  await page.getByRole("button", { name: "Layouts" }).click();
  await page.getByRole("menuitem", { name: /Restaurar layout/ }).click();
  await sleep(800);
  return { tabs: (await tabs()).length };
});

let motionJobId;
await step("Motion panel: choose «Título», edit props, «Renderizar y añadir»", async () => {
  await page.locator(".dv-tab", { hasText: "Motion graphics" }).click();
  const panel = page.locator("section[aria-label='Motion graphics']");
  await panel.locator("select").first().selectOption({ value: "remotion:title-card" });
  const field = (label) =>
    panel
      .locator(
        `xpath=.//label[normalize-space(text()[1])='${label}']//*[self::input or self::textarea]`,
      )
      .first();
  await field("Título").fill("Mi primer título");
  await field("Subtítulo").fill("Hecho con Studio");
  await sleep(600);
  const before = new Set((await apiJson("/api/jobs?type=motion.render&limit=50")).map((j) => j.id));
  await shot(page, "03-motion-form.png");
  await panel.getByRole("button", { name: /Renderizar y añadir/ }).click();
  for (let i = 0; i < 40 && !motionJobId; i++) {
    motionJobId = (await apiJson("/api/jobs?type=motion.render&limit=50")).find(
      (j) => !before.has(j.id),
    )?.id;
    await sleep(250);
  }
  if (!motionJobId) throw new Error("no motion.render job was created");
  return { jobId: motionJobId };
});

await step("Jobs panel shows the render progressing (SSE) and finishing", async () => {
  await page.locator(".dv-tab", { hasText: "Trabajos" }).click();
  const jobsPanel = page.locator("section[aria-label='Trabajos']");
  await jobsPanel.waitFor();
  let shotTaken = "";
  let seenProgress = false;
  for (let i = 0; i < 240; i++) {
    const job = await apiJson(`/api/jobs/${motionJobId}`);
    if (!shotTaken && job.status === "running" && job.progress > 0.15) {
      shotTaken = await shot(page, "04-jobs-progress.png");
      seenProgress = await jobsPanel
        .locator("[role=progressbar], progress")
        .count()
        .then((n) => n > 0)
        .catch(() => false);
    }
    if (["succeeded", "failed", "canceled"].includes(job.status)) {
      if (job.status !== "succeeded") throw new Error(`job ${job.status}: ${job.error}`);
      break;
    }
    await sleep(500);
  }
  await sleep(1500);
  const text = await jobsPanel.innerText();
  if (!/complet|Listo|100/i.test(text)) throw new Error(`jobs panel text: ${text.slice(0, 200)}`);
  return { shotTaken, progressbar: seenProgress };
});

await step("motion clip on the timeline got the render (preview)", async () => {
  await page.locator(".dv-tab", { hasText: "Línea de tiempo" }).click();
  await page
    .locator("[data-track-kind='motion'] [data-clip-id]")
    .first()
    .waitFor({ timeout: 10_000 });
  await page.locator("[data-track-kind='motion'] [data-clip-id]").first().click();
  await seek(page, 1.5);
  await sleep(2000);
  return shot(page, "02-timeline-motion.png");
});

await step("Export panel with presets", async () => {
  await page.locator(".dv-tab", { hasText: "Exportar" }).click();
  await page.locator("section[aria-label='Exportar']").waitFor();
  await sleep(800);
  return shot(page, "05-export-panel.png");
});

// Feedback 2026-10-05 (items 8 and 9): tooltips with shortcuts, Space/J/K/L.
await step("tooltip on the timeline scissors: «Cortar en el cursor (S)»", async () => {
  await page.locator(".dv-tab", { hasText: "Línea de tiempo" }).click();
  await page.getByRole("button", { name: "Cortar en el cursor" }).hover();
  const tip = page.getByRole("tooltip");
  await tip.waitFor({ timeout: 3_000 });
  const text = (await tip.textContent())?.trim();
  if (text !== "Cortar en el cursor (S)") throw new Error(`tooltip: ${text}`);
  await page.mouse.move(0, 0);
  return { text };
});

await step("Space plays/pauses once with the Play button focused; L/K shuttle", async () => {
  const preview = page.locator("section[aria-label='Vista previa']");
  await page.locator(".dv-tab", { hasText: "Vista previa" }).click();
  await seek(page, 0.2);
  const play = () => preview.getByRole("button", { name: /^(Reproducir|Pausar)$/ });
  await play().click(); // starts playing and leaves the button focused
  await sleep(300);
  if ((await play().getAttribute("aria-label")) !== "Pausar") throw new Error("click did not play");
  await page.keyboard.press("Space"); // must pause (once), not pause + click again
  await sleep(400);
  const afterSpace = await play().getAttribute("aria-label");
  if (afterSpace !== "Reproducir") throw new Error(`after Space: ${afterSpace}`);
  await page.keyboard.press("l");
  await sleep(300);
  const afterL = await play().getAttribute("aria-label");
  await page.keyboard.press("k");
  await sleep(300);
  const afterK = await play().getAttribute("aria-label");
  if (afterL !== "Pausar" || afterK !== "Reproducir") throw new Error(`L ${afterL} / K ${afterK}`);
  return { afterSpace, afterL, afterK };
});

await step("command palette (Ctrl+K)", async () => {
  await page.keyboard.press("Control+k");
  await page.getByRole("dialog").waitFor({ timeout: 5_000 });
  await sleep(400);
  const s = await shot(page, "06-command-palette.png");
  await page.keyboard.press("Escape");
  return s;
});

// Sprint 1 (web): GPU indicator + «Paquetes de IA», and the social review saved in the project.
await step("GPU indicator and Ajustes → Paquetes de IA", async () => {
  const gpu = page.getByTestId("gpu-indicator");
  await gpu.waitFor({ timeout: 15_000 });
  const label = await gpu.getAttribute("aria-label");
  await page.getByRole("button", { name: "Ajustes" }).click();
  await page.getByRole("tab", { name: "Paquetes de IA" }).click();
  const rows = page.getByTestId("pack-row");
  await rows.first().waitFor({ timeout: 15_000 });
  const packs = await rows.count();
  await page.keyboard.press("Escape");
  return { label, packs };
});

// Integration: a real `409 PACK_REQUIRED` (flat body) from the api must open «Paquete requerido».
await step("Limpiar voz (IA) without the pack: real 409 opens «Paquete requerido»", async () => {
  const pack = (await apiJson("/api/ai/packs")).find((p) => p.id === "voz-limpia");
  if (!pack) throw new Error("pack voz-limpia not listed by /api/ai/packs");
  if (pack.installed) return { skipped: "voz-limpia is installed here: no 409 to trigger" };
  await page.locator(".dv-tab", { hasText: "Línea de tiempo" }).click();
  await page.locator("[data-track-kind='video'] [data-clip-id]").first().click();
  await page.locator(".dv-tab", { hasText: "Voz y audio" }).click();
  const panel = page.locator("section[aria-label='Voz y audio']");
  await panel.getByRole("tab", { name: "Efectos" }).click();
  await panel.getByRole("button", { name: /Limpiar voz \(IA\)/ }).click();
  const dialog = page.getByTestId("pack-required");
  await dialog.waitFor({ timeout: 10_000 });
  const text = (await dialog.innerText()).replace(/\s+/g, " ");
  if (!text.includes(pack.name_es)) throw new Error(`dialog text: ${text.slice(0, 200)}`);
  const download = await dialog.getByRole("button", { name: /^Descargar/ }).textContent();
  await shot(page, "07-pack-required.png");
  await dialog.getByRole("button", { name: "Cancelar" }).click();
  return { pack: pack.id, download: download?.trim() };
});

await step("Exportar → Revisión para redes is saved in project.publish", async () => {
  await page.locator(".dv-tab", { hasText: "Exportar" }).click();
  const panel = page.locator("section[aria-label='Exportar']");
  await panel.getByRole("checkbox", { name: "Voy a subirlo a redes" }).check();
  await panel.getByRole("checkbox", { name: /Voz generada o clonada/ }).check();
  const label = panel.getByRole("checkbox", { name: /Etiqueta «Contenido alterado con IA»/ });
  if (!(await label.isChecked())) throw new Error("AI label did not turn on by itself");
  await sleep(2_500); // autosave debounce (1.5 s)
  const id = await page.evaluate(() => JSON.parse(localStorage.getItem("studio.project.v1")).id);
  const saved = await apiJson(`/api/projects/${id}`);
  if (!saved.publish?.forSocial || !saved.publish.flags?.aiVoice || !saved.publish.aiLabel)
    throw new Error(`publish not saved: ${JSON.stringify(saved.publish)}`);
  return saved.publish;
});

// Sprint 2 (web): multilayer canvas preview, keyframe via K, «Reencuadrar» panel.
const previewCanvas = () => page.getByTestId("preview-canvas");
const trackRow = (kind) => page.locator(`[data-track-kind='${kind}']`).first().locator("xpath=..");
async function canvasShot() {
  await sleep(500); // paused redraws are on demand (seeked/loadeddata + rAF)
  return previewCanvas().screenshot();
}

await step("Sprint 2: canvas preview composites 2 layers (video + text, pixel check)", async () => {
  await page.locator(".dv-tab", { hasText: "Línea de tiempo" }).click();
  await seek(page, 1);
  await page.getByRole("button", { name: "Texto", exact: true }).click(); // text clip at 1 s
  await page.locator(".dv-tab", { hasText: "Vista previa" }).click();
  await previewCanvas().waitFor({ timeout: 10_000 });
  // the media pool element must have decoded a frame (the --vp9-preview route transcodes first)
  await page.waitForFunction(
    () => [...document.querySelectorAll("video")].some((v) => v.readyState >= 2),
    undefined,
    { timeout: 60_000 },
  );
  const all = await canvasShot();
  await trackRow("motion").getByRole("button", { name: "Ocultar pista" }).click();
  const videoText = await canvasShot();
  await trackRow("text").getByRole("button", { name: "Ocultar pista" }).click();
  const videoOnly = await canvasShot();
  await trackRow("video").getByRole("button", { name: "Ocultar pista" }).click();
  const empty = await canvasShot();
  for (const k of ["text", "video", "motion"])
    await trackRow(k).getByRole("button", { name: "Mostrar pista" }).click();
  const textLayer = !videoText.equals(videoOnly);
  const videoLayer = !videoOnly.equals(empty);
  if (!textLayer || !videoLayer)
    throw new Error(`text layer ${textLayer}, video layer ${videoLayer}`);
  // getImageData works when the media came with CORS (crossOrigin=anonymous): mean brightness
  const stats = await page.evaluate(() => {
    const c = document.querySelector("[data-testid='preview-canvas']");
    try {
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
      return { mean: Math.round(sum / (d.length / 4) / 3), size: [c.width, c.height] };
    } catch (e) {
      return { tainted: String(e).slice(0, 80) };
    }
  });
  await shot(page, "08-preview-multicapa.png");
  return { textLayer, videoLayer, motionVisible: !all.equals(videoText), ...stats };
});

await step(
  "Sprint 2: K adds a keyframe on the selected clip (diamond on the timeline)",
  async () => {
    await page.locator(".dv-tab", { hasText: "Línea de tiempo" }).click();
    const textClip = page.locator("[data-track-kind='text'] [data-clip-id]").first();
    await textClip.click();
    await seek(page, 1.5);
    await textClip.click(); // ruler click keeps the selection; make sure it is the text clip
    await page.keyboard.press("k");
    const diamond = textClip.locator("[data-keyframe]");
    await diamond.first().waitFor({ timeout: 5_000 });
    const n = await diamond.count();
    await page.keyboard.press("Control+z");
    return { diamonds: n };
  },
);

await step("Sprint 2: «Reencuadrar» panel opens from the preview", async () => {
  await page.locator(".dv-tab", { hasText: "Vista previa" }).click();
  const preview = page.locator("section[aria-label='Vista previa']");
  await preview.getByRole("button", { name: "Reencuadrar" }).click();
  const panel = page.getByRole("region", { name: "Reencuadrar" });
  await panel.waitFor({ timeout: 5_000 });
  const analyze = await panel.getByRole("button", { name: /Analizar para 9:16/ }).isEnabled();
  await shot(page, "09-reencuadrar.png");
  await panel.getByRole("button", { name: "Cerrar reencuadre" }).click();
  return { analyze };
});

// ---- Sprint 2 integration on the real stack (api + workers-with-mocks.py: real OpenCV tracker,
// SAM 2 with a constant-mask predictor). Media: lavfi clip with a TEXTURED box moving right
// (x = 80 + 200 t, y = 300, 120×80 on 1280×720, 30 fps, 4 s); 1080p canvas.
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const shared = await import(
  pathToFileURL(path.join(REPO, "packages", "shared", "dist", "index.js")).href
).catch(() => undefined);
const S2 = {
  W: 1280,
  H: 720,
  fps: 30,
  dur: 4,
  box: (t) => ({ x: 80 + 200 * t, y: 300, w: 120, h: 80 }),
};
const s2 = {};
const apiSend = async (method, route, body) => {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => undefined);
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
};
async function waitApiJob(jobId, ms = 300_000) {
  const end = Date.now() + ms;
  for (;;) {
    const j = await apiJson(`/api/jobs/${jobId}`);
    if (j.status === "succeeded") return j;
    if (["failed", "canceled"].includes(j.status)) throw new Error(`job ${j.type}: ${j.error}`);
    if (Date.now() > end) throw new Error(`job ${jobId} timeout`);
    await sleep(500);
  }
}
async function lavfiUpload(name, graph, extra = []) {
  const { mkdtemp, readFile } = await import("node:fs/promises");
  const os = await import("node:os");
  s2.dir ??= await mkdtemp(path.join(os.tmpdir(), "studio-ui-s2-"));
  const file = path.join(s2.dir, name);
  const r = spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", graph, ...extra, file]);
  if (r.status !== 0) throw new Error(`ffmpeg ${name}: ${r.stderr}`);
  const fd = new FormData();
  fd.append("file", new Blob([await readFile(file)]), name);
  const asset = await (await fetch(`${API}/api/media`, { method: "POST", body: fd })).json();
  for (let i = 0; i < 240; i++) {
    const jobs = (await apiJson("/api/jobs?limit=100")).filter(
      (j) => j.payload?.assetId === asset.id,
    );
    if (jobs.length && jobs.every((j) => !["queued", "running"].includes(j.status))) break;
    await sleep(500);
  }
  return { ...asset, file };
}
/** Open a saved api project in the dashboard (local copy replaced, then reload). */
async function openProject(id) {
  const proj = await apiJson(`/api/projects/${id}`);
  await page.evaluate((p) => localStorage.setItem("studio.project.v1", JSON.stringify(p)), proj);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("section[aria-label='Línea de tiempo']", { timeout: 60_000 });
  await page.getByText("Guardado", { exact: true }).waitFor({ timeout: 15_000 });
  await page.locator(".dv-tab", { hasText: "Vista previa" }).click();
  await previewCanvas().waitFor({ timeout: 10_000 });
}
/** Playhead to frame `n` (deterministic: start + n × «Fotograma siguiente»). */
async function gotoFrame(n) {
  const preview = page.locator("section[aria-label='Vista previa']");
  await preview.getByRole("button", { name: "Ir al inicio" }).click();
  const next = preview.getByRole("button", { name: "Fotograma siguiente" });
  for (let i = 0; i < n; i++) await next.click();
  await sleep(700);
}
/** Canvas pixels: bbox center (fractions) of pixels matching `kind` ("white") or the RGB at a point. */
async function canvasProbe(query) {
  return page.evaluate((q) => {
    const c = document.querySelector("[data-testid='preview-canvas']");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    if (q.at) {
      const i =
        (Math.round(q.at[1] * (c.height - 1)) * c.width + Math.round(q.at[0] * (c.width - 1))) * 4;
      return [d[i], d[i + 1], d[i + 2]];
    }
    let [x0, y0, x1, y1, n] = [c.width, c.height, -1, -1, 0];
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235) {
          n++;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    return n ? { cx: (x0 + x1) / 2 / c.width, cy: (y0 + y1) / 2 / c.height, n } : undefined;
  }, query);
}
const close = (a, b, tol) => Math.abs(a - b) <= tol;

await step(
  "Sprint 2: «Seguir objeto» box on the preview → real tracker → text follows (pixels at 2 times)",
  async () => {
    s2.video = await lavfiUpload(
      "ui-caja-textura.mp4",
      `color=c=black:s=${S2.W}x${S2.H}:r=${S2.fps}:d=${S2.dur}[b];testsrc2=s=120x80:r=${S2.fps}:d=${S2.dur},lutyuv=y=val*0.6[w];[b][w]overlay=x='80+200*t':y=300`,
      ["-c:v", "libx264", "-pix_fmt", "yuv420p"],
    );
    const p = await apiSend("POST", "/api/projects", { name: "UI sprint 2" });
    const V = p.tracks.find((t) => t.kind === "video");
    const T = p.tracks.find((t) => t.kind === "text");
    V.clips = [{ id: "uivid", trackId: V.id, assetId: s2.video.id, start: 0, in: 0, out: S2.dur }];
    T.clips = [
    { id: "uitxt", trackId: T.id, start: 0, in: 0, out: S2.dur, text: "II",
      textStyle: { fontSize: 72, color: "#ffffff", position: "bottom" } },
  ]; // prettier-ignore
    await apiSend("PUT", `/api/projects/${p.id}`, p);
    s2.project = p.id;
    await openProject(p.id);
    await gotoFrame(0);
    const preview = page.locator("section[aria-label='Vista previa']");
    await preview.getByRole("button", { name: "Seguir objeto" }).click();
    // «Rápido» (OpenCV): the harness' SAM 2 double is a constant mask that does not move.
    await page.getByLabel("Método", { exact: true }).selectOption("csrt");
    const box = await previewCanvas().boundingBox();
    const b = S2.box(0);
    const at = (fx, fy) => [box.x + fx * box.width, box.y + fy * box.height];
    const [ax, ay] = at(b.x / S2.W, b.y / S2.H);
    const [bx, by] = at((b.x + b.w) / S2.W, (b.y + b.h) / S2.H);
    await page.mouse.move(ax, ay);
    await page.mouse.down();
    await page.mouse.move(bx, by, { steps: 8 });
    await page.mouse.up();
    const dialog = page.getByRole("dialog", { name: "Seguir objeto: asignar" });
    await dialog.waitFor({ timeout: 180_000 });
    await dialog.getByLabel("Ancla").selectOption("center");
    await dialog.getByLabel("Desvío Y (%)").fill("0");
    await dialog.getByRole("button", { name: "Asignar" }).click();
    await sleep(2_500); // autosave
    const saved = await apiJson(`/api/projects/${p.id}`);
    const ref = saved.tracks.flatMap((t) => t.clips).find((c) => c.id === "uitxt")?.trackRef;
    if (!ref) throw new Error("trackRef not saved on the text clip");
    s2.trackAssetId = ref.assetId;
    const checks = [];
    for (const frame of [30, 90]) {
      await gotoFrame(frame);
      const t = frame / S2.fps;
      const bb = S2.box(t);
      const exp = { x: (bb.x + bb.w / 2) / S2.W, y: (bb.y + bb.h / 2) / S2.H };
      const got = await canvasProbe({});
      if (!got) throw new Error(`no text on the canvas at ${t} s`);
      if (!close(got.cx, exp.x, 0.012) || !close(got.cy, exp.y, 0.02))
        throw new Error(
          `t=${t}: text at ${got.cx.toFixed(3)},${got.cy.toFixed(3)}, box ${exp.x.toFixed(3)},${exp.y.toFixed(3)}`,
        );
      checks.push({
        t,
        text: [+got.cx.toFixed(4), +got.cy.toFixed(4)],
        box: [+exp.x.toFixed(4), +exp.y.toFixed(4)],
      });
    }
    await shot(page, "10-seguir-objeto.png");
    return { checks };
  },
);

await step(
  "Sprint 2: track → keyframes (inspector), K adds one, inspector edit → export = interpolate()",
  async () => {
    if (!s2.trackAssetId) throw new Error("needs the «Seguir objeto» step");
    await page.locator(".dv-tab", { hasText: "Línea de tiempo" }).click();
    const textClip = page.locator("[data-track-kind='text'] [data-clip-id]").first();
    await textClip.click();
    await page.locator(".dv-tab", { hasText: "Propiedades" }).click();
    const props = page.locator("section[aria-label='Propiedades']");
    await props.getByRole("button", { name: /Convertir seguimiento a/ }).click();
    await textClip.locator("[data-keyframe]").first().waitFor({ timeout: 60_000 });
    const converted = await textClip.locator("[data-keyframe]").count();
    // the text clip stays selected (preview buttons do not change the selection): K at 3.5 s
    await gotoFrame(105);
    await page.keyboard.press("k");
    await page.waitForFunction(
      ([sel, n]) => document.querySelectorAll(sel).length > n,
      ["[data-track-kind='text'] [data-clip-id] [data-keyframe]", converted],
      { timeout: 5_000 },
    );
    await page.locator(".dv-tab", { hasText: "Propiedades" }).click();
    const rows = props.locator("li", { has: page.getByLabel("Tiempo (s)") });
    let edited = false;
    for (let i = 0; i < (await rows.count()); i++) {
      const row = rows.nth(i);
      if (Math.abs(Number(await row.getByLabel("Tiempo (s)").inputValue()) - 3.5) > 1e-6) continue;
      await row.getByLabel("X (%)").fill("80");
      edited = true;
    }
    if (!edited) {
      const times = [];
      for (let i = 0; i < (await rows.count()); i++)
        times.push(await rows.nth(i).getByLabel("Tiempo (s)").inputValue());
      throw new Error(`no keyframe at 3.5 s in the inspector: ${times.join(", ")}`);
    }
    await sleep(2_500); // autosave
    const saved = await apiJson(`/api/projects/${s2.project}`);
    const clip = saved.tracks.flatMap((t) => t.clips).find((c) => c.id === "uitxt");
    const kfs = clip.keyframes?.position ?? [];
    const k35 = kfs.find((k) => Math.abs(k.t - 3.5) < 1e-6);
    if (clip.trackRef || !k35 || Math.abs(k35.v.x - 0.8) > 1e-6)
      throw new Error(`saved keyframes ${JSON.stringify(kfs)}`);
    if (!shared) throw new Error("packages/shared/dist missing (pnpm build:packages)");
    // preview at 3.5 s = 0.8; export at 2.75 / 3.5 s = shared interpolate()
    await gotoFrame(105);
    const pv = await canvasProbe({});
    if (!pv || !close(pv.cx, 0.8, 0.012))
      throw new Error(`preview text at ${pv?.cx} (expected 0.8)`);
    const ex = await apiSend("POST", `/api/projects/${s2.project}/export`, {
      presetId: "youtube-1080p",
      fileName: "ui-keyframes",
    });
    const job = await waitApiJob(ex.jobId);
    const out = path.join(s2.dir, "ui-keyframes.mp4");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      out,
      Buffer.from(await (await fetch(`${API}/files/${job.result.path}`)).arrayBuffer()),
    );
    const checks = [];
    for (const t of [2.75, 3.5]) {
      const v = shared.interpolate(kfs, t);
      const raw = spawnSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", out, "-frames:v", "1",
      "-vf", "scale=960:540,format=gray", "-f", "rawvideo", "pipe:1"], { maxBuffer: 1 << 24 }).stdout; // prettier-ignore
      let [x0, x1, y0, y1] = [960, -1, 540, -1];
      for (let y = 0; y < 540; y++)
        for (let x = 0; x < 960; x++)
          if (raw[y * 960 + x] > 200)
            [x0, x1, y0, y1] = [Math.min(x0, x), Math.max(x1, x), Math.min(y0, y), Math.max(y1, y)];
      const cx = (x0 + x1) / 2 / 960;
      if (x1 < 0 || !close(cx, v.x, 0.01))
        throw new Error(`export t=${t}: text ${cx}, interpolate ${v.x}`);
      checks.push({ t, export: +cx.toFixed(4), interpolate: +v.x.toFixed(4) });
    }
    return { converted, keyframes: kfs.length, preview35: +pv.cx.toFixed(4), checks };
  },
);

await step(
  "Sprint 2: Máscara (SAM 2 mock) → Propagar → Quitar fondo color → preview + export",
  async () => {
    if (!s2.project) throw new Error("needs the sprint 2 project");
    await page.locator(".dv-tab", { hasText: "Línea de tiempo" }).click();
    await page.locator("[data-track-kind='video'] [data-clip-id]").first().click();
    await gotoFrame(0);
    const preview = page.locator("section[aria-label='Vista previa']");
    await preview.getByRole("button", { name: "Máscara (SAM 2)" }).click();
    const bar = page.getByRole("toolbar", { name: "Herramienta Máscara" });
    await bar.getByText("Hacé clic sobre el objeto").waitFor({ timeout: 120_000 });
    const box = await previewCanvas().boundingBox();
    const b = S2.box(0);
    const click = { x: (b.x + b.w / 2) / S2.W, y: (b.y + b.h / 2) / S2.H };
    await page.mouse.click(box.x + click.x * box.width, box.y + click.y * box.height);
    await page.getByTestId("mask-overlay").waitFor({ timeout: 60_000 });
    await bar.getByRole("button", { name: "Propagar" }).click();
    await bar.getByText("Máscara lista.").waitFor({ timeout: 300_000 });
    await bar.getByRole("button", { name: "Quitar fondo" }).click();
    const dialog = page.getByRole("dialog", { name: "Quitar fondo" });
    await dialog.getByRole("button", { name: "Quitar fondo" }).click();
    await dialog.waitFor({ state: "hidden" });
    await sleep(2_500);
    const saved = await apiJson(`/api/projects/${s2.project}`);
    const matte = saved.tracks.flatMap((t) => t.clips).find((c) => c.id === "uivid")?.matte;
    if (!matte?.assetId || matte.background?.value !== "#00b140")
      throw new Error(`matte not saved: ${JSON.stringify(matte)}`);
    // constant mock mask: 30 % × 40 % box centered on the click (clamped) → x 0..0.3, y 0.272..0.672
    const inside = [0.05, 0.62];
    const outside = [0.8, 0.15];
    await gotoFrame(30);
    await sleep(1_500); // alpha WebM seek
    const pin = await canvasProbe({ at: inside });
    const pout = await canvasProbe({ at: outside });
    const green = (c) => c[1] > 140 && c[0] < 60 && c[2] < 110;
    if (green(pin) || !green(pout)) throw new Error(`preview inside ${pin} outside ${pout}`);
    await shot(page, "11-mascara-quitar-fondo.png");
    const ex = await apiSend("POST", `/api/projects/${s2.project}/export`, {
      presetId: "youtube-1080p",
      fileName: "ui-mascara",
    });
    const job = await waitApiJob(ex.jobId);
    const out = path.join(s2.dir, "ui-mascara.mp4");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      out,
      Buffer.from(await (await fetch(`${API}/files/${job.result.path}`)).arrayBuffer()),
    );
    const raw = spawnSync("ffmpeg", ["-v", "error", "-ss", "1", "-i", out, "-frames:v", "1", "-vf", "scale=960:540",
    "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { maxBuffer: 1 << 24 }).stdout; // prettier-ignore
    const px = ([fx, fy]) => {
      const i = (Math.round(fy * 539) * 960 + Math.round(fx * 959)) * 3;
      return [raw[i], raw[i + 1], raw[i + 2]];
    };
    const ein = px(inside);
    const eout = px(outside);
    if (green(ein) || !green(eout)) throw new Error(`export inside ${ein} outside ${eout}`);
    return { preview: { inside: pin, outside: pout }, export: { inside: ein, outside: eout } };
  },
);

await step(
  "Sprint 2: Reencuadrar 9:16 (objeto seguido) → recorrido en la vista previa → Aplicar → export",
  async () => {
    if (!s2.trackAssetId) throw new Error("needs the «Seguir objeto» step");
    // keep only the video (the matte from the previous step stays: the box is still visible)
    const preview = page.locator("section[aria-label='Vista previa']");
    await preview.getByRole("button", { name: "Reencuadrar" }).click();
    const panel = page.getByRole("region", { name: "Reencuadrar" });
    await panel.getByLabel("Seguir").selectOption("track");
    await panel.getByLabel("Seguimiento").selectOption(s2.trackAssetId);
    await panel.getByRole("button", { name: /Analizar para 9:16/ }).click();
    await panel.getByText(/Recorrido 9:16/).waitFor({ timeout: 300_000 });
    await gotoFrame(60);
    const rect = page.getByTestId("reframe-crop").locator("rect");
    const svgW = await page
      .getByTestId("reframe-crop")
      .evaluate((g) => g.ownerSVGElement.viewBox.baseVal.width);
    const draftX = Number(await rect.getAttribute("x")) / svgW;
    await shot(page, "12-reencuadre-recorrido.png");
    await panel.getByRole("button", { name: "Aplicar" }).click();
    await sleep(2_500);
    const saved = await apiJson(`/api/projects/${s2.project}`);
    if (!saved.reframe?.keyframes?.length) throw new Error("project.reframe not saved");
    if (!shared) throw new Error("packages/shared/dist missing");
    const win2 = shared.reframeCropAt(saved.reframe, saved.settings, 2);
    if (!close(draftX, win2.x, 0.005)) throw new Error(`overlay x ${draftX} vs shared ${win2.x}`);
    const ex = await apiSend("POST", `/api/projects/${s2.project}/export`, {
      presetId: "reels-tiktok",
      fileName: "ui-reencuadre",
    });
    const job = await waitApiJob(ex.jobId);
    const out = path.join(s2.dir, "ui-reencuadre.mp4");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      out,
      Buffer.from(await (await fetch(`${API}/files/${job.result.path}`)).arrayBuffer()),
    );
    // at 2 s the export shows the canvas window [win.x, win.x + win.w]: the green matte background
    // left of the mask (x < 0.3) must appear exactly where the preview window puts it
    const raw = spawnSync("ffmpeg", ["-v", "error", "-ss", "2", "-i", out, "-frames:v", "1", "-vf", "scale=270:480",
    "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { maxBuffer: 1 << 24 }).stdout; // prettier-ignore
    if (raw.length < 270 * 480 * 3) throw new Error("no frame");
    const edge = ((0.3 - win2.x) / win2.w) * 270; // mask right edge in the 9:16 output
    const at = (x, y) => raw.slice((y * 270 + x) * 3, (y * 270 + x) * 3 + 3);
    // row at y = 0.62 of the canvas: inside the mask's height (0.272..0.672), below the box path
    const row = Math.round(0.62 * 479);
    const leftOfEdge = at(Math.max(0, Math.round(edge) - 8), row);
    const rightOfEdge = at(Math.min(269, Math.round(edge) + 8), row);
    const isGreen = (c) => c[1] > 140 && c[0] < 60 && c[2] < 110;
    if (edge > 10 && edge < 260 && (isGreen(leftOfEdge) || !isGreen(rightOfEdge)))
      throw new Error(
        `mask edge at ${edge.toFixed(1)} px: left ${[...leftOfEdge]} right ${[...rightOfEdge]}`,
      );
    return {
      keyframes: saved.reframe.keyframes.length,
      overlayX: +draftX.toFixed(4),
      sharedX: +win2.x.toFixed(4),
      maskEdgePx: +edge.toFixed(1),
      leftOfEdge: [...leftOfEdge],
      rightOfEdge: [...rightOfEdge],
    };
  },
);

await step(
  "Sprint 2: preview fps with 3 layers (1080p video + image PiP + text), headless",
  async () => {
    const video = await lavfiUpload("ui-1080p.mp4", "testsrc2=s=1920x1080:r=30:d=12", [
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
    ]);
    const image = await lavfiUpload("ui-pip.png", "testsrc=s=640x360", ["-frames:v", "1"]);
    const p = await apiSend("POST", "/api/projects", { name: "UI fps 3 capas" });
    const V = p.tracks.find((t) => t.kind === "video");
    const T = p.tracks.find((t) => t.kind === "text");
    const V2 = { ...V, id: "uiv2", name: "Video 2", clips: [] };
    p.tracks.splice(p.tracks.indexOf(V) + 1, 0, V2);
    V.clips = [{ id: "fpsv", trackId: V.id, assetId: video.id, start: 0, in: 0, out: 12 }];
    V2.clips = [
      {
        id: "fpsi",
        trackId: V2.id,
        assetId: image.id,
        start: 0,
        in: 0,
        out: 12,
        scale: 0.35,
        position: { x: 0.9, y: 0.1 },
      },
    ];
    T.clips = [
      {
        id: "fpst",
        trackId: T.id,
        start: 0,
        in: 0,
        out: 12,
        text: "Tres capas",
        textStyle: { fontSize: 64, color: "#ffffff", position: "bottom" },
      },
    ];
    await apiSend("PUT", `/api/projects/${p.id}`, p);
    await openProject(p.id);
    const preview = page.locator("section[aria-label='Vista previa']");
    await preview.getByRole("button", { name: "Opciones de la vista previa" }).click();
    await page
      .getByRole("menuitemcheckbox", { name: /Mostrar rendimiento/ })
      .or(page.getByRole("menuitem", { name: /Mostrar rendimiento/ }))
      .click();
    // Calidad «Original»: measure the 1080p decode (Automática may drop to the 360p proxy)
    await preview.getByRole("button", { name: "Opciones de la vista previa" }).click();
    await page
      .getByRole("menuitemcheckbox", { name: "Original", exact: true })
      .or(page.getByRole("menuitem", { name: "Original", exact: true }))
      .click();
    await gotoFrame(0);
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("video")].some(
          (v) => v.videoHeight === 1080 && v.readyState >= 3,
        ),
      undefined,
      { timeout: 120_000 },
    );
    await sleep(1_000);
    await preview.getByRole("button", { name: "Reproducir" }).click();
    const samples = [];
    for (let i = 0; i < 8; i++) {
      await sleep(1_000);
      samples.push((await page.getByTestId("perf-hud").textContent())?.trim());
      if (i === 2)
        await page.evaluate(() => {
          const q = () =>
            [...document.querySelectorAll("video")].map((v) => {
              const p = v.getVideoPlaybackQuality();
              return { n: p.totalVideoFrames - p.droppedVideoFrames, h: v.videoHeight };
            });
          const t0 = performance.now();
          const q0 = q();
          window.__s2frames = () => {
            const dt = (performance.now() - t0) / 1000;
            return q()
              .map((x, i) => ({ height: x.h, fps: +((x.n - (q0[i]?.n ?? 0)) / dt).toFixed(1) }))
              .filter((x) => x.fps > 0);
          };
        });
    }
    // frames each <video> really presented (decoded - dropped) during the last 5 s of playback
    const presented = (await page.evaluate(() => window.__s2frames?.())) ?? [];
    await preview.getByRole("button", { name: "Pausar" }).click();
    const fps = samples
      .map((s) => Number(/([\d.]+) fps/.exec(s ?? "")?.[1] ?? NaN))
      .filter((n) => n > 0);
    const steady = fps.slice(3).sort((a, b) => a - b);
    const median = steady[Math.floor(steady.length / 2)] ?? 0;
    if (!/3 capas/.test(samples.at(-1) ?? "")) throw new Error(`HUD: ${samples.at(-1)}`);
    s2.fps = +median.toFixed(1);
    return { drawsPerSecMedian: s2.fps, videoFps: presented, hud: samples.at(-1), samples: fps };
  },
);

// Sprint 3: the assistant panel against the REAL api + workers (deterministic route: no Ollama
// needed); only the questions flow mocks /api/agent/plan (a plan with questions).
const agentPanel = () => page.locator("section[aria-label='Asistente']");
const agentJson = (route, json, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(json),
  });
async function openAssistant() {
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 5);
  await page.keyboard.press("Control+Shift+A");
  const panel = agentPanel();
  await panel.waitFor({ timeout: 10_000 });
  return panel;
}
async function proposeCommand(panel, command) {
  const input = panel.getByRole("textbox", { name: "Comando para el asistente" });
  await input.fill(command);
  await panel.getByRole("button", { name: /Proponer/ }).click();
}
const agentState = {};

await step(
  "Sprint 3: Ctrl+Shift+A + real plan from the api (deterministic route, no LLM)",
  async () => {
    const panel = await openAssistant();
    const status = panel.getByTestId("assistant-status");
    await status.getByText(/^(Listo|Falta Ollama|Falta el modelo)$/).waitFor({ timeout: 15_000 });
    const input = panel.getByRole("textbox", { name: "Comando para el asistente" });
    if (!(await input.evaluate((el) => el === document.activeElement)))
      throw new Error("Ctrl+Shift+A did not focus the command input");
    await proposeCommand(panel, "poné el lienzo vertical");
    const plan = panel.getByTestId("agent-plan");
    await plan.waitFor({ timeout: 20_000 });
    const ops = await panel.getByTestId("agent-op").count();
    if (ops !== 1) throw new Error(`expected 1 op, got ${ops}`);
    const text = await plan.innerText();
    if (!/Lienzo \d+×\d+/.test(text)) throw new Error(`preview missing: ${text.slice(0, 200)}`);
    const [record] = await apiJson("/api/agent/plans?limit=1");
    if (record?.route !== "deterministic") throw new Error(`route ${record?.route}`);
    agentState.record = record;
    agentState.before = (await apiJson(`/api/projects/${record.projectId}`)).settings;
    await shot(page, "s3-asistente-plan.png");
    return { ops, route: record.route, status: (await status.innerText()).split("\n")[0] };
  },
);

await step(
  "Sprint 3: inline edit -> Aplicar (real agent.apply) -> re-resolved preview -> Deshacer todo",
  async () => {
    const panel = agentPanel();
    const { record, before } = agentState;
    if (!record) throw new Error("no plan from the previous step");
    await panel.getByRole("combobox", { name: "Lienzo (Cambiar lienzo)" }).selectOption("1:1");
    await panel.getByRole("button", { name: /Aplicar \(1\)/ }).click();
    await panel.getByTestId("agent-run").waitFor({ timeout: 10_000 });
    await panel.getByText(/Listo: 1 operación/).waitFor({ timeout: 30_000 });
    const side = Math.min(before.width, before.height);
    // the api resolved the edited op again: its preview replaces the 9:16 one
    await panel.getByText(`Lienzo ${side}×${side}`).first().waitFor({ timeout: 5_000 });
    const stored = await apiJson(`/api/agent/plans?projectId=${record.projectId}&limit=1`);
    if (!stored[0]?.edited) throw new Error("the api did not store the edited ops");
    const after = (await apiJson(`/api/projects/${record.projectId}`)).settings;
    if (after.width !== side || after.height !== side)
      throw new Error(`canvas after apply ${after.width}x${after.height}`);
    await panel.getByRole("button", { name: /Deshacer todo/ }).click();
    let back;
    for (let i = 0; i < 40; i++) {
      back = (await apiJson(`/api/projects/${record.projectId}`)).settings;
      if (back.width === before.width && back.height === before.height) break;
      await sleep(250);
    }
    if (back.width !== before.width || back.height !== before.height)
      throw new Error(`undo left ${back.width}x${back.height}`);
    return { applied: `${side}x${side}`, undone: `${back.width}x${back.height}` };
  },
);

await step("Sprint 3: questions form -> answers -> the command is re-sent", async () => {
  const sent = [];
  const base = {
    id: "e2e-q",
    projectId: agentState.record?.projectId ?? "e2e",
    status: "proposed",
    created_at: new Date().toISOString(),
    resolved: [],
    preview_es: [],
    risks: [],
    unresolved: [],
    errors: [],
    model: "qwen3:8b",
    route: "llm",
    latency_ms: 900,
    warnings: [],
  };
  await page.route(`${API}/api/agent/plan`, (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = JSON.parse(route.request().postData() ?? "{}");
    sent.push(body);
    if (sent.length === 1)
      return agentJson(
        route,
        {
          ...base,
          command: body.command,
          ok: false,
          plan: {
            version: 1,
            summary_es: "Falta el clip y el momento.",
            ops: [],
            questions: ["¿Qué clip corto y en qué segundo?"],
          },
        },
        201,
      );
    const op = { op: "add_text", text: "Hola", t: 2 };
    return agentJson(
      route,
      {
        ...base,
        id: "e2e-q2",
        command: body.command,
        ok: true,
        plan: { version: 1, summary_es: "Texto en el segundo 2.", ops: [op] },
        resolved: [op],
        preview_es: ["Agregar texto «Hola» en 2 s durante 3 s (abajo)"],
      },
      201,
    );
  });
  try {
    const panel = await openAssistant();
    await proposeCommand(panel, "Cortá el clip");
    const form = panel.getByRole("form", { name: "Preguntas del asistente" });
    await form.waitFor({ timeout: 10_000 });
    await form.getByPlaceholder("Tu respuesta").fill("el primero, en el segundo 2");
    await form.getByRole("button", { name: /Responder y volver a proponer/ }).click();
    await panel
      .getByText("Agregar texto «Hola» en 2 s durante 3 s (abajo)")
      .waitFor({ timeout: 10_000 });
    if (sent.length !== 2) throw new Error(`${sent.length} plan requests`);
    if (
      !/Respuestas: ¿Qué clip corto y en qué segundo\? → el primero, en el segundo 2/.test(
        sent[1].command,
      )
    )
      throw new Error(`re-sent command: ${sent[1].command}`);
    return { resent: sent[1].command };
  } finally {
    await page.unroute(`${API}/api/agent/plan`);
  }
});

await step(
  "Sprint 3: PACK_REQUIRED (bogus model, real api/workers) -> «Paquete requerido» + Ollama",
  async () => {
    await page.evaluate(() =>
      localStorage.setItem(
        "studio.agent.v1",
        JSON.stringify({ model: "no-existe:1b", temperature: 0.2 }),
      ),
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    try {
      const panel = await openAssistant();
      await proposeCommand(panel, "poné un texto que diga Hola en el segundo 1");
      const dialog = page.getByRole("dialog").filter({ hasText: "Paquete requerido" });
      await dialog.waitFor({ timeout: 20_000 });
      const text = await dialog.innerText();
      if (!/Ollama/.test(text) || !/no-existe:1b/.test(text))
        throw new Error(`dialog: ${text.slice(0, 300)}`);
      await shot(page, "s3-asistente-ollama.png");
      await page.keyboard.press("Escape");
      return {
        hint: text
          .split("\n")
          .find((l) => /Ollama/.test(l))
          ?.slice(0, 120),
      };
    } finally {
      await page.evaluate(() => localStorage.removeItem("studio.agent.v1"));
    }
  },
);

// ---- Sprint 3b «Capas y fusiones»: the blend mode chosen in Propiedades → «Capa» changes the
// canvas preview to the shared reference (blendRgb — the export pixel tests match the same one),
// then an ellipse mask keeps the center and drops the corners (parity with the export).
await step(
  "Sprint 3b: «Capa» → Multiplicar + máscara elíptica change the preview pixels (= export reference)",
  async () => {
    if (!shared?.blendRgb) throw new Error("packages/shared/dist missing (pnpm build:packages)");
    if (!page.url().startsWith(WEB)) {
      await page.goto(WEB, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("section[aria-label='Línea de tiempo']", { timeout: 60_000 });
    }
    const hex = (c) => c.map((v) => v.toString(16).padStart(2, "0")).join("");
    const vp9 = ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-crf", "8",
      "-b:v", "0", "-pix_fmt", "yuv420p"]; // prettier-ignore
    const base = await lavfiUpload(
      "ui-capa-base.webm",
      `color=c=0x${hex(shared.LAYER_PARITY_BASE)}:s=640x360:r=25:d=4`,
      vp9,
    );
    const top = await lavfiUpload(
      "ui-capa-top.webm",
      `color=c=0x${hex(shared.LAYER_PARITY_TOP)}:s=640x360:r=25:d=4`,
      vp9,
    );
    const p = await apiSend("POST", "/api/projects", {
      name: "UI capas",
      settings: { width: 640, height: 360, fps: 25 },
    });
    const V = p.tracks.find((t) => t.kind === "video");
    const V2 = { ...V, id: "trk_ui_capa2", name: "Video 2", clips: [] };
    V.clips = [{ id: "clp_ui_base", trackId: V.id, assetId: base.id, start: 0, in: 0, out: 4 }];
    V2.clips = [{ id: "clp_ui_top", trackId: V2.id, assetId: top.id, start: 0, in: 0, out: 4 }];
    p.tracks = [V, V2, ...p.tracks.filter((t) => t.id !== V.id)];
    await apiSend("PUT", `/api/projects/${p.id}`, p);
    await openProject(p.id);
    await page.waitForFunction(
      () => [...document.querySelectorAll("video")].filter((v) => v.readyState >= 2).length >= 2,
      undefined,
      { timeout: 60_000 },
    );
    await gotoFrame(25);
    const tol = shared.LAYER_PARITY_TOLERANCE;
    const near3 = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
    const normal = await canvasProbe({ at: [0.5, 0.5] });
    if (!near3(normal, shared.LAYER_PARITY_TOP)) throw new Error(`normal: ${normal}`);
    await page.locator(".dv-tab", { hasText: "Línea de tiempo" }).click();
    await page.locator("[data-clip-id='clp_ui_top']").click();
    await page.locator(".dv-tab", { hasText: "Propiedades" }).click();
    const props = page.locator("section[aria-label='Propiedades']");
    await props.getByLabel("Modo de fusión").selectOption("multiply");
    await page.locator(".dv-tab", { hasText: "Vista previa" }).click();
    await sleep(800);
    const want = shared.blendRgb("multiply", shared.LAYER_PARITY_BASE, shared.LAYER_PARITY_TOP);
    const multiplied = await canvasProbe({ at: [0.5, 0.5] });
    if (!near3(multiplied, want)) throw new Error(`multiply: ${multiplied}, want ${want}`);
    await page.locator(".dv-tab", { hasText: "Propiedades" }).click();
    await props.getByLabel("Máscara").selectOption("ellipse");
    await page.locator(".dv-tab", { hasText: "Vista previa" }).click();
    await page.getByTestId("mask-shape-editor").waitFor({ timeout: 5_000 });
    await sleep(800);
    const center = await canvasProbe({ at: [0.5, 0.5] });
    const corner = await canvasProbe({ at: [0.02, 0.03] });
    if (!near3(center, want)) throw new Error(`ellipse center: ${center}, want ${want}`);
    if (!near3(corner, shared.LAYER_PARITY_BASE)) throw new Error(`ellipse corner: ${corner}`);
    await shot(page, "s3b-capas.png");
    const saved = await (async () => {
      for (let i = 0; i < 20; i++) {
        const s = await apiJson(`/api/projects/${p.id}`);
        const c = s.tracks.flatMap((t) => t.clips).find((x) => x.id === "clp_ui_top");
        if (c?.maskRef) return c;
        await sleep(500);
      }
      return undefined;
    })();
    return {
      normal,
      multiplied,
      want,
      center,
      corner,
      saved: saved ? { blendMode: saved.blendMode, mask: saved.maskRef?.shape } : "no autosave",
    };
  },
);

// ---- Sprint 3b audit: preview/export parity of EVERY blend mode (shared BLEND_MODES) + an ellipse
// mask. One project, one export: the top track has one 1 s clip per mode (and a last one with
// multiply + ellipse); the canvas pixel at each clip's middle must match the FFmpeg export frame
// within LAYER_PARITY_TOLERANCE (the blendRgb reference is reported too).
await step(
  "Sprint 3b: paridad vista previa/exportación de todos los modos de fusión + máscara elíptica (±8)",
  async () => {
    if (!shared?.BLEND_MODES) throw new Error("packages/shared/dist missing (pnpm build:packages)");
    if (!page.url().startsWith(WEB)) {
      await page.goto(WEB, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("section[aria-label='Línea de tiempo']", { timeout: 60_000 });
    }
    const modes = [...shared.BLEND_MODES];
    const n = modes.length + 1; // + ellipse
    const hex = (c) => c.map((v) => v.toString(16).padStart(2, "0")).join("");
    const vp9 = ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-crf", "8",
      "-b:v", "0", "-pix_fmt", "yuv420p"]; // prettier-ignore
    const base = await lavfiUpload(
      "ui-par-base.webm",
      `color=c=0x${hex(shared.LAYER_PARITY_BASE)}:s=640x360:r=25:d=${n}`,
      vp9,
    );
    const top = await lavfiUpload(
      "ui-par-top.webm",
      `color=c=0x${hex(shared.LAYER_PARITY_TOP)}:s=640x360:r=25:d=${n}`,
      vp9,
    );
    const p = await apiSend("POST", "/api/projects", {
      name: "UI paridad capas",
      settings: { width: 640, height: 360, fps: 25 },
    });
    const V = p.tracks.find((t) => t.kind === "video");
    const V2 = { ...V, id: "trk_ui_par2", name: "Video 2", clips: [] };
    V.clips = [{ id: "clp_par_base", trackId: V.id, assetId: base.id, start: 0, in: 0, out: n }];
    V2.clips = [...modes, "ellipse"].map((m, i) => ({
      id: `clp_par_${i}`,
      trackId: V2.id,
      assetId: top.id,
      start: i,
      in: i,
      out: i + 1,
      ...(m === "ellipse"
        ? { blendMode: "multiply", maskRef: shared.defaultMaskShape("ellipse") }
        : m !== "normal" && { blendMode: m }),
    }));
    p.tracks = [V, V2, ...p.tracks.filter((t) => t.id !== V.id)];
    await apiSend("PUT", `/api/projects/${p.id}`, p);
    await openProject(p.id);
    await page.waitForFunction(
      () => [...document.querySelectorAll("video")].filter((v) => v.readyState >= 2).length >= 2,
      undefined,
      { timeout: 60_000 },
    );
    const next = page
      .locator("section[aria-label='Vista previa']")
      .getByRole("button", { name: "Fotograma siguiente" });
    const preview = [];
    await gotoFrame(12); // middle of the first 1 s clip
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        for (let k = 0; k < 25; k++) await next.click();
        await sleep(900);
      }
      preview.push({
        center: await canvasProbe({ at: [0.5, 0.5] }),
        corner: await canvasProbe({ at: [0.02, 0.03] }),
      });
    }
    await shot(page, "s3b-paridad-capas.png");
    const ex = await apiSend("POST", `/api/projects/${p.id}/export`, {
      presetId: "youtube-1080p",
      fileName: "ui-paridad-capas",
    });
    const job = await waitApiJob(ex.jobId);
    if (job.status !== "succeeded") throw new Error(`export ${job.status}: ${job.error}`);
    const out = path.join(s2.dir, "ui-paridad-capas.mp4");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      out,
      Buffer.from(await (await fetch(`${API}/files/${job.result.path}`)).arrayBuffer()),
    );
    const tol = shared.LAYER_PARITY_TOLERANCE;
    const diff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
    const rows = [];
    const bad = [];
    for (let i = 0; i < n; i++) {
      const raw = spawnSync("ffmpeg", ["-v", "error", "-ss", String(i + 0.5), "-i", out, "-frames:v", "1",
        "-vf", "scale=640:360", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { maxBuffer: 1 << 24 }).stdout; // prettier-ignore
      const px = ([fx, fy]) => {
        const j = (Math.round(fy * 359) * 640 + Math.round(fx * 639)) * 3;
        return [raw[j], raw[j + 1], raw[j + 2]];
      };
      const mode = i < modes.length ? modes[i] : "ellipse";
      const ref = shared.blendRgb(
        mode === "ellipse" ? "multiply" : mode,
        shared.LAYER_PARITY_BASE,
        shared.LAYER_PARITY_TOP,
      );
      const e = { center: px([0.5, 0.5]), corner: px([0.02, 0.03]) };
      const row = {
        mode,
        preview: preview[i].center,
        export: e.center,
        ref,
        d: diff(preview[i].center, e.center),
      };
      if (row.d > tol) bad.push(`${mode}: preview ${row.preview} export ${row.export}`);
      if (mode === "ellipse") {
        row.corner = { preview: preview[i].corner, export: e.corner };
        if (diff(preview[i].corner, e.corner) > tol)
          bad.push(`ellipse corner: preview ${preview[i].corner} export ${e.corner}`);
        if (diff(e.corner, shared.LAYER_PARITY_BASE) > tol)
          bad.push(`ellipse corner export ${e.corner} (base expected)`);
      }
      rows.push(row);
    }
    if (bad.length) throw new Error(`${bad.join("; ")} (tolerancia ${tol})`);
    return { tolerance: tol, rows };
  },
);

// ---- Sprint 3b integration: «Perfil de estilo» → «Deducir con Consola Claude» dispatches
// `studio:console:paste`; the Consola Claude panel shows up, opens a session and pastes the prompt
// (with a fake `claude` in STUDIO_CLAUDE_BIN the PTY echoes it; without claude the panel still opens).
await step(
  "Sprint 3b: «Deducir con Consola Claude» (Perfil de estilo) pastes the prompt into the Consola Claude panel",
  async () => {
    const ref = await lavfiUpload("ui-estilo-ref.mp4", "testsrc2=s=320x180:r=25:d=4", [
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
    ]);
    const { jobId } = await apiSend("POST", "/api/style/analyze", { assetId: ref.id });
    await waitApiJob(jobId, 180_000);
    const status = await apiJson("/api/console/status?refresh=1");
    await page.goto(WEB, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("section[aria-label='Línea de tiempo']", { timeout: 60_000 });
    await page.locator(".dv-tab", { hasText: "Perfil de estilo" }).click();
    const panel = page.locator("section[aria-label='Perfil de estilo']");
    const select = panel.getByLabel("Video de referencia");
    await select
      .locator(`option[value='${ref.id}']`)
      .waitFor({ state: "attached", timeout: 15_000 });
    await select.selectOption(ref.id);
    const ask = panel.getByRole("button", { name: "Deducir con Consola Claude" });
    await ask.waitFor({ timeout: 15_000 });
    await ask.click();
    const term = page.getByTestId("console-terminal");
    await term.waitFor({ state: "visible", timeout: 10_000 });
    const squash = (s) => s.replace(/\s+/g, "");
    let text = "";
    for (let i = 0; i < 40; i++) {
      text = await term.evaluate((el) =>
        [...el.querySelectorAll(".xterm-rows > div")].map((r) => r.textContent).join(""),
      );
      if (squash(text).includes("studio_style_save_preset")) break;
      if (!status.claudeInstalled && /claude-code/.test(text)) break;
      await sleep(500);
    }
    if (status.claudeInstalled && !squash(text).includes("studio_style_save_preset"))
      throw new Error(`prompt not in the terminal: ${text.slice(0, 200)}`);
    if (!status.claudeInstalled && !/claude-code/.test(text))
      throw new Error(`no install hint in the terminal: ${text.slice(0, 200)}`);
    await shot(page, "s3b-consola-estilo.png");
    await page
      .getByRole("button", { name: "Cerrar la sesión" })
      .click()
      .catch(() => undefined);
    return {
      claude: status.claudeInstalled ? status.version : "not installed",
      pasted: squash(text).includes("studio_style_save_preset"),
    };
  },
);

// ---- Sprint 3b integration: a SAM 2 mask (sprint 2 session, mock predictor) chosen in
// Propiedades → «Capa» → Máscara «Máscara SAM / imagen» cuts the top clip in the preview and in
// the export (inside the mask = top clip, outside = the track below).
await step(
  "Sprint 3b: SAM mask asset (sprint 2) as «Capa» mask in Propiedades → preview + export",
  async () => {
    const vp9 = ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-crf", "8",
      "-b:v", "0", "-pix_fmt", "yuv420p"]; // prettier-ignore
    const base = await lavfiUpload("ui-sam-base.webm", "color=c=0xff0000:s=640x360:r=25:d=4", vp9);
    const top = await lavfiUpload("ui-sam-top.webm", "color=c=0x404040:s=640x360:r=25:d=4", vp9);
    const sess = await apiSend("POST", "/api/ai/vision/sam/session", { assetId: top.id });
    await apiSend("POST", `/api/ai/vision/sam/session/${sess.sessionId}/points`, {
      frame: 0,
      points: [{ x: 0.5, y: 0.5, label: 1 }],
    });
    const prop = await apiSend(
      "POST",
      `/api/ai/vision/sam/session/${sess.sessionId}/propagate`,
      {},
    );
    const maskAssetId = (await waitApiJob(prop.jobId)).result.maskAssetId;
    if (!maskAssetId) throw new Error("no mask asset from the SAM propagation");
    const p = await apiSend("POST", "/api/projects", {
      name: "UI capa SAM",
      settings: { width: 640, height: 360, fps: 25 },
    });
    const V = p.tracks.find((t) => t.kind === "video");
    const V2 = { ...V, id: "trk_ui_sam2", name: "Video 2", clips: [] };
    V.clips = [{ id: "clp_ui_sam_base", trackId: V.id, assetId: base.id, start: 0, in: 0, out: 4 }];
    V2.clips = [{ id: "clp_ui_sam_top", trackId: V2.id, assetId: top.id, start: 0, in: 0, out: 4 }];
    p.tracks = [V, V2, ...p.tracks.filter((t) => t.id !== V.id)];
    await apiSend("PUT", `/api/projects/${p.id}`, p);
    if (!page.url().startsWith(WEB)) await page.goto(WEB, { waitUntil: "domcontentloaded" });
    await openProject(p.id);
    await page.waitForFunction(
      () => [...document.querySelectorAll("video")].filter((v) => v.readyState >= 2).length >= 2,
      undefined,
      { timeout: 60_000 },
    );
    await page.locator(".dv-tab", { hasText: "Línea de tiempo" }).click();
    await page.locator("[data-clip-id='clp_ui_sam_top']").click();
    await page.locator(".dv-tab", { hasText: "Propiedades" }).click();
    const props = page.locator("section[aria-label='Propiedades']");
    await props.getByLabel("Máscara", { exact: true }).selectOption("asset");
    const media = props.getByLabel("Medio de la máscara");
    await media.waitFor({ timeout: 5_000 });
    await media.selectOption(maskAssetId);
    await page.locator(".dv-tab", { hasText: "Vista previa" }).click();
    await gotoFrame(25);
    await sleep(1_500);
    const center = await canvasProbe({ at: [0.5, 0.5] });
    const corner = await canvasProbe({ at: [0.1, 0.1] });
    const red = (c) => c[0] > 200 && c[1] < 60 && c[2] < 60;
    if (red(center) || center[0] > 110)
      throw new Error(`preview center ${center} (top clip expected)`);
    if (!red(corner)) throw new Error(`preview corner ${corner} (red track below expected)`);
    let saved;
    for (let i = 0; i < 20 && !saved; i++) {
      const s = await apiJson(`/api/projects/${p.id}`);
      const c = s.tracks.flatMap((t) => t.clips).find((x) => x.id === "clp_ui_sam_top");
      if (c?.maskRef?.assetId === maskAssetId) saved = s;
      else await sleep(500);
    }
    if (!saved) throw new Error("maskRef not autosaved");
    const ex = await apiSend("POST", `/api/projects/${p.id}/export`, {
      presetId: "youtube-1080p",
      fileName: "ui-capa-sam",
    });
    const job = await waitApiJob(ex.jobId);
    const out = path.join(s2.dir, "ui-capa-sam.mp4");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      out,
      Buffer.from(await (await fetch(`${API}/files/${job.result.path}`)).arrayBuffer()),
    );
    const raw = spawnSync("ffmpeg", ["-v", "error", "-ss", "1", "-i", out, "-frames:v", "1", "-vf", "scale=640:360",
      "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { maxBuffer: 1 << 24 }).stdout; // prettier-ignore
    const px = ([fx, fy]) => {
      const i = (Math.round(fy * 359) * 640 + Math.round(fx * 639)) * 3;
      return [raw[i], raw[i + 1], raw[i + 2]];
    };
    const ec = px([0.5, 0.5]);
    const ek = px([0.1, 0.1]);
    if (red(ec) || !red(ek)) throw new Error(`export center ${ec} corner ${ek}`);
    await shot(page, "s3b-capa-sam.png");
    return { maskAssetId, preview: { center, corner }, export: { center: ec, corner: ek } };
  },
);

// ---------------------------------------------------------------- BEGIN sprint4:M2
// «Voces»: Chatterbox engine (workers-with-mocks.py: pack installed + bridge --mock), «Voz propia»
// uploaded from the panel («Soy yo» mandatory) and clones with it and with a consented Person
// (Person + signed consent + voice sample created through the api with the web Origin).
await step(
  "Sprint 4: Voces: motor Chatterbox (mock), Voz propia y clonación con Persona",
  async () => {
    const pack = (await apiJson("/api/ai/packs")).find((p) => p.id === "tts-chatterbox");
    if (!pack) throw new Error("pack tts-chatterbox not listed by /api/ai/packs");
    if (!pack.installed) return { skipped: "tts-chatterbox not installed (mocks off)" };
    const { mkdtemp, readFile } = await import("node:fs/promises");
    const os = await import("node:os");
    const dir = await mkdtemp(path.join(os.tmpdir(), "studio-ui-m2-"));
    const lavfi = (name, graph, extra = []) => {
      const file = path.join(dir, name);
      const r = spawnSync("ffmpeg", [
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        graph,
        ...extra,
        file,
      ]);
      if (r.status !== 0) throw new Error(`ffmpeg ${name}: ${r.stderr}`);
      return file;
    };
    const selfWav = lavfi("voz-propia.wav", "sine=frequency=170:duration=9:sample_rate=44100", [
      "-af",
      "volume=0.5",
    ]);
    // A Person with a voice sample and then a signed voice consent (M1's api; uploads and consents
    // need the web Origin; the consent covers the samples loaded before it).
    const person = await apiSend("POST", "/api/persons", { name: "Lu E2E" });
    const human = { origin: WEB };
    const vf = new FormData();
    vf.append(
      "audio",
      new Blob([await readFile(lavfi("lu.wav", "sine=frequency=260:duration=8"))], {
        type: "audio/wav",
      }),
      "lu.wav",
    );
    const sample = await fetch(`${API}/api/persons/${person.id}/voice-samples`, {
      method: "POST",
      headers: human,
      body: vf,
    });
    if (!sample.ok) throw new Error(`voice sample -> ${sample.status} ${await sample.text()}`);
    const sig = await readFile(
      lavfi("firma.png", "color=c=white:s=240x90,drawbox=x=20:y=40:w=200:h=6:color=black:t=fill", [
        "-frames:v",
        "1",
      ]),
    );
    const cf = new FormData();
    for (const [k, v] of Object.entries({
      scope: "voice",
      method: "firma en pantalla",
      signer_name: "Lu E2E",
      text_version: "2026-10-06",
      accept: "true",
    }))
      cf.append(k, v);
    cf.append("evidence", new Blob([sig], { type: "image/png" }), "firma.png");
    const consent = await fetch(`${API}/api/persons/${person.id}/consents`, {
      method: "POST",
      headers: human,
      body: cf,
    });
    if (consent.status !== 201)
      throw new Error(`consent -> ${consent.status} ${await consent.text()}`);

    if (!page.url().startsWith(WEB)) await page.goto(WEB, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("section[aria-label='Línea de tiempo']", { timeout: 60_000 });
    await page.locator(".dv-tab", { hasText: "Voz y audio" }).click();
    const panel = page.locator("section[aria-label='Voz y audio']");
    await panel.getByRole("tab", { name: "Texto a voz" }).click();
    await panel.getByLabel("Motor").selectOption("chatterbox");
    await panel.getByTestId("chatterbox-options").waitFor({ timeout: 15_000 });
    if ((await panel.getByLabel("Idioma").inputValue()) !== "es") throw new Error("language != es");
    // «Voz propia»: upload disabled until «Soy yo»
    const upload = panel.getByLabel("Subir muestra de voz propia");
    if (!(await upload.isDisabled())) throw new Error("upload enabled without «Soy yo»");
    await panel.getByLabel("Soy yo: es mi propia voz").check();
    await upload.setInputFiles(selfWav);
    await panel
      .getByRole("list", { name: "Muestras de voz propia" })
      .getByText(/^Voz propia \(/)
      .first()
      .waitFor({ timeout: 30_000 });
    const before = new Set((await apiJson("/api/jobs?type=voice.tts&limit=200")).map((j) => j.id));
    const generate = async (source, text) => {
      await panel.getByLabel("Voz a clonar").selectOption(source);
      await panel.getByRole("textbox").first().fill(text);
      await panel.getByRole("button", { name: /Generar y añadir al cursor/ }).click();
      for (let i = 0; i < 240; i++) {
        const job = (await apiJson("/api/jobs?type=voice.tts&limit=200")).find(
          (j) => !before.has(j.id),
        );
        if (job && ["succeeded", "failed", "canceled"].includes(job.status)) {
          before.add(job.id);
          const full = await apiJson(`/api/jobs/${job.id}`);
          if (full.status !== "succeeded")
            throw new Error(`voice.tts ${full.status}: ${full.error}`);
          return full;
        }
        await sleep(500);
      }
      throw new Error("voice.tts job did not finish");
    };
    // Persons with voice consent are listed (read-only)
    const options = await panel.getByLabel("Voz a clonar").locator("option").allTextContents();
    if (!options.includes("Persona: Lu E2E")) {
      await panel.getByLabel("Motor").selectOption("piper");
      await panel.getByLabel("Motor").selectOption("chatterbox");
    }
    await panel.getByLabel("Fidelidad al acento de la referencia").fill("0.3");
    const self = await generate("self", "Che, ¿viste que mañana llueve?");
    if (self.result?.aiVoice !== "cloned" || self.payload?.cfg !== 0.3)
      throw new Error(`Voz propia job ${JSON.stringify({ r: self.result, p: self.payload })}`);
    await page.getByText("Marcado como voz clonada (Revisión para redes).").first().waitFor({
      timeout: 10_000,
    });
    const optionsNow = await panel.getByLabel("Voz a clonar").locator("option").allTextContents();
    if (!optionsNow.includes("Persona: Lu E2E"))
      throw new Error(`Person not listed: ${optionsNow.join(" | ")}`);
    const cloned = await generate(`person:${person.id}`, "Hola, soy Lu.");
    const asset = await apiJson(`/api/media/${cloned.result.assetId}`);
    if (asset.aiProvenance?.kind !== "voice-cloned" || asset.aiProvenance.personId !== person.id)
      throw new Error(`Person clone provenance ${JSON.stringify(asset.aiProvenance)}`);
    await shot(page, "s4-voces-chatterbox.png");
    return { self: self.result.assetId, person: asset.id, options: optionsNow };
  },
);
// ------------------------------------------------------------------ END sprint4:M2

// ---------------------------------------------------------------- BEGIN sprint4:M1
// «Caras»: Ajustes → Personas (create, photo, signature on the canvas, consent vigente) and the
// «Cambiar cara» wizard against workers-with-mocks.py (packs faceswap installed, fake FaceFusion
// that draws a box on the face). The licence is accepted in its on-screen dialog.
const m1 = {};
async function m1Lavfi(name, graph, extra = []) {
  const { mkdtemp } = await import("node:fs/promises");
  const os = await import("node:os");
  m1.dir ??= await mkdtemp(path.join(os.tmpdir(), "studio-ui-m1-"));
  const file = path.join(m1.dir, name);
  const r = spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", graph, ...extra, file]);
  if (r.status !== 0) throw new Error(`ffmpeg ${name}: ${r.stderr}`);
  return file;
}
/** A Person with a photo and a face consent made through the api (web Origin). */
async function m1ApiPerson(name) {
  const { readFile } = await import("node:fs/promises");
  const person = await apiSend("POST", "/api/persons", { name });
  const photo = await m1Lavfi(`${person.id}.png`, "color=c=gray:s=320x320", ["-frames:v", "1"]);
  const pf = new FormData();
  pf.append("photo", new Blob([await readFile(photo)], { type: "image/png" }), "cara.png");
  await fetch(`${API}/api/persons/${person.id}/photos`, {
    method: "POST",
    headers: { origin: WEB },
    body: pf,
  });
  const sig = await m1Lavfi(
    `${person.id}-firma.png`,
    "color=c=white:s=240x90,drawbox=x=20:y=40:w=200:h=6:color=black:t=fill",
    ["-frames:v", "1"],
  );
  const cf = new FormData();
  for (const [k, v] of Object.entries({ scope: "face", method: "firma en pantalla",
    signer_name: name, text_version: "2026-10-06", accept: "true" })) cf.append(k, v); // prettier-ignore
  cf.append("evidence", new Blob([await readFile(sig)], { type: "image/png" }), "firma.png");
  const res = await fetch(`${API}/api/persons/${person.id}/consents`, {
    method: "POST",
    headers: { origin: WEB },
    body: cf,
  });
  if (res.status !== 201) throw new Error(`consent -> ${res.status} ${await res.text()}`);
  return person;
}

await step(
  "Sprint 4: Ajustes → Personas: crear, firmar en pantalla, consentimiento vigente",
  async () => {
    const name = `Martín E2E ${Date.now() % 10000}`;
    await page.getByRole("button", { name: "Ajustes" }).click();
    await page.getByRole("tab", { name: "Personas" }).click();
    await page.getByPlaceholder(/Nombre de la persona/).fill(name);
    await page.getByRole("button", { name: "Nueva persona" }).click();
    const detail = page.getByLabel(`Persona ${name}`);
    await detail.waitFor({ timeout: 10_000 });
    const photo = await m1Lavfi("ui-cara.png", "color=c=gray:s=320x320", ["-frames:v", "1"]);
    await page.getByLabel("Subir fotos").setInputFiles(photo);
    await detail.getByAltText(`Foto de ${name}`).first().waitFor({ timeout: 15_000 });
    const form = page.getByLabel("Registrar consentimiento", { exact: true });
    const text = await form.getByTestId("consent-text").innerText();
    if (!text.includes(`Yo, ${name}, mayor de edad`)) throw new Error(`consent text: ${text}`);
    const canvas = form.getByLabel("Recuadro para firmar");
    await canvas.scrollIntoViewIfNeeded();
    const pad = await canvas.boundingBox();
    await page.mouse.move(pad.x + 20, pad.y + pad.height * 0.7);
    await page.mouse.down();
    for (const [fx, fy] of [
      [0.3, 0.3],
      [0.5, 0.8],
      [0.7, 0.2],
      [0.9, 0.6],
    ])
      await page.mouse.move(pad.x + fx * pad.width, pad.y + fy * pad.height, { steps: 6 });
    await page.mouse.up();
    await form.getByRole("checkbox", { name: /Leí este texto con la persona/ }).check();
    await form.getByRole("button", { name: "Registrar consentimiento" }).click();
    await page
      .getByLabel("Personas registradas")
      .getByText("Rostro: vigente")
      .first()
      .waitFor({ timeout: 15_000 });
    await shot(page, "s4-personas.png");
    await page.keyboard.press("Escape");
    const row = (await apiJson("/api/persons")).find((p) => p.name === name);
    if (row?.face !== "vigente") throw new Error(`api: ${JSON.stringify(row)}`);
    m1.personName = name;
    return { person: row.id, photos: row.photos };
  },
);

await step(
  "Sprint 4: Cambiar cara (mock): vista previa, aplicar, insignia IA, deshacer",
  async () => {
    const pack = (await apiJson("/api/ai/packs")).find((p) => p.id === "faceswap");
    if (!pack) throw new Error("pack faceswap not listed by /api/ai/packs");
    if (!pack.installed) return { skipped: "faceswap not installed (STUDIO_MOCK_FACE=0)" };
    await fetch(`${API}/api/ai/licences/faceswap/revoke`, { method: "POST" }).catch(
      () => undefined,
    );
    const name = m1.personName ?? (await m1ApiPerson(`Lucía E2E ${Date.now() % 10000}`)).name;
    const { readFile } = await import("node:fs/promises");
    const file = await m1Lavfi("ui-doble.mp4", "testsrc2=s=640x360:r=25:d=3", [
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
  ]); // prettier-ignore
    const fd = new FormData();
    fd.append("file", new Blob([await readFile(file)]), "ui-doble.mp4");
    const asset = await (await fetch(`${API}/api/media`, { method: "POST", body: fd })).json();
    for (let i = 0; i < 240; i++) {
      const jobs = (await apiJson("/api/jobs?limit=100")).filter(
        (j) => j.payload?.assetId === asset.id,
      );
      if (jobs.length && jobs.every((j) => !["queued", "running"].includes(j.status))) break;
      await sleep(500);
    }
    const p = await apiSend("POST", "/api/projects", { name: "UI cambiar cara" });
    const V = p.tracks.find((t) => t.kind === "video");
    V.clips = [{ id: "uiface", trackId: V.id, assetId: asset.id, start: 0, in: 0, out: 3 }];
    await apiSend("PUT", `/api/projects/${p.id}`, p);
    await openProject(p.id);
    await page.locator(".dv-tab", { hasText: "Línea de tiempo" }).click();
    await page.locator("[data-clip-id='uiface']").click({ button: "right" });
    await page.getByRole("menuitem", { name: /Cambiar cara/ }).click();
    // first use: the licence dialog opens on top of the wizard
    const licence = page.getByRole("dialog", { name: /Licencia: Cambio de cara/ });
    await licence.waitFor({ timeout: 10_000 });
    await licence.getByRole("checkbox", { name: /uso no comercial/ }).check();
    await licence.getByRole("button", { name: "Aceptar" }).click();
    await licence.waitFor({ state: "detached", timeout: 10_000 });
    const wizard = page.getByRole("dialog", { name: "Cambiar cara" });
    await wizard.getByRole("radio", { name: new RegExp(name) }).check();
    await wizard.getByRole("button", { name: /Siguiente/ }).click();
    await wizard.getByRole("button", { name: "Cara 1" }).click({ timeout: 20_000 });
    await wizard.getByRole("button", { name: /Siguiente/ }).click();
    await wizard.getByRole("button", { name: /Vista previa de 1 fotograma/ }).click();
    await wizard.getByAltText("Después").waitFor({ timeout: 60_000 });
    await shot(page, "s4-cambiar-cara-vista-previa.png");
    await wizard.getByRole("button", { name: /Siguiente/ }).click();
    const apply = wizard.getByRole("button", { name: /Aplicar cambio de cara/ });
    if (!(await apply.isDisabled())) throw new Error("apply enabled before the confirmation");
    await wizard.getByRole("checkbox", { name: /nadie en el video es menor de edad/ }).check();
    await apply.click();
    await wizard.getByText(/^Listo:/).waitFor({ timeout: 120_000 });
    await wizard.getByRole("button", { name: "Terminar" }).click();
    const clipBox = page.locator("[data-clip-id='uiface']");
    await clipBox.getByText("IA cara").waitFor({ timeout: 10_000 });
    await clipBox.click();
    await page.locator(".dv-tab", { hasText: "Propiedades" }).click();
    await page.getByText(`IA: cara (${name})`).waitFor({ timeout: 10_000 });
    const swapped = await apiJson(`/api/projects/${p.id}`);
    const clip = swapped.tracks.flatMap((t) => t.clips).find((c) => c.id === "uiface");
    if (!clip.faceSwap || clip.assetId === asset.id)
      throw new Error(`clip ${JSON.stringify(clip)}`);
    await page.getByRole("button", { name: "Deshacer cambio de cara" }).first().click();
    await page.getByText("Cambio de cara deshecho").first().waitFor({ timeout: 10_000 });
    const back = (await apiJson(`/api/projects/${p.id}`)).tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === "uiface");
    if (back.faceSwap || back.assetId !== asset.id)
      throw new Error(`undo: ${JSON.stringify(back)}`);
    return { swappedAsset: clip.assetId, person: name };
  },
);
// ------------------------------------------------------------------ END sprint4:M1

// ---------------------------------------------------------------- BEGIN sprint4:M3
// «Herramientas»: «Revisión para redes» detects the AI media of the project (face swap of the M1
// step, cloned / synthetic voices of the M2 step; if none, a Chatterbox --mock voice is generated
// here) and Ajustes → Paquetes de IA shows the faceswap licence gate + the isolated tool state.
async function m3UiProject() {
  const id = await page.evaluate(() => JSON.parse(localStorage.getItem("studio.project.v1")).id);
  const project = await apiJson(`/api/projects/${id}`);
  const kinds = { face: 0, cloned: 0, synthetic: 0 };
  for (const t of project.tracks ?? []) {
    const visible = t.kind !== "audio" && !t.hidden;
    const audible = t.kind === "audio" ? !t.muted : t.kind === "video" && !t.hidden && !t.muted;
    for (const c of t.clips ?? []) {
      for (const assetId of [c.assetId, c.renderedAssetId, c.matte?.assetId].filter(Boolean)) {
        const a = await apiJson(`/api/media/${assetId}`);
        const k = a?.aiProvenance?.kind;
        if (k === "face" && visible) kinds.face++;
        if (k === "voice-cloned" && audible) kinds.cloned++;
        if (k === "voice-synthetic" && audible) kinds.synthetic++;
      }
    }
  }
  return { project, kinds };
}

await step(
  "Sprint 4: Revisión para redes detecta cara y voz IA; etiqueta al marcar redes",
  async () => {
    if (!page.url().startsWith(WEB)) await page.goto(WEB, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("section[aria-label='Línea de tiempo']", { timeout: 60_000 });
    await sleep(2_000); // autosave of the previous steps
    let { kinds } = await m3UiProject();
    if (kinds.face + kinds.cloned + kinds.synthetic === 0) {
      const pack = (await apiJson("/api/ai/packs")).find((p) => p.id === "tts-chatterbox");
      if (!pack?.installed) return { skipped: "no AI media and tts-chatterbox not installed" };
      await page.locator(".dv-tab", { hasText: "Voz y audio" }).click();
      const voice = page.locator("section[aria-label='Voz y audio']");
      await voice.getByRole("tab", { name: "Texto a voz" }).click();
      await voice.getByLabel("Motor").selectOption("chatterbox");
      await voice.getByRole("textbox").first().fill("Voz sintética para la revisión de redes.");
      await voice.getByRole("button", { name: /Generar y añadir al cursor/ }).click();
      for (let i = 0; i < 120 && kinds.synthetic === 0; i++) {
        await sleep(1_000);
        ({ kinds } = await m3UiProject());
      }
      if (kinds.synthetic === 0)
        throw new Error("the synthetic voice clip did not reach the project");
    }
    await page.locator(".dv-tab", { hasText: "Exportar" }).click();
    const panel = page.locator("section[aria-label='Exportar']");
    const social = panel.getByRole("checkbox", { name: "Voy a subirlo a redes" });
    if (await social.isChecked()) await social.uncheck();
    // internal use: label off, detection visible (the export records it in its metadata anyway)
    await panel.getByTestId("ai-label-off").waitFor({ timeout: 10_000 });
    await panel.getByTestId("ai-detected").waitFor({ timeout: 10_000 });
    await social.check();
    const rows = {
      face: await panel.getByTestId("ai-detected-face").count(),
      cloned: await panel.getByTestId("ai-detected-voice-cloned").count(),
      synthetic: await panel.getByTestId("ai-detected-voice-synthetic").count(),
    };
    for (const k of ["face", "cloned", "synthetic"])
      if (Boolean(rows[k]) !== Boolean(kinds[k]))
        throw new Error(
          `detected rows ${JSON.stringify(rows)} vs project ${JSON.stringify(kinds)}`,
        );
    const face = panel.getByRole("checkbox", { name: /Cara generada o cambiada/ });
    const voiceBox = panel.getByRole("checkbox", { name: /Voz generada o clonada/ });
    if (kinds.face && !((await face.isChecked()) && (await face.isDisabled())))
      throw new Error("«Cara» is not checked + locked with a face swap in the project");
    if (kinds.cloned && !((await voiceBox.isChecked()) && (await voiceBox.isDisabled())))
      throw new Error("«Voz» is not checked + locked with a cloned voice in the project");
    if (!kinds.cloned && kinds.synthetic && !(await voiceBox.isChecked()))
      throw new Error("synthetic voice not marked when going to social media");
    const label = panel.getByRole("checkbox", { name: /Etiqueta «Contenido alterado con IA»/ });
    if (!(await label.isChecked()))
      throw new Error("AI label not proposed when marking social media");
    const s = await shot(page, "s4-revision-redes-ia.png");
    return { kinds, rows, shot: s };
  },
);

await step("Sprint 4: Paquetes de IA: faceswap pide aceptar la licencia", async () => {
  const packs = await apiJson("/api/ai/packs");
  const faceswap = packs.find((p) => p.id === "faceswap");
  if (!faceswap) throw new Error("pack faceswap not listed by /api/ai/packs");
  await page.getByRole("button", { name: "Ajustes" }).click();
  await page.getByRole("tab", { name: "Paquetes de IA" }).click();
  const row = page.locator("[data-testid='pack-row'][data-pack-id='faceswap']");
  await row.waitFor({ timeout: 15_000 });
  const text = (await row.innerText()).replace(/\s+/g, " ");
  if (!text.includes("No comercial: requiere aceptar licencia"))
    throw new Error(`faceswap row without the licence badge: ${text.slice(0, 200)}`);
  if (faceswap.tool && !/Entorno aislado \(tools\\facefusion\)/.test(text))
    throw new Error(`faceswap row without the tool state: ${text.slice(0, 200)}`);
  const licences = await apiJson("/api/ai/licences");
  const accepted = licences.find((l) => l.id === "faceswap")?.accepted;
  const button = row.getByRole("button", { name: accepted ? /Ver licencia/ : /Leer y aceptar/ });
  await button.click();
  const dialog = page
    .getByRole("dialog")
    .filter({ hasText: /Cambio de cara/ })
    .last();
  await dialog.waitFor({ timeout: 10_000 });
  const s = await shot(page, "s4-paquetes-licencia.png");
  await page.keyboard.press("Escape");
  await sleep(300);
  if (await page.getByRole("dialog").count()) await page.keyboard.press("Escape");
  return { accepted: Boolean(accepted), tool: faceswap.tool ?? null, shot: s };
});
// ------------------------------------------------------------------ END sprint4:M3

// ---------------------------------------------------------------- BEGIN sprint5:M2
// Fluidez de la línea de tiempo: hotkeys after clicking the ruler, ripple, multi-selection, Q/W,
// I/O, header at 1366 px / 125 %, tooltips that explain, projects list and the empty preview.
const s5 = {};
const s5Ruler = () => page.getByLabel("Regla de tiempo");
const s5Clips = () =>
  page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem("studio.project.v1"));
    const v = p.tracks.find((t) => t.kind === "video");
    return v.clips
      .map((c) => ({ id: c.id, start: c.start, in: c.in, out: c.out }))
      .sort((a, b) => a.start - b.start);
  });
const s5Playhead = async () => Number(await s5Ruler().getAttribute("aria-valuenow"));
/** Api project with `n` back-to-back 2 s clips of one test video, opened in the dashboard. */
async function s5Project(name, n) {
  if (!page.url().startsWith(WEB)) {
    await page.goto(WEB, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("section[aria-label='Línea de tiempo']", { timeout: 60_000 });
  }
  s5.video ??= await lavfiUpload("ui-s5.mp4", "testsrc2=s=640x360:r=25:d=6", [
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
  ]);
  const p = await apiSend("POST", "/api/projects", { name });
  const V = p.tracks.find((t) => t.kind === "video");
  V.clips = Array.from({ length: n }, (_, i) => ({
    id: `s5c${i}`,
    trackId: V.id,
    assetId: s5.video.id,
    start: i * 2,
    in: i * 2,
    out: i * 2 + 2,
  }));
  await apiSend("PUT", `/api/projects/${p.id}`, p);
  await openProject(p.id);
  await page.locator(".dv-tab", { hasText: "Línea de tiempo" }).click();
  await page.locator("[data-clip-id]").first().waitFor({ timeout: 10_000 });
  return p;
}
/** Click the ruler at `sec` and check that it did not take the keyboard focus. */
async function s5RulerClick(sec) {
  await seek(page, sec);
  const role = await page.evaluate(() => document.activeElement?.getAttribute("role"));
  if (role === "slider") throw new Error("the ruler took the keyboard focus");
  return role;
}

await step("Sprint 5: clic en la regla → S corta (1 → 2 clips)", async () => {
  await s5Project("S5 regla S", 1);
  const focus = await s5RulerClick(1);
  await page.keyboard.press("s");
  await sleep(300);
  const n = await page.locator("[data-clip-id]").count();
  if (n !== 2) throw new Error(`clips after S: ${n}`);
  return { clips: n, focus };
});

await step("Sprint 5: clic en la regla → Espacio, J/K/L y Supr funcionan", async () => {
  await s5Project("S5 regla transporte", 3);
  const preview = page.locator("section[aria-label='Vista previa']");
  await s5RulerClick(1);
  await page.keyboard.press("Space");
  await preview.getByRole("button", { name: "Pausar" }).waitFor({ timeout: 3_000 });
  await page.keyboard.press("k");
  await preview.getByRole("button", { name: "Reproducir" }).waitFor({ timeout: 3_000 });
  const t0 = await s5Playhead();
  await page.keyboard.press("l");
  await sleep(800);
  await page.keyboard.press("k");
  const t1 = await s5Playhead();
  if (!(t1 > t0)) throw new Error(`L did not advance: ${t0} -> ${t1}`);
  await page.keyboard.press("j");
  await sleep(500);
  await page.keyboard.press("k");
  const t2 = await s5Playhead();
  if (!(t2 < t1)) throw new Error(`J did not go back: ${t1} -> ${t2}`);
  // Select the middle clip, click the ruler, then Supr (no click on the clip after the ruler).
  await page.locator("[data-clip-id='s5c1']").click();
  await s5RulerClick(5);
  await page.keyboard.press("Delete");
  await sleep(300);
  const ids = (await s5Clips()).map((c) => c.id);
  if (ids.length !== 2 || ids.includes("s5c1")) throw new Error(`after Supr: ${ids}`);
  return { t0, t1, t2, left: ids };
});

await step("Sprint 5: Shift+Supr cierra el hueco (0 px)", async () => {
  await s5Project("S5 ripple", 3);
  await page.locator("[data-clip-id='s5c1']").click();
  await page.keyboard.press("Shift+Delete");
  await sleep(300);
  const a = await page.locator("[data-clip-id='s5c0']").boundingBox();
  const c = await page.locator("[data-clip-id='s5c2']").boundingBox();
  const gap = Math.round(c.x - (a.x + a.width));
  if (Math.abs(gap) > 1) throw new Error(`gap after Shift+Supr: ${gap} px`);
  const clips = await s5Clips();
  if (clips.length !== 2 || clips[1].start !== 2) throw new Error(JSON.stringify(clips));
  return { gapPx: gap };
});

await step("Sprint 5: Mayús+clic elige 2 y Supr borra 2", async () => {
  await s5Project("S5 multi", 3);
  await page.locator("[data-clip-id='s5c0']").click();
  await page.locator("[data-clip-id='s5c1']").click({ modifiers: ["Shift"] });
  await page.getByTestId("selection-count").filter({ hasText: "2 clips" }).waitFor();
  await page.keyboard.press("Delete");
  await sleep(300);
  const ids = (await s5Clips()).map((c) => c.id);
  if (ids.join() !== "s5c2") throw new Error(`after Supr: ${ids}`);
  return { left: ids };
});

await step("Sprint 5: rectángulo elige 3", async () => {
  await s5Project("S5 rectángulo", 3);
  const lane = page.locator("[data-track-kind='audio']").first();
  const box = await lane.boundingBox();
  const last = await page.locator("[data-clip-id='s5c2']").boundingBox();
  // from the empty audio lane (left) up to the video lane past the last clip
  await page.mouse.move(box.x + 4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(last.x + last.width / 2, last.y + 10, { steps: 8 });
  await page.getByTestId("timeline-marquee").waitFor({ timeout: 2_000 });
  await page.mouse.up();
  const text = await page.getByTestId("selection-count").innerText();
  if (!/3 clips/.test(text)) throw new Error(`selection: ${text}`);
  return { selection: text };
});

await step("Sprint 5: Q/W recortan al cursor", async () => {
  await s5Project("S5 QW", 3);
  // The ruler click lands within a few ms of the target: compare against the real playhead.
  const near = (a, b) => Math.abs(a - b) < 0.02;
  await s5RulerClick(3);
  const q = await s5Playhead();
  await page.keyboard.press("q");
  await sleep(300);
  let clips = await s5Clips();
  // b loses [2, q): starts at 2 with in = q, c follows its new end
  if (!(clips[1].start === 2 && near(clips[1].in, q) && near(clips[2].start, 4 - (q - 2))))
    throw new Error(`Q at ${q}: ${JSON.stringify(clips)}`);
  await s5RulerClick(1);
  const w = await s5Playhead();
  await page.keyboard.press("w");
  await sleep(300);
  const before = clips;
  clips = await s5Clips();
  // a loses [w, 2): b and c move left by 2 − w
  if (!(
    near(clips[0].out, w) &&
    near(clips[1].start, w) &&
    near(clips[2].start, before[2].start - (2 - w))
  ))
    throw new Error(`W at ${w}: ${JSON.stringify(clips)}`);
  return { starts: clips.map((c) => c.start) };
});

await step("Sprint 5: I/O marcan rango visible", async () => {
  await s5Project("S5 IO", 3);
  await s5RulerClick(1);
  await page.keyboard.press("i");
  await s5RulerClick(3);
  await page.keyboard.press("o");
  const range = await page.getByTestId("inout-range").boundingBox();
  const ruler = await page.getByTestId("inout-ruler").boundingBox();
  const label = await page.getByTestId("inout-label").innerText();
  if (!range || range.width < 20) throw new Error(`I/O range ${JSON.stringify(range)}`);
  await page.keyboard.press("Alt+x");
  await sleep(200);
  if (await page.getByTestId("inout-range").count()) throw new Error("Alt+X did not clear I/O");
  return { widthPx: Math.round(range.width), ruler: Math.round(ruler.width), label };
});

await step("Sprint 5: 1366×768 y 1093×700: Asistente y Exportar visibles sin menú", async () => {
  const out = {};
  for (const [w, h] of [
    [1366, 768],
    [1093, 700],
  ]) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(500);
    for (const id of ["header-assistant", "header-export"]) {
      const b = await page.getByTestId(id).boundingBox();
      if (!b || b.x < 0 || b.x + b.width > w || b.y + b.height > h)
        throw new Error(`${id} not visible at ${w}×${h}: ${JSON.stringify(b)}`);
    }
    await page.getByTestId("header-export").click();
    await page.locator("section[aria-label='Exportar']").waitFor({ timeout: 5_000 });
    await page.getByTestId("header-assistant").click();
    await page.locator("section[aria-label='Asistente']").waitFor({ timeout: 5_000 });
    out[`${w}x${h}`] = await shot(page, `s5-cabecera-${w}.png`);
  }
  await page.setViewportSize({ width: 1366, height: 820 });
  return out;
});

await step("Sprint 5: hover en Paneles muestra la explicación", async () => {
  await page.mouse.move(5, 300);
  await page.getByRole("button", { name: "Paneles" }).hover();
  const tip = page.getByRole("tooltip");
  await tip.waitFor({ timeout: 3_000 });
  const text = await tip.innerText();
  if (!/Mostrar u ocultar paneles/.test(text)) throw new Error(`tooltip: ${text}`);
  return { text };
});

await step(
  "Sprint 5: cada botón de ícono tiene una explicación (TIPS ≥ 20 caracteres)",
  async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      new URL("../../apps/web/src/lib/tooltips.ts", import.meta.url),
      "utf8",
    );
    const tipKeys = new Set([...src.matchAll(/^\s{2}(\w+): "/gm)].map((m) => m[1]));
    if (tipKeys.size !== 51) throw new Error(`TIPS keys parsed: ${tipKeys.size}`);
    await page.locator(".dv-tab", { hasText: "Línea de tiempo" }).click();
    await page.locator(".dv-tab", { hasText: "Vista previa" }).click();
    await page.locator(".dv-tab", { hasText: "Media" }).first().click();
    const rows = await page.$$eval(
      "header button[aria-label], section[aria-label='Media'] button[aria-label], section[aria-label='Vista previa'] button[aria-label], section[aria-label='Línea de tiempo'] button[aria-label]",
      (els) =>
        els
          .filter((b) => !b.textContent?.trim() && b.getClientRects().length > 0)
          .map((b) => ({
            label: b.getAttribute("aria-label"),
            tip: b.dataset.tooltip ?? "",
            key: b.dataset.tip ?? null,
          })),
    );
    // M1 owns the GPU indicator tooltip (TIPS.gpu).
    const mine = rows.filter((r) => !/^Estado de la IA local/.test(r.label));
    const bad = mine.filter((r) => r.tip.length < 20 || r.tip === r.label);
    if (bad.length) throw new Error(`without explanation: ${JSON.stringify(bad.slice(0, 5))}`);
    const unknown = mine.filter((r) => r.key && !tipKeys.has(r.key));
    if (unknown.length) throw new Error(`data-tip not in TIPS: ${JSON.stringify(unknown)}`);
    return { buttons: mine.length, withTipsKey: mine.filter((r) => r.key).length };
  },
);

await step(
  "Sprint 5: Proyectos: crear 2, renombrar, abrir el otro, borrar con confirmación",
  async () => {
    const dialog = () => page.getByRole("dialog", { name: "Proyectos" });
    const rename = async (to) => {
      await page.getByTestId("projects-button").click();
      const row = dialog().locator("[data-testid='project-row']", { hasText: "(abierto)" });
      await row.getByRole("button", { name: /^Renombrar/ }).click();
      const input = dialog().getByRole("textbox", { name: "Nuevo nombre del proyecto" });
      await input.fill(to);
      await input.press("Enter");
      await page.getByTestId("project-name").filter({ hasText: to }).waitFor({ timeout: 5_000 });
      await page.keyboard.press("Escape");
    };
    await page.mouse.click(700, 5);
    await page.keyboard.press("Control+Alt+n");
    await page.getByTestId("project-name").filter({ hasText: "Proyecto sin título" }).waitFor();
    await sleep(1_000);
    await rename("S5 UI uno");
    await page.keyboard.press("Control+Alt+n");
    await page.getByTestId("project-name").filter({ hasText: "Proyecto sin título" }).waitFor();
    await sleep(1_000);
    await rename("S5 UI dos");
    // Ctrl+O opens the list; open the other one
    await page.mouse.click(700, 5);
    await page.keyboard.press("Control+o");
    await dialog().waitFor({ timeout: 5_000 });
    const uno = dialog().locator("[data-testid='project-row']", { hasText: "S5 UI uno" });
    await uno.getByRole("button", { name: "Abrir", exact: true }).click();
    await page.getByTestId("project-name").filter({ hasText: "S5 UI uno" }).waitFor();
    const s = await shot(page, "s5-proyectos.png");
    // delete «dos» with confirmation
    await page.getByTestId("projects-button").click();
    const dos = dialog().locator("[data-testid='project-row']", { hasText: "S5 UI dos" });
    await dos.getByRole("button", { name: /^Borrar/ }).click();
    await dos.getByRole("alert").filter({ hasText: "¿Borrar «S5 UI dos»?" }).waitFor();
    await dos.getByRole("button", { name: "Sí, borrar" }).click();
    await dos.waitFor({ state: "detached", timeout: 5_000 });
    await page.keyboard.press("Escape");
    const list = await apiJson("/api/projects?view=summary");
    if (list.some((p) => p.name === "S5 UI dos")) throw new Error("«S5 UI dos» still in the api");
    if (!list.some((p) => p.name === "S5 UI uno"))
      throw new Error("«S5 UI uno» missing in the api");
    return { projects: list.length, shot: s };
  },
);

await step("Sprint 5: estado vacío de la vista previa", async () => {
  await page.mouse.click(700, 5);
  await page.keyboard.press("Control+Alt+n");
  await page.getByTestId("project-name").filter({ hasText: "Proyecto sin título" }).waitFor();
  await page.locator(".dv-tab", { hasText: "Vista previa" }).click();
  const empty = page.getByTestId("preview-empty");
  await empty.waitFor({ timeout: 5_000 });
  const text = await empty.innerText();
  if (!/Arrastrá un video acá o tocá Importar/.test(text)) throw new Error(text);
  await empty.getByRole("button", { name: "Importar" }).waitFor();
  const timelineEmpty = await page.getByTestId("timeline-empty").innerText();
  return { shot: await shot(page, "s5-vista-previa-vacia.png"), timelineEmpty };
});
// ------------------------------------------------------------------ END sprint5:M2

// ---------------------------------------------------------------- BEGIN sprint5:M1
// Centro de trabajos y errores: no repeated toasts after a reload, ONE banner when the workers are
// off (AI actions disabled with the reason), and the jobs center with counts, ETA and Cancelar
// (agent.eval with the mocked planner of workers-with-mocks.py, STUDIO_MOCK_AGENT_EVAL).
const m1s5Toasts = () => page.locator("[data-sonner-toast]").count();
/** Dashboard loaded; the timeline tab active again (the layout is saved in the api). */
async function m1s5Ready() {
  await page.waitForSelector(".dv-tab", { timeout: 60_000 });
  const timeline = page.locator("section[aria-label='Línea de tiempo']");
  if (!(await timeline.count()))
    await page.locator(".dv-tab", { hasText: "Línea de tiempo" }).first().click();
  await timeline.waitFor({ timeout: 15_000 });
}

await step("Sprint 5: recargar no repite toasts", async () => {
  await page.goto(WEB, { waitUntil: "domcontentloaded" });
  await m1s5Ready();
  // A finished job of this session (quick eval, ~4 s with the mock) plus whatever ran before.
  const { jobId } = await apiSend("POST", "/api/agent/eval", {});
  await waitApiJob(jobId, 120_000);
  await sleep(1500);
  for (let i = 0; i < 2; i++) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await m1s5Ready();
    await sleep(3000);
    const n = await m1s5Toasts();
    if (n > 0) {
      const texts = await page.locator("[data-sonner-toast]").allInnerTexts();
      throw new Error(`reload ${i + 1}: ${n} toasts: ${texts.join(" | ").slice(0, 200)}`);
    }
  }
  const seen = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("studio.jobs.seen.v1") ?? "[]"),
  );
  if (!seen.includes(jobId)) throw new Error("the finished job is not in studio.jobs.seen.v1");
  return { seen: seen.length };
});

await step(
  "Sprint 5: workers apagados → un banner y Transcribir deshabilitado con motivo",
  async () => {
    const off = (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({
          status: "degraded",
          version: "0.1.0",
          ffmpeg: { available: true },
          workers: { reachable: false, url: "http://127.0.0.1:8001" },
          checkedAt: new Date().toISOString(),
        }),
      });
    await page.route("**/api/health", off);
    try {
      await page.goto(WEB, { waitUntil: "domcontentloaded" });
      await m1s5Ready();
      const banner = page.getByTestId("service-banner");
      await banner.first().waitFor({ timeout: 15_000 });
      const count = await banner.count();
      if (count !== 1) throw new Error(`${count} banners`);
      const text = await banner.innerText();
      if (
        !text.includes("scripts\\windows\\start.cmd") ||
        /TypeError|ECONNREFUSED|start\.ps1/.test(text)
      )
        throw new Error(text);
      await banner.getByRole("button", { name: /Cómo iniciarla/ }).click();
      await page.getByTestId("service-help").waitFor();
      // Assistant «Proponer» (M1) is disabled with the reason as tooltip.
      const panel = await openAssistant();
      await panel.getByRole("textbox", { name: "Comando para el asistente" }).fill("hola");
      const proponer = panel.getByRole("button", { name: /Proponer/ });
      if (!(await proponer.isDisabled())) throw new Error("Proponer enabled with the workers off");
      const tip = (await proponer.getAttribute("data-tooltip")) ?? "";
      if (!tip.includes("start.cmd")) throw new Error(`Proponer tooltip: ${tip}`);
      // Transcribir (Subtítulos, M2 consumes useAiAvailability).
      await page
        .locator(".dv-tab", { hasText: "Subtítulos" })
        .click()
        .catch(() => undefined);
      const tr = page.getByRole("button", { name: /Transcribir/ }).first();
      const transcribir = (await tr.count()) ? await tr.isDisabled() : null;
      if (transcribir === false) throw new Error("Transcribir enabled with the workers off");
      const s = await shot(page, "s5-workers-apagados.png");
      return { banners: count, transcribirDisabled: transcribir, shot: s };
    } finally {
      await page.unroute("**/api/health", off);
      await page.goto(WEB, { waitUntil: "domcontentloaded" });
      await m1s5Ready();
    }
  },
);

await step("Sprint 5: Trabajos muestra 3/20, faltan ~X y Cancelar", async () => {
  if (!page.url().startsWith(WEB)) {
    await page.goto(WEB, { waitUntil: "domcontentloaded" });
    await m1s5Ready();
  }
  await page.getByTestId("jobs-indicator").click();
  const { jobId } = await apiSend("POST", "/api/agent/eval", { mode: "full" });
  const row = page.locator("[data-testid='jobs-running'] [data-testid='job-row']").first();
  await row.waitFor({ timeout: 15_000 });
  await row
    .getByTestId("job-count")
    .filter({ hasText: /^([3-9]|[1-7]\d)\/80 comandos$/ })
    .waitFor({
      timeout: 20_000,
    });
  const count = await row.getByTestId("job-count").innerText();
  const stage = await row.getByTestId("job-stage").innerText();
  const eta = await row.getByTestId("job-eta").innerText();
  if (!/^faltan ~\d+ (s|min)/.test(eta)) throw new Error(`eta «${eta}»`);
  if (!/· \d+\/\d+$/.test(stage)) throw new Error(`stage «${stage}»`);
  const indicator = await page.getByTestId("jobs-indicator").getAttribute("data-active");
  const s = await shot(page, "s5-trabajos-eta.png");
  await row.getByTestId("job-cancel").click();
  let job;
  for (let i = 0; i < 60; i++) {
    job = await apiJson(`/api/jobs/${jobId}`);
    if (["succeeded", "failed", "canceled"].includes(job.status)) break;
    await sleep(500);
  }
  if (job?.status !== "canceled") throw new Error(`job ${job?.status}`);
  await page
    .locator("[data-testid='jobs-finished'] [data-testid='job-row'][data-status='canceled']")
    .first()
    .waitFor({ timeout: 10_000 });
  // Trabajos shares the group of the timeline: give the tab back (the layout is saved in the api).
  await page.locator(".dv-tab", { hasText: "Línea de tiempo" }).first().click();
  return { count, stage, eta, indicator, shot: s };
});
// ------------------------------------------------------------------ END sprint5:M1

await browser.close();
console.log(
  `\nconsole errors (${consoleErrors.length}):`,
  [...new Set(consoleErrors)].slice(0, 10),
);
const failed = results.filter((r) => r.status === "FAIL").length;
console.log(`${results.length - failed} PASS, ${failed} FAIL`);
console.log(JSON.stringify({ results, consoleErrors: [...new Set(consoleErrors)] }, null, 1));
process.exit(failed ? 1 : 0);

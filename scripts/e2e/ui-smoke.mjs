#!/usr/bin/env node
/* global document, window */
// Headless UI smoke test of the Studio dashboard with Playwright (Chromium).
//
//   node scripts/e2e/ui-smoke.mjs --web http://127.0.0.1:3000 --api http://127.0.0.1:3001 \
//        --media <folder with a .mp4/.wav/.png> [--shots docs/trabajo/capturas] [--headed] [--vp9-preview]
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
async function step(name, fn) {
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

await browser.close();
console.log(
  `\nconsole errors (${consoleErrors.length}):`,
  [...new Set(consoleErrors)].slice(0, 10),
);
const failed = results.filter((r) => r.status === "FAIL").length;
console.log(`${results.length - failed} PASS, ${failed} FAIL`);
console.log(JSON.stringify({ results, consoleErrors: [...new Set(consoleErrors)] }, null, 1));
process.exit(failed ? 1 : 0);

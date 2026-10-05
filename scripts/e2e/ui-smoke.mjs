#!/usr/bin/env node
/* global document */
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
      return route.fulfill({ status: 200, contentType: "video/webm", body: vp9Cache.get(url) });
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

await browser.close();
console.log(
  `\nconsole errors (${consoleErrors.length}):`,
  [...new Set(consoleErrors)].slice(0, 10),
);
const failed = results.filter((r) => r.status === "FAIL").length;
console.log(`${results.length - failed} PASS, ${failed} FAIL`);
console.log(JSON.stringify({ results, consoleErrors: [...new Set(consoleErrors)] }, null, 1));
process.exit(failed ? 1 : 0);

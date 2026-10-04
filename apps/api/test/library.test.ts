import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { API_ROUTES, buildRoute } from "@studio/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/database.js";
import { freesoundLicense, FreesoundProvider } from "../src/library/freesound.js";
import { ftsQuery, LibraryIndex, tagsFromPath } from "../src/library/index-db.js";
import { bucketsPerSecond, peaksFromPcm } from "../src/library/peaks.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

function tone(file: string, seconds = 0.5): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const r = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=f=440:d=${seconds}`,
    file,
  ]);
  if (r.status !== 0) throw new Error(String(r.stderr));
}

describe("library helpers", () => {
  it("builds FTS prefix queries and path tags", () => {
    expect(ftsQuery("  Puerta  cierr! ")).toBe('"puerta"* "cierr"*');
    expect(ftsQuery("***")).toBeUndefined();
    expect(tagsFromPath("sfx/kenney/impact-sounds/footstep_concrete_001.ogg", ["CC0"])).toEqual([
      "kenney",
      "impact",
      "sounds",
      "footstep",
      "concrete",
      "cc0",
    ]);
  });

  it("computes max-abs peaks normalised to 0..1", () => {
    const pcm = Buffer.alloc(8000 * 2); // 1 s of silence at 8 kHz
    pcm.writeInt16LE(-32768, 0);
    pcm.writeInt16LE(16384, 320); // sample 160 -> bucket 2 (80 samples each)
    const peaks = peaksFromPcm(pcm);
    expect(peaks.durationSec).toBe(1);
    expect(peaks.bucketsPerSecond).toBe(100);
    expect(peaks.peaks).toHaveLength(100);
    expect(peaks.peaks[0]).toBe(1);
    expect(peaks.peaks[2]).toBe(0.5);
    expect(bucketsPerSecond(600)).toBe(10);
  });

  it("maps Freesound licenses", () => {
    expect(freesoundLicense("http://creativecommons.org/publicdomain/zero/1.0/")).toBe("CC0-1.0");
    expect(freesoundLicense("https://creativecommons.org/licenses/by/4.0/")).toBe("CC-BY-4.0");
    expect(freesoundLicense("http://creativecommons.org/licenses/by-nc/3.0/")).toBe("CC-BY-NC-3.0");
    expect(freesoundLicense("Attribution")).toBe("CC-BY-4.0");
  });

  it("searches Freesound with the token and maps results (previews only)", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: URL | string, init?: RequestInit) => {
      calls.push(`${String(url)} ${JSON.stringify(init?.headers)}`);
      return new Response(
        JSON.stringify({
          count: 1,
          results: [
            {
              id: 42,
              name: "Puerta",
              tags: ["door"],
              license: "http://creativecommons.org/publicdomain/zero/1.0/",
              previews: { "preview-hq-mp3": "https://cdn.freesound.org/p/42.mp3" },
              duration: 1.2,
              username: "ana",
              url: "https://freesound.org/s/42/",
            },
          ],
        }),
      );
    }) as typeof fetch;
    const fs = new FreesoundProvider("tok", fakeFetch);
    const page = await fs.search({ q: "puerta", provider: "freesound", page: 1, pageSize: 10 });
    expect(calls[0]).toContain("query=puerta");
    expect(calls[0]).toContain('"Authorization":"Token tok"');
    expect(page.items[0]).toMatchObject({
      id: "freesound:42",
      provider: "freesound",
      license: "CC0-1.0",
      previewUrl: "https://cdn.freesound.org/p/42.mp3",
    });
    expect(new FreesoundProvider(undefined).enabled()).toBe(false);
  });
});

describe.skipIf(!hasFfmpeg)("LibraryIndex (FTS5 + peaks)", () => {
  const storage = mkdtempSync(path.join(tmpdir(), "studio-lib-"));
  const lib = path.join(storage, "library");
  const index = new LibraryIndex(openDatabase(":memory:"), storage, "ffmpeg");

  beforeAll(() => {
    tone(path.join(lib, "sfx", "kenney", "impact", "Puerta_cerrándose.wav"));
    tone(path.join(lib, "sfx", "kenney", "impact", "footstep_01.ogg"));
    tone(path.join(lib, "music", "loops", "calm_piano.mp3"), 2);
    writeFileSync(
      path.join(lib, "sfx", "kenney", "_pack.json"),
      JSON.stringify({
        source: "kenney",
        license: "CC0-1.0",
        attribution: "Kenney",
        tags: ["cc0"],
      }),
    );
    writeFileSync(path.join(lib, "sfx", "notes.txt"), "not audio");
  });

  it("scans, extracts license from _pack.json and writes peaks", async () => {
    const res = await index.scan();
    expect(res).toMatchObject({ scanned: 3, added: 3, updated: 0, removed: 0, errors: [] });
    const page = await index.search({ q: "", provider: "local", page: 1, pageSize: 30 });
    expect(page.total).toBe(3);
    const door = page.items.find((i) => i.name === "Puerta cerrándose")!;
    expect(door).toMatchObject({ kind: "sfx", license: "CC0-1.0", attribution: "Kenney" });
    expect(door.durationSec).toBeCloseTo(0.5, 1);
    const details = index.details(door.id)!;
    const peaks = JSON.parse(readFileSync(path.join(storage, details.peaksPath!), "utf8"));
    expect(peaks.version).toBe(1);
    expect(peaks.peaks.length).toBeGreaterThan(10);
    const music = page.items.find((i) => i.kind === "music")!;
    expect(music.license).toBe("unknown");
  });

  it("finds by prefix ignoring accents and filters by kind", async () => {
    const q = (text: string, kind?: "sfx" | "music") =>
      index.search({ q: text, provider: "local", page: 1, pageSize: 30, ...(kind && { kind }) });
    expect((await q("cerrand")).items.map((i) => i.name)).toEqual(["Puerta cerrándose"]);
    expect((await q("PUERTA")).total).toBe(1);
    expect((await q("kenney")).total).toBe(2);
    expect((await q("piano", "sfx")).total).toBe(0);
    expect((await q("piano", "music")).total).toBe(1);
  });

  it("rescans incrementally and drops deleted files", async () => {
    expect(await index.scan()).toMatchObject({ added: 0, updated: 0, removed: 0 });
    rmSync(path.join(lib, "sfx", "kenney", "impact", "footstep_01.ogg"));
    expect(await index.scan()).toMatchObject({ scanned: 2, removed: 1 });
  });

  it("imports uploads with dedupe and keeps edits on rescan", async () => {
    tone(path.join(storage, "tmp", "x.wav"), 0.3);
    const data = readFileSync(path.join(storage, "tmp", "x.wav"));
    const first = await index.importBuffer(data, {
      fileName: "Mi Golpe!.wav",
      kind: "sfx",
      source: "upload",
      license: "CC-BY-4.0",
      tags: ["golpe"],
    });
    expect(first.duplicate).toBe(false);
    expect(first.item.path).toBe("library/sfx/upload/Mi_Golpe_.wav");
    const again = await index.importBuffer(data, {
      fileName: "y.wav",
      kind: "sfx",
      source: "upload",
    });
    expect(again).toMatchObject({ duplicate: true, item: { id: first.item.id } });
    index.update(first.item.id, { name: "Golpe seco", tags: ["Golpe", "seco"] });
    await index.scan({ force: true });
    expect(index.details(first.item.id)).toMatchObject({
      name: "Golpe seco",
      tags: ["golpe", "seco"],
      license: "CC-BY-4.0",
    });
    await expect(
      index.importBuffer(Buffer.from("x"), { fileName: "a.exe", kind: "sfx", source: "upload" }),
    ).rejects.toThrow(/no soportado/);
  });
});

describe("library + voice routes", () => {
  let app: FastifyInstance;
  const storage = mkdtempSync(path.join(tmpdir(), "studio-routes-"));

  beforeAll(async () => {
    if (hasFfmpeg) tone(path.join(storage, "library", "sfx", "boom.wav"));
    const config = loadConfig({
      STORAGE_DIR: storage,
      WORKERS_URL: "http://127.0.0.1:1",
      FFMPEG_PATH: "ffmpeg",
    });
    app = await buildApp({ config, inMemoryDb: true, logger: false });
    await app.ready();
  });
  afterAll(() => app.close());

  it("lists providers with status labels", async () => {
    const res = await app.inject({ method: "GET", url: API_ROUTES.libraryProviders });
    expect(res.json()).toEqual([
      { id: "local", enabled: true, status: "local" },
      { id: "freesound", enabled: false, status: "no configurado" },
      { id: "pixabay", enabled: false, status: "sin API de audio (importar a mano)" },
    ]);
  });

  it("rejects unconfigured or audio-less providers", async () => {
    const fs = await app.inject({ method: "GET", url: `${API_ROUTES.library}?provider=freesound` });
    expect(fs.statusCode).toBe(409);
    const px = await app.inject({ method: "GET", url: `${API_ROUTES.library}?provider=pixabay` });
    expect(px.statusCode).toBe(400);
  });

  it.skipIf(!hasFfmpeg)("scans, searches and imports a local item as MediaAsset", async () => {
    const scan = await app.inject({ method: "POST", url: API_ROUTES.libraryScan });
    expect(scan.json()).toMatchObject({ added: 1 });
    const search = await app.inject({ method: "GET", url: `${API_ROUTES.library}?q=boo` });
    const item = search.json().items[0];
    expect(item).toMatchObject({ name: "boom", provider: "local", path: "library/sfx/boom.wav" });
    const peaks = await app.inject({
      method: "GET",
      url: buildRoute(API_ROUTES.libraryPeaks, { id: item.id }),
    });
    expect(peaks.json().version).toBe(1);
    const imp = await app.inject({
      method: "POST",
      url: API_ROUTES.libraryImport,
      payload: { provider: "local", remoteId: item.id },
    });
    expect(imp.statusCode).toBe(201);
    expect(imp.json()).toMatchObject({ kind: "audio", name: "boom" });
    expect(imp.json().path).toMatch(/^media\/.+\.wav$/);
  });

  it.skipIf(!hasFfmpeg)("uploads a file to the library via multipart", async () => {
    tone(path.join(storage, "tmp", "up.wav"), 0.2);
    const boundary = "----studio";
    const file = readFileSync(path.join(storage, "tmp", "up.wav"));
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nmusic\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="license"\r\n\r\nCC0-1.0\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="jingle.wav"\r\n` +
          `Content-Type: audio/wav\r\n\r\n`,
      ),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.libraryImport,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ kind: "music", license: "CC0-1.0", name: "jingle" });
  });

  it("voice routes validate before enqueueing", async () => {
    const cloud = await app.inject({
      method: "POST",
      url: API_ROUTES.tts,
      payload: { provider: "openai", text: "hola", voice: "nova" },
    });
    expect(cloud.statusCode).toBe(409);
    const tts = await app.inject({
      method: "POST",
      url: API_ROUTES.tts,
      payload: { text: "hola", voice: "es_AR-daniela-high" },
    });
    expect(tts.statusCode).toBe(202);
    expect(tts.json().jobId).toBeTruthy();
    const rvc = await app.inject({
      method: "POST",
      url: API_ROUTES.rvc,
      payload: { assetId: "missing", modelId: "x" },
    });
    expect(rvc.statusCode).toBe(404);
    const sub = await app.inject({
      method: "POST",
      url: API_ROUTES.transcribe,
      payload: { assetId: "missing" },
    });
    expect(sub.statusCode).toBe(404);
    const providers = await app.inject({ method: "GET", url: API_ROUTES.ttsProviders });
    expect(providers.json()[2]).toEqual({
      id: "openai",
      name: "OpenAI TTS",
      enabled: false,
      status: "no configurado",
    });
    const voices = await app.inject({ method: "GET", url: API_ROUTES.ttsVoices });
    expect(voices.statusCode).toBe(503);
    expect(voices.json().error.code).toBe("WORKERS_UNAVAILABLE");
  });
});

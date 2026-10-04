import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Job, MediaAsset } from "@studio/shared";
import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/db/database.js";
import type { JobContext } from "../src/jobs/types.js";
import { createRepos } from "../src/repos/index.js";
import type { WorkersClient } from "../src/services/workers-client.js";
import {
  createRvcHandler,
  createTranscribeHandler,
  createTtsHandler,
  type VoiceAiDeps,
} from "../src/voice-ai/handlers.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

function setup(workers: Partial<WorkersClient>) {
  const storageDir = mkdtempSync(path.join(tmpdir(), "studio-vai-"));
  for (const d of ["media", "renders", "tmp"]) mkdirSync(path.join(storageDir, d));
  const repos = createRepos(openDatabase(":memory:"));
  const enqueued: unknown[] = [];
  const deps = {
    config: { storageDir, ffmpegPath: "ffmpeg", useCuda: false },
    repos,
    queue: { hasHandler: () => true, enqueue: (j: unknown) => enqueued.push(j) },
    workers,
  } as unknown as VoiceAiDeps;
  const progress: number[] = [];
  const ctx: JobContext = {
    jobId: "job1",
    signal: new AbortController().signal,
    reportProgress: (p) => progress.push(p),
    log: () => undefined,
    storageDir,
  };
  const job = { id: "job1" } as Job;
  return { storageDir, repos, deps, ctx, job, progress, enqueued };
}

function addAsset(repos: VoiceAiDeps["repos"], storageDir: string, rel: string): MediaAsset {
  const asset: MediaAsset = {
    id: "src1",
    kind: "audio",
    name: "Mi voz",
    path: rel,
    sizeBytes: 1,
    createdAt: new Date().toISOString(),
  };
  if (!existsSync(path.join(storageDir, rel))) writeFileSync(path.join(storageDir, rel), "x");
  repos.media.insert(asset);
  return asset;
}

describe("voice.tts handler", () => {
  it("calls workers /tts and registers the result as a MediaAsset", async () => {
    const tts = vi.fn<WorkersClient["tts"]>(async (req) => {
      writeFileSync(path.join(storageDir, req.outputPath), "RIFF");
      return { path: req.outputPath, durationSec: 1.5, sampleRate: 22050 };
    });
    const { storageDir, deps, ctx, job, repos, enqueued } = setup({ tts });
    const handler = createTtsHandler(deps);
    const payload = handler.parse({ text: "Hola che", voice: "es_AR-daniela-high" });
    const result = await handler.run(payload, ctx, job);
    expect(tts.mock.calls[0]?.[0]).toMatchObject({
      outputPath: "renders/job1.wav",
      provider: "piper",
      jobId: "job1",
      speed: 1,
    });
    expect(result).toMatchObject({ path: "renders/job1.wav", durationSec: 1.5 });
    const asset = repos.media.get(result.assetId!);
    expect(asset).toMatchObject({ kind: "audio", path: "renders/job1.wav", sampleRate: 22050 });
    // B1: audio gets a probe (waveform peaks), never a video-only proxy.
    expect(enqueued).toEqual([
      { type: "media.probe", payload: { assetId: result.assetId }, priority: 1 },
    ]);
  });
});

describe("voice.rvc handler", () => {
  it("converts the source asset with the requested model", async () => {
    const rvcConvert = vi.fn<WorkersClient["rvcConvert"]>(async (req) => {
      writeFileSync(path.join(storageDir, req.outputPath), "RIFF");
      return { path: req.outputPath, durationSec: 2, sampleRate: 40000, device: "cpu" };
    });
    const { storageDir, deps, ctx, job, repos } = setup({ rvcConvert });
    addAsset(repos, storageDir, "media/src1.wav");
    const handler = createRvcHandler(deps);
    const result = await handler.run(
      handler.parse({ assetId: "src1", modelId: "mi_voz", pitchShift: 12 }),
      ctx,
      job,
    );
    expect(rvcConvert.mock.calls[0]?.[0]).toMatchObject({
      inputPath: "media/src1.wav",
      modelId: "mi_voz",
      pitchShift: 12,
      f0Method: "rmvpe",
      device: "cpu",
      outputPath: "renders/job1.wav",
    });
    expect(repos.media.get(result.assetId!)?.name).toBe("Mi voz (RVC mi_voz)");
  });

  it("fails clearly when the source asset does not exist", async () => {
    const { deps, ctx, job } = setup({});
    const handler = createRvcHandler(deps);
    await expect(
      handler.run(handler.parse({ assetId: "nope", modelId: "x" }), ctx, job),
    ).rejects.toThrow(/no encontrado/);
  });
});

describe.skipIf(!hasFfmpeg)("subtitles.transcribe handler", () => {
  it("extracts 16 kHz WAV, calls workers and returns transcript + files", async () => {
    const transcribe = vi.fn<WorkersClient["transcribe"]>(async (req) => {
      expect(existsSync(path.join(storageDir, req.inputPath))).toBe(true);
      return {
        language: "es",
        durationSec: 1,
        segments: [{ start: 0, end: 1, text: "hola" }],
        files: { jsonPath: "renders/job1.json", srt: "renders/job1.srt", ass: "renders/job1.ass" },
      };
    });
    const { storageDir, deps, ctx, job, repos } = setup({ transcribe });
    spawnSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=f=440:d=1",
      path.join(storageDir, "media", "src1.wav"),
    ]);
    addAsset(repos, storageDir, "media/src1.wav");
    const handler = createTranscribeHandler(deps);
    const result = await handler.run(handler.parse({ assetId: "src1" }), ctx, job);
    expect(transcribe.mock.calls[0]?.[0]).toMatchObject({
      inputPath: "tmp/job1.wav",
      language: "es",
      wordTimestamps: true,
      outputBase: "renders/job1",
    });
    expect(result).toMatchObject({
      path: "renders/job1.json",
      srtPath: "renders/job1.srt",
      assPath: "renders/job1.ass",
      transcript: { language: "es", durationSec: 1 },
    });
    // temp WAV is cleaned up
    expect(existsSync(path.join(storageDir, "tmp", "job1.wav"))).toBe(false);
  });
});

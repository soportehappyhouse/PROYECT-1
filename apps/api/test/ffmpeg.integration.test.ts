import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  API_ROUTES,
  buildRoute,
  WaveformPeaksSchema,
  type VoiceEffect,
  type ExportPreset,
  type FileJobResult,
  type Job,
  type MediaAsset,
  type Project,
} from "@studio/shared";
import { createFfmpegService } from "../src/services/ffmpeg.js";
import { burnSubtitlesArgs } from "../src/services/ffmpeg/builders.js";
import { detectHardwareEncoders } from "../src/services/ffmpeg/encoders.js";
import { runFfmpeg } from "../src/services/ffmpeg/runner.js";
import { makeApp, multipart, tempStorage, waitFor } from "./helpers.js";

const hasFfmpeg =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

// CI installs ffmpeg: there a missing binary must fail instead of silently skipping the suite.
it.runIf(process.env.CI === "true")("ffmpeg and ffprobe are on PATH (CI)", () => {
  expect(hasFfmpeg, "ffmpeg/ffprobe not found on PATH; the CI workflow installs them").toBe(true);
});

const gen = (args: string[]) =>
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);

describe.skipIf(!hasFfmpeg)(
  "ffmpeg integration (generated lavfi media)",
  // Generous limits: under full-suite load (all packages in parallel) ffmpeg runs much slower.
  { timeout: 300_000 },
  () => {
    const dir = tempStorage("studio-ff-");
    const f = (n: string) => path.join(dir, n);
    const ff = createFfmpegService("ffmpeg", "ffprobe");
    let app: FastifyInstance;

    beforeAll(async () => {
      gen([
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=25:duration=4",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=4",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        f("a.mp4"),
      ]);
      gen([
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=320x240:rate=25:duration=3",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        f("b.mp4"),
      ]);
      gen([
        "-f",
        "lavfi",
        "-i",
        "color=c=red@0.5:s=64x64,format=rgba",
        "-frames:v",
        "1",
        f("logo.png"),
      ]);
      gen(["-f", "lavfi", "-i", "sine=frequency=220:duration=2", "-ar", "48000", f("voice.wav")]);
      gen(["-f", "lavfi", "-i", "sine=frequency=880:duration=3", "-ar", "48000", f("music.wav")]);
      gen([
        "-f",
        "lavfi",
        "-i",
        "color=c=black@0.0:s=160x90:d=2:r=25,format=yuva420p,drawbox=x=20:y=20:w=60:h=30:color=yellow@1:t=fill",
        "-c:v",
        "libvpx-vp9",
        "-pix_fmt",
        "yuva420p",
        "-auto-alt-ref",
        "0",
        "-b:v",
        "0",
        "-crf",
        "40",
        "-deadline",
        "realtime",
        f("title.webm"),
      ]);
      ({ app } = await makeApp({ FFMPEG_PATH: "ffmpeg", FFPROBE_PATH: "ffprobe" }));
    }, 120_000);
    afterAll(() => app?.close());

    const upload = async (file: string, type: string) => {
      const { payload, headers } = await multipart(path.basename(file), readFileSync(file), type);
      const res = await app.inject({ method: "POST", url: API_ROUTES.media, payload, headers });
      expect(res.statusCode).toBe(201);
      return res.json<MediaAsset>();
    };
    const jobDone = async (id: string): Promise<Job> => {
      try {
        await waitFor(
          () => ["succeeded", "failed", "canceled"].includes(app.ctx.jobs.get(id)!.status),
          240_000,
        );
      } catch (err) {
        // A stuck job (seen once on windows-latest) must say which step and what ffmpeg printed.
        const stuck = app.ctx.jobs.get(id)!;
        throw new Error(
          `${stuck.type} still ${stuck.status} after 240 s (progress ${stuck.progress}, ` +
            `«${stuck.message ?? ""}»): ` +
            `${String(err)}\n${app.ctx.jobs.logTail(id).join("\n")}`,
        );
      }
      const job = app.ctx.jobs.get(id)!;
      if (job.status === "failed")
        throw new Error(`${job.type} failed: ${job.error}\n${app.ctx.jobs.logTail(id).join("\n")}`);
      return job;
    };
    const idle = async () => {
      await waitFor(
        () =>
          app.ctx.jobs.list({ status: "running" }).length +
            app.ctx.jobs.list({ status: "queued" }).length ===
          0,
        240_000,
      );
    };
    const duration = async (abs: string) => (await ff.probe(abs)).durationSec ?? 0;

    it("probes generated media", async () => {
      const info = await ff.probe(f("a.mp4"));
      expect(info).toMatchObject({
        kind: "video",
        width: 320,
        height: 180,
        fps: 25,
        hasAudio: true,
      });
      expect(info.durationSec).toBeCloseTo(4, 1);
      expect(await ff.probe(f("logo.png"))).toMatchObject({ kind: "image", hasAlpha: true });
      expect(await ff.probe(f("title.webm"))).toMatchObject({
        kind: "video",
        hasAlpha: true,
        videoCodec: "vp9",
      });
    });

    it("import pipeline: probe + thumbnail + sprite + peaks + proxy", async () => {
      const asset = await upload(f("a.mp4"), "video/mp4");
      await idle();
      const stored = app.ctx.repos.media.get(asset.id)!;
      expect(stored).toMatchObject({
        kind: "video",
        width: 320,
        height: 180,
        hasAudio: true,
        hasVideo: true,
      });
      expect(stored.durationSec).toBeCloseTo(4, 1);
      const abs = (rel: string) => path.join(app.ctx.config.storageDir, rel);
      for (const rel of [
        stored.thumbnailPath!,
        stored.sprite!.path,
        stored.waveformPath!,
        stored.proxyPath!,
      ]) {
        expect(existsSync(abs(rel))).toBe(true);
      }
      expect(stored.sprite).toMatchObject({ columns: 4, rows: 1, count: 4, intervalSec: 1 });
      const peaks = WaveformPeaksSchema.parse(
        JSON.parse(readFileSync(abs(stored.waveformPath!), "utf8")),
      );
      expect(peaks.peaks.length).toBeGreaterThan(300);
      expect(Math.max(...peaks.peaks)).toBeGreaterThan(0.05);
      expect((await ff.probe(abs(stored.proxyPath!))).height).toBe(360);
      const job = app.ctx.jobs.list({ type: "media.proxy" })[0]!;
      expect(job).toMatchObject({ status: "succeeded", progress: 1 });
    });

    it("voice effects keep duration (pitch/chipmunk/deep...) and run two-pass loudnorm + ducking", async () => {
      const cases: VoiceEffect[][] = [
        [{ type: "pitch", semitones: 4 }],
        [{ type: "pitch", semitones: -4 }],
        [{ type: "chipmunk" }],
        [{ type: "deep" }],
        [{ type: "robot", intensity: 1 }],
        [{ type: "robot", intensity: 0.5 }],
        [{ type: "telephone" }],
        [{ type: "radio" }],
        [{ type: "reverb", roomSize: 0.5, wet: 0.3 }],
        [{ type: "echo", delayMs: 60, decay: 0.4 }],
        [{ type: "denoise", reductionDb: 12, noiseFloorDb: -25 }],
        [{ type: "speed", factor: 2 }],
        [{ type: "loudnorm", integrated: -16, truePeak: -1.5, lra: 11, twoPass: true }],
      ];
      for (const [i, effects] of cases.entries()) {
        const out = f(`fx-${i}.wav`);
        await ff.applyVoiceEffects(f("voice.wav"), out, effects, { durationSec: 2 });
        const d = await duration(out);
        if (effects[0]!.type === "speed") expect(d).toBeCloseTo(1, 1);
        else expect(Math.abs(d - 2)).toBeLessThan(0.15);
      }
      const ducked = f("ducked.wav");
      await ff.applyVoiceEffects(
        f("voice.wav"),
        ducked,
        [
          {
            type: "ducking",
            musicAssetId: "m",
            threshold: 0.05,
            ratio: 8,
            attackMs: 20,
            releaseMs: 400,
            musicVolume: 1,
          },
        ],
        { musicPath: f("music.wav") },
      );
      expect(await duration(ducked)).toBeCloseTo(3, 1);
    });

    it("voice.effect job via the api registers a new audio asset", async () => {
      const voice = await upload(f("voice.wav"), "audio/wav");
      const res = await app.inject({
        method: "POST",
        url: API_ROUTES.voiceEffects,
        payload: { assetId: voice.id, effects: [{ type: "telephone" }, { type: "loudnorm" }] },
      });
      expect(res.statusCode).toBe(202);
      const job = await jobDone(res.json<{ jobId: string }>().jobId);
      const result = job.result as FileJobResult;
      expect(result.path).toMatch(/^renders\/.+\.wav$/);
      expect(app.ctx.repos.media.get(result.assetId!)).toMatchObject({ kind: "audio" });
    });

    it("burns subtitles from a path with quotes, colons, commas and spaces", async () => {
      // ":" is not allowed in Windows file names; there the drive letter (C:\) provides the colon.
      const weirdName =
        process.platform === "win32" ? "it's a, [weird] dir" : "it's: a, [weird] dir";
      const weird = path.join(dir, weirdName);
      mkdirSync(weird, { recursive: true });
      const srt = path.join(weird, "subs.srt");
      writeFileSync(srt, "1\n00:00:00,000 --> 00:00:01,000\nHola\n");
      const out = f("subbed.mp4");
      await runFfmpeg(
        "ffmpeg",
        burnSubtitlesArgs({ input: f("b.mp4"), output: out, file: srt, style: { fontSize: 20 } }),
        { durationSec: 3 },
      );
      expect(await duration(out)).toBeCloseTo(3, 0);
    });

    it("exports a multi-track project (xfade, image, text, motion alpha, music) and other presets", async () => {
      const a = await upload(f("a.mp4"), "video/mp4");
      const b = await upload(f("b.mp4"), "video/mp4");
      const logo = await upload(f("logo.png"), "image/png");
      const music = await upload(f("music.wav"), "audio/wav");
      const title = await upload(f("title.webm"), "video/webm");
      await idle();

      const created = await app.inject({
        method: "POST",
        url: API_ROUTES.projects,
        payload: { name: "Integración", settings: { width: 320, height: 180, fps: 25 } },
      });
      const p = created.json<Project>();
      const [video, text, audio] = p.tracks;
      const project = {
        ...p,
        subtitles: [{ start: 0.2, end: 1.2, text: "Subtítulo" }],
        tracks: [
          {
            ...video!,
            clips: [
              {
                id: "c1",
                trackId: video!.id,
                assetId: a.id,
                start: 0,
                in: 1,
                out: 3,
                voiceEffects: [{ type: "echo", delayMs: 60, decay: 0.3 }],
              },
              {
                id: "c2",
                trackId: video!.id,
                assetId: b.id,
                start: 2,
                in: 1,
                out: 3,
                transitionIn: { type: "crossfade", durationSec: 0.5 },
              },
              {
                id: "c3",
                trackId: video!.id,
                assetId: logo.id,
                start: 4.5,
                in: 0,
                out: 1,
                transitionIn: { type: "fade", durationSec: 0.3 },
              },
            ],
          },
          {
            id: "mo",
            kind: "motion",
            name: "Motion",
            clips: [
              {
                id: "m1",
                trackId: "mo",
                start: 0.5,
                in: 0,
                out: 2,
                renderedAssetId: title.id,
                motion: { template: "title-card", durationSec: 2 },
              },
            ],
          },
          {
            ...text!,
            clips: [
              {
                id: "t1",
                trackId: text!.id,
                start: 1,
                in: 0,
                out: 1.5,
                text: "Hola: 100% 'ok'",
                textStyle: { fontSize: 24, position: "bottom" },
                transitionIn: { type: "fade", durationSec: 0.3 },
              },
            ],
          },
          {
            ...audio!,
            clips: [
              {
                id: "a1",
                trackId: audio!.id,
                assetId: music.id,
                start: 0,
                in: 0,
                out: 3,
                volume: 0.4,
              },
            ],
          },
        ],
      };
      expect(
        (
          await app.inject({
            method: "PUT",
            url: buildRoute(API_ROUTES.project, { id: p.id }),
            payload: project,
          })
        ).statusCode,
      ).toBe(200);

      const small = await app.inject({
        method: "POST",
        url: API_ROUTES.exportPresets,
        payload: {
          id: "small",
          name: "Small",
          aspect: "16:9",
          width: 320,
          height: 180,
          fps: 25,
          crf: 30,
        },
      });
      const vertical = await app.inject({
        method: "POST",
        url: API_ROUTES.exportPresets,
        payload: {
          id: "small-v",
          name: "Small 9:16",
          aspect: "9:16",
          width: 180,
          height: 320,
          fps: 25,
          crf: 30,
        },
      });
      const alpha = await app.inject({
        method: "POST",
        url: API_ROUTES.exportPresets,
        payload: {
          id: "small-alpha",
          name: "Alpha",
          aspect: "16:9",
          container: "webm",
          videoCodec: "vp9",
          audioCodec: "opus",
          alpha: true,
          width: 320,
          height: 180,
          fps: 25,
          crf: 40,
        },
      });
      const presetIds = [small, vertical, alpha].map((r) => r.json<ExportPreset>().id);

      const outputs: Record<string, string> = {};
      for (const presetId of [...presetIds, "gif-480"]) {
        const body =
          presetId === "gif-480" ? { presetId, range: { start: 1, end: 2 } } : { presetId };
        const res = await app.inject({
          method: "POST",
          url: buildRoute(API_ROUTES.projectExport, { id: p.id }),
          payload: body,
        });
        expect(res.statusCode).toBe(202);
        const job = await jobDone(res.json<{ jobId: string }>().jobId);
        outputs[presetId] = path.join(
          app.ctx.config.storageDir,
          (job.result as FileJobResult).path,
        );
      }
      const main = await ff.probe(outputs.small!);
      expect(main).toMatchObject({ width: 320, height: 180, hasAudio: true, videoCodec: "h264" });
      expect(main.durationSec).toBeCloseTo(5.5, 0);
      expect(outputs.small).toMatch(/exports[\\/]integracion-\d{8}-\d{6}\.mp4$/);
      expect(await ff.probe(outputs["small-v"]!)).toMatchObject({ width: 180, height: 320 });
      expect(await ff.probe(outputs["small-alpha"]!)).toMatchObject({
        videoCodec: "vp9",
        hasAlpha: true,
        audioCodec: "opus",
      });
      const g = await ff.probe(outputs["gif-480"]!);
      expect(g).toMatchObject({ videoCodec: "gif", width: 480 });
      expect(existsSync(path.join(app.ctx.config.storageDir, "tmp"))).toBe(true);
    });

    it("cancels a running ffmpeg process quickly", async () => {
      const ctrl = new AbortController();
      const t0 = Date.now();
      const p = runFfmpeg(
        "ffmpeg",
        ["-re", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25:duration=60", "-f", "null", "-"],
        { signal: ctrl.signal, durationSec: 60 },
      );
      setTimeout(() => ctrl.abort(), 300);
      await expect(p).rejects.toMatchObject({ name: "AbortError" });
      expect(Date.now() - t0).toBeLessThan(5000);
    });

    it("reports progress from -progress pipe:1", async () => {
      const ratios: number[] = [];
      await runFfmpeg(
        "ffmpeg",
        [
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=160x90:rate=25:duration=3",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-f",
          "mp4",
          f("prog.mp4"),
        ],
        {
          durationSec: 3,
          onProgress: (r) => ratios.push(r),
        },
      );
      expect(ratios.at(-1)).toBe(1);
    });

    it("detects hardware encoders with libx264 fallback", async () => {
      const encoders = await detectHardwareEncoders("ffmpeg", 10_000);
      expect(encoders.at(-1)).toBe("libx264");
    });
  },
);

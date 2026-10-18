import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { expect } from "vitest";
import {
  API_ROUTES,
  buildRoute,
  type ExportJobResult,
  type Job,
  type MediaAsset,
  type Project,
} from "@studio/shared";
import { makeApp, multipart, tempStorage, waitFor } from "./helpers.js";

/** Sprint 5 (M3) export integration tests: real ffmpeg, lavfi media, the api as in production. */
export const hasFfmpeg =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

export const gen = (args: string[]) =>
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);

/** Overall RMS level (dB) of the audio of `file` in [start, start+dur) after `filters`. */
export function rmsDb(file: string, start: number, dur: number, filters = "anull"): number {
  const out = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-ss",
      String(start),
      "-t",
      String(dur),
      "-i",
      file,
      "-vn",
      "-af",
      `${filters},astats=measure_perchannel=none:measure_overall=RMS_level`,
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8" },
  );
  const m = /RMS level dB:\s*(-?[\d.]+|-inf)/.exec(out.stderr);
  if (!m) throw new Error(`astats sin RMS: ${out.stderr.slice(-400)}`);
  return m[1] === "-inf" ? -Infinity : Number(m[1]);
}

export function probeVideo(file: string): { width: number; height: number; duration: number } {
  const out = execFileSync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height:format=duration",
    "-of",
    "json",
    file,
  ]).toString();
  const j = JSON.parse(out) as {
    streams: { width: number; height: number }[];
    format: { duration: string };
  };
  return {
    width: j.streams[0]!.width,
    height: j.streams[0]!.height,
    duration: Number(j.format.duration),
  };
}

export interface Harness {
  app: FastifyInstance;
  storage: string;
  dir: string;
  file: (name: string) => string;
  upload: (file: string, type: string) => Promise<MediaAsset>;
  idle: () => Promise<void>;
  save: (p: Project) => Promise<Project>;
  create: (name: string, width: number, height: number, fps?: number) => Promise<Project>;
  exportRaw: (projectId: string, body: Record<string, unknown>) => Promise<LightMyRequestResponse>;
  exportNow: (
    projectId: string,
    body: Record<string, unknown>,
  ) => Promise<{ job: Job; result: ExportJobResult; abs: string; log: string[] }>;
}

export async function harness(prefix: string, ffmpegPath = "ffmpeg"): Promise<Harness> {
  const dir = tempStorage(prefix);
  const { app, storage } = await makeApp({ FFMPEG_PATH: ffmpegPath, FFPROBE_PATH: "ffprobe" });
  const jobDone = async (id: string): Promise<Job> => {
    await waitFor(
      () => ["succeeded", "failed", "canceled"].includes(app.ctx.jobs.get(id)!.status),
      240_000,
    );
    const job = app.ctx.jobs.get(id)!;
    if (job.status === "failed")
      throw new Error(`${job.type} failed: ${job.error}\n${app.ctx.jobs.logTail(id).join("\n")}`);
    return job;
  };
  const h: Harness = {
    app,
    storage,
    dir,
    file: (n) => path.join(dir, n),
    upload: async (file, type) => {
      const { payload, headers } = await multipart(path.basename(file), readFileSync(file), type);
      const res = await app.inject({ method: "POST", url: API_ROUTES.media, payload, headers });
      expect(res.statusCode).toBe(201);
      return res.json<MediaAsset>();
    },
    idle: () =>
      waitFor(
        () =>
          app.ctx.jobs.list({ status: "running" }).length +
            app.ctx.jobs.list({ status: "queued" }).length ===
          0,
        240_000,
      ),
    save: async (p) => {
      const res = await app.inject({
        method: "PUT",
        url: buildRoute(API_ROUTES.project, { id: p.id }),
        payload: p,
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json<Project>();
    },
    create: async (name, width, height, fps = 25) => {
      const res = await app.inject({
        method: "POST",
        url: API_ROUTES.projects,
        payload: { name, settings: { width, height, fps } },
      });
      expect(res.statusCode).toBe(201);
      return res.json<Project>();
    },
    exportRaw: (projectId, body) =>
      app.inject({
        method: "POST",
        url: buildRoute(API_ROUTES.projectExport, { id: projectId }),
        payload: body,
      }),
    exportNow: async (projectId, body) => {
      const res = await h.exportRaw(projectId, body);
      expect(res.statusCode, res.body).toBe(202);
      const id = res.json<{ jobId: string }>().jobId;
      const job = await jobDone(id);
      const result = job.result as ExportJobResult;
      return { job, result, abs: path.join(storage, result.path), log: app.ctx.jobs.logTail(id) };
    },
  };
  return h;
}

/** A clip of the timeline (defaults of the api). */
export function clip(
  trackId: string,
  id: string,
  assetId: string,
  start: number,
  dur: number,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    trackId,
    assetId,
    start,
    in: 0,
    out: dur,
    speed: 1,
    volume: 1,
    opacity: 1,
    voiceEffects: [],
    ...extra,
  };
}

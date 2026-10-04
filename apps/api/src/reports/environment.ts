import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WORKER_ROUTES } from "@studio/shared";
import { REPO_ROOT, type ApiConfig } from "../config.js";
import type { JobQueue } from "../jobs/queue.js";
import type { FfmpegService } from "../services/ffmpeg.js";

/** entorno.json: everything needed to reproduce the user's setup (never secrets). */
export interface EnvironmentInfo {
  collectedAt: string;
  app: { name: string; version: string; apiVersion: string };
  git: {
    commit?: string;
    branch?: string;
    dirtyFiles?: number;
    source: "VERSION" | "git" | "desconocido";
  };
  os: {
    platform: string;
    type: string;
    release: string;
    version?: string;
    arch: string;
    cpu?: string;
    cpuCount: number;
    memoryGb: number;
    freeMemoryGb: number;
    locale?: string;
    timeZone?: string;
  };
  versions: {
    node: string;
    pnpm?: string;
    python?: string;
    ffmpeg?: string;
    ffmpegPath: string;
  };
  gpu: { name?: string; source: "nvidia-smi" | "workers" | "desconocida"; cudaInWorkers?: boolean };
  /** Same shape as GET /api/health. */
  health: {
    status: "ok" | "degraded";
    ffmpeg: { available: boolean; version?: string };
    workers: { reachable: boolean; url: string };
  };
  /** Raw GET :8001/health (torch, models, packages) or undefined when unreachable. */
  workersHealth?: unknown;
  queue: Record<string, { active: number; limit: number }>;
  /** Non-secret configuration (keys only as booleans). */
  config: Record<string, unknown>;
}

function run(
  cmd: string,
  args: string[],
  timeout = 4000,
  shell = false,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout, windowsHide: true, cwd: REPO_ROOT, shell },
      (err, stdout, stderr) => {
        if (err) return resolve(undefined);
        const text = `${stdout}`.trim() || `${stderr}`.trim();
        resolve(text || undefined);
      },
    );
  });
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** VERSION file (written by release/zip installs) or `git rev-parse`. */
async function gitInfo(): Promise<EnvironmentInfo["git"]> {
  const versionFile = path.join(REPO_ROOT, "VERSION");
  if (existsSync(versionFile)) {
    const text = readFileSync(versionFile, "utf8").trim();
    const commit = /[0-9a-f]{7,40}/i.exec(text)?.[0] ?? text.split(/\r?\n/)[0];
    return { ...(commit && { commit }), source: "VERSION" };
  }
  const [commit, branch, status] = await Promise.all([
    run("git", ["rev-parse", "HEAD"]),
    run("git", ["rev-parse", "--abbrev-ref", "HEAD"]),
    run("git", ["status", "--porcelain"]),
  ]);
  if (!commit) return { source: "desconocido" };
  return {
    commit,
    ...(branch && { branch }),
    dirtyFiles: status ? status.split(/\r?\n/).filter(Boolean).length : 0,
    source: "git",
  };
}

async function pnpmVersion(): Promise<string | undefined> {
  const ua = process.env.npm_config_user_agent ?? "";
  const m = /pnpm\/(\S+)/.exec(ua);
  if (m) return m[1];
  // pnpm is a .cmd shim on Windows: it needs a shell (fixed arguments, no user input).
  return run("pnpm", ["--version"], 5000, process.platform === "win32");
}

async function pythonVersion(): Promise<string | undefined> {
  const venv = path.join(REPO_ROOT, "apps", "workers", ".venv");
  const candidates = [path.join(venv, "Scripts", "python.exe"), path.join(venv, "bin", "python")];
  const exe = candidates.find((c) => existsSync(c));
  const out = exe
    ? await run(exe, ["--version"])
    : await run(
        process.platform === "win32" ? "py" : "python3",
        process.platform === "win32" ? ["-3.11", "--version"] : ["--version"],
      );
  return out?.replace(/^Python\s+/i, "");
}

async function nvidiaGpu(): Promise<string | undefined> {
  const out = await run("nvidia-smi", [
    "--query-gpu=name,driver_version,memory.total",
    "--format=csv,noheader",
  ]);
  return out?.split(/\r?\n/)[0];
}

async function fetchWorkersHealth(baseUrl: string): Promise<unknown> {
  try {
    const res = await fetch(new URL(WORKER_ROUTES.health, baseUrl), {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok ? ((await res.json()) as unknown) : undefined;
  } catch {
    return undefined;
  }
}

const GB = 1024 ** 3;
const round1 = (n: number) => Math.round(n * 10) / 10;

export interface EnvironmentDeps {
  config: ApiConfig;
  ffmpeg: FfmpegService;
  queue?: Pick<JobQueue, "lanes">;
}

/** Collect versions, OS, GPU and service health in parallel (each probe has a short timeout). */
export async function collectEnvironment(deps: EnvironmentDeps): Promise<EnvironmentInfo> {
  const { config, ffmpeg } = deps;
  const rootPkg = readJson(path.join(REPO_ROOT, "package.json"));
  const apiPkg = readJson(path.join(REPO_ROOT, "apps", "api", "package.json"));
  const [git, pnpm, python, ffmpegVersion, workersHealth, nvidia] = await Promise.all([
    gitInfo(),
    pnpmVersion(),
    pythonVersion(),
    ffmpeg.version().catch(() => undefined),
    fetchWorkersHealth(config.workersUrl),
    nvidiaGpu(),
  ]);
  const torchDevice = (workersHealth as { torch?: { deviceName?: string } } | undefined)?.torch
    ?.deviceName;
  const cpus = os.cpus();
  const intl = Intl.DateTimeFormat().resolvedOptions();
  return {
    collectedAt: new Date().toISOString(),
    app: {
      name: typeof rootPkg?.name === "string" ? rootPkg.name : "studio",
      version: typeof rootPkg?.version === "string" ? rootPkg.version : "desconocida",
      apiVersion: typeof apiPkg?.version === "string" ? apiPkg.version : "desconocida",
    },
    git,
    os: {
      platform: process.platform,
      type: os.type(),
      release: os.release(),
      ...(typeof os.version === "function" && { version: os.version() }),
      arch: process.arch,
      ...(cpus[0] && { cpu: cpus[0].model.trim() }),
      cpuCount: cpus.length,
      memoryGb: round1(os.totalmem() / GB),
      freeMemoryGb: round1(os.freemem() / GB),
      locale: intl.locale,
      timeZone: intl.timeZone,
    },
    versions: {
      node: process.version,
      ...(pnpm && { pnpm }),
      ...(python && { python }),
      ...(ffmpegVersion && { ffmpeg: ffmpegVersion }),
      ffmpegPath: config.ffmpegPath,
    },
    gpu: nvidia
      ? { name: nvidia, source: "nvidia-smi", cudaInWorkers: Boolean(config.useCuda) }
      : torchDevice
        ? { name: torchDevice, source: "workers", cudaInWorkers: Boolean(config.useCuda) }
        : { source: "desconocida", cudaInWorkers: Boolean(config.useCuda) },
    health: {
      status: ffmpegVersion && workersHealth ? "ok" : "degraded",
      ffmpeg: {
        available: Boolean(ffmpegVersion),
        ...(ffmpegVersion && { version: ffmpegVersion }),
      },
      workers: { reachable: Boolean(workersHealth), url: config.workersUrl },
    },
    ...(workersHealth !== undefined && { workersHealth }),
    queue: deps.queue?.lanes() ?? {},
    config: {
      apiPort: config.port,
      apiHost: config.host,
      webOrigin: config.webOrigin,
      workersUrl: config.workersUrl,
      storageDir: config.storageDir,
      modelsDir: config.modelsDir,
      ffmpegPath: config.ffmpegPath,
      ffprobePath: config.ffprobePath,
      useCuda: config.useCuda,
      hwEncoder: config.hwEncoder,
      queue: config.queue,
      remotion: config.remotion,
      logLevel: config.logLevel,
      providers: Object.fromEntries(Object.entries(config.keys).map(([k, v]) => [k, Boolean(v)])),
    },
  };
}

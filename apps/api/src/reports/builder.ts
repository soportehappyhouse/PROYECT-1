import { existsSync } from "node:fs";
import { copyFile, mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FileJobResultSchema,
  LOGS_SUBDIR,
  ProjectSchema,
  REPORTS_SUBDIR,
  ReportSeveritySchema,
  type CreateReportRequest,
  type CreateReportResponse,
  type Job,
  type MediaAsset,
  type Project,
  type ReportSummary,
} from "@studio/shared";
import { REPO_ROOT, type ApiConfig } from "../config.js";
import type { JobStore } from "../jobs/types.js";
import { redactText, redactValue, type RedactOptions } from "../lib/redact.js";
import { zipDirectory } from "../lib/zip.js";
import type { Repos } from "../repos/index.js";
import type { EnvironmentInfo } from "./environment.js";
import { buildMarkdown, buildPrompt, type ReportDocument } from "./markdown.js";

/** Folder/zip name: yyyyMMdd-HHmmss-<slug> (local time). */
export const REPORT_ID_PATTERN = /^\d{8}-\d{6}-[a-z0-9-]{1,60}$/;

const LOG_TAIL_LINES = 500;
const MAX_LOG_FILES = 10;
const LOG_MAX_AGE_MS = 3 * 24 * 3600 * 1000;
const AUTO_FAILED_JOBS = 5;
const MEDIA_FILE_LIMIT = 25 * 1024 * 1024;
const MEDIA_TOTAL_LIMIT = 100 * 1024 * 1024;

export interface ReportBuilderDeps {
  config: ApiConfig;
  jobs: JobStore;
  repos: Pick<Repos, "projects" | "media">;
  /** Versions/OS/GPU/health (environment.ts; replaced in tests). */
  collectEnvironment: () => Promise<EnvironmentInfo>;
  now?: () => Date;
}

/** ASCII slug for folder names ("¿Exportar falla?" -> "exportar-falla"). */
export function slugify(text: string, max = 40): string {
  const slug = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "reporte";
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function reportsDir(storageDir: string): string {
  return path.join(storageDir, REPORTS_SUBDIR);
}

/** Absolute zip path of a report id, or undefined when the id is malformed. */
export function reportZipPath(storageDir: string, id: string): string | undefined {
  if (!REPORT_ID_PATTERN.test(id)) return undefined;
  return path.join(reportsDir(storageDir), `${id}.zip`);
}

/** Last `lines` lines of a text file (reads at most the final 2 MB). */
export async function tailFile(file: string, lines: number): Promise<string[]> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, 2 * 1024 * 1024);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, size - length);
    const all = buf.toString("utf8").split(/\r?\n/);
    if (length < size) all.shift(); // partial first line
    while (all.length && !all[all.length - 1]) all.pop();
    return all.slice(-lines);
  } finally {
    await handle.close();
  }
}

/** Display a path relative to the repo when possible ("storage/reports/x"), else absolute. */
function displayPath(abs: string): string {
  const rel = path.relative(REPO_ROOT, abs);
  return !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : abs;
}

function projectStats(p: Project): ReportDocument["project"] {
  let clips = 0;
  let duration = 0;
  for (const t of p.tracks) {
    for (const c of t.clips) {
      clips++;
      const end = c.start + (c.out - c.in) / (c.speed || 1);
      duration = Math.max(duration, end);
    }
  }
  return { id: p.id, name: p.name, tracks: p.tracks.length, clips, durationSec: duration };
}

/** Turn any absolute path inside STORAGE_DIR into a relative one; other absolute paths -> basename. */
function relativizePaths<T>(value: T, storageDir: string): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string" && path.isAbsolute(v) && v.length < 1000) {
      const rel = path.relative(storageDir, v);
      return !rel.startsWith("..") && !path.isAbsolute(rel)
        ? rel.split(path.sep).join("/")
        : `<fuera de storage>/${path.basename(v)}`;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, walk(val)]));
    return v;
  };
  return walk(value) as T;
}

/**
 * Build storage/reports/<id>/ (reporte.md, reporte.json, entorno.json, proyecto.json, jobs/,
 * logs/, medios/ when includeMedia) and zip it to storage/reports/<id>.zip. Every text written
 * goes through the redactor (API keys from .env, token-shaped strings, the user's home folder).
 */
export async function buildReport(
  deps: ReportBuilderDeps,
  req: CreateReportRequest,
): Promise<CreateReportResponse> {
  const { config } = deps;
  const now = deps.now?.() ?? new Date();
  const root = reportsDir(config.storageDir);
  await mkdir(root, { recursive: true });

  const base = `${stamp(now)}-${slugify(req.title)}`;
  let id = base;
  for (let n = 2; existsSync(path.join(root, id)) || existsSync(path.join(root, `${id}.zip`)); n++)
    id = `${base}-${n}`;
  const dir = path.join(root, id);
  await mkdir(dir, { recursive: true });

  const redact: RedactOptions = { secrets: Object.values(config.keys), homeDir: os.homedir() };
  const files: string[] = [];
  const writeText = async (rel: string, text: string) => {
    const abs = path.join(dir, ...rel.split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, redactText(text, redact), "utf8");
    files.push(rel);
  };
  const writeJson = (rel: string, value: unknown) =>
    writeText(rel, `${JSON.stringify(redactValue(value, redact), null, 2)}\n`);

  // ---------------------------------------------------------------- environment
  const env = await deps.collectEnvironment();
  await writeJson("entorno.json", env);

  // ---------------------------------------------------------------- jobs
  const wanted = new Set(req.jobIds);
  if (wanted.size === 0) {
    const dayAgo = now.getTime() - 24 * 3600 * 1000;
    for (const j of deps.jobs.list({ status: "failed", limit: AUTO_FAILED_JOBS }))
      if (Date.parse(j.createdAt) >= dayAgo) wanted.add(j.id);
  }
  const jobEntries: ReportDocument["jobs"] = [];
  for (const jobId of wanted) {
    const job = deps.jobs.get(jobId);
    if (!job) continue;
    const diagnostics = deps.jobs.diagnostics(job.id);
    const logTail = deps.jobs.logTail(job.id);
    const entry = {
      job: relativizePaths(job, config.storageDir),
      logTail,
      ...(diagnostics && { diagnostics }),
    };
    jobEntries.push(entry);
    await writeJson(`jobs/${job.id}.json`, entry);
  }
  const recent = deps.jobs.list({ limit: 20 }).map((j: Job) => ({
    id: j.id,
    type: j.type,
    status: j.status,
    createdAt: j.createdAt,
    ...(j.startedAt && { startedAt: j.startedAt }),
    ...(j.finishedAt && { finishedAt: j.finishedAt }),
    ...(j.error && { error: j.error }),
  }));
  await writeJson("jobs/recientes.json", recent);

  // ---------------------------------------------------------------- logs
  const logErrors: string[] = [];
  const logsDir = path.join(config.storageDir, LOGS_SUBDIR);
  if (existsSync(logsDir)) {
    const candidates: { name: string; mtime: number }[] = [];
    for (const name of await readdir(logsDir)) {
      if (!name.endsWith(".log")) continue;
      const info = await stat(path.join(logsDir, name)).catch(() => undefined);
      if (info?.isFile() && info.size > 0 && now.getTime() - info.mtimeMs < LOG_MAX_AGE_MS)
        candidates.push({ name, mtime: info.mtimeMs });
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    for (const { name } of candidates.slice(0, MAX_LOG_FILES)) {
      const lines = await tailFile(path.join(logsDir, name), LOG_TAIL_LINES).catch(() => []);
      await writeText(`logs/${name}`, `${lines.join("\n")}\n`);
      if (/^api-/.test(name))
        for (const l of lines)
          if (/"level":\s*(50|60)\b/.test(l)) logErrors.push(redactText(l, redact));
    }
  }

  // ---------------------------------------------------------------- project
  let project: Project | undefined;
  let projectSource: "navegador" | "guardado" | undefined;
  let rawProject: unknown;
  if (req.project !== undefined) {
    const parsed = ProjectSchema.safeParse(req.project);
    if (parsed.success) project = parsed.data;
    else rawProject = req.project;
    projectSource = "navegador";
  }
  if (!project && !rawProject && req.projectId) {
    project = deps.repos.projects.get(req.projectId);
    if (project) projectSource = "guardado";
  }
  const assets: MediaAsset[] = [];
  if (project) {
    const ids = new Set<string>();
    for (const t of project.tracks)
      for (const c of t.clips) {
        if (c.assetId) ids.add(c.assetId);
        if (c.renderedAssetId) ids.add(c.renderedAssetId);
      }
    for (const assetId of ids) {
      const a = deps.repos.media.get(assetId);
      if (a) assets.push(a);
    }
  }
  if (project || rawProject !== undefined)
    await writeJson(
      "proyecto.json",
      relativizePaths(
        {
          source: projectSource,
          ...(project ? { project } : { projectInvalido: rawProject }),
          assets,
        },
        config.storageDir,
      ),
    );

  // ---------------------------------------------------------------- media (opt-in)
  if (req.includeMedia) {
    let total = 0;
    const copySmall = async (relative: string | undefined) => {
      if (!relative || path.isAbsolute(relative) || relative.includes("..")) return;
      const abs = path.join(config.storageDir, relative);
      const info = await stat(abs).catch(() => undefined);
      if (!info?.isFile() || info.size > MEDIA_FILE_LIMIT || total + info.size > MEDIA_TOTAL_LIMIT)
        return;
      const rel = `medios/${relative.replace(/\\/g, "/")}`;
      if (files.includes(rel)) return;
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await copyFile(abs, path.join(dir, rel));
      total += info.size;
      files.push(rel);
    };
    for (const a of assets) await copySmall(a.thumbnailPath);
    for (const a of assets) await copySmall(a.path);
    for (const e of jobEntries) {
      const out = FileJobResultSchema.safeParse(e.job.result);
      if (out.success) await copySmall(out.data.path);
    }
  }

  // ---------------------------------------------------------------- reporte.json + reporte.md
  const createdAt = now.toISOString();
  const relativeDir = `${REPORTS_SUBDIR}/${id}`;
  const folderLabel = displayPath(dir);
  const zipAbs = path.join(root, `${id}.zip`);
  const zipLabel = displayPath(zipAbs);
  const listed = [...files, "reporte.json", "reporte.md"].sort();
  const doc: ReportDocument = {
    id,
    title: req.title,
    severity: req.severity,
    createdAt,
    steps: req.steps,
    folderLabel,
    zipLabel,
    env,
    ...(project && { project: projectStats(project) }),
    jobs: jobEntries,
    breadcrumbs: req.uiBreadcrumbs,
    ...(req.clientError && { clientError: req.clientError }),
    logErrors: logErrors.slice(-20),
    includeMedia: req.includeMedia,
    files: listed,
  };
  const prompt = redactText(buildPrompt(doc), redact);
  const markdown = redactText(buildMarkdown(doc, prompt), redact);
  await writeJson("reporte.json", {
    schemaVersion: 1,
    id,
    title: req.title,
    severity: ReportSeveritySchema.parse(req.severity),
    createdAt,
    steps: req.steps,
    includeMedia: req.includeMedia,
    projectId: project?.id ?? req.projectId,
    jobIds: jobEntries.map((e) => e.job.id),
    environment: {
      app: env.app,
      git: env.git,
      os: `${env.os.type} ${env.os.release} ${env.os.arch}`,
      versions: env.versions,
      gpu: env.gpu,
      health: env.health,
    },
    ui: {
      breadcrumbs: req.uiBreadcrumbs,
      state: req.uiState ?? {},
      ...(req.clientError && { clientError: req.clientError }),
    },
    jobs: jobEntries.map((e) => ({
      id: e.job.id,
      type: e.job.type,
      status: e.job.status,
      error: e.job.error,
      commands: e.diagnostics?.commands.map((c) => c.command) ?? [],
      stderrTail: (e.diagnostics?.stderrTail ?? e.logTail).slice(-40),
    })),
    logErrors: doc.logErrors,
    files: listed,
    prompt,
  });
  await writeText("reporte.md", markdown);

  const zipBytes = await zipDirectory(dir, zipAbs, id);
  return {
    id,
    title: req.title,
    severity: req.severity,
    createdAt,
    dir,
    zipPath: zipAbs,
    relativeDir,
    zipBytes,
    markdown,
    prompt,
    files: listed,
  };
}

/** Reports found under storage/reports (newest first). */
export async function listReports(storageDir: string): Promise<ReportSummary[]> {
  const root = reportsDir(storageDir);
  if (!existsSync(root)) return [];
  const out: ReportSummary[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !REPORT_ID_PATTERN.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    let meta: { title?: unknown; severity?: unknown; createdAt?: unknown } = {};
    try {
      meta = JSON.parse(await readFile(path.join(dir, "reporte.json"), "utf8")) as typeof meta;
    } catch {
      continue;
    }
    const zipPath = path.join(root, `${entry.name}.zip`);
    const zipInfo = await stat(zipPath).catch(() => undefined);
    const severity = ReportSeveritySchema.safeParse(meta.severity);
    out.push({
      id: entry.name,
      title: typeof meta.title === "string" ? meta.title : entry.name,
      severity: severity.success ? severity.data : "medium",
      createdAt: typeof meta.createdAt === "string" ? meta.createdAt : new Date(0).toISOString(),
      dir,
      zipPath,
      relativeDir: `${REPORTS_SUBDIR}/${entry.name}`,
      zipBytes: zipInfo?.size ?? 0,
    });
  }
  return out.sort((a, b) => b.id.localeCompare(a.id));
}

import {
  REPORT_SEVERITY_LABELS,
  type ClientError,
  type Job,
  type JobDiagnostics,
  type ReportSeverity,
  type UiBreadcrumb,
} from "@studio/shared";
import type { EnvironmentInfo } from "./environment.js";

/** Everything reporte.md / the "Prompt para Claude" block are rendered from. */
export interface ReportDocument {
  id: string;
  title: string;
  severity: ReportSeverity;
  createdAt: string;
  steps: string;
  /** Relative to the repo root when STORAGE_DIR is the default (e.g. storage/reports/<id>). */
  folderLabel: string;
  zipLabel: string;
  env: EnvironmentInfo;
  project?: { id: string; name: string; tracks: number; clips: number; durationSec: number };
  jobs: { job: Job; diagnostics?: JobDiagnostics; logTail: string[] }[];
  breadcrumbs: UiBreadcrumb[];
  clientError?: ClientError;
  /** error/fatal lines found in the api log tail. */
  logErrors: string[];
  includeMedia: boolean;
  /** Files of the folder (relative, posix), including reporte.md/json. */
  files: string[];
}

export const JOB_TYPE_LABELS_ES: Record<Job["type"], string> = {
  "media.probe": "Analizar medio",
  "media.proxy": "Generar proxy",
  "motion.render": "Render motion",
  "voice.tts": "Texto a voz",
  "voice.effect": "Efecto de voz",
  "voice.rvc": "Conversión RVC",
  "subtitles.transcribe": "Transcripción",
  "project.export": "Exportación",
  "packs.download": "Descarga de paquete IA",
  "analyze.scenes": "Detección de escenas",
  "analyze.silences": "Análisis de silencios",
  "timeline.apply-cuts": "Aplicar cortes",
  "audio.denoise": "Limpieza de voz",
  "perf.run": "Test de rendimiento IA",
};

const PROMPT_JOBS = 3;
const PROMPT_STDERR_LINES = 25;
const PROMPT_BREADCRUMBS = 15;

function fmtDuration(ms: number | undefined): string {
  if (ms === undefined) return "?";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  return s < 120 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  // Local time of the PC (the api runs on the user's machine).
  return Number.isNaN(d.getTime()) ? iso : d.toTimeString().slice(0, 8);
}

function fmtSeconds(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** One-line environment summary used by the prompt and the markdown. */
export function environmentLines(env: EnvironmentInfo): string[] {
  const v = env.versions;
  const git = env.git.commit
    ? `commit ${env.git.commit.slice(0, 12)}${env.git.branch ? ` (rama ${env.git.branch})` : ""}${
        env.git.dirtyFiles ? `, ${env.git.dirtyFiles} archivos modificados` : ""
      }`
    : "commit desconocido";
  return [
    `Studio ${env.app.version}, ${git}`,
    `Sistema: ${env.os.platform === "win32" && env.os.version ? env.os.version : env.os.type} ${env.os.release} ${env.os.arch}, ${env.os.cpuCount} CPU (${env.os.cpu ?? "?"}), ${env.os.memoryGb} GB RAM`,
    `Node ${v.node} · pnpm ${v.pnpm ?? "?"} · Python ${v.python ?? "?"} · FFmpeg ${
      v.ffmpeg ? v.ffmpeg.replace(/^ffmpeg version\s+/i, "").split(" ")[0] : "NO DISPONIBLE"
    }`,
    `GPU: ${env.gpu.name ?? "desconocida"} (USE_CUDA=${env.gpu.cudaInWorkers ? "true" : "false"})`,
    `Servicios: api ok · workers ${env.health.workers.reachable ? "ok" : "NO responden"} (${env.health.workers.url}) · ffmpeg ${env.health.ffmpeg.available ? "ok" : "NO encontrado"}`,
  ];
}

function jobHeadline(entry: ReportDocument["jobs"][number]): string {
  const { job, diagnostics } = entry;
  const label = JOB_TYPE_LABELS_ES[job.type] ?? job.type;
  const took = fmtDuration(diagnostics?.timings.runMs);
  return `Trabajo ${job.id} (${label}, ${job.type}) → ${job.status}${
    job.status === "failed" ? ` tras ${took}` : ""
  }: ${(job.error ?? job.message ?? "sin mensaje").split(/\r?\n/)[0]}`;
}

function lastCommand(d: JobDiagnostics | undefined): string | undefined {
  if (!d?.commands.length) return undefined;
  const failed = [...d.commands].reverse().find((c) => c.exitCode !== 0 && c.exitCode !== 200);
  const c = failed ?? d.commands[d.commands.length - 1]!;
  return `${c.command}${c.exitCode !== undefined ? `   # salida: ${c.exitCode ?? "no arrancó"}` : ""}`;
}

/** Ready-to-paste block: contexto → pasos → error → archivos adjuntos. */
export function buildPrompt(doc: ReportDocument): string {
  const out: string[] = [];
  out.push(
    `Hola Claude. Encontré un error en Studio (este repo). Reproducilo con los datos de abajo, encontrá la causa y arreglalo con un test que lo cubra.`,
    "",
    "## Contexto",
    `- Reporte: ${doc.id} — «${doc.title}»`,
    `- Severidad: ${REPORT_SEVERITY_LABELS[doc.severity]}`,
    `- Fecha: ${doc.createdAt}`,
    ...environmentLines(doc.env).map((l) => `- ${l}`),
  );
  if (doc.project)
    out.push(
      `- Proyecto: «${doc.project.name}» (${doc.project.id}): ${doc.project.tracks} pistas, ${doc.project.clips} clips, duración ${fmtSeconds(doc.project.durationSec)}`,
    );
  out.push("", "## Pasos (lo que hacía el usuario)", doc.steps.trim() || "(no los escribió)");

  out.push("", "## Error");
  let anyError = false;
  for (const entry of doc.jobs.slice(0, PROMPT_JOBS)) {
    anyError = true;
    out.push(`- ${jobHeadline(entry)}`);
    const cmd = lastCommand(entry.diagnostics);
    if (cmd) out.push(`  Comando: \`${cmd.length > 1500 ? `${cmd.slice(0, 1500)}…` : cmd}\``);
    const stderr = (
      entry.diagnostics?.stderrTail.length ? entry.diagnostics.stderrTail : entry.logTail
    ).slice(-PROMPT_STDERR_LINES);
    if (stderr.length)
      out.push("  Últimas líneas de stderr/log:", "  ```", ...stderr.map((l) => `  ${l}`), "  ```");
  }
  if (doc.jobs.length > PROMPT_JOBS)
    out.push(`- (+${doc.jobs.length - PROMPT_JOBS} trabajos más en jobs/)`);
  if (doc.clientError) {
    anyError = true;
    out.push(`- Error en el navegador: ${doc.clientError.message}`);
    const stack = (doc.clientError.stack ?? "").split("\n").slice(0, 12);
    if (stack.length && stack[0]) out.push("  ```", ...stack.map((l) => `  ${l}`), "  ```");
  }
  const uiErrors = doc.breadcrumbs.filter((b) => b.category === "error" || b.category === "api");
  for (const b of uiErrors.slice(-5)) {
    anyError = true;
    out.push(`- ${fmtTime(b.at)} [${b.category}] ${b.message}`);
  }
  for (const l of doc.logErrors.slice(-5)) {
    anyError = true;
    out.push(`- log api: ${l.length > 400 ? `${l.slice(0, 400)}…` : l}`);
  }
  if (!anyError) out.push("- No se registró un error técnico: ver pasos y últimas acciones.");

  if (doc.breadcrumbs.length) {
    out.push(
      "",
      `## Últimas acciones en la interfaz (${Math.min(PROMPT_BREADCRUMBS, doc.breadcrumbs.length)} de ${doc.breadcrumbs.length})`,
    );
    for (const b of doc.breadcrumbs.slice(-PROMPT_BREADCRUMBS))
      out.push(`- ${fmtTime(b.at)} [${b.category}] ${b.message}`);
  }

  out.push(
    "",
    "## Archivos adjuntos",
    `- Carpeta: ${doc.folderLabel}/  (zip: ${doc.zipLabel})`,
    ...doc.files.map((f) => `  - ${f}`),
    "- Empezá por reporte.json y jobs/*.json (comando completo + stderr); entorno.json tiene las versiones; logs/ las últimas 500 líneas de cada log.",
    "- Si no podés leer esa carpeta, pedime que adjunte el .zip.",
  );
  return out.join("\n");
}

/** Full reporte.md (Spanish). The prompt goes first so a non-developer only copies that block. */
export function buildMarkdown(doc: ReportDocument, prompt: string): string {
  const out: string[] = [];
  out.push(
    `# Reporte de error — ${doc.title}`,
    "",
    `- **Id:** \`${doc.id}\``,
    `- **Fecha:** ${doc.createdAt}`,
    `- **Severidad:** ${REPORT_SEVERITY_LABELS[doc.severity]}`,
    `- **Carpeta:** \`${doc.folderLabel}\` · **Zip:** \`${doc.zipLabel}\``,
    "",
    "## Prompt para Claude",
    "",
    "Copiá el bloque completo y pegalo en la sesión de Claude Code de este repo (si la sesión no ve tu disco, adjuntá también el .zip).",
    "",
    "````text",
    prompt,
    "````",
    "",
    "## Qué intentaba hacer",
    "",
    doc.steps.trim() || "_(sin pasos)_",
    "",
    "## Entorno",
    "",
    ...environmentLines(doc.env).map((l) => `- ${l}`),
    "",
    "Detalle completo en `entorno.json`.",
    "",
    "## Trabajos",
    "",
  );
  if (!doc.jobs.length) out.push("_(ningún trabajo adjunto)_", "");
  for (const entry of doc.jobs) {
    const { job, diagnostics } = entry;
    out.push(`### ${JOB_TYPE_LABELS_ES[job.type] ?? job.type} — \`${job.id}\` (${job.status})`, "");
    out.push(
      `- Creado ${job.createdAt}; en cola ${fmtDuration(diagnostics?.timings.queuedMs)}; ejecución ${fmtDuration(diagnostics?.timings.runMs)}`,
    );
    if (job.error) out.push(`- **Error:** ${job.error}`);
    out.push("", "Comandos:", "");
    if (diagnostics?.commands.length) {
      for (const c of diagnostics.commands)
        out.push(
          "```",
          c.command,
          "```",
          `salida: ${c.exitCode === undefined ? "en curso" : (c.exitCode ?? "no arrancó")} · ${fmtDuration(c.durationMs)}${c.error ? ` · ${c.error}` : ""}`,
          "",
        );
    } else out.push("_(sin comandos registrados)_", "");
    const tail = diagnostics?.stderrTail.length ? diagnostics.stderrTail : entry.logTail;
    if (tail.length)
      out.push(`stderr / log (últimas ${tail.length} líneas):`, "", "```", ...tail, "```", "");
  }
  if (doc.clientError) {
    out.push("## Error en el navegador", "", doc.clientError.message, "");
    if (doc.clientError.stack) out.push("```", doc.clientError.stack, "```", "");
    if (doc.clientError.componentStack)
      out.push("Componentes:", "", "```", doc.clientError.componentStack.trim(), "```", "");
  }
  out.push("## Últimas acciones en la interfaz", "");
  if (!doc.breadcrumbs.length) out.push("_(sin acciones registradas)_");
  doc.breadcrumbs.forEach((b, i) =>
    out.push(`${i + 1}. \`${fmtTime(b.at)}\` **${b.category}** — ${b.message}`),
  );
  out.push("", "## Errores en el log de la api", "");
  if (!doc.logErrors.length) out.push("_(ninguno en las últimas líneas)_");
  for (const l of doc.logErrors) out.push(`- \`${l.length > 600 ? `${l.slice(0, 600)}…` : l}\``);
  out.push(
    "",
    "## Contenido de la carpeta",
    "",
    ...doc.files.map((f) => `- \`${f}\``),
    "",
    "## Privacidad",
    "",
    "Las claves y tokens se reemplazaron por `[REDACTED]` y tu carpeta de usuario por `~`. " +
      (doc.includeMedia
        ? "Este reporte **incluye medios pequeños** (miniaturas y archivos de hasta 25 MB) en `medios/`: revisalos antes de compartir."
        : "No incluye tus videos ni audios (solo nombres, rutas relativas y metadatos)."),
    "",
  );
  return out.join("\n");
}

import { ALWAYS_CONFIRM_OPS, type Job } from "@studio/shared";
import type {
  AgentApplyRequest,
  AgentApplyResult,
  AgentEvalModelResult,
  AgentTime,
  ClipRef,
  EditOp,
  EditOpName,
} from "./agent-types";

type EditOpKind = EditOpName;

/** Read any argument of an op (the union is strict per kind). */
export function opArg(op: EditOp, key: string): unknown {
  return (op as unknown as Record<string, unknown>)[key];
}

/** Spanish name of each operation (checklist title). */
export const OP_LABELS: Record<EditOpKind, string> = {
  cut_silences: "Cortar silencios",
  detect_scenes: "Detectar escenas",
  split: "Dividir clip",
  trim: "Recortar clip",
  delete_clip: "Eliminar clip",
  set_speed: "Cambiar velocidad",
  add_text: "Agregar texto",
  add_motion: "Agregar motion graphic",
  add_captions: "Agregar subtítulos",
  transcribe: "Transcribir",
  tts: "Texto a voz",
  voice_effect: "Efecto de voz",
  denoise: "Limpiar voz",
  add_audio: "Agregar audio",
  remove_background: "Quitar fondo",
  reframe: "Reencuadrar",
  set_canvas: "Cambiar lienzo",
  set_publish: "Revisión para redes",
  export: "Exportar",
  report_bug: "Reportar error",
};

export function opLabel(op: Pick<EditOp, "op">): string {
  return (OP_LABELS as Record<string, string>)[op.op] ?? op.op;
}

/** Ops the contract always asks to confirm (destructive or that write a file). */
export const ALWAYS_CONFIRM: ReadonlySet<EditOpKind> = new Set(ALWAYS_CONFIRM_OPS);

/** Ops that run a local AI model (may need a pack download, use the GPU). */
const AI_OPS: ReadonlySet<EditOpKind> = new Set([
  "cut_silences",
  "detect_scenes",
  "add_captions",
  "transcribe",
  "tts",
  "voice_effect",
  "denoise",
  "remove_background",
  "reframe",
]);

export interface OpRisk {
  label: string;
  tone: "danger" | "warning";
}

/** Badges of one op: red for destructive/irreversible, amber for slow AI jobs. */
export function opRisks(op: EditOp): OpRisk[] {
  const out: OpRisk[] = [];
  if (op.op === "delete_clip") out.push({ label: "Borra un clip", tone: "danger" });
  if (op.op === "export") out.push({ label: "Escribe un archivo", tone: "danger" });
  if (op.op === "trim" || op.op === "cut_silences")
    out.push({ label: "Quita partes del video", tone: "warning" });
  if (AI_OPS.has(op.op)) out.push({ label: "IA local (puede tardar)", tone: "warning" });
  return out;
}

/** Default true; delete/export always need the check. */
export function needsConfirm(op: EditOp): boolean {
  return ALWAYS_CONFIRM.has(op.op) || op.confirm !== false;
}

// --------------------------------------------------------------------------------------------
// Time / clip refs

const TIME_WORDS: Record<string, AgentTime> = {
  inicio: "start",
  start: "start",
  principio: "start",
  fin: "end",
  final: "end",
  end: "end",
  cursor: "cursor",
};

const TIME_LABELS: Record<string, string> = { start: "inicio", end: "final", cursor: "cursor" };

/** "3,5 s" / "inicio" / "escena 2" / "después de «Intro»". */
export function formatAgentTime(t: unknown): string {
  if (typeof t === "number") return `${String(Math.round(t * 100) / 100).replace(".", ",")} s`;
  if (typeof t === "string") return TIME_LABELS[t] ?? t;
  if (t && typeof t === "object") {
    if ("scene" in t) return `escena ${String((t as { scene: unknown }).scene)}`;
    if ("after_clip" in t)
      return `después de ${formatClipRef((t as { after_clip: ClipRef }).after_clip)}`;
  }
  return "—";
}

/** Text the inline editor shows for a time ("3,5", "inicio"); undefined when not editable. */
export function timeInputValue(t: unknown): string | undefined {
  if (t === undefined) return "";
  if (typeof t === "number") return String(t).replace(".", ",");
  if (typeof t === "string") return TIME_LABELS[t] ?? t;
  return undefined;
}

/** Parse what the user typed in a time field: "3", "3,5", "2.25 s", "inicio", "cursor". */
export function parseAgentTime(text: string): AgentTime | undefined {
  const clean = text.trim().toLowerCase();
  if (!clean) return undefined;
  if (clean in TIME_WORDS) return TIME_WORDS[clean];
  const n = Number(clean.replace(/\s*s(eg)?$/, "").replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function formatClipRef(ref: unknown): string {
  if (!ref || typeof ref !== "object") return "el clip elegido";
  const r = ref as ClipRef;
  if (r.name) return `«${r.name}»`;
  if (r.index !== undefined) {
    // 1 = first, -1 = last (shared ClipRef).
    const which =
      r.index === -1
        ? "último clip"
        : r.index < 0
          ? `${-r.index}.º clip desde el final`
          : `clip ${r.index}`;
    return `${which}${r.track ? ` (${r.track})` : ""}`;
  }
  if (r.at !== undefined) return `clip en ${formatAgentTime(r.at)}`;
  if (r.id) return `clip ${r.id}`;
  return "el clip elegido";
}

// --------------------------------------------------------------------------------------------
// Inline-editable parameters

export type ParamKind = "text" | "number" | "time" | "select" | "checkbox";

export interface ParamSpec {
  key: string;
  label: string;
  kind: ParamKind;
  options?: readonly { value: string; label: string }[];
  /** Free text with suggestions (datalist): export presets, motion templates. */
  suggestions?: "export-presets" | "motion-templates";
  step?: number;
  min?: number;
}

const CANVAS_OPTIONS = [
  { value: "16:9", label: "16:9 (horizontal)" },
  { value: "9:16", label: "9:16 (vertical)" },
  { value: "1:1", label: "1:1 (cuadrado)" },
] as const;

const REFRAME_OPTIONS = [
  { value: "9:16", label: "9:16" },
  { value: "1:1", label: "1:1" },
  { value: "4:5", label: "4:5" },
] as const;

const P = {
  text: { key: "text", label: "Texto", kind: "text" },
  t: { key: "t", label: "En", kind: "time" },
  duration: { key: "duration_s", label: "Duración (s)", kind: "number", step: 0.5, min: 0.1 },
  template: {
    key: "template",
    label: "Plantilla",
    kind: "text",
    suggestions: "motion-templates",
  },
  preset: { key: "preset", label: "Preset", kind: "text", suggestions: "export-presets" },
  captionStyle: { key: "style", label: "Estilo", kind: "select" },
  textStyle: { key: "style", label: "Estilo", kind: "text" },
} satisfies Record<string, ParamSpec>;

/** Key params editable inline, per op kind (only scalars: refs/objects stay read-only). */
const OP_PARAMS: Partial<Record<EditOpKind, readonly ParamSpec[]>> = {
  add_text: [P.text, P.t, P.duration, P.textStyle],
  add_motion: [P.template, P.t, P.duration],
  add_captions: [P.captionStyle, { key: "animated", label: "Animados", kind: "checkbox" }],
  tts: [P.text, P.t],
  split: [P.t],
  trim: [
    { key: "in", label: "Desde", kind: "time" },
    { key: "out", label: "Hasta", kind: "time" },
  ],
  set_speed: [{ key: "speed", label: "Velocidad", kind: "number", step: 0.25, min: 0.1 }],
  cut_silences: [
    { key: "min_silence_ms", label: "Silencio mínimo (ms)", kind: "number", step: 50, min: 100 },
  ],
  add_audio: [
    { key: "query", label: "Buscar", kind: "text" },
    P.t,
    { key: "volume_db", label: "Volumen (dB)", kind: "number", step: 1 },
  ],
  set_canvas: [{ key: "preset", label: "Lienzo", kind: "select", options: CANVAS_OPTIONS }],
  reframe: [{ key: "target", label: "Formato", kind: "select", options: REFRAME_OPTIONS }],
  export: [P.preset, { key: "name", label: "Nombre", kind: "text" }],
  report_bug: [{ key: "title", label: "Título", kind: "text" }],
};

/** Editable params of an op; a param whose current value is not a scalar is left out. */
export function editableParams(op: EditOp): ParamSpec[] {
  return (OP_PARAMS[op.op] ?? []).filter((spec) => {
    const v = opArg(op, spec.key);
    if (v === undefined || v === null) return true;
    if (spec.kind === "time") return timeInputValue(v) !== undefined;
    if (spec.kind === "checkbox") return typeof v === "boolean";
    return typeof v === "string" || typeof v === "number";
  });
}

/** Immutable param edit; `undefined` removes the key (the api applies its default). */
export function setOpParam(op: EditOp, key: string, value: unknown): EditOp {
  const next = { ...op } as unknown as Record<string, unknown>;
  if (value === undefined || value === "") delete next[key];
  else next[key] = value;
  return next as unknown as EditOp;
}

/** Short Spanish preview when the api sent none: "Agregar texto «Hola» en 3 s". */
export function fallbackPreview(op: EditOp): string {
  const a = (k: string) => opArg(op, k);
  const parts = [opLabel(op)];
  for (const k of ["text", "template"]) {
    const v = a(k);
    if (typeof v === "string") parts.push(`«${v}»`);
  }
  for (const k of ["preset", "target"]) {
    const v = a(k);
    if (typeof v === "string") parts.push(v);
  }
  if (a("clip") !== undefined) parts.push(`de ${formatClipRef(a("clip"))}`);
  if (a("t") !== undefined) parts.push(`en ${formatAgentTime(a("t"))}`);
  return parts.join(" ");
}

// --------------------------------------------------------------------------------------------
// Apply payload, questions

/**
 * POST /api/agent/apply body: the indexes of the checked ops and, when the user edited params
 * inline, the edited ops (the api validates them again before running anything).
 */
export function buildApplyRequest(
  planId: string,
  original: readonly EditOp[],
  edited: readonly EditOp[],
  enabled: readonly boolean[],
): AgentApplyRequest {
  const ops = edited.map((_, i) => i).filter((i) => enabled[i]);
  const changed = edited.some((op, i) => JSON.stringify(op) !== JSON.stringify(original[i]));
  return { planId, ops, ...(changed && { edited_ops: [...edited] }) };
}

/** The questions form re-sends the command with the answers appended. */
export function appendAnswers(
  command: string,
  questions: readonly string[],
  answers: readonly string[],
): string {
  const pairs = questions
    .map((q, i) => ({ q: q.trim(), a: (answers[i] ?? "").trim() }))
    .filter((p) => p.a);
  if (pairs.length === 0) return command;
  const base = command.trim().replace(/[.\s]+$/, "");
  return `${base}. Respuestas: ${pairs.map((p) => `${p.q} → ${p.a}`).join("; ")}`;
}

// --------------------------------------------------------------------------------------------
// Command history (↑/↓)

export const MAX_COMMAND_HISTORY = 50;

/** Newest last; repeated commands move to the end. */
export function pushHistory(history: readonly string[], command: string): string[] {
  const c = command.trim();
  if (!c) return [...history];
  return [...history.filter((h) => h !== c), c].slice(-MAX_COMMAND_HISTORY);
}

/**
 * Navigate the history like a shell: `cursor` = index into history, or history.length for the
 * draft line. Returns the new cursor (↑ = -1, ↓ = +1).
 */
export function navigateHistory(length: number, cursor: number, dir: -1 | 1): number {
  return Math.max(0, Math.min(length, cursor + dir));
}

// --------------------------------------------------------------------------------------------
// Apply progress per op

export type OpRunState = "pending" | "running" | "done" | "failed" | "skipped";

/** «Paso 2/5…» in the job message wins over the progress ratio. */
function stepFromMessage(message: string | undefined): number | undefined {
  const m = /(\d+)\s*(?:\/|de)\s*(\d+)/.exec(message ?? "");
  return m ? Number(m[1]) - 1 : undefined;
}

/**
 * State of each op of the plan while/after agent.apply runs. `selected` = indexes sent to the api
 * (in plan order); the job runs them in that order and stops at the first error.
 */
export function opRunStates(
  total: number,
  selected: readonly number[],
  job: Pick<Job, "status" | "progress" | "message"> | undefined,
  result?: AgentApplyResult,
): OpRunState[] {
  const states: OpRunState[] = Array.from({ length: total }, (_, i) =>
    selected.includes(i) ? "pending" : "skipped",
  );
  if (!job) return states;
  const n = selected.length;
  if (job.status === "succeeded" || result) {
    const applied = result?.applied ?? n;
    const failedIndex = result?.failed?.index;
    selected.forEach((planIndex, k) => {
      // `failed.index` is the plan index of the op that stopped the run.
      if (failedIndex !== undefined && planIndex === failedIndex) states[planIndex] = "failed";
      else if (k < applied) states[planIndex] = "done";
    });
    return states;
  }
  const current = Math.min(
    n - 1,
    stepFromMessage(job.message) ?? Math.floor(Math.max(0, job.progress) * n),
  );
  selected.forEach((planIndex, k) => {
    if (k < current) states[planIndex] = "done";
    else if (k === current)
      states[planIndex] =
        job.status === "failed" ? "failed" : job.status === "canceled" ? "pending" : "running";
  });
  return states;
}

// --------------------------------------------------------------------------------------------
// Eval results

function rate(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** agent.eval result: `{models: {name: metrics}}`, `{results: [...]}`, an array or a map. */
export function normalizeEvalResults(raw: unknown): AgentEvalModelResult[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as Record<string, unknown>;
  const source = r.models ?? r.results ?? r.by_model ?? raw;
  const entries: [string | undefined, unknown][] = Array.isArray(source)
    ? source.map((v) => [undefined, v])
    : Object.entries(source as Record<string, unknown>);
  const out: AgentEvalModelResult[] = [];
  for (const [key, value] of entries) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const model = typeof v.model === "string" ? v.model : key;
    if (!model) continue;
    const metrics: AgentEvalModelResult = { model };
    for (const k of [
      "valid_json_rate",
      "schema_valid_rate",
      "exact_ops_rate",
      "semantic_rate",
      "p50_latency_ms",
    ] as const) {
      const n = rate(v[k]);
      if (n !== undefined) metrics[k] = n;
    }
    if (Array.isArray(v.failures)) metrics.failures = v.failures;
    if (Object.keys(metrics).length > 1) out.push(metrics);
  }
  return out;
}

/** 0.934 -> "93 %" (rates may also come as 0..100). */
export function formatRate(v: number | undefined): string {
  if (v === undefined) return "—";
  const pct = v <= 1 ? v * 100 : v;
  return `${Math.round(pct)} %`;
}

/** 850 -> "850 ms", 2400 -> "2,4 s". */
export function formatLatency(ms: number | undefined | null): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
}

// --------------------------------------------------------------------------------------------
// «Redactar con IA» (bug report)

export interface DraftedReport {
  title?: string;
  steps?: string;
  expected?: string;
  actual?: string;
}

const SECTION_KEYS: { key: keyof DraftedReport; re: RegExp }[] = [
  { key: "title", re: /^t[ií]tulo/i },
  { key: "steps", re: /^(pasos|c[oó]mo reproducir|qu[eé] hice)/i },
  { key: "expected", re: /^(esperad|qu[eé] esperaba|resultado esperado)/i },
  { key: "actual", re: /^(pas[oó]|qu[eé] pas[oó]|resultado real|lo que pas[oó]|actual)/i },
];

/**
 * Split the markdown of /api/agent/bugreport into the form fields. Accepts `# Title` and
 * `## Pasos` / `**Esperado:**` style headings; unknown sections are ignored.
 */
export function parseDraftedReport(markdown: string): DraftedReport {
  const out: DraftedReport = {};
  const buf: Partial<Record<keyof DraftedReport, string[]>> = {};
  let current: keyof DraftedReport | undefined;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h1 = /^#\s+(.+)$/.exec(line);
    if (h1) {
      if (!out.title && !buf.title) out.title = h1[1]!.trim();
      current = undefined;
      continue;
    }
    const hashed = /^#{2,6}\s+(.+?)\s*:?\s*$/.exec(line);
    const bold = /^\*\*(.+?)\*\*\s*(.*)$/.exec(line);
    const name = (hashed?.[1] ?? bold?.[1])?.replace(/:\s*$/, "").trim();
    const section = name ? SECTION_KEYS.find((s) => s.re.test(name)) : undefined;
    if (section) {
      current = section.key;
      const rest = bold?.[2]?.replace(/^:\s*/, "").trim();
      buf[current] = rest ? [rest] : [];
      continue;
    }
    if (hashed) {
      current = undefined;
      continue;
    }
    if (current) (buf[current] ??= []).push(line);
  }
  for (const s of SECTION_KEYS) {
    const text = buf[s.key]?.join("\n").trim();
    if (text) out[s.key] = s.key === "title" ? text.split("\n")[0]!.trim() : text;
  }
  return out;
}

/** Back to the «¿Qué intentabas hacer?» format: steps, «Esperaba que…», «Pero pasó…». */
export function composeSteps(d: DraftedReport, fallback: string): string {
  if (!d.steps && !d.expected && !d.actual) return fallback;
  const lines: string[] = [];
  if (d.steps) lines.push(d.steps);
  if (d.expected) lines.push("", `Esperaba que: ${d.expected}`);
  if (d.actual) lines.push("", `Pero pasó: ${d.actual}`);
  return lines.join("\n").trim();
}

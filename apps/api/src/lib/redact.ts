/**
 * Secret redaction for logs and error reports. Applied to every line written to storage/logs and
 * to every file of a report. Conservative: it prefers hiding a harmless value over leaking a key.
 */

export const REDACTED = "[REDACTED]";

/** Names whose values are always hidden (env vars, JSON keys, headers, query params). */
const SECRET_NAME = String.raw`[A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|authorization|auth[_-]?key|private[_-]?key|access[_-]?key|credential)[A-Za-z0-9_.-]*`;

const PATTERNS: readonly [RegExp, string | ((...m: string[]) => string)][] = [
  // Authorization: Bearer xxx / Basic xxx
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${REDACTED}`],
  // NAME=value / NAME: value / "name": "value"
  [
    new RegExp(
      String.raw`(["']?${SECRET_NAME}["']?\s*[:=]\s*)(["']?)(?!(?:null|true|false|undefined)\b)([^\s"',;&}]+)\2`,
      "gi",
    ),
    (_m, prefix = "", quote = "") => `${prefix}${quote}${REDACTED}${quote}`,
  ],
  // ?api_key=... &token=...
  [
    /([?&](?:key|api_key|apikey|token|access_token|auth|sig|signature)=)[^&\s"']+/gi,
    `$1${REDACTED}`,
  ],
  // Provider-shaped keys anywhere in the text.
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, REDACTED], // OpenAI / Anthropic
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, REDACTED], // GitHub
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED], // Slack
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED], // AWS access key id
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, REDACTED], // Google API key
  [/\bhf_[A-Za-z0-9]{20,}/g, REDACTED], // Hugging Face
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED], // JWT
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
];

export interface RedactOptions {
  /** Exact secret values to hide (e.g. the API keys loaded from .env). */
  secrets?: readonly (string | undefined)[];
  /** Replace this directory (the user's home) with "~" to avoid leaking the user name. */
  homeDir?: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Redact secrets in free text (log lines, stderr, markdown). */
export function redactText(text: string, opts: RedactOptions = {}): string {
  let out = text;
  for (const secret of opts.secrets ?? []) {
    if (secret && secret.length >= 6) out = out.split(secret).join(REDACTED);
  }
  for (const [re, replacement] of PATTERNS) {
    out = out.replace(re, replacement as never);
  }
  if (opts.homeDir && opts.homeDir.length > 3) {
    const variants = new Set([opts.homeDir, opts.homeDir.replace(/\\/g, "/")]);
    for (const v of variants) out = out.replace(new RegExp(escapeRegExp(v), "gi"), "~");
    // JSON-escaped Windows paths (C:\\Users\\name).
    const jsonEscaped = JSON.stringify(opts.homeDir).slice(1, -1);
    if (jsonEscaped !== opts.homeDir)
      out = out.replace(new RegExp(escapeRegExp(jsonEscaped), "gi"), "~");
  }
  return out;
}

/** True when an object key / env var name denotes a secret. */
export function isSecretName(name: string): boolean {
  return new RegExp(`^${SECRET_NAME}$`, "i").test(name);
}

/** Deep-redact a JSON value: secret-named keys are hidden, strings go through redactText. */
export function redactValue<T>(value: T, opts: RedactOptions = {}): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return redactText(v, opts);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v).map(([k, val]) => [
          k,
          isSecretName(k) && val !== null && val !== "" && typeof val !== "boolean"
            ? REDACTED
            : walk(val),
        ]),
      );
    }
    return v;
  };
  return walk(value) as T;
}

/** Redact a `.env`-style text: every secret-named variable with a value becomes [REDACTED]. */
export function redactEnvText(text: string, opts: RedactOptions = {}): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const m = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/.exec(line);
      if (!m) return redactText(line, opts);
      const [, lead = "", name = "", eq = "", value = ""] = m;
      if (isSecretName(name) && value.trim() !== "" && value.trim() !== '""')
        return `${lead}${name}${eq}${REDACTED}`;
      return redactText(line, opts);
    })
    .join("\n");
}

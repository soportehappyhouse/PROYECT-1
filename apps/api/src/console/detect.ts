import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Sprint 3b — Consola Claude: where is the Claude Code CLI (`claude`) and is there a login?
 * Only the user's Claude.ai subscription is used (`claude auth login`); never an API key.
 */

export const CLAUDE_INSTALL_COMMAND = "npm i -g @anthropic-ai/claude-code";
export const CLAUDE_LOGIN_COMMAND = "claude auth login";

/**
 * Settings file passed to the console child with `--settings` (ships with the api:
 * `apps/api/console/`, same relative path from `src/console/` and `dist/console/`). It only adds
 * `permissions.deny` rules (`.env*`, `storage/`, `models/`, WebFetch); the repo's own
 * `.claude/settings.json` and `.mcp.json` are not touched.
 */
export const CONSOLE_SETTINGS_PATH = fileURLToPath(
  new URL("../../console/claude-console-settings.json", import.meta.url),
);

/**
 * Arguments of the interactive console session. Windows `.cmd` shims go through `cmd /c`, which
 * only keeps the quotes of ONE quoted token: if both the shim and the settings path have spaces,
 * the settings path is passed relative to the session cwd (the repo root).
 */
export function consoleClaudeArgs(
  bin: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  settingsPath: string = CONSOLE_SETTINGS_PATH,
): string[] {
  let p = settingsPath;
  if (isWin(platform) && /\.(cmd|bat)$/i.test(bin) && /\s/.test(bin) && /\s/.test(p)) {
    const rel = path.win32.relative(cwd, p);
    if (rel && !/\s/.test(rel) && !path.win32.isAbsolute(rel)) p = rel;
  }
  return ["--settings", p];
}

export interface ClaudeInfo {
  installed: boolean;
  /** Absolute path of the executable (claude, claude.exe or claude.cmd). */
  bin?: string;
  /** `claude --version` first line, e.g. "2.1.290 (Claude Code)". */
  version?: string;
  /** `claude auth status` (exit 0 = logged in, 1 = not); null = could not tell. */
  loggedIn: boolean | null;
  /** authMethod of `claude auth status` (claude.ai, oauth_token, api_key, none…). */
  authMethod?: string;
}

export interface DetectOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Skip the 20 s cache. */
  force?: boolean;
  /** Skip `claude auth status` (faster; loggedIn = null). */
  skipAuth?: boolean;
}

const isWin = (p: NodeJS.Platform) => p === "win32";

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Names tried in each PATH directory (Windows: PATHEXT order, .exe and .cmd first). */
export function executableNames(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (!isWin(platform)) return ["claude"];
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const ordered = [".exe", ".cmd", ...exts.filter((e) => e !== ".exe" && e !== ".cmd")];
  return [...new Set(ordered)].map((e) => `claude${e}`);
}

/** First `claude` found on PATH (no shell involved). */
export function findOnPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const pathVar = env.PATH ?? env.Path ?? "";
  const sep = isWin(platform) ? ";" : ":";
  const names = executableNames(platform, env);
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir.replace(/^"|"$/g, ""), name);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

type Exec = (
  file: string,
  args: string[],
  opts: { timeout: number; env?: NodeJS.ProcessEnv },
) => Promise<{ code: number; stdout: string; stderr: string }>;

const execCapture: Exec = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: opts.timeout, env: opts.env, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? ((err as { code: number }).code as number)
            : err
              ? -1
              : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });

/**
 * Command line that runs `bin args` (Windows .cmd/.bat shims go through cmd.exe). No `/s`: cmd keeps
 * the quotes of a single quoted path with spaces ("C:\Users\Usuario Demo\…\claude.cmd").
 */
export function commandFor(
  bin: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } {
  if (isWin(platform) && /\.(cmd|bat)$/i.test(bin))
    return { file: "cmd.exe", args: ["/d", "/c", bin, ...args] };
  return { file: bin, args };
}

/** Windows fallback: the npm global prefix (`npm root -g` → its parent holds claude.cmd). */
async function npmGlobalCandidates(env: NodeJS.ProcessEnv, exec: Exec): Promise<string[]> {
  const out: string[] = [];
  if (env.APPDATA) out.push(path.join(env.APPDATA, "npm", "claude.cmd"));
  const res = await exec("cmd.exe", ["/d", "/s", "/c", "npm root -g"], { timeout: 10_000, env });
  const root = res.code === 0 ? res.stdout.trim().split(/\r?\n/)[0]?.trim() : undefined;
  if (root) {
    const prefix = path.dirname(root);
    out.push(path.join(prefix, "claude.cmd"), path.join(prefix, "claude.exe"));
  }
  return out;
}

/** Locate the executable: STUDIO_CLAUDE_BIN, PATH, native installer dir, npm global prefix. */
export async function findClaude(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exec: Exec = execCapture,
): Promise<string | undefined> {
  const override = env.STUDIO_CLAUDE_BIN?.trim();
  if (override) return existsSync(override) ? path.resolve(override) : undefined;
  const onPath = findOnPath(env, platform);
  if (onPath) return onPath;
  const home = env.USERPROFILE ?? env.HOME ?? os.homedir();
  const local = isWin(platform)
    ? [path.join(home, ".local", "bin", "claude.exe")]
    : [path.join(home, ".local", "bin", "claude"), path.join(home, ".claude", "local", "claude")];
  for (const c of local) if (isFile(c)) return c;
  if (isWin(platform)) {
    for (const c of await npmGlobalCandidates(env, exec)) if (isFile(c)) return c;
  }
  return undefined;
}

let cache: { at: number; info: ClaudeInfo; skipAuth: boolean } | undefined;
const CACHE_MS = 20_000;

export function clearClaudeCache(): void {
  cache = undefined;
}

/** Find `claude`, read its version and (unless skipAuth) the login status. Cached 20 s. */
export async function detectClaude(
  opts: DetectOptions = {},
  exec: Exec = execCapture,
): Promise<ClaudeInfo> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  if (
    !opts.force &&
    cache &&
    Date.now() - cache.at < CACHE_MS &&
    (cache.skipAuth === false || opts.skipAuth)
  )
    return cache.info;
  const bin = await findClaude(env, platform, exec);
  let info: ClaudeInfo;
  if (!bin) info = { installed: false, loggedIn: null };
  else {
    const v = commandFor(bin, ["--version"], platform);
    const a = commandFor(bin, ["auth", "status"], platform);
    const [ver, auth] = await Promise.all([
      exec(v.file, v.args, { timeout: 15_000, env }),
      opts.skipAuth ? undefined : exec(a.file, a.args, { timeout: 15_000, env }),
    ]);
    const version = ver.code === 0 ? ver.stdout.trim().split(/\r?\n/)[0]?.trim() : undefined;
    let loggedIn: boolean | null = null;
    let authMethod: string | undefined;
    if (auth && (auth.code === 0 || auth.code === 1)) {
      try {
        const parsed = JSON.parse(auth.stdout) as { loggedIn?: unknown; authMethod?: unknown };
        if (typeof parsed.authMethod === "string") authMethod = parsed.authMethod;
        loggedIn =
          typeof parsed.loggedIn === "boolean"
            ? parsed.loggedIn
            : authMethod
              ? authMethod !== "none"
              : auth.code === 0;
      } catch {
        // Older CLI without `auth status` JSON: unknown.
      }
    }
    info = {
      installed: true,
      bin,
      ...(version && { version }),
      loggedIn,
      ...(authMethod && { authMethod }),
    };
  }
  cache = { at: Date.now(), info, skipAuth: Boolean(opts.skipAuth) };
  return info;
}

import { randomBytes } from "node:crypto";
import type { IPty } from "@lydell/node-pty";
import {
  CLAUDE_INSTALL_COMMAND,
  CLAUDE_LOGIN_COMMAND,
  commandFor,
  consoleClaudeArgs,
  CONSOLE_SETTINGS_PATH,
  type ClaudeInfo,
} from "./detect.js";

/**
 * Sprint 3b — Consola Claude sessions. `POST /api/console/session` issues a one-time token; the
 * first WebSocket that presents it (`GET /api/console/ws?token=`) gets a PTY running `claude` in
 * the repo root. Closing the socket kills the process (SIGHUP, then SIGKILL after 3 s).
 */

/** Messages sent by the server over the console WebSocket (JSON text frames). */
export type ConsoleServerMessage =
  | { type: "output"; data: string }
  | {
      type: "status";
      state: "running" | "missing" | "exited" | "error";
      message?: string;
      claude?: Pick<ClaudeInfo, "installed" | "version" | "loggedIn">;
    }
  | { type: "exit"; exitCode: number; signal?: number };

/** Messages accepted from the browser. */
export type ConsoleClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "kill" };

export interface ConsoleSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", cb: (data: Buffer | string) => void): unknown;
  on(event: "close", cb: () => void): unknown;
}

export type SpawnPty = (
  file: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; cols: number; rows: number },
) => IPty | Promise<IPty>;

export interface ConsoleSession {
  token: string;
  createdAt: number;
  cols: number;
  rows: number;
  attached: boolean;
  pty?: IPty;
  socket?: ConsoleSocket;
  exited: boolean;
}

export interface ConsoleManagerOptions {
  cwd: string;
  env: () => Record<string, string>;
  detect: () => Promise<ClaudeInfo>;
  spawn?: SpawnPty;
  /** Unattached tokens expire after this (default 2 min). */
  tokenTtlMs?: number;
  /** Max live sessions; the oldest is closed when a new one is created (default 4). */
  maxSessions?: number;
  platform?: NodeJS.Platform;
  /** `--settings` file with the console's deny rules (default CONSOLE_SETTINGS_PATH). */
  settingsPath?: string;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export const clampSize = (n: unknown, lo: number, hi: number, fallback: number): number => {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : fallback;
  return Math.min(hi, Math.max(lo, v));
};

/** Spanish text written into the terminal when `claude` is not installed. */
export function missingClaudeBanner(platform: NodeJS.Platform = process.platform): string {
  const lines = [
    "\x1b[1;33mClaude Code no está instalado en esta PC.\x1b[0m",
    "",
    "Para usar la Consola Claude con tu suscripción de Claude.ai (sin API key):",
    "",
    `  1. Instalalo:            \x1b[1m${CLAUDE_INSTALL_COMMAND}\x1b[0m`,
    platform === "win32"
      ? "     (o volvé a correr \x1b[1mscripts\\windows\\setup.cmd\x1b[0m, que lo instala con -WithClaude)"
      : "",
    `  2. Iniciá sesión una vez: \x1b[1m${CLAUDE_LOGIN_COMMAND}\x1b[0m`,
    "  3. Volvé a este panel y tocá «Nueva sesión».",
    "",
    "Necesitás Node.js 22 o superior. Más info: docs/CONSOLA-CLAUDE.md",
  ].filter((l, i, all) => l !== "" || all[i - 1] !== "");
  return lines.join("\r\n") + "\r\n";
}

async function defaultSpawn(...a: Parameters<SpawnPty>): Promise<IPty> {
  const pty = await import("@lydell/node-pty");
  const [file, args, o] = a;
  return pty.spawn(file, args, { name: "xterm-256color", ...o });
}

export class ConsoleManager {
  private readonly sessions = new Map<string, ConsoleSession>();
  private readonly ttl: number;
  private readonly max: number;

  constructor(private readonly o: ConsoleManagerOptions) {
    this.ttl = o.tokenTtlMs ?? 120_000;
    this.max = o.maxSessions ?? 4;
  }

  get size(): number {
    return this.sessions.size;
  }

  private prune(): void {
    const now = Date.now();
    for (const s of this.sessions.values())
      if (!s.attached && now - s.createdAt > this.ttl) this.sessions.delete(s.token);
  }

  create(size: { cols?: number; rows?: number } = {}): ConsoleSession {
    this.prune();
    while (this.sessions.size >= this.max) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!oldest) break;
      this.close(oldest.token, "Se abrió otra sesión");
    }
    const session: ConsoleSession = {
      token: randomBytes(24).toString("base64url"),
      createdAt: Date.now(),
      cols: clampSize(size.cols, 20, 500, 100),
      rows: clampSize(size.rows, 5, 200, 30),
      attached: false,
      exited: false,
    };
    this.sessions.set(session.token, session);
    return session;
  }

  get(token: string | undefined): ConsoleSession | undefined {
    this.prune();
    return token ? this.sessions.get(token) : undefined;
  }

  /** Most recent session (resize without token). */
  latest(): ConsoleSession | undefined {
    return [...this.sessions.values()].sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  resize(token: string | undefined, cols: number, rows: number): ConsoleSession | undefined {
    const s = token ? this.get(token) : this.latest();
    if (!s) return undefined;
    s.cols = clampSize(cols, 20, 500, s.cols);
    s.rows = clampSize(rows, 5, 200, s.rows);
    if (s.pty && !s.exited) {
      try {
        s.pty.resize(s.cols, s.rows);
      } catch {
        // the process may have just exited
      }
    }
    return s;
  }

  private send(s: ConsoleSession, msg: ConsoleServerMessage): void {
    try {
      s.socket?.send(JSON.stringify(msg));
    } catch {
      // socket already closed
    }
  }

  /** Bind a WebSocket to a session (once) and start `claude`, or explain how to install it. */
  async attach(token: string, socket: ConsoleSocket): Promise<boolean> {
    const s = this.get(token);
    if (!s || s.attached) {
      socket.close(4401, "Token de consola inválido o usado");
      return false;
    }
    s.attached = true;
    s.socket = socket;
    socket.on("message", (raw) => this.onMessage(s, raw));
    socket.on("close", () => this.close(s.token));

    const claude = await this.o.detect();
    const claudeState = {
      installed: claude.installed,
      ...(claude.version && { version: claude.version }),
      loggedIn: claude.loggedIn,
    };
    if (!claude.installed || !claude.bin) {
      this.send(s, { type: "output", data: missingClaudeBanner(this.o.platform) });
      this.send(s, {
        type: "status",
        state: "missing",
        message: `Claude Code no está instalado: ${CLAUDE_INSTALL_COMMAND}`,
        claude: claudeState,
      });
      return true;
    }
    if (claude.loggedIn === false)
      this.send(s, {
        type: "output",
        data:
          "\x1b[33mNo encontramos un inicio de sesión de Claude Code. Si la consola te lo pide, " +
          `escribí \x1b[1m/login\x1b[0;33m o cerrala y corré \x1b[1m${CLAUDE_LOGIN_COMMAND}\x1b[0;33m.\x1b[0m\r\n`,
      });
    const platform = this.o.platform ?? process.platform;
    const args = consoleClaudeArgs(
      claude.bin,
      this.o.cwd,
      platform,
      this.o.settingsPath ?? CONSOLE_SETTINGS_PATH,
    );
    const cmd = commandFor(claude.bin, args, platform);
    try {
      const pty = await (this.o.spawn ?? defaultSpawn)(cmd.file, cmd.args, {
        cwd: this.o.cwd,
        env: this.o.env(),
        cols: s.cols,
        rows: s.rows,
      });
      if (!this.sessions.has(s.token)) {
        // socket closed while spawning
        pty.kill();
        return false;
      }
      s.pty = pty;
      pty.onData((data) => this.send(s, { type: "output", data }));
      pty.onExit(({ exitCode, signal }) => {
        s.exited = true;
        this.send(s, { type: "exit", exitCode, ...(signal ? { signal } : {}) });
        this.send(s, {
          type: "status",
          state: "exited",
          message: `Claude Code terminó (código ${exitCode})`,
        });
      });
      this.send(s, { type: "status", state: "running", claude: claudeState });
      this.o.log?.("Consola Claude iniciada", { bin: claude.bin, version: claude.version });
      return true;
    } catch (err) {
      const message = `No se pudo iniciar Claude Code: ${err instanceof Error ? err.message : String(err)}`;
      this.send(s, { type: "output", data: `\x1b[31m${message}\x1b[0m\r\n` });
      this.send(s, { type: "status", state: "error", message, claude: claudeState });
      return true;
    }
  }

  private onMessage(s: ConsoleSession, raw: Buffer | string): void {
    let msg: ConsoleClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ConsoleClientMessage;
    } catch {
      return;
    }
    if (msg.type === "input" && typeof msg.data === "string") {
      if (s.pty && !s.exited) s.pty.write(msg.data);
    } else if (msg.type === "resize") this.resize(s.token, msg.cols, msg.rows);
    else if (msg.type === "kill") this.close(s.token, "Sesión cerrada");
  }

  /** Kill the process and forget the session. */
  close(token: string, reason?: string): void {
    const s = this.sessions.get(token);
    if (!s) return;
    this.sessions.delete(token);
    const pty = s.pty;
    if (pty && !s.exited) {
      try {
        pty.kill();
      } catch {
        // already gone
      }
      if (this.o.platform !== "win32" && process.platform !== "win32") {
        const timer = setTimeout(() => {
          if (!s.exited) {
            try {
              pty.kill("SIGKILL");
            } catch {
              // already gone
            }
          }
        }, 3000);
        timer.unref();
      }
    }
    try {
      s.socket?.close(1000, reason ?? "Sesión cerrada");
    } catch {
      // already closed
    }
  }

  closeAll(): void {
    for (const token of [...this.sessions.keys()]) this.close(token, "La API se detuvo");
  }
}

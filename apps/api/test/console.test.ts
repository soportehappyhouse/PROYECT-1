import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  clearClaudeCache,
  commandFor,
  executableNames,
  findOnPath,
} from "../src/console/detect.js";
import { consoleEnv } from "../src/console/env.js";
import { clipUnder } from "../src/console/frame.js";
import { ConsoleManager, missingClaudeBanner } from "../src/console/sessions.js";
import { CONSOLE_ROUTES, isLoopback } from "../src/routes/console.js";
import { makeApp } from "./helpers.js";

const isWin = process.platform === "win32";

/** Fake `claude`: --version, auth status (JSON) and an echo loop for the interactive session. */
function fakeClaude(dir: string): string {
  if (isWin) {
    const bin = path.join(dir, "claude.cmd");
    writeFileSync(
      bin,
      [
        "@echo off",
        'if "%1"=="--version" (echo 9.9.9 ^(Claude Code^) & exit /b 0)',
        'if "%1"=="auth" (echo {"loggedIn":true,"authMethod":"claude.ai"} & exit /b 0)',
        "echo FAKE CLAUDE key=%ELEVENLABS_API_KEY% api=%STUDIO_API_URL%",
        ":loop",
        "set /p line=",
        "echo eco:%line%",
        "goto loop",
      ].join("\r\n"),
    );
    return bin;
  }
  const bin = path.join(dir, "claude");
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env bash",
      'if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi',
      'if [ "$1" = "auth" ]; then echo \'{"loggedIn":true,"authMethod":"claude.ai"}\'; exit 0; fi',
      'echo "FAKE CLAUDE pid=$$ key=${ELEVENLABS_API_KEY:-none} api=$STUDIO_API_URL"',
      'while IFS= read -r line; do echo "eco:$line"; done',
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return bin;
}

interface Received {
  messages: Array<Record<string, unknown>>;
  text: () => string;
}

function collect(ws: WebSocket): Received {
  const messages: Array<Record<string, unknown>> = [];
  ws.addEventListener("message", (ev) => messages.push(JSON.parse(String(ev.data))));
  return {
    messages,
    text: () =>
      messages
        .filter((m) => m.type === "output")
        .map((m) => String(m.data))
        .join(""),
  };
}

async function until(fn: () => boolean, timeout = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeout) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("console helpers", () => {
  it("strips keys, tokens and secrets from the child env", () => {
    const env = consoleEnv(
      {
        PATH: "/bin",
        ELEVENLABS_API_KEY: "x",
        ANTHROPIC_API_KEY: "y",
        CLAUDE_CODE_OAUTH_TOKEN: "z",
        GITHUB_TOKEN: "t",
        MY_SECRET: "s",
        ANTHROPIC_BASE_URL: "http://evil",
        HOME: "/home/u",
      },
      { STUDIO_API_URL: "http://127.0.0.1:3001" },
    );
    expect(env).toMatchObject({ PATH: "/bin", HOME: "/home/u", TERM: "xterm-256color" });
    expect(env.STUDIO_API_URL).toBe("http://127.0.0.1:3001");
    for (const k of [
      "ELEVENLABS_API_KEY",
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "GITHUB_TOKEN",
      "MY_SECRET",
      "ANTHROPIC_BASE_URL",
    ])
      expect(env[k]).toBeUndefined();
  });

  it("loopback detection", () => {
    for (const a of ["127.0.0.1", "127.8.0.3", "::1", "::ffff:127.0.0.1"])
      expect(isLoopback(a)).toBe(true);
    for (const a of ["10.0.0.5", "192.168.1.2", "::ffff:10.0.0.1", "fe80::1", undefined, ""])
      expect(isLoopback(a)).toBe(false);
  });

  it("windows shims go through cmd.exe; PATHEXT order prefers .exe/.cmd", () => {
    expect(commandFor("C:\\npm\\claude.cmd", [], "win32")).toEqual({
      file: "cmd.exe",
      args: ["/d", "/c", "C:\\npm\\claude.cmd"],
    });
    expect(commandFor("/usr/bin/claude", ["--version"], "linux")).toEqual({
      file: "/usr/bin/claude",
      args: ["--version"],
    });
    expect(executableNames("win32", { PATHEXT: ".COM;.EXE;.BAT;.CMD" })).toEqual([
      "claude.exe",
      "claude.cmd",
      "claude.com",
      "claude.bat",
    ]);
  });

  it("finds claude on PATH", () => {
    if (isWin) return;
    const dir = mkdtempSync(path.join(tmpdir(), "studio-claude-path-"));
    const bin = fakeClaude(dir);
    expect(findOnPath({ PATH: `/nope:${dir}` }, "linux")).toBe(bin);
    expect(findOnPath({ PATH: "/nope" }, "linux")).toBeUndefined();
  });

  it("missing banner is Spanish and has the install + login commands", () => {
    const b = missingClaudeBanner("win32");
    expect(b).toContain("npm i -g @anthropic-ai/claude-code");
    expect(b).toContain("claude auth login");
    expect(b).toContain("setup.cmd");
  });

  it("session tokens are random, single-use and expire; oldest is evicted", async () => {
    const m = new ConsoleManager({
      cwd: tmpdir(),
      env: () => ({}),
      detect: async () => ({ installed: false, loggedIn: null }),
      tokenTtlMs: 50,
      maxSessions: 2,
    });
    const a = m.create({ cols: 1000, rows: 1 });
    expect(a.token).toMatch(/^[\w-]{32}$/);
    expect([a.cols, a.rows]).toEqual([500, 5]);
    const b = m.create();
    expect(b.token).not.toBe(a.token);
    m.create();
    expect(m.get(a.token)).toBeUndefined(); // evicted (max 2)
    expect(m.size).toBe(2);
    const closed: number[] = [];
    const sock = {
      send: () => undefined,
      close: (code?: number) => closed.push(code ?? 0),
      on: () => undefined,
    };
    expect(await m.attach(b.token, sock)).toBe(true);
    expect(await m.attach(b.token, sock)).toBe(false); // single use
    expect(closed).toContain(4401);
    await new Promise((r) => setTimeout(r, 80));
    expect(m.get(b.token)).toBeDefined(); // attached b survives the ttl
    expect(m.size).toBe(1);
  });

  it("clipUnder picks the top visible video clip and maps to source time", () => {
    const project = {
      tracks: [
        {
          kind: "video",
          hidden: false,
          clips: [{ assetId: "a", start: 0, in: 2, out: 12, speed: 1 }],
        },
        {
          kind: "video",
          hidden: false,
          clips: [{ assetId: "b", start: 5, in: 0, out: 4, speed: 2 }],
        },
        {
          kind: "video",
          hidden: true,
          clips: [{ assetId: "c", start: 0, in: 0, out: 9, speed: 1 }],
        },
      ],
    } as never;
    expect(clipUnder(project, 1)).toEqual({ assetId: "a", sourceTime: 3 });
    expect(clipUnder(project, 6)).toEqual({ assetId: "b", sourceTime: 2 });
    expect(clipUnder(project, 20)).toBeUndefined();
  });
});

describe("console routes", () => {
  let app: FastifyInstance;
  let base: string;
  const prev = { ...process.env };

  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "studio-claude-"));
    process.env.STUDIO_CLAUDE_BIN = fakeClaude(dir);
    process.env.ELEVENLABS_API_KEY = "super-secret";
    clearClaudeCache();
    ({ app } = await makeApp());
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    base = typeof addr === "object" && addr ? `127.0.0.1:${addr.port}` : "";
  });
  afterEach(() => clearClaudeCache());
  afterAll(async () => {
    await app.close();
    process.env = prev;
  });

  it("POST /api/console/session issues a token with claude info", async () => {
    const res = await app.inject({ method: "POST", url: CONSOLE_ROUTES.session, payload: {} });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.token).toMatch(/^[\w-]{32}$/);
    expect(body).toMatchObject({
      claudeInstalled: true,
      version: "9.9.9 (Claude Code)",
      loggedIn: true,
      authMethod: "claude.ai",
      installCommand: "npm i -g @anthropic-ai/claude-code",
    });
    expect(typeof body.cwd).toBe("string");
  });

  it("refuses non-loopback clients and foreign origins", async () => {
    for (const url of [CONSOLE_ROUTES.session, CONSOLE_ROUTES.resize]) {
      const res = await app.inject({
        method: "POST",
        url,
        payload: { cols: 80, rows: 24 },
        remoteAddress: "192.168.1.50",
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("CONSOLE_LOOPBACK_ONLY");
    }
    const ws = await app.inject({
      method: "GET",
      url: `${CONSOLE_ROUTES.ws}?token=x`,
      remoteAddress: "10.0.0.7",
    });
    expect(ws.statusCode).toBe(403);
    const evil = await app.inject({
      method: "POST",
      url: CONSOLE_ROUTES.session,
      payload: {},
      headers: { origin: "https://evil.example" },
    });
    expect(evil.statusCode).toBe(403);
  });

  it("rejects an unknown token over the WebSocket", async () => {
    const ws = new WebSocket(`ws://${base}${CONSOLE_ROUTES.ws}?token=nope-nope-nope`);
    const code = await new Promise<number>((resolve) =>
      ws.addEventListener("close", (e) => resolve(e.code)),
    );
    expect(code).toBe(4401);
  });

  it("spawns the fake claude, round-trips input, resizes and kills on close", async () => {
    const created = (
      await app.inject({ method: "POST", url: CONSOLE_ROUTES.session, payload: { cols: 90 } })
    ).json();
    const ws = new WebSocket(`ws://${base}${CONSOLE_ROUTES.ws}?token=${created.token}`);
    const rx = collect(ws);
    await until(() => rx.text().includes("FAKE CLAUDE"));
    expect(rx.messages.find((m) => m.type === "status")).toMatchObject({ state: "running" });
    expect(rx.text()).toContain("key=none"); // API keys never reach the console
    expect(rx.text()).toContain("api=http://127.0.0.1:");
    ws.send(JSON.stringify({ type: "input", data: "hola consola\r" }));
    await until(() => rx.text().includes("eco:hola consola"));

    const resized = await app.inject({
      method: "POST",
      url: CONSOLE_ROUTES.resize,
      payload: { token: created.token, cols: 120, rows: 40 },
    });
    expect(resized.json()).toEqual({ ok: true, cols: 120, rows: 40 });
    const missing = await app.inject({
      method: "POST",
      url: CONSOLE_ROUTES.resize,
      payload: { token: "x".repeat(32), cols: 120, rows: 40 },
    });
    expect(missing.statusCode).toBe(404);

    const pid = Number(/pid=(\d+)/.exec(rx.text())?.[1]);
    ws.close();
    if (!isWin) {
      const alive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      await until(() => !alive()); // the PTY process is killed with the socket
    }
    await new Promise((r) => setTimeout(r, 100));
    const after = await app.inject({
      method: "POST",
      url: CONSOLE_ROUTES.resize,
      payload: { token: created.token, cols: 100, rows: 30 },
    });
    expect(after.statusCode).toBe(404);
  });

  it("streams install instructions when claude is not installed", async () => {
    process.env.STUDIO_CLAUDE_BIN = path.join(tmpdir(), "does-not-exist", "claude");
    clearClaudeCache();
    const created = (
      await app.inject({ method: "POST", url: CONSOLE_ROUTES.session, payload: {} })
    ).json();
    expect(created.claudeInstalled).toBe(false);
    const ws = new WebSocket(`ws://${base}${CONSOLE_ROUTES.ws}?token=${created.token}`);
    const rx = collect(ws);
    await until(() => rx.messages.some((m) => m.type === "status"));
    expect(rx.text()).toContain("npm i -g @anthropic-ai/claude-code");
    expect(rx.messages.find((m) => m.type === "status")).toMatchObject({ state: "missing" });
    ws.close();
  });

  it("POST /api/console/plans validates, resolves and stores a Claude plan", async () => {
    const project = app.ctx.repos.projects.create({ name: "Consola" });
    const bad = await app.inject({
      method: "POST",
      url: CONSOLE_ROUTES.plans,
      payload: { projectId: project.id, plan: { version: 1, ops: [{ op: "nope" }] } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().errors.length).toBeGreaterThan(0);
    const plan = {
      version: 1,
      summary_es: "Título",
      ops: [{ op: "add_text", text: "Hola", t: 0 }],
    };
    const dry = await app.inject({
      method: "POST",
      url: CONSOLE_ROUTES.plans,
      payload: { projectId: project.id, plan, save: false },
    });
    expect(dry.json()).toMatchObject({ saved: false, id: null });
    const res = await app.inject({
      method: "POST",
      url: CONSOLE_ROUTES.plans,
      payload: { projectId: project.id, plan },
    });
    expect(res.statusCode).toBe(201);
    const rec = res.json();
    expect(rec).toMatchObject({ saved: true, status: "proposed", model: "claude-code" });
    expect(rec.preview_es).toHaveLength(1);
    const listed = await app.inject({
      method: "GET",
      url: `/api/agent/plans?projectId=${project.id}`,
    });
    expect(listed.json().map((p: { id: string }) => p.id)).toContain(rec.id);
  });

  it("GET /api/projects/:id/frame 404s for an unknown project", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/nope/frame?t=1" });
    expect(res.statusCode).toBe(404);
  });
});

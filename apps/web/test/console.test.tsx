import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Sprint 3b (web): «Consola Claude». xterm, the api and the WebSocket are faked. */

const termInstances: FakeTerminal[] = [];
class FakeTerminal {
  cols = 100;
  rows = 30;
  written: string[] = [];
  pasted: string[] = [];
  options: Record<string, unknown> = {};
  private dataCb: ((d: string) => void) | undefined;
  constructor() {
    termInstances.push(this);
  }
  loadAddon() {}
  open() {}
  attachCustomKeyEventHandler() {}
  onData(cb: (d: string) => void) {
    this.dataCb = cb;
    return { dispose: () => undefined };
  }
  type(d: string) {
    this.dataCb?.(d);
  }
  write(d: string) {
    this.written.push(d);
  }
  paste(t: string) {
    this.pasted.push(t);
  }
  reset() {
    this.written = [];
  }
  focus() {}
  hasSelection() {
    return false;
  }
  getSelection() {
    return "";
  }
  dispose() {}
}
vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const {
  consoleLabels,
  consoleReducer,
  consoleTransport,
  CONSOLE_PASTE_EVENT,
  CONSOLE_PROMPT_CHIPS,
  INITIAL_CONSOLE,
  pasteIntoConsole,
  useConsoleStore,
} = await import("@/stores/console-store");
const { ConsolePanel } = await import("@/components/panels/ConsolePanel");
const { PANELS } = await import("@/lib/layout");
const { SHORTCUT_ACTIONS } = await import("@/lib/shortcuts");

const STATUS = {
  claudeInstalled: true,
  version: "2.1.290 (Claude Code)",
  loggedIn: null,
  authMethod: null,
  bin: "/usr/bin/claude",
  cwd: "/repo",
  storageDir: "/repo/storage",
  mcpReady: true,
  installCommand: "npm i -g @anthropic-ai/claude-code",
  loginCommand: "claude auth login",
};

class FakeSocket {
  static last: FakeSocket | undefined;
  readyState = 0;
  sent: string[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
  }
  server(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

function mockFetch(status = STATUS) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = url.includes("/api/console/session") ? { token: "tok-123", ...status } : status;
      return new Response(JSON.stringify(json), {
        status: url.includes("/session") ? 201 : 200,
      });
    }),
  );
  return calls;
}

beforeEach(() => {
  consoleTransport.create = (url) => new FakeSocket(url) as unknown as WebSocket;
  useConsoleStore.setState({ ...INITIAL_CONSOLE });
  termInstances.length = 0;
});
afterEach(() => {
  useConsoleStore.getState().stop();
  vi.unstubAllGlobals();
});

describe("console state machine", () => {
  it("idle → connecting → running → exited, and errors", () => {
    let s = consoleReducer(INITIAL_CONSOLE, { type: "STATUS", status: STATUS });
    expect(s.phase).toBe("idle");
    s = consoleReducer(s, { type: "START" });
    expect(s).toMatchObject({ phase: "connecting", sessionSeq: 1 });
    s = consoleReducer(s, { type: "SERVER_STATUS", state: "running" });
    expect(s.phase).toBe("running");
    expect(consoleReducer(s, { type: "STATUS_FAILED", message: "x" }).phase).toBe("running");
    s = consoleReducer(s, { type: "EXIT", exitCode: 0 });
    expect(s).toMatchObject({ phase: "exited", exitCode: 0 });
    expect(consoleReducer(s, { type: "CLOSED" }).phase).toBe("exited");
    expect(consoleReducer(s, { type: "START" }).sessionSeq).toBe(2);
    const missing = consoleReducer(
      { ...s, phase: "connecting" },
      { type: "SERVER_STATUS", state: "missing", message: "falta" },
    );
    expect(missing).toMatchObject({ phase: "missing", status: { claudeInstalled: false } });
    expect(consoleReducer(INITIAL_CONSOLE, { type: "FAILED", message: "API" }).phase).toBe("error");
    expect(consoleReducer({ ...s, phase: "running" }, { type: "STOP" }).phase).toBe("idle");
  });

  it("labels: instalado / login desconocido / corriendo", () => {
    expect(consoleLabels({ ...INITIAL_CONSOLE, status: STATUS, phase: "running" })).toEqual({
      installed: "Instalado (2.1.290)",
      login: "Sesión: desconocida",
      run: "Corriendo",
    });
    expect(
      consoleLabels({ ...INITIAL_CONSOLE, status: { ...STATUS, loggedIn: false } }).login,
    ).toBe("Sin iniciar sesión");
    expect(
      consoleLabels({ ...INITIAL_CONSOLE, status: { ...STATUS, claudeInstalled: false } })
        .installed,
    ).toBe("No instalado");
  });

  it("start opens the WebSocket with the session token and streams output/input", async () => {
    const calls = mockFetch();
    await useConsoleStore.getState().start({ cols: 90, rows: 20 });
    expect(calls[0]).toMatchObject({ method: "POST", body: { cols: 90, rows: 20 } });
    const ws = FakeSocket.last!;
    expect(ws.url).toMatch(/^ws:\/\/127\.0\.0\.1:3001\/api\/console\/ws\?token=tok-123$/);
    ws.open();
    ws.server({ type: "status", state: "running" });
    expect(useConsoleStore.getState().phase).toBe("running");
    useConsoleStore.getState().input("hola");
    useConsoleStore.getState().resize(120, 40);
    expect(ws.sent.map((s) => JSON.parse(s))).toEqual([
      { type: "input", data: "hola" },
      { type: "resize", cols: 120, rows: 40 },
    ]);
    ws.server({ type: "exit", exitCode: 3 });
    expect(useConsoleStore.getState()).toMatchObject({ phase: "exited", exitCode: 3 });
  });

  it("shows the install state when claude is missing", async () => {
    mockFetch({ ...STATUS, claudeInstalled: false, version: null });
    await useConsoleStore.getState().start();
    const ws = FakeSocket.last!;
    ws.open();
    ws.server({ type: "output", data: "npm i -g @anthropic-ai/claude-code" });
    ws.server({ type: "status", state: "missing", message: "Claude Code no está instalado" });
    expect(useConsoleStore.getState().phase).toBe("missing");
  });
});

describe("ConsolePanel", () => {
  it("renders header, chips and pastes a chip into the terminal", async () => {
    mockFetch();
    render(<ConsolePanel />);
    await waitFor(() => expect(screen.getByText("Instalado (2.1.290)")).toBeTruthy());
    expect(screen.getByText("Sesión: desconocida")).toBeTruthy();
    expect(screen.getByText("Detenida")).toBeTruthy();
    for (const chip of CONSOLE_PROMPT_CHIPS) expect(screen.getByText(chip)).toBeTruthy();
    await waitFor(() => expect(termInstances.length).toBe(1));
    const term = termInstances[0]!;

    fireEvent.click(screen.getByText("Nueva sesión"));
    await waitFor(() => expect(FakeSocket.last).toBeDefined());
    const ws = FakeSocket.last!;
    act(() => {
      ws.open();
      ws.server({ type: "status", state: "running" });
      ws.server({ type: "output", data: "Claude Code listo" });
    });
    await waitFor(() => expect(screen.getByText("Corriendo")).toBeTruthy());
    expect(term.written.join("")).toContain("Claude Code listo");

    fireEvent.click(screen.getByText(CONSOLE_PROMPT_CHIPS[1]));
    expect(term.pasted).toEqual([CONSOLE_PROMPT_CHIPS[1]]);
    term.type("x");
    expect(ws.sent.map((s) => JSON.parse(s))).toContainEqual({ type: "input", data: "x" });

    // Another panel (Perfil de estilo) pastes through the window event.
    act(() => {
      window.dispatchEvent(
        new CustomEvent(CONSOLE_PASTE_EVENT, { detail: { text: "Analizá /tmp/hoja.png" } }),
      );
    });
    expect(term.pasted).toContain("Analizá /tmp/hoja.png");
  });

  it("explains how to install Claude Code when it is missing", async () => {
    mockFetch({ ...STATUS, claudeInstalled: false, version: null });
    render(<ConsolePanel />);
    await waitFor(() => expect(screen.getByText("Claude Code no está instalado")).toBeTruthy());
    expect(screen.getAllByText("npm i -g @anthropic-ai/claude-code").length).toBeGreaterThan(0);
    expect(screen.getByText("No instalado")).toBeTruthy();
  });

  it("queues pastes until a session is running", async () => {
    mockFetch();
    render(<ConsolePanel />);
    await waitFor(() => expect(termInstances.length).toBe(1));
    pasteIntoConsole("primero");
    expect(termInstances[0]!.pasted).toEqual([]);
  });

  it("is registered as a panel with the Ctrl+Shift+C shortcut", () => {
    expect(PANELS.find((p) => p.id === "console")?.title).toBe("Consola Claude");
    expect(SHORTCUT_ACTIONS.find((a) => a.id === "console.open")?.defaultKeys).toBe("Ctrl+Shift+C");
  });
});

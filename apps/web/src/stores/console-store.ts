import { create } from "zustand";
import { api, API_URL } from "@/lib/api";
import { addBreadcrumb } from "./breadcrumbs-store";
import { useJobsStore } from "./jobs-store";
import { useMediaStore } from "./media-store";
import { useProjectStore } from "./project-store";

/**
 * Sprint 3b — «Consola Claude» (docs/trabajo/sprint3b-contratos.md §A): Claude Code CLI running in a
 * PTY of the api (`/api/console/*`), shown with xterm.js. The WebSocket lives here (not in the
 * panel) so a hidden tab keeps its session; the panel replays the output buffer when it mounts.
 */

export const CONSOLE_ROUTES = {
  status: "/api/console/status",
  session: "/api/console/session",
  ws: "/api/console/ws",
  resize: "/api/console/resize",
} as const;

/** Window event other panels dispatch to paste text into the console (e.g. the style panel). */
export const CONSOLE_PASTE_EVENT = "studio:console:paste";
export interface ConsolePasteDetail {
  text: string;
  /** Press Enter after pasting (default false: the user reviews and sends). */
  submit?: boolean;
}

/** Suggested prompts (contract §A). */
export const CONSOLE_PROMPT_CHIPS = [
  "Analizá el video de referencia y proponé un perfil de estilo",
  "Cortá los silencios y exportá para Reels",
  "Redactá un reporte del último error",
] as const;

export interface ConsoleStatus {
  claudeInstalled: boolean;
  version: string | null;
  loggedIn: boolean | null;
  authMethod: string | null;
  bin: string | null;
  cwd: string;
  storageDir?: string;
  mcpReady: boolean;
  installCommand: string;
  loginCommand: string;
}

export type ConsolePhase =
  | "idle" // no session
  | "connecting" // POST session / WebSocket opening
  | "running" // claude is running in the PTY
  | "missing" // claude not installed: instructions shown in the terminal
  | "exited" // the process ended (Reiniciar starts a new one)
  | "error"; // api unreachable / spawn failed

export interface ConsoleMachine {
  phase: ConsolePhase;
  status: ConsoleStatus | null;
  /** Spanish line for the header / error notice. */
  message?: string;
  exitCode?: number;
  /** Increments on each new session: the panel clears the terminal. */
  sessionSeq: number;
}

export type ConsoleEvent =
  | { type: "STATUS"; status: ConsoleStatus }
  | { type: "STATUS_FAILED"; message: string }
  | { type: "START" }
  | { type: "SERVER_STATUS"; state: "running" | "missing" | "exited" | "error"; message?: string }
  | { type: "EXIT"; exitCode: number }
  | { type: "CLOSED"; message?: string }
  | { type: "FAILED"; message: string }
  | { type: "STOP" };

export const INITIAL_CONSOLE: ConsoleMachine = { phase: "idle", status: null, sessionSeq: 0 };

/** Pure state machine of the console (tested without DOM/WebSocket). */
export function consoleReducer(s: ConsoleMachine, e: ConsoleEvent): ConsoleMachine {
  switch (e.type) {
    case "STATUS":
      return {
        ...s,
        status: e.status,
        ...(s.phase === "error" && { phase: "idle" }),
        message: undefined,
      };
    case "STATUS_FAILED":
      return s.phase === "running" ? s : { ...s, phase: "error", message: e.message };
    case "START":
      return {
        ...s,
        phase: "connecting",
        message: undefined,
        exitCode: undefined,
        sessionSeq: s.sessionSeq + 1,
      };
    case "SERVER_STATUS":
      if (e.state === "running") return { ...s, phase: "running", message: undefined };
      if (e.state === "missing")
        return {
          ...s,
          phase: "missing",
          message: e.message,
          status: s.status ? { ...s.status, claudeInstalled: false } : s.status,
        };
      if (e.state === "exited") return { ...s, phase: "exited", message: e.message ?? s.message };
      return { ...s, phase: "error", message: e.message };
    case "EXIT":
      return { ...s, phase: "exited", exitCode: e.exitCode };
    case "CLOSED":
      if (s.phase === "connecting" || s.phase === "running")
        return {
          ...s,
          phase: "exited",
          message: e.message ?? "Se cerró la conexión con la consola",
        };
      return s;
    case "FAILED":
      return { ...s, phase: "error", message: e.message };
    case "STOP":
      return { ...s, phase: "idle", message: undefined };
  }
}

/** Header labels: instalado / logueado-desconocido / corriendo. */
export function consoleLabels(m: ConsoleMachine): {
  installed: string;
  login: string;
  run: string;
} {
  const st = m.status;
  return {
    installed: !st
      ? "Comprobando…"
      : st.claudeInstalled
        ? `Instalado${st.version ? ` (${st.version.replace(/\s*\(Claude Code\)/, "")})` : ""}`
        : "No instalado",
    login: !st?.claudeInstalled
      ? "Sin sesión"
      : st.loggedIn === true
        ? "Sesión iniciada"
        : st.loggedIn === false
          ? "Sin iniciar sesión"
          : "Sesión: desconocida",
    run:
      m.phase === "running"
        ? "Corriendo"
        : m.phase === "connecting"
          ? "Conectando…"
          : m.phase === "exited"
            ? "Terminó"
            : m.phase === "missing"
              ? "Falta instalar"
              : m.phase === "error"
                ? "Error"
                : "Detenida",
  };
}

type OutputListener = (data: string) => void;
type PasteBridge = (text: string) => void;

const MAX_BUFFER = 256 * 1024;
let socket: WebSocket | undefined;
let token: string | undefined;
let buffer = "";
const listeners = new Set<OutputListener>();
let pasteBridge: PasteBridge | undefined;
let focusBridge: (() => void) | undefined;
const pendingPastes: { text: string; submit: boolean }[] = [];

function emit(data: string) {
  buffer = (buffer + data).slice(-MAX_BUFFER);
  for (const l of listeners) l(data);
}

/** Subscribe to terminal output; returns the buffered output so far (replayed by the panel). */
export function subscribeConsoleOutput(l: OutputListener): { replay: string; off: () => void } {
  listeners.add(l);
  return { replay: buffer, off: () => listeners.delete(l) };
}

/** The panel registers how to paste into xterm (bracketed paste) and how to focus it. */
export function registerPasteBridge(bridge: PasteBridge | undefined, focus?: () => void): void {
  pasteBridge = bridge;
  focusBridge = bridge ? focus : undefined;
}

/** Pastes queued while Claude Code was starting (the panel flushes them once it is ready). */
export function flushPendingPastes(): number {
  let n = 0;
  if (!pasteBridge || useConsoleStore.getState().phase !== "running") return 0;
  while (pendingPastes.length) {
    const p = pendingPastes.shift()!;
    pasteBridge(p.text);
    if (p.submit) setTimeout(() => useConsoleStore.getState().input("\r"), 50 * (n + 1));
    n++;
  }
  return n;
}

export const hasPendingPastes = () => pendingPastes.length > 0;

/** Ctrl+Shift+C / palette: focus the terminal once the panel is visible. */
export function focusConsole(): void {
  setTimeout(() => focusBridge?.(), 30);
}

interface ConsoleStore extends ConsoleMachine {
  dispatch: (e: ConsoleEvent) => void;
  refreshStatus: (force?: boolean) => Promise<void>;
  start: (size?: { cols: number; rows: number }) => Promise<void>;
  restart: (size?: { cols: number; rows: number }) => Promise<void>;
  stop: () => void;
  /** Raw terminal input (keystrokes, already-bracketed pastes). */
  input: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  /** Paste through xterm (bracketed paste) or queue it until the panel is mounted. */
  paste: (text: string, submit?: boolean) => void;
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  const body = (await res.json().catch(() => undefined)) as
    (T & { error?: { message?: string } }) | undefined;
  if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  return body as T;
}

const wsUrl = (t: string) =>
  `${API_URL.replace(/^http/, "ws")}${CONSOLE_ROUTES.ws}?token=${encodeURIComponent(t)}`;

/** WebSocket factory (tests replace it). */
export const consoleTransport = {
  create: (url: string): WebSocket => new WebSocket(url),
};

export const useConsoleStore = create<ConsoleStore>()((set, get) => {
  const dispatch = (e: ConsoleEvent) => set((s) => consoleReducer(s, e));

  const closeSocket = () => {
    const ws = socket;
    socket = undefined;
    token = undefined;
    if (ws && ws.readyState <= 1) {
      try {
        ws.send(JSON.stringify({ type: "kill" }));
      } catch {
        // not open yet
      }
      ws.close();
    }
  };

  return {
    ...INITIAL_CONSOLE,
    dispatch,
    refreshStatus: async (force = false) => {
      try {
        const status = await getJson<ConsoleStatus>(
          `${CONSOLE_ROUTES.status}${force ? "?refresh=1" : ""}`,
        );
        dispatch({ type: "STATUS", status });
      } catch (err) {
        dispatch({
          type: "STATUS_FAILED",
          message: `No se pudo consultar la consola: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
    start: async (size) => {
      closeSocket();
      buffer = "";
      dispatch({ type: "START" });
      addBreadcrumb("ui", "Nueva sesión de la Consola Claude");
      let created: ConsoleStatus & { token: string };
      try {
        created = await getJson(CONSOLE_ROUTES.session, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(size ?? {}),
        });
      } catch (err) {
        dispatch({
          type: "FAILED",
          message: `No se pudo abrir la consola: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
      const { token: t, ...status } = created;
      dispatch({ type: "STATUS", status });
      set({ phase: "connecting" });
      token = t;
      const ws = consoleTransport.create(wsUrl(t));
      socket = ws;
      watchExternalApplies();
      ws.onmessage = (ev) => {
        if (socket !== ws) return;
        let msg: {
          type: string;
          data?: string;
          state?: string;
          message?: string;
          exitCode?: number;
        };
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.type === "output" && typeof msg.data === "string") emit(msg.data);
        else if (msg.type === "status" && msg.state)
          dispatch({
            type: "SERVER_STATUS",
            state: msg.state as "running" | "missing" | "exited" | "error",
            ...(msg.message && { message: msg.message }),
          });
        else if (msg.type === "exit") dispatch({ type: "EXIT", exitCode: msg.exitCode ?? 0 });
      };
      ws.onclose = (ev) => {
        if (socket !== ws) return;
        socket = undefined;
        dispatch({
          type: "CLOSED",
          ...(ev.code === 4401 && { message: "La sesión venció: tocá «Nueva sesión»" }),
        });
      };
      ws.onerror = () => {
        if (socket !== ws) return;
        dispatch({ type: "FAILED", message: "Falló la conexión con la consola (¿API detenida?)" });
      };
    },
    restart: async (size) => {
      await get().start(size);
    },
    stop: () => {
      closeSocket();
      dispatch({ type: "STOP" });
    },
    input: (data) => {
      if (socket?.readyState === 1) socket.send(JSON.stringify({ type: "input", data }));
    },
    resize: (cols, rows) => {
      if (socket?.readyState === 1) socket.send(JSON.stringify({ type: "resize", cols, rows }));
      else if (token)
        void fetch(`${API_URL}${CONSOLE_ROUTES.resize}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, cols, rows }),
        }).catch(() => undefined);
    },
    paste: (text, submit = false) => {
      if (!text) return;
      if (pasteBridge && get().phase === "running" && pendingPastes.length === 0) {
        pasteBridge(text);
        if (submit) setTimeout(() => get().input("\r"), 50);
      } else pendingPastes.push({ text, submit });
    },
  };
});

/** Paste text into the console from anywhere (also via the `studio:console:paste` event). */
export function pasteIntoConsole(text: string, submit = false): void {
  useConsoleStore.getState().paste(text, submit);
}

const PROJECT_JOBS = new Set(["agent.apply", "timeline.apply-cuts", "timeline.track-to-keyframes"]);
let unwatch: (() => void) | undefined;
const seen = new Set<string>();

/**
 * Plans applied from the console (studio_apply_plan) change the project in the api without the
 * web knowing: when such a job of the open project succeeds and no panel is awaiting it (no
 * intent), the project is re-read and adopted as one undo step, like the Asistente does.
 */
export function watchExternalApplies(): () => void {
  if (unwatch) return unwatch;
  const off = useJobsStore.subscribe((s) => {
    const projectId = useProjectStore.getState().project.id;
    for (const job of Object.values(s.jobs)) {
      if (seen.has(job.id) || job.status !== "succeeded" || !PROJECT_JOBS.has(job.type)) continue;
      if (job.projectId && job.projectId !== projectId) continue;
      seen.add(job.id);
      if (s.intents[job.id]) continue; // started by a panel: it reloads on its own
      void api
        .getProject(projectId)
        .then((remote) =>
          useProjectStore.getState().adoptServerProject(remote, "Consola Claude: aplicó cambios"),
        )
        .then(() => useMediaStore.getState().refresh())
        .catch(() => undefined);
    }
  });
  // Jobs already finished before the watcher started are not re-applied.
  for (const job of Object.values(useJobsStore.getState().jobs)) seen.add(job.id);
  unwatch = () => {
    off();
    unwatch = undefined;
  };
  return unwatch;
}

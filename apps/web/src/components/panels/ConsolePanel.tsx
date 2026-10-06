"use client";

import "@xterm/xterm/css/xterm.css";
import type { FitAddon } from "@xterm/addon-fit";
import type { ITheme, Terminal } from "@xterm/xterm";
import {
  ClipboardCopy,
  ClipboardPaste,
  Play,
  RotateCcw,
  Square,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge, ErrorNotice } from "@/components/ui/misc";
import { useResolvedTheme } from "@/hooks/use-apply-theme";
import {
  CONSOLE_PASTE_EVENT,
  CONSOLE_PROMPT_CHIPS,
  consoleLabels,
  flushPendingPastes,
  focusConsole,
  hasPendingPastes,
  registerPasteBridge,
  subscribeConsoleOutput,
  useConsoleStore,
  type ConsolePasteDetail,
} from "@/stores/console-store";
import { useSettingsStore } from "@/stores/settings-store";
import { showPanel } from "../dashboard/dock-controller";
import { Panel } from "./Panel";

/** Terminal colors matching the app theme (globals.css --background / --foreground). */
export function terminalTheme(mode: "light" | "dark", accent: string): ITheme {
  return mode === "dark"
    ? {
        background: "#171717",
        foreground: "#f2f2f2",
        cursor: accent,
        cursorAccent: "#171717",
        selectionBackground: "#ffffff40",
      }
    : {
        background: "#ffffff",
        foreground: "#1f1f1f",
        cursor: accent,
        cursorAccent: "#ffffff",
        selectionBackground: "#00000030",
        black: "#1f1f1f",
        brightBlack: "#6b6b6b",
        white: "#d4d4d4",
        brightWhite: "#f5f5f5",
        yellow: "#a16207",
        brightYellow: "#b45309",
      };
}

/**
 * Other panels (e.g. «Perfil de estilo» → «Deducir con Consola Claude») dispatch
 * `studio:console:paste` {text}: show the console, start a session if needed and paste.
 */
function onPasteEvent(ev: Event) {
  const detail = (ev as CustomEvent<ConsolePasteDetail>).detail;
  if (!detail?.text) return;
  showPanel("console");
  const store = useConsoleStore.getState();
  store.paste(detail.text, detail.submit);
  if (store.phase === "idle" || store.phase === "exited" || store.phase === "error")
    void store.start();
  focusConsole();
}
if (typeof window !== "undefined") {
  window.removeEventListener(CONSOLE_PASTE_EVENT, onPasteEvent);
  window.addEventListener(CONSOLE_PASTE_EVENT, onPasteEvent);
}

function Instructions() {
  const status = useConsoleStore((s) => s.status);
  const phase = useConsoleStore((s) => s.phase);
  if (!status) return null;
  if (!status.claudeInstalled || phase === "missing")
    return (
      <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
        <p className="font-medium">Claude Code no está instalado</p>
        <p>
          Instalalo una vez (necesita Node.js 22) y volvé a tocar «Nueva sesión». Usa tu suscripción
          de Claude.ai, sin API key:
        </p>
        <code className="block rounded bg-muted px-2 py-1">{status.installCommand}</code>
        <p>
          En Windows también podés correr <code>scripts\windows\setup.cmd</code> (instala Claude
          Code con <code>-WithClaude</code>). Después iniciá sesión con{" "}
          <code>{status.loginCommand}</code>.
        </p>
      </div>
    );
  if (status.loggedIn === false)
    return (
      <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
        <p className="font-medium">Falta iniciar sesión en Claude Code</p>
        <p>
          Escribí <code>/login</code> en la consola, o cerrala y corré{" "}
          <code>{status.loginCommand}</code> en esta terminal: se abre el navegador para entrar con
          tu cuenta de Claude.ai.
        </p>
      </div>
    );
  if (!status.mcpReady)
    return (
      <p className="rounded-md border p-2 text-xs text-muted-foreground">
        Las herramientas de Studio (studio-mcp) no están compiladas: corré{" "}
        <code>pnpm build:packages</code> (lo hace <code>setup.cmd</code>) para que Claude pueda leer
        y editar el proyecto.
      </p>
    );
  return null;
}

/** Panel «Consola Claude»: Claude Code CLI (suscripción, sin API key) en una terminal embebida. */
export function ConsolePanel() {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const phase = useConsoleStore((s) => s.phase);
  const message = useConsoleStore((s) => s.message);
  const sessionSeq = useConsoleStore((s) => s.sessionSeq);
  const status = useConsoleStore((s) => s.status);
  const labels = consoleLabels({ phase, status, sessionSeq });
  const resolved = useResolvedTheme();
  const accent = useSettingsStore((s) => s.accent);

  useEffect(() => {
    void useConsoleStore.getState().refreshStatus();
  }, []);

  // Create xterm once (browser only: dynamic import keeps it out of SSR).
  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || !hostRef.current) return;
      const term = new Terminal({
        cursorBlink: true,
        fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace',
        fontSize: 13,
        scrollback: 5000,
        allowProposedApi: false,
        theme: terminalTheme(
          document.documentElement.classList.contains("dark") ? "dark" : "light",
          accent,
        ),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      termRef.current = term;
      fitRef.current = fit;
      // Copy / paste: Ctrl+Shift+C (or Ctrl+C with a selection) copies; Ctrl+V / Ctrl+Shift+V
      // are left to the browser so xterm receives a real paste event (bracketed paste).
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;
        const ctrl = e.ctrlKey || e.metaKey;
        if (ctrl && (e.key === "c" || e.key === "C") && (e.shiftKey || term.hasSelection())) {
          const sel = term.getSelection();
          if (sel) void navigator.clipboard?.writeText(sel).catch(() => undefined);
          e.preventDefault();
          return false;
        }
        if (ctrl && (e.key === "v" || e.key === "V")) return false;
        return true;
      });
      const store = useConsoleStore.getState;
      const onData = term.onData((d) => store().input(d));
      const out = subscribeConsoleOutput((d) => term.write(d));
      if (out.replay) term.write(out.replay);
      registerPasteBridge(
        (text) => term.paste(text),
        () => term.focus(),
      );
      const doFit = () => {
        try {
          fit.fit();
          store().resize(term.cols, term.rows);
        } catch {
          // hidden tab (0×0)
        }
      };
      const ro = new ResizeObserver(() => doFit());
      ro.observe(hostRef.current);
      doFit();
      cleanup = () => {
        ro.disconnect();
        onData.dispose();
        out.off();
        registerPasteBridge(undefined);
        term.dispose();
        termRef.current = null;
        fitRef.current = null;
      };
    })();
    return () => {
      disposed = true;
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = terminalTheme(resolved, accent);
  }, [resolved, accent]);

  // New session → clean screen.
  useEffect(() => {
    if (sessionSeq > 0) termRef.current?.reset();
  }, [sessionSeq]);

  // Text pasted while Claude Code was starting: wait until its prompt is drawn.
  useEffect(() => {
    if (phase !== "running" || !hasPendingPastes()) return;
    const timer = setTimeout(() => flushPendingPastes(), 2500);
    return () => clearTimeout(timer);
  }, [phase]);

  const size = () =>
    termRef.current ? { cols: termRef.current.cols, rows: termRef.current.rows } : undefined;
  const start = () => {
    void useConsoleStore.getState().start(size());
    termRef.current?.focus();
  };
  const running = phase === "running" || phase === "connecting";

  const copy = async () => {
    const sel = termRef.current?.getSelection();
    if (!sel) return toast.message("Seleccioná texto en la consola para copiarlo");
    await navigator.clipboard?.writeText(sel);
    toast.success("Copiado");
  };
  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) termRef.current?.paste(text);
      termRef.current?.focus();
    } catch {
      toast.message("Usá Ctrl+V dentro de la consola para pegar");
    }
  };

  return (
    <Panel
      title="Consola Claude"
      bare
      toolbar={
        <>
          <TerminalSquare className="size-4 text-muted-foreground" aria-hidden />
          <Badge tone={labels.installed.startsWith("Instalado") ? "success" : "warning"}>
            {labels.installed}
          </Badge>
          <Badge
            tone={
              labels.login === "Sesión iniciada"
                ? "success"
                : labels.login === "Sin iniciar sesión"
                  ? "warning"
                  : "muted"
            }
          >
            {labels.login}
          </Badge>
          <Badge tone={phase === "running" ? "success" : phase === "error" ? "danger" : "muted"}>
            {labels.run}
          </Badge>
          <span className="flex-1" />
          {running ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => useConsoleStore.getState().restart(size())}
            >
              <RotateCcw /> Reiniciar
            </Button>
          ) : null}
          <Button size="xs" onClick={start} disabled={phase === "connecting"}>
            <Play /> Nueva sesión
          </Button>
          {running ? (
            <Button
              size="icon-sm"
              variant="ghost"
              tooltip="Cerrar la sesión"
              aria-label="Cerrar la sesión"
              onClick={() => useConsoleStore.getState().stop()}
            >
              <Square />
            </Button>
          ) : null}
          <Button
            size="icon-sm"
            variant="ghost"
            tooltip="Copiar selección"
            aria-label="Copiar selección"
            onClick={() => void copy()}
          >
            <ClipboardCopy />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            tooltip="Pegar"
            aria-label="Pegar"
            onClick={() => void paste()}
          >
            <ClipboardPaste />
          </Button>
        </>
      }
    >
      <div className="flex shrink-0 flex-col gap-1 border-b p-2">
        {phase === "error" && message ? <ErrorNotice message={message} /> : null}
        <Instructions />
        <div className="flex flex-wrap gap-1" aria-label="Pedidos sugeridos">
          {CONSOLE_PROMPT_CHIPS.map((p) => (
            <button
              key={p}
              type="button"
              className="rounded-full border px-2 py-0.5 text-xs hover:bg-accent"
              title="Pegar en la consola (revisalo y apretá Enter)"
              onClick={() => {
                const store = useConsoleStore.getState();
                store.paste(p);
                if (store.phase === "idle" || store.phase === "exited") start();
                termRef.current?.focus();
              }}
            >
              {p}
            </button>
          ))}
        </div>
      </div>
      <div
        ref={hostRef}
        data-testid="console-terminal"
        className="min-h-0 flex-1 overflow-hidden px-1 py-1"
        style={{ background: resolved === "dark" ? "#171717" : "#ffffff" }}
      />
      {phase === "idle" ? (
        <p className="shrink-0 border-t px-2 py-1 text-[11px] text-muted-foreground">
          Claude Code corre en tu PC con tu suscripción de Claude.ai (sin API key), en la carpeta de
          Studio, con las herramientas studio-mcp. Tocá «Nueva sesión» para empezar.
        </p>
      ) : null}
    </Panel>
  );
}

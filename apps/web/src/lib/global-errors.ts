import type { ClientError } from "@studio/shared";
import { addBreadcrumb } from "@/stores/breadcrumbs-store";

/** Browser noise that is not a bug of the app. */
const IGNORED = [/ResizeObserver loop/i, /^Script error\.?$/i];

let last: { error: ClientError; at: number } | undefined;

function remember(error: ClientError): void {
  last = { error, at: Date.now() };
}

export function toClientError(err: unknown, fallback = "Error desconocido"): ClientError {
  if (err instanceof Error)
    return {
      message: `${err.name}: ${err.message}`.slice(0, 2000),
      ...(err.stack && { stack: err.stack.slice(0, 20_000) }),
    };
  if (typeof err === "string") return { message: err.slice(0, 2000) };
  try {
    return { message: (JSON.stringify(err) ?? fallback).slice(0, 2000) };
  } catch {
    return { message: fallback };
  }
}

/** Last uncaught error of this tab if it happened in the last `maxAgeMs` (default 15 min). */
export function lastClientError(maxAgeMs = 15 * 60_000): ClientError | undefined {
  return last && Date.now() - last.at < maxAgeMs ? last.error : undefined;
}

/** Record a crash caught by the error boundary (so later reports include it). */
export function recordCrash(error: ClientError): void {
  remember(error);
}

/**
 * Capture window.onerror / unhandledrejection into the breadcrumbs (category "error").
 * Returns the uninstall function.
 */
export function installGlobalErrorCapture(): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onError = (event: ErrorEvent) => {
    const message = event.message || "Error de JavaScript";
    if (IGNORED.some((re) => re.test(message))) return;
    const error = event.error !== undefined ? toClientError(event.error) : { message };
    remember(error);
    addBreadcrumb("error", `Error JS: ${message}`, {
      ...(event.filename && { source: `${event.filename}:${event.lineno}:${event.colno}` }),
      ...(error.stack && { stack: error.stack.split("\n").slice(0, 6).join("\n") }),
    });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    const error = toClientError(event.reason, "Promesa rechazada");
    if (IGNORED.some((re) => re.test(error.message))) return;
    remember(error);
    addBreadcrumb("error", `Promesa rechazada sin manejar: ${error.message}`, {
      ...(error.stack && { stack: error.stack.split("\n").slice(0, 6).join("\n") }),
    });
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}

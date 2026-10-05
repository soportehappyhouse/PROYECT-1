import { AsyncLocalStorage } from "node:async_hooks";
import type { JobCommandRecord, JobDiagnostics } from "@studio/shared";

/** Max stderr lines kept per job (all processes / worker errors combined). */
export const STDERR_TAIL_LINES = 200;
const MAX_COMMANDS = 50;
const MAX_COMMAND_CHARS = 8000;
const MAX_LINE_CHARS = 2000;

export interface CommandHandle {
  /** Mark the command finished (exit code / HTTP status; null when it never started). */
  end(exitCode: number | null, error?: string): void;
}

/**
 * Collects what a job did: every external command (ffmpeg, worker HTTP call) with timings and the
 * last stderr lines. One recorder per job execution, reachable from anywhere in the job's async
 * call tree via AsyncLocalStorage (runFfmpeg, runProcess and the workers client record into it),
 * so handlers need no changes. Persisted in jobs.diagnostics when the job ends.
 */
export class JobDiagnosticsRecorder {
  readonly commands: JobCommandRecord[] = [];
  readonly stderr: string[] = [];

  command(kind: JobCommandRecord["kind"], command: string, cwd?: string): CommandHandle {
    const t0 = Date.now();
    const record: JobCommandRecord = {
      kind,
      command:
        command.length > MAX_COMMAND_CHARS ? `${command.slice(0, MAX_COMMAND_CHARS)}…` : command,
      ...(cwd && { cwd }),
      startedAt: new Date(t0).toISOString(),
    };
    this.commands.push(record);
    if (this.commands.length > MAX_COMMANDS)
      this.commands.splice(0, this.commands.length - MAX_COMMANDS);
    return {
      end: (exitCode, error) => {
        record.durationMs = Date.now() - t0;
        record.exitCode = exitCode;
        if (error) record.error = error.slice(0, MAX_LINE_CHARS);
      },
    };
  }

  stderrLine(line: string): void {
    for (const l of line.split(/\r?\n/)) {
      if (!l.trim()) continue;
      this.stderr.push(l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}…` : l);
    }
    if (this.stderr.length > STDERR_TAIL_LINES)
      this.stderr.splice(0, this.stderr.length - STDERR_TAIL_LINES);
  }

  snapshot(timing: { createdAt: string; startedAt?: string; finishedAt?: string }): JobDiagnostics {
    const created = Date.parse(timing.createdAt);
    const started = timing.startedAt ? Date.parse(timing.startedAt) : undefined;
    const finished = timing.finishedAt ? Date.parse(timing.finishedAt) : undefined;
    return {
      commands: this.commands.map((c) => ({ ...c })),
      stderrTail: [...this.stderr],
      timings: {
        ...(started !== undefined && { queuedMs: Math.max(0, started - created) }),
        ...(started !== undefined &&
          finished !== undefined && { runMs: Math.max(0, finished - started) }),
        ...(timing.startedAt && { startedAt: timing.startedAt }),
        ...(timing.finishedAt && { finishedAt: timing.finishedAt }),
      },
    };
  }
}

const storage = new AsyncLocalStorage<JobDiagnosticsRecorder>();

/** Run `fn` with `recorder` as the current job recorder. */
export function runWithDiagnostics<T>(recorder: JobDiagnosticsRecorder, fn: () => T): T {
  return storage.run(recorder, fn);
}

/** Recorder of the job currently executing (undefined outside jobs, e.g. HTTP routes). */
export function currentDiagnostics(): JobDiagnosticsRecorder | undefined {
  return storage.getStore();
}

/** Shell-like rendering of a command line, quoting args with spaces or special characters. */
export function formatCommand(bin: string, args: readonly string[]): string {
  const quote = (a: string) =>
    a === "" ? '""' : /[\s"'`$&|;<>()*?!]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
  return [bin, ...args].map(quote).join(" ");
}

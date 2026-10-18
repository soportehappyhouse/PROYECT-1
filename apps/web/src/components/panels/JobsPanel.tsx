"use client";

import { formatEtaEs, isStalled, type Job, type JobProgressUnit } from "@studio/shared";
import { Bug, ChevronDown, ChevronRight, Eraser, ExternalLink, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge, EmptyState, NotImplementedNotice, Progress } from "@/components/ui/misc";
import { hasGpuFallback } from "@/lib/ai";
import { errorCode, errorMessage, fileUrl } from "@/lib/api";
import {
  isTerminal,
  JOB_STATUS_LABELS,
  jobLabel,
  jobOutputPath,
  sortedJobs,
  useJobsStore,
  type JobsConnection,
} from "@/stores/jobs-store";
import { openReport } from "@/stores/report-store";
import { Panel } from "./Panel";

const CONNECTION_LABELS: Record<
  JobsConnection,
  { label: string; tone: "success" | "warning" | "muted" | "danger" }
> = {
  connecting: { label: "Conectando…", tone: "muted" },
  live: { label: "En vivo", tone: "success" },
  polling: { label: "Consulta periódica", tone: "warning" },
  "not-implemented": { label: "En desarrollo", tone: "warning" },
  offline: { label: "Sin conexión", tone: "danger" },
};

const STATUS_TONE: Record<Job["status"], "default" | "success" | "warning" | "danger" | "muted"> = {
  queued: "muted",
  running: "default",
  succeeded: "success",
  failed: "danger",
  canceled: "warning",
};

const UNIT_LABELS: Record<JobProgressUnit, string> = {
  items: "",
  blocks: " bloques",
  frames: " cuadros",
  seconds: " s",
  bytes: "",
  commands: " comandos",
};

const NOT_CANCELLABLE_ES = "Este trabajo termina en segundos y no se puede cancelar.";

/** Re-render every second while something runs (ETA countdown, «sin avance»). */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** «3/20 comandos», «1,2 / 4,5 GB». */
export function formatCount(done: number, total: number, unit?: JobProgressUnit): string {
  if (unit === "bytes") {
    const gb = (n: number) => (n / 1e9).toFixed(1).replace(".", ",");
    return `${gb(done)} / ${gb(total)} GB`;
  }
  return `${done}/${total}${unit ? UNIT_LABELS[unit] : ""}`;
}

/** ETA left now: the api's eta_s minus the time since it was computed (never below 0). */
export function liveEtaS(job: Pick<Job, "detail">, receivedAt: number, now: number): number | null {
  const eta = job.detail?.eta_s;
  if (eta === null || eta === undefined) return null;
  return Math.max(0, eta - Math.max(0, now - receivedAt) / 1000);
}

function JobRow({ job, now }: { job: Job; now: number }) {
  const path = jobOutputPath(job);
  const detail = job.detail;
  const [open, setOpen] = useState(false);
  // When this row got the current ETA (re-set every time the api sends a new one).
  const [received, setReceived] = useState(() => Date.now());
  useEffect(() => setReceived(Date.now()), [detail?.eta_s, job.progress]);
  const active = !isTerminal(job);
  const cancellable = detail?.cancellable !== false;
  const stalled = active && (detail?.stalled || isStalled(detail?.progressAt, now));
  const cpu = hasGpuFallback(job.result);
  const cancel = () =>
    void useJobsStore
      .getState()
      .cancel(job.id)
      .catch((err: unknown) =>
        toast.error("No se pudo cancelar", {
          description:
            errorCode(err) === "JOB_NOT_CANCELLABLE" ? NOT_CANCELLABLE_ES : errorMessage(err),
        }),
      );
  const stage = detail?.stage_es ?? (active ? job.message : undefined);
  const count =
    detail?.done !== undefined && detail.total !== undefined
      ? formatCount(detail.done, detail.total, detail.unit)
      : undefined;
  return (
    <li className="rounded-md border p-2 text-xs" data-testid="job-row" data-status={job.status}>
      <div className="flex items-center gap-2">
        <span className="font-medium">{jobLabel(job)}</span>
        <Badge tone={STATUS_TONE[job.status]}>{JOB_STATUS_LABELS[job.status]}</Badge>
        {cpu ? (
          <Badge tone="warning" title="Corrió en la CPU (la GPU no tenía memoria libre)">
            CPU
          </Badge>
        ) : null}
        <span className="ml-auto text-[11px] text-muted-foreground">
          {new Date(job.createdAt).toLocaleTimeString("es")}
        </span>
        {active ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Cancelar trabajo"
            data-testid="job-cancel"
            tip="jobCancel"
            disabled={!cancellable}
            disabledReason={NOT_CANCELLABLE_ES}
            onClick={cancel}
          >
            <X />
          </Button>
        ) : null}
        {job.status === "failed" ? (
          <Button
            size="xs"
            variant="outline"
            aria-label="Reportar error de este trabajo"
            tip="jobReport"
            onClick={() =>
              openReport({
                title: `Falló: ${jobLabel(job)}`,
                jobIds: [job.id],
                source: "trabajos",
              })
            }
          >
            <Bug /> Reportar
          </Button>
        ) : null}
        {path ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Abrir resultado"
            tip="jobOpen"
            onClick={() => window.open(fileUrl(path), "_blank")}
          >
            <ExternalLink />
          </Button>
        ) : null}
      </div>
      {active ? (
        <>
          <div className="mt-1 flex items-center gap-2">
            <Progress
              value={job.progress}
              className={job.status === "queued" ? "animate-pulse" : ""}
            />
            <span className="w-9 text-right tabular-nums">{Math.round(job.progress * 100)}%</span>
          </div>
          <p className="mt-1 flex flex-wrap gap-x-2 text-muted-foreground" data-testid="job-detail">
            {stage ? <span data-testid="job-stage">{stage}</span> : null}
            {count ? (
              <span className="tabular-nums" data-testid="job-count">
                {count}
              </span>
            ) : null}
            {job.status === "running" ? (
              <span data-testid="job-eta">{formatEtaEs(liveEtaS(job, received, now))}</span>
            ) : (
              <span>En espera</span>
            )}
            {stalled ? (
              <span className="text-amber-600" data-testid="job-stalled">
                sin avance hace 2 min
              </span>
            ) : null}
          </p>
        </>
      ) : null}
      {job.status === "failed" && job.error ? (
        <div className="mt-1">
          <button
            type="button"
            className="flex items-start gap-1 text-left text-destructive"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? (
              <ChevronDown className="mt-0.5 size-3 shrink-0" />
            ) : (
              <ChevronRight className="mt-0.5 size-3 shrink-0" />
            )}
            <span className={open ? "whitespace-pre-wrap break-words" : "line-clamp-2"}>
              {job.error}
            </span>
          </button>
        </div>
      ) : null}
    </li>
  );
}

export function JobsPanel() {
  const jobs = useJobsStore((s) => s.jobs);
  const connection = useJobsStore((s) => s.connection);
  const { running, finished } = useMemo(() => {
    const all = sortedJobs(jobs);
    return { running: all.filter((j) => !isTerminal(j)), finished: all.filter(isTerminal) };
  }, [jobs]);
  const now = useNow(running.length > 0);
  const conn = CONNECTION_LABELS[connection];

  return (
    <Panel
      title="Trabajos"
      toolbar={
        <>
          <Badge tone={conn.tone}>{conn.label}</Badge>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label="Recargar trabajos"
            tip="jobsReload"
            onClick={() =>
              void useJobsStore
                .getState()
                .refresh()
                .catch(() => undefined)
            }
          >
            <RefreshCw />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Limpiar terminados"
            tip="jobsClear"
            disabled={finished.length === 0}
            onClick={() => useJobsStore.getState().dismissFinished()}
          >
            <Eraser />
          </Button>
        </>
      }
    >
      {connection === "not-implemented" ? (
        <NotImplementedNotice what="El seguimiento de trabajos" />
      ) : null}
      {running.length === 0 && finished.length === 0 ? (
        <EmptyState>
          No hay trabajos. Lo que tarda (transcribir, exportar, quitar el fondo…) aparece acá con su
          avance, el tiempo que falta y el botón Cancelar.
        </EmptyState>
      ) : null}
      {running.length > 0 ? (
        <section aria-label="En curso" data-testid="jobs-running">
          <h3 className="mb-1 text-[11px] font-medium text-muted-foreground">
            En curso ({running.length})
          </h3>
          <ul className="flex flex-col gap-1">
            {running.map((j) => (
              <JobRow key={j.id} job={j} now={now} />
            ))}
          </ul>
        </section>
      ) : null}
      {finished.length > 0 ? (
        <section aria-label="Terminados" className="mt-2" data-testid="jobs-finished">
          <h3 className="mb-1 text-[11px] font-medium text-muted-foreground">
            Terminados ({finished.length})
          </h3>
          <ul className="flex flex-col gap-1">
            {finished.map((j) => (
              <JobRow key={j.id} job={j} now={now} />
            ))}
          </ul>
        </section>
      ) : null}
    </Panel>
  );
}

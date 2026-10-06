"use client";

import type { Job } from "@studio/shared";
import { Bug, ExternalLink, Eraser, RefreshCw, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge, EmptyState, NotImplementedNotice, Progress, Tabs } from "@/components/ui/misc";
import { errorMessage, fileUrl } from "@/lib/api";
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

function JobRow({ job }: { job: Job }) {
  const path = jobOutputPath(job);
  const cancel = () =>
    void useJobsStore
      .getState()
      .cancel(job.id)
      .catch((err: unknown) =>
        toast.error("No se pudo cancelar", { description: errorMessage(err) }),
      );
  return (
    <li className="rounded-md border p-2 text-xs" data-testid="job-row">
      <div className="flex items-center gap-2">
        <span className="font-medium">{jobLabel(job)}</span>
        <Badge tone={STATUS_TONE[job.status]}>{JOB_STATUS_LABELS[job.status]}</Badge>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {new Date(job.createdAt).toLocaleTimeString("es")}
        </span>
        {!isTerminal(job) ? (
          <Button size="icon-sm" variant="ghost" aria-label="Cancelar trabajo" onClick={cancel}>
            <X />
          </Button>
        ) : null}
        {job.status === "failed" ? (
          <Button
            size="xs"
            variant="outline"
            aria-label="Reportar error de este trabajo"
            title="Generar un reporte con el comando y la salida de error de este trabajo"
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
            onClick={() => window.open(fileUrl(path), "_blank")}
          >
            <ExternalLink />
          </Button>
        ) : null}
      </div>
      {job.status === "running" || job.status === "queued" ? (
        <div className="mt-1 flex items-center gap-2">
          <Progress value={job.progress} />
          <span className="w-9 text-right tabular-nums">{Math.round(job.progress * 100)}%</span>
        </div>
      ) : null}
      {job.message && !isTerminal(job) ? (
        <p className="mt-1 text-muted-foreground">{job.message}</p>
      ) : null}
      {job.status === "failed" && job.error ? (
        <p className="mt-1 text-destructive">{job.error}</p>
      ) : null}
    </li>
  );
}

export function JobsPanel() {
  const jobs = useJobsStore((s) => s.jobs);
  const connection = useJobsStore((s) => s.connection);
  const [filter, setFilter] = useState<"active" | "all">("all");
  const list = useMemo(() => {
    const all = sortedJobs(jobs);
    return filter === "active" ? all.filter((j) => !isTerminal(j)) : all;
  }, [jobs, filter]);
  const conn = CONNECTION_LABELS[connection];

  return (
    <Panel
      title="Trabajos"
      toolbar={
        <>
          <Tabs
            className="w-48"
            value={filter}
            onChange={setFilter}
            items={[
              { value: "all", label: "Todos" },
              { value: "active", label: "Activos" },
            ]}
          />
          <Badge tone={conn.tone}>{conn.label}</Badge>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label="Recargar trabajos"
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
      {list.length === 0 ? <EmptyState>No hay trabajos.</EmptyState> : null}
      <ul className="flex flex-col gap-1">
        {list.map((j) => (
          <JobRow key={j.id} job={j} />
        ))}
      </ul>
    </Panel>
  );
}

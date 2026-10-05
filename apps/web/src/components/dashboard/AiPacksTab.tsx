"use client";

import { Download, Gauge, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Badge,
  EmptyState,
  ErrorNotice,
  NotImplementedNotice,
  Progress,
  Section,
  Spinner,
} from "@/components/ui/misc";
import { featureLabel, formatDuration, perfEstimates } from "@/lib/ai";
import { packState, type PackInfo, type PackState, type PerfResult } from "@/lib/ai-types";
import { aiApi, ApiRequestError, errorMessage, isNotImplemented } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { runJob } from "@/lib/job-runner";
import { isTerminal, useJobsStore } from "@/stores/jobs-store";
import { usePacksStore } from "@/stores/packs-store";

const STATE_LABELS: Record<PackState, { label: string; tone: "success" | "warning" | "muted" }> = {
  installed: { label: "Instalado", tone: "success" },
  partial: { label: "Incompleto", tone: "warning" },
  missing: { label: "Falta", tone: "muted" },
};

function PackRow({ pack, queuePos }: { pack: PackInfo; queuePos: number | undefined }) {
  const jobId = usePacksStore((s) => s.downloads[pack.id]);
  const requestError = usePacksStore((s) => s.downloadErrors[pack.id]);
  const job = useJobsStore((s) => (jobId ? s.jobs[jobId] : undefined));
  const state = packState(pack);
  const active = !!job && !isTerminal(job);
  const failed = job?.status === "failed" ? (job.error ?? "La descarga falló") : undefined;
  const error = requestError ?? failed;
  const s = STATE_LABELS[state];

  return (
    <tr className="border-t align-top" data-testid="pack-row" data-pack-id={pack.id}>
      <td className="py-1.5 pr-2">
        <span className="block font-medium">{pack.name_es}</span>
        {pack.description_es ? (
          <span className="block text-[11px] text-muted-foreground">{pack.description_es}</span>
        ) : null}
        {active ? (
          <div className="mt-1">
            <Progress
              value={job.progress}
              className={job.status === "queued" ? "animate-pulse" : ""}
            />
            <span className="text-[11px] text-muted-foreground">
              {job.status === "queued"
                ? `En cola${queuePos ? ` (${queuePos}.º)` : ""}`
                : `${Math.round(job.progress * 100)} %${job.message ? ` · ${job.message}` : ""}`}
            </span>
          </div>
        ) : null}
        {error ? <span className="block text-[11px] text-destructive">{error}</span> : null}
      </td>
      <td className="py-1.5 pr-2">
        <Badge tone={s.tone}>{s.label}</Badge>
      </td>
      <td className="py-1.5 pr-2 whitespace-nowrap tabular-nums">{formatBytes(pack.size_bytes)}</td>
      <td className="py-1.5 pr-2 text-[11px]">
        {pack.required_by.map(featureLabel).join(", ") || "—"}
      </td>
      <td className="py-1.5 text-right">
        <Button
          size="xs"
          variant={state === "installed" ? "ghost" : "outline"}
          disabled={active}
          tooltip={
            state === "installed"
              ? "Comprueba los archivos y vuelve a bajar los que falten o estén dañados"
              : state === "partial"
                ? "Continúa la descarga donde quedó"
                : `Descargar ${formatBytes(pack.size_bytes)}`
          }
          onClick={() => void usePacksStore.getState().startDownload(pack.id)}
        >
          {active ? (
            <Spinner className="size-3" />
          ) : state === "installed" ? (
            <ShieldCheck />
          ) : error ? (
            <RefreshCw />
          ) : (
            <Download />
          )}
          {state === "installed" ? "Verificar" : state === "partial" ? "Completar" : "Descargar"}
        </Button>
      </td>
    </tr>
  );
}

function PerfSection() {
  const [result, setResult] = useState<PerfResult | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    aiApi
      .lastPerf()
      .then(setResult)
      .catch(() => undefined); // 404: never ran.
  }, []);

  const run = async () => {
    setRunning(true);
    setError(undefined);
    try {
      const r = await runJob(() => aiApi.runPerf(), "perf.run");
      // The job may answer only {path}: read storage/run/perf.json through the api then.
      setResult(r && "ran_at" in r ? r : await aiApi.lastPerf());
    } catch (err) {
      setError(
        isNotImplemented(err) || (err instanceof ApiRequestError && err.status === 404)
          ? "El test de rendimiento todavía no está disponible en la API."
          : errorMessage(err),
      );
    } finally {
      setRunning(false);
    }
  };

  const num = (v: number | null | undefined, unit: string) =>
    v == null ? "—" : `${v.toFixed(v < 10 ? 2 : 1).replace(".", ",")} ${unit}`;

  return (
    <Section
      title="Test de rendimiento IA"
      actions={
        <Button size="xs" variant="outline" disabled={running} onClick={() => void run()}>
          {running ? <Spinner className="size-3" /> : <Gauge />}
          {running ? "Midiendo…" : "Test de rendimiento IA"}
        </Button>
      }
    >
      <p className="text-[11px] text-muted-foreground">
        Mide en esta PC cuánto tardan Whisper, Piper, RVC y la detección de escenas (un par de
        minutos). Los tiempos se guardan y se usan para estimar cada tarea.
      </p>
      {error ? <ErrorNotice message={error} /> : null}
      {result ? (
        <div className="grid gap-3 sm:grid-cols-2" data-testid="perf-results">
          <table className="text-xs">
            <tbody>
              <tr>
                <td className="pr-2 text-muted-foreground">GPU</td>
                <td>
                  {typeof result.gpu === "string" ? result.gpu : result.gpu ? "Sí" : "No (CPU)"}
                </td>
              </tr>
              <tr>
                <td className="pr-2 text-muted-foreground">Whisper turbo</td>
                <td>{num(result.whisper_turbo_s_per_min, "s por min")}</td>
              </tr>
              <tr>
                <td className="pr-2 text-muted-foreground">Piper</td>
                <td>{num(result.piper_s_per_100chars, "s por 100 caracteres")}</td>
              </tr>
              <tr>
                <td className="pr-2 text-muted-foreground">RVC</td>
                <td>{num(result.rvc_s_per_min, "s por min")}</td>
              </tr>
              <tr>
                <td className="pr-2 text-muted-foreground">Escenas</td>
                <td>{num(result.scenes_fps, "fps")}</td>
              </tr>
              <tr>
                <td className="pr-2 text-muted-foreground">Respaldo en CPU</td>
                <td>{result.cpu_fallback_ok ? "Funciona" : "Falló"}</td>
              </tr>
              <tr>
                <td className="pr-2 text-muted-foreground">Medido</td>
                <td>{new Date(result.ran_at).toLocaleString("es")}</td>
              </tr>
            </tbody>
          </table>
          <ul className="flex flex-col gap-1 text-xs">
            {perfEstimates(result).map((e) => (
              <li key={e.label} className="rounded-md bg-muted px-2 py-1">
                {e.label} ≈ <strong>{formatDuration(e.seconds)}</strong>
              </li>
            ))}
          </ul>
        </div>
      ) : !error ? (
        <EmptyState>Todavía no se midió el rendimiento en esta PC.</EmptyState>
      ) : null}
    </Section>
  );
}

/** Ajustes → «Paquetes de IA»: packs state + downloads (one at a time) + performance test. */
export function AiPacksTab() {
  const packs = usePacksStore((s) => s.packs);
  const status = usePacksStore((s) => s.status);
  const error = usePacksStore((s) => s.error);
  const downloads = usePacksStore((s) => s.downloads);
  const jobs = useJobsStore((s) => s.jobs);

  useEffect(() => {
    void usePacksStore.getState().load();
  }, []);

  // Sequential queue: the running download first, then the queued ones by creation time.
  const queue = Object.entries(downloads)
    .map(([packId, jobId]) => ({ packId, job: jobs[jobId] }))
    .filter((d) => d.job && !isTerminal(d.job))
    .sort((a, b) => a.job!.createdAt.localeCompare(b.job!.createdAt));
  const running = queue.filter((d) => d.job!.status === "running").length;
  const waiting = queue.filter((d) => d.job!.status === "queued");
  const total = packs.reduce((n, p) => n + p.size_bytes, 0);
  const installed = packs.filter((p) => p.installed).reduce((n, p) => n + p.size_bytes, 0);

  return (
    <div className="flex flex-col gap-5">
      <Section
        title="Paquetes de IA"
        actions={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Actualizar lista de paquetes"
            onClick={() => void usePacksStore.getState().load()}
          >
            <RefreshCw />
          </Button>
        }
      >
        <p className="text-[11px] text-muted-foreground">
          Cada función de IA baja su modelo la primera vez que la usás. Las descargas van de a una,
          se pueden reanudar y se verifican al terminar.
          {packs.length > 0
            ? ` Instalado: ${formatBytes(installed)} de ${formatBytes(total)}.`
            : ""}
        </p>
        {queue.length > 0 ? (
          <p
            className="rounded-md bg-primary/10 px-2 py-1 text-xs"
            aria-live="polite"
            data-testid="pack-queue"
          >
            Cola de descargas: {running} en curso
            {waiting.length > 0 ? `, ${waiting.length} en espera` : ""} (una a la vez).
          </p>
        ) : null}
        {status === "not-implemented" ? <NotImplementedNotice what="La lista de paquetes" /> : null}
        {status === "error" && error ? <ErrorNotice message={error} /> : null}
        {status === "loading" ? <Spinner /> : null}
        {packs.length > 0 ? (
          <table className="w-full text-left text-xs">
            <thead className="text-[11px] text-muted-foreground">
              <tr>
                <th className="pb-1 font-medium">Paquete</th>
                <th className="pb-1 font-medium">Estado</th>
                <th className="pb-1 font-medium">Tamaño</th>
                <th className="pb-1 font-medium">Lo usa</th>
                <th className="pb-1" />
              </tr>
            </thead>
            <tbody>
              {packs.map((p) => {
                const pos = waiting.findIndex((w) => w.packId === p.id);
                return (
                  <PackRow
                    key={p.id}
                    pack={p}
                    queuePos={pos >= 0 ? pos + 1 + running : undefined}
                  />
                );
              })}
            </tbody>
          </table>
        ) : status === "ready" ? (
          <EmptyState>La API no informó paquetes.</EmptyState>
        ) : null}
      </Section>
      <PerfSection />
    </div>
  );
}

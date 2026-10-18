"use client";

import { formatEtaEs, type Job } from "@studio/shared";
import { Download, FlaskConical, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Label, Range, Select } from "@/components/ui/input";
import {
  Badge,
  EmptyState,
  ErrorNotice,
  NotImplementedNotice,
  Progress,
  Section,
  Spinner,
} from "@/components/ui/misc";
import { useAiAvailability } from "@/hooks/use-ai-availability";
import { formatLatency, formatRate } from "@/lib/agent";
import {
  AGENT_PACK_ID,
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_MODELS,
  isLlamaModel,
} from "@/lib/agent-types";
import { useAgentStore } from "@/stores/agent-store";
import { isTerminal, useJobsStore } from "@/stores/jobs-store";
import { usePacksStore } from "@/stores/packs-store";

/** Models in the select: defaults + installed + the current choice, without repeats. */
export function modelOptions(installed: readonly string[], current: string | undefined): string[] {
  return [...new Set([...DEFAULT_AGENT_MODELS, ...installed, ...(current ? [current] : [])])];
}

function DownloadModel() {
  const jobId = usePacksStore((s) => s.downloads[AGENT_PACK_ID]);
  const requestError = usePacksStore((s) => s.downloadErrors[AGENT_PACK_ID]);
  const job = useJobsStore((s) => (jobId ? s.jobs[jobId] : undefined));
  const active = !!job && !isTerminal(job);
  return (
    <div className="flex flex-col gap-1">
      <Button
        size="xs"
        variant="outline"
        className="self-start"
        disabled={active}
        onClick={() => void usePacksStore.getState().startDownload(AGENT_PACK_ID)}
      >
        {active ? <Spinner className="size-3" /> : <Download />} Descargar modelo
      </Button>
      {active ? (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Progress value={job.progress} />
          <span className="w-9 text-right tabular-nums">{Math.round(job.progress * 100)}%</span>
        </div>
      ) : null}
      {job?.status === "failed" || requestError ? (
        <span className="text-[11px] text-destructive">
          {requestError ?? job?.error ?? "La descarga falló"}
        </span>
      ) : null}
    </div>
  );
}

/** Running «Evaluar modelos»: «qwen3:8b · 17/20», bar, ETA and Cancelar (Sprint 5). */
function EvalProgress({ job }: { job: Job }) {
  const d = job.detail;
  return (
    <div className="flex flex-col gap-1 text-[11px]" data-testid="eval-progress" aria-live="polite">
      <div className="flex items-center gap-2">
        <Progress value={job.progress} />
        <span className="w-9 text-right tabular-nums">{Math.round(job.progress * 100)}%</span>
        <Button
          size="xs"
          variant="outline"
          tip="jobCancel"
          data-testid="eval-cancel"
          onClick={() =>
            void useJobsStore
              .getState()
              .cancel(job.id)
              .catch(() => undefined)
          }
        >
          <X /> Cancelar
        </Button>
      </div>
      <span className="text-muted-foreground">
        {d?.stage_es ?? job.message ?? "Preparando…"} · {formatEtaEs(d?.eta_s ?? null)}
        {d?.stalled ? " · sin avance hace 2 min" : ""}
      </span>
    </div>
  );
}

/** Ajustes → «Asistente local»: model, temperature, model download and the eval table. */
export function AssistantTab() {
  const status = useAgentStore((s) => s.status);
  const statusLoad = useAgentStore((s) => s.statusLoad);
  const settings = useAgentStore((s) => s.settings);
  const results = useAgentStore((s) => s.evalResults);
  const running = useAgentStore((s) => s.evalRunning);
  const evalError = useAgentStore((s) => s.evalError);
  const evalJobId = useAgentStore((s) => s.evalJobId);
  const evalJob = useJobsStore((s) => (evalJobId ? s.jobs[evalJobId] : undefined));
  const evalAvailability = useAiAvailability("ollama");
  const { setModel, setTemperature, runEval, loadStatus } = useAgentStore.getState();
  const installed = status?.models_installed ?? [];
  const current = settings.model ?? status?.model ?? DEFAULT_AGENT_MODEL;

  useEffect(() => {
    const s = useAgentStore.getState();
    void s.loadStatus();
    void s.loadLastEval();
  }, []);

  return (
    <div className="flex flex-col gap-5">
      <Section
        title="Asistente local"
        actions={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Comprobar el estado del asistente"
            onClick={() => void loadStatus()}
          >
            <RefreshCw />
          </Button>
        }
      >
        <p className="flex items-start gap-1 text-[11px] text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-600" aria-hidden />
          El asistente corre 100 % en tu PC con Ollama: no usa claves ni manda tu proyecto a ningún
          servicio externo.
        </p>
        {statusLoad === "not-implemented" ? <NotImplementedNotice what="El asistente" /> : null}
        {status ? (
          <p className="text-xs">
            Ollama:{" "}
            <Badge tone={status.ollama ? "success" : "danger"}>
              {status.ollama ? "en marcha" : "no encontrado"}
            </Badge>{" "}
            Modelo:{" "}
            <Badge tone={status.ready ? "success" : "warning"}>
              {status.ready ? "listo" : "falta"}
            </Badge>
            {status.hint_es ? (
              <span className="mt-1 block text-[11px] text-muted-foreground">{status.hint_es}</span>
            ) : null}
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Label>
            Modelo
            <Select
              aria-label="Modelo del asistente"
              value={current}
              onChange={(e) =>
                setModel(e.target.value === DEFAULT_AGENT_MODEL ? undefined : e.target.value)
              }
            >
              {modelOptions(installed, settings.model).map((m) => (
                <option key={m} value={m}>
                  {m}
                  {m === DEFAULT_AGENT_MODEL ? " (recomendado)" : ""}
                  {installed.includes(m) ? " · instalado" : " · sin descargar"}
                </option>
              ))}
            </Select>
          </Label>
          <Label>
            Temperatura: {settings.temperature.toFixed(2).replace(".", ",")}
            <Range
              aria-label="Temperatura"
              min={0}
              max={1}
              step={0.05}
              value={settings.temperature}
              onChange={(e) => setTemperature(Number(e.target.value))}
            />
            <span className="text-[10px] font-normal">
              Más baja = respuestas más predecibles (recomendado 0,2).
            </span>
          </Label>
        </div>
        {isLlamaModel(current) ? (
          <p className="text-[11px] text-muted-foreground" data-testid="built-with-llama">
            <Badge tone="muted">Built with Llama</Badge> {current} deriva de Llama 3.1 (Llama 3.1
            Community License, uso personal OK).
          </p>
        ) : null}
        <DownloadModel />
      </Section>
      <Section
        title="Evaluar modelos"
        actions={
          <div className="flex items-center gap-1">
            <Button
              size="xs"
              variant="outline"
              data-testid="eval-quick"
              disabled={running || !evalAvailability.enabled}
              disabledReason={
                running ? "Ya hay una evaluación en curso." : evalAvailability.reason_es
              }
              tooltip="Rápida: 20 comandos variados por modelo (unos minutos)"
              onClick={() => void runEval(installed.length ? installed : [current], "quick")}
            >
              {running ? <Spinner className="size-3" /> : <FlaskConical />}
              {running ? "Evaluando…" : "Rápida (20)"}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              data-testid="eval-full"
              disabled={running || !evalAvailability.enabled}
              disabledReason={
                running ? "Ya hay una evaluación en curso." : evalAvailability.reason_es
              }
              tooltip="Completa: los 80 comandos de prueba por modelo (puede tardar 10–20 min)"
              onClick={() => void runEval(installed.length ? installed : [current], "full")}
            >
              Completa (80)
            </Button>
          </div>
        }
      >
        <p className="text-[11px] text-muted-foreground">
          Mide con cada modelo instalado si el plan es válido, si es el correcto (también solo entre
          los pedidos que tienen operaciones) y cuánto tarda. La rápida usa 20 comandos variados; la
          completa, los 80. Podés cancelarla cuando quieras: Ollama deja de generar al instante.
        </p>
        {evalJob && !isTerminal(evalJob) ? <EvalProgress job={evalJob} /> : null}
        {evalError ? <ErrorNotice message={evalError} /> : null}
        {results.length > 0 ? (
          <table className="w-full text-left text-xs" data-testid="agent-eval">
            <thead className="text-[11px] text-muted-foreground">
              <tr>
                <th className="pb-1 font-medium">Modelo</th>
                <th className="pb-1 font-medium">Válido</th>
                <th className="pb-1 font-medium">Correcto</th>
                <th className="pb-1 font-medium" title="Solo los pedidos con operaciones">
                  Correcto (con ops)
                </th>
                <th className="pb-1 font-medium">Latencia p50</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.model} className="border-t">
                  <td className="py-1 font-mono">{r.model}</td>
                  <td className="py-1 tabular-nums">
                    {formatRate(r.schema_valid_rate ?? r.valid_json_rate)}
                  </td>
                  <td className="py-1 tabular-nums">
                    {formatRate(r.semantic_rate ?? r.exact_ops_rate)}
                  </td>
                  <td className="py-1 tabular-nums">{formatRate(r.semantic_rate_ops_only)}</td>
                  <td className="py-1 tabular-nums">{formatLatency(r.p50_latency_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : !evalError && !running ? (
          <EmptyState>Todavía no se evaluaron modelos en esta PC.</EmptyState>
        ) : null}
      </Section>
    </div>
  );
}

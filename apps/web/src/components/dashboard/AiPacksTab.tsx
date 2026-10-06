"use client";

import { API_ROUTES, type ToolState, type TtsProviderInfo } from "@studio/shared";
import { Download, FileText, Gauge, RefreshCw, ShieldCheck } from "lucide-react";
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
import {
  featureLabel,
  formatDuration,
  perfEstimates,
  rvmDetail,
  rvmFpsLabel,
  rvmHqFpsLabel,
} from "@/lib/ai";
import { packState, type PackInfo, type PackState, type PerfResult } from "@/lib/ai-types";
import {
  aiApi,
  apiFetch,
  ApiRequestError,
  errorMessage,
  isNotImplemented,
  openLicenceDialog,
} from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { runJob } from "@/lib/job-runner";
import { isTerminal, useJobsStore } from "@/stores/jobs-store";
import { usePacksStore } from "@/stores/packs-store";
import { usePersonsStore } from "@/stores/persons-store";

const STATE_LABELS: Record<PackState, { label: string; tone: "success" | "warning" | "muted" }> = {
  installed: { label: "Instalado", tone: "success" },
  partial: { label: "Incompleto", tone: "warning" },
  missing: { label: "Falta", tone: "muted" },
};

type Tone = "success" | "warning" | "muted" | "danger";

/** Sprint 4: state of the isolated tool venv (tools/<id>/.venv) of a pack. */
export const TOOL_STATE_ES: Record<ToolState, { label: string; tone: Tone }> = {
  ready: { label: "listo", tone: "success" },
  stale: { label: "desactualizado", tone: "warning" },
  missing: { label: "falta", tone: "muted" },
  broken: { label: "roto", tone: "danger" },
  python: { label: "falta Python 3.12", tone: "danger" },
};

/** Window event the licence dialog (M1) fires after an acceptance: refresh the badges. */
const LICENCE_ACCEPTED = "studio:licence:accepted";

const dec = (v: number, digits = 1) => v.toFixed(digits).replace(".", ",");

/** «12,3 s por minuto (GPU)» — RVC of the performance test, with the device it really used. */
export function rvcPerfLabel(r: Partial<PerfResult>): string | undefined {
  if (r.rvc_s_per_min == null) return undefined;
  const device = r.rvc_device === "cuda" ? "GPU" : r.rvc_device === "cpu" ? "CPU" : undefined;
  return `${dec(r.rvc_s_per_min)} s por minuto${device ? ` (${device})` : ""}`;
}

/** «RTF 0,62 (≈ 6,2 s por cada 10 s de voz)». RTF = generation time / audio duration. */
export function chatterboxPerfLabel(r: Partial<PerfResult>): string | undefined {
  if (r.chatterbox_rtf == null) return undefined;
  const device = r.chatterbox_device === "cuda" ? ", GPU" : r.chatterbox_device ? ", CPU" : "";
  return `RTF ${dec(r.chatterbox_rtf, 2)} (≈ ${dec(r.chatterbox_rtf * 10)} s por cada 10 s de voz${device})`;
}

/** «18,0 fps (≈ 1,7 min por minuto a 1080p; con mejorador 7,0 fps)». */
export function faceSwapPerfLabel(r: Partial<PerfResult>): string | undefined {
  const fps = r.facefusion_fps;
  if (fps == null || fps <= 0) return undefined;
  const minutes = ((r.facefusion_startup_s ?? 0) + (60 * 30) / fps) / 60;
  const enh =
    r.facefusion_enh_fps != null ? `; con mejorador ${dec(r.facefusion_enh_fps)} fps` : "";
  return `${dec(fps)} fps (≈ ${dec(minutes)} min por minuto a 1080p${enh})`;
}

interface PerfTools {
  tools?: Partial<
    Record<"facefusion" | "chatterbox", { state?: ToolState; variant?: string; version?: string }>
  >;
}

/** «V3 (git 5de7a54)» / «V2 (respaldo PyPI 0.1.7)» of the Chatterbox venv. */
export function chatterboxVariantLabel(r: PerfTools): string | undefined {
  const cb = r.tools?.chatterbox;
  if (!cb?.variant) return undefined;
  return cb.variant === "v2"
    ? `V2 (respaldo PyPI${cb.version ? ` ${cb.version}` : ""})`
    : `V3${cb.version ? ` (${cb.version})` : ""}`;
}

function LicenceCell({ licenceId }: { licenceId: string }) {
  const licences = usePersonsStore((s) => s.licences);
  const status = licences.find((l) => l.id === licenceId);
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1" data-testid="pack-licence">
      <Badge tone="warning">No comercial: requiere aceptar licencia</Badge>
      {status?.accepted ? (
        <>
          <span className="text-[11px] text-muted-foreground">
            Aceptada
            {status.acceptance?.accepted_at
              ? ` el ${new Date(status.acceptance.accepted_at).toLocaleDateString("es")}`
              : ""}
          </span>
          <Button size="xs" variant="ghost" onClick={() => openLicenceDialog(licenceId)}>
            <FileText />
            Ver licencia
          </Button>
        </>
      ) : (
        <Button size="xs" variant="outline" onClick={() => openLicenceDialog(licenceId)}>
          <FileText />
          Leer y aceptar
        </Button>
      )}
    </span>
  );
}

function PackRow({
  pack,
  queuePos,
  toolVariant,
}: {
  pack: PackInfo;
  queuePos: number | undefined;
  toolVariant?: string | undefined;
}) {
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
        {pack.licence_gate ? <LicenceCell licenceId={pack.licence_gate} /> : null}
        {pack.tool ? (
          <span className="mt-1 block text-[11px]" data-testid="pack-tool">
            Entorno aislado ({`tools\\${pack.tool.id}`}):{" "}
            <Badge tone={TOOL_STATE_ES[pack.tool.state].tone}>
              {TOOL_STATE_ES[pack.tool.state].label}
            </Badge>
            {toolVariant ? (
              <span className="ml-1 text-muted-foreground" data-testid="pack-tool-variant">
                modelo {toolVariant}
              </span>
            ) : null}
            {pack.tool.state === "python" ? (
              <span className="block text-muted-foreground">
                Corré {"scripts\\windows\\setup.ps1 -Update"} para instalar Python 3.12.
              </span>
            ) : null}
          </span>
        ) : null}
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
        Mide en esta PC cuánto tardan Whisper, Piper, RVC, la detección de escenas, el recorte de
        personas y, si están instalados, Chatterbox y el cambio de cara (unos minutos). Los tiempos
        se guardan y se usan para estimar cada tarea.
      </p>
      {error ? <ErrorNotice message={error} /> : null}
      {result ? (
        <div className="grid gap-3 sm:grid-cols-2" data-testid="perf-results">
          <table className="text-xs">
            <tbody>
              <tr>
                <td className="pr-2 text-muted-foreground">GPU</td>
                <td>{!result.gpu || result.gpu === "cpu" ? "No (CPU)" : result.gpu}</td>
              </tr>
              <tr>
                <td className="pr-2 text-muted-foreground">Whisper turbo</td>
                <td>{num(result.whisper_turbo_s_per_min, "s por min")}</td>
              </tr>
              <tr>
                <td className="pr-2 text-muted-foreground">Piper</td>
                <td>{num(result.piper_s_per_100chars, "s por 100 caracteres")}</td>
              </tr>
              <tr data-testid="perf-rvc">
                <td className="pr-2 text-muted-foreground">RVC</td>
                <td>{rvcPerfLabel(result) ?? "—"}</td>
              </tr>
              <tr data-testid="perf-chatterbox">
                <td className="pr-2 text-muted-foreground">Chatterbox</td>
                <td>
                  {chatterboxPerfLabel(result) ??
                    (result.skipped?.chatterbox ? `no medido: ${result.skipped.chatterbox}` : "—")}
                  {chatterboxVariantLabel(result as PerfTools) ? (
                    <span className="block text-[10px] text-muted-foreground">
                      Modelo {chatterboxVariantLabel(result as PerfTools)}
                      {result.chatterbox_load_s != null
                        ? ` · primera carga ${num(result.chatterbox_load_s, "s")}`
                        : ""}
                    </span>
                  ) : null}
                </td>
              </tr>
              <tr data-testid="perf-facefusion">
                <td className="pr-2 text-muted-foreground">Cambio de cara</td>
                <td>
                  {faceSwapPerfLabel(result) ??
                    (result.skipped?.facefusion ? `no medido: ${result.skipped.facefusion}` : "—")}
                  {result.facefusion_device && result.facefusion_fps != null ? (
                    <span className="block text-[10px] text-muted-foreground">
                      {result.facefusion_device === "cuda" ? "GPU" : "CPU"} ·{" "}
                      {result.facefusion_model ?? "hyperswap_1a_256"}
                    </span>
                  ) : null}
                </td>
              </tr>
              <tr>
                <td className="pr-2 text-muted-foreground">Escenas</td>
                <td>{num(result.scenes_fps, "fps")}</td>
              </tr>
              {result.rvm_fps != null ? (
                <tr data-testid="perf-rvm">
                  <td className="pr-2 text-muted-foreground">Recorte de personas</td>
                  <td>
                    {rvmFpsLabel(result)}
                    {rvmDetail(result) ? (
                      <span className="block text-[10px] text-muted-foreground">
                        {rvmDetail(result)}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ) : null}
              {rvmHqFpsLabel(result) ? (
                <tr data-testid="perf-rvm-hq">
                  <td className="pr-2 text-muted-foreground">Recorte alta calidad</td>
                  <td>{rvmHqFpsLabel(result)}</td>
                </tr>
              ) : null}
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
            {Object.entries(result.skipped ?? {})
              .filter(([k]) => k !== "chatterbox" && k !== "facefusion")
              .map(([k, why]) => (
                <li key={`skip-${k}`} className="text-muted-foreground">
                  {k}: sin medir ({why})
                </li>
              ))}
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
/** «V3» / «V2 (respaldo)» from the Chatterbox provider row (models: ["mtl-v3"] | ["mtl-v2"]). */
export function chatterboxModelLabel(models: readonly string[] | undefined): string | undefined {
  if (!models?.length) return undefined;
  if (models.includes("mtl-v3")) return "V3";
  return models.includes("mtl-v2") ? "V2 (respaldo PyPI)" : undefined;
}

export function AiPacksTab() {
  const packs = usePacksStore((s) => s.packs);
  const [cbVariant, setCbVariant] = useState<string | undefined>(undefined);
  const status = usePacksStore((s) => s.status);
  const error = usePacksStore((s) => s.error);
  const downloads = usePacksStore((s) => s.downloads);
  const jobs = useJobsStore((s) => s.jobs);

  useEffect(() => {
    void usePacksStore.getState().load();
    // Sprint 4: acceptance state of the licence-gated packs (faceswap) and the Chatterbox model
    // variant (V3 git / V2 PyPI fallback) of the isolated venv; both best effort.
    void usePersonsStore
      .getState()
      .loadLicences()
      .catch(() => undefined);
    apiFetch<TtsProviderInfo[]>(API_ROUTES.ttsProviders)
      .then((rows) =>
        setCbVariant(chatterboxModelLabel(rows.find((r) => r.id === "chatterbox")?.models)),
      )
      .catch(() => undefined);
    const onAccepted = () => {
      void usePacksStore.getState().load();
      void usePersonsStore
        .getState()
        .loadLicences()
        .catch(() => undefined);
    };
    window.addEventListener(LICENCE_ACCEPTED, onAccepted);
    return () => window.removeEventListener(LICENCE_ACCEPTED, onAccepted);
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
            onClick={() => {
              void usePacksStore.getState().load();
              void usePersonsStore
                .getState()
                .loadLicences()
                .catch(() => undefined);
            }}
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
                    toolVariant={p.tool?.id === "chatterbox" ? cbVariant : undefined}
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

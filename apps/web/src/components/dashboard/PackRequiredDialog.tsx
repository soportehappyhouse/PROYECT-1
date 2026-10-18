"use client";

import { PACKS_PATH_ES } from "@studio/shared";
import { Download, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorNotice, Progress, Spinner } from "@/components/ui/misc";
import { featureLabel } from "@/lib/ai";
import { AGENT_PACK_ID } from "@/lib/agent-types";
import { formatBytes } from "@/lib/format";
import { useAgentStore } from "@/stores/agent-store";
import { isTerminal, useJobsStore } from "@/stores/jobs-store";
import { usePacksStore } from "@/stores/packs-store";

/**
 * «Paquete requerido»: opened by any `409 PACK_REQUIRED`. Downloads the pack (job packs.download,
 * progress by SSE); the packs store re-runs the action that needed it once the download finishes.
 */
export function PackRequiredDialog() {
  const request = usePacksStore((s) => s.request);
  const packs = usePacksStore((s) => s.packs);
  const packsStatus = usePacksStore((s) => s.status);
  const packId = request?.info.packId;
  const jobId = usePacksStore((s) => (packId ? s.downloads[packId] : undefined));
  const requestError = usePacksStore((s) => (packId ? s.downloadErrors[packId] : undefined));
  const job = useJobsStore((s) => (jobId ? s.jobs[jobId] : undefined));
  const [starting, setStarting] = useState(false);
  const ollama = useAgentStore((s) => s.status?.ollama);
  const isAgent = packId === AGENT_PACK_ID;

  useEffect(() => {
    if (isAgent) void useAgentStore.getState().loadStatus();
  }, [isAgent]);

  useEffect(() => {
    if (request && packsStatus === "idle") void usePacksStore.getState().load();
  }, [request, packsStatus]);

  if (!request) return null;
  const pack = packs.find((p) => p.id === request.info.packId);
  const name = request.info.name_es ?? pack?.name_es ?? request.info.packId;
  const size = request.info.size_bytes ?? pack?.size_bytes;
  const active = !!job && !isTerminal(job);
  const failed = job && (job.status === "failed" || job.status === "canceled");
  const error = requestError ?? (failed ? (job.error ?? job.message ?? "La descarga falló") : "");

  const download = async () => {
    setStarting(true);
    await usePacksStore.getState().startDownload(request.info.packId);
    setStarting(false);
  };

  return (
    <Dialog
      open
      title="Paquete requerido"
      className="max-w-md"
      onClose={() => usePacksStore.getState().closeRequest(active)}
    >
      <div className="flex flex-col gap-3 text-sm" data-testid="pack-required">
        <p>
          Esta función necesita el paquete <strong>«{name}»</strong>
          {size ? ` (${formatBytes(size)})` : ""}, que todavía no está instalado.
        </p>
        {pack?.description_es ? (
          <p className="text-xs text-muted-foreground">{pack.description_es}</p>
        ) : null}
        {isAgent ? <OllamaHint missing={ollama === false} message={request.info.message} /> : null}
        <ul className="text-xs text-muted-foreground">
          {pack?.license ? <li>Licencia: {pack.license}</li> : null}
          {pack?.required_by.length ? (
            <li>Lo usan: {pack.required_by.map(featureLabel).join(", ")}</li>
          ) : null}
          <li>Se descarga una sola vez a la carpeta models/ y se verifica al terminar.</li>
          <li>También podés descargarlo cuando quieras en {PACKS_PATH_ES}.</li>
        </ul>
        {active ? (
          <div className="flex flex-col gap-1" aria-live="polite">
            <Progress
              value={job.progress}
              className={job.status === "queued" ? "animate-pulse" : ""}
            />
            <p className="text-xs text-muted-foreground">
              {job.status === "queued"
                ? "En cola: las descargas se hacen de a una."
                : `${Math.round(job.progress * 100)} %${job.message ? ` · ${job.message}` : ""}`}
            </p>
          </div>
        ) : null}
        {error ? <ErrorNotice message={error} /> : null}
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => usePacksStore.getState().closeRequest(active)}
          >
            {active ? "Seguir en segundo plano" : "Cancelar"}
          </Button>
          {!active ? (
            <Button size="sm" disabled={starting} onClick={() => void download()}>
              {starting ? <Spinner /> : error ? <RefreshCw /> : <Download />}
              {error ? "Reintentar" : `Descargar${size ? ` (${formatBytes(size)})` : ""}`}
            </Button>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

/** agent-llm runs on Ollama: say how to install it when the service is missing. */
function OllamaHint({ missing, message }: { missing: boolean; message: string | undefined }) {
  return (
    <div
      className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs"
      data-testid="ollama-hint"
    >
      <p>
        El asistente usa <strong>Ollama</strong> (gratis, MIT), que corre el modelo en tu PC: nada
        sale de tu computadora.
      </p>
      {missing ? (
        <p className="mt-1">
          No encontramos el servicio de Ollama. Instalalo con <code>scripts\windows\setup.ps1</code>{" "}
          (o <code>winget install Ollama.Ollama</code>), abrilo y volvé a tocar <em>Descargar</em>.{" "}
          <code>scripts\windows\doctor.ps1</code> verifica que esté en marcha.
        </p>
      ) : null}
      {message ? <p className="mt-1 text-muted-foreground">{message}</p> : null}
    </div>
  );
}

"use client";

import { Download, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorNotice, Progress, Spinner } from "@/components/ui/misc";
import { featureLabel } from "@/lib/ai";
import { formatBytes } from "@/lib/format";
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
        <ul className="text-xs text-muted-foreground">
          {pack?.license ? <li>Licencia: {pack.license}</li> : null}
          {pack?.required_by.length ? (
            <li>Lo usan: {pack.required_by.map(featureLabel).join(", ")}</li>
          ) : null}
          <li>Se descarga una sola vez a la carpeta models/ y se verifica al terminar.</li>
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

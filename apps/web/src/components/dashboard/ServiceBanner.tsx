"use client";

import { API_DOWN_ES, START_CMD_ES, WORKERS_DOWN_ES } from "@studio/shared";
import { AlertTriangle, HelpCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";
import {
  serviceBannerKind,
  startServiceStatus,
  useServiceStatusStore,
} from "@/stores/service-status-store";

/**
 * Sprint 5 (M1, H4): the ONE notice when Studio's api or the local AI (workers) is not running.
 * Replaces the loose texts of Voz, Paquetes de IA and Asistente; AI buttons are disabled with the
 * same reason (useAiAvailability). «Cómo iniciarla» = manual §12.
 */
export function ServiceBanner() {
  const api = useServiceStatusStore((s) => s.api);
  const workers = useServiceStatusStore((s) => s.workers);
  const checking = useServiceStatusStore((s) => s.checking);
  const [help, setHelp] = useState(false);
  useEffect(() => startServiceStatus(), []);
  const kind = serviceBannerKind({ api, workers });
  if (!kind) return null;
  return (
    <div
      role="alert"
      data-testid="service-banner"
      data-kind={kind}
      className="flex shrink-0 flex-col gap-1 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <AlertTriangle className="size-4 shrink-0 text-amber-600" aria-hidden />
        <span className="font-medium">{kind === "api" ? API_DOWN_ES : WORKERS_DOWN_ES}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="xs"
            variant="outline"
            disabled={checking}
            tooltip="Volver a comprobar si Studio y la IA local responden"
            onClick={() => void useServiceStatusStore.getState().check()}
          >
            {checking ? <Spinner className="size-3" /> : <RefreshCw />} Reintentar
          </Button>
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={help}
            tooltip="Pasos para iniciar Studio con la IA local (manual §12)"
            onClick={() => setHelp((h) => !h)}
          >
            <HelpCircle /> Cómo iniciarla
          </Button>
        </div>
      </div>
      {help ? (
        <ol className="ml-6 list-decimal text-muted-foreground" data-testid="service-help">
          <li>Cerrá Studio (la ventana negra de Studio y esta pestaña).</li>
          <li>
            Abrí <code>{START_CMD_ES}</code> con doble clic: inicia la API, la web y la IA local.
          </li>
          <li>
            Si la IA local sigue apagada, mirá el detalle en el manual, sección 12 («La IA local
            está apagada»).
          </li>
        </ol>
      ) : null}
    </div>
  );
}

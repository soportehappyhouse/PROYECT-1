"use client";

import { Cpu, Gpu } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/menu";
import { gpuBadgeText, gpuTooltip, formatVram } from "@/lib/ai";
import type { GpuStatus } from "@/lib/ai-types";
import { aiApi, errorMessage, isNotImplemented, isOffline } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings-store";

export const GPU_POLL_MS = 10_000;

type GpuState =
  | { kind: "loading" }
  | { kind: "ready"; status: GpuStatus }
  | { kind: "unavailable"; reason: string };

/** Header badge: GPU/CPU, free VRAM and resident model; polls /api/ai/gpu every 10 s. */
export function GpuIndicator() {
  const [state, setState] = useState<GpuState>({ kind: "loading" });
  const [releasing, setReleasing] = useState(false);

  const poll = useCallback(async () => {
    try {
      setState({ kind: "ready", status: await aiApi.gpu() });
    } catch (err) {
      setState({
        kind: "unavailable",
        reason: isOffline(err)
          ? "No hay conexión con la API local"
          : isNotImplemented(err) || (err as { status?: number }).status === 404
            ? "El gestor de GPU todavía no está disponible en la API"
            : `Workers de IA no disponibles: ${errorMessage(err)}`,
      });
    }
  }, []);

  useEffect(() => {
    void poll();
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") void poll();
    }, GPU_POLL_MS);
    return () => clearInterval(timer);
  }, [poll]);

  const release = async () => {
    setReleasing(true);
    try {
      await aiApi.releaseGpu();
      toast.success("GPU liberada", { description: "El modelo cargado se descargó de la VRAM." });
      await poll();
    } catch (err) {
      toast.error("No se pudo liberar la GPU", { description: errorMessage(err) });
    } finally {
      setReleasing(false);
    }
  };

  const status = state.kind === "ready" ? state.status : undefined;
  const label = status ? gpuBadgeText(status) : state.kind === "loading" ? "IA …" : "IA —";
  const tooltip = status
    ? gpuTooltip(status)
    : state.kind === "unavailable"
      ? `Estado de la IA local desconocido.\n${state.reason}`
      : "Consultando la GPU…";
  const tone = !status
    ? "text-muted-foreground"
    : status.mode === "gpu" && !status.sysmem_fallback
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-amber-700 dark:text-amber-400";

  return (
    <Menu
      label="GPU e IA local"
      trigger={(p) => (
        <Button
          variant="ghost"
          size="sm"
          tooltip={tooltip}
          aria-label={`Estado de la IA local: ${label}`}
          data-testid="gpu-indicator"
          className={cn("h-7 gap-1.5 px-2 text-xs tabular-nums", tone)}
          {...p}
        >
          {status?.mode === "gpu" ? <Gpu /> : <Cpu />}
          <span className="hidden md:inline">{label}</span>
          {status?.resident_model ? (
            <span className="hidden max-w-28 truncate text-muted-foreground lg:inline">
              · {status.resident_model}
            </span>
          ) : null}
        </Button>
      )}
    >
      {(close) => (
        <>
          <MenuLabel>
            {status
              ? status.mode === "gpu"
                ? `GPU${status.gpu_name ? ` · ${status.gpu_name}` : ""}`
                : "Modo CPU"
              : "IA local sin datos"}
          </MenuLabel>
          {status ? (
            <MenuLabel>
              VRAM libre {formatVram(status.vram_free_mb)} · modelo:{" "}
              {status.resident_model ?? "ninguno"}
            </MenuLabel>
          ) : null}
          <MenuSeparator />
          <MenuItem
            disabled={!status || releasing}
            onSelect={() => {
              close();
              void release();
            }}
          >
            Liberar GPU
          </MenuItem>
          <MenuItem
            onSelect={() => {
              close();
              useSettingsStore.getState().setSettingsOpen(true, "ai-packs");
            }}
          >
            Paquetes de IA y test de rendimiento…
          </MenuItem>
        </>
      )}
    </Menu>
  );
}

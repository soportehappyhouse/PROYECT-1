"use client";

import { Crosshair, Eraser, Loader2, Minus, Plus, Undo2, Wand2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Progress } from "@/components/ui/misc";
import { TRACK_METHOD_OPTIONS } from "@/lib/vision-types";
import { useMaskProgress, useMaskStore } from "@/stores/mask-store";
import { usePreviewStore } from "@/stores/preview-store";
import { useProjectStore } from "@/stores/project-store";
import { useVisionStore } from "@/stores/vision-store";

/** Second toolbar row of the preview while «Máscara» is active (SAM 2). */
export function MaskToolbar() {
  const m = useMaskStore();
  const progress = useMaskProgress();
  const close = () => {
    void useMaskStore.getState().close();
    usePreviewStore.getState().setTool("none");
  };
  const busy = m.status === "starting" || m.status === "segmenting";
  return (
    <div
      role="toolbar"
      aria-label="Herramienta Máscara"
      className="flex flex-wrap items-center gap-1 border-b bg-violet-500/10 px-2 py-1 text-xs"
    >
      <span className="font-medium">Máscara</span>
      {m.status === "starting" ? (
        <span className="flex items-center gap-1 text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Preparando SAM 2…
        </span>
      ) : null}
      {m.status === "ready" || m.status === "segmenting" ? (
        <>
          <Button
            size="xs"
            variant={m.label === 1 ? "secondary" : "ghost"}
            aria-pressed={m.label === 1}
            tooltip="Los clics marcan lo que querés incluir"
            onClick={() => m.setLabel(1)}
          >
            <Plus /> Incluir
          </Button>
          <Button
            size="xs"
            variant={m.label === 0 ? "secondary" : "ghost"}
            aria-pressed={m.label === 0}
            tooltip="Los clics marcan lo que hay que excluir (también clic derecho o Alt+clic)"
            onClick={() => m.setLabel(0)}
          >
            <Minus /> Excluir
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Deshacer el último punto"
            disabled={m.points.length === 0 || busy}
            onClick={() => void m.undoPoint()}
          >
            <Undo2 />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Borrar los puntos"
            disabled={m.points.length === 0}
            onClick={() => m.clearPoints()}
          >
            <Eraser />
          </Button>
          <Button
            size="xs"
            disabled={m.points.length === 0 || busy}
            tooltip="Sigue la máscara en todo el clip"
            onClick={() => void m.propagate()}
          >
            <Wand2 /> Propagar
          </Button>
          <span className="text-muted-foreground">
            {busy
              ? "Calculando…"
              : m.points.length === 0
                ? "Hacé clic sobre el objeto en el cuadro actual."
                : `${m.points.length} punto(s) en el cuadro ${m.frame}`}
          </span>
        </>
      ) : null}
      {m.status === "propagating" ? (
        <span className="flex min-w-48 items-center gap-2">
          <Loader2 className="size-3.5 animate-spin" /> Propagando {Math.round(progress * 100)} %
          <Progress value={progress} className="w-32" />
        </span>
      ) : null}
      {m.status === "done" && m.result ? <MaskResultActions /> : null}
      {m.error ? <span className="text-destructive">{m.error}</span> : null}
      <Button
        size="icon-sm"
        variant="ghost"
        className="ml-auto"
        aria-label="Cerrar máscara"
        onClick={close}
      >
        <X />
      </Button>
    </div>
  );
}

function MaskResultActions() {
  const m = useMaskStore();
  const r = m.result!;
  const clipId = m.clipId;
  const finish = () => {
    void useMaskStore.getState().close();
    usePreviewStore.getState().setTool("none");
  };
  return (
    <>
      <span className="text-emerald-600 dark:text-emerald-400">Máscara lista.</span>
      <Button
        size="xs"
        disabled={!clipId}
        tooltip={
          r.alphaAssetId
            ? "Usa el recorte de la máscara y elegí el fondo"
            : "Recorta a la persona con RVM y elegí el fondo"
        }
        onClick={() => {
          if (!clipId) return;
          useVisionStore
            .getState()
            .openMatte({ clipId, ...(r.alphaAssetId && { alphaAssetId: r.alphaAssetId }) });
          finish();
        }}
      >
        Quitar fondo
      </Button>
      <Button
        size="xs"
        variant="secondary"
        disabled={!r.trackAssetId}
        tooltip={
          r.trackAssetId ? "Un texto o motion sigue al objeto" : "La máscara no generó seguimiento"
        }
        onClick={() => {
          if (!r.trackAssetId) return;
          useVisionStore
            .getState()
            .openTrackAssign({ trackAssetId: r.trackAssetId, sourceClipId: clipId });
          finish();
        }}
      >
        <Crosshair /> Seguir este objeto
      </Button>
    </>
  );
}

/** Banner while drawing the «Seguir objeto» box (with the «Método» selector). */
export function TrackBoxBanner() {
  const busy = useVisionStore((s) => s.busy.track);
  const method = useVisionStore((s) => s.trackMethod);
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b bg-violet-500/10 px-2 py-1 text-xs"
    >
      <Crosshair className="size-3.5" />
      {busy
        ? "Siguiendo el objeto…"
        : "Dibujá un rectángulo alrededor del objeto a seguir (arrastrando sobre el video)."}
      <label className="ml-auto flex items-center gap-1">
        Método
        <Select
          aria-label="Método"
          title="Automático: SAM 2 si su paquete está instalado; si no, Rápido (OpenCV)"
          className="h-6 py-0 text-xs"
          value={method}
          disabled={!!busy}
          onChange={(e) =>
            useVisionStore
              .getState()
              .setTrackMethod(e.target.value as (typeof TRACK_METHOD_OPTIONS)[number]["value"])
          }
        >
          {TRACK_METHOD_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </label>
      <Button size="xs" variant="ghost" onClick={() => usePreviewStore.getState().setTool("none")}>
        Cancelar
      </Button>
    </div>
  );
}

/** Start a vision tool on the selected clip (or the first video under the playhead). */
export function startTool(tool: "mask" | "track-box"): void {
  const p = useProjectStore.getState();
  const sel = p.selectedClipId;
  let clipId: string | undefined;
  let assetId: string | undefined;
  for (const t of p.project.tracks) {
    if (t.kind !== "video" || t.hidden) continue;
    for (const c of t.clips) {
      const under = p.playhead >= c.start && p.playhead < c.start + (c.out - c.in) / (c.speed || 1);
      if ((sel && c.id === sel) || (!sel && under && !clipId)) {
        clipId = c.id;
        assetId = c.assetId;
      }
    }
  }
  if (!clipId || !assetId) {
    toast.message("Seleccioná un clip de video y poné el cursor sobre él");
    return;
  }
  usePreviewStore.getState().setTool(tool, clipId);
  if (tool === "mask") void useMaskStore.getState().start(clipId, assetId);
}

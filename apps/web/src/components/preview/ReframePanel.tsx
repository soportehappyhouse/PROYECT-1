"use client";

import { Check, Loader2, ScanFace, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/input";
import { Progress } from "@/components/ui/misc";
import { REFRAME_TARGETS, type ReframeTarget } from "@/lib/vision-types";
import { useJobsStore } from "@/stores/jobs-store";
import { useMediaStore } from "@/stores/media-store";
import { usePreviewStore } from "@/stores/preview-store";
import { useProjectStore } from "@/stores/project-store";
import { useVisionStore } from "@/stores/vision-store";

/**
 * «Reencuadrar a 9:16 / 1:1 / 4:5»: analyze (job vision.reframe) → the crop path animates on the
 * preview (amber) → «Aplicar» writes project.reframe (cyan; keyframes editable in Propiedades).
 */
export function ReframePanel() {
  const draft = usePreviewStore((s) => s.reframeDraft);
  const applied = useProjectStore((s) => s.project.reframe);
  const busy = useVisionStore((s) => s.busy.reframe);
  const progress = useJobsStore((s) =>
    typeof busy === "string" ? (s.jobs[busy]?.progress ?? 0) : 0,
  );
  const assets = useMediaStore((s) => s.assets);
  const tracks = useMemo(() => Object.values(assets).filter((a) => a.kind === "track"), [assets]);
  const [target, setTarget] = useState<ReframeTarget>(draft?.target ?? applied?.target ?? "9:16");
  const [subject, setSubject] = useState<"face" | "track">("face");
  const [trackId, setTrackId] = useState<string>("");
  const close = () => {
    usePreviewStore.getState().setReframeOpen(false);
    usePreviewStore.getState().setReframeDraft(undefined);
  };
  return (
    <section
      role="region"
      aria-label="Reencuadrar"
      className="absolute top-2 right-2 z-10 flex w-64 flex-col gap-2 rounded-md border bg-card/95 p-3 text-xs shadow-lg"
    >
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Reencuadrar</h3>
        <Button size="icon-sm" variant="ghost" aria-label="Cerrar reencuadre" onClick={close}>
          <X />
        </Button>
      </div>
      <div role="group" aria-label="Formato" className="flex gap-1">
        {REFRAME_TARGETS.map((t) => (
          <Button
            key={t}
            size="xs"
            variant={t === target ? "secondary" : "outline"}
            aria-pressed={t === target}
            onClick={() => setTarget(t)}
          >
            {t}
          </Button>
        ))}
      </div>
      <Label>
        Seguir
        <Select value={subject} onChange={(e) => setSubject(e.target.value as "face" | "track")}>
          <option value="face">Caras (automático)</option>
          <option value="track" disabled={tracks.length === 0}>
            Un objeto seguido
          </option>
        </Select>
      </Label>
      {subject === "track" ? (
        <Label>
          Seguimiento
          <Select value={trackId} onChange={(e) => setTrackId(e.target.value)}>
            <option value="">Elegí…</option>
            {tracks.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Label>
      ) : null}
      <Button
        size="xs"
        disabled={!!busy || (subject === "track" && !trackId)}
        onClick={() =>
          void useVisionStore
            .getState()
            .analyzeReframe(target, subject, subject === "track" ? trackId : undefined)
        }
      >
        {busy ? <Loader2 className="animate-spin" /> : <ScanFace />}
        {busy ? "Analizando…" : `Analizar para ${target}`}
      </Button>
      {busy ? <Progress value={progress} /> : null}
      {draft ? (
        <div className="flex flex-col gap-1 rounded border border-amber-500/40 bg-amber-500/10 p-2">
          <p>
            Recorrido {draft.target}: {draft.keyframes.length} keyframes. Reproducí para ver el
            recuadro.
          </p>
          <div className="flex gap-1">
            <Button size="xs" onClick={() => useVisionStore.getState().applyReframe()}>
              <Check /> Aplicar
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => usePreviewStore.getState().setReframeDraft(undefined)}
            >
              Descartar
            </Button>
          </div>
        </div>
      ) : applied ? (
        <p className="text-muted-foreground">
          Aplicado: {applied.target} ({applied.keyframes.length} keyframes,{" "}
          {applied.mode === "manual" ? "editado" : "automático"}). Editalo en Propiedades.
        </p>
      ) : (
        <p className="text-muted-foreground">
          Analiza el video, propone un recorte que sigue a la persona y lo muestra sobre la vista
          previa antes de aplicarlo.
        </p>
      )}
    </section>
  );
}

"use client";

import { hasAnimatedCaptions, type Project } from "@studio/shared";
import { Headphones, Scissors, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Input, Label } from "@/components/ui/input";
import { Badge, EmptyState, ErrorNotice, Spinner } from "@/components/ui/misc";
import { saveProjectNow } from "@/hooks/use-project-sync";
import { formatDuration } from "@/lib/ai";
import type { SilenceCut } from "@/lib/ai-types";
import { aiApi, api, ApiRequestError, errorMessage, isNotImplemented } from "@/lib/api";
import {
  cutsInClip,
  previewWindow,
  selectionTotals,
  setKindSelected,
  type TimelineCut,
} from "@/lib/cuts";
import { formatTime } from "@/lib/format";
import { runJob } from "@/lib/job-runner";
import { playRange } from "@/lib/preview";
import { clipDuration, findClip } from "@/lib/timeline";
import { runWithPack } from "@/stores/packs-store";
import { useProjectStore } from "@/stores/project-store";
import { useSilencesStore } from "@/stores/silences-store";

type Step = "options" | "analyzing" | "review" | "applying";

/** True when the route is not there yet (module in development): fall back to the local edit. */
function routeMissing(err: unknown): boolean {
  return isNotImplemented(err) || (err instanceof ApiRequestError && err.status === 404);
}

function readCuts(result: unknown): SilenceCut[] {
  const list = Array.isArray(result) ? result : (result as { cuts?: unknown } | null)?.cuts;
  return Array.isArray(list) ? (list as SilenceCut[]) : [];
}

function readProject(result: unknown): Pick<Project, "tracks" | "subtitles"> | undefined {
  const r = result as { project?: Project; tracks?: unknown } | null;
  if (r?.project?.tracks) return r.project;
  if (Array.isArray(r?.tracks)) return result as Project;
  return undefined;
}

/**
 * «Quitar silencios y muletillas»: options → analyze.silences → review (one checkbox per cut,
 * «Escuchar» in the preview, totals) → timeline.apply-cuts (one undo step).
 */
export function SilencesDialog() {
  const clipId = useSilencesStore((s) => s.clipId);
  const options = useSilencesStore((s) => s.options);
  const project = useProjectStore((s) => s.project);
  const found = clipId ? findClip(project, clipId) : undefined;
  const [step, setStep] = useState<Step>("options");
  const [cuts, setCuts] = useState<TimelineCut[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    setStep("options");
    setCuts([]);
    setSelected(new Set());
    setError(undefined);
  }, [clipId]);

  const totals = useMemo(() => selectionTotals(cuts, selected), [cuts, selected]);
  if (!clipId) return null;
  const close = () => useSilencesStore.getState().close();
  const animated = hasAnimatedCaptions(project);

  const analyze = () =>
    runWithPack(async () => {
      setStep("analyzing");
      setError(undefined);
      await saveProjectNow();
      const { project: p } = useProjectStore.getState();
      const result = await runJob(
        () =>
          aiApi.analyzeSilences({
            projectId: p.id,
            clipId,
            options: useSilencesStore.getState().options,
          }),
        "analyze.silences",
      );
      const clip = findClip(useProjectStore.getState().project, clipId)?.clip;
      const list = clip ? cutsInClip(clip, readCuts(result)) : [];
      setCuts(list);
      setSelected(new Set(list.map((c) => c.index)));
      setStep("review");
      return true;
    })
      .then((ok) => {
        if (!ok) setStep("options"); // the «Paquete requerido» dialog took over
      })
      .catch((err: unknown) => {
        setStep("options");
        setError(
          routeMissing(err)
            ? "El análisis de silencios todavía no está disponible en la API. Mientras tanto, usá «Corte rápido» en Subtítulos (necesita la transcripción)."
            : errorMessage(err),
        );
      });

  const apply = async () => {
    const chosen = cuts.filter((c) => selected.has(c.index));
    if (chosen.length === 0) return;
    setStep("applying");
    setError(undefined);
    const store = useProjectStore.getState();
    const label = `Quitó ${chosen.length} silencio(s)/muletilla(s)`;
    try {
      await saveProjectNow();
      const projectId = useProjectStore.getState().project.id;
      let removed = totals.removedSec;
      try {
        const result = await runJob(
          () =>
            aiApi.applyCuts({
              projectId,
              clipId,
              cuts: chosen.map((c) => ({ start: c.source.start, end: c.source.end })),
            }),
          "timeline.apply-cuts",
        );
        // The job may answer only an id/path: read the edited project back then.
        const edited = readProject(result) ?? readProject(await api.getProject(projectId));
        if (!edited) throw new Error("La API no devolvió el proyecto editado");
        if (typeof result?.removedSec === "number") removed = result.removedSec;
        store.applyServerEdit(edited, label);
      } catch (err) {
        if (!routeMissing(err)) throw err;
        removed = store.applyCutsLocally(clipId, chosen);
      }
      toast.success(`Se quitaron ${formatDuration(removed)} (${chosen.length} cortes)`, {
        description: animated
          ? "Volvé a renderizar los subtítulos animados: quedaron con los tiempos anteriores."
          : "Podés deshacerlo con Ctrl+Z.",
      });
      close();
    } catch (err) {
      setStep("review");
      setError(errorMessage(err));
    }
  };

  const toggle = (index: number, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(index);
      else next.delete(index);
      return next;
    });

  const busy = step === "analyzing" || step === "applying";
  const clipLength = found ? clipDuration(found.clip) : 0;

  return (
    <Dialog open title="Quitar silencios y muletillas" onClose={close} className="max-w-xl">
      <div className="flex flex-col gap-3 text-sm" data-testid="silences-dialog">
        {!found ? (
          <ErrorNotice message="El clip ya no está en la línea de tiempo." />
        ) : step === "options" || step === "analyzing" ? (
          <>
            <p className="text-xs text-muted-foreground">
              Busca pausas (FFmpeg) y muletillas («eh», «este», «o sea», «tipo»…, con las palabras
              de Whisper) en el clip seleccionado. Nada se corta hasta que revises la lista.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Label>
                Silencio mínimo (ms)
                <Input
                  type="number"
                  min={100}
                  step={50}
                  value={options.minSilenceMs}
                  onChange={(e) =>
                    useSilencesStore
                      .getState()
                      .setOptions({ minSilenceMs: Math.max(100, Number(e.target.value) || 500) })
                  }
                />
              </Label>
              <Label>
                Margen a cada lado (ms)
                <Input
                  type="number"
                  min={0}
                  step={10}
                  value={options.paddingMs}
                  onChange={(e) =>
                    useSilencesStore
                      .getState()
                      .setOptions({ paddingMs: Math.max(0, Number(e.target.value) || 0) })
                  }
                />
              </Label>
            </div>
            <label className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={options.fillers}
                onChange={(e) =>
                  useSilencesStore.getState().setOptions({ fillers: e.target.checked })
                }
              />
              Incluir muletillas (usa la transcripción de Whisper)
            </label>
            {error ? <ErrorNotice message={error} /> : null}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={close}>
                Cancelar
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void analyze()}>
                {busy ? <Spinner /> : <Scissors />} {busy ? "Analizando…" : "Analizar"}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span data-testid="silences-totals">
                {totals.selected} de {totals.total} cortes · se quitan{" "}
                <strong>{formatDuration(totals.removedSec)}</strong>
                {clipLength ? ` de ${formatDuration(clipLength)}` : ""}
              </span>
              <span className="ml-auto flex gap-1">
                {(["silence", "filler"] as const).map((kind) => {
                  const all = cuts.filter((c) => c.kind === kind);
                  if (all.length === 0) return null;
                  const on = all.every((c) => selected.has(c.index));
                  return (
                    <Button
                      key={kind}
                      size="xs"
                      variant="outline"
                      onClick={() => setSelected(setKindSelected(cuts, selected, kind, !on))}
                    >
                      {on ? "Quitar" : "Marcar"} {kind === "silence" ? "silencios" : "muletillas"}
                    </Button>
                  );
                })}
              </span>
            </div>
            {cuts.length === 0 ? (
              <EmptyState>No se encontraron silencios ni muletillas con estas opciones.</EmptyState>
            ) : (
              <ul className="flex max-h-[40vh] flex-col divide-y overflow-auto rounded-md border">
                {cuts.map((c) => (
                  <li
                    key={c.index}
                    className="flex items-center gap-2 px-2 py-1 text-xs"
                    data-testid="cut-row"
                  >
                    <Checkbox
                      aria-label={`Cortar ${formatTime(c.start)}`}
                      checked={selected.has(c.index)}
                      onChange={(e) => toggle(c.index, e.target.checked)}
                    />
                    <Badge tone={c.kind === "silence" ? "muted" : "warning"}>
                      {c.kind === "silence" ? "silencio" : "muletilla"}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate">
                      {c.text ? `«${c.text}»` : <span className="text-muted-foreground">—</span>}
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                      {formatTime(c.start)}
                    </span>
                    <span className="w-12 text-right tabular-nums">
                      {formatDuration(c.duration)}
                    </span>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Escuchar"
                      tooltip="Escuchar en la vista previa (con 0,5 s antes y después)"
                      onClick={() => {
                        const w = previewWindow(c);
                        playRange(w.start, w.end);
                      }}
                    >
                      <Headphones />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {animated ? (
              <p className="flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-400">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                Hay subtítulos animados renderizados: después de aplicar hay que volver a
                renderizarlos (Subtítulos → «Renderizar subtítulos como motion»).
              </p>
            ) : null}
            {error ? <ErrorNotice message={error} /> : null}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setStep("options")}>
                Volver a las opciones
              </Button>
              <Button
                size="sm"
                disabled={busy || totals.selected === 0}
                onClick={() => void apply()}
              >
                {step === "applying" ? <Spinner /> : <Scissors />} Aplicar {totals.selected} cortes
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

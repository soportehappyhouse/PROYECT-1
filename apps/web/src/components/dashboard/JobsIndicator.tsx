"use client";

import { ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";
import { isBackgroundJobType } from "@/hooks/use-job-events";
import { isTerminal, useJobsStore } from "@/stores/jobs-store";
import { analyzingText } from "@/stores/suggestions-store";
import { showPanel } from "./dock-controller";

/**
 * Sprint 5 (M1): header spinner + number of active jobs; click opens «Trabajos». Sprint 6: the
 * background analyses (import suggestions) are not counted as the user's jobs; one aggregated
 * «Analizando N medios…» line says they are running.
 */
export function JobsIndicator() {
  const active = useJobsStore(
    (s) =>
      Object.values(s.jobs).filter((j) => !isTerminal(j) && !isBackgroundJobType(j.type)).length,
  );
  const analyzing = useJobsStore(
    (s) =>
      Object.values(s.jobs).filter((j) => !isTerminal(j) && isBackgroundJobType(j.type)).length,
  );
  const stalled = useJobsStore(
    (s) =>
      Object.values(s.jobs).filter(
        (j) => !isTerminal(j) && !isBackgroundJobType(j.type) && j.detail?.stalled,
      ).length,
  );
  const background = analyzingText(analyzing);
  const label =
    (active === 0
      ? "Trabajos: no hay nada en curso"
      : `Trabajos: ${active} en curso${stalled ? ` (${stalled} sin avance)` : ""}`) +
    (background ? ` · ${background}` : "");
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={label}
      tooltip={`${label}. Clic para ver el progreso, el tiempo que falta y cancelar`}
      data-testid="jobs-indicator"
      data-active={active}
      className="gap-1 px-2"
      onClick={() => showPanel("jobs")}
    >
      {active > 0 || background ? <Spinner className="size-3.5" /> : <ListChecks />}
      {active > 0 ? <span className="tabular-nums">{active}</span> : null}
      {background ? (
        <span
          className="hidden text-[11px] text-muted-foreground lg:inline"
          aria-live="polite"
          data-testid="jobs-indicator-analyzing"
        >
          {background}
        </span>
      ) : null}
    </Button>
  );
}

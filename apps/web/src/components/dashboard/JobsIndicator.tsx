"use client";

import { ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";
import { isTerminal, useJobsStore } from "@/stores/jobs-store";
import { showPanel } from "./dock-controller";

/** Sprint 5 (M1): header spinner + number of active jobs; click opens «Trabajos». */
export function JobsIndicator() {
  const active = useJobsStore((s) => Object.values(s.jobs).filter((j) => !isTerminal(j)).length);
  const stalled = useJobsStore(
    (s) => Object.values(s.jobs).filter((j) => !isTerminal(j) && j.detail?.stalled).length,
  );
  const label =
    active === 0
      ? "Trabajos: no hay nada en curso"
      : `Trabajos: ${active} en curso${stalled ? ` (${stalled} sin avance)` : ""}`;
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
      {active > 0 ? <Spinner className="size-3.5" /> : <ListChecks />}
      {active > 0 ? <span className="tabular-nums">{active}</span> : null}
    </Button>
  );
}

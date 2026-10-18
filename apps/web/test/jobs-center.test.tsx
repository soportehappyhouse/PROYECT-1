import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Job } from "@studio/shared";
import { formatCount, JobsPanel, liveEtaS } from "@/components/panels/JobsPanel";
import { JobsIndicator } from "@/components/dashboard/JobsIndicator";
import { opRisks } from "@/lib/agent";
import { firstCpuWarning, resetCpuWarnings } from "@/lib/gpu-preflight";
import { useJobsStore } from "@/stores/jobs-store";

/** Sprint 5 (M1): job rows with stage, counts, ETA, «sin avance» and Cancelar. */

const job = (over: Partial<Job>): Job => ({
  id: "j",
  type: "agent.eval",
  status: "running",
  progress: 0.15,
  payload: {},
  createdAt: "2026-10-08T10:00:00.000Z",
  ...over,
});

describe("Trabajos (centro de trabajos)", () => {
  it("shows stage, 3/20, ETA and a working Cancelar", () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    useJobsStore.setState({
      cancel,
      jobs: {
        a: job({
          id: "a",
          detail: {
            done: 3,
            total: 20,
            unit: "commands",
            stage_es: "qwen3:8b · 3/20",
            eta_s: 340,
            cancellable: true,
            progressAt: new Date().toISOString(),
          },
        }),
        b: job({
          id: "b",
          type: "timeline.apply-cuts",
          detail: { cancellable: false },
        }),
      },
    });
    render(<JobsPanel />);
    expect(screen.getAllByTestId("job-stage")[0]!.textContent).toBe("qwen3:8b · 3/20");
    expect(screen.getByTestId("job-count").textContent).toBe("3/20 comandos");
    expect(screen.getAllByTestId("job-eta")[0]!.textContent).toBe("faltan ~6 min");
    expect(screen.getAllByTestId("job-eta")[1]!.textContent).toBe("calculando…");
    const [first, second] = screen.getAllByTestId("job-cancel") as HTMLButtonElement[];
    expect(second!.disabled).toBe(true);
    fireEvent.click(first!);
    expect(cancel).toHaveBeenCalledWith("a");
  });

  it("flags a stalled job and the CPU fallback", () => {
    useJobsStore.setState({
      jobs: {
        s: job({
          id: "s",
          detail: { cancellable: true, stalled: true, progressAt: "2026-10-08T09:00:00.000Z" },
        }),
        c: job({
          id: "c",
          status: "succeeded",
          result: { warnings: ["gpu_fallback_cpu"] },
        }),
      },
    });
    render(<JobsPanel />);
    expect(screen.getByTestId("job-stalled").textContent).toBe("sin avance hace 2 min");
    expect(screen.getByText("CPU")).toBeTruthy();
  });

  it("header indicator counts active jobs", () => {
    useJobsStore.setState({
      jobs: { a: job({ id: "a" }), b: job({ id: "b", status: "succeeded" }) },
    });
    render(<JobsIndicator />);
    expect(screen.getByTestId("jobs-indicator").getAttribute("data-active")).toBe("1");
  });

  it("helpers", () => {
    expect(formatCount(1.2e9, 4.5e9, "bytes")).toBe("1,2 / 4,5 GB");
    expect(liveEtaS({ detail: { eta_s: 60, cancellable: true } }, 0, 20_000)).toBe(40);
    expect(liveEtaS({ detail: { eta_s: null, cancellable: true } }, 0, 0)).toBeNull();
  });

  it("CPU warnings once per session and feature (H24)", () => {
    resetCpuWarnings();
    window.sessionStorage.clear();
    expect(firstCpuWarning("preflight:transcribe")).toBe(true);
    expect(firstCpuWarning("preflight:transcribe")).toBe(false);
    expect(firstCpuWarning("preflight:stems")).toBe(true);
  });

  it("labels fast FFmpeg ops apart from local AI (H23)", () => {
    expect(opRisks({ op: "detect_scenes" } as never).map((r) => r.label)).toContain(
      "Rápido (FFmpeg)",
    );
    expect(opRisks({ op: "transcribe" } as never).map((r) => r.label)).toContain(
      "IA local (puede tardar)",
    );
  });
});

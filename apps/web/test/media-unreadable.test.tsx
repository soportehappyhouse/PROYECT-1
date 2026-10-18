import type { Job, MediaAsset } from "@studio/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaPanel } from "@/components/panels/MediaPanel";
import { api } from "@/lib/api";
import { useJobsStore } from "@/stores/jobs-store";
import { probeFailureOf, unreadableFromJobs, useMediaStore } from "@/stores/media-store";
import { createEmptyProject, useProjectStore } from "@/stores/project-store";

/** MEJORAS B15 (Sprint 6 M3): a medium whose probe failed shows «No se pudo leer» + «Quitar». */

const broken: MediaAsset = {
  id: "bad",
  kind: "video",
  name: "vacio.mp4",
  path: "media/bad.mp4",
  sizeBytes: 0,
  createdAt: "2026-10-18T10:00:00.000Z",
};
const good: MediaAsset = { ...broken, id: "ok", name: "bien.mp4", sizeBytes: 10, durationSec: 3 };

const probe = (id: string, assetId: string, status: Job["status"], createdAt: string): Job => ({
  id,
  type: "media.probe",
  status,
  progress: status === "succeeded" ? 1 : 0,
  payload: { assetId },
  createdAt,
  ...(status === "failed" && { error: "moov atom not found" }),
});

beforeEach(() => {
  useProjectStore.getState().loadProject(createEmptyProject("Demo"));
  useJobsStore.setState({ jobs: {}, intents: {}, handled: {}, connection: "live" });
  useMediaStore.setState({
    assets: { bad: broken, ok: good },
    order: ["bad", "ok"],
    status: "ready",
    error: undefined,
    uploads: [],
    unreadable: {},
  });
});
afterEach(() => vi.restoreAllMocks());

describe("B15: medio que no se pudo leer", () => {
  it("unreadableFromJobs keeps the newest failure; a later success clears it", () => {
    const jobs = [
      probe("1", "bad", "failed", "2026-10-18T10:00:01.000Z"),
      probe("2", "ok", "failed", "2026-10-18T10:00:01.000Z"),
      probe("3", "ok", "succeeded", "2026-10-18T10:05:00.000Z"),
    ];
    expect(unreadableFromJobs(jobs)).toEqual({ bad: "moov atom not found" });
    expect(probeFailureOf(Object.fromEntries(jobs.map((j) => [j.id, j])), "ok")).toBeUndefined();
  });

  it("shows the red mark with «Quitar» (no proxy actions) from a failed probe job", async () => {
    useJobsStore.getState().upsertJob(probe("p1", "bad", "failed", "2026-10-18T10:00:01.000Z"));
    const del = vi.spyOn(api, "deleteMedia").mockResolvedValue(undefined);
    render(<MediaPanel />);
    const mark = screen.getByTestId("media-unreadable");
    expect(mark.textContent).toContain("No se pudo leer");
    expect(screen.getAllByText("Sin proxy")).toHaveLength(1); // only the readable video
    expect(screen.getAllByRole("button", { name: "Generar proxy" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Quitar" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("bad"));
    await waitFor(() => expect(useMediaStore.getState().assets.bad).toBeUndefined());
  });

  it("the mark survives a reload (failed probes read from the api)", async () => {
    vi.spyOn(api, "listMedia").mockResolvedValue([broken, good]);
    vi.spyOn(api, "listJobs").mockResolvedValue([
      probe("p1", "bad", "failed", "2026-10-18T10:00:01.000Z"),
    ]);
    await useMediaStore.getState().refresh();
    await waitFor(() =>
      expect(useMediaStore.getState().unreadable).toEqual({ bad: "moov atom not found" }),
    );
    render(<MediaPanel />);
    expect(screen.getByTestId("media-unreadable")).toBeTruthy();
  });
});

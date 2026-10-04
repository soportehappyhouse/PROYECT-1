"use client";

import {
  TranscribeJobResultSchema,
  TranscriptSchema,
  type Job,
  type JobEvent,
  type SubtitleSegment,
} from "@studio/shared";
import { useEffect } from "react";
import { toast } from "sonner";
import { api, fileUrl } from "@/lib/api";
import { clipEnd, findClip } from "@/lib/timeline";
import {
  isTerminal,
  JOB_TYPE_LABELS,
  jobOutputAssetId,
  jobOutputPath,
  useJobsStore,
} from "@/stores/jobs-store";
import { useMediaStore } from "@/stores/media-store";
import { useProjectStore } from "@/stores/project-store";
import { openReport } from "@/stores/report-store";

const SSE_RETRY_MS = 20_000;
const POLL_MS = 5_000;

/** Map transcript segments (source time of the clip asset) onto the timeline. */
export function transcriptToTimeline(
  segments: readonly SubtitleSegment[],
  clip: { start: number; in: number; out: number; speed: number },
): SubtitleSegment[] {
  const speed = clip.speed || 1;
  const toTimeline = (t: number) => clip.start + (t - clip.in) / speed;
  return segments
    .filter((s) => s.end > clip.in && s.start < clip.out)
    .map((s) => ({
      ...s,
      start: Math.max(clip.start, toTimeline(s.start)),
      end: Math.min(clipEnd(clip), toTimeline(s.end)),
      words: s.words?.map((w) => ({ ...w, start: toTimeline(w.start), end: toTimeline(w.end) })),
    }));
}

/**
 * U3: automatic analysis jobs (probe/proxy enqueued by an upload or import) finish silently; they
 * stay in the Jobs panel. Jobs started from the UI (tracked with an intent) and every failure toast.
 */
export function shouldToastSuccess(type: Job["type"], hasIntent: boolean): boolean {
  return hasIntent || (type !== "media.probe" && type !== "media.proxy");
}

async function handleFinished(job: Job): Promise<void> {
  const jobs = useJobsStore.getState();
  if (jobs.handled[job.id]) return;
  jobs.markHandled(job.id);
  const label = JOB_TYPE_LABELS[job.type];

  if (job.status === "failed") {
    toast.error(`${label}: falló`, {
      description: job.error ?? job.message,
      action: {
        label: "Reportar",
        onClick: () => openReport({ title: `Falló: ${label}`, jobIds: [job.id], source: "aviso" }),
      },
    });
    return;
  }
  if (job.status !== "succeeded") return;

  // Events do not carry `result`: fetch the full job once.
  let full = job;
  try {
    full = await api.getJob(job.id);
    jobs.upsertJob(full);
  } catch {
    // keep partial job
  }

  const intent = jobs.intents[job.id];
  const assetId = jobOutputAssetId(full);
  const media = useMediaStore.getState();
  const project = useProjectStore.getState();

  if (job.type.startsWith("media.")) void media.refresh();

  switch (intent?.kind) {
    case "replaceClipAsset": {
      if (!assetId) break;
      const asset = await media.ensure(assetId);
      const found = findClip(project.project, intent.clipId);
      if (found) {
        const maxOut = asset?.durationSec;
        project.updateClip(intent.clipId, {
          assetId,
          ...(maxOut && found.clip.out > maxOut ? { out: maxOut } : {}),
        });
      }
      break;
    }
    case "addToTimeline": {
      if (!assetId) break;
      const asset = await media.ensure(assetId);
      if (asset) project.addAssetClip(asset, { start: intent.start });
      break;
    }
    case "setMotionRender": {
      if (assetId) {
        await media.ensure(assetId);
        project.updateClip(intent.clipId, { renderedAssetId: assetId });
      }
      break;
    }
    case "transcript": {
      const found = findClip(project.project, intent.clipId);
      // subtitles.transcribe result = TranscribeJobResult { transcript, path, srtPath, ... }.
      const result = TranscribeJobResultSchema.safeParse(full.result);
      const parsed = result.success
        ? { success: true as const, data: result.data.transcript }
        : TranscriptSchema.safeParse(full.result);
      if (parsed.success && found) {
        const mapped = transcriptToTimeline(parsed.data.segments, found.clip);
        const end = clipEnd(found.clip);
        const kept = project.project.subtitles.filter(
          (s) => s.end <= found.clip.start || s.start >= end,
        );
        project.setSubtitles([...kept, ...mapped]);
      } else {
        // The api stored the transcript in project.subtitles: reload it.
        try {
          const fresh = await api.getProject(project.project.id);
          project.setSubtitles(fresh.subtitles);
        } catch {
          toast.warning("Transcripción lista, pero no se pudo leer el resultado.");
        }
      }
      break;
    }
    default:
      break;
  }

  if (!shouldToastSuccess(job.type, !!intent)) return;
  const path = jobOutputPath(full);
  toast.success(`${label}: completado`, {
    ...(path
      ? { action: { label: "Abrir", onClick: () => window.open(fileUrl(path), "_blank") } }
      : {}),
  });
}

/** Keeps the jobs store live: SSE first, gentle polling while jobs are active as fallback. */
export function useJobEvents(): void {
  useEffect(() => {
    let es: EventSource | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let disposed = false;
    const store = useJobsStore;

    const onJobChange = (job: Job) => {
      if (isTerminal(job)) void handleFinished(job);
    };

    const unsubscribe = store.subscribe((state, prev) => {
      for (const [id, job] of Object.entries(state.jobs)) {
        if (prev.jobs[id]?.status !== job.status) onJobChange(job);
      }
    });

    const poll = async () => {
      const active = Object.values(store.getState().jobs).some((j) => !isTerminal(j));
      if (!active) return;
      try {
        await store.getState().refresh();
      } catch {
        store.getState().setConnection("offline");
      }
    };

    const startPolling = () => {
      if (!pollTimer) pollTimer = setInterval(() => void poll(), POLL_MS);
    };
    const stopPolling = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = undefined;
    };

    const handleMessage = async (raw: string) => {
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        return;
      }
      const event = data as { jobId?: string };
      if (!event.jobId) return;
      if (!store.getState().jobs[event.jobId]) {
        try {
          store.getState().upsertJob(await api.getJob(event.jobId));
        } catch {
          return;
        }
      }
      store.getState().applyEvent(data as JobEvent);
    };

    const connect = () => {
      if (disposed || typeof EventSource === "undefined") return;
      store.getState().setConnection("connecting");
      es = new EventSource(api.jobEventsUrl());
      es.onopen = () => {
        store.getState().setConnection("live");
        stopPolling();
      };
      es.onmessage = (m) => void handleMessage(m.data as string);
      es.addEventListener("job", (m) => void handleMessage((m as MessageEvent).data as string));
      es.onerror = () => {
        es?.close();
        es = undefined;
        if (disposed) return;
        // Find out why: 501 (module in development) vs api down.
        void store
          .getState()
          .refresh()
          .then(() => {
            if (store.getState().connection !== "not-implemented")
              store.getState().setConnection("polling");
            startPolling();
          })
          .catch(() => store.getState().setConnection("offline"));
        retryTimer = setTimeout(connect, SSE_RETRY_MS);
      };
    };

    void store
      .getState()
      .refresh()
      .catch(() => store.getState().setConnection("offline"));
    connect();

    return () => {
      disposed = true;
      unsubscribe();
      es?.close();
      stopPolling();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, []);
}

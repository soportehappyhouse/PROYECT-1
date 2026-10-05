import {
  FileJobResultSchema,
  JobEventSchema,
  TERMINAL_JOB_STATUSES,
  type Job,
  type JobEvent,
  type JobType,
} from "@studio/shared";
import { create } from "zustand";
import { api, errorMessage, isNotImplemented } from "@/lib/api";
import { addBreadcrumb } from "./breadcrumbs-store";

export const JOB_TYPE_LABELS: Record<JobType, string> = {
  "media.probe": "Analizar medio",
  "media.proxy": "Generar proxy",
  "motion.render": "Render motion",
  "voice.tts": "Texto a voz",
  "voice.effect": "Efecto de voz",
  "voice.rvc": "Conversión RVC",
  "subtitles.transcribe": "Transcripción",
  "project.export": "Exportación",
};

export const JOB_STATUS_LABELS: Record<Job["status"], string> = {
  queued: "En cola",
  running: "En curso",
  succeeded: "Completado",
  failed: "Falló",
  canceled: "Cancelado",
};

/** What to do in the UI when a job created from the dashboard finishes successfully. */
export type JobIntent =
  | { kind: "replaceClipAsset"; clipId: string }
  | { kind: "addToTimeline"; start: number }
  | { kind: "setMotionRender"; clipId: string }
  | { kind: "transcript"; clipId: string }
  | { kind: "refreshMedia" }
  | { kind: "export" };

export type JobsConnection = "connecting" | "live" | "polling" | "not-implemented" | "offline";

interface JobsState {
  jobs: Record<string, Job>;
  intents: Record<string, JobIntent>;
  connection: JobsConnection;
  /** Ids whose terminal state was already handled (follow-up run once). */
  handled: Record<string, true>;
  refresh: () => Promise<void>;
  upsertJob: (job: Job) => void;
  applyEvent: (event: JobEvent) => void;
  track: (jobId: string, type: JobType, intent?: JobIntent) => void;
  markHandled: (jobId: string) => void;
  setConnection: (c: JobsConnection) => void;
  cancel: (jobId: string) => Promise<void>;
  dismissFinished: () => void;
}

export function isTerminal(job: Pick<Job, "status">): boolean {
  return TERMINAL_JOB_STATUSES.includes(job.status);
}

export function jobOutputPath(job: Pick<Job, "result">): string | undefined {
  const parsed = FileJobResultSchema.safeParse(job.result);
  return parsed.success ? parsed.data.path : undefined;
}

export function jobOutputAssetId(job: Pick<Job, "result">): string | undefined {
  const parsed = FileJobResultSchema.safeParse(job.result);
  return parsed.success ? parsed.data.assetId : undefined;
}

export const useJobsStore = create<JobsState>()((set, get) => ({
  jobs: {},
  intents: {},
  connection: "connecting",
  handled: {},
  refresh: async () => {
    try {
      const list = await api.listJobs({ limit: 100 });
      set((s) => {
        const jobs = { ...s.jobs };
        for (const j of list) jobs[j.id] = j;
        return { jobs };
      });
    } catch (err) {
      if (isNotImplemented(err)) set({ connection: "not-implemented" });
      else throw new Error(errorMessage(err));
    }
  },
  upsertJob: (job) => set((s) => ({ jobs: { ...s.jobs, [job.id]: job } })),
  applyEvent: (event) => {
    const parsed = JobEventSchema.safeParse(event);
    if (!parsed.success) return;
    const e = parsed.data;
    const existing = get().jobs[e.jobId];
    if (!existing) return;
    if (e.status !== existing.status && (e.status === "failed" || e.status === "canceled"))
      addBreadcrumb(
        "job",
        `${JOB_TYPE_LABELS[existing.type]} ${e.status === "failed" ? "falló" : "cancelado"}${
          e.message ? `: ${e.message}` : ""
        }`,
        { jobId: e.jobId, type: existing.type, status: e.status },
      );
    set((s) => ({
      jobs: {
        ...s.jobs,
        [e.jobId]: {
          ...existing,
          status: e.status,
          progress: e.progress,
          message: e.message ?? existing.message,
        },
      },
    }));
  },
  track: (jobId, type, intent) => {
    const now = new Date().toISOString();
    if (!get().jobs[jobId])
      addBreadcrumb("job", `Inició: ${JOB_TYPE_LABELS[type]}`, {
        jobId,
        type,
        ...(intent && { intent: intent.kind }),
      });
    set((s) => ({
      jobs: s.jobs[jobId]
        ? s.jobs
        : {
            ...s.jobs,
            [jobId]: {
              id: jobId,
              type,
              status: "queued",
              progress: 0,
              payload: undefined,
              createdAt: now,
            },
          },
      intents: intent ? { ...s.intents, [jobId]: intent } : s.intents,
    }));
  },
  markHandled: (jobId) => set((s) => ({ handled: { ...s.handled, [jobId]: true } })),
  setConnection: (connection) => set({ connection }),
  cancel: async (jobId) => {
    const job = await api.cancelJob(jobId);
    get().upsertJob(job);
  },
  dismissFinished: () =>
    set((s) => ({
      jobs: Object.fromEntries(Object.entries(s.jobs).filter(([, j]) => !isTerminal(j))),
    })),
}));

/** Jobs sorted newest first. */
export function sortedJobs(jobs: Record<string, Job>): Job[] {
  return Object.values(jobs).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

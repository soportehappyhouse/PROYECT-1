import {
  FileJobResultSchema,
  JobEventSchema,
  TERMINAL_JOB_STATUSES,
  type Job,
  type JobEvent,
  type JobType,
} from "@studio/shared";
import { create } from "zustand";
import type { AnyJobType } from "@/lib/ai-types";
import { api, errorMessage, isNotImplemented } from "@/lib/api";
import { addBreadcrumb } from "./breadcrumbs-store";

/**
 * Every shared job type plus the ones the api may add before @studio/shared lists them
 * (`agent.eval`, TODO(integration)).
 */
export const JOB_TYPE_LABELS: Record<AnyJobType, string> & Record<string, string> = {
  "media.probe": "Analizar medio",
  "media.proxy": "Generar proxy",
  "motion.render": "Render motion",
  "voice.tts": "Texto a voz",
  "voice.effect": "Efecto de voz",
  "voice.rvc": "Conversión RVC",
  "subtitles.transcribe": "Transcripción",
  "project.export": "Exportación",
  "packs.download": "Descargar paquete de IA",
  "analyze.scenes": "Detectar escenas",
  "analyze.silences": "Analizar silencios y muletillas",
  "timeline.apply-cuts": "Aplicar cortes",
  "audio.denoise": "Limpiar voz (IA)",
  "perf.run": "Test de rendimiento IA",
  "vision.matte": "Quitar fondo",
  "vision.mask": "Máscara (propagar)",
  "vision.track": "Seguir objeto",
  "vision.reframe": "Reencuadre",
  "timeline.track-to-keyframes": "Seguimiento a keyframes",
  "agent.apply": "Asistente: aplicar plan",
  "agent.eval": "Asistente: evaluar modelos",
  "audio.stems": "Separar audio (stems)",
  "style.analyze": "Perfil de estilo: analizar referencia",
  "style.infer": "Perfil de estilo: deducir con modelo local",
};

/** Packs whose download gets its own label in the Jobs panel and toasts. */
const PACK_JOB_LABELS: Record<string, string> = {
  "agent-llm": "Descargar modelo del asistente (Ollama)",
};

/** Label of any job type (unknown future types show their id). */
export function jobTypeLabel(type: string): string {
  return JOB_TYPE_LABELS[type] ?? type;
}

/** Pack id of a packs.download job payload (`{packId}` or `{pack_id}`/`{id}`). */
export function jobPackId(job: Pick<Job, "type" | "payload">): string | undefined {
  if (job.type !== "packs.download") return undefined;
  const p = job.payload as { packId?: unknown; pack_id?: unknown; id?: unknown } | null | undefined;
  const id = p?.packId ?? p?.pack_id ?? p?.id;
  return typeof id === "string" ? id : undefined;
}

/** Label of a job: the type label, specialized for some packs (agent-llm). */
export function jobLabel(job: Pick<Job, "type" | "payload">): string {
  const pack = jobPackId(job);
  return (pack && PACK_JOB_LABELS[pack]) || jobTypeLabel(job.type);
}

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
  | { kind: "export" }
  /** The UI awaits the result itself (job-runner): no success toast, no follow-up. */
  | { kind: "await" };

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
  track: (jobId: string, type: JobType | AnyJobType, intent?: JobIntent) => void;
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
        `${jobTypeLabel(existing.type)} ${e.status === "failed" ? "falló" : "cancelado"}${
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
      addBreadcrumb("job", `Inició: ${jobTypeLabel(type)}`, {
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
              // Sprint 1 types may not be in the shared enum yet (AnyJobType).
              type: type as JobType,
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

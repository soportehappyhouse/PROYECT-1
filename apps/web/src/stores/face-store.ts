import {
  FACE_SWAPPER_INFO,
  type Clip,
  type FaceDetectResult,
  type FacePreviewResult,
  type FaceSelector,
  type FaceSwapOptions,
  type FaceSwapResult,
  type MediaAsset,
  type PersonSummary,
  type Project,
  type Track,
} from "@studio/shared";
import { toast } from "sonner";
import { create } from "zustand";
import { saveProjectNow } from "@/hooks/use-project-sync";
import {
  aiApi,
  api,
  apiErrorInfo,
  ApiRequestError,
  errorMessage,
  openLicenceDialog,
} from "@/lib/api";
import { faceApi } from "@/lib/api-face";
import { licencesApi, personsApi } from "@/lib/api-persons";
import { warnIfCpu } from "@/lib/gpu-preflight";
import { JobFailedError, waitForJob } from "@/lib/job-runner";
import { findClip } from "@/lib/timeline";
import { addBreadcrumb } from "./breadcrumbs-store";
import { useMediaStore } from "./media-store";
import { runWithPack } from "./packs-store";
import { useProjectStore } from "./project-store";

/**
 * Sprint 4 M1 «Cambiar cara» wizard (components/face/FaceSwapWizard.tsx): 1. Persona (only with a
 * valid face consent) -> 2. face in the video (frame at the cursor with the boxes of
 * /api/face/detect) -> 3. options + one-frame preview -> 4. apply with the mandatory confirmation
 * «La persona dio su consentimiento y nadie en el video es menor de edad». No shortcut on purpose.
 */

export type FaceStep = "person" | "face" | "options" | "apply";
export const FACE_STEPS: readonly { id: FaceStep; label: string }[] = [
  { id: "person", label: "Persona" },
  { id: "face", label: "Cara en el video" },
  { id: "options", label: "Opciones y vista previa" },
  { id: "apply", label: "Aplicar" },
];

export interface FaceError {
  code?: string;
  message: string;
  jobId?: string;
}

export const DEFAULT_FACE_OPTIONS: FaceSwapOptions = {
  model: "hyperswap_1a_256",
  enhancer: true,
  enhancerBlend: 80,
  strength: 1,
};

interface FaceState {
  open: boolean;
  clipId: string | undefined;
  step: FaceStep;
  persons: PersonSummary[];
  personsLoading: boolean;
  /** undefined = unknown (api down): the api checks again anyway. */
  licenceAccepted: boolean | undefined;
  personId: string | undefined;
  /** Timeline seconds of the frame where the face is chosen. */
  t: number;
  detect: FaceDetectResult | undefined;
  detecting: boolean;
  detectError: FaceError | undefined;
  /** undefined = «la única cara del clip» (selector mode one). */
  faceIndex: number | undefined;
  options: FaceSwapOptions;
  preview: FacePreviewResult | undefined;
  previewing: boolean;
  previewError: FaceError | undefined;
  confirmed: boolean;
  applying: boolean;
  progressJobId: string | undefined;
  result: FaceSwapResult | undefined;
  applyError: FaceError | undefined;
  /** facefusion_fps of the last perf test (estimate), if measured. */
  perfFps: number | undefined;
  openWizard: (clipId: string) => Promise<void>;
  close: () => void;
  goTo: (step: FaceStep) => void;
  next: () => void;
  back: () => void;
  refreshPersons: () => Promise<void>;
  selectPerson: (id: string) => void;
  detectAt: (t: number) => Promise<void>;
  pickFace: (index: number | undefined) => void;
  setOptions: (patch: Partial<FaceSwapOptions>) => void;
  runPreview: () => Promise<void>;
  setConfirmed: (v: boolean) => void;
  apply: () => Promise<void>;
  undo: (clipId: string) => Promise<void>;
}

export interface FaceClipContext {
  project: Project;
  clip: Clip;
  track: Track;
  asset: MediaAsset | undefined;
}

export function faceClipContext(clipId: string | undefined): FaceClipContext | undefined {
  if (!clipId) return undefined;
  const project = useProjectStore.getState().project;
  const found = findClip(project, clipId);
  if (!found) return undefined;
  const asset = found.clip.assetId
    ? useMediaStore.getState().assets[found.clip.assetId]
    : undefined;
  return { project, clip: found.clip, track: found.track, asset };
}

/** Video clip whose face can be swapped (a video asset on a video track). */
export function canSwapFace(
  track: Pick<Track, "kind">,
  asset: Pick<MediaAsset, "kind"> | undefined,
): boolean {
  return track.kind === "video" && asset?.kind === "video";
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Timeline seconds -> seconds of the clip's asset, inside [in, out). */
export function assetTimeOf(clip: Pick<Clip, "start" | "in" | "out" | "speed">, t: number): number {
  const speed = clip.speed || 1;
  const v = clip.in + (t - clip.start) * speed;
  return r3(Math.min(Math.max(clip.in, v), Math.max(clip.in, clip.out - 0.04)));
}

/** Timeline seconds of the clip that the wizard starts on: the cursor when inside the clip. */
export function initialTime(
  clip: Pick<Clip, "start" | "in" | "out" | "speed">,
  cursor: number,
): number {
  const end = clip.start + (clip.out - clip.in) / (clip.speed || 1);
  return r3(
    cursor >= clip.start && cursor < end
      ? cursor
      : clip.start + Math.min(0.5, (end - clip.start) / 2),
  );
}

export function selectorOf(
  s: Pick<FaceState, "faceIndex" | "t">,
  clip: Pick<Clip, "start" | "in" | "out" | "speed">,
): FaceSelector {
  return s.faceIndex === undefined
    ? { mode: "one" }
    : { mode: "reference", t: assetTimeOf(clip, s.t), faceIndex: s.faceIndex, distance: 0.3 };
}

/** Whether the wizard may leave `step` forward. */
export function canAdvance(
  s: Pick<
    FaceState,
    "step" | "personId" | "licenceAccepted" | "detect" | "faceIndex" | "confirmed" | "persons"
  >,
): boolean {
  switch (s.step) {
    case "person":
      return (
        !!s.personId && s.licenceAccepted !== false && s.persons.some((p) => p.id === s.personId)
      );
    case "face":
      return s.faceIndex === undefined || (s.detect?.faces.length ?? 0) > s.faceIndex;
    case "options":
      return true;
    case "apply":
      return s.confirmed;
  }
}

/** «≈ N min» for `seconds` of video at the measured FaceFusion speed (undefined = not measured). */
export function estimateMinutes(
  seconds: number,
  assetFps: number | undefined,
  procFps: number | undefined,
): number | undefined {
  if (!procFps || procFps <= 0) return undefined;
  const frames = seconds * (assetFps && assetFps > 0 ? assetFps : 30);
  return Math.max(1, Math.round(frames / procFps / 60));
}

/** Error of a route (ApiRequestError) or of a failed job (body in `job.result`) for the wizard. */
export function faceError(err: unknown): FaceError {
  if (err instanceof JobFailedError) {
    const info = apiErrorInfo(err.job.result);
    return {
      ...(info?.code && { code: info.code }),
      message: info?.message ?? err.message,
      jobId: err.job.id,
    };
  }
  if (err instanceof ApiRequestError)
    return { ...(err.code && { code: err.code }), message: errorMessage(err) };
  return { message: errorMessage(err) };
}

const STEP_ORDER = FACE_STEPS.map((s) => s.id);

const initial = {
  open: false,
  clipId: undefined,
  step: "person" as FaceStep,
  personId: undefined,
  t: 0,
  detect: undefined,
  detecting: false,
  detectError: undefined,
  faceIndex: undefined,
  options: { ...DEFAULT_FACE_OPTIONS },
  preview: undefined,
  previewing: false,
  previewError: undefined,
  confirmed: false,
  applying: false,
  progressJobId: undefined,
  result: undefined,
  applyError: undefined,
};

export const useFaceStore = create<FaceState>()((set, get) => ({
  ...initial,
  persons: [],
  personsLoading: false,
  licenceAccepted: undefined,
  perfFps: undefined,
  openWizard: async (clipId) => {
    const ctx = faceClipContext(clipId);
    if (!ctx || !canSwapFace(ctx.track, ctx.asset)) {
      toast.error("Cambiar cara", { description: "Elegí un clip de video de la línea de tiempo." });
      return;
    }
    const cursor = useProjectStore.getState().playhead;
    set({ ...initial, open: true, clipId, t: initialTime(ctx.clip, cursor) });
    addBreadcrumb("ui", "Cambiar cara: abrir asistente", { clipId });
    await Promise.all([
      get().refreshPersons(),
      licencesApi
        .list()
        .then((l) => {
          const ok = l.find((x) => x.id === "faceswap")?.accepted ?? false;
          set({ licenceAccepted: ok });
          if (!ok) openLicenceDialog("faceswap"); // shown before the first swap
        })
        .catch(() => set({ licenceAccepted: undefined })),
      aiApi
        .lastPerf()
        .then((p) =>
          set({ perfFps: (p as { facefusion_fps?: number | null }).facefusion_fps ?? undefined }),
        )
        .catch(() => undefined),
    ]);
  },
  close: () => set({ open: false }),
  goTo: (step) => set({ step }),
  next: () => {
    const s = get();
    if (!canAdvance(s)) return;
    const i = STEP_ORDER.indexOf(s.step);
    const step = STEP_ORDER[Math.min(STEP_ORDER.length - 1, i + 1)]!;
    set({ step });
    if (step === "face" && !get().detect && !get().detecting) void get().detectAt(get().t);
  },
  back: () => {
    const i = STEP_ORDER.indexOf(get().step);
    set({ step: STEP_ORDER[Math.max(0, i - 1)]! });
  },
  refreshPersons: async () => {
    set({ personsLoading: true });
    try {
      const persons = await personsApi.list("face");
      const keep = persons.some((p) => p.id === get().personId);
      set({
        persons,
        personsLoading: false,
        ...(!keep && { personId: persons.length === 1 ? persons[0]!.id : undefined }),
      });
    } catch {
      set({ personsLoading: false });
    }
  },
  selectPerson: (personId) => set({ personId, preview: undefined }),
  detectAt: async (t) => {
    const ctx = faceClipContext(get().clipId);
    if (!ctx?.asset) return;
    set({ t: r3(t), detecting: true, detectError: undefined, preview: undefined });
    try {
      const res = await runWithPack(() => faceApi.detect(ctx.asset!.id, assetTimeOf(ctx.clip, t)));
      if (!res) return set({ detecting: false });
      const faces = res.faces.length;
      set((s) => ({
        detect: res,
        detecting: false,
        faceIndex:
          faces === 0
            ? undefined
            : s.faceIndex !== undefined && s.faceIndex < faces
              ? s.faceIndex
              : faces > 1
                ? 0
                : undefined,
        ...(faces === 0 && {
          detectError: {
            code: "NO_FACE",
            message: "No se encontró una cara en el fotograma elegido.",
          },
        }),
      }));
    } catch (err) {
      set({ detecting: false, detectError: faceError(err) });
    }
  },
  pickFace: (faceIndex) => set({ faceIndex, preview: undefined }),
  setOptions: (patch) => set((s) => ({ options: { ...s.options, ...patch }, preview: undefined })),
  runPreview: async () => {
    const s = get();
    const ctx = faceClipContext(s.clipId);
    if (!ctx?.asset || !s.personId) return;
    set({ previewing: true, previewError: undefined, preview: undefined });
    try {
      const done = await runWithPack(async () => {
        const { jobId } = await faceApi.preview({
          personId: s.personId!,
          assetId: ctx.asset!.id,
          t: assetTimeOf(ctx.clip, s.t),
          selector: selectorOf(s, ctx.clip),
          options: s.options,
        });
        const job = await waitForJob(jobId, "face.preview");
        return job.result as FacePreviewResult;
      });
      set({ previewing: false, ...(done && { preview: done }) });
    } catch (err) {
      set({ previewing: false, previewError: faceError(err) });
    }
  },
  setConfirmed: (confirmed) => set({ confirmed }),
  apply: async () => {
    const s = get();
    const ctx = faceClipContext(s.clipId);
    if (!ctx?.asset || !s.personId || !s.confirmed || s.applying) return;
    set({ applying: true, applyError: undefined, result: undefined, progressJobId: undefined });
    const person = s.persons.find((p) => p.id === s.personId);
    addBreadcrumb("ui", "Cambiar cara: aplicar", {
      clipId: ctx.clip.id,
      model: s.options.model,
    });
    try {
      await saveProjectNow();
      await warnIfCpu("faceswap");
      const projectId = useProjectStore.getState().project.id;
      const result = await runWithPack(async () => {
        const { jobId } = await faceApi.swap({
          personId: s.personId!,
          assetId: ctx.asset!.id,
          selector: selectorOf(s, ctx.clip),
          options: s.options,
          target: { projectId, clipId: ctx.clip.id },
          confirmed: true,
        });
        set({ progressJobId: jobId });
        const job = await waitForJob(jobId, "face.swap");
        return job.result as FaceSwapResult;
      });
      if (!result) return set({ applying: false });
      set({ applying: false, result });
      try {
        const remote = await api.getProject(projectId);
        useProjectStore.getState().adoptServerProject(remote, "Cambió la cara de un clip (IA)");
      } catch {
        toast.warning("No se pudo releer el proyecto", { description: "Recargá la página." });
      }
      void useMediaStore
        .getState()
        .refresh()
        .catch(() => undefined);
      const clipId = ctx.clip.id;
      toast.success("Cara cambiada", {
        description:
          `Ahora se ve la cara de «${person?.name ?? "la Persona"}» (${FACE_SWAPPER_INFO[s.options.model].name_es}). ` +
          "Queda marcado como contenido alterado con IA." +
          (result.warnings?.includes("matte_removed") ? " Volvé a recortar el fondo." : ""),
        action: { label: "Deshacer cambio de cara", onClick: () => void get().undo(clipId) },
      });
    } catch (err) {
      set({ applying: false, applyError: faceError(err) });
    }
  },
  undo: async (clipId) => {
    try {
      await saveProjectNow();
      const projectId = useProjectStore.getState().project.id;
      const remote = await faceApi.undo(projectId, clipId);
      useProjectStore.getState().adoptServerProject(remote, "Deshizo el cambio de cara");
      toast.success("Cambio de cara deshecho", {
        description: "El clip volvió al video original (el generado queda en Medios).",
      });
    } catch (err) {
      toast.error("Deshacer cambio de cara", { description: errorMessage(err) });
    }
  },
}));

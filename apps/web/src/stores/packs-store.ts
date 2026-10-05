import { toast } from "sonner";
import { create } from "zustand";
import type { PackInfo, PackRequiredInfo } from "@/lib/ai-types";
import {
  aiApi,
  errorMessage,
  isNotImplemented,
  isOffline,
  onPackRequired,
  packRequiredInfo,
} from "@/lib/api";
import { waitForJob } from "@/lib/job-runner";
import { addBreadcrumb } from "./breadcrumbs-store";
import type { LoadStatus } from "./media-store";

/** «Paquete requerido» dialog request. */
export interface PackRequest {
  info: PackRequiredInfo;
}

interface PacksState {
  packs: PackInfo[];
  status: LoadStatus;
  error: string | undefined;
  /** packId -> jobId of its last packs.download job. */
  downloads: Record<string, string>;
  /** packId -> message when the download request itself failed (offline, api error). */
  downloadErrors: Record<string, string>;
  request: PackRequest | undefined;
  /** packId -> action that hit the 409; re-run when that pack's download succeeds. */
  retries: Record<string, () => unknown>;
  load: () => Promise<void>;
  /** POST /api/ai/packs/:id/download; the workers run one download at a time (queue). */
  startDownload: (packId: string) => Promise<string | undefined>;
  openRequest: (info: PackRequiredInfo) => void;
  attachRetry: (packId: string, retry: () => unknown) => void;
  /** Close the dialog; `keepRetry` (download still running) resumes the action later anyway. */
  closeRequest: (keepRetry?: boolean) => void;
}

export const usePacksStore = create<PacksState>()((set, get) => ({
  packs: [],
  status: "idle",
  error: undefined,
  downloads: {},
  downloadErrors: {},
  request: undefined,
  retries: {},
  load: async () => {
    set({ status: get().status === "ready" ? "ready" : "loading" });
    try {
      const packs = await aiApi.packs();
      set({ packs, status: "ready", error: undefined });
    } catch (err) {
      set({
        status: isNotImplemented(err) ? "not-implemented" : "error",
        error: errorMessage(err),
      });
    }
  },
  startDownload: async (packId) => {
    set((s) => {
      const downloadErrors = { ...s.downloadErrors };
      delete downloadErrors[packId];
      return { downloadErrors };
    });
    try {
      const { jobId } = await aiApi.downloadPack(packId);
      // The api reuses the active job of a pack: never wait (and resume) twice for one job.
      if (get().downloads[packId] === jobId) return jobId;
      addBreadcrumb("job", `Descarga del paquete «${packId}»`, { packId, jobId });
      set((s) => ({ downloads: { ...s.downloads, [packId]: jobId } }));
      void waitForJob(jobId, "packs.download")
        .then(() => resume(packId))
        .catch(() => undefined)
        .finally(() => void get().load());
      return jobId;
    } catch (err) {
      const message = isOffline(err)
        ? "Sin conexión con la API local: revisá que Studio esté iniciado y reintentá."
        : errorMessage(err);
      set((s) => ({ downloadErrors: { ...s.downloadErrors, [packId]: message } }));
      return undefined;
    }
  },
  openRequest: (info) => {
    const current = get().request;
    if (current?.info.packId === info.packId) return;
    addBreadcrumb("api", `Falta el paquete «${info.packId}»`, { packId: info.packId });
    set({ request: { info } });
  },
  attachRetry: (packId, retry) => {
    const current = get().request;
    set((s) => ({
      request: { info: current?.info.packId === packId ? current.info : { packId } },
      retries: { ...s.retries, [packId]: retry },
    }));
  },
  closeRequest: (keepRetry = false) =>
    set((s) => {
      const packId = s.request?.info.packId;
      if (keepRetry || !packId) return { request: undefined };
      const retries = { ...s.retries };
      delete retries[packId];
      return { request: undefined, retries };
    }),
}));

/** A pack finished downloading: close its dialog and repeat the action that needed it. */
function resume(packId: string): void {
  const state = usePacksStore.getState();
  const name =
    (state.request?.info.packId === packId ? state.request.info.name_es : undefined) ??
    state.packs.find((p) => p.id === packId)?.name_es ??
    packId;
  const retry = state.retries[packId];
  const retries = { ...state.retries };
  delete retries[packId];
  usePacksStore.setState({
    retries,
    ...(state.request?.info.packId === packId ? { request: undefined } : {}),
  });
  toast.success(`Paquete «${name}» instalado`, {
    ...(retry ? { description: "Reanudando la acción…" } : {}),
  });
  if (retry) void retry();
}

// Every 409 PACK_REQUIRED from the api opens the dialog (even for calls not wrapped below).
onPackRequired((info) => usePacksStore.getState().openRequest(info));

/**
 * Run an action that may need a model pack. On 409 PACK_REQUIRED the dialog offers the download
 * and re-runs the action once it finishes; resolves `undefined` in that case. Other errors throw.
 */
export async function runWithPack<T>(action: () => Promise<T>): Promise<T | undefined> {
  try {
    return await action();
  } catch (err) {
    const info = packRequiredInfo(err);
    if (!info) throw err;
    usePacksStore.getState().openRequest(info);
    // Wrap the whole user action (request + follow-up), so the retry repeats all of it.
    usePacksStore
      .getState()
      .attachRetry(info.packId, () =>
        runWithPack(action).catch((e: unknown) =>
          toast.error("No se pudo reanudar la acción", { description: errorMessage(e) }),
        ),
      );
    return undefined;
  }
}

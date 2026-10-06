import {
  STEMS_API_ROUTES,
  type JobAccepted,
  type StemsRequestInput,
  type StemsUndoResponse,
} from "@studio/shared";
import { apiFetch } from "./api";

/** Sprint 3b «Separar audio» routes (docs/trabajo/sprint3b-contratos.md §C, STEMS_API_ROUTES). */
export const stemsApi = {
  /** Job audio.stems (409 PACK_REQUIRED «stems» before enqueueing). */
  separate: (body: StemsRequestInput) =>
    apiFetch<JobAccepted>(STEMS_API_ROUTES.stems, { method: "POST", json: body }),
  /** «Deshacer separación»: restores the project saved before the job (409 PROJECT_CHANGED). */
  undo: (undoSnapshotId: string, force = false) =>
    apiFetch<StemsUndoResponse>(STEMS_API_ROUTES.undo, {
      method: "POST",
      json: { undoSnapshotId, ...(force && { force: true }) },
    }),
};

import {
  API_ROUTES,
  type FaceDetectResult,
  type FacePreviewRequestInput,
  type FaceSwapRequestInput,
  type JobAccepted,
  type Project,
} from "@studio/shared";
import { apiFetch } from "./api";

/** Sprint 4 M1 client: «Cambiar cara» (detect faces in a frame, preview job, swap job, undo). */
export const faceApi = {
  /** Faces of the frame `t` (seconds of the asset), left to right; 409 PACK_REQUIRED faceswap. */
  detect: (assetId: string, t: number) =>
    apiFetch<FaceDetectResult>(API_ROUTES.faceDetect, { method: "POST", json: { assetId, t } }),
  preview: (body: FacePreviewRequestInput) =>
    apiFetch<JobAccepted>(API_ROUTES.facePreview, { method: "POST", json: body }),
  /** `confirmed: true` = consent + nobody in the video is a minor (the wizard checkbox). */
  swap: (body: FaceSwapRequestInput) =>
    apiFetch<JobAccepted>(API_ROUTES.faceSwap, { method: "POST", json: body }),
  undo: (projectId: string, clipId: string) =>
    apiFetch<Project>(API_ROUTES.faceUndo, { method: "POST", json: { projectId, clipId } }),
};

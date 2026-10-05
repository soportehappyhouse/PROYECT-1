import {
  API_ROUTES,
  TrackFileSchema,
  type MediaAsset,
  type SamPoint,
  type SamPointsResponse,
  type SamSessionResponse,
  type TrackFile,
  type TrackRef,
  type TrackToKeyframesResult,
  type VisionMaskResult,
  type VisionMatteRequest,
  type VisionMatteResult,
  type VisionReframeRequest,
  type VisionReframeResult,
  type VisionTrackRequest,
  type VisionTrackResult,
} from "@studio/shared";
import { apiFetch, fileUrl, type Accepted } from "./api";

/** Sprint 2 vision routes (docs/trabajo/sprint2-contratos.md, «API»; API_ROUTES.aiVision*). */
export const visionApi = {
  /** Job vision.matte (RVM for video, BiRefNet for images); `target` links clip.matte. */
  matte: (body: VisionMatteRequest) =>
    apiFetch<Accepted<VisionMatteResult>>(API_ROUTES.aiVisionMatte, { method: "POST", json: body }),
  samSession: (assetId: string, frameRange?: [number, number]) =>
    apiFetch<SamSessionResponse>(API_ROUTES.aiVisionSamSession, {
      method: "POST",
      json: { assetId, ...(frameRange && { frameRange }) },
    }),
  /** Points in fractions 0..1 of the source frame; answers the mask PNG of that frame. */
  samPoints: (sessionId: string, frame: number, points: SamPoint[], objId = 1) =>
    apiFetch<SamPointsResponse>(API_ROUTES.aiVisionSamPoints, {
      method: "POST",
      params: { id: sessionId },
      json: { frame, points, objId },
    }),
  /** Job vision.mask: masks + track (+ alpha) of the whole clip. */
  samPropagate: (sessionId: string, assetId?: string) =>
    apiFetch<Accepted<VisionMaskResult>>(API_ROUTES.aiVisionSamPropagate, {
      method: "POST",
      params: { id: sessionId },
      json: { ...(assetId && { assetId }) },
    }),
  samClose: (sessionId: string) =>
    apiFetch<unknown>(API_ROUTES.aiVisionSamSessionItem, {
      method: "DELETE",
      params: { id: sessionId },
    }),
  /** Job vision.track (bbox in source fractions); `target` sets clip.trackRef when done. */
  track: (body: Omit<VisionTrackRequest, "method"> & { method?: VisionTrackRequest["method"] }) =>
    apiFetch<Accepted<VisionTrackResult>>(API_ROUTES.aiVisionTrack, {
      method: "POST",
      json: { method: "auto", ...body },
    }),
  /** Job vision.reframe: crop keyframes (the api also stores them on the saved project). */
  reframe: (body: Partial<VisionReframeRequest> & Pick<VisionReframeRequest, "projectId">) =>
    apiFetch<Accepted<VisionReframeResult>>(API_ROUTES.aiVisionReframe, {
      method: "POST",
      json: body,
    }),
  trackToKeyframes: (projectId: string, clipId: string, perSecond?: number) =>
    apiFetch<Accepted<TrackToKeyframesResult>>(API_ROUTES.aiTrackToKeyframes, {
      method: "POST",
      json: { projectId, clipId, ...(perSecond && { perSecond }) },
    }),
};

/** Mask PNG of session/points: `maskUrl` ("/files/…") or a STORAGE_DIR path. */
export function maskImageUrl(res: Pick<SamPointsResponse, "maskPath" | "maskUrl">): string {
  const u = res.maskUrl;
  if (u && /^(https?:|blob:|data:)/.test(u)) return u;
  if (u?.startsWith("/files/")) return fileUrl(u.slice("/files/".length));
  return fileUrl(res.maskPath);
}

const trackCache = new Map<string, TrackFile>();
const trackLoads = new Map<string, Promise<TrackFile | undefined>>();

/** Cached track.json of a "track" asset (undefined while loading or when missing). */
export function cachedTrack(assetId: string): TrackFile | undefined {
  return trackCache.get(assetId);
}

export function primeTrack(assetId: string, file: TrackFile): void {
  trackCache.set(assetId, file);
}

/** Load (once) the TrackFile of an asset through GET /files/<path>. */
export function loadTrack(
  asset: Pick<MediaAsset, "id" | "path"> | undefined,
): Promise<TrackFile | undefined> {
  if (!asset) return Promise.resolve(undefined);
  const hit = trackCache.get(asset.id);
  if (hit) return Promise.resolve(hit);
  const pending = trackLoads.get(asset.id);
  if (pending) return pending;
  const p = fetch(fileUrl(asset.path))
    .then((r) => (r.ok ? (r.json() as Promise<unknown>) : undefined))
    .then((raw) => {
      const parsed = TrackFileSchema.safeParse(raw);
      if (!parsed.success) return undefined;
      trackCache.set(asset.id, parsed.data);
      return parsed.data;
    })
    .catch(() => undefined)
    .finally(() => trackLoads.delete(asset.id));
  trackLoads.set(asset.id, p);
  return p;
}

/** Default TrackRef for a freshly tracked asset. */
export function defaultTrackRef(assetId: string): TrackRef {
  return { assetId, anchor: "center", offset: { x: 0, y: 0 } };
}

import { DEFAULT_BRAND_KIT, type Clip } from "@studio/shared";
import { vi } from "vitest";
// The real catalog (Spanish labels from packages/remotion), as GET /api/motion/templates returns it.
import { REMOTION_TEMPLATES } from "../../../packages/remotion/src/templates";
import { createEmptyProject, useProjectStore } from "@/stores/project-store";

/** Sprint 6 M2 web tests: fetch mock (path + method -> JSON or binary reply). */
export type Reply = { status?: number; json?: unknown; blob?: Blob } | undefined;
export interface Call {
  path: string;
  method: string;
  body: unknown;
  at: number;
}

export function mockFetch(handler: (path: string, method: string, body: unknown) => Reply): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ path: url.pathname, method, body, at: Date.now() });
    const res = handler(url.pathname, method, body);
    if (!res)
      return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "x" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    if (res.blob) return new Response(res.blob, { status: res.status ?? 200 });
    return new Response(res.json === undefined ? null : JSON.stringify(res.json), {
      status: res.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

/** jsdom has no object URLs. */
export function stubObjectUrls(): void {
  let n = 0;
  globalThis.URL.createObjectURL ??= () => `blob:still-${++n}`;
  globalThis.URL.revokeObjectURL ??= () => undefined;
}

export const PNG = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });

export function setupMotionProject(): Clip {
  const project = createEmptyProject("Motion");
  const track = project.tracks.find((t) => t.kind === "motion")!;
  const clip: Clip = {
    id: "clp_lt",
    trackId: track.id,
    start: 1,
    in: 0,
    out: 4,
    speed: 1,
    volume: 1,
    opacity: 1,
    voiceEffects: [],
    renderedAssetId: "ast_old",
    motion: {
      schemaVersion: 1,
      engine: "remotion",
      template: "lower-third",
      props: { name: "Luis", role: "Happy House" },
      durationSec: 4,
      fps: 30,
      width: 1080,
      height: 1920,
      format: "webm-vp9-alpha",
      includeAudio: false,
    },
  };
  track.clips.push(clip);
  project.settings = { ...project.settings, width: 1080, height: 1920 };
  useProjectStore.getState().loadProject(project);
  return clip;
}

export function motionApi() {
  return mockFetch((path) => {
    if (path === "/api/motion/templates") return { json: REMOTION_TEMPLATES };
    if (path === "/api/motion/engines")
      return { json: [{ id: "remotion", displayName: "Remotion", ok: true }] };
    if (path === "/api/brand-kit") return { json: DEFAULT_BRAND_KIT };
    if (path === "/api/motion/still") return { blob: PNG };
    return undefined;
  });
}

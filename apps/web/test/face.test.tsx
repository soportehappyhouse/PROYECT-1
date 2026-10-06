import type { FaceSwapResult, Job, MediaAsset, PersonSummary, Project } from "@studio/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LicenceDialog } from "@/components/consent/LicenceDialog";
import { PersonsTab } from "@/components/consent/PersonsTab";
import { FaceSwapWizard } from "@/components/face/FaceSwapWizard";
import { LICENCE_OPEN_EVENT, openLicenceDialog } from "@/lib/api";
import { JobFailedError } from "@/lib/job-runner";
import {
  assetTimeOf,
  canAdvance,
  estimateMinutes,
  faceError,
  initialTime,
  selectorOf,
  useFaceStore,
} from "@/stores/face-store";
import { useJobsStore } from "@/stores/jobs-store";
import { useMediaStore } from "@/stores/media-store";
import { usePacksStore } from "@/stores/packs-store";
import { endOfDayIso, usePersonsStore } from "@/stores/persons-store";
import { createEmptyProject, useProjectStore } from "@/stores/project-store";

/** Sprint 4 M1 (web): «Cambiar cara» wizard store, licence dialog and helpers. The api is mocked. */

type Reply = { status?: number; json?: unknown } | undefined;
const calls: { method: string; path: string; search: string; body: unknown }[] = [];

function mockFetch(handler: (path: string, method: string, body: unknown) => Reply) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : init?.body;
    calls.push({ method, path: url.pathname, search: url.search, body });
    const res = handler(url.pathname, method, body);
    if (!res)
      return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "x" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    return new Response(res.json === undefined ? null : JSON.stringify(res.json), {
      status: res.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
}

const ASSET = {
  id: "a1",
  kind: "video",
  name: "Caída",
  path: "media/a1.mp4",
  mimeType: "video/mp4",
  sizeBytes: 1,
  durationSec: 10,
  fps: 25,
  hasAudio: true,
  hasVideo: true,
  createdAt: new Date().toISOString(),
} as MediaAsset;

const ANA: PersonSummary = {
  id: "p1",
  name: "Ana",
  photos: 2,
  voiceSamples: 0,
  face: "vigente",
  voice: "sin consentimiento",
};

function setupProject(): Project {
  const base = createEmptyProject("Doble");
  const project: Project = {
    ...base,
    tracks: base.tracks.map((t) =>
      t.kind === "video"
        ? {
            ...t,
            clips: [
              {
                id: "c1",
                trackId: t.id,
                assetId: "a1",
                start: 2,
                in: 1,
                out: 6,
                speed: 1,
                volume: 1,
                opacity: 1,
                voiceEffects: [],
              },
            ],
          }
        : t,
    ),
  };
  useProjectStore.getState().loadProject(project);
  useProjectStore.getState().setPlayhead(3);
  return project;
}

const job = (id: string, type: Job["type"], status: Job["status"], result: unknown): Job => ({
  id,
  type,
  status,
  progress: 1,
  payload: {},
  result,
  createdAt: new Date().toISOString(),
});

const RESULT: FaceSwapResult = {
  assetId: "a2",
  path: "renders/face/j2/faceswap.mp4",
  frames: 125,
  fps: 25,
  device: "cpu",
  model: "hyperswap_1a_256",
  consentId: "cons1",
  licences: ["faceswap"],
  clipId: "c1",
};

beforeEach(() => {
  vi.restoreAllMocks();
  calls.length = 0;
  useJobsStore.setState({ jobs: {}, intents: {}, handled: {}, connection: "live" });
  useMediaStore.setState({ assets: { a1: ASSET }, order: ["a1"], status: "ready" });
  usePacksStore.setState({ request: undefined, retries: {} });
  useFaceStore.getState().close();
  usePersonsStore.setState({ licenceDialog: { open: false, licenceId: "faceswap" }, licences: [] });
});

describe("face wizard helpers", () => {
  const clip = { start: 2, in: 1, out: 6, speed: 1 };
  it("maps timeline seconds to asset seconds inside the clip", () => {
    expect(assetTimeOf(clip, 3)).toBe(2);
    expect(assetTimeOf({ ...clip, speed: 2 }, 3)).toBe(3);
    expect(assetTimeOf(clip, 0)).toBe(1);
    expect(assetTimeOf(clip, 99)).toBe(5.96);
    expect(initialTime(clip, 3)).toBe(3);
    expect(initialTime(clip, 50)).toBe(2.5);
  });
  it("selector: reference with the picked face, else «one»", () => {
    expect(selectorOf({ faceIndex: undefined, t: 3 }, clip)).toEqual({ mode: "one" });
    expect(selectorOf({ faceIndex: 1, t: 3 }, clip)).toEqual({
      mode: "reference",
      t: 2,
      faceIndex: 1,
      distance: 0.3,
    });
  });
  it("cannot advance without a Persona with consent, the licence, or the confirmation", () => {
    const base = {
      step: "person" as const,
      personId: "p1",
      licenceAccepted: true,
      detect: undefined,
      faceIndex: undefined,
      confirmed: false,
      persons: [ANA],
    };
    expect(canAdvance(base)).toBe(true);
    expect(canAdvance({ ...base, licenceAccepted: false })).toBe(false);
    expect(canAdvance({ ...base, personId: "other" })).toBe(false);
    expect(canAdvance({ ...base, step: "face", faceIndex: 2 })).toBe(false);
    expect(canAdvance({ ...base, step: "apply" })).toBe(false);
    expect(canAdvance({ ...base, step: "apply", confirmed: true })).toBe(true);
  });
  it("estimates minutes from the perf fps and reads job error codes", () => {
    expect(estimateMinutes(60, 25, 15)).toBe(2);
    expect(estimateMinutes(60, 25, undefined)).toBeUndefined();
    const failed = new JobFailedError({
      ...job("j9", "face.swap", "failed", {
        error: {
          code: "CONTENT_BLOCKED",
          message: "El analizador de contenido de FaceFusion bloqueó…",
        },
      }),
      error: "x",
    });
    expect(faceError(failed)).toMatchObject({ code: "CONTENT_BLOCKED", jobId: "j9" });
    expect(endOfDayIso("2027-01-31")).toMatch(/^2027-0[12]-/);
    expect(endOfDayIso("31/01/2027")).toBeUndefined();
  });
});

describe("«Cambiar cara» wizard", () => {
  it("person -> face (detect at the cursor) -> preview -> confirmed apply -> adopts the project", async () => {
    const project = setupProject();
    const swapped: Project = {
      ...project,
      tracks: project.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) =>
          c.id === "c1"
            ? {
                ...c,
                assetId: "a2",
                in: 0,
                out: 5,
                faceSwap: {
                  prev: { assetId: "a1", in: 1, out: 6 },
                  personId: "p1",
                  consentId: "cons1",
                  jobId: "j2",
                },
              }
            : c,
        ),
      })),
    };
    mockFetch((path, method) => {
      if (path === "/api/persons") return { json: [ANA] };
      if (path === "/api/ai/licences") return { json: [{ id: "faceswap", accepted: true }] };
      if (path === "/api/ai/perf") return { json: { facefusion_fps: 12.5 } };
      if (path === "/api/face/detect")
        return {
          json: {
            t: 2,
            width: 640,
            height: 360,
            framePath: "renders/face/detect/f.png",
            faces: [
              { index: 0, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.3 }, score: 0.9 },
              { index: 1, box: { x: 0.6, y: 0.1, w: 0.2, h: 0.3 }, score: 0.8 },
            ],
          },
        };
      if (path === "/api/face/preview") {
        setTimeout(
          () =>
            useJobsStore.getState().upsertJob(
              job("j1", "face.preview", "succeeded", {
                beforePath: "renders/face/j1/before.png",
                afterPath: "renders/face/j1/after.png",
                device: "cpu",
                ms: 900,
              }),
            ),
          5,
        );
        return { status: 202, json: { jobId: "j1" } };
      }
      if (path === "/api/jobs/j1")
        return {
          json: job("j1", "face.preview", "succeeded", {
            beforePath: "renders/face/j1/before.png",
            afterPath: "renders/face/j1/after.png",
            device: "cpu",
            ms: 900,
          }),
        };
      if (path === `/api/projects/${project.id}` && method === "PUT") return { json: project };
      if (path === "/api/ai/gpu") return { json: { cuda: true, mode: "gpu", vram_free_mb: 5000 } };
      if (path === "/api/face/swap") {
        setTimeout(
          () => useJobsStore.getState().upsertJob(job("j2", "face.swap", "succeeded", RESULT)),
          5,
        );
        return { status: 202, json: { jobId: "j2" } };
      }
      if (path === "/api/jobs/j2") return { json: job("j2", "face.swap", "succeeded", RESULT) };
      if (path === `/api/projects/${project.id}`) return { json: swapped };
      if (path === "/api/media") return { json: [ASSET] };
      return undefined;
    });
    const store = useFaceStore.getState();
    await store.openWizard("c1");
    expect(calls.find((c) => c.path === "/api/persons")?.search).toBe("?scope=face");
    let s = useFaceStore.getState();
    expect(s).toMatchObject({
      open: true,
      personId: "p1",
      licenceAccepted: true,
      perfFps: 12.5,
      t: 3,
    });
    s.next();
    await waitFor(() => expect(useFaceStore.getState().detect?.faces).toHaveLength(2));
    expect(calls.find((c) => c.path === "/api/face/detect")?.body).toEqual({ assetId: "a1", t: 2 });
    expect(useFaceStore.getState().faceIndex).toBe(0); // several faces: the first is preselected
    useFaceStore.getState().pickFace(1);
    useFaceStore.getState().next();
    useFaceStore.getState().setOptions({ strength: 0.7 });
    await useFaceStore.getState().runPreview();
    expect(useFaceStore.getState().preview?.afterPath).toBe("renders/face/j1/after.png");
    expect(calls.find((c) => c.path === "/api/face/preview")?.body).toMatchObject({
      personId: "p1",
      assetId: "a1",
      t: 2,
      selector: { mode: "reference", t: 2, faceIndex: 1 },
      options: { strength: 0.7, model: "hyperswap_1a_256" },
    });
    useFaceStore.getState().next();
    // no confirmation -> nothing is sent
    await useFaceStore.getState().apply();
    expect(calls.some((c) => c.path === "/api/face/swap")).toBe(false);
    useFaceStore.getState().setConfirmed(true);
    await useFaceStore.getState().apply();
    s = useFaceStore.getState();
    expect(s.result).toEqual(RESULT);
    expect(calls.find((c) => c.path === "/api/face/swap")?.body).toEqual({
      personId: "p1",
      assetId: "a1",
      selector: { mode: "reference", t: 2, faceIndex: 1, distance: 0.3 },
      options: { model: "hyperswap_1a_256", enhancer: true, enhancerBlend: 80, strength: 0.7 },
      target: { projectId: project.id, clipId: "c1" },
      confirmed: true,
    });
    const clip = useProjectStore
      .getState()
      .project.tracks.flatMap((t) => t.clips)
      .find((c) => c.id === "c1");
    expect(clip?.faceSwap?.personId).toBe("p1");
  });

  it("licence not accepted: the dialog opens and step 1 cannot advance", async () => {
    setupProject();
    mockFetch((path) => {
      if (path === "/api/persons") return { json: [ANA] };
      if (path === "/api/ai/licences")
        return {
          json: [
            {
              id: "faceswap",
              name_es: "Cambio de cara",
              text_es: "texto",
              text_version: "2026-10-06",
              urls: [],
              packs: ["faceswap"],
              accepted: false,
            },
          ],
        };
      return undefined;
    });
    const events: string[] = [];
    window.addEventListener(LICENCE_OPEN_EVENT, () => events.push("open"));
    await useFaceStore.getState().openWizard("c1");
    expect(events).toEqual(["open"]);
    expect(useFaceStore.getState().licenceAccepted).toBe(false);
    expect(canAdvance(useFaceStore.getState())).toBe(false);
    render(<FaceSwapWizard />);
    expect((screen.getByRole("button", { name: /Siguiente/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getAllByText(/leer y aceptar su licencia/).length).toBeGreaterThan(0);
  });

  it("CONSENT_REQUIRED on apply -> error with «Abrir Personas»", async () => {
    setupProject();
    mockFetch((path, method) => {
      if (path === "/api/persons") return { json: [ANA] };
      if (path === "/api/ai/licences") return { json: [{ id: "faceswap", accepted: true }] };
      if (path.startsWith("/api/projects/") && method === "PUT")
        return { json: useProjectStore.getState().project };
      if (path === "/api/ai/gpu") return { json: { cuda: true, mode: "gpu", vram_free_mb: 5000 } };
      if (path === "/api/face/swap")
        return {
          status: 403,
          json: {
            error: {
              code: "CONSENT_REQUIRED",
              message: "Ana no tiene un consentimiento vigente para usar su cara (revocado).",
              details: { personId: "p1", scope: "face", reason: "revoked" },
            },
          },
        };
      return undefined;
    });
    await useFaceStore.getState().openWizard("c1");
    useFaceStore.setState({ step: "apply", confirmed: true });
    await useFaceStore.getState().apply();
    expect(useFaceStore.getState().applyError).toMatchObject({ code: "CONSENT_REQUIRED" });
    render(<FaceSwapWizard />);
    expect(screen.getByRole("button", { name: "Abrir Personas" })).toBeTruthy();
  });

  it("the licence dialog opens on the window event and accepts with the current text version", async () => {
    mockFetch((path) => {
      if (path === "/api/ai/licences")
        return {
          json: [
            {
              id: "faceswap",
              name_es: "Cambio de cara (modelos no comerciales + OpenRAIL-AS)",
              text_es: "texto",
              text_version: "2026-10-06",
              urls: [],
              packs: ["faceswap", "faceswap-extra"],
              accepted: false,
            },
          ],
        };
      if (path === "/api/ai/licences/faceswap/accept")
        return {
          json: {
            id: "faceswap",
            text_version: "2026-10-06",
            text_sha256: "a".repeat(64),
            accepted_at: new Date().toISOString(),
          },
        };
      return undefined;
    });
    render(<LicenceDialog />);
    openLicenceDialog("faceswap");
    await screen.findByRole("dialog");
    const accept = screen.getByRole("button", { name: "Aceptar" }) as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    await waitFor(() => expect(usePersonsStore.getState().licences).toHaveLength(1));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(accept);
    await waitFor(() =>
      expect(calls.find((c) => c.path === "/api/ai/licences/faceswap/accept")?.body).toEqual({
        text_version: "2026-10-06",
        accept: true,
      }),
    );
  });
});

describe("Ajustes → Personas", () => {
  it("creates a Person and shows the versioned consent text with the name and the scope", async () => {
    const person = {
      id: "p9",
      name: "Martín Ruiz",
      photos: [],
      voiceSamples: [],
      consents: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    let created = false;
    mockFetch((path, method) => {
      if (path === "/api/persons" && method === "POST") {
        created = true;
        return { status: 201, json: person };
      }
      if (path === "/api/persons")
        return {
          json: created
            ? [
                {
                  id: "p9",
                  name: "Martín Ruiz",
                  photos: 0,
                  voiceSamples: 0,
                  face: "sin consentimiento",
                  voice: "sin consentimiento",
                },
              ]
            : [],
        };
      return undefined;
    });
    usePersonsStore.setState({
      list: [],
      status: "idle",
      selectedId: undefined,
      person: undefined,
    });
    render(<PersonsTab />);
    await screen.findByText("Todavía no hay Personas registradas.");
    fireEvent.change(screen.getByPlaceholderText(/Nombre de la persona/), {
      target: { value: "Martín Ruiz" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Nueva persona/ }));
    const text = await screen.findByTestId("consent-text");
    expect(text.textContent).toContain("Yo, Martín Ruiz, mayor de edad");
    expect(text.textContent).toContain("usar mi rostro para generar");
    fireEvent.change(screen.getByLabelText("Alcance"), { target: { value: "both" } });
    expect(screen.getByTestId("consent-text").textContent).toContain("mi rostro y voz");
    const submit = screen
      .getAllByRole("button", { name: "Registrar consentimiento" })
      .at(-1) as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // no signature, box unchecked
    expect(calls.find((c) => c.path === "/api/persons" && c.method === "POST")?.body).toEqual({
      name: "Martín Ruiz",
    });
    expect((await screen.findAllByText(/Rostro: sin consentimiento/)).length).toBeGreaterThan(0);
  });
});

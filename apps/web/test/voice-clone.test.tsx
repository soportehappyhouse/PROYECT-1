import type { MediaAsset, PersonSummary, TtsProviderInfo } from "@studio/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoicePanel } from "@/components/panels/VoicePanel";
import type { GpuStatus, PerfResult } from "@/lib/ai-types";
import { PERSONS_CHANGED_EVENT, personsApi } from "@/lib/api-persons";
import { usePacksStore } from "@/stores/packs-store";
import { useSettingsStore } from "@/stores/settings-store";
import {
  chatterboxOnCpu,
  chatterboxRequest,
  cloneOptions,
  currentProvider,
  defaultProvider,
  estimateLabel,
  installedModel,
  modelLabel,
  recordMicrophone,
  textTooLong,
  useVoiceCloneStore,
} from "@/stores/voice-clone-store";

/** Sprint 4 M2 (web): Voces → Chatterbox engine, «Voz propia» and cloning. The api is mocked. */

type Reply = { status?: number; json?: unknown } | undefined;
const calls: { method: string; path: string; search: string; body: unknown }[] = [];

function mockFetch(handler: (path: string, method: string, body: unknown) => Reply) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as unknown)
        : init?.body instanceof FormData
          ? init.body
          : undefined;
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

const PIPER: TtsProviderInfo = {
  id: "piper",
  name: "Piper (local)",
  enabled: true,
  status: "local",
};
const cb = (installed: boolean, extra: Partial<TtsProviderInfo> = {}): TtsProviderInfo => ({
  id: "chatterbox",
  name: "Chatterbox (local, GPU)",
  enabled: installed,
  status: installed ? "local" : "falta paquete",
  packId: "tts-chatterbox",
  installed,
  supportsClone: true,
  models: installed ? ["mtl-v3"] : ["mtl-v3", "mtl-v2"],
  languages: ["es"],
  gpu: true,
  default: false,
  ...extra,
});
const SELF: MediaAsset = {
  id: "vr1",
  kind: "voice-ref",
  name: "Voz propia (06/10/2026 10:00)",
  path: "media/vr1.wav",
  sizeBytes: 1,
  durationSec: 9.6,
  createdAt: new Date().toISOString(),
};
const PERSONS: PersonSummary[] = [
  {
    id: "p1",
    name: "Ana",
    photos: 0,
    voiceSamples: 1,
    face: "sin consentimiento",
    voice: "vigente",
  },
  { id: "p2", name: "Beto", photos: 1, voiceSamples: 0, face: "vigente", voice: "vigente" },
  { id: "p3", name: "Caro", photos: 0, voiceSamples: 2, face: "vigente", voice: "revocado" },
];
const GPU_CPU = { mode: "cpu", vram_free_mb: null, cuda: false } as unknown as GpuStatus;
const GPU_OK = { mode: "gpu", vram_free_mb: 5200, cuda: true } as unknown as GpuStatus;

function apiFor(opts: {
  providers?: TtsProviderInfo[];
  selfRefs?: MediaAsset[];
  gpu?: GpuStatus;
  perf?: Partial<PerfResult>;
  tts?: Reply;
  upload?: Reply;
  persons?: () => PersonSummary[];
}) {
  return mockFetch((path, method) => {
    if (path === "/api/config") return { json: { providers: {}, useCuda: false } };
    if (path === "/api/voice/tts/voices")
      return {
        json: [
          {
            provider: "piper",
            id: "es_AR-daniela-high",
            name: "Daniela",
            language: "es-AR",
            installed: true,
          },
        ],
      };
    if (path === "/api/voice/tts/providers")
      return { json: opts.providers ?? [PIPER, cb(true, { default: true })] };
    if (path === "/api/voice/self-refs" && method === "GET") return { json: opts.selfRefs ?? [] };
    if (path === "/api/voice/self-refs" && method === "POST")
      return opts.upload ?? { status: 201, json: SELF };
    if (path === "/api/persons") return { json: opts.persons ? opts.persons() : PERSONS };
    if (path.startsWith("/api/persons/") && method === "POST") return { json: { id: "c1" } };
    if (path === "/api/ai/gpu") return { json: opts.gpu ?? GPU_OK };
    if (path === "/api/ai/perf") return { json: { chatterbox_rtf: 0.5, ...opts.perf } };
    if (path === "/api/voice/tts" && method === "POST")
      return opts.tts ?? { status: 202, json: { jobId: "j1" } };
    if (path === "/api/jobs/j1")
      return {
        json: {
          id: "j1",
          type: "voice.tts",
          status: "succeeded",
          progress: 1,
          result: { assetId: "out1", path: "renders/j1.wav", aiVoice: "cloned" },
          createdAt: new Date().toISOString(),
        },
      };
    if (path.startsWith("/api/media/") && method === "DELETE") return { status: 204 };
    return undefined;
  });
}

beforeEach(() => {
  calls.length = 0;
  useVoiceCloneStore.getState().reset();
  usePacksStore.setState({ packs: [] });
});
afterEach(() => vi.restoreAllMocks());

// --------------------------------------------------------------------------------- helpers

describe("voice-clone-store helpers", () => {
  it("default engine follows decision 10 (flagged row), else Piper", () => {
    expect(defaultProvider(undefined)).toBe("piper");
    expect(defaultProvider([PIPER, cb(true)])).toBe("piper");
    expect(defaultProvider([PIPER, cb(true, { default: true })])).toBe("chatterbox");
    expect(defaultProvider([PIPER, cb(false, { default: true })])).toBe("piper");
    expect(currentProvider({ chosen: "piper", providers: [cb(true, { default: true })] })).toBe(
      "piper",
    );
  });

  it("clone sources: Ninguna, Voz propia, Persons with valid voice consent and samples", () => {
    expect(cloneOptions([], PERSONS).map((o) => o.value)).toEqual(["none", "person:p1"]);
    const all = cloneOptions([SELF], PERSONS);
    expect(all.map((o) => o.label)).toEqual([
      "Ninguna (voz multilingüe del modelo)",
      "Voz propia",
      "Persona: Ana",
    ]);
  });

  it("builds the Chatterbox request (language es, sliders, voice ids)", () => {
    const base = { exaggeration: 0.7, cfg: 0.3, selfRefId: undefined };
    expect(chatterboxRequest({ ...base, source: "none" }, "Hola")).toEqual({
      provider: "chatterbox",
      text: "Hola",
      voice: "chatterbox:multilingual",
      language: "es",
      exaggeration: 0.7,
      cfg: 0.3,
      temperature: 0.8,
      format: "wav",
    });
    expect(chatterboxRequest({ ...base, source: "self" }, "Hola")).toMatchObject({
      voice: "chatterbox:self",
    });
    expect(chatterboxRequest({ ...base, source: "self" }, "Hola")).not.toHaveProperty("voiceRef");
    expect(chatterboxRequest({ ...base, source: "self", selfRefId: "vr1" }, "x")).toMatchObject({
      voiceRef: { assetId: "vr1", self: true },
    });
    expect(chatterboxRequest({ ...base, source: "person:p1" }, "x")).toMatchObject({
      voice: "chatterbox:person:p1",
      voiceRef: { personId: "p1" },
    });
  });

  it("estimate, model label, CPU warning and text limit", () => {
    expect(estimateLabel("a".repeat(140), { chatterbox_rtf: 2 } as PerfResult)).toBe("≈ 20 s");
    expect(estimateLabel("a".repeat(1400), { chatterbox_rtf: 1 } as PerfResult)).toBe("≈ 1.7 min");
    expect(estimateLabel("hola", undefined)).toBeUndefined();
    expect(installedModel(cb(true))).toBe("mtl-v3");
    expect(installedModel(cb(false))).toBeUndefined();
    expect(modelLabel(cb(true, { models: ["mtl-v2"] }))).toBe("Multilingüe V2 (respaldo)");
    expect(chatterboxOnCpu(GPU_CPU)).toBe(true);
    expect(chatterboxOnCpu({ ...GPU_OK, vram_free_mb: 3000 })).toBe(true);
    expect(chatterboxOnCpu(GPU_OK)).toBe(false);
    expect(textTooLong("a".repeat(5000))).toBe(false);
    expect(textTooLong("a".repeat(5001))).toBe(true);
  });
});

// --------------------------------------------------------------------------------- store

describe("voice-clone-store", () => {
  it("loads providers, «Voz propia», voice Persons, GPU and perf", async () => {
    apiFor({ selfRefs: [SELF] });
    await useVoiceCloneStore.getState().load();
    const s = useVoiceCloneStore.getState();
    expect(currentProvider(s)).toBe("chatterbox");
    expect(s.selfRefs).toEqual([SELF]);
    expect(s.persons).toHaveLength(3);
    expect(s.perf?.chatterbox_rtf).toBe(0.5);
    expect(calls.find((c) => c.path === "/api/persons")?.search).toBe("?scope=voice");
  });

  it("forgets a clone source that is no longer offered", async () => {
    useVoiceCloneStore.setState({ source: "person:p3" });
    apiFor({});
    await useVoiceCloneStore.getState().load();
    expect(useVoiceCloneStore.getState().source).toBe("none");
  });

  it("«Voz propia» upload needs «Soy yo» and posts attestSelf + audio", async () => {
    apiFor({});
    const blob = new Blob([new Uint8Array(100)], { type: "audio/webm" });
    expect(await useVoiceCloneStore.getState().uploadSelfRef(blob)).toBeUndefined();
    expect(useVoiceCloneStore.getState().lastError).toMatch(/Soy yo/);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    useVoiceCloneStore.getState().setAttestSelf(true);
    const asset = await useVoiceCloneStore.getState().uploadSelfRef(blob);
    expect(asset?.id).toBe("vr1");
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/voice/self-refs")!;
    const form = post.body as FormData;
    expect(form.get("attestSelf")).toBe("true");
    expect((form.get("audio") as File).name).toBe("voz-propia.webm");
    expect(useVoiceCloneStore.getState()).toMatchObject({ source: "self", record: "idle" });
    expect(useVoiceCloneStore.getState().selfRefs.map((a) => a.id)).toEqual(["vr1"]);
  });

  it("explains a rejected sample and files over 25 MB", async () => {
    apiFor({
      upload: {
        status: 400,
        json: { error: { code: "VOICE_SAMPLE_INVALID", message: "La muestra tiene que…" } },
      },
    });
    useVoiceCloneStore.getState().setAttestSelf(true);
    await useVoiceCloneStore.getState().uploadSelfRef(new Blob(["x"], { type: "audio/wav" }));
    expect(useVoiceCloneStore.getState().lastError).toBe(
      "La muestra tiene que durar entre 5 y 60 s y tener voz.",
    );
    const big = { size: 26 * 1024 * 1024, type: "audio/wav" } as Blob;
    await useVoiceCloneStore.getState().uploadSelfRef(big);
    expect(useVoiceCloneStore.getState().lastError).toBe("La muestra supera 25 MB.");
  });

  it("deleting the last sample goes back to «Ninguna»", async () => {
    apiFor({});
    useVoiceCloneStore.setState({ selfRefs: [SELF], source: "self" });
    await useVoiceCloneStore.getState().deleteSelfRef("vr1");
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/api/media/vr1" });
    expect(useVoiceCloneStore.getState()).toMatchObject({ selfRefs: [], source: "none" });
  });

  it("records with MediaRecorder and uploads the blob", async () => {
    apiFor({});
    const stop = vi.fn();
    class FakeRecorder {
      mimeType = "audio/webm;codecs=opus";
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.ondataavailable?.({ data: new Blob([new Uint8Array(10)]) });
      }
      stop() {
        this.ondataavailable?.({ data: new Blob([new Uint8Array(10)]) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop }] })) },
    });
    const blob = await recordMicrophone(0.15);
    expect(blob.size).toBe(20);
    expect(stop).toHaveBeenCalled();
    useVoiceCloneStore.getState().setAttestSelf(true);
    const asset = await useVoiceCloneStore.getState().recordSelfRef(0.15);
    expect(asset?.kind).toBe("voice-ref");
    vi.unstubAllGlobals();
  });
});

// --------------------------------------------------------------------------------- panel

describe("Voces panel: Chatterbox", () => {
  it("Chatterbox by default: language fixed es, clone list, sliders, PerTh, estimate", async () => {
    apiFor({ selfRefs: [SELF] });
    render(<VoicePanel />);
    await screen.findByTestId("chatterbox-options");
    expect((screen.getByLabelText("Motor") as HTMLSelectElement).value).toBe("chatterbox");
    expect((screen.getByLabelText("Idioma") as HTMLSelectElement).value).toBe("es");
    const clone = screen.getByLabelText("Voz a clonar") as HTMLSelectElement;
    expect([...clone.options].map((o) => o.text)).toEqual([
      "Ninguna (voz multilingüe del modelo)",
      "Voz propia",
      "Persona: Ana",
    ]);
    expect((screen.getByLabelText("Expresividad") as HTMLInputElement).value).toBe("0.5");
    expect(
      (screen.getByLabelText("Fidelidad al acento de la referencia") as HTMLInputElement).value,
    ).toBe("0.5");
    expect(screen.getByText(/marca de agua inaudible \(PerTh\)/)).toBeTruthy();
    expect(screen.getByText(/Modelo: Multilingüe V3/)).toBeTruthy();
    expect(screen.queryByTestId("chatterbox-cpu")).toBeNull();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "a".repeat(140) } });
    expect(screen.getByText(/Tiempo estimado: ≈ 5 s/)).toBeTruthy(); // 10 s of speech × RTF 0.5
    expect(screen.getByText("140 / 5000 caracteres")).toBeTruthy();
    expect(screen.queryByText(/Velocidad/)).toBeNull(); // Chatterbox has no speed control
  });

  it("warns before running on the CPU and blocks text over 5000", async () => {
    apiFor({ gpu: GPU_CPU });
    render(<VoicePanel />);
    await screen.findByTestId("chatterbox-cpu");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "a".repeat(5001) } });
    expect(screen.getByText(/dividí el texto/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /Generar y añadir/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("clones a Person: request with voiceRef, then «Marcado como voz clonada»", async () => {
    const ok = vi.spyOn(toast, "success").mockImplementation(() => "t");
    apiFor({});
    render(<VoicePanel />);
    await screen.findByTestId("chatterbox-options");
    fireEvent.change(screen.getByLabelText("Voz a clonar"), { target: { value: "person:p1" } });
    fireEvent.change(screen.getByLabelText("Fidelidad al acento de la referencia"), {
      target: { value: "0.3" },
    });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Hola, che" } });
    fireEvent.click(screen.getByRole("button", { name: /Generar y añadir/ }));
    // waitForJob polls GET /api/jobs/:id every 2 s (no SSE in the test)
    await waitFor(
      () =>
        expect(ok).toHaveBeenCalledWith(
          "Voz clonada agregada al cursor",
          expect.objectContaining({
            description: "Marcado como voz clonada (Revisión para redes).",
          }),
        ),
      { timeout: 5000 },
    );
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/voice/tts")!;
    expect(post.body).toMatchObject({
      provider: "chatterbox",
      voice: "chatterbox:person:p1",
      voiceRef: { personId: "p1" },
      language: "es",
      cfg: 0.3,
      exaggeration: 0.5,
    });
  });

  it("a Person registered or revoked while the panel is open is picked up (event, focus, engine)", async () => {
    let persons: PersonSummary[] = [];
    apiFor({ persons: () => persons });
    render(<VoicePanel />);
    await screen.findByTestId("chatterbox-options");
    const texts = () =>
      [...(screen.getByLabelText("Voz a clonar") as HTMLSelectElement).options].map((o) => o.text);
    expect(texts()).not.toContain("Persona: Ana");
    // Ajustes → Personas (M1) announces every change; the Voz panel (M2) stays mounted
    persons = PERSONS;
    const heard = vi.fn();
    window.addEventListener(PERSONS_CHANGED_EVENT, heard);
    await act(async () => {
      await personsApi.revokeConsent("p3", "c1");
    });
    window.removeEventListener(PERSONS_CHANGED_EVENT, heard);
    expect(heard).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(texts()).toContain("Persona: Ana"));
    // changed elsewhere (api / console): focusing «Voz a clonar» reloads
    persons = [];
    fireEvent.focus(screen.getByLabelText("Voz a clonar"));
    await waitFor(() => expect(texts()).not.toContain("Persona: Ana"));
    // choosing the Chatterbox engine reloads too
    persons = PERSONS;
    fireEvent.change(screen.getByLabelText("Motor"), { target: { value: "piper" } });
    fireEvent.change(screen.getByLabelText("Motor"), { target: { value: "chatterbox" } });
    await waitFor(() => expect(texts()).toContain("Persona: Ana"));
  });

  it("CONSENT_REQUIRED offers «Abrir Personas»", async () => {
    const err = vi.spyOn(toast, "error").mockImplementation(() => "t");
    apiFor({
      tts: {
        status: 403,
        json: {
          error: {
            code: "CONSENT_REQUIRED",
            message: "Ana no tiene un consentimiento vigente para usar su voz (revocado).",
          },
        },
      },
    });
    render(<VoicePanel />);
    await screen.findByTestId("chatterbox-options");
    fireEvent.change(screen.getByLabelText("Voz a clonar"), { target: { value: "person:p1" } });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Hola" } });
    fireEvent.click(screen.getByRole("button", { name: /Generar y añadir/ }));
    await waitFor(() => expect(err).toHaveBeenCalled());
    const [, opts] = err.mock.calls[0]!;
    const action = (opts as { action: { label: string; onClick: () => void } }).action;
    expect(action.label).toBe("Abrir Personas");
    act(() => action.onClick());
    expect(useSettingsStore.getState().settingsTab).toBe("persons");
  });

  it("without the pack: «Descargar paquete» opens the pack dialog; «Usar Piper» switches", async () => {
    apiFor({ providers: [PIPER, cb(false)] });
    usePacksStore.setState({
      packs: [{ id: "tts-chatterbox", name_es: "Voz avanzada", size_bytes: 6.2e9 } as never],
    });
    render(<VoicePanel />);
    await waitFor(() => expect(useVoiceCloneStore.getState().providers).toBeDefined());
    expect((screen.getByLabelText("Motor") as HTMLSelectElement).value).toBe("piper");
    fireEvent.change(screen.getByLabelText("Motor"), { target: { value: "chatterbox" } });
    await screen.findByTestId("chatterbox-missing");
    fireEvent.click(screen.getByRole("button", { name: /Descargar paquete \(6,2 GB\)/ }));
    expect(usePacksStore.getState().request?.info.packId).toBe("tts-chatterbox");
    usePacksStore.getState().closeRequest();
    fireEvent.click(screen.getByRole("button", { name: "Usar Piper" }));
    expect((screen.getByLabelText("Motor") as HTMLSelectElement).value).toBe("piper");
    expect(screen.queryByTestId("chatterbox-missing")).toBeNull();
  });

  it("«Voz propia»: recording/upload only after «Soy yo»; samples listed and playable", async () => {
    apiFor({ selfRefs: [SELF] });
    render(<VoicePanel />);
    await screen.findByText(SELF.name);
    const rec = screen.getByRole("button", { name: /Grabar 10 s/ }) as HTMLButtonElement;
    expect(rec.disabled).toBe(true);
    expect(
      (screen.getByLabelText("Subir muestra de voz propia") as HTMLInputElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByLabelText("Soy yo: es mi propia voz"));
    expect(rec.disabled).toBe(false);
    expect(screen.getByText(/Che, ¿viste que mañana llueve\?/)).toBeTruthy();
    const audio = document.querySelector("audio")!;
    expect(audio.getAttribute("src")).toMatch(/\/files\/media\/vr1\.wav$/);
    const file = new File([new Uint8Array(50)], "mi-voz.wav", { type: "audio/wav" });
    fireEvent.change(screen.getByLabelText("Subir muestra de voz propia"), {
      target: { files: [file] },
    });
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.path === "/api/voice/self-refs")).toBe(
        true,
      ),
    );
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/voice/self-refs")!;
    expect(((post.body as FormData).get("audio") as File).name).toBe("mi-voz.wav");
  });
});

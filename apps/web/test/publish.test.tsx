import type { AiProvenance, Clip, MediaAsset, Pack, Project } from "@studio/shared";
import { detectedPublishFlags } from "@studio/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AiPacksTab,
  chatterboxModelLabel,
  chatterboxPerfLabel,
  chatterboxVariantLabel,
  faceSwapPerfLabel,
  rvcPerfLabel,
} from "@/components/dashboard/AiPacksTab";
import { aiBadgeLabel } from "@/components/panels/MediaPanel";
import { SocialReview } from "@/components/panels/SocialReview";
import { DEFAULT_PUBLISH } from "@/lib/ai-types";
import {
  effectiveFlags,
  missingLockedFlags,
  nextPublish,
  projectAiContent,
  projectPublish,
  socialPatch,
} from "@/lib/publish";
import { useMediaStore } from "@/stores/media-store";
import { usePacksStore } from "@/stores/packs-store";
import { usePersonsStore } from "@/stores/persons-store";
import { createEmptyProject, useProjectStore } from "@/stores/project-store";

/** Sprint 4 (M3): «Revisión para redes» from the media provenance + Ajustes → Paquetes de IA. */

const now = "2026-10-06T00:00:00.000Z";

function prov(kind: AiProvenance["kind"], personId?: string): AiProvenance {
  return {
    kind,
    tool: kind === "face" ? "facefusion 3.9.1" : "chatterbox mtl-v3",
    createdAt: now,
    ...(personId && { personId }),
  };
}

function asset(id: string, name: string, p?: AiProvenance): MediaAsset {
  return {
    id,
    kind: p?.kind === "face" ? "video" : "audio",
    name,
    path: `media/${id}`,
    sizeBytes: 1,
    createdAt: now,
    ...(p && { aiAltered: true, aiProvenance: p }),
  } as MediaAsset;
}

const clip = (p: Pick<Clip, "id" | "trackId" | "assetId">): Clip => ({
  start: 0,
  in: 0,
  out: 5,
  speed: 1,
  volume: 1,
  opacity: 1,
  voiceEffects: [],
  ...p,
});

function load(assets: MediaAsset[], placement: Record<string, "video" | "audio">): Project {
  const p = createEmptyProject("Redes");
  for (const [assetId, kind] of Object.entries(placement)) {
    const track = p.tracks.find((t) => t.kind === kind)!;
    track.clips.push(clip({ id: `c-${assetId}`, trackId: track.id, assetId }));
  }
  useProjectStore.getState().loadProject(p);
  useMediaStore.setState({ assets: Object.fromEntries(assets.map((a) => [a.id, a])) });
  return p;
}

const SWAP = asset("swap", "Doble", prov("face", "per1"));
const TTS = asset("tts", "Locución", prov("voice-synthetic"));
const CLONE = asset("clone", "Voz de Ana", prov("voice-cloned", "per2"));

beforeEach(() => {
  vi.restoreAllMocks();
  useProjectStore.getState().loadProject(createEmptyProject("Redes"));
  useMediaStore.setState({ assets: {} });
  usePersonsStore.setState({
    list: [
      {
        id: "per1",
        name: "Ana",
        photos: 1,
        voiceSamples: 0,
        face: "vigente",
        voice: "sin consentimiento",
      },
    ],
    licences: [],
  });
});

describe("publish helpers with detection", () => {
  it("locks face and cloned voice; a synthetic voice is marked but editable", () => {
    load([SWAP, TTS], { swap: "video", tts: "audio" });
    const project = useProjectStore.getState().project;
    const report = projectAiContent(project, useMediaStore.getState().assets);
    const d = detectedPublishFlags(report);
    expect(d.locked).toEqual({ aiFace: true, aiVoice: false });
    expect(effectiveFlags(DEFAULT_PUBLISH.flags, d)).toMatchObject({
      aiFace: true,
      aiVoice: false,
    });
    expect(socialPatch(true, report)).toEqual({
      forSocial: true,
      flags: { aiFace: true, aiVoice: true },
    });
    expect(socialPatch(false, report)).toEqual({ forSocial: false });
    // the locked flag survives an uncheck; the synthetic voice can be unchecked
    let p = nextPublish(DEFAULT_PUBLISH, socialPatch(true, report), d);
    expect(p.aiLabel).toBe(true); // proposed when marking «Voy a subirlo a redes» (D4)
    p = nextPublish(p, { flags: { aiFace: false, aiVoice: false } }, d);
    expect(p.flags.aiFace).toBe(true);
    expect(p.flags.aiVoice).toBe(false);
    expect(missingLockedFlags(DEFAULT_PUBLISH.flags, d)).toEqual({ aiFace: true });
  });

  it("internal use keeps the label off even with AI content (decision 4)", () => {
    load([CLONE], { clone: "audio" });
    const report = projectAiContent(
      useProjectStore.getState().project,
      useMediaStore.getState().assets,
    );
    const p = nextPublish(
      DEFAULT_PUBLISH,
      { flags: { aiVoice: true } },
      detectedPublishFlags(report),
    );
    expect(p.forSocial).toBe(false);
    expect(p.aiLabel).toBe(false);
  });
});

describe("SocialReview (sprint 4)", () => {
  it("shows the detected rows; face and cloned voice are checked and locked", () => {
    load([SWAP, CLONE, TTS], { swap: "video", clone: "audio", tts: "audio" });
    render(<SocialReview />);
    // internal use: label off, but the detection is visible
    expect(screen.getByTestId("ai-label-off")).toBeTruthy();
    expect(screen.getByTestId("ai-detected-face").textContent).toContain("Persona: Ana");
    fireEvent.click(screen.getByRole("checkbox", { name: "Voy a subirlo a redes" }));
    const face = screen.getByRole("checkbox", {
      name: /Cara generada o cambiada/,
    }) as HTMLInputElement;
    const voice = screen.getByRole("checkbox", {
      name: /Voz generada o clonada/,
    }) as HTMLInputElement;
    expect(face.checked && face.disabled).toBe(true);
    expect(voice.checked && voice.disabled).toBe(true);
    expect(screen.getByTestId("ai-detected-voice-cloned").textContent).toContain("Voz de Ana");
    expect(screen.getByTestId("ai-detected-voice-synthetic").textContent).toContain("Locución");
    const publish = projectPublish(useProjectStore.getState().project);
    expect(publish).toMatchObject({
      forSocial: true,
      aiLabel: true,
      flags: { aiFace: true, aiVoice: true },
    });
    // unchecking «Voy a subirlo a redes» turns the label off (it stays only for social media)
    fireEvent.click(screen.getByRole("checkbox", { name: "Voy a subirlo a redes" }));
    expect(screen.getByTestId("ai-label-off")).toBeTruthy();
  });

  it("only a synthetic voice: marked when going to social, but it can be unchecked", () => {
    load([TTS], { tts: "audio" });
    render(<SocialReview />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Voy a subirlo a redes" }));
    const voice = screen.getByRole("checkbox", {
      name: /Voz generada o clonada/,
    }) as HTMLInputElement;
    expect(voice.checked).toBe(true);
    expect(voice.disabled).toBe(false);
    fireEvent.click(voice);
    expect(projectPublish(useProjectStore.getState().project).flags.aiVoice).toBe(false);
  });

  it("no AI media: no detection block", () => {
    load([asset("plain", "Plano")], { plain: "video" });
    render(<SocialReview />);
    expect(screen.queryByTestId("ai-detected")).toBeNull();
  });
});

describe("Media badges and performance labels", () => {
  it("labels AI media", () => {
    expect(aiBadgeLabel(SWAP)).toBe("IA: cara");
    expect(aiBadgeLabel(TTS)).toBe("IA: voz");
    expect(aiBadgeLabel(CLONE)).toBe("IA: voz clonada");
    expect(aiBadgeLabel(asset("p", "P"))).toBeUndefined();
  });

  it("labels the Chatterbox model variant of the venv", () => {
    expect(chatterboxModelLabel(["mtl-v3"])).toBe("V3");
    expect(chatterboxModelLabel(["mtl-v2"])).toBe("V2 (respaldo PyPI)");
    expect(chatterboxModelLabel(undefined)).toBeUndefined();
  });

  it("formats RVC, Chatterbox and FaceFusion results in Spanish", () => {
    expect(rvcPerfLabel({ rvc_s_per_min: 8.25, rvc_device: "cuda" })).toBe(
      "8,3 s por minuto (GPU)",
    );
    expect(rvcPerfLabel({ rvc_s_per_min: 70, rvc_device: "cpu" })).toBe("70,0 s por minuto (CPU)");
    expect(rvcPerfLabel({})).toBeUndefined();
    expect(chatterboxPerfLabel({ chatterbox_rtf: 0.62, chatterbox_device: "cuda" })).toBe(
      "RTF 0,62 (≈ 6,2 s por cada 10 s de voz, GPU)",
    );
    expect(
      faceSwapPerfLabel({ facefusion_fps: 18, facefusion_enh_fps: 7, facefusion_startup_s: 0 }),
    ).toBe("18,0 fps (≈ 1,7 min por minuto a 1080p; con mejorador 7,0 fps)");
    expect(
      chatterboxVariantLabel({ tools: { chatterbox: { variant: "v2", version: "0.1.7" } } }),
    ).toBe("V2 (respaldo PyPI 0.1.7)");
  });
});

describe("Ajustes → Paquetes de IA (sprint 4)", () => {
  const PACK = (p: Partial<Pack>): Pack =>
    ({
      id: "faceswap",
      name_es: "Cambio de cara (FaceFusion 3.9.1)",
      description_es: "",
      size_bytes: 4e9,
      installed: false,
      partial: false,
      files: [],
      required_by: ["face.swap"],
      license: "OpenRAIL-AS",
      group: "faceswap",
      ...p,
    }) as Pack;

  it("gated packs ask to read and accept the licence; the venv state is shown", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("[]", { status: 200 }),
    );
    vi.spyOn(usePacksStore.getState(), "load").mockResolvedValue(undefined as never);
    vi.spyOn(usePersonsStore.getState(), "loadLicences").mockResolvedValue([]);
    usePacksStore.setState({
      packs: [
        PACK({ licence_gate: "faceswap", tool: { id: "facefusion", state: "python" } }),
        PACK({
          id: "tts-chatterbox",
          name_es: "Voz avanzada",
          licence_gate: null,
          tool: { id: "chatterbox", state: "ready" },
        }),
      ],
      status: "ready",
    });
    const opened: unknown[] = [];
    const onOpen = (e: Event) => opened.push((e as CustomEvent).detail);
    window.addEventListener("studio:licence:open", onOpen);
    render(<AiPacksTab />);
    expect(screen.getAllByTestId("pack-licence")).toHaveLength(1);
    expect(screen.getByText("No comercial: requiere aceptar licencia")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Leer y aceptar/ }));
    expect(opened).toEqual([{ licenceId: "faceswap" }]);
    const tools = screen.getAllByTestId("pack-tool").map((n) => n.textContent);
    expect(tools[0]).toContain("falta Python 3.12");
    expect(tools[1]).toContain("listo");
    window.removeEventListener("studio:licence:open", onOpen);
  });
});

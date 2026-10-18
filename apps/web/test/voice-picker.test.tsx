import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoicePanel } from "@/components/panels/VoicePanel";
import { voiceDisplayName } from "@/lib/voices";
import { mockFetch } from "./design-helpers";

function voiceApi(providers: Record<string, boolean> = {}) {
  return mockFetch((path) => {
    if (path === "/api/config") return { json: { providers, useCuda: false } };
    if (path === "/api/voice/tts/voices") return { json: [] };
    if (path === "/api/voice/tts/providers") return { json: [] };
    if (path === "/api/voice/self-refs") return { json: [] };
    if (path === "/api/persons") return { json: [] };
    if (path === "/api/voice/rvc/models") return { json: [] };
    return undefined;
  });
}

/** Sprint 6 M2 (H20): one «¿Qué voz?» picker. */
describe("voice picker", () => {
  afterEach(() => vi.restoreAllMocks());

  it("offers 3 options: Mis voces · Voces de Studio · Convertir mi grabación", async () => {
    voiceApi();
    render(<VoicePanel />);
    const picker = await screen.findByTestId("voice-picker");
    const tabs = within(picker)
      .getAllByRole("tab")
      .map((t) => t.textContent);
    expect(tabs).toEqual(["Mis voces", "Voces de Studio", "Convertir mi grabación"]);
  });

  it("engines without a key are hidden from the engine list (only listed in «Avanzado»)", async () => {
    voiceApi({ elevenlabs: false, openai: false });
    render(<VoicePanel />);
    const motor = (await screen.findByRole("combobox", { name: "Motor" })) as HTMLSelectElement;
    const options = [...motor.options].map((o) => o.textContent ?? "");
    expect(options.some((o) => /ElevenLabs|OpenAI/.test(o))).toBe(false);
    expect(options).toHaveLength(2);
    await screen.findByTestId("voice-advanced");
    expect(screen.getByTestId("voice-advanced").textContent).toMatch(/ElevenLabs, OpenAI/);
  });

  it("an engine with its key shows up; «Mis voces» and «Convertir» have no engine list", async () => {
    voiceApi({ elevenlabs: true, openai: false });
    render(<VoicePanel />);
    const motor = (await screen.findByRole("combobox", { name: "Motor" })) as HTMLSelectElement;
    await vi.waitFor(() =>
      expect([...motor.options].some((o) => /ElevenLabs/.test(o.textContent ?? ""))).toBe(true),
    );
    fireEvent.click(screen.getByRole("tab", { name: "Mis voces" }));
    expect(screen.queryByRole("combobox", { name: "Motor" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Convertir mi grabación" }));
    expect(screen.queryByRole("combobox", { name: "Motor" })).toBeNull();
    expect(screen.getByRole("button", { name: /Convertir voz/ })).toBeTruthy();
  });

  it("voice names keep their accents (H19)", () => {
    expect(voiceDisplayName("Claude (Mexico)")).toBe("Claude (México)");
    expect(voiceDisplayName("Davefx (Espana, baja)")).toBe("Davefx (España, baja)");
  });
});

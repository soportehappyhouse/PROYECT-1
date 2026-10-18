import { UI_ENGLISH_DENYLIST } from "@studio/shared";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InspectorPanel } from "@/components/panels/InspectorPanel";
import { MotionPanel } from "@/components/panels/MotionPanel";
import { VoicePanel } from "@/components/panels/VoicePanel";
import { useProjectStore } from "@/stores/project-store";
import { motionApi, setupMotionProject, stubObjectUrls } from "./design-helpers";

const deny = UI_ENGLISH_DENYLIST.map(
  (t) => new RegExp(`(^|[^\\p{L}])${t.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}($|[^\\p{L}])`, "iu"),
);

/** Visible text outside the folded «Avanzado» sections (option labels included). */
export function visibleText(root: HTMLElement): string {
  const copy = root.cloneNode(true) as HTMLElement;
  for (const d of copy.querySelectorAll("details")) d.remove();
  const parts = [copy.textContent ?? ""];
  for (const el of copy.querySelectorAll("[title],[aria-label],[placeholder]"))
    for (const a of ["title", "aria-label", "placeholder"]) {
      const v = el.getAttribute(a);
      if (v) parts.push(v);
    }
  return parts.join(" \n ");
}

export function englishTerms(text: string): string[] {
  return UI_ENGLISH_DENYLIST.filter((_, i) => deny[i]!.test(text));
}

/** Sprint 6 M2 (C3): 0 English terms visible in Motion, Propiedades and Voz. */
describe("UI language (UI_ENGLISH_DENYLIST)", () => {
  beforeEach(() => stubObjectUrls());
  afterEach(() => vi.restoreAllMocks());

  it("Propiedades of a motion clip", async () => {
    const clip = setupMotionProject();
    motionApi();
    useProjectStore.getState().selectClip(clip.id);
    const { container } = render(<InspectorPanel />);
    await screen.findByRole("combobox", { name: /Estilo/ });
    expect(englishTerms(visibleText(container))).toEqual([]);
  });

  it("Motion graphics panel with a template chosen", async () => {
    setupMotionProject();
    motionApi();
    const { container } = render(<MotionPanel />);
    const select = (await screen.findByRole("combobox", {
      name: /Plantilla/,
    })) as HTMLSelectElement;
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(select, { target: { value: "remotion:lower-third" } });
    await screen.findByRole("combobox", { name: /Estilo/ });
    expect(englishTerms(visibleText(container))).toEqual([]);
  });

  it("Voz panel", async () => {
    const { mockFetch } = await import("./design-helpers");
    mockFetch((path) => {
      if (path === "/api/config") return { json: { providers: {}, useCuda: false } };
      if (path.startsWith("/api/voice") || path === "/api/persons") return { json: [] };
      return undefined;
    });
    const { container } = render(<VoicePanel />);
    await screen.findByTestId("voice-picker");
    expect(englishTerms(visibleText(container))).toEqual([]);
    for (const tab of ["Mis voces", "Convertir mi grabación"]) {
      const { fireEvent } = await import("@testing-library/react");
      fireEvent.click(screen.getByRole("tab", { name: tab }));
      expect(englishTerms(visibleText(container)), tab).toEqual([]);
    }
  });
});

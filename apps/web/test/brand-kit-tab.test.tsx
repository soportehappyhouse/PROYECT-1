import { DEFAULT_BRAND_KIT, type BrandKit } from "@studio/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrandKitTab, lowContrastColors } from "@/components/design/BrandKitTab";
import { STILL_DEBOUNCE_MS } from "@/hooks/use-design";
import { mockFetch, PNG, stubObjectUrls } from "./design-helpers";

/** Sprint 6 M2: Ajustes → Kit de marca. */
describe("BrandKitTab", () => {
  let kit: BrandKit;
  beforeEach(() => {
    stubObjectUrls();
    kit = structuredClone(DEFAULT_BRAND_KIT);
  });
  afterEach(() => vi.restoreAllMocks());

  const api = () =>
    mockFetch((path, method, body) => {
      if (path === "/api/brand-kit" && method === "GET") return { json: kit };
      if (path === "/api/brand-kit" && method === "PUT") {
        kit = { ...kit, ...(body as Partial<BrandKit>), updated_at: new Date().toISOString() };
        return { json: kit };
      }
      if (path === "/api/media") return { json: [] };
      if (path === "/api/motion/still") return { blob: PNG };
      return undefined;
    });

  it("asks the api for stills of the title, lower third and captions after the debounce", async () => {
    const calls = api();
    const t0 = Date.now();
    render(<BrandKitTab />);
    await screen.findByTestId("brand-kit-tab");
    expect(calls.filter((c) => c.path === "/api/motion/still")).toHaveLength(0);
    await waitFor(
      () => expect(calls.filter((c) => c.path === "/api/motion/still")).toHaveLength(3),
      { timeout: 3000 },
    );
    const stills = calls.filter((c) => c.path === "/api/motion/still");
    expect(stills[0]!.at - t0).toBeGreaterThanOrEqual(STILL_DEBOUNCE_MS - 20);
    expect(stills.map((c) => (c.body as { template: string }).template).sort()).toEqual([
      "animated-captions",
      "lower-third",
      "title-card",
    ]);
    expect(stills.every((c) => (c.body as { width: number }).width === 540)).toBe(true);
  });

  it("changing the accent saves the kit (debounced) and refreshes the preview", async () => {
    const calls = api();
    render(<BrandKitTab />);
    const accent = await screen.findByLabelText("Color Acento");
    await waitFor(
      () => expect(calls.filter((c) => c.path === "/api/motion/still")).toHaveLength(3),
      {
        timeout: 3000,
      },
    );
    fireEvent.change(accent, { target: { value: "#00aaff" } });
    await waitFor(
      () => expect(calls.some((c) => c.method === "PUT" && c.path === "/api/brand-kit")).toBe(true),
      { timeout: 3000 },
    );
    const put = calls.find((c) => c.method === "PUT")!;
    expect((put.body as BrandKit).tokens.color.accent).toBe("#00AAFF");
    // New kit version -> the 3 stills are requested again.
    await waitFor(
      () =>
        expect(calls.filter((c) => c.path === "/api/motion/still").length).toBeGreaterThanOrEqual(
          6,
        ),
      {
        timeout: 3000,
      },
    );
  });

  it("says the logo is not drawn yet and locks the weight of one-face fonts (audit S6 E12–E13)", async () => {
    api();
    render(<BrandKitTab />);
    expect((await screen.findByTestId("kit-logo-pending")).textContent).toMatch(
      /todavía no se dibuja/,
    );
    // Default kit: display = Anton (one face) → its weight select is disabled; title is not.
    const selects = screen
      .getAllByRole("combobox")
      .filter((el) => (el as HTMLSelectElement).options[0]?.value === "400");
    expect(selects.some((el) => (el as HTMLSelectElement).disabled)).toBe(true);
    expect(selects.some((el) => !(el as HTMLSelectElement).disabled)).toBe(true);
  });

  it("a low-contrast color is marked live", async () => {
    api();
    render(<BrandKitTab />);
    const text = await screen.findByLabelText("Color Texto");
    expect(text.getAttribute("data-low-contrast")).toBeNull();
    fireEvent.change(text, { target: { value: "#333333" } });
    await waitFor(() => expect(text.getAttribute("data-low-contrast")).toBe("true"));
    expect(text.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getAllByText(/Poco contraste/).length).toBeGreaterThan(0);
    expect(lowContrastColors(DEFAULT_BRAND_KIT.tokens).size).toBe(0);
  });

  it("«Calibrar con una captura» shows the screenshot calibrator with 4 sliders", async () => {
    api();
    render(<BrandKitTab />);
    fireEvent.click(await screen.findByRole("button", { name: "Calibrar con una captura" }));
    const cal = await screen.findByTestId("calibrator");
    expect(cal.querySelectorAll('input[type="range"]')).toHaveLength(4);
    expect(screen.getByLabelText("Captura del teléfono")).toBeTruthy();
  });
});

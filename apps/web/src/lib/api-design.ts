/**
 * Sprint 6 M2 client: brand kit, design tokens, checklist, motion stills and the bundled fonts
 * (docs/trabajo/sprint6-contratos.md §M2). lib/api.ts stays untouched (shared rule).
 */
import {
  API_ROUTES,
  BUNDLED_FONT_FAMILIES,
  type BrandKit,
  type BrandKitUpdate,
  type DesignAspect,
  type DesignCheckResult,
  type MotionStillRequest,
  type ResolvedDesign,
} from "@studio/shared";
import { API_URL, ApiRequestError, apiFetch, apiUrl, uploadFile } from "./api";

export const designApi = {
  brandKit: () => apiFetch<BrandKit>(API_ROUTES.brandKit),
  saveBrandKit: (patch: BrandKitUpdate) =>
    apiFetch<BrandKit>(API_ROUTES.brandKit, { method: "PUT", json: patch }),
  uploadLogo: (file: File, onProgress?: (r: number) => void) =>
    uploadFile<BrandKit>(API_ROUTES.brandKitLogo, file, onProgress, "logo"),
  tokens: (aspect: DesignAspect) =>
    apiFetch<ResolvedDesign>(API_ROUTES.designTokens, { query: { aspect } }),
  check: (projectId: string, opts: { aspect?: DesignAspect; fix?: boolean } = {}) =>
    apiFetch<DesignCheckResult>(API_ROUTES.designCheck, {
      method: "POST",
      json: { projectId, ...opts },
    }),
  /** PNG of one frame as an object URL (revoke it when replaced). */
  async still(
    req: Partial<MotionStillRequest> & Pick<MotionStillRequest, "template" | "width" | "height">,
    signal?: AbortSignal,
  ): Promise<string> {
    let res: Response;
    try {
      res = await fetch(apiUrl(API_ROUTES.motionStill), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
        ...(signal && { signal }),
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      throw new ApiRequestError(0, undefined);
    }
    if (!res.ok) {
      const raw = (await res.json().catch(() => undefined)) as
        { error?: { code: string; message: string; details?: unknown } } | undefined;
      throw new ApiRequestError(
        res.status,
        raw?.error ? { error: raw.error } : undefined,
        undefined,
        raw,
      );
    }
    return URL.createObjectURL(await res.blob());
  },
};

/** URL of a bundled font file (GET /fonts/*). */
export function fontFileUrl(family: string, file: string): string {
  return `${API_URL}/fonts/${encodeURIComponent(family)}/${encodeURIComponent(file)}`;
}

const FONT_FILES: Record<string, Record<string, string>> = Object.fromEntries(
  BUNDLED_FONT_FAMILIES.map((f) => {
    const stem = f.replace(/ /g, "");
    const single = ["Bebas Neue", "Anton", "Archivo Black", "Bangers"].includes(f);
    const w = (n: number) => `${stem}-${single ? 400 : f === "Oswald" && n === 900 ? 700 : n}.ttf`;
    return [f, { "400": w(400), "700": w(700), "900": w(900) }];
  }),
);

let fontsInjected = false;

/**
 * Declares @font-face for the bundled families (served by the api) once, so the kit previews in
 * the web use the same files as Remotion and libass (no Google Fonts). The UI itself keeps the
 * system font (≤ 2 families in the UI).
 */
export function ensureBundledFontFaces(doc: Document | undefined = globalThis.document): void {
  if (fontsInjected || !doc) return;
  fontsInjected = true;
  const css = Object.entries(FONT_FILES)
    .flatMap(([family, weights]) =>
      Object.entries(weights).map(
        ([weight, file]) =>
          `@font-face{font-family:"${family}";font-weight:${weight};font-style:normal;font-display:swap;src:url("${fontFileUrl(family, file)}") format("truetype");}`,
      ),
    )
    .join("\n");
  const style = doc.createElement("style");
  style.dataset.studioFonts = "bundled";
  style.textContent = css;
  doc.head.appendChild(style);
}

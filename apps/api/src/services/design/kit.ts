import {
  BrandKitSchema,
  BrandKitUpdateSchema,
  BUNDLED_FONT_FAMILIES,
  DEFAULT_BRAND_KIT,
  formatErrorEs,
  SPRINT6_ERRORS,
  type BrandKit,
} from "@studio/shared";
import { HttpError } from "../../lib/errors.js";
import type { SettingsRepo } from "../../repos/settings.js";

/** Row of the `settings` table that holds the single brand kit (decision 2026-10-08). */
export const BRAND_KIT_KEY = "brand_kit";

const BUNDLED = new Set<string>(BUNDLED_FONT_FAMILIES);

/** 400 FONT_NOT_BUNDLED when a font token names a family Studio does not ship. */
export function assertBundledFonts(body: unknown): void {
  const font = (body as { tokens?: { font?: Record<string, { family?: unknown }> } } | undefined)
    ?.tokens?.font;
  if (!font || typeof font !== "object") return;
  for (const [role, tok] of Object.entries(font)) {
    const fam = tok?.family;
    if (typeof fam === "string" && !BUNDLED.has(fam))
      throw new HttpError(
        SPRINT6_ERRORS.FONT_NOT_BUNDLED.status,
        "FONT_NOT_BUNDLED",
        formatErrorEs("FONT_NOT_BUNDLED", { familia: fam }),
        { role, family: fam, families: BUNDLED_FONT_FAMILIES },
      );
  }
}

/** The brand kit stored in `settings` (validated; a broken row falls back to the default). */
export class BrandKitRepo {
  constructor(private readonly settings: SettingsRepo) {}

  get(): BrandKit {
    const stored = this.settings.get<unknown>(BRAND_KIT_KEY);
    if (!stored) return DEFAULT_BRAND_KIT;
    const parsed = BrandKitSchema.safeParse(stored);
    return parsed.success ? parsed.data : DEFAULT_BRAND_KIT;
  }

  /** PUT semantics: only the fields sent replace the stored ones (tokens as a whole). */
  update(body: unknown): BrandKit {
    assertBundledFonts(body);
    const patch = BrandKitUpdateSchema.parse(body ?? {});
    const next = BrandKitSchema.parse({
      ...this.get(),
      ...patch,
      id: "default",
      updated_at: new Date().toISOString(),
    });
    this.settings.set(BRAND_KIT_KEY, next);
    return next;
  }
}

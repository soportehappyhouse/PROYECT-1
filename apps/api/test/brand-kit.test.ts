import {
  API_ROUTES,
  BrandKitSchema,
  DEFAULT_BRAND_KIT,
  DEFAULT_DESIGN_TOKENS,
} from "@studio/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp } from "./helpers.js";

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);

async function logoForm(name: string, content: Buffer | string, type: string) {
  const form = new FormData();
  form.append("logo", new Blob([content], { type }), name);
  const res = new Response(form);
  return {
    payload: Buffer.from(await res.arrayBuffer()),
    headers: { "content-type": res.headers.get("content-type")! },
  };
}

describe("brand kit (Sprint 6 M2)", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    ({ app } = await makeApp());
  });
  afterAll(() => app.close());

  it("GET returns the default kit", async () => {
    const res = await app.inject({ method: "GET", url: API_ROUTES.brandKit });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(DEFAULT_BRAND_KIT);
  });

  it("PUT is partial: only the fields sent change", async () => {
    const res = await app.inject({
      method: "PUT",
      url: API_ROUTES.brandKit,
      payload: { name: "Happy House" },
    });
    expect(res.statusCode).toBe(200);
    const kit = BrandKitSchema.parse(res.json());
    expect(kit.name).toBe("Happy House");
    expect(kit.tokens).toEqual(DEFAULT_DESIGN_TOKENS);
    expect(kit.updated_at).toBeTruthy();
    const tokens = {
      ...DEFAULT_DESIGN_TOKENS,
      color: { ...DEFAULT_DESIGN_TOKENS.color, accent: "#00AAFF" },
    };
    const res2 = await app.inject({ method: "PUT", url: API_ROUTES.brandKit, payload: { tokens } });
    expect(res2.json().tokens.color.accent).toBe("#00AAFF");
    expect(res2.json().name).toBe("Happy House");
    const again = await app.inject({ method: "GET", url: API_ROUTES.brandKit });
    expect(again.json().tokens.color.accent).toBe("#00AAFF");
  });

  it("a family that is not bundled -> 400 FONT_NOT_BUNDLED", async () => {
    const tokens = {
      ...DEFAULT_DESIGN_TOKENS,
      font: { ...DEFAULT_DESIGN_TOKENS.font, title: { family: "Comic Sans MS", weight: 700 } },
    };
    const res = await app.inject({ method: "PUT", url: API_ROUTES.brandKit, payload: { tokens } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("FONT_NOT_BUNDLED");
    expect(res.json().error.message).toContain("«Comic Sans MS»");
  });

  it("invalid fields -> 400 VALIDATION_ERROR", async () => {
    const res = await app.inject({
      method: "PUT",
      url: API_ROUTES.brandKit,
      payload: { colorz: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("logo: text file -> 400 BRAND_LOGO_INVALID; PNG -> kit with logo_asset_id", async () => {
    const bad = await logoForm("logo.txt", "hola", "text/plain");
    const r1 = await app.inject({ method: "POST", url: API_ROUTES.brandKitLogo, ...bad });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().error.code).toBe("BRAND_LOGO_INVALID");
    const big = await logoForm("big.png", Buffer.alloc(5 * 1024 * 1024 + 10, 1), "image/png");
    const r2 = await app.inject({ method: "POST", url: API_ROUTES.brandKitLogo, ...big });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().error.code).toBe("BRAND_LOGO_INVALID");
    const ok = await logoForm("logo.png", PNG_1PX, "image/png");
    const r3 = await app.inject({ method: "POST", url: API_ROUTES.brandKitLogo, ...ok });
    expect(r3.statusCode).toBe(200);
    const id = r3.json().logo_asset_id as string;
    expect(id).toBeTruthy();
    const media = await app.inject({ method: "GET", url: `/api/media/${id}` });
    expect(media.json().kind).toBe("image");
  });

  it("GET /api/design/tokens resolves the kit for a canvas", async () => {
    const r = await app.inject({ method: "GET", url: `${API_ROUTES.designTokens}?aspect=9:16` });
    expect(r.statusCode).toBe(200);
    expect(r.json().caption_px).toMatchObject({ size: 65, min_size: 49, max_chars_line: 30 });
    const r2 = await app.inject({ method: "GET", url: `${API_ROUTES.designTokens}?w=1920&h=1080` });
    expect(r2.json().aspect).toBe("16:9");
  });

  it("GET /fonts/* serves the bundled fonts with an immutable cache", async () => {
    const ofl = await app.inject({ method: "GET", url: "/fonts/Inter/OFL.txt" });
    expect(ofl.statusCode).toBe(200);
    expect(ofl.body).toMatch(/SIL OPEN FONT LICENSE/i);
    const ttf = await app.inject({ method: "GET", url: "/fonts/Bebas%20Neue/BebasNeue-400.ttf" });
    expect(ttf.statusCode).toBe(200);
    expect(ttf.headers["cache-control"]).toMatch(/immutable/);
    expect(ttf.rawPayload.readUInt32BE(0)).toBe(0x00010000);
    const nope = await app.inject({ method: "GET", url: "/fonts/../../package.json" });
    expect(nope.statusCode).not.toBe(200);
  });
});

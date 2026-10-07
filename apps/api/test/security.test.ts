import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isAllowedHost, isWebOrigin, webOrigins } from "../src/lib/cors.js";
import { assertBrowserRead } from "../src/services/persons/gate.js";
import { makeApp } from "./helpers.js";

/** Audit fix 5: Host allowlist (DNS rebinding), exact web Origin, browser-only biometric reads. */
describe("api hardening (Host / Origin)", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    ({ app } = await makeApp());
  });
  afterAll(async () => {
    await app?.close();
  });

  it("rejects a foreign Host with 403 BAD_HOST before any route or /files", async () => {
    for (const host of ["evil.example", "evil.example:3001", "127.0.0.1.nip.io:3001"]) {
      const res = await app.inject({ method: "GET", url: "/api/persons", headers: { host } });
      expect(res.statusCode, host).toBe(403);
      expect(res.json().error.code).toBe("BAD_HOST");
    }
    const files = await app.inject({ method: "GET", url: "/files/x", headers: { host: "a.b" } });
    expect(files.statusCode).toBe(403);
    for (const host of ["127.0.0.1:3001", "localhost:3001", "[::1]:3001"])
      expect(
        (await app.inject({ method: "GET", url: "/api/persons", headers: { host } })).statusCode,
      ).toBe(200);
  });

  it("isAllowedHost checks the loopback name and the api port (real socket)", () => {
    const cfg = { host: "127.0.0.1", port: 3001 };
    expect(isAllowedHost(cfg, "127.0.0.1:3001", 3001)).toBe(true);
    expect(isAllowedHost(cfg, "localhost:3001", 3001)).toBe(true);
    expect(isAllowedHost(cfg, "localhost:4000", 3001)).toBe(false);
    expect(isAllowedHost(cfg, "localhost:4000", 4000)).toBe(true); // listening on 4000 (tests)
    expect(isAllowedHost(cfg, "attacker.test:3001", 3001)).toBe(false);
    expect(isAllowedHost(cfg, undefined, 3001)).toBe(false);
    expect(isAllowedHost(cfg, "user@127.0.0.1:3001", 3001)).toBe(false);
    expect(isAllowedHost({ host: "192.168.0.5", port: 3001 }, "192.168.0.5:3001", 3001)).toBe(true);
    expect(isAllowedHost({ host: "0.0.0.0", port: 3001 }, "192.168.0.5:3001", 3001)).toBe(false);
  });

  it("HUMAN_ONLY uses the exact web origins, not the CORS regex", () => {
    const cfg = { webOrigin: "http://localhost:3000" };
    expect(webOrigins(cfg)).toEqual([
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://[::1]:3000",
    ]);
    expect(isWebOrigin(cfg, "http://127.0.0.1:3000")).toBe(true);
    expect(isWebOrigin(cfg, "http://127.0.0.1:3001")).toBe(false);
    expect(isWebOrigin(cfg, undefined)).toBe(false);
  });

  it("biometric reads: same-origin/same-site fetch metadata or the web Origin; never mcp", () => {
    const cfg = { webOrigin: "http://localhost:3000" };
    const ok = (headers: Record<string, string>) => () => assertBrowserRead({ headers }, cfg);
    expect(ok({ "sec-fetch-site": "same-origin" })).not.toThrow();
    expect(ok({ "sec-fetch-site": "same-site" })).not.toThrow();
    expect(ok({ "sec-fetch-site": "cross-site", origin: "http://localhost:3000" })).not.toThrow();
    expect(ok({})).toThrow();
    expect(ok({ "sec-fetch-site": "cross-site" })).toThrow();
    expect(ok({ "sec-fetch-site": "none" })).toThrow();
    expect(ok({ "sec-fetch-site": "same-origin", "x-studio-client": "mcp" })).toThrow();
  });
});

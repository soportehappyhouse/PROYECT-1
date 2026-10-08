import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_ROUTES } from "@studio/shared";
import { systemRouteDeps } from "../src/routes/system.js";
import { exportsFile, revealCommand } from "../src/services/export/reveal.js";
import {
  loudnormApplyFilter,
  parseEbur128Probe,
  parseLoudnormStats,
} from "../src/services/export/loudness.js";
import { makeApp } from "./helpers.js";

/** Sprint 5 (M3): «Abrir carpeta» only under exports/, argv without a shell. */
describe("POST /api/system/reveal", () => {
  let app: FastifyInstance;
  let storage: string;
  const calls: [string, string[]][] = [];
  const saved = { ...systemRouteDeps };

  beforeAll(async () => {
    ({ app, storage } = await makeApp());
    systemRouteDeps.reveal = (cmd, args) => calls.push([cmd, args]);
    systemRouteDeps.platform = "win32";
    mkdirSync(path.join(storage, "exports"), { recursive: true });
    writeFileSync(path.join(storage, "exports", "mi video ñandú.mp4"), "x");
  });
  afterAll(async () => {
    Object.assign(systemRouteDeps, saved);
    await app?.close();
  });
  const reveal = (p: string) =>
    app.inject({ method: "POST", url: API_ROUTES.systemReveal, payload: { path: p } });

  it("selects the export in the Explorer with one argv element (spaces and accents)", async () => {
    const res = await reveal("exports/mi video ñandú.mp4");
    expect(res.statusCode, res.body).toBe(200);
    expect(calls.at(-1)).toEqual([
      "explorer.exe",
      [`/select,${path.join(storage, "exports", "mi video ñandú.mp4")}`],
    ]);
  });

  it("refuses .. and paths outside exports/ (400 REVEAL_OUTSIDE_EXPORTS)", async () => {
    for (const p of [
      "exports/../studio.db",
      "media/a.mp4",
      "/etc/passwd",
      "C:\\x.mp4",
      "exports/",
    ]) {
      const res = await reveal(p);
      expect(res.statusCode, p).toBe(400);
      expect(res.json<{ error: { code: string } }>().error.code).toBe("REVEAL_OUTSIDE_EXPORTS");
    }
    expect((await reveal("exports/no-existe.mp4")).statusCode).toBe(404);
  });

  it("platform commands", () => {
    expect(revealCommand("darwin", "/s/exports/a.mp4")).toEqual([
      "open",
      ["-R", "/s/exports/a.mp4"],
    ]);
    expect(revealCommand("linux", "/s/exports/a.mp4")).toEqual(["xdg-open", ["/s/exports"]]);
    expect(exportsFile("/s", "exports/sub/a.mp4")).toBe(
      path.resolve("/s", "exports", "sub", "a.mp4"),
    );
  });
});

describe("loudness parsing", () => {
  const PASS1 =
    '[Parsed_loudnorm_0 @ 0x1]\r\n{\r\n\t"input_i" : "-27.61",\r\n\t"input_tp" : "-4.47",\r\n' +
    '\t"input_lra" : "18.06",\r\n\t"input_thresh" : "-39.20",\r\n\t"output_i" : "-14.05",\r\n' +
    '\t"output_tp" : "-1.00",\r\n\t"normalization_type" : "dynamic",\r\n\t"target_offset" : "0.05"\r\n}\r\n';

  it("reads the last JSON block with CRLF; -inf becomes silence", () => {
    const m = parseLoudnormStats(`noise {not json}\n${PASS1}`);
    expect(m).toMatchObject({
      input_i: -27.61,
      input_tp: -4.47,
      output_i: -14.05,
      target_offset: 0.05,
    });
    const silent = parseLoudnormStats(
      '{"input_i":"-inf","input_tp":"-inf","input_lra":"0.00","input_thresh":"-inf","target_offset":"inf"}',
    );
    expect(silent).toMatchObject({ input_i: -70, target_offset: 0 });
    expect(() => parseLoudnormStats("no json here")).toThrow();
  });

  it("pass 2 is linear with the measured values", () => {
    const f = loudnormApplyFilter(
      { integrated: -14, truePeak: -1, lra: 11 },
      parseLoudnormStats(PASS1),
    );
    expect(f).toBe(
      "loudnorm=I=-14:TP=-1:LRA=11:measured_I=-27.61:measured_TP=-4.47:measured_LRA=18.06" +
        ":measured_thresh=-39.2:offset=0.05:linear=true:print_format=json",
    );
  });

  it("ebur128 probe: last frame, peaks linear or dB", () => {
    const out = JSON.stringify({
      frames: [
        { tags: { "lavfi.r128.I": "-20.0" } },
        {
          tags: {
            "lavfi.r128.I": "-14.2",
            "lavfi.r128.true_peaks_ch0": "0.5",
            "lavfi.r128.true_peaks_ch1": "0.8",
          },
        },
      ],
    });
    const m = parseEbur128Probe(out);
    expect(m.integrated).toBe(-14.2);
    expect(m.truePeak).toBeCloseTo(20 * Math.log10(0.8), 3);
  });
});

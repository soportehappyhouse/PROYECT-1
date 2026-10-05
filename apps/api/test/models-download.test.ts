import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { API_ROUTES } from "@studio/shared";
import { makeApp, tempStorage } from "./helpers.js";

/**
 * Feedback 6: the Voz panel downloads Piper voices through POST /api/voice/models/download.
 * Hugging Face is not reachable from the test sandbox, so the workers service is mocked with the
 * exact error bodies studio_workers/downloads.py produces (offline, HTTP 403, checksum).
 */
describe("voice model download (mocked workers)", () => {
  let server: Server;
  let app: FastifyInstance;
  const models = tempStorage("studio-models-");
  let next: { status: number; body: unknown } = { status: 200, body: {} };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        res.writeHead(next.status, { "content-type": "application/json" });
        res.end(JSON.stringify(next.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    ({ app } = await makeApp({ WORKERS_URL: `http://127.0.0.1:${port}`, MODELS_DIR: models }));
  });
  afterAll(async () => {
    await app?.close();
    server?.close();
  });

  const post = (id: string) =>
    app.inject({
      method: "POST",
      url: API_ROUTES.voiceModelDownload,
      payload: { kind: "piper", id },
    });

  it("passes a successful download through", async () => {
    next = {
      status: 200,
      body: {
        kind: "piper",
        id: "es_MX-claude-high",
        files: [{ path: "piper/es_MX-claude-high.onnx", sizeBytes: 63_000_000, skipped: false }],
      },
    };
    const res = await post("es_MX-claude-high");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: "es_MX-claude-high" });
  });

  it.each([
    [
      "Error de red al descargar https://huggingface.co/x: [Errno 11001] getaddrinfo failed",
      "DOWNLOAD_OFFLINE",
    ],
    [
      "HTTP 403 al descargar https://huggingface.co/rhasspy/piper-voices/x.onnx",
      "DOWNLOAD_FORBIDDEN",
    ],
    ["es_MX-claude-high.onnx: md5 no coincide", "DOWNLOAD_CHECKSUM"],
  ])("maps %s to %s with a Spanish message", async (detail, code) => {
    next = { status: 502, body: { detail, code: "DOWNLOAD_FAILED" } };
    const res = await post("es_MX-claude-high");
    expect(res.statusCode).toBe(502);
    const body = res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe(code);
    expect(body.error.message).toContain(detail);
  });

  it("reports progress from the .part file and validates the voice id", async () => {
    const dir = path.join(models, "piper");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "es_ES-davefx-medium.onnx.part"), Buffer.alloc(1234));
    const url = `${API_ROUTES.voiceModelDownloadProgress}?kind=piper&id=es_ES-davefx-medium`;
    expect((await app.inject({ url })).json()).toEqual({ bytes: 1234, active: true });
    const bad = await app.inject({
      url: `${API_ROUTES.voiceModelDownloadProgress}?kind=piper&id=..%2F..%2Fetc`,
    });
    expect(bad.statusCode).toBe(400);
  });
});

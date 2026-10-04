import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkersClient, WorkersError } from "../src/services/workers-client.js";

describe("workers client (module d)", () => {
  let server: http.Server;
  let base: string;
  const progress: Record<string, number> = {};

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        const send = (status: number, data: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(data));
        };
        if (req.url?.startsWith("/jobs/")) {
          const id = req.url.slice("/jobs/".length);
          return send(200, { jobId: id, status: "running", progress: progress[id] ?? 0.5 });
        }
        if (req.url === "/transcribe") {
          const parsed = JSON.parse(body) as { jobId: string };
          progress[parsed.jobId] = 0.4;
          // answer after a few progress polls
          return setTimeout(
            () =>
              send(200, {
                language: "es",
                durationSec: 2,
                segments: [{ start: 0, end: 1, text: "hola", words: null }],
                model: "base",
                files: { jsonPath: "renders/j.json", srt: "renders/j.srt", ass: "renders/j.ass" },
              }),
            120,
          );
        }
        if (req.url === "/tts")
          return send(409, { detail: "Voz no instalada", code: "VOICE_NOT_INSTALLED" });
        if (req.url === "/rvc/models")
          return send(200, [{ id: "a", name: "a", modelPath: "rvc/a/a.pth", indexPath: null }]);
        return send(404, { detail: "nope" });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("POSTs transcribe, polls progress and parses the transcript with files", async () => {
    const client = createWorkersClient(base);
    const seen: number[] = [];
    const t = await client.transcribe(
      { inputPath: "tmp/a.wav", language: "es", wordTimestamps: true, jobId: "j" },
      { onProgress: (p) => seen.push(p), pollMs: 20 },
    );
    expect(t.files?.srt).toBe("renders/j.srt");
    expect(t.segments[0]?.text).toBe("hola");
    expect(seen).toContain(0.4);
  });

  it("maps worker errors to WorkersError with code and status", async () => {
    const client = createWorkersClient(base);
    const err = await client
      .tts({ text: "hola", voice: "x", speed: 1, outputPath: "renders/x.wav" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkersError);
    expect(err).toMatchObject({ statusCode: 409, code: "VOICE_NOT_INSTALLED" });
  });

  it("drops null indexPath from RVC models", async () => {
    const models = await createWorkersClient(base).rvcModels();
    expect(models).toEqual([{ id: "a", name: "a", modelPath: "rvc/a/a.pth" }]);
  });

  it("reports unreachable workers as 503 WORKERS_UNAVAILABLE", async () => {
    const err = await createWorkersClient("http://127.0.0.1:1")
      .ttsVoices()
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 503, code: "WORKERS_UNAVAILABLE" });
    expect(await createWorkersClient("http://127.0.0.1:1").jobProgress("x")).toBeUndefined();
  });
});

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { CreateReportResponse, ReportSummary } from "@studio/shared";
import { openDatabase } from "../src/db/database.js";
import { formatCommand } from "../src/jobs/diagnostics.js";
import { JobQueue } from "../src/jobs/queue.js";
import { SqliteJobStore } from "../src/jobs/store.js";
import { cleanupOldLogs, DailyLogStream, localDay } from "../src/lib/log-file.js";
import { REDACTED, redactEnvText, redactText, redactValue } from "../src/lib/redact.js";
import { slugify } from "../src/reports/builder.js";
import { runProcess } from "../src/voice-ai/proc.js";
import { makeApp, tempStorage } from "./helpers.js";

const FAKE_ANTHROPIC = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const FREESOUND_KEY = "fs-secret-value-1234567890";

/** Read every entry of a zip (stored/deflate, no ZIP64) -> { name: content }. */
function readZip(file: string): Record<string, Buffer> {
  const buf = readFileSync(file);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThan(0);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: Record<string, Buffer> = {};
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const localNameLen = buf.readUInt16LE(local + 26);
    const localExtra = buf.readUInt16LE(local + 28);
    const start = local + 30 + localNameLen + localExtra;
    const data = buf.subarray(start, start + compressed);
    out[name] = method === 8 ? inflateRawSync(data) : Buffer.from(data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe("redact", () => {
  it("hides provider keys, NAME=value pairs, bearer tokens and the home folder", () => {
    const text = [
      `calling anthropic with ${FAKE_ANTHROPIC}`,
      "OPENAI_API_KEY=sk-proj-1234567890abcdefghijkl",
      '{"apiKey":"abc123456789","name":"ok","token":null}',
      "Authorization: Bearer abcdefghijklmnop.qrstuv",
      "GET https://freesound.org/apiv2/search?query=x&token=zzzzzzzz",
      "custom secret value: my-literal-secret",
      "C:\\Users\\Usuario Demo\\studio\\storage\\media\\a.mp4",
    ].join("\n");
    const out = redactText(text, {
      secrets: ["my-literal-secret"],
      homeDir: "C:\\Users\\Usuario Demo",
    });
    expect(out).not.toContain(FAKE_ANTHROPIC);
    expect(out).not.toContain("sk-proj-1234567890abcdefghijkl");
    expect(out).not.toContain("abc123456789");
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out).not.toContain("zzzzzzzz");
    expect(out).not.toContain("my-literal-secret");
    expect(out).not.toContain("Usuario Demo");
    expect(out).toContain('"name":"ok"');
    expect(out).toContain('"token":null');
    expect(out).toContain("~\\studio\\storage");
    expect(out.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it("redacts secret-named keys deep inside JSON values and .env files", () => {
    const value = redactValue({ a: { elevenlabsApiKey: "x".repeat(20), keep: 1 }, list: ["ok"] });
    expect(value).toEqual({ a: { elevenlabsApiKey: REDACTED, keep: 1 }, list: ["ok"] });
    const env = redactEnvText("WEB_PORT=3000\nOPENAI_API_KEY=abc\nFREESOUND_API_KEY=\n# comment");
    expect(env).toBe("WEB_PORT=3000\nOPENAI_API_KEY=[REDACTED]\nFREESOUND_API_KEY=\n# comment");
  });

  it("slugifies titles for folder names", () => {
    expect(slugify("¿La exportación falla con 9:16?")).toBe("la-exportacion-falla-con-9-16");
    expect(slugify("¡¡!!")).toBe("reporte");
  });
});

describe("daily api log", () => {
  it("writes redacted lines to api-YYYY-MM-DD.log, rotates per day and keeps 7 days", async () => {
    const dir = tempStorage("studio-logs-");
    writeFileSync(path.join(dir, "api-2020-01-01.log"), "old\n");
    writeFileSync(path.join(dir, "workers.log"), "not ours\n");
    let now = new Date(2026, 9, 4, 23, 59, 0);
    const stream = new DailyLogStream({
      dir,
      stdout: false,
      now: () => now,
      redact: { secrets: [FREESOUND_KEY] },
    });
    stream.write(`{"level":30,"msg":"key ${FREESOUND_KEY} ${FAKE_ANTHROPIC}"}\n`);
    now = new Date(2026, 9, 5, 0, 0, 1);
    stream.write('{"level":50,"msg":"next day"}\n');
    await stream.end();
    const day1 = readFileSync(path.join(dir, `api-${localDay(new Date(2026, 9, 4))}.log`), "utf8");
    expect(day1).toContain(REDACTED);
    expect(day1).not.toContain(FREESOUND_KEY);
    expect(day1).not.toContain(FAKE_ANTHROPIC);
    expect(readFileSync(path.join(dir, "api-2026-10-05.log"), "utf8")).toContain("next day");
    expect(existsSync(path.join(dir, "api-2020-01-01.log"))).toBe(false);
    expect(existsSync(path.join(dir, "workers.log"))).toBe(true);
    writeFileSync(path.join(dir, "api-2026-09-27.log"), "8 days old\n");
    writeFileSync(path.join(dir, "api-2026-09-28.log"), "7 days old\n");
    expect(cleanupOldLogs(dir, "api", 7, new Date(2026, 9, 5))).toEqual(["api-2026-09-27.log"]);
  });
});

describe("job diagnostics", () => {
  let queue: JobQueue | undefined;
  afterEach(async () => {
    await queue?.stop();
  });

  it("stores the command line, stderr tail and timings of a failed job", async () => {
    const store = new SqliteJobStore(openDatabase(":memory:"));
    queue = new JobQueue({ store, storageDir: tempStorage() });
    queue.register({
      type: "voice.effect",
      parse: (p) => p,
      run: async () => {
        await runProcess(process.execPath, [
          "-e",
          "for (let i = 0; i < 250; i++) console.error('line ' + i); process.exitCode = 3",
        ]);
        return null;
      },
    });
    queue.start();
    const job = queue.enqueue({ type: "voice.effect", payload: {} });
    await queue.onIdle();
    expect(store.get(job.id)?.status).toBe("failed");
    const d = store.diagnostics(job.id)!;
    expect(d.commands).toHaveLength(1);
    expect(d.commands[0]!.command).toContain(path.basename(process.execPath));
    expect(d.commands[0]!.exitCode).toBe(3);
    expect(d.stderrTail.length).toBeLessThanOrEqual(200);
    expect(d.stderrTail.some((l) => l.includes("line 249"))).toBe(true);
    expect(d.timings.runMs).toBeGreaterThanOrEqual(0);
    expect(formatCommand("ffmpeg", ["-i", "a b.mp4", "-vf", "scale=1:2;x"])).toBe(
      'ffmpeg -i "a b.mp4" -vf "scale=1:2;x"',
    );
  });
});

describe("POST /api/reports", () => {
  it("creates the folder, redacts secrets, zips it and lists/downloads it", async () => {
    const { app, storage } = await makeApp({ FREESOUND_API_KEY: FREESOUND_KEY });
    try {
      // A failed job with a secret in its stderr.
      const job = app.ctx.jobs.create({ type: "project.export", payload: { projectId: "p1" } });
      app.ctx.jobs.update(job.id, {
        status: "failed",
        error: "ffmpeg terminó con código 1: Invalid argument",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        diagnostics: {
          commands: [
            {
              kind: "process",
              command: `ffmpeg -i media/a.mp4 -headers "Authorization: Bearer ${FAKE_ANTHROPIC}" out.mp4`,
              startedAt: new Date().toISOString(),
              durationMs: 120,
              exitCode: 1,
            },
          ],
          stderrTail: [`[http] key=${FREESOUND_KEY}`, "Invalid argument"],
          timings: { queuedMs: 5, runMs: 120 },
        },
      });
      // An api log with a fake key in it.
      mkdirSync(path.join(storage, "logs"), { recursive: true });
      writeFileSync(
        path.join(storage, "logs", `api-${localDay(new Date())}.log`),
        `{"level":50,"msg":"boom ${FAKE_ANTHROPIC}"}\n{"level":30,"msg":"ok"}\n`,
      );

      const res = await app.inject({
        method: "POST",
        url: "/api/reports",
        payload: {
          title: "¿Exportar falla?",
          steps: "1. Importé un video\n2. Exporté en 9:16\nEsperaba un MP4. Pasó: error",
          severity: "high",
          jobIds: [job.id],
          uiBreadcrumbs: [
            { at: new Date().toISOString(), category: "panel", message: "Abrió Exportar" },
            {
              at: new Date().toISOString(),
              category: "api",
              message: "POST /api/projects/:id/export → 500",
              data: { status: 500 },
            },
          ],
          uiState: { browser: { userAgent: "vitest" }, settings: { theme: "dark" } },
          project: { not: "a project" },
        },
      });
      expect(res.statusCode).toBe(201);
      const report = res.json<CreateReportResponse>();
      expect(report.id).toMatch(/^\d{8}-\d{6}-exportar-falla$/);
      expect(report.relativeDir).toBe(`reports/${report.id}`);
      expect(existsSync(report.dir)).toBe(true);
      for (const f of [
        "reporte.md",
        "reporte.json",
        "entorno.json",
        "proyecto.json",
        `jobs/${job.id}.json`,
        "jobs/recientes.json",
        `logs/api-${localDay(new Date())}.log`,
      ])
        expect(report.files).toContain(f);

      // Prompt first, with context -> steps -> error -> attachments.
      expect(report.markdown.indexOf("## Prompt para Claude")).toBeLessThan(
        report.markdown.indexOf("## Qué intentaba hacer"),
      );
      const order = ["## Contexto", "## Pasos", "## Error", "## Archivos adjuntos"].map((h) =>
        report.prompt.indexOf(h),
      );
      expect(order.every((i) => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(report.prompt).toContain("Invalid argument");
      expect(report.prompt).toContain("Exporté en 9:16");

      // Nothing secret anywhere on disk or in the zip.
      const zip = readZip(report.zipPath);
      expect(Object.keys(zip)).toContain(`${report.id}/reporte.md`);
      expect(Object.keys(zip)).toContain(`${report.id}/jobs/${job.id}.json`);
      for (const [name, content] of Object.entries(zip)) {
        const text = content.toString("utf8");
        expect(text, name).not.toContain(FAKE_ANTHROPIC);
        expect(text, name).not.toContain(FREESOUND_KEY);
        expect(text).toBe(
          readFileSync(path.join(report.dir, name.slice(report.id.length + 1)), "utf8"),
        );
      }
      expect(zip[`${report.id}/jobs/${job.id}.json`]!.toString()).toContain(REDACTED);
      expect(zip[`${report.id}/logs/api-${localDay(new Date())}.log`]!.toString()).toContain(
        REDACTED,
      );
      const env = JSON.parse(zip[`${report.id}/entorno.json`]!.toString()) as {
        versions: { node: string };
        config: { providers: { freesound: boolean } };
      };
      expect(env.versions.node).toBe(process.version);
      expect(env.config.providers.freesound).toBe(true);

      const list = await app.inject({ method: "GET", url: "/api/reports" });
      expect(list.json<ReportSummary[]>().map((r) => r.id)).toEqual([report.id]);
      const dl = await app.inject({ method: "GET", url: `/api/reports/${report.id}/download` });
      expect(dl.statusCode).toBe(200);
      expect(dl.headers["content-type"]).toBe("application/zip");
      expect(dl.rawPayload.subarray(0, 2).toString()).toBe("PK");
      const missing = await app.inject({ method: "GET", url: "/api/reports/..%2F..%2Fx/download" });
      expect(missing.statusCode).toBe(404);
      // Reports and logs are never exposed through /files.
      const leaked = await app.inject({
        method: "GET",
        url: `/files/${report.relativeDir}/reporte.md`,
      });
      expect(leaked.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("rejects an empty title", async () => {
    const { app } = await makeApp();
    try {
      const res = await app.inject({ method: "POST", url: "/api/reports", payload: { title: "" } });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

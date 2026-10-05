import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

export function tempStorage(prefix = "studio-test-"): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export async function makeApp(
  env: Record<string, string> = {},
): Promise<{ app: FastifyInstance; storage: string }> {
  const storage = tempStorage();
  const config = loadConfig({
    STORAGE_DIR: storage,
    WORKERS_URL: "http://127.0.0.1:1",
    FFMPEG_PATH: "ffmpeg-does-not-exist",
    FFPROBE_PATH: "ffprobe-does-not-exist",
    HW_ENCODER: "off",
    ...env,
  });
  const app = await buildApp({ config, logger: false });
  await app.ready();
  return { app, storage };
}

/** Serialize a multipart body (field "file") for app.inject. */
export async function multipart(
  name: string,
  content: Buffer | string,
  type = "application/octet-stream",
): Promise<{ payload: Buffer; headers: Record<string, string> }> {
  const form = new FormData();
  form.append("file", new Blob([content], { type }), name);
  const res = new Response(form);
  return {
    payload: Buffer.from(await res.arrayBuffer()),
    headers: { "content-type": res.headers.get("content-type")! },
  };
}

export async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeout = 20_000,
): Promise<void> {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > timeout) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}

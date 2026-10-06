import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { CONSENT_TEXT_VERSION } from "@studio/shared";

/** Sprint 4 M1 test helpers (persons.test.ts, face-swap.test.ts). */

export const ORIGIN = { origin: "http://localhost:3000" };

/** Minimal PNG header (signature + IHDR) of the given size: enough for the sniffer. */
export function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** Multipart body with fields and files for app.inject. */
export async function form(
  fields: Record<string, string>,
  files: Record<string, { data: Buffer | string; name: string; type: string }>,
): Promise<{ payload: Buffer; headers: Record<string, string> }> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const [k, f] of Object.entries(files))
    fd.append(k, new Blob([f.data], { type: f.type }), f.name);
  const res = new Response(fd);
  return {
    payload: Buffer.from(await res.arrayBuffer()),
    headers: { "content-type": res.headers.get("content-type")! },
  };
}

export async function addConsent(
  app: FastifyInstance,
  personId: string,
  over: Record<string, string> = {},
  headers: Record<string, string> = ORIGIN,
): Promise<LightMyRequestResponse> {
  const body = await form(
    {
      scope: "face",
      method: "firma en pantalla",
      signer_name: "Ana Pérez",
      text_version: CONSENT_TEXT_VERSION,
      accept: "true",
      ...over,
    },
    { evidence: { data: pngHeader(300, 120), name: "firma.png", type: "image/png" } },
  );
  return app.inject({
    method: "POST",
    url: `/api/persons/${personId}/consents`,
    payload: body.payload,
    headers: { ...body.headers, ...headers },
  });
}

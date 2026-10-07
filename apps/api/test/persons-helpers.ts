import { crc32, deflateSync } from "node:zlib";
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

/**
 * A real RGBA PNG like the signature canvas: transparent with a dark stroke (`ink: false` = blank,
 * `white: true` = opaque white background).
 */
export function signaturePng(
  width = 300,
  height = 120,
  { ink = true, white = false }: { ink?: boolean; white?: boolean } = {},
): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = y % 2 ? 2 : 1; // Up / Sub filters exercise the decoder
    for (let x = 0; x < width; x++) {
      const stroke = ink && Math.abs(y - height / 2 - Math.round(10 * Math.sin(x / 15))) < 2;
      const px = stroke ? [20, 20, 30, 255] : white ? [255, 255, 255, 255] : [0, 0, 0, 0];
      raw.set(px, y * (width * 4 + 1) + 1 + x * 4);
    }
  }
  // re-encode the filtered scanlines (Sub: delta to the left pixel; Up: delta to the row above)
  const out = Buffer.from(raw);
  const stride = width * 4 + 1;
  for (let y = 0; y < height; y++)
    for (let i = 1; i < stride; i++) {
      const cur = raw[y * stride + i]!;
      const pred =
        y % 2 ? (y > 0 ? raw[(y - 1) * stride + i]! : 0) : i > 4 ? raw[y * stride + i - 4]! : 0;
      out[y * stride + i] = (cur - pred) & 0xff;
    }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(out)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
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
  evidence: Buffer = signaturePng(),
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
    { evidence: { data: evidence, name: "firma.png", type: "image/png" } },
  );
  return app.inject({
    method: "POST",
    url: `/api/persons/${personId}/consents`,
    payload: body.payload,
    headers: { ...body.headers, ...headers },
  });
}

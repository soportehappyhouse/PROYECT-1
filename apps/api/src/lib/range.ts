import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyReply, FastifyRequest } from "fastify";

export type ByteRange = { start: number; end: number };

/**
 * Parse a single `Range: bytes=...` header against a file size.
 * Returns undefined (serve whole file) for absent/multi/malformed ranges, "unsatisfiable" for 416.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | "unsatisfiable" | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined;
  const [, a, b] = m;
  if (a === "" && b === "") return undefined;
  let start: number;
  let end: number;
  if (a === "") {
    const suffix = Number(b);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

/** Stream a file with HTTP Range support (206/416), ETag-less but with Last-Modified. */
export async function sendFileWithRange(
  req: FastifyRequest,
  reply: FastifyReply,
  absPath: string,
  contentType = "application/octet-stream",
  downloadName?: string,
): Promise<FastifyReply> {
  const info = await stat(absPath);
  const size = info.size;
  reply.header("Accept-Ranges", "bytes");
  reply.header("Content-Type", contentType);
  reply.header("Last-Modified", info.mtime.toUTCString());
  reply.header("Cache-Control", "no-cache");
  if (downloadName)
    reply.header(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
    );
  const range = parseRange(req.headers.range, size);
  if (range === "unsatisfiable") {
    reply.header("Content-Range", `bytes */${size}`);
    return reply.code(416).send();
  }
  if (!range) {
    reply.header("Content-Length", String(size));
    return reply.code(200).send(req.method === "HEAD" ? undefined : createReadStream(absPath));
  }
  reply.header("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
  reply.header("Content-Length", String(range.end - range.start + 1));
  return reply
    .code(206)
    .send(
      req.method === "HEAD"
        ? undefined
        : createReadStream(absPath, { start: range.start, end: range.end }),
    );
}

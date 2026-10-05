import { createReadStream, createWriteStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { crc32, deflateRawSync } from "node:zlib";

/**
 * Minimal ZIP writer (deflate, no ZIP64): enough for diagnostic bundles (a few MB, < 65k files).
 * Uses node:zlib (crc32 needs Node >= 22.2), so the api needs no archive dependency.
 */

interface Entry {
  name: string;
  crc: number;
  compressed: number;
  size: number;
  method: number;
  offset: number;
  time: number;
  date: number;
}

const MAX_ZIP_BYTES = 0xffffffff;

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

async function listFiles(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(path.join(root, rel), { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(root, r)));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

async function readAll(file: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of createReadStream(file)) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/**
 * Zip every file under `sourceDir` into `zipPath`, entries prefixed with `prefix/` (the folder
 * name, so extracting recreates the folder). Returns the zip size in bytes.
 */
export async function zipDirectory(
  sourceDir: string,
  zipPath: string,
  prefix = "",
): Promise<number> {
  const files = await listFiles(sourceDir);
  const out = createWriteStream(zipPath);
  const entries: Entry[] = [];
  let offset = 0;
  const write = async (buf: Buffer) => {
    if (!out.write(buf)) await once(out, "drain");
    offset += buf.length;
  };

  for (const rel of files) {
    const abs = path.join(sourceDir, rel);
    const info = await stat(abs);
    const data = await readAll(abs);
    const deflated = deflateRawSync(data, { level: 6 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const name = Buffer.from(prefix ? `${prefix}/${rel}` : rel, "utf8");
    const { time, date } = dosDateTime(info.mtime);
    const entry: Entry = {
      name: name.toString("utf8"),
      crc: crc32(data) >>> 0,
      compressed: body.length,
      size: data.length,
      method: useDeflate ? 8 : 0,
      offset,
      time,
      date,
    };
    if (offset + body.length > MAX_ZIP_BYTES)
      throw new Error("El reporte supera 4 GB (ZIP64 no soportado)");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(entry.method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(entry.crc, 14);
    header.writeUInt32LE(entry.compressed, 18);
    header.writeUInt32LE(entry.size, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    await write(header);
    await write(name);
    await write(body);
    entries.push(entry);
  }

  const cdStart = offset;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(e.method, 10);
    cd.writeUInt16LE(e.time, 12);
    cd.writeUInt16LE(e.date, 14);
    cd.writeUInt32LE(e.crc, 16);
    cd.writeUInt32LE(e.compressed, 20);
    cd.writeUInt32LE(e.size, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(e.offset, 42);
    await write(cd);
    await write(name);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(offset - cdStart, 12);
  end.writeUInt32LE(cdStart, 16);
  await write(end);
  out.end();
  await once(out, "close");
  return offset;
}

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "remotion/version";
import { webpackOverride } from "./webpack-override.js";

/** Absolute path to the Remotion entry (works from src/ and dist/). */
export const REMOTION_ENTRY = fileURLToPath(new URL("../src/entry.ts", import.meta.url));
const SRC_DIR = path.dirname(REMOTION_ENTRY);
const PACKAGE_DIR = path.dirname(SRC_DIR);

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) =>
      e.isDirectory() ? listFiles(path.join(dir, e.name)) : [path.join(dir, e.name)],
    ),
  );
  return nested.flat().sort();
}

/** Hash of every file in packages/remotion/src + the Remotion version (bundle cache key). */
export async function computeSourceHash(srcDir = SRC_DIR): Promise<string> {
  const hash = createHash("sha256").update(`remotion@${VERSION}`);
  for (const file of await listFiles(srcDir)) {
    hash.update(path.relative(srcDir, file).replace(/\\/g, "/"));
    hash.update(await readFile(file));
  }
  return hash.digest("hex").slice(0, 16);
}

export interface BundleOptions {
  /** Disk cache root; the bundle goes to `<cacheDir>/<hash>`. Null = temp dir, memory cache only. */
  cacheDir: string | null;
  onProgress?: (ratio: number) => void;
}

const inFlight = new Map<string, Promise<string>>();

async function bundleTo(opts: BundleOptions): Promise<string> {
  const { bundle } = await import("@remotion/bundler");
  const common = {
    entryPoint: REMOTION_ENTRY,
    rootDir: PACKAGE_DIR,
    webpackOverride,
    onProgress: (pct: number) => opts.onProgress?.(pct / 100),
  };
  if (!opts.cacheDir) return bundle(common);

  const hash = await computeSourceHash();
  const outDir = path.join(opts.cacheDir, hash);
  if (existsSync(path.join(outDir, "index.html"))) return outDir;
  await mkdir(opts.cacheDir, { recursive: true });
  // Drop stale bundles (other hashes) and any half-written output.
  for (const entry of await readdir(opts.cacheDir)) {
    await rm(path.join(opts.cacheDir, entry), { recursive: true, force: true });
  }
  return bundle({ ...common, outDir });
}

/**
 * Bundle the compositions once (webpack) and reuse: in-process promise cache + on-disk cache keyed
 * by a hash of the sources, so restarting the api does not re-bundle unless src/ changed.
 */
export function getServeUrl(opts: BundleOptions = { cacheDir: null }): Promise<string> {
  const key = opts.cacheDir ?? "<memory>";
  let p = inFlight.get(key);
  if (!p) {
    p = bundleTo(opts).catch((err: unknown) => {
      inFlight.delete(key);
      throw err;
    });
    inFlight.set(key, p);
  }
  return p;
}

export function clearBundleCache(): void {
  inFlight.clear();
}

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { STORAGE_SUBDIRS, TMP_SUBDIR, type StorageArea } from "@studio/shared";

/** Create storage/{media,proxies,renders,exports,library,tmp}. */
export async function ensureStorageLayout(storageDir: string): Promise<void> {
  const dirs = [...Object.values(STORAGE_SUBDIRS), TMP_SUBDIR];
  await Promise.all(dirs.map((d) => mkdir(path.join(storageDir, d), { recursive: true })));
}

/** Resolve a STORAGE_DIR-relative path, refusing traversal outside storage. */
export function resolveStoragePath(storageDir: string, relative: string): string {
  const abs = path.resolve(storageDir, relative);
  const root = path.resolve(storageDir) + path.sep;
  if (!abs.startsWith(root)) throw new Error(`Path escapes storage: ${relative}`);
  return abs;
}

/** Build a posix-style relative path inside an area, e.g. ("renders", "x.mp4") -> "renders/x.mp4". */
export function storageRelative(area: StorageArea, fileName: string): string {
  return `${STORAGE_SUBDIRS[area]}/${fileName}`;
}

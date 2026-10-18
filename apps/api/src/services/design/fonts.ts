import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fontFilesFor } from "@studio/remotion";
import { TMP_SUBDIR } from "@studio/shared";

/**
 * libass `fontsdir` is not recursive, so the bundled fonts (packages/remotion/public/fonts/<Family>/)
 * are mirrored flat into `<storage>/tmp/fonts-ass/` once (≈ 1,8 MB, refreshed when a size
 * changes). Returns the absolute folder, or null if it cannot be prepared (the burn-in then falls
 * back to the system fonts, as before Sprint 6).
 */
export function ensureAssFontsDir(storageDir: string): string | null {
  try {
    const dir = path.join(storageDir, TMP_SUBDIR, "fonts-ass");
    mkdirSync(dir, { recursive: true });
    for (const src of fontFilesFor()) {
      const dest = path.join(dir, path.basename(src));
      if (!existsSync(dest) || statSync(dest).size !== statSync(src).size) copyFileSync(src, dest);
    }
    return dir;
  } catch {
    return null;
  }
}

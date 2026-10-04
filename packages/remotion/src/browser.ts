import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MotionEngineError, type MotionAvailability } from "@studio/motion-engines";

/** packages/remotion (works from src/ and dist/). */
export const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = path.resolve(PACKAGE_DIR, "../..");

export const BROWSER_HINT =
  "Falta Chrome Headless Shell para Remotion. Ejecuta `pnpm --filter @studio/remotion browser:ensure` " +
  "(scripts/windows/setup.ps1 lo hace) o define REMOTION_BROWSER_EXECUTABLE con la ruta a chrome-headless-shell.exe.";

export class RemotionBrowserMissingError extends MotionEngineError {
  override readonly code = "BROWSER_MISSING";
  constructor(detail?: string) {
    super(detail ? `${BROWSER_HINT} (${detail})` : BROWSER_HINT, "remotion");
    this.name = "RemotionBrowserMissingError";
  }
}

/** Relative location of Remotion's downloaded headless shell inside a `node_modules/.remotion`. */
function headlessShellRelative(): string | null {
  const arch = os.arch();
  switch (process.platform) {
    case "win32":
      return path.join("win64", "chrome-headless-shell-win64", "chrome-headless-shell.exe");
    case "linux":
      return arch === "arm64"
        ? path.join("linux-arm64", "chrome-headless-shell-linux-arm64", "headless_shell")
        : path.join("linux64", "chrome-headless-shell-linux64", "chrome-headless-shell");
    case "darwin": {
      const p = arch === "arm64" ? "mac-arm64" : "mac-x64";
      return path.join(p, `chrome-headless-shell-${p}`, "chrome-headless-shell");
    }
    default:
      return null;
  }
}

/** Directories whose `node_modules/.remotion` may hold the browser (depends on setup's cwd). */
function candidateRoots(): string[] {
  const roots = [REPO_ROOT, PACKAGE_DIR, path.join(REPO_ROOT, "apps", "api")];
  let dir = process.cwd();
  for (;;) {
    roots.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [...new Set(roots.map((r) => path.resolve(r)))];
}

/**
 * Locate Chrome Headless Shell without downloading anything:
 * explicit path > REMOTION_BROWSER_EXECUTABLE > `<root>/node_modules/.remotion/chrome-headless-shell/...`.
 * Returns null when none exists. An explicit/env path that does not exist throws.
 */
export function resolveBrowserExecutable(explicit?: string | null): string | null {
  const configured = explicit || process.env.REMOTION_BROWSER_EXECUTABLE?.trim();
  if (configured) {
    if (!existsSync(configured)) throw new RemotionBrowserMissingError(`no existe ${configured}`);
    return configured;
  }
  const rel = headlessShellRelative();
  if (!rel) return null;
  for (const root of candidateRoots()) {
    const exe = path.join(root, "node_modules", ".remotion", "chrome-headless-shell", rel);
    if (existsSync(exe)) return exe;
  }
  return null;
}

/** For MotionEngine.checkAvailable: never throws. */
export async function checkRemotionAvailable(
  explicit?: string | null,
): Promise<MotionAvailability> {
  try {
    return resolveBrowserExecutable(explicit) ? { ok: true } : { ok: false, reason: BROWSER_HINT };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

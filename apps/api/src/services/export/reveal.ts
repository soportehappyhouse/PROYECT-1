import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { STORAGE_SUBDIRS } from "@studio/shared";

/**
 * Sprint 5 (M3): «Abrir carpeta» of an export. Only files under storage/exports; the file is
 * selected in the Explorer on Windows (`explorer.exe /select,<abs>` as ONE argv element, no shell:
 * spaces and accents are safe; explorer exits with 1 even when it worked), `open -R` on macOS and
 * the folder with `xdg-open` elsewhere.
 */

export type RevealRunner = (command: string, args: string[]) => void;

/** Default runner: detached, no shell, exit code ignored. */
export const spawnRevealRunner: RevealRunner = (command, args) => {
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: false });
  child.on("error", () => undefined);
  child.unref();
};

/** Absolute path of `rel` when it is a file under storage/exports, else undefined. */
export function exportsFile(storageDir: string, rel: string): string | undefined {
  if (!rel || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return undefined;
  const parts = rel.replace(/\\/g, "/").split("/");
  if (parts.some((p) => p === ".." || p === "")) return undefined;
  const root = path.resolve(storageDir, STORAGE_SUBDIRS.exports);
  const abs = path.resolve(storageDir, ...parts);
  return abs.startsWith(root + path.sep) ? abs : undefined;
}

/** argv of the file manager for `abs` on `platform`. */
export function revealCommand(platform: NodeJS.Platform, abs: string): [string, string[]] {
  if (platform === "win32") return ["explorer.exe", [`/select,${abs}`]];
  if (platform === "darwin") return ["open", ["-R", abs]];
  return ["xdg-open", [path.dirname(abs)]];
}

export async function revealExport(
  storageDir: string,
  rel: string,
  run: RevealRunner = spawnRevealRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<"ok" | "outside" | "missing"> {
  const abs = exportsFile(storageDir, rel);
  if (!abs) return "outside";
  const st = await stat(abs).catch(() => undefined);
  if (!st?.isFile()) return "missing";
  // Integration (security): a link inside exports/ must not reveal a file elsewhere.
  const [realRoot, realAbs] = await Promise.all([
    realpath(path.resolve(storageDir, STORAGE_SUBDIRS.exports)).catch(() => undefined),
    realpath(abs).catch(() => undefined),
  ]);
  if (!realRoot || !realAbs || !realAbs.startsWith(realRoot + path.sep)) return "outside";
  const [cmd, args] = revealCommand(platform, abs);
  run(cmd, args);
  return "ok";
}

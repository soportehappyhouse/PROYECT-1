import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { TMP_SUBDIR } from "@studio/shared";
import type { AppContext } from "../../context.js";
import type { MediaAssetDetails } from "@studio/shared";
import { resolveStoragePath } from "../../services/storage.js";
import { isAbortError } from "../state.js";
import type { JobContext } from "../types.js";

export function requireAsset(app: AppContext, id: string): MediaAssetDetails {
  const asset = app.repos.media.get(id);
  if (!asset) throw new Error(`Asset ${id} no encontrado`);
  return asset;
}

export function absPath(app: AppContext, relative: string): string {
  return resolveStoragePath(app.config.storageDir, relative);
}

/** Per-job scratch dir storage/tmp/<jobId> (ffmpeg cwd); removed by the returned cleanup. */
export async function jobTmpDir(
  app: AppContext,
  jobId: string,
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = path.join(app.config.storageDir, TMP_SUBDIR, jobId);
  await mkdir(dir, { recursive: true });
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function fileSize(abs: string): Promise<number> {
  return (await stat(abs)).size;
}

/** Run an optional step: abort propagates; other errors are logged and swallowed. */
export async function optionalStep<T>(
  ctx: JobContext,
  label: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    if (isAbortError(err) || ctx.signal.aborted) throw err;
    ctx.log(`${label} falló: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** Throw AbortError if the job was canceled. */
export function checkAborted(ctx: JobContext): void {
  if (ctx.signal.aborted) throw Object.assign(new Error("Cancelado"), { name: "AbortError" });
}

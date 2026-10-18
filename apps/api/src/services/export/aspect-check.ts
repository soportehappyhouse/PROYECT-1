import {
  aspectLabel,
  ASPECT_FIT_OPTIONS,
  ExportPresetSchema,
  FEATURE_PACKS,
  formatErrorEs,
  orientationEs,
  presetKeepsFraming,
  sameAspect,
  SPRINT5_ERRORS,
  type AspectChoiceRequiredDetails,
  type AspectFit,
  type ExportPreset,
  type Pack,
  type Project,
} from "@studio/shared";
import type { AppContext } from "../../context.js";
import { HttpError } from "../../lib/errors.js";

/**
 * Sprint 5 (M3, decision «9:16 principal»): a horizontal video never leaves as vertical with
 * blurred bars unless the user chose it. Called by POST /api/projects/:id/export, the agent.apply
 * `export` op and project.export itself (the project may have changed since the route checked).
 */

type PresetShape = Pick<ExportPreset, "id" | "name" | "width" | "height"> &
  Partial<Pick<ExportPreset, "alpha" | "container" | "videoCodec">>;

/** Whether the «reframe» pack is installed (unknown packs = ready: the job reports it). */
export function reframeReady(
  packs: readonly Pick<Pack, "id" | "installed">[] | undefined,
): boolean {
  const pack = packs?.find((p) => p.id === FEATURE_PACKS.reframe);
  return !pack || pack.installed;
}

/**
 * Framing to use for this export, or a 409: ASPECT_CHOICE_REQUIRED (different aspect, no reframe
 * keyframes, no `aspectFit`) / REFRAME_REQUIRED (`reframe` without keyframes). Same aspect, GIF
 * and alpha presets return undefined (nothing to choose).
 */
export function resolveExportAspect(
  project: Pick<Project, "settings" | "reframe">,
  preset: PresetShape,
  aspectFit: AspectFit | undefined,
  opts: { reframeReady?: boolean } = {},
): AspectFit | undefined {
  const canvas = { width: project.settings.width, height: project.settings.height };
  if (presetKeepsFraming(preset) || sameAspect(canvas, preset)) return undefined;
  const keyframes = (project.reframe?.keyframes.length ?? 0) > 0;
  if (aspectFit === "reframe" && !keyframes)
    throw new HttpError(
      SPRINT5_ERRORS.REFRAME_REQUIRED.status,
      "REFRAME_REQUIRED",
      formatErrorEs("REFRAME_REQUIRED"),
    );
  if (aspectFit) return aspectFit;
  if (keyframes) return "reframe";
  const details: AspectChoiceRequiredDetails = {
    canvas: { w: canvas.width, h: canvas.height },
    preset: { id: preset.id, w: preset.width, h: preset.height },
    options: [...ASPECT_FIT_OPTIONS],
    reframeReady: opts.reframeReady ?? true,
  };
  throw new HttpError(
    SPRINT5_ERRORS.ASPECT_CHOICE_REQUIRED.status,
    "ASPECT_CHOICE_REQUIRED",
    formatErrorEs("ASPECT_CHOICE_REQUIRED", {
      orientacion: orientationEs(canvas.width, canvas.height),
      preset: preset.name,
      aspecto: aspectLabel(preset.width, preset.height),
    }),
    details,
  );
}

/** True when resolveExportAspect would ask (cheap check before fetching the packs). */
export function exportNeedsChoice(
  project: Pick<Project, "settings" | "reframe">,
  preset: PresetShape,
  aspectFit: AspectFit | undefined,
): boolean {
  try {
    resolveExportAspect(project, preset, aspectFit);
    return false;
  } catch (err) {
    return err instanceof HttpError && err.code === "ASPECT_CHOICE_REQUIRED";
  }
}

/**
 * Route check of POST /api/projects/:id/export: same as resolveExportAspect, with
 * `details.reframeReady` from the workers' packs (only fetched when the choice is needed).
 */
export async function checkExportAspectRequest(
  app: Pick<AppContext, "repos" | "workers">,
  project: Pick<Project, "settings" | "reframe">,
  req: { presetId: string; aspectFit?: AspectFit | undefined },
): Promise<AspectFit | undefined> {
  const stored = app.repos.presets.get(req.presetId);
  if (!stored) return undefined;
  const preset = ExportPresetSchema.parse(stored);
  if (!exportNeedsChoice(project, preset, req.aspectFit))
    return resolveExportAspect(project, preset, req.aspectFit);
  const packs = await app.workers.packs().catch(() => undefined);
  return resolveExportAspect(project, preset, req.aspectFit, { reframeReady: reframeReady(packs) });
}

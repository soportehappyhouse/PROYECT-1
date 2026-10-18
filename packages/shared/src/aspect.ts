import { z } from "zod";
import { AspectFitSchema, type AspectFit } from "./agent.js";
import type { ExportPreset } from "./export.js";

/**
 * Sprint 5 (M3): aspect helpers shared by the api (409 ASPECT_CHOICE_REQUIRED, plan expansion)
 * and the web (Exportar → encuadre, PlanChoices).
 */

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Width / height after rounding to even sizes (as the export compiler does). */
export function aspectOf(width: number, height: number): number {
  return even(width) / even(height);
}

/** Aspects that differ by less than this are the same (rounding of even sizes). */
export const ASPECT_EPS = 0.01;

export function sameAspect(
  a: { width: number; height: number },
  b: { width: number; height: number },
): boolean {
  return Math.abs(aspectOf(a.width, a.height) - aspectOf(b.width, b.height)) < ASPECT_EPS;
}

type PresetShape = Pick<ExportPreset, "width" | "height"> &
  Partial<Pick<ExportPreset, "alpha" | "container" | "videoCodec">>;

/** GIF and alpha exports keep the canvas framing (scale/pad): no choice applies. */
export function presetKeepsFraming(preset: PresetShape): boolean {
  return !!preset.alpha || preset.container === "gif" || preset.videoCodec === "gif";
}

/**
 * True when exporting `canvas` with `preset` needs a framing choice: different aspect (≥ 0.01),
 * not GIF / alpha, and no reframe keyframes (with keyframes the reframe applies, as before).
 */
export function needsAspectChoice(
  canvas: { width: number; height: number },
  preset: PresetShape,
  reframe?: { keyframes: readonly unknown[] } | null,
): boolean {
  if (presetKeepsFraming(preset)) return false;
  if (sameAspect(canvas, preset)) return false;
  return !reframe?.keyframes.length;
}

/** Reframe target (op `reframe` / vision.reframe) of a preset, or null (16:9 or other aspects). */
export function reframeTargetFor(
  preset: Pick<ExportPreset, "width" | "height">,
): "9:16" | "1:1" | "4:5" | null {
  const a = aspectOf(preset.width, preset.height);
  const targets = [
    ["9:16", 9 / 16],
    ["1:1", 1],
    ["4:5", 4 / 5],
  ] as const;
  for (const [id, v] of targets) if (Math.abs(a - v) < ASPECT_EPS) return id;
  return null;
}

/** «horizontal» | «vertical» | «cuadrado» (Spanish, for messages). */
export function orientationEs(
  width: number,
  height: number,
): "horizontal" | "vertical" | "cuadrado" {
  const a = aspectOf(width, height);
  return Math.abs(a - 1) < ASPECT_EPS ? "cuadrado" : a > 1 ? "horizontal" : "vertical";
}

/** «9:16», «16:9», «1:1», «4:5» or «W×H» (Spanish messages). */
export function aspectLabel(width: number, height: number): string {
  const a = aspectOf(width, height);
  const known = [
    ["16:9", 16 / 9],
    ["9:16", 9 / 16],
    ["1:1", 1],
    ["4:5", 4 / 5],
  ] as const;
  for (const [id, v] of known) if (Math.abs(a - v) < ASPECT_EPS) return id;
  return `${even(width)}×${even(height)}`;
}

/** Order of the options everywhere (409 details, PlanChoices, Exportar). */
export const ASPECT_FIT_OPTIONS: readonly AspectFit[] = ["reframe", "center", "blur"];

/** Short Spanish labels of the three framings. */
export const ASPECT_FIT_LABELS_ES: Record<AspectFit, string> = {
  reframe: "Seguir la cara",
  center: "Recortar al centro",
  blur: "Dejarlo entero con franjas borrosas",
};

/** One-line help of each framing (Exportar, tooltips). */
export const ASPECT_FIT_HELP_ES: Record<AspectFit, string> = {
  reframe: "Studio busca la cara en cada plano y mueve el recorte para seguirla.",
  center:
    "Recorta el centro del video al formato del destino: rápido, pero puede cortar a la persona.",
  blur: "Muestra el video entero, achicado, con el mismo video desenfocado arriba y abajo.",
};

/**
 * Sprint 5: pick an option of a PlanChoice of a stored plan (Asistente → PlanChoices). The api
 * applies the option (patch/insert), expands and resolves the plan again and returns the record.
 */
export const AGENT_PLAN_CHOOSE_ROUTE = "/api/agent/plans/:id/choose";
export const AgentPlanChooseRequestSchema = z
  .object({ choiceId: z.string().min(1), optionId: AspectFitSchema })
  .strict();
export type AgentPlanChooseRequest = z.infer<typeof AgentPlanChooseRequestSchema>;

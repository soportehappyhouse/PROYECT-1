import {
  ASPECT_FIT_LABELS_ES,
  FEATURE_PACKS,
  orientationEs,
  presetKeepsFraming,
  reframeTargetFor,
  sameAspect,
  type AgentPlanValidation,
  type EditOp,
  type EditPlan,
  type PlanChoice,
  type PlanChoiceOption,
} from "@studio/shared";
import { reframeReady } from "../export/aspect-check.js";
import { canvasSize, resolvePlan, type PlanResolution, type ResolveContext } from "./resolve.js";

/**
 * Sprint 5 (M3, H6): before resolving a plan the api expands it so a horizontal video is never
 * exported to 9:16 with blurred bars by default. For every `export` to another aspect without
 * `aspect_fit`, without a previous `reframe`/`set_canvas` and without project reframe keyframes:
 * (a) a video and the «reframe» pack (or unknown packs) -> a `reframe {target, subject:"face"}` is
 * inserted before it and the export gets `aspect_fit:"reframe"` (`added`); (b) otherwise a
 * PlanChoice with the three framings and the export stays unresolved until one is picked. An
 * explicit `aspect_fit:"reframe"` without a reframe before inserts it too. Runs before each of
 * the 4 resolvePlan calls (Asistente, plan editado, Consola Claude, Perfil de estilo).
 */

export const ADDED_REFRAME_REASON_ES =
  "El video es horizontal: lo reencuadro siguiendo la cara antes de exportar.";
export const ADDED_SUFFIX_ES = " (agregado por Studio)";

export interface ExpandedPlan {
  plan: EditPlan;
  added: AgentPlanValidation["added"];
  choices: PlanChoice[];
  /** Export op index of each choice (same order as `choices`). */
  choiceOps: number[];
}

type ExpandContext = Pick<ResolveContext, "project" | "media" | "presets" | "packs">;

const hasVideo = (ctx: ExpandContext) =>
  ctx.project.tracks.some(
    (t) =>
      t.kind === "video" &&
      t.clips.some((c) => c.assetId && ctx.media(c.assetId)?.kind === "video"),
  );

function presetOf(ctx: ExpandContext, id: string) {
  const norm = (s: string) => s.trim().toLowerCase();
  return (
    ctx.presets.find((p) => p.id === id) ??
    ctx.presets.find((p) => norm(p.id) === norm(id) || norm(p.name) === norm(id))
  );
}

function packLine(ctx: ExpandContext): string {
  const pack = ctx.packs?.find((p) => p.id === FEATURE_PACKS.reframe);
  if (!pack || pack.installed) return ASPECT_FIT_LABELS_ES.reframe;
  const mb = Math.max(1, Math.round(pack.size_bytes / 1e6));
  return `${ASPECT_FIT_LABELS_ES.reframe} (descarga «${pack.name_es}», ${mb} MB)`;
}

export function expandPlanForAspect(plan: EditPlan, ctx: ExpandContext): ExpandedPlan {
  const ops: EditOp[] = plan.ops.map((o) => ({ ...o }) as EditOp);
  const added: ExpandedPlan["added"] = [];
  const pending: { exportIndex: number; choice: PlanChoice }[] = [];
  const keyframes = (ctx.project.reframe?.keyframes.length ?? 0) > 0;
  let canvas = { width: ctx.project.settings.width, height: ctx.project.settings.height };
  let reframed = keyframes;
  const video = hasVideo(ctx);
  const ready = reframeReady(ctx.packs);
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    if (op.op === "reframe") {
      reframed = true;
      continue;
    }
    if (op.op === "set_canvas") {
      const size = canvasSize({ settings: { ...ctx.project.settings, ...canvas } }, op.preset);
      canvas = { width: size.w, height: size.h };
      // A new canvas of the export aspect is the user's framing choice: nothing to add.
      continue;
    }
    if (op.op !== "export") continue;
    const preset = presetOf(ctx, op.preset);
    if (!preset || presetKeepsFraming(preset) || sameAspect(canvas, preset)) continue;
    if (op.aspect_fit === "center" || op.aspect_fit === "blur") continue;
    if (reframed) continue;
    const target = reframeTargetFor(preset);
    const reframeOp = target ? ({ op: "reframe", target, subject: "face" } as EditOp) : undefined;
    if (reframeOp && video && (op.aspect_fit === "reframe" || ready)) {
      ops.splice(i, 0, reframeOp);
      added.push({ index: i, reason_es: ADDED_REFRAME_REASON_ES });
      i++;
      ops[i] = { ...op, aspect_fit: "reframe" };
      reframed = true;
      continue;
    }
    const options: PlanChoiceOption[] = [];
    if (reframeOp && video)
      options.push({
        id: "reframe",
        label_es: packLine(ctx),
        insert: { before: i, op: reframeOp },
        patch: { index: i, aspect_fit: "reframe" },
      });
    options.push(
      {
        id: "center",
        label_es: ASPECT_FIT_LABELS_ES.center,
        patch: { index: i, aspect_fit: "center" },
      },
      { id: "blur", label_es: ASPECT_FIT_LABELS_ES.blur, patch: { index: i, aspect_fit: "blur" } },
    );
    const where = preset.id === "reels-tiktok" ? "Reels" : `«${preset.name}»`;
    const orient = orientationEs(preset.width, preset.height);
    pending.push({
      exportIndex: i,
      choice: {
        id: pending.length === 0 ? "aspect" : `aspect-${pending.length + 1}`,
        question_es: `El video es ${orientationEs(canvas.width, canvas.height)} y ${where} es ${orient}. ¿Cómo lo encuadro?`,
        options,
      },
    });
  }
  return {
    plan: { ...plan, ops },
    added,
    choices: pending.map((p) => p.choice),
    choiceOps: pending.map((p) => p.exportIndex),
  };
}

export type ExpandedResolution = PlanResolution & {
  plan: EditPlan;
  added: AgentPlanValidation["added"];
  choices: PlanChoice[];
};

/**
 * expandPlanForAspect + resolvePlan: the export of a pending choice stays unresolved (with the
 * question), ops added by Studio say so in their preview line.
 */
export function resolveExpandedPlan(
  plan: EditPlan,
  ctx: ResolveContext,
  resolve: typeof resolvePlan = resolvePlan,
): ExpandedResolution {
  const x = expandPlanForAspect(plan, ctx);
  const r = resolve(x.plan, ctx);
  for (const a of x.added)
    if (r.preview_es[a.index] !== undefined) r.preview_es[a.index] += ADDED_SUFFIX_ES;
  x.choices.forEach((c, k) => {
    const i = x.choiceOps[k]!;
    r.resolved[i] = null;
    r.unresolved.push(`Operación ${i + 1}: ${c.question_es}`);
  });
  return { ...r, plan: x.plan, added: x.added, choices: x.choices };
}

/** Apply a picked option to a plan (patch first, then insert); the caller expands and resolves. */
export function applyPlanChoice(plan: EditPlan, option: PlanChoiceOption): EditPlan {
  const ops = plan.ops.map((o) => ({ ...o }) as EditOp);
  if (option.patch) {
    const target = ops[option.patch.index];
    if (target?.op === "export")
      ops[option.patch.index] = { ...target, aspect_fit: option.patch.aspect_fit };
  }
  if (option.insert) ops.splice(option.insert.before, 0, option.insert.op);
  return { ...plan, ops };
}

/**
 * resolveExpandedPlan typed for the record spreads of the call sites (`{plan, added: [],
 * choices: [], ...r}`): the expanded `plan`, `added` and `choices` override the defaults.
 */
export function resolvePlanForRecord(
  plan: EditPlan,
  ctx: ResolveContext,
  resolve: typeof resolvePlan = resolvePlan,
): PlanResolution & Partial<Pick<ExpandedResolution, "plan" | "added" | "choices">> {
  return resolveExpandedPlan(plan, ctx, resolve);
}

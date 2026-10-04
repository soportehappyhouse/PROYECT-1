import type { MotionTemplateInfo } from "@studio/shared";
import { z } from "zod";
import { findTemplateDef, TEMPLATE_DEFS, THUMBNAIL_SUFFIX, type TemplateDef } from "./catalog.js";
import { REMOTION_COLOR_BRAND, REMOTION_TEXTAREA_BRAND } from "./schemas/common.js";

export { TEMPLATE_DEFS, type RemotionTemplateId } from "./catalog.js";

/** MotionTemplateInfo with the optional catalog fields made required for Remotion templates. */
export interface RemotionTemplateInfo extends MotionTemplateInfo {
  engine: "remotion";
  category: TemplateDef["category"];
  defaultSize: { width: number; height: number };
  /** Still composition for previews: render with renderStill or show in <Player>. */
  thumbnail: { compositionId: string; frame: number };
}

/**
 * zod -> JSON Schema (draft 2020-12) for the dashboard form. Studio brands become
 * `format: "color"` / `format: "textarea"`. Uses the *input* shape so defaulted keys are optional.
 */
export function toPropsJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
    override: (ctx) => {
      const js = ctx.jsonSchema as Record<string, unknown>;
      if (js.description === REMOTION_COLOR_BRAND) {
        delete js.description;
        js.format = "color";
      } else if (js.description === REMOTION_TEXTAREA_BRAND) {
        delete js.description;
        js.format = "textarea";
      }
    },
  }) as Record<string, unknown>;
}

function toInfo(def: TemplateDef): RemotionTemplateInfo {
  return {
    engine: "remotion",
    id: def.id,
    name: def.name,
    description: def.description,
    category: def.category,
    propsSchema: toPropsJsonSchema(def.schema),
    defaultProps: def.schema.parse({}) as Record<string, unknown>,
    defaultDurationSec: def.defaultDurationSec,
    defaultSize: def.defaultSize,
    supportsAlpha: def.supportsAlpha,
    thumbnail: { compositionId: `${def.id}${THUMBNAIL_SUFFIX}`, frame: def.thumbnailFrame },
  };
}

/** Catalog of Remotion templates exposed by GET /api/motion/templates. */
export const REMOTION_TEMPLATES: readonly RemotionTemplateInfo[] = (
  TEMPLATE_DEFS as readonly TemplateDef[]
).map(toInfo);

export type PropsValidation =
  { ok: true; props: Record<string, unknown> } | { ok: false; errors: string[] };

/** Validate + apply defaults. Errors are Spanish, prefixed with the prop path. */
export function validateRemotionProps(templateId: string, props: unknown): PropsValidation {
  const def = findTemplateDef(templateId);
  if (!def) return { ok: false, errors: [`Plantilla Remotion desconocida: ${templateId}`] };
  const parsed = def.schema.safeParse(props ?? {});
  if (parsed.success) return { ok: true, props: parsed.data as Record<string, unknown> };
  return {
    ok: false,
    errors: parsed.error.issues.map(
      (i) => `${i.path.length ? i.path.join(".") : "props"}: ${i.message}`,
    ),
  };
}

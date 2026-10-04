import type { MotionTemplateInfo } from "@studio/shared";

/**
 * Catalog of Remotion compositions. Ids MUST match <Composition id> in Root.tsx and
 * REMOTION_TEMPLATE_IDS in @studio/shared.
 * TODO(module-c): one zod props schema per template (+ z.toJSONSchema -> propsSchema).
 */
export const REMOTION_TEMPLATES = [
  {
    engine: "remotion",
    id: "title-card",
    name: "Título",
    description: "Animated centered title with subtitle.",
    defaultProps: { title: "Mi título", subtitle: "", color: "#ffffff", background: "#111111" },
    defaultDurationSec: 3,
    supportsAlpha: true,
  },
  {
    engine: "remotion",
    id: "lower-third",
    name: "Lower third",
    description: "Name + role bar sliding in from the left.",
    defaultProps: { name: "Nombre Apellido", role: "Cargo", accent: "#e13238" },
    defaultDurationSec: 5,
    supportsAlpha: true,
  },
  {
    engine: "remotion",
    id: "animated-captions",
    name: "Subtítulos animados",
    description: "Word-by-word highlighted captions from a Whisper transcript.",
    defaultProps: { segments: [], highlightColor: "#ffd400", fontSize: 72 },
    defaultDurationSec: 10,
    supportsAlpha: true,
  },
  {
    engine: "remotion",
    id: "transition",
    name: "Transición",
    description: "Full-frame wipe/fade transition overlay.",
    defaultProps: { kind: "wipe", color: "#000000" },
    defaultDurationSec: 1,
    supportsAlpha: true,
  },
] as const satisfies readonly MotionTemplateInfo[];

export type RemotionTemplateId = (typeof REMOTION_TEMPLATES)[number]["id"];

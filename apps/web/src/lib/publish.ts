import type { Project } from "@studio/shared";
import {
  DEFAULT_AI_LABEL_TEXT,
  DEFAULT_PUBLISH,
  PublishSettingsSchema,
  type PublishFlags,
  type PublishSettings,
} from "./ai-types";

/** Project with the Sprint 1 `publish` field (TODO(integration): in @studio/shared). */
export type ProjectWithPublish = Project & { publish?: PublishSettings };

export function projectPublish(project: Project): PublishSettings {
  const parsed = PublishSettingsSchema.safeParse((project as ProjectWithPublish).publish);
  return parsed.success ? parsed.data : DEFAULT_PUBLISH;
}

export function hasAiContent(flags: PublishFlags): boolean {
  return flags.aiFace || flags.aiVoice || flags.aiOther;
}

/**
 * Apply a change to the social review. The AI label turns on by itself when the video becomes
 * «AI content for social media» (forSocial + any AI flag); after that the user's choice stays.
 */
export function nextPublish(
  prev: PublishSettings,
  patch: Partial<Omit<PublishSettings, "flags">> & { flags?: Partial<PublishFlags> },
): PublishSettings {
  const next: PublishSettings = {
    ...prev,
    ...patch,
    flags: { ...prev.flags, ...patch.flags },
  };
  const wasAi = prev.forSocial && hasAiContent(prev.flags);
  const isAi = next.forSocial && hasAiContent(next.flags);
  if (isAi && !wasAi && patch.aiLabel === undefined) next.aiLabel = true;
  if (next.aiLabel && !next.aiLabelText) next.aiLabelText = DEFAULT_AI_LABEL_TEXT;
  return next;
}

export type PublishFlagId = keyof PublishFlags;

export interface PublishFlagInfo {
  id: PublishFlagId;
  label: string;
  /** Short consequence badges. */
  badges: { text: string; tone: "warning" | "danger" | "default" }[];
  warning: string;
}

const LABEL = { text: "Requiere etiqueta", tone: "default" } as const;
const TAKEDOWN = { text: "Puede darse de baja", tone: "danger" } as const;
const NO_MONEY = { text: "No monetizable", tone: "warning" } as const;

/** Checklist of «Revisión para redes» with the platform consequences of each item. */
export const PUBLISH_FLAGS: readonly PublishFlagInfo[] = [
  {
    id: "aiFace",
    label: "Cara generada o cambiada con IA",
    badges: [LABEL, TAKEDOWN],
    warning:
      "YouTube, TikTok e Instagram exigen marcarlo como contenido alterado o sintético. Sin etiqueta, o sin el consentimiento de la persona, el video puede darse de baja.",
  },
  {
    id: "aiVoice",
    label: "Voz generada o clonada con IA",
    badges: [LABEL, TAKEDOWN],
    warning:
      "Una voz realista que imita a alguien requiere etiqueta. Clonar la voz de un tercero sin permiso puede hacer que se dé de baja.",
  },
  {
    id: "aiOther",
    label: "Otro contenido realista hecho con IA",
    badges: [LABEL],
    warning:
      "Escenas, lugares o hechos realistas generados o alterados con IA requieren la etiqueta de contenido alterado.",
  },
  {
    id: "music",
    label: "Música con derechos de autor",
    badges: [NO_MONEY, TAKEDOWN],
    warning:
      "Lo más probable es un reclamo de Content ID: el video no será monetizable (los ingresos van al titular) y puede silenciarse o bloquearse en algunos países.",
  },
  {
    id: "thirdParty",
    label: "Contenido de terceros (clips, imágenes, marcas)",
    badges: [NO_MONEY, TAKEDOWN],
    warning:
      "Sin permiso, el titular puede pedir la baja o quedarse con la monetización. Usá material propio, con licencia o con atribución.",
  },
];

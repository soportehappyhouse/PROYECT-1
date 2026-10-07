import {
  detectAiContent,
  detectedPublishFlags,
  type AiContentReport,
  type DetectedPublishFlags,
  type MediaAsset,
  type Project,
} from "@studio/shared";
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

export type PublishPatch = Partial<Omit<PublishSettings, "flags">> & {
  flags?: Partial<PublishFlags>;
};

/**
 * Sprint 4: AI content of the project from the provenance of its media (face swap, synthetic or
 * cloned voice), only clips that reach the export (shared detectAiContent).
 */
export function projectAiContent(
  project: Pick<Project, "tracks">,
  assets: Readonly<Record<string, MediaAsset>>,
): AiContentReport {
  return detectAiContent(project, new Map(Object.entries(assets)));
}

/** Flags the checklist shows: the stored ones plus what the detection locks (face, cloned voice). */
export function effectiveFlags(flags: PublishFlags, detected?: DetectedPublishFlags): PublishFlags {
  if (!detected) return flags;
  return {
    ...flags,
    aiFace: flags.aiFace || detected.locked.aiFace,
    aiVoice: flags.aiVoice || detected.locked.aiVoice,
  };
}

/**
 * Patch of «Voy a subirlo a redes»: turning it on also marks what the detection found (a voice that
 * is only synthetic gets marked too, but stays editable), so nextPublish proposes the AI label
 * (decision 4). Turning it off only clears forSocial: in internal use the label stays off.
 */
export function socialPatch(forSocial: boolean, report?: AiContentReport): PublishPatch {
  if (!forSocial || !report) return { forSocial };
  const d = detectedPublishFlags(report);
  const flags: Partial<PublishFlags> = {
    ...(d.aiFace && { aiFace: true }),
    ...(d.aiVoice && { aiVoice: true }),
  };
  return Object.keys(flags).length > 0 ? { forSocial, flags } : { forSocial };
}

/** Locked flags that the stored publish settings still lack (persisted by «Revisión para redes»). */
export function missingLockedFlags(
  flags: PublishFlags,
  detected: DetectedPublishFlags,
): Partial<PublishFlags> | undefined {
  const out: Partial<PublishFlags> = {
    ...(detected.locked.aiFace && !flags.aiFace && { aiFace: true }),
    ...(detected.locked.aiVoice && !flags.aiVoice && { aiVoice: true }),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Apply a change to the social review. The AI label turns on by itself when the video becomes
 * «AI content for social media» (forSocial + any AI flag); after that the user's choice stays.
 * With `detected` (sprint 4) the locked flags cannot be unchecked while the detection lasts.
 */
export function nextPublish(
  prev: PublishSettings,
  patch: PublishPatch,
  detected?: DetectedPublishFlags,
): PublishSettings {
  const next: PublishSettings = {
    ...prev,
    ...patch,
    flags: effectiveFlags({ ...prev.flags, ...patch.flags }, detected),
  };
  const wasAi = prev.forSocial && hasAiContent(effectiveFlags(prev.flags, detected));
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

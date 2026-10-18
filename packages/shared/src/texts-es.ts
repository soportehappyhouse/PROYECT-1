/**
 * Sprint 5: fixed Spanish texts shared by api, web and MCP. User-facing texts never mention
 * `start.ps1`, `TypeError`, `ECONNREFUSED` nor internal job ids: use these constants and jobLabel().
 */

/** How the user starts Studio on Windows. */
export const START_CMD_ES = "scripts\\windows\\start.cmd";

/** Where the AI packs are downloaded. */
export const PACKS_PATH_ES = "Ajustes → Paquetes de IA";

/** Workers (local AI) are not answering. */
export const WORKERS_DOWN_ES = `La IA local está apagada. Cerrá Studio y abrilo de nuevo con ${START_CMD_ES}.`;

/** The api is not answering (web only). */
export const API_DOWN_ES = `Studio no está corriendo. Abrilo con ${START_CMD_ES}.`;

// ---------------------------------------------------------------------------------------------
// Sprint 6 (docs/trabajo/sprint6-contratos.md): base texts. Modules add their own strings in
// their own files; names of panels, packs and actions always come from GLOSSARY_ES.

/** Canonical Spanish names (H19): panels, settings tabs and recurring actions. */
export const GLOSSARY_ES = {
  panels: {
    script: "Guion",
    subtitles: "Subtítulos",
    motion: "Motion graphics",
    inspector: "Propiedades",
    assistant: "Asistente",
    suggestions: "Sugerencias",
    voice: "Voz y audio",
    media: "Media",
    export: "Exportar",
    jobs: "Trabajos",
    console: "Consola Claude",
    style: "Perfil de estilo",
  },
  settings: {
    brandKit: "Kit de marca",
    packs: "Paquetes de IA",
    persons: "Personas",
    shortcuts: "Atajos",
    localAssistant: "Asistente local",
  },
  actions: {
    apply: "Aplicar",
    dismiss: "Ignorar",
    muteKind: "No sugerir más",
    undoAll: "Deshacer todo",
    transcribe: "Transcribir",
    removeSafeFillers: "Quitar seguras",
    reviewDoubtful: "Revisar dudosas",
    shortenPauses: "Acortar pausas largas",
    fitDuration: "Dejalo en…",
    calibrate: "Calibrar con una captura",
    fix: "Arreglar",
    advanced: "Avanzado",
  },
  media: {
    generated: "Generados",
  },
} as const;

/** Transcribing (Subtítulos and Guion) needs a clip with speech on the timeline. */
export const NEED_SPEECH_CLIP_ES =
  "Primero agregá un video o un audio con voz a la línea de tiempo";

/** Filler confidence levels as shown in the Guion panel. */
export const FILLER_LEVEL_ES = {
  safe: "Segura",
  probable: "Probable",
  doubtful: "Dudosa",
} as const;

/** Guion panel (M1). `{n}`/`{s}` placeholders are filled by the panel. */
export const SCRIPT_TEXTS_ES = {
  empty: "Transcribí el video para editarlo como texto.",
  stale:
    "El guion no coincide con la línea de tiempo. Volvé a transcribir o deshacé el último cambio.",
  longPauses: "{n} pausas de más de 0,6 s",
  /** Audit S6 E9: transcribing again replaces words corrected by hand. */
  replaceCorrected:
    "Este tramo tiene {n} palabras corregidas a mano: transcribir de nuevo las reemplaza.",
  replaceCorrectedAction: "Transcribir igual",
  removed: "Quité {n} muletillas (−{s} s).",
  harshSkipped: "Dejé {n} sin cortar para evitar cortes bruscos.",
  corrected: "Tiempo estimado por la corrección",
} as const;

/** Extra Spanish texts of the Guion panel (M1; moved here by the integration). */
export const SCRIPT_PANEL_TEXTS_ES = {
  title: "Guion",
  transcribe: "Transcribir para el guion",
  transcribing: "Transcribiendo palabras…",
  removeSafe: "Quitar seguras ({n})",
  reviewDoubtful: "Revisar dudosas ({n})",
  shortenPauses: "Acortar pausas largas ({n})",
  fitLabel: "Dejalo en",
  fitPreview: "Ver propuesta",
  fitApply: "Aplicar",
  deleteSelection: "Borrar selección",
  noAudioArtifact:
    "Sin el análisis de audio no se detectan los «eh» que Whisper no escribe: volvé a transcribir desde el Guion.",
  acoustic: "(eh)",
  fixPrompt: "Corregí el texto (los tiempos no se mueven)",
  deleted: "Borré {n} palabras (−{s} s).",
  nothingToCut: "No hay nada para cortar con esa selección.",
  harsh: "Corte brusco: queda sin cortar para no comerse la palabra vecina",
} as const;

/** Design system / brand kit (M2). */
export const DESIGN_TEXTS_ES = {
  safeZoneGuide:
    "La zona segura es una guía (las apps cambian): calibrala con una captura de tu teléfono.",
  allRulesPass: "Subtítulos y títulos cumplen las 10 reglas de diseño.",
  /** Audit S6 E25. */
  nothingToCheck: "No hay subtítulos quemados, títulos ni textos para revisar.",
  rulesFailed: "{n} de 10 reglas de diseño no se cumplen.",
  lowContrast: "Poco contraste: se lee mal sobre el video.",
  fontsBundled: "Tipografías incluidas en Studio (funcionan sin internet).",
} as const;

/** Import suggestions (M3). */
export const SUGGESTION_TEXTS_ES = {
  silences: "{n} silencios largos = {s} s de {total}",
  lowVoice: "La voz está baja ({lufs} LUFS). ¿La subo a un nivel normal para redes?",
  clipping: "El audio satura (pico de {tp} dBTP). ¿Lo bajo un poco?",
  analyzing: "Analizando {n} medios…",
} as const;

/** UI texts of the suggestion cards (M3; moved here by the integration). */
export const SUGGESTION_UI_ES = {
  section: "Sugerencias",
  sectionHelp:
    "Studio revisó los medios que importaste y encontró cosas que se pueden mejorar. Nada se aplica solo.",
  apply: "Aplicar",
  dismiss: "Ignorar",
  mute: "No sugerir más",
  stale: "El clip cambió desde el análisis",
  silencesDetail:
    "Cortar silencios de {min} ms o más con un margen corto antes y después de cada corte.",
  lowVoiceTitle: "La voz está baja ({lufs} LUFS)",
  lowVoiceDetail:
    "Subir {gain} dB la deja cerca de {target} LUFS (nivel normal en redes) sin saturar.",
  clippingTitle: "El audio satura (pico de {tp} dBTP)",
  clippingDetail: "Bajar {gain} dB deja el pico en {limit} dBTP (sin distorsión al exportar).",
  analyzeAction: "Analizar",
  analyzeTip: "Mide silencios y volumen para proponer sugerencias (trabajo de fondo)",
  empty: "No hay sugerencias para este proyecto.",
  analyzingTip: "Trabajo de fondo: nunca demora lo que pedís vos",
} as const;

/** Kinds of import suggestion (Ajustes → «Sugerencias al importar»). */
export const SUGGESTION_KIND_LABELS_ES = {
  silences: "Silencios largos",
  low_voice: "Voz baja",
  clipping: "Audio que satura",
} as const;

/** Ajustes → Asistente → «Sugerencias al importar» (integration S6). */
export const SUGGESTION_SETTINGS_ES = {
  title: "Sugerencias al importar",
  help: "Studio revisa en segundo plano los videos y audios que importás y propone arreglos (nunca aplica nada solo).",
  enabled: "Analizar los medios al importarlos",
  muted: "Tipos que no se sugieren",
  noneMuted: "No silenciaste ningún tipo de sugerencia.",
  mutedHint: "No se sugiere («No sugerir más»)",
  unmute: "Volver a sugerir",
} as const;

/** Spanish names of the built-in motion templates (raw ids are never shown in the UI). */
export const MOTION_TEMPLATE_NAMES_ES: Readonly<Record<string, string>> = {
  "title-card": "Título",
  "lower-third": "Rótulo",
  "animated-captions": "Subtítulos animados",
  transition: "Transición",
  "audio-visualizer": "Visualizador de audio",
  "lottie-overlay": "Animación Lottie",
  "end-screen": "Pantalla final",
  "progress-bar": "Barra de progreso",
  "kinetic-typography": "Tipografía cinética",
};

/** «Título» for "title-card"; «Gráfico» for an unknown template. */
export function motionTemplateNameEs(id: string | undefined): string {
  return (id && MOTION_TEMPLATE_NAMES_ES[id]) ?? "Gráfico";
}

/** Body of the Paso 0 stubs (501 NOT_IMPLEMENTED). */
export const NOT_IMPLEMENTED_ES = "Todavía no está disponible ({modulo}).";

/**
 * Technical / English terms that must not be visible in the Spanish UI outside the folded
 * «Avanzado» sections (M2 test over Motion, Propiedades and Voz). Case-insensitive, whole words.
 */
export const UI_ENGLISH_DENYLIST: readonly string[] = [
  "bottom-left",
  "bottom-right",
  "top-left",
  "top-right",
  "lower third",
  "lower-third",
  "slide",
  "fade",
  "wipe",
  "pop",
  "box",
  "bar",
  "underline",
  "split",
  "Motion Canvas",
  "Revideo",
  "ProRes",
  "PNG sequence",
  "rmvpe",
  "harvest",
  "crepe",
  "Feature index",
  "Espana",
  "Mexico",
];

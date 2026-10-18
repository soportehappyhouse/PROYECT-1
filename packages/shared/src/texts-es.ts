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
    voice: "Voz",
    media: "Medios",
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

/** Filler confidence levels as shown in the Guion panel. */
export const FILLER_LEVEL_ES = {
  safe: "Segura",
  probable: "Probable",
  doubtful: "Dudosa",
} as const;

/** Guion panel (M1). `{n}`/`{s}` placeholders are filled by the panel. */
export const SCRIPT_TEXTS_ES = {
  empty: "Transcribí el video para editarlo como texto.",
  stale: "El guion no coincide con la línea de tiempo. Volvé a transcribir.",
  longPauses: "{n} pausas de más de 0,6 s",
  removed: "Quité {n} muletillas (−{s} s).",
  harshSkipped: "Dejé {n} sin cortar para evitar cortes bruscos.",
  corrected: "Tiempo estimado por la corrección",
} as const;

/** Design system / brand kit (M2). */
export const DESIGN_TEXTS_ES = {
  safeZoneGuide:
    "La zona segura es una guía (las apps cambian): calibrala con una captura de tu teléfono.",
  allRulesPass: "Subtítulos y títulos cumplen las 10 reglas de diseño.",
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

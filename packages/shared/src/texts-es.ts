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

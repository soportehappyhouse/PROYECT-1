# Sprint 3 — módulo Web (apps/web + manual)

Contrato: `sprint3-contratos.md` (Web). Tipos/rutas de `@studio/shared` (`agent.ts`, `API_ROUTES.agent*`).

## Qué hay

- **Panel Asistente** (`panels/AssistantPanel.tsx`, `stores/agent-store.ts`, `lib/agent.ts`,
  `lib/agent-api.ts`): id `assistant` (pestaña en el grupo de Propiedades; `WebPanelId` = `PanelId |
  "assistant"`, viaja solo en `ui.layout`). `Ctrl+Shift+A` (acción `assistant.open`, también en la
  paleta y dentro de campos) muestra el panel, enfoca el comando y refresca el estado. Historial
  ↑/↓ (localStorage `studio.agent.v1`), ejemplos, línea de estado (100 % local, modelo, latencia,
  Listo/Falta Ollama/Falta el modelo/Workers apagados + «Descargar modelo»).
- **Plan**: `summary_es`, riesgos en rojo, `unresolved`/`errors` en ámbar, checklist con
  `preview_es`, badges de riesgo por op, parámetros escalares editables (texto, t, duración,
  preset, plantilla, estilo, velocidad, lienzo…), `questions` → formulario que reenvía el comando
  con «Respuestas: …». Guarda el proyecto antes de proponer/aplicar.
- **Aplicar** → `agent.apply` (`waitForJob`), estado por op desde `message` «op k/n» o progreso;
  al terminar relee el proyecto (`adoptServerProject`, 1 paso de Ctrl+Z) y los medios; op con
  `failed.packRequired` abre «Paquete requerido». **Deshacer todo** adopta `{project, plan}` del
  undo (el plan vuelve a «Propuesto», historial «Deshecho»). Rechazar / historial por proyecto.
- PACK_REQUIRED `agent-llm`: `PackRequiredDialog` con aviso de Ollama y el `message` de la api.
- **Ajustes → Asistente local** (`dashboard/AssistantTab.tsx`): modelo (qwen3:8b, hermes3:8b +
  instalados), temperatura, «Descargar modelo» (pack), «Evaluar modelos» (`agent.eval`) → tabla
  válido %, correcto %, latencia p50 (también lee `GET /api/agent/eval`).
- **Redactar con IA** (reporte): `/api/agent/bugreport` → título + pasos/esperado/pasó, editable.
- Trabajos/avisos: etiquetas `agent.apply`, `agent.eval`, descarga `agent-llm` (`jobLabel`).
- Tests `test/sprint3.test.tsx` (17); 2 pasos E2E en `ui-smoke.mjs` con `/api/agent/*` mockeado
  (PASS contra el build). Manual: §4.2, §10, §13 y nueva §19 (md + html + PDF).

## Pendiente / integración

- **`edited_ops`**: la web manda las ops editadas inline, pero `AgentApplyRequestSchema` y el
  handler aplican `record.resolved`: hoy esas ediciones se pierden. La api debe validar/resolver
  `edited_ops` (o una ruta PATCH del plan) antes de encolar.
- `format:check` falla solo por 2 `.md` de workers (no son de este módulo).

# Sprint 1 — módulo Web (apps/web + manual)

Contrato: `sprint1-contratos.md` (Web). Tipos y rutas de `@studio/shared` (`ai.ts`,
`API_ROUTES.ai*`); `apps/web/src/lib/ai-types.ts` solo agrega alias y helpers.

## Qué hay

- **Cliente** (`lib/api.ts` → `aiApi`): gpu, releaseGpu, packs, downloadPack, analyzeScenes,
  analyzeSilences, applyCuts, denoise, runPerf, lastPerf. `ApiRequestError.raw` guarda el cuerpo:
  el 409 de la api es `{error:"PACK_REQUIRED", packId, name_es, size_bytes}` (también acepta
  `error.details`). `lib/job-runner.ts`: `runJob`/`waitForJob` (SSE + GET cada 2 s); un job fallido
  con `result` PACK_REQUIRED se convierte en el mismo 409.
- **Paquete requerido** (`PackRequiredDialog` + `stores/packs-store.ts`): cualquier 409 lo abre
  (listener en `apiFetch`, y jobs fallidos en `handleFinished`). `runWithPack(acción)` guarda la
  acción completa y la repite al terminar el job `packs.download`, aunque se cierre el diálogo.
- **Cabecera** `GpuIndicator`: sondeo 10 s, tooltip multilínea (tooltip.tsx admite `\n`), menú
  «Liberar GPU» y atajo a Ajustes → «Paquetes de IA» (`AiPacksTab`: tabla, cola secuencial,
  Verificar = volver a descargar, test de rendimiento con estimaciones `perfEstimates`).
- **Silencios y muletillas** (`components/edit/SilencesDialog.tsx`, `lib/cuts.ts`): opciones →
  `analyze.silences` → revisión (casillas, Escuchar = `lib/preview.ts playRange` ±0,5 s, totales
  con solapes una vez) → `timeline.apply-cuts` (cortes en segundos de fuente) y
  `applyServerEdit` = un paso de deshacer. Si la ruta da 404/501 aplica local
  (`applyCutsLocally`, mismo ripple que el corte rápido). Botones: Subtítulos, barra del timeline,
  paleta.
- **Escenas** (`lib/scenes.ts`, `stores/scenes-store.ts`, `timeline/scene-actions.ts`): menú
  Escenas (Detectar / Cortar en escenas / Mostrar marcadores), marcadores en la regla + línea
  punteada, el imán incluye los marcadores visibles; lee también `asset.scenes`.
- **Revisión para redes** (`panels/SocialReview.tsx`, `lib/publish.ts`): `project.publish` vía
  `setPublish` (fuera del deshacer); la etiqueta se prende sola al pasar a «IA + redes».
- **Voz → Efectos → Limpiar voz (IA)**: `audio.denoise`, reemplaza el audio del clip o lo deja
  en Media (intent `refreshMedia`, ahora manejado en `handleFinished`).
- Manual §4, flujo 2, §15 y nueva §17; `index.html` y PDF regenerados (scratchpad `mdbuild`).
- Tests: `apps/web/test/sprint1.test.tsx` (16). E2E: 2 pasos al final de `ui-smoke.mjs`
  (GPU + Paquetes de IA; publish guardado en la api). Pendiente: correrlo con api+workers reales.

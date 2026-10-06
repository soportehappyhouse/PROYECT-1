# Integración Sprint 3b — 2026-10-06

Rama `claude/funny-mccarthy-0bbdt6` (5 módulos: consola, estilo, stems, recorte HQ, capas). Stack real en el sandbox (Linux, 4 vCPU, sin GPU): api `:3001` (`node dist/index.js`, `STORAGE_DIR` temporal, `STUDIO_CLAUDE_BIN` = `claude` falso que hace eco), workers `:8001` con `scripts/e2e/workers-with-mocks.py` (análisis de estilo real; RVM/SAM/stems simulados), Ollama real con `studio-tiny`, web `next build` + `next start`, Playwright Chromium.

## Qué se reconcilió (detalle en `sprint3b-contratos.md`, «Cambios en integración»)

- **Bug real**: `style.analyze` de un video **sin audio** fallaba en la api (zod: `speech_method`/`music_method` = `null`). Shared los acepta `nullish`.
- **Orden z en pistas nuevas**: stems sobre un proyecto con `Track.order` quedaban intercaladas en el orden z; ahora van justo encima de la pista origen y se renumera. `move_clip` del Asistente ya no copia el `order` a la pista nueva (queda arriba, como las de `agent.apply`).
- Packs: `test_cli_packs` independiente de Ollama; registro final de 15 packs; doctor los lista solo; `setup.ps1 -Full` documenta los nuevos.
- `.env.example` + manual §11: `STYLE_VISION_MODEL`, `STYLE_NUM_CTX`, `STUDIO_CLAUDE_BIN`.
- Manual: §23 **Consola Claude** (nuevo), índice 1–23, «Los 13 paneles», atajo `Ctrl+Shift+C`; HTML + PDF regenerados. `ARQUITECTURA.md`: rutas de consola/estilo/stems/matte HQ, workers 3b, §5.3 capas.
- Tipos/formato: `layers.test.ts` (genéricos) y `system_es.md` (prettier). CI: `studio-mcp smoke`.

## Resultados

- Desde cero: `pnpm install --frozen-lockfile` (lockfile sin cambios), `build:packages`, `lint`, `format:check`, `-r typecheck`, `-r build`, `-r test` OK (shared 70, web 190, motion-engines 22, studio-mcp 13, remotion 55+1 skip, api 229+1 skip); `studio-mcp build test smoke` OK (16 herramientas); workers ruff OK, pytest **326 passed, 5 skipped**; 6 `.ps1` parsean (pwsh 7.4); `ci.yml` válido; búsqueda de secretos vacía.
- `run-e2e.mjs` (`AGENT_MODEL=studio-tiny`): **60/60 obligatorios** (625 s), 12 pasos «sprint3b» (7 de los módulos + 5 de integración: consola estado/WS/eco/token 4401/fotograma PNG; `studio-mcp` stdio → `studio_style_save_preset` + `studio_style_apply` → plan propuesto; máscara SAM como `maskRef` en el export; hash de bloques; `Track.order` con Asistente y stems). 2 SKIP (`--hw`, descargas), 2 expected-fail (Whisper/Piper sin modelos).
- `ui-smoke.mjs --vp9-preview` (storage nuevo): **32/32** (los 3 errores de consola del navegador son 404 del proyecto local inicial y el 409 PACK_REQUIRED provocado a propósito) (+2: «Deducir con Consola Claude» → `studio:console:paste` → la consola abre sesión y el PTY muestra el pedido; máscara SAM elegida en Propiedades → «Capa», preview centro [64,64,64] / esquina [254,0,0] = export [62,62,62] / [252,0,0]).

## Mediciones

- **Estilo**: 1 min 1080p30 (3 planos + tono) → `style.analyze` **19,9 s** por la api real (3 planos detectados, hoja de contactos). Criterio < 60 s en CPU ✔.
- **Halo (recorte HQ)**: solo sintético (`test_vision_refine.py`, módulo recorte): error de color del borde 32,7 → **8,0** (−76 %); puntaje sin referencia que muestra la app 36,3 → 4,6. El mock del e2e devuelve `halo: null`; el PNG antes/después (`previewComparePath`) se sirve por `/files` ✔.
- **Paridad preview/export (capas)**: multiplicar preview [48,40,190] · export [45,39,192] · referencia `blendRgb` [48,40,192]; screen export [174,183,253] vs [176,184,255] (tolerancia 8). Elipse centro/esquina idénticos.
- **Hash de bloques**: re-export 0/1 renderizados; fusión, máscara y orden → 1/1; al revertir todo → 0/1 (caché).
- **Stems en CPU**: 60 s estéreo 44,1 kHz por `separate_array` (bucle de la app, tramos de 7 s) con un HTDemucs de pesos aleatorios (mismo cómputo; el host de pesos está bloqueado): **35,0 s** en 4 hilos de CPU (12 tramos).

## Pendiente (PC del usuario)

- `claude` real + `studio_get_project` desde la consola; stems 1 min < 60 s en la RTX 4050 con los pesos reales; comparativa de halos Rápido vs Alta calidad en un clip real con fondo colorido.

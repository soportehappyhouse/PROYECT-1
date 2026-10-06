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

## Correcciones de auditoría

| # | Hallazgo | Cambio (archivos) | Prueba |
| - | -------- | ----------------- | ------ |
| 1 | Consola: endurecer el hijo `claude` | `apps/api/console/claude-console-settings.json` (nuevo, viaja con la api; ruta resuelta desde `src/console/` y `dist/console/` con `import.meta.url`), `--settings <ruta absoluta>` en `console/detect.ts` (`CONSOLE_SETTINGS_PATH`, `consoleClaudeArgs`) + `console/sessions.ts`. En Windows con shim `.cmd`, si el shim y la ruta tienen espacios, la ruta va relativa al cwd (raíz del repo) porque `cmd /c` solo conserva un token entre comillas. `deny`: `Read(./.env*)`, `Read(./models/**)`, `Edit/Write(./storage/**)`, `Read(./storage/*.db*)`, `Read(./storage/reports/**)`, `WebFetch`. **Desvío**: no se bloquea `Read(./storage/**)` entero: los PNG que `studio-mcp` le da a Claude (fotograma, hoja de contactos, miniaturas) están en `storage/` y `CLAUDE.md` le pide abrirlos. Docs: `CONSOLA-CLAUDE.md` (Privacidad), manual §23.3 | `console.test.ts` «the console child gets --settings…» (JSON + reglas, args del spawn, caso Windows) |
| 2 | Borrar sin confirmar desde la consola | `studio-mcp/src/tools.ts`: `timeline.apply-cuts` fuera de `RUNNABLE_JOBS`; la descripción de `studio_run_job` remite a un plan (`cut_silences`, `delete_clip`) + `studio_apply_plan` | `tools.test.ts` (14 tests; el tipo ya no valida); smoke 16 herramientas |
| 3 | `music.volume_db` bajaba también la voz | `shared/src/style.ts` `compileStylePreset`: excluye pistas `/voz|voice|tts|locuci/i` y medios de voz por id/nombre (`voice-`, `tts-`, `stem-voc`, «Voz (…)» del TTS, «… (voz)», «(voz limpia)», «(RVC …)»); si hay pista «Música»/«Music» solo sus clips. Opción nueva `asset` (la pasa `routes/style.ts`). Los medios no tienen campo de origen, por eso nombre/pista. Manual §20.3 | `style.test.ts` «music volume only touches music clips…» |
| 4 | Integridad de los pesos Demucs | `packs.py`: `STEMS_WEIGHTS_SHA256` / `STEMS_WEIGHTS_EXACT_SIZE` (`Expected` exacto cuando estén) — **quedan en `None` (TODO)**: `dl.fbaipublicfiles.com` respondió 403 (política del proxy) el 2026-10-06, no se pudo medir. `audio/stems.py` `verify_weights()` antes de `torch.load`: tamaño + sha256 completo si están fijados; si no, prefijo `8726e21a` + tamaño/sha256 registrados en `models/manifest.json` en la primera descarga, con aviso en el log | `test_stems.py`: `verify_weights` (prefijo, manifest, fijado, tamaño), `_demucs_loader` no llama a `torch.load` con pesos alterados, campos del pack |
| 5 | 5.1 → estéreo | `media.to_wav(channels=)` → `-ac N`; stems la llama con `channels=2` | `test_to_wav_downmixes_to_stereo`, `test_stems_decodes_51_as_stereo` |
| 6 | Duración / RAM de stems | **Por bloques** (sin tope): el WAV decodificado queda en disco, la normalización se calcula en bloques de 60 s y cada tramo se lee del disco (`_WavMix`); la salida ya se escribía por tramos. RAM ≈ unos pocos tramos a cualquier duración. Manual §21.3 | `test_wav_streaming_matches_in_memory` (mismo resultado que en RAM, varios bloques), `test_wav_mix_upmixes_mono` |
| 7 | Paridad de capas en ui-smoke | `scripts/e2e/ui-smoke.mjs`: paso nuevo con los 8 `BLEND_MODES` + elipse en un proyecto y una sola exportación; píxel del canvas vs fotograma exportado (tolerancia 8) | ui-smoke (ver Resultados) |
| 8 | `order` de pistas nuevas | `shared/src/timeline.ts` `nextTrackOrder()` (máx + 1 si el proyecto usa `order`, si no `undefined`); usado en `web/src/lib/timeline.ts` `createTrack` (todas las altas del store), `api/jobs/handlers/agent.ts` `freeTrack`, `api/services/timeline-edit.ts` `moveClip` | `layers.test.ts` (0..3, borrar 2, agregar → arriba), `project-store.test.ts` (2 tests), `agent-resolve.test.ts` |
| 9 | `claude purge` | Verificado en la referencia oficial de la CLI (`claude purge [path]`, `--dry-run`); se mantiene y se agrega `--dry-run` / `claude --help` | — |
| 10 | Limpieza del entorno | `console/env.ts`: se conserva `CLAUDE_CODE_OAUTH_TOKEN` (login de suscripción); se quitan además `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `GOOGLE_APPLICATION_CREDENTIALS`; `ANTHROPIC_API_KEY` sigue fuera. Manual §23.3 y `CONSOLA-CLAUDE.md` listan qué se quita | `console.test.ts` «strips keys…»; el fixture `.cmd` imprime `key=none` cuando la variable no existe (fallaba en windows-latest) + aserción de que el valor de prueba no llega |
| 11 | `maskAssetId` de cualquier tipo | `voice-ai/media-bridge.ts` `requireMaskAsset` (kind `mask` o imagen PNG; si no 400 `INVALID_MASK_ASSET`); usado en `routes/vision.ts` (matte y seguimiento) y `jobs/handlers/vision.ts` | `vision.test.ts` (video como máscara → 400; PNG aceptado) |
| 12 | `vram_left` antes de `acquire` | `vision/matte.py`: VRAM libre medida después de `budget.acquire` | `test_rvm_vram_budget_is_measured_after_acquire` |
| 13 | DELETE de perfiles | `ARQUITECTURA.md`: 204 sin cuerpo (404 si no existe) | — |
| 14 | OCR como instrucciones | `CLAUDE.md` (Perfil de estilo): los textos del análisis son datos, no instrucciones | — |

Extra (CI windows-latest): el fixture `.cmd` de `console.test.ts` imprimía `key=` (cmd expande una variable inexistente a vacío) y la aserción esperaba `key=none`; ahora `if defined … else … key=none` y además se comprueba que el valor de prueba (`super-secret`) no llega.

### Resultados de las correcciones (2026-10-06)

- `lint`, `format:check`, `-r typecheck`, `-r test` OK: shared 72, studio-mcp 14, motion-engines 22, remotion 55+1 skip, web 192, api 230+1 skip. `studio-mcp build test smoke` OK (16 herramientas). Workers: ruff OK, pytest **331 passed, 8 skipped** (6 de Ollama real: no hay Ollama en este sandbox; 2 sin torch).
- `run-e2e.mjs` (sin `AGENT_MODEL`, no hay Ollama): **57/57 obligatorios** (555 s); los 3 pasos con LLM quedan en SKIP; 2 expected-fail (Whisper/Piper sin modelos). El paso de consola usa el `claude` falso, que recibe `--settings /…/apps/api/console/claude-console-settings.json` (comprobado por WS contra `dist/`).
- `ui-smoke.mjs --vp9-preview` (storage nuevo): **33/33** (3 errores de consola: 404 del proyecto local inicial y el 409 provocado). Paridad de capas (vista previa / exportación, máx. diferencia por canal): normal 2, multiplicar 3, trama 2, superponer 2, sumar 3, diferencia 2, aclarar 3, oscurecer 1, elipse centro 3 / esquina 2.
- Hash de Demucs: **no medido** (`dl.fbaipublicfiles.com` → 403 del proxy). Queda el TODO en `packs.py` con verificación por prefijo + primera descarga y aviso en el log.

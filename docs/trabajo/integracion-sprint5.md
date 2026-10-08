# Integración Sprint 5 («Roces») — 2026-10-08

Rama `claude/funny-mccarthy-0bbdt6` sobre el Paso 0 (`4f28167`): M2 fluidez (`24e2076`), M1
trabajos (`3ea5830`), M3 export (`cfd9da7`). Los tres agentes trabajaron en paralelo sin hablarse;
esta integración resolvió los pedidos cruzados, revisó las costuras, corrió todo desde cero y
completó la documentación.

## Procedimiento

Sandbox Linux (4 vCPU, sin GPU). El disco estaba al 100 % (17 GB de corridas viejas en el
scratchpad): se borraron antes de empezar. Stack real con `STORAGE_DIR` y `MODELS_DIR` nuevos por
corrida: api `:3001` (`node dist/index.js`, `REMOTION_BROWSER_EXECUTABLE` = Chrome Headless Shell de
Playwright en `/opt/pw-browsers`, `STUDIO_CLAUDE_BIN` = el `claude` falso de siempre, que contesta
`--version`/`auth` y hace eco), workers `:8001` con `scripts/e2e/workers-with-mocks.py`, web
`next build` + `next start :3000`, Playwright Chromium. Sin Ollama, Whisper, Piper reales ni Hugging
Face: esos pasos quedan en SKIP o expected-fail.

```bash
pnpm lint && pnpm format:check && pnpm -r typecheck && pnpm -r build && pnpm -r test
pnpm --filter @studio/studio-mcp smoke
cd apps/workers && .venv/bin/python -m ruff check . && .venv/bin/python -m ruff format --check . \
  && .venv/bin/python -m ruff check --config pyproject.toml ../../tools && .venv/bin/python -m pytest -q
.venv/bin/python -m pytest -q -p no:randomly                               # orden de archivos
.venv/bin/python -m pytest -q -p no:randomly $(ls tests/test_*.py | sort -r)   # orden inverso
python scripts/agent/validate-dataset.py
node scripts/e2e/run-e2e.mjs --api http://127.0.0.1:3001 --storage <storage> --work <work>   # SIN --skip-motion
# storage nuevo + workers con STUDIO_MOCK_DENOISE=0:
node scripts/e2e/ui-smoke.mjs --web http://127.0.0.1:3000 --api http://127.0.0.1:3001 --media <carpeta> \
  --vp9-preview --shots <scratch> --playwright /opt/node22/lib/node_modules/playwright/index.mjs
```

Ojo al reiniciar el stack: `npx next start` deja un `next-server` hijo vivo si solo se mata el
padre; con el `.next` recompilado por debajo, el viejo sigue en el puerto 3000 y el ui-smoke ve un
dashboard roto (la primera corrida de ui-smoke de esta integración, 44/56, fue eso y no un bug).

## Resultados

- **Desde cero**: `lint`, `format:check`, `-r typecheck`, `-r build` OK; `-r test`: shared 154, studio-mcp 19, motion-engines 22, remotion 55 + 1 skip, web 284, api 329 + 1 skip (863).
  `studio-mcp smoke`: 18 herramientas. Workers: ruff OK (también `tools/`), pytest **492 passed, 9 skipped**;
  igual en orden de archivos (`-p no:randomly`) y en orden inverso (antes del arreglo 11 fallaba
  `test_plan_with_api_json_summary_uses_fewshot_and_env_temperature`). `validate-dataset.py`: OK.
- **`run-e2e.mjs`** (sin `--skip-motion`, storage nuevo): **82/82 obligatorios** (466 s), con los
  10 pasos «sprint5» (1 de M2, 4 de M1, 4 de M3; «cancelar `vision.reframe` llega al worker» M1 lo
  marcó opcional porque el reencuadre falso puede terminar antes del cancelar: pasó, job y tarea
  `canceled`); 3 SKIP (`--hw`, descarga de Hugging Face, ruta LLM sin Ollama) y 2 expected-fail
  (Whisper y Piper sin modelos). El paso de la Consola de sprint 3b (WS de ida y vuelta) pasa con
  el `claude` falso correcto («echo ok», reuso del token → 4401, «9.9.9 (Claude Code)»): el FAIL
  que informó M1 era de su `claude` falso, que no contestaba `--version`.
- **`ui-smoke.mjs --vp9-preview`** (storage nuevo, `STUDIO_MOCK_DENOISE=0`): **56/56** (38 de sprints anteriores + 18 de sprint 5).
  Corridas previas: 55/56 (falló «Trabajos muestra 3/20…»: el job se canceló en la api pero la
  fila «cancelado» no llegó en 10 s por SSE; sola pasa siempre, ver Descubierto) y antes 44/56 por
  el arreglo 12. Errores de consola del navegador: los esperados (404 del proyecto local inicial y
  el 409 `PACK_REQUIRED` provocado a propósito).
- **Seguridad**: búsqueda de secretos en el diff del sprint: vacía; `.env.example` con todas las
  claves vacías (`*_API_KEY=`), sin variables nuevas (las de Sprint 5 son del mock e2e).

## Bugs entre módulos encontrados y arreglados

| # | Hallazgo | Cambio | Prueba |
| - | -------- | ------ | ------ |
| 1 | **`useAiAvailability` solo en 4 lugares** (pedido M1 → M2): Voz, Estilo, Reencuadrar y Cambiar cara seguían habilitados con la IA local apagada (encolaban y fallaban con un aviso suelto) | `VoicePanel` (TTS Piper/Chatterbox, descargas de voces, Limpiar voz, Separar audio, RVC; ElevenLabs/OpenAI no dependen de los workers), `SubtitlesPanel` («Transcribir clip»), `StylePanel` (Analizar = workers, Deducir = Ollama), `ReframePanel`, `FaceSwapSection` | ui-smoke «workers apagados» (más estricto, ver 2) |
| 2 | **El motivo no se veía en botones de texto** (M1 ↔ M2): `Button` solo armaba el tooltip con `tip` o etiqueta, así que `disabledReason` en «Transcribir clip», «Generar y añadir al cursor»… no aparecía nunca | `components/ui/button.tsx`: sin tooltip propio, el motivo es el tooltip | `tooltips.test.tsx` (nuevo caso); ui-smoke exige Transcribir deshabilitado **con** `start.cmd` en el tooltip |
| 3 | **`start.ps1` en Voz** (M1 → M2): «Los workers de voz no están corriendo: inicia Studio con start.ps1…» | `downloadErrorMessage` usa el texto de la api (`start.cmd`) o `WORKERS_DOWN_ES` | `feedback.test.tsx` (ahora `start.cmd`) |
| 4 | **«Ajustes → Paquetes»** en 5 mensajes (M1 → M3, integración) | `resolve.ts`, `routes/style.ts`, workers `packs.py`, `ollama_client.py`, `style/infer.py` → «Ajustes → Paquetes de IA» | `agent-resolve.test.ts`, `style.test.ts` |
| 5 | **Exportar sin ítems para la ETA** (M1 → M3): solo `stage_es`, la ETA caía a la fórmula por `p` | `exportProject` pasa `done/total` de bloques (+1 paso de audio y unión), el handler los manda con `unit:"blocks"` | `segment-cache.integration.test.ts` (aserción nueva) |
| 6 | **La música de la Biblioteca caía en la pista de la voz y sin rol** (M3 → M2): `addAssetClip` usa la primera pista de audio; sin `role` el ducking automático no la bajaba | `addAssetClip(asset, {role})`: pista con ese rol, o vacía sin rol, o una nueva; pone `role` en el mismo paso de deshacer; `LibraryPanel` pasa `libraryRole(kind)` | `project-store.test.ts` |
| 7 | **«Bajar la música cuando hay voz» no persistía** (M3 → M2): estado local del panel | `project-store.setAudioMix` (guarda `project.audioMix`, sin deshacer como el resto de ajustes); Exportar lo lee/escribe ahí | `project-store.test.ts` |
| 8 | **La pregunta de encuadre salía dos veces** en el Asistente (M3 → M1): la línea `unresolved` y los botones de `PlanChoices` | `AssistantPanel` filtra la línea si la misma pregunta está en `choices` | `export-sprint5.test.tsx` (nuevo) |
| 9 | **Tests web al azar con la IA «apagada»**: el `service-status-store` sondea `/api/health`; en jsdom falla y marca la api caída a mitad de un test (rompió `feedback.test.tsx` al aplicar 1) | `test/setup.ts` contesta `/api/health` como «todo arriba»; los tests que necesitan otro estado espían `fetch` | suite web |
| 10 | **Layout nuevo vs. ui-smoke viejo** (M2 ↔ sprints anteriores): la Consola Claude ahora comparte grupo con la Línea de tiempo y el layout se guarda en la api; tras «Deducir con Consola Claude» las recargas abrían en la Consola y 11 pasos esperaban la línea de tiempo 60 s | helper `timelineReady()` (elige la pestaña si hace falta) en los 10 lugares; el tooltip de la tijera ahora es el de `TIPS.split` («Cortar el clip en el cursor (S)») | ui-smoke completo |
| 11 | **pytest dependiente del orden** (anterior al sprint, lo informó M1): `few_shot_pool()` (`lru_cache`) quedaba con el dataset temporal de 4 ejemplos de `test_agent_eval.py` | fixture `autouse` en `conftest.py` que limpia los caches del planner antes y después de cada test (sin skip) | pytest en orden de archivos y en orden inverso |
| 12 | **ui-smoke «Proyectos» no repetible** (M2): los nombres fijos «S5 UI uno/dos» se acumulaban entre corridas sobre el mismo storage | sufijo único por corrida | ui-smoke |

Además: el planner dice que sin destino claro el export es `reels-tiktok` (pedido de M3; decisión
9:16 principal), y `POST /api/system/reveal` compara con `realpath` (seguridad, abajo).

Costuras revisadas sin cambios: `snapping` en `settings-store` y la semántica nueva de `S`/`Supr`
(M2) — ningún código ni test de M1/M3 usaba el `snapping` viejo ni dependía de que `Supr` borrara
un solo clip; `ExportPanel.tsx:590` (`SocialReview lastExport`) ya estaba tipado por M3 (`tsc`
limpio); `ServiceBanner`/`JobsIndicator` (M1) dentro de `Dashboard.tsx` (M2) en los bloques
acordados; `PlanChoices` (M3) en `AssistantPanel` (M1); `resolvePlanForRecord` en las 4 llamadas
(Asistente, plan editado, Consola, Perfil de estilo); `ExportPanel` lee `inOut` de M2;
`tip="presetDup"`/`"presetDel"` (M3) y `tip="jobCancel"` (M1) existen en `TIPS`.

## Correcciones de auditoría

Auditoría independiente posterior a la integración (13 hallazgos). Dos commits: ALTA + MEDIA
(D1–D8) y BAJA + documentación (D9–D13).

| # | Prioridad | Hallazgo | Cambio | Prueba |
| - | --------- | -------- | ------ | ------ |
| D1 | ALTA | Cancelar `vision.matte` (RVM) dejaba vivo el subproceso GPL con la VRAM tomada (`TaskCanceled` dentro de `on_event`, sin `finally`; `on_cancel_kill` sin usar) | `gpl.run_rvm`: grupo propio (`new_group_kwargs`), `on_cancel_kill(proc)` al arrancar y `try/finally: kill_process_tree` + cerrar tuberías + `join` del lector; SAM (ffmpeg de fotogramas) pasa de `subprocess.run(timeout=3600)` a `Popen` con el mismo gancho; `frames.py` (lector y `AlphaWriter`) registra el gancho. `kill_process_tree` ya no hace `killpg` de un grupo compartido (habría matado a los workers) y espera la salida | `test_cancel_kill.py`: árbol hijo + nieto, sin grupo propio, gancho con hijo largo falso, `_rvm` cancelado por gancho y por progreso (el subproceso falso termina) |
| D2 | MEDIA | `TaskCanceled` caía en `except Exception` de Whisper y htdemucs → descarga del modelo CUDA, `budget.failed()` y «usando CPU» falso | `except TaskCanceled: raise` antes del genérico (`stt/engine.py`, `audio/stems.py`) | `test_transcribe_cancel.py`, `test_stems.py` (sin reintento en CPU, modelo y residente intactos) |
| D3 | MEDIA | ETA optimista en exportaciones con bloques en caché (contaban como renderizados en 0 s) | `JobProgressDetail.cached`; `exportProject` informa los bloques salteados; `estimateEtaS` divide por los reales y no da ETA hasta el primer bloque real; espejo `_eta(..., cached)` en Python | `job-progress.test.ts`, `test_tasks_cancel.py`, `segment-cache.integration.test.ts` (2.ª exportación: `cached = total`, `eta_s` null) |
| D4 | MEDIA | `Espacio` no «apretaba» botones en diálogos modales (solo se excluía Ajustes) | `useSpaceDoesNotClickButtons` sale si `modalDialogOpen()` | `hotkeys-scope.test.tsx` |
| D5 | MEDIA | `Mayús+Supr` en la pista principal solo corría esa pista y los subtítulos | Ripple con sincronía: `rippleDelete(..., {syncTrackId})` corta el tramo de todas las pistas sin bloquear (corre lo posterior, recorta lo que cruza, quita lo que queda entero adentro), un paso de deshacer; manual §4/§5 | `timeline-ripple.test.ts` (2 casos), `selection.test.ts` |
| D6 | MEDIA | `pagehide` medía `string.length` y se volvía a serializar el proyecto en cada cambio; cuota de `localStorage` llena sin aviso | `serializeProject` (caché por identidad, `Blob.size`) para `localStorage`, el debounce y `pagehide`; `writeRaw` distingue cuota; un aviso por sesión | `project-sync.test.ts` (bytes UTF-8, una sola serialización, aviso una vez, `SecurityError` callado) |
| D7 | MEDIA | «Bajar la música» sin pistas de Voz/Música no decía nada; música importada quedaba «Otro» | `inferTrackRole`: pista de audio llamada (pista o todos sus archivos) «música/music/fondo» → `music`; `duckingGapEs` en Exportar → Sonido; la tarjeta del resultado dice «Música sin bajar» si no hubo ducking | `audio-mix.test.ts`, `export-sprint5.test.tsx` |
| D8 | MEDIA | «Cancelando…» no salía por SSE; reconexión del SSE a los 20 s (el «Descubierto» de la fila cancelada) | `queue.cancel` emite el evento; `use-job-events` reintenta a 2 s con espera doble hasta 10 s y vuelve a 2 s al abrir | `queue.test.ts`, `use-job-events.test.ts` (EventSource falso, relojes falsos) |
| D9 | BAJA | `I`/`O` podían dejar un tramo de largo cero; `O` antes de `I` ponía la entrada en 0; el tramo no seguía al ripple | `markIn`/`markOut` avisan y conservan el tramo anterior; `rippleInOut` en `Mayús+Supr`, `Q`/`W` y cerrar huecos de la pista principal; se limpia al cargar proyecto (ya ocurría, ahora con prueba) | `selection.test.ts` |
| D10 | BAJA | `/transcribe` registraba el evento de cancelar después de `require_module`; un `TaskCanceled` daba 500 con traceback; `GET /transcribe/progress/{job_id}` sin uso (ni api ni web) | Evento antes de cualquier chequeo; manejador `TaskCanceled` en `main.py` → **499** `{detail:"Cancelado", code:"TASK_CANCELED"}`; ruta de progreso borrada (`ARQUITECTURA.md`) | `test_transcribe_cancel.py` |
| D11 | BAJA | Un job que terminaba mientras se cancelaba quedaba «cancelado» con su archivo escrito | Si el handler terminó, el job queda `succeeded` (y el registro lo anota) | `queue.test.ts` (`project.export` que ignora el abort) |
| D12 | BAJA | «Abrir carpeta» mostraba la ruta sin resolver | `revealCommand(platform, realAbs)`; argv sigue siendo un elemento; con coma en la ruta, Explorer abre la carpeta sin `/select` (limitación de Explorer, comentado en el código) | `system-reveal.test.ts` |
| D13 | BAJA | Documentación | Manual §4/§5 (ripple con sincronía, I/O), §10 (choque de `Ctrl+Mayús+Supr` con «Borrar datos de navegación» y alternativa; tabla de atajos revisada contra `HOTKEYS`: 32/32), §17.9 y Flujo de música (rol por nombre, aviso); `index.html` y PDF regenerados; `ARQUITECTURA.md` | — |

## Hallazgos de la auditoría de fluidez (`auditoria-fluidez.md`)

| Estado | Hallazgos |
| ------ | --------- |
| Cerrados (17) | H1 Evaluar modelos (progreso por ítem, ETA, Rápida/Completa, cancelar hasta Ollama, `PACK_REQUIRED`), H2 aviso con el error real, H3 sin toasts al recargar, H4 una franja + botones deshabilitados con motivo + `start.cmd`, H5 atajos tras clicar la regla, H6 Reels desde horizontal (plan con `reframe` o pregunta; 409 sin elección), H7 Proyectos, H8 Asistente y Exportar a 1366 px, H9 ripple, H10 selección múltiple, H15 motion cancelado se quita, H17 Exportar «¿Dónde lo vas a publicar?» + resultado, H21 tooltips que explican (51 claves), H22 `pagehide`, H23 etiquetas por op, H24 aviso de CPU una vez, H26 estados vacíos y lienzo al primer video |
| Parciales (2) | H18: contador «Pensando… 12 s» + Cancelar hechos; reabrir el último borrador tras recargar, no. H19: `start.cmd` y «Paquetes de IA» unificados; quedan voces «Espana/Mexico», columna «Lo usa» y el glosario único (Sprint 6) |
| Abiertos (7, Sprint 6) | H11 conservar `words` al corregir, H12 Motion en español, H13 editar motion en Propiedades, H14 sistema de diseño, H16 medios generados/duplicados, H20 selector de voz único, H25 deshacer de ajustes/estilo |

## Seguridad (pasada rápida)

- Secretos: nada en el diff; `.env.example` sin valores en las claves.
- Rutas nuevas: `PATCH/POST duplicate/DELETE /api/projects/:id` (zod estricto, ids solo como
  parámetro de SQL preparado, 404 `PROJECT_NOT_FOUND`; borrar no toca archivos),
  `POST /api/agent/plans/:id/choose` (zod, registro por id), cancelar (`/api/jobs/:id/cancel`, 409
  `JOB_NOT_CANCELLABLE`; workers: el id solo busca en el diccionario de la cola, 404
  `TASK_NOT_FOUND`; `/transcribe/cancel` solo marca un evento).
- `POST /api/system/reveal`: solo rutas relativas bajo `storage/exports/` (rechaza absolutas,
  `C:`, `..`, vacías) y, nuevo, `realpath` del archivo bajo `realpath(exports)` (un link adentro que
  apunte afuera → 400; test, salvo en Windows); `explorer.exe` con `/select,<abs>` como **un** argv,
  `spawn` sin shell, código de salida ignorado.

## Desvíos

- «cancelar `vision.reframe` llega al worker» sigue opcional en el e2e (decisión de M1).
- El paso de ui-smoke «Trabajos…» acepta que la fila cancelada llegue con «Recargar trabajos» si el
  SSE no la trajo en 10 s, y lo informa (`via`).
- `index.html` del manual: secciones cambiadas regeneradas con el mismo renderizador `marked` de
  siempre e insertadas a mano (el resto del archivo intacto), índice lateral regenerado; PDF con
  Playwright Chromium forzando las imágenes `loading="lazy"`: 77 páginas, las 6 capturas.
- H19 no se cerró entero (glosario y nombres de voces quedan para Sprint 6).

## Solo medible en la PC del usuario

- Que Ollama corte la generación al cancelar «Evaluar modelos» o «Pensando…» (GPU baja de uso en
  < 3 s); duración real de **Rápida** (meta ≤ 3 min con qwen3:8b en la RTX 4050) y **Completa**;
  cancelar una transcripción larga en CUDA y que la siguiente vuelva a usar la GPU; `taskkill /T /F`
  matando el árbol de un subproceso.
- `Ctrl+O` en Edge/Chrome de Windows (abre Proyectos, no «Abrir archivo»); `Ctrl+Alt+N` con AltGr;
  escala 125 % real en 1366 px (probado con viewport 1093×700); arrastre con 50+ clips; `pagehide`
  con keepalive al cerrar Edge.
- Tiempo extra de las 2 pasadas de `loudnorm` en un video de 10 min; «Abrir carpeta» con rutas con
  espacios y tildes en el Explorador; sonoridad medida por Instagram/TikTok tras subir; que el
  ducking calibrado suene natural con voz real.

## Descubierto

- **Fila cancelada sin SSE**: en la corrida completa de ui-smoke, una vez la fila «cancelado» no
  llegó en 10 s tras recargar en el paso anterior (la api ya decía `canceled`). Sola pasa siempre;
  revisar la reconexión del `EventSource` de `use-job-events` tras un `page.goto` con `route()`.
  **Corregido en D8** (reintento a 2 s en lugar de 20 s, «Cancelando…» por SSE).
- **`GET /api/projects` (rendimiento)**: `?view=summary` arma la lista leyendo y validando cada
  proyecto completo (`list()` + `get(id)` con todas las pistas y subtítulos) y busca los medios uno
  por uno para la miniatura; con decenas de proyectos largos el diálogo Proyectos tarda. Sprint 6:
  columnas de resumen en la tabla `projects` (duración, cantidad de clips, primer `assetId`,
  `updatedAt`) actualizadas al guardar, y una sola consulta.
- El `next start` del sandbox: matar solo el padre deja el servidor viejo (ver Procedimiento).

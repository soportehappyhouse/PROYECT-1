# Integración Sprint 6 («Guion y sistema de diseño») — 2026-10-18

Rama `claude/funny-mccarthy-0bbdt6` sobre el Paso 0 (`0f7b6e5`): M3 sugerencias (`3c72802`), M1
guion (`911eb8d`), M2 sistema de diseño (`9c5eb77`). Los tres agentes trabajaron en paralelo sobre
el mismo árbol sin hablarse; esta integración resolvió los pedidos cruzados, buscó las costuras,
corrió todo desde cero, midió los criterios C1–C3 y completó la documentación.

Commits de la integración: `8f72924` (pedidos cruzados), `6f08584` (costuras), `e0afdd5` (la
vista previa de «Dejalo en» dice lo que da aplicar), `62b8efb` (costuras de la ui-smoke
completa), `24d7dbf` (hallazgos del mapa de calor), y el de documentación y panel.

## Procedimiento

Sandbox Linux (4 vCPU, sin GPU). Stack real con `STORAGE_DIR` y `MODELS_DIR` nuevos **por
corrida**: api `:3001` (`node dist/index.js`, `REMOTION_BROWSER_EXECUTABLE` = Chrome Headless
Shell de Playwright en `/opt/pw-browsers`, `STUDIO_CLAUDE_BIN` = un `claude` falso que contesta
`--version` «9.9.9 (Claude Code)», `auth status` y hace eco), workers `:8001` con
`scripts/e2e/workers-with-mocks.py` (para ui-smoke y el mapa de calor con `STUDIO_MOCK_DENOISE=0`),
web `next build` + `next start :3000`, Playwright Chromium 1366×820. Sin Ollama, Whisper, Piper
reales ni Hugging Face: esos pasos quedan en SKIP o expected-fail.

```bash
npm i -g pnpm@12.9.1                       # corepack roto en el sandbox
rm -rf node_modules apps/*/node_modules packages/*/node_modules apps/*/dist packages/*/dist apps/web/.next
pnpm install --frozen-lockfile
pnpm -r lint && pnpm lint && npx prettier --check . && pnpm -r typecheck && pnpm -r build && pnpm test
pnpm --filter @studio/studio-mcp smoke
cd apps/workers && .venv/bin/python -m ruff check . && .venv/bin/python -m ruff format --check . \
  && .venv/bin/python -m ruff check --config pyproject.toml ../../tools
.venv/bin/python -m pytest -q                                                   # normal
.venv/bin/python -m pytest -q -p no:randomly $(ls tests/test_*.py | sort -r)    # inverso
.venv/bin/python -m pytest -q -p no:randomly $(ls tests/test_*.py | shuf)       # aleatorio
apps/workers/.venv/bin/python scripts/agent/validate-dataset.py
node scripts/e2e/run-e2e.mjs --api http://127.0.0.1:3001 --storage <s> --work <w>   # SIN --skip-motion
node scripts/e2e/design-check.mjs --api http://127.0.0.1:3001 --aspect 9:16   # y --aspect 16:9
# storage nuevo + STUDIO_MOCK_DENOISE=0:
node scripts/e2e/ui-smoke.mjs --web http://127.0.0.1:3000 --api http://127.0.0.1:3001 --media <m> \
  --vp9-preview --ux-metrics --shots <s> --playwright /opt/node22/lib/node_modules/playwright/index.mjs
# storage nuevo: mapa de calor (9 flujos del protocolo, script de Playwright de la integración)
```

Ojo en el sandbox: `pnpm remove --offline` (para sacar `@remotion/google-fonts`) dejó el lockfile
bien pero **podó 34 paquetes del almacén virtual** (`jsdom` entre ellos) y `pnpm install
--frozen-lockfile` decía «up to date» sin reponerlos: hubo que borrar `node_modules` y reinstalar.
Y `pkill -f next-server` dentro de un `bash -c` que contiene esa palabra mata al propio shell.

## Resultados (corrida final desde cero)

| Suite | Resultado |
| ----- | --------- |
| `npm i -g pnpm@12.9.1` + `pnpm install --frozen-lockfile` (sin `node_modules`, `dist` ni `.next`) | OK |
| `pnpm -r lint` · `pnpm lint` (eslint) · `prettier --check .` · `pnpm -r typecheck` · `pnpm -r build` | OK |
| `pnpm -r test` | **1113 + 2 omitidos**: shared 251 · web 332 · motion-engines 24 · studio-mcp 21 · remotion 91 · api 394 + 2 |
| `studio-mcp smoke` | 19 herramientas |
| workers `ruff check` + `ruff format --check` (+ `tools/`) | OK |
| `pytest` normal · orden inverso · orden aleatorio (`shuf`) | **523 passed, 9 skipped** las tres veces |
| `validate-dataset.py` | OK (dataset válido) |
| `run-e2e.mjs` (sin `--skip-motion`, storage nuevo) | **91/91 obligatorios** (574 s); 3 SKIP (`--hw`, descarga de Hugging Face, sin `AGENT_MODEL`), 2 expected-fail (Whisper y Piper sin modelos), 1 opcional PASS; los 9 pasos `sprint6` en verde |
| `design-check.mjs --aspect 9:16` · `--aspect 16:9` | **10/10 reglas** en los dos; caja del texto en zona segura 5/5 fotogramas (≈ 1 línea por página en 9:16, ≤ 2 en 16:9) |
| `ui-smoke.mjs --vp9-preview --ux-metrics` (storage nuevo, `STUDIO_MOCK_DENOISE=0`) | **63/63** |
| `--ux-metrics` | `{"english":{"Propiedades":[],"Voz":[],"Motion":[]},"iconButtonsWithoutTip":[],"uiFontFamilies":["-apple-system","ui-monospace"],"firstExportClicks":5,"pass":true}` |
| Mapa de calor (9 flujos, storage nuevo) | promedio **3,90 / 5** (abajo) |

Corridas intermedias que encontraron costuras: run-e2e 89/91 (los 2 pasos de M1 cuando la api
empezó a exigir `confirm`; ver costuras 1 y 2), ui-smoke 55/63 → 60/63 → 61/63 (costuras 4–8).
Manual: `index.html` con las secciones §8, §11, §12 regeneradas y §28–§30 nuevas (mismo
renderizador `marked`, índice lateral regenerado) y PDF con Playwright Chromium: 80 páginas, las 6
capturas.

## Pedidos cruzados (17 de los informes de módulo + 1 de la consigna)

| # | Pedido | Origen | Resolución |
| - | ------ | ------ | ---------- |
| 1 | Exportar renderiza sola los gráficos Motion sin render y avisa `DESIGN_AUTOFIXED` | M2 #1 | **Hecho.** `services/export/motion-prerender.ts`: `pendingMotionClips` + `renderPendingMotion` (un `motion.render` por clip con `target`, carril motion, cancelar corta el render); `findExportBlockers(…, {autoRenderMotion})` en la ruta, el job y el op `export` del Asistente; solo bloquea un medio borrado o una spec que los motores rechazan (`motionSpecProblems`). `checkDesignWithFix` en el aspecto del preset → `warnings: ["DESIGN_AUTOFIXED"]` + `designFixed`; `motionRendered`; la web los muestra en el resultado. Tests: `export-motion-prerender.test.ts` (3), `api.test.ts` ajustado |
| 2 | `confirm:true` del resolvedor de `fit_duration`/`delete_words` también fuera del panel Guion | M1 #2 | **Hecho.** `opNeedsSeparateConfirm(op, resolved)` (shared) en `/api/agent/apply` (409 `CONFIRM_REQUIRED`), en la web (`isDestructive`/`destructiveIndexes` con `record.resolved`, «Confirmar recorte», arranca destildada) y en studio-mcp (`needsConfirmation`). El Guion confirma con su casilla; si el recorte supera el 20 % sin oraciones abre el Asistente. Tests: `agent-script-ops.test.ts` (409 y 202), `sprint3.test.tsx` |
| 3 | `use-job-events` sin toasts para `suggest.analyze`; «Analizando N medios…» en `JobsIndicator` | M3 #4, #5 | **Hecho.** `isBackgroundJobType` (tampoco el toast de falla); el indicador no los cuenta como trabajos del usuario y muestra la línea agregada; se quitó el «marcar como atendido» indirecto de `suggestions-store`. Tests: `suggestions.test.tsx` (indicador, `handleFinished` sin toast) |
| 4 | `cut_silences` con `noise_db` | M3 #2 | **Hecho.** `noise_db: -60..-20` en `CutSilencesOpSchema` (schemas JSON regenerados), handler `op.noise_db ?? -35`, la tarjeta pasa `silence_threshold_db` redondeado |
| 5 | `normalize_loudness` / tope de `set_volume` | M3 #3 | **Diferido a S7**: no es barato. `ClipSchema.volume` ≤ 4 (+12 dB) y el export no tiene ganancia por clip más allá de eso; hace falta subir el rango del clip y su filtro, o un `loudnorm` por clip en el compilador. Hoy el `loudnorm` −14 LUFS del preset de redes completa al exportar |
| 6 | `SUGGESTION_UI_ES` y `SCRIPT_PANEL_TEXTS_ES` a `texts-es.ts` | M1 #3, M3 #1 | **Hecho** (y los `*Tip` duplicados de las tarjetas se borraron: usan `TIPS`) |
| 7 | Claves de tooltip `script*` y de las tarjetas | M1 #1, M3 #1 | **Hecho.** 7 `script*` + `mediaAnalyze` + `assistantStatus`, `consoleCopy`, `consolePaste` (74 claves); `ScriptPanel` y `SuggestionCard` usan `tip=` |
| 8 | `ScriptTranscribeResult` a shared | M1 #3 | **Hecho.** `ScriptTranscribeResultSchema` en `script.ts`; api y web lo importan |
| 9 | `MediaAsset.probeError` | M3 #7 | **Hecho.** El handler `media.probe` guarda la causa (y la limpia al leer bien); la web la usa además de los jobs fallidos. Test `media-probe-error.test.ts` |
| 10 | `ClipView` con nombre legible | M2 #2 | **Hecho.** `MOTION_TEMPLATE_NAMES_ES`/`motionTemplateNameEs` en shared: la línea de tiempo, los renders («Gráfico · Título») y la vista previa («Rótulo — sin renderizar (se renderiza al exportar)») |
| 11 | Quitar `@remotion/google-fonts`, `REMOTION_FONTS`/`fontMode`; `*.ttf binary` | M2 #5, #6 | **Hecho** (también `.otf`/`.woff2`; `.env.example`, manual §8 y §11, `INSTALACION-WINDOWS.md`); la lista de fuentes de la web sale de `BUNDLED_FONT_FAMILIES` |
| 12 | Voces «España/México» con tilde en los workers | M2 #3 | **Hecho** (`piper_catalog.py` + test) |
| 13 | Ajustes para reactivar tipos silenciados | M3 #6 | **Hecho.** Ajustes → Asistente local → «Sugerencias al importar» (apagar el análisis, «Volver a sugerir»). Test |
| 14 | `studio_design_check` + 3 ops en `CLAUDE.md` y en el manual | M2 #7, M1 #4 | **Hecho.** Herramienta de solo lectura (19 herramientas); `studio_run_job` acepta `script.transcribe` (id en la ruta). `CLAUDE.md`: ops, `noise_db`, confirmación de recortes, flujos «Sacá los eh» y «Revisar el diseño». Manual §28–§30 |
| 15 | Mover `KIT_TEXTS_ES` a `texts-es.ts` | M2 #4 | **Diferido** (opcional en el pedido): son textos de una sola pantalla de la web; no los usa la api ni la consola |
| 16 | Tarjeta «Quitar muletillas» | M1 #5 | **Diferido a S7** (costura 6 del contrato): necesita el guion transcripto, que no existe al importar |
| 17 | `jobs/handlers/ai.ts` sin dueño | M1 #6 | Revisado: las 4 líneas de M1 quedan |
| 18 | Borradores de manual, `ARQUITECTURA.md` y `NOTICE.md` (fuentes OFL) | M1, M2, M3 | **Hecho** |

Además: «Medios → Analizar» no existía (las tarjetas y `SUGGESTION_STALE` mandaban ahí): botón
**Analizar** (bombita) en cada video/audio de Media (`POST /api/media/:id/analyze {force}`).

## Costuras encontradas y arregladas

| # | Costura | Módulos | Cambio | Prueba |
| - | ------- | ------- | ------ | ------ |
| 1 | La vista previa de «Dejalo en» no aplicaba el afinado por energía (45,5 s previstos, 45,7 s aplicados) y el afinado movía hasta 60 ms por borde las pausas acortadas | M1 ↔ M1/api | Las pausas acortadas no se afinan (quedan 125 ms por lado, `pause_target_ms`); `computeFit` calcula `to_s` con los mismos cortes que aplicar el plan, replanea una vez si queda arriba de la tolerancia y, si no llega, lo dice (`reached:false` + pregunta) | `script.test.ts` (aplica el plan y compara < 2 ms), `script-words.test.ts`, run-e2e (45,55 previsto = 45,55 aplicado) |
| 2 | El `confirm:true` de M1 no lo exigía nadie (la api, la web y el MCP solo miraban `ALWAYS_CONFIRM_OPS`) | M1 ↔ Asistente/MCP | pedido 2 | run-e2e `delete_words` (409 sin confirmar) |
| 3 | Puerto fijo `:8001` en los pasos de Sprint 5 de run-e2e (M3 tuvo que esquivarlo) | S5 ↔ M3 | `S5_WORKERS` sale de `GET /api/health` (`workers.url`); `--workers` sigue mandando | run-e2e |
| 4 | Medios: con «Analizar» cada fila crecía a 115 px y el medio quedaba fuera del panel (falló el arrastre de la ui-smoke) | integración ↔ S0 | 4 acciones en 2 columnas (63 px) | ui-smoke «drag the video…» |
| 5 | Formulario Motion de M2 (texto del label en `<span>`) rompió el paso de S0 de la ui-smoke | M2 ↔ S0 | selector por el texto del `<span>` | ui-smoke «Motion panel…» |
| 6 | Pestaña «Texto a voz» → «Voces de Studio» (H20) en el paso de Sprint 4 «Revisión para redes» | M2 ↔ S4 | selector | ui-smoke |
| 7 | El paso de S5 «cada botón de ícono…» esperaba 51 claves de TIPS (M2 sumó 12 y dejó el paso roto) | M2 ↔ S5 | cuenta también las claves de texto en dos líneas; 74 | ui-smoke |
| 8 | `--ux-metrics` buscaba un panel en «Paneles» y, si ya estaba abierto, lo cerraba (`(panel cerrado)` según el estado previo) | M2 | solo abre si `aria-checked` ≠ `true` y espera la sección | ui-smoke |
| 9 | Vista previa: «Motion «lower-third» — pendiente de render» (id crudo en inglés) | S0 ↔ M2 | nombre en español + «se renderiza al exportar» | mapa de calor flujo 5 |
| 10 | «Revisar diseño» guardaba con `api.saveProject` suelto (sin estado de guardado ni copia local) | M2 ↔ M1/M3 | `saveProjectNow()` como Guion y Sugerencias | — |
| 11 | Textos duplicados: «Primero agregá un video…» (Guion y Subtítulos), «No hay nada para cortar…», dos avisos de guion desactualizado, tips de tarjetas repetidos en `TIPS` | M1, M2, M3 | `NEED_SPEECH_CLIP_ES`, `SCRIPT_PANEL_TEXTS_ES.nothingToCut`, un solo `SCRIPT_TEXTS_ES.stale`, `TIPS.suggestion*` | — |
| 12 | `GLOSSARY_ES.panels` decía «Medios» y «Voz» y las pestañas «Media» y «Voz y audio» | M2 ↔ layout | glosario = títulos reales; test que los ata | `glossary-panels.test.ts` |
| 13 | Importar desde la vista previa ponía el clip antes del `media.probe`: 5 s por defecto y lienzo 16:9 con un vertical de 10 s (exportaba 5 s y pedía encuadre) | S5 ↔ M3 (probe más lento con el análisis de fondo) | `waitForProbe` (≤ 30 s) antes de `addAssetClip` | `import-wait-probe.test.ts`, mapa de calor flujo 1 |
| 14 | Motion y Silencios seguían diciendo «Renderizalo antes de exportar» | M2 ↔ integración | textos | — |
| 15 | Tooltips que faltaban: estado del asistente, Copiar/Pegar de la Consola, Duplicar/Eliminar preset (`presetDup`/`presetDel` existían sin usarse) | S3/S3b/S5 | `tip=` | mapa de calor flujo 8 |

Costuras revisadas sin cambios: stores de zustand compartidos (`agent-store` lo usan el Guion
—`receivePlan`/`apply`— y Sugerencias —`openPlan`, suscripción a `run.status`—: un `fit` aplicado
desde el Guion recarga las tarjetas, correcto); rutas duplicadas (ninguna: `API_ROUTES` sin valores
repetidos y Fastify no registró dos veces una ruta); `resolve.ts`/`handlers/agent.ts` (M1) y las
ops de M3 (`resolvePlanForRecord` sin cambios); `timeline.ts` (fundidos de M1 + `fontsdir` de M2 en
sus bloques); `SubtitlesPanel.tsx` (bloque de M1 con `fixWords`); `TaskQueue` con prioridad (M3)
y `stt.words` (M1, prioridad usuario); registros globales por proceso (`setScriptDeps`,
`setAssDesign`, `setDesignTokensProvider`) — en la app hay una sola instancia; en tests de un mismo
archivo con dos `makeApp` gana el último (anotado en «Descubierto»).

## Criterios del sprint

| # | Criterio | Medida (sandbox) | Meta | Estado |
| - | -------- | ---------------- | ---- | ------ |
| C1 | 10 muletillas desde el guion | ui-smoke «Sprint 6: 10 muletillas»: **0,43 s** desde abrir el Guion hasta el 10.º corte («Quitar seguras» = 8 cortes + 2 × Supr), subtítulos corridos, un Ctrl+Z deshace un solo gesto | < 60 s | 🟢 (Whisper real: PC) |
| C2 | Subtítulos y títulos pasan las reglas sin tocar nada | `design-check.mjs`: **10/10** en 9:16 y **10/10** en 16:9; píxeles 5/5 adentro de la zona segura. Tras la auditoría (E4): también **10/10 a 3 palabras/s**; a 3,5 palabras/s 9/10 (ver «Correcciones de auditoría») | 10/10 en los dos | 🟢 (habla ≤ 3 palabras/s) |
| C3 | Diseño (panel) | checklist C2 10/10 + mapa de calor **3,90 / 5** (observaciones reproducibles con `scripts/e2e/heatmap-ux.mjs` desde la auditoría) (flujos 2 = 3,8, 5 = 4,0, 6 = 3,6, 8 = 4,0) + `--ux-metrics` `pass:true` (0 inglés, 0 íconos sin tooltip, 2 familias, 5 clics) | ≥ 3,5 y 2/5/6/8 ≥ 3,5 | 🟢 → **panel Diseño 78 %** (3,90 / 5) |
| C4 | Ningún render depende de la red | run-e2e «fuentes sin red» PASS (title-card + animated-captions con la familia pedida), test que prohíbe URLs en `packages/remotion/src`, `@remotion/google-fonts` fuera | 0 pedidos de red | 🟢 |
| C5 | Sugerencias al importar | run-e2e: 2 tarjetas en 7,4 s; un `subtitles.transcribe` arranca sin esperar al análisis; aplicar + deshacer | 2 tarjetas < 15 s | 🟢 |
| C6 | Deuda de funciones | 10 ítems cerrados en el sandbox (abajo) | 5 firmes + P2/P3 | 🟢 |

### Mapa de calor UX (protocolo `protocolo-mapa-calor.md`, 2026-10-18)

Corrida única con storage nuevo, Playwright Chromium 1366×820, los 9 flujos en orden con un script
de la integración que cuenta clics, mide esperas, busca términos de `UI_ENGLISH_DENYLIST` y
botones de ícono sin tooltip en cada panel y en Ajustes, y guarda capturas
(`docs/trabajo/capturas/mapa-2026-10-18-*.png`). Diferencia contra la auditoría del 2026-10-08:

| Flujo | Descubribilidad | Pasos | Feedback | Autonomía IA | Consistencia | Prom. | Δ |
| ----- | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| 1. Primer proyecto → exportar | 4 | 5 | 4 | 4 | 4 | 4,2 | +1,4 |
| 2. Subtítulos / edición por texto | 4 | 4 | 3 | 4 | 4 | 3,8 | +1,2 |
| 3a. Asistente local / Consola Claude | 4 | 4 | 4 | 4 | 4 | 4,0 | +1,0 |
| 3b. «Evaluar modelos» | 4 | 4 | 4 | — | 4 | 4,0 | +1,5 |
| 4. Trabajos, servicios caídos, paquetes | 4 | 4 | 4 | 3 | 4 | 3,8 | +1,6 |
| 5. Motion graphics y perfil de estilo | 4 | 4 | 4 | 4 | 4 | 4,0 | +2,0 |
| 6. Voz | 4 | 4 | 3 | 3 | 4 | 3,6 | +1,2 |
| 7. Timeline | 4 | 4 | 4 | 3 | 4 | 3,8 | +1,0 |
| 8. Consistencia general | 4 | — | 4 | — | 4 | 4,0 | +1,7 |
| **Promedio (42 celdas)** | | | | | | **3,90** | **+1,38** (2,52 → 3,90) |

Por qué no hay 5 (medio punto no se usa; ante la duda, el menor):
- **Flujo 1**: 5 clics (Ctrl+Alt+N, Vista previa, Importar, Exportar, Exportar), 0 callejones,
  export de 10 s en 9,4 s con −14 LUFS y «Abrir carpeta». Descubrir Ctrl+Alt+N pide el menú
  Proyectos; el resultado dice «Música sin bajar (faltó una pista de Voz o de Música)» sin música
  en el proyecto (ruido). Antes de la costura 13 el mismo flujo pedía encuadre y exportaba 5 s.
- **Flujo 2 (Feedback 3)**: sin Whisper (sandbox) el aviso es el crudo «Falta el paquete Python
  'faster-whisper==1.2.1'. Ejecuta … pip install …» y llegan 3 toasts juntos (falló, «Transcribiendo…»,
  «Va a correr en CPU»). Guion: «Transcribir para el guion» 1,3 s (mock), «Quitar seguras (8)» en
  un clic (28 → 20 palabras), F2 conserva los tiempos; el export 9:16 pasa 9/10 reglas: una página
  quedó a 17,3 cps tras los cortes (`caption.timing`, no se arregla sola; «Descubierto»).
- **Flujo 3a**: plan en 0,3 s por la ruta determinista (sin Ollama), confirmar la exportación aparte,
  aplicar 11,4 s con avance por op, «Deshacer todo»; 2 sugerencias esperando arriba («2 silencios
  largos», «La voz está baja (−26,7 LUFS)»). La franja de Ollama faltante es larga.
- **Flujo 3b**: «Rápida» deshabilitada con el motivo y el arreglo en el tooltip (sin Ollama no se
  puede evaluar en el sandbox).
- **Flujo 4 (Autonomía 3)**: franja «La IA local está apagada…» con «Reintentar» y «Cómo
  iniciarla», Transcribir deshabilitado con el motivo, vuelve solo 1,8 s después de reiniciar los
  workers; «Paquete requerido» real (ui-smoke). Studio no puede levantar los workers por su cuenta.
- **Flujo 5**: Motion en español (estilos Barra/Caja/Subrayado/Dividido, posiciones «Abajo a la
  izquierda»…), doble clic → Propiedades con vista previa (primer still 3,4 s), «Del kit», render
  18,8 s y «Renderizado: listo para exportar»; Perfil de estilo analiza en 3,5 s; Kit de marca
  cambia el acento y la vista previa se actualiza. 0 términos en inglés.
- **Flujo 6 (Feedback 3, Autonomía 3)**: un selector «¿Qué voz?» (Mis voces · Voces de Studio ·
  Convertir mi grabación), «España/México»; «Generar y añadir al cursor» queda deshabilitado sin
  decir por qué cuando no hay voces instaladas (la lista dice «No instalada»), y no propone bajarlas.
- **Flujo 7**: 26 clips; seleccionar 92 ms, Mayús+clic 98 ms, Mayús+Supr 64 ms, deshacer/rehacer
  59/47 ms, S 25 ms, arrastre 170 ms. La IA no participa en la línea de tiempo (el Guion sí).
- **Flujo 8**: 0 términos en inglés en los 14 paneles y en Ajustes (salvo `rmvpe.pt` como nombre de
  archivo en Paquetes de IA), 0 botones de ícono sin explicación tras la costura 15, glosario =
  pestañas (costura 12), estados vacíos con «cómo empezar» (Guion, Trabajos, Perfil de estilo,
  Subtítulos), foco visible en 23 de 25 elementos con Tab (las pestañas de dockview no muestran
  anillo), 2 familias tipográficas.

Hallazgos nuevos (para S7): H27 «Generar» de Voz deshabilitado sin motivo; H28 aviso crudo de
paquete Python faltante al transcribir; H29 «Música sin bajar» sin música; H30 página > 17 cps tras
cortar; H31 anillo de foco en las pestañas de dockview.

## Deuda de funciones

Tabla actualizada en `docs/trabajo/sprint6-contratos.md` («Deuda de funciones», columna «Estado
(integración S6)»): **10 cerrados en el sandbox** (#2 reclasificado con la evidencia del
2026-10-05, #11 H18, #12 H19, #13 B7, #14 verificador como script, #15 B11, #16 B13, #17 B15 +
`probeError`, #18 B6, #23 reconciliado en `docs/MEJORAS.md`), 5 bajan con una corrida del
verificador en la PC (#3, #4, #5, #7, #9), 5 siguen en la PC (#1, #6, #8, #10, #22) y 3 pasan a S7
(#19, #20, #21). De lo asignado al sprint quedó fuera H16 (medios generados/duplicados) y H25
(deshacer de ajustes), que M3 no tomó (P2 opcionales).

## Panel

`docs/trabajo/panel/sesion.json` (y el `<script id="data">` de `index.html`, solo esa etiqueta):
S6 «integrado» (30 commits, ≈ 4,5 h, tests e2e 91 · smoke 63 · node 1113 · python 523),
`progreso.diseno` **78** medido (3,90 / 5), `progreso.funciones` **100** (C1–C6 🟢), errores 100
(15 de 15 costuras), agentes con tokens (investigación 145k, contratos 386k, M1 534k, M2 567k, M3
434k medidos; integración ≈ 680k estimado). S1 pasa a 2 🟢 + 1 🟡 (deuda #2) → 83,3 %.
Funciones acumulado del panel: **87,1 %** con los sprints «hecho» (89,2 % cuando S6 pase a «hecho»
tras la auditoría: el panel solo suma sprints «hecho»).

## Solo medible en la PC del usuario

- C1 con Whisper real sobre un video propio (cronometrar; cuántos «eh/em» detecta el hueco
  acústico y si confunde respiraciones); error de borde de Whisper ≤ 80 ms en el 90 %.
- Que los fundidos de 12 ms no se oigan y que el afinado por energía no coma consonantes; tiempo de
  `stt.words` en la RTX 4050.
- Calibrar la zona segura con capturas reales de Reels/TikTok/Shorts; mirar 3 fotogramas en el
  teléfono; libass de Windows con `fontsdir` en rutas con espacios y tildes; `renderStill` < 1,5 s
  con caché caliente en el i5.
- Importar 3 videos de 10 min sin que la línea de tiempo se trabe (ffmpeg en «Debajo de lo
  normal»); piso de ruido del micrófono real.
- `scripts\windows\verificar-pc.cmd` (cierra #3, #4, #5, #7, #9 de la deuda).
- Flujos 1, 5 y 6 del mapa de calor a 125 % en 1366 px.

## Descubierto

- **Subtítulos rápidos después de cortar**: tras «Quitar seguras» + una corrección, una página
  quedó a 17,3 caracteres por segundo (máx. 17): `caption.timing` es dura pero no se puede
  arreglar sola (no hay hueco para estirarla). S7: ofrecer partir la página o aceptar ≤ 10 % de
  exceso como guía.
- **Exportar sin pista de música**: «Bajar la música cuando hay voz» viene tildado y, sin música,
  Exportar muestra en amarillo «No se encontró una pista de Música…» y el resultado «Música sin
  bajar»: ruido para el caso más común (S7: no avisar si no hay música).
- **Transcribir sin Whisper** (sandbox): el aviso dice «Falta el paquete Python
  'faster-whisper==1.2.1'. Ejecuta scripts\windows\setup.ps1 o pip install…» (técnico y sin
  voseo); en la PC está instalado, pero el texto debería pasar por «Paquetes de IA».
- `Paquetes de IA` lista archivos como `rmvpe.pt` (término de `UI_ENGLISH_DENYLIST`).
- `B8`, `B9`, `B10`, `B12`, `U6` de `MEJORAS.md` siguen abiertos (reconciliado: S7); `MotionSpec`
  sin tope propio de tamaño.
- Registros globales por proceso en la api (`setScriptDeps`, `setAssDesign`,
  `setDesignTokensProvider`): con dos apps en el mismo proceso (tests) gana la última.
- `pnpm remove --offline` poda el almacén virtual (ver Procedimiento).
- **Panel**: la tarjeta «Diseño» de `index.html` toma el **primer** sprint con `diseno_medido`
  (`D.sprints.find`), así que sigue mostrando 2,52 (FL) aunque S6 tenga 3,90; y los gráficos tratan
  como «planeado» todo sprint que no esté «hecho». Arreglarlo es tocar el HTML (fuera de esta
  integración): `findLast` y aceptar «integrado».
- El script de Playwright de los 9 flujos del mapa de calor quedó en el scratchpad de la
  integración; desde las correcciones de auditoría está en `scripts/e2e/heatmap-ux.mjs`.
- **Logo del kit** (auditoría E13): se guarda pero ningún render ni exportación lo dibuja (S7); el
  Kit y el manual ya lo dicen.

## Correcciones de auditoría

Auditoría independiente posterior a la integración (`auditoria-sprint6.md`, 25 hallazgos: 2 altos,
11 medios, 12 bajos). Cinco commits por grupo: `cc25200` (E1–E3), `b2074fb` (E4–E7), `1e06984`
(E8–E9), `80d21b8` (E10–E13, E20) y `4d78df4` (bajos). Cada hallazgo se reprodujo primero con
una prueba que fallaba (o se corrigió la prueba que fijaba el valor equivocado) y después se
arregló. **Corregidos: 2/2 altos, 11/11 medios y 10/12 bajos**; diferidos E16 y E24 (abajo).

Verificación tras las correcciones (sandbox, mismo procedimiento): `pnpm -r lint`, `pnpm lint`,
`prettier --check .`, `pnpm -r typecheck`, `pnpm -r build` OK; `pnpm -r test` **1150 + 2 omitidas**
(shared 266 · web 340 · motion-engines 24 · studio-mcp 21 · remotion 94 con Chrome · api 405 + 2);
`studio-mcp smoke` 19 herramientas; workers `ruff` OK y `pytest` **524 passed, 9 skipped** normal y
en orden `shuf`; `validate-dataset` OK; `run-e2e.mjs` (sin `--skip-motion`, storage nuevo) **91/91
obligatorios** (559 s; mismos 3 SKIP y 2 expected-fail); `design-check.mjs` **10/10 en 9:16 y en
16:9 a 2,6 y a 3 palabras/s**, cajas 5/5 en zona segura; `ui-smoke.mjs --vp9-preview --ux-metrics`
(storage nuevo, `STUDIO_MOCK_DENOISE=0`) **63/63** (`UX_METRICS pass:true`) y, sobre el mismo storage
ya usado, los 4 primeros pasos 4/4; `heatmap-ux.mjs` (storage nuevo) corre los 9 flujos (el 8 se
corrigió en el script: tomaba las pestañas de tema/densidad como secciones de Ajustes; repetido
solo, OK).

| # | Sev. | Estado | Cambio | Commit | Prueba |
| - | ---- | ------ | ------ | ------ | ------ |
| E1 | alta | corregido | libass lee `Bold` como booleano: `Bold` = −1/0 y el peso real como `{\b900}`; el peso se mapea a la cara que existe (`BUNDLED_FONT_FACES` / `bundledFontWeight` / `captionFontWeight` en shared): las familias de una sola cara (Bangers, Anton, Bebas Neue, Archivo Black) nunca reciben negrita falsa y Oswald 900 usa su 700. La vista previa del reproductor (canvas y clásica) dibuja los subtítulos con la familia y el peso del kit (`design-tokens-store`) y la web declara las `@font-face` desde la misma tabla | `cc25200` | `ass-tokens.test.ts` (render real: Inter 400 ≠ 700 ≠ 900, Bangers 400 = 900 píxel a píxel; reemplaza el `s[7] === "900"`), `design-rules.test.ts`, `fonts-offline.test.ts` (tabla = TTF = peso OS/2), `caption-weight.test.tsx` |
| E2 | alta | corregido | `fixWords` nunca inserta palabras de largo cero: usa el hueco hasta el borde del segmento si alcanza o toma la mitad de la vecina más larga; `retimeSegment` no descarta palabras `corrected` | `cc25200` | `script-words.test.ts` (palabras pegadas tipo Whisper, agregado al final, el texto sobrevive a un corte posterior) |
| E3 | media | corregido | Repeticiones de una palabra con contenido («muy muy», «nunca nunca») y las que contienen números (cuentas) pasan a **probable**; tartamudeos de palabras funcionales («que que», «en el en el») siguen seguros; «ah» probable (puede ser respuesta). El mock de Whisper usa «mmm» en lugar de «ah» (siguen 8 seguras para C1) | `cc25200` | `script-words.test.ts` («Quitar seguras» no toca énfasis, cuentas ni «Ah, entendí»), `sprint6-contracts.test.ts` |
| E4 | media | corregido | `paginateCaptions` reparte el tiempo entre páginas vecinas cuando no hay hueco: cada página puede aparecer hasta 0,5 s antes o 0,3 s después de su primera palabra, sin solaparse (también contra la última página del segmento anterior). `design-check.mjs` mide además a 3 palabras/s (`--rates 2.6,3`, ambos deben dar 10/10) | `b2074fb` | `design-rules.test.ts` (40 s a 2,6 y 3 palabras/s sin `caption.timing`; páginas sin solaparse y cerca de sus palabras), design-check |
| E5 | media | corregido | `lufs_i`/`lra`/`true_peak_db` aceptan ausente (lo que deja `stripNulls`) y se normalizan a `null`; un resultado inválido falla con un motivo en español | `b2074fb` | `suggestions.test.ts` (silencio digital por el cliente HTTP real) |
| E6 | media | corregido | `StillService`: 2 renders a la vez, cola; el cierre de la conexión (la web aborta la vista previa anterior) descarta lo que todavía no empezó; `renderTemplateStill` reusa un solo Chrome Headless Shell para `selectComposition` + `renderStill` (antes abría dos por still) y lo cierra a los 60 s sin uso | `b2074fb` | `motion-still.test.ts` (8 pedidos → pico 2; abortados en cola no renderizan), `t13` de la auditoría: 8 stills distintos en paralelo → pico de **7** procesos `headless_shell` (antes 70), 3,8 s |
| E7 | media | corregido | «La voz está baja» solo si todas las pistas del medio tienen rol voz (`inferTrackRole`: video o Voz explícito); «Silencios» no se ofrece en pistas de música ni efectos; «Saturación» sigue para cualquier sonido | `b2074fb` | `suggestions-rules.test.ts` (música −30 LUFS sin tarjetas) |
| E8 | media | corregido | Se eligió respetar el bloqueo: si una pista bloqueada tiene algo después del primer corte, `cutTimeline`/`speedUpTimeline` no cortan nada (`CutLockedError` → 409 `TRACK_LOCKED` «Desbloqueá la pista «X» para cortar…»; el Guion lo avisa y no toca el proyecto). Una pista bloqueada que termina antes del corte no molesta | `1e06984` | `script-words.test.ts`, `apply-cuts-timeline.test.ts`, `script-panel.test.tsx` |
| E9 | media | corregido | `script.transcribe` con subtítulos en el tramo pide `replace: true` (409 `SCRIPT_REPLACE_REQUIRED` con cuántas palabras corregidas a mano); el resultado trae `replaced` (los subtítulos pisados). La web pregunta («Transcribir igual») solo si hay palabras corregidas (si no, deshace con Ctrl+Z). `CLAUDE.md` y la nota de `studio_run_job`: pedir un «sí» antes de `delete_words`/`fit_duration` y antes de `replace: true` | `1e06984` | `script.test.ts`, `script-panel.test.tsx`, run-e2e (re-transcribir → 409) |
| E10 | media | corregido | La exportación copia las TTF de la familia de los subtítulos a `<trabajo>/fonts/` y usa `fontsdir=fonts` relativo (como `subs.ass`, `cwd` = carpeta del trabajo): ninguna ruta del perfil con tildes llega al filtro. Sin tipografías avisa «Subtítulos con las fuentes del sistema…» y la api lo loguea al arrancar. Falta el chequeo en `verificar-pc.ps1` (Windows, sin poder probarlo acá) | `80d21b8` | `ass-tokens.test.ts` (grafo con `fontsdir=fonts`, copias, aviso; render real desde una carpeta «Ñandú con espacios» = render con ruta absoluta) |
| E11 | media | corregido | Palabras más largas que la línea (URL, número) se parten con guion en la paginación (check y ASS iguales); la exportación cuenta las reglas duras sin arreglo (`designUnfixed`, aviso `DESIGN_UNFIXED` en el resultado y en Exportar) | `80d21b8` | `design-rules.test.ts`, `export-design-summary.test.ts` |
| E12 | media | corregido | Título y pantalla final usan el grosor de «Títulos», la tipografía cinética el de «Destacados», el cargo del rótulo el de «Texto» y los subtítulos animados el de «Subtítulos» (`fontWeight` pasa a «Del kit»; sin kit, los de antes). El Kit bloquea el grosor de las familias de una sola cara | `80d21b8` | `fonts-render.test.ts` (render real: título Inter 400 ≠ 900, Bangers 400 = 900, subtítulos animados 400 ≠ 900), `brand-kit-tab.test.tsx` |
| E13 | media | corregido | El Kit dice «El logo todavía no se dibuja en los videos…» (manual §29.1 también); subir otro logo borra el anterior. El dibujo del logo queda en S7 (en «Descubierto») | `80d21b8` | `brand-kit.test.ts`, `brand-kit-tab.test.tsx` |
| E14 | baja | corregido | «Acelerar» solo existe con todos los grupos: destildar otro lo destilda y tildarlo vuelve a tildar todo; el total mostrado sigue a las casillas | `4d78df4` | `script-fit-choices.test.ts` |
| E15 | baja | corregido | Una sola duración (`exportDuration`/`timelineDuration` en shared, la del export: saltea pistas ocultas salvo audio y suma subtítulos); la api la importa | `4d78df4` | `script-words.test.ts` |
| E16 | baja | **diferido (S7)** | Clave `(project, asset, clip)` de `script_audio` y limpieza de `renders/<job>`: cambia el esquema SQLite y la lectura de huecos de M1; sin riesgo de datos, solo pierde «eh» acústicas al transcribir dos mitades del mismo medio | — | — |
| E17 | baja | corregido | Al partir un clip (cortes del Guion y `splitClip` de la web) los keyframes se reubican en cada pieza con el valor interpolado en los bordes; `faceSwap` queda solo en la primera pieza | `4d78df4` | `script-words.test.ts` |
| E18 | baja | corregido (parcial) | `numpy>=1.26` declarado en `pyproject.toml` y `requirements.txt` (ya venía por faster-whisper; no se instala nada nuevo). Leer el WAV por bloques y extraer solo el tramo del clip: S7 | `4d78df4` | `test_declared_deps.py` |
| E19 | baja | corregido | El hash del bundle de Remotion incluye `public/` (fuentes) | `4d78df4` | `render.test.ts` |
| E20 | baja | corregido (parcial) | Logo validado por firma (PNG/JPEG) y SVG sin `<script>`, eventos, `javascript:` ni enlaces externos. Sin cabecera CSP propia para `/files/*.svg` (rechazar el contenido alcanza) | `80d21b8` | `brand-kit.test.ts` |
| E21 | baja | corregido | `mediaSrc` (Lottie, video/audio de fondo, transiciones) solo acepta archivos de Studio: relativos, `data:`/`blob:` o http(s) a loopback o red privada | `4d78df4` | `schemas.test.ts` |
| E22 | baja | corregido | Reescritas la 2.ª prueba de la cola (el trabajo de fondo queda retenido hasta que corre el del usuario) y `sprint6-stubs` (404/400/409 por contrato); `ass-tokens` en E1. `scripts/e2e/heatmap-ux.mjs`: los 9 flujos del mapa de calor en el repo (genera sus medios). `ui-smoke` acepta un storage ya usado (los archivos de la corrida llevan sufijo). Queda para S7: PNG de referencia por familia/peso en `design-check` | `4d78df4` | las mismas pruebas; ui-smoke sobre storage usado (4/4 tras restablecer el layout guardado en la api; la primera prueba falló por los paneles movidos por la corrida anterior, no por los nombres) |
| E23 | baja | corregido | `probeError` guarda un motivo corto en español («El archivo está dañado o incompleto.») sin rutas; el texto crudo va al log del trabajo con la ruta relativa a storage | `4d78df4` | `media-probe-error.test.ts` |
| E24 | baja | **diferido (licencia)** | Renombrar Playfair Display («Reserved Font Name») implica regenerar las TTF con otro nombre interno y migrar los kits guardados; se decide con el usuario. Parte resuelta: la tabla archivo↔peso de la web sale de `bundledFontFileName` (shared) y se prueba contra `manifest.json` | `cc25200` (tabla) | `fonts-offline.test.ts` |
| E25 | baja | corregido | `checkDesign` devuelve `applicable: false` sin subtítulos quemados, títulos ni textos («No hay … para revisar») y `fixedCount` cuenta arreglos distintos (un ajuste del estilo arregla varias reglas) | `4d78df4` | `design-rules.test.ts`, `design-check.test.ts` |

Criterios después de las correcciones:

| # | Antes | Después |
| - | ----- | ------- |
| C1 | 0,43 s | **0,46 s** (ui-smoke; 8 seguras + 2 × Supr; el mock usa «mmm» en lugar de «ah», que ya no es segura) |
| C2 | 10/10 solo con habla a 2,6 palabras/s (9/10 a 3) | **10/10 en 9:16 y 16:9 a 2,6 y a 3 palabras/s** (`design-check --rates 2.6,3`). Medido con `checkDesignWithFix` sobre 40 s de habla: 3,5 palabras/s (18,6 caracteres/s de habla) **9/10, 11 incidencias** (antes 14); 4 palabras/s (20,9 c/s) 9/10, 22; 4,5 palabras/s 9/10, 23. Ahí la regla de 17 c/s no se puede cumplir sin condensar el texto: la exportación lo avisa (`DESIGN_UNFIXED`); bajar la regla a guía queda para S7 |
| C3 | 3,90 / 5 autoevaluado, sin script | **3,90 / 5** (sin cambios en las notas); las observaciones ahora se reproducen con `scripts/e2e/heatmap-ux.mjs` (9/9 flujos) y la corrida de verificación dio lo mismo que la integración (0 inglés salvo `rmvpe`, 0 íconos sin tooltip, 2 familias, foco visible 11/12, latencias de la línea de tiempo 36–184 ms). Las notas 1–5 las sigue poniendo una persona |
| C5 | 7,4 s | 6,8 s (2 tarjetas) |

Documentación: `CLAUDE.md` (confirmar `delete_words`/`fit_duration`, `replace: true`,
`TRACK_LOCKED`) y `MANUAL-USUARIO.md` §28 (muletillas seguras/probables, pista bloqueada,
re-transcribir), §28.3 (palabras agregadas), §29.1 (grosor por familia, logo pendiente) y §29.2
(páginas rápidas, URL con guion, `DESIGN_UNFIXED`). El `index.html` y el PDF del manual **no** se
regeneraron en esta pasada (quedan para la próxima regeneración del manual).

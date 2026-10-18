# Sprint 6 · M1 — Guion editable por palabras (agente «guion»)

Contrato: `docs/trabajo/sprint6-contratos.md` («## M1»), investigación `docs/trabajo/fuentes-sprint6.md`
§1. Criterio del sprint: **C1 «cortar 10 muletillas desde el guion en < 1 min»** → medido en el
ui-smoke: **0,5 s** headless (10 cortes, subtítulos corridos, un deshacer por gesto).
Respuestas por defecto aplicadas: muletillas probables **no** preseleccionadas («Quitar seguras» solo
toma las seguras); `fit_duration` no quita oraciones salvo `allow_sentences` y con confirmación.

## Qué quedó hecho

| Pieza | Dónde |
| --- | --- |
| Lógica pura compartida (web, api y ops del Asistente usan la misma): `normWord`, `buildScript` (vista calculada de `project.subtitles[].words`, ids `segmento:palabra`, pausas, `harsh`, stats), `detectFillers` (léxico rioplatense con reglas de contexto: «este» solo con pausa, «viste» no tras lo/la/me/te/ya, «tipo de» no, «nada» al inicio, «¿no?/¿sí?» solo con «?», repeticiones de 1–3 palabras = se borra la primera, arranque falso), hueco acústico (≥ 250 ms y ≥ piso + 10 dB → pseudo-palabra «(eh)» segura), `planWordCuts` (medio del hueco, margen ≤ 60 ms, < 40 ms no corta, «evitar cortes bruscos», fundido 12 ms), `refineCutsWithEnergy` (mínimo RMS en ±60 ms sin entrar en una palabra), `cutTimeline` (ripple de todas las pistas sin bloquear: video/audio partidos con `Clip.audioFade` en cada empalme, texto/motion acortados, subtítulos animados re-temporizados sin render, subtítulos y reencuadre corridos), `speedUpTimeline`, `fitDuration` (voraz por niveles: pausas largas de la más larga a la más corta y la última parcial → seguras → probables/dudosas con conf. ≥ 0,6 → oraciones solo con `allow_sentences` → aceleración ≤ 1,1× solo con `allow_speedup`; nunca baja de objetivo − tolerancia; si no llega, `question_es`), `fixWords` (LCS propia: equal conserva, replace reparte por letras ≥ 80 ms, insert ≤ 60 % del hueco, delete deja hueco), `replaceWordsText`, `findPhrase`, `scriptIsStale` | `packages/shared/src/script-words.ts` (+ `export *` en `index.ts`) |
| Workers `stt.words`: `POST /transcribe/words` → `{task_id}` en el área `transcribe` (cola propia con prioridad usuario), faster-whisper `word_timestamps`, `vad_filter=False`, `hallucination_silence_threshold=2.0`, `condition_on_previous_text=False`, `clip_timestamps` del clip; progreso `set_items` en segundos («Transcribiendo palabras · 1:20 de 3:05»); cancelar entre segmentos; RMS dBFS cada 5 ms con numpy → `renders/<job>/script-rms.f32`, piso = percentil 10 de ventanas de 50 ms, huecos ≥ 30 ms con `voiced`; `transcript.json` + `script-audio.json`; `GET /transcribe/tasks/{id}` y `/cancel` | `apps/workers/studio_workers/stt/words.py`, `stt/engine.py` (`extra`, `clip`), `routers/transcribe.py` (bloque `sprint6:M1`) |
| api job `script.transcribe` (carril workers): WAV 16 kHz del medio → workers → sondeo `pollWorkerTask("transcribe")` (cancelar llega al worker) → palabras a la línea de tiempo por el clip, reemplazo de `project.subtitles` en el tramo del clip (guardado) y fila en la tabla propia `script_audio` (`CREATE TABLE IF NOT EXISTS`, sin tocar `MIGRATIONS`). El resultado trae `segments` y la web los aplica en un paso de deshacer | `apps/api/src/jobs/handlers/script.ts` (registro en `jobs/handlers/index.ts`, bloque `sprint6:M1`), `services/script/store.ts` |
| Rutas `GET …/script` (Script con huecos acústicos mapeados por los clips del medio, `stale`), `POST …/script/transcribe` (202), `POST …/script/cuts` (afinado por energía con el `.f32`), `POST …/script/fit` (vista previa + `plan`); `SCRIPT_EMPTY`, `SCRIPT_STALE`, `SCRIPT_NOTHING_TO_CUT` (con `details.skipped`) | `apps/api/src/routes/script.ts`, `services/script/service.ts` |
| Ops del EditPlan: `delete_words` («Quitar 8 muletillas seguras (−3,4 s)»; > 20 % de la duración → `confirm:true` + riesgo «Quita partes del video»), `fit_duration` («Ajustar duración: 60 s → 45,4 s (−12,8 s en 27 pausas, …)»; con oraciones o > 20 % → `confirm:true`; si no llega, la pregunta va como riesgo y aplica lo logrado), `fix_text` (una/todas/la del momento `at`; «aparece N veces: ¿corrijo todas…?»; avisa «N palabras con tiempos estimados»). Sin guion → «Primero transcribí el video (Guion → Transcribir).» Aplicadas en `agent.apply` con la instantánea de siempre (**un** «Deshacer todo») | `services/agent/resolve.ts`, `jobs/handlers/agent.ts` (bloques `sprint6:M1`), `services/script/ops.ts` |
| `timeline.apply-cuts` con `mode:"timeline"` + `joinFadeMs` | `services/timeline-edit.ts` (`applyTimelineCuts`), `jobs/handlers/ai.ts` (bloque `sprint6:M1`, 4 líneas) |
| Export: `Clip.audioFade` → `afade=t=in|out:…:curve=qsin` de 12 ms dentro del clip (sin solape, la duración no cambia; no se duplica donde ya hay fundido de transición) | `services/ffmpeg/timeline.ts` (`joinFadeFilters`, bloque `sprint6:M1`) |
| Panel **Guion** (pestaña junto a Subtítulos): palabras con foco por teclado, clic = cabezal, arrastre / Mayús+clic = rango, Ctrl+clic = sumar; Supr/Retroceso = `POST cuts` (energía) → `cutTimeline` local en **un** paso de deshacer (sin api: mismos cortes sin afinado); Esc; Mayús+M «Quitar seguras (8)»; «Revisar dudosas (4)» y `.` / `,`; «Acortar pausas largas (9)»; «Dejalo en __ s» → vista previa con grupos destildables → «Aplicar» = plan del Asistente (historial + «Deshacer todo»; con oraciones pide tildar «Entiendo que quita oraciones enteras»); F2 / doble clic corrige sin mover tiempos; resaltado segura (fondo ámbar) / probable (subrayado ámbar) / dudosa (punteado gris) / corregida (borde punteado) / pausa larga (chip «0,7 s») / corte brusco omitido (⚠); contador «23 pausas de más de 0,6 s»; estado vacío con «Transcribir para el guion» (deshabilitado con motivo vía `useAiAvailability`); aviso de guion desactualizado | `apps/web/src/components/panels/ScriptPanel.tsx`, `stores/script-store.ts`, `lib/script.ts`, `lib/api-script.ts`; registro en `panels/index.ts` y `lib/layout.ts` (bloques `sprint6:M1`) |
| **H11**: editar el texto de un segmento en Subtítulos usa `fixWords` (palabras 1:1 conservan tiempos, el karaoke no se pierde) y agrupa las teclas en un paso de deshacer (800 ms; cada tecla se compara contra el segmento al empezar la edición, las estimaciones no se acumulan) | `SubtitlesPanel.tsx` (bloque `sprint6:M1`) → `lib/script.ts` `editSubtitleText` |
| Asistente local: 9 golden nuevos (3 por op, reemplazando 9 que pasaron a train: siguen 80) y 4 train; `system_es.md` describe las 3 ops; `KEY_ARGS` de las 3 ops (+ `fillers` de `delete_words` comparado como valor, `find/replace` normalizados); `PENDING_OPS` vacío; `validate-dataset.py` OK | `apps/workers/studio_workers/agent/{dataset,prompts/system_es.md,eval.py}`, `scripts/agent/validate-dataset.py` |

## Pruebas

| Paquete | Archivo | Casos |
| --- | --- | --- |
| shared | `test/script-words.test.ts` | 28 (léxico y contexto, repetición, hueco acústico, cortes: medio del hueco / margen / < 40 ms / harsh / rangos / pausas, afinado por energía, `cutTimeline`, `fixWords` equal/replace/insert/delete, `fitDuration`: orden de niveles, nunca a mitad de palabra, no llega → pregunta, tolerancia, oraciones con confirmación) |
| api | `script.test.ts` (6), `agent-script-ops.test.ts` (4), `apply-cuts-timeline.test.ts` (2), `ffmpeg-join-fade.test.ts` (3); ajustados `agent-resolve.test.ts` (caso M1) y `sprint6-stubs.test.ts` (rutas M1 vivas) | transcribe con worker falso → subtítulos con `words` + artefacto; `cuts` con `.f32` sintético mueve el borde al mínimo; `fit` 60 → 45 s con plan válido; `SCRIPT_EMPTY` / `SCRIPT_STALE` / `SCRIPT_NOTHING_TO_CUT`; las 3 ops resuelven, aplican y se deshacen en un paso; `mode:"timeline"` corta todas las pistas sin bloquear con `audioFade`; filtro `afade` `qsin` 12 ms con la misma duración (y conteo de muestras con ffmpeg) |
| workers | `tests/test_stt_words.py` (5) + `test_task_schema_sprint6.py` (rutas M1 vivas) | modelo falso con 40 palabras: `vad_filter=False`, umbral 2.0, progreso en segundos, `clip_timestamps`, cancelar entre segmentos, `.f32` del largo correcto, huecos `voiced` |
| web | `test/script-panel.test.tsx` (5), `test/subtitles-fix.test.tsx` (2); ajustado `settings-store.test.ts` (layout con «Guion») | selección + Supr = 1 deshacer; «Quitar seguras» marca y corta 8; F2 conserva tiempos; `.` salta; H11 con el panel real |
| e2e | `run-e2e.mjs` (bloque `sprint6:M1`) | «sprint6: script.transcribe (mock) → guion con 12 muletillas», «sprint6: fit_duration 45 s → plan válido», «sprint6: delete_words fillers safe → −X s y subtítulos corridos» (con deshacer) — 3/3 PASS |
| ui-smoke | `ui-smoke.mjs` (bloque `sprint6:M1`) | **C1** «Sprint 6: 10 muletillas en < 1 min» (0,5 s; Ctrl+Z deshace un solo gesto) y «Sprint 6: corregir una palabra conserva el karaoke» — 2/2 PASS |
| mock | `workers-with-mocks.py` (bloque `sprint6:M1`, `STUDIO_MOCK_SCRIPT=0` lo apaga) | `/transcribe/words` con guion fijo de 28 palabras (8 seguras + 4 probables) repartido en el clip; envolvente, piso y huecos son el código real |

Todo verde al cerrar: `pnpm -r lint`, `pnpm -r typecheck`, `pnpm -r test` (shared 250, api 389 + 2 skip, web
328), `pytest` workers (522 + 9 skip), `validate-dataset.py` OK.

## Cómo probarlo

```bash
pnpm --filter @studio/shared test -- script-words
pnpm --filter @studio/api test -- script agent-script-ops apply-cuts-timeline ffmpeg-join-fade
pnpm --filter @studio/web test -- script-panel subtitles-fix
apps/workers/.venv/bin/pytest -q apps/workers/tests/test_stt_words.py
apps/workers/.venv/bin/python scripts/agent/validate-dataset.py --quiet
# e2e (api + workers con mocks levantados; STORAGE_DIR propio):
node scripts/e2e/run-e2e.mjs --api http://127.0.0.1:3001 --only "sprint6: (script|fit_duration|delete_words)"
node scripts/e2e/ui-smoke.mjs --web http://127.0.0.1:3000 --api http://127.0.0.1:3001 --media <carpeta> \
  --only "Sprint 6: (10 muletillas|corregir una palabra)"
```

En la app: importar un video hablado → pestaña **Guion** (abajo, junto a Subtítulos) →
«Transcribir para el guion» → «Quitar seguras» / elegir palabras y Supr / «Dejalo en 45 s».

## Pedidos cruzados

1. **M2 (tooltips)**: agregar a `apps/web/src/lib/tooltips.ts` las claves `scriptRemoveSafe`,
   `scriptReviewDoubtful`, `scriptShortenPauses`, `scriptFit`, `scriptTranscribe` (y
   `scriptDelete`, `scriptFitApply`). Mientras tanto el panel usa `tooltip="…"` con el mismo
   texto en español (`TipKey` es estricto: `tip="…"` inexistente no compila); al agregarlas, cambiar
   `tooltip=` por `tip=` en `ScriptPanel.tsx`.
2. **Integración (confirmación de ops no destructivas)**: `routes/agent.ts` (api) y
   `isDestructive` de `apps/web/src/lib/agent.ts` solo exigen la confirmación aparte para
   `ALWAYS_CONFIRM_OPS`. El resolvedor de M1 ya marca `confirm:true` + riesgo en `fit_duration` con
   oraciones y en `delete_words`/`fit_duration` que quiten > 20 %; falta que `agentApply` pida
   `confirmedIndexes` cuando `record.resolved[i].confirm === true` y que la web las arranque
   destildadas. En el panel Guion la confirmación ya se pide (casilla «Entiendo que quita oraciones»).
3. **Integración (textos)**: `SCRIPT_PANEL_TEXTS_ES` vive en `script-words.ts` porque `texts-es.ts`
   es del Paso 0; moverlo junto a `SCRIPT_TEXTS_ES`. El tipo `ScriptTranscribeResult` está en
   `apps/api/src/jobs/handlers/script.ts` y repetido en `apps/web/src/lib/api-script.ts`: podría ir a
   `packages/shared/src/script.ts` (`ScriptTranscribeResultSchema`).
4. **Integración (CLAUDE.md, lista de ops del EditPlan)**: agregar
   `delete_words {ranges?|text?|fillers?: safe|probable|all, long_pauses?}`,
   `fit_duration {target_s, tolerance_s?, allow_speedup?, allow_sentences?}` (con oraciones pide
   confirmación) y `fix_text {find, replace, all?, at?}`; flujo típico «Sacá los eh»:
   `studio_validate_plan` con `delete_words {fillers:"safe"}` → `studio_apply_plan`.
5. **M3 / S7**: tarjeta de sugerencia «Quitar muletillas» (costura 6) usando
   `delete_words {fillers:"safe"}`.
6. `jobs/handlers/ai.ts` no tiene dueño en el Sprint 6: M1 tocó 4 líneas en un bloque
   `sprint6:M1` para pasar `mode`/`joinFadeMs` a `applyTimelineCuts`.

## Desvíos del contrato (y por qué)

- **Un solo ripple puro en shared** (`cutTimeline`) para web y api en lugar de
  `rippleDelete(…, {syncTrackId})` en la web: `rippleDelete` sincroniza las otras pistas recortando la
  cola (no el medio), y con una pista de voz separada se desincronizaba. Mismo resultado en las dos
  puntas y en el Asistente.
- **Huecos acústicos** = pseudo-palabras en `Script.words` con id `segmento:100000+k`
  (`ACOUSTIC_WORD_BASE`, cumple el regex `^\d+:\d+$`); `isAcoustic(word)` las distingue. Una pausa
  larga que contiene un «eh» deja de contarse como pausa (pasa a ser muletilla).
- Los artefactos de audio se guardan en **segundos de fuente del medio** (`script_audio` por
  proyecto + medio) y se mapean a la línea de tiempo por los clips que lo muestran: sobreviven a
  cortes, ripples y deshacer sin «stale». La envolvente `.f32` cubre el archivo entero (índice =
  segundo de fuente / 5 ms).
- `stale` es heurístico: > 10 % de las palabras fuera de un clip con medio, o la última palabra
  después del final de la línea de tiempo.
- `GET …/script` sin subtítulos responde 200 con el guion vacío (el panel muestra el estado vacío);
  `SCRIPT_EMPTY` lo dan `cuts`, `fit` y las ops.
- `fit` con aceleración: el plan es un único `fit_duration {allow_speedup:true}` (se recalcula al
  aplicar) porque los ids de clip cambian después de los cortes y un `set_speed` por clip no se
  puede escribir de antemano; la aceleración es uniforme en todas las pistas sin bloquear. Sin
  aceleración el plan es `delete_words {ranges}` (bloques de 200 desde el final hacia el principio,
  para que aplicar uno no corra los rangos del siguiente).
- En la vista previa de «Dejalo en» las casillas son por tipo de corte (pausas / muletillas /
  oraciones / aceleración): `ScriptCut.reason` no distingue muletillas seguras de probables.
- La vista previa de `fit` no aplica el afinado por energía y el apply sí: el resultado puede
  diferir unas centésimas por corte (medido en el mock: 45,5 s previstos → 45,7 s aplicados).
- `keepFillers` de `ScriptTranscribeRequest` se acepta pero no cambia nada: el pedido de guion es
  siempre sin VAD.
- Fundido por empalme fijo de 12 ms (`joinFadeMs`); `ScriptCut.fade_ms` informa el que cabe en el
  hueco pero `cutTimeline` usa uno solo.

## Solo medible en la PC

- Error de borde de Whisper real contra un marcado manual (5 clips, objetivo ≤ 80 ms en el 90 %);
  si falla, se reabre WhisperX en S7.
- Cuántos «eh/em» detecta el hueco acústico con tu voz y tu micrófono (y si confunde respiraciones).
- C1 cronometrado sobre un video propio con Whisper real (en el sandbox: 0,5 s headless con el mock).
- Que los fundidos de 12 ms no se escuchen en los empalmes (y que el afinado por energía no coma
  consonantes).
- Tiempo de `stt.words` en la RTX 4050 (sin VAD transcribe también los silencios).

## Borrador manual §28 — Guion (editar el video desde el texto)

> La pestaña **Guion** (abajo, junto a Subtítulos) muestra lo que se dice en el video, palabra por
> palabra. La primera vez tocá **Transcribir para el guion** (usa Whisper sin quitar los «eh»).
>
> - **Clic** en una palabra lleva el cabezal ahí. **Arrastrá** o usá **Mayús+clic** para elegir
>   varias y **Supr** para borrarlas: el hueco se cierra en todas las pistas con un fundido cortito
>   para que no se note el corte. **Ctrl+Z** deshace el borrado entero.
> - Las muletillas aparecen marcadas: **fondo ámbar** = seguras («eh», «em», repeticiones),
>   **subrayado ámbar** = probables («o sea», «digamos», «este» con pausa), **punteado gris** =
>   dudosas («tipo», «nada», «¿viste?»). **Quitar seguras** (Mayús+M) borra todas las seguras de una;
>   las demás revisalas con **.** (siguiente) y **,** (anterior).
> - **(eh)** en gris = un sonido que Whisper no escribió pero se oye entre dos palabras.
> - **Acortar pausas largas** deja en 0,25 s cada silencio de más de 0,6 s.
> - **Dejalo en __ s**: Studio propone qué pausas y muletillas sacar para llegar a esa duración; podés
>   destildar grupos y **Aplicar** (queda en el historial del Asistente y se puede **Deshacer todo**).
>   Nunca quita oraciones salvo que se lo pidas, y entonces te pide confirmarlo.
> - **F2** o **doble clic** corrige una palabra mal transcripta sin mover los tiempos (los
>   subtítulos palabra por palabra siguen sincronizados).
> - ⚠ junto a una palabra = no se cortó porque estaba pegada a la vecina (sonaría brusco).

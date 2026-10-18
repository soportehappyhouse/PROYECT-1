# Sprint 6 · M3 — Sugerencias proactivas al importar (agente «sugerencias», alcance esencial)

Contrato: `docs/trabajo/sprint6-contratos.md` («## M3», decisión 11, criterio C5) y
`docs/trabajo/fuentes-sprint6.md` §3. Deuda asignada: #11 (H18), #16 (B13), #17 (B15) y la P3 #14
(`verificar-pc.cmd`).

## Qué quedó hecho

| Pieza | Dónde |
| --- | --- |
| **Cola con prioridad en los workers**: `TaskQueue.submit(..., priority=TASK_PRIORITY_USER)` sobre `queue.PriorityQueue[(priority, seq, task, fn)]`; FIFO dentro de la misma prioridad; la firma vieja sigue valiendo (prioridad 0 = usuario, 5 = fondo); `Task.priority` | `apps/workers/studio_workers/tasks.py` |
| **`/analyze/suggest`** (tarea `suggest.analyze`, cola `analyze`, prioridad 5): **una sola pasada de FFmpeg** con `ebur128=peak=true:framelog=quiet` (LUFS integrado, LRA, true peak) y un PCM 8 kHz mono por `pipe:1` leído de a 1 s: piso de ruido = percentil 10 del RMS en ventanas de 50 ms; umbral = piso + 9 dB acotado a [−50, −30]; silencios con la semántica de `silencedetect` (toda muestra bajo el umbral ≥ 500 ms) en bloques de 10 ms. `-threads 2`, `nice -n 10` (POSIX) / `BELOW_NORMAL_PRIORITY_CLASS` (Windows), progreso en segundos leídos con `stage_es` «Midiendo silencios y volumen», cancelación revisada cada segundo de audio + `on_cancel_kill` (mata el árbol del ffmpeg). `GET /analyze/tasks/{id}`, `POST /analyze/tasks/{id}/cancel` (404 `TASK_NOT_FOUND`) | `studio_workers/analyze.py` (sección «import suggestions»), `routers/analyze.py` (bloque `sprint6:M3`) |
| **Carril `background` en la api**: los trabajos del carril toman prioridad −10 por defecto (`BACKGROUND_JOB_PRIORITY`); el carril (límite 1) nunca comparte cupo con `workers`/`ffmpeg`/`edit` | `apps/api/src/jobs/queue.ts` |
| **Job `suggest.analyze`**: valida el asset, firma del archivo (`size`, `mtime_ms`), no repite un análisis con la misma `(asset, params_version, file_sig)` (salvo `force`), llama a los workers, sondea con `pollWorkerTask` (`unit:"seconds"`, cancelar llega al worker), guarda `ImportAnalysis` y recalcula las tarjetas de cada proyecto que usa el medio. Sin workers termina `failed` con `WORKERS_UNAVAILABLE` (sin toast en la web) | `jobs/handlers/suggest.ts` (registro en `handlers/index.ts`, bloque `sprint6:M3`), `services/suggestions/workers.ts` |
| **Encolado automático tras `media.probe`** (video/audio con sonido, ≤ 30 min, sugerencias activadas, máx. 3 análisis activos: el resto espera en memoria y arranca cuando termina uno). `POST /api/media/:id/analyze` = pedido manual (sin límites, prioridad 0 dentro del carril de fondo) | `services/suggestions/service.ts` (`installSuggestionHooks`, `autoAnalyze`, `drainPending`), `routes/media.ts` |
| **Tarjetas** (`suggestionsFromAnalysis`, puro): silencios (≥ 8 % o ≥ 5 s en ≥ 3 → `cut_silences {clip, min_silence_ms: 500, fillers: false}` por clip), voz baja (LUFS + volumen del clip < −24 → `set_volume` hasta −14 LUFS sin pasar −1 dBTP ni +12 dB), saturación (true peak > −1 dBTP → `set_volume` a −1 dBTP). Una por tipo y medio, ordenadas por impacto; `visibleSuggestions` muestra máx. 4 (abiertas antes que `stale`) | `packages/shared/src/suggestions-rules.ts` (+ `SUGGESTION_UI_ES`) |
| **Estados**: `open` (se recalcula si el clip cambió y sigue aplicando), `stale` (ya no aplica o el archivo cambió: «Aplicar» → 409 `SUGGESTION_STALE`), `applied` (su plan se aplicó) y vuelve a `open` si ese plan se deshace con «Deshacer todo», `dismissed` («Ignorar»); «No sugerir más» silencia el tipo en `SuggestionSettings.mutedKinds` | `services/suggestions/{service,store}.ts` (tablas `import_analysis`, `suggestions`) |
| **Rutas** (reemplazan los 501): `GET /api/projects/:id/suggestions`, `POST …/:sid/plan` (→ `AgentPlanRecord` `proposed`, validado y resuelto con `resolvePlanForRecord`, `route:"deterministic"`, `warnings:["suggestion:<id>"]`), `POST …/:sid/dismiss`, `POST /api/media/:id/analyze` (202), `GET|PUT /api/suggestions/settings` | `routes/suggestions.ts` |
| **Web: sección «Sugerencias» arriba del campo de comando del Asistente**: título, detalle, barra de evidencia con los tramos, «Aplicar» (→ plan en la vista previa normal del Asistente → aplicar → historial y «Deshacer todo»), «Ignorar», «No sugerir más», insignia «El clip cambió desde el análisis»; un solo renglón agregado «Analizando N medios…»; los `suggest.analyze` nunca muestran toast (se marcan como atendidos apenas aparecen); recarga de tarjetas al terminar un análisis o al aplicar/deshacer un plan | `components/suggestions/SuggestionCard.tsx`, `stores/suggestions-store.ts`, `lib/api-suggestions.ts`, `components/panels/AssistantPanel.tsx` |
| **H18** (deuda #11): al recargar (o cambiar de proyecto) el Asistente reabre el último plan `proposed` del proyecto que nunca se deshizo (`lastOpenPlan`); un borrador de otro proyecto se descarta. `openPlan` acepta un `AgentPlanRecord` (costura 12, para el Guion de M1) | `stores/agent-store.ts` (bloques `sprint6:M3`), `AssistantPanel.tsx` |
| **B15** (deuda #17): medio con `media.probe` fallido → insignia roja «No se pudo leer» (tooltip con la causa) + «Quitar»; sin «Sin proxy» ni «Generar proxy». Sobrevive a la recarga (lee los probes fallidos de `GET /api/jobs?type=media.probe`) | `stores/media-store.ts` (`unreadable`, `unreadableFromJobs`, `probeFailureOf`), `components/panels/MediaPanel.tsx` (bloque `sprint6:M3`) |
| **B13** (deuda #16): ya estaba corregido (feedback 12: los renders motion muestran «Render» y no ofrecen proxy); verificado con `feedback.test.tsx` «show a Render badge…» y el test nuevo de B15 (el medio ilegible tampoco ofrece proxy) | — |
| **Verificador de la PC** (deuda #14, P3): `verificar-pc.cmd` corre Test de rendimiento + «Evaluar modelos» Rápida + stems de 1 min (audio generado con FFmpeg) contra la api local y deja `storage\run\verificacion.json` (también al portapapeles) | `scripts/windows/verificar-pc.{cmd,ps1}` |
| E2E / UI smoke / mock | bloques `sprint6:M3` en `scripts/e2e/{run-e2e.mjs,ui-smoke.mjs,workers-with-mocks.py}` |

## Tests

- shared `test/suggestions-rules.test.ts` (13): 3,5 s de 12 s → silencios; 2 s de 60 s con 2
  silencios → nada; ≥ 5 s en ≥ 3 silencios; rango de clip recortado/acelerado; −30 LUFS → +16 dB
  acotado por TP (−10 dBTP → +9 dB) y por la op (+12 dB); clip ya subido no repite; −1,0 dBTP no
  satura, −0,5 sí; sin LUFS → nada; firma `stale`; máx. 4 tarjetas.
- workers `tests/test_task_priority.py` (4): con la cola ocupada, una tarea de prioridad 0 corre
  antes que 3 de prioridad 5 encoladas antes; FIFO entre iguales; firma vieja; cancelada en cola no
  corre. `tests/test_suggest_analyze.py` (6, **ffmpeg real**): WAV sintético de 12 s con 3 silencios
  y −30 LUFS → silencios ±50 ms, LUFS ±1; tarea del router con `stage_es` y `done/total` en
  segundos; 404; **cancelar a mitad** → `canceled` en < 2 s y el ffmpeg muerto; la cola `analyze`
  respeta la prioridad; helpers puros.
- api `test/suggestions.test.ts` (9): tras `media.probe` se encola `suggest.analyze` en
  `background` con prioridad −10 y prioridad 5 en el worker; análisis → 2 tarjetas con plan válido;
  `plan` → `AgentPlanRecord` resuelto; no repite con el mismo `file_sig` (sí con `force`);
  aplicar `set_volume` → `applied`, deshacer → `open`; `dismiss` + `muteKind` (otro proyecto ya no
  recibe ese tipo); `SUGGESTION_NOT_FOUND` / `SUGGESTION_STALE` (clip recortado y archivo cambiado);
  sin workers → `WORKERS_UNAVAILABLE`; cancelar llega al worker; máx. 3 automáticos, > 30 min solo a
  pedido. `test/queue-background.test.ts` (2): un `subtitles.transcribe` arranca en < 1 s mientras
  corre un `suggest.analyze` (y el 2.º análisis espera); un trabajo del usuario no espera detrás de
  uno de fondo.
- web `test/suggestions.test.tsx` (8): máx. 4 tarjetas (stale al final, sin «Aplicar»), sección
  oculta si no hay nada, «Analizando 2 medios…», «Aplicar» pide el plan y lo abre en el Asistente,
  «Ignorar»/«No sugerir más», sin toast para análisis de fondo, H18 (`lastOpenPlan` y `loadHistory`).
  `test/media-unreadable.test.tsx` (3): B15.
- Se quitaron las filas M3 de `sprint6-stubs.test.ts` (api) y de `test_task_schema_sprint6.py`
  (workers): los stubs 501 ya no existen.

Corridas (sandbox, árbol compartido con M1/M2, tras sus commits): `pnpm lint` OK; `pnpm -r
typecheck` OK en lo de M3 (los únicos errores que vi en el árbol eran de trabajo en curso de M1/M2);
shared **250**, api **388 + 2 skip**, web **328**; workers `pytest -q` **522 passed, 9 skipped** en
orden, en orden inverso de archivos y en orden aleatorio de archivos (`shuf`; el venv no trae
`pytest-randomly`).
`run-e2e.mjs --only sprint6` contra api + `workers-with-mocks.py` reales: **3/3** («importar → 2
sugerencias» en 3,9 s; «transcribir no espera» con 0 ms de espera mientras el análisis corría;
«aplicar silencios → plan aplicado + deshacer»: 12 s → 9,22 s → 12 s y la tarjeta vuelve a `open`).
`run-e2e.mjs --skip-motion` completo: 74 obligatorios PASS; los 6 FAIL son de motion (el proyecto
queda bloqueado sin los renders que `--skip-motion` saltea) o de `S5_WORKERS` (el paso de sprint 5
consulta el puerto 8001 fijo y yo levanté los workers en 8101): ninguno toca M3.
`ui-smoke.mjs --only "Sprint 6"` contra un `next build` del commit: **1/1** (captura
`s6-sugerencia-voz-baja.png`: la tarjeta «La voz está baja (−25,6 LUFS)» arriba del campo de
comando, «Aplicar» abre el plan). La corrida completa de `ui-smoke` no es concluyente en este
sandbox (sin Chrome para los renders de motion, los pasos posteriores se encadenan); queda para la
integración.

## Cómo probarlo

```bash
# workers (prioridad + análisis real con ffmpeg)
cd apps/workers && .venv/bin/python -m pytest -q tests/test_task_priority.py tests/test_suggest_analyze.py
# shared / api / web
pnpm --filter @studio/shared test -- suggestions-rules
pnpm --filter @studio/api test -- suggestions queue-background
pnpm --filter @studio/web test -- suggestions media-unreadable
# e2e (api + workers con mocks levantados; el mock suma 2 s a cada análisis)
node scripts/e2e/run-e2e.mjs --api http://127.0.0.1:3001 --only sprint6
node scripts/e2e/ui-smoke.mjs --web http://127.0.0.1:3000 --api http://127.0.0.1:3001 --media <carpeta> --only "Sprint 6"
```

A mano: importar un video hablado con pausas → al rato aparece «Sugerencias» en el Asistente →
«Aplicar» → vista previa del plan → «Aplicar» → «Deshacer todo» deja todo como estaba y la tarjeta
vuelve.

## Pedidos cruzados

1. **Integración / M2 (texts-es.ts)**: mover `SUGGESTION_UI_ES` (hoy en
   `packages/shared/src/suggestions-rules.ts`, porque `texts-es.ts` es del Paso 0) a `texts-es.ts`
   junto a `SUGGESTION_TEXTS_ES`; y las claves de tooltip de las tarjetas a `lib/tooltips.ts`
   (`suggestionApply`, `suggestionDismiss`, `suggestionMute`, `suggestionStale`,
   `suggestionEvidence`, `mediaUnreadableRemove`): hoy van como texto en `tooltip=`/`title`.
2. **Integración (agent.ts) + M1 (handlers/agent.ts)**: `cut_silences` sin parámetro de umbral: el
   handler usa `noiseDb: -35` fijo, mientras la tarjeta mide con piso + 9 dB (−50…−30). En
   grabaciones con ruido de fondo alto la tarjeta puede prometer más (o menos) de lo que corta.
   Propuesta: `noise_db?: -60..-20` en `CutSilencesOpSchema` y que el plan de la tarjeta lo pase con
   `silence_threshold_db` del análisis.
3. **Integración (agent.ts)**: `set_volume.volume_db` tiene máximo +12 dB: con −30 LUFS la tarjeta
   llega a −18 LUFS (el loudnorm −14 LUFS del preset de redes completa al exportar). Propuesta: op
   `normalize_loudness {clip, target_lufs}` o subir el máximo a +20 dB (el clip ya admite
   `volume` hasta 4 = +12 dB; habría que subir también `ClipSchema.volume`).
4. **Dueño de `hooks/use-job-events.ts`**: `shouldToastSuccess`/fallas deberían excluir
   `suggest.analyze` (trabajo de fondo). Hoy lo resuelvo desde `suggestions-store.ts` marcando esos
   jobs como atendidos apenas aparecen en el store de Trabajos (funciona, pero es indirecto).
5. **Dueño de `components/dashboard/JobsIndicator.tsx`**: el aviso agregado «Analizando N medios…»
   va hoy en la sección Sugerencias del Asistente (`analyzingText`); el contrato lo pide en el
   indicador de Trabajos.
6. **Ajustes (M2 / integración)**: falta la UI para reactivar tipos silenciados y apagar las
   sugerencias (`GET|PUT /api/suggestions/settings` ya existe; `suggestionsApi.settings/saveSettings`
   en `lib/api-suggestions.ts`). El tooltip de «No sugerir más» ya dice «se reactiva en Ajustes».
7. **Integración (shared media.ts)**: `MediaAsset.probeError` (MEJORAS B15) para no depender de los
   jobs fallidos (hoy se leen de `GET /api/jobs?type=media.probe`, hasta 500).
8. **Manual / ARQUITECTURA / CLAUDE.md**: borrador abajo (§ Sugerencias).

## Desvíos del contrato

- **`silencedetect`**: la pasada única no puede usar el filtro `silencedetect` con umbral relativo
  (el piso se conoce recién al decodificar). Los silencios se calculan con la misma semántica
  (toda muestra bajo el umbral ≥ d) sobre el PCM de esa misma pasada, en bloques de 10 ms. El
  progreso sale de los segundos de PCM leídos (no de `-progress pipe:1`, que ocuparía el stdout).
- La cola de workers del análisis es una `TaskQueue("analyze")` propia (en `routers/analyze.py`);
  la prioridad también vale dentro de ella (pedido manual futuro con prioridad 0).
- `POST /api/media/:id/analyze` (pedido del usuario) entra al carril de fondo con prioridad 0 (antes
  que los automáticos, −10) y sin el límite de 3.
- `stale`: una tarjeta abierta cuyo clip cambió pero sigue aplicando se **recalcula** (no se marca
  `stale`); `stale` queda para cuando ya no aplica o el archivo cambió (firma distinta). Una tarjeta
  aplicada vuelve a `open` si su plan se deshace.
- Voz baja: ganancia acotada a +12 dB (límite de `set_volume`, pedido cruzado 3); el test del
  contrato «−30 LUFS → +16 dB acotada por TP» se cubre con TP −10 dBTP → +9 dB.
- H16 (grupo «Generados», duplicados por sha256) y H25 (deshacer de ajustes) **no entraron** (P2
  opcionales fuera de las filas asignadas H18/B13/B15).

## Solo medible en la PC

- Importar 3 videos de 10 min en el i5 con la línea de tiempo en uso: sin trabas; ffmpeg en «Debajo
  de lo normal» en el Administrador de tareas; las tarjetas aparecen de a una.
- Piso de ruido real del micrófono del usuario (¿el umbral piso + 9 dB separa bien voz y pausa?);
  si corta respiraciones, subir `silence_rel_db` y `params_version` en `SUGGESTION_THRESHOLDS`.
- `scripts\windows\verificar-pc.cmd` (no se pudo ejecutar PowerShell en el sandbox): correrlo con
  Studio abierto y pegar `storage\run\verificacion.json` (cierra #3, #4, #5, #7, #9).

## Borrador manual § Sugerencias

> **Sugerencias al importar.** Cuando importás un video o un audio, Studio lo revisa en segundo
> plano (sin demorar lo que estés haciendo: los trabajos que pedís vos siempre van primero) y, si
> encuentra algo para mejorar, aparece la sección **Sugerencias** arriba del Asistente: silencios
> largos para cortar, voz baja para subir o audio que satura. Cada tarjeta muestra qué encontró
> («3 silencios largos = 3,5 s de 12 s») y una barra con los tramos. **Aplicar** arma el plan y te
> lo muestra en el Asistente antes de tocar nada; después de aplicarlo, **Deshacer todo** lo
> revierte. **Ignorar** oculta la tarjeta; **No sugerir más** deja de sugerir ese tipo (se reactiva
> en Ajustes). Si cambiás el clip, la tarjeta se actualiza o queda marcada «El clip cambió desde el
> análisis» (volvé a analizar desde Medios).

ARQUITECTURA (para §4 Trabajos): carril `background` (límite 1, prioridad −10 por defecto) para
`suggest.analyze`; en los workers, `TaskQueue` con `PriorityQueue` (0 usuario, 5 fondo).

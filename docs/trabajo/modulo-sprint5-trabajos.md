# Sprint 5 · M1 — Centro de trabajos y errores (agente «trabajos»)

Contrato: `docs/trabajo/sprint5-contratos.md` («## M1»). Hallazgos: H1, H2, H3, H4, H15, H18, H19
(textos que toca M1), H23, H24 de `docs/trabajo/auditoria-fluidez.md`.

## Qué quedó hecho

| Pieza | Dónde |
| --- | --- |
| ETA, «sin avance» y texto en español (una sola función para api y web) | `packages/shared/src/job-progress.ts` (`estimateEtaS`, `isStalled`, `formatEtaEs`) + test |
| `Job.detail` (`done/total/unit/eta_s/stage_es/cancellable/stalled/progressAt`) y `Job.errorCode`, persistidos (columnas `detail`, `error_code` agregadas sin migración numerada si faltan) y en cada evento SSE junto con `error` | `apps/api/src/jobs/{queue,store,types}.ts`, `routes/jobs.ts` |
| Reloj de 15 s por job activo: recalcula ETA/`stalled` y reemite si cambian | `jobs/queue.ts` (`stallCheckMs`) |
| 409 `JOB_NOT_CANCELLABLE` (`timeline.apply-cuts`, `media.probe` o `detail.cancellable:false`) | `jobs/queue.ts` |
| `pollWorkerTask` / `cancelWorkerTaskOnAbort` / `workerTaskDetail` | `jobs/handlers/util.ts` |
| Cancelar llega al worker: vision (matte, mask, track, reframe), stems, style, perf, packs, agent.eval; transcribir con `POST /transcribe/cancel` | `jobs/handlers/{vision,audio-stems,style,ai,agent}.ts`, `voice-ai/handlers.ts` |
| `agent.eval` con progreso real («qwen3:8b · 17/20», `unit:"commands"`), modo `quick`/`full` web → api → worker, `PACK_REQUIRED agent-llm` si ningún modelo está disponible | `jobs/handlers/agent.ts`, `routes/agent.ts`, `workers/routers/agent.py`, `workers/agent/eval.py` |
| Asistente: la api corta la llamada al worker si el cliente cierra; el worker cancela el planner al detectar la desconexión (Ollama deja de generar) | `routes/agent.ts`, `workers/routers/agent.py` |
| `WORKERS_UNAVAILABLE` en español con `start.cmd` (la causa cruda solo al diagnóstico) | `services/workers-client.ts` (`workersDownMessage`), `services/style/workers.ts`, `services/persons/face-workers.ts` |
| `/api/health`: `checkedAt`, `workers.cuda`, timeout 1,5 s | `routes/health.ts` |
| Workers `TaskQueue`: `set_items`, ETA en `public()` (valida con `TaskPublic`), `cancel()` (queued/running/finished), `cancel_event`, `on_cancel`, `TaskCanceled` (también al actualizar progreso desde el hilo de la tarea), `code` del error, `kill_process_tree` (taskkill /T /F en Windows) | `studio_workers/tasks.py` |
| `POST /<área>/tasks/{id}/cancel` en agent, vision, audio, style, perf, packs (bloques `sprint5:M1`); 404 `TASK_NOT_FOUND` | `routers/*.py` |
| `select_quick` determinista (orden por id, ronda por la primera op) y cancelación de cada plan como `asyncio.Task` con vigía de 100 ms | `agent/eval.py` |
| Web: dedupe de toasts (`studio.jobs.seen.v1` + `studio.jobs.active.v1`), descripción = error real, `WORKERS_UNAVAILABLE` → banner | `stores/jobs-store.ts`, `hooks/use-job-events.ts` |
| Un solo banner «La IA local está apagada…» / «Studio no está corriendo…» con «Reintentar» y «Cómo iniciarla» | `stores/service-status-store.ts`, `components/dashboard/ServiceBanner.tsx` |
| `useAiAvailability` real (api caída > workers caídos > Ollama) | `hooks/use-ai-availability.ts` |
| Centro de trabajos: «En curso» / «Terminados», etapa, `n/total`, «faltan ~X» / «calculando…», «sin avance hace 2 min», Cancelar con `TIPS.jobCancel` (deshabilitado si no se puede), error desplegable + Reportar, insignia CPU | `components/panels/JobsPanel.tsx`, `components/dashboard/JobsIndicator.tsx` |
| «Evaluar modelos»: Rápida (20) / Completa (80), deshabilitado sin Ollama con motivo, progreso + Cancelar | `components/dashboard/AssistantTab.tsx`, `stores/agent-store.ts` |
| Asistente: «Pensando… 12 s» + Cancelar (`AbortController`), «Proponer» deshabilitado sin IA local | `components/panels/AssistantPanel.tsx`, `stores/agent-store.ts`, `lib/agent-api.ts` |
| Motion cancelado (H15): se quita el clip que esperaba ese render (un paso de deshacer) | `hooks/use-job-events.ts` |
| Etiquetas por op (H23): «Rápido (FFmpeg)» / «IA local (puede tardar)» | `lib/agent.ts` |
| Aviso de CPU una vez por sesión y función (H24) | `lib/gpu-preflight.ts` (`firstCpuWarning`, `sessionStorage["studio.cpuWarned.v1"]`) |
| `PACK_REQUIRED`: el diálogo nombra `PACKS_PATH_ES` | `components/dashboard/PackRequiredDialog.tsx` |
| E2E / UI smoke / mock | bloques `sprint5:M1` en `scripts/e2e/{run-e2e.mjs,ui-smoke.mjs,workers-with-mocks.py}` |

Tests nuevos: shared `job-progress.test.ts`; api `jobs-progress.test.ts`, `jobs-cancel-workers.test.ts`,
`agent-eval.test.ts`, `workers-unavailable.test.ts`; workers `test_tasks_cancel.py`,
`test_eval_cancel.py`, `test_transcribe_cancel.py`; web `use-job-events.test.ts`,
`service-status.test.tsx`, `jobs-center.test.tsx` (+ 2 aserciones ajustadas a la UI nueva en
`components.test.tsx` y `sprint3.test.tsx`).

## Borrador manual §4 — Recorrido por el dashboard (fila «Trabajos»)

| **Trabajos** | Todo lo que tarda (transcribir, quitar el fondo, exportar, evaluar modelos, descargar paquetes…) en dos grupos: **En curso** y **Terminados**. Cada fila muestra qué está haciendo («qwen3:8b · 17/20», «Bloque 3 de 12»), cuánto lleva («17/20 comandos») y **cuánto falta** («faltan ~6 min»; «calculando…» los primeros segundos). Si no avanza en 2 minutos dice **«sin avance hace 2 min»** en ámbar. **Cancelar** detiene el trabajo también en la IA local (la GPU se libera en segundos); los que terminan en segundos (aplicar cortes, analizar un medio) no se pueden cancelar. En los que fallan, tocá el error para verlo completo y **Reportar**. La insignia **CPU** indica que corrió sin GPU. En la cabecera, el contador con el círculo que gira dice cuántos hay en curso: clic y se abre este panel. |

Avisos: cuando un trabajo termina aparece un aviso una sola vez (recargar la página no repite los
viejos). Si falla, el aviso dice la causa real («Falta el paquete «Whisper»…»), no solo «Error».

## Borrador manual §12 — Solución de problemas: «La IA local está apagada»

| Síntoma | Causa | Qué hacer |
| --- | --- | --- |
| Franja amarilla arriba: **«La IA local está apagada. Cerrá Studio y abrilo de nuevo con scripts\windows\start.cmd.»** y los botones de IA (Transcribir, Proponer, Quitar fondo…) grises con ese motivo al pasar el mouse | Los workers de IA (puerto 8001) no corren o se cerraron | Tocá **Reintentar** (a veces tardan en arrancar). Si sigue: cerrá la ventana de Studio y la pestaña, y abrí `scripts\windows\start.cmd` con doble clic. Si vuelve a pasar, mirá la ventana «workers» o corré `scripts\windows\doctor.cmd`. |
| Franja: **«Studio no está corriendo. Abrilo con scripts\windows\start.cmd.»** | La API (3001) no responde | Abrí `scripts\windows\start.cmd`. |
| Un trabajo dice **«sin avance hace 2 min»** | El modelo se está cargando la primera vez o algo se trabó | Esperá un poco más; si no cambia, **Cancelar** y probá de nuevo. Si se repite, **Reportar**. |

## Borrador manual §19 — Asistente local: «Evaluar modelos» y Cancelar

- **Ajustes → Asistente local → Evaluar modelos** tiene dos botones: **Rápida (20)** (20 comandos
  variados, uno de cada tipo de operación; unos minutos) y **Completa (80)** (los 80 comandos de
  prueba). Mientras corre se ve «qwen3:8b · 7/20 · faltan ~2 min», la barra y **Cancelar**: Ollama
  deja de generar al instante y la GPU se libera.
- Sin Ollama (o sin el modelo) los botones están deshabilitados con el motivo; si igual se lanza
  (por la Consola), el trabajo falla con el diálogo **Paquete requerido** del asistente, nunca
  «Completado» vacío.
- En el panel **Asistente**, mientras piensa un plan se ve **«Pensando un plan (en tu PC)… 12 s»** y
  **Cancelar**, que deja de esperar y hace que Ollama corte la respuesta.
- Etiquetas de cada paso del plan: **Rápido (FFmpeg)** (silencios, escenas, reencuadre: segundos) o
  **IA local (puede tardar)** (transcribir, voz, quitar fondo, cambiar cara).

(La consigna también nombraba §7 «Trabajos» y §17 «Asistente»: en el manual actual el panel Trabajos
está en §4 y el asistente en §19; los textos de arriba van ahí. §7 «Límites» no cambia.)

## Borrador ARQUITECTURA §4 — Ciclo de vida de un job (agregar)

- **Progreso (Sprint 5).** `ctx.reportProgress(p, msg?, detail?)`; `detail` parcial
  `{done,total,unit,stage_es,cancellable}`. La cola completa `progressAt` (cambia con `p` o `done`),
  `eta_s = estimateEtaS()` (con ítems: transcurrido desde el primer ítem / hechos × restantes; sin
  ítems: transcurrido × (1 − p) / p tras 10 s y p ≥ 0,02) y `stalled` (≥ 120 s sin cambio; un reloj de
  15 s por job reemite si cambia). Se guarda en `jobs.detail` (JSON) y viaja en cada `JobEvent` con
  `error` y `errorCode` (código de `HttpError`/`WorkersError`/`PackRequiredError`/`WorkerTaskError`).
- **Cancelar (Sprint 5).** `POST /api/jobs/:id/cancel` → `AbortSignal`; los handlers que esperan
  una tarea del worker registran `cancelWorkerTaskOnAbort` → `POST /<área>/tasks/{id}/cancel`
  (3 s, error ignorado). En el worker, `TaskQueue.cancel`: queued → `canceled` sin correr; running →
  `cancel_event` + ganchos `on_cancel`; la tarea termina con `TaskCanceled` (en `check_canceled()` o
  en la próxima actualización de progreso desde su hilo) → `canceled`. `/transcribe` (síncrona) se
  corta con `POST /transcribe/cancel {job_id}` entre segmentos. 409 `JOB_NOT_CANCELLABLE` para
  `timeline.apply-cuts`, `media.probe` o `detail.cancellable:false`.
- `agent.eval`: `POST /agent/eval {dataset, models, mode}` (quick = `select_quick` 20, full = 80) →
  `pollWorkerTask("agent")` cada 1 s; sin modelos disponibles la tarea falla con `code
  PACK_REQUIRED` y el job con el cuerpo de `agent-llm`.

Tabla del §3 (workers), agregar: `POST /<agent|vision|audio|style|perf|packs>/tasks/{id}/cancel` →
`TaskCancelResponse {task_id, canceled, was}` (404 `TASK_NOT_FOUND`); `GET /<área>/tasks/{id}` →
`TaskPublic` (+ `done/total/stage_es/eta_s/cancellable/code`); `POST /transcribe/cancel {job_id}` →
`{stopped}`; `GET /transcribe/progress/{job_id}` → `{progress, done_s, total_s}`.

## Pedidos a otros módulos

- **M2 (SubtitlesPanel, VoicePanel, PreviewPanel, StylePanel…)**: usar `useAiAvailability(feature)`
  en los botones de IA con `disabled={!a.enabled}` y `disabledReason={a.reason_es}`. En particular
  **«Transcribir clip»** (`SubtitlesPanel.tsx:281`): el paso de UI smoke «workers apagados → un banner
  y Transcribir deshabilitado con motivo» lo comprueba (hoy informa `transcribirDisabled`).
- **M2 (VoicePanel.tsx:199-200)**: el texto propio «Los workers de voz no están corriendo: inicia
  Studio con start.ps1…» sobra: con `WORKERS_UNAVAILABLE` alcanza con `errorMessage(err)` (ya trae
  `start.cmd`) o con nada (lo dice el banner).
- **M3 (`services/agent/resolve.ts:288`, `routes/style.ts:30`)**: «Ajustes → Paquetes» → usar
  `PACKS_PATH_ES` («Ajustes → Paquetes de IA»).
- **M3 (`project-export.ts`)**: reportar `stage_es` + `done/total` (`unit:"blocks"`) con
  `ctx.reportProgress(p, msg, {...})` para que la ETA use los bloques.
- **Integración**: `packs.py` (sin dueño) dice «Descargalo en Ajustes.» → `PACKS_PATH_ES`. Los motores
  con subprocesos (Demucs, SAM 2, RVM, descargas) pueden registrar `tasks.on_cancel_kill(proc)` o
  llamar `current_task().check_canceled()` entre bloques: hoy se cortan en la próxima actualización de
  progreso (la mayoría la hace por bloque/cuadro).
- **Integración**: `test_agent_api.py::test_plan_with_api_json_summary_uses_fewshot_and_env_temperature`
  falla si corre después de `test_agent_eval.py` (dependencia de orden previa a este sprint; en el
  orden alfabético normal pasa).

## Solo medible en la PC

- Que Ollama corte la generación al cancelar «Evaluar modelos» o «Pensando…» (la GPU baja de uso en
  < 3 s, `nvidia-smi`).
- Duración real de **Rápida** (meta ≤ 3 min con qwen3:8b en la RTX 4050) y de **Completa**.
- Cancelar una transcripción larga en CUDA: hoy el motor marca la GPU como fallida para esa
  combinación y la libera (mismo camino que un error de CUDA); verificar que la siguiente
  transcripción vuelva a usar la GPU.
- `taskkill /T /F` matando el árbol de un subproceso de herramienta al cancelar.

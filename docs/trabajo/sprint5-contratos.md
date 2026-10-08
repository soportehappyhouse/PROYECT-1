# Sprint 5 — Contratos acordados («Roces»: fluidez del uso diario)

Plan: `docs/02-PLAN-BASE-v3.md` (Sprint 5, ítems 1–6; criterio de éxito Sprint 5; decisiones 2026-10-08). Base: `docs/trabajo/auditoria-fluidez.md` (26 hallazgos con archivo:línea; **H#** abajo) y `docs/trabajo/referencias-fluidez-autonomia.md` (§5–§6 y ranking **R1** loudnorm + ducking por rol, **R12** teclado: ripple, Q/W, I/O; **R10** `fit_duration` queda para Sprint 6). Código leído: `apps/api/src/jobs/{queue,types,state,store}.ts`, `jobs/handlers/agent.ts:1014-1052` (`agent.eval`), `services/workers-client.ts:378`, `routes/{health,projects,agent}.ts`, `services/agent/resolve.ts:619-680`, `services/ffmpeg/{timeline,audio-fx,builders}.ts`, `apps/workers/studio_workers/{tasks.py,routers/agent.py:153-198,agent/eval.py:200-240,routers/face.py:93}`, `apps/web/src/{hooks/use-job-events.ts,components/dashboard/Hotkeys.tsx,lib/shortcuts.ts,components/timeline/Ruler.tsx:39-47,stores/project-store.ts}`. Fecha: 2026-10-08.

## Decisiones del usuario (vinculantes, PLAN-BASE v3)
- **Orden 5 → 6 → 7**: este sprint solo saca roces; edición por guion, sistema de diseño y lazo autónomo no entran (ver tabla de trazabilidad).
- **Un solo brand kit** (el canal del usuario): no se crea nada de marca en Sprint 5; ningún contrato de acá agrega tokens de diseño (Sprint 6, H14).
- **Destino principal 9:16 (Reels/TikTok)**, 16:9 secundario: «Reels / TikTok» es la primera tarjeta y el preset por defecto del Asistente y de Exportar; la sonoridad por defecto es −14 LUFS / −1 dBTP; un video horizontal exportado a 9:16 **nunca** sale con franjas borrosas sin que el usuario lo elija.

## Decisiones tomadas en este documento
1. **Un contrato de progreso** para todo job: `JobProgressDetail {done,total,unit,eta_s,stage_es,cancellable,stalled}` en `Job.detail` y en cada evento SSE (que además trae `error` y `errorCode`). `progress` 0..1 sigue siendo la barra.
2. **ETA**: con `done/total` del worker, `eta_s = transcurrido_desde_el_primer_ítem / done × (total − done)`; sin ítems, `transcurrido × (1 − p) / p` recién tras 10 s y p ≥ 0,02; antes, `null` («calculando…»). `stalled = true` si el progreso no cambia en 120 s («sin avance hace 2 min»). Una sola función compartida (`estimateEtaS`) para api y web.
3. **Cancelar de punta a punta**: `POST /api/jobs/:id/cancel` → `ctx.signal` → el handler llama `POST /<área>/tasks/{id}/cancel` del worker → `Task.cancel_event` + ganchos `on_cancel` (cerrar el pedido a Ollama, matar el árbol del subproceso) → tarea `canceled`. Rutas síncronas largas (`/transcribe`) se cancelan con `POST /transcribe/cancel {job_id}` (patrón de `/tts/cancel`), revisado entre segmentos.
4. **«Evaluar modelos»**: modo **Rápida (20)** por defecto y **Completa (80)** aparte; las 20 se eligen de forma determinista (ronda por la primera op de cada ejemplo de `golden.jsonl`, ordenado por `id`), no `examples[:20]`. Sin Ollama el job termina `failed` con `PACK_REQUIRED agent-llm` (diálogo de paquete), nunca «Completado» vacío.
5. **Código `WORKERS_UNAVAILABLE` se mantiene** (lo usan web, MCP y tests); cambia el texto (sin `TypeError`, con `start.cmd`). No se crea `WORKERS_DOWN`.
6. **Toasts**: un job terminal solo genera aviso si esta pestaña lo vio no terminal, o si terminó después de abrir la pestaña y su id no está en `localStorage["studio.jobs.seen.v1"]` (anillo de 500 ids). La primera carga siembra `handled` y `seen` con todo lo terminal.
7. **Atajos**: registro único en `packages/shared/src/hotkeys.ts`; react-hotkeys-hook con scopes `global` (siempre) y `editor` (se apaga con diálogos y la paleta); los atajos de edición/transporte disparan con foco en `role=slider` (regla) salvo las flechas; nunca en campos de texto. Además la regla deja de robar el foco.
8. **Ripple**: Supr deja hueco (como hoy); **Mayús+Supr** borra y cierra el hueco en la pista del clip (y desplaza subtítulos si es la pista de video principal, igual que `applyCutsLocally`); menú «Cerrar huecos de la pista». Modo magnético por pista → Sprint 6.
9. **Selección múltiple**: `selectedClipIds[]` (el último es el primario y alimenta `selectedClipId`, que se mantiene para no romper paneles); Mayús+clic suma rango en la pista, Ctrl+clic alterna, rectángulo en zona vacía.
10. **Proyectos**: lista con miniatura desde `GET /api/projects?view=summary`; abrir, renombrar, duplicar, borrar (con confirmación); nombre automático con el primer video importado si sigue «Proyecto sin título».
11. **Export de audio**: si el preset tiene `loudness`, `loudnorm` 2 pasadas sobre la mezcla completa (medir → aplicar lineal); ducking automático por **rol de pista** (`voice`/`music`/`sfx`/`other`) con −12 dB, ataque 150 ms, suelta 600 ms. El ducking por clip (`voiceEffects` `ducking`) sigue igual (job propio).
12. **Aspecto**: export con aspecto del preset ≠ lienzo, sin `project.reframe` con keyframes y sin `aspectFit` → `409 ASPECT_CHOICE_REQUIRED`. Opciones: `reframe` (seguir la cara), `center` (recorte al centro), `blur` (franjas borrosas, el comportamiento viejo, ahora solo explícito).
13. **Planes**: el api expande el plan antes de resolverlo: `export` a un aspecto distinto sin `reframe`/`set_canvas` previo → inserta `reframe {target, subject:"face"}` (con paquete `reframe`) o deja una **elección** de 3 opciones y la exportación sin resolver. Vale para Asistente, `studio_validate_plan`, Consola y Perfil de estilo.
14. **Paso 0** (abajo) antes de lanzar los 3 agentes, incluida la tabla de tooltips y el stub de `useAiAvailability`.

## Trazabilidad (hallazgos de la auditoría → módulo)
| Módulo | Hallazgos | Ítem del plan v3 |
| --- | --- | --- |
| M1 | H1, H2, H3, H4, H15, H18, H19 (textos que M1 toca), H23, H24 | 1, 2 |
| M2 | H5, H7, H8, H9, H10, H21, H22, H26 | 3, 4 |
| M3 | H6, H17 (resultado y vista simple de Exportar), R1 | 5, 6 |
| Sprint 6/7 o Descubierto | H11, H12, H13, H14, H16, H20, H25 | — |

## Regla común de edición concurrente
Tres agentes Opus en paralelo sobre el mismo árbol; cada uno toca **solo sus rutas**. Compartidos:
- `packages/shared/**`: lo escribe el **Paso 0**; después cada módulo solo agrega archivos propios (M1 `job-progress.ts`, M2 `projects.ts`, M3 `audio-mix.ts`, `aspect.ts`) y una línea `export *` al final de `index.ts` tras releerlo.
- `apps/web/src/lib/tooltips.ts` y `apps/web/src/hooks/use-ai-availability.ts`: los crea el Paso 0; `tooltips.ts` no se edita (salvo integración); `use-ai-availability.ts` lo implementa M1 sin cambiar la firma.
- Archivos con dueño y bloques ajenos `BEGIN sprint5:<M> … END sprint5:<M>` (TS `// …`, TSX `{/* … */}`, Python `# …`), insertados tras releer el archivo y sin tocar otras líneas:
  - `components/dashboard/Dashboard.tsx` (M2) ← M1: `<ServiceBanner />` justo después de `</header>` y `<JobsIndicator />` en la cabecera.
  - `components/panels/AssistantPanel.tsx` (M1) ← M3: `<PlanChoices />` dentro de la sección de preguntas.
  - `apps/api/src/routes/agent.ts` y `jobs/handlers/agent.ts` (M1) ← M3: las 2 llamadas a `resolvePlan` de la ruta y el `case "export"` de `agent.apply` (pasa `aspectFit`). `routes/console.ts:204` y `routes/style.ts:183` (llamadas a `resolvePlan`) las edita solo M3.
  - `apps/api/src/routes/projects.ts` (M2) ← M3: solo el cuerpo del handler `projectExport` (línea ~50).
  - Routers de workers `vision.py`, `audio.py`, `style.py`, `perf.py`, `packs.py` (sin dueño de sprint) ← M1: bloque al final con `POST /tasks/{task_id}/cancel`.
- `lib/api.ts` (web) no se toca: cada módulo agrega su cliente en archivo propio (M1 `lib/api-jobs.ts`, M2 `lib/api-projects.ts`, M3 `lib/api-export.ts`), como `api-persons.ts`.
- `scripts/e2e/run-e2e.mjs` (antes de `const required = results.filter(`), `scripts/e2e/ui-smoke.mjs` (antes de `await browser.close();`), `scripts/e2e/workers-with-mocks.py` (antes de `settings = get_settings()`): bloque `BEGIN/END sprint5:<M>` por módulo.
- Manual, `ARQUITECTURA.md`, `CLAUDE.md`: borrador en `docs/trabajo/modulo-sprint5-<trabajos|timeline|export>.md` («## Borrador manual §NN»); los pega la integración. CI y scripts de Windows: nadie (no hacen falta cambios).

### Paso 0 (coordinador, un commit `feat(shared): sprint 5 contracts` antes de lanzar)
Copiar los bloques de «Contratos compartidos» a `packages/shared/src` (nuevos `hotkeys.ts`, `texts-es.ts`; aditivos en `job.ts`, `api.ts`, `agent.ts`, `export.ts`, `timeline.ts`, `ai.ts`, `index.ts`); `apps/workers/studio_workers/task_schema.py` (pydantic); `apps/web/src/lib/tooltips.ts` (tabla de M2, objeto `TIPS` con las 51 claves) y `apps/web/src/hooks/use-ai-availability.ts` (stub que devuelve `{enabled:true}`); ajustar los `switch` exhaustivos que `tsc` marque (`ASPECT_CHOICE_REQUIRED` no rompe nada; `role` y `aspect_fit` son opcionales); `pnpm --filter @studio/shared export-schemas`; `pnpm typecheck && pnpm test` y `pytest -q` verdes. Existentes que exporten vertical desde horizontal (e2e y `agent.test.ts`) pasan `aspectFit:"blur"` en este mismo commit.

## Reglas comunes
1. **UI en español rioplatense**; código, comentarios y logs en inglés; errores al usuario en español con causa real y acción. Ningún texto al usuario dice `start.ps1`, `TypeError`, `ECONNREFUSED` ni ids internos (`analyze.scenes`): se usan `START_CMD_ES`, `PACKS_PATH_ES` y `jobLabel()`.
2. **Ningún job sin `detail`**: todo handler que tarde > 2 s reporta `reportProgress(p, msg, {done,total,unit,stage_es})` al menos cada ítem/bloque; los que no pueden contar reportan `stage_es` y la ETA cae a la fórmula por `p`. `cancellable:false` solo en `timeline.apply-cuts` y `media.probe` (≤ 2 s).
3. **Cancelar no deja basura**: archivos parciales en `renders/`/`exports/` se borran; un clip creado para el job (motion recién agregado) se quita (H15); las tareas del worker quedan `canceled`, nunca `error`.
4. **Sin regresiones de Deshacer**: ripple, selección múltiple, Q/W y renombrar son un paso de deshacer cada uno; el registro de atajos no cambia los defaults existentes (S, Supr, Space, J/K/L, Ctrl+Z…).
5. **Windows primero**: rutas con espacios/tildes como elementos de argv; `taskkill /T /F /PID` para matar árboles; `localStorage`/`sessionStorage` en try/catch; Chrome/Edge reservan Ctrl+N/Ctrl+W/Ctrl+T (no se usan); escala 125 % en 1366 px da ~1093 px CSS (M2 lo prueba también).
6. **Sin descargas en CI/sandbox**: Ollama simulado (`httpx.MockTransport` o planner falso del mock e2e), ffmpeg real para loudnorm.
7. Errores: api `ApiError {error:{code,message,details?}}` salvo `PACK_REQUIRED` (cuerpo plano); workers `{detail, code}`; job fallido: `Job.error` (texto) + `Job.errorCode`.

## Contratos compartidos (Paso 0)
```ts
// ---- job.ts (aditivo) ---------------------------------------------------------------------------
export const JobProgressUnitSchema = z.enum(["items", "blocks", "frames", "seconds", "bytes", "commands"]);
export const JobProgressDetailSchema = z.object({
  done: z.number().int().nonnegative().optional(), total: z.number().int().positive().optional(),
  unit: JobProgressUnitSchema.optional(),
  eta_s: z.number().nonnegative().nullable().optional(),   // null = «calculando…»
  stage_es: z.string().max(120).optional(),                // «qwen3:8b · 17/80», «Bloque 3 de 12», «Midiendo sonoridad»
  cancellable: z.boolean().default(true),
  stalled: z.boolean().optional(),                         // sin cambio de progreso ≥ JOB_STALL_S
  progressAt: TimestampSchema.optional(),                  // último cambio de progreso
});
export type JobProgressDetail = z.infer<typeof JobProgressDetailSchema>;
export const JOB_ETA_MIN_ELAPSED_S = 10; export const JOB_ETA_MIN_PROGRESS = 0.02; export const JOB_STALL_S = 120;
// JobSchema      += detail: JobProgressDetailSchema.optional(), errorCode: z.string().optional()
// JobEventSchema += error: z.string().optional(), errorCode: z.string().optional(), detail: JobProgressDetailSchema.optional()
// (M1 implementa en job-progress.ts:) estimateEtaS(o:{progress:number; startedAt:string; now:number; done?:number;
//   total?:number; firstItemAt?:string}): number|null · isStalled(progressAt:string|undefined, now:number): boolean ·
//   formatEtaEs(s:number|null): string  // «faltan ~6 min», «faltan ~40 s», «calculando…»

// ---- ai.ts (aditivo): tareas del worker -----------------------------------------------------------
export const WorkerTaskStatusSchema = z.enum(["queued", "running", "done", "error", "canceled"]);
export const WorkerTaskSchema = z.object({ task_id: z.string(), kind: z.string(), target: z.string(),
  status: WorkerTaskStatusSchema, progress: z.number().min(0).max(1), bytes_done: z.number().default(0),
  bytes_total: z.number().default(0), current_file: z.string().nullish(),
  done: z.number().int().nullish(), total: z.number().int().nullish(), stage_es: z.string().nullish(),
  eta_s: z.number().nullish(), cancellable: z.boolean().default(true),
  error: z.string().nullish(), code: z.string().nullish(), message: z.string().nullish(), result: z.unknown().optional() });
export const WorkerTaskCancelSchema = z.object({ task_id: z.string(), canceled: z.boolean(),
  was: z.enum(["queued", "running", "finished"]) });
export const WORKER_TASK_ROUTES = { agent: "/agent/tasks/:id", vision: "/vision/tasks/:id", audio: "/audio/tasks/:id",
  style: "/style/tasks/:id", perf: "/perf/tasks/:id", packs: "/packs/tasks/:id", face: "/face/tasks/:id" } as const;
export const workerTaskCancelRoute = (area: keyof typeof WORKER_TASK_ROUTES) => `${WORKER_TASK_ROUTES[area]}/cancel`;
export const WORKER_TRANSCRIBE_CANCEL = "/transcribe/cancel";   // POST {job_id} -> {stopped: boolean}
// PackTaskSchema queda (compatibilidad); los clientes nuevos parsean WorkerTaskSchema.

// ---- agent.ts (aditivo) -------------------------------------------------------------------------
// AgentEvalRequestSchema += mode: z.enum(["quick", "full"]).default("quick")     ; AGENT_EVAL_QUICK_N = 20
// AspectFitSchema = z.enum(["reframe", "center", "blur"])
// ExportOpSchema += aspect_fit: AspectFitSchema.optional().describe("Cómo llevar un video horizontal a vertical.")
export const PlanChoiceOptionSchema = z.object({ id: AspectFitSchema, label_es: z.string(),
  insert: z.object({ before: z.number().int().min(0), op: EditOpSchema }).optional(),   // reframe a insertar
  patch: z.object({ index: z.number().int().min(0), aspect_fit: AspectFitSchema }).optional() });
export const PlanChoiceSchema = z.object({ id: z.string(), question_es: z.string(), options: z.array(PlanChoiceOptionSchema).min(2) });
// AgentPlanValidationSchema += added: z.array(z.object({ index: z.number().int(), reason_es: z.string() })).default([]),
//                              choices: z.array(PlanChoiceSchema).default([])
// (AgentPlanRecordSchema lo hereda; la web reenvía el plan elegido por la ruta de aplicar/editar existente.)

// ---- export.ts (aditivo) ------------------------------------------------------------------------
export const LoudnessTargetSchema = z.object({ integrated: z.number().min(-30).max(-5),
  truePeak: z.number().min(-9).max(0), lra: z.number().min(1).max(20) });
// ExportPresetSchema += loudness: LoudnessTargetSchema.nullable().optional()   // null = no normalizar
// BUILT_IN: reels-tiktok, youtube-shorts, youtube-1080p, youtube-4k = {integrated:-14, truePeak:-1, lra:11}; gif-480, webm-alpha = null
// ExportRequestSchema += aspectFit: AspectFitSchema.optional(), normalizeLoudness: z.boolean().optional(),  // ausente = sí si el preset tiene loudness
//                        autoDuck: z.boolean().optional()                                                   // ausente = project.audioMix.autoDuck ?? true
// ExportJobResultSchema += durationS: z.number().optional(), sizeBytes: z.number().int().optional(), aspectFit: AspectFitSchema.optional(),
//   loudness: z.object({ input_i: z.number(), input_tp: z.number(), output_i: z.number(), output_tp: z.number() }).optional(),
//   ducked: z.object({ voiceTracks: z.number().int(), musicTracks: z.number().int() }).optional(), warnings: z.array(z.string()).optional()

// ---- timeline.ts (aditivo) ----------------------------------------------------------------------
export const TrackRoleSchema = z.enum(["voice", "music", "sfx", "other"]);
// TrackSchema   += role: TrackRoleSchema.optional()           // ausente = inferTrackRole() de M3
// ProjectSchema += audioMix: z.object({ autoDuck: z.boolean().default(true), duckDb: z.number().min(-30).max(0).default(-12) }).optional()
export const AUTO_DUCK = { threshold: 0.05, ratio: 8, attackMs: 150, releaseMs: 600 } as const;

// ---- api.ts (aditivo) ---------------------------------------------------------------------------
export const ProjectSummarySchema = z.object({ id: IdSchema, name: z.string(), createdAt: TimestampSchema,
  updatedAt: TimestampSchema, durationS: z.number().nonnegative(), width: z.number().int(), height: z.number().int(),
  clips: z.number().int().nonnegative(), thumbnailPath: z.string().optional() });   // miniatura del 1.er clip de video
export const ProjectPatchSchema = z.object({ name: z.string().trim().min(1).max(120) }).strict();
export const ProjectDuplicateSchema = z.object({ name: z.string().trim().min(1).max(120).optional() }).strict();
// API_ROUTES += projectDuplicate "/api/projects/:id/duplicate", systemReveal "/api/system/reveal"
// GET /api/projects?view=summary -> ProjectSummary[]  (sin view: Project[] como hoy)
// HealthResponseSchema += workers: { reachable, url, version?: string, cuda?: boolean }, checkedAt: TimestampSchema
export const ServiceStateSchema = z.object({ api: z.enum(["up", "down"]), workers: z.enum(["up", "down", "unknown"]),
  since: TimestampSchema });   // estado del service-status-store web (M1)

// ---- texts-es.ts (nuevo) ------------------------------------------------------------------------
export const START_CMD_ES = "scripts\\windows\\start.cmd";
export const PACKS_PATH_ES = "Ajustes → Paquetes de IA";
export const WORKERS_DOWN_ES = `La IA local está apagada. Cerrá Studio y abrilo de nuevo con ${START_CMD_ES}.`;
export const API_DOWN_ES = `Studio no está corriendo. Abrilo con ${START_CMD_ES}.`;

// ---- hotkeys.ts (nuevo) -------------------------------------------------------------------------
export const HotkeyScopeSchema = z.enum(["global", "editor"]);
export interface HotkeyDef { id: string; group: "Reproducción" | "Línea de tiempo" | "Edición" | "Proyecto" | "Interfaz";
  keys: string; scope: "global" | "editor"; onSlider: boolean; inTextFields: boolean; label_es: string; help_es: string }
export const HOTKEYS: readonly HotkeyDef[];   // tabla de M2 (existentes + nuevos); ids = ShortcutActionId de la web
```
```py
# ---- apps/workers/studio_workers/task_schema.py (nuevo, espejo de WorkerTaskSchema) ----
class TaskPublic(BaseModel):
    task_id: str; kind: str; target: str
    status: Literal["queued", "running", "done", "error", "canceled"]
    progress: float; bytes_done: int = 0; bytes_total: int = 0; current_file: str | None = None
    done: int | None = None; total: int | None = None; stage_es: str | None = None; eta_s: float | None = None
    cancellable: bool = True; error: str | None = None; code: str | None = None; message: str | None = None; result: Any = None
class TaskCancelResponse(BaseModel):
    task_id: str; canceled: bool; was: Literal["queued", "running", "finished"]
class TranscribeCancelRequest(BaseModel):
    job_id: str
```

### Códigos de error nuevos o con texto nuevo
| HTTP | Código | Mensaje (plantilla) |
| --- | --- | --- |
| 503 | `WORKERS_UNAVAILABLE` (existente, texto nuevo) | «La IA local está apagada (no responde en 127.0.0.1:8001). Cerrá Studio y abrilo con scripts\windows\start.cmd.» `details.url`; la causa cruda va al log del job, no al mensaje |
| 409 | `JOB_NOT_CANCELLABLE` | «Este trabajo termina en segundos y no se puede cancelar.» |
| 404 | `TASK_NOT_FOUND` (workers) | «La tarea {id} ya no existe en la IA local (¿se reinició?).» |
| 409 | `PACK_REQUIRED` (existente) | `agent-llm` cuando «Evaluar modelos» corre sin Ollama o sin el modelo |
| 409 | `ASPECT_CHOICE_REQUIRED` | «El video es {horizontal\|vertical} y «{preset}» es {9:16\|1:1…}: elegí cómo encuadrarlo (seguir la cara, al centro o con franjas borrosas).» `details {canvas:{w,h}, preset:{id,w,h}, options:["reframe","center","blur"], reframeReady:boolean}` |
| 409 | `REFRAME_REQUIRED` | `aspectFit:"reframe"` sin `project.reframe` con keyframes: «Primero reencuadrá el video (Vista previa → Reencuadrar) o pedíselo al Asistente.» |
| 404 | `PROJECT_NOT_FOUND` (existente) | duplicar/renombrar un id inexistente |
| 400 | `REVEAL_OUTSIDE_EXPORTS` | «Solo se pueden mostrar archivos de la carpeta de exportaciones.» |
| — | `LOUDNESS_MEASURE_FAILED` (aviso) | job `project.export`: «No se pudo medir la sonoridad de la mezcla ({causa}); se exportó sin normalizar.» (aviso en `warnings`, no falla el job) |

## M1. Centro de trabajos y errores (agente «trabajos»)
Rutas: `packages/shared/src/job-progress.ts` (+ `test/job-progress.test.ts`); `apps/api/src/jobs/{queue,store,types}.ts`, `routes/{jobs,health,agent}.ts` (salvo bloques M3), `jobs/handlers/*` **excepto** `project-export.ts` (M3), `services/workers-client.ts`, `services/{style/workers.ts,persons/face-workers.ts}` (solo texto de error); workers `tasks.py`, `task_schema.py` (tras Paso 0), `routers/agent.py`, `agent/eval.py`, `agent/planner.py` (solo cancelación), `routers/transcribe.py`, bloques en `routers/{vision,audio,style,perf,packs}.py`; web `hooks/use-job-events.ts`, `stores/{jobs-store,service-status-store(nuevo)}.ts`, `hooks/use-ai-availability.ts`, `components/panels/{JobsPanel,AssistantPanel}.tsx`, `components/dashboard/{AssistantTab,GpuIndicator,PackRequiredDialog,ServiceBanner(nuevo),JobsIndicator(nuevo)}.tsx`, `lib/{agent,ai,gpu-preflight,api-jobs(nuevo)}.ts`.

**Cola api**: `JobContext.reportProgress(progress, message?, detail?: Partial<JobProgressDetail>)`; la cola completa `progressAt`, `eta_s = estimateEtaS(...)` y `stalled` (timer de 15 s por job activo que reemite si cambia `stalled`/ETA). `store.ts`: columnas `detail TEXT` (JSON) y `error_code TEXT` con migración idempotente (`ALTER TABLE` si falta). `#emit` incluye `error`, `errorCode`, `detail`. Error con `code` (`ApiError`/`WorkersError`) → `errorCode`. `cancel()` de un job con `detail.cancellable === false` → 409 `JOB_NOT_CANCELLABLE`. Helper `pollWorkerTask(area, taskId, ctx, map?)` en `jobs/handlers/util.ts`: GET cada 1 s → `reportProgress(task.progress, task.stage_es, {done,total,unit,stage_es})`; en `ctx.signal` abortado → `POST …/cancel` (timeout 3 s, error ignorado) y lanza `AbortError`; `status:"error"` → error con `task.code`; lo usan vision, stems, style, perf, packs, face y agent.eval.

**`agent.eval`** (reemplaza `handlers/agent.ts:1014-1052`): `POST /agent/eval {dataset, models, mode}` → `pollWorkerTask("agent", …)` (sin mirar `mtime`); `stage_es` = «qwen3:8b · 17/20» y `unit:"commands"`, `total = n_modelos × n_ejemplos`; resultado = `readAgentEval()` al terminar; `result.models[m].available === false` en todos los modelos → falla con `PACK_REQUIRED agent-llm` (cuerpo del worker). Ruta `POST /api/agent/eval` acepta `mode`.

**Workers `TaskQueue`**: `Task += done, total, stage_es, cancellable, cancel_event: threading.Event, on_cancel: list[Callable]`, `set_items(done, total, stage_es)` (también fija `progress = done/total`, tope 0,99) y `eta_s` calculado en `public()` (misma fórmula que `estimateEtaS`); `public()` devuelve `TaskPublic`. `TaskQueue.cancel(id)`: queued → `canceled` y no corre; running → `cancel_event.set()` + ganchos; la función de la tarea lanza `TaskCanceled` al ver el evento → `status="canceled"`; terminada → `was:"finished"`. `POST /<área>/tasks/{id}/cancel` → `TaskCancelResponse` en agent, vision, audio, style, perf, packs (face ya existe: no se toca). Subprocesos (Demucs, SAM 2, RVM, descargas) registran `on_cancel` que mata el árbol (`taskkill /T /F` en Windows, `os.killpg` en POSIX) o cierra el stream de descarga.

**Eval cancelable de verdad** (`agent/eval.py`, `routers/agent.py`): `evaluate()` recibe `cancel: threading.Event`; entre ejemplos revisa el evento; cada `plan_fn(ex)` corre como `asyncio.Task` y se espera con `asyncio.wait({plan, watcher}, FIRST_COMPLETED)` donde `watcher` sondea el evento cada 100 ms; si gana el watcher, `plan.cancel()` → `httpx` cierra la conexión y **Ollama deja de generar** (ollama aborta la generación al cortarse el cliente). `step(i, n, model)` llama `task.set_items(...)`. `mode:"quick"` → `select_quick(examples, 20)`. El resultado guarda `mode`, `n` y `canceled:false`. **Asistente** (H18): `POST /agent/plan` corre el planner como tarea que se cancela si `await request.is_disconnected()`; la ruta api corta la llamada al worker cuando el cliente cierra (`req.raw.on("close")`); la web muestra «Pensando… 12 s» + «Cancelar» (`AbortController`).

**Transcribir**: `TranscribeRequest += job_id: str | None`; `POST /transcribe/cancel {job_id}` marca un `threading.Event` revisado entre segmentos de faster-whisper (lanza `TaskCanceled`, libera el modelo como hoy); el handler api `subtitles.transcribe` lo llama al abortar y reporta `{done: segundos_transcriptos, total: duración, unit:"seconds"}` (el worker expone el avance en `GET /transcribe/progress/{job_id}` → `{done_s, total_s}`; sondeo 1 s).

**Errores y servicios (H2, H4, H19, H24)**: `workers-client.ts:378` (y `style/workers.ts:84`, `persons/face-workers.ts:132`) → `WORKERS_UNAVAILABLE` con `WORKERS_DOWN_ES`; la causa (`String(err)`) solo a `diag`/log. `health.ts` agrega `checkedAt`, `workers.version/cuda` (de `/health` del worker, timeout 1,5 s). Web: `service-status-store` (poll `GET /api/health` cada 5 s mientras algo esté caído, 15 s si todo anda; error de red = api `down`; también se actualiza ante cualquier `WORKERS_UNAVAILABLE`) → **`ServiceBanner`**: una sola franja arriba («La IA local está apagada…» / «Studio no está corriendo…», botones «Reintentar» y «Cómo iniciarla» → manual §12); se quitan los avisos sueltos de Voz, Paquetes de IA y Asistente (H4: 4 textos). `useAiAvailability(feature: "workers" | GpuFeature | "ollama"): {enabled: boolean; reason_es?: string}`: deshabilita botones de IA con tooltip = motivo; lo consumen todos los módulos. «Evaluar modelos» deshabilitado si Ollama no está (`AssistantTab.tsx:160-170`).

**Toasts (H2, H3)**: `handleFinished` usa `full.error ?? job.error ?? job.message` (el evento ya trae `error`); con `errorCode` conocido muestra la acción («Descargar paquete», «Cómo iniciarla», «Reportar»). Siembra `handled`+`seen` en la primera carga (decisión 6); `seen` en `localStorage` con try/catch. **CPU** (H24): el aviso previo `willRunOnCpu` y el posterior `hasGpuFallback` se muestran una vez por sesión y por función (`sessionStorage["studio.cpuWarned.v1"]`); después, insignia «CPU» en la fila del trabajo. **PACK_REQUIRED**: un solo camino (diálogo `PackRequiredDialog` con nombre, tamaño y `PACKS_PATH_ES`), tanto desde jobs como desde rutas síncronas.

**Centro de trabajos** (`JobsPanel.tsx` pasa a llamarse «Trabajos» en un único lugar; `JobsIndicator` en la cabecera: spinner + cantidad activa, clic abre el panel): fila = etiqueta, `stage_es`, barra, `done/total`, «faltan ~X» o «calculando…», «sin avance hace 2 min» en ámbar si `stalled`, botón Cancelar (deshabilitado si `cancellable:false`, tooltip `TIPS.jobCancel`), error completo desplegable + «Reportar». Grupos «En curso» / «Terminados» (limpiar). Motion cancelado (H15): con intento `setMotionRender` de un clip creado para ese render, se quita el clip (un paso de deshacer). **Etiquetas** (H23, `lib/agent.ts:54-78`): por op «Rápido (FFmpeg)» / «IA local (puede tardar)».

**Tests**: shared `job-progress.test.ts` (ETA con y sin `done/total`, < 10 s → null, `stalled` a 120 s, formato es). api `jobs-progress.test.ts` (detail persistido y en SSE con `error`/`errorCode`; migración de columnas; 409 `JOB_NOT_CANCELLABLE`), `jobs-cancel-workers.test.ts` (worker falso: cancelar `vision.reframe`/`audio.stems` llama `/tasks/{id}/cancel` y el job queda `canceled`), `agent-eval.test.ts` (sondea `/agent/tasks/{id}`: progreso 0,05 → … con `stage_es`; cancelar → POST cancel; todos `available:false` → `failed` con `PACK_REQUIRED`; `mode` por defecto `quick`), `workers-unavailable.test.ts` (mensaje con `start.cmd`, sin `TypeError`/`ECONNREFUSED`). workers `test_tasks_cancel.py` (queued/running/finished, `on_cancel` llamado, `TaskPublic` válido, `eta_s`), `test_eval_cancel.py` (Ollama `MockTransport` que tarda 30 s por respuesta: cancelar corta en < 2 s y el transporte ve la conexión cerrada; `select_quick` determinista, 20 ítems, cubre ≥ 8 ops distintas), `test_transcribe_cancel.py` (modelo falso con 50 segmentos). web vitest `use-job-events.test.ts` (sin toasts en la primera carga; `seen` evita repetir tras recargar; job terminado durante la recarga avisa una vez; descripción = `full.error`), `service-status-store.test.ts` (transiciones, un solo banner). Mock e2e (`STUDIO_MOCK_AGENT_EVAL=0` lo apaga): `make_planner` falso que tarda 0,2 s por ejemplo. E2E: «sprint5: agent.eval rápida (mock) 20 ítems con stage y ETA → completado», «sprint5: agent.eval cancelada → job canceled + tarea canceled», «sprint5: cancelar vision.reframe llega al worker», «sprint5: workers apagados → 503 WORKERS_UNAVAILABLE con start.cmd». UI smoke: «Sprint 5: recargar no repite toasts», «Sprint 5: workers apagados → un banner y Transcribir deshabilitado con motivo», «Sprint 5: Trabajos muestra 3/20, faltan ~X y Cancelar».

Manual: §4 «Trabajos» (centro, ETA, cancelar, «sin avance»), §12 «La IA local está apagada» (`start.cmd`), §19 «Evaluar modelos» rápida/completa y cancelar. **Solo en tu PC**: que Ollama corte la generación al cancelar (GPU baja de uso en < 3 s), duración real de Rápida (meta ≤ 3 min con qwen3:8b en la 4050) y Completa.

## M2. Fluidez de la línea de tiempo (agente «timeline»)
Rutas: `packages/shared/src/projects.ts` (funciones: `projectSummary(project, assets)`, `autoProjectName(name, firstVideo)`) + test; `packages/shared/src/hotkeys.ts` (tras Paso 0, solo la tabla); `apps/api/src/routes/projects.ts` (salvo `projectExport`), `services/projects/**` (si hace falta); web `components/timeline/**`, `components/panels/{TimelinePanel,PreviewPanel,InspectorPanel,MediaPanel,LibraryPanel,SubtitlesPanel,MotionPanel,StylePanel,VoicePanel,VisionSections}.tsx` (tooltips/estados vacíos; StylePanel:162 texto `PACKS_PATH_ES`), `components/dashboard/{Dashboard,DockLayout,Hotkeys,CommandPalette,SettingsDialog,ProjectsMenu(nuevo)}.tsx`, `components/dashboard/actions.ts`, `lib/{shortcuts,timeline,layout,api-projects(nuevo)}.ts`, `stores/{project-store,settings-store}.ts`, `hooks/use-project-sync.ts`.

**Foco y atajos (H5)**: `Ruler.tsx` hace `e.preventDefault()` en `pointerdown` (no toma foco) y, si el foco estaba en un control de la línea de tiempo, lo devuelve al contenedor `role="application"` de la línea de tiempo (`tabIndex=0`); `Hotkeys.tsx` usa `HotkeysProvider initiallyActiveScopes={["global","editor"]}`; cada `Binding` toma `scopes`, `enableOnFormTags: def.inTextFields ? true : def.onSlider ? ["slider"] : false` y `ignoreEventWhen: (e) => isTextEditable(e.target)` salvo `inTextFields`. Diálogos y paleta desactivan `editor` (`useHotkeysContext().disableScope`). `SHORTCUT_ACTIONS` se deriva de `HOTKEYS`.

**Tabla `HOTKEYS`** (scope `editor` salvo indicado; `onSlider` = sí salvo flechas; `inTextFields` solo los globales actuales `GLOBAL_IN_FORMS`):
| id | Teclas | Ayuda (help_es) |
| --- | --- | --- |
| existentes (21) | sin cambios | `playback.*`, `timeline.split/delete/zoomIn/zoomOut/toggleSnap`, `edit.*`, `project.*`, `palette.open`, `layout.reset`, `assistant.open`, `console.open` (global los 4 de `GLOBAL_IN_FORMS`); `playback.frameBack/Forward` con `onSlider:false` |
| `timeline.rippleDelete` | Shift+Delete | «Borra los clips elegidos y corre lo que sigue para cerrar el hueco» |
| `timeline.selectAll` / `timeline.deselect` | Ctrl+A / Escape | «Elige todos los clips de las pistas sin bloquear» / «Quita la selección» |
| `timeline.trimStartToCursor` / `…EndToCursor` | Q / W | «Recorta el comienzo (Q) o el final (W) del clip hasta el cursor, con ripple» |
| `timeline.markIn` / `markOut` / `clearInOut` | I / O / Alt+X | «Marca entrada/salida del rango (reproducir en bucle y exportar solo ese tramo)» |
| `timeline.closeGaps` | Ctrl+Shift+Delete | «Cierra todos los huecos de la pista del clip elegido» |
| `project.open` / `project.new` | Ctrl+O / Ctrl+Alt+N (global) | «Abre la lista de proyectos» / «Proyecto nuevo» (Ctrl+N lo reserva el navegador) |

**Edición**: `lib/timeline.ts` += `rippleDelete(tracks, ids)` (une rangos, desplaza a la izquierda solo en las pistas afectadas, no mueve pistas bloqueadas), `closeGaps(track)`, `trimToCursor(clip, t, edge)` (Q/W, ripple en su pista), `clipsInRect(tracks, rect, zoom)`. `project-store` += `selectedClipIds: string[]`, `selectClip(id, mode: "replace"|"toggle"|"range")`, `selectRect(...)`, `deleteSelected({ripple})`, `moveSelected(delta)`, `inOut?: {in:number; out:number}` (no se guarda en el proyecto; lo lee ExportPanel de M3) y `snap: {enabled, playhead, clipEdges, inOut}` en `settings-store` (persistido en `ui`). Inspector con N clips: velocidad y volumen en lote («3 clips»). Menú del clip: «Borrar y cerrar hueco», «Cerrar huecos de la pista». Botón imán con menú de tildes (cursor, bordes de clips, marcas I/O).

**Proyectos (H7)**: `GET /api/projects?view=summary` (orden `updatedAt` desc; miniatura = `thumbnailPath` del asset del 1.er clip de video), `PATCH /api/projects/:id` `ProjectPatch` → `ProjectSummary`, `POST /api/projects/:id/duplicate` → 201 `Project` (ids de pistas/clips nuevos, mismos assets, «{nombre} (copia)»), `DELETE` existente (la web pide confirmación con el nombre). `ProjectsMenu` en la cabecera: recientes con miniatura y fecha, buscar, abrir (guarda antes el actual), renombrar en línea, duplicar, borrar, nuevo. Al importar el primer video, `autoProjectName` renombra «Proyecto sin título» (un paso de deshacer). **Autoguardado (H22)**: `pagehide` → `fetch(PUT autosave, {keepalive:true})` si hay cambios pendientes (cuerpo ≤ 64 KB; si es más grande, `navigator.sendBeacon` no sirve para PUT: guardar al cortar con debounce de 300 ms en vez de 1,5 s).

**1366 px (H8)**: cabecera con botones fijos con texto **«Asistente»** y **«Exportar»** (primario) que abren/enfocan su panel; layout por defecto: columna derecha con Propiedades · Asistente · Exportar; Motion, Voz, Subtítulos, Consola Claude y Perfil de estilo en la izquierda/abajo como pestañas; «Más paneles ⌄» con nombres (no un número). `layout.reset` aplica el nuevo default; los layouts guardados del usuario no se migran.

**Estados vacíos (H26)**: vista previa sin clips → «Arrastrá un video acá o tocá Importar» + botón; línea de tiempo vacía → «Agregá un medio con + o arrastrándolo»; Media vacío → tipos aceptados; Subtítulos sin texto → «Transcribir el video» (deshabilitado con motivo si no hay workers, `useAiAvailability`); Trabajos vacío lo hace M1. Primer video importado con lienzo por defecto → lienzo = tamaño del video (un paso de deshacer y aviso «Ajusté el lienzo a 1280×720 · Deshacer»).

**Tooltips (H21)**: componente `IconButton` (o `Button size="icon"`) exige `tooltip` = qué hace + atajo + motivo si está deshabilitado; textos en `lib/tooltips.ts` (Paso 0). Dueño de aplicar: M1 en JobsPanel/GpuIndicator, M3 en ExportPanel, M2 en el resto.
| Clave · lugar | Texto | Clave · lugar | Texto |
| --- | --- | --- | --- |
| panels · Dashboard | Mostrar u ocultar paneles (Media, Voz, Subtítulos…) | layouts · Dashboard | Guardar o cargar una disposición de paneles |
| theme · Dashboard | Cambiar entre tema claro, oscuro o el del sistema | report · Dashboard | Armar un reporte de error con diagnósticos para enviar |
| settings · Dashboard | Ajustes: atajos, paquetes de IA, Personas, asistente | gpu · GpuIndicator | Estado de la IA local y la GPU; clic para ver detalles |
| toStart · Preview | Ir al inicio (Inicio) | frameBack · Preview | Retroceder un fotograma (←) |
| play · Preview | Reproducir o pausar (Espacio) | frameFwd · Preview | Avanzar un fotograma (→) |
| toEnd · Preview | Ir al final (Fin) | previewOpts · Preview | Calidad de la vista previa, guías de zona segura y modo multicapa |
| removeBg · Preview | Quitar el fondo del clip elegido con IA (sin pantalla verde) | sam · Preview | Marcar un objeto con clics y seguirlo en todo el clip (SAM 2) |
| reframe · Preview | Llevar el video a 9:16 o 1:1 siguiendo la cara | track · Preview | Seguir un objeto para que un texto o gráfico lo acompañe |
| undo · Timeline | Deshacer el último cambio (Ctrl+Z) | redo · Timeline | Rehacer (Ctrl+Mayús+Z) |
| split · Timeline | Cortar el clip en el cursor (S) | delete · Timeline | Borrar el clip (Supr); con Mayús+Supr cierra el hueco |
| snap · Timeline | Imán: los clips se pegan al cursor y a otros clips (N) | silences · Timeline | Encontrar silencios y muletillas y elegir cuáles cortar |
| zoomIn · Timeline | Acercar la línea de tiempo (=) | zoomOut · Timeline | Alejar la línea de tiempo (−) |
| trackMute · Pista | Silenciar esta pista (no suena ni se exporta su audio) | trackHide · Pista | Ocultar esta pista en la vista previa y la exportación |
| trackLock · Pista | Bloquear: evita mover o cortar sus clips por error | trackDelete · Pista | Borrar la pista y sus clips |
| trackOrder · Pista | Subir o bajar la capa (lo de arriba tapa a lo de abajo) | mediaReload · Media | Volver a leer la lista de medios |
| mediaProxy · Media | Crear una copia liviana para editar fluido videos pesados | mediaAdd · Media | Poner este medio en la línea de tiempo, en el cursor |
| mediaDelete · Media | Quitar el medio del proyecto (el archivo queda en disco) | jobsReload · Trabajos | Actualizar la lista de trabajos |
| jobsClear · Trabajos | Borrar de la lista los trabajos terminados | jobCancel · Trabajos | Cancelar: detiene el trabajo también en la IA local |
| jobOpen · Trabajos | Abrir el archivo que generó el trabajo | jobReport · Trabajos | Reportar este error con sus diagnósticos |
| presetDup · Exportar | Copiar este formato para cambiarle calidad o tamaño | presetDel · Exportar | Borrar este formato propio (los de Studio no se borran) |
| subAdd · Subtítulos | Agregar un subtítulo en el cursor | subDel · Subtítulos | Borrar este subtítulo (el video no cambia) |
| subSrt · Subtítulos | Descargar los subtítulos como .srt para subirlos a la red | motionReload · Motion | Volver a cargar las plantillas de gráficos |
| styleReload · Estilo | Actualizar la lista de perfiles de estilo | styleDel · Estilo | Borrar este perfil de estilo |
| libPlay · Biblioteca | Escuchar la muestra | libAdd · Biblioteca | Poner este sonido en el cursor, en una pista de audio |
| libUpload · Biblioteca | Agregar tus propios sonidos o música a la biblioteca | kfCopy · Keyframes | Copiar los keyframes del clip |
| kfPaste · Keyframes | Pegar los keyframes copiados a partir del cursor | | |

**Tests**: shared `projects.test.ts`, `hotkeys.test.ts` (ids únicos, sin teclas repetidas en el mismo scope, todo con `help_es`, flechas con `onSlider:false`). web vitest `timeline-ripple.test.ts` (rippleDelete con rangos solapados y pista bloqueada, closeGaps, Q/W), `selection.test.ts` (replace/toggle/range/rect, borrar y mover en lote = 1 deshacer), `tooltips.test.ts` (51 claves; cada texto ≠ su `aria-label` y ≥ 20 caracteres), `project-sync.test.ts` (`pagehide` con `keepalive`). api `projects-summary.test.ts` (summary, PATCH 400/404, duplicate con ids nuevos, DELETE). UI smoke (Playwright, 1366×820 salvo indicado): «Sprint 5: clic en la regla → S corta (1 → 2 clips)» y «… → Espacio reproduce, K pausa, L avanza, Supr borra» (sin clicar el clip), «Shift+Supr cierra el hueco (0 px)», «Mayús+clic elige 2 y Supr borra 2», «rectángulo elige 3», «Q/W recortan al cursor», «I/O marcan rango visible», «1366×768 y 1093×700: Asistente y Exportar visibles sin menú», «hover en Paneles muestra la explicación», «Proyectos: crear 2, renombrar, abrir el otro, borrar con confirmación», «estado vacío de la vista previa». E2E: «sprint5: projects summary + rename + duplicate».

Manual: §4 Proyectos y cabecera nueva, §10 Atajos (tabla completa), §5 flujo 1 con «clic en la regla → S». **Solo en tu PC**: Ctrl+O en Edge/Chrome de Windows (no abre el diálogo del navegador), 125 % de escala, arrastre con 50+ clips.

## M3. Export profesional y 9:16 (agente «export»)
Rutas: `packages/shared/src/{audio-mix,aspect}.ts` (+ tests); `apps/api/src/services/ffmpeg/{timeline,audio-fx,builders}.ts`, `jobs/handlers/project-export.ts`, `services/export/**` (nuevo: `loudness.ts`, `aspect-check.ts`), `services/agent/{resolve,aspect(nuevo)}.ts`, `routes/system.ts`, bloques en `routes/{agent,projects}.ts`, `jobs/handlers/agent.ts`, llamadas en `routes/{console,style}.ts`; `packages/studio-mcp/src/tools.ts` (`studio_export`); web `components/panels/{ExportPanel,SocialReview,PlanChoices(nuevo)}.tsx`, `stores/export-presets-store.ts`, `lib/{publish,api-export(nuevo)}.ts`.

**Funciones compartidas**: `inferTrackRole(track, assetOf): TrackRole` (`role` explícito; si no: pista de video → `voice`; audio con assets `voice-ref`/`aiProvenance` de voz/TTS → `voice`; resto → `other`, nunca se duckea lo dudoso) · `loudnessFor(preset)` · `aspectOf(w,h)` y `needsAspectChoice(canvas, preset, reframe?)` (diferencia ≥ 0,01, no GIF/alpha) · `reframeTargetFor(preset): "9:16"|"1:1"|"4:5"|null`. Agregar un sonido de la biblioteca (`add_audio` y panel Biblioteca vía `updateTrack`) pone `role` = `music` (music/ambience) o `sfx`.

**Mezcla y sonoridad** (`project.export`): la mezcla de audio (todas las pistas audibles) se renderiza **siempre aparte** a `tmp/mix.wav` (PCM 48 kHz, `compileExport` con `audioOnly`), también en modo `single`; si hay ≥ 1 pista `voice` y ≥ 1 `music` audibles y `autoDuck`, el grafo arma bus `voice` (amix) y bus `music` (amix + `volume`) y aplica `sidechaincompress` con `AUTO_DUCK` (ratio que da ≈ `duckDb` bajo voz) antes del amix final, con `apad` en la cadena lateral (`duckingFragment` reutilizado). Pasada 1: `loudnorm=I:TP:LRA:print_format=json` sobre `mix.wav` (`parseLoudnormJson`, tolera CRLF); pasada 2: `loudnorm` lineal con `measured_*` + `offset`, `-ar 48000`, códec del preset; mux final con `-c:v copy`. Medición fallida → `warnings:["LOUDNESS_MEASURE_FAILED"]`, export sin normalizar. Progreso con `stage_es` («Video: bloque 3 de 12», «Midiendo sonoridad», «Normalizando audio», «Uniendo») y `cancellable:true`. Resultado += `loudness`, `ducked`, `durationS`, `sizeBytes`, `aspectFit`. Cache de bloques de video intacta (el audio nunca se cacheaba).

**Aspecto** (`services/export/aspect-check.ts`, llamado en el handler `projectExport` de la ruta y en `agent.apply`/`studio_export`): `needsAspectChoice` y sin `aspectFit` → 409 `ASPECT_CHOICE_REQUIRED`; `reframe` sin keyframes → 409 `REFRAME_REQUIRED`; `center` = recorte centrado al aspecto del preset (sin franjas); `blur` = `blurredBackgroundFilter` (camino viejo). Con `project.reframe` con keyframes y `aspectFit` ausente → `reframe` (como hoy, `reframeApplies`).

**Planes (H6)** (`services/agent/aspect.ts`): `expandPlanForAspect(plan, ctx): {plan, added, choices}` corre antes de cada `resolvePlan` (4 llamadas). Por cada `export` con `needsAspectChoice` sin `aspect_fit`, sin `reframe`/`set_canvas` previo y sin `project.reframe` para ese aspecto: (a) hay video y paquete `reframe` instalado (o `packs` desconocido) → inserta `reframe {target, subject:"face"}` antes del export, `aspect_fit:"reframe"`, `added[{index, reason_es:"El video es horizontal: lo reencuadro siguiendo la cara antes de exportar."}]`; (b) falta el paquete → `choices[{id:"aspect", question_es:"El video es horizontal y Reels es vertical. ¿Cómo lo encuadro?", options: reframe («Seguir la cara (descarga «Reencuadre», N MB)»), center («Recortar al centro»), blur («Dejarlo entero con franjas borrosas»)}]` y el export queda en `unresolved` hasta elegir. El reframe insertado es «Operación larga» en riesgos y no pide confirmación aparte; el export sí (ALWAYS_CONFIRM). `PlanChoices.tsx` muestra las opciones como botones; elegir arma el plan con `insert`/`patch` y lo reenvía (plan editado) para obtener vista previa nueva. `studio_export` += `aspectFit` (si falta y hace falta: el error explica las 3 opciones para que Claude pregunte). Vista previa: «(agregado por Studio)» en las ops de `added`.

**Exportar (H17, decisión 9:16)**: vista simple «¿Dónde lo vas a publicar?» con tarjetas (Reels/TikTok primero, Shorts, YouTube 1080p, YouTube 4K, Otro) y lo técnico (CRF, bitrate, códecs) plegado en «Avanzado»; con horizontal → vertical sin reencuadre, la tarjeta muestra la elección de encuadre (seguir la cara / al centro / franjas) antes de habilitar Exportar; sección «Sonido»: «Normalizar a −14 LUFS (recomendado para redes)» y «Bajar la música cuando hay voz» (on) + rol por pista (Voz/Música/Efectos/Otro, `updateTrack`); «Solo el rango I–O» si M2 marcó `inOut`. Tarjeta de resultado: miniatura, ruta, duración, tamaño, «−14,0 LUFS», «Abrir carpeta» (`POST /api/system/reveal {path}`: solo bajo `exports/`; Windows `explorer.exe /select,<abs>` con argv; Linux `xdg-open` del directorio; 400 `REVEAL_OUTSIDE_EXPORTS`) y «Revisar» (abre «Revisión para redes»). **Revisión para redes**: filas nuevas «Sonoridad» (mide el último export: ok si |I − objetivo| ≤ 1 y TP ≤ −1) y «Formato» (vertical sin franjas: aviso si `aspectFit:"blur"`).

**Tests**: shared `audio-mix.test.ts` (`inferTrackRole`, `loudnessFor` de los built-in), `aspect.test.ts` (`needsAspectChoice` 16:9→9:16 sí, 9:16→9:16 no, GIF no, `reframe` con keyframes no). api `export-loudnorm.test.ts` (ffmpeg real: voz senoidal modulada a −30 LUFS + música a −20; export `reels-tiktok` → **medida con ffprobe** `-f lavfi -i "amovie=<rel>,ebur128=metadata=1:peak=true" -show_entries frame_tags=lavfi.r128.I,lavfi.r128.true_peaks_ch0` (último frame): I = −14 ± 1, TP ≤ −0,8; con `normalizeLoudness:false` no cambia; `result.loudness` coherente), `export-ducking.test.ts` (RMS de la música en el tramo con voz ≥ 8 dB menor que sin `autoDuck`; sin pista `voice` no hay sidechain en el grafo), `export-aspect.test.ts` (409 `ASPECT_CHOICE_REQUIRED` con `details`; `center` → 1080×1920 sin franjas: columnas laterales no uniformes; `blur` como antes; `reframe` sin keyframes → 409), `agent-reels.test.ts` («Exportá para Reels» sobre 16:9 con pack → plan `[…, reframe(face), export(aspect_fit:"reframe")]` y `added`; sin pack → `choices` + export sin resolver; lienzo 9:16 → sin cambios; plan con `reframe` previo → sin duplicar; los 4 caminos: plan, plan editado, Consola, Perfil de estilo), `system-reveal.test.ts` (`..` y fuera de exports → 400; runner falso ve argv). studio-mcp: `studio_export` con/sin `aspectFit`. E2E: «sprint5: export reels-tiktok con loudnorm −14 LUFS (ffprobe ebur128)», «sprint5: ducking automático música bajo voz», «sprint5: export vertical desde horizontal sin elección → 409 ASPECT_CHOICE_REQUIRED; con center → 1080×1920», «sprint5: plan Reels desde horizontal propone reframe». UI smoke: «Sprint 5: Exportar → Reels con video horizontal pide elegir encuadre», «Sprint 5: resultado con ruta, LUFS y Abrir carpeta», «Sprint 5: Revisión para redes muestra Sonoridad y Formato».

Manual: **§15** (quitar «Ducking: solo por API…» y «Sin recorte ni zoom… queda con barras»; agregar lo que sigue pendiente), §5 flujo «Reels desde un video horizontal», §17 Revisión para redes (filas nuevas), §9/§17 «Sonido al exportar» (roles, −14 LUFS, ducking). **Solo en tu PC**: tiempo extra de las 2 pasadas en un video de 10 min, que «Abrir carpeta» seleccione el archivo en el Explorador con rutas con tildes, sonoridad real medida por Instagram/TikTok tras subir (−14 es [S]).

## Notas para Windows
- Textos y documentación: siempre `scripts\windows\start.cmd` (nunca `start.ps1`).
- `loudnorm` imprime el JSON en stderr con `\r\n`: parsear el último bloque `{…}` sin depender de saltos de línea. En `amovie=` (filtro lavfi) la ruta va relativa con `cwd` = carpeta del archivo: los `:` de `C:\` y `\` rompen el parseo del filtro.
- Cancelar subprocesos: `taskkill /T /F /PID <pid>` con argv (sin `shell`); `httpx` dentro de `asyncio.run` en hilo propio (Proactor) cierra bien el socket al cancelar la tarea.
- `explorer.exe /select,<ruta>` devuelve código 1 aunque funcione: no tratarlo como error.
- Atajos: Ctrl+N/Ctrl+W/Ctrl+T no se pueden interceptar en Chrome/Edge; Ctrl+O sí (con `preventDefault`).
- `localStorage` puede estar bloqueado (perfiles con políticas): todo en try/catch, sin romper la UI.

## Criterios del sprint
Del plan v3: **ningún trabajo sin progreso/ETA/cancelar** (todo job > 2 s muestra `stage_es`, «faltan ~X» o «calculando…», y Cancelar detiene también la tarea del worker; «Evaluar modelos» avanza de a ítem, Rápida (20) por defecto, cancelable con Ollama dejando de generar); **con workers apagados un solo aviso** (una franja, acciones de IA deshabilitadas con motivo, texto con `start.cmd`, ningún `TypeError`); **atajos funcionan tras clicar cualquier zona** (Playwright: clic en la regla → S, Espacio, J/K/L, Supr); **Reels desde horizontal sin franjas por defecto** (plan con `reframe` o pregunta; API 409 sin elección). Además: errores con la causa real en el aviso; recargar no repite avisos; Mayús+Supr, selección múltiple, Q/W, I/O, lista de proyectos; Asistente y Exportar visibles a 1366 px; 51 tooltips con explicación; export `reels-tiktok` mide −14 ± 1 LUFS y TP ≤ −1 dBTP (+0,2 de tolerancia de medición) con la música bajo la voz; `pnpm typecheck && pnpm test`, `pytest -q`, e2e y ui-smoke verdes en ubuntu + windows.

## Descubierto (fuera de alcance)
- Modo magnético por pista (cierra huecos solo), `X`/`M` (marcar clip, marcadores) y edición de 3 puntos (R12 completo) → Sprint 6 junto con el guion editable.
- Vista previa del plan con diferencias (R13), «Revisar resultado» con LUFS y franjas (estructural 4) → Sprint 7; acá solo filas de Revisión para redes.
- H11 (conservar `words` al corregir), H12–H14 (Motion en español, sistema de diseño, brand kit), H16 (medios generados y duplicados), H20 (selector de voz único), H25 (deshacer de ajustes/estilo) → Sprint 6.
- ETA por «Test de rendimiento» (segundos por minuto de video por tipo) en lugar de la fórmula lineal.
- Fundido de 20–30 ms en cada empalme y tono de sala (referencias §6).
- Cancelar `audio.denoise` y `voice.tts` de Piper (síncronos y cortos): hoy solo cortan el pedido HTTP.

## Cambios en integración

(2026-10-08; detalle, resultados y procedimiento en `docs/trabajo/integracion-sprint5.md`)

- **`useAiAvailability` en todos los botones de IA (M1 → M2)**: Voz (texto a voz Piper/Chatterbox,
  descargas de voces, Limpiar voz, Separar audio, RVC), Subtítulos («Transcribir clip», además de
  «Transcribir el video»), Perfil de estilo («Analizar» = workers, «Deducir con modelo local» =
  Ollama), Reencuadrar («Analizar para 9:16») y «Cambiar cara…». ElevenLabs/OpenAI no dependen de
  los workers. `VoicePanel` ya no dice `start.ps1`: con `WORKERS_UNAVAILABLE` usa el texto de la api
  (`start.cmd`) o `WORKERS_DOWN_ES`.
- **`Button` sin tooltip propio** (costura M1 ↔ M2): `disabledReason` solo se mostraba si el botón
  tenía `tip` o etiqueta; en los botones de texto («Transcribir clip», «Generar y añadir al
  cursor»…) el motivo se perdía. Ahora el motivo es el tooltip. Test en `tooltips.test.tsx`; el paso
  de UI smoke «workers apagados» exige Transcribir deshabilitado **con** `start.cmd` en el tooltip.
- **Tests web y el `service-status-store`**: jsdom no tiene api, el sondeo de `/api/health` fallaba
  y marcaba la api «caída» a mitad de un test (deshabilitaba botones al azar; rompía
  `feedback.test.tsx`). `test/setup.ts` responde `/api/health` como «todo arriba»; los tests que
  necesitan otro estado siguen espiando `fetch`.
- **«Ajustes → Paquetes de IA» (M1 → M3, integración)**: `services/agent/resolve.ts`,
  `routes/style.ts`, workers `packs.py` (`PackRequiredError`), `agent/ollama_client.py` y
  `style/infer.py` usan el nombre de la pestaña (`PACKS_PATH_ES`).
- **ETA de la exportación (M1 → M3)**: `exportProject` pasa los bloques como ítems
  (`done/total`, `unit:"blocks"`, total = bloques + 1 paso final de audio y unión) además de
  `stage_es`; la ETA usa la fórmula por ítems. Aserción nueva en `segment-cache.integration.test.ts`.
- **Rol de pista de la Biblioteca y «Bajar la música» (M3 → M2)**: `addAssetClip(asset, {role})`
  manda el sonido a una pista de audio con ese rol (o a una vacía sin rol, o a una nueva) y le pone
  `role` en el mismo paso de deshacer (antes caía en la primera pista de audio, la de la voz);
  `LibraryPanel` pasa `libraryRole(item.kind)`. `project-store.setAudioMix` guarda
  `project.audioMix.autoDuck` y Exportar lo lee/escribe ahí (antes era estado local del panel y
  se perdía). Tests en `project-store.test.ts`.
- **Pregunta de encuadre repetida (M3 → M1)**: el Asistente ya no muestra la línea `unresolved`
  «Operación N: El video es horizontal…» cuando la misma pregunta está como botones de
  `PlanChoices`. Test en `export-sprint5.test.tsx`.
- **Planner (pedido de M3 a workers)**: `system_es.md` dice que sin destino claro el export es
  `reels-tiktok` (decisión 9:16 principal; la regla directa ya lo hacía con «Reels/TikTok»).
- **`snapping` y `S`/`Supr` (M2)**: revisados M1/M3 y sus pasos de e2e/ui-smoke; nadie usaba el
  `snapping` viejo del project-store ni dependía de que `Supr` borrara un solo clip.
- **`ExportPanel.tsx:590` (`SocialReview lastExport`)**: ya tipado en M3 (`lastExport?: Job`);
  `tsc` limpio.
- **Seguridad**: `POST /api/system/reveal` además compara con `realpath` (un link dentro de
  `exports/` que apunte afuera → 400). Test nuevo (no corre en Windows: crear links pide permisos).
- **Pytest dependiente del orden**: el planner cachea el pool de few-shot (`few_shot_pool`,
  `lru_cache`); `test_agent_eval.py` lo llenaba con un dataset temporal de 4 ejemplos y
  `test_agent_api.py::test_plan_with_api_json_summary…` veía 1 ejemplo similar en vez de 2. Un
  fixture `autouse` de `conftest.py` limpia esos caches antes y después de cada test (sin skip).
- **UI smoke «Proyectos»**: nombres con un sufijo único por corrida (`S5 UI uno <tag>`), así un
  storage reusado no tiene dos filas con el mismo nombre.
- **Docs**: manual §3 (`start.cmd` como forma principal y la franja), §4.1 cabecera, §4.2 paneles
  (Exportar, Trabajos, Propiedades en lote, Línea de tiempo), distribución y vista previa vacía,
  línea de tiempo (selección, ripple, Q/W, I/O, imán), §4.4 «Proyectos y guardado», §5 flujo 1
  (pasos nuevos), flujo 2 y 3 (ducking automático), flujo 6, flujo 7 y **flujo 8 nuevo** «Reels
  desde un video horizontal», §6.2, §10 (tabla completa), §12 (filas nuevas), §15, §17.7 (filas
  Sonoridad/Formato), **§17.9 nuevo** «Sonido al exportar», §19.2/§19.4/§19.5; `index.html` a mano y
  PDF regenerado; `ARQUITECTURA.md` (§2 rutas y Sprint 5, §3 tareas cancelables, §4 progreso,
  cancelar y avisos, §5 audio aparte, §5.5 web); `CLAUDE.md` (`studio_export aspectFit`, `added`/
  `choices`, ruta `choose`, flujo Reels sin `reframe` a mano). `.env.example` sin cambios: las únicas
  variables nuevas son del mock e2e (`STUDIO_MOCK_AGENT_EVAL*`).

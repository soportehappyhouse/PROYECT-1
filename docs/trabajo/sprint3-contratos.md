# Sprint 3 — Contratos acordados (Fase D: agente local de edición por comandos)

Decisión 8 del usuario: **solo local, sin API key**. Claude (esta cuenta) produce instrucciones, esquema y dataset; el modelo local solo propone un `EditPlan` JSON; la API lo valida; el usuario confirma antes de aplicar. Lo determinista NUNCA pasa por el LLM.
Referencia: `docs/INVESTIGACION-IA-LOCAL.md` §9. Hardware: RTX 4050 6 GB → modelos Q4 de ≤ 8B.

## Runtime LLM
- **Ollama** (MIT) instalado por `setup.ps1` (winget `Ollama.Ollama`) y verificado por `doctor.ps1`; servicio en `http://127.0.0.1:11434`.
- Pack `agent-llm`: modelo por defecto `qwen3:8b` (Apache-2.0, ~5 GB Q4_K_M); alternativa `hermes3:8b` (Llama 3.1 Community License, uso personal OK). Descarga vía API de Ollama (`/api/pull`) con progreso, registrada en el manifiesto. Modelo chico para CI/sandbox: `qwen3:0.6b`.
- Presupuesto GPU (en los dos sentidos): antes de invocar al LLM se descarga el modelo residente de visión/whisper (`GpuBudget.make_room`); y al cargar Whisper/visión, si la VRAM libre no alcanza, `GpuBudget.acquire` descarga primero los modelos de Ollama (`/api/ps` → `keep_alive: 0`) y recién si sigue sin alcanzar pasa a CPU. `keep_alive` 60 s (`AGENT_KEEP_ALIVE`), `num_ctx` 4096 (`AGENT_NUM_CTX`).

## EditPlan (packages/shared/src/agent.ts — fuente única; los workers validan con el mismo JSON Schema exportado a `apps/workers/studio_workers/agent/editplan.schema.json` por un script `pnpm --filter @studio/shared export-schemas`)
```
EditPlan = { version: 1, summary_es: string, ops: EditOp[], questions?: string[] /* el agente pregunta en vez de adivinar */ }
EditOp (discriminada por `op`), todos con `confirm?: boolean` (default true) y `note_es?: string`:
  cut_silences        { clip?: ClipRef, min_silence_ms?, padding_ms?, fillers?: boolean }
  detect_scenes       { clip?: ClipRef, split?: boolean }
  split               { clip: ClipRef, t: Time }
  trim                { clip: ClipRef, in?: Time, out?: Time }
  delete_clip         { clip: ClipRef }                                   // confirm siempre
  set_speed           { clip: ClipRef, speed: number }
  add_text            { text: string, t: Time, duration_s?: number, style?: TextStyle, position?: Anchor }
  add_motion          { template: TemplateId, t: Time, duration_s?: number, params?: object, follow?: ClipRef|"face" }
  add_captions        { clip?: ClipRef, style?: CaptionStyleId, animated?: boolean, language?: "es" }
  transcribe          { clip?: ClipRef }
  tts                 { text: string, voice?: VoiceId, t: Time, effect?: VoiceEffectId }
  voice_effect        { clip: ClipRef, effect: VoiceEffectId }
  denoise             { clip: ClipRef }
  add_audio           { query?: string, asset?: AssetRef, t: Time, volume_db?: number, duck?: boolean }
  remove_background   { clip: ClipRef, background: {type:"color"|"image"|"video"|"blur", value?} }
  reframe             { target: "9:16"|"1:1"|"4:5", subject?: "face"|"center" }
  set_canvas          { preset: "16:9"|"9:16"|"1:1" | {w,h} }
  set_publish         { for_social: boolean, flags?: {...}, ai_label?: boolean }
  export              { preset: PresetId, name?: string, burn_subtitles?: boolean }      // confirm siempre
  report_bug          { title: string, steps_es: string }
ClipRef = { id?: string, name?: string, index?: number, track?: TrackKind, at?: Time }   // la API resuelve a id; ambigüedad → `questions`
Time = number (s) | "start" | "end" | "cursor" | { scene: number } | { after_clip: ClipRef }
```
Respuesta de validación: `{ ok, plan, resolved: EditOp[] con ids, preview_es: string[] (una línea por op), risks: string[], unresolved: string[] }`.

## Workers (`apps/workers/studio_workers/agent/`)
- `GET /agent/status` → `{ollama: bool, model: string|null, models_installed: string[], ready: bool, gpu_mode}`.
- `POST /agent/plan {command, project_summary, settings:{model?, temperature?: 0.2}}` → `{plan: EditPlan, model, latency_ms, attempts, warnings, route: "deterministic"|"llm"}`.
  - **Enrutador determinista primero**: patrones en español para comandos simples e inequívocos (p. ej. "exportá para reels", "cortá los silencios", "transcribí", "reencuadrá a 9:16", "poné el lienzo vertical", "detectá escenas") → EditPlan sin LLM. Lista y tests en `router.py`.
  - LLM: prompt de sistema en español rioplatense (`prompts/system_es.md`), resumen del proyecto compacto (≤ 1500 tokens: lienzo, pistas, clips con id/nombre/duración, escenas, assets, 10 primeras líneas de transcripción, cursor), salida con `format` = JSON Schema (Ollama structured outputs); hasta 3 intentos realimentando errores de validación; `questions` cuando falta un dato (nunca inventar ids ni tiempos).
- `POST /agent/eval {models?: string[], dataset?: "golden"|"all"}` → task; resultado `storage/run/agent-eval.json`: por modelo `{valid_json_rate, schema_valid_rate, exact_ops_rate, semantic_rate (ops+args clave), p50_latency_ms, failures:[...]}`.
- `POST /agent/bugreport {title?, steps_text, breadcrumbs, errors, env}` → `{markdown_es}` (LLM; si no hay modelo, plantilla determinista).
- Dataset: `apps/workers/studio_workers/agent/dataset/{train.jsonl, golden.jsonl}` con `{command, project_summary, plan}`; ≥ 200 entrenamiento + 50 golden (criterio 4: ≥ 90 % semantic_rate en golden con el modelo por defecto). Generado por Claude en esta cuenta; `eval.py` también sirve para LoRA futura (fuera de alcance).

## API (`apps/api`)
- `POST /api/agent/plan {command}` → llama a workers con `project_summary` generado por la API (`services/agent/summary.ts`), valida con zod, resuelve `ClipRef`/`Time`, produce `preview_es`, `risks` (delete/export/sobrescritura/pack faltante), guarda `AgentPlan {id, command, plan, resolved, created_at, status: proposed|applied|rejected}` en SQLite.
- `POST /api/agent/apply {planId, ops?: index[] /* subconjunto confirmado */}` → job `agent.apply` (lane edit): snapshot de undo del proyecto, ejecuta ops en orden mapeando a lo existente (timeline-edit, jobs de IA, export), espera a cada job, se detiene en el primer error, resultado `{applied: n, failed?: {index, error}, undoSnapshotId}`; progreso por SSE.
- `GET /api/agent/plans`, `POST /api/agent/plans/:id/reject`, `GET /api/agent/status` (proxy + packs), `POST /api/agent/bugreport` (proxy; integra con el canal de reportes existente: agrega el markdown al `reporte.md`).
- Pack `agent-llm` gestionado por el sistema de packs (`PACK_REQUIRED` con instrucciones de Ollama si falta el servicio).

## Web (`apps/web`)
- Panel **Asistente** (dockview, atajo `Ctrl+Shift+A` y entrada en paleta): campo de comando con historial, estado del modelo (local, nombre, latencia), botón Proponer → lista de ops con descripción en español, casilla por op, parámetros clave editables inline, riesgos en rojo, `questions` como formulario breve que re-envía; **Aplicar** → progreso por op, **Deshacer todo**; historial de planes.
- Ajustes → "Asistente local": modelo (qwen3:8b / hermes3:8b / instalado), temperatura, botón "Evaluar modelos" con tabla de resultados.
- Diálogo de reporte de errores: botón "Redactar con IA" → `/api/agent/bugreport` rellena pasos/esperado/pasó.
- Sin envío a ningún servicio externo: badge "100 % local".

## Criterios (plan v2, sprint 3)
≥ 90 % de los 50 comandos golden producen un EditPlan válido y correcto sin API externa (medido por `/agent/eval` con el modelo por defecto en la PC del usuario; en CI con mock + validación de esquema).

## Cambios en integración (2026-10-06)

- **`edited_ops`** (`POST /api/agent/apply`): `{planId, ops?, edited_ops?: EditOp[] (mismo largo que plan.ops), cursor?}`. La api valida cada op con `EditOpSchema` (400 `PLAN_INVALID` con la ruta en español), vuelve a resolver contra el proyecto actual (`preview_es`, `risks`, `unresolved`), lo guarda como ops finales del plan (`edited: true`) y recién después encola; responde `{jobId, plan}` (409 `PLAN_UNRESOLVED` trae `details.plan`). La web adopta ese registro y muestra la vista previa re-resuelta.
- **`project_summary`** = forma JSON del dataset `{canvas:{w,h,fps}, cursor_s, tracks:[{kind, clips:[{id,name,start,end}]}], scenes?:[{n,start}], assets?:[{id,name,kind}], transcript_excerpt?:[{start,end,text}]}` (`AgentProjectSummarySchema` en shared, `.strict()`). La api la arma (≤ 6000 caracteres serializada: recorta transcripción → assets sin usar → assets → escenas → clips) y los workers la pegan con `summary.as_text` (JSON compacto, igual que los few-shot). El renderizador de texto de la api se quitó (nadie más lo usaba); los workers todavía leen el formato de texto viejo.
- **Ops nuevas** (22 en total): `set_volume {clip, volume_db: -60..12}` (≤ -60 = silenciado; `timeline-edit.setClipVolume`) y `move_clip {clip, t}` (`timeline-edit.moveClip`: misma pista si está libre, si no la primera libre del mismo tipo o una nueva). Reglas deterministas «bajá / subí / silenciá la música [a N dB]» y «mové / llevá / pasá el texto | la música al segundo N | 1:20 | inicio | cursor». 6 ejemplos nuevos (2 golden multi-op con typos, 4 train) + 2 de train corregidos (antes «fuera de alcance»); 2 golden (g030, g031) pasaron a train para mantener 50 y la cobertura.
- **Catálogos**: `CAPTION_STYLE_IDS` vive en `subtitles.ts` junto a `CAPTION_STYLE_PRESETS` (la web usa esos objetos; el validador lee de ahí). Efectos `monstruo`, `catedral`, `bajo-agua`, `megafono` pasaron de la web a `VOICE_EFFECT_PRESETS` (shared) y a `VOICE_EFFECT_IDS`. `duration_s` máx. 3600.
- **Config**: `OLLAMA_URL`, `AGENT_MODEL`, `AGENT_TEMPERATURE` en `.env.example`; la api los lee (`config.agent`) y manda `settings {model, temperature}` por defecto; los workers usan `agent_temperature` cuando el pedido no trae una (también en bugreport).
- **Bugreport**: `model?` opcional en `/api/agent/bugreport` y `/agent/bugreport`; la api respeta `source: "template"` de los workers (antes lo marcaba `llm`).
- **RVM** (docs/trabajo/perf-rvm.md): `bench.py` agrega `rvm_steady_fps`, `rvm_startup_s`, `rvm_bottleneck`, `rvm_stage_ms`, `rvm_alpha_codec` (en `PerfResultSchema`); `/vision/matte` devuelve `alpha_path` del archivo escrito + `alpha_codec` y `timings`; la web muestra «≈ X fps sostenido (arranque Y s) · meta 15» y estima 1 min con arranque + sostenido.

## Auditoría Sprint 3 (2026-10-06)

- **GPU en los dos sentidos**: `GpuBudget(external_release=services.release_ollama)`; `acquire` sin VRAM suficiente → `OllamaClient.unload_loaded_sync()` (cada modelo de `/api/ps` con `keep_alive: 0`) → vuelve a medir → CUDA o CPU. `make_room` nunca descarga Ollama. Plan/eval/bugreport mandan `keep_alive` = `AGENT_KEEP_ALIVE` (60 s por defecto).
- **Entrar en 6 GB**: `num_ctx` 4096 (`AGENT_NUM_CTX`); de los 8 pares de `fewshot_es.jsonl` el planner elige 4 por diversidad (ops distintas; «preguntar en vez de adivinar» pesa doble) + 2 parecidos de train; resumen ≤ 4000 caracteres (api y workers). El tamaño del prompt se estima (caracteres / 3,5 + 6 por mensaje), se loguea junto al `prompt_eval_count` de Ollama y vuelve como `prompt_tokens` en `/agent/plan`; si no deja 700 tokens de salida se avisa `prompt_near_ctx`. Si Ollama igual rechaza el prompt por largo (0.35: 400 `exceed_context_size_error`, el tokenizador real cuenta más), el planner saca pares de ejemplo de a uno y reintenta (`prompt_trimmed`); sin ejemplos y todavía largo → plan de respaldo con pregunta (`prompt_over_ctx:<n>`). En `eval`, un error de Ollama cuenta como ejemplo fallido, no corta la corrida. `/agent/status` y `/api/agent/status` agregan `loaded` (`/api/ps`): la web muestra «Cargando modelo…» mientras la primera llamada carga el modelo.
- **Primera instalación**: el `PACK_REQUIRED` de `agent-llm` trae los comandos exactos: si `/api/version` no responde, «abrí Ollama desde el menú Inicio (bandeja del sistema)» + `winget install Ollama.Ollama`; si responde, «Ollama X está corriendo, pero falta el modelo» + `` `ollama pull <AGENT_MODEL>` ``; ambos con `scripts\windows\doctor.cmd`. El nombre del paquete sigue a `AGENT_MODEL`: «Asistente local (Ollama + Qwen3 8B | Hermes 3 8B | <tag>)».
- **Control de calidad del plan** (resolver de la api): tiempo > duración del proyecto + 2 s, texto/gráfico que terminaría después de 3600 s, `set_speed` fuera de ×0,1–×8 y `trim` con inicio ≥ final → `unresolved` con pregunta (nunca se aplican). Golden: 80 ejemplos (+30 con ops, rioplatense, cada op ≥ 3 veces); `eval` agrega `semantic_rate_ops_only` (y `n_ops`): el acierto solo entre los ejemplos con ops.
- **Acciones destructivas**: la web deja `delete_clip` y `export` sin marcar y pide un clic aparte «Confirmar borrado/exportación» antes de «Aplicar». `POST /api/agent/apply` agrega `confirmedIndexes?: number[]`: toda op delete/export que se aplicaría y no está ahí → 409 `CONFIRM_REQUIRED` (`details.indexes`).
- **Deshacer**: agent.apply guarda `postApplyHash` (sha256 del contenido del proyecto sin `updatedAt`) y `postApplyUpdatedAt`. `POST /api/agent/plans/:id/undo {undoSnapshotId?, force?}`: si el proyecto cambió desde entonces → 409 `PROJECT_CHANGED` salvo `force: true` (la web: «El proyecto cambió después; ¿restaurar igual?»). Deshacer restaura solo el proyecto: **no borra** los archivos exportados ni los medios que creó el plan (audios TTS, fondos, etc.).
- **`OLLAMA_URL` seguro**: los workers rechazan un `OLLAMA_URL` que no sea loopback (127.0.0.0/8, ::1, localhost) salvo `AGENT_ALLOW_REMOTE_OLLAMA=true` (403 `OLLAMA_REMOTE_REFUSED`; el estado lo explica; `GET /packs` lo ve como servicio ausente; el bugreport cae a plantilla). Las rutas deterministas siguen andando.
- **Licencias**: Ollama (MIT), Qwen3 (Apache-2.0), Hermes 3 (Llama 3.1 Community License, aviso «Built with Llama» en Ajustes cuando está elegido) en `fuentes.md`.

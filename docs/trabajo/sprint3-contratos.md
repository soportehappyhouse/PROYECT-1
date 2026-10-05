# Sprint 3 — Contratos acordados (Fase D: agente local de edición por comandos)

Decisión 8 del usuario: **solo local, sin API key**. Claude (esta cuenta) produce instrucciones, esquema y dataset; el modelo local solo propone un `EditPlan` JSON; la API lo valida; el usuario confirma antes de aplicar. Lo determinista NUNCA pasa por el LLM.
Referencia: `docs/INVESTIGACION-IA-LOCAL.md` §9. Hardware: RTX 4050 6 GB → modelos Q4 de ≤ 8B.

## Runtime LLM
- **Ollama** (MIT) instalado por `setup.ps1` (winget `Ollama.Ollama`) y verificado por `doctor.ps1`; servicio en `http://127.0.0.1:11434`.
- Pack `agent-llm`: modelo por defecto `qwen3:8b` (Apache-2.0, ~5 GB Q4_K_M); alternativa `hermes3:8b` (Llama 3.1 Community License, uso personal OK). Descarga vía API de Ollama (`/api/pull`) con progreso, registrada en el manifiesto. Modelo chico para CI/sandbox: `qwen3:0.6b`.
- Presupuesto GPU: antes de invocar al LLM se descarga el modelo residente de visión/whisper (gpu.py); Ollama gestiona su propia VRAM; `keep_alive` 5 min.

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

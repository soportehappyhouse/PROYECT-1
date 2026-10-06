# Integración Sprint 3 — 2026-10-06

Rama `claude/funny-mccarthy-0bbdt6`. Stack real en el sandbox (Linux, 4 vCPU, sin GPU): api `:3001` (`node dist/index.js`, `STORAGE_DIR` temporal), workers `:8001` con `scripts/e2e/workers-with-mocks.py` (agente **real**: router + Ollama), web `next build` + `next start`, Playwright Chromium. **Ollama 0.35.1 real** con un modelo diminuto fabricado localmente (`studio-tiny`, 86 K parámetros; el registro de Ollama está bloqueado): sirve para la plomería, no para medir calidad.

## Qué se reconcilió

- **Ediciones inline perdidas**: la api ignoraba `edited_ops`. Ahora los valida, re-resuelve, guarda como ops finales y responde `{jobId, plan}`; la web muestra la vista previa nueva (detalle en `sprint3-contratos.md`, «Cambios en integración»).
- **`project_summary`**: la api mandaba texto y dataset/workers usan JSON. Ahora la api manda la forma del dataset (≤ 1500 tokens) y los workers la renderizan con `summary.as_text`.
- **Esquema**: `CAPTION_STYLE_IDS` única (shared ← web), 4 efectos de voz llevados a shared, `duration_s` ≤ 3600, ops `set_volume` y `move_clip` de punta a punta (shared, router, resolver, `timeline-edit`, web, dataset, validador). JSON Schema re-exportado; `validate-dataset.py` OK (train 255, golden 50, few-shot 8).
- **Few-shot**: test que confirma que `prompts/fewshot_es.jsonl` (8 pares) entra al prompt del endpoint real.
- **Config**: `OLLAMA_URL` / `AGENT_MODEL` / `AGENT_TEMPERATURE` documentados y leídos igual por api y workers.
- **Bugreport**: la api decía `source: "llm"` aunque los workers usaran su plantilla; `model?` opcional.
- **RVM** (pedido extra, `perf-rvm.md`): `rvm_steady_fps` / `rvm_startup_s` en el test de rendimiento, `alpha_path`/`alpha_codec`/`timings` en `/vision/matte`, etiqueta web «≈ X fps sostenido (arranque Y s)». `test_vision_rvm_pipeline.py` corre en pytest (1 skip: sin torch).
- **Formato**: `dataset/README.md` y `system_es.md` pasan prettier (solo líneas en blanco en el prompt; el texto queda igual).

## Resultados

- `run-e2e.mjs` con `AGENT_MODEL=studio-tiny`: **48/48 obligatorios** (386 s; +6 de Sprint 3: «exportá para reels» determinista → export 1080×1920; `edited_ops` → vista previa re-resuelta → apply → undo; PACK_REQUIRED con modelo inexistente + bugreport plantilla; ruta LLM api → workers → Ollama → plan válido; bugreport con LLM; `/api/agent/eval` golden → `agent-eval.json`). 2 SKIP (`--hw`, descargas), 2 expected-fail (Whisper/Piper sin modelos). Sin `AGENT_MODEL` los 3 pasos LLM se saltean con motivo.
- `ui-smoke.mjs --vp9-preview`: **29/29** (los 2 pasos web del Asistente ahora contra la api real + formulario de preguntas + diálogo «Paquete requerido» con la ayuda de Ollama).
- Desde cero: `pnpm install --frozen-lockfile`, `build:packages`, `lint`, `format:check`, `-r typecheck`, `-r build`, `-r test` (shared 52, motion-engines 22, remotion 55+1 skip, web 148, api 184+1 skip) OK; workers ruff OK, pytest **274 passed, 3 skipped** (Ollama real sin `qwen3:0.6b`, torch); con Ollama apagado los tests de Ollama real se omiten limpio. Los 7 `.ps1` parsean; `ci.yml` válido; búsqueda de secretos vacía.

## Mediciones con `studio-tiny` (solo plomería)

Eval golden: schema_valid 100 %, semantic 34 % (4 por router; el resto el modelo responde solo preguntas), p50 423 ms, 21 s en total. Plan LLM ≈ 0,5–0,7 s, 1 intento. Con `AGENT_MODEL` inexistente: estado «Falta el modelo», 409 `PACK_REQUIRED` con la ayuda de Ollama, el router determinista sigue funcionando y el bugreport cae a plantilla.

## Pendiente

- Criterio 4 (≥ 90 % semántico en golden) solo medible en la PC con `qwen3:8b` («Evaluar modelos»).
- `studio-tiny` siempre propone solo preguntas: el apply de un plan **LLM** con ops no se ejerció acá (sí el de planes deterministas y simulados).
- El nombre del paquete `agent-llm` dice «Qwen3 8B» aunque `AGENT_MODEL` sea otro (el mensaje sí nombra el modelo).

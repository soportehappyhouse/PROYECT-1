# Módulo sprint 3 — workers (agente local)

Contrato: `docs/trabajo/sprint3-contratos.md`. Código en `apps/workers/studio_workers/agent/` + `routers/agent.py`.

- **`ollama_client.py`**: cliente async (`/api/version`, `/api/tags`, `/api/pull` NDJSON con progreso por capa, `/api/chat` con `format` = JSON Schema, `options` temperature/num_ctx 8192, `keep_alive` 5m, `think:false` solo en qwen3). Errores en español: `OllamaUnavailableError` («Ollama no está corriendo…», 503), modelo faltante (404 → «ollama pull X»), timeout (504), pull sin registro.
- **Pack `agent-llm`** (`packs.py`): `ollama_models` = `AGENT_MODEL` (qwen3:8b; hermes3:8b; qwen3:0.6b CI). Instalado = servicio arriba + modelo en `/api/tags` (timeout 1 s). Descarga = `/api/pull` en la cola de paquetes; queda en `models/manifest.json`. `--packs all` lo omite si Ollama no responde.
- **`router.py`**: reglas deterministas de frase completa (exportar reels/tiktok/shorts/youtube/4k/gif/transparencia, silencios, muletillas, transcribir, subtítulos [animados|simples|estilo], reencuadre, lienzo, escenas [+dividir], limpiar audio, quitar/desenfocar fondo, etiqueta IA on/off) + cadenas con «y / , / después». Lo que sobra («del segundo clip», «no …», colores) va al LLM. Clip obligatorio: un solo candidato → `{name}`; varios → `questions`; resumen ilegible → LLM. Coincide 100 % semántico con los 22 comandos del dataset que enruta.
- **`planner.py`**: system_es.md + 8 pares fijos de `prompts/fewshot_es.jsonl` + 3 similares de `train.jsonl` (nunca el comando evaluado) + resumen (≤ 6000 car.). Valida con jsonschema (`schema.py`, más la regla «ops o questions»), ≤ 3 intentos realimentando errores; ids no presentes en el resumen se quitan y, si la referencia queda vacía, la op pasa a `questions`. Tras 3 fallos: plan con pregunta + warning `llm_invalid_plan`.
- **GPU**: `GpuBudget.make_room(5500)` antes de cada llamada al LLM (plan y bugreport) libera Whisper/visión si quedan < 5,5 GB (warning `gpu_released:<modelo>`).
- **`summary.py`**: lee el texto de `apps/api/.../summary.ts` (líneas `- V1 video …` / `  1. id=…`) y el JSON del dataset.

## Endpoints

- `GET /agent/status` → contrato + aditivos `ollama_version, ollama_url, default_model, alt_models, pack_id, hint_es`.
- `POST /agent/plan` → `{plan, model, latency_ms, attempts, warnings, route}`; sin Ollama/modelo y sin ruta determinista → 409 `PACK_REQUIRED` (`agent-llm`) con el detalle de Ollama.
- `POST /agent/eval {models?, dataset?: golden|all, use_router?, limit?}` → `{task_id}`; `GET /agent/tasks/{id}`, `GET /agent/eval/last`. Archivo `storage/run/agent-eval.json`: `{generated, dataset, n, criterion_semantic_rate: 0.9, use_router, models: {<modelo>: {valid_json_rate, schema_valid_rate, exact_ops_rate, semantic_rate, p50_latency_ms, mean_attempts, routes, failures[≤50]}}}`; modelo no disponible → `{available: false, error}`.
- `POST /agent/bugreport` → `{markdown_es, source: llm|template, model?|warning?}`; encabezados fijos «Pasos para reproducir / Qué esperaba / Qué pasó / Errores registrados / Últimas acciones / Entorno».

## Instalador

`setup.ps1`: paso Ollama (winget `Ollama.Ollama`, idempotente, inicia `ollama app.exe`/`ollama serve` si no responde, `-SkipOllama`; fallo = warn). `doctor.ps1`: sección «Asistente local (Ollama)» con versión, modelos y `AGENT_MODEL`. Helpers en `common.ps1` (ASCII). `INSTALACION-WINDOWS.md`: opción y sección nuevas.

## Pruebas

ruff OK; pytest 250 passed + 2 skip (78 de router, planner con Ollama simulado, eval, bugreport, pack, endpoints). **Sí hubo corrida con Ollama real** (0.35.1, binario de GitHub en el sandbox): `/api/tags`, errores 404 y pull reales, y structured outputs con el esquema completo. `registry.ollama.ai`/Hugging Face bloqueados → no se pudo bajar `qwen3:0.6b`; se usó un GGUF llama de 86 K parámetros fabricado localmente (`studio-tiny`): Ollama aplicó la gramática y devolvió un EditPlan válido; `POST /agent/plan`, `/agent/eval` y los tests `test_agent_ollama_real.py` (`AGENT_TEST_MODEL=studio-tiny`) pasaron. La calidad (criterio 4, ≥ 90 % en golden) queda para medir en la PC con `qwen3:8b`.

Pendientes: dependencia nueva `jsonschema` (setup `-Update` la instala por requirements); `.env.example` sin `AGENT_MODEL`/`OLLAMA_URL` (dueño raíz); `dataset/README.md` y `system_es.md` fallan `prettier --check`.

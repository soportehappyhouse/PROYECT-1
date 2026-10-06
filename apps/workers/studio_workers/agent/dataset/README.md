# Dataset del asistente local de edición

Ejemplos `pedido en español → EditPlan` para el agente local (Fase D, sprint 3; contrato en
`docs/trabajo/sprint3-contratos.md`, esquema en `packages/shared/src/agent.ts`).

| Archivo                       | Líneas | Para qué                                                                    |
| ----------------------------- | ------ | --------------------------------------------------------------------------- |
| `train.jsonl`                 | ≥ 200  | Pool de few-shot del planner (`planner.pick_examples`) y futura LoRA.       |
| `golden.jsonl`                | 80     | Evaluación (`POST /agent/eval`, criterio 4: ≥ 90 % `semantic_rate`).        |
| `../prompts/system_es.md`     | —      | Prompt de sistema (≤ 900 tokens del tokenizador de Qwen).                   |
| `../prompts/fewshot_es.jsonl` | 8      | Pares fijos cortos `{command, project_summary, plan}` para pegar al prompt. |

## Formato de cada línea

```json
{"id": "g001", "command": "…", "project_summary": {…}, "plan": {EditPlan}, "tags": ["…"]}
```

- `project_summary`: `{canvas, cursor_s, tracks, scenes?, assets?, transcript_excerpt?}` con
  `canvas = {w, h, fps}`, `tracks = [{kind, clips: [{id, name, start, end}]}]`,
  `scenes = [{n, start}]`, `assets = [{id, name, kind}]` y
  `transcript_excerpt = [{start, end, text}]`.
  La API manda este mismo JSON (`apps/api/src/services/agent/summary.ts`, ≤ 4000 caracteres ≈ 1150 tokens) y los
  workers lo pegan en el prompt con `summary.as_text()` (JSON compacto).
- `plan`: un `EditPlan` válido contra `apps/workers/studio_workers/agent/editplan.schema.json`.
- `tags`: etiquetas a mano (`ambiguo`, `fuera_de_alcance`, `typo`, `reels`, `subtitulos`, …) más
  etiquetas derivadas del plan (`op:<op>`, `time:<forma>`, `ref:<campo>`, `multi_op`, `questions`,
  `only_questions`).
- `golden.jsonl` y `train.jsonl` no comparten comandos (lo verifica el validador).

## Cómo se produjo

Claude (esta cuenta) escribió cada ejemplo a mano sobre 19 proyectos tipo (entrevista, video de
WhatsApp vertical en lienzo 16:9, vlog de 4 clips, tutorial con dos pistas de video y escenas,
podcast, receta 9:16, promo con escenas y pantalla final, charla de 1 h, proyecto vacío, partida
con webcam, dos cámaras con rótulo, boda, unboxing con subtítulos animados, documental con
locución, testimonio 1:1, fitness, selfie de tips, video musical, clases). El vocabulario sale del
manual (`docs/manual/MANUAL-USUARIO.md`) y del feedback del usuario (`docs/trabajo/feedback-usuario-2026-10-05.md`):
voseo rioplatense, errores de tipeo ("q", "pa", "d"), Reels/TikTok/Shorts/YouTube, rótulos,
silencios y muletillas, escenas, voz, TTS, música con ducking, quitar fondo, reencuadre, lienzo,
etiqueta de IA, exportar y "reportá este error". Los ids válidos (plantillas, estilos de
subtítulos, efectos, voces, presets) son los del código, no inventados.

Convenciones que siguen todos los planes (y que el prompt enseña):

- **ClipRef**: `name` si el usuario nombra el clip o archivo; `index` + `track` para "el primero /
  el último" (`-1` = último); `at` + `track` para "este clip" / "acá" / "el que está en el 1:40";
  `id` solo si el usuario lo cita. Cada ClipRef resuelve a **un** clip del resumen; si hay varios
  candidatos el plan pregunta.
- **Time**: segundos (`1:30` → `90`); `start`, `end`, `cursor`, `{scene: n}`, `{after_clip: ClipRef}`.
  `trim.in/out` y `split.t` son tiempos de la línea de tiempo (por eso "sacale 5 s al brindis" que
  arranca en 160 da `in: 165`).
- Ops con clip opcional (`cut_silences`, `detect_scenes`, `add_captions`, `transcribe`) omiten
  `clip` cuando el pedido se refiere al video principal.
- `delete_clip` y `export` llevan siempre `"confirm": true`; el resto usa el valor por defecto.
- "De fondo" / "bajita" / "bajá la música" = `volume_db: -12`; "silenciá" = `set_volume` con
  `volume_db: -60`; "que baje cuando hablo" = `duck: true`.
- `set_volume` cambia el volumen de un clip que ya está; `move_clip` cambia su inicio (`t`).
- `add_captions`: `style` solo si el usuario lo pide; `animated: true` para palabra a palabra,
  TikTok, reels o karaoke.
- "Título" → `title-card`; "rótulo / lower third" → `lower-third`; "texto / cartel" → `add_text`.
- **Preguntas**: `ops: []` + `questions` cuando falta un dato (clip, momento, texto) o hay varios
  candidatos; ops claras + `questions` cuando solo falta una parte. **Fuera de alcance** (cambio de
  cara, publicar en redes, color/LUT, estabilizar, traducir…): `ops: []` y una pregunta que explica qué no se puede y ofrece una alternativa real.

## Cómo extenderlo

1. Agregá líneas al final de `train.jsonl` (o reemplazá alguna de `golden.jsonl`, que debe seguir
   teniendo 80) con un `id` nuevo (`t###` / `g###`). Reusá un `project_summary` existente o armá
   uno chico y realista (ids tipo `clip_a1b2`, nombres de archivo reales).
2. Respetá las convenciones de arriba; nunca pongas en el plan ids, tiempos o archivos que no estén
   en el resumen o en el pedido.
3. Validá:

   ```powershell
   apps\workers\.venv\Scripts\python.exe scripts\agent\validate-dataset.py
   ```

   (`uv pip install --python apps\workers\.venv jsonschema` si falta). Valida contra el JSON
   Schema exportado (`pnpm --filter @studio/shared export-schemas`), resuelve cada ClipRef/Time
   contra el `project_summary` del ejemplo, comprueba plantillas y sus `params`, estilos de
   subtítulos, efectos, voces Piper y presets leyendo `packages/shared`, `packages/remotion` y el
   catálogo Piper, revisa la cobertura del golden (cada op ≥ 3, todas las formas de Time y
   ClipRef, ≥ 8 ambiguos, ≥ 5 multi-op, ≥ 5 con typos, ≥ 5 fuera de alcance) y muestra
   estadísticas por op y por tag. Sale con código ≠ 0 si hay errores.

4. Si cambia el esquema (op nueva, campo nuevo), actualizá `prompts/system_es.md` (el validador
   exige que nombre todas las ops), agregá ≥ 3 ejemplos golden y varios de train con la op nueva.

## Cómo lo usa la evaluación

`studio_workers/agent/eval.py` (`POST /agent/eval {models?, dataset: "golden"|"all"}`) pasa cada
`command` + `project_summary` por el mismo pipeline que `POST /agent/plan` (router determinista
primero, después el LLM con `system_es.md` + 4 de los 8 pares de `prompts/fewshot_es.jsonl`
elegidos por diversidad + 2 ejemplos de `train.jsonl` por solapamiento de palabras, excluyendo el
comando evaluado; `num_ctx` 4096) y compara con `plan`:

- `exact_ops_rate`: mismas ops con los mismos argumentos (ignora `confirm` / `note_es`);
- `semantic_rate`: misma secuencia de ops y mismos argumentos clave (`KEY_ARGS`: preset, target,
  template, tiempos con ±0,5 s, texto, referencia de clip…); un plan esperado solo con preguntas
  coincide con una respuesta solo con preguntas;
- `semantic_rate_ops_only`: lo mismo, solo sobre los ejemplos cuyo plan esperado tiene ops (`n_ops`;
  en golden, 30 de los 80 se agregaron con 2–3 ops para que cada op aparezca ≥ 3 veces): un modelo
  que solo pregunta no lo sube.

Resultado en `storage/run/agent-eval.json`. Meta: ≥ 90 % de `semantic_rate` en golden con
`qwen3:8b`. Las reglas del router (`router.py`) coinciden con los planes esperados en todos los
comandos que enruta.

## LoRA opcional (fuera de alcance de este sprint)

Si el few-shot no alcanza el 90 %, el siguiente paso es un ajuste fino liviano con estos datos:

- **Método**: QLoRA (base en 4 bits NF4, adaptadores LoRA r = 16, α = 32, dropout 0,05 sobre
  `q,k,v,o,gate,up,down`), 2–3 épocas sobre `train.jsonl` (+ variantes parafraseadas), formato
  chat: sistema = `system_es.md`, usuario = resumen + pedido, asistente = plan JSON (sin bloque de
  razonamiento). `golden.jsonl` queda **fuera** del entrenamiento para medir con `eval.py`.
- **Modelos**: Qwen3-4B (preferido para la PC del usuario) o Qwen3-8B.
- **VRAM estimada** (secuencia 1024–1536, batch 1, gradient checkpointing, Unsloth o PEFT +
  bitsandbytes): Qwen3-4B ≈ 5–7 GB (entra justo o no entra en la RTX 4050 de 6 GB; mejor una GPU
  de 8 GB+); Qwen3-8B ≈ 9–12 GB (necesita una GPU de 12–16 GB, p. ej. una T4/L4 alquilada o una
  RTX 3060 12 GB). En 6 GB solo es razonable entrenar el 4B con secuencias cortas.
- **Entrega**: fusionar el adaptador, convertir a GGUF Q4_K_M (`llama.cpp convert` + `quantize`)
  y registrarlo en Ollama con un `Modelfile` (`FROM ./studio-agent-q4.gguf`); después elegirlo en
  Ajustes → Asistente local y correr "Evaluar modelos".
- **Datos**: para LoRA conviene llegar a 1–2 mil ejemplos (parafrasear los comandos de train con
  más jerga y typos, variar proyectos); cada ejemplo nuevo pasa por `validate-dataset.py`.

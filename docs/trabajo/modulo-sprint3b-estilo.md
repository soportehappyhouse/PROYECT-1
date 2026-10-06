# Módulo Sprint 3b — Perfil de estilo (agente «estilo»)

Contrato: `sprint3b-contratos.md` §B. Manual: §20 (MD/HTML/PDF).

## Qué hay
- **Workers** `studio_workers/style/` + `routers/style.py`: `POST /style/analyze` (cola propia `style`, `GET /style/tasks/{id}`) y `POST /style/infer`. `video.py` (ffprobe, cortes con PySceneDetect si está el pack `scenes`, si no `select=gt(scene,0.3)` de FFmpeg; histograma; movimiento; hoja de contactos), `audio.py` (ebur128, silencedetect, envolvente RMS de 50 ms con `astats`, planitud con `aspectralstats`), `ocr.py` (RapidOCR sobre las 24 miniaturas), `infer.py` + `system_es.md` (Ollama, `format` = `stylepreset.schema.json`, 3 intentos con errores realimentados, imagen en `images`).
- **Packs** (bloque delimitado en `packs.py`): `ocr` (rapidocr-onnxruntime 1.4.4 `--no-deps` + pyclipper/shapely/onnxruntime CPU, Apache-2.0, ~30 MB) y `vision-llm` (Ollama `qwen2.5vl:3b`, Apache-2.0, ~3,2 GB; `STYLE_VISION_MODEL` lo cambia). 409 `PACK_REQUIRED` con «… o usá la Consola Claude».
- **Shared** `style.ts`: `StyleAnalysisSchema`, `StylePresetDraftSchema` (lo que produce el LLM/Claude, sin id) y `StylePresetSchema` (+`id`, `source {assetId, analysisId, analysis_path, via}`), `compileStylePreset(preset, project, {scenes})`, rutas `STYLE_API_ROUTES` / `WORKER_STYLE_ROUTES`. `export-schemas` escribe también `stylepreset.schema.json` (workers + `packages/shared/schemas`).
- **API**: `routes/style.ts`, `jobs/handlers/style.ts` (`style.analyze`, `style.infer`, lane workers), `services/style/{presets,workers}.ts`. Tabla `style_presets` con migración idempotente propia (`ensureStyleSchema`, no toca `MIGRATIONS`). `apply` compila, resuelve con `resolvePlan` y guarda un `AgentPlanRecord` (`route: deterministic`, `warnings: ["style_preset:<id>"]`).
- **Web**: `StylePanel.tsx` + `stores/style-store.ts`, panel `style` (dockview + paleta «IA local»). «Deducir con Consola Claude» dispara `studio:console:paste {text}`; «Aplicar» guarda el proyecto, llama a apply y abre el Asistente con `receivePlan`.

## Decisiones / desvíos
- Asset `analysis` nuevo en `MediaKindSchema` (thumbnail = hoja de contactos; MediaPanel lo trata como dato). Job types `style.analyze`/`style.infer` en `job.ts` + lanes/etiquetas.
- `compileStylePreset`: orden fijo set_canvas → cut_silences → detect_scenes (`split` si plano ≤ 3 s) → add_captions → add_motion título (t=0) → lower-third (2.ª escena o 2 s) → set_volume por clip de audio (≤ 4) → set_publish → export (`confirm`). No hay op de transición ni de keyframes de escala: van como `note_es` (≤ 300 car.). Sin clips con audio no hay cut_silences ni subtítulos.
- Heurísticas documentadas en los docstrings: movimiento = búsqueda de desplazamiento/escala sobre cuadros grises 40×22 a 3 fps (punch-in = escala 1,1–1,45 que explica el salto); voz = ventanas de 0,5 s con modulación ≥ 3,5 dB y planitud < 0,6 (o cobertura de la transcripción si existe); música = ventanas estables (< 3 dB) y tonales (planitud < 0,45) ≥ 30 % de las activas.
- drawtext usa Arial (`fontfile`) en Windows; si falla, hoja sin hora + aviso `contact_sheet_without_timestamps`.

## Medido (sandbox 4 vCPU, sin GPU)
- 1 min 1080p30 (3 planos + tono): **22,8 s** (cortes 0,1 · movimiento 8,5 · audio 7,5 · hoja 2,4 · resto 4,4). Criterio < 60 s ✔.
- RapidOCR real (instalado aparte): lee títulos quemados (score 0,99) pero junta palabras («MITITULOGRANDE»).
- e2e real (api + `workers-with-mocks.py`): 3 pasos nuevos `sprint3b: style…` PASS (análisis 4 planos + hoja 1300×1108; infer 409 sin qwen2.5vl; preset → plan propuesto → CONFIRM_REQUIRED → aplicar con exportación confirmada → 1080×1920).

## Pendiente / para integración
- `.env.example`: `STYLE_VISION_MODEL=qwen2.5vl:3b`, `STYLE_NUM_CTX=8192` (los lee el worker). `setup.ps1 -Full` baja los packs nuevos solo; nada más que instalar.
- `tests/test_packs.py::test_cli_packs` depende de que Ollama corra (los packs Ollama se omiten si no); `test_registry_matches_contract` necesita además `matting-hq` (agente recorte).
- Ops futuras: transición entre clips y punch-in con keyframes de escala.

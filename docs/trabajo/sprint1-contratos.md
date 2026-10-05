# Sprint 1 — Contratos acordados (base + Fase A)

Los tres módulos se desarrollan en paralelo contra estos contratos. Cambios → avisar al orquestador.

## Workers (FastAPI, apps/workers) — prefijo interno, solo los llama la api
- `GET /gpu/status` → `{cuda: bool, gpu_name, vram_total_mb, vram_free_mb, resident_model: string|null, mode: "gpu"|"cpu", sysmem_fallback: bool}`
- `POST /gpu/release` → libera el modelo residente.
- `GET /packs` → `[{id, name_es, description_es, size_bytes, installed: bool, partial: bool, files: [{name, size, present}], required_by: [feature_id], license, group}]`
- `POST /packs/{id}/download` → `{task_id}`; `GET /packs/tasks/{task_id}` → `{status: queued|running|done|error, progress: 0..1, bytes_done, bytes_total, current_file, error?}`. Descargas secuenciales (una a la vez), reanudables, verificadas, escriben `models/manifest.json`.
- `POST /analyze/scenes` `{path, threshold?: number, min_scene_len_s?: number}` → `{scenes: [{start, end, score}]}` (PySceneDetect ContentDetector; pack `scenes` = solo pip).
- `POST /analyze/silences` `{path, min_silence_ms?: 500, noise_db?: -35, padding_ms?: 120, fillers?: bool, transcript?: {words:[{w,s,e}]}}` → `{cuts: [{start, end, kind: "silence"|"filler", text?}], total_removed_s}` (FFmpeg silencedetect + palabras de Whisper; lista de muletillas rioplatenses: eh, este, o sea, digamos, viste, bueno, tipo, nada, ehh, mmm).
- `POST /audio/denoise` `{path, output_base}` → `{path}` (DeepFilterNet; pack `voz-limpia`).
- `POST /perf/run` → `{task_id}`; resultado en `storage/run/perf.json`: `{gpu, whisper_turbo_s_per_min, piper_s_per_100chars, rvc_s_per_min?, scenes_fps, cpu_fallback_ok, ran_at}`.
- Whisper: modelo por defecto `large-v3-turbo` float16 si CUDA y pack `whisper-turbo` instalado; si no, `WHISPER_MODEL` actual. `compute_type` auto.
- Gestor de GPU: un modelo residente; antes de cargar otro, descargar; si `vram_free < requerido` → CPU con `warning` en la respuesta (`{warnings: ["gpu_fallback_cpu"]}`).

## Paquetes (`apps/workers/studio_workers/packs.py` + `models/packs.json` generado)
| id | contenido | tamaño aprox | requerido por |
|---|---|---|---|
| core | whisper base + piper es_AR-daniela | ~0.3 GB | transcribir, tts |
| whisper-turbo | faster-whisper large-v3-turbo | ~1.6 GB | transcribir (GPU) |
| voces-es | 7 voces Piper restantes | ~0.5 GB | tts |
| rvc-base | hubert_base + rmvpe | ~0.4 GB | rvc |
| scenes | pyscenedetect (pip) | ~0.05 GB | escenas |
| voz-limpia | DeepFilterNet | ~0.2 GB | denoise |
(Fase B/C agregan: matting, sam2, reframe, facefusion, chatterbox.)
`setup.ps1 -Full` descarga todos en secuencia; por defecto solo `core`.

## API (Fastify, apps/api) — prefijo /api
- `GET /api/ai/gpu`, `POST /api/ai/gpu/release` (proxy).
- `GET /api/ai/packs`, `POST /api/ai/packs/:id/download` → crea job `packs.download` (lane workers) que sondea `/packs/tasks/{id}` y reporta progreso por SSE.
- Jobs nuevos: `analyze.scenes {assetId}` → guarda `scenes` en el asset y devuelve lista; `analyze.silences {projectId, clipId, options}` → devuelve `cuts` (no aplica); `timeline.apply-cuts {projectId, clipId, cuts}` → divide el clip y elimina tramos (server-side, devuelve proyecto); `audio.denoise {assetId}` → nuevo asset; `perf.run {}`.
- Error estándar cuando falta un pack: `409 PACK_REQUIRED {packId, name_es, size_bytes}`; la web abre el diálogo de descarga.
- **Render por bloques**: el export divide el timeline en segmentos en límites de clips (máx. 10 s), hash = inputs (ids+mtime+trim+efectos+posición) + preset + versión del compilador; cada segmento se renderiza a `storage/cache/segments/<hash>.mp4` (solo video, keyframe forzado al inicio, mismos parámetros de códec), concat demuxer con `-c copy`; el audio se renderiza entero una vez y se muxea. Progreso: "N/M bloques (K en caché)". Flag `useSegmentCache` (default true) en ExportRequest; limpieza LRU por tamaño (`SEGMENT_CACHE_MAX_GB`, default 10).
- **NVENC** en proxies e intermedios: usar `detectHardwareEncoder()` existente; fallback libx264; `HW_ENCODER` env respeta.
- **Revisión para redes**: `project.publish = {forSocial: bool, flags: {aiFace, aiVoice, aiOther, music, thirdParty}, aiLabel: bool, aiLabelText?: string}` en shared; cuando `aiLabel` es true, el export quema una etiqueta pequeña (drawtext, esquina inferior izquierda, texto por defecto "Contenido alterado con IA") durante todo el video; la web muestra advertencias de monetización/baja según flags.

## Web (Next, apps/web)
- Indicador en cabecera: GPU/CPU, VRAM libre, modelo residente (sondeo cada 10 s de `/api/ai/gpu`).
- Diálogo "Paquete requerido" ante `409 PACK_REQUIRED` con tamaño, botón Descargar, progreso por SSE del job `packs.download`, reintento.
- Ajustes → "Paquetes de IA": tabla de packs con estado, descargar/verificar; "Test de rendimiento IA" con resultados y tiempos estimados.
- Subtítulos/Edición → "Quitar silencios y muletillas": corre `analyze.silences`, diálogo de revisión (lista de cortes con casillas, vista previa de cada tramo, totales), botón Aplicar → `timeline.apply-cuts`.
- Timeline: marcadores de escena (job `analyze.scenes`) y acción "Cortar en escenas".
- Panel Exportar: sección "Revisión para redes" (checkbox "Voy a subirlo a redes", casillas de contenido, aviso de monetización, toggle etiqueta IA con texto editable).
- Voz: botón "Limpiar voz (IA)" → `audio.denoise`.

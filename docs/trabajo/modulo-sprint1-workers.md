# Sprint 1 — Workers (GPU, paquetes, escenas, silencios, limpieza de voz, rendimiento)

Contratos: `sprint1-contratos.md` (claves en snake_case; también acepta camelCase en las entradas).

## Endpoints nuevos (FastAPI :8001)

- `GET /gpu/status` · `POST /gpu/release` — `gpu.py`: un modelo residente; `acquire()` descarga el anterior antes de cargar otro; si `vram_free − 800 MB < estimado` → CPU con `warnings:["gpu_fallback_cpu"]`. VRAM vía `nvidia-smi` (no crea contexto CUDA) o `torch.cuda.mem_get_info` si torch ya inició CUDA. `sysmem_fallback` = heurística (VRAM casi llena con modelo residente). Integrado en Whisper, RVC y DeepFilterNet; Piper es solo CPU.
- `GET /packs` · `POST /packs/{id}/download` → `{task_id}` · `GET /packs/tasks/{task_id}` — `packs.py` + `tasks.py` (una descarga a la vez). Archivos reanudables/verificados con `models_manifest` (se registran en `models/manifest.json`, sección nueva `packs`); los pip se instalan en el venv con `pip` (o `uv`) mostrando líneas. `models/packs.json` se regenera al arrancar.
- `POST /analyze/scenes` — PySceneDetect `ContentDetector` (+score `content_val`); sin pack → `409 {error:"PACK_REQUIRED", packId:"scenes", name_es, size_bytes}`.
- `POST /analyze/silences` — `silencedetect` + muletillas rioplatenses (palabras del `transcript` o Whisper si está instalado; si no, `warnings:["fillers_skipped_no_transcript"]`). Discursivas solo aisladas (pausa ≥ 0,12 s antes y después, o puntuación + pausa, o repetidas); tartamudeo "el el"; padding (no en bordes), unión de cortes, descarte < 0,15 s, `total_removed_s`.
- `POST /audio/denoise` — DeepFilterNet 3 (import diferido; pesos del pack, no del caché del usuario); WAV o MP3 (`format` o extensión).
- `POST /perf/run` → `{task_id}` · `GET /perf/tasks/{id}` · `GET /perf/last` — escribe `storage/run/perf.json` (`gpu` = nombre o "cpu", `gpu_status`, `skipped:{componente: motivo}`, `errors`).
- `/transcribe` agrega `model_used`, `compute_type`, `warnings`. Por defecto `large-v3-turbo` fp16 si `USE_CUDA` y pack `whisper-turbo`; si cae a CPU usa `WHISPER_MODEL`. `/health` agrega `gpu` y `packs`.

## Paquetes (`packs.py`)

| id | contenido | tamaño | fuente / verificación |
|---|---|---|---|
| core | Whisper base + es_AR-daniela-high | 0,26 GB | HF (sha256 X-Linked-Etag) + voices.json md5 |
| whisper-turbo | mobiuslabsgmbh/faster-whisper-large-v3-turbo | 1,6 GB [S] | HF snapshot |
| voces-es | 7 voces Piper | 0,46 GB [S] | voices.json md5 |
| rvc-base | rmvpe.pt + hubert_base | 0,37 GB [S] | HF lj1995 |
| scenes | opencv-python-headless 4.11.0.86 + scenedetect 0.7.1 `--no-deps` | 0,04 GB [V PyPI] | pip |
| voz-limpia | deepfilternet/deepfilterlib 0.5.6 `--no-deps` + DeepFilterNet3.zip | 7,99 MB zip [V sha256] | pip + raw.githubusercontent |

CLI: `models_cli --packs list | download <id>... | all` (`--force`, `--json`, `--report`). `setup.ps1` baja `core`; `setup.ps1 -Full` todos en secuencia. `doctor.ps1` muestra estado de paquetes y GPU.

## Probar en Windows

`setup.ps1 -WithCuda -Full` (tabla "Paquetes de IA") y `doctor.ps1` (paquetes + "GPU (workers)"). Con Studio abierto: `curl 127.0.0.1:8001/gpu/status`, `/packs`, `POST /perf/run` → `storage\run\perf.json`. Transcribir: `model_used: large-v3-turbo`, `device: cuda`; `/gpu/status` muestra el residente y `POST /gpu/release` lo libera.

## Riesgos residuales

- Sin CUDA, torch ni Hugging Face en el sandbox: GPU real, inferencia DeepFilterNet (`df` + shim `torchaudio.backend` de 2.7.1) y descargas de HF no ejecutadas; `deepfilternet --no-deps` con numpy 2 sin probar.
- Tamaños de turbo/voces/RVC estimados [S] (se verifican al bajar); `sysmem_fallback` es heurístico; Whisper tiende a omitir muletillas (falta `initial_prompt` literal).

# Módulo (d) — workers Python, biblioteca de sonidos y setup Windows

## Hecho
- `apps/workers` (FastAPI, Python 3.11): `/transcribe` (faster-whisper 1.2.1, CPU int8 / CUDA con
  fallback a CPU, VAD, palabras → JSON + SRT + ASS karaoke `\kf` en `renders/<jobId>.*`, caché LRU de
  modelos), `/tts` + `/tts/voices` + `/tts/providers` (Piper 1.8.0, 8 voces es_AR/es_MX/es_ES,
  speed/noise/silencio, WAV + MP3 por ffmpeg; ElevenLabs/OpenAI solo si hay key, si no "no configurado"),
  `/rvc/models` + `/rvc/convert` (infer-rvc-python 1.3.1, `models/rvc/<nombre>/*.pth|*.index`),
  `/models/download` (Piper con md5/tamaño de `voices.json`, Whisper, RVC base con tamaño mínimo +
  Content-Length), `/jobs/{jobId}` (progreso que la api consulta), `/health` (torch/CUDA en segundo
  plano, ffmpeg, modelos, versiones). CLI `python -m studio_workers.models_cli` (usado por setup).
- `requirements.txt` (CPU, torch 2.7.1 de PyPI = CPU en Windows) y `requirements-cuda.txt` (índice cu128).
- api: `services/workers-client.ts` (zod, node:http sin timeout de 300 s para llamadas largas, polling
  de progreso), handlers `voice.tts` / `voice.rvc` / `subtitles.transcribe` (`src/voice-ai/`),
  rutas voz/subtítulos, biblioteca (`src/library/`: SQLite FTS5 + peaks FFmpeg + `_pack.json`,
  scan incremental, upload multipart, import → MediaAsset, Freesound solo previews).
- `packages/shared/src/voice-ai.ts` (aditivo: rutas extra, schemas de resultados/biblioteca).
- `scripts/windows/{setup,start,stop,doctor}.ps1` + `.cmd`, `common.ps1`; `scripts/library/import-cc0.ps1`.
- `docs/INSTALACION-WINDOWS.md`.

## Verificado (Linux)
- `ruff check` + `ruff format --check` + `pytest` (37 tests con mocks, sin descargas).
- `pnpm --filter @studio/api lint typecheck test` (97 tests; los de biblioteca usan ffmpeg real).
- `uv pip compile` de `requirements.txt` y del perfil liviano para `win_amd64` cp311 (solo binarios): OK.
- PowerShell: parser de pwsh 7.5.4 + PSScriptAnalyzer (compatibilidad 5.1) sin errores.

## Pendiente / no verificable aquí
- Índice cu128 de PyTorch, huggingface.co, kenney.nl y freesound.org bloqueados por el proxy:
  `requirements-cuda.txt`, descarga real de modelos, scraping de Kenney y Freesound sin probar.
- Nombres/tamaños de `hubert_base/*` (lj1995) y compatibilidad librosa 0.9.1 + numpy 2 en runtime RVC.
- Inferencia real (Whisper/Piper/RVC) y scripts .ps1 ejecutados en Windows real.

## Cómo probar en Windows
1. `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\setup.ps1` → tabla ✅/❌.
2. `scripts\windows\doctor.ps1` (filtros ffmpeg, GPU, modelos).
3. `scripts\windows\start.ps1` → http://localhost:3000; `GET :8001/health` muestra modelos.
4. `scripts\library\import-cc0.ps1`, luego `GET :3001/api/library?q=click`.
5. TTS: `POST :3001/api/voice/tts {"text":"Hola","voice":"es_AR-daniela-high"}` → job → `renders/<id>.wav`.

# Sprint 2 — Workers (visión: recorte, SAM 2, seguimiento, reencuadre)

Contratos: `sprint2-contratos.md`. Código: `studio_workers/vision/` + `routers/vision.py`; GPL aislado en `apps/workers/vision_gpl/`.

## Endpoints (FastAPI :8001, snake_case, también acepta camelCase)
- `POST /vision/matte {path, model:"rvm"|"birefnet", output_base, downsample?, chunk_frames?:300}` → `{task_id}`; `GET /vision/tasks/{id}` → `{status, progress, result:{alpha_path, preview_path, fps, frames, device, warnings?}}`. Salida WebM VP9 `yuva420p` por tramos (segmentos unidos con concat `-c copy`, alfa verificada por test) + `<base>.preview.png`. CPU: `warnings:["gpu_fallback_cpu"|"cpu_slow"]`; BiRefNet en video agrega `birefnet_video_flicker`.
- `POST /vision/matte-image {path, output_base}` → `{path (PNG RGBA), device}` (síncrono).
- `POST /vision/sam/session {path, frame_range?}` → `{session_id, frames, fps, frame_range, width, height, model}`; `/points {frame, points:[{x,y,label}], obj_id, replace?}` → `{mask_png_path, bbox (0..1), bbox_px, device}`; `/propagate {chunk_frames?:200, alpha?:true}` → task `{masks_dir, track, track_path, alpha_path?, frames, fps, objects, model}`; `DELETE` borra los cuadros (tmp) y deja máscaras/alfa (son assets). Sesión ocupada → 409 `SESSION_BUSY`.
- `POST /vision/track {path, bbox|mask_png, method:"csrt"|"sam2", frame_range?, asset_id?, output_base?}` → task `{track_path, smoothed, method, frames, track}`.
- `POST /vision/reframe {path, target, scenes?, subject:"face"|"track", track_path?}` → task `{keyframes, per_scene, crop_px, axis, source, warnings?}`.
- `/perf/run` suma `rvm_fps`, `sam2_fps`, `yunet_fps` (o `skipped.{rvm,sam2,yunet}`); `/health` suma `vision:{gpl_venv, packs}` y los 4 packs en `packs`.

## Convenciones (acordadas con shared/api)
- Coordenadas de entrada: fracciones 0..1 si todos los valores ≤ 1 (o `normalized:true`), si no píxeles del fuente. `frame`/`frame_range`: índices de cuadro (inclusive), relativos al inicio del rango de la sesión.
- TrackFile `{version:1, fps, frames:[{t,x,y,w,h,conf}], smoothed, source:{assetId, method}}`: x,y = esquina superior izquierda, 0..1; t en s desde el primer cuadro (pts reales vía ffprobe, sirve para VFR); `conf:0` = perdido (interpolado).
- Keyframes de reencuadre: `v:{x,y,w,h}` en **porcentaje** del fuente (shared `normalizeCropRect` lo acepta); el último de cada escena con `ease:"hold"` (salto en el corte, sin barrido).
- One-Euro: seguimiento `min_cutoff 2, beta 4`; reencuadre `0.5 / 1.5` + zona muerta 4 % + paneo máx. 0,6 anchos/s + RDP.

## Paquetes
| id | contenido | tamaño | verificación |
|---|---|---|---|
| matting | RVM mobilenetv3 TorchScript fp16 + fp32 (CPU) + `.venv-gpl` | ~23 MB + venv | [U] min_bytes (github bloqueado) |
| matting-image | BiRefNet-general-lite ONNX + onnxruntime 1.24.4 (`-gpu` con CUDA) + opencv headless | ~0,27 GB | [V] tamaño rembg; [V PyPI] wheels |
| sam2 | SAM 2.1 tiny + small (092824) + `SAM-2 @ git+…facebookresearch/sam2` (`--no-deps --no-build-isolation`, `SAM2_BUILD_CUDA=0`) + hydra/iopath/pillow | ~0,34 GB | [S] tamaños; requiere Git |
| reframe | YuNet 2023mar + opencv headless | 0,23 MB + 39 MB | [V] tamaño y sha256 |

## GPL y GPU
- `vision_gpl` (GPL-3) nunca se importa desde `studio_workers` (test). Corre `python -m vision_gpl.rvm` en `.venv-gpl` (líneas JSON `start/chunk/progress/warning/done/error`). El venv lo crean los workers al bajar `matting` (`python -m venv` + `pip -r vision_gpl/requirements.txt`) o `setup.ps1` (paso 5b, solo `-Full` o si ya existe; `models_cli --gpl-venv status|ensure`). Reusa el torch del `.venv` con un `.pth` de baja prioridad (sin otra copia de 2,5 GB). Sello con hash de requirements → `stale`. `GPL_PYTHON`/`GPL_VENV_DIR` en .env para desarrollo.
- Presupuesto: BiRefNet y SAM 2 pasan por `gpu.acquire`; antes de RVM se descarga el residente y el subproceso recibe `STUDIO_VRAM_BUDGET_MB` (< 900 MB → CPU con aviso; error CUDA a mitad → reintenta el tramo en CPU). SAM: small si > 3 GB libres, si no tiny; se descarga al terminar cada propagación. Tramos de RVM reanudables (work dir determinístico en `storage/tmp/matte`).
- OpenCV headless no trae CSRT: cadena CSRT (si hay contrib) → plantilla NCC (`source.method:"template"`); MIL se descartó (derivaba ~15 px en 2 s).

**Probar en Windows:** `setup.ps1 -Full` (paso "Entorno aislado GPL") y `doctor.ps1` ("Entorno GPL (.venv-gpl)" con versión de torch). Con Studio abierto: `POST /perf/run` → `rvm_fps` (criterio ≥ 15 fps 1080p) y `sam2_fps`.

## Riesgos residuales
Sin CUDA/torch/onnxruntime/sam2 ni acceso a github releases/HF/fbaipublicfiles en el sandbox: inferencia real de RVM, BiRefNet y SAM 2 no ejecutada (tests con modelos simulados); tamaños [U]/[S] se verifican al bajar. YuNet real sí probado (CPU). El job `workers` de CI no instala ffmpeg: 22 tests de visión se omiten allí.

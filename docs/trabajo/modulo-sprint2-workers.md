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
| matting | RVM mobilenetv3 TorchScript fp16 (7 952 067 B) + fp32 (15 501 891 B) + `.venv-gpl` | ~23 MB + venv | [V] tamaño + sha256 (release v1.0.0, medido 2026-10-05) |
| matting-image | BiRefNet-general-lite **swin_v1_tiny** ONNX (re-host de rembg, 224 005 088 B) + onnxruntime 1.24.4 (`-gpu` con CUDA) + opencv headless | ~0,28 GB | [V] tamaño + sha256; [V PyPI] wheels |
| sam2 | SAM 2.1 tiny + small (092824) + `SAM-2 @ git+…facebookresearch/sam2@2b90b9f5…` (`--no-deps --no-build-isolation`, `SAM2_BUILD_CUDA=0`) + setuptools/wheel + hydra/iopath/pillow | ~0,34 GB | [U] min_bytes + sha256 en la primera descarga; requiere Git |
| reframe | YuNet 2023mar + opencv headless | 0,23 MB + 39 MB | [V] tamaño y sha256 |

## Auditoría Sprint 2 (2026-10-05)
- **onnxruntime GPU**: piper-tts y faster-whisper traen `onnxruntime` (CPU) y comparte el módulo `onnxruntime` con `onnxruntime-gpu`, así que «importable» no alcanza. `PipReq.cpu_dist/cuda_dist` + `importlib.metadata`: con `USE_CUDA=true` y sin la distribución `onnxruntime-gpu` (o con las dos), el pack desinstala `onnxruntime` (y la `-gpu` sombreada) y instala `onnxruntime-gpu==1.24.4` (CUDA 12 + cuDNN 9, ver INVESTIGACION-IA-LOCAL.md). En CUDA la fila del pack es `pip:onnxruntime-gpu==1.24.4` y queda «parcial» hasta el cambio. `/health` → `vision.onnxruntime {dist, version, provider: CUDAExecutionProvider|CPUExecutionProvider, source: metadata|session, cpu_on_cuda}`; `/gpu/status` suma `onnx_provider: cuda|cpu|null` y la web avisa «Va a correr en CPU» antes de «Quitar fondo» en imágenes (BiRefNet) cuando es `cpu` en una PC con CUDA. YuNet no se cableó: corre con OpenCV DNN (CPU siempre, rápido), no con onnxruntime.
- **SAM 2**: el repo no tiene tags de release → commit fijo `2b90b9f5ceec907a1c18123530e92e794ad901a4` (HEAD de main, 2024-12-15, `VERSION 1.0`; [V] `git ls-remote`). Antes de bajar nada se comprueba `git` en el PATH: sin Git el pack falla con «Falta Git para instalar SAM 2 desde GitHub. Instalá Git (winget install Git.Git) y reintentá». `setuptools>=61,<=80.6.0` y `wheel` van en el venv (el build es `--no-build-isolation`).
- **Integridad de descargas**: github releases respondieron desde el sandbox → RVM (fp16/fp32) y BiRefNet con tamaño exacto + sha256 [V]. `dl.fbaipublicfiles.com` y Hugging Face siguen bloqueados (403) → SAM 2.1 conserva `min_bytes` y la **primera descarga** registra tamaño + sha256 en `models/manifest.json` (`"verified": "first-download"`); desde ahí `--check`/`Verificar` comparan contra ese sha256. `GET /packs` suma `integrity: pinned|first-download|pending|none`; `doctor.ps1` avisa «verificación pendiente de primera descarga» mientras sea `pending`.
- **Test de rendimiento**: `rvm_fps` = clip lavfi `testsrc2` 1920×1080, 5 s a 25 fps por el subproceso GPL (`vision_gpl.rvm` en `.venv-gpl`, el mismo camino que «Quitar fondo»); suma `rvm_proc_fps`, `rvm_device`, `rvm_precision` (fp16 CUDA / fp32 CPU), `rvm_downsample`, `rvm_resolution`, `rvm_target_fps: 15`. El evento `done` de `vision_gpl.rvm` y el resultado de `/vision/matte` traen `precision` y `downsample`. La web muestra «Recorte de personas ≈ X fps (meta 15)» y estima 1 min de video.
- **Seguir objeto**: la web manda `method:"auto"` (o el elegido en «Método»: Automático / SAM 2 / Rápido); la api resuelve `auto` con `GET /packs` (sam2 instalado → `sam2`, si no `csrt` → template matching en OpenCV headless, con su toast).

## GPL y GPU
- `vision_gpl` (GPL-3) nunca se importa desde `studio_workers` (test). Corre `python -m vision_gpl.rvm` en `.venv-gpl` (líneas JSON `start/chunk/progress/warning/done/error`). El venv lo crean los workers al bajar `matting` (`python -m venv` + `pip -r vision_gpl/requirements.txt`) o `setup.ps1` (paso 5b, solo `-Full` o si ya existe; `models_cli --gpl-venv status|ensure`). Reusa el torch del `.venv` con un `.pth` de baja prioridad (sin otra copia de 2,5 GB). Sello con hash de requirements → `stale`. `GPL_PYTHON`/`GPL_VENV_DIR` en .env para desarrollo.
- Presupuesto: BiRefNet y SAM 2 pasan por `gpu.acquire`; antes de RVM se descarga el residente y el subproceso recibe `STUDIO_VRAM_BUDGET_MB` (< 900 MB → CPU con aviso; error CUDA a mitad → reintenta el tramo en CPU). SAM: small si > 3 GB libres, si no tiny; se descarga al terminar cada propagación. Tramos de RVM reanudables (work dir determinístico en `storage/tmp/matte`).
- OpenCV headless no trae CSRT: cadena CSRT (si hay contrib) → plantilla NCC (`source.method:"template"`); MIL se descartó (derivaba ~15 px en 2 s).

**Probar en Windows:** `setup.ps1 -Full` (paso "Entorno aislado GPL") y `doctor.ps1` ("Entorno GPL (.venv-gpl)" con versión de torch). Con Studio abierto: `POST /perf/run` → `rvm_fps` (criterio ≥ 15 fps 1080p) y `sam2_fps`.

## Riesgos residuales
Sin CUDA/torch/onnxruntime/sam2 en el sandbox ni acceso a HF/fbaipublicfiles: inferencia real de RVM, BiRefNet y SAM 2 no ejecutada (tests con modelos simulados); el cambio a `onnxruntime-gpu` se probó con metadatos simulados; SAM 2.1 [U]/[S] se verifica en la primera descarga. YuNet real sí probado (CPU). El job `workers` de CI no instala ffmpeg: 22 tests de visión se omiten allí.

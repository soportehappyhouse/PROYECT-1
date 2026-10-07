# Fuentes Sprint 4 — FaceFusion, Chatterbox, RVC en CUDA, onnxruntime-gpu

Fecha de investigación: 2026-10-06. Destino: Windows 10/11, i5, 32 GB RAM, RTX 4050 6 GB, CUDA 12.x, venv principal Python 3.11 con torch 2.7.1+cu128.
**Leyenda:** **[V]** verificado leyendo la fuente primaria (URL indicada) · **[S]** secundario (snippet de búsqueda web de una página oficial) · **[U]** no verificado.
**Limitación del sandbox:** `huggingface.co`, `hf-mirror.com`, `docs.facefusion.io`, `onnxruntime.ai`, `licenses.ai`, `download.pytorch.org` y `cdn.jsdelivr.net` devolvieron 403 por política de red (no se reintentó). Por eso todo lo de Hugging Face (nombres, tamaños, sha256) es [S]/[U]. Sí se leyó directo: GitHub raw, `git ls-remote`, assets de GitHub Releases (Range request), PyPI JSON y wheels.

## 0. Hallazgos críticos (leer primero)

1. **FaceFusion 3.9.1 exige Python ≥ 3.12 de hecho.** `requirements.txt` fija `scipy==1.18.1`, que declara `requires_python >=3.12` y no tiene wheel cp311 [V PyPI]. El código solo chequea ≥3.10 y la CI usa 3.12 [V]. Studio hoy provisiona solo Python 3.11 → hay que instalar 3.12 en paralelo (venv aparte).
2. FaceFusion **no usa torch**: solo onnxruntime. Para CUDA 12 pinea `onnxruntime-gpu==1.24.4`; la 1.30.0 ya es CUDA 13 [V installer.py + PyPI]. En un venv sin conda nadie carga las DLLs CUDA/cuDNN → usar un launcher con `onnxruntime.preload_dlls()` (§1.3).
3. **NSFW siempre activo:** no hay flag; el código se autovalida por hash (`common_pre_check`). `headless-run` solo devuelve exit code 0/1 (el rechazo NSFW, código interno 3, se ve como job fallido).
4. **Chatterbox en PyPI (0.1.7) solo trae Multilingual V2** (archivo fijo `t3_mtl23ls_v2.safetensors`). V3 (`t3_model="v3"`) y el Single Language Pack existen solo en GitHub master [V]. PerTh de PyPI (1.0.1) importa `pkg_resources` → se rompe con setuptools ≥ 82 [V].
5. **infer-rvc-python 1.3.1 no tiene parámetro `device` ni `fp16`:** usa `cuda:0` fijo y fp16 automático (§3). Su hubert es formato transformers (`r3gm/hubert_base`), no el `hubert_base.pt` de fairseq.
6. Ninguna cadena de FaceFusion es 100 % comercial: todos los swappers pasan por `arcface` (InsightFace, no comercial) y se descarga `xseg_1` (GPL-3.0) y `kim_vocal_2` (no comercial) aunque no se usen (§1.5).

## 1. FaceFusion (github.com/facefusion/facefusion)

### 1.1 Versión / Python / pins / fuente

| Ítem | Valor | Fuente |
|---|---|---|
| Última release | **3.9.1**, 2026-09-30. Anteriores: 3.9.0 (2026-09-03, agrega `alphaface_256` y `hrffa`), 3.8.3 (2026-09-01), 3.8.1 (2026-08-05, "CUDA 12 and 13 installer options") | [V] https://github.com/facefusion/facefusion/releases ; commits https://github.com/facefusion/facefusion/commits/master |
| Tag → commit | `3.9.1` = `72470819a0373be3388b3929c8f8f311f418fc3c` (tags sin prefijo `v`) | [V] `git ls-remote --tags https://github.com/facefusion/facefusion.git` |
| Python | `pre_check`: ≥3.10; CI: 3.12; efectivo ≥3.12 por scipy | [V] `facefusion/core.py`, `.github/workflows/ci.yml`, PyPI scipy 1.18.1 |
| requirements.txt | `gradio==5.50.0`, `gradio-rangeslider==0.0.8`, `numpy==2.4.6` (≥3.11), `onnx==1.23.1`, `onnxruntime==1.30.0`, `opencv-python-headless==5.0.0.93`, `tqdm==4.70.1`, `scipy==1.18.1` (≥3.12) | [V] https://raw.githubusercontent.com/facefusion/facefusion/3.9.1/requirements.txt |
| ONNXRUNTIME_SET (Windows) | `default`=onnxruntime 1.30.0; `cuda@12`=onnxruntime-gpu **1.24.4**; `cuda@13`=onnxruntime-gpu 1.30.0; `openvino`=1.24.1; `directml`=onnxruntime-directml 1.24.4; `qnn`=2.6.0 | [V] `facefusion/installer.py` |
| torch | **no se usa** (no figura en requirements ni installer) | [V] |
| Binarios externos | `curl`, `ffmpeg`, `ffprobe` en PATH (`pre_check` falla si faltan; Win10/11 traen `curl.exe`) | [V] `core.py` |
| Licencia del código | `OpenRAIL-AS` (`metadata.py`); `LICENSE.md` = 3 líneas (título + "Copyright (c) 2026 Henry Ruhs") | [V] |
| Wheels ORT 1.24.4 | `onnxruntime_gpu-1.24.4-cp312-cp312-win_amd64.whl` 207 MB sha256 `da5c1e327d8e119a831be2790e69f93cf6daab9145ed0aca7577f412a620f709`; cp311 sha256 `1a799a16e5f1ff4d6a9e5f72d750849ab0fe534da8d323ae4a5d8d8bb7daeca8`; **no hay cp310** | [V] https://pypi.org/pypi/onnxruntime-gpu/1.24.4/json |

Alternativas si no se quiere Python 3.12: (a) tag `3.7.0` (scipy 1.17.1, numpy 2.2.1, `onnxruntime-gpu==1.26.0`, un solo extra `cuda`) instala en 3.11 [V requirements por tag], pero 1.26.0 cae en la ventana con fuga de memoria de arena que FaceFusion parchea (`1.25.1 < v < 1.29.0`, `inference_manager.py`) y no trae `alphaface`; (b) parchear `scipy==1.17.1` en 3.9.1 (solo se usa `scipy.signal` en `voice_extractor.py`) [U, sin probar]. **No recomendadas.**

### 1.2 Instalación en Windows (venv, sin conda)

`install.py` exige conda salvo `--skip-conda` y llama a `pip` del PATH (`shutil.which('pip')`), no a `python -m pip` → con el venv sin activar instalaría en el Python equivocado [V]. Replicar su lógica con el python del venv:

```powershell
winget install -e --id Python.Python.3.12            # [S] id de winget; deja `py -3.12` disponible
$ff = "C:\Studio\tools\facefusion"                   # ruta de ejemplo
git clone --depth 1 --branch 3.9.1 https://github.com/facefusion/facefusion.git $ff
py -3.12 -m venv "$ff\.venv"; $py = "$ff\.venv\Scripts\python.exe"
& $py -m pip install -U pip
# install.py hace: pip uninstall de todos los onnxruntime*, instalar requirements SIN las líneas onnxruntime*, y luego el pin elegido
$req = Get-Content "$ff\requirements.txt" | Where-Object { $_ -and $_ -notmatch '^onnxruntime' }
& $py -m pip install @req "onnxruntime-gpu[cuda,cudnn]==1.24.4"    # extras = nvidia-*-cu12 (§4), ~1,6 GB de descarga
& $py -c "import onnxruntime as o; o.preload_dlls(); print(o.get_available_providers())"   # debe listar CUDAExecutionProvider
```

Nunca instalar `onnxruntime` y `onnxruntime-gpu` en el mismo venv (comparten carpeta `onnxruntime/`). El venv principal de Studio (onnxruntime CPU de Piper) no se toca.

### 1.3 Launcher (carga de DLLs CUDA 12 / cuDNN 9)

FaceFusion solo ajusta PATH si existe `CONDA_PREFIX` (`facefusion/conda.py`) [V]. Con venv hay que precargar:

```python
# <facefusion>\ff_launcher.py  — ejecutar con el python del venv de FaceFusion
import os, sys, glob, runpy
os.environ["OMP_NUM_THREADS"] = "1"                     # lo hace facefusion.py; se repite porque ORT se importa antes
for d in glob.glob(os.path.join(sys.prefix, "Lib", "site-packages", "nvidia", "*", "bin")):
    os.add_dll_directory(d); os.environ["PATH"] = d + os.pathsep + os.environ["PATH"]   # [U] curand/nvrtc no los precarga ORT en Windows
import onnxruntime as ort
ort.preload_dlls()   # [V] ORT >=1.21: carga cublasLt64_12, cublas64_12, cufft64_11, cudart64_12 y cudnn*64_9 desde site-packages\nvidia
# Alternativa sin duplicar ~1,6 GB: ort.preload_dlls(directory=r"<venv-principal>\Lib\site-packages\torch\lib")  [V docstring; torch 2.7.1+cu128 trae esas DLLs, [S]]
os.chdir(os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, os.getcwd())
sys.argv = ["facefusion.py", *sys.argv[1:]]
runpy.run_path("facefusion.py", run_name="__main__")
```

Fuente de `preload_dlls` (orden de búsqueda: `directory` → DLLs por defecto; con `directory=None` en Windows usa `torch\lib` solo si hay torch+cu12x en el mismo env): https://raw.githubusercontent.com/microsoft/onnxruntime/v1.24.4/onnxruntime/__init__.py [V].

### 1.4 CLI `headless-run` (3.9.1)

Argumentos verificados en `facefusion/program.py` [V] (defaults entre paréntesis): `-s/--source-paths` (1+ imágenes), `-t/--target-path`, `-o/--output-path` (misma extensión que el target, si no `pre_process` falla), `--temp-path` (tmp del sistema), `--jobs-path` (`.jobs`, relativo al cwd), `--processors` (`face_swapper`; también `face_enhancer`, `background_remover`, `lip_syncer`, …), `--face-swapper-model` (`hyperswap_1a_256`), `--face-swapper-pixel-boost` (primer valor del modelo, p. ej. `256x256`), `--face-swapper-weight` (0.5), `--face-enhancer-model` (`gfpgan_1.4`), `--face-enhancer-blend` (80), `--face-selector-mode many|one|reference` (`reference`), `--reference-face-position` (0), `--reference-face-distance` (0.3), `--reference-frame-number` (0), `--face-selector-order` (`large-small`), `--face-detector-model` (`yolo_face`), `--face-mask-types` (`box`), `--execution-providers` (el primero disponible; `cuda`), `--execution-device-ids` (0), `--execution-thread-count` (8), `--video-memory-strategy strict|moderate|tolerant` (`strict`), `--download-providers github|huggingface` (ambos, github primero), `--output-video-encoder` (primero disponible: `libx264`), `--output-video-quality` (80), `--output-audio-encoder` (primero disponible), `--trim-frame-start/--trim-frame-end`, `--workflow-strategy memory|disk`, `--log-level error|warn|info|debug`. **No existe `--skip-download`** ni flag para desactivar el analizador NSFW.

```powershell
& $py "$ff\ff_launcher.py" headless-run `
  --source-paths "C:\...\persona.jpg" --target-path "C:\...\clip.mp4" --output-path "C:\...\clip_swap.mp4" `
  --processors face_swapper face_enhancer --face-swapper-model hyperswap_1a_256 --face-enhancer-model gfpgan_1.4 --face-enhancer-blend 80 `
  --face-selector-mode reference --reference-face-position 0 --reference-face-distance 0.3 --reference-frame-number 0 `
  --execution-providers cuda --execution-device-ids 0 --execution-thread-count 4 --video-memory-strategy moderate `
  --output-video-encoder libx264 --output-video-quality 80 --output-audio-encoder aac `
  --temp-path "C:\Studio\storage\tmp\ff" --jobs-path "C:\Studio\storage\tmp\ff\jobs" --download-providers github --log-level info
```

`headless-run` crea un job `headless-*`, lo ejecuta y sale con **0 (ok) o 1 (falló)**: `process_step` devuelve bool [V `core.py`]. Códigos internos: 2 = pre-check/args, 3 = NSFW, 4 = detenido. Para distinguir NSFW: exit 1 + sin archivo de salida + log sin errores de descarga/modelo (heurística [U]).

### 1.5 Modelos: hosts, descarga offline y licencias

- **Hosts [V `facefusion/choices.py`, `download.py`]:** primero `https://github.com/facefusion/facefusion-assets/releases/download/{models-X.Y.Z}/{archivo}` (ping `curl -I` a `https://github.com`); si falla, `https://huggingface.co/facefusion/{models-X.Y.Z}/resolve/main/{archivo}` y `https://hf-mirror.com/...`. GitHub: **sin login ni token** [V] (se bajaron los `.hash` y se midieron los `.onnx` con curl anónimo); el espejo de Hugging Face queda como fallback, sin gating observado en el código [U]. Descarga por `curl --continue-at -` (reanuda).
- **Destino:** `<facefusion>\.assets\models\<nombre>.onnx` + `<nombre>.hash` (CRC32 hex de 8 chars; el modelo es válido solo si `crc32(onnx) == contenido del .hash`) [V `hash_helper.py`]. Si todo está presente y válido **no descarga nada** (solo hace `curl -I` a github.com, timeout 5 s, sin red sigue funcionando).
- **Pre-descarga:** `force-download` (`--download-providers`, `--download-scope lite|full`) baja los modelos de **todos** los processors (varios GB) → no sirve para un pack mínimo [V `core.force_download`]. Mejor descargar a mano los `.onnx` + `.hash` listados abajo con las URLs de arriba.
- Cada `pre_check` de processor baja también los "common modules" del swapper: `content_analyser`, `face_classifier`, `face_detector`, `face_landmarker`, `face_masker`, `face_recognizer`, `voice_extractor` [V `face_swapper/core.py`].

**Swappers** (licencia = campo `license` de `__metadata__`; tamaños medidos con Range request a la release de GitHub, MB decimales) [V]:

| Modelo | Licencia (campo del código) | Tamaño | Release | Nota |
|---|---|---|---|---|
| `hyperswap_1a_256` (default) / `1b` / `1c` | **ResearchRAIL** (vendor FaceFusion) | 402,7 MB c/u | models-3.3.0 | CRC32 1a `79e50d4b`, 1b `36312901`, 1c `83c5ce36` |
| `ghost_1_256` / `ghost_2_256` / `ghost_3_256` | **Apache-2.0** | 514,9 / 738,7 / 855,5 MB (+22,1 `crossface_ghost`) | models-3.0.0 / 3.4.0 | `ghost_1` CRC32 `53447f7f` |
| `inswapper_128` / `_fp16` | **Non-Commercial** (InsightFace) | 555,3 / 277,7 MB | models-3.0.0 | fp16 CRC32 `32500ff1` |
| `simswap_256` / `simswap_unofficial_512` | **Non-Commercial** | 220,4 / 239,2 MB (+22,1 `crossface_simswap`) | models-3.0.0 / 3.4.0 | |
| `blendswap_256` | **Non-Commercial** | 1661,4 MB | models-3.0.0 | |
| `alphaface_256` | **Non-Commercial** | 555,6 MB | models-3.9.0 | nuevo en 3.9.0 |
| `uniface_256`, `hififace_unofficial_256` | **Unknown** | 407,0 / 203,8 MB (+22,1 `crossface_hififace`) | models-3.0.0 / 3.1.0 | evitar |

**Pack mínimo por defecto** (`hyperswap_1a_256` + `face_enhancer gfpgan_1.4`, detector `yolo_face`, landmarker `2dfan4`, occluder `xseg_1`, parser `bisenet_resnet_34`) [V tamaños/licencias]:

| Archivo (release) | MB | Licencia | CRC32 |
|---|---|---|---|
| `hyperswap_1a_256.onnx` (3.3.0) | 402,7 | ResearchRAIL | 79e50d4b |
| `nsfw_1/2/3.onnx` (3.3.0) | 80,4 / 22,5 / 358,2 | Apache-2.0 / Apache-2.0 / MIT | f602d1c5 / c7fa5fe2 / 633a3b02 |
| `fairface.onnx` (3.0.0) | 85,2 | CC-BY-4.0 | 10d79769 |
| `yoloface_8n.onnx` (3.0.0) | 12,7 | **GPL-3.0** | f9a0382f |
| `fan_68_5.onnx` + `2dfan4.onnx` (3.0.0) | 0,9 + 97,9 | OpenRAIL-M + MIT | 95c4a198 / a948738e |
| `xseg_1.onnx` (3.1.0) | 70,3 | **GPL-3.0** (DeepFaceLab) | f207afe3 |
| `bisenet_resnet_34.onnx` (3.0.0) | 93,6 | MIT | 35d17a50 |
| `arcface_w600k_r50.onnx` (3.0.0) | 174,4 | **Non-Commercial** (InsightFace) | 1f5fefb8 |
| `kim_vocal_2.onnx` (3.0.0) | 66,8 | **Non-Commercial** | c965a055 |
| **Total** | **1465,6 MB (1,40 GiB)** | | |
| `gfpgan_1.4.onnx` (3.0.0), opcional | 340,3 | Apache-2.0 | 5a6c6364 |

Otros mejoradores: `gfpgan_1.2/1.3` 340,3 MB Apache; `restoreformer_plus_plus` 294,3 Apache; `codeformer` 377,0 S-Lab-1.0; `gpen_bfr_256/512/1024/2048` 75,8/284,3/285,2/285,6 Non-Commercial. Detectores: `yunet` 0,2 MB MIT (models-3.4.0), `retinaface_10g` 16,9 y `scrfd_2.5g` 3,3 Non-Commercial.
**Cadena sin no-comerciales: imposible hoy** (arcface + kim_vocal_2 se cargan siempre). Si el plan exige "sin modelos no comerciales activos salvo aceptación explícita" (docs/01-PLAN-BASE-v2.md), el pack entero debe marcarse como no comercial y pedir aceptación.

### 1.6 Analizador NSFW (debe quedar SIEMPRE activo)

- Cableado [V `content_analyser.py`, `workflows/to_image.py`, `workflows/to_video.py`, `core.py`]: `analyse_image`/`analyse_video` son **la primera tarea** de ambos workflows y devuelven código 3 si detectan. Usa 3 modelos (`nsfw_1` EraX, `nsfw_2` Marqo, `nsfw_3` Freepik); positivo si ≥2 de 3 coinciden por frame; en video analiza 1 frame por segundo y rechaza si **> 10 %** de los frames muestreados son positivos.
- **No hay flag CLI ni clave `.ini`.** `core.common_pre_check()` exige `crc32(inspect.getsource(content_analyser)) == '068a6158'` → editar el módulo hace fallar todo `process_step`. Studio no debe parchearlo.
- Analiza solo el **target** (video/imagen destino), no las imágenes `--source-paths` [V]. Si Studio quiere filtrar también la cara de origen, debe hacerlo por su cuenta.

### 1.7 Licencia OpenRAIL-AS

- El repo **no incluye el texto**: `LICENSE.md` son 3 líneas en todos los tags probados (2.6.1, 3.0.0, 3.3.0, 3.5.0, 3.8.0, 3.9.0 y master) [V]. `docs.facefusion.io` y `licenses.ai` no se pudieron leer → **restricciones de uso específicas [U]**; los implementadores deben leerlas en https://www.licenses.ai/ y https://docs.facefusion.io/ desde un navegador antes de distribuir.
- [S] El sufijo "-AS" de la familia RAIL = Application + Source code; las OpenRAIL permiten uso comercial pero **obligan a trasladar las restricciones de uso (Attachment A) a cualquier acuerdo posterior**. Resultados de búsqueda sobre otras OpenRAIL (BigCode) confirman la estructura, no el texto de FaceFusion.
- La licencia del código no cubre los pesos de terceros: aplican las del §1.5.

### 1.8 Riesgos para la instalación en Windows (FaceFusion)

- Python 3.12 no está en el instalador actual (solo 3.11); `winget` puede no estar disponible (`-SkipWinget`).
- `install.py` usa `pip` del PATH; no ejecutarlo tal cual (§1.2).
- Sin conda nadie ajusta PATH: sin `preload_dlls`/`add_dll_directory` el EP CUDA no carga (error 126 por `onnxruntime_providers_cuda.dll`). Con `--execution-providers cuda` y sin DLLs FaceFusion hace `fatal_exit(1)` al crear la sesión [V `inference_manager.py`], no cae a CPU salvo que se pase `cpu` también.
- Descarga de nvidia-* ≈ 1,65 GB (cudnn 743, cublas 553, cufft 200, nvrtc 76, curand 69, runtime 4) [V PyPI]; más 1,4 GB de modelos.
- El driver NVIDIA debe soportar CUDA 12.x (≥ 570 para 12.8 [U]). Visual C++ Redistributable x64 requerido (ORT lo avisa en `preload_dlls`).
- Rutas relativas: `.assets/models`, `.jobs`, `.caches` dependen del cwd/carpeta de instalación → fijar `cwd` y pasar `--jobs-path`/`--temp-path`.
- `cudnn_conv_algo_search=EXHAUSTIVE` (RTX 4050) hace la primera pasada más lenta [V `execution.py`].
- Antivirus/SmartScreen pueden marcar `curl`/descargas de `.onnx`; la ruta con espacios o tildes no se probó [U].

## 2. Chatterbox (github.com/resemble-ai/chatterbox)

### 2.1 Versión / Python / pins / fuente

| Ítem | Valor | Fuente |
|---|---|---|
| PyPI `chatterbox-tts` | **0.1.7** (2026-03-26); anteriores 0.1.6 (2025-12-15), 0.1.5 (2025-12-12). Wheel 108 543 B sha256 `83782500e3ad4e7c919132e9d7eb8755f29f57c5bde5ec48c655ca23a4eb113c` | [V] https://pypi.org/pypi/chatterbox-tts/json |
| GitHub master | HEAD `5de7a54aa4e5e2baadb0182dde554908b48b85c2` (2026-07-21, "Update ChatterboxNano"); `65b1843` (2026-06-10) = "v3 multilingual and single language pack release". `pyproject` sigue en 0.1.7 → **la PyPI 0.1.7 no equivale a master** | [V] `git ls-remote`, commits; wheel 0.1.7 inspeccionada: `allow_patterns` con `t3_mtl23ls_v2.safetensors` fijo, sin `t3_model` |
| Python | `requires-python >=3.10`; README: "developed and tested on Python 3.11" | [V] pyproject/README |
| Pins | `torch==2.6.0`, `torchaudio==2.6.0` (<3.14), `transformers==5.2.0` (huggingface-hub `>=1.3.0,<2`), `numpy>=1.24,<2.0` (<3.13), `gradio==6.8.0`, `librosa==0.11.0`, `diffusers==0.29.0`, `conformer==0.3.2`, `safetensors==0.5.3`, `pykakasi==2.3.0`, `s3tokenizer`, `spacy-pkuseg`, `pyloudnorm`, `omegaconf`; PerTh: PyPI 0.1.7 → `resemble-perth>=1.0.0`; **master → `resemble-perth @ git+https://github.com/resemble-ai/Perth.git@master`** (rama sin fijar) | [V] METADATA del wheel y `pyproject.toml` de master |
| Wheels Windows cp311 | torch 2.6.0 (PyPI, 204 MB = solo CPU); `spacy-pkuseg 1.0.1` cp311 y cp312; `numpy 1.26.4` cp311; el resto puro Python | [V] PyPI |
| Torch CUDA | `torch==2.6.0+cu124` / `+cu126` desde `https://download.pytorch.org/whl/cu124` (o `cu126`); host bloqueado en el sandbox | [S/U] confirmar en la PC destino |
| `resemble-perth` | PyPI 1.0.1 (2025-05-23, MIT, wheel 34,4 MB sha256 `65e9c37531b1a128a4a56226b75dece4521683cf3611b0b2a5ffe234f00c9342`, **sin Requires-Dist**); master `ff1c8ac55a976971245cdd53c18d6131ca00d993` = v1.1.0 (src layout, `uv_build`, deps `torch>=2.1`, `librosa>=0.11`, `PyYAML`, `pydub`, `soundfile`), checkpoint 37,4 MB dentro del repo | [V] PyPI y raw de Perth |
| Licencia | **MIT** (Copyright 2025 Resemble AI); Perth MIT. Disclaimer del README: "Don't use this model to do bad things" (sin política de uso adicional) | [V] LICENSE, README |

### 2.2 Instalación recomendada (venv propio, Python 3.11)

Chatterbox fija `torch==2.6.0` y `numpy<2` → **venv aislado** (el principal tiene torch 2.7.1+cu128). Procedimiento armado desde `pyproject.toml` [V]; **no se ejecutó** (no hay Windows/GPU/HF en el sandbox) [U]:

```powershell
py -3.11 -m venv C:\Studio\tools\chatterbox\.venv; $py = "C:\Studio\tools\chatterbox\.venv\Scripts\python.exe"
& $py -m pip install -U pip wheel "setuptools<82"            # pkg_resources desaparece en setuptools 82.0.0 [V]; solo importa con PerTh 1.0.1
& $py -m pip install torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cu124   # [S/U] o cu126; sin esto PyPI instala CPU
# Opción A (V3 + packs): master fijado por SHA; --no-deps para no re-resolver Perth@master ni traer gradio (la librería no lo importa [V])
& $py -m pip install "resemble-perth @ git+https://github.com/resemble-ai/Perth.git@ff1c8ac55a976971245cdd53c18d6131ca00d993"
& $py -m pip install "numpy>=1.24,<2" librosa==0.11.0 s3tokenizer transformers==5.2.0 diffusers==0.29.0 conformer==0.3.2 safetensors==0.5.3 spacy-pkuseg pykakasi==2.3.0 pyloudnorm omegaconf huggingface_hub
& $py -m pip install --no-deps "chatterbox-tts @ git+https://github.com/resemble-ai/chatterbox.git@5de7a54aa4e5e2baadb0182dde554908b48b85c2"
# Opción B (solo V2, todo desde PyPI): pip install chatterbox-tts==0.1.7 "setuptools<82"
```

Requiere Git en PATH (el instalador de Studio ya lo instala). Si `import perth` deja `perth.PerthImplicitWatermarker = None` (ImportError silenciado en `perth/__init__.py`), Chatterbox falla al instanciar con `TypeError: 'NoneType' object is not callable` [V código].

### 2.3 Repos de Hugging Face, archivos y tamaños

- **Repo base:** `ResembleAI/chatterbox` (`REPO_ID` en `mtl_tts.py`, `revision="main"`, `token=os.getenv("HF_TOKEN")` → anónimo si no hay token) [V]. `from_pretrained` baja solo: `ve.pt`, `<t3_model>`, `s3gen.pt`, `grapheme_mtl_merged_expanded_v1.json`, `conds.pt`, `Cangjie5_TC.json`. `t3_model`: `"v2"`→`t3_mtl23ls_v2.safetensors` (default), `"v3"`→`t3_mtl23ls_v3.safetensors`, o cualquier `*.safetensors` [V código master].
- **Tamaños [S]** (páginas de archivos del repo vistas por búsqueda): `t3_mtl23ls_v2.safetensors` 2,14 GB; `t3_mtl23ls_v3.safetensors` 2,14 GB; `s3gen.pt` 1,06 GB; `ve.pt` 5,7 MB; `conds.pt` 169 kB. Descarga mínima V3 ≈ **3,2 GB**. **sha256: no obtenible** (HF bloqueado) [U]; obtenerlos desde la PC con red: `HfApi().model_info("ResembleAI/chatterbox", files_metadata=True).siblings[*].lfs.sha256`, o calcularlos en la primera descarga y fijarlos en el manifiesto.
- **Variantes español (Single Language Pack, README master)** [V enlaces]: `ResembleAI/Chatterbox-Multilingual-es-mx-latam` (Latam) y `ResembleAI/Chatterbox-Multilingual-es-es` (España); también `-pt-br`, `-pt-pt`, `-hi`, `-zh-cmn`. Archivos [S]: `t3_es_mx_latam.safetensors` (2 143 990 280 B, fp32, vocab texto 2454 / habla 8194), `s3gen_v3.pt` / `s3gen_v3.safetensors`, `grapheme_mtl_merged_expanded_v1.json`. Nombre del T3 de es-es [U]. **El código público de master no carga estos packs** (`from_local` espera `s3gen.pt`; no hay referencia a `s3gen_v3`) → cómo ensamblarlos es [U]; no existe modelo es-AR (rioplatense).
- **Gating:** los repos se bajan sin token en el código [V]; que ninguno esté gated es [U] (verificar `401/403` en la PC destino). Si fueran gated, Studio no puede pedir token → quedarse con el repo base.
- **Offline:** descargar con `huggingface_hub.snapshot_download(repo_id="ResembleAI/chatterbox", allow_patterns=[...], local_dir=...)` (evita symlinks del caché en Windows) y cargar con `ChatterboxMultilingualTTS.from_local(dir, device, t3_model="v3")` [V firma]; en runtime `HF_HUB_OFFLINE=1` y sin `HF_TOKEN`.

### 2.4 Uso mínimo (español + clonación)

```python
import torchaudio as ta
from chatterbox.mtl_tts import ChatterboxMultilingualTTS      # Opción A (master). En PyPI 0.1.7 no existe el argumento t3_model.

model = ChatterboxMultilingualTTS.from_pretrained(device="cuda", t3_model="v3")   # o from_local(carpeta, "cuda", t3_model="v3")
wav = model.generate(
    "Hola, ¿cómo andás? Esta es una prueba de voz en español.",
    language_id="es",                       # "es" = español (también para latam)
    audio_prompt_path="referencia_10s.wav", # clonación; omitir usa la voz de conds.pt
    exaggeration=0.5, cfg_weight=0.5,       # defaults del código; temperature=0.8, repetition_penalty=1.2, min_p=0.05, top_p=1.0
)
ta.save("salida.wav", wav, model.sr)        # model.sr = 24000 [V S3GEN_SR]
```

- Parámetros [V código + README]: `exaggeration` 0.5 (≈0.7+ para dramatismo; acelera el habla), `cfg_weight` 0.5 (≈0.3 si la referencia habla rápido; **0** si el idioma de la referencia no coincide con `language_id`, para no heredar acento).
- Límite por llamada: `max_new_tokens=1000` a 25 tokens/s ≈ 40 s de audio → trocear el texto por oraciones. `punc_norm` reemplaza `:` `;` `…` por comas [V].
- Idiomas (23, V2/V3): ar da de el en **es** fi fr he hi it ja ko ms nl no pl pt ru sv sw tr zh [V `SUPPORTED_LANGUAGES`].
- **CPU:** soportado (`device="cpu"`, `map_location` a CPU en `from_local`) [V]; velocidad en el i5 sin medir [U] (esperar varias veces más lento que tiempo real).
- **VRAM [S]:** ~3,5 GB solo TTS; 4,0–4,1 GB durante generación; algún reporte de ~5 GB; recomendado 6 GB+. En una 4050 de 6 GB queda poco margen → descargar Whisper/RVC antes (gestor GPU de Studio, `gpu.py`) y no cargar FaceFusion a la vez. El checkpoint es fp32 y el código no usa fp16/bf16 [V grep].
- **PerTh:** `self.watermarker = perth.PerthImplicitWatermarker()` en `__init__` y `apply_watermark(...)` **incondicional** al final de `generate` [V]; no hay flag para apagarlo. Es imperceptible y sobrevive MP3/edición (README) [V]. Mantenerlo activo y avisarlo en la UI.

### 2.5 Riesgos para la instalación en Windows (Chatterbox)

- `transformers==5.2.0` + `huggingface-hub>=1.3` + `gradio==6.8.0` + `numpy<2` en un venv que no comparte nada con el principal; `diffusers==0.29.0` y `safetensors==0.5.3` fijos viejos [V] — no actualizar por separado.
- Wheel `torch 2.6.0+cu124` pesa ≈ 2,5 GB [U]; sumado al venv principal (torch 2.7.1+cu128) son dos copias de CUDA.
- Opción A depende de dos repos Git y de que `uv_build~=0.12.7` se pueda bajar al construir Perth (build isolation) [V pyproject Perth]; sin Git o sin red a GitHub falla. Fijar SHAs evita el drift de `@master`.
- Setuptools ≥ 82 sin `pkg_resources` rompe PerTh 1.0.1 (Opción B) [V].
- Caché de HF con symlinks necesita modo desarrollador en Windows (si no, copia y duplica disco) → usar `local_dir`.
- Texto con `:` y puntos suspensivos se normaliza; textos > ~300 caracteres (límite de la demo oficial [S]) degradan la estabilidad.

## 3. RVC en CUDA (`infer-rvc-python`)

### 3.1 Versión / Python / pins / fuente

| Ítem | Valor | Fuente |
|---|---|---|
| Versión | **1.3.1** (2026-09-02, MIT), `requires_python >=3.10,<4`; wheel 36 176 B sha256 `945da670c9f0a7841abf2507908424cd53221219d0b2c35e9605a4ea0e25cacc` | [V] https://pypi.org/pypi/infer-rvc-python/json |
| Dependencias | `torch`, `torchvision`, `torchaudio` (**sin pin**), `transformers`, `faiss-cpu==1.10.0`, `pyworld==0.3.4`, `torchcrepe==0.0.20`, `typeguard==4.2.0`, `soxr==1.1.0`, `praat-parselmouth>=0.4.2`, `librosa`, `numpy`, `soundfile`, `ffmpeg-python` | [V] METADATA |
| Wheels Windows cp311 | `faiss_cpu-1.10.0`, `pyworld-0.3.4`, `soxr-1.1.0`, `praat_parselmouth-0.4.7` y `torch/torchaudio 2.7.1` todos con `cp311-win_amd64` | [V] PyPI |
| Compatibilidad con torch 2.7.1+cu128 | Sí: no fija versión de torch y el código solo usa API estable. Único punto de atención: `torch.load(model_path, map_location="cpu")` **sin** `weights_only` (`main.py:248`); con torch ≥ 2.6 el default es `weights_only=True`: los `.pth` RVC estándar (dict de tensores, listas, str, int) cargan; checkpoints con objetos extra (p. ej. numpy) fallarían con `UnpicklingError` | [V código]; efecto en modelos reales [U] |

### 3.2 Selección de CUDA y fp16

```python
from infer_rvc_python import BaseLoader
conv = BaseLoader(only_cpu=False, hubert_path=r"...\rvc\_base\hubert_base", rmvpe_path=r"...\rvc\_base\rmvpe.pt", preload_models=False)
# NO existe device= ni fp16=. Config() fija device="cuda:0" y is_half=True; si torch.cuda.is_available() y not only_cpu → usa cuda:0.
# is_half pasa a False si el nombre de la GPU contiene "16" (salvo V100), o P40/1060/1070/1080; en CPU/MPS también False. RTX 4050 → fp16.
# Otra GPU: variable de entorno CUDA_VISIBLE_DEVICES antes de importar torch. Forzar fp32: conv.config.is_half = False antes del primer infer [U].
conv.apply_conf(tag="mi_voz", file_model="...\mi_voz.pth", pitch_algo="rmvpe+", pitch_lvl=0, file_index="...\mi_voz.index",
                index_influence=0.66, respiration_median_filtering=3, envelope_ratio=0.25, consonant_breath_protection=0.33)
out = conv(audio_files=["in.wav"], tag_list=["mi_voz"], overwrite=False, parallel_workers=1, type_output="wav")   # firma de __call__ [V]
# pitch_algo válido [V root_pipe]: "pm", "harvest", "crepe" o cualquier texto que contenga "rmvpe" ("rmvpe+" usa pitch_based_audio_inference)
```
Perfil de memoria: con fp16 y GPU de 6 GB usa `x_pad=3, x_query=10, x_center=60, x_max=65`; con ≤4 GB baja a `1/5/30/32` [V `Config.device_config`]. El motor actual (`apps/workers/studio_workers/rvc_engine.py`) ya construye `BaseLoader(only_cpu=..., hubert_path=..., rmvpe_path=...)`: la ruta CUDA ya está soportada; falta solo validarla en la 4050.

### 3.3 Modelos base: hubert y rmvpe

- Defaults de la librería [V `main.py`]: `rmvpe.pt` ← `https://huggingface.co/r3gm/sonitranslate_voice_models/resolve/main/rmvpe.pt` (a `./rmvpe.pt` del cwd, vía `torch.hub.download_url_to_file`, anónimo) salvo que `rmvpe_path` exista; hubert ← `HubertModelWithFinalProj.from_pretrained("r3gm/hubert_base")` (**formato transformers**, `config.json` + pesos, vía caché HF) salvo que `hubert_path` sea una carpeta local con ese formato.
- Tamaños [S]: `rmvpe.pt` 181 189 687 B (idéntico en `lj1995/VoiceConversionWebUI`); `hubert_base.pt` (fairseq) 190 MB — **la librería no lo usa**. Tamaño del hubert transformers de `r3gm/hubert_base` [U] (~190 MB).
- **Discrepancia a resolver [U]:** `rvc_engine.py` baja `hubert_base/config.json`, `preprocessor_config.json` y `hubert_base/pytorch_model.bin` desde `lj1995/VoiceConversionWebUI`; las búsquedas solo muestran `hubert_base.pt` ahí, no una carpeta `hubert_base/` en formato transformers. Verificar con navegador/HF API; la fuente confirmada por el código de la librería es `r3gm/hubert_base` (+ `r3gm/sonitranslate_voice_models` para rmvpe). Ambos repos se leen anónimos desde la librería [V], pero que no estén gated es [U].
- Un modelo de voz = `.pth` (+ `.index` FAISS opcional); detalles en `docs/trabajo/fuentes-audio.md` §2.

## 4. onnxruntime-gpu en Windows (CUDA 12.8 + cuDNN 9)

| Versión PyPI | CUDA | Python | Observación | Fuente |
|---|---|---|---|---|
| 1.24.1 / **1.24.4** (2026-03-17) | **12.x**: extras `cuda` → `nvidia-cuda-nvrtc-cu12~=12.0`, `nvidia-cuda-runtime-cu12~=12.0`, `nvidia-cufft-cu12~=11.0`, `nvidia-curand-cu12~=10.0`; extra `cudnn` → `nvidia-cudnn-cu12~=9.0` | ≥3.11 (cp311–cp314 win) | Pin de FaceFusion `cuda@12`; fuera de la ventana de fuga de arena | [V] PyPI `requires_dist` |
| 1.25.0 – 1.26.0 | CUDA 12 (`-cu12`) | ≥3.11 | 1.25.1 < v < 1.29.0 usa el parche de arena de FaceFusion | [V] PyPI; `inference_manager.py` |
| 1.27.0 → 1.30.0 (2026-09-10) | **CUDA 13** (`nvidia-cuda-runtime~=13.0`, `nvidia-cudnn-cu13`) | ≥3.11 | 1.30.0 = FaceFusion `cuda@13`; wheel win 160 MB | [V] PyPI |

- **Índice extra:** para CUDA 12 con 1.24.4 **no hace falta** ningún índice (PyPI ya es CUDA 12) [V]. Los feeds `https://aiinfra.pkgs.visualstudio.com/PublicPackages/_packaging/<feed>/pypi/simple/` son solo nightlies (`ort-cuda-13-nightly`, `ORT-Nightly` para CUDA 12) [S]; no usarlos.
- **Compatibilidad CUDA 12.x:** un ORT compilado con CUDA 12.8 funciona con cualquier 12.x y requiere cuDNN 9.x [S docs ORT]; torch 2.7.1+cu128 (CUDA 12.8 + cuDNN 9) es compatible por versión mayor.
- **Convivencia con las DLLs de torch [V código ORT v1.24.4]:** `preload_dlls()` documenta que si `import torch` (con CUDA de la misma versión mayor) va antes que `import onnxruntime`, no hace falta precargar; en Windows, con `directory=None`, busca primero `torch\lib` del mismo entorno. En el venv aislado de FaceFusion no hay torch → se usan las `nvidia-*-cu12` de pip o `directory=<torch\lib del venv principal>` (ahorra ~1,6 GB, acopla rutas) [U en práctica].
- Las nvidia-* de PyPI para Windows existen como `py3-none-win_amd64`: cudnn-cu12 9.27.0.42 (743 MB), cublas-cu12 12.9.2.10 (553 MB), cufft-cu12 11.4.1.4 (200 MB), curand-cu12 10.3.10.19 (69 MB), nvrtc-cu12 12.9.86 (76 MB), cuda-runtime-cu12 12.9.79 (4 MB) [V]. En Windows ORT solo precarga cublasLt/cublas/cufft/cudart/cudnn (no curand ni nvrtc) [V] → de ahí el `add_dll_directory` del launcher [U].
- Smoke test recomendado en la PC destino: crear `InferenceSession("nsfw_2.onnx", providers=["CUDAExecutionProvider"])` y comprobar `get_providers()[0] == "CUDAExecutionProvider"` (`get_available_providers()` solo prueba que el wheel es GPU, no que las DLLs carguen).

## 5. Riesgos para la instalación en Windows (resumen transversal)

1. Tres entornos Python (3.11 principal, 3.12 FaceFusion, 3.11 Chatterbox) + dos stacks CUDA distintos de torch (2.7.1+cu128 y 2.6.0+cu124) y las nvidia-* de ORT: ≈ 8–10 GB de disco solo de runtimes, más ≈ 1,4 GB (FaceFusion) + 3,2 GB (Chatterbox V3) + ~0,4 GB (RVC base) de modelos.
2. Hugging Face es dependencia dura de Chatterbox y de RVC base; FaceFusion tiene GitHub como primario. Sin red a HF no hay TTS/RVC → pre-descarga como packs con manifiesto y sha256 calculado en la 1ª descarga.
3. Un solo modelo en la GPU de 6 GB: Chatterbox (~4–5 GB) y FaceFusion (hyperswap + gfpgan, varios GB [U]) no pueden convivir con Whisper/RVC; ejecutar como subprocesos serializados bajo `GpuBudget`.
4. Variables de entorno: no heredar `HF_TOKEN` inválido; fijar `HF_HOME`/`HF_HUB_OFFLINE`; ejecutar FaceFusion con `cwd` propio; dos `onnxruntime` en un mismo venv rompen el EP CUDA.
5. Windows Defender/SmartScreen sobre `curl`/`.onnx`; rutas largas (> 260) en `torch\lib` y `nvidia\*\bin` → habilitar `LongPathsEnabled` o rutas cortas.
6. Licencias: ResearchRAIL/Non-Commercial/GPL en pesos; OpenRAIL-AS sin texto accesible; PerTh obligatorio en Chatterbox (informar al usuario).

## 6. Decisiones recomendadas para los implementadores

1. FaceFusion **tag 3.9.1** (SHA `72470819a0373be3388b3929c8f8f311f418fc3c`) en venv propio **Python 3.12** (`py -3.12`); agregar Python 3.12 al instalador (winget `Python.Python.3.12`).
2. Instalar con `python -m pip` replicando `install.py` (no ejecutarlo): requirements sin `onnxruntime*` + `onnxruntime-gpu[cuda,cudnn]==1.24.4`. Nunca mezclar `onnxruntime` CPU y GPU.
3. Ejecutar siempre vía `ff_launcher.py` (`preload_dlls`, `OMP_NUM_THREADS=1`, `cwd` = carpeta de FaceFusion) con `--execution-providers cuda --video-memory-strategy moderate --download-providers github`.
4. Pack `face-swap` (~1,47 GB + 0,34 GB del enhancer): descargar `.onnx` + `.hash` de GitHub Releases a `.assets/models/` y validar CRC32; **no** usar `force-download`. Default `hyperswap_1a_256`; `ghost_1_256` (Apache) como alternativa. Marcar el pack "no comercial" y exigir aceptación (arcface/xseg/kim_vocal_2 siempre cargan).
5. NSFW: no tocar `content_analyser.py`; tratar exit 1 sin salida como posible rechazo y mostrar mensaje claro. Filtrar por separado la imagen de origen (FaceFusion solo analiza el destino).
6. Chatterbox: venv Python 3.11 propio, `torch==2.6.0` CUDA, `setuptools<82`, instalar desde git con SHAs (`5de7a54a…`, Perth `ff1c8ac5…`) y `--no-deps` (sin gradio); fallback PyPI 0.1.7 = solo V2.
7. Modelo TTS: base `ResembleAI/chatterbox` con `t3_model="v3"` y `language_id="es"`; pre-descargar (`snapshot_download(local_dir=…, allow_patterns=[ve.pt, t3_mtl23ls_v3.safetensors, s3gen.pt, grapheme_mtl_merged_expanded_v1.json, conds.pt, Cangjie5_TC.json])`) y correr con `HF_HUB_OFFLINE=1`. Packs es-mx-latam/es-es solo tras prueba con acceso a HF ([U] cómo se cargan).
8. Clonación rioplatense: referencia propia de ~10 s con el acento deseado; `exaggeration` 0.5, `cfg_weight` 0.5 (0.3 si habla rápido; 0 si cambia el idioma); trocear a ≤ ~300 caracteres; PerTh siempre activo y declarado.
9. RVC: mantener `infer-rvc-python==1.3.1` en el venv principal (torch 2.7.1+cu128 compatible); `BaseLoader(only_cpu=False, hubert_path, rmvpe_path)`, sin `device`/`fp16`; capturar `UnpicklingError` de `torch.load` como "modelo RVC incompatible" (no desactivar `weights_only`: son pickles de usuario).
10. Verificar el origen del hubert (§3.3): migrar a `r3gm/hubert_base` + `rmvpe.pt` si `lj1995/…/hubert_base/` no existe; actualizar `rvc_engine.py` y el pack `rvc-base`.
11. Sha256 de HF: obtenerlos con `HfApi().model_info(..., files_metadata=True)` en una PC con red y fijarlos en el manifiesto; hasta entonces usar `Content-Length` + prueba de carga.
12. Smoke tests en la PC destino (4050): sesión ORT con CUDA, `headless-run` de 2 s, `generate()` de Chatterbox en 3 frases, conversión RVC de 10 s; registrar VRAM pico para alimentar `GpuBudget`.

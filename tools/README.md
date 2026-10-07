# tools/ — herramientas aisladas de Studio

Lo que **no** puede vivir en el entorno de los workers (`apps/workers/.venv`) por licencia o por
dependencias que chocan corre acá, cada herramienta en **su propio entorno y su propio proceso**
(decisión 2 del plan; `docs/trabajo/sprint4-contratos.md`):

| Carpeta       | Herramienta                         | Python | Entorno                  | Paquete de IA                         |
| ------------- | ----------------------------------- | ------ | ------------------------ | ------------------------------------- |
| `facefusion/` | FaceFusion 3.9.1 (cambio de cara)   | 3.12   | `tools/facefusion/.venv` | `faceswap` (pide aceptar la licencia) |
| `chatterbox/` | Chatterbox multilingüe (voz y clon) | 3.11   | `tools/chatterbox/.venv` | `tts-chatterbox`                      |

El repositorio versiona **solo las recetas**: `requirements*.txt`, `<id>.lock.json` (versión, commit o
SHA fijado, fuente) y los scripts puente (`chatterbox/studio_tts_server.py`). Todo lo demás es local y
está en `.gitignore`: `*/.venv/`, `facefusion/app/` (el código de FaceFusion bajado del zip del commit
fijado), `*/.downloads/`, `*/.studio-source.json` (sha256 del zip, primera descarga) y `runtimes.json`
(el Python 3.12 que encontró o instaló `setup.ps1`).

## Cómo se instalan

`studio_workers.toolvenv.ensure(<id>)` (al descargar el paquete desde Ajustes, o
`models_cli --tool-venv <id> ensure`, que usa `setup.ps1`):

- **FaceFusion**: `py -3.12 -m venv` → `pip install -U pip` → zip del commit fijado a `facefusion/app/`
  → `pip uninstall` de todo `onnxruntime*` → `pip install -r requirements-cuda.txt` (o `-cpu`) → enlace
  `app/.assets/models` → `models/facefusion` (junction en Windows) → prueba con una sesión de
  onnxruntime real. **Nunca** se ejecuta `install.py` de FaceFusion (usa el `pip` del PATH) y nunca
  conviven `onnxruntime` y `onnxruntime-gpu` en el mismo entorno.
- **Chatterbox**: venv con el Python 3.11 de Studio → `pip install -U pip wheel "setuptools<82"` →
  `torch==2.6.0 torchaudio==2.6.0` (índice cu124 solo con CUDA) → PerTh y Chatterbox desde GitHub
  fijados por SHA (`--no-deps`, variante **V3**) → si no hay Git o GitHub falla,
  `chatterbox-tts==0.1.7` de PyPI (variante **V2**) → prueba de imports.

Cada entorno lleva un sello `.venv/.studio-tool-install` (hash de requirements + lock, perfil
cuda/cpu, variante, fuente). Si cambia la receta o el perfil, el entorno queda «desactualizado» y el
próximo `ensure` lo rehace.

## Cómo se ejecutan

Siempre a través de `launch.py`, con el Python del entorno de la herramienta y un argv en lista (nunca
una línea de comando armada como texto):

```
<tools/<id>/.venv/python> tools/launch.py --tool facefusion|chatterbox [--chdir <dir>] [--preload-ort] -- <script> <args…>
```

El lanzador quita `HF_TOKEN` y toda variable `*_API_KEY` / `*_TOKEN` / `*_SECRET`, pone
`HF_HUB_OFFLINE=1`, `HF_HOME=models/<id>/.hf`, `PYTHONUTF8=1`, `PYTHONIOENCODING=utf-8` (y
`OMP_NUM_THREADS=1` para FaceFusion), con `--preload-ort` agrega las carpetas `nvidia/*/bin` al
buscador de DLL y llama a `onnxruntime.preload_dlls()`, fija el directorio de trabajo y corre el
script con `runpy`. Un error de arranque es una línea JSON
`{"event":"error","code":"LAUNCH_FAILED","message":…}` y código 2. Cancelar = matar el árbol de
procesos (`taskkill /T /F /PID` en Windows).

`FACEFUSION_PYTHON`, `FACEFUSION_APP_DIR` y `CHATTERBOX_PYTHON` (en `.env`) reemplazan el intérprete
o la carpeta (pruebas y e2e). CI nunca crea estos entornos ni baja modelos.

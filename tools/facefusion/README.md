# tools/facefusion — receta del entorno aislado de FaceFusion 3.9.1

- `facefusion.lock.json`: versión `3.9.1`, commit `72470819a0373be3388b3929c8f8f311f418fc3c`, zip de
  GitHub y su sha256 (nulo = se registra en la primera descarga en `.studio-source.json`), Python 3.12.
- `requirements-cuda.txt`: el `requirements.txt` de 3.9.1 sin `onnxruntime` + `onnxruntime-gpu[cuda,cudnn]==1.24.4`
  (CUDA 12 + cuDNN 9 desde PyPI). `requirements-cpu.txt`: el de 3.9.1 tal cual (`onnxruntime==1.30.0`).
- Local (git-ignored): `.venv/` (Python 3.12), `app/` (el código de FaceFusion en el commit fijado; su
  `.assets/models` es un enlace a `models/facefusion`), `.downloads/`, `.studio-source.json`.

Lo instala `toolvenv.ensure("facefusion")` al descargar el paquete `faceswap` (solo con la licencia
aceptada en pantalla) y lo ejecuta `tools/launch.py --tool facefusion --preload-ort`. Nunca se usa su
`install.py`, nunca se edita su analizador de contenido (NSFW, siempre activo). Ver `tools/README.md`.

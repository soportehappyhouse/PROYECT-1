# tools/chatterbox — receta del entorno aislado de Chatterbox

- `chatterbox.lock.json`: Chatterbox y PerTh desde GitHub fijados por SHA (variante **V3**), respaldo
  `chatterbox-tts==0.1.7` de PyPI (variante **V2**), Python 3.11, `torch==2.6.0` (índice cu124 con CUDA).
- `requirements.txt`: las dependencias de Chatterbox (se instala con `--no-deps`, sin gradio).
- `studio_tts_server.py`: el puente persistente (JSON por línea por stdin/stdout) que usan los workers.
- Local (git-ignored): `.venv/` (Python 3.11 + torch 2.6).

Lo instala `toolvenv.ensure("chatterbox")` al descargar el paquete `tts-chatterbox` y lo ejecuta
`tools/launch.py --tool chatterbox` (sin `HF_TOKEN`, Hugging Face offline). PerTh (marca de agua) queda
siempre activo. Ver `tools/README.md`.

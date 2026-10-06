# Fuentes y licencias (índice)

Detalle por módulo: [fuentes-motion.md](fuentes-motion.md) · [fuentes-audio.md](fuentes-audio.md) · [fuentes-editor.md](fuentes-editor.md).

| Dependencia      | Licencia                     | Uso en Studio                                                 |
| ---------------- | ---------------------------- | ------------------------------------------------------------- |
| Remotion         | Licencia gratuita (personal) | Render de motion graphics; uso personal/individual            |
| piper-tts        | GPL-3.0                      | Dependencia en tiempo de ejecución (pip); no se copia código  |
| infer-rvc-python | MIT                          | Conversión de voz RVC (workers)                               |
| faster-whisper   | MIT                          | Transcripción/subtítulos (workers)                            |
| dockview         | MIT                          | Paneles acoplables del dashboard                              |
| wavesurfer.js    | BSD-3-Clause                 | Formas de onda en la web                                      |
| RobustVideoMatting (RVM) mobilenetv3 | GPL-3.0 | Recorte de personas en video (paquete `matting`). **Aislado**: corre como proceso aparte (`python -m vision_gpl.rvm`) en su propio entorno `apps\workers\.venv-gpl`; `studio_workers` nunca lo importa (test). Pesos TorchScript fp16/fp32 de github.com/PeterL1n/RobustVideoMatting releases v1.0.0 (tamaño y sha256 verificados) |
| BiRefNet-general-lite (swin_v1_tiny) | MIT | Quitar fondo de imágenes (paquete `matting-image`). El ONNX **no** es del repo oficial (ZhengPeng7/BiRefNet publica `.pth`): es el **re-host de rembg** (github.com/danielgatis/rembg releases v0.0.0, `BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx`, 224 005 088 B, sha256 verificado); misma licencia MIT |
| SAM 2.1 (código + pesos tiny/small) | Apache-2.0 | Máscara por clic y seguimiento (paquete `sam2`). Código `git+https://github.com/facebookresearch/sam2` fijado al commit `2b90b9f5` (sin tags de release); pesos de dl.fbaipublicfiles.com (sha256 registrado en la primera descarga) |
| YuNet (face_detection_yunet_2023mar) | MIT | Detección de caras para reencuadrar (paquete `reframe`, OpenCV Zoo; tamaño y sha256 verificados) |
| onnxruntime / onnxruntime-gpu 1.24.4 | MIT | Inferencia ONNX de BiRefNet (`-gpu` con CUDA 12 reemplaza a la versión CPU que traen piper/faster-whisper) |
| opencv-python-headless 4.11.0.86 | Apache-2.0 | Lectura de cuadros, seguimiento CSRT/plantilla, YuNet (paquetes `scenes`, `reframe`, `matting-image`) |
| scenedetect (PySceneDetect) 0.7.1 | BSD-3-Clause | Detección de escenas (paquete `scenes`) |
| deepfilternet / deepfilterlib 0.5.6 | MIT / Apache-2.0 (doble) | Limpieza de voz (paquete `voz-limpia`, pesos DeepFilterNet3 del repo oficial) |
| Ollama | MIT | Servicio local del asistente de edición (paquete `agent-llm`, Sprint 3): lo instala `setup.ps1` (`winget install Ollama.Ollama`); los workers le hablan solo por loopback (`OLLAMA_URL` no local se rechaza salvo `AGENT_ALLOW_REMOTE_OLLAMA=true`) |
| Qwen3 8B (`qwen3:8b`, Q4_K_M) | Apache-2.0 | Modelo por defecto del asistente (`AGENT_MODEL`), descargado con `ollama pull qwen3:8b` (~5 GB; Ollama verifica los digests) |
| Hermes 3 8B (`hermes3:8b`) | Llama 3.1 Community License | Modelo alternativo del asistente. Derivado de Llama 3.1: uso personal OK; si se usa hay que mostrar el aviso **«Built with Llama»** (Ajustes → «Asistente local» lo muestra cuando está elegido) y respetar la Acceptable Use Policy de Llama |

# Investigación — IA local para Studio (RTX 4050 Laptop 6 GB / 32 GB RAM)

> Fecha: 2026-10-05 · Autor: agente de investigación · Estado: **propuesta, nada implementado**.
> Pedido de origen: `docs/trabajo/feedback-usuario-2026-10-05.md` ("IA local para subir el nivel… que
> corra bien en RTX 4050 6 GB y no muera en el proceso").
> Contexto técnico: `docs/ARQUITECTURA.md` (web Next.js :3000 → api Fastify :3001 con cola por carriles
> `ffmpeg:2 / motion:1 / workers:1` → workers FastAPI :8001 con faster-whisper, Piper, RVC; torch
> `2.7.1+cu128` ya instalado por `setup.ps1 -WithCuda`).

## Cómo leer este documento

- **Para el dueño (no desarrollador):** leé el **Resumen ejecutivo**, la **Tabla resumen**, las **Fases**
  y las **Preguntas para decidir** (al final). El resto es detalle para quien implemente.
- **Marcas de verificación** (en cada dato importante):
  - **[V]** verificado en esta sesión contra la fuente primaria (README/LICENSE/código del proyecto,
    PyPI, tamaño real del archivo de descarga, o el propio repo de Studio).
  - **[S]** fuente secundaria (artículo, foro, buscador) o **estimación propia** razonada (por ejemplo,
    extrapolar un benchmark de otra GPU a la RTX 4050 Laptop).
  - **[U]** no se pudo verificar (fuente bloqueada o inexistente). Hay que confirmarlo antes de implementar.
- **Importante sobre velocidades:** no existe ningún benchmark publicado para estas herramientas en una
  _RTX 4050 Laptop_. Todas las cifras "en tu PC" son **extrapolaciones [S]** desde la GPU citada. La
  RTX 4050 Laptop (Ada, 6 GB GDDR6, bus de 96 bits ≈ 192 GB/s, TGP variable 35–115 W según la notebook)
  rinde aproximadamente como una RTX 3060 Laptop/2060 Super en tareas de cómputo y peor en las limitadas
  por ancho de banda de memoria [S]. Por eso se propone un **"Test de rendimiento IA"** que mida en la PC
  real (ver §10).
- Hosts **bloqueados** desde este entorno de investigación: `huggingface.co`, `dl.fbaipublicfiles.com`,
  `docs.facefusion.io`, `ollama.com` y la API de GitHub. Se usó `raw.githubusercontent.com`, PyPI y
  descargas de releases de GitHub (solo cabeceras, para medir tamaños). En la PC del usuario esos hosts
  **sí** funcionan (Whisper ya se baja de Hugging Face).

---

## Resumen ejecutivo

1. **Lo que más valor da con menos riesgo es determinístico, no "IA pesada":** cortar silencios y
   muletillas (Whisper con marcas por palabra + `silencedetect` de FFmpeg), detección de escenas
   (PySceneDetect / TransNetV2), y usar NVENC también en proxies e intermedios. Corre en CPU o casi sin GPU.
2. **Rotoscopia de personas en video:** **RobustVideoMatting** (7 MB, ~100+ fps de tensor en GPUs de la
   clase de la 4050) [V/S]. Licencia **GPL-3.0** [V]: OK para uso personal; condiciona si algún día se
   distribuye Studio. **Objetos arbitrarios con clic:** **SAM 2.1 tiny/small** (Apache-2.0 [V]) pero
   **solo por tramos** (≈200–300 cuadros) y con descarga a RAM; si no, se queda sin memoria (hay reportes
   de 21–60 GB de VRAM en videos de 2,5 min [S]).
3. **Tracking para pegar texto/motion:** máscara de SAM 2 → caja por cuadro → keyframes suavizados que
   Remotion/FFmpeg ya pueden consumir. Para caras: **YuNet** (OpenCV, MIT [V]) o MediaPipe (Apache-2.0
   [V], en Windows/Python solo CPU [S]). CoTracker3 es excelente pero **CC-BY-NC** [V].
4. **Reencuadre 16:9 → 9:16:** detección de cara/sujeto cada N cuadros + suavizado (filtro One-Euro /
   zona muerta) + reinicio en cada corte de escena. Esfuerzo medio, alto impacto para Reels/Shorts.
5. **Cambio de cara:** la opción realista es **FaceFusion** como herramienta externa (CLI `headless-run`,
   su propio entorno Python). Sus modelos tienen **licencias mixtas** [V]: `inswapper_128` y `arcface`
   son **no comerciales**, `ghost_*_256` Apache-2.0, `hyperswap` "ResearchRAIL". Para uso personal no
   comercial está OK; si el dueño **monetiza** los videos, es zona gris → decisión del dueño. Obligatorio:
   **compuerta de consentimiento** + etiqueta visible "contenido alterado con IA" (YouTube/TikTok lo
   exigen [S]; la UE lo exige por ley desde el 2-ago-2026 [S]).
6. **Voz:** mejor que Piper y con licencia limpia: **Chatterbox Multilingual V3** (MIT [V], 0,5 B, español
   y un modelo dedicado **"Latam Spanish"** [V], clonación de voz, marca de agua inaudible [V]). **XTTS-v2**
   suena bien pero sus pesos son **no comerciales y ya no hay a quién comprar licencia** (Coqui cerró en 2024) [S]. F5-TTS: pesos base **CC-BY-NC** [V]. Whisper: pasar a **large-v3-turbo float16** en GPU.
7. **Agente por comandos:** sí, con un modelo chico local (**Qwen3/Qwen3.5 de 4–9 B en Ollama**) que
   **solo propone** un plan JSON validado (esquema estricto) que el usuario confirma; todo lo medible
   (tiempos, silencios, render) lo hace código determinístico. Claude por API como opción paga opcional.
8. **Para "no morir en el proceso":** (a) un **gestor de presupuesto de GPU** en los workers (un trabajo
   pesado por vez, descarga de modelos al terminar), (b) procesar **por tramos con reanudación**, y
   (c) configurar en el panel NVIDIA **"CUDA – Sysmem Fallback Policy"** según preferencia (por defecto
   el driver no da error de memoria sino que se vuelve 5–10× más lento) [S].

---

## 0. Restricciones de la máquina y del stack actual

| Tema         | Estado actual en Studio                                                                                                                                                                                                                         | Implicancia                                                                                                                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GPU          | RTX 4050 Laptop, 6 GB (≈ 5,0–5,5 GB útiles: Windows/escritorio/Chrome usan 0,3–0,8 GB) [S]                                                                                                                                                      | Un solo modelo "grande" residente a la vez.                                                                                                                                                                    |
| torch        | `2.7.1+cu128` (incluye CUDA 12.8 + cuDNN 9) en `requirements-cuda.txt` [V repo]                                                                                                                                                                 | SAM 2 pide `torch>=2.5.1` [V] → compatible. Chatterbox fija `torch==2.6.0` [V] → **requiere venv aparte**.                                                                                                     |
| onnxruntime  | No instalado como GPU                                                                                                                                                                                                                           | Para CUDA 12 hay que fijar `onnxruntime-gpu==1.24.4`; la 1.30.0 ya es para CUDA 13 (así lo hace FaceFusion en su instalador [V]).                                                                              |
| OpenCV       | Varios paquetes candidatos traen su propio `opencv-python` (scenedetect, insightface [V PyPI])                                                                                                                                                  | **Conflicto clásico**: `opencv-python`, `opencv-python-headless` y `opencv-contrib-python` pisan el mismo módulo `cv2`. Elegir **uno** (`opencv-contrib-python-headless`) e instalar el resto con `--no-deps`. |
| Cola de jobs | Carriles `ffmpeg:2`, `motion:1`, `workers:1` (`apps/api/src/jobs/queue.ts`) [V repo]                                                                                                                                                            | El carril `workers:1` ya serializa los trabajos IA → buena base para el presupuesto de GPU.                                                                                                                    |
| NVENC        | Export: autodetecta `h264_nvenc` y cae a `libx264` si falla (`encoder-select.ts`, `project-export.ts`) [V repo]. Proxies e intermedios: `libx264` fijo (`builders.ts`: `X264`, `proxyArgs`) [V repo]. Sin `-hwaccel` de decodificación [V repo] | Quick win: NVENC en proxies/intermedios (§7.4).                                                                                                                                                                |
| Descargas    | `downloads.py`: escritura atómica `.part → rename`, chequeo de tamaño/md5/sha256 [V repo]; **sin reanudación por HTTP Range** [V repo]                                                                                                          | Ver §11.                                                                                                                                                                                                       |

---

## 1. Rotoscopia / matting / quitar fondo

### 1.1 Opciones

| Herramienta                               | Para qué sirve                                                                                       | Licencia [V salvo indicación]                                                                | ¿OK uso personal cerrado?                                                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **RobustVideoMatting (RVM)**              | Recorte de **personas** en video, sin clics, con memoria temporal (no "parpadea")                    | **GPL-3.0**                                                                                  | Sí para uso personal. Si se distribuye Studio, el código que lo integra debería ser GPL → aislarlo en un proceso/plugin aparte. |
| **MODNet**                                | Recorte de retratos (persona de frente)                                                              | Apache-2.0                                                                                   | Sí. Calidad menor que RVM en video [S].                                                                                         |
| **BiRefNet** (vía `rembg` u ONNX directo) | Quitar fondo de **imágenes** con calidad muy alta (pelo, bordes)                                     | MIT                                                                                          | Sí.                                                                                                                             |
| **rembg** 2.0.85                          | Envoltorio Python/CLI con muchos modelos (u2net, isnet, birefnet-*, SAM)                             | MIT; cada modelo con su licencia. Ojo: `bria-rmbg` es **no comercial** [S]                   | Sí (evitar bria-rmbg si hay uso comercial).                                                                                     |
| **SAM 2 / SAM 2.1** (Meta)                | **Clic en cualquier objeto → máscara** que se propaga por el video                                   | Apache-2.0 (código y pesos)                                                                  | Sí.                                                                                                                             |
| SAM 3 / 3.1 (nov-2025 / mar-2026)         | Igual que SAM 2 + segmentar por texto ("la taza")                                                    | "SAM License" propia, pesos **gated** en HF; 848 M parámetros; pide Python 3.12 y CUDA 12.6+ | Probablemente sí, pero **no entra cómodo en 6 GB** [S] y no coincide con Python 3.11 de los workers. Descartado por ahora.      |
| EdgeTAM (Meta)                            | SAM 2 "liviano" (22× más rápido, 150 fps en A100)                                                    | Apache-2.0                                                                                   | Sí. Alternativa si SAM 2.1 tiny va lento; algo menos preciso (SA-V test 71,7 vs 77,0 J&F).                                      |
| MatAnyone / MatAnyone 2                   | Matting de video de máxima calidad guiado por una máscara inicial (ideal: máscara SAM 2 → MatAnyone) | **NTU S-Lab 1.0 = no comercial**                                                             | Solo personal no comercial. VRAM a 1080p no publicada [U]; tiene `--max_size` para bajar resolución [V]. Fase posterior.        |

### 1.2 Datos técnicos

**RVM** [V README salvo indicación]

- Pesos ONNX en releases de GitHub: `rvm_mobilenetv3_fp16.onnx` **7,2 MB**, `fp32` 14,3 MB,
  `rvm_resnet50_fp16.onnx` 51,3 MB [V tamaño real]. También `.pth` y TorchScript.
- Velocidad publicada (solo tensor, batch 1): HD 1080p **134 fps en RTX 2060 Super (FP16)**, 172 fps en
  RTX 3090, con `downsample_ratio=0.25` [V]. El README aclara que el script de conversión real es "mucho
  más lento" por decodificar/codificar en CPU [V].
- **En la 4050 (estimado [S]):** 80–130 fps de tensor; con decodificación FFmpeg + codificación NVENC
  en tubería, **25–60 fps reales** → 1 min de 1080p30 en **0,5–1,5 min**. VRAM ~0,4–0,8 GB [S].
- CPU: funciona (ONNX Runtime CPU) a ~3–8 fps en 1080p con i5 [S] → 1 min ≈ 4–10 min.
- Instalación Windows: `onnxruntime-gpu==1.24.4` (CUDA 12) o reutilizar torch ya instalado (`.pth`).
- Salida recomendada: video alfa **webm VP9** (ya es el formato de overlay del editor) o máscara gris MP4
  para usar como `alphamerge` en FFmpeg.

**BiRefNet / rembg** [V]

- Tamaños reales (releases de rembg): `BiRefNet-general` **928 MB**, `BiRefNet-general-lite` (Swin-T)
  **214 MB**, `BiRefNet-portrait` 928 MB, `isnet-general-use` 170 MB, `u2net` 168 MB [V].
- BiRefNet estándar a 1024×1024: **3,5 GB VRAM en FP16** (4,8 GB FP32); 57,7 ms/imagen en RTX 4090 FP16
  [V]. En ONNX es ~75–90 % más lento que en PyTorch [V].
- **En la 4050 [S]:** completo ≈ 0,25–0,4 s/cuadro (cabe justo); lite ≈ 0,1–0,2 s/cuadro. Para **video**
  1 min 1080p30 serían 4–12 min y **parpadea** (cuadro a cuadro, sin memoria) → usar BiRefNet para
  **imágenes/miniaturas/fotos**, RVM para personas en video, SAM 2 para objetos.
- `rembg[gpu]` pide `onnxruntime-gpu` + cuDNN; el README admite que en NVIDIA "puede requerir" instalar
  CUDA/cuDNN aparte [V] → en Studio conviene usar las DLL que ya trae torch cu128 (mismo truco que ya se
  usa para CTranslate2) o el modelo `.pth` vía torch.

**SAM 2.1** [V README salvo indicación]

- Modelos: tiny 38,9 M parámetros (91,2 fps en A100), small 46 M (84,8 fps), base+ 80,8 M (64,1 fps),
  large 224,4 M (39,5 fps) — medidos en **A100 con `torch.compile`** [V].
- Tamaños de checkpoint: tiny ≈ 149 MB, small ≈ 176 MB, base+ ≈ 309 MB, large ≈ 857 MB [S] (el host
  `dl.fbaipublicfiles.com` está bloqueado aquí; también hay copias en HF `facebook/sam2.1-hiera-*`).
- **Windows:** el README "recomienda fuertemente WSL" [V], pero la extensión CUDA es **opcional**:
  `SAM2_BUILD_CUDA=0 pip install -e .` instala Python puro y solo se pierde un posprocesado menor
  (rellenar agujeritos de la máscara) [V INSTALL.md]. Instalar desde el repo oficial
  (`git+https://github.com/facebookresearch/sam2@<tag>`); **el paquete `sam2` de PyPI no es oficial**
  (autor ajeno a Meta) [V PyPI]. Alternativa: `transformers` (Sam2VideoModel) que baja de HF [S].
- **Memoria (el punto crítico):** SAM 2 convierte cada cuadro a 1024×1024 float32 ≈ **12,6 MB por
  cuadro** (cálculo propio [S]). 1 min a 30 fps = 1800 cuadros ≈ **22 GB** solo de cuadros. Eso explica
  los reportes de 60 GB de VRAM (21 GB con `offload_video_to_cpu=True`) en un video de 2,5 min [S, issue
  #196]. Regla para 6 GB: `offload_video_to_cpu=True`, `offload_state_to_cpu=True`, autocast bf16/fp16,
  **tramos de 200–300 cuadros** (≈2,5–3,8 GB de RAM por tramo) encadenando la última máscara como
  prompt del tramo siguiente, y `reset_state()` entre tramos.
- **En la 4050 [S]:** tiny/small ≈ 8–15 fps (sin compile) → 1 min de video en 2–4 min. VRAM 1,5–3 GB
  con lo anterior. CPU: posible pero ~1 fps → 30 min por minuto de video (no recomendado).

### 1.3 Integración en Studio

| Pieza     | Propuesta                                                                                                                                                                                                                                                                                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker    | `POST /vision/matte` (RVM) `{inputPath, outputPath, format:"webm-alpha"\|"mask-mp4", downsampleRatio?, range?, jobId}`; `POST /vision/remove-bg` (imagen, BiRefNet-lite por defecto); `POST /vision/segment/preview` (SAM 2 imagen: puntos/caja → PNG de máscara, interactivo, < 1 s); `POST /vision/segment/track` (propaga por tramos → máscara webm + `track.json`). |
| Job types | `vision.matte`, `vision.removeBg`, `vision.segment` (carril `workers`).                                                                                                                                                                                                                                                                                                 |
| UI        | Inspector del clip → pestaña **"Recorte IA"**: botón "Quitar fondo (persona)" y "Seleccionar objeto" (clics verdes = incluir, rojos = excluir sobre el visor, vista previa de máscara, luego "Propagar"). El resultado se agrega como clip con alfa encima del original.                                                                                                |
| Esfuerzo  | RVM: **S–M**. BiRefNet imagen: **S**. SAM 2 interactivo + propagación por tramos: **L**.                                                                                                                                                                                                                                                                                |
| Riesgos   | GPL de RVM; memoria de SAM 2; parpadeo de BiRefNet en video; conflicto OpenCV.                                                                                                                                                                                                                                                                                          |

---

## 2. Tracking para pegar elementos (texto/motion que sigue a un objeto o cara)

### 2.1 Opciones

| Herramienta                                                | Qué rastrea                                                                       | Licencia                                                                     | Recursos / velocidad                                                                                                                                                                         |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SAM 2 → caja**                                           | Objeto completo (máscara → bounding box/centroide por cuadro)                     | Apache-2.0 [V]                                                               | Mismo costo que §1 (se obtiene "gratis" si ya se hizo la máscara).                                                                                                                           |
| **OpenCV CSRT / KCF**                                      | Una caja elegida por el usuario                                                   | Apache-2.0 [V PyPI `opencv-contrib-python` 5.0.0.93]                         | CPU. CSRT ≈ 20–60 fps a 720p, robusto; KCF ≈ 100+ fps pero falla con cambios de escala [S]. En OpenCV 4.5.1+ algunos trackers se movieron a `cv2.legacy`; confirmar nombres en OpenCV 5 [U]. |
| **CoTracker3** (Meta)                                      | Puntos (p. ej. 4 esquinas de un cartel → para "pegar" un elemento en perspectiva) | **CC-BY-NC 4.0** [V]                                                         | Modo _online_ (ventanas) es el que entra en 6 GB [V: "more memory-efficient"]; pesos `scaled_online.pth` desde HF [V]. Estimado 6 GB: grilla chica a ~512 px [S].                            |
| **YuNet** (`cv2.FaceDetectorYN`)                           | Caras                                                                             | Modelo MIT (según metadatos de FaceFusion [V])                               | CPU muy rápido (~cientos de fps a 320 px [S]); archivo < 1 MB [S].                                                                                                                           |
| **MediaPipe** 1.0.1 (Face Detector, Face Landmarker, Pose) | Caras, 478 puntos faciales, esqueleto                                             | Apache-2.0 [V]                                                               | Rueda en Windows con rueda `win_amd64` [V], pero **en Windows/Python solo CPU** (el delegado GPU no está soportado) [S, issues #4575/#5126]. Suficiente para 30 fps a 720p [S].              |
| YOLOv8n-face (ultralytics)                                 | Caras                                                                             | **AGPL-3.0** (ultralytics [V]); `yolo_face` figura GPL-3.0 en FaceFusion [V] | Evitar dentro de Studio si se piensa compartir/distribuir; YuNet/MediaPipe cubren lo mismo.                                                                                                  |

### 2.2 Formato de exportación del track (contrato propuesto)

Archivo `storage/renders/<jobId>.track.json` (aditivo a `packages/shared`, versionado):

```json
{
  "schemaVersion": 1,
  "source": { "assetId": "…", "fps": 30, "width": 1920, "height": 1080 },
  "kind": "box",
  "smoothing": { "method": "one-euro", "minCutoff": 1.0, "beta": 0.007 },
  "keyframes": [
    { "t": 0.0, "x": 0.512, "y": 0.43, "w": 0.12, "h": 0.18, "rot": 0, "conf": 0.97 },
    { "t": 0.033, "x": 0.514, "y": 0.431, "w": 0.121, "h": 0.18, "rot": 0, "conf": 0.96 }
  ]
}
```

- Coordenadas **normalizadas 0..1** respecto del clip fuente (independiente del lienzo; resuelve también
  el bug 4 del feedback de "subtítulos fuera del video").
- Cuadros con `conf` baja se interpolan; luego se **simplifica** la curva (Ramer–Douglas–Peucker) para
  quedarse con decenas de keyframes en lugar de miles.
- **Remotion:** el overlay recibe `track` por props y usa `interpolate(frame, ts, xs)` → `transform`.
- **FFmpeg:** `overlay` (y `crop`) aceptan comandos en tiempo de ejecución; se genera un archivo
  `sendcmd` con `x`/`y` por instante [S — validar en la versión de FFmpeg instalada]. Evitar expresiones
  `if(between(t,…))` gigantes.

### 2.3 Integración

| Pieza    | Propuesta                                                                                                                                                                                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Worker   | `POST /vision/track` `{inputPath, method:"sam2"\|"csrt"\|"face", seed:{t, box?\|points?}, range?, outputPath}` → `track.json`.                                                                                                                                                                   |
| Job type | `vision.track`.                                                                                                                                                                                                                                                                                  |
| UI       | Clic derecho en un clip de texto/motion → **"Seguir objeto…"** → elegir en el visor la caja o la cara → barra de progreso → el overlay queda "anclado" (ícono de cadena) con opción "Suavizado: bajo/medio/alto" y "Desfase X/Y". Depende del pedido 7 del feedback (posición libre X/Y/escala). |
| Esfuerzo | CSRT/caras: **M**. SAM 2 → caja: **S** extra sobre §1. CoTracker (pegado en perspectiva): **L**.                                                                                                                                                                                                 |
| Riesgos  | Oclusiones (la cara sale de cuadro) → mantener última posición y avisar; licencia NC de CoTracker.                                                                                                                                                                                               |

---

## 3. Detección de escenas y cortes

|             | **PySceneDetect** 0.7.1                                                                                                                       | **TransNetV2**                                                                          |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Licencia    | BSD-3-Clause [S] (PyPI no declara campo [V])                                                                                                  | MIT [V]; port `transnetv2-pytorch` 1.0.5 MIT [V]                                        |
| Método      | `ContentDetector` (cambio de color/brillo), `AdaptiveDetector` (dos pasadas, tolera movimiento de cámara), `ThresholdDetector` (fundidos) [V] | Red neuronal; entrada diminuta 48×27 px [V] → muy barata                                |
| Calidad     | Buena en cortes duros; falsos positivos con flashes/movimiento                                                                                | Mejor F1 publicado (BBC Planet Earth 96,2) [V], detecta también transiciones graduales  |
| Recursos    | CPU; limitado por decodificación. 1 min 1080p ≈ 5–15 s con reducción de escala [S]                                                            | GPU o CPU; 1 min ≈ 5–20 s, también limitado por decodificar [S]. Pesos ~30 MB [U]       |
| Instalación | `pip install scenedetect` (arrastra `opencv-python` → usar `--no-deps`) [V]                                                                   | `pip install transnetv2-pytorch` (torch ya está) [V]; confirmar de dónde baja pesos [U] |

- **Recomendación:** PySceneDetect `AdaptiveDetector` como predeterminado (determinístico, liviano);
  TransNetV2 como modo "preciso". Ambos solo devuelven una lista de tiempos.
- **Integración:** worker `POST /vision/scenes {inputPath, method, threshold?}` → `{cuts:[t…]}`; job
  `vision.scenes`; UI: botón **"Detectar escenas"** en Media/timeline → marcadores sobre la pista y acción
  "Dividir en todas las escenas". También alimenta el reencuadre (§5) y el agente (§9). Esfuerzo **S**.
- Riesgo: bajo.

---

## 4. Quitar silencios y muletillas (pedido 10 del feedback)

### 4.1 Diseño (100 % determinístico, sin LLM)

1. **Silencios por audio:** FFmpeg `silencedetect=noise=-35dB:d=0.35` sobre el WAV que ya se extrae para
   Whisper → intervalos `[silence_start, silence_end]`. Umbral relativo: medir antes con `loudnorm`
   (pasada 1, ya implementada en `audio-fx.ts` [V repo]) y fijar `noise = loudness_integrada − 25 dB`.
2. **Silencios por palabras:** Whisper ya corre con `wordTimestamps` [V repo]. Huecos entre palabras
   > `minGap` (p. ej. 0,45 s) = silencio. Intersecar con (1) para no cortar respiraciones dentro de palabras.
3. **Muletillas:** palabras de la lista (§4.3) con su `[start,end]`; marcar solo si están **aisladas**
   (pausa antes/después o repetidas), para no cortar "este" cuando es demostrativo ("este video").
4. **Plan de cortes:** unir intervalos, aplicar **márgenes** (0,10–0,20 s antes/después, igual que
   `auto-editor --margin` [V]), descartar cortes < 0,15 s, y producir una lista de **rangos a conservar**.
5. **Revisión en UI** (clave): lista con cada corte propuesto (tipo: silencio/muletilla, duración, texto
   alrededor) con casilla, "previsualizar", y botón "Aplicar" que crea un **único paso deshacible** que
   divide y cierra huecos en el timeline (_ripple_). Los subtítulos se re-temporizan con el mismo mapa.

### 4.2 Datos y riesgos

- **Whisper tiende a "limpiar" las muletillas** (no escribe "eh", "em") [S, comportamiento conocido].
  Mitigación: `initial_prompt` con muletillas escritas ("Eh, este… o sea, bueno, mmm…") para inducir
  transcripción literal, y detectar además **pausas llenas** por audio (tramo con voz pero sin palabra
  asignada). Para precisión de palabra fina: alineación forzada tipo WhisperX (wav2vec2) — fase posterior [S].
- Precisión de marcas por palabra de faster-whisper: ±0,1–0,3 s [S] → por eso los márgenes.
- Referencia/alternativa: **auto-editor** 29.3.1 (Unlicense [V], hoy binario escrito en Nim [V]) corta por
  volumen o movimiento; sirve como comparación, pero conviene la implementación propia para la revisión
  en UI y la integración con el timeline.
- **Integración:** api (no hace falta worker nuevo): `POST /api/edit/silences/analyze` → job
  `edit.silences` (carril `ffmpeg` + transcript existente) → `{cuts:[{start,end,kind,text}]}`; aplicar es
  una mutación del `Project` en la web. UI: botón **"Cortar silencios y muletillas"** (tijera con onda)
  en la barra del timeline + diálogo de revisión con sliders "Agresividad" y "Margen". Esfuerzo **M**.

### 4.3 Muletillas rioplatenses (lista inicial, configurable por el usuario)

- **Sonidos de relleno (siempre candidatos):** eh, ehh, em, emm, mm, mmm, ah, aa, este… (alargado), eeh.
- **Muletillas de discurso (candidatas solo si están aisladas o repetidas):** este, o sea, bueno, tipo,
  nada, viste, digamos, como que, ¿no?, ¿entendés?, ¿me explico?, ¿sabés?, a ver, mirá, la verdad que,
  posta, literal, onda, en fin, ponele, dale, che, básicamente, obviamente, claro, ¿cachái? (no; es
  chileno), "y nada", "qué sé yo", "¿cómo se dice?", "o algo así", "ta" (uruguayo), "tá bien".
- Reglas: no cortar si la palabra está dentro de una frase sin pausas (< 0,12 s antes y después); cortar
  repeticiones inmediatas ("el el", "que que") como "tartamudeo"; lista editable en Ajustes.

---

## 5. Auto-reencuadre 16:9 → 9:16 (Reels/Shorts/TikTok)

- **Algoritmo [S, diseño propio basado en AutoFlip de MediaPipe]:**
  1. Cortes de escena (§3) → cada escena se trata por separado (sin "barridos" entre escenas).
  2. Detección cada 3–5 cuadros: caras (YuNet/MediaPipe, CPU) y, si no hay cara, sujeto (máscara RVM de
     persona o caja SAM 2 elegida por el usuario).
  3. Elegir objetivo (cara más grande / la que habla — opcional: cruzar con energía de voz por canal).
  4. Suavizado: **filtro One-Euro** + **zona muerta** (no mover la ventana si el sujeto se movió < 5 % del
     ancho) + velocidad máxima de paneo; opcional "cámara fija por escena" (estilo más profesional).
  5. Salida = keyframes de recorte `{t, x, y, w, h}` con el mismo `track.json` de §2.2.
  6. Render: FFmpeg `crop` con `sendcmd` + `scale` a 1080×1920, o un clip Remotion con `transform`. Con
     dos caras lejanas: "pantalla dividida" (dos recortes apilados) como opción avanzada.
- **Velocidad [S]:** análisis 1 min de video ≈ 15–40 s en CPU (detección cada 4 cuadros); render con NVENC
  ≈ tiempo real o más rápido.
- **Integración:** worker `POST /vision/reframe {inputPath, targetAspect:"9:16", mode:"follow"|"static",
scenes?}` → `track.json`; job `vision.reframe`; UI: en el diálogo de exportación, preset "Reels 9:16"
  ofrece **"Reencuadre inteligente"** con vista previa y posibilidad de corregir a mano un keyframe.
  También como acción de clip ("Reencuadrar para vertical"). Esfuerzo **M**.
- Riesgo: escenas sin caras ni sujeto claro → caer a recorte centrado y avisar.

---

## 6. Cambio de cara (face swap) — con compuerta de consentimiento

### 6.1 Estado de las opciones

| Opción                               | Estado                                                                                                                                                                                                                                                                                                                          | Licencia                                                                                                           | Comentario                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **InsightFace `inswapper_128`**      | El repo de InsightFace dice que para los modelos inswapper hay que **contactar a insightface.ai para licencia**; los modelos entrenados con sus datos son **solo para investigación no comercial** [V README]. No está como descarga oficial en releases de InsightFace; circula vía terceros (p. ej. assets de FaceFusion) [V] | Código MIT; **modelos no comerciales** [V]                                                                         | La librería `insightface` 1.0+ ya no necesita compilar C++ [V], versión 2.1 del 2026-10-03 [V].                                                                                                                                                                                                                                             |
| **FaceFusion** (henryruhs)           | Activo; CLI con `run`, `headless-run`, `batch-run`, jobs, `benchmark` [V]. Proveedores: CUDA, TensorRT, DirectML, OpenVINO, CPU [V]. Analizador de contenido NSFW incluido [V]. Estrategia de memoria de video `strict/moderate/tolerant` [V]                                                                                   | Código **OpenRAIL-AS** (texto completo no está en el repo, solo el encabezado [V]; cláusulas de uso no leídas [U]) | Es "plataforma" completa: detector, reconocimiento, varios swappers, mejoradores de cara, upscalers, lip-sync. Requiere `onnxruntime-gpu 1.24.4` para CUDA 12 [V]; `gradio 5.50`, `numpy 2.4.6`, `opencv-python-headless 5.0` [V] → **venv propio obligatorio**. El "Windows Installer" oficial existe [V], condiciones no verificadas [U]. |
| roop (s0md3v)                        | **Archivado** por el autor por razones éticas [V]                                                                                                                                                                                                                                                                               | —                                                                                                                  | Descartar.                                                                                                                                                                                                                                                                                                                                  |
| DeepFaceLive                         | Herramienta en tiempo real (webcam/streaming), DirectX12/ONNX, GPL-3.0 [V]; usa modelos DFM de personas concretas entrenados con DeepFaceLab                                                                                                                                                                                    | GPL-3.0 [V]                                                                                                        | No encaja en un editor por lotes; entrenar un DFM lleva días. Descartar.                                                                                                                                                                                                                                                                    |
| SimSwap                              | Investigación                                                                                                                                                                                                                                                                                                                   | **CC-BY-NC 4.0** [V]                                                                                               | Ya está empaquetado dentro de FaceFusion (`simswap_256`, `simswap_unofficial_512`).                                                                                                                                                                                                                                                         |
| GFPGAN / CodeFormer (mejora de cara) | Maduros                                                                                                                                                                                                                                                                                                                         | GFPGAN: Apache-2.0 [S]; **CodeFormer: S-Lab = no comercial** [V]                                                   | `GFPGANv1.4.pth` 333 MB, `codeformer.pth` 359 MB [V tamaños].                                                                                                                                                                                                                                                                               |

**Licencias de los modelos que FaceFusion descarga** (leídas de su código fuente, campo `license` [V]):

| Tipo                       | Modelo → licencia                                                                                                                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Swapper                    | `ghost_1/2/3_256` → **Apache-2.0**; `hyperswap_1a/1b/1c_256` → ResearchRAIL; `inswapper_128(_fp16)`, `simswap_*`, `blendswap_256`, `alphaface_256` → **Non-Commercial**; `uniface_256`, `hififace_unofficial_256` → Unknown |
| Detector de caras          | `yunet` → MIT; `retinaface`, `scrfd` → Non-Commercial; `yolo_face` → GPL-3.0                                                                                                                                                |
| Reconocimiento (identidad) | `arcface` → **Non-Commercial** (lo usan todos los swappers para la "identidad" de origen)                                                                                                                                   |
| Mejora de cara             | `restoreformer_plus_plus` → Apache-2.0; `codeformer` → S-Lab; `gpen_bfr_*` → Non-Commercial                                                                                                                                 |
| Upscaler de cuadro         | `real_esrgan_x2/x4/x8(_fp16)` → BSD-3-Clause; `swin2_sr_x4`, `real_hatgan_x4` → Apache-2.0; `ultra_sharp*`, `remacri`, `clear_reality` → Non-Commercial                                                                     |
| Lip-sync                   | `edtalk_256` → Apache-2.0; `wav2lip_*` → Non-Commercial                                                                                                                                                                     |
| Filtro NSFW                | `nsfw_1/2` → Apache-2.0; `nsfw_3` → MIT                                                                                                                                                                                     |

**Conclusión de licencias:** no existe hoy una cadena de cambio de cara 100 % comercial "lista": aun con
`ghost` (Apache) el reconocimiento `arcface` es no comercial. **Para uso personal sin fines comerciales
es aceptable**; si los videos se **monetizan** (YouTube Partner, publicidad, clientes) la lectura más
prudente es que **no** está cubierto → es la **Pregunta 1** para el dueño.

### 6.2 Tamaños y rendimiento en 6 GB

- Tamaños reales [V]: `inswapper_128_fp16.onnx` **265 MB** (fp32 530 MB), `ghost_1_256` 491 MB,
  `ghost_2_256` 705 MB, `crossface_ghost` 21 MB, `hyperswap_1a_256` 384 MB, `arcface_w600k_r50` 166 MB,
  `yoloface_8n` 12 MB, `retinaface_10g` 16 MB, `gfpgan_1.4.onnx` 325 MB, `codeformer.onnx` 360 MB,
  `gpen_bfr_512` 271 MB, `nsfw_1` 77 MB, `real_esrgan_x2_fp16` 35 MB.
  Paquete mínimo (yunet/yoloface + arcface + inswapper fp16 + ghost_1 + gfpgan + nsfw) ≈ **1,35 GB**.
- VRAM: `inswapper_128` ~4 GB, `inswapper_128_fp16` ~2 GB [S]; con mejorador de cara +30 % de tiempo [S].
- **Velocidad estimada en la 4050 [S]:** 1080p, una cara, inswapper fp16 sin mejorador ≈ 15–25 fps;
  con GFPGAN ≈ 6–12 fps → **1 min de video 1080p30 ≈ 2,5–5 min** (sin mejorador ≈ 1,5–2 min).
  Ghost 256 ≈ 0,5–0,7× la velocidad de inswapper [S].
- **Calidad realista:** inswapper trabaja a 128×128 px → en primeros planos se nota "blandito" sin
  mejorador; ghost/hyperswap a 256 px mejoran nitidez; perfiles muy laterales, oclusiones (manos,
  micrófono) y luz dura siguen fallando [S]. Para "creíble" hacen falta: buena foto de origen (frontal,
  bien iluminada, varias fotos), máscara de oclusión (FaceFusion la trae), y mejorador.
- CPU: técnicamente posible (~0,5–2 fps [S]) → 15–60 min por minuto; no ofrecer salvo imágenes.

### 6.3 Marco legal y de plataformas (resumen, no es asesoría legal)

- **Argentina:** el Código Civil y Comercial **art. 53** exige consentimiento para captar o reproducir la
  imagen o la voz de una persona [S]. No hay aún ley específica de deepfakes; hay proyectos (p. ej.
  3955-D-2024, penas de 4–8 años por deepfakes sin consentimiento) sin sanción [S].
- **Uruguay:** la Ley 19.580 ya pena difundir contenido íntimo sin autorización; un proyecto aprobado por
  Diputados extiende la pena a imágenes íntimas **generadas con IA** (24 meses a 3 años) y hubo una
  primera condena por material de abuso infantil generado con IA [S]. La imagen y la voz son datos
  personales (Ley 18.331) [S].
- **Unión Europea:** AI Act **art. 50**, vigente desde el **2-ago-2026**: quien publica un deepfake debe
  **declarar que es artificial**, de forma clara; régimen más liviano para obras artísticas/satíricas [S].
- **EE. UU.:** **TAKE IT DOWN Act** (firmada el 19-may-2025): delito publicar deepfakes íntimos de personas
  identificables sin consentimiento; plataformas deben retirar en 48 h [S].
- **Plataformas:** YouTube exige marcar "contenido alterado o sintético" en caras cambiadas y voces
  clonadas realistas (aplicación plena desde ene-2026; detección automática desde may-2026) [S]; TikTok
  exige etiqueta AIGC en caras sintéticas/cambiadas y clones de voz, y lee C2PA [S]; Meta etiqueta
  "Info de IA" [S].

### 6.4 Compuerta de consentimiento (propuesta de producto, obligatoria)

1. **Registro de identidades** (`storage/consent/…`, fuera de `/files`): para usar una cara (o voz) como
   **origen**, el usuario crea una "Persona" con: nombre, foto(s), **declaración de consentimiento**
   (casilla + texto: "Tengo autorización expresa de esta persona para usar su rostro/voz en este
   proyecto"), fecha, alcance (proyecto/s), y opcionalmente adjunta evidencia (audio/video/foto del
   permiso firmado). Para "yo mismo": casilla "Soy esta persona".
2. **Sin Persona registrada no hay swap**: el job `face.swap` exige `consentId`; la api lo valida y lo
   guarda en el job (auditoría). No se acepta "cualquier foto bajada de internet" como origen.
3. **Bloqueos fijos:** mantener activo el analizador NSFW de FaceFusion (no ofrecer opción para
   desactivarlo); rechazar si se detecta posible menor como destino u origen (si se dispone de
   estimación de edad; si no, advertencia explícita) [S, diseño].
4. **Divulgación por defecto:** al exportar un proyecto con swaps o voz clonada, la opción
   **"Agregar aviso 'Contenido alterado con IA'"** viene **activada** (marca de agua discreta en una
   esquina + texto en metadatos del MP4 `comment`), y el diálogo recuerda marcar la casilla de
   "contenido alterado" en YouTube/TikTok. El usuario puede desactivarla, quedando registrado.
5. **Trazabilidad:** escribir en metadatos del archivo exportado "edited-with: Studio; synthetic-face: yes;
   consent-id: …" (y a futuro C2PA). Chatterbox ya agrega marca de agua de audio PerTh [V].

### 6.5 Integración técnica

- FaceFusion en `tools/facefusion/` con **su propio venv** (Python 3.12 + `onnxruntime-gpu 1.24.4`),
  descargado/actualizado por el instalador incremental; los workers lo invocan como **subproceso**
  (`facefusion.py headless-run --source … --target … --output-path … --face-swapper-model
inswapper_128_fp16|ghost_1_256 --face-enhancer-model gfpgan_1.4 --execution-providers cuda
--video-memory-strategy strict --execution-thread-count 2`) [opciones V en `choices.py`; nombres
  exactos de flags a confirmar con `--help`, docs bloqueadas U]. Separar en proceso también aísla
  licencias (OpenRAIL/GPL) del código de Studio.
- Worker `POST /face/swap {consentId, sourceImages[], targetPath, range?, model, enhancer, outputPath}`;
  job `face.swap`; UI: asistente **"Cambiar cara"** (1. elegir Persona con consentimiento, 2. elegir cara
  destino en el visor, 3. vista previa de 1 cuadro, 4. procesar). Esfuerzo **L** (por la compuerta, el
  venv aparte y la UX); el swap en sí es M.

---

## 7. Mejora de imagen y velocidad

### 7.1 Upscaling (escalado)

| Opción                                      | Licencia                                   | Tamaño [V]  | Uso recomendado                                               |
| ------------------------------------------- | ------------------------------------------ | ----------- | ------------------------------------------------------------- |
| **Real-ESRGAN** `realesr-general-x4v3`      | BSD-3-Clause [S; BSD-3 según FaceFusion V] | **4,7 MB**  | Video real de baja resolución (p. ej. WhatsApp 478×850 → ×2). |
| `realesr-animevideov3`                      | ídem                                       | 2,4 MB      | Animación/dibujos.                                            |
| `RealESRGAN_x4plus`                         | ídem                                       | 63,9 MB     | Fotos; muy lento para video.                                  |
| Portable `realesrgan-ncnn-vulkan` (Windows) | ídem                                       | 43,4 MB zip | **Sin Python ni CUDA** (Vulkan) — la vía más simple.          |

- Velocidad estimada en 4050 [S]: general-x4v3 a 720p→1440p ≈ 5–12 fps; x4plus ≈ 0,5–2 fps. 1 min de
  video 30 fps con x4v3 ≈ 3–6 min. VRAM ajustable con `tile` (1–3 GB). CPU: no práctico para video.
- Integración: `POST /enhance/upscale {inputPath, model, scale:2|4, outputPath}`; job `enhance.upscale`;
  UI: clic derecho en medio → **"Mejorar resolución"**; sugerirlo automáticamente cuando el medio es
  < 720p en un proyecto 1080p (caso real del feedback). Esfuerzo **S–M**.

### 7.2 Interpolación de cuadros (cámara lenta / 60 fps)

- **RIFE** (Practical-RIFE, MIT [V]); v4.25 recomendada por defecto [V]; el original corre "30+ fps 2×
  720p en 2080 Ti" [V]. Pesos solo en **Google Drive/Baidu** [V] → malos para un instalador automático.
- Alternativa empaquetada: **rife-ncnn-vulkan** (MIT [S]), zip Windows **431 MB** con binarios y todos los
  modelos (incluye `rife-v4`, `rife-v4.6`) [V]; "portable, sin CUDA ni PyTorch" [V].
- Estimado 4050 [S]: 1080p ×2 ≈ 10–25 fps (ncnn) → 1 min 30→60 fps ≈ 2–5 min.
- Integración: `POST /enhance/interpolate {inputPath, factor:2|4, outputPath}`; UI: en el inspector del
  clip, velocidad < 100 % → casilla **"Cámara lenta suave (IA)"**. Esfuerzo **S–M**.

### 7.3 Denoise y audio

- **Video:** filtros FFmpeg determinísticos: `hqdn3d` (rápido), `nlmeans` (mejor, lento en CPU),
  `nlmeans_vulkan` (FFmpeg 7+) [S]. Ofrecer "Reducir ruido de video: leve/medio/fuerte". Esfuerzo **S**.
- **Audio de voz (alto impacto, liviano):** **DeepFilterNet** (MIT [V PyPI 0.5.6]; Windows soportado [V])
  — supresión de ruido neuronal casi en tiempo real en CPU [S]; existe binario `deep-filter` en releases
  (Rust) que evita problemas con versiones nuevas de torchaudio [S]. Ya existe `afftdn` en `audio-fx.ts`
  [V repo] como opción clásica. **Demucs** 4.1.0 (MIT [V]) para separar voz de música (quitar música de
  fondo) — GPU 1–2 GB, ~10–30 s por minuto [S]. Esfuerzo **S–M**.
- **Color:** corrección automática determinística (`eq`, `colorlevels`, LUTs `.cube` con `lut3d`); no
  hace falta IA (DeOldify descartado como pidió el encargo).

### 7.4 NVENC en Studio (estado y quick wins)

- **Hoy:** export detecta `h264_nvenc` con una codificación real de prueba y cae a `libx264` si falla;
  usa `-preset p5 -tune hq -rc vbr -cq` (`encoders.ts`) [V repo]. **Proxies e intermedios usan
  `libx264` fijo** y no hay decodificación por hardware [V repo].
- **Propuesta (S):** usar el encoder elegido también en `proxyArgs` y en renders intermedios (preset
  `p1–p3` para velocidad); probar `-hwaccel cuda` solo para decodificar entradas H.264/HEVC (cuidado con
  filtros que requieren cuadros en CPU); exponer **HEVC/AV1 NVENC** (la serie 40/Ada codifica AV1 [S]).
  NVENC es un bloque aparte de la GPU, así que puede convivir con IA, pero reserva ~0,2–0,5 GB de VRAM
  por sesión [S] → contarlo en el presupuesto (§10).

---

## 8. Voz

### 8.1 TTS en español mejor que Piper

| Motor                                        | Licencia                                                                                                            | Español                                                                               | Clonación                                     | VRAM / velocidad en 6 GB                            | Veredicto                                                                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Piper (actual)                               | `piper-tts` 1.8.0 hoy proviene del fork `piper1-gpl` → **GPL-3.0** [S]; voces con licencia propia                   | es_AR, es_ES, es_MX [V catálogo repo]                                                 | No                                            | CPU, muy rápido                                     | Mantener como "rápido/sin GPU".                                                                                                                                               |
| **Chatterbox Multilingual V3** (Resemble AI) | **MIT** [V LICENSE]                                                                                                 | Sí (`es`) + modelo dedicado **`Chatterbox-Multilingual-es-mx-latam`** y `es-es` [V]   | **Sí, zero-shot** (~10 s de referencia) [V/S] | 0,5 B parámetros [V]; ~3–5 GB VRAM, RTF 0,5–1,5 [S] | **Recomendado** para clonación y calidad. Marca de agua PerTh en todo audio [V]. Fija `torch==2.6.0`, `transformers==5.2.0`, `gradio==6.8.0` [V pyproject] → **venv propio**. |
| **Kokoro-82M**                               | Apache-2.0 (código y pesos) [V]                                                                                     | Sí (`lang_code='e'`) [V]; voces `ef_dora`, `em_alex`, `em_santa` [U, VOICES.md en HF] | No                                            | 82 M; tiempo real o más en CPU [S]                  | Bueno como voz rápida/neutra; acento no rioplatense [S]. Necesita espeak-ng para español [S].                                                                                 |
| XTTS-v2 (fork `coqui-tts` 0.27.5)            | Código MPL-2.0 [V]; **pesos CPML no comercial**; Coqui cerró en ene-2024 → **no hay forma de comprar licencia** [S] | Sí (17 idiomas) [V]                                                                   | Sí, 6 s                                       | ~2–3 GB, RTF 0,3–0,6 [S]                            | Solo si el uso es estrictamente no comercial. Opcional, detrás de un aviso.                                                                                                   |
| F5-TTS 1.1.22                                | Código MIT; **pesos base CC-BY-NC** (datos Emilia) [V]                                                              | Base ZH/EN; español vía _fine-tunes_ comunitarios (p. ej. "F5-Spanish") [U licencia]  | Sí                                            | RTF 0,147 en L20 PyTorch [V]; en 4050 ~0,3–0,6 [S]  | No prioritario.                                                                                                                                                               |
| Fish-Speech / OpenAudio                      | **Fish Audio Research License** (investigación/no comercial; comercial bajo licencia) [V]                           | Sí [S]                                                                                | Sí                                            | ~3–4 GB [S]                                         | No prioritario por licencia.                                                                                                                                                  |

- **Consentimiento de voz:** la clonación de voz usa la **misma compuerta** de §6.4 (Persona con
  consentimiento; aviso "voz sintética" al exportar).
- **Integración:** extender `TtsProviderInfo` con `chatterbox` y `kokoro` (aditivo); worker
  `POST /tts {provider:"chatterbox", voiceRef?: consentId, language:"es", …}`. Como Chatterbox vive en
  otro venv, el worker principal lo llama como **subproceso persistente** (servidor local en otro
  puerto, p. ej. :8002) que se apaga tras N minutos inactivo. UI: panel Voz → selector de motor, "Clonar
  voz desde un audio de 10 s" (con consentimiento). Esfuerzo **M** (Chatterbox) / **S** (Kokoro).

### 8.2 RVC en CUDA

- Ya integrado (`infer-rvc-python` 1.3.1, inferencia) [V repo]. En CUDA con `rmvpe`: 1 min de audio ≈
  3–10 s; CPU ≈ 30–120 s [S]. VRAM ~1–2 GB [S]. Solo asegurar que el presupuesto de GPU lo descargue al
  terminar.

### 8.3 Whisper en CUDA: qué modelo usar

- Benchmark oficial faster-whisper (13 min de audio, **RTX 3070 Ti 8 GB**, CUDA 12.4) [V]:
  large-v2 fp16 = 1 min 03 s y **4,5 GB**; int8 = 59 s y **2,9 GB**; con `batch_size=8` fp16 = 17 s pero
  **6,1 GB** (no entra en 6 GB) e int8 batch 8 = 16 s y 4,5 GB.
- `large-v3-turbo` (4 capas de decodificador) es mucho más liviano que large-v3 [S]; ~1,5–2,5 GB en fp16
  [S]; un reporte en RTX 3060 Laptop 6 GB lo da casi igual de rápido en fp16 e int8 [S]. El motor de Studio
  ya acepta `large-v3-turbo`/`turbo`/`distil-large-v3.5` y elige `float16` en CUDA, `int8` en CPU, con
  caída automática a CPU si CUDA falla [V repo `stt/engine.py`].
- **Recomendación:** en GPU **`large-v3-turbo` + `float16`** (o `int8_float16` si convive con otro modelo),
  `BatchedInferencePipeline` con `batch_size` 4 (no 8) y `vad_filter=True` [V API]. Estimado 4050: 1 min de
  audio ≈ 3–8 s [S]. `medium` queda como plan B (~1,5 GB; menos preciso en español [S]); en CPU,
  `small`/`base` int8 (CPU i7-12700K: small int8 13 min en 1 min 42 s [V]; en i5 laptop ≈ 1,5–2× más) [S].
- Descarga: modelos CTranslate2 de HF (`Systran/faster-whisper-*`, `mobiuslabsgmbh/...turbo` u otros)
  — large-v3-turbo ≈ 1,6 GB, medium ≈ 1,5 GB, large-v3 ≈ 3,1 GB [S].

---

## 9. Agente de edición por comandos ("cortá los silencios, agregá un título en el segundo 3, exportá para Reels")

### 9.1 Modelos locales que entran en 6 GB

| Modelo (Ollama, Q4_K_M)        | Disco / VRAM                                                                                | Tool-calling (evaluación Docker, jun-2025, F1 selección de herramienta) | Español                            | Licencia                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------ |
| **Qwen3-8B**                   | 5,2 GB disco, ~6 GB VRAM con contexto [S] → no entra entero con 5 GB útiles; parte va a CPU | **0,919** (Q4_K_M) / 0,933 (F16) [V]                                    | Muy bueno, 100+ idiomas [V]        | Apache-2.0 [V]                                   |
| **Qwen3.5-9B / 4B** (mar-2026) | 9B ≈ 5 GB a Q4 [S]; 4B ≈ 2,5–3 GB [S]                                                       | Tool calling nativo en Ollama [S]; sin número independiente [U]         | 201 idiomas y dialectos [V README] | Ver licencia en HF [U] (Qwen3 es Apache-2.0 [V]) |
| Qwen3-4B-Instruct-2507         | ~2,5 GB [S]                                                                                 | Mejor uso de herramientas que Qwen3-4B original [V README]              | Bueno                              | Apache-2.0 [V]                                   |
| Llama 3.1 8B                   | ~4,9 GB [S]                                                                                 | 0,793 [V]                                                               | Bueno                              | Llama Community License [S]                      |
| Qwen2.5-7B-Instruct            | ~4,7 GB [S]                                                                                 | 0,753 [V]                                                               | Bueno                              | Apache-2.0 [S]                                   |
| Gemma 3 4B / Gemma 4 E4B       | ~3 GB [S]                                                                                   | gemma3:4b 0,733 [V]                                                     | Bueno                              | Gemma Terms [S]                                  |
| Gemma 2 9B                     | ~5,4 GB [S]                                                                                 | Sin tool calling nativo [S]                                             | Bueno                              | Gemma Terms                                      | Descartar. |

- **Recomendación:** **Qwen3.5-4B** (o Qwen3-4B-2507) como predeterminado → entra en VRAM junto a casi
  nada más pero sin desbordar, ~40–70 tokens/s en la 4050 [S]; **Qwen3.5-9B / Qwen3-8B** como opción
  "mejor comprensión" descargando todo lo demás antes (~20–40 tok/s si entra entero, 8–15 tok/s si se
  desborda a CPU [S]). Un plan de edición son ~200–400 tokens → **2–10 s** por comando [S].
- **Runtime:** **Ollama para Windows** (MIT [S]) como servicio aparte en `127.0.0.1:11434`. Su API acepta
  **`format` = JSON Schema** (salida estructurada) y `keep_alive` (`0` descarga el modelo al instante)
  [V docs/api.md]; `OLLAMA_MAX_LOADED_MODELS` y `OLLAMA_KEEP_ALIVE` controlan residencia [S]. Alternativa:
  `llama-cpp-python` 0.3.36 — en PyPI solo hay código fuente (compilar con CUDA en Windows es difícil)
  [V PyPI] → no recomendado.
- **Claude por API (opcional, ya existe `ANTHROPIC_API_KEY` en `.env.example` [V repo]):** soporta
  herramientas con `strict: true` y salidas estructuradas por JSON Schema. Modelos y precios actuales por
  millón de tokens (entrada/salida): `claude-opus-5-5` $4/$20 (predeterminado recomendado por Anthropic),
  `claude-sonnet-5-5` $2/$10, `claude-haiku-4-5` $1/$5 [V, documentación de Anthropic cacheada al
  25-sep-2026]. Un comando típico (~3.000 tokens de entrada con esquema + resumen del proyecto, ~300 de
  salida) costaría ≈ US$0,018 (Opus 5.5), ≈ US$0,009 (Sonnet 5.5), ≈ US$0,0045 (Haiku 4.5), sin contar
  razonamiento interno [S, cálculo]. Elegir el modelo es decisión del dueño (Pregunta 8). Nota: en Opus 5.5
  no se puede forzar `tool_choice` a una herramienta (usar `auto` + `strict` o salida estructurada) [V].

### 9.2 Arquitectura propuesta

```
Barra de comandos (Ctrl+K, texto o dictado por Whisper)
   │
   ├─▶ 1. Gramática determinística (regex/intents) para lo frecuente:
   │      "exportá para reels" → {op:"export", preset:"reels-9x16"}  (sin LLM)
   │
   └─▶ 2. Si no matchea: LLM (Ollama local o Claude) con
          • system prompt fijo + catálogo de operaciones (JSON Schema)
          • resumen compacto del proyecto: pistas, clips (id, tipo, inicio, fin), duración,
            subtítulos (primeras palabras por segmento), presets disponibles
          • salida forzada por JSON Schema → EditPlan
   ▼
api: valida EditPlan con zod (packages/shared: EditOpSchema, aditivo)
   │  - rechaza ids inexistentes, tiempos fuera de rango, ops no permitidas
   ▼
web: muestra "Plan propuesto" (lista legible + vista previa en el timeline, en gris)
   │  [Aplicar] [Editar] [Cancelar]   ← siempre confirmación humana
   ▼
Aplicación: mutaciones del Project (un único paso deshacible) y/o encolar jobs existentes
(edit.silences, motion.render, project.export, vision.reframe, subtitles.transcribe …)
```

**Operaciones (v1):** `cutSilences{aggressiveness}`, `removeFillers{}`, `split{clipId,t}`,
`trim{clipId,start,end}`, `delete{clipId}`, `addTitle{text,t,duration,template,position}`,
`addSubtitles{style}`, `setVolume{clipId,db}`, `duckMusic{}`, `addSfx{query,t}`,
`reframe{aspect}`, `detectScenes{}`, `export{presetId,range?}`, `askClarification{question}`.

**Guardrails:**

- El LLM **nunca** recibe ni devuelve rutas de archivo, comandos FFmpeg ni código; solo ops del esquema.
- Tiempos siempre en segundos del timeline y validados contra la duración; anclas simbólicas permitidas
  ("después del segmento 3") que resuelve el código.
- Operaciones destructivas (borrar, export que sobrescribe) piden confirmación explícita.
- Máximo N ops por plan (p. ej. 20); si es ambiguo → `askClarification`.
- Con Claude: enviar solo el resumen del proyecto (nunca medios); aviso de privacidad y opción "solo
  local" por defecto.

**Lo que NO debe pasar por un LLM (determinístico):** detectar silencios/muletillas y calcular cortes;
transcribir y temporizar subtítulos; detección de escenas; cálculo de reencuadre y tracking; armado de
comandos FFmpeg/Remotion; presets de exportación y códecs; evitar solapes de clips (bug 5); validaciones
de consentimiento y licencias; cualquier medición de audio/video.

- Integración: api `POST /api/agent/plan {projectId, text, provider:"local"|"claude"}` → `EditPlan`
  (rápido, sin job) y `POST /api/agent/apply`. Esfuerzo **L** (esquema + UI de revisión + pruebas de
  frases en español rioplatense). Riesgo: modelos chicos inventan ids o tiempos → mitigado por validación
  y confirmación.

---

## 10. Concurrencia en 6 GB: presupuesto de GPU

### 10.1 Consumo estimado por modelo (residente) [S salvo indicación]

| Modelo                                                   | VRAM aprox.                 | ¿Puede convivir?        |
| -------------------------------------------------------- | --------------------------- | ----------------------- |
| Whisper large-v3-turbo fp16                              | 1,5–2,5 GB                  | Sí, con RVC o RVM       |
| Whisper large-v3 fp16 / int8                             | 4,5 GB / 2,9 GB [V 3070 Ti] | fp16: solo              |
| RVC (hubert + rmvpe + modelo)                            | 1–2 GB                      | Sí                      |
| RVM mobilenetv3 fp16 1080p                               | 0,4–0,8 GB                  | Sí                      |
| BiRefNet lite / completo fp16 1024                       | 1,5–2 GB / 3,5 GB [V 4090]  | completo: solo          |
| SAM 2.1 tiny/small (por tramos, offload)                 | 1,5–3 GB                    | Solo con modelos chicos |
| Face swap (detector + arcface + inswapper fp16 + GFPGAN) | 2,5–4 GB                    | Solo                    |
| Chatterbox / XTTS                                        | 3–5 GB / 2–3 GB             | Solo                    |
| LLM 4B Q4 / 8–9B Q4                                      | 2,5–3,5 GB / 5–6+ GB        | 8–9B: solo (y desborda) |
| NVENC (export en paralelo)                               | 0,2–0,5 GB                  | Sí                      |
| Chrome headless de Remotion                              | 0,2–1 GB (si usa GPU)       | Sí                      |

### 10.2 Gestor de presupuesto ("GPU budget") en los workers

- **Un solo proceso dueño de la GPU** (el worker FastAPI) con un `GpuBudget`:
  - presupuesto = `VRAM_total − reserva_sistema` (medido con `torch.cuda.mem_get_info()`/NVML al iniciar;
    reserva por defecto 0,8 GB);
  - cada motor declara `estimated_vram_mb` por configuración y se registra con `load()`/`unload()`;
  - antes de un job: si no entra, **descargar por LRU** (liberar sesión ONNX / `del model` +
    `torch.cuda.empty_cache()`), pedir a Ollama `keep_alive:0` y a subprocesos (Chatterbox, FaceFusion)
    que terminen;
  - si aun así no entra → **degradar** (modelo más chico, fp16→int8, tramos más cortos, `tile` menor) y,
    como último recurso, **CPU con aviso** al usuario ("Esto va a tardar ~X min en CPU. ¿Seguir?").
- **Política por defecto:** carril `workers` con concurrencia 1 (ya es así [V repo]); los modelos chicos
  (Whisper turbo, RVM) quedan residentes 5 min tras usarse; los grandes (face swap, TTS clonación, LLM 9B,
  SAM 2) se descargan **al terminar**.
- `GET /gpu/status` → `{totalMb, freeMb, loaded:[{engine, mb, lastUsed}], device:"cuda"|"cpu"}` para
  mostrar un **indicador de GPU** en la barra de estado del dashboard.
- **Trabajo por tramos + reanudación:** todo job de video procesa bloques (p. ej. 10 s / 300 cuadros),
  escribe resultados parciales en `storage/tmp/<jobId>/` y puede **reanudar** desde el último bloque si el
  proceso muere (falta de memoria, suspensión de la notebook, _thermal throttling_). Esto es lo que evita
  "morir en el proceso".
- **Driver NVIDIA:** desde 536.40 el driver de Windows, al llenarse la VRAM, **usa RAM compartida en lugar
  de dar error** → 5–10× más lento; desde 546.01 se puede elegir **"CUDA – Sysmem Fallback Policy: Prefer
  No Sysmem Fallback"** (falla rápido en vez de arrastrarse) [S]. Propuesta: dejarlo como está (no
  "muere") pero detectar la lentitud (fps < umbral) y avisar; documentarlo en `doctor.ps1`.
- **Test de rendimiento IA** (job `system.aibench`, ~1 min): mide fps reales de RVM, Whisper turbo, SAM 2
  tiny y un swap de 30 cuadros en la PC; guarda resultados en `settings` para mostrar estimaciones de
  tiempo reales en la UI ("~3 min").

### 10.3 Espacio en disco

| Paquete                               | Contenido                                                                                                                                                                                                                                                                                                         | Tamaño aprox.        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Ya instalado                          | torch cu128 + Whisper base/… + Piper + RVC base                                                                                                                                                                                                                                                                   | (actual) ~3–4 GB [S] |
| **"Paquete IA básico" (recomendado)** | Whisper large-v3-turbo (~1,6 GB [S]); `onnxruntime-gpu` 1.24.4 (~0,3 GB [S]); RVM fp16 (7 MB [V]); BiRefNet-lite (214 MB [V]); SAM 2.1 small (~176 MB [S]); PySceneDetect/TransNetV2 (~50 MB [S]); YuNet + MediaPipe (~50 MB [S]); Real-ESRGAN x4v3 (5 MB [V]); DeepFilterNet (~50 MB [S]); Kokoro (~0,35 GB [S]) | **≈ 3 GB**           |
| "Paquete Voz avanzada"                | venv Chatterbox con su torch 2.6 (~3 GB [S]) + modelo multilingüe/latam (~2–3 GB [S]); XTTS opcional (~1,9 GB [S])                                                                                                                                                                                                | **≈ 5–8 GB**         |
| "Paquete Cambio de cara"              | venv FaceFusion (~1,5–2,5 GB [S]) + modelos mínimos (≈ 1,35 GB [V suma])                                                                                                                                                                                                                                          | **≈ 3–4 GB**         |
| "Paquete Asistente local"             | Ollama (~1–2 GB con libs CUDA [S]) + Qwen3.5-4B (~3 GB [S]) [+ 9B ~5–6 GB opcional]                                                                                                                                                                                                                               | **≈ 4–11 GB**        |
| "Extras"                              | rife-ncnn-vulkan (431 MB [V]), MatAnyone, CoTracker3, SAM 2.1 base+/large                                                                                                                                                                                                                                         | ≈ 1–2 GB             |
| **Instalación completa**              | todo lo anterior                                                                                                                                                                                                                                                                                                  | **≈ 20–28 GB**       |

---

## 11. Requisitos del instalador incremental

1. **Manifiesto versionado** `models/manifest.json` (en el repo; nunca con claves):
   ```json
   {
     "schemaVersion": 1,
     "packages": [
       {
         "id": "rvm-mobilenetv3-fp16",
         "group": "basic",
         "version": "1.0.0",
         "url": "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp16.onnx",
         "mirrors": [],
         "sizeBytes": 7503483,
         "sha256": "<calcular al publicar>",
         "dest": "models/vision/rvm/rvm_mobilenetv3_fp16.onnx",
         "license": "GPL-3.0",
         "commercialUse": true,
         "gated": false,
         "requires": ["onnxruntime-gpu"]
       }
     ]
   }
   ```
   (`sizeBytes` real medido [V]; los `sha256` se calculan una vez al publicar el manifiesto y se fijan.) Grupos: `basic`, `voice-plus`,
   `faceswap`, `assistant`, `extras`; cada uno con casilla en el instalador y en **Ajustes › Modelos IA**.
2. **Saltear si existe:** comparar tamaño (rápido) y, en modo `-Verify`, sha256 (lento). Ya existe la base
   en `downloads.py` (`file_matches` con size/md5/sha256) [V repo].
3. **Reanudar descargas parciales:** conservar `<archivo>.part`, pedir `Range: bytes=<tamaño_actual>-`,
   aceptar `206` o reiniciar si el servidor responde `200`; validar sha256 al final y recién ahí renombrar.
   Hoy `downloads.py` hace `.part → rename` pero **no reanuda** [V repo]. Para Hugging Face,
   `huggingface_hub.hf_hub_download` ya reanuda solo [S]. Releases de GitHub redirigen a un CDN que
   acepta Range [S].
4. **Modo `-Update`:** leer manifiesto nuevo, comparar `version`/`sha256` por paquete, bajar solo lo
   cambiado, borrar lo obsoleto (con confirmación), y **no tocar** los venvs si su `requirements*.txt` no
   cambió (ya se hace con hash del requirements [V repo setup.ps1]).
5. **Venvs separados** para paquetes con dependencias incompatibles: `apps/workers/.venv` (principal),
   `tools/chatterbox/.venv`, `tools/facefusion/.venv`; Ollama como instalador oficial aparte (winget) [S].
6. **Fuentes con autenticación (HF "gated"):** SAM 3, pyannote, Llama/Gemma en HF, algunas voces. Política:
   **no incluir modelos gated en el paquete por defecto**; si el usuario quiere uno, el instalador pide
   el token una vez y lo guarda en `.env` (`HF_TOKEN=`, vacío en `.env.example`, nunca en el repo ni en
   logs/reportes); los modelos de Ollama no necesitan cuenta [S]. Preferir siempre espejos sin
   autenticación (releases de GitHub, `facefusion-assets` [V]).
7. **Licencias visibles:** el manifiesto trae `license` y `commercialUse`; la UI muestra un aviso y exige
   aceptar en los paquetes no comerciales (XTTS, inswapper, arcface, CodeFormer, CoTracker, MatAnyone).
8. **Mostrar espacio** requerido y libre antes de bajar; fallar con mensaje claro si no alcanza.
9. **Google Drive (RIFE oficial) no es apto** para descargas automáticas (cuotas/HTML intermedio) → usar
   rife-ncnn-vulkan de GitHub [V tamaño] o espejar los pesos.

---

## Tabla resumen

| Capacidad                        | Opción recomendada                                       | Licencia                            | VRAM (6 GB)      | Velocidad estimada en 4050 (1 min 1080p30) | Esfuerzo | Fase     |
| -------------------------------- | -------------------------------------------------------- | ----------------------------------- | ---------------- | ------------------------------------------ | -------- | -------- |
| Cortar silencios y muletillas    | Whisper palabras + FFmpeg `silencedetect` + revisión     | propia / MIT                        | 0–2 GB (Whisper) | análisis 5–15 s                            | M        | A        |
| Detección de escenas             | PySceneDetect Adaptive (+ TransNetV2 "preciso")          | BSD-3 / MIT                         | 0 / <0,5 GB      | 5–20 s                                     | S        | A        |
| NVENC en proxies/intermedios     | `h264_nvenc` p1–p3                                       | —                                   | 0,2–0,5 GB       | 2–5× más rápido que x264 [S]               | S        | A        |
| Ruido de voz / separar música    | DeepFilterNet / Demucs                                   | MIT / MIT                           | 0 / 1–2 GB       | 5–30 s                                     | S–M      | A        |
| Whisper mejor                    | large-v3-turbo fp16 batched                              | MIT                                 | 1,5–2,5 GB       | 3–8 s por min de audio                     | S        | A        |
| Quitar fondo persona (video)     | RobustVideoMatting fp16                                  | GPL-3.0                             | 0,4–0,8 GB       | 0,5–1,5 min                                | S–M      | B        |
| Quitar fondo (imagen)            | BiRefNet-lite (rembg/ONNX)                               | MIT                                 | 1,5–2 GB         | 0,1–0,2 s/imagen                           | S        | B        |
| Seleccionar objeto con clic      | SAM 2.1 tiny/small por tramos                            | Apache-2.0                          | 1,5–3 GB         | 2–4 min                                    | L        | B        |
| Tracking (caja/cara)             | SAM 2 → caja; CSRT; YuNet                                | Apache-2.0 / MIT                    | 0–3 GB           | 20 s–4 min                                 | M        | B        |
| Reencuadre 9:16                  | YuNet/MediaPipe + One-Euro + escenas                     | MIT / Apache-2.0                    | ~0 (CPU)         | análisis 15–40 s                           | M        | B        |
| Upscale                          | Real-ESRGAN general-x4v3 (×2)                            | BSD-3                               | 1–3 GB           | 3–6 min                                    | S–M      | B/C      |
| Cámara lenta                     | rife-ncnn-vulkan                                         | MIT                                 | 1–2 GB           | 2–5 min                                    | S–M      | C        |
| Cambio de cara                   | FaceFusion (inswapper fp16 / ghost) + compuerta          | OpenRAIL-AS + modelos **NC**/Apache | 2,5–4 GB         | 1,5–5 min                                  | L        | C        |
| TTS + clonación                  | Chatterbox Multilingual (es-mx-latam)                    | MIT                                 | 3–5 GB           | RTF 0,5–1,5                                | M        | C        |
| TTS rápido                       | Kokoro-82M                                               | Apache-2.0                          | 0 (CPU)          | > tiempo real                              | S        | C        |
| Agente por comandos              | Qwen3.5-4B en Ollama (+ Claude opcional) → EditPlan JSON | Apache-2.0 / pago                   | 2,5–3,5 GB       | 2–10 s por comando                         | L        | D        |
| Presupuesto de GPU + reanudación | `GpuBudget` + tramos                                     | propia                              | —                | —                                          | M        | A (base) |
| Instalador incremental           | manifiesto + Range + `-Update`                           | propia                              | —                | —                                          | M        | A        |

(Todas las velocidades en 4050 son **[S]** salvo que el texto de la sección diga otra cosa.)

---

## Propuesta por fases

**Fase A — Quick wins determinísticos (2–3 semanas de trabajo de implementación [S])**

- Cortar silencios y muletillas con diálogo de revisión (resuelve el pedido 10).
- Detección de escenas con marcadores y "dividir en escenas".
- NVENC en proxies e intermedios; HEVC/AV1 como opción de export.
- Whisper `large-v3-turbo` por defecto con GPU; DeepFilterNet para "limpiar voz".
- Base de infraestructura: `GpuBudget`, `GET /gpu/status`, jobs por tramos con reanudación,
  manifiesto de modelos + descargas reanudables + `-Update`, "Test de rendimiento IA".

**Fase B — Visión: SAM 2 + tracking + reencuadre**

- RVM "Quitar fondo (persona)" y BiRefNet para imágenes.
- SAM 2.1 interactivo (clic) + propagación por tramos → máscara y `track.json`.
- "Seguir objeto/cara" para overlays (requiere posición libre X/Y/escala, pedido 7).
- Reencuadre inteligente 9:16 en el preset Reels. Upscale ×2 para medios de baja resolución.

**Fase C — Cara y voz con consentimiento**

- Registro de Personas con consentimiento, auditoría y aviso "contenido alterado con IA" por defecto.
- FaceFusion en venv propio (inswapper fp16 / ghost + GFPGAN + NSFW activo).
- Chatterbox Multilingual (Latam) con clonación bajo la misma compuerta; Kokoro como voz rápida;
  XTTS solo si el dueño confirma uso no comercial. Cámara lenta (RIFE ncnn).

**Fase D — Agente de edición**

- Esquema `EditPlan` en `packages/shared`, gramática determinística para comandos comunes, Ollama +
  Qwen3.5-4B con salida por JSON Schema, UI "Plan propuesto" con aplicar/deshacer; Claude opcional.

---

## Preguntas para decidir (antes de implementar)

1. **¿Los videos se van a monetizar o usar para clientes?** Si sí, hay que excluir o limitar los modelos
   no comerciales (inswapper/arcface → el cambio de cara en general, XTTS, CodeFormer, CoTracker,
   MatAnyone) o aceptar el riesgo por escrito.
2. **¿Studio se va a compartir/distribuir alguna vez** (amigos, venta, repo público)? Si sí, conviene
   aislar todo lo GPL/AGPL (RVM, Piper GPL, FaceFusion) en procesos/plugins aparte desde el principio.
3. **¿El cambio de cara se usa solo con tu propia cara**, o también con terceros? (Define cuán estricta
   es la compuerta: "soy yo" vs. registro con evidencia del permiso.)
4. **¿El aviso visible "Contenido alterado con IA" debe ser obligatorio** (no desactivable) o activado por
   defecto pero desactivable?
5. **¿Cuánto disco estás dispuesto a usar?** Solo "Paquete IA básico" (~3 GB) o instalación completa
   (~20–28 GB)? ¿En qué unidad (C: o D:)?
6. **¿Preferís velocidad o calidad por defecto** en Whisper/recortes/swap (ej.: turbo vs. large-v3,
   inswapper fp16 vs. ghost + mejorador)?
7. **Si la GPU se queda sin memoria, ¿qué preferís?** (a) que siga en modo lento (RAM compartida/CPU) con
   aviso, o (b) que se detenga y te proponga una opción más liviana.
8. **Agente por comandos:** ¿solo local (gratis, más limitado) o habilitar Claude con tu API key para
   comandos complejos? Si es Claude: ¿qué modelo/costo aceptás (Opus 5.5 ≈ US$0,02, Sonnet 5.5 ≈
   US$0,01, Haiku 4.5 ≈ US$0,005 por comando)? ¿Está bien enviar el resumen del proyecto (sin medios)?
9. **Voz clonada:** ¿necesitás acento rioplatense específico? (Chatterbox tiene modelo "Latam" genérico;
   para rioplatense fino quizá haya que usar RVC encima de un TTS o grabar más referencia.)
10. **Prioridad entre fases B y C:** ¿qué te sirve primero, recorte/tracking/reencuadre para Reels o
    cambio de cara y voz? ¿Y el agente (D) es imprescindible o "lindo de tener"?

---

## Qué no se pudo verificar (pendientes para quien implemente)

- **Ningún benchmark en RTX 4050 Laptop**: todas las cifras de la 4050 son extrapolaciones → correr el
  "Test de rendimiento IA" en la PC real antes de prometer tiempos en la UI.
- Hugging Face bloqueado: tamaños exactos de checkpoints SAM 2.1, Whisper turbo, Kokoro (voces
  españolas), Chatterbox (VRAM real), F5-Spanish (licencia), CoTracker3, MatAnyone; licencia exacta de
  Qwen3.5 [U].
- `docs.facefusion.io` bloqueado: flags exactos de `headless-run`, condiciones del Windows Installer y
  texto completo de OpenRAIL-AS [U].
- `ollama.com` bloqueado: tamaños de `qwen3.5:4b/9b` [S de terceros].
- Nombres de trackers CSRT/KCF en OpenCV 5.0 [U]; soporte `sendcmd` para `crop`/`overlay` en la build de
  FFmpeg que instala `setup.ps1` [S].
- Marco legal: resumen de prensa/secundario, no asesoría legal [S].

---

## Fuentes

Primarias (leídas en esta sesión):

- SAM 2 README/INSTALL/LICENSE — https://github.com/facebookresearch/sam2
- SAM 3 README/LICENSE — https://github.com/facebookresearch/sam3
- EdgeTAM — https://github.com/facebookresearch/EdgeTAM
- RobustVideoMatting — https://github.com/PeterL1n/RobustVideoMatting
- MODNet — https://github.com/ZHKKKe/MODNet
- BiRefNet — https://github.com/ZhengPeng7/BiRefNet
- rembg — https://github.com/danielgatis/rembg
- MatAnyone / MatAnyone2 — https://github.com/pq-yang/MatAnyone · https://github.com/pq-yang/MatAnyone2
- CoTracker3 — https://github.com/facebookresearch/co-tracker
- PySceneDetect — https://github.com/Breakthrough/PySceneDetect · https://pypi.org/project/scenedetect/
- TransNetV2 — https://github.com/soCzech/TransNetV2 · https://pypi.org/project/transnetv2-pytorch/
- InsightFace — https://github.com/deepinsight/insightface · https://pypi.org/project/insightface/
- FaceFusion (README, `choices.py`, `installer.py`, módulos de modelos) — https://github.com/facefusion/facefusion · assets: https://github.com/facefusion/facefusion-assets/releases
- roop (archivado) — https://github.com/s0md3v/roop
- DeepFaceLive — https://github.com/iperov/DeepFaceLive
- SimSwap — https://github.com/neuralchen/SimSwap
- GFPGAN — https://github.com/TencentARC/GFPGAN · CodeFormer — https://github.com/sczhou/CodeFormer
- Real-ESRGAN — https://github.com/xinntao/Real-ESRGAN
- Practical-RIFE — https://github.com/hzwer/Practical-RIFE · ECCV2022-RIFE — https://github.com/hzwer/ECCV2022-RIFE · rife-ncnn-vulkan — https://github.com/nihui/rife-ncnn-vulkan
- faster-whisper — https://github.com/SYSTRAN/faster-whisper
- coqui-tts (fork idiap) — https://github.com/idiap/coqui-ai-TTS
- F5-TTS — https://github.com/SWivid/F5-TTS
- Kokoro — https://github.com/hexgrad/kokoro
- Fish-Speech — https://github.com/fishaudio/fish-speech
- Chatterbox — https://github.com/resemble-ai/chatterbox
- DeepFilterNet — https://github.com/Rikorose/DeepFilterNet · Demucs — https://pypi.org/project/demucs/
- auto-editor — https://github.com/WyattBlue/auto-editor
- MediaPipe LICENSE — https://github.com/google-ai-edge/mediapipe · Ultralytics LICENSE — https://github.com/ultralytics/ultralytics
- Ollama API (format JSON Schema, keep_alive) — https://github.com/ollama/ollama/blob/main/docs/api.md
- Qwen3 / Qwen3.5 README — https://github.com/QwenLM/Qwen3 · https://github.com/QwenLM/Qwen3.5
- PyPI (versiones/licencias): onnxruntime-gpu, mediapipe, opencv-contrib-python, coqui-tts, f5-tts, kokoro, llama-cpp-python, chatterbox-tts, ultralytics, ctranslate2, deepfilternet.
- Repo Studio: `apps/api/src/services/ffmpeg/encoders.ts`, `builders.ts`, `services/encoder-select.ts`, `jobs/queue.ts`, `apps/workers/studio_workers/stt/engine.py`, `downloads.py`, `requirements-cuda.txt`, `scripts/windows/setup.ps1`.

Secundarias:

- SAM 2 memoria — https://github.com/facebookresearch/sam2/issues/196
- Docker, evaluación de tool calling local (jun-2025) — https://www.docker.com/blog/local-llm-tool-calling-a-practical-evaluation/
- Qwen3 8B en Ollama — https://computingforgeeks.com/ollama-models-cheat-sheet/ · Qwen 3.5 pequeños — https://x.com/ollama/status/2028514180936908842
- Ollama keep_alive — https://docs.ollama.com/faq
- faster-whisper turbo — https://github.com/SYSTRAN/faster-whisper/issues/1030
- MediaPipe GPU en Windows — https://github.com/google/mediapipe/issues/4575 · https://github.com/google/mediapipe/issues/5126
- NVIDIA Sysmem Fallback — https://nvidia.custhelp.com/app/answers/detail/a_id/5490/~/system-memory-fallback-for-stable-diffusion
- XTTS licencia — https://github.com/coqui-ai/TTS/discussions/4304 · https://localaimaster.com/blog/xtts-coqui-commercial-license
- FaceFusion VRAM — https://docs.clore.ai/guides/face-and-identity/facefusion
- AI Act art. 50 — https://artificialintelligenceact.eu/transparency-rules-article-50/
- TAKE IT DOWN Act — https://www.congress.gov/bill/119th-congress/senate-bill/146/text · https://www.ftc.gov/business-guidance/blog/2026/05/take-it-down-act-enforcement-starts-now-what-know-about-ftc-tida
- Argentina deepfakes / art. 53 CCyC — https://www.perfil.com/noticias/opinion/proyecto-de-ley-de-deepfakes-en-argentina.phtml · https://www.esderecho.com.ar/derecho-imagen-inteligencia-artificial-argentina/
- Uruguay — https://www.elobservador.com.uy/nacional/personas-que-difundan-imagenes-sexuales-terceros-creadas-ia-podrian-ser-penalizados-avanza-nueva-reglamentacion-n6041804 · https://www.uypress.net/Actualidad/Uruguay-avanza-para-castigar-los-deepfakes-sexuales-sin-consentimiento-uc154313
- Políticas de plataformas — https://syncstudio.ai/blog/youtube-synthetic-content-disclosure · https://www.cinerads.com/blog/tiktok-ai-content-policy

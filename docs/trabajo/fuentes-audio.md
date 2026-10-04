# Fuentes de audio y voz — investigación técnica (Studio, Windows local)

Fecha de investigación: 2026-10-04. Destino: workers Python 3.11 detrás de backend Node, PC Windows limpia, GPU no garantizada (CUDA opcional).

**Leyenda de verificación** (el sandbox de investigación no alcanzaba huggingface.co, ffmpeg.org, pytorch.org ni docs de OpenAI/ElevenLabs/Freesound; por eso se marca cada dato):

- **[V]** verificado directamente (PyPI JSON, archivos raw de GitHub, descarga/HEAD de releases, o ejecución local de FFmpeg 6.1.1 con `--enable-librubberband`).
- **[S]** tomado de resultados de búsqueda web (snippet de la fuente oficial); confirmar al implementar.
- **[U]** no verificado (conocimiento previo / estimación); probar en la PC destino antes de depender de ello.

No hay API keys ni enlaces privados en este documento. Todos los comandos son para PowerShell salvo que se indique.

---

## 0. Tabla resumen

| Herramienta | Versión verificada | Licencia | ¿Funciona en CPU? | ¿GPU necesaria? |
|---|---|---|---|---|
| Piper (`piper-tts`, OHF-Voice/piper1-gpl) | 1.8.0 (2026-09-04) [V] | GPL-3.0-or-later (código); cada voz tiene su licencia | Sí, más rápido que tiempo real | No (`--cuda` opcional con onnxruntime-gpu) |
| Piper binario legacy (rhasspy/piper) | 2023.11.14-2, repo archivado 2025-10-06 [V] | MIT | Sí | No |
| Kokoro-82M (`kokoro`) | 0.9.4 [V] | Apache-2.0 (código y pesos) | Sí (torch CPU) | No |
| kokoro-onnx | 0.6.1 (2026-08-19) [V] | MIT (código) + pesos Apache-2.0 | Sí, sin torch | No |
| Coqui fork (`coqui-tts`, idiap) | 0.27.5 (2026-01-26) [V] | MPL-2.0 (código); pesos XTTS-v2 = CPML (no comercial) [V .models.json] | Sí pero lento (XTTS) [U] | Recomendada para XTTS |
| OpenAI TTS / ElevenLabs | API REST | Servicio de pago, ver ToS | n/a (nube) | No |
| RVC WebUI (RVC-Project) | rama main, Python 3.12 [V] | MIT [V] | Sí, lento [U] | No, pero CUDA acelera mucho |
| `infer-rvc-python` | 1.3.1 (2026-09-02) [V] | MIT [V] | Sí | Opcional |
| `rvc-python` (daswer123) | 0.1.5 (2024-11-04) [V] | MIT [V] | Sí | Opcional (pin fairseq, ver 2.3) |
| Applio | main, 2026 [V] | MIT + Terms of Use propios [V] | Sí | Opcional |
| faster-whisper | 1.2.1 (2025-10-31) [V] | MIT [V] | Sí (int8) | Opcional (cuBLAS 12 + cuDNN 9) |
| CTranslate2 | 4.8.2, wheel win cp311 [V] | MIT | Sí | Opcional |
| whisper.cpp | v1.9.4; binarios Windows en tag `b5130` [V] | MIT [V] | Sí | Opcional (cuBLAS/Vulkan) |
| FFmpeg (Gyan.FFmpeg full build) | 9.0.2 (2026-09-20) [V] | GPL-3.0-or-later (build full) [V Scoop] | Sí | No |
| audiowaveform (BBC) | 1.10.2 [V] | GPL-3.0 [V COPYING] | Sí | No |
| torch (PyPI, Windows cp311) | 2.14.1, wheel 124 MB = solo CPU [V] | BSD-style | Sí | CUDA solo vía índice `download.pytorch.org` |

---

## 1. TTS local y opcional por API

### 1.1 Piper

**Estado del proyecto [V].** `rhasspy/piper` fue archivado el 2025-10-06 (último release `2023.11.14-2`). El desarrollo continúa en **`OHF-Voice/piper1-gpl`** (Open Home Foundation, GPL-3.0, busca mantenedores). El paquete pip `piper-tts` 1.8.0 incorpora espeak-ng; **no hay que instalar eSpeak aparte**.

- Repo activo: https://github.com/OHF-Voice/piper1-gpl
- Repo legacy (MIT, archivado): https://github.com/rhasspy/piper
- PyPI: https://pypi.org/project/piper-tts/ — wheel `cp39-abi3-win_amd64` de 34 MB [V]; dependencias de runtime: `onnxruntime>=1,<2`, `pathvalidate>=3,<4`. Funciona en Python 3.11 sin compilar.

**Opción A (recomendada para el worker Python):**

```powershell
python -m venv .venv-audio
.\.venv-audio\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install piper-tts==1.8.0
python -m piper.download_voices es_AR-daniela-high --data-dir models\piper
python -m piper -m es_AR-daniela-high --data-dir models\piper -f out.wav -- "Hola, esto es una prueba."
```

Fuente de los comandos: `docs/CLI.md` de piper1-gpl [V]. Opciones útiles [V]: `--data-dir`, `-f/--output-file`, `--input-file`, `--sentence-silence <seg>`, `--volume <x>`, `--no-normalize`, `--cuda` (requiere `onnxruntime-gpu`), `--output-raw`. El CLI recarga el modelo en cada llamada; para uso repetido, cargar `PiperVoice` una vez en el worker (o usar el servidor HTTP, `pip install piper-tts[http]`).

API Python [V, `docs/API_PYTHON.md`]:

```python
import wave
from piper import PiperVoice, SynthesisConfig
voice = PiperVoice.load("models/piper/es_AR-daniela-high.onnx")   # busca el .onnx.json al lado
cfg = SynthesisConfig(volume=1.0, length_scale=1.0, noise_scale=0.667, noise_w_scale=0.8, normalize_audio=True)
with wave.open("out.wav", "wb") as f:
    voice.synthesize_wav("Hola mundo", f, syn_config=cfg)
```

`length_scale` > 1 = más lento. `PiperVoice.load(..., use_cuda=True)` requiere `onnxruntime-gpu` (1.30.0 tiene wheel win cp311 [V]; compatibilidad CUDA/cuDNN exacta [U]).

**Opción B: binario Windows legacy (sin Python).**

- URL [V, HTTP 200]: `https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip`
- Tamaño 22 477 236 bytes, SHA-256 `f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea` (calculado al descargar) [V].
- Contenido [V]: `piper/piper.exe`, `espeak-ng.dll`, `onnxruntime.dll`, `piper_phonemize.dll`, `libtashkeel_model.ort`, `espeak-ng-data/`. Trae espeak-ng embebido, tampoco necesita MSI.
- Uso [U, flags del Piper 1.2 legacy]: `echo Hola | .\piper\piper.exe -m es_ES-davefx-medium.onnx -f out.wav` (también `--output_file`, `--length_scale`, `--noise_scale`, `--noise_w`, `--sentence_silence`, `--speaker N`, `--json-input`, `--output-raw`).

Nota de licencias: el binario legacy es MIT; el paquete `piper-tts` es GPL-3.0. Para una app personal y local ambos sirven; si algún día se distribuye el producto, la GPL del paquete pip obliga a revisar.

**Voces en español** (repo https://huggingface.co/rhasspy/piper-voices). Lista y URLs exactas tomadas de `VOICES.md` de rhasspy/piper [V]. Cada voz = 2 archivos: `<id>.onnx` + `<id>.onnx.json`. (Ojo: en `VOICES.md` los enlaces de config tienen un sufijo erróneo `?download=true.json`; la URL correcta termina en `.onnx.json`.)

Patrón de URL: `https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/es/<region>/<voz>/<calidad>/<id>.onnx` (y `.onnx.json`). También funciona `resolve/main/...` (es lo que usa `piper.download_voices`).

| ID de voz | Calidad | Archivos | Notas |
|---|---|---|---|
| `es_AR-daniela-high` | high | `es_AR-daniela-high.onnx` / `.onnx.json` | Rioplatense; 22 050 Hz; dataset OpenSLR 61, CC BY-SA 4.0 [S]. **Mejor candidata para Uruguay.** |
| `es_MX-claude-high` | high | `es_MX-claude-high.onnx` / `.onnx.json` | Licencia del dataset Apache-2.0 [S]; español latino neutro. |
| `es_MX-ald-medium` | medium | `es_MX-ald-medium.onnx` / `.onnx.json` | Fine-tune de davefx; licencia "unlicense" [S]. |
| `es_ES-davefx-medium` | medium | `es_ES-davefx-medium.onnx` / `.onnx.json` | Masculina, castellano. Licencia: leer MODEL_CARD [U]. |
| `es_ES-sharvard-medium` | medium | `es_ES-sharvard-medium.onnx` / `.onnx.json` | Probablemente multi-speaker (ver `num_speakers` en el JSON) [U]. |
| `es_ES-mls_10246-low` | low | `es_ES-mls_10246-low.onnx` / `.onnx.json` | Calidad baja; MLS (típicamente CC BY 4.0) [U]. |
| `es_ES-mls_9972-low` | low | `es_ES-mls_9972-low.onnx` / `.onnx.json` | Ídem. |
| `es_ES-carlfm-x_low` | x_low | `es_ES-carlfm-x_low.onnx` / `.onnx.json` | Muy pequeña, solo para pruebas. |

URLs completas de ejemplo [V, construidas del VOICES.md]:

- https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/es/es_AR/daniela/high/es_AR-daniela-high.onnx
- https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/es/es_AR/daniela/high/es_AR-daniela-high.onnx.json
- https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/es/es_MX/claude/high/es_MX-claude-high.onnx
- https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/es/es_MX/claude/high/es_MX-claude-high.onnx.json
- https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/es/es_MX/ald/medium/es_MX-ald-medium.onnx
- https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/es/es_ES/davefx/medium/es_ES-davefx-medium.onnx
- https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/es/es_ES/sharvard/medium/es_ES-sharvard-medium.onnx
- https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/es/es_ES/carlfm/x_low/es_ES-carlfm-x_low.onnx
- https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/es/es_ES/mls_10246/low/es_ES-mls_10246-low.onnx
- https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/es/es_ES/mls_9972/low/es_ES-mls_9972-low.onnx

Todas las rutas siguen el patrón; los `.onnx.json` van con el mismo prefijo. Catálogo completo con tamaños, md5, `num_speakers`, `sample_rate`: https://huggingface.co/rhasspy/piper-voices/resolve/main/voices.json (es lo que lee `python -m piper.download_voices`; **el worker debería leerlo en vez de hardcodear tamaños**). Muestras de audio: https://rhasspy.github.io/piper-samples/

**Sample rate:** medium y high suelen ser **22 050 Hz**, low y x_low **16 000 Hz** [S/U]. La verdad está en `audio.sample_rate` del `.onnx.json` de cada voz: leerlo y resamplear a 48 000 Hz con FFmpeg antes de mezclar en el timeline. Salida: WAV PCM 16-bit mono.

Licencias: el `MODEL_CARD` de cada voz manda. Piper dice estar pensado para uso personal e investigación y no agrega restricciones, pero algunas voces tienen licencias restrictivas [V, VOICES.md]. Guardar la licencia de cada voz en la base de datos de assets.

### 1.2 Kokoro-82M (alternativa; sí soporta español)

- Modelo: https://huggingface.co/hexgrad/Kokoro-82M — Apache-2.0 (código y pesos) [V]. 82 M parámetros, salida **24 000 Hz** [V, README].
- Librería: https://github.com/hexgrad/kokoro, PyPI `kokoro` 0.9.4, `requires_python >=3.10,<3.13` (OK con 3.11) [V]; depende de `torch`, `transformers`, `huggingface-hub`, `misaki[en]` (este trae `espeakng-loader`, `phonemizer-fork`, `spacy`) [V].
- Español: `KPipeline(lang_code='e')`; voces **`ef_dora`** (femenina), **`em_alex`** y **`em_santa`** (masculinas) [S, VOICES.md]. El README indica que para idiomas no ingleses se usa espeak-ng; en Windows el README sugiere instalar el MSI de espeak-ng (https://github.com/espeak-ng/espeak-ng/releases); `espeakng-loader` ya empaqueta la librería, así que el MSI probablemente no haga falta [U, probar].
- Solo 3 voces en español, sin acento rioplatense declarado: sirve como segunda opción de calidad, no reemplaza a Piper daniela.

```python
from kokoro import KPipeline
import soundfile as sf
pipe = KPipeline(lang_code='e')
for i, (gs, ps, audio) in enumerate(pipe("Hola, esto es Kokoro.", voice='ef_dora', speed=1)):
    sf.write(f"k{i}.wav", audio, 24000)
```

**Variante sin torch: `kokoro-onnx` 0.6.1** (MIT, `>=3.10,<3.14`, deps: `onnxruntime>=1.20.1`, `espeakng-loader`, `phonemizer`, `numpy>=2.0.2`) [V]. Los archivos de modelo se bajan de GitHub (no hace falta Hugging Face) [V, HTTP 200]:

- https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
- https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx (cuantizado, más liviano)
- https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin

(El README del repo apunta también a `model-files-v1.1`; confirmar cuál es el vigente al implementar.)

### 1.3 Coqui TTS / XTTS-v2 (fork mantenido)

- Original `coqui-ai/TTS` (PyPI `TTS` 0.22.0, `<3.12`, 2023-12) está sin mantenimiento [V]. Fork activo: **https://github.com/idiap/coqui-ai-TTS**, PyPI **`coqui-tts` 0.27.5** (2026-01-26), MPL-2.0, `>=3.10,<3.15` [V].
- Desde 0.27.4 **torch ya no viene incluido**: instalarlo antes (ver 2.4). Hay wheels para Windows desde 0.24.2 [V, README].
- XTTS-v2: 17 idiomas (incluye `es`), clonación de voz con un WAV de referencia (`speaker_wav`), streaming <200 ms en GPU [V, README]. **Licencia de pesos: CPML (no comercial) y `tos_required: true`** [V, `.models.json`]. Peso aprox. 1.8 GB [U]. En CPU es lento (varias veces más lento que tiempo real) [U].

```python
import torch
from TTS.api import TTS
dev = "cuda" if torch.cuda.is_available() else "cpu"
tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to(dev)
tts.tts_to_file(text="Hola mundo", speaker_wav="mi_voz.wav", language="es", file_path="out.wav")
```

Recomendación: tratarlo como opcional "clonación sin entrenar" solo si hay GPU; no es dependencia base.

### 1.4 TTS por API (opcional, sin keys)

**OpenAI** [S, platform.openai.com/docs/api-reference/audio/createSpeech]

- `POST https://api.openai.com/v1/audio/speech`
- Header: `Authorization: Bearer $OPENAI_API_KEY`, `Content-Type: application/json`
- Body: `{"model":"gpt-4o-mini-tts","input":"texto (máx 4096 caracteres)","voice":"alloy","response_format":"wav","speed":1.0,"instructions":"tono cálido, acento rioplatense"}`
- `model`: `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts` (y fecha-versionados). `response_format`: mp3 (default), opus, aac, flac, wav, pcm. `speed` 0.25–4.0. `instructions` no aplica a `tts-1`/`tts-1-hd`. Lista de voces: alloy, echo, fable, onyx, nova, shimmer (+ otras más recientes; consultar docs). Respuesta: bytes de audio.
- Variable de entorno: `OPENAI_API_KEY`.

**ElevenLabs** [S, elevenlabs.io/docs/api-reference/text-to-speech/convert]

- `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128`
- Header: `xi-api-key: $ELEVENLABS_API_KEY`, `Content-Type: application/json`
- Body: `{"text":"...","model_id":"eleven_multilingual_v2","voice_settings":{"stability":0.5,"similarity_boost":0.75}}` (`model_id` por defecto `eleven_multilingual_v2`)
- Listar voces: `GET /v1/voices`. Respuesta: bytes de audio.
- Variable de entorno: `ELEVENLABS_API_KEY`.

En `.env.example`: `OPENAI_API_KEY=`, `ELEVENLABS_API_KEY=`, `FREESOUND_API_KEY=` (vacíos). El backend Node debe llamar a la API (no el navegador) para no exponer keys.

---

## 2. Conversión de voz RVC

### 2.1 Proyecto, licencia y activos

- Repo: https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI — **licencia MIT** [V, LICENSE: Copyright 2023 liujing04, 源文雨, Ftps]. README dice que los modelos base se entrenaron con ~50 h de VCTK (sin problemas de copyright).
- El README de `main` ahora apunta a **Python 3.12** y usa `requirments_cpu_py312.txt`, `requirments_cu128_py312.txt` (RTX 50) o `requirments_cu118_py312.txt` (el nombre lleva la errata "requirments", es real) [V]. Para un worker en 3.11 conviene usar una librería de inferencia (2.3) en vez de la WebUI.
- **Activos obligatorios para inferencia**:
  - HuBERT: formato legacy `hubert_base.pt` → https://huggingface.co/lj1995/VoiceConversionWebUI/resolve/main/hubert_base.pt [S]. Formato actual de `main` (transformers): `assets/hubert_base/{config.json, preprocessor_config.json, pytorch_model.bin}`, comando oficial: `hf download lj1995/VoiceConversionWebUI --revision main --include "hubert_base/*" --local-dir assets` [V].
  - RMVPE: https://huggingface.co/lj1995/VoiceConversionWebUI/resolve/main/rmvpe.pt [S]; comando oficial `hf download lj1995/VoiceConversionWebUI rmvpe.pt --revision main --local-dir assets/rmvpe` [V]. `rmvpe.onnx` solo para DirectML (AMD/Intel en Windows).
  - Para **entrenar** (no necesario para solo convertir): `pretrained/*`, `pretrained_v2/*`, `mute.zip` del mismo repo [V].
  - Mirrors usados por librerías: `Daswer123/RVC_Base` (`hubert_base.pt`, `rmvpe.pt`, `rmvpe.onnx`; lo descarga `rvc-python` solo) [V código]; `r3gm/sonitranslate_voice_models/rmvpe.pt` y `r3gm/hubert_base` (los usa `infer-rvc-python`) [V código].
- Instalar el CLI de HF: `pip install -U huggingface_hub` (comando `hf`).

### 2.2 Formato de modelos de voz

Un modelo RVC = **`.pth`** (obligatorio) + **`.index`** (FAISS, opcional pero mejora el parecido). Estructura que espera `rvc-python`: `rvc_models/<nombre>/<nombre>.pth` y `<nombre>.index` [V]. Muchos repos los publican en `.zip` con ambos archivos. Sample rate de salida del modelo: 32k/40k/48k según el modelo [U].

**De dónde sacar modelos legalmente** (el punto crítico es el consentimiento y la licencia de la voz, no el formato):

1. **Entrenar tu propia voz o la de personas que den consentimiento** con RVC/Applio (README recomienda ≥10 min de audio limpio) [V]. Es la vía sin riesgo.
2. **Hugging Face**: repos de usuarios que declaran licencia explícita (CC0, CC-BY, MIT) en la model card. Revisar cada uno; muchos no declaran nada.
3. **voice-models.com**: directorio comunitario con decenas de miles de modelos (anime, celebridades, etc.) que enlaza a Hugging Face [S]; **no hay una licencia única** y buena parte son voces de personas reales/personajes protegidos sin permiso. Úsalo solo para voces con licencia o consentimiento claro; no imitar a personas reales para engañar ni publicar.
4. Applio publica sus propios modelos base bajo MIT, pero sus **Terms of Use** piden respetar copyright y privacidad si se usa la versión oficial [V].

Regla para Studio: guardar en la base de assets `license`, `source_url` y `consent_note` por modelo, y mostrar un aviso en la UI al convertir ("usa solo voces con permiso").

### 2.3 Librerías de inferencia (sin WebUI)

| Librería | Estado | Dependencias críticas | Veredicto en Win + Py 3.11 |
|---|---|---|---|
| **`infer-rvc-python` 1.3.1** (R3gm) | MIT, 2026-09-02, `>=3.10,<4` [V] | `torch`, `torchaudio`, `torchvision`, `faiss-cpu==1.10.0`, `pyworld==0.3.4`, `torchcrepe==0.0.20`, `typeguard==4.2.0`, `soxr==1.1.0`, `transformers`, `librosa`, `praat-parselmouth` | **Recomendada.** Todas con wheel `cp311 win_amd64` [V]. Sin `fairseq`. Requisito previo del README: `pip install "pip>=24" "setuptools<=80.6.0"` [V]. |
| `rvc-python` 0.1.5 (daswer123) | MIT, 2024-11-04 [V] | `fairseq==0.12.2`, `omegaconf==2.0.6`, `numpy<=1.23.5`, `faiss-cpu==1.7.3` | `fairseq 0.12.2` en PyPI **solo tiene wheels hasta cp38 Linux/mac y sdist** (sin wheel Windows) [V]; compilarlo en Windows exige MSVC y suele fallar en 3.11. El README recomienda Python 3.10 [V]. Usar solo en venv 3.10 aislado. |
| Applio (IAHispano) | MIT, 2026; "ya no recibirá actualizaciones frecuentes" [V] | Python 3.10 (su instalador) [U] | Alternativa si se quiere UI externa; no es librería embebible. |
| RVC WebUI | MIT [V] | Python 3.12 | Para entrenar; no como worker. |

Uso de `infer-rvc-python` [V, README]:

```python
from infer_rvc_python import BaseLoader
converter = BaseLoader(only_cpu=True, hubert_path=None, rmvpe_path=None)  # only_cpu=False si hay CUDA
converter.apply_conf(tag="mi_voz", file_model="models/rvc/mi_voz/mi_voz.pth",
    pitch_algo="rmvpe+", pitch_lvl=0, file_index="models/rvc/mi_voz/mi_voz.index",
    index_influence=0.66, respiration_median_filtering=3, envelope_ratio=0.25,
    consonant_breath_protection=0.33)
out_paths = converter(["entrada.wav"], ["mi_voz"], overwrite=False, parallel_workers=1)
```

Parámetros equivalentes en `rvc-python` CLI [V]: `python -m rvc_python cli -i in.wav -o out.wav -mp model.pth -ip model.index -de cpu -me rmvpe -pi 0 -ir 0.5 -fr 3 -rmr 0.25 -pr 0.33` (`-de cuda:0` para GPU). Métodos de pitch: `rmvpe` (mejor), `harvest`, `crepe`, `pm` (más rápido, peor calidad).

Los modelos de pitch/HuBERT se descargan solos al primer uso (necesitan internet una vez); para instalación offline, pre-descargarlos con el script de setup y pasar `hubert_path`/`rmvpe_path`.

### 2.4 CPU vs CUDA y comandos de torch en Windows

- **CPU**: viable para clips cortos en modo offline (cola de trabajos). Orden de magnitud [U]: del mismo orden que la duración del audio con `rmvpe` en una CPU moderna; GPU lo baja a una fracción. **Medir en la PC destino** y mostrar progreso/ETA en la UI.
- Hecho verificado: el wheel de PyPI `torch-2.14.1-cp311-cp311-win_amd64.whl` pesa **124 MB**, es decir **solo CPU**; en Windows la versión con CUDA solo está en el índice de PyTorch [V tamaños, S].

```powershell
# CPU (Windows, cualquier equipo)
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu

# NVIDIA CUDA 12.8 (comando verificado en el README de RVC con torch 2.7.1)
pip install torch==2.7.1 torchaudio==2.7.1 --index-url https://download.pytorch.org/whl/cu128 --extra-index-url https://pypi.org/simple

# NVIDIA CUDA 12.6 (series 2.10/2.11 publican cu126, cu128 y cu130) [S]
pip install torch==2.11.0 torchaudio==2.11.0 --index-url https://download.pytorch.org/whl/cu126

# Verificación
python -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available())"
```

Notas: los wheels CUDA ya incluyen el runtime de CUDA/cuDNN; solo hace falta un **driver NVIDIA reciente** (para cu128 hace falta un driver de la rama 570+ [U]). RTX serie 50 requiere cu128 o superior [V, README RVC]. Desde torch 2.11 el `pip install torch` de PyPI en Linux instala CUDA 13 por defecto [S]; en Windows sigue siendo CPU. Mantener **dos requirements** (`requirements-cpu.txt` / `requirements-cuda.txt`) y que el setup detecte `nvidia-smi`.

---

## 3. Voz a texto (subtítulos): faster-whisper y whisper.cpp

### 3.1 faster-whisper

- Repo https://github.com/SYSTRAN/faster-whisper — **MIT** [V]. PyPI `faster-whisper` **1.2.1** (2025-10-31), `>=3.9` [V]. Depende de `ctranslate2>=4,<5` (4.8.2 tiene wheel `cp311 win_amd64` de 19 MB), `huggingface-hub`, `tokenizers`, `onnxruntime` (para Silero VAD) y `av` (PyAV con FFmpeg embebido: **no necesita FFmpeg en el sistema** para decodificar) [V].
- Instalar: `pip install faster-whisper==1.2.1`.
- Los modelos se descargan de Hugging Face la primera vez (`Systran/faster-whisper-*`); fijar la carpeta con `WhisperModel(name, download_root="models/whisper")` o la variable `HF_HOME`.

**Modelos disponibles** (nombres reales de `faster_whisper/utils.py`) [V]: `tiny`, `tiny.en`, `base`, `base.en`, `small`, `small.en`, `medium`, `medium.en`, `large-v1`, `large-v2`, `large-v3` (alias `large`), `large-v3-turbo` (alias `turbo`, `mobiuslabsgmbh/faster-whisper-large-v3-turbo`), `distil-large-v2`, `distil-large-v3`, `distil-large-v3.5`, `distil-medium.en`, `distil-small.en`. Los `.en` y los `distil-*` son **solo inglés**: para español usar los multilingües.

Tamaño en disco aproximado en fp16 [U]: tiny 75 MB, base 145 MB, small 480 MB, medium 1.5 GB, large-v3 3 GB, turbo 1.6 GB.

**Velocidad en CPU** (benchmark del README: 13 min de audio, i7-12700K, 8 hilos, beam 5, modelo `small`) [V]:

| Config | Tiempo | RAM |
|---|---|---|
| faster-whisper fp32 | 2m37s | 2257 MB |
| faster-whisper int8 | 1m42s (~7.6x tiempo real) | 1477 MB |
| faster-whisper int8, `batch_size=8` | 51s | 3608 MB |
| whisper.cpp fp32 (referencia) | 2m05s | 1049 MB |

En GPU (RTX 3070 Ti, large-v2, 13 min): fp16 1m03s; int8 59s; con `batch_size=8` 17s [V]. Estimación para planificar [U]: en CPU, `medium` es ~3x más lento que `small`; `large-v3` en CPU es poco práctico para videos largos. Sugerencia de defaults: CPU → `small` + `int8`; GPU → `large-v3-turbo` o `large-v3` + `float16`.

**CUDA en Windows [V + U].** Requiere **cuBLAS 12 y cuDNN 9 para CUDA 12** (las versiones recientes de ctranslate2 solo soportan CUDA 12 + cuDNN 9; para CUDA 11/cuDNN 8 hay que bajar ctranslate2) [V, README]. Tres vías:

1. Instalar CUDA Toolkit 12.x y cuDNN 9 desde NVIDIA y dejarlos en `PATH` (vía oficial).
2. **Vía pip en Windows**: el README dice "Linux only", pero PyPI sí publica wheels `win_amd64` de `nvidia-cublas-cu12` 12.9.2.10 (553 MB) y `nvidia-cudnn-cu12` 9.27.0.42 (743 MB) [V]. Hay que añadir `site-packages\nvidia\cublas\bin` y `site-packages\nvidia\cudnn\bin` al `PATH` o usar `os.add_dll_directory(...)` antes de importar `ctranslate2` [U, probar].
3. Descargar el paquete de DLLs de Purfview: https://github.com/Purfview/whisper-standalone-win/releases/tag/libs y ponerlas en una carpeta del `PATH` [V, README].

Si se cargó antes `torch` con CUDA 12.x en el mismo proceso, a veces ctranslate2 reutiliza sus DLLs [U]. Implementar **fallback automático**: intentar `device="cuda"`; si falla al cargar, volver a `device="cpu", compute_type="int8"` y avisar.

**Uso recomendado para subtítulos animados (español):**

```python
from faster_whisper import WhisperModel
model = WhisperModel("small", device="cpu", compute_type="int8", download_root="models/whisper")
segments, info = model.transcribe(
    "audio_16k.wav", language="es", beam_size=5,
    word_timestamps=True, vad_filter=True,
    vad_parameters=dict(min_silence_duration_ms=500),
    condition_on_previous_text=False)
data = {"language": info.language, "duration": info.duration, "segments": []}
for s in segments:                       # es un generador: la transcripción corre aquí
    data["segments"].append({"id": s.id, "start": s.start, "end": s.end, "text": s.text,
        "words": [{"word": w.word, "start": w.start, "end": w.end, "probability": w.probability} for w in s.words]})
```

- `Segment` tiene `id, seek, start, end, text, tokens, avg_logprob, compression_ratio, no_speech_prob, words, temperature`; `Word` tiene `start, end, word, probability` [V, `transcribe.py`].
- **VAD** (Silero, integrado): `vad_filter=True`. Defaults [V, `vad.py`]: `threshold=0.5`, `min_silence_duration_ms=2000`, `speech_pad_ms=400`, `min_speech_duration_ms=0`, `max_speech_duration_s=inf`. Bajar `min_silence_duration_ms` a ~500 para cortes más finos. En `BatchedInferencePipeline` el VAD viene activo por defecto [V].
- Extraer audio del video antes (barato, evita problemas de códecs): `ffmpeg -i video.mp4 -vn -ac 1 -ar 16000 -c:a pcm_s16le audio_16k.wav`.
- `word.word` incluye el espacio inicial (" Hola"): hacer `.strip()`.

**Exportación.** Guardar siempre el **JSON a nivel de palabra** como fuente de verdad (alimenta Remotion para subtítulos animados) y derivar SRT/ASS. Esquema sugerido (`words[]` en segundos, floats):

```json
{"language":"es","duration":12.4,"model":"small",
 "segments":[{"id":0,"start":0.0,"end":1.8,"text":"Hola mundo",
   "words":[{"word":"Hola","start":0.0,"end":0.5,"probability":0.97},{"word":"mundo","start":0.6,"end":1.1,"probability":0.95}]}]}
```

Conversión probada localmente (SRT y ASS se renderizaron sin error con los filtros `subtitles=` y `ass=` de FFmpeg) [V]:

```python
def srt_t(s):
    ms = round(s*1000); h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); sec, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{sec:02},{ms:03}"
def ass_t(s):
    cs = round(s*100); h, cs = divmod(cs, 360000); m, cs = divmod(cs, 6000); sec, cs = divmod(cs, 100)
    return f"{h}:{m:02}:{sec:02}.{cs:02}"
# SRT:  "<n>\n<srt_t(start)> --> <srt_t(end)>\n<texto>\n"
# ASS karaoke: "Dialogue: 0,<ass_t(start)>,<ass_t(end)>,Default,,0,0,0,,{\kf50}Hola {\kf50}mundo"
#   \kf<centisegundos> = relleno progresivo por palabra; usar (start_siguiente - start_palabra) como duración para respetar pausas.
```

Cabecera ASS mínima: `[Script Info]` (`ScriptType: v4.00+`, `PlayResX/Y`), `[V4+ Styles]` con `Format:`/`Style:` y `[Events]` con `Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text`. Quemar en el video con `ffmpeg -i in.mp4 -vf "ass=subs.ass" ...` (en Windows, para rutas con `C:` usar comillas y escapar: `ass='C\:/ruta/subs.ass'`, o ejecutar con `cwd` en la carpeta y ruta relativa). Para subtítulos animados "estilo TikTok" lo mejor es Remotion leyendo el JSON, no ASS.

### 3.2 Alternativa: whisper.cpp

- Repo https://github.com/ggml-org/whisper.cpp — **MIT** [V]. Última release `v1.9.4` (según Scoop) [V]; **los binarios de Windows no están en el tag `v1.9.4` sino en el tag de build `b5130`** (el manifiesto de Scoop los toma de ahí) [V, HTTP 200 + listado del zip]:
  - https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip (8.5 MB, carpeta `Release/` con `whisper-cli.exe`, `whisper-server.exe`, `whisper-quantize.exe`, `whisper-vad-speech-segments.exe`, DLLs `ggml-cpu-*.dll` que eligen la ISA de la CPU)
  - https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-cublas-12.4.0-bin-x64.zip (CUDA 12.4) [V, HEAD 200]
  - https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-cublas-11.8.0-bin-x64.zip [V, HEAD 200]
  - https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-blas-bin-x64.zip [V, HEAD 200]
  - Convención del nombre de tag/versionado puede cambiar: buscar en la página de releases el build que enlaza la nota de la última versión. `releases/latest/download/...` redirige al tag `v1.9.4` que NO tiene esos assets [V].
- Modelos `ggml-*.bin`: `models\download-ggml-model.cmd small` (script del repo, Windows) [V]; origen https://huggingface.co/ggerganov/whisper.cpp/tree/main [V, nota de Scoop], p. ej. `.../resolve/main/ggml-small.bin` [U]. Se pueden cuantizar con `whisper-quantize`.
- Flags de `whisper-cli` [V, `examples/cli/README.md`]: `-m <modelo>`, `-f <wav>`, `-l es` (o `auto`), `-osrt`, `-ovtt`, `-otxt`, `-oj` / `-ojf` (JSON completo), `-ocsv`, `-olrc`, `-of <prefijo_salida>`, `-ml N` (largo máx. de segmento en caracteres), `-sow` (cortar por palabra), `--prompt`. **Timestamps por palabra:** `-ml 1` (con `-sow`) [V, README].
- Ejemplo: `.\whisper-cli.exe -m models\ggml-small.bin -f audio_16k.wav -l es -ml 1 -sow -ojf -osrt -of salida`.
- Entrada: WAV 16 kHz mono 16-bit es lo seguro [U]; convertir con FFmpeg.
- Comparado con faster-whisper: menor RAM y sin Python, pero el JSON por palabra queda como "un segmento por palabra" (más trabajo de post-proceso) y la GPU requiere el build cuBLAS. **Se recomienda faster-whisper como motor principal y whisper.cpp como plan B** (si falla la instalación de ctranslate2/CUDA).

---

## 4. Efectos de voz solo con FFmpeg

**Verificación:** todos los comandos de esta sección se ejecutaron localmente contra FFmpeg 6.1.1 (Linux, con `--enable-librubberband`, `arnndn`, `afftdn`, `afir`, `sidechaincompress`, `loudnorm`) y terminaron sin error [V]. En Windows el build **Gyan.FFmpeg full 9.0.2** [V] debería comportarse igual; confirmar `rubberband` con `ffmpeg -hide_banner -filters | findstr rubberband` [U: se espera presente en el build *full*; el *essentials* no tiene todas las libs].

Convenciones: `IN` = entrada (audio o video), `OUT` = salida. Desde Node usar `child_process.spawn('ffmpeg', [...args])` con el filtro como **un solo argumento** (sin shell): se evita todo el infierno de comillas de cmd/PowerShell. Para aplicar a un video conservando la imagen: `ffmpeg -y -i IN.mp4 -map 0:v -map 0:a -c:v copy -af "FILTRO" -c:a aac -b:a 192k OUT.mp4`. Para solo audio: `ffmpeg -y -i IN.wav -af "FILTRO" -ar 48000 OUT.wav`.

**Fórmula de semitonos:** `r = 2^(n/12)`: +2 → 1.122462, +4 → 1.259921, +7 → 1.498307, +12 → 2.0, −4 → 0.793701, −7 → 0.667420, −12 → 0.5. `atempo` acepta 0.5–100 en esta versión [V]; fuera de rango, encadenar varios `atempo`.

### 4.1 Pitch arriba/abajo conservando duración

Opción 1, **rubberband** (mejor calidad, mantiene tempo y permite preservar formantes) [V]:

```
ffmpeg -y -i IN.wav -af "rubberband=pitch=1.259921:formant=preserved:pitchq=quality:transients=smooth:window=long" OUT.wav
ffmpeg -y -i IN.wav -af "rubberband=pitch=0.793701:formant=preserved" OUT.wav
```

Opciones de `rubberband` [V]: `tempo` (0.01–100), `pitch` (0.01–100), `transients` (crisp|mixed|smooth), `detector`, `phase` (laminar|independent), `window` (standard|short|long), `smoothing`, `formant` (shifted|preserved), `pitchq` (speed|quality|consistency), `channels` (apart|together). Además sirve para cambiar velocidad sin tocar el tono: `rubberband=tempo=1.25`.

Opción 2, **sin rubberband** (`asetrate` + `aresample` + `atempo`), independiente de la sample rate de entrada porque se normaliza a 48 k primero [V]:

```
# +4 semitonos (más agudo)
ffmpeg -y -i IN.wav -af "aresample=48000,asetrate=48000*1.259921,aresample=48000,atempo=0.793701" OUT.wav
# -4 semitonos (más grave)
ffmpeg -y -i IN.wav -af "aresample=48000,asetrate=48000*0.793701,aresample=48000,atempo=1.259921" OUT.wav
```

Regla: `asetrate=48000*R` y `atempo=1/R`. Esta opción también desplaza los formantes (suena más "ardilla" o más "monstruo").

### 4.2 Chipmunk y voz grave

```
# Chipmunk (ardilla): +7 semitonos aprox., formantes subidos
ffmpeg -y -i IN.wav -af "aresample=48000,asetrate=48000*1.5,aresample=48000,atempo=0.666667" OUT.wav
# Chipmunk más natural con rubberband
ffmpeg -y -i IN.wav -af "rubberband=pitch=1.6:formant=preserved" OUT.wav
# Voz grave / profunda (demonio suave)
ffmpeg -y -i IN.wav -af "aresample=48000,asetrate=48000*0.75,aresample=48000,atempo=1.333333,lowpass=f=6000" OUT.wav
ffmpeg -y -i IN.wav -af "rubberband=pitch=0.7:formant=shifted,lowpass=f=7000" OUT.wav
```

### 4.3 Robot / tipo vocoder

FFmpeg **no trae un vocoder real** (no hay filtro de síntesis con portadora). Aproximaciones útiles [V]:

```
# Robot "metálico" (fase cero, ejemplo de la documentación de afftfilt)
ffmpeg -y -i IN.wav -af "aresample=48000,afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75,volume=1.5" OUT.wav

# Susurro / voz espectral (fase aleatoria, ejemplo de la documentación)
ffmpeg -y -i IN.wav -af "afftfilt=real='hypot(re,im)*cos((random(0)*2-1)*2*3.14)':imag='hypot(re,im)*sin((random(1)*2-1)*2*3.14)':win_size=128:overlap=0.8" OUT.wav

# Dalek / modulación en anillo (voz x seno 30 Hz); se necesita filter_complex
ffmpeg -y -i IN.wav -filter_complex "[0:a]aresample=48000,aformat=channel_layouts=mono[v];sine=f=30:r=48000,aformat=channel_layouts=mono[m];[v][m]amultiply,volume=2" OUT.wav

# Robot con trémolo + eco corto
ffmpeg -y -i IN.wav -af "tremolo=f=60:d=1,aecho=0.8:0.88:6:0.4" OUT.wav
```

Para un vocoder auténtico habría que usar un worker Python (p. ej. con RVC, `pedalboard` [GPL-3.0, 0.9.25] o DSP propio); queda fuera del alcance "solo FFmpeg".

### 4.4 Teléfono, radio, megáfono, bajo el agua

```
# Teléfono (banda 300-3400 Hz + compresión)
ffmpeg -y -i IN.wav -af "highpass=f=300,lowpass=f=3400,acompressor=threshold=-18dB:ratio=4,volume=1.5" OUT.wav

# Radio AM / walkie (más estrecho + saturación ligera)
ffmpeg -y -i IN.wav -af "highpass=f=400,lowpass=f=3000,acrusher=bits=8:mix=0.3:mode=log:aa=1,compand=attacks=0:points=-80/-80|-30/-10|0/-3,volume=1.2" OUT.wav

# Megáfono
ffmpeg -y -i IN.wav -af "highpass=f=500,lowpass=f=4000,acrusher=bits=10:mix=0.4,acompressor=threshold=-20dB:ratio=6:makeup=6" OUT.wav

# Bajo el agua
ffmpeg -y -i IN.wav -af "lowpass=f=800,aecho=0.8:0.8:40:0.5,vibrato=f=4:d=0.3" OUT.wav
```

### 4.5 Eco y reverb

```
# Eco simple (60 ms) / eco largo estilo cañón (500 ms y 1 s)
ffmpeg -y -i IN.wav -af "aecho=0.8:0.88:60:0.4" OUT.wav
ffmpeg -y -i IN.wav -af "aecho=0.8:0.9:500|1000:0.2|0.1" OUT.wav

# Reverb "de sala" barata con aecho multitap
ffmpeg -y -i IN.wav -af "aecho=0.8:0.7:20|40|60|80:0.4|0.3|0.2|0.1" OUT.wav

# Reverb real por convolución con una respuesta al impulso (IR) -> afir
# 1) IR sintética de 1.5 s (ruido con decaimiento exponencial), solo si no hay IR real
ffmpeg -y -f lavfi -i "aevalsrc='random(0)*exp(-t*5)':d=1.5:s=48000:c=mono" -af "aformat=sample_fmts=fltp" ir.wav
# 2) mezcla seca/mojada controlada (wet 35 %), evita que afir cambie mucho el volumen
ffmpeg -y -i IN.wav -i ir.wav -filter_complex "[0:a]asplit[d][w];[w][1:a]afir=dry=0:wet=1:gtype=gn[wr];[d][wr]amix=inputs=2:weights='1 0.35':normalize=0" OUT.wav
```

Para reverb realista usar IRs con licencia libre (p. ej. packs CC0 de IR en Freesound/OpenAIR [U]); guardar `kind='ir'` en la biblioteca. Con `afir` el IR debe estar a la misma sample rate que la voz (usar `aresample=48000` en ambos) [U]. El eco largo alarga el archivo (`aecho` de 1 s añade ~1 s de cola): usar `apad` si hay que mantener duración.

### 4.6 Vibrato, coro y otros

```
ffmpeg -y -i IN.wav -af "vibrato=f=6:d=0.5" OUT.wav
ffmpeg -y -i IN.wav -af "chorus=0.5:0.9:50|60|40:0.4|0.32|0.3:0.25|0.4|0.3:2|2.3|1.3" OUT.wav
ffmpeg -y -i IN.wav -af "atempo=1.25" OUT.wav          # velocidad (cambia tono levemente en voz); preferir rubberband=tempo=1.25
```

### 4.7 Reducción de ruido

```
# FFT (rápido, sin modelos). nr = reducción en dB (0.01-97), nf = piso de ruido en dB, tn=1 sigue el ruido
ffmpeg -y -i IN.wav -af "highpass=f=80,afftdn=nr=12:nf=-25:tn=1" OUT.wav

# Red neuronal RNNoise (voz). Requiere un archivo de modelo .rnnn
ffmpeg -y -i IN.wav -af "arnndn=m=std.rnnn:mix=1" OUT.wav
```

Modelos `.rnnn` [V, descargados con HTTP 200]: https://github.com/richardpl/arnndn-models — archivos `std.rnnn` (original de Xiph RNNoise), `bd.rnnn`, `cb.rnnn`, `lq.rnnn`, `mp.rnnn`, `sh.rnnn` (≈300 KB c/u; los otros creados por Gregor Richards [V, README]). URL: `https://raw.githubusercontent.com/richardpl/arnndn-models/master/std.rnnn`. El repo **no incluye archivo LICENSE** [V, 404]; `std.rnnn` proviene de RNNoise (BSD-3-Clause) [U]: dejar nota en el README del proyecto. **En Windows** la ruta del modelo dentro del filtro necesita escape: `arnndn=m='C\:/studio/models/std.rnnn'`; más simple: ejecutar FFmpeg con `cwd` en esa carpeta y usar `m=std.rnnn`.

### 4.8 Normalizar loudness: `loudnorm` en dos pasadas

Objetivo típico: **-16 LUFS** (YouTube/web, estéreo), true peak -1.5 dBTP, LRA 11. Para Reels/TikTok se suele usar -14 LUFS [U].

Pasada 1 (medir, sin salida) [V]:

```
ffmpeg -hide_banner -y -i IN.wav -af "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json" -f null -
```

Escribe en **stderr** un bloque JSON (parsear el último `{...}`) con claves `input_i`, `input_tp`, `input_lra`, `input_thresh`, `output_i`, `output_tp`, `output_lra`, `output_thresh`, `normalization_type`, `target_offset` (todas como strings).

Pasada 2 (aplicar con los valores medidos, modo lineal) [V]:

```
ffmpeg -y -i IN.wav -af "loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=-16.65:measured_TP=-2.97:measured_LRA=0.50:measured_thresh=-26.65:offset=0.04:linear=true:print_format=summary" -ar 48000 OUT.wav
```

Importante: **`loudnorm` remuestrea internamente a 192 kHz**, por eso siempre se fuerza `-ar 48000` a la salida. `linear=true` solo se respeta si los valores medidos permiten ganancia lineal; si no, FFmpeg cae a modo dinámico (el JSON de la pasada 2 lo informa en `normalization_type`). Una sola pasada (`loudnorm=I=-16:TP=-1.5:LRA=11`) también funciona pero es dinámica y menos precisa [V].

Cadena de "voz limpia" de uso común [V]: `highpass=f=80,afftdn=nr=10:nf=-30,loudnorm=I=-16:TP=-1.5:LRA=11`.

### 4.9 Ducking: bajar la música cuando habla la voz (`sidechaincompress`)

Entrada 0 = música, entrada 1 = voz. La voz alimenta el sidechain y luego se mezcla [V]:

```
ffmpeg -y -i musica.wav -i voz.wav -filter_complex "[1:a]asplit=2[sc][vo];[0:a][sc]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400:makeup=1[duck];[duck][vo]amix=inputs=2:duration=longest:normalize=0[out]" -map "[out]" -ar 48000 OUT.wav
```

Parámetros [V]: `threshold` 0.000977–1 (lineal; 0.05 ≈ -26 dB), `ratio` 1–20, `attack` 0.01–2000 ms, `release` 0.01–9000 ms, `makeup` 1–64, `knee`, `level_sc` (ganancia del sidechain), `mix`. Para más bajada subir `ratio` o bajar `threshold`; para recuperación suave subir `release` (400–800 ms). Si la música es más corta: `aloop=loop=-1:size=2e9` antes, y `-shortest`/`atrim` al final; para fade-out final: `afade=t=out:st=<T>:d=2`. Con video: usar `-map 0:v` desde otra entrada y `-c:v copy`.

---

## 5. Efectos de sonido y música utilizables en un proyecto personal

### 5.1 Freesound (API oficial)

- Solicitar credenciales: https://freesound.org/apiv2/apply [V]. Docs: https://freesound.org/docs/api/ (fuente verificada: `_docs/api/source/*.rst` del repo MTG/freesound).
- **Auth por token (API key)** [V]: `GET https://freesound.org/apiv2/search/text/?query=puerta&token=$FREESOUND_API_KEY` o header `Authorization: Token $FREESOUND_API_KEY`. Basta para buscar y para bajar **previews** (mp3/ogg comprimidos; campo `previews` con `preview-hq-mp3`, `preview-hq-ogg`, `preview-lq-mp3`, `preview-lq-ogg`) [V/S].
- **OAuth2** solo para descargar el archivo **original** (`/apiv2/sounds/<id>/download/`) [V]: authorize `https://freesound.org/apiv2/oauth2/authorize/` (con `client_id`, `response_type=code`), token en `https://freesound.org/apiv2/oauth2/access_token/` (POST `client_id`, `client_secret`, `grant_type=authorization_code`, `code`), luego header `Authorization: Bearer <access_token>`; `expires_in` ≈ 86400 s y se renueva con `grant_type=refresh_token` [V]. Para una app personal local: usar solo previews (más simple) y, si se quiere calidad original, implementar el flujo OAuth una vez con redirect local.
- **Límites** [S]: 60 requests/min y 2000/día por clave.
- Parámetros útiles de búsqueda [S/U]: `query`, `filter` (ej. `duration:[0 TO 10] license:"Creative Commons 0"`), `sort` (`score`, `downloads_desc`, `rating_desc`), `fields=id,name,tags,license,previews,duration,username,url`, `page_size` (hasta 150), `page`.
- **Licencias por sonido**: CC0 (libre total), CC-BY (requiere atribución), CC-BY-NC (no comercial). Guardar `license`, `username` y `url` en la biblioteca y generar créditos automáticamente para CC-BY.
- Variables de entorno: `FREESOUND_API_KEY` (token), y solo si se usa OAuth: `FREESOUND_CLIENT_ID`, `FREESOUND_CLIENT_SECRET`.
- Cliente Python oficial (opcional): https://github.com/MTG/freesound-python (pero un `requests` simple alcanza).

### 5.2 Pixabay

La API de Pixabay (`https://pixabay.com/api/` para imágenes y `https://pixabay.com/api/videos/` para videos, parámetro `key=`) **no incluye música ni efectos de sonido** [S, docs.pixabay.com/api/docs]. El audio de Pixabay (Content License) hay que descargarlo a mano desde https://pixabay.com/music/ y https://pixabay.com/sound-effects/ e importarlo a la biblioteca con metadata manual. No planificar un conector de audio Pixabay.

### 5.3 Packs CC0 / uso libre

- **Kenney** (CC0, sin atribución obligatoria) [S]: Interface Sounds (100 archivos) https://kenney.nl/assets/interface-sounds ; Impact Sounds (130) https://kenney.nl/assets/impact-sounds ; Digital Audio (60) https://kenney.nl/assets/digital-audio ; también RPG Audio, UI Audio, Sci-fi Sounds. Descarga manual del ZIP (no hay repo oficial de estos packs en GitHub verificado).
- **Mixkit**: SFX y música gratis sin atribución bajo su licencia propia [S] — https://mixkit.co/free-sound-effects/ ; revisar términos antes de redistribuir.
- **YouTube Audio Library**: gratis para videos en YouTube; sus términos no cubren todos los usos fuera de YouTube [S/U].
- Otros a evaluar manualmente (licencia a verificar por pack) [U]: OpenGameArt (CC0/CC-BY), Sonniss GDC Game Audio Bundle (royalty-free), Incompetech (CC-BY).
- Regla: la biblioteca nunca debe mezclar ítems sin licencia registrada; campo `license` obligatorio, valor `unknown` bloquea la exportación final con aviso.

### 5.4 Plan de biblioteca local (carpeta + SQLite + tags + waveform)

Estructura:

```
library/
  library.db                     # SQLite (WAL)
  assets/{sfx,music,voice,ir}/<fuente>/<sha8>_<slug>.<ext>
  peaks/<asset_id>.json          # picos para el timeline
  waveforms/<asset_id>.png       # miniatura opcional
  previews/<asset_id>.opus       # preview liviana (opcional)
```

Esquema SQLite (probado con SQLite 3.45 + FTS5) [V]:

```sql
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE asset(
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('sfx','music','voice','ir','model')),
  path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, title TEXT,
  duration_s REAL, sample_rate INTEGER, channels INTEGER,
  loudness_lufs REAL, peak_db REAL, bpm REAL,
  source TEXT, source_id TEXT, license TEXT NOT NULL DEFAULT 'unknown',
  attribution TEXT, author TEXT, url TEXT, peaks_path TEXT,
  added_at TEXT DEFAULT (datetime('now')));
CREATE TABLE tag(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE asset_tag(asset_id INTEGER REFERENCES asset(id) ON DELETE CASCADE,
  tag_id INTEGER REFERENCES tag(id), PRIMARY KEY(asset_id, tag_id));
CREATE VIRTUAL TABLE asset_fts USING fts5(title, tags, author, content='',
  tokenize='unicode61 remove_diacritics 2');   -- búsqueda "puerta*" encuentra "Puerta que se cierra"
```

Pipeline de ingesta (worker Python o Node):

1. `ffprobe -v error -show_entries stream=sample_rate,channels:format=duration -of json file` → duración, sr, canales.
2. `sha256` del archivo para deduplicar; copiar a `assets/...`.
3. Loudness/peak: `ffmpeg -i file -af loudnorm=print_format=json -f null -` (o `ebur128=peak=true`), guardar `loudness_lufs`.
4. **Picos para waveform** (sin dependencias extra) [V]: `ffmpeg -v error -i file -ac 1 -ar 8000 -f s16le -` y calcular min/max por bloque (p. ej. 80 muestras = 10 ms) → JSON de ints; el front dibuja canvas/SVG. Probado: 4.35 s de audio → 435 pares min/max.
5. Miniatura PNG (opcional) [V]: `ffmpeg -i file -filter_complex "showwavespic=s=1200x120:colors=#4aa3ff" -frames:v 1 wave.png`.
6. Inserción en `asset` + `asset_tag` + `asset_fts`.
7. Conectores opcionales (Freesound) bajan previews a `assets/sfx/freesound/` y llenan `license/author/url`.

`audiowaveform` (BBC, GPL-3.0, 1.10.2, binarios Windows en su página de Releases; el desarrollo se mudó a https://codeberg.org/chrisn/audiowaveform) genera `.dat`/`.json` de picos y PNG [V], pero **no es necesario**: el método FFmpeg del paso 4 evita una dependencia más.

Créditos: exportar un `CREDITS.txt` por proyecto con los `attribution` de los assets CC-BY usados en el timeline.

---

## 6. Requisitos de Windows desde cero

IDs de winget con manifiesto verificado en el repo `microsoft/winget-pkgs` [V]:

| Paquete | ID winget | Versión vista en el manifiesto |
|---|---|---|
| Python 3.11 | `Python.Python.3.11` | 3.11.9 (última con instalador binario de la serie 3.11 [U]) |
| FFmpeg (Gyan) | `Gyan.FFmpeg` | 9.0.2, build *full*, instalador portable con alias `ffmpeg`, `ffplay`, `ffprobe` |
| Git | `Git.Git` | 2.54.0 existe |
| Node.js LTS | `OpenJS.NodeJS.LTS` | 24.12.0 existe |
| VC++ Redistributable 2015-2022 x64 | `Microsoft.VCRedist.2015+.x64` | 14.50.35719.0 existe |

```powershell
winget install -e --id Git.Git
winget install -e --id OpenJS.NodeJS.LTS
winget install -e --id Python.Python.3.11
winget install -e --id Gyan.FFmpeg
winget install -e --id Microsoft.VCRedist.2015+.x64
# Cerrar y abrir una terminal nueva para que se actualice el PATH, luego:
git --version; node --version; py -3.11 --version; ffmpeg -version
ffmpeg -hide_banner -filters | findstr /i "rubberband arnndn afftdn sidechaincompress loudnorm afir"
```

- **VC++ Redistributable**: torch, onnxruntime (Piper, faster-whisper VAD, kokoro-onnx), ctranslate2 y los binarios de whisper.cpp/Piper necesitan el runtime de MSVC x64 [S/U]; instalarlo explícitamente evita el clásico error `VCRUNTIME140.dll` / `DLL load failed`. **No hacen falta las Build Tools de Visual Studio** siempre que se evite `fairseq` (usar `infer-rvc-python`, no `rvc-python`).
- **eSpeak-ng**: **no es necesario para Piper** (el wheel `piper-tts` y el zip legacy lo traen embebido [V]). Kokoro lo usa para español vía `espeakng-loader` (empaquetado); si fallara, instalar el MSI desde https://github.com/espeak-ng/espeak-ng/releases (README de Kokoro) [V].
- **Python**: crear un venv por perfil. Sugerido: `.venv-audio` (Python 3.11: piper-tts, faster-whisper, infer-rvc-python, soundfile) y, solo si alguien insiste en `rvc-python`, un venv aparte con `py -3.10`. Instalar con `py -3.11 -m venv ...` evita ambigüedad con otras versiones.
- **GPU opcional**: driver NVIDIA actualizado; CUDA Toolkit no hace falta para torch (los wheels cu12x traen sus libs); para faster-whisper usar el Toolkit o los wheels pip `nvidia-*-cu12` (ver 3.1). Detectar con `nvidia-smi`; sin GPU, todo corre en CPU con `int8` / modelos pequeños.
- **Rutas largas**: `git config --system core.longpaths true` y habilitar LongPathsEnabled en Windows (torch y modelos generan rutas largas).
- **Espacio en disco** estimado [U]: torch CPU ~0.3 GB, torch CUDA ~3 GB, modelos Whisper small/medium 0.5–1.5 GB, voces Piper 60–120 MB c/u, Kokoro ~0.3 GB, RVC base (hubert + rmvpe) ~0.4 GB, FFmpeg ~0.2 GB.
- **Descargas de modelos**: Hugging Face (Piper, Whisper, RVC) con `HF_HOME` apuntando a la carpeta `models/` del proyecto para que sea portable; GitHub para Piper legacy, whisper.cpp y kokoro-onnx.

---

## 7. Decisiones y recomendaciones

1. **TTS por defecto: Piper vía `pip install piper-tts==1.8.0`** (GPL-3.0, sin eSpeak aparte). Voz inicial `es_AR-daniela-high` (rioplatense) y `es_MX-claude-high` como alternativa; leer `voices.json` y el `.onnx.json` (sample rate) en vez de hardcodear.
2. Segunda opción local: **kokoro-onnx** (MIT, sin torch, `ef_dora`/`em_alex`/`em_santa`). XTTS-v2 solo opcional con GPU y aviso de licencia no comercial.
3. TTS por API opcional (OpenAI `/v1/audio/speech`, ElevenLabs `/v1/text-to-speech/{voice_id}`) con `OPENAI_API_KEY` / `ELEVENLABS_API_KEY` en `.env`; llamadas desde el backend.
4. **RVC: usar `infer-rvc-python` 1.3.1** en Python 3.11 (evita `fairseq`); descartar `rvc-python` salvo en venv 3.10. Activos: `hubert_base` + `rmvpe.pt` desde `lj1995/VoiceConversionWebUI`, pre-descargados por el setup.
5. Torch en **dos perfiles**: CPU (`--index-url .../whl/cpu`) y CUDA 12.8 (`torch==2.7.1+cu128`, comando del README de RVC); el wheel de PyPI en Windows es solo CPU. Selección automática con `nvidia-smi`.
6. Modelos RVC: preferir voces propias o con licencia/consentimiento explícito; registrar licencia y fuente; advertencia en la UI. No usar voice-models.com como "fuente legal" por defecto.
7. **STT: faster-whisper 1.2.1**, defaults `small` + `int8` en CPU y `large-v3-turbo` + `float16` en GPU; `language="es"`, `word_timestamps=True`, `vad_filter=True` con `min_silence_duration_ms=500`. Fallback automático GPU→CPU. whisper.cpp (tag `b5130`) como plan B.
8. Fuente de verdad de subtítulos = **JSON por palabra**; SRT y ASS (`\kf`) se derivan; Remotion consume el JSON para el estilo animado.
9. **Efectos de voz**: preset por nombre → lista de argumentos FFmpeg (sección 4), ejecutados con `spawn` sin shell; `rubberband` si `-filters` lo lista, si no, fallback `asetrate+atempo`. Salida siempre a 48 kHz.
10. Normalización: `loudnorm` en dos pasadas (-16 LUFS, -1.5 dBTP) al exportar; ducking con `sidechaincompress` (threshold 0.05, ratio 8, attack 20, release 400). Siempre `-ar 48000` tras `loudnorm`.
11. Biblioteca local: carpeta + SQLite (FTS5) + picos calculados con FFmpeg (sin `audiowaveform`); `license` obligatorio; créditos CC-BY automáticos. Fuentes iniciales: Kenney (CC0) + Freesound por token (solo previews); Pixabay no tiene API de audio.
12. Prerrequisitos Windows con winget: `Git.Git`, `OpenJS.NodeJS.LTS`, `Python.Python.3.11`, `Gyan.FFmpeg`, `Microsoft.VCRedist.2015+.x64`; no se requieren Build Tools de Visual Studio.
13. Pendiente de validar en la PC destino (marcados [U]): rubberband presente en el build Gyan, DLLs `nvidia-*-cu12` por pip para faster-whisper, tiempos reales de RVC en CPU, licencias de voces Piper no verificadas (davefx, sharvard, mls, carlfm) y sample rate real de cada `.onnx.json`.

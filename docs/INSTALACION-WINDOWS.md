# Instalación en Windows (desde cero hasta el dashboard abierto)

Guía para una PC con **Windows 10 (21H2 o superior) u 11 de 64 bits**, sin nada instalado. Todo corre
en tu PC (`127.0.0.1`); no hace falta cuenta ni nube. Las API keys (ElevenLabs, OpenAI, Freesound…)
son **opcionales**.

Una vez instalado, el **[Manual de usuario](manual/MANUAL-USUARIO.md)** explica cómo usar cada panel,
los flujos paso a paso, los límites y la solución de problemas (también en
[HTML](manual/index.html) y [PDF](manual/MANUAL-USUARIO.pdf)).

| Requisito   | Mínimo                                  | Recomendado                                  |
| ----------- | --------------------------------------- | -------------------------------------------- |
| Disco libre | 10 GB                                   | 20 GB (+4 GB con CUDA)                       |
| RAM         | 8 GB                                    | 16 GB                                        |
| GPU         | no necesaria (todo funciona en CPU)     | NVIDIA con driver 570+ para Whisper/RVC CUDA |
| Internet    | solo durante la instalación y descargas |                                              |

## 1. Conseguir el código

Usá una **ruta corta** (las dependencias generan rutas muy largas): por ejemplo `C:\dev\studio`.

- **Recomendado — ZIP** (no necesita Git): en la página del repo, **Code → Download ZIP**,
  descomprimilo en `C:\dev\studio` (que `package.json` quede directamente dentro) y luego, en
  PowerShell, desbloqueá los scripts (Windows marca los archivos bajados de internet):

  ```powershell
  Get-ChildItem -Recurse C:\dev\studio\scripts | Unblock-File
  ```

- Alternativa con Git: `git clone <url-del-repo> C:\dev\studio` (si no tenés Git, `setup.ps1` lo
  instala; actualizar luego es un `git pull`).

## 2. Abrir PowerShell en la carpeta

Menú Inicio → "Windows PowerShell" (**no** hace falta "Ejecutar como administrador") y:

```powershell
cd C:\dev\studio
```

## 3. Instalar todo

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\setup.ps1
```

(o doble clic en `scripts\windows\setup.cmd`). `-ExecutionPolicy Bypass` vale solo para ese proceso:
no cambia la configuración de seguridad de Windows.

Sin pasos manuales extra, salvo aceptar UAC: los instaladores de winget (Node.js, VC++) muestran
el aviso de **Control de cuentas de usuario** y eso es lo esperado.

**Es incremental**: cada paso primero revisa qué hay y, si ya está, muestra
`✔ ya instalado, se omite: <qué y versión>` y pasa al siguiente. La primera vez tarda lo que tarde
(descargas grandes); repetirlo (o actualizar a una versión nueva) solo hace lo que falta o cambió.
Qué hace:

1. Con **winget** instala lo que falte: Git (≥ 2.40), **Node.js 22** (≥ 22.12), **Python 3.11**,
   **Python 3.12** (solo lo usa el cambio de cara, en su entorno aislado; ver
   [Herramientas aisladas](#herramientas-aisladas-cambio-de-cara-y-voz-avanzada)),
   **FFmpeg** (build "full" de Gyan) y **Visual C++ Redistributable x64**. Si ya están y la versión
   alcanza, se omiten; si son más viejos, `winget upgrade`. Node y VC++ muestran un aviso de
   **Control de cuentas (UAC)**: aceptalo.
2. Crea `.env` copiando `.env.example` (nunca pisa uno existente) y las carpetas `storage\` y `models\`.
3. Instala **pnpm 12** (`npm i -g pnpm@12`), las dependencias JS (`pnpm install`, se omite si
   `pnpm-lock.yaml` y los `package.json` no cambiaron desde la última vez) y el navegador de Remotion
   (`pnpm --filter @studio/remotion browser:ensure`, se omite si ya está descargado).
4. Crea el entorno Python `apps\workers\.venv` con faster-whisper, Piper y RVC (torch CPU, o CUDA
   si hay GPU NVIDIA: ver [9](#9-actualizar-y-desinstalar)). Se omite si el sello
   `.venv\.studio-install` coincide con el hash de `requirements.txt` (o `requirements-cuda.txt`) y
   `pyproject.toml`; cambiar entre CPU y `-WithCuda` lo rehace.
5. Modelos: primero `models_cli --check` muestra la tabla **presente / falta / parcial / corrupto**
   y después baja **solo lo que falta**: voz **es_AR-daniela-high** y Whisper **base** (los activos
   de RVC, `rmvpe.pt` + `hubert_base`, solo con `-Full`; si no, al usar RVC). Cada archivo se
   verifica (tamaño, md5 del catálogo de Piper, sha256 publicado por Hugging Face) y queda
   registrado en **`models\manifest.json`** (nombre,
   ruta, tamaño, sha256/md5, URL de origen, fecha). Una descarga cortada queda como `<archivo>.part`
   y **se reanuda** donde quedó (HTTP Range) la próxima vez.
6. Compila el proyecto (`pnpm build`), salvo que el build existente coincida con el hash del
   código, del lockfile y de los valores de `.env` que entran al build (`NEXT_PUBLIC_*`, puertos).
   `start.ps1` usa la misma regla: si cambiaste `.env` o el código, recompila antes de abrir.
7. Muestra un **resumen con ✅ / ❌**, los **segundos de cada paso**, si se `[omitido]` o
   `[ejecutado]`, y la línea `N pasos omitidos (ya instalados), M ejecutados, tiempo total X s`
   (también en `storage\run\setup-last.json`). Si al final falta la voz Piper, el modelo Whisper o
   el navegador de Remotion, termina con error (código 1) y los lista en rojo.

Duración típica la primera vez: 15–40 minutos según la conexión (torch ≈ 200 MB, CUDA ≈ 3 GB).
Re-ejecutarlo con todo instalado: alrededor de un minuto (verificaciones, sin descargas).

> **Si winget instaló algo nuevo y algún paso falló**, cerrá PowerShell, abrí una nueva (para que se
> actualice el PATH) y volvé a ejecutar `setup.ps1`.

### Opciones útiles

| Opción                                        | Para qué                                                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `-Update`                                     | Después de bajar una versión nueva: todo incremental (ver [9](#9-actualizar-y-desinstalar))                                                 |
| `-Force`                                      | Ignora los sellos: rehace `pnpm install`, `pip install`, el build, los entornos aislados existentes (`tools\*\.venv`) y re-descarga modelos |
| `-WithCuda`                                   | GPU NVIDIA: torch CUDA 12.8 (cu128) y `USE_CUDA=true` (automático si se detecta la GPU)                                                     |
| `-NoCuda` (o `-WithCuda:$false`)              | Perfil CPU aunque haya GPU NVIDIA (`USE_CUDA=false`)                                                                                        |
| `-WhisperModel small`                         | Otro modelo de subtítulos (`tiny`, `base`, `small`, `medium`, `large-v3-turbo`)                                                             |
| `-PiperVoice es_MX-claude-high`               | Otra voz por defecto                                                                                                                        |
| `-SkipRvc` / `-SkipRvc:$false`                | Sin dependencias de RVC en el `.venv` (torch/RVC; se recuerda) / volver a instalarlas                                                       |
| `-SkipModels` / `-SkipBuild` / `-SkipBrowser` | Saltear pasos                                                                                                                               |
| `-SkipWinget`                                 | No usa winget: Git, Node 22, Python 3.11 y FFmpeg ya deben estar en el PATH (3.12: aviso)                                                   |
| `-SkipOllama`                                 | No instala ni inicia Ollama (el Asistente local queda deshabilitado)                                                                        |
| `-SkipClaude` (o `-WithClaude:$false`)        | No instala Claude Code (la Consola Claude explica cómo instalarlo después)                                                                  |
| `-Full`                                       | Descarga todos los paquetes de IA en secuencia (ver abajo)                                                                                  |

### Paquetes de IA (`-Full`)

Por defecto `setup.ps1` instala solo el paquete **core** (Whisper base + voz Daniela). Los demás se
descargan al usar cada función (Ajustes → Paquetes de IA, con barra de progreso). Con `-Full` se
bajan todos ahora, uno por uno (~4,3 GB + 5,2 GB del Asistente si Ollama está instalado + ~6,2 GB de
la voz avanzada Chatterbox; el **cambio de cara** (~4 GB) solo si ya aceptaste su licencia en
pantalla; repetirlo omite lo que ya está y reanuda lo parcial):

| Paquete          | Contenido                                                                   | Tamaño aprox.                                     | Lo usa                                        |
| ---------------- | --------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------- |
| `core`           | Whisper base + Piper es_AR-daniela-high                                     | 0,3 GB                                            | subtítulos, locución                          |
| `whisper-turbo`  | Whisper large-v3-turbo (float16 en GPU)                                     | 1,6 GB                                            | subtítulos (por defecto con `-WithCuda`)      |
| `voces-es`       | 7 voces Piper más (México, España)                                          | 0,5 GB                                            | locución                                      |
| `rvc-base`       | hubert + rmvpe                                                              | 0,4 GB                                            | conversión de voz (RVC)                       |
| `scenes`         | PySceneDetect + OpenCV (pip)                                                | 0,04 GB                                           | detectar escenas                              |
| `voz-limpia`     | DeepFilterNet 3 (pip + pesos)                                               | 0,01–0,25 GB                                      | limpiar voz                                   |
| `matting`        | RobustVideoMatting fp16 + fp32 + `.venv-gpl`                                | 0,05 GB (0,25 GB si el `.venv` no tiene torch)    | quitar fondo en video                         |
| `matting-hq`     | RobustVideoMatting **resnet50** fp16 + fp32 (mismo `.venv-gpl`)             | 0,16 GB (+0,03 GB si `.venv-gpl` es nuevo)        | quitar fondo en alta calidad                  |
| `matting-image`  | BiRefNet-lite **swin_v1_tiny** (ONNX) + onnxruntime + OpenCV                | 0,28 GB (+0,2 GB `onnxruntime-gpu` con CUDA)      | quitar fondo en imágenes                      |
| `sam2`           | SAM 2.1 tiny + small + código `sam2` (desde GitHub, **requiere Git**)       | 0,34 GB                                           | máscara por clic, seguir objeto (SAM 2)       |
| `reframe`        | YuNet (caras) + OpenCV                                                      | 0,04 GB                                           | reencuadrar, seguir objeto (rápido)           |
| `agent-llm`      | Modelo del Asistente local vía Ollama (`qwen3:8b`, Q4)                      | 5,2 GB                                            | Asistente (comandos en español), reporte      |
| `tts-chatterbox` | Chatterbox multilingüe V3 + entorno `tools\chatterbox\.venv` (torch 2.6)    | ≈ 6,2 GB (≈ 3,2 GB modelos + ≈ 3 GB entorno CUDA) | voz avanzada en español y clonación           |
| `faceswap`       | FaceFusion 3.9.1 + modelos + entorno `tools\facefusion\.venv` (Python 3.12) | ≈ 4 GB (≈ 1,8 GB modelos + ≈ 2,2 GB entorno CUDA) | cambio de cara (**pide aceptar la licencia**) |
| `faceswap-extra` | Modelos extra de cambio de cara (Ghost, InSwapper)                          | 0,8 GB                                            | cambio de cara (otros modelos)                |

Notas de los paquetes de visión:

- **`.venv-gpl`**: RobustVideoMatting es GPL-3, así que corre en un proceso aparte con su propio
  entorno `apps\workers\.venv-gpl` (reusa el torch del `.venv`, no baja otra copia). Lo crean
  los workers al bajar `matting` o `setup.ps1` (paso «Entorno aislado GPL», con `-Full` o si ya
  existe). `doctor.ps1` muestra «Entorno GPL (.venv-gpl)» con la versión de torch. Si lo borrás,
  se vuelve a crear al descargar `matting`.
- **Git** es obligatorio para `sam2` (el código oficial se instala con
  `pip install git+https://github.com/facebookresearch/sam2@<commit fijo>`). Sin Git el paquete falla
  con «Instalá Git (winget install Git.Git) y reintentá».
- **GPU**: con CUDA, `matting-image` reemplaza el `onnxruntime` (CPU) que traen Piper/Whisper por
  `onnxruntime-gpu` 1.24.4 (CUDA 12). `GET /health` → `vision.onnxruntime.provider` dice cuál quedó
  activo (`CUDAExecutionProvider` o `CPUExecutionProvider`). Si dice CPU en una PC con GPU, volvé a
  descargar «Quitar fondo de imágenes».
- **Integridad**: RVM, BiRefNet y YuNet se verifican por tamaño y sha256 publicados. Los pesos de
  SAM 2.1 no publican sha256: la primera descarga registra tamaño y sha256 en
  `models\manifest.json` y desde ahí se comparan; hasta entonces `doctor.ps1` avisa «verificación
  pendiente de primera descarga».

### Herramientas aisladas (cambio de cara y voz avanzada)

El cambio de cara (FaceFusion) y la voz avanzada (Chatterbox) tienen dependencias que chocan con las
de Studio (FaceFusion pide **Python 3.12** y `onnxruntime-gpu` 1.24.4; Chatterbox fija torch 2.6 y
numpy < 2), y sus licencias no son las del resto (modelos no comerciales, GPL). Por eso cada una
corre **en un proceso y un entorno aparte**:

| Herramienta | Entorno                  | Python | Lo crea                                               |
| ----------- | ------------------------ | ------ | ----------------------------------------------------- |
| FaceFusion  | `tools\facefusion\.venv` | 3.12   | el paquete `faceswap` (solo con la licencia aceptada) |
| Chatterbox  | `tools\chatterbox\.venv` | 3.11   | el paquete `tts-chatterbox`                           |

- **Bajo demanda**: los entornos se crean al descargar su paquete desde Ajustes → Paquetes de IA (como
  `.venv-gpl`). `setup.ps1` solo los **actualiza** si ya existen (paso «Herramientas aisladas»: si
  cambió su `requirements*.txt` o el `*.lock.json`, el entorno se rehace) o los crea con `-Full`
  (FaceFusion, además, solo si la licencia ya figura aceptada). Sin nada de eso, el paso aparece como
  «se instala al descargar el paquete desde Ajustes».
- **Python 3.12**: `setup.ps1` lo instala con winget (`Python.Python.3.12` 3.12.10, por usuario) y
  anota la ruta en `tools\runtimes.json`; si ya está (`py -3.12`), se omite. Sin él, el paquete de cambio
  de cara avisa «Falta Python 3.12: corré scripts\windows\setup.ps1 -Update». `FACEFUSION_BASE_PYTHON`
  en `.env` fuerza otro intérprete.
- El código de FaceFusion se baja **fijado por commit** (3.9.1, `72470819…`) a `tools\facefusion\app\`
  y nunca se ejecuta su `install.py`; Chatterbox se instala desde GitHub fijado por commit (V3) y, si no
  hay Git o GitHub no responde, cae a la V2 de PyPI (0.1.7). Nunca conviven dos `onnxruntime` en un
  mismo entorno.
- Siempre se ejecutan a través de `tools\launch.py`: sin `HF_TOKEN` ni API keys en el entorno, Hugging
  Face en modo offline (los modelos los baja el paquete) y, en FaceFusion con GPU, precarga de las DLL
  de CUDA/cuDNN (`onnxruntime.preload_dlls()`).
- `doctor.ps1` (sección «Herramientas aisladas») muestra el estado de cada entorno (listo /
  desactualizado / no instalado / roto / falta Python 3.12), la versión, el proveedor que cargó de
  verdad (CUDA o CPU), la variante de Chatterbox (V3 / V2), si la licencia del cambio de cara está
  aceptada y si el torch de RVC ve la GPU.
- **Rutas largas**: torch y las DLL de NVIDIA crean rutas de más de 260 caracteres dentro de
  `tools\*\.venv`. Activá `LongPathsEnabled` (ver [8](#8-solución-de-problemas)) o instalá Studio en una
  ruta corta (`C:\dev\studio`).
- Para borrarlos: cerrá Studio y borrá `tools\facefusion\.venv`, `tools\facefusion\app` o
  `tools\chatterbox\.venv`; se vuelven a crear al descargar el paquete.

**Primer uso recomendado** (después de instalar con GPU): Ajustes → Paquetes de IA →
**Test de rendimiento IA** (mide Whisper, Piper, RVC — «RVC: X s por minuto (GPU)» —, escenas, si
está `matting` el recorte de personas: «Recorte de personas ≈ X fps (meta 15)», si está
`tts-chatterbox` la voz avanzada: «Chatterbox: RTF X», y si aceptaste la licencia y registraste una
Persona con consentimiento, el cambio de cara: «X fps a 1080p»; lo que no está instalado aparece
«no medido» con el motivo), y después **Quitar fondo** sobre un clip de **10 s** para confirmar que
el recorte corre en la GPU antes de usarlo en un video largo.

### Asistente local (Ollama)

El Asistente (panel con `Ctrl+Shift+A`) convierte pedidos como «cortá los silencios y exportá para
Reels» en un plan de edición que confirmás antes de aplicar. Todo corre en tu PC, sin API key:

- `setup.ps1` instala **Ollama** con winget (`Ollama.Ollama`, MIT) y lo inicia si no está corriendo
  (`http://127.0.0.1:11434`). Si ya está, se omite. `-SkipOllama` saltea el paso.
- El modelo **no** se baja en el setup normal (~5 GB): Ajustes → Paquetes de IA → «Asistente local»
  (o `setup.ps1 -Full`, o `ollama pull qwen3:8b`). Alternativa: `AGENT_MODEL=hermes3:8b` en `.env`.
- Los comandos simples («exportá para reels», «transcribí», «reencuadrá a 9:16») funcionan aunque
  el modelo no esté descargado: no pasan por la IA.
- `doctor.ps1` muestra la sección «Asistente local (Ollama)»: versión, modelos y si falta el de
  `AGENT_MODEL`. Si dice que no responde, abrí Ollama desde el menú Inicio.
- Antes de cada consulta los workers liberan Whisper/visión de la GPU si quedan menos de 5,5 GB
  libres; Ollama libera su modelo a los 5 minutos sin uso.

Estado: `scripts\windows\doctor.ps1` (sección "Paquetes de IA") o, a mano,
`apps\workers\.venv\Scripts\python.exe -m studio_workers.models_cli --packs list`.
Uno solo: `... models_cli --packs download whisper-turbo`.

### Consola Claude (Claude Code)

La Consola Claude (panel con `Ctrl+Shift+C`) corre **Claude Code** dentro de Studio con tu
suscripción de Claude.ai (Pro/Max): sin API key. Guía completa: [CONSOLA-CLAUDE.md](CONSOLA-CLAUDE.md).

- `setup.ps1` instala Claude Code con `npm i -g @anthropic-ai/claude-code` cuando hay Node.js 22
  (paso «Claude Code», opción `-WithClaude`, activa por defecto). Si ya está instalado muestra la
  versión y lo omite. `-SkipClaude` saltea el paso.
- La primera vez iniciá sesión **una sola vez** en una terminal (o dentro de la consola con `/login`):
  `claude auth login` → se abre el navegador para entrar con tu cuenta de Claude.ai.
- `doctor.ps1` muestra la sección «Consola Claude»: versión, si hay sesión iniciada
  (`claude auth status`) y si las herramientas `studio-mcp` están compiladas.
- Si en Ajustes o en el `.env` hay una `ANTHROPIC_API_KEY`, la consola **no** la usa: Studio la
  quita del entorno de Claude Code a propósito.

## 4. Abrir Studio

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\start.ps1
```

(o doble clic en `scripts\windows\start.cmd`). Se abren tres ventanas — **workers** (Python, puerto
8001), **api** (3001) y **web** (3000) —, el script espera a que respondan, indexa la biblioteca de
sonidos y abre **http://localhost:3000** en el navegador.

- `-SingleConsole`: todo en una sola consola con logs `[workers]`, `[api]`, `[web]`; **Ctrl+C** detiene todo.
- `-Dev`: modo desarrollo con recarga en caliente.
- Para detener: cerrá las ventanas o ejecutá `scripts\windows\stop.ps1`.
- Los puertos se cambian en `.env` (`WEB_PORT`, `API_PORT`, `WORKERS_PORT`). Las URLs internas
  (`NEXT_PUBLIC_API_URL`, `WORKERS_URL`) usan `127.0.0.1`, no `localhost`, porque los servicios
  escuchan solo en `127.0.0.1`.
- Los gráficos de Remotion usan fuentes del sistema (`REMOTION_FONTS=system`, funciona sin
  internet); `REMOTION_FONTS=google` descarga Google Fonts la primera vez.

Si aparece el **Firewall de Windows** preguntando por `node.exe` o `python.exe`: todo escucha solo en
`127.0.0.1`, así que podés elegir **Cancelar** (o solo "Redes privadas").

## 5. Voces, subtítulos y conversión de voz

- **Voces Piper** (español): `es_AR-daniela-high` (rioplatense, por defecto), `es_MX-claude-high`,
  `es_MX-ald-medium`, `es_ES-davefx-medium`, `es_ES-sharvard-medium`, `es_ES-mls_10246-low`,
  `es_ES-mls_9972-low`, `es_ES-carlfm-x_low`. Para bajar otra:

  ```powershell
  apps\workers\.venv\Scripts\python.exe -m studio_workers.models_cli --piper es_MX-claude-high
  ```

  (o `POST http://127.0.0.1:3001/api/voice/models/download` con `{"kind":"piper","id":"es_MX-claude-high"}`).
  Cada voz tiene su propia licencia (ver su `MODEL_CARD` en Hugging Face).

- **TTS por API** (opcional): poné `ELEVENLABS_API_KEY` u `OPENAI_API_KEY` en `.env` y reiniciá; sin
  key el proveedor aparece como "no configurado".
- **Subtítulos (Whisper)**: en CPU usa `int8`. `base` es rápido; `small` es más preciso (≈ 7× tiempo
  real en una CPU moderna). Un modelo no descargado se baja la primera vez que se usa.
- **RVC (conversión de voz)**: copiá cada modelo en `models\rvc\<nombre>\` (`.pth` obligatorio,
  `.index` opcional). **En CPU funciona pero es lento** (del orden de la duración del audio o más); con
  `-WithCuda` es varias veces más rápido. Usá solo voces propias o con permiso explícito.

## 6. Biblioteca de sonidos

- Packs **CC0 de Kenney** (interfaz, impactos, digital, RPG, UI, sci-fi):

  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\library\import-cc0.ps1
  ```

  Se guardan en `storage\library\sfx\kenney\<pack>\` con `_pack.json` (licencia) y `ATTRIBUTION.txt`.
  Si kenney.nl cambia su página, bajá los ZIP a mano y usá `-ZipDir $HOME\Downloads`.

- **Tus archivos**: copiálos a `storage\library\sfx\`, `music\` o `ambience\` (subcarpetas = tags) y
  reiniciá `start.ps1` (o `POST /api/library/scan`). Un `_pack.json` en una carpeta define la licencia
  de todo lo que hay debajo: `{"license":"CC-BY-4.0","attribution":"Autor - fuente","tags":["lluvia"]}`.
- **Freesound** (opcional): `FREESOUND_API_KEY` en `.env` (pedila en https://freesound.org/apiv2/apply);
  se buscan y descargan **previews** con su licencia y atribución.

## 7. Diagnóstico

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\doctor.ps1
```

Muestra versiones, PATH, filtros de FFmpeg (incluido `rubberband`), GPU, paquetes Python, modelos,
puertos y estado de los servicios. También el **estado de `models\manifest.json`** (archivos
registrados por grupo, cuáles faltan o cambiaron de tamaño, la tabla presentes/faltantes de
`models_cli --check`) y el **espacio en disco** que ocupan `models\` y `storage\` (con detalle de
`media`, `proxies`, `renders`, etc.). Desde el sprint 4 también **Python 3.12**, los **entornos
aislados** `tools\facefusion` y `tools\chatterbox` (estado, versión, proveedor CUDA real o CPU,
variante V3/V2), la **licencia del cambio de cara** (aceptada o no, leída del espejo
`storage\consent\licences.json`), el **torch de RVC** (si ve la GPU) y el **origen del hubert**
de RVC. No modifica nada.

Para ver solo los modelos:

```powershell
apps\workers\.venv\Scripts\python.exe -m studio_workers.models_cli --check --update
```

## 8. Solución de problemas

| Síntoma                                                              | Solución                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `... cannot be loaded because running scripts is disabled`           | Ejecutá siempre con `powershell -NoProfile -ExecutionPolicy Bypass -File ...` o con los `.cmd`. Alternativa permanente: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`. Si una política de grupo lo impide, `Get-ExecutionPolicy -List` lo muestra. |
| `winget` no existe                                                   | Instalá "App Installer" desde Microsoft Store y abrí una PowerShell nueva.                                                                                                                                                                                 |
| `node`, `pnpm` o `python` "no se reconoce" justo después de instalar | Cerrá y abrí PowerShell (PATH nuevo) y repetí `setup.ps1`.                                                                                                                                                                                                 |
| `python` abre Microsoft Store                                        | Configuración → Aplicaciones → Alias de ejecución de aplicaciones → desactivá `python.exe` y `python3.exe`. Los scripts usan `py -3.11`.                                                                                                                   |
| Node 24 o 26 ya instalado                                            | Studio requiere Node 22: desinstalá el otro desde "Aplicaciones" y repetí `setup.ps1`.                                                                                                                                                                     |
| `DLL load failed` / `VCRUNTIME140.dll` (torch, onnxruntime)          | `winget install -e --id Microsoft.VCRedist.2015+.x64` y reiniciá los workers.                                                                                                                                                                              |
| Error por rutas largas (`ENAMETOOLONG`, `Filename too long`)         | Clonar en `C:\dev\studio`. Como administrador: `New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force` y `git config --global core.longpaths true`.                        |
| `El puerto 3000/3001/8001 está ocupado`                              | `scripts\windows\stop.ps1`; si sigue, cambiá el puerto en `.env`. Hyper-V/WSL reservan rangos: `netsh interface ipv4 show excludedportrange protocol=tcp`.                                                                                                 |
| Falla la descarga de modelos                                         | Reintentá `setup.ps1` (o `-Update`): lo verificado se saltea y el `.part` se reanuda donde quedó. Un archivo corrupto se vuelve a bajar solo. Proxies corporativos pueden bloquear `huggingface.co`.                                                       |
| Subtítulos con `-WithCuda` dicen "CUDA no disponible, usando CPU"    | Actualizá el driver NVIDIA (570+). faster-whisper necesita cuBLAS 12 + cuDNN 9: los toma de `torch\lib`; si aun falla, `apps\workers\.venv\Scripts\python.exe -m pip install nvidia-cublas-cu12 nvidia-cudnn-cu12`.                                        |
| RVC tarda mucho                                                      | Normal en CPU. Usá clips cortos, `f0Method: "pm"` (más rápido) o `-WithCuda`.                                                                                                                                                                              |
| RVC avisa `torch_cpu_build` con `USE_CUDA=true`                      | El torch del `.venv` es el de CPU: `setup.ps1 -Update -WithCuda` instala el de CUDA (cu128).                                                                                                                                                               |
| «El modelo RVC … no se puede cargar de forma segura»                 | El `.pth` trae objetos que `torch.load` seguro rechaza (no se desactiva por seguridad): usá otra versión del modelo (exportada como diccionario de pesos).                                                                                                 |
| «Falta Python 3.12» al usar el cambio de cara                        | `setup.ps1 -Update` (instala `Python.Python.3.12` con winget). Sin winget: instalá Python 3.12 de python.org y poné su ruta en `FACEFUSION_BASE_PYTHON` en `.env`.                                                                                         |
| El cambio de cara corre en CPU con GPU NVIDIA                        | `doctor.ps1` → «FaceFusion (tools\facefusion)»: si dice proveedor CPU, actualizá el driver (570+) y el VC++ x64, y volvé a descargar el paquete (rehace el entorno).                                                                                       |
| «El entorno aislado de … no está listo»                              | Ajustes → Paquetes de IA → volver a descargar el paquete (rehace `tools\<id>\.venv`) o `setup.ps1 -Update`.                                                                                                                                                |
| `doctor.ps1` dice que falta `rubberband`                             | Los efectos de tono usan `asetrate+atempo` como respaldo. Para mejor calidad, instalá el build "full": `winget install -e --id Gyan.FFmpeg`.                                                                                                               |
| Remotion no renderiza (Chrome Headless Shell)                        | `pnpm --filter @studio/remotion browser:ensure` (desde la raíz).                                                                                                                                                                                           |
| `pnpm install` muy lento                                             | El antivirus escanea `node_modules`. Opcional (admin): `Add-MpPreference -ExclusionPath 'C:\dev\studio'`.                                                                                                                                                  |
| El navegador no abre / pantalla en blanco                            | Abrí http://localhost:3000 a mano; mirá la ventana "Studio web" (o `storage\logs\web.log` con `-SingleConsole`).                                                                                                                                           |

## 9. Actualizar y desinstalar

**Actualizar a una versión nueva** (no se vuelve a bajar lo que ya tenés):

1. Cerrá Studio (`scripts\windows\stop.ps1` o cerrá sus ventanas).
2. Bajá el ZIP nuevo y **descomprimilo encima de la misma carpeta** (`C:\dev\studio`), aceptando
   "Reemplazar los archivos". Si clonaste con Git, en cambio: `git pull`.
3. Desbloqueá los scripts: `Get-ChildItem -Recurse C:\dev\studio\scripts | Unblock-File`.
4. Corré la actualización (o doble clic en `scripts\windows\actualizar.cmd`):

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\setup.ps1 -Update
   ```

   `-Update` no toca Git: revisa todo, omite lo que ya está (prerrequisitos, `node_modules`, `.venv`,
   navegador, modelos registrados en `models\manifest.json`), conserva el perfil anterior (CUDA o sin
   RVC; un perfil CPU pasa a CUDA si hay GPU NVIDIA, salvo `-NoCuda`) y solo instala, descarga o
   recompila lo que la versión nueva cambió. Termina con
   `N pasos omitidos, M ejecutados, tiempo total`.

   Las dependencias de Python (`apps\workers\.venv`) se reinstalan cuando cambia el perfil o
   **cualquier** archivo de requirements del perfil, incluidos los que se referencian con `-r` (con
   CUDA, `requirements-cuda.txt` incluye `requirements.txt`). La primera actualización después de
   esta corrección reinstala una vez las instalaciones CUDA (antes no se notaban las dependencias
   nuevas de `requirements.txt` y los workers fallaban con `ModuleNotFoundError`).

**Opciones al instalar o actualizar** (se combinan con `-Update`):

| Opción      | Qué hace                                                                                                                                                                                                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-Update`   | Incremental tras bajar una versión nueva; conserva el perfil anterior (con o sin RVC). Si la instalación estaba en CPU y ahora se detecta una GPU NVIDIA, **cambia a CUDA sola** (torch CUDA, ~2,5 GB una vez, y `USE_CUDA=true` en `.env`, sin tocar el resto del archivo). |
| `-Full`     | Baja **todos** los paquetes de IA ahora, en secuencia (~4,3 GB + 5,2 GB del Asistente + ~6,2 GB de Chatterbox; el cambio de cara, ~4 GB, solo con su licencia ya aceptada). Sin `-Full` solo se instala `core`.                                                              |
| `-WithCuda` | Perfil GPU: torch CUDA 12.8 y `USE_CUDA=true`. No hace falta pasarlo: es **automático** si se detecta una GPU NVIDIA (`nvidia-smi` o el nombre del adaptador de video contiene «NVIDIA»), en la primera instalación y en `-Update`.                                          |
| `-NoCuda`   | Perfil CPU aunque haya GPU NVIDIA (`USE_CUDA=false`). La elección queda registrada en `apps\workers\.venv\.studio-install`: los `-Update` siguientes no vuelven a cambiar a CUDA (para volver: `-WithCuda`).                                                                 |

El setup imprime qué eligió, por ejemplo `Aceleracion IA: CUDA (GPU) - GPU NVIDIA detectada: NVIDIA
GeForce RTX 4050 Laptop GPU`. Si ya tenías una instalación en CPU y hay GPU, `-Update` muestra
`GPU NVIDIA detectada: cambiando a CUDA (descarga ~2.5 GB, una sola vez)` y la cambia; para quedarte
en CPU usá `setup.ps1 -Update -NoCuda`. `doctor.ps1` muestra
`USE_CUDA=<valor> / modo=<gpu|cpu> / GPU=<nombre>`.

Qué se descarga y cuándo:

| Paquete          | Por defecto              | Bajo demanda (al usar la función)                                                       | Con `-Full`                   |
| ---------------- | ------------------------ | --------------------------------------------------------------------------------------- | ----------------------------- |
| `core`           | sí                       | —                                                                                       | sí                            |
| `whisper-turbo`  | no                       | sugerencia al transcribir con CUDA («Descargar whisper-turbo (1.6 GB)»)                 | sí                            |
| `voces-es`       | no                       | Voz → «Descargar» (una voz o el paquete entero)                                         | sí                            |
| `rvc-base`       | no (aunque instales RVC) | Conversión RVC → «Paquete requerido»                                                    | sí                            |
| `scenes`         | no                       | Detectar escenas → «Paquete requerido»                                                  | sí                            |
| `voz-limpia`     | no                       | Limpiar voz → «Paquete requerido»                                                       | sí                            |
| `matting`        | no                       | Quitar fondo (video) → «Paquete requerido» (crea `.venv-gpl`)                           | sí                            |
| `matting-image`  | no                       | Quitar fondo (imagen) → «Paquete requerido»                                             | sí                            |
| `sam2`           | no                       | Máscara / Seguir objeto con SAM 2 → «Paquete requerido» (requiere Git)                  | sí                            |
| `reframe`        | no                       | Reencuadrar / Seguir objeto rápido → «Paquete requerido»                                | sí                            |
| `tts-chatterbox` | no                       | Voz y audio → Motor «Chatterbox» → «Descargar» (crea `tools\chatterbox\.venv`)          | sí                            |
| `faceswap`       | no                       | Cambiar cara → leer y aceptar la licencia → «Descargar» (crea `tools\facefusion\.venv`) | solo con la licencia aceptada |

**No borres** al actualizar (ahí está lo que ya descargaste o creaste):

| Carpeta / archivo                           | Qué contiene                                                |
| ------------------------------------------- | ----------------------------------------------------------- |
| `.env`                                      | Tu configuración y API keys (el ZIP no lo trae: no se pisa) |
| `storage\`                                  | Proyectos, medios importados, proxies, renders, biblioteca  |
| `models\` (incluye `manifest.json`)         | Voces Piper, Whisper, RVC (GB de descargas)                 |
| `apps\workers\.venv\`                       | Entorno Python (torch, faster-whisper…): se reutiliza       |
| `tools\*\.venv\`, `tools\facefusion\app\`   | Entornos aislados de cambio de cara y Chatterbox            |
| `node_modules\` y `packages\*\node_modules` | Dependencias JS y el navegador de Remotion: se reutilizan   |

Si borrás `node_modules\` o `.venv\` no se rompe nada, pero `setup.ps1` los vuelve a instalar
(más tiempo y descargas). Borrar `apps\web\.next\` solo fuerza a recompilar.

Descomprimir encima no borra los archivos que la versión nueva eliminó. Si después el build falla
por un archivo que ya no existe en el ZIP, borrá las carpetas `src` de `apps\web`, `apps\api` y
`packages\*` (nada más), descomprimí de nuevo y repetí `setup.ps1 -Update`.

- Desinstalar Studio: borrar la carpeta `C:\dev\studio` (incluye `storage\`, `models\` y `.venv`).
  Node, Python, Git y FFmpeg se quitan desde "Aplicaciones" o con `winget uninstall --id <ID>`.

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
   **FFmpeg** (build "full" de Gyan) y **Visual C++ Redistributable x64**. Si ya están y la versión
   alcanza, se omiten; si son más viejos, `winget upgrade`. Node y VC++ muestran un aviso de
   **Control de cuentas (UAC)**: aceptalo.
2. Crea `.env` copiando `.env.example` (nunca pisa uno existente) y las carpetas `storage\` y `models\`.
3. Instala **pnpm 12** (`npm i -g pnpm@12`), las dependencias JS (`pnpm install`, se omite si
   `pnpm-lock.yaml` y los `package.json` no cambiaron desde la última vez) y el navegador de Remotion
   (`pnpm --filter @studio/remotion browser:ensure`, se omite si ya está descargado).
4. Crea el entorno Python `apps\workers\.venv` con faster-whisper, Piper y RVC (torch CPU). Se omite
   si el sello `.venv\.studio-install` coincide con el hash de `requirements.txt` (o
   `requirements-cuda.txt`) y `pyproject.toml`; cambiar entre CPU y `-WithCuda` lo rehace.
5. Modelos: primero `models_cli --check` muestra la tabla **presente / falta / parcial / corrupto**
   y después baja **solo lo que falta**: voz **es_AR-daniela-high**, Whisper **base**, activos de
   RVC (`rmvpe.pt` + `hubert_base`). Cada archivo se verifica (tamaño, md5 del catálogo de Piper,
   sha256 publicado por Hugging Face) y queda registrado en **`models\manifest.json`** (nombre,
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

| Opción                                        | Para qué                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `-Update`                                     | Después de bajar una versión nueva: todo incremental (ver [9](#9-actualizar-y-desinstalar)) |
| `-Force`                                      | Ignora los sellos: rehace `pnpm install`, `pip install`, el build y re-descarga modelos     |
| `-WithCuda`                                   | GPU NVIDIA: torch CUDA 12.8 (cu128) y `USE_CUDA=true` en `.env` (se recuerda)               |
| `-WithCuda:$false`                            | Volver de CUDA al perfil CPU                                                                |
| `-WhisperModel small`                         | Otro modelo de subtítulos (`tiny`, `base`, `small`, `medium`, `large-v3-turbo`)             |
| `-PiperVoice es_MX-claude-high`               | Otra voz por defecto                                                                        |
| `-SkipRvc` / `-SkipRvc:$false`                | Instalación liviana sin torch/RVC (se recuerda) / volver a instalar RVC                     |
| `-SkipModels` / `-SkipBuild` / `-SkipBrowser` | Saltear pasos                                                                               |
| `-SkipWinget`                                 | No usa winget: Git, Node 22, Python 3.11 y FFmpeg ya deben estar en el PATH                 |
| `-Full`                                       | Descarga todos los paquetes de IA en secuencia (ver abajo)                                  |

### Paquetes de IA (`-Full`)

Por defecto `setup.ps1` instala solo el paquete **core** (Whisper base + voz Daniela). Los demás se
descargan al usar cada función (Ajustes → Paquetes de IA, con barra de progreso). Con `-Full` se
bajan todos ahora, uno por uno (~3,5 GB; repetirlo omite lo que ya está y reanuda lo parcial):

| Paquete         | Contenido                               | Tamaño aprox. | Lo usa                                   |
| --------------- | --------------------------------------- | ------------- | ---------------------------------------- |
| `core`          | Whisper base + Piper es_AR-daniela-high | 0,3 GB        | subtítulos, locución                     |
| `whisper-turbo` | Whisper large-v3-turbo (float16 en GPU) | 1,6 GB        | subtítulos (por defecto con `-WithCuda`) |
| `voces-es`      | 7 voces Piper más (México, España)      | 0,5 GB        | locución                                 |
| `rvc-base`      | hubert + rmvpe                          | 0,4 GB        | conversión de voz (RVC)                  |
| `scenes`        | PySceneDetect + OpenCV (pip)            | 0,04 GB       | detectar escenas                         |
| `voz-limpia`    | DeepFilterNet 3 (pip + pesos)           | 0,01–0,25 GB  | limpiar voz                              |

Estado: `scripts\windows\doctor.ps1` (sección "Paquetes de IA") o, a mano,
`apps\workers\.venv\Scripts\python.exe -m studio_workers.models_cli --packs list`.
Uno solo: `... models_cli --packs download whisper-turbo`.

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
`media`, `proxies`, `renders`, etc.). No modifica nada.

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
   RVC) y solo instala, descarga o recompila lo que la versión nueva cambió. Termina con
   `N pasos omitidos, M ejecutados, tiempo total`.

**No borres** al actualizar (ahí está lo que ya descargaste o creaste):

| Carpeta / archivo                           | Qué contiene                                                |
| ------------------------------------------- | ----------------------------------------------------------- |
| `.env`                                      | Tu configuración y API keys (el ZIP no lo trae: no se pisa) |
| `storage\`                                  | Proyectos, medios importados, proxies, renders, biblioteca  |
| `models\` (incluye `manifest.json`)         | Voces Piper, Whisper, RVC (GB de descargas)                 |
| `apps\workers\.venv\`                       | Entorno Python (torch, faster-whisper…): se reutiliza       |
| `node_modules\` y `packages\*\node_modules` | Dependencias JS y el navegador de Remotion: se reutilizan   |

Si borrás `node_modules\` o `.venv\` no se rompe nada, pero `setup.ps1` los vuelve a instalar
(más tiempo y descargas). Borrar `apps\web\.next\` solo fuerza a recompilar.

Descomprimir encima no borra los archivos que la versión nueva eliminó. Si después el build falla
por un archivo que ya no existe en el ZIP, borrá las carpetas `src` de `apps\web`, `apps\api` y
`packages\*` (nada más), descomprimí de nuevo y repetí `setup.ps1 -Update`.

- Desinstalar Studio: borrar la carpeta `C:\dev\studio` (incluye `storage\`, `models\` y `.venv`).
  Node, Python, Git y FFmpeg se quitan desde "Aplicaciones" o con `winget uninstall --id <ID>`.

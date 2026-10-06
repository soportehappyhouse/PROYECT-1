# Sprint 4 — M3 «herramientas»: runtime de herramientas + RVC en CUDA + instalador + rendimiento + revisión para redes

Contrato: `docs/trabajo/sprint4-contratos.md` §M3. Fuentes: `docs/trabajo/fuentes-sprint4.md` (§1.2–1.3
FaceFusion en venv, §2.2 Chatterbox, §3 RVC, §4 onnxruntime-gpu). Manual: §27 (borrador abajo).

## Qué se construyó

- **`apps/workers/studio_workers/toolvenv.py`** (API fija del contrato; M1 y M2 la importan diferida):
  `TOOLS`/`ToolSpec`, `venv_dir`, `status` (`ready | stale | missing | broken | python`, + versión,
  variante, proveedores, perfil), `ensure`, `command` (argv, env, cwd vía `tools/launch.py`),
  `status_rows`, `status_summary`, `licence_accepted`. Agregados: `verify` (doctor: proveedor real, con
  `record=False` no escribe nada), `require_ready` (409 `TOOL_MISSING` con `details {tool, state,
packId}`), `pack_hooks`, `spawn` / `popen_kwargs` / `kill_tree` / `kill_tree_command`
  (`taskkill /T /F /PID` en Windows, `os.killpg` en POSIX), `IdleTimer`, `tool_settings()` (claves
  nuevas de `.env`, todas como texto: un valor vacío nunca rompe los workers), `scrubbed_env`.
  - `ensure("facefusion")`: Python 3.12 (`FACEFUSION_BASE_PYTHON` → `tools/runtimes.json` → `py -3.12`
    → `python3.12` → carpetas por defecto; caché 60 s) → `venv` → `pip -U pip` → zip del commit fijado
    (sha256 del lock o registrado en `.studio-source.json` la primera vez; distinto → error) extraído
    seguro a `tools/facefusion/app/` → `pip uninstall` de **todo** `onnxruntime*` → `-r
requirements-cuda|cpu.txt` → junction (Windows, `_winapi.CreateJunction`) / symlink
    `app/.assets/models` → `models/facefusion` (si FaceFusion ya había bajado modelos ahí, se mueven) →
    prueba vía `launch.py --preload-ort` con sesión ORT real sobre `nsfw_2.onnx` cuando está (CUDA que no
    carga = aviso `onnx_cuda_unavailable`, no roto). Nunca `install.py`; requirements con dos
    `onnxruntime*` → error antes de crear nada; la prueba falla si quedaron dos distribuciones.
  - `ensure("chatterbox")`: venv con el Python 3.11 de Studio → `pip -U pip wheel "setuptools<82"` →
    `torch/torchaudio==2.6.0` (índice cu124 **solo** con CUDA) → PerTh `@ git+…@sha` → `-r
requirements.txt` → `--no-deps chatterbox-tts @ git+…@sha` (V3); sin Git o si GitHub falla →
    `chatterbox-tts==0.1.7 "setuptools<82"` (V2, aviso `chatterbox_v2_fallback`) → prueba de imports +
    `PerthImplicitWatermarker`.
  - Sello `.venv/.studio-tool-install`: `<sha256(req+lock)[:16]> <cuda|cpu>`, `variant`, `source`,
    `python`, `providers`, `checked`. Sin sello o con receta/perfil distinto → `stale` → se recrea.
    Prueba fallida → `.studio-tool-broken` → `broken`.
- **`tools/launch.py`** (solo stdlib, corre en 3.11 y 3.12): saca su propia carpeta de `sys.path`, quita
  `HF_TOKEN` y toda `*_API_KEY | *_TOKEN | *_SECRET | *_PASSWORD | *_ACCESS_KEY`, `PYTHONPATH/HOME`,
  pone `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, `HF_HOME=<models>/<tool>/.hf`, `PYTHONUTF8=1`,
  `PYTHONIOENCODING=utf-8`, `OMP_NUM_THREADS=1` (FaceFusion); `--preload-ort` = `os.add_dll_directory`
  (handles retenidos) + `PATH` por cada `site-packages/nvidia/*/bin` y `onnxruntime.preload_dlls()`
  (si falla: aviso por stderr; si no se puede importar onnxruntime: error); `os.chdir`,
  `sys.path.insert(0, cwd)`, `runpy.run_path`; modo `-- -c "<código>"` para las pruebas de los
  entornos. Error de arranque = una línea `{"event":"error","code":"LAUNCH_FAILED","message":…}` y
  código 2. `tools/README.md`, `tools/facefusion/README.md`, `tools/chatterbox/README.md`.
- **`models_cli`**: `--tool-venv facefusion|chatterbox status|ensure|verify [--json] [--report]
[--no-write]`, `--licences --json` (espejo de solo lectura), y `--packs all|download` omite/rechaza
  los packs con `licence_gate` sin aceptar (`all`: «se omite: requiere aceptar la licencia»;
  `download faceswap`: error, código 1). Workers `POST /packs/{id}/download` → 403 `LICENCE_REQUIRED`
  (`details {licenceId, text_version}`) con el mismo espejo (defensa en profundidad).
- **RVC en CUDA** (`rvc_engine.py`, `routers/rvc.py`): `USE_CUDA` con torch que no ve la GPU → CPU +
  `torch_cpu_build`; `GpuBudget.acquire("rvc", 1500, unload)` antes de inferir y liberación tras
  `RVC_IDLE_S` (300 s) sin uso (`IdleTimer` → `budget.release("rvc")`); error en CUDA → reintento en
  CPU con `gpu_fallback_cpu`; `torch.load` que rechaza el pickle (`UnpicklingError`, también envuelto)
  → 422 `RVC_MODEL_INCOMPATIBLE` (`details.modelId`), sin reintento y sin tocar `weights_only`.
  **Hubert**: queda `lj1995/VoiceConversionWebUI/hubert_base/{config.json, pytorch_model.bin}`
  (carpeta del comando oficial de RVC [V fuentes-audio §2] y usada por varias herramientas públicas
  [S]); si responde 404/401/403 la descarga pasa sola a `r3gm/hubert_base` (el de infer-rvc-python
  [V código]); `rmvpe.pt` con tamaño exacto 181 189 687 B y respaldo
  `r3gm/sonitranslate_voice_models`. El manifiesto guarda la URL que funcionó (`mirror: true`);
  `doctor` muestra «hubert de <repo>». `preprocessor_config.json` ya no se baja (ni transformers ni la
  librería lo leen).
- **Test de rendimiento** (`perf.py`, `routers/perf.py`): `POST /perf/run` acepta `{face_source_path?,
face_consent_id?, licences?}` (la api los saca de `gate.benchFaceSource()`); nuevos campos
  `rvc_device`, `chatterbox_rtf/_load_s/_device/_model` (por el `ChatterboxClient` de M2: se detiene
  primero para medir la carga en frío y nunca hay dos modelos en la GPU), `facefusion_fps/_enh_fps/
_startup_s/_device/_model` (por el `FaceEngine` de M1: video de 3 s a 1080p armado con la foto, sin
  y con GFPGAN; fps = cuadros / (segundos de FaceFusion − arranque)) y `tools` (estado de los
  entornos). Sin algo → `null` + `skipped[comp]`: «paquete X no instalado», «licencia no aceptada»,
  «registrá una Persona con consentimiento para medir», «entorno aislado de X: <estado>». Sin los
  motores de M1/M2 hay un camino directo (protocolo del puente / argv de `headless-run`).
- **Revisión para redes**: `packages/shared/src/ai-content.ts` (`detectAiContent`, `aiContentComment`,
  `detectedPublishFlags`, `inheritedAiProvenance`, `trackIsVisible/Audible`) + test;
  `apps/api/src/services/ai-provenance.ts` (`inheritAiProvenance(source, extra)`,
  `applyInheritedAiProvenance`, `exportAiComment`); herencia en `voice.effect`, `audio.denoise`,
  `audio.stems`, `vision.matte`; export con `-metadata comment=…` **siempre** que haya contenido IA
  (pasada única y concat final de bloques; no entra al hash de bloques), etiqueta visible opcional
  (D4). Web: `SocialReview` con «Detectado en el proyecto» (cara + Persona, voz clonada, voz
  sintética), `aiFace`/`aiVoice` clonada marcados y bloqueados, voz solo sintética marcada al pasar a
  redes pero editable, etiqueta propuesta al marcar redes (`socialPatch` + `nextPublish(…, detected)`);
  `MediaPanel`: insignias «IA: cara / voz / voz clonada» y `voice-ref` no arrastrable («Voz propia»).
- **Ajustes → Paquetes de IA**: insignia «No comercial: requiere aceptar licencia» + «Leer y aceptar» /
  «Ver licencia» (`openLicenceDialog` de M1; recarga al evento `studio:licence:accepted`), estado del
  entorno aislado (listo / desactualizado / falta / roto / falta Python 3.12), modelo V3/V2 de
  Chatterbox; Test de rendimiento: «RVC: X s por minuto (GPU|CPU)», «Chatterbox: RTF X (≈ Y s por cada
  10 s de voz)», «Cambio de cara: X fps (≈ Z min por minuto a 1080p; con mejorador W fps)» o «no
  medido: <motivo>».
- **Instalador**: `setup.ps1` paso «Python 3.12 (herramientas)» (winget `Python.Python.3.12` 3.12.10
  por usuario, sin `--version` si esa no está; con `-SkipWinget` solo verifica; falta = aviso, nunca
  error) que anota la ruta en `tools/runtimes.json`, y paso 5c «Herramientas aisladas»
  (`models_cli --tool-venv <id> ensure` si el venv existe o con `-Full`; FaceFusion además solo con
  la licencia aceptada). `.SYNOPSIS`/`-Full` con los tamaños nuevos. `common.ps1`: `Find-Python312`,
  `Get-ToolVenvPython`. `doctor.ps1`: Python 3.12, FaceFusion/Chatterbox (estado, versión, variante,
  proveedor real con `verify --no-write`, torch + CUDA), licencia (espejo), RVC (torch CUDA + origen
  del hubert), rutas largas para `tools\*\.venv`, espacio libre. `.env.example`: `FACEFUSION_BASE_PYTHON`,
  `FACEFUSION_PYTHON`, `FACEFUSION_APP_DIR`, `CHATTERBOX_PYTHON`, `CHATTERBOX_IDLE_S=120`,
  `RVC_IDLE_S=300`. `.gitignore`: `tools/*/app/`, `tools/*/.venv/`, `tools/*/.downloads/`,
  `tools/*/.studio-source.json`, `tools/runtimes.json`, `storage/consent/`. CI: `STUDIO_TOOL_VENV_TESTS=0`,
  ruff también sobre `tools/`, y el smoke de Windows verifica que «Herramientas aisladas» queda
  omitido, que el paso de Python 3.12 existe y no falla, y que no hay `tools\*\.venv`.
- **E2E**: bloques `sprint4:M3` en `run-e2e.mjs` (licencia de punta a punta con `Origin` y con
  `X-Studio-Client: mcp` → 403; perf.json con campos y motivos; export con `comment`; RVC `device`),
  `ui-smoke.mjs` (Revisión para redes con detección real del proyecto; Paquetes de IA con la licencia) y
  `workers-with-mocks.py` (descarga de packs con licencia sin red, Chatterbox `--mock` en el perf, voz
  RVC falsa «e2e-voz»; `STUDIO_MOCK_TOOLS=0` / `STUDIO_MOCK_RVC=0` los apagan).

## Pruebas

- workers: `test_toolvenv.py` (26), `test_launch.py` (15 + 1 opt-in con un venv real de Python 3.12,
  marcador `tool_venv`, `STUDIO_TOOL_VENV_TESTS=1`), `test_rvc_cuda.py` (10), `test_cli_packs.py` (5),
  `test_perf.py` (9); `test_rvc.py` y `test_packs.py` ajustados (lista exacta de packs con los de
  sprint 4 y los dos con licencia).
- shared `ai-content.test.ts` (8); api `ai-provenance.test.ts` (6: herencia, `metadataArgs`, cuerpo de
  `perf.run` desde el gate, **ffprobe del `comment` en pasada única y por bloques**, `voice.effect`
  hereda la procedencia); web `publish.test.tsx` (8: detección bloqueada, etiqueta solo con redes,
  insignias, textos del test de rendimiento, licencia y estado del entorno en Paquetes de IA).

## E2E (al final, stack propio en :3001/:8001/:3000, `STORAGE_DIR` temporal)

- `run-e2e.mjs --skip-motion --only "…|sprint4"`: los 14 pasos `sprint4` en verde (4 de M3: licencia de
  punta a punta `{download: succeeded, mcpAccept: 403, swapAfterRevoke: 403}`; perf.json con Chatterbox
  RTF 0,012 (mock) y FaceFusion `CONTENT_BLOCKED` (la primera Persona con rostro vigente del e2e es la
  de la foto «nsfw» de M1: el bench pasa por el `FaceEngine` y clasifica igual que un trabajo real);
  export con `comment` «…voz sintética: sí» y la etiqueta visible apagada; RVC `device: cpu`). En la
  corrida completa de M1 el paso de RVC falló porque la api pedía `rvc-base`: el mock ahora lo reporta
  instalado y el paso devuelve un motivo si no está.
- `ui-smoke.mjs --vp9-preview --only "Sprint 4"`: 5/5 (2 de M3: Revisión para redes con la detección real
  del proyecto y la etiqueta propuesta al marcar redes; Paquetes de IA con la licencia y el estado del
  entorno de FaceFusion).

## Desvíos del contrato

- `routers/perf.py` y `services/workers-client.ts` (`perfRun(body?)`) no estaban en mis rutas: hacía
  falta para que `POST /perf/run` reciba la foto; nadie más los tocó. `perf.run` manda además
  `face_consent_id` (el `FaceEngine` de M1 lo exige; aditivo).
- `jobs/handlers/project-export.ts` (2 líneas: calcula el `comment` y lo pasa a `exportProject`) y
  `services/ffmpeg.ts` (al lado de `services/ffmpeg/**`): el metadato necesita los medios del proyecto.
- `scripts/windows/common.ps1` (helpers `Find-Python312`, `Get-ToolVenvPython`) y
  `apps/workers/pyproject.toml` (marcador `tool_venv`): solo M3 toca el instalador/CI.
- `tests/test_packs.py`: la aserción de `--packs all` excluye los packs con licencia y la lista de packs
  vuelve a ser exacta (pedido del coordinador).
- `ToolSpec` tiene campos extra con default (`name_es`, `preload_ort`, `omp_single_thread`,
  `venv_size`); `ensure` acepta además `client` (httpx) y `git_available` para las pruebas.
- `--preload-ort` solo se pasa si el venv de FaceFusion se creó con perfil CUDA (con
  `FACEFUSION_PYTHON`, solo con `STUDIO_TOOL_PRELOAD_ORT=1`): en CPU no hace falta y así el e2e con el
  intérprete principal no depende de su onnxruntime (pedido 6 de M1).
- La variante de Chatterbox llega a la web por `GET /api/voice/tts/providers` (`models`) y por
  `perf.json.tools`: `PackSchema.tool` es `{id, state}` y no se tocó `ai.ts`. `readPerfResult` pasó a
  `PerfResultSchema.loose()` para conservar `tools`.

## Pedidos de M1 / M2 atendidos

- M1: junction `app/.assets/models` → `models/facefusion`; `.gitignore`; «Leer y aceptar» con
  `openLicenceDialog` + `studio:licence:accepted`; `perf.run` con `benchFaceSource()` y medición por
  `services.face_engine().run(...)`; doctor lee la licencia del espejo; `--preload-ort` no rompe en CPU.
- M2: el perf mide por `services.chatterbox_client()` (lo detiene y libera antes: nunca dos modelos);
  `.env.example` con `CHATTERBOX_PYTHON` y `CHATTERBOX_IDLE_S=120`; `-Full` incluye `tts-chatterbox` y
  `-Update` rehace el venv si cambió la receta; doctor con la fila de Chatterbox (estado, V3/V2, torch +
  CUDA; los 6 archivos de `models/chatterbox/` salen como «verificación pendiente» por la regla genérica
  de integridad); CI corre ruff sobre `tools/`; `voice-ref` no arrastrable con insignia «Voz propia»;
  variante V3/V2 en Paquetes de IA.

## Borrador manual §27

## 27. Rendimiento e instalación de herramientas

### Paquetes nuevos y tamaños

| Paquete          | Qué trae                                                                 | Tamaño aprox. |
| ---------------- | ------------------------------------------------------------------------ | ------------- |
| `tts-chatterbox` | Voz avanzada (Chatterbox V3) + su entorno `tools\chatterbox\.venv`       | ≈ 6,5 GB      |
| `faceswap`       | Cambio de cara (FaceFusion 3.9.1) + modelos + `tools\facefusion\.venv`   | ≈ 4 GB        |
| `faceswap-extra` | Modelos de cambio de cara extra (Ghost, InSwapper)                       | ≈ 0,8 GB      |

El cambio de cara **pide leer y aceptar su licencia** antes de bajar nada (Ajustes → Paquetes de IA →
«Leer y aceptar»): algunos de sus modelos son solo para uso no comercial.

### Por qué hay «entornos aislados»

FaceFusion necesita Python 3.12 y una versión de onnxruntime para CUDA; Chatterbox fija torch 2.6.
Si se instalaran junto con el resto de Studio se romperían entre sí, y sus licencias son distintas.
Por eso cada uno vive en su carpeta (`tools\facefusion`, `tools\chatterbox`), con su propio Python, y
corre como un programa aparte que Studio arranca y detiene. Se crean solos al descargar el paquete.
Siempre corren sin conexión a Hugging Face y sin ninguna clave tuya en el entorno.

### Python 3.12

`setup.ps1` lo instala con winget (por usuario, no toca tu Python 3.11). Si no lo tenés y no usás el
cambio de cara, no pasa nada: el resto funciona igual. Si lo necesitás: `setup.ps1 -Update`.

### `-Full` y `-Update`

- `setup.ps1 -Full` baja también la voz avanzada (~6,5 GB) y, **solo si ya aceptaste la licencia en
  Studio**, el cambio de cara.
- `setup.ps1 -Update` actualiza los entornos aislados que ya existen si la versión nueva de Studio
  cambió su receta; si no cambió nada aparece «ya instalado, se omite».

### Diagnóstico

`doctor.ps1` → «Herramientas aisladas»: estado (listo / desactualizado / no instalado / roto / falta
Python 3.12), versión, si FaceFusion cargó **CUDA de verdad** (o CPU), la variante de Chatterbox (V3 o
V2 de respaldo), la licencia del cambio de cara (aceptada o no) y si RVC usa la GPU.

### Test de rendimiento

Ajustes → Paquetes de IA → **Test de rendimiento IA**. Además de Whisper, Piper, escenas y recorte,
mide:

- **RVC**: segundos por minuto de voz y si usó GPU o CPU (meta: menos de 15 s por minuto en GPU).
- **Chatterbox**: RTF (tiempo de generación / duración del audio; menor que 1 = más rápido que tiempo
  real) y la primera carga del modelo.
- **Cambio de cara**: cuadros por segundo a 1080p sin y con el mejorador de rostro (meta ≈ 15 fps sin
  mejorador en una RTX 4050). Solo se mide si aceptaste la licencia y registraste una Persona con
  consentimiento de rostro (usa su foto sobre un video de prueba; nada se guarda).

Lo que falta aparece como «no medido» con el motivo.

### RVC en la GPU

Con GPU NVIDIA y `USE_CUDA=true`, RVC usa la GPU sola (media precisión). Si `doctor` dice que el torch
no ve la GPU, corré `setup.ps1 -Update -WithCuda`. RVC devuelve la GPU a los 5 minutos sin uso
(`RVC_IDLE_S`). Un modelo `.pth` que no se puede abrir de forma segura se rechaza («formato
incompatible»): pedí una versión exportada solo con los pesos.

## Borrador ARQUITECTURA

### Herramientas aisladas (sprint 4)

- `tools/<id>/` versiona solo la receta (`requirements*.txt`, `<id>.lock.json`, scripts puente);
  `tools/<id>/.venv` (y `tools/facefusion/app`) se crean bajo demanda con
  `studio_workers.toolvenv.ensure` (pack `post_install_env`, `models_cli --tool-venv`, `setup.ps1`
  5c). Estados `ready | stale | missing | broken | python` en `GET /packs` (`PackSchema.tool`).
- Toda ejecución pasa por `tools/launch.py` dentro del venv de la herramienta: entorno limpio (sin
  tokens/keys, HF offline, UTF-8), `onnxruntime.preload_dlls()` para FaceFusion en CUDA, cwd fijo,
  argv en lista; cancelar = matar el árbol de procesos. FaceFusion se usa por subproceso por trabajo
  (`face.engine`), Chatterbox como subproceso persistente JSON-lines (`tts.chatterbox`); ambos bajo
  `GpuBudget` (`facefusion` 3500 MB, `chatterbox` 4500 MB; `unload` = matar el proceso).
- Licencia del cambio de cara: la api la guarda en SQLite y escribe el espejo de solo lectura
  `storage/consent/licences.json`; los workers (`toolvenv.licence_accepted`), `models_cli --packs all`
  y `doctor` lo leen. `POST /packs/{id}/download` y `face/*` lo exigen.
- Procedencia IA: `MediaAsset.aiAltered/aiProvenance` la escriben `face.swap` y `voice.tts`/RVC y la
  heredan `voice.effect`, `audio.denoise`, `audio.stems` y `vision.matte`
  (`services/ai-provenance.ts`). `detectAiContent` (shared) alimenta «Revisión para redes» y el
  metadato `comment` de cada export (siempre que haya IA; sin ids ni nombres).

## Borrador fuentes (para `fuentes.md`)

- Hubert de RVC: `lj1995/VoiceConversionWebUI` `hubert_base/` es la carpeta que baja el comando oficial
  de RVC-Project (`hf download … --include "hubert_base/*"`, [V] fuentes-audio §2) y la que usan
  herramientas públicas (ultimate-rvc y derivados, entre otras) [S, búsqueda de código en GitHub
  2026-10-06]; `r3gm/hubert_base` es el default de `infer-rvc-python` 1.3.1 (`load_hu_bert`) [V wheel].
  Hugging Face siguió bloqueado desde el sandbox: Studio prueba la primera y cae a la segunda con 404.
- `infer-rvc-python` 1.3.1: `load_trained_model` hace `torch.load(model_path, map_location="cpu")` sin
  `weights_only` (default `True` en torch ≥ 2.6) dentro de `generate_from_cache` [V wheel].

## Solo medible en la PC

- Que winget tenga `Python.Python.3.12` **3.12.10** (si no, se instala la última 3.12 sin `--version`)
  y que `py -3.12` lo encuentre; tiempo de `setup -Update` omitiendo todo salvo Python 3.12 la primera vez.
- Tamaños y tiempos reales de los dos venvs (torch 2.6.0+cu124, nvidia-*-cu12) y que las DLL de
  `nvidia-*-cu12` sirvan a `onnxruntime-gpu` 1.24.4 con `preload_dlls()` (doctor: «sesión ORT real:
  CUDAExecutionProvider»); rutas largas en `tools\*\.venv`.
- RVC en CUDA: s/min reales en la 4050 (meta < 15 s por minuto), fp16 automático, liberación a los
  300 s, y que ningún modelo `.pth` del usuario dispare `RVC_MODEL_INCOMPATIBLE` sin motivo.
- Origen real del hubert (si `lj1995/…/hubert_base/` responde o se usa `r3gm/hubert_base`) y el
  tamaño exacto de `rmvpe.pt` (181 189 687 B [S]): si no coincide, la descarga falla y hay que
  corregir `RMVPE_SIZE`.
- Chatterbox RTF y carga en frío medidos por el Test de rendimiento; FaceFusion fps a 1080p con y
  sin GFPGAN.

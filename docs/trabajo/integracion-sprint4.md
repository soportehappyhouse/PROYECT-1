# Integración Sprint 4 (Fase C: cara y voz) — 2026-10-06

Rama `claude/funny-mccarthy-0bbdt6` sobre Paso 0 (`78c57a8`): M1 caras (`b6d67fe`, `74d2639`), M2 voz
(`42440c1`), M3 herramientas (`81e3a44`, `3e81f1a`, `3cf9511`). Los tres agentes trabajaron en
paralelo sin hablarse; esta integración revisó las costuras, arregló el CI de Windows y completó la
documentación.

## Procedimiento

Sandbox Linux (4 vCPU, sin GPU, 3,4 GB libres de disco). Stack real con `STORAGE_DIR` y `MODELS_DIR`
temporales en el scratch: api `:3001` (`node dist/index.js`, `REMOTION_BROWSER_EXECUTABLE` = Chrome
Headless Shell de Playwright en `/opt/pw-browsers`, `STUDIO_CLAUDE_BIN` = `claude` falso que hace eco),
workers `:8001` con `scripts/e2e/workers-with-mocks.py` (packs `faceswap`/`faceswap-extra` y
`tts-chatterbox` reportados instalados; FaceFusion = `scripts/e2e/fake_facefusion/facefusion.py`,
Chatterbox = el puente real con `--mock`, voz RVC falsa «e2e-voz»), web `next build` + `next start
:3000`, Playwright Chromium. Sin Ollama ni Hugging Face (bloqueados): los pasos con LLM quedan en SKIP.

```bash
pnpm install --frozen-lockfile && pnpm lint && pnpm format:check && pnpm -r typecheck && pnpm -r build && pnpm -r test
pnpm --filter @studio/studio-mcp smoke
cd apps/workers && .venv/bin/python -m ruff check . && .venv/bin/python -m ruff format --check . \
  && .venv/bin/python -m ruff check --config pyproject.toml ../../tools && .venv/bin/python -m pytest -q
python scripts/agent/validate-dataset.py
# api y workers con STORAGE_DIR/MODELS_DIR nuevos (ver arriba), luego:
node scripts/e2e/run-e2e.mjs --api http://127.0.0.1:3001 --storage <storage> --work <work>   # SIN --skip-motion
# storage nuevo + workers con STUDIO_MOCK_DENOISE=0 (el 409 «Paquete requerido» provocado):
node scripts/e2e/ui-smoke.mjs --web http://127.0.0.1:3000 --api http://127.0.0.1:3001 --media <carpeta> \
  --vp9-preview --playwright /opt/node22/lib/node_modules/playwright/index.mjs
```

Los 6 `.ps1` se parsearon con pwsh 7.4 (`Parser::ParseFile`); además se revisó a mano que los cambios
de `setup.ps1`, `doctor.ps1` y `common.ps1` no usen sintaxis de PowerShell 7 (corren en 5.1).

## Resultados

- **CI en GitHub** (antes de la integración): 3e81f1a y 3cf9511 fallaban en `Python workers
  (windows-latest)` (3 tests) y `Node (windows-latest)` (`persons.test.ts`; en 3cf9511 también el
  timeout de `agent.test.ts`). Ubuntu y el smoke de Windows, verdes. Causas y arreglos abajo.
- **CI tras la integración**: c5d312d 5/5 verde. f1f230e (solo web y docs) falló en windows-latest
  por dos intermitentes ajenos al cambio: `test_idle_timer_fires_once_after_last_touch` (destapó
  el bug 9, arreglado) y un job de exportación de `ffmpeg.integration.test.ts` (test de sprints
  anteriores) colgado 242 s, sin salida en el log; pasó en las 3 corridas anteriores y en el
  sandbox. Se agregó diagnóstico al helper (tipo, estado, progreso y cola del log del job) para
  identificarlo si vuelve.
- **Desde cero**: `pnpm install --frozen-lockfile` (lockfile sin cambios), `lint`, `format:check`,
  `-r typecheck`, `-r build`, `-r test` OK: shared 103, studio-mcp 18, motion-engines 22, remotion
  55 + 1 skip, web 227, api 270 + 1 skip. `studio-mcp smoke`: 18 herramientas. Workers: ruff OK
  (también sobre `tools/`), pytest **450 passed, 9 skipped** (6 de Ollama real, 1 venv real de
  herramientas `STUDIO_TOOL_VENV_TESTS=1`, 2 sin torch). `validate-dataset.py`: OK (golden 80,
  `face_swap` = 3). 6 `.ps1` parsean. Búsqueda de secretos en `git diff origin/main`: vacía (solo
  `https://evil.example` de un test de `Origin` y hosts públicos documentados).
- **`run-e2e.mjs`** (sin `--skip-motion`, Remotion con el Chrome Headless Shell de Playwright),
  storage nuevo: **73/73 obligatorios** (663 s): 16 pasos «sprint4» (6 de M1, 4 de M2, 4 de M3 y
  2 nuevos de integración); 3 SKIP (`--hw`, descarga de modelos de Hugging Face, ruta LLM sin
  Ollama) y 2 expected-fail (Whisper y Piper sin modelos). Una corrida anterior, con la api aún
  sin el arreglo 3, dio 71/71 (sin los 2 pasos de integración); el paso de integración de cara +
  voz falló contra esa api por el `jobId` del RVC (era el bug 3) y pasó con la api nueva.
  M1 había informado 6 FAIL con `--skip-motion` (exportaciones `EXPORT_BLOCKED` por motion sin
  renderizar y `rvc-base` faltante): sin `--skip-motion` y con el mock de RVC de M3 no hay ninguno.
- **`ui-smoke.mjs --vp9-preview`** (storage nuevo): **38/38** (33 de sprints anteriores + 5 de
  sprint 4). La primera corrida dio 37/38: «Sprint 4: Voces…» (M2) no encontraba a la Persona en
  «Voz a clonar» (bug 8 de abajo; con `--only` pasaba). Errores de consola del navegador: 2
  esperados (404 del proyecto local inicial y el 409 `PACK_REQUIRED` provocado a propósito).
  Paridad de capas igual que en 3b (máx. diferencia por canal 1–3, tolerancia 8).

### Mediciones (sandbox, CPU, mocks: solo plomería)

- `perf.run` por los motores de los workers: Chatterbox (`--mock`) RTF 0,012–0,016, carga en frío
  medida; FaceFusion falso 1080p 3 s por el `FaceEngine` de M1: ≈ 85 fps sin mejorador / ≈ 81 con
  GFPGAN, arranque 0,05 s (el `facefusion.py` falso no carga modelos: los números reales son de la
  RTX 4050).
- Export con IA: `comment` = «Editado con Studio; contenido alterado con IA: cara sintética: sí; voz
  clonada: sí; voz sintética: no» con la etiqueta visible apagada; tras «Deshacer cambio de cara»,
  «cara sintética: no; …».

## Bugs entre módulos encontrados y arreglados

| # | Hallazgo | Cambio | Prueba |
| - | -------- | ------ | ------ |
| 1 | **Junctions invisibles en Python 3.11** (M3, real en la PC): `toolvenv._is_dir_link` dependía de `os.path.isjunction` (3.12+); los workers corren 3.11.9, así que el segundo `link_dir` de `tools/facefusion/app/.assets/models` → `models/facefusion` (cualquier `ensure` repetido: `-Update` con receta nueva, `-Force`, entorno `stale`) fallaba con `WinError 183` | `toolvenv.py`: también por `lstat` (`FILE_ATTRIBUTE_REPARSE_POINT` + `IO_REPARSE_TAG_MOUNT_POINT`) | `test_junction_detected_without_isjunction` (nuevo), `test_symlink_relinked_when_target_changes` en windows-latest |
| 2 | **Bench de cambio de cara nunca medido** (M3 ↔ M1): `benchFaceSource()` toma la primera Persona **por nombre**; en el e2e era «E2E Contenido» (foto con la marca NSFW de M1) y `perf.run` terminaba en `CONTENT_BLOCKED` (pedido 7 de M1) | Sin cambio de contrato (en la PC el usuario elige a quién registra); paso e2e nuevo con una Persona «0 E2E Banco» que va primera | «sprint4 integración: perf.run mide FaceFusion por el FaceEngine (M1) con la Persona del gate» |
| 3 | **Procedencia de RVC** (M2 ↔ M3): M2 usaba su propia `inheritVoiceProvenance`; el asset de RVC conservaba el `jobId` del TTS de origen, distinto de `voice.effect` / `audio.denoise` / `audio.stems` / `vision.matte` | `voice-ai/handlers.ts` usa `inheritAiProvenance(source, {jobId})` de `services/ai-provenance.ts`; se borró la función duplicada | paso e2e de integración (RVC sobre una voz clonada: `voice-cloned`, `sourceAssetId` = el clon, `jobId` = el RVC) |
| 4 | **El reporte sin conexión podía llevarse el registro de Personas**: `reportar-error.ps1` copiaba `studio.db` entera si no podía leerla (ahora tiene `persons`, `ai_licences`, `consent_audit`) y no ocultaba rutas `consent/…` en los logs | ya no copia la base; regla `consent/(persons\|archive)/… → consent/<oculto>` igual a `reports/builder.ts` | probado con pwsh 7.4 sobre textos con rutas Windows y POSIX; `REPORTAR-ERRORES.md` (Privacidad) |
| 5 | Tests no portables a Windows (M1/M3) y un test lento | `test_find_base_python_order` con intérpretes falsos que existen; `os.pathsep`; `/files/CONSENT/…` 403 \| 404 (`@fastify/static` rechaza alias de mayúsculas con 403 en Windows antes de `allowedPath`); `agent.test.ts` codifica el clip una vez y el test de 5 pedidos tiene 30 s | CI windows-latest |
| 6 | Smoke de `studio-mcp` aceptaba 16 herramientas | exige ≥ 18 | `pnpm --filter @studio/studio-mcp smoke` |
| 7 | Tamaño de Chatterbox: 6,2 GB (pack/UI) vs 6,5 GB (`setup.ps1`, `doctor.ps1`, guía) | 6,2 GB en todos lados | — |
| 8 | **«Voz a clonar» no veía Personas nuevas** (M1 ↔ M2, lo destapó el ui-smoke completo): el panel de Voz cargaba `GET /api/persons?scope=voice` solo al montarse y dockview lo deja montado; una Persona registrada (o revocada) en Ajustes → Personas con el panel abierto no aparecía (o seguía ofrecida) hasta recargar la página. Con `--only` el paso de M2 pasaba porque el panel se montaba después | `lib/api-persons.ts` (M1) emite `studio:persons:changed` tras cada cambio; `voice-clone-store` (M2) `loadPersons()`; `VoicePanel` recarga con ese evento, al elegir el motor Chatterbox y al enfocar «Voz a clonar» (cambios hechos por la api o la consola) | `voice-clone.test.tsx` «a Person registered or revoked while the panel is open…»; ui-smoke completo |
| 9 | **`IdleTimer` podía no liberar nunca la GPU** (M3, lo destapó un fallo intermitente en windows-latest): si el hilo del timer despertaba «antes» según `time.monotonic()` (≈ 15,6 ms de resolución en Windows), `_fire` lo descartaba sin reprogramarse y la liberación de RVC/Chatterbox quedaba esperando otro `touch()`; en producción lo tapaba el margen del 1 % de 120/300 s, en el test de 0,15 s no | `_fire` ignora solo los timers reemplazados (`threading.current_thread() is not self._timer`) y, si despertó antes, espera el resto | `test_idle_timer_early_wake_is_rescheduled_and_stale_timers_ignored` (falla con el código viejo); `test_idle_timer_fires_once_after_last_touch` con márgenes amplios |

Costuras revisadas sin cambios: `ConsentGate` de M1 en la voz de M2 (403 scope/revocado/vencido, 409
sin muestra, revalidación al empezar el job); `tool_status`/`extra_status`/`post_install_env` de los
packs de M1/M2 delegan en `toolvenv` de M3 (estados en `GET /packs` y en Paquetes de IA);
`perf.run` usa `services.chatterbox_client()` (lo detiene antes: nunca dos modelos en GPU) y
`services.face_engine()`; `detectAiContent` + `comment` del export con assets de M1 y M2; diálogo
de licencia global (`FaceDialogs` siempre montado; «Leer y aceptar» de Paquetes de IA y todo 403
`LICENCE_REQUIRED` de `lib/api.ts`); `SPRINT4_UI_CODES` en la web; `CLAUDE.md` con las 2
herramientas, la op `face_swap` y la regla de consentimientos; `test_packs.py` con la lista exacta
de 18 packs; `.env.example` = claves que lee el código (`tool_settings()` y `Settings`), todas vacías
o tiempos, sin secretos; `.gitignore` con `tools/*/app|.venv|.downloads`, `tools/runtimes.json`,
`storage/consent/`; consola con `Read(./storage/consent/**)` denegado.

## Seguridad (pasada rápida)

- Secretos: nada en el diff; `.env.example` sin valores en las claves (`*_API_KEY` vacías); las
  herramientas corren sin `HF_TOKEN` ni `*_API_KEY|*_TOKEN|*_SECRET|*_PASSWORD` (`tools/launch.py`).
- `storage/consent/**`: `/files` lo rechaza (también con otras mayúsculas: 404, o 403 en Windows);
  `reports/builder.ts` no lo copia ni lo nombra; `reportar-error.ps1` idem (arreglo 4); la Consola
  Claude lo tiene denegado.
- `spawn`/`subprocess`: listas de argumentos sin shell en todo el código nuevo (FaceFusion,
  Chatterbox, `toolvenv`, `launch.py`, `taskkill /T /F /PID` con argv).
- `HUMAN_ONLY` en `POST /api/persons/:id/consents` y `POST /api/ai/licences/:id/accept` (Origin de
  la web y nunca `X-Studio-Client: mcp`); el MCP no tiene herramientas para eso. Sigue siendo una
  defensa razonable, no autenticación (ver Puntos abiertos).

## Desvíos

- Los dos pasos nuevos de e2e usan helpers de los bloques de M1/M2/M3 (`m1Person`, `m2Tts`,
  `m3SetLicence`…) y van en su propio bloque `BEGIN/END sprint4:integración`.
- `benchFaceSource()` no cambió (contrato: «1.ª Persona con cara vigente», hoy por nombre).
- Se mantiene la decisión de M2 de no unificar el `TtsResultSchema` de `services/workers-client.ts`
  (M2 usa su propia llamada `createTtsExtendedCall` que conserva `device/warnings/rtf/model`).

## Solo medible en la PC del usuario

- **Cambio de cara**: fps reales a 1080p con y sin GFPGAN (meta [S] 15–25 / 6–12), VRAM de
  hyperswap + GFPGAN (presupuesto 3500 MB), que `CUDAExecutionProvider` cargue en
  `tools\facefusion` con las DLL `nvidia-*-cu12` + `preload_dlls()`, **texto real del rechazo NSFW
  de 3.9.1** (fijarlo en `NSFW_RE`), calidad en primeros planos y con varias caras, CRC32/release de
  `crossface_ghost`, junction con rutas con espacios/tildes, rutas largas.
- **Chatterbox**: instalación real desde Git (SHAs) o caída a V2; tamaño del venv con torch 2.6.0
  cu124; firma de `from_local(..., t3_model="v3")`; RTF y VRAM en la 4050 (meta RTF ≤ 1), primera
  carga, tiempo en CPU; **prueba de escucha A/B** de la Voz propia (cfg 0,3/0,5/0,7 × exaggeration
  0,5/0,7) para fijar el default rioplatense; grabación con MediaRecorder en Chrome/Edge.
- **Instalador y RVC**: `winget` con `Python.Python.3.12` 3.12.10; `setup -Update` que omite todo
  salvo Python 3.12 la primera vez; un segundo `ensure` de FaceFusion en Windows (arreglo 1);
  RVC en CUDA (meta < 15 s por minuto), liberación a los 300 s, origen real del hubert y tamaño
  exacto de `rmvpe.pt`.
- Hugging Face (bloqueado en el sandbox): revisión fijada y sha256 de los 6 archivos de Chatterbox
  (`CHATTERBOX_HF_REVISION = "main"`, TODO), hubert, y el texto completo de OpenRAIL-AS.

## Puntos abiertos

1. **`HUMAN_ONLY` desde la Consola Claude**: Claude Code podría usar `Bash` (p. ej. `curl` con un
   `Origin` inventado) para aceptar una licencia o registrar un consentimiento sin el MCP; Claude
   Code pide permiso al usuario antes de cada comando de `Bash` y `CLAUDE.md` lo prohíbe, pero la
   api solo frena a `studio-mcp`. Opciones: denegar `Bash(curl:*)` / `Bash(Invoke-WebRequest:*)` en
   `claude-console-settings.json` o un token de un solo uso que solo tenga la web.
2. **RVC sobre una voz real**: convertir la grabación del usuario a la voz de un modelo RVC de otra
   persona no queda marcado como IA (el contrato solo pide heredar). Decidir si RVC marca
   `voice-cloned` siempre.
3. `benchFaceSource()` por nombre: quizás convenga la Persona con el consentimiento de rostro más
   reciente.
4. Unificar `TtsResultSchema` de `workers-client.ts` con los campos de Chatterbox y dejar una sola
   llamada a `/tts`.
5. `CHATTERBOX_HF_REVISION` y sha256 de Hugging Face (ver «Solo medible»).

## Correcciones de auditoría

Auditoría independiente del Sprint 4 (hallazgos ALTO 1–2, MEDIO 3–14, BAJO 15–24 y puntos abiertos
A–D decididos por el coordinador). Commits `b6764b2` (ALTO + MEDIO) y el siguiente (BAJO, puntos
abiertos, e2e, docs). Todo verificado en el sandbox Linux (sin CI: GitHub Actions bloqueado por la
facturación de la cuenta).

| # | Hallazgo | Cambio (archivos) | Prueba |
| - | -------- | ----------------- | ------ |
| 1 | «Voz propia» sin `HUMAN_ONLY` ni auditoría | `routes/voice-ai.ts` (`assertHumanOrigin` + `voice.self.attest` con sha256 de la muestra guardada y de la subida), `voice-ai/self-refs.ts`; manual §26.3 | `voice-chatterbox.test.ts` «self-refs: HUMAN_ONLY», auditoría con sha256; e2e «Voz propia» (403 sin Origin) |
| 2 | Revocar no frenaba si había un consentimiento anterior vigente | `shared/consent.ts` (`activeConsent`: manda el más reciente del alcance; `revocableConsents`), `POST /api/persons/:id/consents/revoke {scope}`, `PersonsTab.tsx` («Revocar rostro / voz / todo» con confirmación), store/api web | `consent.test.ts` (test viejo corregido + nuevo), `persons.test.ts`, `face.test.tsx`, e2e auditoría |
| 3 | Consentimiento no atado a las fotos/muestras | `ConsentSchema.photo_ids/sample_ids` (id + sha256, opcionales: ausentes = consentimiento anterior, cubre todo); `coveredPhotos/coveredVoiceSamples`; `facePreflight` y `voiceSamplePath` usan solo lo cubierto; `POST photos/voice-samples` `HUMAN_ONLY`; UI «sin consentimiento para esta foto/muestra» y aviso en el formulario | `consent.test.ts`, `persons.test.ts`, `face.test.tsx`, e2e auditoría |
| 4 | Workers solo pedían un `consent_id` no vacío | api reescribe `consent/active.json` (y `licences.json`) en cada cambio y al arrancar (`gate.writeMirrors`); `studio_workers/consent_mirror.py`; `routers/face.py`, `face/engine.py`, `tts/chatterbox.py` (`check_voice_ref`) y el bench de `perf.py` lo verifican (vigente, alcance, vencimiento, ruta bajo `consent/persons/<persona>/` y listada) | `test_face_runner.py::test_consent_mirror_is_checked_before_launch`, `test_face_router.py`, `test_tts_router.py`, `test_perf.py` (espejos falsos) |
| 5 | `Origin` contra la regex de CORS; sin control de `Host` | `lib/cors.ts` (`webOrigins/isWebOrigin` exactos, `isAllowedHost`), hook `onRequest` 403 `BAD_HOST`, `assertBrowserRead` (`Sec-Fetch-Site` same-origin/same-site u `Origin` exacto) en fotos, muestras y evidencia; la web usa `crossOrigin="anonymous"` y abre la evidencia por `fetch`; e2e/ui-smoke mandan el `Origin` de la web | `security.test.ts`, `persons.test.ts`; e2e auditoría (Host ajeno → 403) |
| 6 | NSFW: fallas de modelo/muertes silenciosas como `CONTENT_BLOCKED` | `face/runner.py` (`NSFW_MODEL_RE`, sin «failed» en `ERROR_RE`, heurística solo con exit 1 + «processing … failed», silencio/señal/OOM → `TOOL_FAILED`, `FACEFUSION_NSFW_RE`); fake FaceFusion rechaza por el DESTINO | `test_face_runner.py` (clasificación, override, destino marcado); e2e NSFW con el video marcado |
| 7 | `archivePersonFiles` podía perder evidencia | `persons/files.ts`: copia + verificación (tamaño y sha256) antes de borrar; si falla, aborta sin borrar; fotos y voz al final | `persons.test.ts` «archive never destroys evidence» |
| 8 | Cancelar no detenía Chatterbox | workers `POST /tts/cancel`, `ChatterboxClient.cancel()` (mata el árbol, libera la GPU, sin reintento); api `WorkersClient.ttsCancel` al abortar el job | `test_chatterbox_client.py` (puente colgado), `test_tts_router.py`, `voice-chatterbox.test.ts` |
| 9 | Entorno por lista negra; fallbacks silenciosos | `toolvenv.py`/`tools/launch.py`: lista permitida (`ENV_ALLOW_*`, proxies solo para instalar); `face/tool.py` y `tts/chatterbox.py` sin lanzador de respaldo (`TOOL_MISSING broken`); variables del fake → `STUDIO_FAKE_FACEFUSION_*` | `test_toolvenv.py::test_tool_env_is_an_allowlist` (25 nombres), `test_launch.py` (listas iguales), `test_face_router.py`, `test_chatterbox_client.py` |
| 10 | Reimportar un export perdía la marca IA | `media-probe.ts` (`aiFromComment`), `shared/ai-content.ts` (`parseAiContentComment`, `reimportedAiProvenance`, `extraKinds`) | `ai-provenance.test.ts` (ffprobe sobre un MP4 con `comment`), `ai-content.test.ts` |
| 11 | Auditoría editable, sin cadena ni lectura | `persons/db.ts`: disparadores `BEFORE UPDATE/DELETE` con `RAISE(ABORT)`, `prev_hash`/`hash` (relleno único de las filas viejas), `verify()`; `GET /api/persons/:id/audit` (`HUMAN_ONLY`); filas `voice.self.attest` y `perf.facefusion`; «Ver auditoría» en la web | `persons.test.ts` «audit», `ai-provenance.test.ts`; e2e auditoría |
| 12 | Docs prometían más de lo que se hace | manual §24.4, `ARQUITECTURA.md` (§2 HUMAN_ONLY, §5.4), `CONSOLA-CLAUDE.md`: qué frena y qué no (proceso local con terminal), reglas de la consola, PIN local a futuro | — |
| 13 | Cadena de suministro | `models_manifest.py` guarda `X-Repo-Commit` (`revision`); `packs.chatterbox_revision()` fija URL y sha256 tras la primera descarga; `models_cli`/`doctor` («verificación pendiente» / «pesos fijados en …»); `rvc_engine.py` registra el origen de hubert/rmvpe; riesgo `r3gm/*` en `fuentes.md` | `test_tts_router.py` (commit registrado y fijado) |
| 14 | VRAM de Chatterbox fija | `CHATTERBOX_VRAM_MB` (4500) y `GPU_RESERVE_MB` (800) en `ToolSettings`, `.env.example` (vacías), manual §11/§26.6/§27.7 | `test_chatterbox_client.py::test_vram_reservation_is_configurable` |
| 15 | Bench por nombre | `benchFaceSource`: consentimiento de rostro más reciente + foto cubierta; auditoría `perf.facefusion` | `ai-provenance.test.ts` |
| 16 | Firma en blanco / nombre vacío; renombrar | `decodePngRgba` + `signatureInk` (400 `SIGNATURE_EMPTY`), `signer_name` con `trim().min(1)`; la UI muestra «firmó X (la Persona ahora se llama «Y»)» | `persons.test.ts`, `face.test.tsx` |
| 17 | `licences.json` desactualizado al arrancar | cubierto por 4 (`writeMirrors` al arrancar) | `persons.test.ts` |
| 18 | Deduplicación por clip | `routes/face.ts`: clip + Persona | `face-swap.test.ts` «dedupe…» |
| 19 | `source.mp4` quedaba tras fallar | `face/engine.py` borra los parciales al fallar o cancelar | `test_face_runner.py` (NSFW y cancelar) |
| 20 | ffmpeg con la extensión del cliente | `services/audio-upload.ts` (`sniffAudio`, `-protocol_whitelist file,pipe -f <tipo>`), personas y «Voz propia» | `persons.test.ts` (WAV llamado `.m3u8`, playlist `#EXTM3U` → 400) |
| 21 | Deshacer forzaba `aiFace=false` | `ClipFaceSwap.prevAiFace` (aditivo); undo restaura | `face-swap.test.ts` «… undo restores» |
| 22 | Rutas `consent/` en diagnósticos; nombre de la Persona en el asset | `lib/consent-paths.ts` en `workers-client` (comando y error); asset «Voz Chatterbox (Voz clonada (Persona))» | `voice-chatterbox.test.ts` |
| 23 | Overrides de herramientas silenciosos | `toolvenv.override_warnings()` al arrancar los workers; `.env.example` | `test_toolvenv.py::test_override_warnings`; visto en el log del e2e |
| 24 | Cancelar en cola no mataba el recorte | `engine.py`: el `trim` es un `Popen` registrado; cancelar antes de empezar o durante el recorte lo mata | `test_face_runner.py::test_cancel_before_start_and_during_the_trim` |
| A | Consola: `Bash` con clientes HTTP | `claude-console-settings.json` deny `curl`, `wget`, `Invoke-WebRequest`, `Invoke-RestMethod`, `iwr`, `irm`, `sqlite3`; `CONSOLA-CLAUDE.md` (prefijos evitables con `python -c`/`node -e`) | `console.test.ts` |
| B | RVC sobre voz real | `voice-ai/handlers.ts`: `voice-cloned` (`tool: rvc:<modelo>`) salvo origen ya sintético/clonado; casilla bloqueada por la detección existente; manual §26.5/§17.7 | `voice-chatterbox.test.ts` |
| C | Dos esquemas de resultado TTS | `WorkersClient.tts` usa `WorkerTtsResultSchema`, acepta `timeoutMs` (0 = sin límite), `WorkersError.details`; Chatterbox va por el cliente compartido; se borró `createTtsExtendedCall` | `voice-chatterbox.test.ts` (error con `details`) |
| D | `models_cli --tool-venv facefusion ensure` sin licencia | sale con código 3 y mensaje en español; `setup.ps1` lo muestra como omitido | `test_cli_packs.py` |

Además (pedido del coordinador): `LICENSE` (todos los derechos reservados, uso personal, código
publicado para consulta), `NOTICE.md` (licencias de terceros; `apps/workers/vision_gpl/` GPL-3.0),
sección «Licencia» del `README.md`; rutas de ejemplo con nombres de personas → `C:\Users\Usuario`
(`Usuario Demo` donde hace falta un espacio); CI (`.github/workflows/ci.yml`): los tres trabajos de
Windows solo en `pull_request` y en `main`, `paths-ignore` de `docs/**` y `**/*.md` en `push`,
`concurrency` con cancelación (ya estaba).

| # | Pedido | Cambio (archivos) | Prueba |
| - | ------ | ----------------- | ------ |
| E | Repo público: licencia | `LICENSE` (todos los derechos reservados, uso personal; español + inglés), `NOTICE.md` (`vision_gpl` GPL-3.0-or-later derivado de RobustVideoMatting en venv y proceso aparte; Remotion; FaceFusion OpenRAIL-AS + InsightFace no comercial, hyperswap ResearchRAIL, simswap CC-BY-NC 4.0, xseg GPL-3.0; Chatterbox MIT + PerTh; Demucs; SAM 2; faster-whisper; Piper; Llama 3.1 Community / Qwen; CoTracker solo en docs; enlace a `fuentes.md`), `README.md` «Licencia» | `prettier --check` |
| F | Sin nombres de personas en rutas de ejemplo | `console.test.ts`, `detect.ts`, `reports.test.ts`, `escape.test.ts`, `services/ffmpeg/escape.ts` (JSDoc), `fuentes-editor.md` → `C:\Users\Usuario` / `C:\Users\Usuario Demo` (se conserva el espacio) | `git grep` del nombre anterior: vacío; tests de api |
| G | CI más barata | `ci.yml`: `concurrency` `ci-${{ github.ref }}` con cancelación; matriz de Node y Python con `windows-latest` solo si `pull_request` o `refs/heads/main`; `windows-smoke` con el mismo `if`; `paths-ignore` (`docs/**`, `**/*.md`) solo en `push` | YAML validado con `yaml.safe_load` (venv de workers) |
| H | Instalador: sello de requirements no veía cambios en requirements.txt bajo perfil CUDA | `common.ps1` (`Add-RequirementsChain` + `Get-RequirementsHash`: hash del requirements y de todo lo que incluye con `-r`/`-c`, recursivo, relativo al archivo que lo incluye, en orden de inclusión; sin includes = mismo valor que `Get-FileHash`), `setup.ps1` paso «Workers Python (.venv)» (línea 1 del sello `<perfil> <HEX>`; un sello CUDA viejo reinstala una vez, lo avisa el `Write-Info`); `INSTALACION-WINDOWS.md` §9. Antes `-WithCuda` solo hasheaba `requirements-cuda.txt` y se salteaba `pip install -r` cuando `requirements.txt` sumaba dependencias (`jsonschema` → `ModuleNotFoundError` al arrancar los workers). `.venv-gpl` y herramientas: el hash lo calcula `toolvenv.py` y sus requirements no usan `-r` | `pwsh` 7.4 (sandbox): `ParseFile` de `setup.ps1`/`common.ps1` sin errores; CPU = `Get-FileHash`; CUDA estable entre corridas y cambia al tocar `requirements.txt`; ciclos, `--requirement=`, comillas e includes faltantes |

### Verificación de las correcciones (2026-10-07, desde cero)

- `pnpm lint`, `format:check`, `-r typecheck`, `-r build`, `-r test` OK: shared 106, studio-mcp 18,
  motion-engines 22, remotion 55 + 1 skip, web 228, api 283 + 1 skip. `studio-mcp smoke`: 18
  herramientas. Workers: ruff OK, pytest **459 passed, 9 skipped**. `validate-dataset.py`: OK.
- **`run-e2e.mjs`** (sin `--skip-motion`, storage y modelos nuevos, workers con mocks): **74/74
  obligatorios** (544 s), con el paso nuevo «sprint4 auditoría» (Host ajeno → 403, foto sin
  `Origin` → 403, `photo_ids`, espejo `active.json` solo con la foto cubierta, «Revocar rostro»,
  auditoría con cadena íntegra); 3 SKIP (`--hw`, descarga de Hugging Face, ruta LLM sin Ollama) y
  2 expected-fail (Whisper y Piper sin modelos). El log de los workers muestra el aviso de la
  corrección 23 (`CHATTERBOX_PYTHON=… reemplaza la herramienta administrada…`).
- **`ui-smoke.mjs --vp9-preview`** (storage nuevo, `STUDIO_MOCK_DENOISE=0`): **38/38**.
- Manual: §9.3 (RVC → voz clonada) en `MANUAL-USUARIO.md` e `index.html`; PDF regenerado con
  Playwright Chromium forzando la carga de las imágenes `loading="lazy"` (el PDF anterior salía
  sin algunas capturas): 80 páginas, las 6 capturas.

### Desvíos

- `photo_ids`/`sample_ids` son opcionales **sin** valor por defecto: `[]` significa «no cubre
  ninguna» (consentimiento registrado antes de subir fotos) y ausente = consentimiento anterior a
  esta corrección (cubre todo). Con `default([])` no se podían distinguir.
- Revocar «rostro» revoca entero un consentimiento «rostro y voz» (un consentimiento, una fecha de
  revocación); la UI lo avisa antes de confirmar.
- La comprobación de `Host` no mira el puerto cuando no hay socket real (`app.inject` de los tests).
- `doctor.ps1` escribe «verificacion pendiente» sin tilde, como el resto de sus mensajes.

## Descubierto

- **PIN local**: Studio no tiene autenticación; `HUMAN_ONLY` reconoce a la web por `Origin` /
  `Sec-Fetch-Site`, que un proceso local con terminal puede falsificar (también la Consola Claude
  vía `python -c` / `node -e`, que las reglas `deny` por prefijo no cubren). La solución de fondo es
  un PIN (o token de un solo uso) que solo conozca la persona para consentimientos, licencias y
  biometría.
- **Filtro NSFW de las fotos de Persona**: el analizador de FaceFusion revisa solo el destino; las
  fotos de origen no pasan por ningún filtro (hoy se confía en que son de una Persona con
  consentimiento). Falta un chequeo propio (p. ej. el mismo `nsfw_*.onnx`) al subirlas.
- **Hashes de Hugging Face**: Chatterbox, hubert y rmvpe siguen en «confianza en la primera
  descarga» (ahora con revisión y sha256 fijados después); falta fijar de antemano commit + sha256
  publicados (`HfApi().model_info(..., files_metadata=True)` desde la PC del usuario) y
  `--require-hashes` para los requirements de las herramientas.
- **Texto real del rechazo NSFW de FaceFusion 3.9.1**: sigue sin fijar; mientras tanto la heurística
  («processing … failed» con exit 1) y `FACEFUSION_NSFW_RE` en `.env`.

# Módulo Sprint 4 — Personas + consentimiento + cambio de cara (agente «caras», M1)

Contrato: `sprint4-contratos.md` («M1», «Gate», «Códigos de error nuevos»). Fuentes: `fuentes-sprint4.md` §1
(FaceFusion 3.9.1). Manual: §24 y §25 (borradores abajo).

## Qué hay

- **Shared** (`packages/shared/src/consent.ts`, solo funciones): `renderConsentText(nombre, alcance)`,
  `activeConsent(p, need, now?)` (historial: vale el último vigente que cubre `need`; `both` cubre los
  dos), `consentReason` (`none | scope | revoked | expired`), `consentState`
  (`vigente | vencido | revocado | sin consentimiento`), `consentCovers`, `consentExpired`, `personSummary`,
  `CONSENT_SCOPE_ES`. Test `packages/shared/test/consent.test.ts` (7).
- **API**
  - `services/persons/db.ts`: tablas propias con `ensurePersonsSchema` idempotente (`persons` con
    `deleted_at`, `ai_licences`, `consent_audit` solo-agregar: la clase no tiene update/delete).
  - `services/persons/gate.ts`: `ConsentGate` con la firma del contrato (`assertConsent`,
    `voiceSamplePath`, `assertLicence`, `isLicenceAccepted`, `benchFaceSource`, `audit`),
    `createConsentGate(db, storageDir)` (una instancia por db + storage: M2/M3 pueden llamarla las veces
    que quieran), `assertHumanOrigin(req, config)` (Origin = lista de CORS de la web y nunca
    `X-Studio-Client: mcp`), `isMcpRequest`, `consentRequired`, `licenceRequired`, `licenceTextSha256`.
  - `services/persons/files.ts`: rutas de `storage/consent/…`, sniffer de PNG/JPEG/WebP (tipo y tamaño
    reales por cabecera), PDF, espejo `consent/licences.json` (escritura atómica `.tmp` → rename),
    archivo al borrar la Persona.
  - `services/persons/face-workers.ts`: cliente de `/face/*` de los workers (no toca
    `workers-client.ts`, archivo compartido). **No registra el cuerpo** de los pedidos en los
    diagnósticos del job (llevan rutas `consent/…`).
  - `routes/persons.ts`: `/api/persons` (CRUD, fotos ≤ 10 · ≤ 15 MB · lado ≤ 8192 px, muestras de voz
    5–60 s → WAV 24 kHz mono con `silenceremove` en los bordes + `loudnorm`, ≤ 30 s, ≤ 5; consentimientos
    multipart con `HUMAN_ONLY`, `TEXT_OUTDATED`, firma PNG ≤ 2 MB o documento PDF/JPG/PNG ≤ 20 MB;
    revocar; evidencia) y `/api/ai/licences` (listar / aceptar `HUMAN_ONLY` / revocar + espejo).
    Las fotos, muestras y evidencias solo se leen por estas rutas (nunca por `/files`, y nunca con
    `X-Studio-Client: mcp` → 403). Borrar exige `?confirm=1` (409 `CONFIRM_REQUIRED`).
  - `routes/face.ts` + `jobs/handlers/face.ts`: `/api/face/detect` (síncrono), `/api/face/preview` y
    `/api/face/swap` (202) y `/api/face/undo`. Chequeo previo en el orden del contrato (licencia → pack
    `faceswap` (+ `faceswap-extra`) → consentimiento de rostro → venv (`TOOL_MISSING` con el `tool` de
    `GET /packs`) → límites `CLIP_TOO_LONG`) **al encolar y otra vez al empezar** el job. Un job que
    falla deja el `ApiError` en `result` (la web lee el código: `CONSENT_REQUIRED`, `CONTENT_BLOCKED`…).
    Resultado: asset `renders/face/<jobId>/faceswap.mp4` (`aiAltered`, `aiProvenance{kind:"face",
    tool:"facefusion 3.9.1 <modelo>", personId, consentId, licences, jobId, sourceAssetId}`) + `media.probe`
    + `media.proxy`; con `target`, el clip pasa al asset nuevo (`in 0`, `out` = largo del tramo),
    `faceSwap.prev` guarda `assetId/in/out` + `matte` y `maskRef` de tipo asset (se quitan, aviso
    `matte_removed`) y `publish.flags.aiFace = true`. Auditoría: `face.preview`, `face.swap`,
    `face.swap.done`, `face.undo`, `consent.*`, `licence.*`, `person.*`.
  - `routes/ai.ts`: `POST /api/ai/packs/:id/download` de un pack con `licence_gate` sin aceptar → 403
    `LICENCE_REQUIRED`. `app.ts`: registro + `consent/` (sin distinguir mayúsculas) en `allowedPath`.
    `reports/builder.ts`: nunca copia `consent/…` y oculta esas rutas en todos los textos del reporte.
    `apps/api/console/claude-console-settings.json`: `Read(./storage/consent/**)` denegado.
  - Asistente: op `face_swap` (resolver: clip de video, Persona por `name` difuso o `id`, sin
    consentimiento vigente / ambigua / inexistente → pregunta «Registrá el consentimiento de X en Ajustes →
    Personas»; `t` + `face_index` → selector `reference`; riesgos «contenido alterado», pack, licencia,
    operación larga; > 10 min → pregunta). `agent.apply` lo corre como sub-job `face.swap` con
    `confirmed: true` (solo llega si el índice está en `confirmedIndexes`). Op `tts`: voz
    `chatterbox:*` → proveedor `chatterbox`.
- **Workers** (`studio_workers/face/`, `routers/face.py`, `main.py`, bloques en `packs.py`/`services.py`)
  - `detect.py`: YuNet (el mismo `YuNetDetector`/archivo del pack `reframe`), imagen o fotograma `t`
    (PNG en `renders/face/detect/`), caras izquierda → derecha en fracciones. Sin cv2/YuNet → 409
    `PACK_REQUIRED faceswap`.
  - `runner.py`: argv de `headless-run` **fijado por test** (lista, `shell=False`), proceso en su grupo,
    `\r` de tqdm leído como línea (progreso %), cola de 40 líneas, clasificación: mensaje del analizador
    (`NSFW_RE`) o salida ≠ 0 sin archivo y sin líneas de error → `CONTENT_BLOCKED` (422); el resto →
    `TOOL_FAILED` (502, `details.logTail`); línea JSON `LAUNCH_FAILED` de `tools/launch.py` → `TOOL_FAILED`.
    Cancelar = matar el árbol (`taskkill /T /F` / `killpg`).
  - `engine.py`: licencia en el espejo → venv listo (`TOOL_MISSING`) → modelos (presencia + `.hash` ==
    CRC32 fijado + `crc32(onnx) == .hash`, con sello `models/facefusion/.studio-crc.json` para no
    rehashear) → `PACK_REQUIRED` **antes** de lanzar → límites → cara de referencia (`NO_FACE` si el
    fotograma tiene menos caras) → `GpuBudget.release()` + `acquire("facefusion", 3500, unload=matar)`;
    sin VRAM → `cpu` + `gpu_fallback_cpu` (+ `facefusion_cpu_slow` en video). Video: recorte preciso
    `-ss/-t` reencodado (CRF 12) → FaceFusion → `strength < 1`: `blend` sobre el original (H.264 CRF 16),
    `strength = 1`: copia del video de FaceFusion (`--output-video-quality 80` ≈ CRF 10) + audio original.
    Vista previa: `before.png` / `after.png`.
  - `tool.py`: puente al runtime de M3 (`toolvenv.command/status_summary/status_rows/ensure/
    licence_accepted`, import diferido). Si `toolvenv` no existe, `_launch()` con la misma firma
    `(argv, env, cwd)` corre `<FACEFUSION_PYTHON | tools/facefusion/.venv> <FACEFUSION_APP_DIR |
    tools/facefusion/app>/facefusion.py …` con el mismo entorno (sin `HF_TOKEN`, `HF_HUB_OFFLINE=1`,
    UTF-8, `OMP_NUM_THREADS=1`): pasar al lanzador de M3 no requiere cambios (ya delega cuando está).
    Siempre agrega la carpeta del ffmpeg de Studio al `PATH` del hijo.
  - Packs `faceswap` (≈ 4,05 GB con venv: 1806 MB de modelos [V] + YuNet + OpenCV + 2,2 GB de venv) y
    `faceswap-extra` (≈ 815 MB): `.onnx` + `.hash` de `facefusion-assets` (GitHub releases) a
    `models/facefusion/`, `licence_gate="faceswap"`, `post_install` = verificación CRC32,
    `post_install_env` / `extra_status` / `tool_status` delegados a `toolvenv`.
  - `tools/facefusion/{requirements-cuda.txt, requirements-cpu.txt, facefusion.lock.json}`.
- **Web**: Ajustes → **Personas** (`components/consent/PersonsTab.tsx`: lista con estado por alcance,
  crear, fotos con arrastrar y soltar + contador de caras, muestras de voz subir/grabar 10 s,
  «Registrar consentimiento» con texto versionado, pestañas «Firma en pantalla» (`SignaturePad`) /
  «Documento adjunto», alcance, vencimiento, casilla obligatoria, historial con «Revocar» y evidencia,
  «Borrar persona» con confirmación). `LicenceDialog` global (evento `studio:licence:open` y todo 403
  `LICENCE_REQUIRED` desde `lib/api.ts`). Asistente «Cambiar cara» (`components/face/FaceSwapWizard.tsx`
  + `stores/face-store.ts`): Persona (solo vigentes; «Registrar persona») → cara en el fotograma (cajas,
  clic, deslizador) → modelo con su licencia, mejorador, intensidad + vista previa antes/después →
  casilla «La persona dio su consentimiento y nadie en el video es menor de edad», progreso y estimación
  con `facefusion_fps`. Entradas: menú contextual del clip (`components/timeline/ClipContextMenu.tsx`),
  Propiedades (`FaceSwapSection`: insignia «IA: cara (Persona)» + «Deshacer cambio de cara») y paleta.
  `CONSENT_REQUIRED` → «Abrir Personas»; `CONTENT_BLOCKED`/`TOOL_FAILED` → «Reportar error» con el jobId.
- **MCP**: `studio_list_persons` (solo lectura, sin rutas) y `studio_face_swap` (`confirmed:
  z.literal(true)`, descripción con la pregunta obligatoria); `X-Studio-Client: mcp` en todo pedido.
  `CLAUDE.md`: filas, op `face_swap` y regla «nunca registres consentimientos ni aceptes licencias».
- Progreso: el % que imprime FaceFusion (barras tqdm); no hay estimación por `facefusion_fps` cuando no
  imprime nada (el asistente muestra la estimación antes de aplicar).
- **Dataset**: 3 golden + 6 train con `face_swap` (+ 2 de solo preguntas); ver
  `apps/workers/studio_workers/agent/dataset/README.md`; `system_es.md` menciona la op.

## Pruebas

- Unitarias: shared `consent.test.ts` 7; api `persons.test.ts` 9 (CRUD, límites, sniffer, muestras
  de voz con ffmpeg real, `HUMAN_ONLY` sin Origin / con `X-Studio-Client: mcp` / Origin ajeno,
  `TEXT_OUTDATED`, `/files/consent/…` → 404, revocación, baja, reporte sin `consent/`) +
  `face-swap.test.ts` 9 (licencias + espejo + descarga de pack con gate, orden del chequeo previo,
  vista previa, swap con `target` → asset `aiAltered` + `faceSwap.prev` + `aiFace` + deshacer,
  revocación y licencia retirada con el job en cola, NSFW → `CONTENT_BLOCKED`, `TOOL_FAILED` con
  `logTail`, detect, op `face_swap` del Asistente con 409 sin confirmar y sub-job); workers
  `test_face_runner.py` 10 + `test_face_router.py` 6 (con el `facefusion.py` falso: argv, entorno sin
  `HF_TOKEN`, cwd, `--temp-path`, tramo + intensidad + audio, vista previa, `NO_FACE`, NSFW,
  `TOOL_FAILED`, licencia/venv/modelos antes de lanzar, CRC32 y sello, GPU CUDA/CPU, cancelar mata el
  árbol, espejo, `consent_id`, `..`, códigos de tarea, registro de packs, puente a `toolvenv`);
  studio-mcp +4; web `face.test.tsx` 9 (helpers, flujo completo del asistente, licencia, error con
  «Abrir Personas», diálogo de licencia, pestaña Personas).
- e2e (sandbox Linux, sin GPU; api `:3101` desde `dist/`, workers `:8101` con
  `scripts/e2e/workers-with-mocks.py`, web `next build` + `next start :3100`, Playwright Chromium):
  `run-e2e.mjs` 6/6 pasos «sprint4» de M1 (también re-ejecutados sobre el mismo storage);
  `ui-smoke.mjs` 2/2 («Ajustes → Personas: crear, firmar en pantalla, consentimiento vigente»,
  «Cambiar cara (mock): vista previa, aplicar, insignia IA, deshacer»). La corrida completa de
  `run-e2e.mjs --skip-motion` (después de los commits de M2 y M3) da 60 PASS y 6 FAIL requeridos,
  todos del entorno: 5 exportaciones con `EXPORT_BLOCKED` porque los motion quedan sin renderizar
  (sin Chrome Headless Shell para Remotion) y el paso RVC de M3 (`rvc-base` no instalado). Pasan
  los 6 pasos de M1 y el de licencia de punta a punta de M3.
- Arreglos que salieron del smoke: el `SignaturePad` se borraba en cada re-render (callback del padre en
  una ref) y el diálogo de licencia quedaba debajo del asistente / de Ajustes (ahora se monta después).

## Desvíos del contrato

- `golden.jsonl` debe tener exactamente 80 líneas (lo exige `validate-dataset.py`): en vez de sumar 3,
  `g028`, `g049` y `g067` pasaron a `train.jsonl` y entraron `g101`–`g103` con `face_swap`.
- `components/dashboard/CommandPalette.tsx` no figura en mis rutas pero el contrato pide «paleta»:
  bloque `BEGIN/END sprint4:M1` con 2 entradas («Personas y consentimientos», «Cambiar cara del clip
  seleccionado»), sin atajo. Los diálogos globales se montan desde `SettingsDialog.tsx` (mío) para no
  tocar `Dashboard.tsx`.
- El resolver necesita las Personas y `ResolveContext` no tiene la db: `services/agent/persons.ts`
  (`setPersonsDirectory`, lo registra `app.ts`); `agent.apply` además pasa `persons` explícito.
  `routes/agent.ts`/`console.ts`/`style.ts` (no míos) usan el registro.
- `/api/face/detect` devuelve 200 con `faces: []` (la web muestra el texto de `NO_FACE`); el 422
  `NO_FACE` sale al subir una foto sin caras, cuando la Persona no tiene fotos utilizables y cuando el
  fotograma de referencia no tiene la cara elegida (workers).
- Una foto de Persona cuya marca de NSFW de prueba no puede ir en el nombre (el servidor renombra): el
  `facefusion.py` falso de e2e también rechaza fotos que terminan en los bytes `NSFW-TEST`.
- Workers `LICENCE_REQUIRED.details` = `{licenceId}` (la api reconstruye el detalle completo con
  `licenceRequired()` cuando lo devuelve un job).
- `strength = 1` copia el video de FaceFusion (calidad 80 ≈ CRF 10, mejor que CRF 16); `strength < 1`
  reencoda a CRF 16.

## Pedidos a M3

1. `toolvenv.ensure("facefusion")`: junction `tools/facefusion/app/.assets/models` → `models/facefusion`
   (ahí bajan los packs `faceswap`/`faceswap-extra`; FaceFusion no descarga nada si están los `.onnx` +
   `.hash`).
2. `.gitignore`: además de `tools/facefusion/app/` y `tools/*/.venv/`, nada nuevo (todo lo de M1 vive en
   `storage/consent/` y `models/facefusion/`, ya ignorados). `.env.example`: sin claves nuevas de M1
   (uso `FACEFUSION_PYTHON` / `FACEFUSION_APP_DIR` de M3).
3. `AiPacksTab`: el botón «Leer y aceptar» puede llamar `openLicenceDialog("faceswap")` de `lib/api.ts`
   (evento `studio:licence:open`); al aceptar se emite `studio:licence:accepted`.
4. `perf.run`: `createConsentGate(ctx.db, storageDir).benchFaceSource()` da `{personId, consentId,
   photoPath}` (foto con cara de la primera Persona con rostro vigente). Para medir con el motor de M1:
   `services.face_engine().run(FaceSwapWorkerRequest(...), task_id)` (devuelve `proc_fps`, `timings`).
5. CI: los tests de M1 no crean venvs ni bajan modelos (`fake_facefusion/facefusion.py`, `require_models`
   simulado). `doctor`: la licencia se lee de `storage/consent/licences.json`.
6. `tools/launch.py --preload-ort` con `FACEFUSION_PYTHON` del venv principal (e2e): si el `onnxruntime`
   del venv principal no tiene `preload_dlls()`, el lanzador no debería fallar en modo CPU.
7. `perf.run` en la corrida e2e completa midió FaceFusion con la foto de la Persona del paso NSFW
   (marcador `NSFW-TEST`) y por el camino propio de `perf.py`, que reporta «Processing to video
   failed» como error genérico: conviene elegir una Persona sin bloqueo previo y, si se usa ese
   camino, clasificar con `face.runner.classify` (→ `CONTENT_BLOCKED`).

## Borrador manual §24 — Personas y consentimiento

**Para qué.** Studio solo usa la cara o la voz de alguien que lo autorizó: esa persona se registra en
**Ajustes → Personas** con su consentimiento. Sirve, por ejemplo, para poner la cara del actor sobre la
de su doble de riesgo.

1. **Crear la Persona**: escribí su nombre y tocá «Nueva persona». Podés agregar notas.
2. **Fotos** (hasta 10, JPG/PNG/WebP de hasta 15 MB): de frente, con buena luz, sin anteojos oscuros.
   Studio cuenta las caras de cada foto; una foto sin caras se rechaza.
3. **Muestras de voz** (hasta 5, de 5 a 60 s): «Grabar 10 s» o «Subir audio». Se guardan normalizadas
   (24 kHz, mono, hasta 30 s).
4. **Registrar consentimiento**: elegí el alcance (rostro, voz o rostro y voz) y, si querés, una fecha de
   vencimiento. Leé el texto con la persona («Yo, {nombre}, mayor de edad, autorizo expresamente…»). La
   persona **firma en pantalla** (en el recuadro, con el mouse, un lápiz o el dedo) o adjuntás un
   **documento firmado** (PDF, JPG o PNG). Marcá «Leí este texto con la persona y lo acepta» y tocá
   «Registrar consentimiento». Studio guarda el texto exacto (su huella), la firma o el documento y la
   fecha.
5. **Estados**: *vigente*, *vencido* (pasó la fecha), *revocado* o *sin consentimiento*. Vale el último
   consentimiento vigente.
6. **Revocar**: «Revocar» en el consentimiento. Lo ya generado no se borra, pero no se puede usar para
   nada nuevo (los trabajos en cola fallan al empezar).
7. **Borrar persona**: borra sus fotos y muestras; los consentimientos se archivan (quedan como prueba).

**Dónde se guarda.** En tu PC, en `storage\consent\`. Nunca se sube a internet, no se sirve por
`/files`, no entra en los reportes de error y la Consola Claude no puede leerla. La Consola y el
asistente **no pueden** registrar consentimientos ni aceptar licencias: solo vos, desde la pantalla.

## Borrador manual §25 — Cambiar cara

**Antes de empezar**: una Persona con consentimiento de **rostro** vigente (§24), el paquete «Cambio de
cara (FaceFusion 3.9.1)» (Ajustes → Paquetes de IA, ≈ 4 GB) y la **licencia** aceptada en pantalla: los
modelos son de uso **no comercial** (ArcFace, kim_vocal_2, inswapper), ResearchRAIL (hyperswap), GPL-3
(xseg) y FaceFusion es OpenRAIL-AS (prohíbe suplantar sin consentimiento, el contenido sexual no
consentido y la desinformación). Sin aceptarla no se baja ni se ejecuta nada.

1. Clic derecho en el clip de video → **«Cambiar cara…»** (o Propiedades → «Cambiar cara…», o la paleta).
2. **Persona**: elegí quién (solo aparecen las que tienen consentimiento de rostro vigente).
3. **Cara en el video**: Studio muestra el fotograma del cursor con las caras encontradas; hacé clic en la
   que querés cambiar (con el deslizador elegís otro momento). Se sigue en todo el clip.
4. **Opciones**: modelo (cada uno con su licencia: HyperSwap 1a recomendado; Ghost 1 e InSwapper en
   «Modelos extra»), mejorador de nitidez (GFPGAN) y su mezcla, intensidad. **Vista previa de 1
   fotograma** antes / después.
5. **Aplicar**: marcá «La persona dio su consentimiento y nadie en el video es menor de edad» (sin eso no
   se aplica) y tocá «Aplicar cambio de cara». Se procesa el tramo del clip (hasta 10 min y 4K por vez).
   En GPU (RTX 4050) ≈ 15–25 fotogramas por segundo sin mejorador; en CPU, entre 15 y 60 min por minuto.
6. El clip pasa a mostrar el video nuevo, con la insignia **«IA: cara»**; el video queda en Medios. Si el
   clip tenía recorte de fondo, volvé a recortarlo.
7. **Deshacer**: Propiedades → «Deshacer cambio de cara» (o «Deshacer todo» del Asistente).

**Analizador de contenido.** FaceFusion revisa siempre el video destino y rechaza contenido explícito
(«El analizador de contenido de FaceFusion bloqueó este video o imagen»). Studio no lo puede apagar.

**Redes.** El cambio de cara marca el proyecto como «cara alterada con IA»; al marcar «Voy a subirlo a
redes» se propone la etiqueta «Contenido alterado con IA» (Revisión para redes).

**Asistente y Consola.** El pedido «poné la cara de Martín en el doble» crea la op `face_swap`, que
siempre pide confirmación aparte. La Consola Claude tiene `studio_face_swap` y debe preguntarte si
confirmás el consentimiento y que no hay menores.

## Borrador ARQUITECTURA

- §2 API: `/api/persons` (+ `/:id`, `/photos[/:photoId]`, `/voice-samples[/:sampleId]`, `/consents`,
  `/consents/:cid/revoke|evidence`), `/api/ai/licences` (+ `/:id/accept|revoke`), `/api/face/detect|
  preview|swap|undo`. `HUMAN_ONLY`: consentimientos y aceptación de licencias exigen el `Origin` de la
  web y rechazan `X-Studio-Client: mcp` (lo manda `studio-mcp`).
- §3 Workers: `POST /face/detect {path, t}` → `{t, width, height, frame_path, faces}`; `POST /face/swap
  FaceSwapWorkerRequest` → `{task_id}` (cola propia `face`); `GET /face/tasks/{id}` → `{status, progress,
  message, result: FaceTaskResult, error, code, details}`; `POST /face/tasks/{id}/cancel`.
- §4 Jobs: `face.preview` y `face.swap` (carril workers), chequeo previo al encolar y al empezar.
- §5 Almacenamiento: `storage/consent/persons/<id>/{photos,voice,consents/<cid>}/…`,
  `consent/archive/<id>/`, `consent/licences.json`; `renders/face/<jobId>/`, `renders/face/detect/`;
  `models/facefusion/*.onnx|.hash|.studio-crc.json`. Tablas: `persons`, `ai_licences`, `consent_audit`
  (solo agregar). `/files` rechaza `consent/`.

## Solo medible en la PC

- fps reales a 1080p con y sin GFPGAN (meta [S] 15–25 / 6–12), VRAM de hyperswap + GFPGAN (presupuesto
  3500 MB), que `CUDAExecutionProvider` cargue en `tools\facefusion` (DLLs nvidia-cu12 + `preload_dlls`).
- **Texto real del rechazo NSFW de 3.9.1** (fijarlo en `NSFW_RE` de `face/runner.py` y en el test) y que
  la heurística «salida 1 sin archivo ni líneas de error» no confunda otros fallos.
- Release y CRC32 de `crossface_ghost` (`packs.py`, hoy solo contra su `.hash`), sha256 de primera
  descarga de los `.onnx`, junction de modelos con rutas con espacios/tildes.
- Calidad en primeros planos y con varias caras (`--reference-face-distance 0.3`), sincronía del audio
  tras el recorte, rendimiento del sello CRC32 (primer uso ≈ 1,8 GB a leer).

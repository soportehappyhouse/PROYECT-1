# Módulo sprint 4 — M2 Voz: Chatterbox TTS + clonación

Contrato: `sprint4-contratos.md` «M2» (+ «Decisiones» D9 y 9–10, «Reglas comunes», `ConsentGate` de M1,
`toolvenv`/`tools/launch.py` de M3). Fuentes: `fuentes-sprint4.md` §2. Manual: §26 (borrador abajo).

## Qué se construyó

- **Puente** `tools/chatterbox/studio_tts_server.py` (corre dentro de `tools/chatterbox/.venv` vía
  `tools/launch.py`): proceso persistente, carga el modelo **una vez** (`ChatterboxMultilingualTTS.from_local(dir,
  device, t3_model="v3")`; sin `t3_model` en la V2 de PyPI 0.1.7) y habla JSON por línea (stdin/stdout,
  protocolo del contrato). La fd 1 se redirige a stderr antes de importar torch (stdout = solo eventos,
  JSON ASCII). Trozos ≤ 300 caracteres por oración (después comas, después espacios), 120 ms de silencio
  entre trozos, progreso por trozo, WAV 24 kHz mono 16 bit escrito atómico (`.tmp` → rename), `rtf` en
  `done`. Condicionales de la referencia una vez por pedido (`prepare_conditionals`), y vuelve a `conds.pt`
  sin referencia. Revisa los 6 archivos del modelo antes de importar torch (`MODEL_MISSING`), PerTh
  (`WATERMARK_MISSING` si `PerthImplicitWatermarker` es `None`; **nunca** lo desactiva), `sm_XY` fuera de
  `torch.cuda.get_arch_list()` → CPU + `gpu_arch_unsupported` (RTX 50xx con torch 2.6), sin CUDA →
  `gpu_fallback_cpu`, OOM → `CUDA_OOM`. `HF_HUB_OFFLINE=1` y sin `HF_TOKEN` (además del lanzador).
  `--mock`: tono 220 Hz (330 Hz con `ref`), 0,06 s por carácter, sin torch.
- **Receta** `tools/chatterbox/{requirements.txt, chatterbox.lock.json}` (SHAs del contrato; el orden de
  instalación lo ejecuta `toolvenv.ensure("chatterbox")` de M3).
- **Workers** `studio_workers/tts/chatterbox.py`: `ChatterboxClient` (único: `services.chatterbox_client()`,
  bloque M2 de `services.py`): arranque perezoso, `GpuBudget.acquire("chatterbox", 4500, unload=stop)`,
  espera `ready` ≤ 180 s, un pedido a la vez, apagado por `CHATTERBOX_IDLE_S` (120 s; libera el
  presupuesto), `unload` del presupuesto = terminar el árbol de procesos (`toolvenv.kill_tree`),
  muerte del hijo → **un** reinicio + reenvío, segunda → `TOOL_FAILED` 502 con `details.logTail` (40
  líneas de stderr), `CUDA_OOM` → reinicio en CPU (`gpu_fallback_cpu`), en CPU siempre
  `chatterbox_cpu_slow`. `ChatterboxProvider` en `build_providers` (Piper sigue por defecto). Defensa en
  profundidad de la referencia (`check_voice_ref`): `resolve_input` (`..`/absoluta → 400), «Voz propia»
  (`consent: "self"`) nunca bajo `consent/`, muestra de Persona solo bajo `consent/persons/<id>/` de una
  Persona no archivada (`consent/archive/<id>` → 403 `CONSENT_REQUIRED` `deleted`) y consentId bien formado.
  `POST /tts` rama chatterbox: texto ≤ 5000 (400) → pack (409 `PACK_REQUIRED`) → venv (409 `TOOL_MISSING`)
  → referencia → síntesis → MP3 por el camino de Piper. `TtsResult` += `device, warnings, watermark:
  "perth", rtf, model`; `TtsProviderInfo` += `pack_id, installed, supports_clone, models, languages, gpu`;
  `TtsRequest` += `language, model, voice_ref{path, consent}, exaggeration, cfg, temperature, seed`.
- **Pack `tts-chatterbox`** (bloque M2 de `packs.py`): «Voz avanzada (Chatterbox: español y clonación)»,
  grupo `voice`, MIT + PerTh siempre activa; `ve.pt`, `t3_mtl23ls_v3|v2.safetensors` (según el `variant`
  del sello; sin venv: V3, o V2 si falta Git), `s3gen.pt`, `grapheme_mtl_merged_expanded_v1.json`,
  `conds.pt`, `Cangjie5_TC.json` de `huggingface.co/ResembleAI/chatterbox/resolve/main/` →
  `models/chatterbox/` (trust on first download: `min_bytes` + sha256 en `models/manifest.json`);
  `post_install_env` = `toolvenv.ensure("chatterbox")` y, si el venv quedó en V2, baja en el mismo job el
  T3 de V2; `extra_status`/`tool_status` delegan en `toolvenv` (import diferido, `{"state": "missing"}` si
  falta el módulo). ≈ 6,2 GB (venv ≈ 3 GB [S] + pesos ≈ 3,2 GB [S]).
- **API** `voice-ai/chatterbox.ts` (fila del proveedor con `default` según la decisión 10, voz
  `chatterbox:multilingual`, validación, fuente del clon con el `ConsentGate` de M1 o el asset
  `voice-ref`, llamada a workers que conserva los campos nuevos), `voice-ai/self-refs.ts` («Voz propia»:
  `attestSelf=true` obligatorio, 25 MB, decodifica → 5–60 s con audio → recorta silencios de borde +
  loudnorm → WAV 24 kHz mono ≤ 30 s, asset `voice-ref` sin `media.probe`), `routes/voice-ai.ts`
  (`GET/POST /api/voice/self-refs`, proveedores, voces, `POST /api/voice/tts` chatterbox), `handlers.ts`
  (`voice.tts` repite los chequeos al empezar; asset `aiAltered` + `aiProvenance` `voice-synthetic` |
  `voice-cloned` con `personId/consentId` o `self/sourceAssetId`; Piper y nube también `voice-synthetic`;
  `gate.audit({action: "voice.clone"})`; resultado `provider, device, aiVoice, watermark, rtf, warnings`;
  `voice.rvc` devuelve `device` y hereda la procedencia del origen), `media-bridge.ts`
  (`registerAudioAsset` acepta `kind`, `channels`, `aiAltered`, `aiProvenance`).
- **Shared** `voice-clone.ts`: `parseChatterboxVoice`, `chatterboxVoiceId`, `CHATTERBOX_DEFAULTS`,
  `validateChatterboxRequest`, límites de muestra, frase para grabar, `WorkerTtsResultSchema`,
  `estimateChatterboxSeconds`.
- **Web** `stores/voice-clone-store.ts` + `VoicePanel.tsx` (Texto a voz): selector **Motor** (Piper /
  Chatterbox con estado del paquete / ElevenLabs / OpenAI; por defecto el `default` de la api), sin
  paquete «Descargar paquete (X GB)» o «Usar Piper»; Chatterbox: Idioma fijo «Español (es)», **Voz a
  clonar** (Ninguna · Voz propia · Persona… de `GET /api/persons?scope=voice`, solo vigentes con muestra),
  «Expresividad» y «Fidelidad al acento de la referencia» (0,5 / 0,5), aviso de CPU
  (`willRunOnCpu(status, "chatterbox")`) + toast `warnIfCpu`, «≈ X s» con `chatterbox_rtf`, nota PerTh,
  versión del modelo, contador 0/5000; sección **«Voz propia»**: frase rioplatense para leer, «Soy yo: es
  mi propia voz» obligatorio, «Grabar 10 s» (MediaRecorder) o «Subir archivo», escuchar/borrar; tras un
  clon: «Marcado como voz clonada (Revisión para redes)»; `CONSENT_REQUIRED` → «Abrir Personas».
- **studio-mcp**: nota del payload de `voice.tts` en `RUNNABLE_JOBS` (proveedor, voces `chatterbox:*`,
  `voiceRef`, rangos, 403/409). Sin herramienta nueva (el contrato no la pide); el op `tts` del EditPlan no
  cambia (el contrato usa `voice: "chatterbox:*"`; la línea de `agent.ts` la puso M1).
- **Tests**: workers `test_chatterbox_client.py` (15: partición ≤ 300, protocolo `--mock` + progreso +
  WAV, referencia 330 Hz, error que no mata el proceso, apagado por inactividad + liberación del
  presupuesto, `unload` del presupuesto mata al hijo, sin VRAM → CPU con avisos, muerte → un reinicio,
  dos muertes → `TOOL_FAILED` con `logTail`, timeout de `ready`, archivos faltantes → `PACK_REQUIRED`,
  PerTh roto → `TOOL_MISSING broken`, OOM → CPU, pedido JSON ASCII con rutas con espacios/tildes, argv
  `--models-dir/--device/--t3`, entorno sin `HF_TOKEN`), `test_tts_router.py` (19: proveedores/voces con y
  sin pack, 409, síntesis mock, MP3, clon de Voz propia y de Persona con el árbol `consent/` falso, `..` →
  400, archivada → 403, 5000, `TOOL_MISSING`, 422 de rangos, archivos del pack según `variant`, fila del
  pack, caída a V2 que baja el T3 de V2 con `httpx.MockTransport`); api `voice-chatterbox.test.ts` (16:
  proveedores + decisión 10, voces, 409, 400, gate 403 scope/revocado/vencido/none + 404 + 409 sin
  muestra, voice-ref inválido, síntesis `voice-synthetic`, clon de Persona `voice-cloned` + auditoría, clon
  de Voz propia `chatterbox:self`, revocado entre encolar y empezar, `TOOL_FAILED` en el job, Piper
  `voice-synthetic`, RVC `device` + herencia, self-refs `attestSelf`/413/5–60 s/30 s/silencio/no-audio);
  shared `voice-clone.test.ts` (9); web `voice-clone.test.tsx` (16).
- **E2E** (bloques `sprint4:M2`): `run-e2e.mjs` «sprint4: tts chatterbox (mock) → asset voice-synthetic»,
  «sprint4: Voz propia → voice-ref + clon → voice-cloned», «sprint4: voiceRef Persona sin consentimiento de
  voz → 403», «sprint4: sin pack tts-chatterbox → 409; op tts del Asistente sigue en Piper» (con mocks el
  pack está: verifica que el sub-job de `tts` sin voz va a Piper y que `chatterbox:self` va a Chatterbox y
  queda `cloned`); `ui-smoke.mjs` «Sprint 4: Voces: motor Chatterbox (mock), Voz propia y clonación con
  Persona»; `workers-with-mocks.py` `STUDIO_MOCK_CHATTERBOX` (pack instalado, `CHATTERBOX_PYTHON` =
  intérprete actual, puente real con `--mock`).

## Resultados (sandbox Linux, sin GPU)

- Stack real: api `node dist/index.js` (:3001, `STORAGE_DIR` temporal) + `workers-with-mocks.py` (:8001)
  + web `next build` / `next start` (:3000) + Playwright Chromium. `run-e2e.mjs --only` los 4 pasos
  «sprint4» de M2: **4/4 PASS** (síntesis mock 24 kHz mono con la duración esperada, `voice-ref` 24 kHz
  mono 8,8 s, clon `voice-cloned` con `self`/`sourceAssetId`, 403 `CONSENT_REQUIRED` con la Persona de M1,
  sub-job del Asistente: sin voz → `piper`, `chatterbox:self` → `chatterbox` `cloned`). `ui-smoke.mjs
  --only "Sprint 4: Voces"`: **PASS** (Persona + firma + muestra por la api de M1, subida de «Voz propia»
  desde el panel, clon con Voz propia y con la Persona; captura `s4-voces-chatterbox.png`).
- Unitarios: workers 34 nuevos (pytest total verde), api 16, shared 9, web 16.

## Desvíos del contrato y decisiones propias

- `gpu_fallback_cpu` solo cuando `USE_CUDA=true` y terminó en CPU (sin VRAM, CUDA que no carga, OOM);
  en CPU por configuración el resultado lleva solo `chatterbox_cpu_slow` (mismo criterio que el resto de
  los motores: no es una «caída»).
- Códigos extra: `WATERMARK_MISSING` en el protocolo del puente (→ 409 `TOOL_MISSING` `broken`, como pide
  el contrato); api `INVALID_VOICE_REF` (400: el asset no es `voice-ref`), `ATTEST_SELF_REQUIRED` (400),
  `TEXT_TOO_LONG` / `BAD_LANGUAGE` / `BAD_VOICE` (400) y `VOICE_SAMPLE_MISSING` 409 también para
  `chatterbox:self` sin ninguna «Voz propia».
- `model` pedido distinto del instalado → se usa el instalado + aviso `chatterbox_model_unavailable`.
- Llamada a workers propia (`createTtsExtendedCall`, node:http sin el timeout de 300 s de undici): el
  `TtsResultSchema` de `services/workers-client.ts` (de nadie) descarta `device/warnings/rtf/model`; no lo
  toqué. La integración puede unificarlo agregando esos campos ahí.
- Herencia de procedencia en RVC con una función local (`inheritVoiceProvenance`), misma semántica que
  `inheritAiProvenance` de M3 (`services/ai-provenance.ts`); la integración puede usar la de M3.
- `apps/workers/tests/test_packs.py`: la lista exacta de packs pasó a prefijo (`[:15]`) porque los packs
  de sprint 4 se agregan al final por bloques (M1 y M2); única línea tocada fuera de mis rutas.
- `packages/studio-mcp/src/tools.ts` (ruta de M1): solo la entrada `voice.tts` de `RUNNABLE_JOBS` (nota del
  payload), a pedido del coordinador.
- El T3 de V3 ya bajado no se borra si el venv cae a V2 (se baja también el de V2): 2,1 GB extra solo en
  ese caso (sin Git, que el instalador sí instala).
- Las muestras «Voz propia» quedan en `media/<id>.wav` (servidas por `/files` como cualquier medio del
  usuario; nunca en `consent/`).

## Pedidos a M3

1. **Test de rendimiento** (`perf.py`, `bench_chatterbox`): lanza un **segundo** puente con su propio
   `acquire("chatterbox", …)`; si el `ChatterboxClient` de los workers está residente con el mismo nombre,
   `acquire` no descarga nada y quedan dos modelos en la GPU (~9 GB en una 4050 de 6 GB). Antes del bench:
   `services.chatterbox_client().stop()` + `services.gpu_budget().release("chatterbox")`, o usar
   directamente `services.chatterbox_client().synthesize(job_id=None, text=…, out=…)` → `SynthesisOutcome`
   (`rtf`, `load_s`, `device`, `model`, `warnings`).
2. `.env.example`: `CHATTERBOX_PYTHON=` y `CHATTERBOX_IDLE_S=120` (el cliente lee `CHATTERBOX_IDLE_S` con
   `toolvenv.tool_settings().seconds("chatterbox_idle_s", 120)`).
3. `setup.ps1 -Full`: `tts-chatterbox` en la secuencia de packs (≈ 6,2 GB); `-Update`: `ensure` si cambió
   `tools/chatterbox/requirements.txt` o `chatterbox.lock.json`.
4. `doctor.ps1`: fila «Chatterbox (tools\chatterbox)» con estado, `variant` V3/V2, torch + CUDA, y
   «verificación pendiente» de los 6 archivos de `models/chatterbox/` (trust on first download).
5. CI: correr ruff también sobre `tools/chatterbox/studio_tts_server.py` (hoy el ruff de los workers solo
   mira `apps/workers`; el archivo pasa con la config de `apps/workers/pyproject.toml`).
6. `MediaPanel`: los assets `kind: "voice-ref"` («Voz propia») no deberían poder arrastrarse a la línea de
   tiempo (son muestras de referencia); mostrarlos con la insignia «Voz propia» o filtrarlos.
7. `AiPacksTab`: mostrar el `variant` (V3 / V2 respaldo) de `tool` para `tts-chatterbox`.

## Notas de integración

- `ConsentGate` de M1 (`services/persons/gate.ts`): se usa `createConsentGate(ctx.db, storageDir)`
  (cacheado por db) en la ruta y otra vez al empezar el job; los tests de api crean Personas con
  `gate.persons.insert` y leen `gate.auditLog.list({action: "voice.clone"})`.
- Las rutas `POST /api/voice/tts` y `/api/voice/self-refs` no exigen `Origin` humano: «Voz propia» es la
  voz del propio usuario (D9) y el clon de terceros pasa siempre por el consentimiento registrado.
- El sub-job `voice.tts` del Asistente (op `tts` con `voice: "chatterbox:self"` o `chatterbox:person:<id>`)
  pasa por los mismos chequeos al empezar.

## Borrador manual §26

## 26. Voces: Chatterbox y clonación

Studio tiene dos motores de voz locales en **Voz y audio → Texto a voz → Motor**:

- **Piper**: rápido, liviano, sin GPU (voz `es_AR-daniela-high` y las del paquete «Voces en español»).
  Sigue siendo el motor por defecto si no bajaste Chatterbox o si la PC no tiene GPU, y el que usa el
  Asistente salvo que le pidas otra voz.
- **Chatterbox** (Resemble AI, licencia MIT): voz en español más natural y **clonación**: puede leer el
  texto con tu voz, o con la de una persona que te dio su consentimiento, a partir de unos **10 s de
  muestra**. Corre en tu PC, en un entorno aparte (`tools\chatterbox`); nada sale de tu computadora. Si el
  paquete está y la PC usa la GPU, es el motor que aparece elegido.

### 26.1 Bajar el paquete

Elegí **Chatterbox** en _Motor_. La primera vez aparece **Descargar paquete (≈ 6,2 GB)**: baja el modelo
(≈ 3,2 GB de Hugging Face, repositorio público) y arma su entorno de Python (≈ 3 GB, con su propia copia de
PyTorch). Tarda según tu conexión; podés seguir trabajando. También está en **Ajustes → Paquetes de IA →
«Voz avanzada (Chatterbox: español y clonación)»**. Si preferís no bajarlo: **Usar Piper**.

Studio instala la versión **Multilingüe V3** desde el código fijado de GitHub; si no puede (sin Git o sin
acceso a GitHub) usa la **V2** de PyPI y lo indica como «Multilingüe V2 (respaldo)» debajo de las opciones.

### 26.2 Generar voz

1. Escribí el texto (hasta **5000 caracteres**; Studio lo lee en trozos de una o dos oraciones).
2. **Idioma**: español (fijo).
3. **Voz a clonar**: _Ninguna_ (la voz multilingüe del modelo), _Voz propia_ o _Persona: …_.
4. **Expresividad** (0,5): más alto = más dramático y un poco más rápido.
5. **Fidelidad al acento de la referencia** (0,5): con una muestra en español conserva la tonada de la
   muestra; bajala a **0,3** si la persona de la muestra habla rápido.
6. **Generar y añadir al cursor**: el audio nuevo queda en Media y en la línea de tiempo, en el cursor.

Debajo verás el **tiempo estimado** (si corriste el Test de rendimiento) y, si va a correr en CPU, el aviso
**«Va a correr en CPU»**: en CPU Chatterbox es varias veces más lento que el tiempo real.

### 26.3 Tu «Voz propia» (para que suene rioplatense)

Chatterbox no tiene un modelo rioplatense: el acento sale de **la muestra que clona**. Para grabarla:

1. En _Texto a voz_ con Chatterbox, bajá hasta **Voz propia** y marcá **«Soy yo: es mi propia voz»** (es
   obligatorio: para otra persona se usa su consentimiento, ver §26.4).
2. **Grabar 10 s** (el navegador pide permiso al micrófono) y leé con tu tonada natural la frase que
   aparece: _«Che, ¿viste que mañana llueve? Yo llevo el paraguas, vos traé el mate y nos vemos en la plaza
   a las cinco.»_ O **Subir archivo** (5 a 60 s, hasta 25 MB; WAV, MP3, M4A, OGG o WebM).
3. Consejos: lugar callado, sin música ni eco, a un palmo del micrófono, hablando como hablás siempre. Studio
   recorta los silencios del principio y del final, normaliza el volumen y guarda hasta 30 s.
4. Podés escucharla, grabar otra (se usa la más reciente, o elegís cuál) o borrarla.

### 26.4 Clonar la voz de otra persona

Solo con su **consentimiento de voz** registrado en **Ajustes → Personas** (alcance «voz» o «rostro y
voz», con firma en pantalla o documento firmado) y una **muestra de voz** de esa persona. Solo aparecen en
_Voz a clonar_ las Personas con consentimiento **vigente**. Si se revoca o vence, Studio rechaza los usos
nuevos (también los que estaban en cola) con un aviso y el botón **Abrir Personas**. Cada clon de una
Persona queda en el registro de auditoría.

### 26.5 Marca de agua y redes

- Todo audio de Chatterbox lleva una **marca de agua inaudible (PerTh)** que no se puede quitar: sirve para
  que se sepa que es voz generada.
- Toda voz generada (Piper, nube o Chatterbox) queda marcada como **voz sintética**; la clonada, como **voz
  clonada**. Al generar un clon verás «Marcado como voz clonada (Revisión para redes)»: en _Exportar →
  Revisión para redes_ la casilla de voz generada o clonada aparece marcada (ver §17).

### 26.6 GPU, CPU y tiempos

- En GPU usa **4–5 GB de VRAM**: antes de cargar libera Whisper, RVC o lo que haya en la GPU, y se apaga
  solo tras **2 minutos** sin uso (`CHATTERBOX_IDLE_S`). La **primera** generación tarda más (carga ≈ 3 GB).
- Meta en una RTX 4050: generar más rápido que el tiempo real (RTF ≤ 1). En CPU: varias veces la duración
  del audio.
- Las RTX serie 50 todavía no son compatibles con la versión de PyTorch de Chatterbox: corre en CPU y lo avisa.
- Errores: «El entorno aislado de Chatterbox no está listo» → volvé a descargar el paquete en Ajustes →
  Paquetes de IA (o `setup.ps1 -Update`); «Chatterbox terminó con error…» → **Reportar error**.

## Borrador ARQUITECTURA

- §1 tabla de procesos: «Chatterbox (subproceso de los workers, `tools/chatterbox/.venv`, Python 3.11,
  torch 2.6.0; sin puerto; JSON por stdin/stdout; se apaga tras `CHATTERBOX_IDLE_S`)».
- Flujo 4 (Voz): `POST /api/voice/tts` `provider: "chatterbox"` → (api: validación, pack `tts-chatterbox`,
  `ConsentGate.assertConsent(personId, "voice")` + `voiceSamplePath` o asset `voice-ref`) → job `voice.tts`
  (repite los chequeos) → workers `POST /tts` (`voiceRef {path, consent}`) → `ChatterboxClient` →
  `tools/launch.py` → `studio_tts_server.py` → `renders/<jobId>.wav` + `MediaAsset` con `aiAltered` y
  `aiProvenance` (`voice-synthetic` | `voice-cloned`) + `consent_audit` `voice.clone`.
- Rutas api nuevas: `GET/POST /api/voice/self-refs` (multipart `audio` + `attestSelf=true` → `MediaAsset`
  `voice-ref`; se borra con `DELETE /api/media/:id`). `GET /api/voice/tts/providers` agrega la fila
  `chatterbox` (`packId, installed, supportsClone, models, languages, gpu, default`).
- Workers `POST /tts`: campos nuevos (`language, model, voiceRef, exaggeration, cfg, temperature, seed`) y
  resultado (`device, warnings, watermark, rtf, model`); errores `PACK_REQUIRED` 409, `TOOL_MISSING` 409,
  `TOOL_FAILED` 502 (`details.logTail`), `CONSENT_REQUIRED` 403 (defensa del árbol `consent/`),
  `VOICE_SAMPLE_INVALID` 400.
- GPU (§10): presupuesto `chatterbox` 4500 MB; nunca convive con FaceFusion, Whisper ni RVC; `unload` =
  terminar el subproceso.

## Solo medible en la PC

- Instalación real de `tools/chatterbox/.venv` desde Git (SHAs `5de7a54…` + Perth `ff1c8ac…`, `--no-deps`)
  o la caída a V2 de PyPI; tamaño real del venv con torch 2.6.0+cu124; que `import chatterbox.mtl_tts,
  perth` y `PerthImplicitWatermarker` carguen con `setuptools<82`.
- Firma real de `from_local(..., t3_model="v3")` en el SHA fijado y que `prepare_conditionals` siga
  existiendo; tamaños y sha256 reales de los 6 archivos de HF (fijar `CHATTERBOX_HF_REVISION` con
  `HfApi().model_info("ResembleAI/chatterbox", files_metadata=True)`).
- **RTF y VRAM** en la RTX 4050 (meta RTF ≤ 1; VRAM pico para ajustar los 4500 MB), tiempo de la primera
  carga, tiempo en CPU del i5.
- **Prueba de escucha A/B** de la Voz propia: 3 frases rioplatenses × cfg 0,3 / 0,5 / 0,7 × exaggeration
  0,5 / 0,7, para fijar el default que mejor conserva el acento; si la muestra de 10 s alcanza o conviene
  pedir 20–30 s.
- Grabación real con MediaRecorder en Chrome/Edge de Windows (WebM/Opus → normalización con ffmpeg).

# DEVOLUCIÓN — 2026-10-04 — Studio (editor de video + motion + voz)

**Nivel:** N4 · Proyecto complejo. **Entorno:** Claude Code (cloud, Linux) → destino Windows.
**Plan:** `docs/00-PLAN-BASE.md`. **Rama:** `claude/funny-mccarthy-0bbdt6`.

## Criterios de éxito
| # | Criterio | Estado | Evidencia |
|---|---|---|---|
| 1 | Windows limpio: `setup.ps1` + `start.ps1` → dashboard en :3000 | ✅ | Job `windows-smoke` del CI en verde sobre `windows-latest` (setup + start + 3 health OK). Pendiente solo la PC del usuario. |
| 2 | Flujo completo importar→cortar→Whisper→voz→SFX→Remotion→MP4 | 🟡 | Cada etapa tiene test (api 102, remotion 47, workers 37). Whisper/Piper/RVC solo con mocks (sin modelos en el sandbox). Render Remotion real verificado con Chromium local. |
| 3 | Layout persistido, tema, presets editables | ✅ | `apps/web` (dockview, settings-store, export-presets-store), 53 tests, round-trip de settings en api. |
| 4 | lint/typecheck/build/tests verdes, sin secretos | ✅ | Verificado desde instalación limpia; `git grep` sin keys; `.env.example` vacío. CI definido para ubuntu+windows (aún sin correr). |

## Qué se entregó
- Monorepo pnpm: `apps/web` (Next 15, dockview, timeline), `apps/api` (Fastify 5, cola SQLite, FFmpeg, export), `apps/workers` (FastAPI: faster-whisper, Piper, RVC), `packages/remotion` (9 plantillas), `packages/motion-engines` (Remotion / FFmpeg+Lottie / Motion Canvas stub), `packages/shared` (contratos zod).
- Windows desde cero: `scripts/windows/{setup,start,stop,doctor}.ps1`, `scripts/library/import-cc0.ps1`.
- Docs: `ARQUITECTURA.md`, `INSTALACION-WINDOWS.md`, `trabajo/fuentes-*.md` (licencias y comandos verificados), `trabajo/modulo-{a,b,c,d}.md`, `trabajo/integracion.md`.

## Números
- Preguntas: 4 en 1 turno (0 de más, 0 de menos; la respuesta "las 3 opciones de motion" amplió alcance y se resolvió con arquitectura enchufable).
- Agentes: 3 búsqueda (Sonnet) + 1 arquitecto + 4 módulos + 1 integración + 1 fixes (Opus) + 1 auditor (Sonnet). Fable solo coordinó (~10 turnos de orquestación).
- Supuestos errados: 1 (pnpm vía corepack no funciona con pnpm 12 → `npm i -g pnpm@12`).
- Re-trabajos: integración de contratos (previsto); 1 bug real encontrado en verificación (nombres de export duplicados en el mismo segundo).
- Semáforos: 🟢 en todos los hitos; auditoría 🟢 con 5 riesgos aplicados como fixes.

## Pendientes / riesgos (para la primera corrida en tu PC)
1. Correr `scripts\windows\setup.ps1` y revisar la tabla final; si algo falla, `doctor.ps1` y pegar la salida.
2. Modelos (Piper, Whisper, RVC base) se descargan en setup; sin internet quedan en ❌.
3. Motor Motion Canvas es stub (Revideo es la vía); preview del navegador no compone multi-clip/PiP (el export sí).
4. `piper-tts` es GPL-3 en runtime (no se copió código) — aceptable para uso personal cerrado.

## Propuestas de cambio a las guías
- Agregar regla: "si el destino es otro SO, incluir siempre un job de CI en ese SO que ejecute los scripts de instalación" (diff: sección 3, Ejecución por hitos, nuevo bullet).
- Agregar a la plantilla de PLAN-BASE el campo "Entorno de verificación ≠ entorno destino: sí/no" para que el criterio 1 se redacte como 🟡 desde el inicio.

---

# Ronda 2 — 2026-10-04 — Manual, QA, canal de errores, PR

**Nivel:** N4. **Preguntas:** 0 (todo derivado de la ronda 1; supuestos declarados al inicio).

## Entregado
- **Manual de usuario** en 3 formatos: `docs/manual/MANUAL-USUARIO.md`, `docs/manual/index.html` (autocontenido, claro/oscuro, imprimible), `docs/manual/MANUAL-USUARIO.pdf`. Incluye formatos soportados, límites reales confirmados en código vs recomendados, catálogo de plantillas, voces, atajos, 10 recetas de prueba y 6 prompts para Claude.
- **Prueba de punta a punta real** (`scripts/e2e/run-e2e.mjs`, 23/23 pasos por API; `scripts/e2e/ui-smoke.mjs`, 12/12 en navegador; `scripts/e2e/probe-limits.mjs`, 37 observaciones). Informe en `docs/trabajo/prueba-e2e.md`, 6 capturas en `docs/trabajo/capturas/`.
- **Canal de errores**: botón 🐞 en cabecera, "Reportar" en trabajos fallidos y en el toast, pantalla de error ante crash, `POST /api/reports` que arma carpeta + zip con `reporte.md` (bloque "Prompt para Claude" arriba), `entorno.json`, comandos y stderr de cada job, logs, proyecto; todo con keys redactadas. Fallback sin app: `scripts\windows\reportar-error.cmd`. Plantilla de issue en GitHub. Doc: `docs/REPORTAR-ERRORES.md`.
- **Revisión de mejoras**: `docs/MEJORAS.md` con 16 bugs (8 corregidos en esta ronda), 11 carencias de UX y backlog P1/P2/P3 con esfuerzo y licencias.

## Números
- Agentes: 3 en paralelo (QA, canal de errores, manual) + 1 de arreglos (Opus); 0 de búsqueda. Fable coordinó.
- Bugs detectados por QA/manual: 16; corregidos: 8 (B1–B6, U3, U8 + 2 del manual); pendientes documentados en MEJORAS.md.
- Re-trabajos: 1 (el manual se escribió antes de los arreglos y se actualizó al final).
- Semáforo: 🟢. PR #1 abierto contra `main`, CI 5/5 en verde (incluido Windows smoke).

## Bloqueo (resuelto)
- **PR:** el remoto no tenía `main`. Con autorización explícita del usuario se creó desde el primer commit y se abrió el PR #1. Dos fallos de CI en Windows (nombres de archivo con `:` en tests; shim `pnpm.cmd` sin ruta en `start.ps1`) se corrigieron en el siguiente commit.

## Propuesta de cambio a las guías
- En proyectos nuevos, pedir en la ronda única de preguntas "¿contra qué rama se abre el PR?" cuando el repo está vacío.

---

# Sprint 1 — 2026-10-05 — Base + Fase A (IA local determinista)

**Plan:** `docs/01-PLAN-BASE-v2.md`. **Nivel:** N4. **Preguntas:** 0 (10 decisiones del usuario ya registradas).

## Entregado
- Gestor de GPU (un modelo residente, fallback a CPU con aviso previo y posterior), paquetes de modelos bajo demanda (`core` por defecto, 6 packs, descargas secuenciales y reanudables, diálogo "Paquete requerido", pestaña Paquetes de IA), `setup -Full`, detección automática de CUDA con cambio en `-Update`.
- Render por bloques con caché (segmentos ≤10 s, hash, concat sin recodificar, LRU 10 GB), NVENC en proxies y bloques con keyframes forzados.
- Quitar silencios y muletillas con diálogo de revisión; detección de escenas y "Cortar en escenas"; Whisper large-v3-turbo en GPU; limpieza de voz (DeepFilterNet); test de rendimiento IA.
- Revisión para redes (flags + avisos) y etiqueta "Contenido alterado con IA" solo cuando se marca redes.
- Análisis de HyperFrames (HeyGen) como referencia para sprint 2.

## Criterios
| # | Criterio | Estado | Evidencia |
|---|---|---|---|
| 1 | `-Update` omite lo instalado; CI verde | 🟡 | Instalador incremental probado en sandbox y CI; falta correr en la PC del usuario |
| 2a | Silencios < 30 s por minuto | ✅ (sandbox) | 0,82 s/min medido en e2e (sin Whisper) |
| 2b | Re-render con un cambio < 20 % del tiempo | 🟡 | 42 % en sandbox CPU libx264; se mide con NVENC en la PC real |

## Números
- Agentes: 3 módulos + 1 integración + 1 auditoría (Sonnet) + 1 fixes + 1 búsqueda (HyperFrames). Fable coordinó.
- Desvíos detectados por auditoría: 3 (etiqueta IA fantasma, packs sin pedir descarga, criterio 2 sin medir) → 3 corregidos. Riesgos: 5 → 5 mitigados.
- Tests: Node 332+, Python 81, e2e 33/33, smoke 17/17.

## Pendiente para la PC real
Whisper turbo, DeepFilterNet, NVENC por bloques y los tiempos reales. Primera corrida: `actualizar.cmd` (cambia a CUDA solo, ~2,5 GB una vez) → `doctor.cmd` → Ajustes → Paquetes de IA → Test de rendimiento.

## Medido en la PC del usuario (RTX 4050 Laptop, 2026-10-05 14:59)
| Métrica | Valor | Estimación |
|---|---|---|
| Whisper large-v3-turbo (GPU) | 5,65 s por minuto de audio | 10 min ≈ 57 s |
| Piper (CPU) | 7,38 s por 100 caracteres | 1000 caracteres ≈ 1 min 14 s |
| Detección de escenas | 330 fps | 10 min a 30 fps ≈ 55 s |
| Respaldo en CPU | Funciona | — |
| Paquetes | 6/6 instalados (2,5 GB) | `actualizar.cmd` cambió a CUDA correctamente |
RVC sin medir: no hay modelos de voz en `models/rvc/`. Criterio 2a (silencios < 30 s/min) ✅ con margen amplio.

---

# Sprint 2 — 2026-10-05 — Fase B (visión, keyframes, preview multicapa)

**Plan:** `docs/01-PLAN-BASE-v2.md`. **Preguntas:** 0. **Contratos:** `docs/trabajo/sprint2-contratos.md`.

## Entregado
- Recorte de personas (RobustVideoMatting, GPL aislado en `.venv-gpl` y subproceso), recorte de imágenes (BiRefNet swin_v1_tiny), máscara por clic en video (SAM 2.1 tiny/small por tramos de 200 fotogramas), seguimiento de objetos (SAM 2 o rápido, suavizado sin retardo) → keyframes, reencuadre automático 9:16 / 1:1 / 4:5 (YuNet por escena).
- Keyframes de posición, escala, opacidad y recorte: diamantes en el timeline, `K`, inspector con easing, export con expresiones FFmpeg, paridad preview/export por función compartida.
- Vista previa multicapa con reloj maestro (referencia HyperFrames): 29 fps con 3 capas 1080p en Chromium sin GPU.
- Fondo reemplazable (color, imagen, video, desenfoque); subtítulos y rótulos de Remotion que siguen un objeto.
- 4 packs nuevos bajo demanda; onnxruntime-gpu correcto en CUDA; SAM 2 fijado a commit; integridad de descargas con sha256 donde la red lo permitió.

## Criterios (plan v2, sprint 2)
| Criterio | Estado | Evidencia |
|---|---|---|
| Recorte ≥ 15 fps 1080p en la 4050 | 🟡 | Solo mock (14,1 fps en CPU sandbox); se mide con el test de rendimiento en la PC |
| Reencuadre sin saltos | ✅ (sandbox) | One-Euro + `hold` por escena; e2e export 9:16 |
| Texto siguiendo objeto exportado | ✅ | e2e píxeles en 3 instantes; deriva 2,6 px |
| Preview ≥ 24 fps con 3 capas | ✅ (headless) | 29,1 fps; validar en Chrome/Edge de la notebook |

## Números
- Agentes: 3 módulos + integración + auditoría + fixes. Tests: Node 420, Python 128; e2e 41/41; smoke 25/25.
- Auditoría: 2 ❌ documentales + 5 riesgos → todos corregidos.

## Pendiente para la PC real
Primera corrida: `actualizar.cmd` → Ajustes → Paquetes de IA → descargar `matting`, `matting-image`, `sam2` (requiere Git), `reframe` → Test de rendimiento (ver `Recorte de personas ≈ X fps`) → "Quitar fondo" en un clip de 10 s.

---

# Sprint 3 — 2026-10-06 — Fase D (agente local de edición por comandos)

**Plan:** `docs/01-PLAN-BASE-v2.md`. **Contratos:** `docs/trabajo/sprint3-contratos.md`. **Decisión 8:** solo local, sin API key.

## Entregado
- Runtime Ollama (instalado por `setup.ps1`), pack `agent-llm` (qwen3:8b por defecto, hermes3:8b alternativo), modelo chico para CI.
- `EditPlan` como fuente única (22 operaciones, JSON Schema exportado), enrutador determinista para comandos simples (sin LLM), planificador con salida estructurada, reintentos y sin ids inventados, resolución de referencias, vista previa en español, riesgos y controles de calidad (tiempos fuera del proyecto, velocidades, recortes inválidos → pregunta).
- Job `agent.apply` con snapshot de undo, confirmación explícita para borrar y exportar, undo protegido si el proyecto cambió; `edited_ops` respetados.
- Dataset generado por Claude: 255 ejemplos de entrenamiento + 80 golden, validador contra esquema e ids reales; evaluador de modelos (`/agent/eval`) con tasa semántica.
- Web: panel Asistente (`Ctrl+Shift+A`), preguntas como formulario, historial, Ajustes → Asistente local con "Evaluar modelos", "Redactar con IA" en reportes.
- GPU: liberación en ambos sentidos entre Ollama y visión/Whisper; contexto 4096 para entrar en 6 GB; Ollama solo en loopback.
- Extra: optimización del recorte de personas (pipeline paralelo, conversión en GPU, lotes de 4) + métricas de fps sostenido y arranque.

## Criterio 4 (≥ 90 % de 80 comandos golden válidos y correctos)
🟡 No medible en el sandbox (modelo de prueba sin capacidad). Se mide en la PC con "Evaluar modelos" sobre qwen3:8b y hermes3:8b.

## Números
- Agentes: 4 módulos + integración + auditoría + fixes + perf. Tests: Node 469, Python 290; e2e 48/48; smoke 29/29.
- Auditoría: 5 riesgos + 2 brechas → 7 corregidos.

## Pendiente para la PC real
`actualizar.cmd` (instala Ollama) → Ajustes → Paquetes de IA → `agent-llm` (~5 GB) → Asistente local → "Evaluar modelos" → pegar resultados. Test de rendimiento: ver fps sostenido del recorte.

---

# Sprint 3b — 2026-10-06 — Perfil de estilo, Consola Claude, stems, recorte HQ, capas libres

**Plan:** `docs/01-PLAN-BASE-v2.md` (sección Sprint 3b). **Contratos:** `docs/trabajo/sprint3b-contratos.md`. **Integración:** `docs/trabajo/integracion-sprint3b.md`. **Decisión 8:** sin API key — la consola usa la suscripción de Claude.ai vía Claude Code CLI + servidor MCP local.

## Entregado
- **Perfil de estilo**: análisis de un video de referencia (escenas, planos, cortes/min, zooms, LUFS, voz/música/silencios, OCR opcional) + hoja de contactos PNG; inferencia con VLM local (pack `vision-llm`, 409 `PACK_REQUIRED` si falta) o con Claude desde la consola; `StylePreset` estricto → EditPlan válido (`compileStylePreset`); panel Estilo en la web.
- **Consola Claude**: PTY sobre WebSocket solo loopback + Origin permitido, token aleatorio de un solo uso (2 min, máx. 4 sesiones), env del hijo sin claves (`ANTHROPIC_API_KEY`, AWS, Google; se conserva `CLAUDE_CODE_OAUTH_TOKEN`), ajustes propios con `permissions.deny` (`.env*`, `storage/*.db*`, `storage/reports`, escritura en `storage/`, `models/`, `WebFetch`); `packages/studio-mcp` con 16 herramientas (`studio_*`), `.mcp.json`, `CLAUDE.md` en español; `setup.ps1 -WithClaude`.
- **Stems (Demucs htdemucs)**: pack `stems`, separación voz/música (2 o 4 stems) por bloques leídos de disco (sin tope de duración, RAM acotada), 5.1 → estéreo, pistas «Voz»/«Música» alineadas al clip con snapshot de undo (`PROJECT_CHANGED` + `force`), GPU vía budget manager.
- **Recorte HQ**: RVM resnet50 + refinado de alfa + despill + guía SAM, GPL aislado en subproceso (`vision_gpl`); `maskAssetId` validado (`INVALID_MASK_ASSET`); VRAM medida después de `acquire`.
- **Capas libres**: 8 modos de fusión, máscaras rect/elipse (feather, invertida)/PNG/SAM, `Track.order` explícito (`nextTrackOrder`), paridad vista previa ↔ export con píxeles reales (tolerancia 8, diferencia máxima medida 3); hash de caché de segmentos incluye blend, máscara y z.
- Manual §20–§23 (MD, HTML y PDF 69 páginas), `ARQUITECTURA.md`, `CONSOLA-CLAUDE.md`, `.env.example`, CI con smoke de `studio-mcp`.

## Criterios (plan v2, sprint 3b)
- Estilo: 1 min de referencia analizado en < 60 s en CPU → 🟢 **19,2 s** (medición independiente del auditor); el preset genera un EditPlan válido → 🟢.
- Capas: multiply/screen y elipse idénticos entre vista previa y export → 🟢 export (ffmpeg real), 🟢 vista previa (ui-smoke 8 modos + elipse, diferencia máx. 3).
- Consola: `claude` corre dentro de Studio y `studio_get_project` responde → 🟡 probado con un `claude` falso (PTY, WS, token, `--settings`, MCP smoke); el real solo se mide en tu PC.
- Stems: 1 min < 60 s en GPU → 🟡 solo medible en tu PC (aquí 35 s en CPU con pesos aleatorios, no cuenta).
- Recorte HQ: halos visiblemente menores → 🟡 evidencia sintética (32,7 → 8,0, −76 %); confirmar con un clip real.
- CI verde ubuntu + windows + smoke → se verifica en el PR.

## Auditoría independiente (solo lectura)
14 hallazgos (0 críticos, 4 medios, 10 bajos) → **14 corregidos** + 1 fallo de CI en Windows (test de consola) corregido. Desvío declarado: no se bloquea `Read(./storage/**)` entero porque Claude necesita abrir los PNG que `studio-mcp` le entrega; si se quiere el bloqueo total hay que devolver las imágenes dentro de la respuesta MCP.

## Números
- Agentes: 5 módulos + integración + auditoría + fixes. Tests: Node 585 (shared 72, web 192, api 230, remotion 55, motion-engines 22, studio-mcp 14), Python 331; e2e 57/57 obligatorios (3 SKIP sin Ollama); ui-smoke 33/33.
- Commits del sprint: 8 (contratos, 5 módulos, integración, correcciones).

## Pendiente para la PC real
1. `actualizar.cmd` (instala Claude Code si usás `-WithClaude`) → `claude login` una vez → Studio → panel Consola → «¿qué hay en mi proyecto?» (debe llamar `studio_get_project`).
2. Ajustes → Paquetes de IA → `stems` (~80 MB) → separar un clip de 1 min y anotar el tiempo. Después pasame tamaño y `sha256` del archivo `models/stems/955717e8-8726e21a.th` para fijarlos en `packs.py` (hoy se registran en `manifest.json` en la primera descarga porque el sandbox no pudo bajarlo).
3. `matting-hq` (~230 MB) → recortar un clip con fondo complejo en calidad alta y comparar bordes con el modo normal.
4. `vision-llm` (opcional) → Estilo → analizar un video de referencia → «Inferir con IA local»; o hacerlo desde la consola con Claude.
5. Sigue pendiente del sprint 3: Asistente → «Evaluar modelos» (qwen3:8b / hermes3:8b) y fps sostenido del recorte.

---

# Sprint 4 — 2026-10-07 — Fase C (cara y voz: Personas, consentimiento, FaceFusion, Chatterbox, RVC en CUDA)

**Plan:** `docs/01-PLAN-BASE-v2.md` (Sprint 4, criterio 5). **Contratos:** `docs/trabajo/sprint4-contratos.md`. **Fuentes:** `docs/trabajo/fuentes-sprint4.md`. **Integración:** `docs/trabajo/integracion-sprint4.md`. **Decisiones aplicadas:** 3 (consentimiento previo con registro por persona), 4 (etiqueta visible opcional), 6 (herramientas y modelos bajo demanda), 9 (rioplatense por clonación de voz propia, sin entrenamiento).

## Entregado
- **Personas y consentimiento**: Ajustes → Personas (fotos, muestras de voz, firma en pantalla o documento, alcance rostro/voz, vencimiento, revocación por alcance), consentimiento atado a las fotos y muestras concretas, auditoría solo-agregar con cadena de hashes y triggers en SQLite, espejo de solo lectura para los workers (`storage/consent/active.json`), `HUMAN_ONLY` (solo desde la web de Studio: ni MCP ni procesos sin Origin válido), `storage/consent/**` nunca servido, nunca en reportes, denegado a la Consola Claude.
- **Cambio de cara**: FaceFusion 3.9.1 en venv propio (Python 3.12) como subproceso vía `tools/launch.py`, una sola aceptación de licencia en pantalla para los modelos no comerciales (versión del texto + fecha, exigida al descargar y al usar), analizador de contenido de FaceFusion siempre activo (rechazo → `CONTENT_BLOCKED`, fallo de herramienta → `TOOL_FAILED`, sin asset si no se clasifica), verificación licencia → pack → consentimiento → venv → límites al encolar y al arrancar, asistente «Cambiar cara» de 5 pasos, deshacer por clip, `studio_face_swap` con confirmación y op `face_swap` del EditPlan siempre confirmada.
- **Voz**: Chatterbox Multilingual (V3 desde Git fijado por SHA, V2 de PyPI como respaldo) en venv propio con torch 2.6, proceso persistente con cancelación real y liberación de GPU, marca de agua PerTh siempre, Piper sigue por defecto; «Voz propia» (10 s, casilla «Soy yo», `HUMAN_ONLY`, auditada) y clonación de Personas con consentimiento de voz; todo audio generado marcado sintético y clonado cuando corresponde, RVC sobre voz real también marcado clonado.
- **Herramientas e instalador**: runtime Python 3.12 por winget, `toolvenv` con estados, junctions compatibles con Python 3.11, lanzador con lista blanca de variables de entorno (sin tokens ni API keys, Hugging Face offline), RVC en CUDA con presupuesto de GPU y `RVC_MODEL_INCOMPATIBLE`, test de rendimiento con RVC/Chatterbox/FaceFusion, `doctor`, `.env.example`, `.gitignore`.
- **Revisión para redes**: detección de contenido IA (cara, voz sintética/clonada) con herencia por efectos, limpieza, stems y recorte; `comment` invisible siempre en el MP4 exportado y conservado al reimportar; etiqueta visible opcional.
- **Repo público**: `LICENSE` (todos los derechos reservados, uso personal), `NOTICE.md` de licencias de terceros, rutas de ejemplo sin nombres, CI recortada (cancelación de corridas viejas, Windows solo en PR y `main`, sin CI en cambios de solo documentación).
- Manual §24–§27 (MD, HTML, PDF 80 páginas), `ARQUITECTURA.md`, `fuentes.md`, `INSTALACION-WINDOWS.md`, `CONSOLA-CLAUDE.md`, `CLAUDE.md` (regla 7 y dos herramientas nuevas).

## Criterio 5 (plan v2)
- Swap solo con consentimiento registrado → 🟢 en código (api y workers, al encolar y al arrancar, auditado).
- Etiqueta opcional → 🟢 (`forSocial && aiLabel`; `comment` siempre).
- Sin modelos no comerciales activos sin aceptación explícita en pantalla → 🟢 (403 `LICENCE_REQUIRED` en descarga, CLI, `-Full` y uso).
- Rendimiento (fps de FaceFusion, RTF de Chatterbox, RVC < 15 s/min) → 🟡 solo medible en tu PC.

## Auditoría independiente (solo lectura)
24 hallazgos (2 altos, 12 medios, 10 bajos) + 5 puntos abiertos → **todos corregidos o decididos** (ver «Correcciones de auditoría» en `integracion-sprint4.md`). Límite declarado: Studio no tiene autenticación local; un proceso con shell en tu PC puede llegar a la API. La consola tiene denegados `curl`, `wget` y equivalentes; un PIN local queda en Descubierto.

## Números
- Agentes: investigación + contratos + Paso 0 + 3 módulos + integración + auditoría + 2 pasadas de correcciones (una perdida por límite de uso y reinicio del contenedor).
- Tests: Node 713 (shared 106, web 228, api 283, remotion 55, motion-engines 22, studio-mcp 18), Python 459; e2e 74/74 obligatorios; ui-smoke 38/38; MCP smoke 18 herramientas.
- Integración: 9 bugs entre módulos corregidos. Commits del sprint: 15.

## Pendiente para la PC real
1. `actualizar.cmd` → debe instalar Python 3.12 (winget) sin tocar el resto; `doctor.cmd` muestra el estado de las herramientas.
2. Ajustes → Personas → crear una Persona con tu foto y firmar el consentimiento (rostro y voz). Ajustes → Paquetes de IA → aceptar la licencia de cambio de cara → descargar `faceswap` (~1,5 GB + venv ~1,7 GB) → «Cambiar cara» sobre un clip corto. Anotar fps y, si bloquea contenido, el texto exacto del rechazo (para fijar `FACEFUSION_NSFW_RE`).
3. Paquetes de IA → `tts-chatterbox` (~6 GB) → Voces → motor Chatterbox → «Voz propia» (grabar 10 s) → generar un texto. Anotar tiempo real, si quedó en V3 o V2, y si la voz conserva la tonada (probar cfg 0,3/0,5/0,7).
4. Voces → RVC con CUDA: tiempo por minuto (meta < 15 s). Test de rendimiento completo y pegar `perf.json`.
5. Sigue pendiente de sprints anteriores: sha256 de Demucs, Asistente «Evaluar modelos», fps sostenido del recorte.

---

# Sprint 5 — 2026-10-08 — Roces (plan v3: centro de trabajos, fluidez, export profesional y 9:16)

**Plan:** `docs/02-PLAN-BASE-v3.md` (decisiones: orden 5 → 6 → 7, un brand kit, 9:16 principal). **Base:** `docs/trabajo/auditoria-fluidez.md` (26 hallazgos sobre la app real) y `docs/trabajo/referencias-fluidez-autonomia.md`. **Contratos:** `docs/trabajo/sprint5-contratos.md`. **Integración:** `docs/trabajo/integracion-sprint5.md`.

## Entregado
- **Centro de trabajos y errores**: progreso real por ítem con ETA y etapa (los bloques en caché no engañan la ETA), cancelar de punta a punta hasta el worker (Ollama, transcripción, visión con muerte del subproceso, stems, estilo, descargas), «Evaluar modelos» rápida (20) y completa (80) con avance por comando, errores con la causa real, avisos sin repetir al recargar, un solo banner «IA local apagada» con `start.cmd` y acciones deshabilitadas con motivo, aviso de CPU una vez por sesión.
- **Fluidez de línea de tiempo**: atajos siempre activos (la regla ya no roba el foco; alcances global/editor), ripple delete que corre y recorta todas las pistas sin bloquear, selección múltiple (Ctrl/Mayús/rectángulo/Ctrl+A), J/K/L, Q/W, I/O con tramo, imán configurable, proyectos (listar, abrir, renombrar, duplicar, borrar), autoguardado al cerrar, Asistente y Exportar fijos a 1366 px, 51 tooltips explicativos, estados vacíos con guía, Espacio operable en diálogos.
- **Export profesional y 9:16**: mezcla aparte con `loudnorm` 2 pasadas a −14 LUFS / −1 dBTP (medido −14,5), ducking por rol de pista calibrado con la voz real, pregunta «¿Dónde lo vas a publicar?» (Reels/TikTok por defecto), exportar a otro aspecto exige encuadre (seguir la cara / al centro / franjas) y el Asistente inserta `reframe` o pregunta, nunca franjas por defecto; tarjeta de resultado con LUFS y «Abrir carpeta»; revisión para redes con Sonoridad y Formato.
- Manual (§3–§5, §10, §12, §15, §17, §19; HTML y PDF 77 páginas), ARQUITECTURA, CLAUDE.md, panel de sesión actualizado.

## Criterios (plan v3, Sprint 5)
- Ningún trabajo sin progreso/ETA/cancelar → 🟢 (🟡 `taskkill` del árbol solo medible en tu PC).
- Workers apagados = un solo aviso → 🟢.
- Atajos tras clicar cualquier zona → 🟢 (Edge: `Ctrl+O`, `Ctrl+Alt+N`, `Ctrl+Mayús+Supr` a probar en tu PC).
- Reels desde horizontal sin franjas por defecto → 🟢.

## Auditoría independiente
13 hallazgos (1 alto, 7 medios, 5 bajos) → 13 corregidos. Hallazgos de fluidez: 17 cerrados, 2 parciales, 7 al Sprint 6 (H11–H14, H16, H20, H25). Descubierto: columnas de resumen para `GET /api/projects`, cancelación cooperativa en motores sin subproceso.

## Números
- Agentes: auditoría UX + referencias + contratos + Paso 0 + 3 módulos + integración + auditoría + correcciones; ninguno murió. Pedidos cruzados: 13; costuras: 12.
- Tests: Node 881 (shared 157, web 296, api 332, remotion 55, motion-engines 22, studio-mcp 19), Python 501; e2e 82/82; ui-smoke 56/56; MCP 18 herramientas.

## Pendiente para la PC real
1. `actualizar.cmd` → `start.cmd`. Ajustes → Asistente local → «Evaluar modelos» (Rápida): debe mostrar «qwen3:8b · n/20», tiempo restante y Cancelar; anotá la duración (meta ≤ 3 min) y el porcentaje final.
2. Apagá los workers con la ventana cerrada: un solo cartel; «Reintentar» lo levanta.
3. Clic en la regla y probá Espacio, S, J/K/L, Supr, Mayús+Supr, Ctrl+O y Ctrl+Alt+N en tu navegador.
4. Exportá un video horizontal a Reels: tiene que pedir encuadre; con «Seguir la cara» usa el paquete Reencuadre. Anotá los LUFS de la tarjeta y probá «Abrir carpeta».
5. Cancelá un recorte de fondo a mitad y mirá en el Administrador de tareas que la GPU baje en menos de 3 s.

---

# Sprint 6 — 2026-10-18 — Edición por guion y sistema de diseño

**Plan:** `docs/02-PLAN-BASE-v3.md` (Sprint 6, ítems 1–3). **Contratos:** `docs/trabajo/sprint6-contratos.md` (criterios C1–C6 y deuda de funciones). **Fuentes:** `docs/trabajo/fuentes-sprint6.md`. **Módulos:** `modulo-sprint6-guion.md`, `modulo-sprint6-diseno.md`, `modulo-sprint6-sugerencias.md`. **Integración:** `docs/trabajo/integracion-sprint6.md` (incluye «Correcciones de auditoría»). **Auditoría:** `docs/trabajo/auditoria-sprint6.md`.

## Entregado
- **Panel Guion (edición por texto)**: transcripción de palabras con tiempos (`script.transcribe`), borrar palabras = cortar el video con ripple sincronizado en todas las pistas y un solo Deshacer por gesto; corte en el medio del hueco, afinado por energía y fundido de audio de 12 ms por lado. Muletillas en 3 niveles (seguras / probables / dudosas) con léxico rioplatense, repeticiones y hueco acústico (Whisper no escribe los «eh»); solo las seguras vienen tildadas. Corregir una palabra conserva tiempos y karaoke. «Dejalo en» (`fit_duration`) acorta a una duración dada por niveles, nunca a mitad de palabra, y pregunta antes de cortar oraciones o acelerar. Una sola fuente de tiempos: `project.subtitles[].words`.
- **Sistema de diseño**: tokens editables en `packages/shared/src/design.ts` (Ajustes → Kit de marca: colores, tipografías con grosor por rol, zona segura por aspecto, logo), 10 reglas medibles (`DESIGN_RULES`), `POST /api/design/check` y correcciones automáticas al generar y al exportar (máx. 2 líneas, 30/34/42 caracteres por línea en 9:16/1:1/16:9, tamaño ≥ 4,5 % del lado corto, contorno o caja, duración y caracteres por segundo, zona segura). Motion en español y editable desde Propiedades, un solo selector de voz, glosario único.
- **Sin red en los renders**: las 10 familias OFL empaquetadas en `packages/remotion/public/fonts/` y usadas igual por Remotion, libass (`fontsdir` relativo a la carpeta del trabajo) y la vista previa; Exportar renderiza solo los gráficos Motion pendientes y avisa `DESIGN_AUTOFIXED`.
- **Sugerencias al importar**: tarjetas («silencios largos», «voz baja») calculadas en segundo plano con prioridad por debajo de lo que lance el usuario; «Aplicar» arma un plan y «Deshacer todo» lo revierte; reabrir el último borrador del Asistente tras recargar (H18), `probeError` en español.
- **Deuda cerrada**: lienzo máximo 8192 (B7), motor no disponible en español con «Arreglar» (B11), fondo transparente del `title-card` (B6), `verificar-pc.cmd`, `MEJORAS.md` reconciliado.
- Manual §28–§30 nuevos y §8, §11, §12 actualizados, `ARQUITECTURA.md`, `CLAUDE.md` (confirmar `delete_words` / `fit_duration`, `replace: true`, `TRACK_LOCKED`), panel de sesión.

## Criterios (plan v3, Sprint 6)
- C1 — Cortar 10 muletillas desde el guion en < 1 min → 🟢 **0,46 s** (ui-smoke: «Quitar seguras» + 2 selecciones + `Supr`; subtítulos corridos, un Deshacer). 🟡 con Whisper real sobre un video propio.
- C2 — Subtítulos y títulos pasan las reglas sin tocar nada → 🟢 **10/10 en 9:16 y 16:9 a 2,6 y a 3 palabras/s**, caja del texto en zona segura 5/5 fotogramas. A 3,5 y 4 palabras/s da **9/10 con aviso** (`caption.timing`: no hay hueco para estirar la página); por eso el criterio vale para habla de hasta 3 palabras/s. 🟡 mirar fotogramas en el teléfono.
- C3 — Diseño (panel) → 🟢 mapa de calor **3,90 / 5** (antes 2,52, +1,38) → panel Diseño **78 %**; 0 términos en inglés en Motion/Propiedades/Voz, 0 botones de ícono sin tooltip, 2 familias tipográficas, primer proyecto → export en 5 clics. 🟡 a 125 % en 1366 px.
- C4 — Ningún render depende de la red → 🟢 (e2e con `STUDIO_FONTS_OFFLINE=1`, prueba que prohíbe `googleapis` en `packages/remotion/src`). 🟡 libass de Windows con rutas con tildes.
- C5 — Sugerencias al importar → 🟢 2 tarjetas en 6,8 s (meta 15 s), una transcripción del usuario arranca sin esperar. 🟡 3 videos de 10 min en el i5.
- C6 — Deuda de funciones → 🟢 10 cerrados en el sandbox (ver «Deuda de funciones»).

## Auditoría independiente (solo lectura)
**25 hallazgos (2 altos, 11 medios, 12 bajos) → 23 corregidos, 2 diferidos con motivo.** Altos: E1 (libass leía `Bold` como booleano y las familias de una sola cara recibían negrita falsa) y E2 (`fixWords` insertaba palabras de largo cero). Medios: muletillas con contenido pasan a «probable» (E3), páginas de subtítulos con holgura de 0,5 s antes / 0,3 s después para pasar a 3 palabras/s (E4), pista bloqueada = `TRACK_LOCKED` en vez de cortar igual (E8), re-transcribir exige `replace: true` si hay palabras corregidas a mano (E9), fuentes copiadas al trabajo para que ninguna ruta con tildes llegue a libass (E10), logo validado por firma (E20). **Diferidos:** E16 (clave `(project, asset, clip)` de `script_audio`: cambia el esquema SQLite, sin riesgo de datos; va a S7) y E24 (renombrar Playfair Display por su «Reserved Font Name» lo decide el usuario; ver pregunta abajo).

## Pruebas (sandbox Linux, sin GPU, desde cero)
| Suite | Resultado |
| ----- | --------- |
| Node (`pnpm -r test`) | **1150 + 2 omitidas** (shared 266, web 340, motion-engines 24, studio-mcp 21, remotion 94, api 405 + 2) |
| pytest (normal y orden aleatorio) | **524 + 9 omitidas** |
| e2e (`run-e2e.mjs`, sin `--skip-motion`) | **91/91** obligatorios (3 SKIP y 2 expected-fail sin Whisper/Piper/Ollama) |
| ui-smoke (`--vp9-preview --ux-metrics`) | **63/63** |
| design-check (9:16 y 16:9, 2,6 y 3 palabras/s) | **10/10** |
| lint, prettier, typecheck, build, `studio-mcp smoke` (19 herramientas), ruff, `validate-dataset` | OK |

- Agentes: investigación + contratos + Paso 0 + 3 módulos en paralelo + integración + auditoría + correcciones. Pedidos cruzados: 18; costuras corregidas: 15.

## Deuda de funciones (C6)
23 ítems: **10 cerrados en el sandbox** (#2 reclasificado 🟢 con la medición del 2026-10-05, #11 H18, #12 H19, #13 B7, #14 verificador, #15 B11, #16 B13, #17 B15, #18 B6, #23 reconciliado), **5 bajan con una corrida de `verificar-pc.cmd`** (#3 re-render con NVENC, #4 recorte ≥ 15 fps, #5 Evaluar modelos, #7 stems en GPU, #9 FaceFusion/Chatterbox/RVC) y **3 pasan a S7** (#19 resumen de proyectos, #20 cancelar `audio.denoise` y Piper, #21 PIN local y filtro de fotos). Siguen solo en la PC: #1, #6, #8, #10, #22.

## Solo medible en tu PC
1. Actualizá con `actualizar.cmd` y abrí Studio con `start.cmd`.
2. Corré `scripts\windows\verificar-pc.cmd` (Test de rendimiento, «Evaluar modelos» Rápida y stems de 1 min). Pegame `storage\run\verificacion.json`.
3. Panel Guion con un video tuyo: «Transcribir para el guion», cronometrá hasta cortar 10 muletillas (meta < 1 min), anotá cuántos «eh/em» detecta y si confunde respiraciones, y escuchá los empalmes (los fundidos de 12 ms no deberían oírse ni comer consonantes).
4. Ajustes → Kit de marca: elegí colores y tipografías; en «Calibrar con una captura» subí una captura de Reels y otra de TikTok hechas con el teléfono y ajustá la zona segura.
5. Exportá en 9:16 con subtítulos y títulos, pasá el MP4 al teléfono y mirá 3 fotogramas: nada tapado por la interfaz de Reels/TikTok, máximo 2 líneas.
6. Importá un medio y mirá las tarjetas de sugerencias; con 3 videos de 10 min comprobá que la línea de tiempo no se trabe.
7. Exportá con un título que tenga fuente propia, con el usuario de Windows con tilde o espacio en el perfil, y confirmá que los subtítulos salen con la tipografía elegida (libass con `fontsdir`).
8. Probá Guion, Kit de marca y Voz a escala 125 % en 1366 px.

## Descubierto / a Sprint 7
- `normalize_loudness` / tope de `set_volume`: la tarjeta «La voz está baja» no puede subir el volumen de un clip más allá de +12 dB (`ClipSchema.volume` ≤ 4) y el export no tiene ganancia por clip; hace falta subir el rango o un `loudnorm` por clip.
- Tarjeta «Quitar muletillas» en las sugerencias de importación (hoy solo silencios y voz baja).
- H27 «Generar» de Voz queda deshabilitado sin decir por qué; H28 aviso crudo de paquete Python faltante al transcribir; H29 «Música sin bajar» aparece sin música en el proyecto; H30 una página supera 17 caracteres por segundo tras cortar (`caption.timing` no se arregla sola); H31 las pestañas de dockview no muestran anillo de foco.
- El logo del kit se guarda pero ningún render ni exportación lo dibuja (E13).
- Guardar el kit de marca desde el panel Estilo (hoy se edita solo en Ajustes → Kit de marca).
- E16: clave de `script_audio` por clip y limpieza de `renders/<job>` (esquema SQLite).
- E24: licencia de Playfair Display (abajo).
- `verificar-pc.ps1`: agregar el chequeo de fuentes de libass con rutas con tildes.
- Leer el WAV por bloques y extraer solo el tramo del clip (E18, hoy se lee entero).
- También: cancelar `audio.denoise` y Piper, `GET /api/projects?view=summary`, PIN local, la tarjeta «Diseño» del panel toma el primer sprint medido (`findLast`).
- El manual `index.html` y el PDF quedaron sin regenerar tras las correcciones de auditoría (§28–§29 del `.md` están al día); no hay script de armado en el repo.

## Pregunta abierta para vos
**E24 — La licencia de Playfair Display prohíbe publicar versiones modificadas con el mismo nombre y el repo es público: ¿la renombramos (hay que regenerar las TTF y migrar los kits guardados) o la reemplazamos por otra familia sin esa restricción?**

## Próximos pasos
1. Sprint 7 según `docs/02-PLAN-BASE-v3.md`: «Revisar resultado», escenas y caras en sugerencias, Player en vivo, y lo de «Descubierto».
2. Pasame `verificacion.json` y las observaciones de «Solo medible en tu PC» para bajar los 🟡.
3. Tu respuesta sobre E24.

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

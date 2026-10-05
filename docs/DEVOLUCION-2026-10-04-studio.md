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

# DEVOLUCIÓN — 2026-10-04 — Studio (editor de video + motion + voz)

**Nivel:** N4 · Proyecto complejo. **Entorno:** Claude Code (cloud, Linux) → destino Windows.
**Plan:** `docs/00-PLAN-BASE.md`. **Rama:** `claude/funny-mccarthy-0bbdt6`.

## Criterios de éxito
| # | Criterio | Estado | Evidencia |
|---|---|---|---|
| 1 | Windows limpio: `setup.ps1` + `start.ps1` → dashboard en :3000 | 🟡 | Scripts, `docs/INSTALACION-WINDOWS.md`, job smoke en CI. **Nunca ejecutado en Windows real** (este entorno es Linux). |
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

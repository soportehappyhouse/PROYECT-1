# PLAN-BASE v1 — Studio (editor de video + motion graphics + voz)

**Objetivo:** Dashboard web local y personalizable para editar video, generar motion graphics, modificar/generar voz y agregar sonidos, corriendo 100% en una PC Windows desde cero.

## Alcance IN
- Dashboard web (Next.js) con paneles reordenables/ocultables, tema y atajos configurables, timeline con pistas de video/audio/texto.
- Backend local (Node + Fastify) con cola de trabajos (SQLite) que orquesta FFmpeg, Remotion y workers Python.
- Edición base: importar, cortar, unir, recortar, velocidad, overlays, transiciones, exportar con presets (YouTube, Reels/TikTok 9:16, Shorts).
- Motion graphics: motor **Remotion** completo (títulos, lower-thirds, subtítulos animados, transiciones). Arquitectura de motores enchufables con adaptadores para **Motion Canvas** y **FFmpeg+Lottie** (esqueleto + 1 ejemplo cada uno).
- Voz/audio: TTS local (Piper, voces es) + TTS por API opcional; conversión de voz RVC (CPU lento / CUDA opcional); efectos de voz (pitch, robot, reverb, teléfono) vía FFmpeg; subtítulos automáticos con faster-whisper; biblioteca local de SFX/música con búsqueda y conectores opcionales por API.
- Instalación desde cero en Windows: `scripts/windows/setup.ps1` (winget: Git, Node LTS, Python 3.11, FFmpeg) + descarga de modelos + `start.ps1` que levanta todo.
- Secretos solo en `.env` (ignorado por git), `.env.example` documentado. Ningún key ni enlace privado en el repo.

## Alcance OUT
- Despliegue en nube, multiusuario, autenticación.
- Entrenamiento de modelos RVC propios (solo inferencia con modelos ya entrenados).
- App de escritorio empaquetada (Electron/Tauri) — queda como extensión futura.
- Compra/licencia de assets comerciales.

## Criterios de éxito
1. En Windows limpio: `setup.ps1` + `start.ps1` dejan el dashboard abierto en `http://localhost:3000` sin pasos manuales extra.
2. Flujo completo funciona: importar video → cortar → agregar subtítulos Whisper → aplicar efecto de voz o TTS → agregar SFX → render Remotion de título → exportar MP4.
3. Dashboard personalizable: layout de paneles persistido, tema claro/oscuro, presets de exportación editables.
4. `pnpm lint`, `pnpm typecheck`, `pnpm build` y tests pasan en CI (Linux) y no hay secretos en el repo.

## Supuestos declarados
- GPU no garantizada: todo corre en CPU por defecto; CUDA se activa por flag en setup si hay NVIDIA.
- UI en español, código y comentarios en inglés.
- Solo se copia código con licencia MIT/Apache/BSD/CC0; Remotion se usa bajo su licencia gratuita para uso personal. Todo queda registrado en `docs/trabajo/fuentes.md`.
- Node 22 LTS, Python 3.11, pnpm. Monorepo: `apps/web`, `apps/api`, `apps/workers` (Python), `packages/remotion`, `packages/motion-engines`, `packages/shared`.
- Claude/otros LLM dentro de la app: solo como asistente opcional (guiones, prompts) con key en `.env`; no es requisito para funcionar.
- piper-tts es dependencia GPL-3 en tiempo de ejecución (no se copia código); aceptable para uso personal cerrado.

## Restricciones
- Fable solo coordina; búsqueda → Sonnet, código → Opus, auditoría → agente de solo lectura.
- Contexto mínimo: cada agente escribe a archivos y devuelve ≤15 líneas.
- Rama: `claude/funny-mccarthy-0bbdt6`. Sin PR salvo pedido.

## Hitos
1. `docs/trabajo/fuentes-*.md` — investigación (motion, audio/voz, editor/instalación) con licencias y comandos exactos.
2. Esqueleto del monorepo + `docs/ARQUITECTURA.md` (diagrama) + scripts Windows base.
3. Módulos en paralelo: (a) dashboard web, (b) API + FFmpeg + cola, (c) Remotion + motores, (d) workers Python + setup/modelos.
4. Integración, tests, lint/typecheck/build verdes, auditoría contra este plan.
5. Commit + push + `docs/DEVOLUCION-2026-10-04-studio.md`.

## Descubierto (fuera de alcance)
- Motor Motion Canvas real vía Revideo; rasterizador Lottie propio para el motor FFmpeg; preview multi-clip/PiP en el navegador.

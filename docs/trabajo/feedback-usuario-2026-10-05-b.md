# Feedback del usuario — segunda prueba real (2026-10-05, sprint 2 instalado)

Test de rendimiento en RTX 4050: todos los packs instalados; Whisper turbo 7,09 s/min; Piper 5,79 s/100 car.; escenas 376 fps; **recorte de personas 9,4 fps (meta 15)** → optimización en curso (`docs/trabajo/perf-rvm.md`).

## Carencias observadas
1. **Separación de audio**: no existe separar voz / música / efectos de un clip (stems).
2. **Quitar fondo con muchos colores**: el recorte se daña y se llena de impurezas (bordes sucios, halos). RVM mobilenet es rápido pero básico; falta un modo "calidad alta" y limpieza de bordes.
3. **Falta de libertad para capas y superposiciones**: no se pueden componer varias capas de video libremente (mezclar, opacidad, modos de fusión, máscaras entre capas), ni superponer elementos con libertad total.
4. **Consola de Claude dentro de Studio**: el usuario quiere abrir Claude dentro de la app, sin API key, con la misma función que este chat y acceso total a las herramientas.

## Decisiones
- **Perfil de estilo desde video de referencia**: aprobado para el cierre del sprint 3 (análisis determinista en Studio + deducción del estilo con Claude en sesión o con un modelo local de visión opcional).
- **Consola Claude en Studio**: se implementa como panel con terminal embebida que ejecuta Claude Code (usa la suscripción Claude.ai con inicio de sesión, sin API key) + servidor MCP de Studio que expone las herramientas de la app (proyecto, jobs, EditPlan, exportar, reportes, análisis de estilo) + `CLAUDE.md` del proyecto. Sprint 3b.
- Stems (Demucs), calidad de recorte (modelo grande + refinado de bordes + despill) y compositor de capas libre → sprint 3b/4 según esfuerzo; registrados en `docs/01-PLAN-BASE-v2.md`.

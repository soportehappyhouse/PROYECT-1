# PLAN-BASE v2 — Studio IA local (post primera prueba real)

**Objetivo:** llevar Studio de "editor básico con plantillas" a editor con IA local en una RTX 4050 6 GB / 32 GB RAM: recorte y tracking, reencuadre, corte automático, render por bloques, paquetes de modelos bajo demanda y un agente local que edita por comandos. Sin nube ni créditos.

## Decisiones del usuario (2026-10-05)

| #   | Pregunta                | Decisión                                                                                                                                                                                                                                |
| --- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Monetización            | No se monetiza, pero puede subirse a redes → **"Revisión para redes"**: checklist que marca si el video contiene IA (cara/voz), música/terceros, etc., y avisa que puede no monetizarse o darse de baja.                                |
| 2   | Distribución            | Uso personal, pero **instalable en cualquier máquina** sin ataduras → todo lo GPL/no-comercial aislado en procesos/venv aparte desde el inicio.                                                                                         |
| 3   | Cambio de cara          | Con terceros **con aprobación previa** (caso de uso: dobles de riesgo). Compuerta de consentimiento con registro por persona.                                                                                                           |
| 4   | Aviso "alterado con IA" | **Desactivable**, apagado para uso interno; se activa solo al marcar "subir a redes".                                                                                                                                                   |
| 5   | Disco                   | **Paquete completo** (20–28 GB) en la unidad de instalación.                                                                                                                                                                            |
| 6   | Instalación             | Núcleo primero; **complementos (modelos) se descargan en secuencia y bajo demanda** al usar cada función, con barra de progreso.                                                                                                        |
| 7   | Sin VRAM                | Seguir lento con aviso, y **render por bloques con caché** (solo se recompilan los tramos que cambiaron).                                                                                                                               |
| 8   | Agente                  | **Solo local, sin API key.** Claude (esta cuenta) arma instrucciones, esquema de herramientas y dataset de ejemplos para adaptar el modelo local; evaluar Hermes 3 8B vs Qwen3 8B. El agente también ayuda a redactar reportes de bugs. |
| 9   | Acento rioplatense      | Según costo: se decide en fase C.                                                                                                                                                                                                       |
| 10  | Orden                   | **B antes que C.** Agente necesario, va después de B.                                                                                                                                                                                   |

## Alcance IN (por sprint, cada uno termina con commit, CI verde y prueba en tu PC)

**Sprint 1 — Base + Fase A (determinista)**

- Gestor de presupuesto de GPU en workers (un modelo residente, descarga/carga, fallback a CPU con aviso).
- Paquetes de modelos bajo demanda: `models/packs.json`; cada función pide su pack, la UI muestra "Descargar paquete (X GB)" y progreso; `setup -Full` baja todo en secuencia.
- Render por bloques: export dividido en segmentos por escena/tiempo, caché por hash de entradas, re-render solo de lo cambiado, concat sin recodificar.
- Cortar silencios y muletillas (Whisper palabras + silencedetect) con diálogo de revisión; detección de escenas (PySceneDetect); NVENC en proxies e intermedios; Whisper large-v3-turbo en GPU; limpieza de voz (DeepFilterNet).
- "Revisión para redes" + etiqueta IA desactivable.
- Test de rendimiento IA (mide en la PC real y guarda resultados).

**Sprint 2 — Fase B (visión)**

- Recorte de personas (RobustVideoMatting en proceso aislado GPL) y de imágenes (BiRefNet-lite).
- Máscara por clic sobre video (SAM 2.1 tiny/small, por tramos de 200–300 fotogramas).
- Tracking → keyframes (`track.json`) para pegar texto/motion que siga a un objeto o cara; keyframes de posición/escala/opacidad en el timeline.
- Auto-reencuadre 16:9 → 9:16 siguiendo cara/sujeto con suavizado y respeto de cortes de escena.

**Sprint 3 — Agente local (Fase D)**

- Ollama + modelo elegido por evaluación (Hermes 3 8B / Qwen3 8B, Q4). Esquema `EditPlan` JSON validado por la API; el usuario confirma antes de aplicar.
- Dataset de ejemplos (comando → EditPlan) generado con Claude en esta cuenta; evaluación automática; opción de LoRA local si el modelo base no alcanza.
- Comandos iniciales: cortar silencios, agregar título/rótulo en t, subtítulos con estilo, reencuadrar, exportar preset; y "redactar reporte de bug".

**Sprint 3b — Perfil de estilo + Consola Claude + libertad de composición (aprobado 2026-10-05)**

- Perfil de estilo desde video de referencia: Studio extrae análisis (hoja de contactos, escenas, duraciones, transcripción, perfil de audio); el estilo lo deduce Claude en sesión (sin API) o un modelo local de visión opcional (pack `vision-llm`, Qwen2.5-VL 3B/7B); se guarda como `StylePreset` y el Asistente lo aplica como EditPlan.
- Consola Claude: panel con terminal embebida (xterm.js + node-pty) que ejecuta Claude Code con la suscripción del usuario (sin API key) en la carpeta del proyecto; servidor MCP `studio-mcp` con herramientas (leer proyecto, proponer/aplicar EditPlan, jobs, exportar, reportes, análisis de estilo, capturas de la preview); `CLAUDE.md` de Studio con reglas y atajos.
- Separación de audio en stems (Demucs htdemucs, MIT) como pack `stems`: voz / música / efectos a pistas separadas.
- Recorte de fondo "calidad alta": RVM resnet50 + refinado de bordes (erosión/feather) + despill; opción por clip; medir vs mobilenet.
- Compositor de capas libre: cualquier pista de video superior se compone sobre las inferiores con transformación, opacidad, modo de fusión (normal, multiplicar, pantalla, superponer, añadir), máscara por clip (SAM/forma), en preview y export.

**Sprint 4 — Fase C (cara y voz)**

- FaceFusion en venv aislado + compuerta de consentimiento (registro de personas con aprobación) + etiqueta.
- TTS Chatterbox (MIT, español latino, clonación) en venv aislado; RVC en CUDA; decisión rioplatense.

## Alcance OUT

Nube, multiusuario, entrenamiento de modelos pesados (más allá de LoRA chico), generación de video por IA, publicación directa en redes.

## Criterios de éxito

1. Cada sprint: `setup -Update` en tu PC termina con pasos omitidos salvo lo nuevo; CI verde (ubuntu + windows + smoke).
2. Sprint 1: cortar silencios de un video de 1 min en < 30 s en GPU; export con un cambio chico re-renderiza < 20 % del tiempo total.
3. Sprint 2: recorte de persona a 1080p ≥ 15 fps en tu 4050; reencuadre 9:16 sin saltos visibles; texto siguiendo un objeto exportado correctamente.
4. Sprint 3: ≥ 90 % de 50 comandos de prueba producen un EditPlan válido y correcto sin API externa.
5. Sprint 4: swap con consentimiento registrado, etiqueta opcional, sin modelos no comerciales activos salvo aceptación explícita en pantalla.

## Supuestos declarados

- Velocidades en la 4050 son estimadas; el Test de rendimiento las mide y la UI muestra tiempos reales.
- Licencias no comerciales (inswapper/arcface) solo se habilitan tras aceptar un aviso; uso personal sin monetización.
- "Entrenar con mi cuenta de Claude" = Claude genera instrucciones, herramientas y ejemplos; no hay fine-tuning en la nube.

## Restricciones

Mismo protocolo: Fable coordina, Opus implementa, Sonnet investiga, auditoría independiente por sprint, commit + push + devolución al cierre de cada sprint.

## Descubierto (fuera de alcance)

- Separación de stems, calidad alta de recorte, compositor de capas y consola Claude: promovidos a Sprint 3b (ver arriba).

- HyperFrames (HeyGen) como referencia para preview multicapa, keyframes y pila de efectos — ver docs/trabajo/analisis-hyperframes.md

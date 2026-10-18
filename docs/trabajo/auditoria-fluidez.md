# Auditoría de fluidez de edición — 2026-10-08

Pedido del dueño: «como sistema de edición aún pierde muchas áreas de fluidez y sinergia; quiero
resultados profesionales de forma autónoma sin ser diseñador; aún tenemos muchos roces».

## Método

App real en el sandbox (rama `claude/funny-mccarthy-0bbdt6`, `de89506`), procedimiento de
`integracion-sprint4.md`: `pnpm -r build`; workers con `scripts/e2e/workers-with-mocks.py`
(`STUDIO_MOCK_DENOISE=0` para provocar el 409); api `node dist/index.js` con `STORAGE_DIR`/`MODELS_DIR`
nuevos, `REMOTION_BROWSER_EXECUTABLE` = headless shell de Playwright y `claude` falso;
`next start :3000`. Playwright Chromium 1366×820 (helpers de `ui-smoke.mjs`: `seek`, `routeVp9`),
manejado como un usuario nuevo. Medios: `clip.mp4` 12 s 1280×720 con 3,5 s de silencio, `voz.wav`,
`logo.png`. Capturas en el scratchpad `…/scratchpad/ux/` (nombres citados abajo). Además se leyó el
código donde el comportamiento no era obvio. Sin Ollama, Whisper ni GPU (ver «No probado»).

## (a) Mapa de calor (1 = roce fuerte, 5 = fluido)

| Flujo                                  | Descubribilidad | Pasos | Feedback | Autonomía IA | Consistencia |
| -------------------------------------- | :-------------: | :---: | :------: | :----------: | :----------: |
| 1. Primer proyecto → exportar          |        3        |   3   |    3     |      2       |      3       |
| 2. Subtítulos / edición por texto      |        3        |   3   |    2     |      2       |      3       |
| 3a. Asistente local / Consola Claude   |        2        |   4   |    3     |      3       |      3       |
| 3b. «Evaluar modelos»                  |        3        |   4   |    1     |      —       |      2       |
| 4. Trabajos, servicios caídos, paquetes|        3        |   3   |    2     |      1       |      2       |
| 5. Motion graphics y perfil de estilo  |        2        |   2   |    2     |      2       |      2       |
| 6. Voz (Piper/Chatterbox/RVC/Personas) |        2        |   3   |    3     |      2       |      2       |
| 7. Timeline (fluidez de edición)       |        3        |   3   |    4     |      1       |      3       |
| 8. Consistencia general (UI/textos)    |        3        |   —   |    2     |      —       |      2       |

Lectura rápida: lo que más duele es **feedback de trabajos/servicios** (progreso falso, errores
crudos, toasts repetidos) y **autonomía**: la IA espera comandos; no mira el material ni el
resultado. La timeline es usable pero de «una cosa por vez» (sin multiselección ni ripple).

### Conteo del flujo 1 (usuario nuevo)

Importar (1 clic + diálogo) → `+` del medio (1) → clic en la regla (1) → **S no corta** (hallazgo
5; hay que clicar el clip o la tijera) → clic en el trozo + Supr deja hueco (2) → arrastrar el resto
a mano (1, sin ripple) → pestaña Exportar (1) → Exportar (1). **≈ 9 clics, 1 callejón sin salida**,
10,6 s de exportación sin ruta del archivo en el resultado (`12-exportado.png`). El asistente lo
hace en 4 clics (escribir, Proponer, tildar exportación + «Confirmar exportación», Aplicar; 12,4 s).

## (b) Hallazgos

Severidad: **A** alta (rompe confianza o bloquea), **M** media, **B** baja.

1. **A — «Evaluar modelos» sin progreso real, sin ETA y sin cancelar.**
   `apps/api/src/jobs/handlers/agent.ts:1027-1045` publica `0.02` y después `0.5` fijo en cada
   vuelta del bucle que solo mira el `mtime` de `agent-eval.json`; nunca consulta
   `GET /agent/tasks/{id}`, aunque el worker ya lleva `task.progress` y `current_file =
   "qwen3:8b: 17/80"` (`apps/workers/studio_workers/routers/agent.py:162-165`,
   `agent/eval.py:209-211`). `TaskQueue` (`studio_workers/tasks.py`) no tiene cancelación:
   cancelar el job solo corta el `sleep` del api y Ollama sigue con los 80 × N comandos. Sin Ollama
   el job termina «Completado» en 2 s y la UI dice «La evaluación no devolvió resultados»
   (`32-evaluar-modelos-fin.png`); el botón está habilitado aunque arriba diga «Ollama: no
   encontrado» (`AssistantTab.tsx:160-170`). **Arreglo**: en el handler, `agentTask(task_id)` cada
   1 s → `ctx.reportProgress(task.progress, "qwen3:8b · 17/80 · faltan ~6 min")` con
   ETA = transcurrido / hechos × restantes; `Task.cancel_event` revisado entre ejemplos +
   `DELETE /agent/tasks/{id}` llamado al abortar `ctx.signal`; `available:false` → job `failed`
   con el texto de Ollama; botón deshabilitado sin Ollama; modo «Rápida (20)» por defecto
   (`limit` ya existe) y «Completa (80)» aparte con su duración estimada.
2. **A — El aviso de error dice solo «Error».** `apps/web/src/hooks/use-job-events.ts:70-71` usa
   `job.error ?? job.message` del evento SSE (que no trae `error`; `message = "Error"`), aunque dos
   líneas antes pidió el job completo (`full`). Visto: «Transcripción: falló · Error»
   (`17-asistente.png`, `84-workers-caidos-transcribir.png`); el texto real («Falta el paquete
   Python faster-whisper…») solo aparece en Trabajos. **Arreglo**: `description: full.error ??
   job.error ?? job.message`.
3. **A — Al recargar se repiten los toasts de trabajos viejos.** `use-job-events.ts:207-215`: la
   carga inicial de `/api/jobs` cambia el estado de `undefined` a terminal y dispara
   `handleFinished` para cada uno. Visto al recargar: 8 toasts («Exportación: completado», «Render
   motion: completado», «Transcripción: falló…») de la sesión anterior (`80-…inicio.png`).
   **Arreglo**: sembrar `handled` con los jobs ya terminales de la primera carga.
4. **A — Workers caídos = errores sueltos con 4 textos distintos, ninguno global.** Con el worker
   apagado: cabecera «IA —» gris; Voz y Paquetes de IA: «Workers Python no disponibles en
   http://127.0.0.1:8001 (¿está corriendo start.ps1?): TypeError: fetch failed»
   (`81`, `85`); Asistente: «Workers apagados» + «Los workers de IA no responden (¿está corriendo
   start.ps1?)» (`82`); Transcribir sigue habilitado, encola y falla con «Error: connect
   ECONNREFUSED 127.0.0.1:8001» (`90-trabajos-en-curso.png`). El usuario usa
   `scripts\windows\start.cmd`, no `start.ps1`. Texto crudo en
   `apps/api/src/services/workers-client.ts:378` (idem `style/workers.ts:84`,
   `persons/face-workers.ts:132`). Con la api caída pasa lo mismo: solo el panel Media lo dice
   (`86-api-caida.png`). **Arreglo**: un `service-status-store` (poll de `/api/health` cada 5 s +
   SSE) → **una** franja arriba: «La IA local está apagada. [Reintentar] [Cómo iniciarla]»; los
   botones de IA se deshabilitan con tooltip; el api traduce `ECONNREFUSED` a
   `WORKERS_DOWN` con texto en español sin `TypeError`.
5. **A — Después de clicar la regla, S/Espacio/J/K/L/Supr no hacen nada.** La regla es
   `role="slider" tabIndex={-1}` (`components/timeline/Ruler.tsx:39-43`) y toma el foco;
   react-hotkeys-hook 5.3.3 trata `role=slider` como campo de formulario e ignora el atajo.
   Medido: regla con foco → S no corta (1 clip); clip con foco → corta (2). Es exactamente el
   gesto natural «clic donde quiero cortar → S». **Arreglo**: `preventDefault` en el `pointerdown`
   de la regla (no robar foco) o `enableOnFormTags: ["slider"]` para transporte/timeline.
6. **A — «Exportá para Reels» con video horizontal da un 9:16 con el video chico y fondo
   borroso.** El plan del asistente fue `cut_silences` + `export reels-tiktok`, sin `reframe` ni
   pregunta; el archivo sale 1080×1920 con el 16:9 al centro (`23-export-reels-frame.png`). El
   propio `CLAUDE.md` dice «+ reframe 9:16 si es horizontal». **Arreglo**: en el resolver del api
   (`services/agent/resolve.ts`), si el aspecto del preset ≠ lienzo, insertar `reframe {target}`
   (riesgo: «el video es horizontal: lo reencuadro siguiendo la cara») o una `question`.
7. **M — No hay forma de abrir otro proyecto.** Cada perfil de navegador crea «Proyecto sin
   título» (14 homónimos en la api tras la sesión); `api.listProjects` (`lib/api.ts:362`) no se usa
   en ningún componente; el proyecto actual es solo `localStorage.studio.project.v1`. **Arreglo**:
   menú «Proyectos» (recientes con miniatura, renombrar, duplicar) y nombre automático con el
   primer video importado.
8. **M — Lo importante está escondido detrás de «⌄ 5».** A 1366 px el grupo derecho muestra
   Propiedades/Motion/Voz y esconde Subtítulos, Exportar, **Asistente**, Consola Claude y Perfil de
   estilo (`01-primer-arranque.png`). **Arreglo**: layout por defecto con barra lateral de modos
   (Editar · Subtítulos · Gráficos · Voz · Exportar) y botón fijo «Asistente» en la cabecera.
9. **M — Borrar deja hueco; no hay ripple.** `lib/timeline.ts:265` `removeClip` filtra y listo;
   medido hueco de 144 px tras Supr (`05-borrar-deja-hueco.png`). Solo «Quitar silencios» hace
   ripple. **Arreglo**: Mayús+Supr = borrar y cerrar hueco; menú contextual «Cerrar huecos de la
   pista»; opción «Magnético» por pista.
10. **M — Selección de un solo clip.** `selectedClipId` único (`stores/project-store.ts:60`);
    Mayús+clic no suma (medido: 1 seleccionado). **Arreglo**: `selectedClipIds` + rectángulo de
    selección; borrar/mover/velocidad/volumen en lote.
11. **M — No existe edición por transcripción.** Subtítulos permite editar texto y tiempos; borrar
    un segmento borra solo el subtítulo, no el video. Corregir una letra **borra los tiempos por
    palabra** (`SubtitlesPanel.tsx:396-401`, `words: undefined`) → el karaoke/animado deja de
    funcionar en ese segmento, y cada tecla es un paso de deshacer. **Arreglo**: ver estructural 3;
    a corto plazo, conservar `words` si la cantidad de palabras no cambia (reemplazo 1:1) o
    redistribuir proporcionalmente.
12. **M — Motion: formulario técnico, en inglés y «renderizar para ver».** Rótulo: Estilo
    `bar/box/underline/split`, Posición `bottom-left…`, Animación `slide/fade/wipe/pop`, Formato
    «ProRes 4444 / Secuencia PNG», motores «Motion Canvas (Revideo)» con «no implementado todavía»
    a la vista (`41-motion-rotulo-form.png`). Con Remotion sin navegador cada plantilla dice solo
    «(no disponible)» sin motivo ni botón (`40-motion.png`; el api sí trae `reason`). Render de un
    rótulo de 5 s: **36,6 s** (2.º render 6 s con caché), sin ETA; cada cambio de texto obliga a
    re-renderizar. **Arreglo**: mapas de etiquetas en español, «Avanzado» plegado (motor, formato,
    márgenes), mostrar `reason` + «Arreglar», y vista previa en vivo con `@remotion/player` en el
    canvas (render solo al exportar).
13. **M — Editar un motion obliga a cambiar de panel.** Con el rótulo elegido, Propiedades muestra
    «lower-third» y tiempo/escala/posición pero no sus textos ni colores (`44-…propiedades.png`);
    hay que ir a Motion graphics («Editar el clip motion seleccionado», `MotionPanel.tsx:354-449`).
    **Arreglo**: el formulario del template dentro de Propiedades; doble clic en el clip lo abre.
14. **M — No hay sistema de diseño.** Estilo de subtítulos (`stores/caption-style-store.ts`),
    props de cada plantilla (10 tipografías, colores sueltos) y perfil de estilo
    (`packages/shared/src/style.ts:135,146`, `accentColor` por sección) no comparten tokens; no hay
    kit de marca; las guías de zona segura existen (`PreviewOverlay.tsx:136`) pero apagadas y sin
    validación. Resultado: la consistencia depende del usuario, que no es diseñador. Ver
    estructural 2.
15. **M — Cancelar un render deja un clip motion vacío.** Tras cancelar el «Título» quedó una
    pista Motion nueva con el clip `title-card` sin render (proyecto `s_pGFE…`); según
    `integracion-sprint4.md` eso termina en `EXPORT_BLOCKED` al exportar. **Arreglo**: al cancelar,
    quitar el clip recién creado o mostrarlo rayado con «Sin render · Renderizar».
16. **M — Medios internos ensucian Media.** La hoja de contactos («Perfil de estilo · clip.mp4»,
    con insignia «Máscara (SAM 2)») y los renders («Motion · lower-third») aparecen como medios y
    como opción de «video de referencia» (`46-estilo-analizado.png`, `71-timeline-drag.png`). Subir
    el mismo archivo dos veces lo duplica. **Arreglo**: filtro por origen + grupo «Generados»;
    deduplicar por hash.
17. **M — Exportar habla en códecs.** El panel abre con CRF, bitrate, contenedor, códec de audio
    (`10-panel-exportar.png`); el resultado es «Completado · Descargar» sin ruta, tamaño ni
    duración. **Arreglo**: vista simple «¿Dónde lo vas a publicar?» (tarjetas con aspecto), técnico
    plegado; tarjeta de resultado con miniatura, ruta, «Abrir carpeta» y «Revisar».
18. **M — Asistente esperando al modelo: sin tiempo ni cancelar; el plan no sobrevive.** Solo
    spinner «Pensando un plan (en tu PC)…» (`AssistantPanel.tsx:700-706`), sin segundos
    transcurridos ni botón Cancelar; el worker corta a 120 s (`config.py:57`). Tras recargar el plan
    propuesto desaparece (queda en el Historial pero no se reabre). **Arreglo**: contador +
    «Cancelar» con `AbortController`; reabrir el último borrador.
19. **M — Nombres inconsistentes.** «Paquetes de IA» (pestaña) vs «Ajustes → Paquetes»
    (`StylePanel.tsx:162`, `api/services/agent/resolve.ts:288`, `routes/agent.ts:35`,
    `routes/style.ts:30`); «Voz limpia ~200 MB» (panel) vs «Limpieza de voz (DeepFilterNet) 220 MB»
    (diálogo, `52-paquete-requerido.png`); columna «Lo usa» con ids (`analyze.scenes`,
    `vision.matte.rvm`); voces «Espana», «Mexico»; pestaña «RVC», «Índice de rasgos», «Método F0:
    rmvpe/harvest/pm/crepe» (`53-voz-rvc.png`); el modelo de Ollama se baja en «Asistente local»,
    no en Paquetes; `start.ps1` vs `start.cmd`. **Arreglo**: glosario único en
    `packages/shared` (nombres de paneles, paquetes y acciones) usado por web, api y mensajes.
20. **M — Voz: tres paneles para una idea.** Texto a voz (Piper/Chatterbox/«ElevenLabs (sin API
    key)»/«OpenAI (sin API key)»), «Voz propia», RVC y Personas (en Ajustes) son caminos separados;
    los motores sin clave se ofrecen igual (`50-voz.png`). **Arreglo**: un selector «¿Qué voz?»
    (Mis voces · Voces de Studio · Convertir mi grabación) con el motor elegido solo; ocultar los
    que no tienen clave.
21. **M — Tooltips que repiten la etiqueta.** 51 botones de solo ícono tienen `aria-label` y el
    tooltip dice lo mismo: «Paneles», «Tema», «Generar proxy» (hover medido). Bien: la tijera
    («Cortar en el cursor (S)») y SAM 2. El usuario pidió que los botones se expliquen. **Arreglo**:
    `tooltip` obligatorio = qué hace + atajo + por qué está deshabilitado.
22. **M — Autoguardado sin vaciado al cerrar.** `use-project-sync.ts:8` espera 1,5 s y no hay
    `pagehide`/`beforeunload`: cortar y cerrar enseguida pierde el corte (visto en la prueba de
    atajos). **Arreglo**: `pagehide` → `fetch(..., {keepalive: true})` del proyecto.
23. **B — «IA local (puede tardar)» en operaciones que no son IA.** `lib/agent.ts:54-78` marca así
    `cut_silences`, `detect_scenes`, `reframe` (FFmpeg/OpenCV, segundos). **Arreglo**: etiqueta
    por op («rápido, FFmpeg» / «IA local»).
24. **B — Tres avisos por clic en CPU.** «Va a correr en CPU (más lento)» + «Transcribiendo…» +
    el resultado, cada vez (`17-asistente.png`). **Arreglo**: el aviso de CPU una vez por sesión y
    en línea en el panel.
25. **B — Deshacer cubre poco.** `Snapshot = tracks + subtitles + reframe`
    (`project-store.ts:45-49`): lienzo, estilo de subtítulos, publicación y ajustes de exportación
    no se deshacen; el historial se pierde al recargar. **Arreglo**: sumar `settings` y
    `captionStyle`; guardar las últimas 20 instantáneas en `sessionStorage`.
26. **B — Primer arranque mudo.** Vista previa negra sin llamada a la acción; lienzo 1920×1080 por
    defecto aunque el video sea 1280×720 («Ajustar lienzo al video» es manual,
    `InspectorPanel.tsx:283-287`). **Arreglo**: estado vacío «Arrastrá un video acá» en la vista
    previa y ajustar el lienzo al primer video automáticamente (con deshacer).

### Mediciones de timeline (26 clips, Chromium headless, CPU, incluye ida y vuelta de Playwright)

| Acción                         | Mediana | Máx    |
| ------------------------------ | ------- | ------ |
| Cortar (S) hasta 2 rAF         | 39 ms   | 57 ms  |
| Cada paso de arrastre (2 px)   | 48 ms   | 66 ms  |
| Deshacer / zoom / fotograma    | 37 / 31 / 31 ms | — |
| Clic + Supr                    | 97 ms   | —      |
| rAF en reposo / reproduciendo  | 60 / 60 fps | — |

Aceptable, pero el arrastre a ~20 fps se nota; `ClipView` re-renderiza toda la pista en cada
`mousemove`. Imán (N) y zoom (=/−) existen; J/K/L y Espacio funcionan (salvo hallazgo 5).

## (c) Quick wins (≤ 1 día cada uno)

1. Toast de error con `full.error` (hallazgo 2) y sembrar `handled` al cargar (hallazgo 3).
2. Regla sin robar foco: los atajos vuelven a andar tras buscar con el mouse (hallazgo 5).
3. «Evaluar modelos»: progreso por ítem desde `/agent/tasks/{id}`, ETA, «Rápida (20)» por
   defecto, botón deshabilitado sin Ollama y `failed` con motivo (hallazgo 1, sin cancelación).
4. Franja global de servicios desde `/api/health` + botones de IA deshabilitados con motivo;
   `WORKERS_DOWN` en español con `start.cmd` (hallazgo 4).
5. ETA genérico en Trabajos: `restante ≈ transcurrido × (1 − p) / p` tras 10 s, y «sin avance
   hace 2 min» si el progreso no cambia (detecta el «2 % para siempre»).
6. Resolver: preset vertical sobre lienzo horizontal → agrega `reframe` o pregunta (hallazgo 6).
7. Mayús+Supr = borrar con ripple + «Cerrar huecos» en el menú del clip (hallazgo 9).
8. Etiquetas en español para enums de plantillas y ocultar Motion Canvas no implementado
   (hallazgo 12).
9. Pasada de nombres: «Ajustes → Paquetes de IA» en todos los mensajes, tildes en voces,
   «Lo usa» con nombres de función, `start.cmd` (hallazgo 19).
10. Vaciar el guardado en `pagehide` y tooltips descriptivos en los 20 íconos más usados
    (hallazgos 21-22).

## (d) Cambios estructurales hacia resultados profesionales autónomos

1. **Un centro de trabajos con contrato de progreso.** Esquema compartido
   `{done, total, unit, eta_s, stage_es, cancellable}` en `packages/shared`; todos los handlers
   (api y workers) lo reportan; cancelación de punta a punta (`ctx.signal` → `DELETE` en workers →
   `cancel_event` en `TaskQueue` y en los subprocesos); errores siempre con `code` + texto en
   español + acción («Descargar paquete», «Iniciar IA», «Reportar»). Un `service-status-store` y
   una sola franja para api/workers/Ollama/GPU ocupada. Se acaba el «2 % sin ETA».
2. **Kit de marca + plantillas con guardas.** Tokens (2 tipografías, paleta de 3-5 colores,
   logo, márgenes de zona segura por aspecto, duraciones de entrada/salida, escala tipográfica)
   en el proyecto; subtítulos, plantillas Remotion y perfiles de estilo los consumen en vez de
   props sueltas; las plantillas declaran qué se puede cambiar (texto, posición en una grilla de
   9 anclas) y validan legibilidad (contraste, tamaño mínimo, texto fuera de zona segura). El perfil
   de estilo deducido de una referencia se guarda como kit. Así un no diseñador no puede salirse de
   «se ve profesional».
3. **Edición por transcripción.** Panel «Texto» con palabras clicables sobre `words`: borrar
   palabras/frases = cortes con ripple (ya existe `applyCutsLocally`), muletillas y silencios
   resaltados para quitar con un clic, corregir texto conservando tiempos, buscar y saltar. La
   transcripción corre sola al importar (si Whisper está), y subtítulos, cortes y el asistente
   trabajan sobre el mismo texto.
4. **Bucle plan → render → revisión.** Tras aplicar un plan (o antes de exportar), Studio genera
   fotogramas clave (inicio, cada cambio de plano, títulos) y corre chequeos automáticos:
   letterbox/barras, texto fuera de zona segura o ilegible, cara tapada por subtítulos, loudness
   (−14 LUFS para redes), silencios largos, motion sin render. Muestra una tarjeta «Revisión» con
   miniaturas y arreglos de un clic, y el asistente (local o Claude, que ya tiene
   `studio_preview_frame`) propone el plan de corrección antes de exportar.
5. **Sugerencias proactivas y «hacer versión para…».** Al importar, análisis baratos en
   segundo plano (silencios, escenas, aspecto, audio) → tarjetas «Hay 3,5 s de silencios —
   ¿cortar?», «Video horizontal — ¿versión 9:16 siguiendo la cara?», «Sin subtítulos —
   ¿generarlos?». Un botón «Versión Reels/YouTube» encadena perfil de estilo + reencuadre +
   subtítulos + revisión (estructural 4) y deja la exportación esperando confirmación. La IA deja de
   esperar comandos y el usuario aprueba en vez de dirigir.

## (e) No probado en el sandbox

- **Ollama real**: planes por LLM, tiempos de propuesta, la evaluación de 10-25 min (solo se vio
  el camino sin Ollama, 2 s) y el modelo «cargando». Los planes vinieron de la regla directa.
- **Whisper**: el venv del sandbox no tiene `faster-whisper` → la transcripción falla; no se
  probaron estilo → corrección → karaoke con palabras reales ni el render de subtítulos animados.
- **GPU/CUDA**: «GPU ocupada → CPU» solo leído en código (`hasGpuFallback`); el indicador mostró
  «CPU». Sin medir VRAM ni la liberación.
- **Voz real** (Piper sin voces instaladas, Chatterbox `--mock`, RVC falso «e2e voz»), cara
  (FaceFusion falso) y Personas con consentimiento: solo navegación y textos.
- **Descargas de paquetes** (Hugging Face bloqueado) y su progreso.
- **Consola Claude real**: el `claude` es un eco; no se probó el flujo MCP de punta a punta.
- **Video H.264 en el navegador**: Chromium de Playwright no lo decodifica; se usó la ruta VP9 de
  `ui-smoke`, así que la fluidez de reproducción real (Chrome/Edge en Windows) no está medida.
- **Rendimiento en la PC del usuario** (RTX 4050, Windows): las latencias de la tabla son
  headless en 4 vCPU e incluyen Playwright; tomarlas como relativas.
- Arrastrar y soltar archivos desde el Explorador de Windows, rutas con tildes/espacios y
  `start.cmd`.

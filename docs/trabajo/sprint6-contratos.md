# Sprint 6 — Contratos acordados («Guion y sistema de diseño»)

Plan: `docs/02-PLAN-BASE-v3.md` (Sprint 6, ítems 1–3; criterio de éxito Sprint 6; decisiones
2026-10-08). Base: `docs/trabajo/auditoria-fluidez.md` (H#), `docs/trabajo/integracion-sprint5.md`
(abiertos y «Descubierto»), `docs/DEVOLUCION-2026-10-04-studio.md` (criterios 🟡 de cada sprint) y
**`docs/trabajo/fuentes-sprint6.md`** (investigación de este sprint, citada como **F§n**). Código leído:
`packages/shared/src/{agent,style,subtitles,timeline,job,job-progress,ai,api,hotkeys,texts-es,frame,motion}.ts`,
`packages/remotion/src/{fonts.ts,schemas/common.ts,render.ts}`, `apps/api/src/{jobs/{queue,state,store}.ts,
services/agent/resolve.ts,jobs/handlers/agent.ts,services/ffmpeg/{ass,timeline}.ts,routes/index.ts,lib/errors.ts}`,
`apps/workers/studio_workers/{tasks.py,task_schema.py,errors.py,routers/{transcribe,analyze}.py,agent/eval.py}`,
`scripts/agent/validate-dataset.py`, `apps/web/src/{lib/{agent,shortcuts}.ts,components/dashboard/Hotkeys.tsx}`.
Fecha: 2026-10-18.

## Decisiones del usuario (vinculantes)
- **Un solo brand kit** (el canal del usuario): no hay selector de kits, herencia por proyecto ni
  «kit por cliente». El kit vive en la api (uno por instalación) y todo lo consume por defecto.
- **Destino principal 9:16 (Reels/TikTok)**, 16:9 secundario: las reglas, zonas seguras y pruebas se
  escriben primero para 9:16; cada criterio medible se corre en los dos aspectos.
- **Español rioplatense** en toda la UI, mensajes de error, plantillas y textos de ayuda.
- **Prioridades 2026-10-18** (panel: Funciones ≈ 85 %, Diseño ≈ 50 %): **M2 Sistema de diseño es el
  módulo principal** (más alcance y más pruebas); M3 se achica a lo esencial (silencios + voz baja
  con «Aplicar»); la deuda de funciones barata entra en el módulo que corresponda (tabla abajo).

## Decisiones tomadas en este documento
1. **Una sola fuente de tiempos por palabra**: `project.subtitles[].words` (tiempos de la línea de
   tiempo). El panel Guion es una vista (`ScriptSchema`, calculada) y nunca guarda una segunda copia de
   los tiempos; subtítulos, cortes, `fit_duration` y el Asistente trabajan sobre el mismo texto (H11,
   estructural 3). Lo que no está en `words` (envolvente de energía y huecos acústicos) se guarda
   aparte como artefacto del job `script.transcribe` (`renders/<jobId>/script-audio.json`).
2. **Borrar palabras** = rangos calculados por **una** función (`planWordCuts`, shared, M1), afinados
   en la api con la energía (`POST …/script/cuts`) y aplicados con el ripple sincronizado que ya
   existe (web: `rippleDelete(..., {syncTrackId})`; api: `timeline.apply-cuts` con `mode:"timeline"`).
   Corte en el **medio del hueco** con margen ≤ 60 ms y afinado al mínimo de energía en ±60 ms;
   no se corta si queda < 40 ms (F§1.5). **Fundido de audio de 12 ms por lado** (`afade` `qsin`,
   máx. 15 ms, sin solape: la duración no cambia) en cada empalme vía `Clip.audioFade`; video seco.
3. **Muletillas en 3 niveles** (`safe` / `probable` / `doubtful`, F§1.3): léxico rioplatense +
   repeticiones + **hueco acústico** (voz sin palabra ≥ 250 ms y ≥ piso + 10 dB) porque Whisper no
   escribe los «eh» (F§0.1). Solo `safe` viene preseleccionado. **Sin WhisperX ni CrisperWhisper**
   (licencia CC-BY-NC / peso): se usa faster-whisper (MIT) con `vad_filter=False` y
   `hallucination_silence_threshold=2.0` en el pedido de guion.
4. **Corrección de texto** = diff palabra a palabra (`difflib.SequenceMatcher` / LCS propia en TS):
   `equal` conserva tiempos, `replace` reparte por letras (≥ 80 ms c/u), `insert` toma ≤ 60 % del
   hueco, `delete` deja hueco (no corta). Palabras tocadas: `corrected: true` (F§1.6).
5. **`fit_duration` voraz por niveles** (F§1.4): pausas largas → muletillas seguras → probables/dudosas
   (conf. ≥ 0,6) → oraciones (solo con `allow_sentences` y confirmación) → aceleración ≤ 1,1× (solo con
   `allow_speedup`). Nunca corta a mitad de palabra; si no llega, devuelve lo logrado + pregunta.
6. **Tokens de diseño = esquema zod en `packages/shared/src/design.ts`** (sin Style Dictionary);
   valores por defecto en `DEFAULT_DESIGN_TOKENS`, todos editables desde el kit (nada hardcodeado en
   plantillas, ASS ni web). Vista DTCG 2025.10 exportable como función de M2 (opcional).
7. **Reglas duras de subtítulos** (F§2.3, valores = tokens editables): máx. **2 líneas**;
   **30 / 34 / 42** caracteres por línea en 9:16 / 1:1 / 16:9; tamaño **≥ 4,5 % del lado corto**
   (recomendado 6 %); contorno 8 % del tamaño o caja con alfa ≥ 0,6; contraste texto/contorno o caja
   ≥ 7:1; duración por página 0,83–7 s y ≤ 17 cps; adentro de la zona segura. Las duras **se corrigen
   solas** al generar (ASS y Remotion) y al exportar; las guías avisan.
8. **Zona segura 9:16 conservadora**: arriba 15 %, abajo 35 %, izquierda 11 %, derecha 11 % (tokens;
   F§2.2 da derecha 18 % para Shorts: queda como perfil avanzado). **Se calibra con capturas del
   teléfono del usuario** (Ajustes → Kit de marca → «Calibrar con una captura»): la UI dice «guía», no
   «certificado». 1:1: 5 % por lado y 8 % abajo; 16:9: 5 % por lado y 10 % abajo.
9. **Ningún render depende de la red** (criterio duro): las 10 familias OFL que ya usa Studio se
   empaquetan en `packages/remotion/public/fonts/<Familia>/` (TTF estáticos 400/700/900 + `OFL.txt`,
   presupuesto ≤ 8 MB) y se usan desde **los tres lados**: Remotion (`FontFace`/`staticFile`, nunca
   `fonts.googleapis.com`), vista previa web (`@font-face` servido por `GET /fonts/*`) y libass
   (`subtitles=…:fontsdir=<carpeta>`). `fonts.ts` deja de bajar de Google Fonts.
10. **Vista previa sin render completo**: `renderStill` en la api (`POST /api/motion/still`, PNG,
    caché por hash de props+kit, debounce 400 ms en la web). `@remotion/player` queda como pregunta
    abierta 1 (no se agrega dependencia en este sprint por defecto).
11. **Sugerencias al importar = trabajos de fondo**: job `suggest.analyze` en el **carril nuevo
    `background`** de la api (límite 1, nunca bloquea `workers`/`ffmpeg`) con `priority = -10`, y en
    los workers una **`TaskQueue` con prioridad** (`PriorityQueue`, `priority` 0 = usuario, 5 = fondo).
    **M3 es dueño del cambio de la cola** (api `jobs/*` y workers `tasks.py`); M1 y M2 no la tocan
    (M1 solo llama `submit(...)` con la firma de hoy, que sigue valiendo).
12. **Paso 0** (abajo) crea los esquemas, textos base, stubs 501 `NOT_IMPLEMENTED` con el módulo, el
    carril `background`, el registro de tasks de workers y las 3 rutas propias vacías.

## Objetivo y criterios medibles del sprint

Objetivo: editar un video hablado **desde el texto** y que todo texto en pantalla salga
**profesional sin tocar nada**, con el kit del canal del usuario, más sugerencias que ahorran pasos.

| # | Criterio | Cómo se mide (sandbox) | Meta | Solo en la PC |
| - | -------- | ---------------------- | ---- | ------------- |
| C1 | **Cortar 10 muletillas desde el guion en < 1 min** | ui-smoke «Sprint 6: 10 muletillas»: proyecto con `words` del mock (12 muletillas: 8 `safe`, 4 `probable`) → abrir Guion, «Quitar seguras» (1 clic) + 2 selecciones + `Supr`; cronómetro desde abrir el panel hasta el 10.º corte aplicado | < 60 s (headless típico < 10 s); 10 cortes, subtítulos corridos, **un** Deshacer por gesto | con Whisper real sobre un video propio: cronometrar y anotar cuántas muletillas «eh/em» detecta el hueco acústico |
| C2 | **Subtítulos y títulos pasan las reglas del sistema de diseño sin tocar nada** | `scripts/e2e/design-check.mjs`: 2 proyectos por defecto (9:16 y 16:9: clip hablado + `add_captions reels` / `clasico` + `title-card` + `lower-third`) → exportar → `POST /api/design/check` + chequeos de píxeles sobre 5 fotogramas (caja del texto = diferencia con/sin subtítulos: adentro de la zona segura, ≤ 2 líneas por alto) | **10/10 reglas** (`DESIGN_RULES`) en los dos aspectos, 0 ajustes manuales | mirar 3 fotogramas en el teléfono (Reels y TikTok) y calibrar la zona segura |
| C3 | **Diseño (panel)** | (a) checklist C2; (b) **mapa de calor UX repetible** (`docs/trabajo/protocolo-mapa-calor.md`, mismo método y 9 flujos × 5 dimensiones que `auditoria-fluidez.md`, lo corre la auditoría del sprint) + métricas automáticas `ui-smoke --ux-metrics` (JSON) | promedio **≥ 3,5 / 5** (hoy 2,52 → panel Diseño ≥ 70 %), flujos 2, 5, 6 y 8 ≥ 3,5; métricas: 0 términos en inglés visibles en Motion/Propiedades/Voz, 0 botones de ícono sin tooltip explicativo, ≤ 2 familias tipográficas en la UI, primer proyecto → export ≤ 7 clics | escala 125 % en 1366 px |
| C4 | **Ningún render depende de la red** | e2e con `STUDIO_FONTS_OFFLINE=1` (la api bloquea `fonts.googleapis.com`/`fonts.gstatic.com` en el navegador de Remotion) → `title-card` y `animated-captions` renderizan con la familia pedida (comparación de píxeles con la referencia empaquetada); test que prohíbe `googleapis` en `packages/remotion/src`; ASS con `fontsdir` | 0 pedidos de red; misma familia en Remotion, ASS y vista previa | sin internet en la notebook |
| C5 | **Sugerencias al importar** | e2e: importar `clip.mp4` (3,5 s de silencio, voz a −30 LUFS) → 2 tarjetas («silencios», «voz baja») en < 15 s; mientras corre, un `subtitles.transcribe` del usuario arranca en ≤ 1 s; «Aplicar» → plan → aplicado → «Deshacer todo» | 2 tarjetas, prioridad respetada, sin bloqueo | importar 3 videos de 10 min en el i5 sin que la línea de tiempo se trabe |
| C6 | **Deuda de funciones** | tabla «Deuda de funciones»: ítems asignados cerrados con prueba | 5 firmes + los P2/P3 que entren | los marcados «PC» |

Además (heredado): `pnpm lint && pnpm format:check && pnpm -r typecheck && pnpm -r test`,
`pytest -q` (al azar, en orden y en orden inverso), `run-e2e.mjs` (sin `--skip-motion`) y
`ui-smoke.mjs --vp9-preview` verdes en ubuntu + windows.

## Trazabilidad (hallazgos → módulo)
| Módulo | Hallazgos de la auditoría | Ítem del plan v3 | Deuda que entra |
| --- | --- | --- | --- |
| M1 Guion | H11 (conservar `words`), estructural 3 | 1 | — |
| M2 Sistema de diseño (principal) | H12 Motion en español, H13 editar motion en Propiedades, H14 sistema de diseño, H19 (resto: glosario, voces «España/México», «Lo usa»), H20 selector de voz único, estructural 2 | 2 | H19, MEJORAS B11, B6 (fondo opaco del título) |
| M3 Sugerencias | estructural 5 (parte), H16 medios generados/duplicados (P2), H18 reabrir el último plan (P2), H25 deshacer de ajustes (P2) | 3 | H18, MEJORAS B13, B15, verificador de la PC (P3) |
| Sprint 7 / Descubierto | estructural 4 («Revisar resultado»), escenas y caras en sugerencias, Player en vivo, PIN local | — | ver tabla de deuda |

## Deuda de funciones (el ≈ 15 % que falta)

Fuente: criterios 🟡 de `DEVOLUCION-2026-10-04-studio.md` (sprints 0–5), «Abiertos» del panel,
«Descubierto» de `integracion-sprint4.md`/`integracion-sprint5.md` y `docs/MEJORAS.md` (backlog R2 sin
reconciliar). «Sandbox» = se puede cerrar acá con prueba; «PC» = solo con la RTX 4050/Windows/servicios
reales del usuario.

| # | Ítem | Origen | Dónde se cierra | Asignado |
| - | ---- | ------ | --------------- | -------- |
| 1 | Flujo completo con Whisper/Piper/RVC reales | S0 crit. 2 🟡 | PC | PC |
| 2 | `-Update` omite lo instalado | S1 crit. 1 🟡 | **ya medido en la PC** (2026-10-05: `actualizar.cmd` cambió a CUDA, 6/6 paquetes) | Integración S6: reclasificar 🟢 con esa evidencia |
| 3 | Re-render con un cambio < 20 % (NVENC) | S1 crit. 2b 🟡 (42 % en CPU) | PC | PC (verificador #14) |
| 4 | Recorte ≥ 15 fps 1080p | S2 🟡 | PC | PC (verificador #14) |
| 5 | Evaluar modelos qwen3:8b ≥ 90 % golden; Rápida ≤ 3 min; Ollama corta al cancelar | S3 crit. 4 🟡, S5 | PC | PC (verificador #14) |
| 6 | Consola con `claude` real | S3b 🟡 | PC | PC |
| 7 | Stems 1 min < 60 s en GPU + sha256 de Demucs | S3b 🟡 | PC | PC (verificador #14) |
| 8 | Halos HQ en clip real | S3b 🟡 | PC | PC |
| 9 | FaceFusion fps, Chatterbox RTF, RVC < 15 s/min | S4 crit. 5 🟡 | PC | PC (verificador #14) |
| 10 | `taskkill /T` del árbol; `Ctrl+O`/`Ctrl+Alt+N` en Edge; 125 % en 1366 px; loudnorm 10 min; «Abrir carpeta» con tildes | S5 🟡 | PC | PC |
| 11 | H18 parcial: reabrir el último borrador del Asistente tras recargar | S5 parcial | Sandbox | **M3 (P2)** |
| 12 | H19 parcial: glosario único, voces «Espana/Mexico», columna «Lo usa» con ids | S5 parcial | Sandbox | **M2** |
| 13 | MEJORAS B7: lienzo sin máximo (20000×20000 rompe el export) | R2 | Sandbox | **Paso 0** (`ProjectSettings` máx. 8192) |
| 14 | Verificador de la PC: un `verificar-pc.cmd` que corre Test de rendimiento + «Evaluar modelos» Rápida + stems 1 min y deja `storage/run/verificacion.json` para pegar (convierte los ítems 3, 4, 5, 7, 9 en un solo paso del usuario) | panel «pendiente PC» | Sandbox (script) + PC (correrlo) | **M3 (P3)** |
| 15 | MEJORAS B11: motor no disponible responde en inglés («Motion engine "m…») | R2 | Sandbox | **M2** |
| 16 | MEJORAS B13: renders motion con «Sin proxy» y botón «Generar proxy» | R2 | Sandbox | **M3 (P2, con H16)** |
| 17 | MEJORAS B15: medio con probe fallido sin marca ni acción | R2 | Sandbox | **M3 (P2, con H16)** |
| 18 | MEJORAS B6: `title-card` con fondo opaco `#111111` sobre WebM alfa | R2 | Sandbox | **M2** (tokens: fondo transparente por defecto) |
| 19 | `GET /api/projects?view=summary` lee cada proyecto completo | S5 Descubierto | Sandbox | S7 |
| 20 | Cancelar `audio.denoise` y `voice.tts` de Piper | S5 Descubierto | Sandbox | S7 |
| 21 | PIN local; filtro NSFW de fotos de Persona | S4 Descubierto | Sandbox | S7 |
| 22 | Hashes de Hugging Face; texto real del rechazo NSFW | S4 Descubierto | PC | PC |
| 23 | MEJORAS B8–B10, B12, U6 (disco), U7 (0,067 s al soltar): reconciliar (varios ya resueltos) | R2 | Sandbox | Integración S6 (solo reconciliar el documento) / S7 |

**Entran en el Sprint 6: 9 ítems** — 5 firmes (#2 reclasificación con evidencia, #12, #13, #15, #18),
3 de prioridad 2 en M3 (#11, #16, #17) y 1 opcional (#14, P3). Con #2 y los verdes de C1–C6 el panel
puede subir Funciones sin la PC; los 🟡 de la PC (#3, #4, #5, #7, #9) bajan de a varios con el
verificador (#14) en una sola corrida del usuario.

## Regla común de edición concurrente
Tres agentes en paralelo sobre el mismo árbol; cada uno toca **solo sus rutas**. Compartidos:
- `packages/shared/**`: lo escribe el **Paso 0**. Después cada módulo solo **agrega archivos propios**
  (M1 `script-words.ts`, M2 `design-rules.ts`, M3 `suggestions-rules.ts`, con su test) y una línea
  `export *` al final de `index.ts` tras releerlo. Si un módulo necesita cambiar un esquema del Paso 0,
  lo pide en su doc de módulo («Pedidos cruzados») y lo hace la integración.
- **Archivos con dueño y bloques ajenos** `BEGIN sprint6:<M> … END sprint6:<M>` (TS `// …`, TSX
  `{/* … */}`, Python `# …`), insertados tras releer y sin tocar otras líneas:
  - `apps/api/src/services/ffmpeg/timeline.ts` (M1: fundidos de empalme) ← M2: la línea del filtro
    `subtitles=subs.ass` (agrega `fontsdir`).
  - `apps/web/src/components/panels/SubtitlesPanel.tsx` (M2) ← M1: el handler de edición de texto de un
    segmento (hoy `words: undefined`, ~`:396-401`) pasa a `fixWords(...)` (H11).
  - `apps/web/src/components/panels/index.ts` y `apps/web/src/lib/layout.ts` (M2) ← M1: registrar el
    panel `script` («Guion»); ← M3: registrar `suggestions` si no va dentro del Asistente.
  - `apps/api/src/routes/media.ts` (M3) ← nadie más.
  - `apps/api/src/services/agent/resolve.ts` y `jobs/handlers/agent.ts` (M1): los `case` de las ops
    nuevas los reemplaza M1; M3 no los edita (sus planes pasan por `resolvePlan` sin cambios).
- `lib/api.ts` (web) no se toca: clientes en archivos propios (`lib/api-script.ts` M1,
  `lib/api-design.ts` M2, `lib/api-suggestions.ts` M3).
- E2E: `scripts/e2e/run-e2e.mjs` (antes de `const required = results.filter(`),
  `scripts/e2e/ui-smoke.mjs` (antes de `await browser.close();`),
  `scripts/e2e/workers-with-mocks.py` (antes de `settings = get_settings()`): un bloque
  `BEGIN/END sprint6:<M>` por módulo. `scripts/e2e/design-check.mjs` es nuevo y de M2.
- Manual, `ARQUITECTURA.md`, `CLAUDE.md` (lista de ops del EditPlan), `NOTICE.md` (fuentes OFL):
  borrador en `docs/trabajo/modulo-sprint6-<guion|diseno|sugerencias>.md` («## Borrador manual §NN»);
  los pega la integración.

### Paso 0 (un commit `feat(shared): sprint 6 contracts` antes de lanzar)
Archivos nuevos en `packages/shared/src`: `design.ts`, `script.ts`, `suggestions.ts`; aditivos en
`agent.ts` (3 ops), `api.ts` (rutas, `SPRINT6_ERRORS`), `ai.ts` (`ApplyCutsRequest`,
`WORKER_TASK_ROUTES`), `job.ts` (2 tipos), `subtitles.ts`, `timeline.ts`, `style.ts`, `texts-es.ts`,
`hotkeys.ts` (`SCRIPT_HOTKEYS` aparte), `index.ts`; `pnpm --filter @studio/shared export-schemas`
(EditPlan y StylePreset). api: carril `background` (`jobs/types.ts`, `queue.ts`, `state.ts`), rutas
`routes/{script,design,suggestions}.ts` con 501 `NOT_IMPLEMENTED` y el módulo, registradas en
`routes/index.ts`; `case` de las 3 ops en `resolve.ts` (pregunta «todavía no disponible») y en
`handlers/agent.ts` (`OpError`); etiquetas de job (`reports/markdown.ts`, web `jobs-store.ts`,
`PersonsTab.tsx` si lo exige `tsc`) y de op (web `lib/agent.ts`). workers: `task_schema.py` (modelos y
`SPRINT6_TASKS`), `errors.py` (`NOT_IMPLEMENTED` 501), stubs `POST /transcribe/words` y
`POST /analyze/suggest`; `scripts/agent/validate-dataset.py` con `PENDING_OPS` (las 3 ops nuevas no
exigen cobertura de dataset ni prompt hasta que M1 las saque). Tests: `sprint6-contracts.test.ts`,
`test_task_schema_sprint6.py`, `sprint6-stubs.test.ts` (api). Todo verde: lint, typecheck, test, pytest.

## Reglas comunes
1. **UI en español rioplatense**; código, comentarios y logs en inglés; errores con causa real y acción.
   Los nombres de paneles, paquetes y acciones salen de `GLOSSARY_ES` (texts-es.ts): nadie escribe
   «Paquetes» suelto ni «Ajustes → Paquetes».
2. **Ningún job sin `detail`** (contrato Sprint 5): `script.transcribe` reporta segundos transcriptos
   (`unit:"seconds"`), `suggest.analyze` reporta etapa («Midiendo silencios y volumen»), ambos
   cancelables hasta el worker.
3. **Un gesto = un paso de deshacer** (borrar palabras, quitar seguras, corregir una palabra, aplicar el
   kit a un proyecto, aplicar una sugerencia).
4. **Nada se aplica solo**: sugerencias y `fit_duration` proponen; el usuario aplica. Lo que quita
   contenido (oraciones) pide confirmación (CLAUDE.md regla 3).
5. **Tokens, no valores sueltos**: ningún tamaño, color, tipografía, margen o duración de texto en
   pantalla nuevo fuera de `DesignTokens`/`BrandKit` (M2 lo verifica con un test que busca colores
   `#rrggbb` nuevos en plantillas y ASS).
6. **Sin red en renders y en CI**: fuentes empaquetadas; Whisper y FFmpeg simulados donde no hay.
7. Errores: api `ApiError {error:{code,message,details?}}`; workers `{detail, code}`; stubs 501
   `NOT_IMPLEMENTED` con `details.module` (`"M1 Guion"`, `"M2 Sistema de diseño"`, `"M3 Sugerencias"`).

## Contratos compartidos (Paso 0)

```ts
// ---- design.ts (nuevo) — M2 implementa la lógica en design-rules.ts --------------------------------
export const DESIGN_ASPECTS = ["9:16", "1:1", "16:9"] as const;  DesignAspectSchema = z.enum(DESIGN_ASPECTS)
export const HexColorSchema = z.string().regex(/^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i)       // #rrggbb o #rrggbbaa
export const BUNDLED_FONT_FAMILIES = ["Inter","Montserrat","Poppins","Roboto","Oswald","Playfair Display",
  "Bebas Neue","Anton","Archivo Black","Bangers"] as const;   // = FONT_FAMILIES de @studio/remotion (test de M2)
export const BUNDLED_FONT_WEIGHTS = [400, 700, 900] as const;
export const FONTS_DIR_REL = "packages/remotion/public/fonts";       // desde la raíz del repo; GET /fonts/* lo sirve
export const FontTokenSchema = z.object({ family: z.enum(BUNDLED_FONT_FAMILIES), weight: z.union(400|700|900) }).strict()
export const SafeZoneSchema = z.object({ top, bottom, left, right: z.number().min(0).max(45) }).strict()  // % del lienzo
export const CaptionRulesSchema = z.object({
  max_lines: z.union([z.literal(1), z.literal(2)]).default(2),
  max_chars_line: z.object({ "9:16": int 12..60 = 30, "1:1": = 34, "16:9": = 42 }).strict(),
  size_pct_short_side: z.number().min(3).max(12).default(6),        // tamaño por defecto
  min_size_pct_short_side: z.number().min(3).max(10).default(4.5),  // regla dura
  outline_pct_size: z.number().min(0).max(20).default(8),
  box_min_alpha: z.number().min(0).max(1).default(0.6),
  min_contrast: z.number().min(3).max(21).default(7),               // texto vs contorno o caja
  min_duration_s: 0.3..2 = 0.83,  max_duration_s: 2..10 = 7,  max_cps: 10..30 = 17,
  page_break_pause_ms: 100..2000 = 300,
}).strict()
export const TitleRulesSchema = z.object({ min_duration_s = 1.5, s_per_word = 0.35, extra_s = 0.7,
  lower_third_min_s = 3 }).strict()
export const MotionTokensSchema = z.object({ transition: z.enum(STYLE_TRANSITION_TYPES).default("fade"),
  transition_s: 0.1..2 = 0.3, enter_ms: 100..1500 = 350, exit_ms: 100..1500 = 250,
  easing: z.enum(["ease-out","ease-in-out","linear","spring"]).default("ease-out") }).strict()
export const ColorTokensSchema = z.object({ text, text_outline, accent, plate: HexColorSchema,
  palette: z.array(HexColorSchema).min(2).max(8) }).strict()
export const DesignTokensSchema = z.object({ version: z.literal(1), color: ColorTokensSchema,
  font: z.object({ title, caption, body, display: FontTokenSchema }).strict(),
  caption: CaptionRulesSchema, title: TitleRulesSchema,
  safe_zone: z.object({ "9:16", "1:1", "16:9": SafeZoneSchema }).strict(), motion: MotionTokensSchema }).strict()
export const DEFAULT_DESIGN_TOKENS: DesignTokens  // texto #FFFFFF, contorno #000000, acento #FFD400, plate #000000B3;
  // title Montserrat 900, caption Inter 900, body Inter 400, display Anton 400;
  // safe_zone 9:16 {15,35,11,11}, 1:1 {5,8,5,5}, 16:9 {5,10,5,5}
export const BrandLogoPositionSchema = z.enum(["top-left","top-right","bottom-left","bottom-right"])
export const BrandKitSchema = z.object({ id: z.literal("default"), name: z.string().trim().min(1).max(80),
  logo_asset_id: IdSchema.nullable(), logo_position: BrandLogoPositionSchema.default("top-right"),
  logo_opacity: z.number().min(0.2).max(1).default(0.9), logo_scale_pct: z.number().min(4).max(30).default(12),
  tokens: DesignTokensSchema,
  calibration: z.object({ aspect: DesignAspectSchema, screenshot_asset_id: IdSchema.optional(),
    calibrated_at: TimestampSchema }).strict().optional(),
  updated_at: TimestampSchema.optional() }).strict()
export const BrandKitUpdateSchema = z.object({ name?, logo_asset_id?, logo_position?, logo_opacity?, logo_scale_pct?,
  tokens?, calibration? }).strict()   // PUT: reemplaza solo lo enviado, sin defaults
export const DEFAULT_BRAND_KIT: BrandKit   // name «Mi canal», sin logo, tokens por defecto
export const DESIGN_RULE_IDS = ["caption.max_lines","caption.chars_per_line","caption.min_size",
  "caption.outline_or_box","caption.contrast","caption.safe_zone","caption.timing",
  "title.safe_zone","title.duration","brand.consistency"] as const;     // exactamente 10 (criterio C2)
export const DesignRuleSeveritySchema = z.enum(["hard", "guide"])
export const DESIGN_RULES: readonly { id; severity; label_es; help_es }[]   // 8 hard (caption.* + title.safe_zone), 2 guide
export const DesignIssueSchema = z.object({ rule: z.enum(DESIGN_RULE_IDS), severity,
  target: z.object({ kind: z.enum(["caption","motion","text"]), clipId: IdSchema.optional(),
    segmentIndex: z.number().int().nonnegative().optional(), t_s: SecondsSchema.optional() }).strict(),
  message_es: z.string().max(300), autofix: z.boolean(), measured: z.number().optional(), limit: z.number().optional() }).strict()
export const DesignCheckRequestSchema = z.object({ projectId: IdSchema, aspect: DesignAspectSchema.optional(),
  fix: z.boolean().default(false) }).strict()          // fix: aplica los arreglos automáticos (un paso de deshacer en la web)
export const DesignCheckResultSchema = z.object({ aspect, rules: z.array(z.object({ id, passed: boolean, issues: int })).length(10),
  passed: int 0..10, issues: z.array(DesignIssueSchema), fixed: int, project: z.unknown().optional(), checkedAt: TimestampSchema })
export const ResolvedDesignSchema = z.object({ aspect, canvas: {w,h}, tokens: DesignTokensSchema,
  safe_zone_px: {top,bottom,left,right: number}, caption_px: { size, outline, max_chars_line, max_lines } })
export const MotionStillRequestSchema = z.object({ template: z.string().min(1), props: z.record(z.string(), z.unknown()).default({}),
  width: int 16..8192, height: int 16..8192, frame: int ≥ 0 .optional(), t_s: SecondsSchema.optional(),
  format: z.enum(["png","jpeg"]).default("png"), brand: z.boolean().default(true),
  background_asset_id: IdSchema.optional() }).strict()   // fotograma del video detrás («cómo quedará»)
// (M2 implementa en design-rules.ts:) contrastRatio(a,b): number · resolveDesign(tokens, canvas): ResolvedDesign ·
//   paginateCaptions(words, rules, aspect): {text, lines:[string,string?], start, end, words}[] ·
//   captionStyleFromTokens(tokens, preset?): CaptionStyle · checkDesign(project, kit, aspect): DesignCheckResult ·
//   autofixCaptionStyle(style, resolved): CaptionStyle · toDtcg(tokens): Record<string, unknown> (opcional)

// ---- script.ts (nuevo) — M1 implementa la lógica en script-words.ts --------------------------------
export const FillerLevelSchema = z.enum(["safe", "probable", "doubtful"])          // seguro / probable / dudoso
export const FillerCategorySchema = z.enum(["vocalization","empty_connector","closing_tag","wildcard",
  "repetition","false_start","acoustic"])
export const ScriptFillerSchema = z.object({ category, level, confidence: z.number().min(0).max(1),
  reason_es: z.string().max(160) }).strict()
export const WordSchema = z.object({
  id: z.string().regex(/^\d+:\d+$/),        // "<segmento>:<palabra>" (las pausas van aparte, ScriptPauseSchema)
  text: z.string(), norm: z.string(),       // norm: minúsculas, sin puntuación ni tildes (diff y léxico)
  start: SecondsSchema, end: SecondsSchema, // línea de tiempo
  probability: z.number().min(0).max(1).optional(), segment: z.number().int().nonnegative(),
  filler: ScriptFillerSchema.optional(), corrected: z.boolean().optional(),
  harsh: z.boolean().optional() }).strict()  // «evitar corte brusco»: hueco < 30 ms o prob. < 0,4
export const ScriptPauseSchema = z.object({ kind: z.literal("pause"), after: z.string() /* id de palabra */,
  start, end, long: z.boolean() }).strict()
export const ScriptSchema = z.object({ version: z.literal(1), projectId: IdSchema, language: z.string(),
  words: z.array(WordSchema), pauses: z.array(ScriptPauseSchema),
  stats: z.object({ words: int, duration_s: number, long_pauses: int,
    fillers: z.object({ safe, probable, doubtful: int }).strict() }).strict(),
  audio: z.object({ jobId: IdSchema, noise_floor_db: z.number() }).strict().optional(),   // sin esto: sin huecos acústicos
  stale: z.boolean().default(false) }).strict()       // los subtítulos ya no calzan con la línea de tiempo
export const SCRIPT_RULES = { pause_long_ms: 600, pause_target_ms: 250, natural_pause_max_ms: 400,
  cut_pad_max_ms: 60, energy_search_ms: 60, energy_window_ms: 5, min_cut_ms: 40, join_fade_ms: 12,
  join_fade_max_ms: 15, harsh_gap_ms: 30, harsh_probability: 0.4, acoustic_min_ms: 250,
  acoustic_db_over_floor: 10, sentence_pause_ms: 700, paragraph_pause_ms: 1500,
  corrected_min_word_ms: 80, insert_max_gap_ratio: 0.6, fit_tolerance_s: 0.5, fit_max_speed: 1.1,
  fit_min_confidence: 0.6 } as const
export const FILLER_LEXICON_ES: readonly { text: string; category; level; needs_pause?: boolean; reason_es }[]
  // «eh», «ehh», «em», «mm», «ah» (vocalization, safe) · «o sea», «digamos» (empty_connector, probable) ·
  // «este», «bueno» (probable, needs_pause) · «¿no?», «¿viste?», «¿entendés?», «¿sí?» (closing_tag, doubtful) ·
  // «tipo», «nada», «literal», «básicamente», «mirá», «dale» (wildcard, doubtful)
export const ScriptTranscribeRequestSchema = z.object({ clipId: IdSchema, model: WhisperModelSchema.optional(),
  language: z.string().default("es"), keepFillers: z.boolean().default(true) }).strict()
export const ScriptCutsRequestSchema = z.object({ wordIds: z.array(z.string()).max(2000).optional(),
  ranges: z.array(CutRangeSchema /* línea de tiempo */).max(500).optional(),
  fillers: FillerLevelSchema.or(z.literal("all")).optional(), shortenLongPauses: z.boolean().optional(),
  avoidHarsh: z.boolean().default(true) }).strict().refine(algo)       // al menos uno
export const ScriptCutSchema = z.object({ start, end /* línea de tiempo */, fade_ms: int 0..30,
  reason: z.enum(["words","filler","pause","sentence"]) }).strict()   // los omitidos van en `skipped`
export const ScriptCutsResponseSchema = z.object({ cuts: z.array(ScriptCutSchema), removed_s: number,
  skipped: z.array(z.object({ wordId: z.string(), reason_es: z.string() })) })
export const FitLevelSchema = z.enum(["pauses","fillers_safe","fillers_other","sentences","speed"])
export const FitDurationRequestSchema = z.object({ target_s: z.number().min(3).max(3600),
  tolerance_s: z.number().min(0).max(5).default(0.5), allow_speedup: z.boolean().default(false),
  max_speed: z.number().min(1).max(1.25).default(1.1), allow_sentences: z.boolean().default(false) }).strict()
export const FitDurationPreviewSchema = z.object({ from_s, to_s: number, reached: z.boolean(),
  groups: z.array(z.object({ level: FitLevelSchema, removed_s: number, count: int, label_es: string })),
  cuts: z.array(ScriptCutSchema), speed: z.number().optional(), question_es: z.string().optional(),
  plan: EditPlanSchema.optional() })        // listo para studio_validate_plan / Asistente
export const WorkerSttWordsRequestSchema = z.object({ input_path: z.string(), language: z.string().default("es"),
  model: z.string().optional(), job_id: z.string().optional(), clip_in_s: SecondsSchema.optional(),
  clip_out_s: SecondsSchema.optional(), output_base: z.string(),   // "renders/<jobId>" → transcript.json + script-audio.json
  hallucination_silence_threshold: z.number().positive().default(2) }).strict()
export const ScriptAudioSchema = z.object({ noise_floor_db: z.number(), window_ms: z.literal(5),
  rms_db_path: z.string(),          // Float32 LE, una muestra cada 5 ms (STORAGE_DIR-relativo)
  gaps: z.array(z.object({ start, end, rms_db: z.number(), voiced: z.boolean() })) }).strict()
export const WorkerSttWordsResultSchema = z.object({ transcript: TranscriptSchema, audio: ScriptAudioSchema })
// (M1 implementa en script-words.ts:) buildScript(project, audio?) · detectFillers(words, pauses, audio?) ·
//   planWordCuts(script, req) · fitDuration(script, req) · fixWords(words, oldText, newText): SubtitleWord[] ·
//   normWord(text)

// ---- suggestions.ts (nuevo) — M3 implementa la lógica en suggestions-rules.ts ----------------------
export const SuggestionKindSchema = z.enum(["silences", "low_voice", "clipping"])   // S7: scenes, reframe, captions
export const SuggestionStatusSchema = z.enum(["open", "applied", "dismissed", "stale"])
export const ImportAnalysisSchema = z.object({ assetId: IdSchema, params_version: z.number().int().positive(),
  file_sig: z.object({ size: int, mtime_ms: number }).strict(), duration_s: number,
  noise_floor_db: number, silence_threshold_db: number, silences: z.array(CutRangeSchema).max(2000),
  lufs_i: number.nullable(), lra: number.nullable(), true_peak_db: number.nullable(),
  analyzed_at: TimestampSchema }).strict()
export const ImportSuggestionSchema = z.object({ id: IdSchema, projectId: IdSchema, assetId: IdSchema,
  clipIds: z.array(IdSchema).min(1), kind: SuggestionKindSchema, status: SuggestionStatusSchema,
  title_es: z.string().min(1).max(120), detail_es: z.string().max(300),
  impact: z.object({ seconds_saved?, count?, lufs?, target_lufs?, gain_db?, true_peak_db? }).strict(),
  evidence: z.object({ ranges: z.array(CutRangeSchema).max(200).optional() }).strict().optional(),
  plan: EditPlanSchema, params_version: int, created_at, updated_at: TimestampSchema }).strict()
export const SUGGESTION_THRESHOLDS = { params_version: 1, silence_rel_db: 9, silence_db_min: -50, silence_db_max: -30,
  silence_min_ms: 500, offer_ratio: 0.08, offer_min_s: 5, offer_min_count: 3, low_voice_lufs: -24,
  target_lufs: -14, clipping_true_peak_db: -1, max_cards: 4, max_parallel_imports: 3, long_video_s: 1800,
  background_priority: -10 } as const
export const SuggestionsResponseSchema = z.object({ suggestions: z.array(ImportSuggestionSchema),
  analyzing: z.array(IdSchema) /* assetIds con suggest.analyze activo */ })
export const SuggestionDismissRequestSchema = z.object({ muteKind: z.boolean().default(false) }).strict()   // «No sugerir más»
export const SuggestionSettingsSchema = z.object({ enabled: z.boolean().default(true),
  mutedKinds: z.array(SuggestionKindSchema).default([]) }).strict()
export const SuggestAnalyzePayloadSchema = z.object({ assetId: IdSchema, projectId: IdSchema.optional(),
  force: z.boolean().default(false) }).strict()
export const MediaAnalyzeRequestSchema = SuggestAnalyzePayloadSchema.omit({ assetId })   // body de POST /api/media/:id/analyze
export const WorkerSuggestAnalyzeResultSchema = z.object({ duration_s, noise_floor_db, silence_threshold_db,
  silences: [number, number][] /* s de fuente */, lufs_i, lra, true_peak_db: number|null })
export const WorkerSuggestAnalyzeRequestSchema = z.object({ input_path: z.string(), job_id: z.string().optional(),
  silence_min_ms: int = 500, silence_rel_db: number = 9, priority: z.number().int().default(5) }).strict()
// (M3 implementa en suggestions-rules.ts:) suggestionsFromAnalysis(analysis, project, asset): ImportSuggestion[] (sin id/fechas)

// ---- agent.ts (aditivo): 3 ops nuevas (EditOpSchema += ..., EDIT_OP_NAMES = 26) ---------------------
DeleteWordsOpSchema  { op:"delete_words", ranges?: [{start, end}] (línea de tiempo, máx. 200),
  text?: string 1..80 (todas las apariciones exactas, sin distinguir mayúsculas ni tildes),
  fillers?: "safe"|"probable"|"all", long_pauses?: boolean (acortar a 250 ms), ...common } refine: al menos uno
FitDurationOpSchema  { op:"fit_duration", target_s: 3..3600, tolerance_s?: 0..5, allow_speedup?: boolean,
  allow_sentences?: boolean, ...common }
FixTextOpSchema      { op:"fix_text", find: string 1..200, replace: string 0..200, all?: boolean,
  at?: Time (el subtítulo de ese momento), ...common }
// ALWAYS_CONFIRM_OPS no cambia; el resolver de M1 fuerza confirm:true en fit_duration con allow_sentences
// y en delete_words que quite > 20 % de la duración (riesgo «Quita partes del video»).

// ---- ai.ts (aditivo) ------------------------------------------------------------------------------
// ApplyCutsRequestSchema += mode: z.enum(["clip","timeline"]).default("clip"),   // timeline: cuts en s de la línea
//   de tiempo, ripple de todas las pistas sin bloquear (= rippleDelete con syncTrackId); clipId = pista principal
//   joinFadeMs: z.number().int().min(0).max(30).optional()                        // Clip.audioFade en cada empalme
// WORKER_TASK_ROUTES += transcribe: "/transcribe/tasks/:id", analyze: "/analyze/tasks/:id"

// ---- job.ts (aditivo) -----------------------------------------------------------------------------
// JobTypeSchema += "script.transcribe" (workers /transcribe/words + /transcribe/tasks/{id}) ,
//                  "suggest.analyze" (workers /analyze/suggest + /analyze/tasks/{id}, carril background)

// ---- subtitles.ts / timeline.ts / style.ts (aditivos, todos opcionales) ---------------------------
// SubtitleWordSchema += corrected: z.boolean().optional()
// CaptionStyleSchema += outlineColor?: string, outlineWidth?: number 0..40 (px a 1080 de alto), box?: boolean,
//                       maxLines?: 1|2, fromBrandKit?: boolean (ausente = sí: los tokens mandan)
// ClipSchema += audioFade: z.object({ inMs: int 0..200, outMs: int 0..200 }).strict().optional()
// ProjectSettingsSchema: width/height .max(8192) (MEJORAS B7)
// StylePreset (presetFields) += use_brand_kit: z.boolean().optional()   // ausente = sí

// ---- api.ts (aditivo) -----------------------------------------------------------------------------
// API_ROUTES += script "/api/projects/:id/script" GET -> Script
//   scriptTranscribe "/api/projects/:id/script/transcribe" POST ScriptTranscribeRequest -> 202 JobAccepted
//   scriptCuts "/api/projects/:id/script/cuts" POST ScriptCutsRequest -> ScriptCutsResponse (no aplica)
//   scriptFit "/api/projects/:id/script/fit" POST FitDurationRequest -> FitDurationPreview (no aplica)
//   brandKit "/api/brand-kit" GET -> BrandKit | PUT BrandKitUpdate -> BrandKit
//   brandKitLogo "/api/brand-kit/logo" POST multipart `logo` -> BrandKit (PNG/JPG/SVG ≤ 5 MB)
//   designTokens "/api/design/tokens" GET ?aspect=9:16|1:1|16:9&w=&h= -> ResolvedDesign
//   designCheck "/api/design/check" POST DesignCheckRequest -> DesignCheckResult
//   motionStill "/api/motion/still" POST MotionStillRequest -> image/png|image/jpeg
//   fonts "/fonts/*" GET archivos de FONTS_DIR_REL (woff2/ttf/OFL.txt, cache inmutable)
//   suggestions "/api/projects/:id/suggestions" GET -> SuggestionsResponse
//   suggestionPlan "/api/projects/:id/suggestions/:sid/plan" POST -> AgentPlanRecord (validado y resuelto)
//   suggestionDismiss "/api/projects/:id/suggestions/:sid/dismiss" POST SuggestionDismissRequest -> ImportSuggestion
//   mediaAnalyze "/api/media/:id/analyze" POST {projectId?, force?} -> 202 JobAccepted (suggest.analyze)
//   suggestionSettings "/api/suggestions/settings" GET | PUT SuggestionSettings
// SPRINT6_ERRORS (abajo) + formatErrorEs acepta Sprint6ErrorCode.

// ---- texts-es.ts (aditivo) ------------------------------------------------------------------------
// GLOSSARY_ES (paneles, acciones, paquetes: «Guion», «Kit de marca», «Sugerencias», «Paquetes de IA»…),
// FILLER_LEVEL_ES {safe:«Segura», probable:«Probable», doubtful:«Dudosa»}, SCRIPT_TEXTS_ES, DESIGN_TEXTS_ES,
// SUGGESTION_TEXTS_ES (plantillas «{n} silencios largos = {s} s de {total}», «La voz está baja ({lufs} LUFS)…»),
// UI_ENGLISH_DENYLIST (términos prohibidos visibles: "bottom-left", "slide", "fade", "Lower third", "Motion Canvas",
//   "ProRes", "rmvpe", "Feature index"… → M2 los traduce y su test lo exige), NOT_IMPLEMENTED_ES.

// ---- hotkeys.ts (aditivo) -------------------------------------------------------------------------
// HotkeyScopeSchema += "script"; HotkeyGroup += "Guion";
// SCRIPT_HOTKEYS (aparte de HOTKEYS, que sigue con 32): scope "script", solo con el foco en el panel Guion
// (el panel corta la propagación de Supr/Retroceso/Esc para que no lleguen a timeline.delete/deselect):
//   script.deleteWords  Delete     «Borra las palabras elegidas y cierra el hueco (con fundido corto)»
//   script.deleteWordsAlt Backspace «Igual que Supr»
//   script.deselect     Escape     «Quita la selección de palabras»
//   script.removeSafe   Shift+M    «Quita todas las muletillas seguras (un paso de deshacer)»
//   script.nextFiller   Period (.) «Salta a la siguiente muletilla o pausa larga»   (N ya es el imán)
//   script.prevFiller   Comma (,)  «Vuelve a la muletilla o pausa larga anterior»
//   script.fixWord      F2         «Corrige el texto de la palabra elegida sin mover los tiempos»
// No se agregan a Ajustes → Atajos en este sprint (fijos; los documenta el panel y el manual).
```

```py
# ---- apps/workers/studio_workers/task_schema.py (aditivo) ----
class SttWordsRequest(BaseModel):            # POST /transcribe/words -> {task_id}   (M1)
    input_path: str; language: str = "es"; model: str | None = None; job_id: str | None = None
    clip_in_s: float | None = None; clip_out_s: float | None = None; output_base: str
    hallucination_silence_threshold: float = 2.0
class AudioGap(BaseModel): start: float; end: float; rms_db: float; voiced: bool
class ScriptAudio(BaseModel): noise_floor_db: float; window_ms: Literal[5] = 5; rms_db_path: str; gaps: list[AudioGap]
class SuggestAnalyzeRequest(BaseModel):      # POST /analyze/suggest -> {task_id}   (M3)
    input_path: str; job_id: str | None = None; silence_min_ms: int = 500; silence_rel_db: float = 9.0; priority: int = 5
class SuggestAnalyzeResult(BaseModel):
    duration_s: float; noise_floor_db: float; silence_threshold_db: float; silences: list[tuple[float, float]]
    lufs_i: float | None; lra: float | None; true_peak_db: float | None
TASK_PRIORITY_USER = 0; TASK_PRIORITY_BACKGROUND = 5      # M3 los usa en TaskQueue (PriorityQueue)
SPRINT6_TASKS: dict[str, TaskSpec]   # "stt.words" (M1, área transcribe, unidad seconds), "suggest.analyze" (M3, área analyze, stage)
```

### Códigos de error nuevos (`SPRINT6_ERRORS`)
| HTTP | Código | Mensaje (plantilla) | Módulo |
| --- | --- | --- | --- |
| 501 | `NOT_IMPLEMENTED` | «Todavía no está disponible ({modulo}).» `details.module` | Paso 0 (stubs) |
| 409 | `SCRIPT_EMPTY` | «El proyecto no tiene guion: transcribí el video primero (Guion → Transcribir).» | M1 |
| 409 | `SCRIPT_STALE` | «El guion no coincide con la línea de tiempo (cambió después de transcribir). Volvé a transcribir o deshacé el último cambio.» | M1 |
| 422 | `SCRIPT_NOTHING_TO_CUT` | «No hay nada para cortar con esa selección (los huecos son muy cortos o son cortes bruscos).» | M1 |
| 400 | `BRAND_LOGO_INVALID` | «El logo tiene que ser PNG, JPG o SVG de hasta 5 MB.» | M2 |
| 400 | `FONT_NOT_BUNDLED` | «La tipografía «{familia}» no viene con Studio. Elegí una de la lista.» | M2 |
| 503 | `STILL_UNAVAILABLE` | «No se pudo generar la vista previa ({motivo}).» `details.reason` del motor | M2 |
| 404 | `SUGGESTION_NOT_FOUND` | «Esa sugerencia ya no existe.» | M3 |
| 409 | `SUGGESTION_STALE` | «El clip cambió desde el análisis: volvé a analizarlo (Medios → Analizar).» | M3 |
| — | `DESIGN_AUTOFIXED` (aviso en `ExportJobResult.warnings`) | «Ajusté {n} subtítulos/títulos para que cumplan las reglas de diseño.» | M2 |

## M1. Guion editable por palabras (agente «guion»)

**Rutas propias**: `packages/shared/src/script-words.ts` (+ `test/script-words.test.ts`); api
`routes/script.ts` (reemplaza el stub), `services/script/**` (nuevo), `jobs/handlers/script.ts` (nuevo,
registro en `jobs/handlers/index.ts` en bloque `sprint6:M1`), `services/agent/resolve.ts` y
`jobs/handlers/agent.ts` (cases de `delete_words`, `fit_duration`, `fix_text`),
`services/timeline-edit.ts` (`mode:"timeline"`, `joinFadeMs`), `services/ffmpeg/timeline.ts` (dueño;
fundidos de empalme con `Clip.audioFade`, `afade=t=in|out:curve=qsin`); workers `routers/transcribe.py`
(`/transcribe/words`, `/transcribe/tasks/{id}`, `/cancel`), `stt/**` (pedido con `vad_filter=False`,
`hallucination_silence_threshold`, envolvente RMS de 5 ms con numpy y huecos), `agent/prompts/system_es.md`,
`agent/dataset/**`, `agent/eval.py` (`KEY_ARGS` de las 3 ops), `scripts/agent/validate-dataset.py`
(saca `PENDING_OPS`); web `components/panels/ScriptPanel.tsx` (nuevo), `stores/script-store.ts` (nuevo),
`lib/{script,api-script}.ts` (nuevos), bloques en `SubtitlesPanel.tsx`, `panels/index.ts`, `lib/layout.ts`.

**Workers `stt.words`** (`POST /transcribe/words` `SttWordsRequest` → `{task_id}`; área `transcribe` del
`TaskQueue` de M3 con prioridad usuario): faster-whisper `word_timestamps=True`, `vad_filter=False`,
`hallucination_silence_threshold=2.0`, `condition_on_previous_text=False`; progreso
`set_items(segundos_transcriptos, duración, "Transcribiendo palabras · 1:20 de 3:05")`; revisa
`cancel_event` entre segmentos (`TaskCanceled` → `canceled`, libera el modelo como hoy); después extrae
el WAV mono 16 kHz que ya usa, calcula RMS en dB cada 5 ms → `renders/<jobId>/script-rms.f32` y los
huecos entre palabras (≥ 30 ms) con `rms_db` medio y `voiced = rms_db ≥ piso + 10 dB` (piso = percentil
10 de ventanas de 50 ms). Resultado: `WorkerSttWordsResult` (también en `<output_base>/transcript.json`
y `script-audio.json`). Sin GPU disponible cae a CPU con el aviso de siempre.

**api**: job `script.transcribe` (carril `workers`): toma `clip.in/out` y el asset, llama
`/transcribe/words`, sondea con `pollWorkerTask("transcribe", …)`, convierte tiempos de fuente a línea
de tiempo (como `subtitles.transcribe`), reemplaza `project.subtitles` del tramo del clip (un paso de
deshacer: la web recarga el proyecto y empuja su instantánea) y registra el artefacto de audio en la
tabla propia `script_audio (project_id, clip_id, job_id, path, noise_floor_db, created_at)` (no en el
proyecto). `GET …/script` arma
`ScriptSchema` con `buildScript` (+ `stale` si la suma de duraciones de clips cambió sin pasar por
cortes de guion). `POST …/script/cuts`: `planWordCuts` + afinado por energía (lee el `.f32`; sin él,
sin afinado) → `ScriptCutsResponse`. `POST …/script/fit`: `fitDuration` → `FitDurationPreview` con
`plan` (ops `delete_words {ranges}` + `set_speed` opcional). Errores `SCRIPT_EMPTY`, `SCRIPT_STALE`,
`SCRIPT_NOTHING_TO_CUT`.

**Ops del EditPlan**: `delete_words` → `POST cuts` interno + `timeline.apply-cuts {mode:"timeline",
joinFadeMs: 12}`; preview «Quitar 8 muletillas seguras (−3,4 s)»; `fit_duration` → preview «62,4 s →
45,2 s: −6,1 s en 9 pausas, −2,4 s en 8 muletillas» (pregunta si no llega); `fix_text` → aplica
`fixWords` al/los segmento(s) (sin cortar) y avisa «3 palabras con tiempos estimados». Sin guion →
`Unresolved` «Primero transcribí el video (Guion → Transcribir)».

**Web «Guion»** (panel nuevo, pestaña junto a Subtítulos): palabras como `<span>` con foco por teclado;
clic = mover el cabezal; arrastre o Mayús+clic = rango; `Supr` = `POST cuts` → `rippleDelete` sincronizado
local (todas las pistas sin bloquear, subtítulos corridos, `audioFade` en los empalmes) en **un** paso de
deshacer; resaltado: muletilla segura (fondo ámbar), probable (subrayado ámbar), dudosa (subrayado
punteado gris), pausa larga (chip «0,9 s»), palabra corregida (borde punteado), corte brusco omitido (⚠);
barra: «Quitar seguras (8)», «Revisar dudosas (4)» (`.` / `,`), «Acortar pausas largas (9)», campo
«Dejalo en __ s» → vista previa (grupos destildables) → «Aplicar» (pasa por el Asistente como plan, queda
en el historial y «Deshacer todo»). `F2`/doble clic: corregir palabra o frase (`fixWords`). Contador en
vivo («23 pausas > 0,6 s»). Estado vacío: «Transcribí el video para editarlo como texto» + botón
(deshabilitado con motivo vía `useAiAvailability("workers")`). Tooltips en `lib/tooltips.ts`
**pedidos a M2** (claves `scriptRemoveSafe`, `scriptReviewDoubtful`, `scriptShortenPauses`,
`scriptFit`, `scriptTranscribe`; M1 usa `tip="…"` y M2 las agrega).

**H11** (bloque en `SubtitlesPanel.tsx`): editar el texto de un segmento usa `fixWords` (conserva
`words` 1:1, reparte en reemplazos) y agrupa las teclas de una edición en un paso de deshacer (debounce
800 ms).

**Tests mínimos**: shared `script-words.test.ts` (léxico: «este» solo con pausa, «viste» no tras
«lo/la/me/te/ya», «tipo de» no es muletilla; repeticiones «en el en el» borra la primera; hueco
acústico ≥ 250 ms → `acoustic` safe; `planWordCuts`: corte en el medio del hueco, margen ≤ 60 ms, < 40 ms
no corta, `harsh` omitido; `fixWords`: equal conserva, replace reparte por letras ≥ 80 ms, insert ≤ 60 %,
delete deja hueco; `fitDuration`: orden de niveles, nunca a mitad de palabra, no llega → `question_es`,
tolerancia 0,5 s, no pasa del objetivo). api `script.test.ts` (transcribe con worker falso → subtítulos
con `words`; `cuts` con `.f32` sintético mueve el borde al mínimo de energía; `fit` 60 → 45 s;
`SCRIPT_EMPTY`/`STALE`), `agent-script-ops.test.ts` (las 3 ops resuelven y aplican; un deshacer),
`apply-cuts-timeline.test.ts` (`mode:"timeline"` corta todas las pistas sin bloquear, `audioFade` en
los empalmes), `ffmpeg-join-fade.test.ts` (filtro `afade` con `qsin` de 12 ms; duración igual).
workers `test_stt_words.py` (modelo falso con 40 palabras: `vad_filter=False`, progreso por segundos,
cancelar entre segmentos, `.f32` del largo correcto, huecos `voiced`). web vitest
`script-panel.test.tsx` (selección + Supr = 1 deshacer; «Quitar seguras» marca 8; F2 conserva tiempos),
`subtitles-fix.test.tsx` (H11). Dataset: ≥ 3 golden por op nueva (reemplazando para seguir en 80),
`train` ≥ 1 por op, `system_es.md` las menciona; `validate-dataset.py` OK. Mock e2e (bloque M1 en
`workers-with-mocks.py`): `/transcribe/words` falso con 12 muletillas (8 `safe` + 4 `probable`) y
huecos. E2E: «sprint6: script.transcribe (mock) → guion con 12 muletillas», «sprint6: delete_words
fillers safe → −X s y subtítulos corridos», «sprint6: fit_duration 45 s → plan válido». UI smoke:
**C1** («Sprint 6: 10 muletillas en < 1 min»), «Sprint 6: corregir una palabra conserva el karaoke».

**Solo en tu PC**: error de borde de Whisper real contra un marcado manual (5 clips, objetivo ≤ 80 ms
en el 90 %; si falla se reabre WhisperX en S7), cuántos «eh/em» detecta el hueco acústico con tu voz y
tu micrófono, C1 cronometrado sobre tu propio video, que los fundidos de 12 ms no se escuchen.

## M2. Sistema de diseño y kit de marca (agente «diseño», módulo principal)

**Rutas propias**: `packages/shared/src/design-rules.ts` (+ test); `packages/remotion/**` (fuentes
empaquetadas en `public/fonts/`, `fonts.ts` sin red, plantillas leen tokens, etiquetas y opciones en
español, fondo transparente por defecto en `title-card` — B6); `packages/motion-engines/**` (B11:
motivos en español); api `routes/design.ts` (reemplaza el stub: brand kit, tokens, check, fonts),
`routes/motion.ts` (`/api/motion/still`), `services/design/**` (nuevo: repositorio del kit en la tabla
`settings` clave `brand_kit`, `renderStill` con caché `renders/stills/<hash>.png`, LRU 200 MB),
`services/ffmpeg/ass.ts` (tokens + `paginateCaptions` + `WrapStyle 2` + `ScaledBorderAndShadow` +
`fontsdir`), bloque `sprint6:M2` en `services/ffmpeg/timeline.ts` (línea `subtitles=`),
`services/export/**` sin tocar salvo aviso `DESIGN_AUTOFIXED` (bloque en el handler de export si hace
falta: lo pide a la integración), `services/style/**` + `routes/style.ts` (`use_brand_kit`, «Guardar
como kit»); web `components/design/**` (nuevo: `BrandKitTab`, `TokenPreview`, `SafeZoneCalibrator`,
`DesignChecklist`), `components/dashboard/{SettingsDialog,AiPacksTab,DockLayout,CommandPalette}.tsx`,
`components/panels/{MotionPanel,InspectorPanel,SubtitlesPanel,VoicePanel,StylePanel}.tsx`,
`components/ui/**`, `app/globals.css`, `lib/{motion-form,voices,tooltips,layout,api-design}.ts`,
`components/panels/index.ts`, `stores/{caption-style-store,style-store,settings-store}.ts`,
`hooks/use-design.ts` (nuevo); `scripts/e2e/design-check.mjs` (nuevo);
`docs/trabajo/protocolo-mapa-calor.md` (nuevo).

**Entregables (por prioridad)**:
1. **Fuentes OFL empaquetadas** (decisión 9): TTF estáticos 400/700/900 de las 10 familias desde
   `github.com/google/fonts` (raw, OFL verificado en F§2.6) + `OFL.txt` por familia en
   `packages/remotion/public/fonts/<Familia>/`; `fonts.ts` registra `FontFace` con `staticFile()`;
   la api sirve `/fonts/*` y la web declara `@font-face` (vista previa y UI de tokens); `ass.ts` usa
   `Fontname` del token y el filtro `subtitles=…:fontsdir=<abs>`. Test: ningún `googleapis` en
   `packages/remotion/src`; lista `BUNDLED_FONT_FAMILIES` = `FONT_FAMILIES`; cada familia tiene sus 3
   pesos y `OFL.txt`.
2. **Tokens + kit único**: `GET/PUT /api/brand-kit`, logo (`BRAND_LOGO_INVALID`), Ajustes → **Kit de
   marca** con vista previa en vivo (`renderStill` 9:16 y 16:9 de un subtítulo + título + rótulo sobre
   un fotograma del último video), paleta (5 colores con verificación de contraste en vivo), 4 roles
   tipográficos (solo familias empaquetadas, `FONT_NOT_BUNDLED`), zona segura con
   **«Calibrar con una captura»** (subís una captura de Reels/TikTok de tu teléfono, se superpone y
   ajustás 4 deslizadores; se guarda en `calibration`).
3. **Reglas duras de subtítulos por defecto** (decisión 7): `paginateCaptions` (máx. 2 líneas,
   caracteres por aspecto, corte en pausas ≥ 300 ms o puntuación, balanceo sin separar artículo y
   sustantivo ni preposición y término) usada por ASS **y** por `animated-captions`; tamaño, contorno o
   caja y márgenes desde `resolveDesign`; `autofixCaptionStyle` al exportar (aviso `DESIGN_AUTOFIXED`).
   Los 5 presets de `CAPTION_STYLE_PRESETS` pasan las reglas en 9:16 y 16:9 sin tocar nada (C2).
4. **Motion en español y en Propiedades** (H12, H13, B6, B11): etiquetas y opciones en español para
   todas las props (`Estilo: Barra/Caja/Subrayado/Dividido`, `Posición: Abajo a la izquierda…`,
   `Animación: Deslizar/Fundido/Barrido/Rebote`), «Avanzado» plegado (motor, formato, márgenes), motor no
   disponible = motivo en español + «Arreglar»; el formulario del template **dentro de Propiedades**
   (doble clic en el clip lo abre), vista previa con `renderStill` (debounce 400 ms, caché) y render real
   solo al exportar o al pedir «Renderizar ahora»; las plantillas leen colores, tipografías, duraciones
   de entrada/salida y zona segura del kit (props explícitas siguen mandando).
5. **StylePreset ↔ kit** (`use_brand_kit` ausente = sí): `compileStylePreset` usa tipografías, colores
   y zona segura del kit; el panel Estilo ofrece «Guardar colores y tipografías como kit» tras analizar
   una referencia.
6. **Coherencia de la UI de Studio, donde es barato**: `GLOSSARY_ES` aplicado a nombres de paneles,
   paquetes y acciones (H19: «Voz limpia» = nombre del paquete, voces «España/México», columna «Lo usa»
   con `jobLabel`), `UI_ENGLISH_DENYLIST` con test sobre los textos visibles de Motion, Propiedades y Voz;
   densidad (alturas de control 28/32 px, radios y espaciados como variables CSS en `globals.css`),
   estados (hover, foco visible, deshabilitado con motivo) uniformes en `components/ui`, íconos lucide a
   16 px en barras y 14 px en listas, estados vacíos con el mismo componente; tooltips nuevos de M1/M3.
7. **Selector de voz único** (H20): «¿Qué voz?» = Mis voces · Voces de Studio · Convertir mi grabación;
   el motor aparece solo dentro de la opción elegida; motores sin clave se ocultan (se ven en Avanzado).
8. **Medición**: `scripts/e2e/design-check.mjs` (C2) y bloque `--ux-metrics` en `ui-smoke.mjs` (C3) +
   `docs/trabajo/protocolo-mapa-calor.md` (pasos exactos, qué cuenta como clic, callejón sin salida,
   texto en inglés, cómo puntuar 1–5 cada dimensión) para que la auditoría repita el mapa de calor.

**Tests mínimos** (los más del sprint): shared `design-rules.test.ts` (contraste WCAG con casos
conocidos: #FFF/#000 = 21, #777/#FFF ≈ 4,48; `resolveDesign` 1080×1920 → tamaño 65 px y mínimo 49 px,
zona segura en px; `paginateCaptions`: nunca 3 líneas, 30/34/42 caracteres, no separa «el auto», corta
en pausa, páginas 0,83–7 s y ≤ 17 cps salvo karaoke; `checkDesign` da exactamente 10 reglas; los 5
presets pasan en 9:16 y 16:9; un estilo con 30 px y sin contorno falla 2 reglas y `autofix` las arregla),
`design-contracts.test.ts` (DEFAULT_BRAND_KIT válido, familias = remotion). remotion
`fonts-offline.test.ts` (sin `googleapis`, `FontFace` con `staticFile`), `tokens-props.test.ts` (cada
plantilla acepta tokens; sin tokens = mismo resultado que hoy), `labels-es.test.ts` (ninguna opción
visible fuera de `UI_ENGLISH_DENYLIST`). api `brand-kit.test.ts` (GET por defecto, PUT parcial, logo
inválido 400, familia inexistente 400), `design-check.test.ts` (proyecto 9:16 por defecto = 10/10;
estilo malo → issues + `fix:true` arregla), `motion-still.test.ts` (PNG con Remotion real si hay
navegador; sin navegador 503 `STILL_UNAVAILABLE` con motivo; caché: 2.º pedido sin render),
`ass-tokens.test.ts` (`Fontname`, `Fontsize` = 6 % del lado corto, `Outline` 8 %, `WrapStyle: 2`,
márgenes = zona segura, `fontsdir` en el filtro). web vitest `brand-kit-tab.test.tsx` (vista previa
pide still con debounce; contraste bajo marca el color), `inspector-motion.test.tsx` (formulario de la
plantilla en Propiedades, doble clic), `voice-picker.test.tsx` (3 opciones, motores sin clave ocultos),
`ui-language.test.tsx` (deny list en Motion/Propiedades/Voz), `tooltips.test.tsx` (claves nuevas).
E2E: «sprint6: fuentes sin red (title-card + animated-captions)» (C4), «sprint6: design-check 9:16 y
16:9 = 10/10» (C2), «sprint6: still 1080×1920 < 5 s con caché». UI smoke: «Sprint 6: Kit de marca →
cambiar acento se ve en la vista previa», «Sprint 6: editar un rótulo desde Propiedades sin
renderizar», «Sprint 6: Voz con un selector», `--ux-metrics` (C3).

**Solo en tu PC**: calibrar la zona segura con capturas reales de Reels/TikTok/Shorts (3 apps) y
guardarla en el kit; legibilidad real de los subtítulos en el teléfono; latencia de `renderStill` en
el i5 (meta < 1,5 s con caché caliente); que libass en Windows tome las fuentes de `fontsdir` con rutas
con espacios y tildes.

## M3. Sugerencias proactivas al importar (agente «sugerencias», alcance esencial)

**Rutas propias**: `packages/shared/src/suggestions-rules.ts` (+ test); api `routes/suggestions.ts`
(reemplaza el stub), `services/suggestions/**` (nuevo: tablas `import_analysis`, `suggestions`),
`jobs/handlers/suggest.ts` (nuevo, registro en `handlers/index.ts` bloque `sprint6:M3`),
**`jobs/{queue,state,types,store}.ts`** (dueño: prioridad y carril `background`), `routes/media.ts`
(encolar tras `media.probe`; P2: origen y duplicados), `routes/projects.ts` no; workers **`tasks.py`**
(dueño: `PriorityQueue`), `routers/analyze.py` + `analyze.py` (`/analyze/suggest`, `/analyze/tasks/{id}`,
`/cancel`); web `components/panels/AssistantPanel.tsx` (dueño: sección «Sugerencias» arriba del
campo de comando, H18), `components/suggestions/**` (nuevo: `SuggestionCard`), `stores/suggestions-store.ts`
(nuevo), `stores/agent-store.ts` (H18), `lib/api-suggestions.ts` (nuevo); P2: `components/panels/MediaPanel.tsx`,
`stores/{media-store,project-store}.ts`; P3: `scripts/windows/verificar-pc.{cmd,ps1}` (nuevos).

**P1 (esencial)**:
1. **Cola con prioridad** (decisión 11): workers `TaskQueue.submit(kind, target, fn, *, dedupe=True,
   priority=TASK_PRIORITY_USER)` con `queue.PriorityQueue[(priority, seq, task, fn)]` (FIFO dentro de la
   misma prioridad; la firma vieja sigue valiendo); las tareas de fondo revisan `cancel_event` cada
   ventana de audio (≤ 1 s). api: carril `background` (límite 1, ya creado en el Paso 0) y
   `priority: -10` en `enqueue`; un job del usuario nunca espera a uno de fondo (son carriles distintos).
2. **`/analyze/suggest`** (`SuggestAnalyzeRequest` → `{task_id}`, prioridad 5): una pasada FFmpeg
   `silencedetect` (umbral relativo: piso = percentil 10 de RMS en ventanas de 50 ms, `piso + 9 dB`
   acotado a [−50, −30]) + `ebur128=peak=true` (LUFS integrado, LRA, true peak), `-threads 2` y
   `BELOW_NORMAL_PRIORITY_CLASS` en Windows (`nice` en POSIX); progreso por `stage_es` y por segundos
   leídos de `-progress pipe:1`; cancelar mata el árbol del ffmpeg (`on_cancel_kill`).
3. **Job `suggest.analyze`** (carril `background`, `priority -10`): lo encola `routes/media.ts` tras el
   `media.probe` de un video/audio (si `SuggestionSettings.enabled`, máx. 3 en cola, > 30 min solo si el
   usuario lo pide); guarda `ImportAnalysis` por `(assetId, params_version, file_sig)` y no repite; sin
   workers queda `failed` con `WORKERS_UNAVAILABLE` **sin aviso** (es de fondo: el banner ya avisa).
   `suggestionsFromAnalysis` arma, para cada proyecto que usa el asset: **silencios** (si quitable ≥ 8 %
   o ≥ 5 s con ≥ 3 silencios → plan `cut_silences {clip, min_silence_ms}`), **voz baja** (LUFS < −24 →
   plan `set_volume {clip, volume_db: min(−14 − I, −1 − TP)}`), **saturado** (TP > −1 dBTP →
   `set_volume` negativo). Se marcan `stale` si el clip cambió.
4. **Tarjetas** (máx. 4, por impacto) en el Asistente: título, evidencia (mini barra con los tramos),
   «Aplicar» (→ `POST …/plan` → la vista previa normal del Asistente → aplicar; queda en el historial y
   «Deshacer todo»), «Ignorar», «No sugerir más» (silencia el tipo). Un solo aviso agregado «Analizando
   2 medios…» en el indicador de Trabajos (nunca un toast por análisis).

**P2 (deuda barata, si entra)**: H18 (al recargar, el Asistente reabre el último plan `proposed` del
proyecto), H16 (grupo «Generados» en Medios: hojas de contacto, renders motion, stems, voces; no aparecen
como «video de referencia»; subir el mismo archivo dos veces = mismo medio por sha256), B13 (los renders
motion no ofrecen «Generar proxy»), B15 (medio con probe fallido: insignia «No se pudo leer» + «Quitar»),
H25 (deshacer cubre `settings`, `captionStyle`, `publish`; últimas 20 instantáneas en `sessionStorage`).
**P3**: `verificar-pc.cmd` (deuda #14).

**Tests mínimos**: shared `suggestions-rules.test.ts` (umbrales: 3,5 s de 12 s = 29 % → silencios; 2 s
de 60 s y 2 silencios → nada; −30 LUFS → ganancia +16 dB acotada por TP; −1,0 dBTP no satura, −0,5 sí;
`stale`). workers `test_task_priority.py` (con la cola ocupada, una tarea de prioridad 0 corre antes que 3
de prioridad 5 encoladas antes; FIFO entre iguales; firma vieja), `test_suggest_analyze.py` (ffmpeg real
sobre un WAV sintético con 3 silencios y −30 LUFS: silencios ±50 ms, LUFS ±1; cancelar a mitad deja
`canceled` y mata ffmpeg). api `suggestions.test.ts` (tras `media.probe` se encola `suggest.analyze` en
`background` con prioridad −10; resultado → 2 sugerencias; `plan` válido; `dismiss` + `muteKind`;
`SUGGESTION_NOT_FOUND`/`STALE`; no repite con el mismo `file_sig`), `queue-background.test.ts` (un
`subtitles.transcribe` arranca mientras corre un `suggest.analyze`). web vitest `suggestions.test.tsx`
(4 tarjetas máx., «Aplicar» abre el plan, «Ignorar» la saca). Mock e2e (bloque M3): `/analyze/suggest`
falso que tarda 2 s. E2E **C5**: «sprint6: importar → 2 sugerencias en < 15 s», «sprint6: transcribir
no espera al análisis de fondo», «sprint6: aplicar sugerencia de silencios → plan aplicado + deshacer».
UI smoke: «Sprint 6: tarjeta de voz baja → Aplicar → −14 LUFS en el plan».

**Solo en tu PC**: importar 3 videos de 10 min en el i5 con la línea de tiempo en uso (sin trabas;
ffmpeg en «debajo de lo normal» en el Administrador de tareas); piso de ruido real de tu micrófono.

## Costuras previsibles entre módulos
| # | Costura | Módulos | Cómo se evita |
| - | ------- | ------- | ------------- |
| 1 | `paginateCaptions` (M2) vs agrupación de palabras del Guion (M1) | M1 ↔ M2 | Funciones distintas sobre las mismas `words`: el Guion agrupa en oraciones/párrafos para leer; los subtítulos los pagina M2. M1 nunca escribe `CaptionStyle` ni ASS. |
| 2 | Borrar palabras corre los subtítulos; los subtítulos re-paginados por M2 | M1 ↔ M2 | M1 corre `words` y `start/end` de segmentos (ripple de siempre); M2 pagina al generar (ASS/Remotion), nunca guarda páginas en el proyecto. |
| 3 | `SubtitlesPanel.tsx` lo editan los dos | M1 ↔ M2 | Dueño M2; M1 solo el bloque `sprint6:M1` del handler de texto (H11). |
| 4 | `services/ffmpeg/timeline.ts`: fundidos (M1) y `fontsdir` (M2) | M1 ↔ M2 | Dueño M1; M2 solo la línea `subtitles=` en su bloque. |
| 5 | Prioridad de la cola de workers que usa la tarea `stt.words` | M1 ↔ M3 | M3 es dueño de `tasks.py`; `submit` conserva la firma (prioridad por defecto = usuario); M1 no la toca. |
| 6 | Tarjetas de sugerencia (M3) generan planes con ops de M1 | M1 ↔ M3 | M3 usa solo `cut_silences` y `set_volume` (existentes); cuando M1 termine, una tarjeta «Quitar muletillas» queda para S7. |
| 7 | Tooltips nuevos de M1/M3 en `lib/tooltips.ts` (M2) | M1/M3 → M2 | M1/M3 listan sus claves en su doc; M2 las agrega con el texto; la integración revisa. Mientras tanto, `tip="clave"` inexistente cae al `aria-label` (no rompe `tsc` si se usa `title`). |
| 8 | Panel «Guion» y «Sugerencias» en el layout (`lib/layout.ts`, `panels/index.ts`, M2) | M1/M3 → M2 | Bloques `sprint6:M1`/`sprint6:M3`; Sugerencias va dentro del Asistente (M3), así que solo M1 registra panel. |
| 9 | Kit de marca afecta el plan de un `StylePreset` y `add_captions` del Asistente | M2 ↔ M1 | M2 cambia `compileStylePreset` y el servicio de estilo de subtítulos que ya usa `case "add_captions"`; M1 no toca `add_captions`. |
| 10 | Job types nuevos en etiquetas (`jobs-store.ts`, `reports/markdown.ts`) | todos | Las pone el Paso 0. |
| 11 | `resolve.ts` / `handlers/agent.ts` | M1 ↔ M3 | Dueño M1; M3 solo llama `resolvePlan` desde `routes/suggestions.ts`. |
| 12 | `AssistantPanel.tsx` (M3) muestra planes de `fit_duration` del Guion (M1) | M1 → M3 | El Guion manda el plan por `agent-store.openPlan(record)` (función existente o nueva de M3 con la firma acordada: `openPlan(record: AgentPlanRecord): void`). |
| 13 | Fuentes servidas en `/fonts/*` (M2) y la UI web (M2) vs `@font-face` en `globals.css` | M2 | Un solo dueño. |

## Riesgos y mitigación
| Riesgo | Mitigación |
| --- | --- |
| Tiempos por palabra de Whisper con ±50–150 ms (más tras pausas largas): cortes que comen consonantes | Corte en el medio del hueco, margen ≤ 60 ms, afinado por energía, «evitar cortes bruscos», fundido 12 ms; medición en la PC antes de cerrar (≤ 80 ms en el 90 %). |
| Hueco acústico confunde respiraciones o vocales alargadas con «eh» | Las acústicas son `safe` solo si ≥ 250 ms y ≥ piso + 10 dB; el resto `doubtful`, nunca preseleccionadas; escuchar al pasar el mouse. |
| Reglas léxicas ambiguas («este», «tipo», «nada», «viste») | Reglas de contexto (F§1.3), solo `safe` preseleccionado, todo deshacible en un paso; lista editable en S7. |
| Fuentes empaquetadas pesan o fallan en libass de Windows | TTF estáticos 3 pesos (≤ 8 MB); `fontsdir` absoluto con escape de `escape.ts`; e2e en windows-latest. |
| Divergencia Remotion / ASS / vista previa (interlineado, contorno) | Un solo `resolveDesign` + `paginateCaptions`; prueba de captura comparada por plantilla (tolerancia 8 como capas). |
| Zonas seguras no oficiales | Tokens editables + calibración con captura del teléfono; la UI dice «guía». |
| `renderStill` lento en el i5 | Caché por hash, debounce 400 ms, bundle compartido con el render; meta < 1,5 s con caché caliente. |
| Análisis de fondo compitiendo con el usuario | Carril `background` (api) + `PriorityQueue` (workers) + ffmpeg con `-threads 2` y prioridad baja; cancelación cooperativa ≤ 1 s. |
| Sobrecorte semántico de `fit_duration` | Oraciones solo con `allow_sentences` + confirmación; vista previa por grupos destildables. |
| M2 demasiado grande para un agente | Prioridades 1–8 numeradas: 1–4 obligatorias (C2, C4), 5–8 en orden; lo que no entre va al «Descubierto» con el criterio C3 medido igual. |
| Licencia de Remotion si Studio se redistribuye (> 3 empleados) | Uso personal: OK; anotado en `NOTICE.md`. Fuentes: OFL.txt incluido por familia. |

## Preguntas abiertas (con la respuesta por defecto que se aplica si no hay otra)
1. **¿Vista previa de plantillas con `@remotion/player` en la web (en vivo, nueva dependencia
   `@remotion/player@4.0.532`, misma licencia que Remotion) o solo `renderStill`?** Default: **solo
   `renderStill`** en este sprint (sin dependencia nueva, misma ruta que el export); Player en S7 si la
   latencia medida en la PC supera 1,5 s.
2. **¿Fuentes en el repo (≈ 6–8 MB) o descargadas por `setup.ps1`?** Default: **en el repo** (render y CI
   sin red, deterministas).
3. **¿Zona segura derecha 11 % o 18 % (botones de Shorts)?** Default: **11 %** (pedido del usuario) con el
   perfil «Shorts (derecha 18 %)» en Avanzado y la calibración con captura.
4. **¿Muletillas «probables» preseleccionadas?** Default: **no**; solo las seguras («Quitar seguras»).
5. **¿`fit_duration` puede quitar oraciones?** Default: **no** salvo `allow_sentences` explícito y con
   confirmación; por defecto pausas + muletillas (+ aceleración ≤ 1,1× solo si se pide).

## Notas para Windows
- `fontsdir=` en el filtro: ruta absoluta con `escape.ts` (los `:` de `C:\` y `\` rompen el parseo).
- `BELOW_NORMAL_PRIORITY_CLASS` (`0x4000`) en `creationflags` del ffmpeg de fondo; matar el árbol con
  `taskkill /T /F` (gancho ya existente).
- Atajos del Guion: `F2`, `Mayús+M`, `.` y `,` no los reserva Chrome/Edge; `Supr`/`Retroceso` se cortan en el
  panel (no navegan atrás).
- Capturas de calibración: PNG/JPG del teléfono pasadas por USB/WhatsApp; se escalan al lienzo 9:16.

## Descubierto (fuera de alcance)
- «Revisar resultado» sobre fotogramas (texto sobre cara, contraste del fondo real) → S7 estructural 4.
- Sugerencias de escenas, reencuadre por cara y subtítulos; tarjeta «Quitar muletillas» → S7.
- Lista de muletillas editable en Ajustes y por hablante; WhisperX si la medición de tiempos falla.
- Exportación DTCG del kit a Figma/Tokens Studio (función opcional de M2).

## Paso 0 — qué quedó en código (2026-10-18)

- `packages/shared/src/{design,script,suggestions}.ts` (nuevos) y aditivos en `agent.ts` (3 ops,
  `EDIT_OP_NAMES` = 26), `ai.ts` (`ApplyCutsRequest.mode/joinFadeMs`, áreas `transcribe`/`analyze`),
  `api.ts` (15 rutas, `SPRINT6_ERRORS`, `SPRINT6_WARNINGS`, `SPRINT6_MODULES`), `job.ts`
  (`script.transcribe`, `suggest.analyze`), `subtitles.ts`, `timeline.ts` (`Clip.audioFade`,
  `PROJECT_CANVAS_MAX` = 8192), `style.ts` (`use_brand_kit`), `texts-es.ts`, `hotkeys.ts`
  (`SCRIPT_HOTKEYS`, `SCRIPT_INTERCEPTED_KEYS`; `HOTKEYS` sigue con 32). JSON Schemas exportados.
- api: carril `background` (límite 1) en `jobs/{types,queue,state}.ts`; `routes/{script,design,
  suggestions}.ts` con 501 `NOT_IMPLEMENTED` (`lib/errors.ts` `sprint6NotImplemented`); `case` de
  las 3 ops en `resolve.ts` (pregunta «Todavía no está disponible (M1 Guion)») y en
  `handlers/agent.ts`; etiquetas de jobs y ops (api y web); `hotkeyPolicy` acepta el scope `script`.
- workers: `task_schema.py` (`SttWordsRequest`, `ScriptAudio`, `SuggestAnalyzeRequest`,
  `SuggestAnalyzeResult`, `TASK_PRIORITY_*`, `SPRINT6_TASKS`), `errors.py` (`not_implemented`, 501),
  stubs `/transcribe/words|tasks/{id}|cancel` (bloque `sprint6:M1`) y `/analyze/suggest|tasks/{id}|cancel`
  (bloque `sprint6:M3`); `scripts/agent/validate-dataset.py` con `PENDING_OPS` (M1 lo vacía).
- Tests: shared `sprint6-contracts.test.ts` (13), api `sprint6-stubs.test.ts` (18) + 1 caso en
  `agent-resolve.test.ts`, workers `test_task_schema_sprint6.py` (11).
- Sin dependencias nuevas.

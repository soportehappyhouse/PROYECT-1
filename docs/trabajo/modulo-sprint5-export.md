# Sprint 5 — M3 «Export profesional y 9:16» (agente «export»)

Contrato: `docs/trabajo/sprint5-contratos.md` §M3 (H6, H17, R1). Este archivo junta los borradores
que pega la integración (manual, ARQUITECTURA, CLAUDE.md) y los pedidos a otros módulos.

## Qué quedó hecho

- **Mezcla aparte + loudnorm 2 pasadas** (`services/ffmpeg.ts` `exportProject`, `services/export/loudness.ts`):
  el video se renderiza solo (`compileExport` `videoOnly`, o bloques de la caché), la mezcla va a
  `tmp/audio/mix.wav` (PCM float 48 kHz, también en modo `single`), pasada 1 `loudnorm …:print_format=json`
  (`parseLoudnormStats`, último `{…}`, tolera CRLF y `-inf`), pasada 2 lineal con `measured_*` + `offset`
  codificada directo en el mux final (`-c:v copy`, `-ar 48000`, códec del preset). GIF y alfa siguen en
  una sola pasada (sin audio / sin normalizar). Medición fallida → `warnings: ["LOUDNESS_MEASURE_FAILED"]`,
  sale sin normalizar. Mezcla en silencio → no se normaliza (sin aviso).
- **Ducking automático por rol** (`compileExport` `audioMix`, `exportAudioMix` en `jobs/handlers/project-export.ts`):
  bus `voice` (amix) → `sidechaincompress` sobre el bus `music` con `AUTO_DUCK` (umbral 0,05, ataque
  150 ms, suelta 600 ms, `apad=whole_dur` acotado), ratio `duckRatioFor(duckDb)` (−12 dB ≈ 7) y
  **calibración**: se mide la voz sola (loudnorm) y `level_sc = duckSidechainGain(LUFS)` la lleva a
  −18 LUFS + 6 dB, así una voz bajita de celular baja la música igual que una de estudio (test:
  voz a ≈ −30 dBFS → música −10,8 dB). Sin pista `voice` audible o sin `music`: no hay sidechain.
  Roles: `Track.role` o `inferTrackRole` (video → voz; audio de TTS/clon/«Voz propia» → voz; lo dudoso → otro).
  `add_audio` del Asistente pone `role` = música/ambiente → `music`, el resto `sfx` (solo en pista nueva).
- **Aspecto** (`services/export/aspect-check.ts`): `POST /api/projects/:id/export` y `agent.apply`
  (`export`) → 409 `ASPECT_CHOICE_REQUIRED` (`details {canvas, preset, options, reframeReady}`),
  `REFRAME_REQUIRED`; `center` = recorte centrado sin franjas, `blur` = fondo desenfocado (viejo),
  `reframe` = `project.reframe`. El hash de bloques solo cambia cuando el encuadre difiere del viejo.
- **Planes (H6)** (`services/agent/aspect.ts`): `expandPlanForAspect` + `resolvePlanForRecord` en las 4
  llamadas (Asistente y plan editado en `routes/agent.ts`, Consola, Perfil de estilo); `POST
  /api/agent/plans/:id/choose {choiceId, optionId}` (`AGENT_PLAN_CHOOSE_ROUTE`, bloque M3 en
  `routes/agent.ts`) aplica la opción (patch → insert), vuelve a expandir/resolver y devuelve el registro.
- **Web**: Exportar con «¿Dónde lo vas a publicar?» (Reels/TikTok primero y por defecto, Shorts, YouTube
  1080p, 4K, Otro), «Avanzado» plegado, elección de encuadre antes de habilitar Exportar, sección
  «Sonido» (−14 LUFS, bajar la música, rol por pista), «Solo el rango I–O», tarjeta de resultado
  (miniatura, ruta, duración, tamaño, LUFS, Abrir carpeta, Revisar); Revisión para redes: filas
  «Sonoridad» y «Formato»; `PlanChoices` en el Asistente. `studio_export` += `aspectFit`.
- `POST /api/system/reveal {path}` (solo `exports/`, `explorer.exe /select,<abs>` en un solo argv).

Archivos fuera de la lista del contrato que tuve que tocar (nadie más los tenía): `services/ffmpeg.ts`
(orquestación del export), `services/ffmpeg/segments.ts` (hash con encuadre), `test/segment-cache.integration.test.ts`
(el mensaje ahora empieza con «Video: »), `test/components.test.tsx` (los 2 tests de ExportPanel: el
destino por defecto ahora es Reels).

## Borrador manual §15

Reemplaza en «15. Limitaciones conocidas»:

- ~~**Ducking**: solo por API (no hay botón) y no se aplica al exportar desde la línea de tiempo.~~ →
  **Ducking al exportar**: es automático por **rol de pista** (Exportar → Sonido). Una pista de audio
  que no es voz ni viene de la Biblioteca queda como _Otro_ y no se baja: marcala como **Música** si
  querés que baje bajo la voz. El ducking por clip (efecto de voz «Ducking») sigue siendo un trabajo
  aparte.
- ~~**Sin recorte (crop) ni zoom** en la interfaz: un video horizontal en un proyecto vertical queda
  con barras.~~ → **Horizontal a vertical**: al exportar para Reels/Shorts Studio pregunta cómo
  encuadrar (seguir la cara, recortar al centro o franjas borrosas); «Seguir la cara» necesita el
  paquete **Reencuadre** y reencuadrar antes (Vista previa → Reencuadrar). Si ponés el **lienzo** en
  9:16 con un video horizontal adentro, el video sigue quedando con barras negras: dejá el lienzo en
  16:9 y elegí el encuadre al exportar.

Agregar:

- **Sonoridad**: se normaliza la mezcla completa a −14 LUFS / −1 dBTP (YouTube, Reels, TikTok,
  Shorts). GIF y WebM con transparencia no se normalizan. Las 2 pasadas suman el tiempo de leer el
  audio dos veces (segundos en un video corto). Los presets propios creados antes de esta versión no
  normalizan: duplicá uno incluido.
- **Rol automático**: las pistas de video cuentan como **voz** (aunque tengan música de fondo
  grabada); cambiá su rol a _Otro_ si no querés que bajen la música.
- **Seguir la cara** no está para 16:9 desde un video vertical (solo 9:16, 1:1 y 4:5): ahí Studio
  ofrece recortar al centro o franjas.

### §5 — Flujo «Reels desde un video horizontal» (reemplaza el bloque del flujo 2 sobre lienzo)

1. Dejá el proyecto en **16:9** e importá el video.
2. **Exportar → ¿Dónde lo vas a publicar? → Reels / TikTok** (ya viene elegido).
3. Studio avisa «El video es horizontal y Reels es 9:16: ¿cómo lo encuadro?»:
   - **Seguir la cara** (recomendado): abrí **Reencuadrar** (botón del aviso), Analizá y Aplicá;
     al volver el aviso desaparece y dice «Usa el reencuadre del proyecto».
   - **Recortar al centro**: rápido, puede cortar a la persona si no está en el medio.
   - **Dejarlo entero con franjas borrosas**: el cuadro completo, más chico.
4. **Sonido**: dejá «Normalizar a −14,0 LUFS» y «Bajar la música cuando hay voz».
5. **Exportar**. La tarjeta «Último resultado» muestra la ruta, la duración, el tamaño, «−14,0 LUFS»,
   **Abrir carpeta** (abre el Explorador con el archivo marcado) y **Revisar**.

Con el Asistente: «Exportá para Reels» sobre un video horizontal arma
`Reencuadrar (agregado por Studio)` + `Exportar`; si falta el paquete Reencuadre pregunta con 3
botones (Seguir la cara (descarga…), Recortar al centro, Dejarlo entero con franjas borrosas).

### §17.7 — Revisión para redes (filas nuevas)

Debajo de la casilla aparecen dos filas del **último export** del proyecto:

- **Sonoridad**: ✓ si quedó a −14 LUFS ± 1 con pico ≤ −1 dBTP; aviso si no se normalizó.
- **Formato**: ✓ «vertical sin franjas» (siguiendo la cara o al centro); aviso si salió con franjas
  borrosas.

### §9 / §17 — «Sonido al exportar»

| Opción (Exportar → Sonido)        | Qué hace                                                                 |
| --------------------------------- | ------------------------------------------------------------------------ |
| Normalizar a −14,0 LUFS           | Mide la mezcla y la lleva a −14 LUFS / −1 dBTP (2 pasadas, lineal).      |
| Bajar la música cuando hay voz    | La música baja ≈ 12 dB mientras suena una pista de Voz (150/600 ms).     |
| Rol de cada pista                 | Automático (video = Voz, TTS/clon = Voz, resto = Otro), Voz, Música, Efectos, Otro. |

## Borrador ARQUITECTURA

§5 Export (agregar al final):

> **Sprint 5 — audio aparte.** `exportProject` renderiza el video sin audio (`videoOnly`) o por
> bloques, la mezcla a `audio/mix.wav` (`audioOnly`, `pcm_f32le`) y la normaliza en el mux final:
> pasada 1 `loudnorm` JSON sobre el WAV, pasada 2 lineal (`measured_*`, `offset`) codificada con el
> códec del preset y `-c:v copy`. `ExportJobResult` += `durationS`, `sizeBytes`, `aspectFit`,
> `loudness {input_i, input_tp, output_i, output_tp}`, `ducked`, `warnings`. El ducking automático
> arma buses por rol (`AudioMixPlan`) con `sidechaincompress` (`duckingFragment` con `apad=whole_dur`
> y `level_sc` calibrado midiendo la voz sola). `effectiveAspectFit` decide el encuadre
> (reframe/center/blur) y entra al hash de bloques solo cuando difiere del comportamiento viejo.
> `services/export/aspect-check.ts` (409 `ASPECT_CHOICE_REQUIRED`/`REFRAME_REQUIRED`) corre en la
> ruta, en `agent.apply` y en el job. `services/agent/aspect.ts` expande los planes antes de
> resolverlos (reframe o `PlanChoice`) y `POST /api/agent/plans/:id/choose` aplica la elección.

## Borrador CLAUDE.md

- Tabla: `studio_export {preset, confirmed, aspectFit?}` — «Si el video es horizontal y el preset
  vertical, preguntá: seguir la cara (reframe), recortar al centro (center) o franjas (blur)».
- `studio_validate_plan` puede devolver `added` (ops agregadas por Studio, p. ej. `reframe` antes de
  exportar a 9:16) y `choices` (preguntas con opciones): mostralas al usuario y volvé a validar con
  `aspect_fit` en el `export`.
- Flujo «Cortá los silencios y exportá para Reels»: el `reframe {target:"9:16"}` ya no hace falta
  escribirlo: el api lo agrega si está el paquete.

## Pedidos a otros módulos

- **M2 (LibraryPanel)**: al agregar un sonido de la Biblioteca a una pista nueva, `updateTrack(id,
  {role: libraryRole(item.kind)})` (`@studio/shared`, music/ambience → `music`, resto → `sfx`).
- **M2 (project-store)**: un setter `setAudioMix(patch)` para guardar «Bajar la música cuando hay
  voz» en `project.audioMix` (hoy Exportar lo manda por pedido como `autoDuck`).
- **M1 (AssistantPanel)**: cuando `record.choices` tiene la pregunta, la línea de `unresolved`
  «Operación N: El video es horizontal…» queda repetida arriba de los botones de `PlanChoices`;
  se puede ocultar si `choices.some(c => u.includes(c.question_es))`.
- **Workers (planner determinista)**: el destino por defecto del Asistente ya es Reels en el api
  (expansión); si el planner elige `youtube-1080p` para «exportá» a secas, alinearlo con la decisión
  «9:16 principal» (fuera de M3).

## Solo medible en la PC

- Tiempo extra de las 2 pasadas + la medición de la voz en un video de 10 min (estimado: 2–3
  lecturas del audio, segundos; el video no se re-codifica).
- Que **Abrir carpeta** seleccione el archivo en el Explorador con rutas con espacios y tildes
  (`explorer.exe` devuelve 1 aunque funcione: se ignora).
- Sonoridad real medida por Instagram/TikTok tras subir (−14 LUFS es la referencia [S]).
- Que el ducking calibrado suene natural con voz real (ataque 150 ms / suelta 600 ms).

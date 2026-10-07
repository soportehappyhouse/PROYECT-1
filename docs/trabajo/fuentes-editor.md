# Fuentes: editor de video, dashboard, backend, FFmpeg, Windows, convenciones

Fecha de investigacion: 2026-10-04. Sin API keys. Ningun codigo se escribio en el repo.

## 0. Metodo y limites (leer primero)

- **Versiones**: consultadas hoy contra el registro npm (`npm view`), PyPI y `nodejs.org/dist/index.json`. Son las `latest` reales, no las de memoria.
- **Verificado por ejecucion** (Linux, Node 22.22.0, ffmpeg 6.1.1, pnpm 12.9.1): stack Fastify 5 + multipart + static (Range 206) + SSE + better-sqlite3 + node:sqlite + p-queue + progreso de ffmpeg; todas las recetas FFmpeg marcadas `[OK 6.1.1]`; un monorepo pnpm de prueba con lint, typecheck, build y vitest; scaffold de Next 16 con lint y build. Todo en el scratchpad, nada en el repo.
- **NO verificado** (no hay Windows en el sandbox): winget en vivo, PowerShell, escape de rutas `C:\` en filtros, encoders de hardware reales (el sandbox no tiene GPU: se probo la deteccion y el fallback, no una codificacion real), AMF.
- **Dominios bloqueados por el proxy** (no se pudieron leer): `remotion.dev`, `ffmpeg.org`, `pnpm.io`, `ui.shadcn.com`. Lo que dependia de ellos esta marcado como "sin verificar". La licencia de Remotion se leyo de `raw.githubusercontent.com/remotion-dev/remotion/main/LICENSE.md`.
- Las especificaciones de plataformas (Reels, Shorts) vienen de agregadores de blogs, no de documentacion oficial de Meta. Los limites de duracion cambian: guardarlos como campos editables del preset, no fijos en codigo.
- Licencias: "OK" = OSI (MIT/Apache/BSD/ISC). Todo lo demas se marca y no se copia codigo.

---

## 1. Editores de video open source en navegador

### 1.1 omniclip — la mejor referencia de arquitectura y estado
- URL: https://github.com/omni-media/omniclip. Licencia **MIT** (LICENSE leido en raw; copyright 2024 Przemyslaw Galezki). ~1.5k estrellas. Mantenido (2.0 en desarrollo, segun README).
- Stack: TypeScript, `@benev/slate`, PixiJS, WebCodecs. Export 100% en el navegador (solo Chromium).
- **Que portar (ideas y tipos, MIT permite copiar con aviso)**: la forma del estado en https://raw.githubusercontent.com/omni-media/omniclip/main/s/context/types.ts
  - `HistoricalState` = `{ projectName, projectId, effects[], tracks[], filters[], animations[], transitions[] }`. Es lo que entra al undo/redo.
  - `NonHistoricalState` = `{ selected_effect, is_playing, is_exporting, export_progress, export_status, fps, timecode, length, zoom, timebase, log, settings }`. Es estado de UI que no se deshace.
  - `Effect` base = `{ id, start_at_position, duration, start, end, track }`. `start`/`end` son el recorte dentro del medio fuente. `start_at_position` es la posicion en el timeline. Los `kind` son `video | audio | image | text`. `EffectRect` guarda posicion, escala, rotacion y pivot.
  - Flujo unidireccional State -> Actions -> Controllers -> Views, con acciones "historicas" y "no historicas".
- **Evitar**: el framework `@benev/slate` (nicho), PixiJS, y el export en cliente (nosotros exportamos con FFmpeg en servidor).

### 1.2 OpenVideo Editor (antes designcombo/react-video-editor) — solo inspiracion de UX
- URLs: https://github.com/designcombo/react-video-editor (hoy muestra el proyecto OpenVideo), repo npm https://github.com/openvideodev/openvideo. ~1.8k estrellas.
- Stack: Next 15, PixiJS v8 (`@openvideo/engine-pixi` 1.4.0, MIT segun npm), Zustand, Tailwind v4, shadcn/Radix, Framer Motion.
- **Licencia NO OSI**: "OpenVideo License", doble nivel. Gratis para individuos, sin animo de lucro y empresas con <=3 empleados; licencia de pago para empresas mas grandes (LICENSE leido en raw). El paquete `openvideo` 0.2.18 declara "SEE LICENSE IN LICENSE".
- Los paquetes viejos `@designcombo/timeline` y `@designcombo/state` 5.5.8 no declaran licencia en npm: tratarlos como sin licencia y **no usarlos**.
- Portar: nada de codigo. Usar solo como referencia visual (disposicion de paneles, comportamiento del timeline).

### 1.3 @xzdarcy/react-timeline-editor — candidato a componente de timeline
- URL: https://github.com/xzdarcy/react-timeline-editor. **MIT** (raw LICENSE verificado, 2021 zdarcy). npm `@xzdarcy/react-timeline-editor` 1.0.0, publicado 2026-01-25. 795 estrellas, ~40 issues abiertos.
- Modelo de datos (README): `editorData: TimelineRow[]`, con `TimelineRow { id, actions[] }`, `action { id, start, end, effectId }` y `effects: Record<id, {id, name}>`.
- Portar: el modelo fila/accion/efecto como punto de partida, o el componente tal cual para un MVP.
- Evitar: depender de el para frame-accuracy. No trae waveform, tipos de pista ni snapping avanzado. Para el producto final, hacer un timeline propio con pointer events y estado en zustand, usando este modelo como esqueleto.

### 1.4 Remotion y editores basados en Remotion
- Licencia (leida en raw): gratis para individuos, empresas con fines de lucro de **hasta 3 empleados**, ONG y evaluacion. Mas de 3 empleados requiere Company License. El plan declara "uso personal": consistente. El LICENSE avisa de cambios en Remotion 5.0 (PR https://github.com/remotion-dev/remotion/pull/3750), asi que releer antes de pasar a v5.
- Paquetes (4.0.532, hoy): `remotion`, `@remotion/player`, `@remotion/renderer` declaran "SEE LICENSE IN LICENSE.md". `@remotion/captions` y `@remotion/media-utils` son MIT. `@remotion/transitions` aparece como UNLICENSED en npm (metadatos inconsistentes). Tratar todo `@remotion/*` bajo la licencia de Remotion.
- "Remotion Editor Starter" (plantilla de pago de Remotion): existe segun mi conocimiento, **sin verificar** (remotion.dev bloqueado). Es de pago y no es OSS: no copiar.
- `designcombo/remotion-timeline` y `react-video-editor-js`: los raw LICENSE devuelven 404, o sea sin licencia declarada. No usar.

### 1.5 Otros revisados (licencia y veredicto)
| Proyecto | Licencia | Veredicto |
|---|---|---|
| etro-js/etro (etro 0.14.1) https://github.com/etro-js/etro | **GPL-3.0** | No copiar. Solo concepto: Movie > Layers > Effects; las propiedades aceptan keyframes o una funcion `(elemento, tiempo)`. Sirve para el modelo de keyframes. |
| diffusionstudio/core 4.0.3 https://github.com/diffusionstudio/core | MPL-2.0 (copyleft por archivo) y marca de agua salvo licencia de pago | Evitar. Concepto: Composition > Layer > Clip. Usa Mediabunny (MPL-2.0). |
| AmitDigga/fabric-video-editor https://github.com/AmitDigga/fabric-video-editor | **MIT** (raw verificado) | Fabric.js + MobX + Next + ffmpeg.wasm. Sus propios issues: audio roto, duracion mal en metadatos, parpadeo. Evitar el export con wasm; ver solo la UI. |
| ncounterspecialist/twick | SUL v1.0 (Sustainable Use License), no OSI | No copiar. |
| shotstack-studio-sdk (npm `@shotstack/shotstack-studio` 2.24.0) | PolyForm Shield 1.0.0, no OSI | No copiar (restringe uso competidor). |
| AIEraDev/Clypra (MIT, 3.3k estrellas, Rust/Tauri/React 19) y MartinDelophy/ai-video-editor (MIT) | MIT (segun la API de busqueda de GitHub) | Aparecieron en la busqueda. **No auditados.** Son de escritorio/Tauri; solo mirar UX. |
| @ffmpeg/ffmpeg 0.12.15 (ffmpeg.wasm) | MIT el wrapper; el nucleo es GPL/LGPL | No hace falta: tenemos FFmpeg nativo. |
| Mediabunny 1.61.1 | MPL-2.0 | Opcional, solo si algun dia se demuxa/muxa en el navegador. |
| LosslessCut (GPL-2.0), Olive (GPL-3.0), OpenShot (GPL-3.0), Kdenlive (GPL-3.0) | GPL | Solo estudio de UX de escritorio. No copiar. |

### 1.6 Forma recomendada del proyecto (diseno propio, derivado de omniclip + react-timeline-editor)
Tiempos en **segundos con decimales** en el JSON (convertir a frames solo en la UI).
```
Project { id, name, fps, width, height, tracks: Track[], assets: Asset[] }
Track   { id, kind: "video"|"audio"|"text"|"overlay", name, muted, locked, order, clips: Clip[] }
Clip    { id, assetId, start /* en el timeline */, duration, in /* offset dentro del medio */,
          speed, volume, fadeIn, fadeOut, transform {x,y,scale,rotation,opacity}, effects[], keyframes{prop:[{t,v,ease}]} }
Asset   { id, path, kind, probe /* ffprobe */, proxyPath, thumbs, peaks }
UI-only (no entra al undo): selection, playhead, zoom, isPlaying, panelLayout
```
El mismo JSON alimenta la vista previa en el navegador y el compilador a FFmpeg `filter_complex` en la API (una sola fuente de verdad).

---

## 2. Bloques de UI

### 2.1 Layout personalizable: react-grid-layout vs dockview vs flexlayout-react
| | react-grid-layout 2.2.4 | dockview 8.4.0 | flexlayout-react 0.11.1 |
|---|---|---|---|
| Licencia | MIT | MIT (paquetes OSS; existe un "enterprise" comercial aparte) | MIT |
| Publicado | 2026-07-29 | 2026-09-30 | 2026-09-26 |
| Modelo | Cuadricula de tarjetas arrastrables y redimensionables | Docking tipo IDE: tabs, splits, grupos flotantes, ventanas popout | Docking: tabsets, borders, popout, maximizar |
| Persistencia | `onLayoutChange`, tu guardas el JSON | `api.toJSON()` / `api.fromJSON()` y evento `onDidLayoutChange` (verificado en los tipos) | `Model.toJson()` / `Model.fromJson()` (verificado en los tipos) |
| React | >=16.3 (v2: React 18+) | 16.8 a 19 | 18 y 19 |
| Encaja con | Panel "inicio" con widgets | **Workspace del editor** (preview, timeline, assets, inspector, jobs) | Alternativa directa a dockview |

- RGL v2 (verificado en README): reescritura TypeScript, hooks `useContainerWidth`, `useGridLayout`, `useResponsiveLayout`; `width` es obligatorio; `/legacy` conserva la API v1. Es para dashboards de tarjetas, no para docking con tabs.
- **Eleccion: dockview** para el editor (reordenar, ocultar/mostrar paneles, flotar, persistir el layout). Plan B: flexlayout-react (API mas simple, menos activo; 1.4k vs 3.5k estrellas). RGL solo si se quiere una pantalla de inicio de widgets.
- Persistir: guardar `toJSON()` en localStorage (carga instantanea) y en la tabla `settings` de SQLite (sobrevive a limpiar el navegador). Validar con zod al cargar y caer al layout por defecto si falla (el JSON de dockview cambia entre versiones mayores).
- CSS: dockview necesita importar `dockview/dist/styles/dockview.css` (el archivo existe en el paquete) y se tematiza con variables CSS, asi que sigue el tema claro/oscuro.
- Panel simple de dos columnas: `react-resizable-panels` 4.14.2 (MIT), base del `Resizable` de shadcn. Su API cambio entre v3 y v4: verificar antes de usarla.

### 2.2 Timeline
- Propio, con DOM y pointer events (arrastre, recorte por bordes, snapping, zoom con `ctrl+rueda`), estado en zustand. Mover clips con dnd-kit funciona pero da menos control de snapping; usar dnd-kit solo para soltar assets sobre el timeline y para reordenar listas/pistas.
- MVP rapido: `@xzdarcy/react-timeline-editor` (MIT, ver 1.3).

### 2.3 Waveform
| Libreria | Version | Licencia | Notas |
|---|---|---|---|
| wavesurfer.js | **8.0.1** (dist-tag `latest`; v7 ya no es la ultima, v8 anade API reactiva con `Signal`) | BSD-3-Clause | 10.4k estrellas, plugins regions/timeline/minimap/envelope/hover/record. Acepta `peaks` + `duration` precalculados: **no decodificar audio grande en el navegador**. `@wavesurfer/react` 1.0.12. |
| peaks.js | 4.0.0 | **LGPL-3.0** | Pide Konva + waveform-data y el binario `audiowaveform` para archivos grandes; el README dice que el desarrollo se mudo a codeberg. **Evitar.** |
- Receta: la API genera los picos con FFmpeg (`-ac 1 -ar 8000 -f s16le` [OK 6.1.1]; reducir a min/max por bucket y guardar JSON junto al asset) y el navegador solo dibuja. Alternativa trivial: PNG con `showwavespic` [OK 6.1.1].

### 2.4 Vista previa de video
- Medio fuente: `<video>` plano sobre el **proxy** (ver 3.6), con overlays DOM (texto, imagenes) sincronizados con `requestVideoFrameCallback`. Paso a frame con `currentTime += 1/fps`.
- `@remotion/player` 4.0.532 (licencia Remotion; peer react >=16.8): solo para previsualizar composiciones Remotion (titulos, subtitulos animados). Se controla por ref (`seekTo`, `play`, `pause`).
- No intentar componer todo en el navegador: preview aproximado + render final en FFmpeg/Remotion.

### 2.5 Resto de piezas
| Pieza | Version | Licencia | Notas |
|---|---|---|---|
| @dnd-kit/core + @dnd-kit/sortable | 6.3.1 + 10.0.0 | MIT | Estables. El core no se publica desde 2024-12 pero es compatible con React 19 (peer >=16.8). **Recomendado.** |
| @dnd-kit/react | 0.5.0 (2026-09-12) | MIT | Reescritura, aun 0.x. Reevaluar cuando llegue a 1.0. |
| zustand | 5.0.15 | MIT | Estado. `immer` 11.1.21 opcional. Undo/redo: separar estado historico y no historico (como omniclip) o `zundo` 2.3.0 (peer zustand 4 o 5, ultima publicacion 2024-11). |
| Tailwind CSS | **4.3.3** | MIT | v4 es la vigente: `create-next-app` hoy genera `@tailwindcss/postcss ^4` (verificado). v3 ya es legado. |
| shadcn CLI | 4.21.1 | MIT | `pnpm dlx shadcn@latest init`. Docs bloqueadas por el proxy: el flujo exacto de `init` queda **sin verificar**. Componentes sobre `radix-ui` 1.6.7 o `@base-ui/react` 1.8.0. Animaciones v4: `tw-animate-css` 1.4.0. |
| cmdk | 1.1.1 (2025-08) | MIT | Paleta de comandos (base del `Command` de shadcn). Peer React 18/19. |
| react-hotkeys-hook | 5.3.3 | MIT | `useHotkeys("mod+k", cb)`. Atajos personalizables: guardar `{accionId: "mod+shift+s"}` en settings y registrar desde ese mapa; detectar conflictos al guardar. |
| next-themes | 0.4.6 | MIT | Claro/oscuro con `attribute="class"`; evita el parpadeo con un script inline. |
| sonner / lucide-react | 2.0.8 / 1.52.0 | MIT | Toasts e iconos. |
- **Tema y colores**: tokens como variables CSS en `:root` y `.dark`. El acento y la densidad elegidos por el usuario se guardan como JSON en `settings` (SQLite) con cache en localStorage y se aplican como `style` sobre `<html>`. Panel de layout, atajos y presets de export en la misma tabla `settings` (clave/valor JSON): cubre el criterio de exito 3 del plan.

---

## 3. Backend Node

### 3.1 Fastify y plugins
| Paquete | Version | Licencia | Nota |
|---|---|---|---|
| fastify | **5.12.5** (mayor 5; existe `6.0.0-alpha.4` en el tag `next`: no usar) | MIT | Node >=20. |
| @fastify/multipart | 10.1.2 | MIT | Subida por streaming. |
| @fastify/static | 10.1.5 | MIT | Sirve medios con Range. |
| @fastify/cors | 11.3.0 | MIT | Necesario si el navegador llama a :3001 directo. |
| @fastify/websocket | 11.3.3 | MIT | Solo si hace falta canal bidireccional. |
| @fastify/sse | 0.6.0 | MIT | Aun 0.x. `fastify-sse-v2` 4.2.2 (peer fastify >=4) es la alternativa. |
| fastify-type-provider-zod / zod | 7.0.0 / 4.6.5 | MIT | Esquemas compartidos con `packages/shared`. |
- Verificado en la prueba [OK Node 22.22 + Fastify 5.12.5]: subida de un archivo por `await req.file()` + `pipeline(file, createWriteStream)` con limite de 5 GB configurado; `@fastify/static` con `acceptRanges` devolvio `206 Partial Content` y `Content-Range`; SSE manual con `reply.raw` entrego los eventos.
- **SSE para progreso de jobs** (una via, reconexion automatica, sin dependencias). WebSocket solo si se necesita bidireccional. Pitfall: al escribir en `reply.raw` se saltan los hooks, asi que **`@fastify/cors` no pone sus cabeceras**; mezclar `reply.getHeaders()` en el `writeHead` o fijar `Access-Control-Allow-Origin` a mano. Conviene llamar `reply.hijack()` antes de escribir en `reply.raw` (mi prueba corrio sin el, pero es lo recomendado por Fastify).
- Escuchar en `127.0.0.1` (no `0.0.0.0`): evita el aviso del firewall de Windows y la exposicion a la LAN.
- Seguridad local: el cliente envia `assetId`, nunca rutas; resolver siempre dentro de `DATA_DIR` y rechazar `..`.

### 3.2 fluent-ffmpeg: **descartado**
- https://github.com/fluent-ffmpeg/node-fluent-ffmpeg esta **archivado** (2025-05-22). El README dice: "no longer maintained and no longer works properly with recent ffmpeg versions". npm `fluent-ffmpeg` 2.1.3 (MIT). Con FFmpeg 9.x de Gyan no hay garantia.
- **Alternativa**: `child_process.spawn("ffmpeg", args, { shell: false })` con un array de argumentos (sin shell no hay problemas de comillas ni de espacios en rutas de Windows). `execa` 10.0.1 (MIT) es opcional; la prueba funciono con `spawn` y `execa`.
- **Progreso** [OK 6.1.1]: `-hide_banner -nostats -loglevel error -progress pipe:1`. La salida son lineas `clave=valor` en bloques que terminan en `progress=continue` o `progress=end`. Las claves utiles: `out_time_us`, `speed`, `frame`, `fps`. Porcentaje = `out_time_us / 1e6 / duracionTotal` (la duracion sale de ffprobe o de la suma del timeline). En la prueba salieron 3 muestras y la ultima fue 5.97 s de 6 s.
- Errores: guardar las ultimas ~40 lineas de stderr en el job.
- Cancelar: escribir `q\n` en stdin (cierra y finaliza el archivo; **no** usar `-nostdin`). Si no responde, matar el arbol de procesos (`taskkill /PID <pid> /T /F` en Windows).

### 3.3 ffprobe JSON [OK 6.1.1]
`ffprobe -v error -print_format json -show_format -show_streams <archivo>`
- Devuelve `{ streams[], format{} }`. `format.duration` viene como **string**. Por stream: `codec_type`, `codec_name`, `width`, `height`, `r_frame_rate` ("30/1"), `avg_frame_rate`, `sample_rate`, `channels`. Los videos de movil rotados traen `side_data_list` con displaymatrix (ffmpeg autorota por defecto). Guardar el JSON completo en `assets.probe`.

### 3.4 Miniaturas y sprite sheets [OK 6.1.1]
- Una miniatura: `ffmpeg -ss 2 -i in.mp4 -frames:v 1 -vf scale=320:-2 -q:v 3 thumb.jpg`
- Sprite (1 fps, 160 px, 6 columnas): `ffmpeg -i in.mp4 -vf "fps=1,scale=160:-2,tile=6x1" -frames:v 1 -q:v 4 sprite.jpg`. Para videos largos: `fps=1/N` y `tile=COLxFILA`, y partir en varios sprites. En la UI se usa `background-position`.
- Los thumbs y los picos se generan como job de baja prioridad al importar.

### 3.5 Proxies de baja resolucion [OK 6.1.1]
`ffmpeg -i in.mp4 -vf "scale=-2:360" -c:v libx264 -preset veryfast -crf 28 -g 15 -keyint_min 15 -sc_threshold 0 -c:a aac -b:a 96k -movflags +faststart proxy.mp4`
- `-g 15` (un keyframe cada 0.5 s a 30 fps) hace que el scrubbing sea fluido. Los exports siempre salen del original, nunca del proxy.

### 3.6 SQLite
| | better-sqlite3 | node:sqlite |
|---|---|---|
| Version | **13.0.3**, MIT, `engines node >=22` | integrado; Node 22.5+, sin flag desde 22.13 y 23.4 |
| Estado | Maduro; WAL, backup, funciones de usuario | **Stability 1.2 Release Candidate** (docs de Node, desde 25.7). En Node 22.22 imprime `ExperimentalWarning` (verificado) |
| API | Sincrona | `DatabaseSync` / `StatementSync` (sincrona). Las filas son objetos de prototipo nulo (verificado). Por defecto no usa WAL |
| Riesgo en Windows | Descarga binario precompilado; si no existe para tu Node, pide VS Build Tools + Python | Cero modulo nativo |
- Ambos funcionaron en la prueba (`CREATE`, `INSERT`, `SELECT`; better-sqlite3 con `journal_mode = WAL`).
- **Recomendacion**: `better-sqlite3` detras de un modulo `db.ts` fino (para poder cambiar a `node:sqlite` si hay problemas de binarios en Windows). Con pnpm 11+/12 hay que permitir sus scripts de build (`allowBuilds`, ver 6.1). Smoke test en `setup.ps1`: `node -e "require('better-sqlite3')"`. Pragmas: `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`.
- Sin ORM: SQL plano + zod. (`drizzle-orm` 0.45.3 / `kysely` 0.29.6 son opcionales.)

### 3.7 Cola de jobs sin Redis
- **p-queue 9.3.3** (MIT, solo ESM, funciono en la prueba): concurrencia, prioridad, pausa. Es **en memoria**: pierde los jobs al reiniciar.
- **Cola en SQLite** (fuente de verdad) con p-queue como ejecutor:
  - Tabla `jobs(id, type, payload_json, status[queued|running|done|failed|canceled], progress, error, priority, attempts, created_at, started_at, finished_at, log_tail)`.
  - Tomar el siguiente de forma atomica: `UPDATE jobs SET status='running', started_at=? WHERE id=(SELECT id FROM jobs WHERE status='queued' ORDER BY priority DESC, created_at LIMIT 1) RETURNING *` (requiere SQLite >=3.35; ambos drivers lo traen).
  - Al arrancar: pasar los `running` a `queued` (recuperacion tras caida).
  - Un `PQueue` por recurso ("carriles"): ffmpeg 1-2, python/whisper 1, remotion 1.
  - Progreso: el worker actualiza `progress` (limitado a 1 escritura por segundo) y emite por SSE.
- No usar BullMQ (Redis) ni equivalentes.

---

## 4. Libro de recetas FFmpeg

Convenciones: `[OK 6.1.1]` = ejecutado hoy en ffmpeg 6.1.1 (Ubuntu) con medios de prueba y salida correcta. Windows trae FFmpeg **9.0.2** (Gyan): reejecutar este mismo set como smoke test en CI Windows. En codigo, pasar cada token como elemento de un array (sin shell).

### 4.1 Cortar (trim)
- **Preciso (recodifica)** [OK, dio 3.000 s]: `ffmpeg -ss 1 -i in.mp4 -t 3 -c:v libx264 -crf 18 -preset medium -c:a aac -b:a 192k -movflags +faststart out.mp4`
- **Sin recodificar** [OK, pero impreciso]: `ffmpeg -ss 1 -to 4 -i in.mp4 -c copy -avoid_negative_ts make_zero out.mp4`. Corta en keyframes: pedi 3 s y salieron 4.09 s porque la fuente solo tenia un keyframe en t=0. Usar para cortes rapidos y sin perdida; ofrecerlo como opcion "rapido (puede ser impreciso)".
- Preferir `-t` (duracion) a `-to` cuando `-ss` esta antes de `-i`.
- Dentro de un grafo (para componer): `[0:v]trim=1:3,setpts=PTS-STARTPTS[v];[0:a]atrim=1:3,asetpts=PTS-STARTPTS[a]`.

### 4.2 Unir (concat)
- **Demuxer (copia, solo si los codecs y parametros son identicos)** [OK]: lista `list.txt` con lineas `file 'a.mp4'` y `ffmpeg -f concat -safe 0 -i list.txt -c copy out.mp4`.
  - **Trampa verificada**: `inpoint`/`outpoint` en la lista **no son fiables** si no caen en keyframe. Pedi 2 s + 2 s y salieron 5.2 s. Para recortes exactos usar el filtro.
  - En Windows usar barras `/` o escapar en la lista (`file 'C:/media/a.mp4'`); una comilla simple dentro de un nombre se escribe `'\''`.
- **Filtro concat (re-encode, normaliza resolucion, fps y audio)** [OK, 11.03 s]:
  `ffmpeg -i a.mp4 -i b.mp4 -filter_complex "[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v0];[1:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v1];[0:a]aresample=48000,aformat=channel_layouts=stereo[a0];[1:a]aresample=48000,aformat=channel_layouts=stereo[a1];[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]" -map "[v]" -map "[a]" -c:v libx264 -crf 20 -c:a aac out.mp4`
- **Trim + concat en un solo grafo** (es lo que debe generar el compilador de timeline) [OK, exactamente 4.000 s]: `[0:v]trim=1:3,setpts=PTS-STARTPTS[v0];[0:a]atrim=1:3,asetpts=PTS-STARTPTS[a0];[1:v]trim=0:2,setpts=PTS-STARTPTS,scale=1280:720,fps=30[v1];[1:a]atrim=0:2,asetpts=PTS-STARTPTS[a1];[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]`

### 4.3 Recortar y redimensionar a 9:16
- **Fondo desenfocado** [OK, 1080x1920]: `ffmpeg -i in.mp4 -filter_complex "[0:v]split=2[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=30[bgb];[fg]scale=1080:-2[fgs];[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1[v]" -map "[v]" -map 0:a? -c:v libx264 -crf 20 -preset veryfast -pix_fmt yuv420p -c:a aac out.mp4`. (`boxblur=40:5` es mas rapido que `gblur`.)
- **Recorte central** [OK]: `-vf "crop=ih*9/16:ih,scale=1080:1920,setsar=1"`. Para recorte con desplazamiento: `crop=ih*9/16:ih:x:0` con `x` animable por expresion.
- Para una fuente ya vertical: `scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2`.

### 4.4 Velocidad
- **Acelerar x2** [OK, 6 s -> 3.07 s]: `-filter_complex "[0:v]setpts=PTS/2[v];[0:a]atempo=2[a]" -map "[v]" -map "[a]"`
- **Cambiar a x0.5** [OK, 6 s -> 12 s]: `setpts=PTS/0.5` y `atempo=0.5`.
- **x4** [OK]: encadenar `atempo=2,atempo=2` (cada `atempo` tiene rango limitado segun la version; encadenar es seguro en todas).
- Slow motion suave opcional: `minterpolate=fps=60` (lento; **sin probar**).

### 4.5 Superponer imagen o video con posicion y tiempo
- **Imagen entre t=1 y t=4, esquina superior derecha** [OK]: `-i in.mp4 -i logo.png -filter_complex "[0:v][1:v]overlay=x=W-w-20:y=20:enable='between(t,1,4)'[v]" -map "[v]" -map 0:a -c:v libx264 -crf 20 -c:a copy out.mp4`
- **Video superpuesto que empieza en t=2** [OK]: `[1:v]scale=320:-2,setpts=PTS-STARTPTS+2/TB[pip];[0:v][pip]overlay=x=W-w-24:y=H-h-24:eof_action=pass[v]`. Su audio se alinea con `[1:a]adelay=2000|2000`.

### 4.6 Picture-in-picture
Es la receta anterior con un overlay escalado (`scale=320:-2`) y `eof_action=pass` para que desaparezca al terminar. Esquinas: `x=24:y=24` / `x=W-w-24:y=24` / `x=24:y=H-h-24` / `x=W-w-24:y=H-h-24`. Para un marco: `pad=iw+8:ih+8:4:4:color=white` antes del overlay.

### 4.7 Fade in/out de video y audio [OK]
`-vf "fade=t=in:st=0:d=1,fade=t=out:st=5:d=1" -af "afade=t=in:st=0:d=1,afade=t=out:st=5:d=1"`. El `st` del fade-out es `duracion - d`: calcularlo con ffprobe o con la duracion del clip tras el `trim`.

### 4.8 Transiciones xfade [OK, 10.03 s]
`-i a.mp4 -i b.mp4 -filter_complex "[0:v]format=yuv420p,fps=30,settb=AVTB[v0];[1:v]scale=1280:720,format=yuv420p,fps=30,settb=AVTB[v1];[v0][v1]xfade=transition=fade:duration=1:offset=5[v];[0:a][1:a]acrossfade=d=1[a]" -map "[v]" -map "[a]" -c:v libx264 -crf 20 -c:a aac out.mp4`
- `offset` = duracion del clip 1 menos `duration`. Con N clips, `offset_k = suma(duraciones hasta k) - k*duration`.
- Los dos videos deben tener **mismo tamano, fps, pix_fmt y timebase** (de ahi `settb=AVTB` y `fps`). Lista de transiciones: `ffmpeg -h filter=xfade`.

### 4.9 Quemar subtitulos
- **SRT con estilo** [OK]: `-vf "subtitles=s.srt:force_style='FontName=DejaVu Sans,FontSize=24,PrimaryColour=&H00FFFFFF&,OutlineColour=&H00000000&,BorderStyle=1,Outline=2,Alignment=2,MarginV=40'"`
- **Con carpeta de fuentes** [OK]: `-vf "subtitles=s.srt:fontsdir=fonts"`. **ASS** [OK]: `-vf "ass=t.ass:fontsdir=fonts"`. Opciones del filtro (de `ffmpeg -h filter=subtitles`): `filename`, `original_size`, `fontsdir`, `alpha`, `charenc`, `stream_index`, `force_style`.
- Los colores ASS son `&HAABBGGRR` (**BGR**, no RGB). `FontName` debe ser el nombre de la **familia** de la fuente que haya en `fontsdir`. Incluir fuentes `.ttf` en el repo (con licencia compatible) y no depender de las del sistema.
- **Windows: rutas y escape** (el problema real):
  - **Solucion recomendada** [OK en Linux]: ejecutar ffmpeg con `cwd` = carpeta del job y usar nombres simples (`job.srt`, `fonts`). No hay nada que escapar.
  - Si hace falta ruta absoluta: barras `/` y escapar los dos puntos: `subtitles='C\:/Users/Usuario/jobs/1/job.srt':fontsdir='C\:/Users/Usuario/jobs/1/fonts'`. En un string de JS cada `\` se duplica: `"subtitles='C\\:/Users/Usuario/jobs/1/job.srt'"`. Comprobado en Linux que el parser acepta `'a\:b.srt'` entre comillas; sin escape falla con `Unable to parse option value "b.srt" as image size`. **No probado con una ruta `C:` real en Windows.**
  - Dentro de `force_style` las comas separan estilos: dejar el valor entre comillas simples y todo el filtro como un solo argumento.
- `drawtext` [OK]: `drawtext=fontfile='/ruta/fuente.ttf':text='Hola\: mundo':fontcolor=white:fontsize=64:box=1:boxcolor=black@0.5:boxborderw=12:x=(w-text_w)/2:y=h-th-80:enable='between(t,0.5,1.5)'`. En Windows: `fontfile='C\:/Windows/Fonts/arial.ttf'`.
- Subtitulos animados (karaoke, palabra por palabra): mejor Remotion; el filtro `ass` soporta `\k` pero es limitado.

### 4.10 Mezcla de audio
- **amix + adelay + volume** [OK]: `-i a.mp4 -i b.mp4 -filter_complex "[0:a]volume=1.0[a0];[1:a]adelay=2000|2000,volume=0.5[a1];[a0][a1]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]" -map 0:v -map "[a]" -c:v copy -c:a aac out.mp4`. `adelay` va en **milisegundos por canal** (`2000|2000` para estereo). `normalize=0` evita que amix baje el volumen de cada entrada (FFmpeg >=4.4).
- **Ducking** de musica bajo voz [OK]: `[1:a][0:a]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400[duck];[0:a][duck]amix=inputs=2:normalize=0[a]` (pista 0 = voz, pista 1 = musica).
- **Normalizar** [OK corre]: `-af loudnorm=I=-14:TP=-1.5:LRA=11` (una pasada). Para precision usar dos pasadas con `print_format=json` y `measured_*`.
- Extraer audio [OK]: `-vn -c:a libmp3lame -q:a 2 out.mp3`. Reemplazar audio [OK]: `-i v.mp4 -i a.mp3 -map 0:v -map 1:a -c:v copy -c:a aac -shortest out.mp4`.
- Efectos de voz (detalle en el doc de voz) [OK corren]: tono `asetrate=44100*1.2,aresample=44100,atempo=1/1.2`; eco/reverb simple `aecho=0.8:0.88:60:0.4`; telefono `highpass=f=400,lowpass=f=3400,acompressor`; robot `afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75` (receta de la documentacion de FFmpeg; el resultado sonoro no se evaluo).

### 4.11 Presets de exportacion (guardar como JSON editable en la DB)
| Preset | Comando (resumido) | Notas |
|---|---|---|
| YouTube 1080p [OK] | `-c:v libx264 -preset slow -crf 18 -profile:v high -pix_fmt yuv420p -c:a aac -b:a 192k -ar 48000 -movflags +faststart` | YouTube pide MP4, moov al inicio, perfil High, 2 B-frames, GOP cerrado, CABAC, 4:2:0, AAC-LC 48 kHz; referencia 8 Mbps para 1080p a 24-30 fps y 12 Mbps a 48-60 fps (https://support.google.com/youtube/answer/1722171). Con CRF 18 el bitrate puede pasar eso; para tope `-maxrate 12M -bufsize 24M`. |
| Reels/TikTok 9:16 [OK] | receta 4.3 + `-r 30 -crf 20 -preset medium -c:a aac -b:a 160k -ar 48000 -movflags +faststart` | 1080x1920, H.264, 30 fps (hasta 60), MP4. Longitud maxima: varia por cuenta/fecha, dejar editable. |
| Shorts [OK] | igual que Reels | 1080x1920, 24-60 fps, hasta 180 s (desde 2024-10-15, fuentes de blogs). |
| GIF [OK] | `-vf "fps=12,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5" -loop 0 out.gif` | Paleta en dos pasos dentro de un solo grafo. |
| WebM con alfa [OK] | `-c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 30 -auto-alt-ref 0 out.webm` | ffprobe lo reporta como `pix_fmt=yuv420p` + tag `alpha_mode=1` (asi guarda VP9 el alfa). La entrada debe tener alfa (en la prueba, `color=black@0.0,format=yuva420p`). Para componer: `-c:v libvpx-vp9 -i overlay.webm` **antes** del `-i` (forzar el decoder libvpx para leer el alfa) [OK]. Render de alfa desde Remotion: sin verificar (docs bloqueadas). |
| Proxy de preview [OK] | ver 3.5 | |
| Solo audio | `-vn -c:a libmp3lame -q:a 2` o `-c:a pcm_s16le` | |
- Para un grafo muy largo: `-filter_complex_script grafo.txt` [OK en 6.1.1]. FFmpeg 7+ marca esa opcion como obsoleta a favor de `-/filter_complex grafo.txt`, que **no existe en 6.1** (verificado: "Unrecognized option"). Detectar la version con `ffmpeg -version` y elegir; verificar en 9.0.2. En Windows el limite de linea de comandos de `CreateProcess` es 32 767 caracteres, asi que usar el archivo de grafo cuando sea largo.

### 4.12 Encoders de hardware con respaldo a libx264
1. `ffmpeg -hide_banner -encoders` solo lista lo **compilado**. La build Gyan "full" incluye nvenc, qsv y amf, pero listar no basta: en el sandbox aparecian `h264_nvenc` y `h264_qsv` y ambos fallaron al iniciar (`Cannot load libcuda.so.1`, `Error creating a MFX session: -9`), y `h264_amf` ni existia.
2. **Sondeo real** al arrancar la API, una vez, con cache en `settings`: `ffmpeg -hide_banner -loglevel error -f lavfi -i color=c=black:s=256x256:d=0.2 -c:v h264_nvenc -f null -`. Mirar el **codigo de salida** (0 = usable), no la salida de texto. Orden: nvenc, qsv, amf, libx264 (siempre disponible).
3. Argumentos por encoder (las opciones de nvenc y qsv se comprobaron como validas en 6.1.1; AMF **sin comprobar**, correr `ffmpeg -h encoder=h264_amf` en la maquina destino):
   - libx264: `-c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p`
   - nvenc: `-c:v h264_nvenc -preset p5 -tune hq -rc vbr -cq 21 -b:v 0 -spatial-aq 1 -pix_fmt yuv420p` (presets p1 a p7)
   - qsv: `-c:v h264_qsv -global_quality 21 -preset slow -look_ahead 1`
   - amf: `-c:v h264_amf -quality quality -rc cqp -qp_i 21 -qp_p 23 -qp_b 25`
4. **Respaldo**: si un job con encoder de hardware termina con codigo != 0 y stderr coincide con `/Cannot load|MFX|No device|OpenEncodeSession|AMF|nvenc/i`, repetir **una vez** con libx264, anotarlo en el log del job y desactivar ese encoder en settings. Los filtros corren en CPU de todos modos; para clips cortos de redes `libx264 -preset veryfast` suele bastar. Los encoders de hardware no igualan el CRF de x264 (ficheros mas grandes a igual calidad).

---

## 5. Bootstrap de Windows desde cero

> Todo lo de esta seccion se leyo de los manifiestos oficiales de `microsoft/winget-pkgs` (raw) y de documentacion. **No se ejecuto en Windows.**

### 5.1 Paquetes winget
| ID | Version hoy | Instalador | Notas |
|---|---|---|---|
| `Git.Git` | 2.55.0 | Inno. Silencioso: `/SP- /VERYSILENT /SUPPRESSMSGBOXES /NORESTART` | Soporta ambito usuario y maquina; `ElevationRequirement: elevatesSelf`. |
| `OpenJS.NodeJS.LTS` | 24.19.0 | MSI (wix), **ambito maquina: pide admin/UAC**. Tambien existe un zip portable | Hoy es Node 24 ("Krypton", LTS activa). Node 22 ("Jod") esta en mantenimiento. **Node 26 (26.10.0) aun no es LTS**; en cuanto se promueva, `OpenJS.NodeJS.LTS` puede saltar a 26, asi que **fijar version**: `--version 24.19.0`. Para quedarse en 22 (lo que dice el plan): `OpenJS.NodeJS.22` (hoy 22.23.2). |
| `Python.Python.3.11` | 3.11.9 | Burn. En el manifiesto: `Custom: InstallAllUsers=0 PrependPath=1` (usuario) o `InstallAllUsers=1 PrependPath=1` (maquina) | 3.11.9 es el ultimo 3.11 con instalador binario (versiones posteriores solo salen como fuente). |
| `Gyan.FFmpeg` | 9.0.2 | ZIP **portable** (`ffmpeg-9.0.2-full_build`), alias `ffmpeg`, `ffprobe`, `ffplay` | Build "full" GPL-3.0 (nvenc/qsv/amf, libass...). Se ejecuta como proceso externo, sin enlazar. |
| `pnpm.pnpm` | 12.8.1 en winget (npm ya tiene 12.9.1) | | Alternativa a `npm i -g pnpm@12`. |

Comando tipo (sin interaccion): `winget install -e --id <ID> --silent --accept-package-agreements --accept-source-agreements [--scope user|machine] [--version X]`. Instalar con `--scope user` donde el manifiesto lo permite (Git, Python, FFmpeg); **Node necesita admin**, asi que `setup.ps1` debe pedir elevacion una sola vez (`Start-Process pwsh -Verb RunAs`). Si `winget` no existe (Windows 10 sin "App Installer"): instalar "App Installer" desde la Store o abortar con mensaje claro.

### 5.2 PATH
- Tras instalar con winget, **la sesion actual no ve los cambios**. Recargar:
  `$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')`
- FFmpeg por usuario (si no se usa winget): copiar a `%LOCALAPPDATA%\Programs\ffmpeg\bin` y
  `$u=[Environment]::GetEnvironmentVariable('Path','User'); [Environment]::SetEnvironmentVariable('Path',"$u;$env:LOCALAPPDATA\Programs\ffmpeg\bin",'User')`.
  **No usar `setx PATH`**: trunca a 1024 caracteres. Para que la API no dependa del PATH, aceptar `FFMPEG_PATH` y `FFPROBE_PATH` en `.env` y resolverlos al arrancar (`where.exe ffmpeg` como respaldo).
- Segun el comportamiento documentado de winget para paquetes portables, crea enlaces en `%LOCALAPPDATA%\Microsoft\WinGet\Links` (en el PATH de usuario); **sin comprobar**, por eso el respaldo `FFMPEG_PATH`.

### 5.3 pnpm y Corepack — hallazgo importante
- **Verificado en el sandbox**: con pnpm 12.9.1, Corepack (0.34.0, el que trae Node 22.22) falla con `Cannot find module '.../pnpm/12.9.1/bin/pnpm.cjs'`. Motivo: **pnpm 12 se publica como binario nativo** (npm lista `bin: { pnpm: 'pnpm' }` con `install.js` y `native-binary.mjs`; pnpm 11 usa `bin/pnpm.mjs`; pnpm 10 usa `bin/pnpm.cjs`) y Corepack no ejecuta el postinstall que lo materializa. Con `npm i -g pnpm@12` el binario funciona y respeta el campo `packageManager`.
- **Corepack**: viene con Node 14.19 hasta 24; **Node 25+ ya no lo incluye** (README de corepack). En Windows `corepack enable` escribe en la carpeta de Node (Program Files) y da `EPERM` sin admin (conocido; sin probar aqui).
- **Decision**: instalar pnpm con `npm i -g pnpm@12` (va a `%APPDATA%\npm`, sin admin) o `winget install pnpm.pnpm`. **No depender de Corepack.** Mantener `"packageManager": "pnpm@12.9.1"` en el `package.json` raiz.
- pnpm 11/12 bloquea por defecto los scripts de build de dependencias: aprobarlos en `pnpm-workspace.yaml` con `allowBuilds` (ver 6.1), o con `pnpm approve-builds`.
- Guardar el almacen en el mismo disco que el proyecto (`pnpm config set store-dir D:\.pnpm-store` si el proyecto esta en D:); si no, pnpm copia en vez de usar enlaces duro y tarda mucho mas.

### 5.4 PowerShell: politica de ejecucion y otras trampas
- Sintoma tipico: `pnpm.ps1 cannot be loaded because running scripts is disabled on this system`. Solucion por usuario: `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force`. Sin tocar la politica: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\setup.ps1`. Ofrecer tambien `setup.cmd` (doble clic) que llame a esa linea.
- Si una politica de grupo la fija, `Get-ExecutionPolicy -List` lo muestra y `-Scope CurrentUser` no gana: documentar el `Bypass` por proceso.
- Archivos descargados como ZIP llevan la marca de la web (Zone.Identifier) y se bloquean: `Get-ChildItem -Recurse scripts | Unblock-File`.
- `.venv\Scripts\Activate.ps1` tambien lo bloquea esa politica: llamar siempre a `.venv\Scripts\python.exe -m ...` sin activar.
- El alias de la Microsoft Store puede secuestrar `python`: desactivar "Alias de ejecucion de aplicaciones" para `python.exe`/`python3.exe`, o usar `py -3.11`.
- `.ps1` en UTF-8 sin BOM puede romper tildes en Windows PowerShell 5.1: guardar los `.ps1` con BOM o evitar tildes en strings (el codigo y los comentarios son en ingles segun el plan). `.gitattributes`: `*.ps1 text eol=crlf`.

### 5.5 Rutas largas
- Activar (admin, Windows 10 1607+): `New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force` y `git config --system core.longpaths true` (o `--global` si no hay admin). Node lo respeta una vez activado.
- Aun asi, clonar en una ruta corta (`C:\dev\studio`): `node_modules` de pnpm anida mucho.

### 5.6 Tres servicios desde un solo `start.ps1`
- Opcion recomendada: **`concurrently` 10.0.5** como devDependency raiz y script `dev:all`: `concurrently -k -n api,py,web -c blue,green,magenta "pnpm --filter @studio/api dev" ".venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8001" "pnpm --filter web dev -H 127.0.0.1 -p 3000"`. `-k` mata a los demas al caer uno y al hacer Ctrl+C. `start.ps1` solo verifica requisitos (Node, pnpm, ffmpeg, `.venv`, `.env`), espera con `wait-on` 9.5.1 (`http-get://127.0.0.1:3000`) y abre el navegador con `Start-Process http://127.0.0.1:3000`.
- Opcion sin Node: `Start-Process -PassThru -WindowStyle Hidden -RedirectStandardOutput logs\api.log -RedirectStandardError logs\api.err.log` por servicio; guardar los PID; en `try/finally` limpiar con `taskkill /PID <pid> /T /F` (`/T` mata el arbol: `pnpm` lanza hijos que `Stop-Process` no alcanza). Sin probar aqui.
- Usar `127.0.0.1` en todas las URLs (`NEXT_PUBLIC_API_URL=http://127.0.0.1:3001`): en Windows `localhost` puede resolver a `::1` primero y no coincidir con un servidor que solo escucha en IPv4.
- Puertos 3000/3001/8001: comprobar antes con `Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue`. Hyper-V/WSL/Docker reservan rangos dinamicos; ver `netsh interface ipv4 show excludedportrange protocol=tcp`. Si el puerto cae ahi, da `EACCES`. Hacer los puertos configurables en `.env`.

### 5.7 Windows Defender, SmartScreen y firewall
- Escuchar solo en `127.0.0.1` **evita el aviso del Firewall de Windows** ("Permitir acceso a node.exe / python.exe"). Si aparece (por escuchar en `0.0.0.0`/`::`), elegir solo "Redes privadas" o Cancelar.
- La proteccion en tiempo real de Defender ralentiza `pnpm install`, la carpeta `node_modules` y la escritura de renders. Opcional con admin: `Add-MpPreference -ExclusionPath 'C:\dev\studio'`. Documentarlo, **no hacerlo automatico**.
- SmartScreen puede avisar al ejecutar ejecutables descargados sin firma (FFmpeg portable, modelos Piper). Los instala winget con hash verificado; para descargas directas, verificar SHA256 en `setup.ps1`.

---

## 6. Convenciones del proyecto

### 6.1 Monorepo pnpm [OK, probado con pnpm 12.9.1, Node 22.22]
```
studio/
  package.json            # private, "type":"module", "packageManager":"pnpm@12.9.1", engines node >=22.12
  pnpm-workspace.yaml
  tsconfig.base.json
  eslint.config.mjs  .prettierrc.json  .prettierignore  .gitattributes  vitest.config.ts
  apps/web/               # Next 16 (no usa estos tsconfig.build)
  apps/api/               # Fastify
  apps/workers/           # Python (FastAPI) con pyproject.toml, fuera del workspace JS
  packages/shared/        # tipos y esquemas zod (el modelo de proyecto de 1.6)
  packages/remotion/  packages/motion-engines/
  scripts/windows/setup.ps1  start.ps1
```
`pnpm-workspace.yaml` (pnpm 11/12; `allowBuilds` es el reemplazo del antiguo `onlyBuiltDependencies`: verificado porque `create-next-app` hoy genera `allowBuilds: { sharp: false, unrs-resolver: false }`):
```
packages:
  - apps/*
  - packages/*
allowBuilds:
  better-sqlite3: true
  esbuild: true
  sharp: true        # next/image; pasar a false si no se usa
```
- `packages/shared` se consume como TypeScript directo: `"exports": { ".": { "types": "./src/index.ts", "default": "./src/index.ts" } }`; en Next anadir `transpilePackages: ["@studio/shared"]`; en la API, `tsx` en desarrollo y `tsc` para compilar (la API importa shared en dev y en build; si el build de la API debe incluir shared, compilarlo antes o bundlear con `tsdown` 0.23.0).
- Python: `uv` 0.12.23 (MIT/Apache-2.0), `ruff` 0.16.10, `pytest` 9.1.1, FastAPI 0.142.2 (MIT), uvicorn 0.54.0, pydantic 2.13.5, faster-whisper 1.2.1 (MIT), python-multipart 0.0.32 (Apache-2.0). Python >=3.10 requerido por FastAPI: 3.11 sirve.

### 6.2 TypeScript estricto (y la trampa de TS 7)
- `tsconfig.base.json` [OK]: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noImplicitReturns`, `verbatimModuleSyntax`, `isolatedModules`, `skipLibCheck`, `forceConsistentCasingInFileNames`, `target/lib ES2023`.
- Web: `module: ESNext`, `moduleResolution: Bundler`, `jsx: react-jsx`, plugin `next`. API: `module/moduleResolution: NodeNext`, `types: ["node"]`, y `tsconfig.build.json` con `outDir` y `rootDir`. Paquete shared: `Bundler`, `noEmit`.
- **TypeScript 7.0.2 ya es `latest`** (compilador nativo). Lo probe: `tsc --noEmit` y `next build` pasan, **pero ESLint se rompe** (`eslint-config-next` falla al cargar) y `typescript-eslint` 8.71.0 declara `typescript >=4.8.4 <6.1.0`. **Fijar `typescript ~6.0.3`** (6.0.3 funciona completo: tsc, lint y build) hasta que typescript-eslint soporte 7.
- `@types/node`: usar `^22` para coincidir con el runtime (el `latest` es 26.x).

### 6.3 ESLint y Prettier
- **ESLint 9.39.5, no 10.12.0**: con ESLint 10 `eslint-config-next` 16.3.8 falla al cargar (probado). `create-next-app` tambien instala `eslint ^9`. Subir a 10 solo cuando `eslint-config-next` lo soporte. (`@eslint/js` 10.0.1 existe: usar `^9.39` para que coincida.)
- Flat config raiz [OK, `pnpm lint` pasa]:
  `import js from '@eslint/js'; import tseslint from 'typescript-eslint'; import prettier from 'eslint-config-prettier'; import { globalIgnores } from 'eslint/config'; export default tseslint.config(globalIgnores(['**/dist/**','**/.next/**','**/.venv/**']), js.configs.recommended, ...tseslint.configs.recommended, { files:['**/*.{ts,tsx}'], rules:{'@typescript-eslint/consistent-type-imports':'error'} }, prettier)`
- En `apps/web`, `eslint.config.mjs` propio con `defineConfig([...nextVitals, ...nextTs, globalIgnores([...])])` importando `eslint-config-next/core-web-vitals` y `eslint-config-next/typescript` (lo que genera `create-next-app`). `next lint` ya no se usa: el script es `eslint`.
- Prettier 3.9.9: `{ "semi": false, "singleQuote": true, "trailingComma": "all", "printWidth": 100, "endOfLine": "lf" }`.
- **Trampa CRLF**: Git en Windows convierte a CRLF y `prettier --check` falla en el runner de Windows. Solucion: `.gitattributes` con `* text=auto eol=lf` (y `*.ps1`, `*.bat`, `*.cmd` en `eol=crlf`) mas `endOfLine: "lf"`.

### 6.4 Vitest [OK]
- Vitest **5.0.3** (MIT; requiere Node `^22.12 || ^24 || >=26`). La config raiz usa `projects`: `defineConfig({ test: { projects: ['packages/*', 'apps/*'] } })` (probado en Vitest 5; el viejo `vitest.workspace` esta obsoleto). Prueba pasada: 1 test en `packages/shared`. Cobertura: `@vitest/coverage-v8` 5.0.3. Tests de API con `fastify.inject()` (viene en Fastify, via light-my-request) sin abrir puertos. Tests E2E de UI: `@playwright/test` 1.63.0 (Apache-2.0), opcional.

### 6.5 GitHub Actions: matriz ubuntu + windows
Versiones de las acciones (leidas de `package.json` en `main` de cada repo; confirmar el tag mayor al escribir el workflow): `actions/checkout` 7.0.1, `actions/setup-node` 7.0.0, `actions/setup-python` 7.0.0, `actions/upload-artifact` 7.0.1, `actions/cache` 6.1.0; `pnpm/action-setup` (README actual: soporta pnpm <=12; para pnpm 11+ existe tambien `pnpm/setup`, que ademas instala Node).
```yaml
name: ci
on: [push, pull_request]
jobs:
  check:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
        node: [22, 24]
    runs-on: ${{ matrix.os }}
    defaults: { run: { shell: bash } }
    steps:
      - uses: actions/checkout@v7          # confirmar tag mayor vigente
      - uses: pnpm/action-setup@v6         # lee packageManager del package.json
      - uses: actions/setup-node@v7
        with: { node-version: "${{ matrix.node }}", cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm format:check
      - run: pnpm typecheck
      - run: pnpm build
      - run: pnpm test
```
- `shell: bash` evita la sintaxis distinta de PowerShell en Windows. Job aparte (`ubuntu-latest`) para Python: `uv sync`, `ruff check`, `pytest`. Job extra "ffmpeg-recipes" en Windows (instalar FFmpeg con winget o chocolatey y correr el smoke test del capitulo 4) para detectar diferencias 6.1.1 vs 9.0.2.
- Node 24 en la matriz detecta pronto problemas de binarios nativos; el desarrollo local sigue en 22 (lo unico probado aqui).

---

## 7. Tabla resumen

| Libreria | Version (2026-10-04) | Licencia | Para que |
|---|---|---|---|
| omniclip (referencia) | repo `main` | MIT | Forma del estado, split historico/no historico |
| @xzdarcy/react-timeline-editor | 1.0.0 | MIT | Modelo fila/accion o timeline MVP |
| OpenVideo / designcombo | 0.2.18 | **OpenVideo License (no OSI)** | Solo UX, no copiar |
| etro | 0.14.1 | **GPL-3.0** | Solo concepto de keyframes |
| @diffusionstudio/core | 4.0.3 | **MPL-2.0 + marca de agua** | Evitar |
| Remotion (`remotion`, `@remotion/player`, `@remotion/renderer`) | 4.0.532 | **Remotion License** (gratis <=3 empleados / personal) | Motion graphics y preview |
| dockview | 8.4.0 | MIT | Paneles acoplables con persistencia |
| flexlayout-react | 0.11.1 | MIT | Plan B de docking |
| react-grid-layout | 2.2.4 | MIT | Widgets de inicio (opcional) |
| react-resizable-panels | 4.14.2 | MIT | Splits simples |
| wavesurfer.js | 8.0.1 | BSD-3-Clause | Waveform con picos precalculados |
| peaks.js | 4.0.0 | **LGPL-3.0** | Evitar |
| @dnd-kit/core, sortable | 6.3.1, 10.0.0 | MIT | Soltar assets, reordenar |
| @dnd-kit/react | 0.5.0 | MIT | Aun 0.x |
| zustand / immer | 5.0.15 / 11.1.21 | MIT | Estado del editor |
| Next.js / React | 16.3.8 / 19.2-19.3 | MIT | Dashboard web |
| Tailwind CSS | 4.3.3 | MIT | Estilos |
| shadcn CLI | 4.21.1 | MIT | Componentes UI |
| cmdk | 1.1.1 | MIT | Paleta de comandos |
| react-hotkeys-hook | 5.3.3 | MIT | Atajos configurables |
| next-themes | 0.4.6 | MIT | Tema claro/oscuro |
| Fastify | 5.12.5 | MIT | API local |
| @fastify/multipart / static / cors / websocket | 10.1.2 / 10.1.5 / 11.3.0 / 11.3.3 | MIT | Subidas, medios, CORS, WS |
| fluent-ffmpeg | 2.1.3 | MIT, **archivado** | Descartado |
| ffmpeg-static | 5.3.0 | GPL-3.0-or-later | No usar (usamos winget) |
| execa | 10.0.1 | MIT | Spawn opcional |
| better-sqlite3 | 13.0.3 | MIT | SQLite principal (Node >=22) |
| node:sqlite | Node 22.5+ | (Node) | Alternativa sin nativos (RC) |
| p-queue | 9.3.3 | MIT | Ejecutor con concurrencia |
| zod | 4.6.5 | MIT | Esquemas compartidos |
| TypeScript | **6.0.3** (7.0.2 sale pero rompe lint) | Apache-2.0 | Tipado estricto |
| ESLint / typescript-eslint | **9.39.5** (10.12.0 sale pero rompe next) / 8.71.0 | MIT | Lint flat config |
| Prettier | 3.9.9 | MIT | Formato |
| Vitest | 5.0.3 | MIT | Tests |
| pnpm | 12.9.1 | MIT | Paquetes (sin Corepack) |
| concurrently / wait-on | 10.0.5 / 9.5.1 | MIT | Levantar servicios |
| FFmpeg (Gyan, winget) | 9.0.2 | GPL-3.0 (proceso externo) | Render |
| Node.js | 22.23.3 (Jod) / 24.21.0 (LTS activa) | MIT | Runtime |
| Python / uv / ruff / pytest | 3.11.9 / 0.12.23 / 0.16.10 / 9.1.1 | PSF / MIT | Workers |
| FastAPI / uvicorn / faster-whisper | 0.142.2 / 0.54.0 / 1.2.1 | MIT / BSD-3 / MIT | Workers Python |

---

## 8. Decisiones y recomendaciones

1. Modelo de proyecto propio en `packages/shared` (secciones 1.6): estado historico/no historico estilo omniclip (MIT), tiempos en segundos; el mismo JSON alimenta preview y compilador FFmpeg.
2. No copiar codigo de OpenVideo, etro, Diffusion Studio, Twick ni Shotstack (licencias no OSI o GPL/MPL); omniclip, react-timeline-editor y fabric-video-editor (MIT) si se pueden consultar.
3. Layout: **dockview** para el workspace del editor (layout en localStorage + tabla `settings`, validado con zod); flexlayout-react como plan B.
4. Timeline propio con pointer events + zustand; dnd-kit core/sortable estable solo para listas y soltar assets.
5. Waveform con wavesurfer.js 8 y picos precalculados por FFmpeg; evitar peaks.js (LGPL). Preview con `<video>` sobre proxy 360p (GOP 15) y `@remotion/player` solo para composiciones.
6. Fastify 5 + SSE manual para progreso (no WebSocket) y CORS explicito; escuchar en 127.0.0.1.
7. No usar fluent-ffmpeg (archivado): `spawn` con array de args, `-progress pipe:1`, ffprobe en JSON, cancelacion con `q` y `taskkill /T`.
8. SQLite con better-sqlite3 detras de un adaptador `db.ts` (plan B `node:sqlite`); cola = tabla `jobs` + p-queue por carril, con recuperacion de `running` al arrancar.
9. Subtitulos en Windows: ejecutar ffmpeg con `cwd` del job y nombres relativos; si no, `C\:/ruta` con barras. Usar `-filter_complex_script` para grafos largos (comprobar `-/filter_complex` en 9.x).
10. Encoders de hardware: sondeo real una vez por arranque (codigo de salida), orden nvenc, qsv, amf, libx264, y un reintento con libx264 si falla.
11. Fijar versiones: **TypeScript ~6.0.3, ESLint ^9.39, `@types/node` ^22**, pnpm 12.9.1 instalado con `npm i -g` (Corepack falla con pnpm 12), `allowBuilds` en `pnpm-workspace.yaml`.
12. Windows: Node con `--version` fijo (24.19.0, o `OpenJS.NodeJS.22`), pedir admin una sola vez por el MSI de Node; Git, Python 3.11.9 y FFmpeg por usuario; recargar PATH en la misma sesion; `FFMPEG_PATH` de respaldo.
13. `start.ps1` con `concurrently -k` + `wait-on`, todo en 127.0.0.1 y puertos configurables; `Bypass` por proceso y `setup.cmd`; `.gitattributes` con LF (y CRLF para `.ps1`).
14. CI: matriz ubuntu + windows y Node 22 + 24, `shell: bash`, job extra que corre el smoke test de recetas FFmpeg en Windows (FFmpeg 9.0.2).
15. Remotion: gratis solo por la regla de <=3 empleados / uso personal; releer la licencia antes de pasar a Remotion 5.

## 9. Pendiente de verificar (fuera de lo que se pudo comprobar)
- Flujo `shadcn init` con Tailwind v4 y Next 16; docs de Remotion (alfa en WebM, Editor Starter); doc oficial de pnpm 12.
- En Windows real: winget silencioso, PATH de enlaces portables, escape `C\:/` en `subtitles`, `start.ps1`, `corepack enable` sin admin, prebuilds de better-sqlite3 13 para Node 22/24, AMF y encoders de hardware reales.
- Tags mayores exactos de las GitHub Actions al redactar el workflow.

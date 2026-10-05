# Prueba end-to-end real — 2026-10-04

QA sobre la rama `claude/funny-mccarthy-0bbdt6`. Probado en el commit `6410dc2` (instantánea aislada) y
repetido en `68fb1d2` (HEAD con el canal de reportes y el manual): **mismo resultado, 23/23 pasos
obligatorios en verde** en las dos.

## Resumen

| Bloque | Resultado |
| ------ | --------- |
| API por HTTP (`scripts/e2e/run-e2e.mjs`) | **23 PASS / 0 FAIL**. 2 pasos «comportamiento esperado» (Whisper y Piper sin modelos) fallan con un mensaje claro |
| Casos límite (`scripts/e2e/probe-limits.mjs`) | 37 observaciones; resultan en los bugs B1, B3, B4, B7, B8 y B11 de `docs/MEJORAS.md` |
| UI con Playwright (`scripts/e2e/ui-smoke.mjs`) | **12 PASS / 0 FAIL**, 6 capturas en `docs/trabajo/capturas/` |
| Workers Python | Arrancan **sin modelos** (`/health` ok, capacidades `whisper/piper/rvc = false`). Transcribir o hacer TTS falla con «Falta el paquete Python … Ejecuta scripts\windows\setup.ps1» |
| Bugs encontrados | 15 (0 críticos, 4 de severidad media). Detalle en `docs/MEJORAS.md` |

## Entorno

- Linux 6.18 en contenedor con 4 vCPU y 15,7 GB de RAM, sin GPU. Node 22.22.0, pnpm 12.9.1, FFmpeg 6.1.1 (Ubuntu) y Python 3.11 (venv de `apps/workers`, sin faster-whisper, piper ni torch).
- Remotion usa `REMOTION_BROWSER_EXECUTABLE=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell`.
- Para no pisar a los otros agentes, los servicios corrieron en puertos propios: api `:3101`, workers `:8101` y web `:3100` (`next build` + `next start`). Cada corrida usó un `STORAGE_DIR` temporal.
- Codificador H.264: `libx264`. La autodetección no encontró NVENC, QSV ni AMF, como corresponde en este contenedor.

## 1. API de punta a punta (`run-e2e.mjs`)

El script genera los medios con `ffmpeg -f lavfi`:
- un video de 10 s (`testsrc2` a 1280×720 y 30 fps, con un tono de 440 Hz);
- un SFX WAV de 3 s;
- un PNG de 640×360;
- un WAV para la biblioteca;
- un `.mp4` corrupto.

Con esos medios recorre todo el flujo por HTTP y verifica cada salida con **ffprobe**.

Tiempos en segundos de tres corridas: «frío» con storage nuevo sobre `6410dc2`, «tibio» repitiendo sobre el mismo storage, y HEAD `68fb1d2`.

| # | Paso | Verificación | Frío | Tibio | HEAD |
| - | ---- | ------------ | ---: | ----: | ---: |
| 1 | health + config + encoders + motores | ffmpeg ok, workers alcanzables, Remotion `ok` | 0,4 | 0,1 | 0,4 |
| 2 | SSE `/api/jobs/events` | `text/event-stream` + `Access-Control-Allow-Origin` | 0,0 | 0,0 | 0,0 |
| 3 | Generar medios con lavfi | 10,0 s | 2,2 | 1,8 | 2,2 |
| 4 | Subida multipart (video, SFX, PNG) | 201 + `MediaAsset` | 0,1 | 0,1 | 0,1 |
| 5 | Jobs `media.probe` + `media.proxy` | duración 10 s, 1280×720, proxy, miniatura, sprite, peaks; SFX 3 s; PNG 640 px | 2,0 | 1,6 | 2,0 |
| 6 | Eventos SSE de los jobs anteriores | ≥4 jobs con `succeeded` | 0,3 | 0,3 | 0,3 |
| 7 | `GET /api/media/:id/file` con `Range` | 206 en el original y en el proxy | 0,0 | 0,0 | 0,0 |
| 8 | `voice.effect` robot sobre el audio del video | WAV pcm_s16le, 48 kHz, 10,0 s | 0,9 | 0,5 | 0,9 |
| 9 | Proyecto y timeline: corte 2–7 s, velocidad ×2 (7–9 s → 1 s), texto, PNG en PiP (escala 0,3, abajo a la derecha), SFX en audio, voz robot en una 2.ª pista de audio, pista motion con 2 clips | `PUT` 200 | 0,0 | 0,0 | 0,0 |
| 10 | `motion.render` de `title-card` en WebM VP9 con alfa y `target` | vp9, `alpha_mode=1`, 1920×1080, 2,5 s; el primer frame decodificado con libvpx da `rgba` | **15,9** | 11,8 | 15,4 |
| 11 | `motion.render` de `animated-captions` con transcripción JSON palabra a palabra escrita a mano | ídem, 3,5 s | **16,3** | 14,2 | 14,6 |
| 12 | Clips enlazados (`renderedAssetId`) | los dos clips enlazados; el asset tiene `hasAlpha=true` | 0,0 | 0,0 | 0,0 |
| 13 | Progreso de motion por SSE | 31–35 eventos por render | 0,0 | 0,0 | 0,0 |
| 14 | Exportar con `youtube-1080p` | h264/aac, 1920×1080, 30 fps, **6,00 s**, audio −26,8 dB de media (no está en silencio) | **10,8** | 8,6 | 10,4 |
| 15 | Exportar con `reels-tiktok` (9:16) | h264/aac, **1080×1920**, 30 fps, 6,00 s, fondo desenfocado | **12,8** | 11,5 | 12,1 |
| 16 | Cancelar un job en curso (render de 60 s) | estado `canceled` 0,7 s después del pedido; el SSE emite `canceled`; no quedan procesos Chrome | 2,0 | 2,0 | 2,0 |
| 17 | Cancelar una exportación 4K en curso | `canceled` en ~2,4 s; borra el archivo parcial de `exports/` | 5,3 | 3,6 | 4,1 |
| 18 | Cancelar un job en cola | pasa de `queued` a `canceled` al instante | 3,3 | 2,9 | 3,3 |
| 19 | Ida y vuelta de settings (tema, paneles, `ui.layout`, `layoutPresets`) | idénticos (sin contar el orden de las claves); un tema inválido da 400 | 0,0 | 0,0 | 0,0 |
| 20 | Biblioteca: copiar un WAV a `storage/library/sfx/e2e/`, `scan`, buscar `campana`, peaks e importar al timeline | `added:1`, 1 resultado, peaks 200, `MediaAsset` de audio | 0,1 | 0,1 | 0,1 |
| 21 | Autoguardado | el snapshot no toca el proyecto guardado; un `PUT` lo borra (después da 404) | 0,0 | 0,0 | 0,0 |
| 22 | Negativos | `.exe` → 415, plantilla inexistente → 400, preset inexistente → 404, JSON en `/api/media` → 415 | 0,0 | 0,0 | 0,0 |
| 23 | `.mp4` corrupto | el job `media.probe` termina en `failed` con «moov atom not found»; el `DELETE` da 204 | 0,4 | 0,4 | 0,4 |
| * | Whisper sin modelos | job `failed`: «Falta el paquete Python 'faster-whisper==1.2.1'…» (esperado) | 0,4 | 0,4 | 0,4 |
| * | Piper sin voces | job `failed`: «Falta el paquete Python 'piper-tts==1.8.0'…» (esperado) | 0,4 | 0,4 | 0,4 |

El total fue de 74 s en frío, 60 s en tibio y 69 s en HEAD. El primer render de Remotion con el
contenedor recién iniciado llegó a **35 s**: incluye el bundle de webpack, que queda en caché en
`storage/tmp/remotion-bundle`.

**Revisión visual** de frames de las exportaciones a 1,2 s, 3,5 s y 5,5 s:
- en `t=1,2` el reloj de `testsrc2` marca 3,2 s, lo que confirma el corte 2–7 s;
- en `t=5,5` marca 8,0 s, lo que confirma la velocidad ×2;
- se ven el título de Remotion con alfa sobre el video, los subtítulos animados con la palabra activa resaltada, el PNG en PiP abajo a la derecha y el texto `drawtext` con «Ñ», «¿» y caja semitransparente;
- en Reels, el lienzo 16:9 queda centrado sobre un fondo desenfocado. No hay auto-reframe: ver MEJORAS.

### Rendimiento medido (4 vCPU, CPU, libx264)

| Operación | Tiempo | Relación con tiempo real |
| --------- | -----: | ------------------------ |
| Subir 60 s de 1080p (41 MB) | 0,6 s | — |
| `media.probe` de 60 s a 1080p (miniatura + sprite + peaks) | 8,7 s | 0,14× |
| `media.proxy` de 60 s a 1080p (proxy 360p) | 14,4 s | 0,24× |
| Exportar 60 s, un solo clip, `youtube-1080p` | 39 s | 0,65× |
| Exportar 60 s, `reels-tiktok` (desenfoque 9:16) | 58 s | 0,97× |
| Exportar 60 s, `youtube-4k` | 121 s | 2× |
| Exportar 6 s con 6 pistas (2 overlays alfa, PiP, texto, 3 audios), `youtube-1080p` | 8,9 s | 1,5× |
| Remotion `lower-third` de 10 s a 1080p en WebM alfa | 36,5 s | 3,6× (≈8 fps) |
| Remotion `title-card` de 2,5 s / `animated-captions` de 3,5 s | 12–16 s | 5–6× |
| Efecto de voz (robot) sobre 10 s | 0,5–0,9 s | 0,07× |

## 2. Casos límite (`probe-limits.mjs`)

| Caso | Comportamiento observado |
| ---- | ------------------------ |
| Nombre `../../..\evil<>.mp4` | 201. Se guarda como `media/<nanoid>.mp4` y se muestra como `evil.mp4` (seguro) |
| `.mp4` de 0 bytes | 201. El probe falla y el asset queda en la lista sin marca de error (UX) |
| Sin extensión y con mime `video/mp4` | 201, `kind: video`, guardado como `.mp4` |
| `.txt` | 415 `UNSUPPORTED_MEDIA_TYPE` |
| `.srt` | 201, `kind: subtitle` |
| Cuerpo JSON de 11 MB | 413, pero con código `INTERNAL_ERROR` (**B8**) |
| `/files/studio.db`, `-wal`, `tmp/`, `../package.json`, `%2e%2e`, listado de `media/` | 404 en todos los casos (bien protegido) |
| Borrar el preset integrado `youtube-1080p` | 409 |
| Motion de 1801 s / a 240 fps / con prop `title: 5` | 400 con el error en español |
| Motion de 7680×4320 | **202** (no hay máximo) |
| Exportar con un clip motion sin renderizar | **`succeeded` sin el overlay**. El aviso queda solo en el log del job (**B3**) |
| Borrar un medio que usa el proyecto y después exportar | `DELETE` 204, export `succeeded` con un hueco negro y sin avisar (**B4**) |
| Clip con `in=8` y `out=15` sobre una fuente de 10 s | export de 7 s (congela el último frame y completa el audio con silencio) |
| Velocidad 0,25 y 16 con audio | correcto (2,63 s = 0,5/0,25 + 10/16) |
| Texto `50% off: it's {x} \ done; [a] 'b' %{pts}` | se dibuja literal y correcto (`textfile` + `expansion=none`) |
| Timeline solo de audio | MP4 1920×1080 en negro con audio |
| Lienzo de 20000×20000 | el `PUT` acepta (200) y la exportación falla con «Nothing was written into output file» (**B7**) |
| Proyecto vacío / rango con inicio > fin | `failed`: «El proyecto no tiene contenido para exportar en ese rango» |
| Rango 1–2,5 s | 1,50 s exactos |
| `gif-480` / `webm-alpha` / `youtube-shorts` | GIF 480×270 sin audio / VP9 `alpha_mode=1` + Opus / 1080×1920 a 60 fps |
| Clip con `start=-1` e `in>out` | 400 `VALIDATION_ERROR` |
| 3 exportaciones a la vez | `running, running, queued` (carril ffmpeg = 2) |
| Efecto de voz sobre una imagen | job `failed`: «El asset no tiene audio» |
| Transcribir una imagen | 400 «Solo se pueden transcribir medios de audio o video» |
| Render con `motion-canvas/hello-circle` | **202** y después un job `failed` con el mensaje en inglés (**B11**) |
| Importar de la biblioteca (`registerAudioAsset`) | encola `media.proxy`, que **siempre falla**: «Solo se generan proxies para video» (**B1**) |

## 3. UI con Playwright (`ui-smoke.mjs`)

Corrió con Chromium headless de Playwright 1.56.1, en tema oscuro y a 1366×820, contra `next build` + `next start`.

| Paso | Resultado | Tiempo |
| ---- | --------- | -----: |
| El dashboard carga: 10 pestañas en 4 grupos de dockview y el estado «Guardado» | PASS | 0,6 s |
| Subir video, WAV y PNG desde el panel Media (`input[type=file]`) y esperar las miniaturas | PASS | 2,4 s |
| Arrastrar el video a «Video 1» (dnd-kit) y añadir el WAV con el botón «+» | PASS | 0,6 s |
| Ocultar «Voz y audio» desde el menú Paneles y mover «Biblioteca» al grupo de la vista previa (drag nativo de dockview) | PASS | 3,9 s |
| El layout persiste tras recargar (localStorage) **y en un navegador nuevo** (copia guardada en la api) | PASS | 3,6 s |
| Layouts → «Restaurar layout» | PASS | 1,0 s |
| Motion: elegir «Título», editar Título y Subtítulo, «Renderizar y añadir» | PASS | 1,4 s |
| El panel Trabajos muestra el progreso en vivo por SSE (barra de progreso «En curso») y luego «Completado» | PASS | 15–35 s |
| El clip motion del timeline muestra el render en la vista previa | PASS | 2,3 s |
| Panel Exportar | PASS | 1,0 s |
| Paleta de comandos (Ctrl+K) | PASS | 0,6 s |

Capturas en PNG, todas de 95–150 KB, para el manual:

| Archivo | Contenido |
| ------- | --------- |
| `docs/trabajo/capturas/01-dashboard.png` | Dashboard con medios, video en la vista previa, Propiedades del clip y timeline |
| `docs/trabajo/capturas/02-timeline-motion.png` | Título de Remotion renderizado en la vista previa y clip en la pista Motion |
| `docs/trabajo/capturas/03-motion-form.png` | Formulario de la plantilla «Título» con la vista previa aproximada |
| `docs/trabajo/capturas/04-jobs-progress.png` | Panel Trabajos con un render en curso (16 %) |
| `docs/trabajo/capturas/05-export-panel.png` | Panel Exportar (muestra el bug B5: preset GIF por defecto con «MP4/H.264») |
| `docs/trabajo/capturas/06-command-palette.png` | Paleta de comandos |

Notas de la UI:
- El Chromium de Playwright **no decodifica H.264/AAC**; Chrome y Edge sí. Sin ayuda, la vista previa del video mostraba «El navegador no puede reproducir… Genera un proxy», aunque el proxy ya existía (**B12**). Para las capturas, el flag `--vp9-preview` transcodifica al vuelo los MP4 a VP9. Eso solo afecta a la captura, no a la app.
- El único error de consola es un `404` esperado: `GET /api/projects/<id local>` antes de crear el proyecto en la api.

## 4. Límites reales (código + comportamiento)

| Tema | Límite | Dónde |
| ---- | ------ | ----- |
| Tamaño de subida a `/api/media` | **20 GB por archivo**, guardado en streaming a disco (`.part` + `rename`). Si se supera: 413 `FILE_TOO_LARGE`. Un archivo por petición | `apps/api/src/app.ts:93`, `routes/media.ts` |
| Subida a la biblioteca (`/api/library/import` multipart) | El mismo tope de 20 GB, pero **carga el archivo entero en RAM** (`toBuffer`) | `routes/library.ts:113` |
| Cuerpo JSON (proyectos, settings) | 10 MB; si se supera, 413 | `app.ts:73` |
| Extensiones de video | mp4 mov mkv webm avi m4v mts m2ts ts wmv flv mpg mpeg 3gp gif | `services/media-files.ts` |
| Extensiones de audio | mp3 wav m4a aac flac ogg opus wma aif aiff | ídem |
| Extensiones de imagen | png jpg jpeg webp bmp tif tiff | ídem |
| Otros tipos | subtítulos srt ass vtt · Lottie json lottie | ídem |
| Archivos sin extensión | se deduce el tipo por mime (`video/*`, `audio/*`, `image/*` y algunos conocidos); lo demás da 415 | ídem |
| Biblioteca (audio) | .wav .mp3 .ogg .oga .opus .flac .m4a .aac; tipos sfx, music y ambience; escaneo con 4 en paralelo; búsqueda FTS5 de hasta 100 por página | `library/index-db.ts:23` |
| Validación de contenido | no se valida al subir; un archivo corrupto se acepta (201) y falla en `media.probe` | probado |
| Duración máxima de un medio o de una exportación | **sin límite** en el código (el límite práctico es el disco y el tiempo de CPU) | — |
| Duración y fps de motion | Remotion ≤ 1800 s y ≤ 120 fps; ffmpeg-lottie ≤ 600 s y ≤ 60 fps; motion-canvas es un stub | `motion-engines` (capacidades) |
| Resolución de motion | sin máximo (7680×4320 aceptado) | probado |
| Lienzo del proyecto | cualquier entero positivo, redondeado a par; **sin máximo** (20000×20000 aceptado y luego falla) | `packages/shared/src/timeline.ts:88` |
| Ajuste de clips al lienzo | *contain* (escala sin recortar) + relleno transparente; PiP con escala de 0,05 a 1 y posición de 0 a 1 | `services/ffmpeg/timeline.ts` |
| Reencuadre al exportar | Si el aspecto es igual, escala y rellena. Si es distinto (16:9 → 9:16), usa fondo desenfocado. Los presets con alfa rellenan con transparencia | `timeline.ts:485-506` |
| Proxies | H.264 a 360p con keyframe cada 15 frames | `builders.ts:598` |
| Clip | velocidad 0,1–16, volumen 0–4, opacidad 0–1, transición ≤ 10 s | `shared/timeline.ts` |
| Voz | pitch ±24 st, eco ≤ 5000 ms, `speed` 0,25–4; TTS de 1 a 20 000 caracteres a velocidad 0,5–2; RVC con pitch ±24 | `shared/voice.ts` |
| Presets integrados | `youtube-1080p` (30 fps, CRF 20), `youtube-4k` (CRF 18), `reels-tiktok` 1080×1920 a 30 fps, `youtube-shorts` 1080×1920 a 60 fps, `gif-480` (12 fps), `webm-alpha` (VP9 + Opus). Los integrados no se pueden borrar (409) | `shared/export.ts` |
| Concurrencia de la cola | Carriles: ffmpeg **2** (1–8), motion **1** (1–4), workers **1** (1–4). Variables `QUEUE_*_CONCURRENCY`. El probe tiene prioridad 1 pero **comparte carril** con las exportaciones (no se adelanta a una que ya corre) | `config.ts`, `jobs/state.ts` |
| Remotion | Pestañas = 50 % de los hilos (`REMOTION_CONCURRENCY`); timeout de carga de 60 s por frame | `.env.example` |
| Jobs | Progreso cada ≥ 500 ms, heartbeat SSE cada 15 s, log de 40 líneas, 2 reintentos tras reinicio; listado de hasta 500 jobs y 5000 medios | `jobs/queue.ts`, `routes/*.ts` |
| Codificador | `HW_ENCODER=auto` prueba NVENC, QSV y AMF y vuelve a libx264 si fallan (y deshabilita el que falló) | `services/encoder-select.ts` |
| Archivos estáticos | `/files/*` sirve `STORAGE_DIR` salvo `studio.db*`, `tmp/` y `*.part` | `app.ts` |
| Deshacer en la web | 100 pasos en memoria (no persisten) | `apps/web/src/stores/project-store.ts:40` |

## 5. Cómo reproducir

### Linux / contenedor (lo que se ejecutó)

```bash
pnpm build:packages && pnpm --filter @studio/api build
# workers sin modelos (venv de apps/workers)
STORAGE_DIR=/tmp/st WORKERS_PORT=8101 apps/workers/.venv/bin/python -m studio_workers &
# api con storage temporal + Chrome Headless Shell de Playwright
cd apps/api && STORAGE_DIR=/tmp/st API_PORT=3101 WORKERS_URL=http://127.0.0.1:8101 \
  REMOTION_BROWSER_EXECUTABLE=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell \
  node dist/index.js &
cd ../.. && node scripts/e2e/run-e2e.mjs --api http://127.0.0.1:3101 --storage /tmp/st
node scripts/e2e/probe-limits.mjs --api http://127.0.0.1:3101
# web contra esa api
cd apps/web && NEXT_PUBLIC_API_URL=http://127.0.0.1:3101 npx next build && npx next start -p 3100 &
cd ../.. && node scripts/e2e/ui-smoke.mjs --web http://127.0.0.1:3100 --api http://127.0.0.1:3101 \
  --media <carpeta con .mp4/.wav/.png> --shots /tmp/capturas --vp9-preview \
  --playwright /opt/node22/lib/node_modules/playwright/index.mjs
```

> La api y los workers **deben compartir `STORAGE_DIR`**. Los workers leen `tmp/<job>.wav` relativo a
> su propio storage; si no coincide, la transcripción falla con «No existe el audio de entrada».

### Windows (después de `setup.ps1`, con `start.ps1` en marcha)

```powershell
node scripts\e2e\run-e2e.mjs --api http://127.0.0.1:3001
```

- Necesita `ffmpeg` y `ffprobe` en el PATH (los instala `setup.ps1`). Si no están, usar `--ffmpeg C:\ruta\ffmpeg.exe --ffprobe C:\ruta\ffprobe.exe`.
- `--storage` apunta por defecto a `<repo>\storage`, que es el `STORAGE_DIR` por defecto. Hace falta para la prueba de biblioteca (copia un WAV) y para comprobar que la exportación cancelada no deja archivos.
- Si los modelos están instalados, los dos pasos «comportamiento esperado» (Whisper y Piper) deberían pasar a PASS.
- **Deja datos de prueba** en el storage: proyecto «E2E Prueba Ñandú», medios `e2e-*`, exportaciones y el item de biblioteca `e2e`. Para no mezclarlos, lanzar la api con un storage temporal: `$env:STORAGE_DIR="$env:TEMP\studio-e2e"; node apps\api\dist\index.js`.
- Sin Chrome Headless Shell, usar `--skip-motion`.
- El informe JSON queda en `%TEMP%\studio-e2e-<marca>\report.json`; se puede cambiar con `--out`. El código de salida es 0 si todos los pasos obligatorios pasan.
- Prueba de UI opcional:

```powershell
npm i -g playwright; npx playwright install chromium
node scripts\e2e\ui-smoke.mjs --web http://localhost:3000 --api http://127.0.0.1:3001 --media C:\videos\prueba --shots $env:TEMP\capturas --playwright "$env:APPDATA\npm\node_modules\playwright\index.mjs"
```

## 6. Archivos añadidos

- `scripts/e2e/run-e2e.mjs`: e2e de la API sin dependencias (Node 22 + ffmpeg).
- `scripts/e2e/probe-limits.mjs`: casos límite. Solo observa; no falla.
- `scripts/e2e/ui-smoke.mjs`: humo de la UI con Playwright y capturas.
- `docs/trabajo/capturas/*.png`: 6 capturas.
- `docs/MEJORAS.md`: bugs, carencias de UX y backlog priorizado.

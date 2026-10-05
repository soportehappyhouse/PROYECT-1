# Módulo (b) — API + FFmpeg + cola + export + media

## Hecho
- **Cola** (`apps/api/src/jobs`): carriles `ffmpeg`(2) / `motion`(1) / `workers`(1) con p-queue (configurable `QUEUE_*_CONCURRENCY`), estado en SQLite (`attempts`, `priority`, `log_tail`), `claimNext` atómico (`UPDATE … RETURNING`), máquina de estados (`state.ts`), progreso con throttle (500 ms), cancelación (AbortSignal → `q` a ffmpeg → kill del árbol), reintento al reiniciar (running → queued hasta 2 intentos), `stop()` re-encola. Jobs sin handler quedan `queued`.
- **Contrato de handlers**: `JobHandler {type, lane?, parse, run(payload, ctx, job)}`; `ctx` = `jobId, signal, reportProgress, log, storageDir`. Los de (b) se registran con `registerModuleBHandlers(ctx)` en `app.ts`; (c)/(d) registran los suyos ahí mismo.
- **SSE** `GET /api/jobs/events` (`?jobId=a,b` opcional): `reply.hijack()`, CORS manual, replay de jobs activos, heartbeat 15 s. `GET /api/jobs/:id/log`.
- **Media**: upload multipart a `media/<id>.<ext>` (nombre del cliente solo como etiqueta), `media.probe` (ffprobe → metadatos + JSON crudo en `media.probe`, miniatura, sprite sheet, peaks `proxies/<id>.peaks.json` formato `WaveformPeaks` v1 de dashboard.ts), `media.proxy` (360p, GOP 15), `GET /api/media/:id/file` con Range (`?proxy=1`, `?download=1`), `/files/*` con Range y sin exponer `studio.db`/`tmp/`.
- **Proyectos**: CRUD, `PUT|GET /api/projects/:id/autosave` (snapshot de recuperación, se borra al guardar). **Settings**: `DashboardSettingsWithUi` completo (layout dockview incluido). **Presets**: sembrados (4 del contrato + GIF + WebM alfa), CRUD, built-ins editables pero no borrables (409).
- **FFmpeg** (`services/ffmpeg/`): `runner` (spawn sin shell, `-progress pipe:1`), `probe`, `builders` (trim preciso, trim+concat filter, 9:16 con fondo desenfocado, velocidad setpts/atempo encadenado, overlay, PiP, fades, xfade, subtítulos SRT/ASS, amix/adelay, miniatura/sprite/proxy/PCM/extract WAV), `escape` (rutas Windows `C\:/…`, comillas), `audio-fx` (cadenas exactas de fuentes-audio §4: pitch ±, chipmunk, deep, robot, teléfono, radio, megáfono, bajo el agua, reverb, eco, denoise, loudnorm 2 pasadas, ducking; rubberband si existe), `encoders` (sondeo real nvenc/qsv/amf, fallback libx264 una vez y se desactiva), `timeline` (Project → un solo `filter_complex` vía `-filter_complex_script` / `-/filter_complex` según versión).
- **Export** `project.export`: capas en orden de `tracks` (0 = abajo), clips secuenciales con huecos transparentes, xfade usando el "handle" previo al `in` del clip entrante (si no hay, fade), texto con `drawtext textfile=` (sin escapes), motion = asset renderizado (`renderedAssetId`, VP9 alfa con libvpx), audio de video+audio con efectos/volumen/velocidad, subtítulos del proyecto quemados, rango, reencuadre al preset (blur si cambia el aspecto), GIF paleta, WebM alfa. Salida `exports/<slug>-<fecha>.<ext>`.
- Rutas extra en `API_ROUTES_EXT` (`/api/system/encoders`, `/api/voice/effects/presets`, autosave, job log).

## Pendiente / límites
- `Clip` no tiene posición/escala: PiP/overlay posicionado existe como builder pero el timeline siempre ajusta a cuadro completo.
- Ducking y loudnorm 2 pasadas solo en `voice.effect`; dentro del timeline loudnorm es 1 pasada y ducking se omite (aviso en el log).
- AMF sin probar (no hay GPU); rutas Windows reales sin probar (escape testeado en unit tests + ruta rara en Linux).
- `.env.example` (raíz) no documenta `HW_ENCODER`, `QUEUE_*_CONCURRENCY` (tienen defaults).

## Cómo probar
- `pnpm --filter @studio/api lint typecheck build test` (unit + integración con `ffmpeg -f lavfi`; se saltan si no hay ffmpeg).
- Manual: `pnpm dev:api`, `curl -F file=@video.mp4 localhost:3001/api/media`, `curl -N localhost:3001/api/jobs/events`.

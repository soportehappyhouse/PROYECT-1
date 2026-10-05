# Módulo (c) — Remotion + motores de motion (estado 2026-10-04)

## Hecho
- `packages/remotion`: 9 plantillas con props zod (defaults en español, JSON Schema con `format: color|textarea`), una `<Composition>` + miniatura `<id>-thumb` (1/4, frame congelado) por plantilla: `title-card` (5 estilos), `lower-third` (4 estilos, entrada/salida configurables), `animated-captions` (highlight/karaoke/pop/caja, zona segura auto 9:16/16:9, transcripción faster-whisper o `Caption[]`), `transition` (fade/slide/wipe/flip entre 2 medios con `@remotion/transitions`), `audio-visualizer` (barras/onda/espejo), `lottie-overlay` (Lottie propio de ejemplo), `end-screen`, `progress-bar` (capítulos), `kinetic-typography`.
- Fuentes Google vía `@remotion/google-fonts`; sin red cae a la fuente del sistema (no rompe el render). `REMOTION_FONTS=system` evita descargas.
- Render Node (`renderMotion`, firma estable): bundle cacheado en disco por hash de `src/` (`storage/tmp/remotion-bundle/<hash>`), `selectComposition` + `renderMedia`/`renderFrames`, mp4 h264, webm vp9 `yuva420p`, ProRes 4444, secuencia PNG; progreso por fases; cancelación (`AbortSignal` → `makeCancelSignal`).
- Chrome Headless Shell: se busca sin descargar (`REMOTION_BROWSER_EXECUTABLE` o `node_modules/.remotion` en raíz, `packages/remotion`, `apps/api`, cwd). Si falta: `RemotionBrowserMissingError` (código `BROWSER_MISSING`) con el comando a ejecutar; `/api/motion/engines` lo muestra como `ok:false`.
- `packages/motion-engines`: capacidades `supportsAlpha/maxFps/maxDurationSec/formats`, `registry.validate()` (plantilla+formato+fps+props, nunca lanza), `MotionValidationError`, `outputExtension`, `overallProgress`. Adaptadores: remotion (completo), **ffmpeg-lottie real** (plantilla `ffmpeg-title`: drawtext con fundido+subida, fondo color/transparente/video/imagen, overlay alpha WebM/MOV con decoder libvpx, salida a los 4 formatos, FFmpeg de sistema), motion-canvas (stub documentado `NOT_IMPLEMENTED`, camino Revideo, `MOTION_CANVAS_EXAMPLE_SPEC`).
- api: `jobs/handlers/motion-render.ts` (valida `MotionSpec`, renderiza a `storage/renders/<jobId>.<ext>`, progreso, registra `MediaAsset` con `hasAlpha`) y `routes/motion.ts` (`POST /api/motion/render` → 400 con errores en español o 202 `{jobId}`). El handler y el adaptador Remotion completo se registran desde `routes/motion.ts` (autocontenido; idempotente).
- Probado en el sandbox con un headless_shell local: render real de las 9 plantillas, alpha WebM (`alpha_mode=1`), transición con video+imagen, visualizador con audio, job end-to-end por la cola.

## Pendiente / pedidos a otros módulos
- (orquestador) `packages/shared`: añadir a `REMOTION_TEMPLATE_IDS` los 5 ids nuevos; opcional `category`, `defaultSize`, `thumbnail` en `MotionTemplateInfoSchema` (hoy van como extras).
- (b) `app.ts`: usar `createDefaultRegistry({ remotion: REMOTION_ENGINE_OPTIONS, ffmpegPath })` y registrar `createMotionRenderHandler(ctx)` ahí (hoy lo hace la ruta).
- (b/d) `.env.example` + `ApiConfig`: `REMOTION_CONCURRENCY` (def. `50%`), `REMOTION_BROWSER_EXECUTABLE`, `REMOTION_HW_ACCEL`, `REMOTION_FONTS`, `REMOTION_BUNDLE_CACHE`, `REMOTION_TIMEOUT_MS`.
- (d) `setup.ps1`: `pnpm --filter @studio/remotion browser:ensure` (la carpeta de descarga depende del cwd).
- `spec.seed` aún no se usa; rasterizador Lottie propio (puppeteer+lottie-web) para ffmpeg-lottie; motor Revideo.
- `zod` fijado a 4.5.4 en `packages/remotion` (lo exige Remotion Studio); el resto del repo usa ^4.6.5.

## Cómo probar en Windows
1. `pnpm install` y `pnpm --filter @studio/remotion browser:ensure` (o `setup.ps1`).
2. Studio: `pnpm --filter remotion studio` (o `-- --port 3010` si la web ya usa el 3000) (carpetas Plantillas / Miniaturas, props editables).
3. CLI: `pnpm --filter remotion render --list`; `pnpm --filter remotion render --template lower-third --format webm-vp9-alpha --out out\lt.webm`; miniatura: `--thumb --out out\lt.png`; medios: `--storage ..\..\storage --media fromSrc=video:media\a.mp4`.
4. Tests: `pnpm --filter remotion --filter motion-engines test` (el render real corre solo si hay Chrome; el de FFmpeg solo si hay `ffmpeg` con drawtext).
5. API: `POST http://127.0.0.1:3001/api/motion/render` con `{"template":"title-card","durationSec":3,"format":"webm-vp9-alpha","props":{"title":"Hola","background":"transparent"}}`.

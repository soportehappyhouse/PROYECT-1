# Fuentes: motion graphics (Remotion, Motion Canvas, FFmpeg+Lottie)

Fecha de verificacion: 2026-10-04. Versiones leidas del registro npm y del codigo fuente en GitHub ese dia.
Marca de verificacion: **[V]** = verificado (npm / repo / ejecutado en sandbox). **[NV]** = no verificado, hay que probarlo en Windows.
Nota: `www.remotion.dev` estaba bloqueado por el proxy del sandbox. La documentacion de Remotion se leyo desde su fuente en el repo (`packages/docs/docs/*.mdx`, commit `e385a83`, 2026-10-03), que es la misma que publica el sitio.

## Tabla resumen

| Herramienta | Version (2026-10-04) | Licencia | OK para uso personal? |
|---|---|---|---|
| remotion, @remotion/cli, /renderer, /bundler, /lottie, /google-fonts, /player, /install-whisper-cpp | 4.0.532 | Remotion License (gratis: individuos, empresas <=3 personas, ONG) | Si |
| @remotion/transitions | 4.0.532 | npm dice `UNLICENSED`; la doc del paquete dice "Remotion License" | Si (misma licencia Remotion) |
| @remotion/media | 4.0.532 | campo `license` vacio en npm; aplica LICENSE.md del monorepo (Remotion License) | Si |
| @remotion/captions, /media-utils, /layout-utils, /shapes, /paths, /noise, /motion-blur, /animated-emoji, /zod-types, /three, /skia | 4.0.532 | MIT | Si |
| Remotion `ffmpeg`/`ffprobe` empaquetado (compositor) | FFmpeg n7.1 | GPLv2+ (build `--enable-gpl`) | Si, solo se usa localmente (no se redistribuye) |
| remotion-dev/template-tiktok, template-audiogram, template-overlay, template-music-visualization, template-render-server | main (2026-10) | `package.json` dice `UNLICENSED`, sin archivo LICENSE; el README remite a la Remotion License | Si, bajo la Remotion License. No son MIT: no re-publicar como plantilla |
| Motion Canvas (@motion-canvas/core, 2d, vite-plugin, ffmpeg, create) | 3.17.2 | MIT (ver nota de licencia del exportador FFmpeg en la seccion 3) | Si |
| Revideo (@revideo/core, renderer, 2d, ffmpeg, cli), fork de Motion Canvas con render headless | 0.11.0 | MIT | Si |
| lottie-web | 5.13.0 | MIT | Si |
| puppeteer-lottie / puppeteer-lottie-cli | 1.1.2 / 1.0.9 (ultimo cambio 2022-05) | MIT | Si, pero abandonado (puppeteer 2.x) |
| ThorVG (motor Lottie en C++) | main | MIT | Si (opcional) |
| FFmpeg de sistema (winget `Gyan.FFmpeg`, build "full" de gyan.dev) | 9.0.2 segun winget; en sandbox se probo 6.1.1 | GPL (build full) | Si, uso local |
| LottieFiles (animaciones .json de terceros) | n/a | cada animacion trae su licencia propia | Revisar una por una |

---

## 1. Remotion

- Repo: https://github.com/remotion-dev/remotion (monorepo). Docs: https://www.remotion.dev/docs
- Version mayor actual: **4.x, ultima 4.0.532** (`npm view remotion version`). Dist-tags: `latest 4.0.532`, `alpha 4.1.0-alpha12`. Remotion 5.0 **no esta publicado**; `5-0-migration.mdx` lista cambios previstos. Anclar **todas** las dependencias `@remotion/*` a la misma version exacta (sin `^`).
- Peer deps: `react` y `react-dom` >= 16.8. Los templates oficiales usan React 19.2.x y TypeScript 5.9.
- Node: el `engines` de `@remotion/cli` dice `>=16` [V]. Remotion 5.0 subira el minimo. El plan usa Node 22 LTS, compatible.

### Paquetes necesarios

```bash
# pin exacto, misma version para todos
pnpm add -E remotion@4.0.532 @remotion/cli@4.0.532 @remotion/renderer@4.0.532 \
  @remotion/bundler@4.0.532 @remotion/captions@4.0.532 @remotion/transitions@4.0.532 \
  @remotion/media-utils@4.0.532 @remotion/google-fonts@4.0.532 @remotion/lottie@4.0.532 \
  @remotion/layout-utils@4.0.532 @remotion/media@4.0.532 @remotion/zod-types@4.0.532 \
  @remotion/install-whisper-cpp@4.0.532 lottie-web@5.13.0 react react-dom zod
```

| Paquete | Para que | Licencia |
|---|---|---|
| `remotion` | nucleo (`Composition`, `Sequence`, `interpolate`, `spring`, `AbsoluteFill`, `OffthreadVideo`) | Remotion |
| `@remotion/cli` | `remotion studio`, `remotion render`, `remotion browser ensure` | Remotion |
| `@remotion/renderer` | API SSR: `renderMedia`, `selectComposition`, `renderStill`, `ensureBrowser`, `makeCancelSignal` | Remotion |
| `@remotion/bundler` | `bundle()` (webpack/rspack) | Remotion |
| `@remotion/captions` | tipo `Caption`, `createTikTokStyleCaptions()`, `parseSrt`, `serializeSrt` | MIT |
| `@remotion/transitions` | `<TransitionSeries>`, presentaciones `fade/slide/wipe/flip/clock-wipe/iris/cube/...`, timings | Remotion |
| `@remotion/media-utils` | `visualizeAudio`, `useWindowedAudioData`, `getVideoMetadata`, forma de onda | MIT |
| `@remotion/google-fonts` | `loadFont()` por fuente (`@remotion/google-fonts/Roboto`) | Remotion |
| `@remotion/lottie` + `lottie-web` | componente `<Lottie>` | Remotion + MIT |
| `@remotion/layout-utils` | `fitText`, `fillTextBox` (medir texto) | MIT |
| `@remotion/install-whisper-cpp` | transcripcion palabra a palabra (usada por template-tiktok). El plan usa faster-whisper en Python; este paquete es opcional | Remotion |

### Licencia (resumen para uso personal) [V]

Fuente: https://github.com/remotion-dev/remotion/blob/main/LICENSE.md y `docs/license/faq.mdx`.
- **Licencia gratuita** si eres: individuo (uso personal **o comercial**), organizacion con hasta 3 personas, ONG, o estas evaluando. Sin diferencia de funcionalidad. No hay que registrarse ni contactar.
- Prohibido: copiar o modificar Remotion para vender/sublicenciar un derivado; vender Remotion como producto; permitir que terceros suban proyectos Remotion arbitrarios a tu servidor para renderizar.
- Permitido: renders automatizados y plantillas parametrizables para uso propio. Un dashboard local personal cumple.
- Remotion 5.0 (futuro): se pedira pasar `licenseKey` a las APIs de render; para la licencia gratuita se pasa el literal `"free-license"`. Hoy (4.x) es opcional/voluntario.
- Los paquetes MIT (`captions`, `media-utils`, `layout-utils`, ...) se pueden copiar/reutilizar sin las restricciones anteriores.

### Render server-side desde Node (bundle + renderMedia) [V]

Patron oficial (`packages/docs/docs/ssr-node.mdx`):

```ts
import {bundle} from '@remotion/bundler';
import {renderMedia, selectComposition, ensureBrowser} from '@remotion/renderer';
import path from 'node:path';

await ensureBrowser(); // descarga Chrome Headless Shell si falta (una vez)

// 1) Bundle: una sola vez, reutilizable en muchos renders
const serveUrl = await bundle({
  entryPoint: path.resolve('./packages/remotion/src/index.ts'),
  publicDir: path.resolve('./data/media'), // carpeta servida via staticFile()
});

// 2) Metadatos de la composicion con las mismas inputProps
const inputProps = {titleText: 'Hola'};
const composition = await selectComposition({serveUrl, id: 'TitleCard', inputProps});

// 3) Render
await renderMedia({
  composition,
  serveUrl,
  codec: 'h264',                 // 'vp8' | 'vp9' | 'prores' para alpha, ver abajo
  outputLocation: 'out/title.mp4',
  inputProps,
  concurrency: '50%',            // por defecto: mitad de los hilos de CPU
  onProgress: ({progress}) => console.log(progress),
  // cancelSignal: makeCancelSignal().cancelSignal,
});
```

Reglas clave:
- **No usar `@remotion/bundler` dentro de una API route de Next.js** (incluye webpack; la doc `miscellaneous/nextjs.mdx` lo dice explicitamente). Ejecutar bundle+render en el **backend Node (Fastify) / worker de la cola**, nunca en Next. Si hace falta en Next: `serverExternalPackages: ['@remotion/renderer']`.
- Hay un servidor de referencia con cola, progreso y cancelacion: https://github.com/remotion-dev/template-render-server (Express; `server/render-queue.ts` usa `makeCancelSignal`, `selectComposition`, `renderMedia`).
- Con `inputProps` hay que pasarlas **igual** a `selectComposition` y a `renderMedia`. (En 5.0 seran obligatorias.)
- El navegador no lee rutas absolutas del disco (`miscellaneous/absolute-paths.mdx`). Medios del usuario: copiarlos/enlazarlos en `publicDir` y usar `staticFile()`, o servirlos por HTTP desde el backend (`http://localhost:PORT/media/...`) y pasar la URL en `inputProps`. Recomendado: HTTP, porque evita re-bundlear.
- Alpha (video transparente) [V, `transparent-videos.mdx`]:
  - WebM: `imageFormat: 'png'`, `pixelFormat: 'yuva420p'`, `codec: 'vp8'` (o `'vp9'`). Sin fondo en la composicion.
  - ProRes 4444 (para editores externos): `codec: 'prores'`, `proResProfile: '4444'`, `pixelFormat: 'yuva444p10le'`, `imageFormat: 'png'`.
  - En `renderMedia` las opciones se llaman `imageFormat` y `pixelFormat` (equivalen a `--image-format`, `--pixel-format` del CLI). `template-overlay/remotion.config.ts` es el ejemplo oficial de ProRes alpha.
- El archivo `remotion.config.ts` **no** aplica a las APIs Node; hay que pasar cada opcion explicitamente.

### Requisitos en Windows [V salvo indicacion]

- Plataformas soportadas: Windows x64 (tambien macOS x64/arm64, Linux x64). `chrome-headless-shell.mdx`.
- **Chrome Headless Shell**: Remotion lo descarga automaticamente a `node_modules/.remotion/chrome-headless-shell/win64/chrome-headless-shell-win64/` (ejecutable `chrome-headless-shell.exe`). Asegurar la descarga en el setup: `npx remotion browser ensure` o `ensureBrowser()`. Modo por defecto (`chromeMode: 'headless-shell'`) es el mas rapido en CPU; `chrome-for-testing` solo sirve para GPU en Linux.
- **FFmpeg**: viene empaquetado (paquete `@remotion/compositor-win32-x64-msvc`); no hace falta instalar nada para Remotion. **Pero** ese FFmpeg es una build minima: se inspecciono el binario Linux 4.0.532 (`ffmpeg -filters`, mismo recorte de filtros en todas las plataformas) y **no incluye `drawtext`, `xfade`, `overlay`, `zoompan`, `fade`, `subtitles`**; solo `scale`, `concat`, `volume`, `amix`, `loudnorm`, `palettegen`, etc. Encoders presentes: libx264, libx265, libvpx (vp8/vp9), prores_ks, aac, libfdk_aac, `h264_nvenc`/`hevc_nvenc`. Conclusion: **el adaptador FFmpeg+Lottie y la edicion normal necesitan un FFmpeg de sistema** (winget).
- Limite de linea de comandos de Windows (8192 caracteres): con muchas capas de audio Remotion falla con `ENAMETOOLONG` (`enametoolong.mdx`). Mitigar: silenciar videos sin audio (`<OffthreadVideo muted>`), componer el audio aparte con FFmpeg y renderizar Remotion con `muted: true`.
- Directorio temporal: variable `TEMP`/`TMP` en Windows (`changing-temp-dir.mdx`). Poner temporales en un disco con espacio.
- Aceleracion por hardware: solo NVENC si hay GPU NVIDIA con drivers >= 525; `hardwareAcceleration: 'if-possible'`. Por defecto `'disabled'`; sin GPU funciona igual en CPU (`hardware-acceleration.mdx`).
- `@remotion/install-whisper-cpp` en Windows descarga un binario y solo hay binarios hasta whisper.cpp `1.6.0`; versiones mas nuevas necesitan `cmake`. Por eso el plan usa faster-whisper (Python) y alimenta `Caption[]` JSON a Remotion.
- Concurrencia en CPU sin GPU: dejar `concurrency` en 50% por defecto o bajarlo si la PC se satura. [NV: rendimiento real en la PC del usuario]
- No se probo la instalacion en Windows desde este sandbox (Linux). [NV]

---

## 2. Plantillas/ejemplos Remotion para adaptar

Todas estan bajo la **Remotion License** (no MIT): sirven para uso personal; no se pueden redistribuir como plantilla propia. Cada repo independiente es espejo de `packages/template-*` del monorepo https://github.com/remotion-dev/remotion. Los paquetes MIT usados (`captions`, `media-utils`, `layout-utils`) si se pueden reutilizar libremente.

| Necesidad | Repo / ruta | Licencia | Archivos a portar |
|---|---|---|---|
| Subtitulos estilo TikTok/CapCut (palabra activa resaltada) | https://github.com/remotion-dev/template-tiktok | Remotion (package.json `UNLICENSED`) | `src/CaptionedVideo/Page.tsx` (resalte por token con `fromMs/toMs`, `fitText`, stroke), `SubtitlePage.tsx` (entrada con `spring`, 5 frames), `index.tsx` (`createTikTokStyleCaptions`, `Sequence` por pagina, `calculateMetadata` con `getVideoMetadata`), `load-font.ts`. `sub.mjs` (Whisper) **no** se porta. Fuente `theboldfont.ttf` es gratuita ("100% free" segun su rtf), pero preferir una fuente de `@remotion/google-fonts` |
| Subtitulos karaoke tipo podcast + audiograma | https://github.com/remotion-dev/template-audiogram | Remotion | `src/Audiogram/Captions.tsx`, `Word.tsx`, `sentence-to-display.ts`, `get-number-of-lines-for-text.ts` (`fillTextBox`), `schema.ts` (zod + `zColor`), `Spectrum.tsx`, `Oscilloscope.tsx`, `AudioVizContainer.tsx`; `helpers/fetch-captions.ts` (`parseSrt`) |
| Visualizador de audio / forma de onda / espectro | https://github.com/remotion-dev/template-music-visualization | Remotion | `src/Visualizer/Spectrum.tsx` y `Waveform.tsx` (`visualizeAudio`, `useWindowedAudioData`), `BassOverlay.tsx`, `helpers/process-frequency-data.ts`, `helpers/schema.ts` |
| Overlays con alpha para insertar en el editor (base de lower-thirds) | https://github.com/remotion-dev/template-overlay | Remotion | `src/Overlay.tsx` (tarjeta que entra con `spring` y sale animada antes del final; fuente via `@remotion/google-fonts/Roboto`), `src/Root.tsx`, `remotion.config.ts` (ProRes 4444 + `muted`). No hay plantilla oficial "lower-third": **hay que escribirla** adaptando `Overlay.tsx` (barra + nombre + subtitulo, entrada `spring`, salida con `interpolate`) |
| Title cards / animacion de titulos | https://github.com/remotion-dev/template-render-server (`remotion/HelloWorld/Title.tsx`, `Subtitle.tsx`, `Logo.tsx`, `Atom.tsx`, verificado); template-helloworld es equivalente [NV] | Remotion | `Title.tsx`, `Subtitle.tsx`, `constants.ts` |
| Transiciones entre clips | paquete `@remotion/transitions` (no hace falta plantilla) | Remotion | Uso: `<TransitionSeries>` + `<TransitionSeries.Transition presentation={fade()} timing={linearTiming({durationInFrames: 30})}/>`. Presentaciones documentadas: `fade`, `slide`, `wipe`, `flip`, `clockWipe`, `iris`, `cube`, `blurSlide`, `crossZoom`, `crosswarp`, `dissolve`, `dreamyZoom`, `filmBurn`, `pushCut`, `ripple`, `swap`, `zoomBlur`, `zoomInOut`, `linearBlur`, `bookFlip`. Imports: `@remotion/transitions/fade`, etc. |
| Lottie | paquete `@remotion/lottie` + `lottie-web` | Remotion + MIT | `<Lottie animationData={json}/>`. Cargar desde `staticFile()` con `delayRender`/`continueRender` y `useState` (patron en `docs/lottie/lottie-staticfile.mdx`). Limitacion oficial: usa `goToAndStop()` de lottie-web; las **expresiones** de After Effects pueden parpadear; solo renderer `svg` |
| Ejemplo de render parametrizado por prompt (referencia de arquitectura) | https://github.com/remotion-dev/template-prompt-to-motion-graphics-saas | sin LICENSE verificada | Solo lectura; usa `@remotion/lottie`, `shapes`, `paths`, `transitions`, `animated-emoji` |
| Servidor de render con cola | https://github.com/remotion-dev/template-render-server | Remotion | `server/render-queue.ts` (patron cola + cancelacion + progreso), `server/index.ts` (bundle al arrancar o `REMOTION_SERVE_URL`) |

Subtitulos (formato de datos): `Caption = {text, startMs, endMs, timestampMs, confidence}`. El `text` **lleva el espacio inicial** (` palabra`); sin eso `createTikTokStyleCaptions` junta todo. Usar `white-space: pre` al renderizar. `combineTokensWithinMilliseconds` (p. ej. 1200) controla cuantas palabras por pagina; valores bajos dan efecto palabra a palabra. Desde 4.0.514 existe `breakOnSilenceAfterMilliseconds`. El worker faster-whisper debe emitir ese JSON.

Otros paquetes MIT utiles: `@remotion/shapes`, `@remotion/paths` (animar trazos SVG), `@remotion/noise`, `@remotion/motion-blur`, `@remotion/animated-emoji`.

---

## 3. Motion Canvas

- Repo: https://github.com/motion-canvas/motion-canvas (ultimo commit leido 2026-07-02). Docs: https://motioncanvas.io
- Version: **3.17.2** (`@motion-canvas/core`, `/2d`, `/vite-plugin`, `/ffmpeg`, `/create`). Licencia **MIT** en npm. **Nota**: el `package.json` fuente de `packages/ffmpeg` dice `GPLv3`, pero el tarball publicado 3.17.2 declara `MIT` [V: descargado y leido]. Hay inconsistencia entre repo y paquete; para uso personal local no afecta, pero revisar antes de redistribuir.
- Instalar proyecto: `npm init @motion-canvas@latest` (pide nombre, TS/JS, exportadores). Node >= 16.
- Agregar exportador FFmpeg a un proyecto existente: `npm install --save @motion-canvas/ffmpeg` y en `vite.config.ts`: `plugins: [motionCanvas(), ffmpeg()]`.
- **Render**: segun la doc oficial se hace desde el **editor en el navegador** (pestana Video Settings, boton Render). El exportador FFmpeg corre un servidor Node (fluent-ffmpeg + `ffmpeg-ffprobe-static`, no hay que instalar FFmpeg) y recibe frames RGBA por el plugin de Vite. **No existe API oficial de render headless/programatico** (busque en docs y repo: sin menciones de headless, puppeteer ni API programatica).
- Limitaciones verificadas leyendo `FFmpegExporterServer.ts`: la salida es siempre `.mp4` con `-pix_fmt yuv420p` (**sin alpha**) y se puede mezclar audio. Para **alpha**: usar el exportador "Image sequence" (PNG/JPEG/WebP; el fondo vacio del proyecto da transparencia) y luego convertir con FFmpeg de sistema a WebM VP9 o ProRes 4444 (comandos en la seccion 4).
- Los exportadores son aun "relativamente nuevos" segun su propia doc.
- **Alternativa headless: Revideo** (fork de Motion Canvas). Repo https://github.com/redotvideo/revideo (README lo llama ahora "midrender/revideo"), licencia MIT, **0.11.0** (npm modificado 2026-07-10). API: `renderVideo({projectFile, variables, settings: {outFile, workers, ffmpeg: {ffmpegPath}, puppeteer: {args}, progressCallback}})` desde `@revideo/renderer`. Renderiza en navegador headless (canvas + WebCodecs) y usa FFmpeg solo para audio. Limite: `outFile` debe terminar en `.mp4` (sin alpha). Recomendacion: si algun dia se quiere un motor "Motion Canvas" para ejecutar desde la cola, adaptar **Revideo**, no Motion Canvas puro.
- Estrategia para el adaptador: modo A (Motion Canvas puro) = abrir el editor y exportar a mano, o automatizar el boton con Puppeteer [NV, no probado]; modo B (Revideo) = `renderVideo` desde Node.

---

## 4. Lottie + FFmpeg

### Renderizar Lottie a video transparente

Opciones (ordenadas por recomendacion):
1. **Remotion + `@remotion/lottie`** con salida alpha (WebM VP8/VP9 `yuva420p` o ProRes 4444, ver seccion 1). Es la ruta mas simple y ya esta en el stack. Sin expresiones AE.
2. **puppeteer-lottie** https://github.com/transitive-bullshit/puppeteer-lottie (MIT, v1.1.2, **sin mantenimiento desde 2022**, depende de puppeteer 2.x). Salida `frame-%d.png` (PNG con transparencia) o `.mp4`/`.gif`. El MP4 **no tiene alpha**. Uso: `renderLottie({path:'anim.json', output:'frame-%d.png', width:1080})`, luego FFmpeg a WebM/ProRes. Riesgo: puppeteer viejo puede no funcionar en Node 22; se puede pasar `opts.browser` o `puppeteerOptions.executablePath` [NV]. Mejor escribir un script propio de 40 lineas con `puppeteer` actual + `lottie-web` (renderer `canvas`, `goToAndStop(frame, true)`, `page.screenshot({omitBackground: true})`).
3. **ThorVG** https://github.com/thorvg/thorvg (MIT, C++, soporta Lottie). Util si se quiere un binario nativo sin navegador. No se verifico un CLI listo (`tools/lottie2gif` devolvio 404) [NV]. Descartado para la primera version.

### Recetas FFmpeg (ejecutadas con FFmpeg 6.1.1 en el sandbox; todas terminaron OK) [V]

Requieren FFmpeg de sistema (el de Remotion no trae los filtros). En Windows, `drawtext` necesita `fontfile` con barra normal y dos puntos escapados: `fontfile='C\:/Windows/Fonts/arialbd.ttf'` [NV en Windows, regla estandar de FFmpeg].

```bash
# Texto animado: aparece con fade y sube 40 px durante 0.5 s, visible de 0.5 s a 3.5 s
ffmpeg -i in.mp4 -vf "drawtext=fontfile='/path/Font-Bold.ttf':text='Hola mundo':fontsize=72:fontcolor=white:borderw=3:bordercolor=black:x=(w-text_w)/2:y=h-200+40*(1-min(t/0.5\,1)):alpha='min(t/0.5\,1)':enable='between(t,0.5,3.5)'" -c:a copy out.mp4

# Fade de video y audio al inicio y al final (clip de 4 s)
ffmpeg -i in.mp4 -vf "fade=t=in:st=0:d=0.5,fade=t=out:st=3.5:d=0.5" -af "afade=t=in:d=0.5,afade=t=out:st=3.5:d=0.5" out.mp4

# Transicion xfade entre dos clips de 4 s (offset = duracion_clip1 - duracion_transicion)
ffmpeg -i a.mp4 -i b.mp4 -filter_complex "[0:v][1:v]xfade=transition=fade:duration=1:offset=3,format=yuv420p[v]" -map "[v]" out.mp4
# con audio: [0:a][1:a]acrossfade=d=1[a]  y  -map "[a]"
# otras transiciones: slideleft, wipeleft, circleopen, dissolve, pixelize, fadeblack, radial, smoothleft, hblur, zoomin ...

# Ken Burns (zoompan) sobre imagen fija: zoom 1.0 a 1.5 en 5 s, 30 fps
ffmpeg -loop 1 -i still.png -vf "scale=3840:-2,zoompan=z='min(zoom+0.0015,1.5)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=150:s=1280x720:fps=30,format=yuv420p" -t 5 out.mp4

# Secuencia PNG con alpha (salida de Lottie/Motion Canvas) a WebM VP9 con alpha
ffmpeg -framerate 30 -i frame-%d.png -c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 -b:v 0 -crf 30 overlay.webm
# o a ProRes 4444 (.mov)
ffmpeg -framerate 30 -i frame-%d.png -c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le overlay.mov

# Superponer el overlay con alpha sobre el video entre 0.5 s y 3 s
# IMPORTANTE: forzar el decoder libvpx ANTES de -i; el decoder nativo vp9 descarta el alpha del WebM
ffmpeg -i base.mp4 -c:v libvpx-vp9 -i overlay.webm -filter_complex "[0:v][1:v]overlay=x=100:y=H-h-80:enable='between(t,0.5,3)':format=auto[v]" -map "[v]" -map 0:a -c:a copy out.mp4
```

Comprobado: tras el `overlay`, los pixeles de zonas transparentes del overlay coinciden con el video base y los de zonas opacas toman el color del overlay. `ffprobe` muestra `pix_fmt=yuv420p` + tag `alpha_mode=1` para el WebM con alpha; es normal (libvpx guarda el alpha aparte).
Con ProRes `.mov` como entrada de `overlay` no hace falta decoder especial.
`drawtext` tambien admite expresiones de texto, p. ej. `text='%{eif\:t*100\:d}'` (probado).
Para karaoke con FFmpeg puro conviene generar un `.ass` con efecto `\k` y usar el filtro `subtitles`/`ass` (disponible en el FFmpeg de sistema); no se probo [NV]. En el stack, subtitulos animados = Remotion; FFmpeg queda para fades, xfade, Ken Burns y composicion final.

---

## 5. Interfaz `MotionEngine` propuesta

Ubicacion segun PLAN-BASE: `packages/motion-engines` (interfaz + registro + adaptadores), `packages/remotion` (composiciones). El backend (Fastify) solo conoce `MotionEngine`; la cola de trabajos llama `registry.render(spec)`.

```ts
// packages/motion-engines/src/types.ts
export type EngineId = 'remotion' | 'motion-canvas' | 'ffmpeg-lottie';

export type TemplateId =
  | 'title-card' | 'lower-third' | 'animated-captions' | 'transition'
  | 'audio-visualizer' | 'lottie-overlay' | 'ken-burns' | (string & {}); // plantillas custom

export type OutputFormat =
  | 'mp4-h264'          // sin alpha
  | 'webm-vp9-alpha'    // yuva420p, para overlays en el editor
  | 'webm-vp8-alpha'
  | 'prores-4444'       // .mov con alpha, para editores externos
  | 'png-sequence';     // carpeta de PNG con alpha

export interface MediaRef {
  kind: 'video' | 'audio' | 'image' | 'lottie' | 'captions';
  /** Ruta absoluta local dentro de la carpeta de datos del proyecto; el adaptador decide como exponerla (HTTP, publicDir, etc.). */
  path: string;
}

/** Entrada JSON versionada y serializable (se guarda en la cola SQLite). */
export interface MotionSpec {
  schemaVersion: 1;
  template: TemplateId;
  /** Motor preferido; si falta, el registro elige el primero compatible. */
  engine?: EngineId;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  /** Props especificas de la plantilla (validadas con el zod schema de la plantilla). */
  props: Record<string, unknown>;
  /** Medios referenciados por clave desde `props` (p. ej. { captions: {...}, music: {...} }). */
  media?: Record<string, MediaRef>;
  output: {
    format: OutputFormat;
    /** Ruta absoluta de salida (archivo o carpeta para png-sequence). */
    path: string;
    /** Sin audio por defecto para overlays; el audio se mezcla despues con FFmpeg. */
    includeAudio?: boolean;
  };
  seed?: number; // determinismo
}

export interface EngineCapabilities {
  formats: OutputFormat[];
  templates: TemplateId[];
  /** true si el motor puede correr sin GPU. */
  cpuOnly: boolean;
  /** true si requiere FFmpeg de sistema (no el empaquetado). */
  needsSystemFfmpeg: boolean;
}

export interface RenderProgress {
  phase: 'preparing' | 'bundling' | 'rendering' | 'encoding' | 'done';
  /** 0..1 */
  ratio: number;
  message?: string;
}

export interface RenderContext {
  jobId: string;
  signal?: AbortSignal;                      // cancelacion desde la cola
  onProgress?: (p: RenderProgress) => void;
  tmpDir: string;                            // directorio temporal del job
  ffmpegPath: string;                        // FFmpeg de sistema resuelto por el backend
  mediaBaseUrl: string;                      // p. ej. http://127.0.0.1:4000/media para exponer MediaRef a navegadores headless
  logger: { info(m: string): void; warn(m: string): void; error(m: string): void };
}

export interface RenderResult {
  outputPath: string;
  format: OutputFormat;
  hasAlpha: boolean;
  durationMs: number;
  width: number;
  height: number;
  engine: EngineId;
  renderTimeMs: number;
}

export interface TemplateInfo {
  id: TemplateId;
  title: string;
  /** JSON Schema generado desde el zod schema, para que el dashboard dibuje el formulario. */
  propsSchema: unknown;
  defaultProps: Record<string, unknown>;
  supportsAlpha: boolean;
}

export interface MotionEngine {
  readonly id: EngineId;
  capabilities(): EngineCapabilities;
  /** Comprueba prerequisitos (navegador descargado, FFmpeg, etc.). No lanza: devuelve el motivo. */
  checkAvailable(): Promise<{ ok: boolean; reason?: string }>;
  listTemplates(): Promise<TemplateInfo[]>;
  /** Valida props/formatos contra la plantilla antes de encolar. */
  validate(spec: MotionSpec): { ok: true } | { ok: false; errors: string[] };
  render(spec: MotionSpec, ctx: RenderContext): Promise<RenderResult>;
  /** Libera recursos (bundle cacheado, navegador). */
  dispose?(): Promise<void>;
}

export interface MotionEngineRegistry {
  register(engine: MotionEngine): void;
  get(id: EngineId): MotionEngine | undefined;
  /** Elige motor: spec.engine si existe y es valido; si no, el primero cuyo capabilities cubra template + formato. */
  resolve(spec: MotionSpec): MotionEngine;
  render(spec: MotionSpec, ctx: RenderContext): Promise<RenderResult>;
}
```

Reglas de implementacion de adaptadores:
- **RemotionEngine** (primero): `bundle()` una vez al arrancar el worker y se cachea en `data/cache/remotion-bundle`; se re-bundlea solo si cambian los archivos de `packages/remotion` (hash). `render` = `selectComposition` + `renderMedia` con `codec`/`pixelFormat`/`imageFormat`/`proResProfile` derivados de `output.format` (tabla de la seccion 1). `AbortSignal` se conecta a `makeCancelSignal()`. `template` = id de `<Composition>`. `props` van como `inputProps`; los `MediaRef` se traducen a URLs `ctx.mediaBaseUrl/...`. `durationMs`/`fps`/tamano se fijan via `calculateMetadata` o `selectComposition`.
- **MotionCanvasEngine** (despues): implementarlo sobre Revideo `renderVideo` (mp4 sin alpha) o sobre exportacion de secuencia PNG + FFmpeg para alpha. `checkAvailable` devuelve `ok:false` mientras no exista.
- **FfmpegLottieEngine** (despues): plantillas `lottie-overlay`, `ken-burns`, `transition`; pipeline = frames PNG (script propio puppeteer+lottie-web) -> FFmpeg -> webm/mov alpha. `needsSystemFfmpeg: true`.
- La **cola** guarda `MotionSpec` como JSON; los resultados pasan al editor como assets (el overlay con alpha se superpone con el filtro `overlay` de FFmpeg, receta de la seccion 4).
- Un unico motor define las plantillas con **zod**; el schema se exporta a JSON Schema (`z.toJSONSchema` en zod 4) para generar formularios en el dashboard. Los templates oficiales ya usan zod + `@remotion/zod-types` (`zColor`).

---

## Decisions/recommendations

1. Remotion 4.0.532 como motor principal, todas las dependencias `@remotion/*` ancladas a esa version exacta; no subir a 5.x hasta que se publique.
2. Licencia: uso personal local entra en la Licencia Gratuita de Remotion (individuos); registrar en `docs/trabajo/fuentes.md`. Los templates oficiales son Remotion License (no MIT): adaptarlos a codigo propio, no redistribuirlos.
3. Render solo en el backend Node/worker (bundle una vez, `renderMedia` por job); nunca `@remotion/bundler` dentro de Next.js.
4. Setup Windows: ejecutar `npx remotion browser ensure` (Chrome Headless Shell) y `winget install -e --id Gyan.FFmpeg` (FFmpeg de sistema). El FFmpeg empaquetado en Remotion NO trae drawtext/xfade/overlay/zoompan/fade.
5. Medios del usuario: servirlos por HTTP local (`mediaBaseUrl`) o `publicDir`; el navegador headless no lee rutas absolutas.
6. Overlays con alpha: WebM VP9 `yuva420p` (para el editor) o ProRes 4444 (para exportar a otros editores); en FFmpeg poner `-c:v libvpx-vp9` antes de `-i` para leer el alpha.
7. Subtitulos animados: faster-whisper emite `Caption[]` (texto con espacio inicial) y Remotion los dibuja con `createTikTokStyleCaptions` portando `Page.tsx`/`SubtitlePage.tsx` de template-tiktok.
8. Lower-thirds: no hay plantilla oficial; escribir `lower-third` adaptando `template-overlay/src/Overlay.tsx`. Audio visualizer: portar `template-music-visualization`. Transiciones: `@remotion/transitions`.
9. Motion Canvas puro no tiene render headless oficial ni alpha en su exportador FFmpeg; para el adaptador usar Revideo (MIT, `renderVideo`, solo mp4) o secuencia PNG + FFmpeg.
10. Lottie: ruta primaria `@remotion/lottie`; `puppeteer-lottie` esta abandonado (2022), preferir script propio puppeteer + lottie-web si se necesita fuera de Remotion.
11. Sin GPU: dejar `hardwareAcceleration` en `disabled` por defecto y `concurrency` 50%; NVENC solo por flag si hay NVIDIA.
12. Interfaz `MotionEngine` + `MotionEngineRegistry` (seccion 5) en `packages/motion-engines`; `MotionSpec` JSON versionado y plantillas validadas con zod.
13. Pendiente de validar en la PC Windows real: instalacion de Chrome Headless Shell, escape de `fontfile` en `drawtext`, rendimiento en CPU. [NV]

## Fuentes consultadas (todas publicas)

- https://github.com/remotion-dev/remotion (LICENSE.md, `packages/docs/docs/*`, `packages/template-tiktok`, `packages/template-audiogram`)
- https://github.com/remotion-dev/template-overlay, template-render-server, template-music-visualization, template-helloworld, template-prompt-to-motion-graphics-saas
- https://www.npmjs.com/package/remotion y `@remotion/*` (consulta `npm view`)
- https://github.com/motion-canvas/motion-canvas, https://github.com/redotvideo/revideo
- https://github.com/transitive-bullshit/puppeteer-lottie, https://github.com/thorvg/thorvg
- https://winstall.app/apps/Gyan.FFmpeg (id de winget)
- Recetas FFmpeg: ejecutadas localmente con FFmpeg 6.1.1 (Ubuntu); salidas de prueba no se incluyen en el repo.

# Sprint 6 — M2 Sistema de diseño y kit de marca (agente «diseño»)

Contrato: `docs/trabajo/sprint6-contratos.md` §M2 (+ C2, C3, C4, deuda #12, #15, #18).
Rama `claude/funny-mccarthy-0bbdt6`. Fecha: 2026-10-18.

## Qué se hizo (por prioridad del contrato)

1. **Fuentes OFL empaquetadas, ningún render usa la red (C4).**
   `packages/remotion/public/fonts/<Familia>/` con las 10 familias (TTF estáticos 400/700/900,
   subconjunto latino + latino extendido, **1,8 MB** en total) + `OFL.txt` de cada una (licencia SIL
   OFL 1.1 verificada en el archivo) + `manifest.json`. `packages/remotion/scripts/fetch-fonts.py`
   las regenera desde `github.com/google/fonts` (fontTools instancia las variables; solo lo corre un
   mantenedor, nunca la instalación). Los tres lados usan los mismos archivos:
   - Remotion: `fonts.ts` registra `FontFace` con `staticFile()` (se fue `@remotion/google-fonts`
     del código); `font-files.ts` (mapa de pesos) y `fonts-node.ts` (rutas para la api).
   - Vista previa web: `GET /fonts/*` (caché inmutable) + `@font-face` inyectado por
     `lib/api-design.ts` (`ensureBundledFontFaces`).
   - libass: `subtitles=subs.ass:fontsdir=<carpeta>` (bloque `sprint6:M2` de `timeline.ts`). Como
     `fontsdir` **no es recursivo**, la api espeja los TTF planos en `<storage>/tmp/fonts-ass/` al
     arrancar (ruta absoluta escapada con `escape.ts`: `C\:/…`, espacios y tildes).
2. **Tokens + kit único.** `GET/PUT /api/brand-kit` (fila `settings.brand_kit`, PUT parcial,
   `FONT_NOT_BUNDLED`), `POST /api/brand-kit/logo` (PNG/JPG/SVG ≤ 5 MB, `BRAND_LOGO_INVALID`; el logo
   queda como medio «Logo del kit»), `GET /api/design/tokens`, `POST /api/design/check`,
   `POST /api/motion/still` (Remotion `renderStill`, caché `renders/stills/<hash>.png` por
   pedido + kit + hash del código de las plantillas, LRU 200 MB, pedidos iguales simultáneos
   comparten el render, `STILL_UNAVAILABLE` 503 con `details.reason`). Ajustes → **Kit de marca**:
   vista previa en vivo 9:16/16:9 (título + rótulo + subtítulos sobre un fotograma del último video,
   tres stills apilados; respaldo CSS «aproximado» con las mismas fuentes si Remotion falta), nombre y
   logo, 4 colores con contraste en vivo (marca el color y dice «Poco contraste»), 4 roles
   tipográficos (solo familias empaquetadas), zona segura 9:16 con **«Calibrar con una captura»**
   (captura del teléfono detrás del marco 9:16 + 4 deslizadores; guarda `calibration`), perfil
   **«Shorts (derecha 18 %)»** y tamaño de subtítulos en «Avanzado»; guardado automático (400 ms).
3. **Reglas duras de subtítulos por defecto** (`packages/shared/src/design-rules.ts`):
   `contrastRatio`, `resolveDesign`, `paginateCaptions` (≤ 2 líneas, 30/34/42 caracteres o menos si
   a ese tamaño no entra en la zona segura, corte en pausa ≥ 300 ms / fin de oración / coma con media
   página, balanceo sin dejar «el | auto» ni preposición colgando, estirado a 0,83–7 s y ≤ 17 cps salvo
   karaoke), `captionStyleFromTokens` (con el kit: tipografía del kit, tamaño ≥ 4,5 %, contorno 8 %),
   `autofixCaptionStyle`, `captionLayout` (márgenes = zona segura + contorno/caja), `checkDesign` (las
   10 reglas), `templateDesign`, `toDtcg`. El ASS (`ass.ts`) usa todo eso: `Fontname`/peso del kit,
   `Fontsize` 6 % del lado corto, `Outline` 8 %, páginas como líneas explícitas (`WrapStyle: 2`),
   `ScaledBorderAndShadow`, márgenes de zona segura. `animated-captions` recibe las mismas páginas
   calculadas en Node (`__pages`). Subtítulos: «Usar tipografía y colores del kit de marca» activado
   por defecto (`fromBrandKit`) y «Revisar diseño» (checklist compacto).
4. **Motion en español y en Propiedades** (H12, H13, B6, B11). Opciones con etiqueta en español
   (`x-enum-labels`: Barra/Caja/Subrayado/Dividido, Abajo a la izquierda…, Deslizar/Fundido/
   Barrido/Rebote), «Avanzado» plegado (`x-advanced`: márgenes, duraciones, formato, motor, datos
   JSON), props de tokens marcadas «Del kit» (`x-token`, con botón para volver al kit). El
   formulario está **dentro de Propiedades** (doble clic en un clip de la línea de tiempo lo abre),
   con vista previa `renderStill` (debounce 400 ms) y «Renderizar ahora»; editar no renderiza.
   Plantillas leen el kit (`__design`): tipografías por rol, colores, zona segura (título, rótulo,
   pantalla final, tipografía cinética, subtítulos animados) y duraciones de entrada/salida; las props
   explícitas mandan; sin kit = mismo resultado que antes (test). `title-card` transparente (B6, ya
   estaba). Motores: mensajes en español (B11), motor caído = motivo + «Arreglar».
5. **StylePreset ↔ kit**: `use_brand_kit` ausente = sí → las ops `add_motion` del plan del perfil
   pierden fuentes y colores para que mande el kit (`routes/style.ts` `withBrandKit`).
6. **Coherencia de la UI** (barato): `GLOSSARY_ES` en Ajustes, voseo en Propiedades/Voz/Subtítulos/
   Atajos/Comandos, voces «España/México» (H19), «Lo usa» sin ids, variables CSS de densidad
   (28/32 px), espaciado, íconos 16/14 px, foco visible y deshabilitado uniformes en
   `globals.css`, `FileButton` (sin «Choose File»), 12 claves de tooltip nuevas (6 de M2 + las 6 que
   pidió M3).
7. **Selector de voz único** (H20): «¿Qué voz?» = Mis voces · Voces de Studio · Convertir mi
   grabación; el motor solo aparece en «Voces de Studio» («Rápida (local)», «Natural (local…)», y las
   de la nube solo con clave; sin clave se listan en «Avanzado»); RVC técnico en «Avanzado».
8. **Medición**: `scripts/e2e/design-check.mjs` (C2), bloque `sprint6:M2` de `ui-smoke.mjs` con
   `--ux-metrics` (C3), bloque `sprint6:M2` de `run-e2e.mjs`, `docs/trabajo/protocolo-mapa-calor.md`.

## Cómo probarlo

```bash
pnpm --filter @studio/shared test          # design-rules (34) + design-contracts (5)
REMOTION_BROWSER_EXECUTABLE=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell \
  pnpm --filter @studio/remotion test      # fonts-offline, tokens-props, labels-es, fonts-render
pnpm --filter @studio/api test             # ass-tokens (libass real), brand-kit, design-check, motion-still, style-brand-kit
pnpm --filter @studio/motion-engines test  # messages-es (B11)
pnpm --filter @studio/web test             # brand-kit-tab, inspector-motion, voice-picker, ui-language, tooltips
# api corriendo (con REMOTION_BROWSER_EXECUTABLE para stills reales):
node scripts/e2e/design-check.mjs --api http://127.0.0.1:3001
node scripts/e2e/run-e2e.mjs --api http://127.0.0.1:3001 --only "sprint6: (fuentes|still|design-check)"
node scripts/e2e/ui-smoke.mjs --web http://127.0.0.1:3000 --api http://127.0.0.1:3001 --only "Sprint 6" --ux-metrics
```

Tests nuevos: **116** (shared 39 · remotion 35 · api 26 · motion-engines 2 · web 14) + tooltips
actualizado. Suites completas en verde al cerrar: shared 250, remotion 91, api 389 (+2 omitidos),
motion-engines 24, web 328.

## Resultado del checklist de 10 reglas (exports de prueba, sandbox)

`design-check.mjs` contra la api local (ffmpeg 6.1 + libass, Remotion con el headless shell de
Playwright). Proyecto por defecto: clip hablado 15 s + subtítulos de 4 oraciones + `title-card` +
`lower-third` con los valores por defecto de las plantillas y del kit.

| Regla | 9:16 (Reels, estilo «reels») | 16:9 (YouTube, estilo «clásico») |
| --- | :-: | :-: |
| caption.max_lines | ✓ | ✓ |
| caption.chars_per_line | ✓ | ✓ |
| caption.min_size | ✓ | ✓ |
| caption.outline_or_box | ✓ | ✓ |
| caption.contrast | ✓ | ✓ |
| caption.safe_zone | ✓ | ✓ |
| caption.timing | ✓ | ✓ |
| title.safe_zone | ✓ | ✓ |
| title.duration (guía) | ✓ | ✓ |
| brand.consistency (guía) | ✓ | ✓ |
| **Total** | **10/10** | **10/10** |
| Píxeles: caja del texto en zona segura (5 fotogramas) | 5/5 (y ≈ 721–854 de 1920; zona 288–1248) | 5/5 (y ≈ 844–972 de 1080; límite 972) |
| Líneas por alto | 1 por página | ≤ 2 |

Los 5 presets de `CAPTION_STYLE_PRESETS` pasan las 10 reglas en 9:16 y 16:9 sin tocar nada (test).
Un estilo de 30 px sin contorno (fuera del kit) falla exactamente 2 reglas y `fix:true` las arregla.
Métricas `--ux-metrics` (C3): 0 términos en inglés en Propiedades/Voz/Motion, 0 botones de ícono sin
tooltip explicativo, 2 familias tipográficas en la UI, **6 clics** del primer proyecto a exportar.
Still 1080×1920: ≈ 1,0 s sin caché (bundle caliente) y ≈ 6 ms con caché (sandbox).

## Desvíos del contrato

- Familias de un solo peso (Bebas Neue, Anton, Archivo Black, Bangers) traen **un** TTF que el mapa
  usa para 400/700/900 (el navegador no inventa negritas); Oswald llega a 700 (900 = 700). El test
  «3 pesos por familia» valida el mapa `manifest.json` ↔ `font-files.ts` y que los archivos existan.
- `fontsdir` apunta al espejo plano `<storage>/tmp/fonts-ass/` (libass no recorre subcarpetas).
- Márgenes del ASS = zona segura **+ contorno o caja**, para que el trazo también quede adentro.
- `STUDIO_FONTS_OFFLINE=1` (bloquear Google Fonts en el navegador) no hizo falta: ya no hay ninguna
  URL externa; lo prueban el test que prohíbe `googleapis`/URLs en `packages/remotion/src` y el render
  real (`fonts-render.test.ts`, run-e2e) que exige familias distintas y ningún aviso de fuente.
- `POST /api/motion/still` vive en `routes/design.ts` (el stub del Paso 0 estaba ahí).
- `fix:true` devuelve el proyecto arreglado **sin guardarlo**: la web lo adopta como un paso de
  deshacer y lo guarda.
- La vista previa del kit apila 3 stills transparentes (título, rótulo, subtítulos) en vez de un
  único render compuesto.
- `brand.consistency` ignora grises neutros (los grises de las plantillas combinan con cualquier
  paleta).
- El render real «al exportar» necesita el pedido cruzado 1: hoy editar un gráfico en Propiedades lo
  deja sin render y el usuario toca «Renderizar ahora» (la exportación lo avisa).
- Quedó para S7 (prioridades 5–6 parciales): «Guardar colores y tipografías como kit» en el panel
  Estilo, dibujar el logo del kit en la exportación, prueba de captura comparada por plantilla
  (tolerancia 8), `toDtcg` sin botón de exportar en la UI.

## Pedidos cruzados

1. **Integración (export, `jobs/handlers/project-export.ts`)**: antes de exportar, renderizar los
   clips motion sin `renderedAssetId` (hoy es un bloqueo «Motion sin renderizar») y agregar el aviso
   `DESIGN_AUTOFIXED` a `ExportJobResult.warnings` con `checkDesign` (la corrección de reglas duras ya
   ocurre al generar el ASS).
2. **Integración (`components/timeline/ClipView.tsx`)**: la etiqueta del clip muestra el id crudo
   («Motion · lower-third»); usar `templateNameEs()` de `components/design/MotionForm.tsx`.
3. **Workers (`tts/piper_catalog.py`)**: nombres «Espana/Mexico» sin tilde (la web ya los corrige al
   mostrarlos con `voiceDisplayName`).
4. **Integración (`texts-es.ts`)**: mover `KIT_TEXTS_ES` y etiquetas de `components/design/texts.ts`
   si se quiere un solo archivo de textos; `SUGGESTION_UI_ES` de M3 (su pedido 1) no lo toqué.
5. **Integración (`apps/api/package.json`/`packages/remotion/package.json` + lockfile)**: quitar la
   dependencia `@remotion/google-fonts` (ya no se importa) y `REMOTION_FONTS`/`fontMode` de
   `config.ts` (ahora se ignoran).
6. **Integración (`.gitattributes`)**: `*.ttf binary` (git ya los detecta como binarios).
7. **Integración (studio-mcp / CLAUDE.md)**: herramienta `studio_design_check {aspect, fix}` sobre
   `POST /api/design/check` y mención del Kit de marca.
8. Fuera de mis bloques, mínimo e imprescindible: `timeline.ts` (import de `assSubtitlesFilter`),
   `ui-smoke.mjs` paso de Sprint 4 (pestaña «Texto a voz» → «Voces de Studio» por H20),
   `sprint6-stubs.test.ts` (sin las filas de M2), `test/components.test.tsx` y
   `test/feedback.test.tsx` (textos nuevos).

### Borrador manual §Kit de marca (para la integración)

> **Ajustes → Kit de marca.** Elegí los colores y tipografías de tu canal una vez: subtítulos,
> títulos y rótulos los usan solos. La vista previa muestra cómo queda en vertical (Reels/TikTok) y
> horizontal (YouTube). La zona segura es una guía: tocá «Calibrar con una captura», subí una captura
> de Reels o TikTok de tu teléfono y mové las 4 guías hasta los botones de la app. En Subtítulos,
> «Revisar diseño» controla las 10 reglas y «Arreglar automáticamente» corrige lo que se puede (un
> solo Deshacer). Para editar un título o rótulo, hacé doble clic en el clip: el formulario aparece
> en Propiedades con la vista previa.

### Borrador NOTICE.md (fuentes)

> Tipografías incluidas (packages/remotion/public/fonts): Inter, Montserrat, Poppins, Roboto, Oswald,
> Playfair Display, Bebas Neue, Anton, Archivo Black y Bangers — SIL Open Font License 1.1 (texto en
> el `OFL.txt` de cada carpeta), obtenidas de github.com/google/fonts; instancias estáticas y
> subconjunto latino generados con fontTools (MIT) por `scripts/fetch-fonts.py`.

## Qué queda solo medible en la PC

- Calibrar la zona segura con capturas reales de Reels, TikTok y Shorts y guardarla en el kit.
- Legibilidad real de los subtítulos en el teléfono (3 fotogramas por app).
- Latencia de `renderStill` en el i5 (meta < 1,5 s con caché caliente; sandbox ≈ 1,0 s sin caché).
- Que libass en Windows tome las fuentes de `fontsdir` con rutas con espacios y tildes
  (`C:\Users\José Pérez\…`; el escape está probado en unidad).
- Mapa de calor completo (`protocolo-mapa-calor.md`) y escala 125 % en 1366 px.

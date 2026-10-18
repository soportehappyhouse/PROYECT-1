# Protocolo del mapa de calor UX (repetible) — Sprint 6, criterio C3

Objetivo: que cada auditoría de sprint mida la fluidez **con el mismo método** que
`auditoria-fluidez.md` (2026-10-08, promedio 2,52), para comparar números y no impresiones.
Meta Sprint 6: promedio **≥ 3,5 / 5** y los flujos 2, 5, 6 y 8 **≥ 3,5**. El panel «Diseño» toma el
promedio (a) de esta tabla y (b) el checklist C2 (`scripts/e2e/design-check.mjs`).

## 1. Preparación (idéntica en cada corrida)

1. Rama del sprint al día; `pnpm install --frozen-lockfile && pnpm -r build`.
2. Workers: `apps/workers/.venv/bin/python scripts/e2e/workers-with-mocks.py` (sin GPU; para provocar
   un «Paquete requerido» real, `STUDIO_MOCK_DENOISE=0`).
3. api: `node apps/api/dist/index.js` con `STORAGE_DIR` y `MODELS_DIR` **nuevos** (carpeta vacía),
   `REMOTION_BROWSER_EXECUTABLE` = el headless shell de Playwright
   (`/opt/pw-browsers/chromium_headless_shell-*/chrome-linux/headless_shell` en el sandbox) y el
   `claude` falso de la integración.
4. Web: `NEXT_PUBLIC_API_URL=<api> next start --port 3000` (build de producción: el overlay de
   desarrollo de Next agrega botones que no son de Studio).
5. Navegador: Playwright Chromium **1366×820**, escala 100 % (en la PC: 125 % en 1366 px, ver §7).
6. Medios fijos (generarlos con ffmpeg si no están): `clip.mp4` 12 s 1280×720 con 3,5 s de
   silencio al principio, `vertical.mp4` 10 s 1080×1920 hablado, `voz.wav` 8 s, `logo.png`.
7. Antes de puntuar, correr las métricas automáticas y pegar el JSON en el informe:
   `node scripts/e2e/ui-smoke.mjs --web <web> --api <api> --only "Sprint 6" --ux-metrics`
   (línea `UX_METRICS {…}`; ver §5).

## 2. Qué cuenta (reglas de conteo)

- **Clic** = cada clic de mouse o tecla de atajo que el usuario tiene que hacer o apretar a
  propósito (un atajo cuenta 1). **No** cuentan: escribir texto, elegir el archivo en el diálogo del
  sistema, desplazar (scroll), pasar el mouse para leer un tooltip.
- Se cuenta el **camino más corto que un usuario nuevo descubre solo** mirando la pantalla (no el que
  conoce el auditor). Si hay dos caminos (botón y Asistente), se anota el del botón y, aparte, el del
  Asistente.
- **Callejón sin salida** = el usuario hace algo razonable y Studio no avanza ni explica qué hacer
  (botón deshabilitado sin motivo, error sin acción, panel vacío sin «cómo empezar», atajo que no
  hace nada). Cada uno se anota con la captura.
- **Texto en inglés visible** = una palabra de `UI_ENGLISH_DENYLIST` (`packages/shared/src/texts-es.ts`)
  o cualquier término técnico en inglés que el usuario lea fuera de una sección «Avanzado» plegada
  (incluye opciones de listas, tooltips, mensajes de error y toasts). Nombres propios de productos
  (Remotion, Whisper, ElevenLabs) no cuentan si aparecen solo en «Avanzado» o junto a una
  explicación en español.
- **Espera** = tiempo desde la acción hasta el resultado visible; se mide con el reloj de
  Playwright (`Date.now()` antes/después) y se anota en segundos con una decimal.

## 3. Los 9 flujos (guion exacto)

| # | Flujo | Pasos a ejecutar (usuario nuevo) |
| - | ----- | -------------------------------- |
| 1 | Primer proyecto → exportar | Ctrl+Alt+N → «Importar» en la vista previa → `vertical.mp4` → pestaña Exportar → «Reels / TikTok» → Exportar → abrir el resultado. Contar clics y callejones. |
| 2 | Subtítulos / edición por texto | Con `clip.mp4`: Subtítulos → Transcribir → elegir estilo «Reels» → abrir Guion → «Quitar seguras» → corregir una palabra (F2) → exportar 9:16 y mirar 3 fotogramas (legibilidad, zona segura). |
| 3a | Asistente local / Consola Claude | Asistente: «cortá los silencios y exportá para Reels» → revisar el plan → confirmar la exportación → aplicar → «Deshacer todo». Consola: abrir y pedir lo mismo. |
| 3b | «Evaluar modelos» | Ajustes → Asistente local → «Evaluar modelos» (Rápida) → leer el resultado. |
| 4 | Trabajos, servicios caídos, paquetes | Apagar los workers → intentar transcribir → leer el aviso → volver a prenderlos → reintentar; pedir «Limpiar voz (IA)» sin el paquete → diálogo «Paquete requerido». |
| 5 | Motion graphics y perfil de estilo | Motion graphics → «Rótulo» → cambiar estilo y posición → «Añadir sin renderizar» → doble clic en el clip → editar desde Propiedades (vista previa) → «Renderizar ahora». Perfil de estilo: analizar `clip.mp4` → aplicar. Ajustes → Kit de marca: cambiar el acento y ver la vista previa. |
| 6 | Voz | Voz y audio → «¿Qué voz?»: Voces de Studio → generar una frase; Mis voces → ver qué pide; Convertir mi grabación → elegir modelo. |
| 7 | Timeline (fluidez de edición) | 26 clips: seleccionar varios (Mayús), cortar con S en el cursor, borrar con ripple (Mayús+Supr), deshacer/rehacer, mover con el imán. Medir latencia de cada gesto. |
| 8 | Consistencia general (UI/textos) | Recorrer cada panel y Ajustes: nombres (GLOSSARY_ES), voseo, tooltips de íconos, estados vacíos, foco visible con Tab, controles deshabilitados con motivo, tipografías. |

Cada flujo se corre **una vez**, en este orden, con el storage nuevo del §1 (el 1 parte de cero).

## 4. Cómo puntuar 1–5 cada dimensión

| Puntaje | Descubribilidad | Pasos | Feedback | Autonomía IA | Consistencia |
| :-: | --- | --- | --- | --- | --- |
| 5 | Se encuentra sin pensar (botón visible donde se espera, nombre claro) | El mínimo razonable (≤ el objetivo del flujo, p. ej. ≤ 7 clics en el 1) y 0 callejones | Progreso real con etapa y ETA, resultado con acción («Abrir»), errores con causa y arreglo | Studio propone solo lo correcto (sugerencias, reglas de diseño aplicadas sin tocar) | Mismo nombre, mismo control y mismo estilo que en el resto; 0 inglés visible |
| 4 | Se encuentra en 1 intento de búsqueda (menú o tooltip) | 1–2 pasos de más, 0 callejones | Progreso y resultado claros, algún error genérico | Propone con 1 confirmación de más | 1 inconsistencia menor (un texto, un ícono) |
| 3 | Hace falta probar 2 lugares o leer una ayuda | 3–4 pasos de más **o** 1 callejón con salida obvia | Progreso sin etapa o sin ETA; algún silencio de > 3 s | Hay que pedirlo con palabras exactas | 2–3 inconsistencias o 1 término en inglés |
| 2 | Solo lo encuentra quien conoce Studio | ≥ 5 pasos de más **o** 1 callejón sin salida | Errores crudos o progreso falso | La IA espera comandos y falla a menudo | Varias pantallas con nombres o estilos distintos |
| 1 | No se encuentra o no existe | No se puede completar | Sin feedback / se cuelga | No hay ayuda | Incoherente o mayormente en inglés |

- «—» cuando la dimensión no aplica (igual que en la auditoría de 2026-10-08: 3b Autonomía, 8 Pasos y
  8 Autonomía). El **promedio** es la media de todas las celdas con número (no se cuentan «—»).
- Medio punto no se usa: si dudás entre dos valores, elegí el menor y anotá por qué.
- Cada puntaje ≤ 3 lleva un hallazgo (H#) con captura y el paso exacto donde ocurre.

## 5. Métricas automáticas (`ui-smoke --ux-metrics`, mismo JSON en cada corrida)

| Métrica | Cómo se mide | Meta S6 |
| --- | --- | --- |
| `english` | Términos de `UI_ENGLISH_DENYLIST` visibles (texto, opciones, `title`, `aria-label`, `placeholder`; sin las `<details>` cerradas) en Propiedades (clip motion), Voz y audio y Motion graphics | 0 en los tres |
| `iconButtonsWithoutTip` | Botones de ícono visibles cuyo tooltip tiene < 20 caracteres o repite el `aria-label` | 0 |
| `uiFontFamilies` | Primera familia de `font-family` de todo elemento visible con texto (sin vistas previas del kit ni lienzos) | ≤ 2 |
| `firstExportClicks` | Flujo 1 automatizado (Ctrl+Alt+N, Vista previa, Importar, Exportar, encuadre si lo pide, Exportar) | ≤ 7 |

Corrida del sandbox 2026-10-18 (M2): `{"english":{"Propiedades":[],"Voz":[],"Motion":[]},
"iconButtonsWithoutTip":[],"uiFontFamilies":["-apple-system","ui-monospace"],"firstExportClicks":6,
"pass":true}` (con `next dev`; con `next start` no aparece el botón del overlay de Next).

## 6. Informe

Tabla igual a la de `auditoria-fluidez.md` §(a) + promedio con dos decimales + diferencia con la
corrida anterior por flujo; debajo, el JSON de §5, los clics del flujo 1, la lista de callejones y
los hallazgos nuevos. Guardar capturas en `docs/trabajo/capturas/` con prefijo `mapa-<fecha>-`.

## 7. Solo en la PC del usuario

Repetir los flujos 1, 5 y 6 en la notebook (i5, RTX 4050) con Windows a **125 % en 1366 px**:
anotar si algún panel corta texto o si los controles de 28 px quedan chicos, y la latencia real de
la vista previa del kit (meta < 1,5 s con caché caliente).

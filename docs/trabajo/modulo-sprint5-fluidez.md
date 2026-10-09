# Sprint 5 · M2 — Fluidez de la línea de tiempo (agente «fluidez»)

Contrato: `docs/trabajo/sprint5-contratos.md` «## M2». Hallazgos: H5, H7, H8, H9, H10, H21, H22, H26
de `docs/trabajo/auditoria-fluidez.md`. Rama `claude/funny-mccarthy-0bbdt6`.

## Qué se hizo

| Hallazgo | Cambio | Dónde |
| --- | --- | --- |
| H5 atajos muertos tras clicar la regla | La regla hace `preventDefault` en `pointerdown` (no toma foco) y pasa el foco a la línea de tiempo (`role="application"`, `tabIndex=0`); el carril vacío también. `HotkeysProvider` con scopes `global` y `editor`; cada atajo: `scopes`, `enableOnFormTags` (`true` si `inTextFields`, `["slider"]` si `onSlider`, si no `false`) e `ignoreEventWhen` (campo de texto, o diálogo modal abierto para `editor`). Paleta, Ajustes y Proyectos apagan `editor`. `SHORTCUT_ACTIONS` sale de `HOTKEYS` (32 ids) | `Ruler.tsx`, `Timeline.tsx`, `Hotkeys.tsx`, `lib/shortcuts.ts` (`hotkeyPolicy`, `isTextEditable`, `modalDialogOpen`) |
| H9 ripple | `Mayús+Supr` borra y cierra el hueco en la pista del clip (y corre los subtítulos si es la pista de video principal); `Ctrl+Mayús+Supr` y menú «Cerrar huecos de la pista»; menú del clip con «Borrar», «Borrar y cerrar hueco», «Cerrar huecos de la pista» | `lib/timeline.ts` (`rippleDelete`, `closeGaps`, `trackGaps`, `rippleTime`, `mergeRanges`), `project-store` (`rippleDelete`, `deleteSelected({ripple})`, `closeGaps`, `rippleSubtitles`), `ClipContextMenu.tsx` |
| H10 selección múltiple | `selectedClipIds[]` (el último = primario = `selectedClipId`); `Ctrl+clic` alterna, `Mayús+clic` suma el rango de la pista, rectángulo desde un carril vacío, `Ctrl+A`, `Esc`; arrastrar uno arrastra todos; borrar/mover en lote = 1 deshacer; Propiedades con N clips: velocidad y volumen en lote | `project-store` (`selectClip(id, mode)`, `selectClips`, `selectAll`, `moveSelected`, `updateClips`), `ClipView.tsx`, `Timeline.tsx` (`clipsInRect`), `InspectorPanel.tsx` (`BatchInspector`) |
| R12 Q/W, I/O | `Q`/`W` recortan el comienzo/final del clip bajo el cursor hasta el cursor, con ripple (Q deja el cursor en el corte); `I`/`O` marcan el rango (franja en la regla y en las pistas, etiqueta «I–O … ×»), `Alt+X` lo quita. `inOut` vive en el store (no se guarda en el proyecto) para que Exportar (M3) lo lea | `lib/timeline.ts` (`trimToCursor`), `project-store` (`trimToCursor`, `markIn/markOut/clearInOut`, `inOut`) |
| Imán | `snap {enabled, playhead, clipEdges, inOut}` en `settings-store` (persistido en `ui.snap`); botón imán + menú de tildes | `settings-store.ts`, `TimelinePanel.tsx`, `ClipView.tsx` (`magnetPoints`), `packages/shared/src/settings.ts` (campo aditivo `ui.snap`) |
| H7 proyectos | `GET /api/projects?view=summary` (`ProjectSummary[]`, recientes primero, miniatura del 1.er clip de video), `PATCH /api/projects/:id` (renombrar → `ProjectSummary`, 400/404 `PROJECT_NOT_FOUND`), `POST /api/projects/:id/duplicate` (201, ids nuevos, mismos medios, «{nombre} (copia)»). Web: botón con el nombre del proyecto en la cabecera → diálogo «Proyectos» (`Ctrl+O`): buscar, abrir (guarda antes el actual), renombrar en línea, duplicar, borrar con confirmación, «Proyecto nuevo» (`Ctrl+Alt+N`). El primer video renombra «Proyecto sin título» con el nombre del archivo; renombrar es 1 deshacer | `packages/shared/src/projects.ts` (`projectSummary`, `autoProjectName`, `duplicateProjectName`, `isUntitledProjectName`), `routes/projects.ts`, `lib/api-projects.ts`, `ProjectsMenu.tsx`, `actions.ts` (`openProjectById`, `newProjectNow`) |
| H22 autoguardado | `pagehide` → `fetch(PUT /api/projects/:id, {keepalive:true})` si hay cambios pendientes y el cuerpo ≤ 64 KB; si es más grande, el debounce baja de 1,5 s a 300 ms | `use-project-sync.ts` (`onPageHide`, `saveDebounceMs`), `lib/api-projects.ts` (`flushProjectOnHide`) |
| H8 1366 px | Cabecera con «Asistente» y «Exportar» (primario) fijos; «Comandos» se oculta bajo 1280 px. Layout por defecto: derecha Propiedades · Asistente · Exportar; izquierda Media · Biblioteca · Motion · Voz; abajo Línea de tiempo · Subtítulos · Trabajos · Consola Claude · Perfil de estilo. El desborde de pestañas de dockview dice «Más paneles ⌄» (CSS). Los layouts guardados no se migran | `Dashboard.tsx`, `lib/layout.ts`, `DockLayout.tsx` |
| H21 tooltips | `Button` acepta `tip` (clave de `TIPS`; el texto ya trae el atajo) y `disabledReason` (se agrega al tip; el botón deshabilitado se envuelve para que el hover funcione). Renderiza `data-tooltip` (y `data-tip`) para los tests. 46 de las 51 claves aplicadas por M2 (cabecera, Vista previa, Línea de tiempo, Pista, Media, Subtítulos, Motion, Estilo, Biblioteca, Keyframes); `gpu` y `jobs*` son de M1, `presetDup/Del` de M3. Otros botones de ícono sin clave en `TIPS` (Proyectos, keyframes, efectos de voz, opciones del imán) tienen texto propio ≥ 20 caracteres | `components/ui/button.tsx`, paneles |
| H26 estados vacíos | Vista previa sin clips: «Arrastrá un video acá o tocá Importar» + botón (importa y lo pone en la línea de tiempo; soltar archivos sobre la vista previa hace lo mismo); línea de tiempo vacía: «Agregá un medio con el botón + del panel Media o arrastrándolo hasta una pista»; Media vacío: tipos aceptados. Primer video con lienzo 1920×1080 por defecto → lienzo según el video (misma regla que «Ajustar lienzo al video») en el mismo paso de deshacer que el clip, con aviso «Ajusté el lienzo a 1080×1920 · Deshacer» | `PreviewPanel.tsx`, `Timeline.tsx`, `MediaPanel.tsx` (`pickMediaFiles`, `importAndPlace`), `project-store` (`addAssetClip`, `firstVideoAdjust`, `canvasSizeForVideo`), `components/timeline/auto-adjust.ts` |
| Ajustes → Atajos | Cada atajo muestra su `help_es` (y «funciona en todo Studio» para los globales) desde `HOTKEYS` | `SettingsDialog.tsx` |
| Textos | `StylePanel` usa `PACKS_PATH_ES` | `StylePanel.tsx` |

`S` con selección: corta los clips elegidos que están bajo el cursor; si ninguno lo está (clic en la
regla lejos de la selección), corta todo lo que está bajo el cursor. `Supr` borra la selección
completa (antes: un clip).

## Tests

- shared: `test/projects.test.ts` (summary, miniatura, nombre automático, copia), `test/hotkeys.test.ts`
  (32 ids únicos, sin teclas repetidas, ayuda en todos, flechas `onSlider:false`, sin Ctrl+N/T/W).
- web: `timeline-ripple.test.ts` (ripple con rangos solapados y pista bloqueada, `rippleTime`,
  `closeGaps`, Q/W, `clipsInRect`), `selection.test.ts` (replace/toggle/range/rect/select all, borrar y
  mover en lote = 1 deshacer, ripple con subtítulos, Q/W, cerrar huecos, I/O, primer video →
  nombre + lienzo en 1 deshacer, renombrar = 1 deshacer), `hotkeys-scope.test.tsx` (registro derivado,
  `hotkeyPolicy`, `S`/`Supr` con foco en `role=slider` y flechas no, nada en campos de texto, el
  diálogo de proyectos apaga `editor` y `Ctrl+K` sigue), `tooltips.test.tsx` (51 claves ≥ 20
  caracteres ≠ `aria-label`; `tip` + `disabledReason`; todos los botones de ícono de la línea de
  tiempo se explican), `project-sync.test.ts` (`pagehide` con `keepalive`, > 64 KB → debounce 300 ms).
  `settings-store.test.ts` actualizado al layout nuevo.
- api: `test/projects-summary.test.ts` (summary ordenado y sin `tracks`, PATCH 200/400/404, duplicate
  con ids nuevos y nombre propio, DELETE).
- e2e `run-e2e.mjs` bloque `sprint5:M2`: «sprint5: projects summary + rename + duplicate».
- `ui-smoke.mjs` bloque `sprint5:M2`: regla → `S`; regla → `Espacio`, `K`, `L`, `J`, `Supr`;
  `Mayús+Supr` (0 px); `Mayús+clic` + `Supr`; rectángulo 3; Q/W; I/O + `Alt+X`; 1366×768 y 1093×700
  (Asistente y Exportar visibles y abren su panel); hover en Paneles; cobertura de tooltips
  (`data-tooltip` ≥ 20 y ≠ `aria-label` en cabecera, Media, Vista previa y Línea de tiempo; todo
  `data-tip` existe en `TIPS`); Proyectos (crear 2, renombrar, abrir el otro, borrar con
  confirmación); estado vacío de la vista previa.

## Borrador manual §4 (Recorrido por el dashboard: cabecera, proyectos y línea de tiempo)

**Cabecera.** A la izquierda, el nombre del proyecto: tocalo (o `Ctrl+O`) para abrir **Proyectos**.
A la derecha, siempre a la vista, **Asistente** y **Exportar**; después el estado de la IA local,
**Comandos** (`Ctrl+K`, solo en pantallas anchas), **Paneles**, **Layouts**, **Tema**, **Reportar
error** y **Ajustes**. Pasá el mouse por cualquier botón de ícono: dice qué hace, su atajo y, si
está deshabilitado, por qué.

**Proyectos** (`Ctrl+O`). Lista de proyectos con miniatura, fecha, duración y cantidad de clips,
los más recientes primero, con buscador. **Abrir** guarda antes el proyecto actual. El lápiz
renombra (Enter guarda, Esc cancela), el ícono de copia **duplica** (misma línea de tiempo y mismos
medios, «… (copia)»), la papelera **borra** después de confirmar con el nombre (los medios no se
borran). **Proyecto nuevo** (`Ctrl+Alt+N`; `Ctrl+N` lo reserva el navegador). Cuando importás el
primer video, un proyecto «Proyecto sin título» toma el nombre del archivo y el lienzo se ajusta al
video (por ejemplo 1080×1920 para un vertical); el aviso trae **Deshacer**.

**Distribución.** Izquierda: Media, Biblioteca, Motion graphics y Voz y audio. Centro: Vista previa.
Derecha: Propiedades, Asistente y Exportar. Abajo: Línea de tiempo, Subtítulos, Trabajos, Consola
Claude y Perfil de estilo. Si un grupo no tiene lugar para todas sus pestañas aparece **Más paneles
⌄** con la lista. **Layouts → Restaurar layout** (`Ctrl+Shift+R`) vuelve a esta distribución (los
layouts que guardaste quedan como estaban).

**Vista previa vacía.** Sin clips muestra «Arrastrá un video acá o tocá Importar»: soltá un archivo
ahí o tocá **Importar** y queda en la línea de tiempo.

**Línea de tiempo.**
- Clic en la regla mueve el cursor y **no** le quita el teclado a la línea de tiempo: después de
  clicar podés usar `S`, `Espacio`, `J`/`K`/`L`, `Supr`, `Q`/`W`, `I`/`O` enseguida.
- **Elegir clips:** clic elige uno; `Ctrl+clic` suma o quita; `Mayús+clic` suma todos los de la
  pista entre el elegido y el clicado; arrastrar desde una zona vacía dibuja un rectángulo y elige
  lo que toca (con `Mayús`/`Ctrl` suma a lo elegido); `Ctrl+A` elige todo lo de pistas sin bloquear;
  `Esc` quita la selección. Con varios elegidos, arrastrar uno mueve todos y **Propiedades** cambia
  velocidad y volumen de todos («3 clips»).
- **Borrar:** `Supr` borra lo elegido y deja el hueco; `Mayús+Supr` borra y **cierra el hueco** (lo
  que sigue en esa pista se corre a la izquierda; si es la pista de video principal, los subtítulos
  también). Clic derecho en un clip: **Borrar**, **Borrar y cerrar hueco**, **Cerrar huecos de la
  pista** (`Ctrl+Mayús+Supr`). Las pistas bloqueadas nunca se tocan.
- **Recortar al cursor:** `Q` corta desde el comienzo del clip hasta el cursor y `W` desde el cursor
  hasta el final; lo que sigue se corre para no dejar hueco.
- **Entrada y salida:** `I` marca la entrada y `O` la salida (franja de color en la regla y en las
  pistas, etiqueta «I–O»); `Alt+X` o un clic en la etiqueta las quita. Exportar puede usar solo ese
  tramo.
- **Imán** (`N`): los clips se pegan al cursor, a los bordes de otros clips y a las marcas I/O; la
  flechita al lado del imán elige a qué se pega.
- Cada una de estas acciones es un solo paso de **Deshacer** (`Ctrl+Z`).
- Si cerrás la pestaña justo después de un cambio, Studio lo envía igual al cerrarse.

## Borrador manual §5 (Flujo 1 — Cortar y exportar un clip, pasos 3–5 nuevos)

3. Hacé clic en la regla donde querés cortar y tocá `S` (no hace falta clicar el clip). Para cortar
   desde el comienzo del clip hasta ahí, `Q`; desde ahí hasta el final, `W`.
4. Elegí la parte que no querés y apretá `Mayús+Supr`: se borra y lo que sigue se corre, sin hueco
   (`Supr` solo deja el hueco).
5. Para varias partes a la vez: `Ctrl+clic` en cada una (o un rectángulo) y `Mayús+Supr`.

## Borrador manual §10 (Atajos de teclado, tabla completa)

Todos se cambian en **Ajustes → Atajos**, que muestra también para qué sirve cada uno. Los de
edición y reproducción funcionan después de clicar la regla (las flechas no); ninguno se dispara
mientras escribís en un campo de texto, salvo `Ctrl+K`, `Ctrl+S`, `Ctrl+E` y `Ctrl+Shift+A`. Con la
paleta, Ajustes o Proyectos abiertos solo funcionan los globales.

| Acción | Atajo por defecto | Grupo |
| --- | --- | --- |
| Reproducir / pausar | `Espacio` | Reproducción |
| Ir al inicio / al final | `Inicio` / `Fin` | Reproducción |
| Reproducir hacia atrás / adelante (otra vez: 2×, 4×) | `J` / `L` | Reproducción |
| Pausa (detenido, con un clip: keyframe) | `K` | Reproducción |
| Fotograma anterior / siguiente | `←` / `→` | Reproducción |
| Cortar en el cursor | `S` | Línea de tiempo |
| Borrar lo elegido (deja hueco) | `Supr` | Línea de tiempo |
| Borrar y cerrar el hueco | `Mayús+Supr` | Línea de tiempo |
| Cerrar huecos de la pista | `Ctrl+Mayús+Supr` | Línea de tiempo |
| Elegir todos los clips / quitar la selección | `Ctrl+A` / `Esc` | Línea de tiempo |
| Recortar comienzo / final hasta el cursor | `Q` / `W` | Línea de tiempo |
| Marcar entrada / salida / quitarlas | `I` / `O` / `Alt+X` | Línea de tiempo |
| Acercar / alejar | `=` / `-` | Línea de tiempo |
| Imán | `N` | Línea de tiempo |
| Deshacer / rehacer | `Ctrl+Z` / `Ctrl+Shift+Z` | Edición |
| Exportar (abre el panel) | `Ctrl+E` (global) | Proyecto |
| Guardar | `Ctrl+S` (global) | Proyecto |
| Abrir proyecto / proyecto nuevo | `Ctrl+O` / `Ctrl+Alt+N` (globales) | Proyecto |
| Paleta de comandos | `Ctrl+K` (global) | Interfaz |
| Restaurar layout | `Ctrl+Shift+R` | Interfaz |
| Asistente | `Ctrl+Shift+A` (global) | Interfaz |
| Consola Claude | `Ctrl+Shift+C` | Interfaz |
| Zoom de la línea de tiempo | `Ctrl` + rueda | (fijo) |
| Elegir varios clips | `Ctrl+clic`, `Mayús+clic`, rectángulo | (fijo) |

## Borrador ARQUITECTURA (web: línea de tiempo y atajos)

- **Atajos**: registro único `packages/shared/src/hotkeys.ts` (`HOTKEYS`, 32 entradas con
  `scope`, `onSlider`, `inTextFields`, `help_es`); la web deriva `SHORTCUT_ACTIONS` y las teclas del
  usuario (`settings-store.shortcuts`) pisan los defaults. `Hotkeys.tsx` monta `HotkeysProvider`
  con scopes `global` y `editor`; `EditorScopeGate` apaga `editor` con paleta/Ajustes/Proyectos y
  `hotkeyPolicy()` decide `enableOnFormTags` / `ignoreEventWhen` (texto editable, diálogo modal).
  La línea de tiempo es `role="application"` enfocable; la regla (`role="slider"`) nunca toma foco.
- **Selección**: `project-store.selectedClipIds` (orden = orden de elección, último = primario =
  `selectedClipId`, que siguen usando los paneles de un clip). Gestos en `ClipView` (modificadores,
  arrastre en grupo con `moveSelected(delta, false, origins)` tras un `checkpoint`) y en `Timeline`
  (rectángulo → `clipsInRect`).
- **Ripple**: funciones puras en `lib/timeline.ts` (`rippleDelete`, `closeGaps`, `trimToCursor`,
  `rippleTime`); el store las aplica en un `commit` (1 deshacer) y remapea subtítulos con
  `rippleSubtitles` solo si la pista es la de video principal (la primera de video).
- **I/O**: `project-store.inOut` (efímero, no viaja en `Project`).
- **Proyectos**: `GET /api/projects?view=summary` usa `projectSummary()` de shared; duplicar crea con
  `repos.projects.create` y guarda la copia con ids nuevos (`withNewIds`). Web: `lib/api-projects.ts`
  y `ProjectsMenu.tsx`; cambiar de proyecto = `saveProjectNow()` + `loadProject()` +
  `persistLocalProject()`.
- **Deshacer de nombre/lienzo**: `Snapshot` puede llevar `name`/`settings` solo en los pasos que los
  cambian (primer video, renombrar); deshacer/rehacer conserva esa forma. El resto de los ajustes
  sigue fuera del deshacer (H25, Sprint 6).
- **Autoguardado**: debounce 1,5 s (300 ms si el proyecto supera 64 KB) + `pagehide` con
  `keepalive`.

## Pedidos a otros módulos

- **M1**: `JobsPanel`/`GpuIndicator` pueden usar `tip="jobCancel"` etc. y `disabledReason` del
  `Button` (ya lo vi en uso). `useAiAvailability` ya se llama en Vista previa (`matting`, `sam2`)
  para deshabilitar «Quitar fondo» y «Máscara» con motivo. En `Dashboard.tsx` el `<JobsIndicator />`
  va dentro del `div.ml-auto` de la cabecera, antes de `<GpuIndicator />`.
- **M3**: `useProjectStore((s) => s.inOut)` da `{in, out}` en segundos (o `undefined`) para «Solo el
  rango I–O»; `tip="presetDup"` / `tip="presetDel"` en ExportPanel. El encabezado «Exportar» de la
  cabecera llama `runAction("project.export")` (`showPanel("export")`).
- **Integración**: pegar los borradores §4/§5/§10 y ARQUITECTURA; `CLAUDE.md` no cambia.

## Solo medible en la PC

- `Ctrl+O` en Edge/Chrome de Windows: debe abrir Proyectos y no el diálogo «Abrir archivo» del
  navegador (se hace `preventDefault`); `Ctrl+Alt+N` con distribuciones de teclado que usan AltGr.
- Escala 125 % en una pantalla de 1366 px (≈ 1093 px CSS): Asistente y Exportar visibles (probado
  con viewport 1093×700 en Chromium, no con la escala real de Windows).
- Arrastre de una selección de 50+ clips y rectángulo con muchos clips (fluidez; la medición de la
  auditoría fue con 26).
- `pagehide` al cerrar la ventana de Edge con cambios recién hechos (keepalive real contra la api
  local).

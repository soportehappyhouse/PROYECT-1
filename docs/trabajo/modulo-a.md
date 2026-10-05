# Módulo (a) — Dashboard web (`apps/web`)

## Hecho
- **Layout** dockview 8 (`dockview-react`): 10 paneles (Media, Biblioteca, Vista previa, Línea de tiempo, Propiedades, Motion graphics, Voz y audio, Subtítulos, Exportar, Trabajos) movibles, redimensionables, flotables y ocultables (menú Paneles / paleta). Layout validado con zod y persistido en localStorage + `PUT /api/settings` (bloque aditivo `ui`, gana la copia más nueva). "Restaurar layout" y presets de layout con nombre.
- **Apariencia**: tema claro/oscuro/sistema (sin parpadeo, script pre-paint), color de acento, densidad (compacta/cómoda/amplia). **Atajos** configurables (captura de teclas, detección de conflictos) con react-hotkeys-hook; **paleta de comandos** cmdk (`Ctrl+K`).
- **Proyecto** (`Project/Track/Clip` de shared) en zustand con deshacer/rehacer; autosave en localStorage y `PUT /api/projects/:id` (crea con `POST` si da 404). Pistas video/audio/texto/motion: mover (incl. cambio de pista del mismo tipo), recortar por bordes, dividir, borrar, imán (0, cursor, bordes), zoom (`Ctrl+rueda`, slider), cursor/regla, mute/ocultar/bloquear. Miniaturas en clips de video y forma de onda wavesurfer 8 en audio: picos de `waveformPath`/`proxies/<id>.peaks.json` y, si faltan, decodificados en el navegador.
- **Vista previa**: `<video>` del clip bajo el cursor sincronizado (proxy si existe), audio de pistas de audio, overlays de texto, subtítulos con estilo y render de motion (o placeholder).
- **Media**: subida drag & drop (XHR con progreso), lista con miniatura y metadatos de probe, arrastrar a una pista (dnd-kit) o botón "+", generar proxy, borrar. **Biblioteca**: búsqueda local/proveedores, escucha previa, importar y añadir al timeline.
- **Voz**: TTS (voces de la API, proveedores según `/api/config`), cadena de efectos (presets de shared + editor de parámetros; "aplicar" crea job o "aplicar al exportar" guarda `clip.voiceEffects`), RVC (modelos, tono, índice, F0, CUDA). **Subtítulos**: transcribir clip, editar/añadir/borrar segmentos, SRT, estilos, "renderizar como motion" (`animated-captions`). **Motion**: motores y plantillas de la API, formulario generado desde `propsSchema` (JSON Schema), vista previa aproximada + último render, renderizar/añadir/actualizar clip. **Exportar**: presets (incluidos + propios editables, API o localStorage si 501), rango, nombre, job y descarga.
- **Trabajos**: SSE `/api/jobs/events` (fallback a consulta cada 5 s solo con jobs activos), progreso, cancelar, abrir resultado, toasts; al terminar aplica el resultado (reemplaza audio del clip, añade TTS al cursor, asigna render de motion, vuelca transcripción).
- Cliente único tipado `src/lib/api.ts` (`API_ROUTES`); 501 → "Módulo en desarrollo" (aviso en panel o toast), API caída → "Guardado local".
- shared (aditivo): `src/dashboard.ts` (`DashboardSettingsWithUi`, `LayoutPreset`, `UiDensity`, `WaveformPeaks`, `waveformPeaksPath`).

## Pendiente / límites
- Composición multi-clip real en la vista previa (fuera de alcance: se muestra el clip bajo el cursor).
- `@remotion/player` no se usa (la vista previa de motion es aproximada hasta renderizar).
- Panel `export` no está en `PanelIdSchema` (se omite del array `panels` enviado a la API).
- Requiere en la API: CORS con `PUT`/`DELETE` (hoy el preflight los rechaza) y persistir el JSON completo de settings (incl. `ui`).
- Sin solapamiento automático: dos clips pueden superponerse en una pista (gana el último en la vista previa).

## Cómo probar
- `pnpm --filter @studio/web lint typecheck test build` (53 tests: timeline, store, layout/persistencia, atajos, picos, formulario de motion, cliente API, componentes).
- `pnpm dev` y abrir http://localhost:3000. Sin API todo funciona en local (proyecto/ajustes en localStorage) y los paneles muestran "Módulo en desarrollo" o "No se pudo conectar".
- Nota: Chromium sin códecs propietarios no reproduce H.264 (usar Chrome/Edge).

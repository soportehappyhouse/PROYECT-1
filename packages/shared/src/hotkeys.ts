import { z } from "zod";

/**
 * Sprint 5: single keyboard shortcut registry (docs/trabajo/sprint5-contratos.md, decision 7).
 * `global` shortcuts work always; `editor` ones turn off while a dialog or the command palette is
 * open. Edit/transport shortcuts also fire with focus on a `role=slider` (the ruler) except the
 * arrows; never inside text fields unless `inTextFields`. Ids = the web's ShortcutActionId.
 */
export const HotkeyScopeSchema = z.enum(["global", "editor"]);
export type HotkeyScope = z.infer<typeof HotkeyScopeSchema>;

export type HotkeyGroup = "Reproducción" | "Línea de tiempo" | "Edición" | "Proyecto" | "Interfaz";

export interface HotkeyDef {
  id: string;
  group: HotkeyGroup;
  /** Default keys in contract format ("Ctrl+Shift+Z", "Space", "Delete"). */
  keys: string;
  scope: HotkeyScope;
  /** Fires with focus on a role=slider (ruler). */
  onSlider: boolean;
  /** Fires inside inputs/textareas/contenteditable. */
  inTextFields: boolean;
  label_es: string;
  help_es: string;
}

const editor = (
  id: string,
  group: HotkeyGroup,
  keys: string,
  label_es: string,
  help_es: string,
  onSlider = true,
): HotkeyDef => ({
  id,
  group,
  keys,
  scope: "editor",
  onSlider,
  inTextFields: false,
  label_es,
  help_es,
});

const global = (
  id: string,
  group: HotkeyGroup,
  keys: string,
  label_es: string,
  help_es: string,
  inTextFields: boolean,
): HotkeyDef => ({
  id,
  group,
  keys,
  scope: "global",
  onSlider: true,
  inTextFields,
  label_es,
  help_es,
});

/** Existing shortcuts (defaults unchanged) + Sprint 5 additions. */
export const HOTKEYS: readonly HotkeyDef[] = [
  // ---- Reproducción
  editor(
    "playback.toggle",
    "Reproducción",
    "Space",
    "Reproducir / pausar",
    "Reproduce o pausa la vista previa desde el cursor",
  ),
  editor(
    "playback.toStart",
    "Reproducción",
    "Home",
    "Ir al inicio",
    "Lleva el cursor al comienzo del proyecto",
  ),
  editor(
    "playback.toEnd",
    "Reproducción",
    "End",
    "Ir al final",
    "Lleva el cursor al final del último clip",
  ),
  editor(
    "playback.shuttleBack",
    "Reproducción",
    "J",
    "Reproducir hacia atrás (otra vez: más rápido)",
    "Reproduce hacia atrás; cada vez que la tocás va más rápido",
  ),
  editor(
    "playback.pause",
    "Reproducción",
    "K",
    "Pausa (detenido, con un clip elegido: agregar keyframe)",
    "Pausa; detenido y con un clip elegido agrega un keyframe en el cursor",
  ),
  editor(
    "playback.shuttleForward",
    "Reproducción",
    "L",
    "Reproducir (otra vez: más rápido)",
    "Reproduce hacia adelante; cada vez que la tocás va más rápido",
  ),
  editor(
    "playback.frameBack",
    "Reproducción",
    "ArrowLeft",
    "Fotograma anterior",
    "Retrocede el cursor un fotograma",
    false,
  ),
  editor(
    "playback.frameForward",
    "Reproducción",
    "ArrowRight",
    "Fotograma siguiente",
    "Avanza el cursor un fotograma",
    false,
  ),
  // ---- Línea de tiempo
  editor(
    "timeline.split",
    "Línea de tiempo",
    "S",
    "Dividir clip en el cursor",
    "Corta en dos el clip elegido (o el que está bajo el cursor) en el cursor",
  ),
  editor(
    "timeline.delete",
    "Línea de tiempo",
    "Delete",
    "Eliminar clip seleccionado",
    "Borra los clips elegidos y deja el hueco",
  ),
  editor(
    "timeline.rippleDelete",
    "Línea de tiempo",
    "Shift+Delete",
    "Borrar y cerrar hueco",
    "Borra los clips elegidos y corre lo que sigue para cerrar el hueco",
  ),
  editor(
    "timeline.closeGaps",
    "Línea de tiempo",
    "Ctrl+Shift+Delete",
    "Cerrar huecos de la pista",
    "Cierra todos los huecos de la pista del clip elegido",
  ),
  editor(
    "timeline.selectAll",
    "Línea de tiempo",
    "Ctrl+A",
    "Elegir todos los clips",
    "Elige todos los clips de las pistas sin bloquear",
  ),
  editor(
    "timeline.deselect",
    "Línea de tiempo",
    "Escape",
    "Quitar la selección",
    "Quita la selección",
  ),
  editor(
    "timeline.trimStartToCursor",
    "Línea de tiempo",
    "Q",
    "Recortar el comienzo hasta el cursor",
    "Recorta el comienzo (Q) o el final (W) del clip hasta el cursor, con ripple",
  ),
  editor(
    "timeline.trimEndToCursor",
    "Línea de tiempo",
    "W",
    "Recortar el final hasta el cursor",
    "Recorta el comienzo (Q) o el final (W) del clip hasta el cursor, con ripple",
  ),
  editor(
    "timeline.markIn",
    "Línea de tiempo",
    "I",
    "Marcar entrada",
    "Marca entrada/salida del rango (reproducir en bucle y exportar solo ese tramo)",
  ),
  editor(
    "timeline.markOut",
    "Línea de tiempo",
    "O",
    "Marcar salida",
    "Marca entrada/salida del rango (reproducir en bucle y exportar solo ese tramo)",
  ),
  editor(
    "timeline.clearInOut",
    "Línea de tiempo",
    "Alt+X",
    "Quitar entrada y salida",
    "Quita las marcas de entrada y salida del rango",
  ),
  editor(
    "timeline.zoomIn",
    "Línea de tiempo",
    "Equal",
    "Acercar",
    "Acerca la línea de tiempo para ver más detalle",
  ),
  editor(
    "timeline.zoomOut",
    "Línea de tiempo",
    "Minus",
    "Alejar",
    "Aleja la línea de tiempo para ver más del proyecto",
  ),
  editor(
    "timeline.toggleSnap",
    "Línea de tiempo",
    "N",
    "Activar / desactivar imán",
    "Activa o desactiva el imán: los clips se pegan al cursor y a otros clips",
  ),
  // ---- Edición
  editor("edit.undo", "Edición", "Ctrl+Z", "Deshacer", "Deshace el último cambio"),
  editor(
    "edit.redo",
    "Edición",
    "Ctrl+Shift+Z",
    "Rehacer",
    "Vuelve a hacer lo último que deshiciste",
  ),
  // ---- Proyecto
  global("project.export", "Proyecto", "Ctrl+E", "Exportar", "Abre el panel Exportar", true),
  global(
    "project.save",
    "Proyecto",
    "Ctrl+S",
    "Guardar proyecto",
    "Guarda el proyecto ahora (también se guarda solo)",
    true,
  ),
  global(
    "project.open",
    "Proyecto",
    "Ctrl+O",
    "Abrir proyecto",
    "Abre la lista de proyectos",
    false,
  ),
  global(
    "project.new",
    "Proyecto",
    "Ctrl+Alt+N",
    "Proyecto nuevo",
    "Proyecto nuevo (Ctrl+N lo reserva el navegador)",
    false,
  ),
  // ---- Interfaz
  global(
    "palette.open",
    "Interfaz",
    "Ctrl+K",
    "Paleta de comandos",
    "Abre la paleta para buscar cualquier acción por nombre",
    true,
  ),
  editor(
    "layout.reset",
    "Interfaz",
    "Ctrl+Shift+R",
    "Restaurar layout",
    "Vuelve a la disposición de paneles por defecto",
  ),
  global(
    "assistant.open",
    "Interfaz",
    "Ctrl+Shift+A",
    "Asistente: escribir un comando",
    "Abre el Asistente para pedir un cambio en español",
    true,
  ),
  editor(
    "console.open",
    "Interfaz",
    "Ctrl+Shift+C",
    "Consola Claude: abrir la terminal de Claude Code",
    "Abre la Consola Claude para editar el proyecto conversando",
  ),
];

export type HotkeyId = (typeof HOTKEYS)[number]["id"];

/** Hotkey by id (undefined when unknown). */
export function hotkeyById(id: string): HotkeyDef | undefined {
  return HOTKEYS.find((h) => h.id === id);
}

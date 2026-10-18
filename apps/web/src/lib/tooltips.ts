/**
 * Sprint 5 tooltips (docs/trabajo/sprint5-contratos.md M2 «Tooltips (H21)»): what each icon button
 * does + its shortcut. Written by Paso 0; modules only read it (M1 JobsPanel/GpuIndicator, M3
 * ExportPanel, M2 the rest). When a button is disabled, append the reason (useAiAvailability).
 */
export const TIPS = {
  // Dashboard
  panels: "Mostrar u ocultar paneles (Media, Voz, Subtítulos…)",
  layouts: "Guardar o cargar una disposición de paneles",
  theme: "Cambiar entre tema claro, oscuro o el del sistema",
  report: "Armar un reporte de error con diagnósticos para enviar",
  settings: "Ajustes: atajos, paquetes de IA, Personas, asistente",
  // GpuIndicator
  gpu: "Estado de la IA local y la GPU; clic para ver detalles",
  // Preview
  toStart: "Ir al inicio (Inicio)",
  frameBack: "Retroceder un fotograma (←)",
  play: "Reproducir o pausar (Espacio)",
  frameFwd: "Avanzar un fotograma (→)",
  toEnd: "Ir al final del video (Fin)",
  previewOpts: "Calidad de la vista previa, guías de zona segura y modo multicapa",
  removeBg: "Quitar el fondo del clip elegido con IA (sin pantalla verde)",
  sam: "Marcar un objeto con clics y seguirlo en todo el clip (SAM 2)",
  reframe: "Llevar el video a 9:16 o 1:1 siguiendo la cara",
  track: "Seguir un objeto para que un texto o gráfico lo acompañe",
  // Timeline
  undo: "Deshacer el último cambio (Ctrl+Z)",
  redo: "Rehacer (Ctrl+Mayús+Z)",
  split: "Cortar el clip en el cursor (S)",
  delete: "Borrar el clip (Supr); con Mayús+Supr cierra el hueco",
  snap: "Imán: los clips se pegan al cursor y a otros clips (N)",
  silences: "Encontrar silencios y muletillas y elegir cuáles cortar",
  zoomIn: "Acercar la línea de tiempo (=)",
  zoomOut: "Alejar la línea de tiempo (−)",
  // Pista
  trackMute: "Silenciar esta pista (no suena ni se exporta su audio)",
  trackHide: "Ocultar esta pista en la vista previa y la exportación",
  trackLock: "Bloquear: evita mover o cortar sus clips por error",
  trackDelete: "Borrar la pista y sus clips",
  trackOrder: "Subir o bajar la capa (lo de arriba tapa a lo de abajo)",
  // Media
  mediaReload: "Volver a leer la lista de medios",
  mediaProxy: "Crear una copia liviana para editar fluido videos pesados",
  mediaAdd: "Poner este medio en la línea de tiempo, en el cursor",
  mediaDelete: "Quitar el medio del proyecto (el archivo queda en disco)",
  // Trabajos
  jobsReload: "Actualizar la lista de trabajos",
  jobsClear: "Borrar de la lista los trabajos terminados",
  jobCancel: "Cancelar: detiene el trabajo también en la IA local",
  jobOpen: "Abrir el archivo que generó el trabajo",
  jobReport: "Reportar este error con sus diagnósticos",
  // Exportar
  presetDup: "Copiar este formato para cambiarle calidad o tamaño",
  presetDel: "Borrar este formato propio (los de Studio no se borran)",
  // Subtítulos
  subAdd: "Agregar un subtítulo en el cursor",
  subDel: "Borrar este subtítulo (el video no cambia)",
  subSrt: "Descargar los subtítulos como .srt para subirlos a la red",
  // Motion
  motionReload: "Volver a cargar las plantillas de gráficos",
  // Estilo
  styleReload: "Actualizar la lista de perfiles de estilo",
  styleDel: "Borrar este perfil de estilo",
  // Biblioteca
  libPlay: "Escuchar la muestra del sonido",
  libAdd: "Poner este sonido en el cursor, en una pista de audio",
  libUpload: "Agregar tus propios sonidos o música a la biblioteca",
  // Keyframes
  kfCopy: "Copiar los keyframes del clip",
  kfPaste: "Pegar los keyframes copiados a partir del cursor",
} as const satisfies Record<string, string>;

export type TipKey = keyof typeof TIPS;

/** Tooltip text plus the reason when the control is disabled. */
export function tipWithReason(key: TipKey, reason_es?: string): string {
  return reason_es ? `${TIPS[key]}. ${reason_es}` : TIPS[key];
}

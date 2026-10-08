# PLAN-BASE v3 (propuesta) — Fluidez y autonomía profesional

**Estado:** propuesta para decisión del usuario (2026-10-08). **Base:** `docs/trabajo/auditoria-fluidez.md`
(26 hallazgos sobre la app real) y `docs/trabajo/referencias-fluidez-autonomia.md` (referencias externas).

## Objetivo

Que un usuario sin formación en diseño obtenga un video terminado con calidad profesional pidiendo el
resultado, no los pasos: Studio entiende el material, planifica, renderiza, se revisa a sí mismo y
corrige, con el usuario aprobando el plan y la exportación.

## Sprint 5 — Roces (1 semana): lo que hoy frena el uso diario

1. Centro de trabajos: progreso real por ítem, ETA, cancelar de punta a punta (incluye «Evaluar
   modelos», que hoy publica 2 % y 50 % fijos y no se puede cancelar), evaluación rápida de 20
   comandos, errores con mensaje real (hoy «Error»), sin toasts repetidos al recargar.
2. Un solo aviso cuando los workers no corren (banner), acciones deshabilitadas, textos con `start.cmd`.
3. Atajos siempre activos (la regla de tiempo bloquea S, Espacio, J/K/L, Supr), ripple delete,
   selección múltiple, abrir/listar proyectos, Asistente y Exportar visibles a 1366 px.
4. Tooltips que explican qué hace cada botón (51 íconos), estados vacíos con guía.
5. Export con `loudnorm` 2 pasadas (−14 LUFS / −1 dBTP) y ducking automático por rol de pista.
6. «Exportá para Reels» con video horizontal propone reencuadre o pregunta, nunca franjas borrosas por defecto.

## Sprint 6 — Edición por guion y sistema de diseño (2 semanas)

1. Guion editable por palabras: seleccionar y Supr corta con ripple, muletillas y pausas
   resaltadas, «dejalo en 45 s» (`fit_duration`), corrección de texto que conserva tiempos.
2. Sistema de diseño compartido (tokens: tipografías, paleta, zonas seguras, duraciones, contraste)
   usado por subtítulos, plantillas Motion y perfiles de estilo; «brand kit» del usuario; reglas
   duras de subtítulos (2 líneas, tamaño mínimo, contorno). Plantillas con opciones en español y
   vista previa sin render completo.
3. Sugerencias proactivas al importar (silencios, voz baja, escenas, caras) con «aplicar».

## Sprint 7 — Lazo autónomo (2 semanas)

1. Receta «Pulir para redes» en un clic: limpiar voz → silencios → subtítulos → reencuadre por
   escena (seguir cara, dos personas) → música con ducking → loudnorm → revisión → exportar con
   confirmación.
2. «Revisar resultado»: reglas sobre fotogramas y audio (zona segura, contraste, texto sobre cara,
   LUFS, cortes bruscos) con «Arreglar», hasta 3 iteraciones; en la Consola, Claude mira los
   fotogramas y propone correcciones.
3. `find_highlights` (transcripción + energía + cara, Qwen3 8B, secuenciado con Whisper por VRAM)
   y `cut_to_beat` (beat_this, MIT).

## Fuera de alcance (no realista en local hoy)

Generación o extensión de video por IA, puntaje de viralidad, mejora de voz generativa, varios
modelos pesados a la vez en 6 GB, multicámara automática, vista previa 4K multicapa.

## Criterios de éxito

- Sprint 5: ningún trabajo sin progreso/ETA/cancelar; con workers apagados un solo aviso; atajos
  funcionan tras clicar cualquier zona; Reels desde horizontal sin franjas por defecto.
- Sprint 6: cortar 10 muletillas desde el guion en < 1 min; subtítulos y títulos pasan las reglas
  del sistema de diseño sin tocar nada.
- Sprint 7: «Pulir para redes» sobre un video de 3 min termina sin intervención y pasa «Revisar
  resultado»; el usuario solo aprueba plan y exportación.

## Preguntas para el usuario (una sola ronda)

1. ¿Orden 5 → 6 → 7, o 6 antes que 5?
2. Brand kit: ¿una identidad (tu canal) o varias?
3. «Pulir para redes»: ¿destino principal Reels/TikTok 9:16 o YouTube 16:9?

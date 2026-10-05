# Feedback del usuario — primera prueba real en PC (2026-10-05)

Entorno: Windows, notebook i5, 32 GB RAM, NVIDIA RTX 4050 6 GB. Instalación con `setup.cmd` OK, dashboard operativo.
Prueba: video vertical de WhatsApp (478×850, 30 fps, 26,5 s) en proyecto 16:9 1920×1080; transcripción Whisper OK (4 segmentos); "Renderizar subtítulos como motion" ×2; title-card ×3; export.

## Bugs observados (prioridad alta → baja)
1. **Export sin motion**: los clips motion (animated-captions, title-card) se renderizaron pero NO aparecen en el MP4 exportado.
2. **Subtítulos duplicados en preview**: se ve a la vez el subtítulo animado palabra a palabra (correcto) y el segmento completo quemado/overlay (incorrecto).
3. **Posición de subtítulos en export**: se eligió "Abajo" y salieron al centro.
4. **Subtítulos no se ajustan al video**: con video vertical dentro del lienzo 16:9 el texto ocupa todo el ancho del lienzo (sale por fuera del video). Deberían limitarse al rectángulo del video (o al área segura del lienzo elegido).
5. **Clips motion se superponen** en la misma pista Motion → inestabilidad. Debe impedirse el solape (desplazar, crear pista nueva o avisar).
6. **Voces TTS**: solo aparece es_AR-daniela; las demás no se pueden descargar desde la app.
7. **Posición de motion graphics no es libre**: hay que poder mover/escalar el overlay (X/Y/escala y anclas: arriba, centro, abajo, esquinas).
8. **Sin atajo para reproducir/pausar** (espacio) ni J/K/L.
9. **Sin tooltips** en botones: al pasar el mouse debe mostrar acción + atajo (ej. tijera → "Cortar (S)").
10. **Sin "cortar silencios"** (quitar silencios/muletillas automáticamente).
11. UX: al borrar un medio en uso aparece 409 (correcto) pero debería ofrecer "Quitar del timeline y borrar".
12. Cosmético: los renders motion muestran "Sin proxy" en rojo en Media.

## Pedidos de producto
- Instalador incremental: si ya hay dependencias/modelos descargados, reconocerlos y saltar; solo bajar lo nuevo. Instalación desde cero puede tardar lo que tarde.
- IA local para subir el nivel (sin créditos ni nube): rotoscopia/matting, cambio de cara creíble (con consentimiento), tracking para pegar elementos, detección de escenas, comandos de edición por IA, mejoras de tiempos. Debe correr bien en RTX 4050 6 GB / 32 GB RAM, no "morir en el proceso".

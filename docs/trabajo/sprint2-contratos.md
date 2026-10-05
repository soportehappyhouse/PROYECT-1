# Sprint 2 — Contratos acordados (Fase B: visión + keyframes + preview multicapa)

Referencia de diseño: `docs/INVESTIGACION-IA-LOCAL.md` §1, §2, §5, §10; `docs/trabajo/analisis-hyperframes.md`. Hardware objetivo: RTX 4050 6 GB (medido: Whisper turbo 5,65 s/min). Decisión 2 del usuario: todo lo GPL/no-comercial aislado en venv/proceso aparte.

## Modelo de datos (packages/shared, additive)
- `Keyframe = {t: number (s, relativo al inicio del clip), v: number | {x,y} , ease: "linear"|"easeIn"|"easeOut"|"easeInOut"|"hold"}`
- `Clip.keyframes?: { position?: Keyframe[], scale?: Keyframe[], opacity?: Keyframe[], crop?: Keyframe[] /* v={x,y,w,h} % del fuente */ }` — si hay keyframes, prevalecen sobre `position/scale` fijos.
- `Clip.trackRef?: { assetId: string /* track.json */, anchor: "center"|"top"|"bottom", offset: {x,y} }` — el clip sigue el track (posición derivada en tiempo de export/preview; no se materializa en keyframes salvo "Convertir a keyframes").
- `Clip.matte?: { assetId: string /* WebM alfa o secuencia */, background?: {type:"color"|"image"|"video"|"blur", value?} }`.
- `MediaAsset.kind` admite `"track"` (JSON) y `"mask"`. `TrackFile = {version:1, fps, frames: [{t, x, y, w, h, conf}], smoothed: bool, source: {assetId, method}}` normalizado 0..1 respecto del fuente.
- `Project.reframe?: { target: "9:16"|"1:1"|"4:5", keyframes: Keyframe[] /* crop */, mode: "auto"|"manual" }`.

## Workers (apps/workers) — packs nuevos (ver tabla) y endpoints
| pack | contenido | tamaño | licencia | aislamiento |
|---|---|---|---|---|
| matting | RobustVideoMatting mobilenetv3 (TorchScript) | ~7 MB | GPL-3 | **proceso aparte** `apps/workers/vision_gpl/` con su propio venv `.venv-gpl`, invocado por CLI/HTTP interno |
| matting-image | BiRefNet-lite ONNX/torch | ~214 MB | MIT | venv principal |
| sam2 | SAM 2.1 tiny + small checkpoints + `sam2` pip | ~200 MB | Apache-2.0 | venv principal |
| reframe | YuNet ONNX (OpenCV zoo) | ~0.3 MB | MIT | venv principal (CPU ok) |
Endpoints (prefijo interno):
- `POST /vision/matte {path, model:"rvm"|"birefnet", output_base, downsample?: 0.25..1, chunk_frames?: 300}` → `{task_id}`; `GET /vision/tasks/{id}` → `{status, progress, result: {alpha_path (WebM VP9 yuva420p), preview_path, fps}}`. RVM por tramos con estado recurrente; CPU fallback con warning.
- `POST /vision/matte-image {path, output_base}` → `{path (PNG RGBA)}`.
- `POST /vision/sam/session {path, frame_range?:[a,b]}` → `{session_id, frames, fps}`; `POST /vision/sam/session/{id}/points {frame, points:[{x,y,label:1|0}], obj_id}` → `{mask_png_path, bbox}`; `POST /vision/sam/session/{id}/propagate {chunk_frames?:200}` → `{task_id}` → result `{masks_dir, track (TrackFile), alpha_path?}`; `DELETE /vision/sam/session/{id}`. Presupuesto: tiny por defecto, small si vram_free > 3 GB.
- `POST /vision/track {path, bbox:{x,y,w,h} | mask_png, method:"sam2"|"csrt", frame_range?}` → `{task_id}` → `{track_path (TrackFile), smoothed: true}` (One-Euro).
- `POST /vision/reframe {path, target, scenes?:[{start,end}], subject:"face"|"track", track_path?}` → `{task_id}` → `{keyframes: Keyframe[] (crop), per_scene: [...]}` (YuNet por escena + One-Euro; sin cara → centro).
- `/perf/run` suma `rvm_fps`, `sam2_fps`, `yunet_fps`. `/health` lista los packs nuevos. Errores `PACK_REQUIRED` como en sprint 1.

## API (apps/api)
- Jobs: `vision.matte {assetId, model, background?}` → nuevo asset `alpha` + `clip.matte` si se pasa `target{projectId,clipId}`; `vision.mask` (sesión SAM: rutas `POST /api/ai/vision/sam/session`, `/points`, `/propagate`, proxy con imágenes de máscara servidas por `/files`); `vision.track {assetId, bbox|maskAssetId, method}` → asset `track`; `vision.reframe {projectId, target, subject}` → `project.reframe.keyframes`; `timeline.track-to-keyframes {projectId, clipId}`.
- Export: keyframes → expresiones FFmpeg por tramos lineales (`overlay x='…'`, `scale` por `zoompan`/`scale=eval=frame` o pre-render por bloque cuando la expresión no sea posible), opacidad vía `format=rgba,colorchannelmixer=aa=…` por tramo o `geq`; `trackRef` se resuelve a keyframes en el compilador; `matte` = overlay del alfa sobre `background`; `reframe` = `crop` con expresiones + `scale` al preset; hash del segment cache incluye keyframes/track/matte/reframe. Fallback a pasada única si una expresión cruza bloques.
- Remotion: `animated-captions` y `lower-third` aceptan `track` (posición por fotograma) en el MotionSpec.
- Preview no la hace la API.

## Web (apps/web)
- **Preview multicapa** (referencia HyperFrames: reloj maestro + orden de capas): canvas 2D con `requestVideoFrameCallback`, capas video (elementos `<video>` por clip visible, proxy), imagen, texto, motion WebM alfa, matte (alpha + fondo), PiP, keyframes interpolados (misma función de easing que el export, en shared), reframe (recorte visible), guías de zona segura. Audio: mezcla simple de las pistas de audio visibles (volumen por clip). Objetivo: ≥ 24 fps en 1080p con 3 capas en la notebook; si cae, bajar a proxy 540p automáticamente.
- **Keyframes**: diamantes en el clip (timeline), `K` agrega keyframe de la propiedad activa, inspector con valores por keyframe y selector de easing, copiar/pegar, "Convertir seguimiento a keyframes".
- **Máscara por clic**: herramienta en la preview (puntos + / −), muestra la máscara superpuesta, "Propagar" con progreso, resultado como asset mask/alpha; "Quitar fondo" (RVM) con elección de fondo (color, imagen, video, desenfoque).
- **Seguir objeto**: dibujar caja en la preview → job track → asignar a un clip de texto/motion (`trackRef`) con ancla y offset.
- **Reencuadre**: panel "Reencuadrar a 9:16" → analiza → muestra el recorrido del recorte sobre la preview → Aplicar (keyframes de crop editables).
- Avisos de pack y de CPU como en sprint 1.

## Criterios (plan v2, sprint 2)
Recorte RVM ≥ 15 fps 1080p en la 4050; reencuadre sin saltos (One-Euro, cortes por escena); texto siguiendo un objeto exportado correctamente (test de píxeles); preview multicapa ≥ 24 fps con 3 capas.

## Cambios en integración (2026-10-05)
- **Coordenadas, una sola regla**: TrackFile = esquina sup. izq. en fracciones 0..1 de la fuente; `position` = **centro** en fracciones del lienzo; recortes de clip = fracciones de la fuente (el % se acepta en los tres lados vía `normalizeCropRect`: el export ahora también normaliza los keyframes `crop`); `Project.reframe` = fracciones del **lienzo**, `t` absoluto (los % de `/vision/reframe` los convierte la api). Nuevo helper compartido `reframeWindow` / `reframeCropAt` (shared `vision.ts`, test `reframe.test.ts`): la preview lo usa tal cual y el compilador toma de ahí el tamaño de la ventana; e2e y UI comparan export ↔ ventana de la preview.
- **Seguimiento sin retraso**: el One-Euro de `/vision/track` y de SAM (`build_track`) pasa a **ida y vuelta** (`smooth_zero_lag`, con reflexión en los extremos): el filtro causal dejaba el texto ~10 px detrás de una caja a 200 px/s. Reencuadre sin cambios (paneo con inercia).
- `VisionTrackResult.method` (`csrt` | `template` | `sam2`): la web muestra «Seguimiento listo (template matching)» y el método en Propiedades → Seguimiento.
- `DELETE /api/ai/vision/sam/session/:id` → `{deleted: boolean}`: idempotente (sesión vencida = `false`), borra las vistas de cada clic (`masks/<sesión>/`); workers borran solo los cuadros (`tmp/sam/<id>`); lo propagado (alfa, máscaras, track) son assets y quedan.
- Remotion: `track`, `trackAnchor`, `trackOffset` llevan `x-internal: true` en el JSON Schema (`INTERNAL_PROP`); el formulario de Motion graphics los oculta.
- Web: toasts de los 5 jobs (máscara propagada y reencuadre analizado agregados), `K` documentado (pausa reproduciendo, keyframe detenido); «Fotograma siguiente/anterior» se ajustan a la grilla de cuadros (antes 30 pasos = 0,99 s); keyframe de reencuadre por defecto en fracciones.
- `workers-with-mocks.py`: mocks de visión (RVM `--mock-model` alfa 200, BiRefNet alfa 200, SAM con máscara constante 30 %×40 %); `STUDIO_MOCK_DENOISE=0` / `STUDIO_MOCK_VISION=0`. CI: ffmpeg en el job de workers (apt / choco).

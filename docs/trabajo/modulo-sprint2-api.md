# Sprint 2 — módulo API (apps/api + packages/shared + packages/remotion)

Implementa la parte api de `docs/trabajo/sprint2-contratos.md`. Detalle en `docs/ARQUITECTURA.md` §2, §3, §4, §5 y §5.2.

## Contrato (`packages/shared`, aditivo)

- `keyframes.ts`: `Keyframe`, `ClipKeyframes`, `interpolate` (export y preview), `ease`, `linearizeKeyframes`, RDP `simplifyKeyframes(ToRate)`, `normalizeCropRect` (fracciones o %), `KEYFRAME_PARITY_CASES` (valores exactos para la web).
- `vision.ts`: `TrackFile`, `TrackRef`, `ClipMatte`, `ProjectReframe`, requests/resultados de los 5 jobs, `VisionTask`. `track.ts`: `trackToCanvas`, `trackPointAt`, `trackRefKeyframes`, `resolveTrackRefs` (misma geometría en export, motion y preview).
- `Clip.keyframes/trackRef/matte`, `Project.reframe`, `MediaKind` `track`/`mask`, 5 `JobType`, 8 rutas `API_ROUTES.aiVision*`/`aiTrackToKeyframes`, `WORKER_AI_ROUTES` de visión, `FEATURE_PACKS` (`matting`, `matting-image`, `sam2`, `reframe`).
- Semántica fijada: posición = **centro** en fracciones del lienzo; `t` relativo al inicio del clip (reframe: absoluto); el ease de un keyframe gobierna el tramo siguiente; coordenadas de workers en fracciones de la fuente.

## API

- `routes/vision.ts` + `jobs/handlers/vision.ts`: `vision.matte` (RVM / BiRefNet → asset alfa + `clip.matte`), sesión SAM (proxy; la máscara se copia a `masks/<sesión>/` y se sirve por `/files`), `vision.mask` (propagate → assets `track`, `mask`, alfa), `vision.track` (asset `track`, `source.assetId` reescrito, `trackRef` opcional), `vision.reframe` (seg. de fuente → timeline, % → fracciones del lienzo, guarda `project.reframe`), `timeline.track-to-keyframes` (RDP, ≤ 2/s). `PACK_REQUIRED` previo (409 plano) y dentro del job (resultado con el cuerpo).
- Subir un `.json` que valida como `TrackFile` crea un asset `track` (antes era `lottie`).
- Export: `keyframe-expr.ts` (árbol balanceado `if(lt(t,..))`, ≤ 30 puntos/s con easing). Clips con posición/escala animada se superponen solos (`scale`/`pad` `eval=frame` + `overlay x/y`); opacidad con `geq`; crop animado; texto con `x/y/fontsize/alpha` por cuadro; `matte` (alfa sobre color/imagen/video/desenfoque); `reframe` = `crop` con expresiones + `scale` al preset (en vez del fondo desenfocado).
- Bloques: keyframes re-basados al trozo y reencuadre con `t+inicio`; no hace falta volver a la pasada única por una expresión que cruza un corte (test de píxeles). Hash: keyframes, matte (+ archivos), trackRef resuelto, reframe + inicio del bloque.
- Remotion: `animated-captions` y `lower-third` aceptan `track`/`trackAnchor`/`trackOffset` (centro por cuadro); `motion.render` los pasa si el clip destino tiene `trackRef` (track en espacio de composición).

## Pruebas

- shared: `keyframes.test.ts` (paridad exacta, easings, RDP, ≤ N/s), `track.test.ts`. remotion: `track.test.ts` (paridad con shared, props).
- api: `vision.test.ts` (workers simulados: 409 previo y en job, matte video/imagen, SAM + `/files`, track + trackRef + keyframes, reframe %, import de track.json, grafo compilado, hash, props de motion); `export-keyframes.integration.test.ts` (lavfi + píxeles: texto siguiendo una caja en 3 instantes, matte sobre verde, reencuadre 9:16, rampa de opacidad, mover/zoom, bloques = pasada única con animación cortada a los 10 s).
- e2e (api :3301 con storage temporal + workers del venv): **35/35 obligatorios** (+2: texto con track → píxeles; reencuadre 9:16) y 1 opcional `vision.track` csrt real (120 cuadros).

## Pendiente / supuestos

- Recortes de `/vision/reframe` llegan en % (workers) y se guardan en fracciones; la web debe usar fracciones.
- Clips con posición/escala animada no hacen xfade con vecinos (fundido alfa). Crop animado: tamaño del primer keyframe.

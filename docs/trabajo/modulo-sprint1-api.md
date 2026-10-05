# Sprint 1 — módulo API (apps/api + packages/shared)

Implementa la parte api de `docs/trabajo/sprint1-contratos.md`. Detalle en `docs/ARQUITECTURA.md` §2, §3, §4 y §5.1.

## Contrato (`packages/shared/src/ai.ts`, aditivo)

- `GpuStatus`, `Pack`, `PackTask`, `SceneList`, `SilenceCuts`, `PerfResult`, `PublishSettings` (`project.publish`), `PackRequiredBody`, requests de los jobs y `WORKER_AI_ROUTES`.
- `ExportRequest.useSegmentCache` (ausente = true), `ExportJobResult` (`mode`, `segments`, `fallbackReason`), `MediaAsset.scenes`.
- 6 `JobType` nuevos; rutas `API_ROUTES.ai*` (`/api/ai/gpu`, `/packs`, `/packs/:id/download`, `/analyze/scenes`, `/analyze/silences`, `/timeline/apply-cuts`, `/audio/denoise`, `/perf`, `/perf/run`). Son las rutas que propuso la web.

## API

- `routes/ai.ts` + `jobs/handlers/ai.ts`: proxy de GPU/packs; jobs `packs.download` (sondea `/packs/tasks/{id}`, progreso por SSE, una descarga activa por pack), `analyze.scenes`, `analyze.silences` (manda las palabras de los subtítulos del clip en segundos de la fuente), `timeline.apply-cuts` (carril nuevo `edit`), `audio.denoise` y `perf.run`.
- `PACK_REQUIRED`: chequeo previo en la ruta → 409 con cuerpo plano; si el error llega en el job, este falla con el mismo cuerpo en `result` (`JobQueue` guarda `err.jobResult`).
- `services/timeline-edit.ts`: cortes server-side (split, ripple de la misma pista, overlays enlazados, `animated-captions` re-temporizados sin render, subtítulos).
- Render por bloques: `services/ffmpeg/segments.ts` (plan, ventanas de transición, hash, LRU) + modos `window` / `audioOnly` del compilador + `exportProject`. `SEGMENT_CACHE_MAX_GB` en `.env.example` y `config.ts`.
- NVENC/QSV/AMF en `media.proxy` (`proxyVideoArgs`) y en los bloques, con vuelta a libx264.
- Etiqueta IA (`aiLabelFilter`) en la pasada única y en los bloques.

## Pruebas

- `test/ai.test.ts` (workers simulados): GPU, packs, descarga con progreso SSE, 409 previo y job fallido con el cuerpo, escenas, silencios, apply-cuts, denoise, perf, `publish`.
- `test/segments.test.ts`: plan, ventanas, fallback, hash, modos del compilador, etiqueta, args de proxy.
- `test/segment-cache.integration.test.ts` (lavfi): 2.ª exportación 100 % en caché; cambiar un texto vuelve a renderizar solo su bloque; igual duración, tamaño y cuadros que la pasada única; diferencia media de píxeles < 4/255 (medida: 0–1,3); etiqueta IA en los dos caminos.
- e2e: nuevo paso «export twice with the segment cache». Resultado: 25/25 obligatorios en verde (api :3201 con storage temporal y workers del venv).

## Pendiente / supuestos

- La web debe leer `PackRequiredBody` en la raíz del 409, no en `error.details`.
- `perf.run` sondea `/packs/tasks/{task_id}` porque el contrato no define otro endpoint de tareas; si responde 404, espera a que cambie `perf.json`.
- Los workers pueden mandar `PACK_REQUIRED` arriba, en `detail` o en `error.details`; la api reconoce los tres.

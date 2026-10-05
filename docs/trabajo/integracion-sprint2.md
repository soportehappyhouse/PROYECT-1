# Integración Sprint 2 — 2026-10-05

Rama `claude/funny-mccarthy-0bbdt6`. Stack real en el sandbox (Linux, 4 CPU, sin GPU): api `:3001` (`node dist/index.js`, `STORAGE_DIR` temporal), workers `:8001` con `scripts/e2e/workers-with-mocks.py` (OpenCV real; RVM/BiRefNet/SAM 2 simulados), web `next build` + `next start`, Playwright Chromium (`--vp9-preview`).

## Qué se reconcilió

- **Coordenadas**: una regla y un helper compartido (`reframeWindow` / `reframeCropAt` en shared, con test): tracks = esquina sup. izq. 0..1 de la fuente; posición = centro en fracciones del lienzo; recortes en fracciones (el export ahora también acepta % en keyframes `crop`); reencuadre en fracciones del lienzo con `t` absoluto (la web ya lo respetaba; el keyframe manual por defecto estaba en %).
- **Seguimiento con retraso**: el One-Euro causal dejaba el texto ~10 px detrás de la caja (200 px/s). Ahora es de ida y vuelta (`smooth_zero_lag`): deriva real medida **2,6 px**.
- **Fotograma siguiente/anterior** acumulaba el redondeo a ms (30 pasos = 0,99 s; `K` caía en 3,465 s en vez de 3,5). Ahora se ajusta a la grilla de cuadros.
- **Método del tracker**: `VisionTrackResult.method`; con OpenCV headless corre **template matching** y la web lo dice (toast + Propiedades).
- **SAM DELETE**: idempotente (`{deleted:false}` si venció), borra las vistas de clic; lo propagado queda como asset.
- **Remotion**: `track`/`trackAnchor`/`trackOffset` marcados `x-internal`; el formulario de Motion los oculta.
- **Toasts** de los 5 jobs (faltaban máscara propagada y reencuadre analizado); `K` documentado en atajos y manual.
- **CI**: ffmpeg en el job de workers (apt / choco): los tests de visión ya no se omiten. `numpy` + `opencv-python-headless==4.11.0.86` tienen wheels abi3 para win_amd64 / py3.11.
- **Arnés**: el ruteo VP9 de `ui-smoke` no tenía CORS ni rangos (la preview no podía buscar en el video: capa de video negra). Mocks de visión y `STUDIO_MOCK_DENOISE=0` en `workers-with-mocks.py`.

## Resultados

- `run-e2e.mjs`: **41/41 obligatorios** en 358 s (+6 de integración: tracker real → trackRef → píxeles; track → keyframes; paridad `interpolate()` con easeInOut/easeOut; SAM simulado → matte color → píxeles; «Quitar fondo» RVM simulado; `vision.reframe` 9:16 con objeto → export = ventana de la preview). 2 SKIP (`--hw`, descargas) y 2 expected-fail (Whisper/Piper sin modelos).
- `ui-smoke.mjs`: **25/25** en 162 s (los 3 pasos web de Sprint 2 corridos de verdad + 5 nuevos: caja en la preview → tracker real → texto sigue (2 instantes); convertir a keyframes + `K` + edición en el inspector → export = `interpolate()`; Máscara → Propagar → Quitar fondo color (preview y export); Reencuadrar → recorrido = `reframeCropAt` → Aplicar → export; fps).
- Desde cero: install, build:packages, lint, format:check, typecheck, build y test OK; ruff + pytest con ffmpeg OK; los 7 `.ps1` parsean; `ci.yml` válido; búsqueda de secretos vacía.

## Mediciones (sandbox, sin GPU)

| Medida | Valor |
|---|---|
| Preview multicapa 1080p, 3 capas (video + imagen PiP + texto), Calidad «Original», Chromium headless | **29,1 fps** dibujados (mediana), video 1080p presentado a **30 fps**, 13,1 ms por cuadro, reloj = video |
| Ídem con Calidad «Automática» (arranque lento por la transcodificación del arnés) | baja a proxy 360p y sigue a 30 fps |
| `vision.track` real (template matching, 120 cuadros 1280×720) + export 1080p | 9,9 s; deriva 2,6 px |
| SAM simulado: sesión + clic + propagar (120 cuadros) + alfa + export | 11,3 s |
| `vision.reframe` (objeto) + export reels | 6,6 s; posición de la caja = ventana de la preview ±1 px |

El criterio de ≥ 24 fps se cumple en headless con decodificación por software; falta medirlo en la notebook (RTX 4050) con H.264 nativo.

## Pendiente

- Inferencia real de RVM (≥ 15 fps 1080p), BiRefNet y SAM 2 solo en la PC con GPU (aquí simulados); YuNet real no detecta una caja sintética (se probó el camino «objeto seguido»).
- CI de Windows con ffmpeg en el job de workers: verificar la primera corrida (no reproducible acá).

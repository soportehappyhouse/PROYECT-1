# Sprint 2 — módulo Web (apps/web + manual)

Contrato: `sprint2-contratos.md` (Web). Tipos, rutas, `interpolate()` y geometría de tracks son de
`@studio/shared`; `lib/vision-types.ts` solo agrega alias/etiquetas. Conceptos de HyperFrames
(Apache-2.0) portados con atribución en `compositor.ts`, `master-clock.ts`, `KeyframeDiamonds.tsx`.

## Qué hay

- **Preview multicapa** (`preview/CompositorStage.tsx`, canvas 2D): `lib/compositor.ts`
  `composeAt()` puro (orden del export: pista 0 al fondo, carriles por inicio, subtítulos arriba;
  keyframes, `trackToCanvas`, matte = fondo + alfa). `lib/master-clock.ts`: reloj del video
  «driver» (el de más abajo), monotónico de respaldo; `usePlaybackClock` lo lee. Dibuja en
  `requestVideoFrameCallback` (rAF si no hay cuadros). `lib/media-pool.ts`: un elemento por fuente
  + precarga a 1 s; deriva > 60 ms → `playbackRate`, > 0,5 s → seek. «Automática» baja a proxy tras
  2 s < 24 fps. HUD en dev. Engranaje: zona segura, calidad, **Vista previa clásica**.
- **Keyframes** (`lib/keyframes.ts`, `stores/keyframe-store.ts`, `panels/VisionSections.tsx`):
  rombos en el clip (arrastre = 1 undo); `K` detenido con clip elegido agrega en el cursor
  (reproduciendo sigue siendo pausa); `Supr` borra el rombo elegido; valor, curva, copiar/pegar.
- **Máscara** (`stores/mask-store.ts`, `preview/VisionTools.tsx`, `PreviewOverlay.tsx`): puntos
  +/− en fracciones del fuente, PNG superpuesto, Propagar con progreso → Quitar fondo / Seguir.
- **Quitar fondo, Seguir objeto, Reencuadrar, Convertir a keyframes** (`stores/vision-store.ts`,
  `vision/VisionDialogs.tsx`, `preview/ReframePanel.tsx`): guardan el proyecto antes del job (la
  api lee el guardado) y aplican el resultado como 1 paso de deshacer (`project.reframe` entra en
  el snapshot). Track→keyframes cae a `trackRefKeyframes` local con 404/501. `runVisionJob`: aviso
  CPU (`matting`/`sam2`) + `runWithPack`. Assets `track`/`mask` en Media son solo datos.
- Tests: `test/sprint2.test.tsx` (19): capas, paridad `KEYFRAME_PARITY_CASES`, track, store de
  keyframes (K/arrastre/undo/copiar), máscara, reencuadre, reloj/sync/proxy.

## Pendiente / notas

- Manual §4.2, §10, §15, §17.1 y nueva §18 (md + html); PDF sin regenerar (no hay `mdbuild`).
- E2E: 3 pasos nuevos en `ui-smoke.mjs` (2 capas por píxeles, `K` → rombo, panel Reencuadrar);
  no corridos acá (sin Playwright/Chromium).
- Reencuadre en preview = rect del aspecto destino centrado en el keyframe (validar con el export).
  Wipe/slide/zoom = fundido. Proxies 360p (un 540p iría en `sourceUrls()`).

# Sprint 3b — módulo E «Capas y fusiones»

Contrato: `sprint3b-contratos.md` §E (pedido: `feedback-usuario-2026-10-05-b.md` punto 3).

- **Shared** (`timeline.ts`): `Clip.blendMode` (normal|multiply|screen|overlay|add|difference|lighten|darken),
  `Clip.maskRef` (`{type:"asset",assetId}` | `{type:"shape",shape:"rect"|"ellipse",x,y,w,h,feather,invert}`, fracciones del
  cuadro visible del clip, feather en px del lienzo con escala 100 %), `Track.order` (z; ausente = índice). Todo opcional:
  proyectos viejos parsean igual y su hash de bloques no cambia. Helpers `blendModeToFfmpeg/Canvas`, `blendRgb` (referencia
  W3C; «add» = plus como canvas `lighter`), `tracksInZOrder`, `moveTrackZ`, `maskShapeRect`, fixture `LAYER_PARITY_*`.
- **Export** (`ffmpeg/timeline.ts`): pistas en `tracksInZOrder`. Máscara: forma = 1 fotograma `geq` (+`gblur` σ=feather/2·escala,
  `negate` si invierte) en loop; asset = carpeta SAM `%05d.png` (start_number = fuente·fps), PNG/imagen (luma o alfa) o video
  alfa, por la MISMA cadena crop/velocidad/ubicación del clip; se multiplica con el alfa del clip (`alphaextract` → `blend
  multiply` → `alphamerge`). Fusión ≠ normal: el clip va solo (lane propio o flotante) sobre lienzo transparente T, ambos a
  `gbrap`, `blend=all_mode` (composite primero → «overlay» depende del fondo como en canvas), `alphamerge` con el alfa del clip y
  `overlay`; «add» = `premultiply` + addition (c3 lighten). Hash de segmentos: orden z, blend, mask, stamp/fps de la máscara.
  `project-export.ts`: resuelve assets `mask` (sin probe) y pasa `fps`.
- **Preview** (`lib/compositor.ts`): orden z compartido; capa con blend/máscara → canvas offscreen, máscara `destination-in`
  (`destination-out` si invierte) con forma `filter: blur(σ)` o imagen (luma→alfa cacheado), luego `globalCompositeOperation`.
  `CompositorStage` carga frames SAM por URL (`MaskImageCache`, sin parpadeo). Vista clásica: `mix-blend-mode`.
- **UI**: Propiedades → «Capa» (`panels/LayerSection.tsx`): modo con ayudas, máscara ninguna/rectángulo/elipse/SAM-imagen,
  difuminado, Invertir, Editar forma (`preview/MaskShapeEditor.tsx`: mover + 8 tiradores, 1 paso de undo por arrastre).
  Timeline: filas en orden z, badge de capa, arrastrar cabecera (DnD nativo), menú (clic derecho / ⋮) Mover arriba/abajo, Traer
  al frente, Enviar al fondo (`lib/layers.ts`, checkpoint + undo). Clips muestran «Multiplicar · Máscara».

## Verificación y límites

- Tests: shared `layers.test.ts`; api `export-layers.integration.test.ts` (7 modos vs `blendRgb` ±8, 50 % multiply/add, elipse
  feather centro/esquinas/borde≈50 %, invertida, rect, PNG y carpeta SAM, `Track.order`, PiP keyframes+screen+elipse, hash); web
  `layers.test.tsx` (store/undo, editor, compositor, paridad de operaciones, Inspector).
- E2E real: 2 pasos `sprint3b: export …` PASS (bloques). UI smoke `Sprint 3b: «Capa» …` PASS: preview multiply [48,40,190] =
  export [45,39,192] = referencia [48,40,192]; elipse centro/esquina OK. `ui-smoke.mjs` acepta `--only <regex>`.
- Límites: clip con fusión pierde el xfade con su vecino (fundido). Export alfa: fusión contra lo que haya debajo (negro si nada).
- Feather: canvas blur vs `gblur steps=3` → igual en centro/exterior, ±pocos niveles en el borde; sin `ctx.filter` (Safari
  viejo) borde duro. Manual §22 (md/html/PDF); índice md sin §20 (consola): prettier renumera hasta que exista.

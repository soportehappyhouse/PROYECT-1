# Sprint 3b · D — Recorte de calidad alta (2026-10-06)

**Qué hay**: pack `matting-hq` (RVM `rvm_resnet50_fp16/fp32.torchscript`, release v1.0.0, 54 173 764 / 108 063 684 B, sha256 fijado; mismo `.venv-gpl`). `quality: "fast"|"high"` de punta a punta: web → `POST /api/ai/vision/matte {quality, refine:{erode, feather, despill, temporal, maskDilate}, maskAssetId}` (409 `matting-hq` si falta) → job `vision.matte` → workers `/vision/matte {quality, refine, mask_path}` → `python -m vision_gpl.rvm --quality high [--erode --feather --despill on|off --temporal --mask --mask-dilate --compare-out --compare-frame]`. En `high`: resnet50 fp16 en CUDA (fp32 CPU), 2 cuadros por llamada, reducción auto 720/lado mayor (0,375 a 1080p; `downsample` la pisa), VRAM 1,6 GB.

**Refinado** (`vision_gpl/refine.py`, GPL, numpy o torch; en CUDA corre en la GPU): (1) guía SAM: alfa = 0 fuera de la máscara dilatada; (2) despill: fondo B = mediana inferior por tesela de 8 px de lo que está fuera del primer plano crecido 3 px; color interior F empujado 8 px hacia afuera; el alfa del borde solo puede **bajar** hacia la proyección de (obs − B) sobre (F − B) (puntos que son puro fondo dejan de verse); fg = (α(obs − (1−α)B) + μF)/(α² + μ), μ = 0,3 (μ = 0 es la fórmula pedida; μ evita el ruido 1/α); fuera del alfa fg = F; (3) erosión r + feather gaussiano; (4) EMA temporal k = 0,2 en bordes. Defaults `high`: r 1, σ 0,7, despill, k 0,2; `fast`: nada (pedido idéntico al de sprint 2).

**Resultado**: `preview_compare_path` (PNG antes | después sobre damero gris, fotograma de la vista previa), `quality`, `refine`, `halo {before, after, frames, reduction}` en el resultado y en `timings`. Halo sin referencia = media ponderada por α de |color del borde − color interior cercano| (0–255) en la franja de 3 px, cada 30 cuadros + el comparado.

## Metodología y números (sintéticos, `tests/test_vision_refine.py`)

Escena 240×180: damero de 6 colores saturados (cuadros de 24 px; «denso» = 9 px) + disco color piel r 50 con borde antialias de 3 px; obs = α·fg + (1−α)·fondo. «Rápido» simulado = fg = obs (fondo mezclado en el borde) con el alfa exacto, 1 px más ancho o borroso (σ 1,2). Métrica con verdad: media ponderada por α de |fg − fg_real| (0–255) en la franja |d − r| ≤ 3 px.

| Caso (cuadros 24 px) | Rápido | Alta (defaults) | Solo «Eliminar halos» |
|---|---|---|---|
| alfa 1 px ancho (el test, umbral ≥ 40 %) | 32,7 | **8,0 (−76 %)** | 14,6 (−55 %) |
| alfa exacto | 16,9 | 1,8 (−90 %) | 3,3 (−80 %, alfa intacto: Δα 0,009) |
| alfa borroso | 22,8 | 8,9 (−61 %) | 10,6 (−54 %) |
| fondo denso 9 px, alfa ancho | 30,5 | 12,3 (−60 %) | 21,3 (−30 %) |

Score sin referencia (el que reporta la app) en el caso del test: 36,3 → 4,6. TorchOps = NumpyOps bit a bit (Δα 2e−7) con torch 2.7.1 CPU; el `.torchscript` resnet50 real cargó y corrió por el CLI (CPU, 320×180, con refinado y PNG comparado).

**Comparativa real (criterio del sprint)**: en la PC, mismo clip con fondo colorido en Rápido y en Alta calidad; el diálogo muestra el PNG antes/después y «halo de color en el borde X → Y». No pude correrla acá: sin GPU, sin clips con personas, y RVM sobre testsrc no ve a nadie (alfa ≈ 0).

**Perf**: `rvm_hq_steady_fps`, `rvm_hq_startup_s`, `rvm_hq_fps`, `rvm_hq_downsample`, `rvm_hq_halo` (mismo clip 1080p 5 s, `--quality high`); fila «Recorte alta calidad ≈ X fps sostenido (arranque Y s) · reducción 0,375». Sin medir en la 4050; el refinado son ~30 operaciones elementales por cuadro (en GPU, pocos ms a 1080p). En CPU torch tarda ~1 s/cuadro a 1080p con la máquina cargada (con 1 hilo, 5× más rápido que con 3: sobresuscripción).

**Riesgos**: la reducción de borde (r 1) achica el alfa ~1 px aunque el modelo acierte; la proyección de color puede afinar pelo fino de color muy distinto al interior (subir μ o apagar «Eliminar halos»); fondos que cambian más rápido que la tesela (8 px) limitan el despill (fila «denso»). Para la consola: `setup.ps1` puede ofrecer `models_cli --packs download matting-hq` (no toqué los .ps1). `MANUAL-USUARIO.pdf`/`index.html` sin regenerar.

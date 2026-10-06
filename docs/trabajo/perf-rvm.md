# Rendimiento de «Quitar fondo» (RVM) — 2026-10-05

Medición del dueño (RTX 4050 Laptop, `POST /perf/run`): **«Recorte de personas ≈ 9,4 fps (meta 15) · 1920×1080 · fp16 · reducción 0,2667 · CUDA»**. Objetivo: ≥ 15 fps a 1080p sin perder calidad de alfa.

Código: `apps/workers/vision_gpl/{rvm,ffio}.py` (GPL, subproceso), `studio_workers/vision/{gpl,matte}.py`, `apps/api/src/services/ffmpeg/timeline.ts` (formato «split» en la exportación). Tests: `apps/workers/tests/test_vision_rvm_pipeline.py`, `apps/api/test/export-keyframes.integration.test.ts`.

## Diagnóstico

El camino anterior era **serie**: en un solo hilo leía un cuadro RGB del ffmpeg decodificador, lo pasaba a la GPU (memoria paginable), corría el modelo, sincronizaba, bajaba **RGBA** (8,3 MB/cuadro a 1080p) y lo escribía al ffmpeg codificador, que además convertía RGBA → `yuva420p` con swscale (un hilo) antes de libvpx. El VP9 ya usaba `-deadline realtime -cpu-used 8 -row-mt 1` (lo que sugería la consigna) y las tuberías ya eran `rawvideo`, no PNG.

Dos hallazgos medidos acá:

1. **libvpx con alfa codifica dos flujos en serie** (color y alfa son dos codificadores VP9; el de alfa cuesta tanto como el de color): 1080p color solo 52 fps de pared / 42 ms CPU por cuadro; color + alfa **28,5 fps / 69 ms**. `-threads`, `-tile-columns 2 -frame-parallel 1`, `-aq-mode 0`, `-static-thresh`, `-lag-in-frames 0` no cambian nada medible (±5 %, dentro del ruido de la máquina compartida); `-cpu-used 9` no existe para VP9 en esta libvpx (rango −8..8).
2. **La conversión RGBA → yuva420p dentro del codificador** cuesta ~13–17 ms de CPU por cuadro y va en serie con libvpx.

Y una hipótesis fuerte sobre el 9,4: `rvm_fps` = cuadros / tiempo total de `matte_video` sobre un clip de **5 s (125 cuadros)**, o sea incluye costos fijos por trabajo: arranque del intérprete + `import torch` (2–4 s en Windows), carga de CUDA + TorchScript, el **primer lote** (TorchScript perfila/compila los primeros llamados), `ffprobe` ×2, la unión y la vista previa. Con F s fijos y R fps sostenidos: fps = 125 / (F + 125/R). Si R era ~20 fps, 9,4 fps ⇒ F ≈ 7 s. Por eso ahora se mide cada parte (abajo) y se propone separar «sostenido» de «arranque» en el test.

## Qué cambió

- **Pipeline en 3 carriles que se solapan** (`ffio.FramePrefetcher` + hilo principal + `ffio.EncodeWorker`): decodificación (proceso ffmpeg + hilo con cola de 6 cuadros), inferencia, codificación (hilo escritor + proceso ffmpeg, cola de 6). Errores de cualquier hilo cortan sin colgarse (test).
- **Conversión de color en la GPU**: `yuva420p_torch` hace RGB → YUV 4:2:0 BT.601 rango limitado (la misma matriz que usaba swscale para RGB sin etiqueta: mismos colores en preview y export) + alfa intacta, cuadro a cuadro (temporarios fp32 ~100 MB). Se bajan 2,5 B/px (5,2 MB) en vez de 4 (8,3 MB) y ffmpeg recibe `-pix_fmt yuva420p` sin convertir nada. `--pix-fmt rgba` deja el camino anterior para A/B.
- **Memoria fijada (pinned) + copias `non_blocking`** H2D/D2H, `torch.inference_mode`, `torch.jit.freeze` (si falla, sigue sin congelar).
- **Lotes temporales**: RVM acepta `[B,T,C,H,W]`; en CUDA van **4 cuadros por llamada** (`--seq-chunk`, 1 en CPU). Verificado con un modelo TorchScript con estado recurrente: salida idéntica bit a bit con `--seq-chunk` 1, 3 y 4, cortes de tramo impares y tamaño impar (97×55). Si CUDA se queda sin memoria con T > 1, reintenta en GPU de a 1 (`warning rvm_seq_chunk_reduced`) antes de caer a CPU.
- **`downsample_ratio`** sin cambios (auto = 512/lado mayor → 0,2667 a 1080p, dentro de lo que recomienda RVM).
- **Formato «split» opcional** (`--alpha-codec split|auto`): un `.mkv` con dos H.264 NVENC, color (`v:0`, cq 19) y alfa como luma de rango completo (`v:1`, cq 12). Se reconstruye con `[0:v:1]extractplanes=y[a];[0:v:0][a]alphamerge` (sin pérdida en el ida y vuelta de valores, test con libx264 qp 0). `auto` = split si NVENC **codifica de verdad** un cuadro (`ffio.encoder_works`: que figure en `-encoders` no alcanza; acá figura y falla sin GPU), si no VP9. El resultado dice qué se usó: `alpha_codec`.
- **Por defecto sigue VP9** (`matte.py`: `STUDIO_MATTE_ALPHA_CODEC` = `vp9` | `split` | `auto`, sin variable = `vp9`): la vista previa web reproduce el WebM con alfa en `<video>` y el job de la api registra el asset como `video/webm` VP9. Ver «Pendiente para integración».
- Perillas para medir en la 4050 (sin cambiar el default): `--channels-last`, `--cudnn-benchmark`, `--fast-start` (ejecutor TorchScript sin perfilado: baja `first_batch_s` si la compilación es lo que pesa).
- No se usó `-hwaccel cuda` para decodificar: en ffmpeg 6.1 falla duro (0 cuadros) si no hay NVDEC, no hace fallback; y la decodificación no es el carril lento (abajo). Si `decode` resultara el cuello en la 4050, se agrega con sondeo como `encoder_works`.

## Instrumentación

- `progress`: `stages` = ms/cuadro acumulados de `decode`, `pre`, `model`, `post`, `encode`.
- `done.timings`: `ms_per_frame`, `stage_fps`, `wait_ms_per_frame` (`decode` = el modelo esperó cuadros; `encode` = el modelo esperó al codificador), `bottleneck` (`decode` | `inference` = pre+model+post | `encode`), `load_s` (import torch + carga del modelo), `first_batch_s` (excluido de los promedios del modelo), `process_s`, `concat_s`; más `alpha_codec`, `pix_fmt`, `seq_chunk`.
- `gpl.run_rvm` → `RvmRun.timings` agrega `startup_s` (spawn → evento `start`: intérprete + torch + modelo) y `total_s`; `MatteEngine.matte_video` devuelve `timings` + `preview_s` y `matte_video_s`, `alpha_codec` y `output` (el archivo escrito).
- En CUDA `pre/model/post` salen de `torch.cuda.Event` (tiempo de GPU real, no de lanzamiento). `decode`/`encode` = tiempo bloqueado leyendo/escribiendo la tubería: refleja la capacidad del carril cuando es el cuello; si no lo es, es menor.
- Probar sin la app: `apps\workers\.venv-gpl\Scripts\python -m vision_gpl.rvm --input clip.mp4 --output o.webm --model-dir <models>\matting` (cwd `apps\workers`) y leer la última línea.

## Mediciones (sandbox: 4 vCPU compartidas con otros procesos, sin GPU)

Capacidad del carril de codificación, 1080p, `ffio.Writer` alimentado desde memoria (100 cuadros reales de testsrc2 + alfa con borde suave; mejor de 3 intercalado):

| Codificación | fps pared | ms CPU ffmpeg / cuadro |
|---|---|---|
| VP9 alfa ← RGBA (antes) | 29,8 | 77,9 |
| **VP9 alfa ← yuva420p (ahora)** | **37,0** (+24 %) | **61,0** (−22 %) |
| split, libx264 ultrafast (suplente de NVENC) | 64,2 | 34,4 |

Pipeline completo con `--mock-model` (1080p, 125 cuadros):

| Variante | fps | cuello (ms/cuadro) |
|---|---|---|
| código anterior (serie) | 18,1–18,8 | — |
| nuevo, `--pix-fmt rgba` (solo el solapamiento) | 25,5–26,5 (+40 %) | encode 36–37 |
| nuevo, `yuva420p` | 17,3–17,5 | inference 52 = conversión **numpy en CPU** del mock |

La última fila es un artefacto del mock (la conversión que en la GPU es un kernel de < 1 ms acá es numpy de un hilo); con ella fuera, el carril de codificación pasa de 36 a ~27 ms (fila de la tabla anterior). Calidad: decodificado contra la verdad del modelo, error de alfa medio 1,275 (nuevo) vs 1,301 (antes), p99 9 en ambos (el error es de VP9 crf 32, igual que antes); color 3,7 vs 4,1 de diferencia media contra la fuente. Luma idéntica a swscale ±1, croma ±0,1 de media a tamaño par.

## Qué espero en la RTX 4050 (sin medir: no hay GPU acá)

- **Inferencia**: RVM mobilenetv3 fp16 a 1080p con 0,25 ≈ 8–12 ms/cuadro con lotes de 4 (el paper da ~104 fps en 1080 Ti) + pre ~1,5 ms (memcpy a pinned + H2D) + post ~1 ms ⇒ **~60–90 fps**.
- **Codificación VP9 alfa**: 61 ms CPU/cuadro acá; una CPU de notebook con 4050 (8–10 núcleos, cada uno ~1,5× estos vCPU) ⇒ **~45–60 fps** (libvpx paraleliza por filas/tiles dentro de cada uno de sus dos codificadores). Con split/NVENC dejaría de ser el cuello (>150 fps).
- **Decodificación** H.264 1080p → rgb24: 10–16 ms acá ⇒ >100 fps allá.
- **Sostenido ≈ 40–60 fps** (cuello probable: `encode`), contra ~15–20 estimado antes (serie: suma de carriles). **Fin a fin en el test de 5 s**: 125 / (F + 125/50); con F = 4–6 s ⇒ **≈ 15–19 fps**; si F sigue en ~7 s ⇒ ~13 fps aunque el procesamiento ya vaya a 40+ — por eso el cambio del test de abajo.

## Pendiente para integración (fuera de lo que me tocaba)

1. **`studio_workers/vision/bench.py`** (lo que lee `perf.py`): `res = engine.matte_video(...)` ya trae `timings`. Sumar al resultado
   `"rvm_steady_fps": round((frames - seq) / max(1e-6, t["process_s"] - (t["first_batch_s"] or 0)), 1)` (seq = 4 en CUDA),
   `"rvm_startup_s": round(t.get("startup_s", 0) + (t["first_batch_s"] or 0) + t.get("preview_s", 0), 2)`, `"rvm_bottleneck": t["bottleneck"]`, `"rvm_stage_ms": t["ms_per_frame"]`, `"rvm_alpha_codec": res["alpha_codec"]`; y la web debería mostrar «≈ X fps (meta 15)» con `rvm_steady_fps` y estimar 1 min como `rvm_startup_s + 60·fps_fuente / rvm_steady_fps`. Opcional: clip de 10 s para bajar el ruido. `perf.py` no necesita cambios (solo copia lo que devuelve `run_vision_bench`).
2. **`routers/vision.py` `/matte`**: `alpha_path` desde `res["output"]` (en split es `.mkv`) y copiar `alpha_codec` y `timings` al resultado (`for key in ("precision","downsample","alpha_codec","timings")`).
3. **Para activar split** (`STUDIO_MATTE_ALPHA_CODEC=auto`): (a) api `jobs/handlers/vision.ts` registra el asset con `mimeType: "video/x-matroska"`, `videoCodec: "h264"` cuando `alpha_codec === "split"` (+ `alpha_codec` opcional en `WorkerMatteResultSchema` de shared); (b) **exportación: hecho** — `timeline.ts` reconoce un matte `.mkv` y arma `extractplanes=y` + `alphamerge` (12 líneas, test de píxeles en `export-keyframes.integration.test.ts` que falla sin el cambio); (c) **vista previa web** (`lib/compositor.ts`): Chrome no reproduce un `.mkv` de dos pistas como alfa; haría falta dibujar color y máscara por separado (WebGL o `destination-in` con la luma pasada a alfa) o pedir a los workers un proxy WebM VP9 alfa de baja resolución solo para la preview. Es lo que más trabajo lleva; hasta entonces split queda apagado.

## Riesgos residuales

- **Nada de esto corrió en CUDA**: los eventos CUDA, `pin_memory`, `non_blocking`, `torch.jit.freeze` y los lotes de 4 sobre el `.torchscript` real de RVM están probados solo con torch CPU y un TorchScript sustituto con estado recurrente (salida idéntica entre tamaños de lote). Si el `.torchscript` oficial no acepta 5D o `freeze` falla, `--seq-chunk 1` / el `except` lo cubren, pero conviene mirar el primer `done.timings` en la 4050.
- VRAM: con 4 cuadros por llamada el pico sube (estimo +100–200 MB sobre los 900 MB de `RVM_VRAM_MB`); hay reintento de a 1 ante OOM, no un ajuste del presupuesto.
- Split/NVENC no se pudo ejecutar (sin GPU): se probó el mismo grafo con libx264; parámetros NVENC (`-preset p4 -tune hq -rc vbr -cq`) por documentación de ffmpeg 6.x.
- La meta de 15 fps **fin a fin en un clip de 5 s** depende del arranque (import de torch en Windows), que este cambio no reduce; por eso el pedido de `rvm_steady_fps` + `rvm_startup_s`.
- Las mediciones del sandbox tienen ruido alto (máquina compartida con lint y un servidor de modelos): las tablas son el mejor de 3 intercalado y la CPU de ffmpeg se midió con `getrusage`.

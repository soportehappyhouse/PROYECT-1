# Integración Sprint 1 — 2026-10-05

Rama `claude/funny-mccarthy-0bbdt6`. Stack real en el sandbox (Linux, sin GPU): api `:3201` (`node dist/index.js`, `STORAGE_DIR` temporal), workers `:8201` (`apps/workers/.venv`, pack `scenes` instalado), web `:3200` (`next build` + `next start`).

## Qué se reconcilió

- **perf.run**: la api sondeaba `/packs/tasks/{id}` (404) y caía al plan B de `perf.json`. Ahora usa `GET /perf/tasks/{id}` de los workers (`WORKER_AI_ROUTES.perfTask`).
- **PerfResult**: el esquema compartido tenía `gpu` texto|booleano y descartaba `gpu_status`/`skipped`. Ahora coincide con `perf.json` (`gpu` texto, `gpu_status`, `skipped`, `errors`, `warnings`, Whisper chico); la web muestra lo omitido.
- **`gpu_fallback_cpu`**: no llegaba a la web. La api lo copia al `result` de transcribir, RVC y limpiar voz; la web muestra un aviso al terminar el job; `/gpu/status` trae `warnings`.
- **409 PACK_REQUIRED**: el cuerpo plano coincide con la web. Probado con un 409 real (Limpiar voz sin el pack abre «Paquete requerido»).
- **Rutas**: diff automático de las 52 llamadas de `apps/web/src/lib/api.ts` contra la api en marcha (método + ruta): 0 faltantes.
- **apply-cuts**: el servidor deja los `animated-captions` sin render («Sin renderizar»); el aviso de la web decía lo contrario y se corrigió. Deshacer (`PUT` anterior) restaura todo.

## Flujos reales (api + workers)

- GPU (`mode: cpu`), liberar, lista de 6 packs, pack desconocido 404.
- Pack `scenes`: desinstalado → 409 real → `packs.download` lo instaló con pip (uv + PyPI) → escenas OK.
- Escenas: video lavfi de 4 tomas (3 cortes duros) → 4 escenas, cortes en 2,00/4,00/6,00 s.
- Silencios: tono con huecos en 2–3 s y 5–6,2 s + subtítulos con «eh»/«mmm» → 2 silencios + 2 muletillas. `apply-cuts` quita 2,32 s en 5 tramos sin huecos; el clip siguiente y el título se corren 2,32 s; los subtítulos animados quedan sin render.
- Export: caché de bloques 2.ª vez 100 % en caché; con `aiLabel`, etiqueta abajo a la izquierda (363 px claros) y nada en el resto; sin `aiLabel`, 0.
- `audio.denoise`: sin el pack, 409 real. Con **mock en los workers** (`scripts/e2e/workers-with-mocks.py`: DeepFilterNet → `afftdn`), el job crea el asset y propaga `gpu_fallback_cpu`. DeepFilterNet real no corre acá (sin torch).
- `perf.run`: termina por `/perf/tasks`; `perf.json` con `gpu: "cpu"`, `scenes_fps` y motivos en `skipped`.

## Resultados

- `run-e2e.mjs`: **32/32 obligatorios** con los workers reales y **32/32** con el mock de limpieza de voz. Se agregaron 7 pasos obligatorios de Sprint 1 y 1 SKIP con motivo (descarga real de modelos de HF; usar `--download-models`).
- `ui-smoke.mjs`: **17/17** (paso nuevo: 409 real → «Paquete requerido»).
- Desde cero: install, build:packages, lint, format:check, typecheck, build y test (101 web + 146 api + 85 paquetes) OK; ruff + pytest (80) OK; los 7 `.ps1` parsean; `ci.yml` válido; búsqueda de secretos vacía.

## Pendiente

- Probar en la RTX 4050: GPU real, Whisper turbo, DeepFilterNet y criterio 2 del plan (< 30 s por minuto).
- Descargas grandes de HF (`core`, `whisper-turbo`, `rvc-base`) sin correr acá.
- Si se desinstala un pack pip con los workers abiertos, siguen viéndolo instalado hasta reiniciar (módulo ya importado).

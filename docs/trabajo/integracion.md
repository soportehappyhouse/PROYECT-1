# Integración (Hito 4) — 2026-10-04

## Qué cambió

- **CORS**: `@fastify/cors` admite `GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS`; el SSE sigue con cabeceras manuales (test de preflight + test SSE).
- **Settings**: `DashboardSettings` incluye `ui` (layout, acento, densidad, presets); test de ida y vuelta del JSON completo.
- **Motion → export**: `POST /api/motion/render` acepta `target {projectId, clipId}`; el job registra el `MediaAsset` y fija `clip.renderedAssetId` en el proyecto guardado (y en su autosave) con `ProjectRepo.patchClip`. La web envía `target`. Test: handler → clip enlazado → `compileExport` usa el render.
- **Contrato shared fusionado** (se borraron `audio-fx.ts`, `export-formats.ts`, `media-derivatives.ts`; se actualizaron todos los consumidores):
  `API_ROUTES_EXT` / `API_ROUTES_VOICE_AI` → `API_ROUTES`; `WORKER_ROUTES_EXT` → `WORKER_ROUTES` + `Worker{Transcribe,Tts,Rvc}Request` (`jobId/outputBase/provider/format`);
  `VoiceEffectSchema` (+8 efectos, `VOICE_EFFECT_PRESETS`, `format` en el request); `ExportPreset` (`gif`, `alpha`, `EXTRA_EXPORT_PRESETS`); `MediaAsset` (sprite, waveformPath, hasAudio/Video/Alpha, códecs);
  `Clip.scale/position` (PiP); `PanelIdSchema` + `export`; `DashboardSettings.ui`; `Project.captionStyle`; 9 `REMOTION_TEMPLATE_IDS`; `MotionTemplateInfo.category/defaultSize/thumbnail`.
- **Export**: PiP por clip (`pipPlacementFilters`) y subtítulos quemados con `project.captionStyle`; nombres de exportación reservados de forma atómica (dos exportaciones en el mismo segundo se pisaban → test de integración inestable).
- **Web**: Inspector con Escala/Posición X/Y (PiP); el estilo de subtítulos se guarda en el proyecto; Biblioteca con **Re-escanear** (`POST /api/library/scan`) y subida de archivos (multipart → item de biblioteca; JSON import → `MediaAsset`); resultado de transcripción validado con `TranscribeJobResultSchema`.
- **api/app.ts**: `createDefaultRegistry({ remotion: REMOTION_ENGINE_OPTIONS })` + `createMotionRenderHandler` (eliminado el duplicado de `routes/motion.ts`); `configureRemotionRenderer(config.remotion)`; tablas FTS5 de la biblioteca → `MIGRATIONS` v2.
- **Config/docs**: `.env.example` documenta `HW_ENCODER`, `QUEUE_*_CONCURRENCY`, `WHISPER_COMPUTE_TYPE`, `OPENAI_TTS_MODEL`, `ELEVENLABS_MODEL` y `REMOTION_*` (la api lee los de la api/Remotion, los workers los suyos); `setup.ps1` ejecuta `pnpm --filter @studio/remotion browser:ensure` desde la raíz; README, ARQUITECTURA §2/§3/§6 e INSTALACION actualizados.
- **Tests**: timeouts de `ffmpeg.integration.test.ts` subidos (hook 120 s, test 300 s, espera 240 s); `pnpm test` = `pnpm -r --workspace-concurrency=1 --no-bail test`.

## Verificación (Linux, estado limpio)

| Comando                                                                | Resultado                                                         |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `rm -rf node_modules */*/node_modules && pnpm install --frozen-lockfile` | OK (lockfile sin cambios)                                         |
| `pnpm build:packages` / `pnpm lint` / `pnpm format:check`              | OK / OK / OK                                                      |
| `pnpm -r typecheck` / `pnpm -r build`                                  | OK / OK                                                           |
| `pnpm -r test` (y `pnpm test`)                                         | OK: shared 6, motion-engines 22, remotion 47 (+1 skip), web 53, api 102 |
| workers: `ruff check` + `ruff format --check` + `pytest`               | OK (37 tests)                                                     |
| `grep -rn "TODO(module-" apps packages scripts` / escaneo de secretos  | sin resultados / sin resultados                                   |

CI (`.github/workflows/ci.yml`) usa solo scripts existentes (`lint`, `format:check`, `typecheck`, `build`, `test`, ruff, pytest).

## Pendientes

- Motor Motion Canvas sigue como stub (camino Revideo); rasterizador Lottie propio para `ffmpeg-lottie`; `spec.seed` sin uso.
- En el timeline `loudnorm` es de 1 pasada y `ducking` se omite (completos solo en `voice.effect`).
- La vista previa web no compone PiP ni varios clips (solo la exportación); el estilo de subtítulos no se recarga desde `project.captionStyle` al abrir un proyecto.
- Sin probar en Windows real: `setup.ps1`/`start.ps1`, AMF, índice CUDA de PyTorch, descargas de modelos, inferencia Whisper/Piper/RVC.
- `zod` fijado a 4.5.4 en `packages/remotion` (Remotion Studio) frente a ^4.6.5 en el resto.

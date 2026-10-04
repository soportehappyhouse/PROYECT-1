# Studio

Dashboard web **local** para editar video, generar motion graphics, modificar/generar voz y agregar
sonidos. Corre 100 % en tu PC Windows (sin nube, sin cuentas). Las API externas son opcionales.

> Estado: los 4 módulos (dashboard, API + FFmpeg + cola, motion graphics, workers de voz/subtítulos)
> están implementados e integrados (Hito 4, ver [`docs/trabajo/integracion.md`](docs/trabajo/integracion.md)).
> Arquitectura y contratos: [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md); guía Windows:
> [`docs/INSTALACION-WINDOWS.md`](docs/INSTALACION-WINDOWS.md).

## Inicio rápido (Windows 10/11)

Abrí **PowerShell** en la carpeta del proyecto:

```powershell
# 1) Instala Git, Node 22, Python 3.11.9, FFmpeg (winget), dependencias y modelos
powershell -ExecutionPolicy Bypass -File scripts\windows\setup.ps1
#    con GPU NVIDIA:  ... setup.ps1 -Cuda

# 2) Levanta workers (8001), API (3001) y dashboard (3000) y abre el navegador
powershell -ExecutionPolicy Bypass -File scripts\windows\start.ps1
```

Luego entrá a <http://localhost:3000>.

`setup.ps1` termina con una tabla ✅/❌ por paso (es idempotente: se puede volver a ejecutar).
`scripts\windows\doctor.ps1` diagnostica FFmpeg, GPU, modelos y el navegador de Remotion;
`stop.ps1` detiene todo.

## Requisitos (instalación manual)

- Node.js **22** y pnpm **12** (`npm install -g pnpm@12`; corepack no sirve con pnpm 12)
- Python **3.11.9**
- FFmpeg en el `PATH` (o `FFMPEG_PATH` en `.env`)
- Opcional: GPU NVIDIA + CUDA (`USE_CUDA=true`)

## Desarrollo

```powershell
copy .env.example .env          # todas las keys son opcionales (dejalas vacías)
npm install -g pnpm@12
pnpm install

# Workers Python (una vez)
cd apps\workers
py -3.11 -m venv .venv
.venv\Scripts\pip install -r requirements.txt      # o requirements-dev.txt (sin modelos)
.venv\Scripts\pip install -e . --no-deps
cd ..\..
```

| Comando                                               | Qué hace                                                              |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| `pnpm dev`                                            | Compila `packages/*` y levanta web (3000) + api (3001) con hot reload |
| `pnpm dev:web` / `pnpm dev:api`                       | Solo uno de los dos                                                   |
| `apps\workers\.venv\Scripts\python -m studio_workers` | Workers FastAPI en :8001 (desde `apps\workers`)                       |
| `pnpm build`                                          | Build de todo (orden topológico)                                      |
| `pnpm typecheck`                                      | TypeScript estricto en todos los paquetes                             |
| `pnpm lint` / `pnpm lint:fix`                         | ESLint 9 (flat config)                                                |
| `pnpm format` / `pnpm format:check`                   | Prettier                                                              |
| `pnpm test`                                           | Vitest en todos los paquetes (uno por vez)                            |
| `pnpm --filter @studio/remotion studio`               | Remotion Studio para diseñar plantillas                               |
| `cd apps\workers; .venv\Scripts\python -m pytest`     | Tests de workers (también `ruff check .`)                             |

## Estructura

```
apps/
  web/              Next.js 15 + React 19 + Tailwind 4 (dashboard, UI en español)
  api/              Fastify 5 + SQLite (cola de trabajos, FFmpeg, orquestación)
  workers/          Python 3.11 FastAPI (faster-whisper, Piper TTS, RVC)
packages/
  shared/           Esquemas zod + tipos TS (contrato entre módulos)
  motion-engines/   Interfaz MotionEngine + registro + adaptadores
  remotion/         Composiciones Remotion 4 + render programático
scripts/windows/    setup.ps1, start.ps1, stop.ps1, doctor.ps1
scripts/library/    import-cc0.ps1 (packs de sonidos CC0 a storage/library)
docs/               PLAN-BASE, ARQUITECTURA, investigación (trabajo/)
storage/            (generado, ignorado por git) media, proxies, renders, exports, library
models/             (generado, ignorado por git) whisper, piper, rvc
```

## Configuración

Todo se configura en `.env` (ver `.env.example`, documentado línea por línea). **Nunca** subas tu
`.env` al repositorio. Las keys `ELEVENLABS_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`FREESOUND_API_KEY` y `PIXABAY_API_KEY` son opcionales: sin ellas todo funciona en local.

## Licencias

Solo se reutiliza código MIT/Apache/BSD/CC0; las fuentes se registran en `docs/trabajo/fuentes*.md`.
Remotion se usa bajo su licencia gratuita (uso personal / equipos pequeños); revisá
<https://www.remotion.dev/license> si tu caso es comercial.

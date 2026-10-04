#Requires -Version 5.1
<#
.SYNOPSIS
  Studio - levanta workers (8001), API (3001) y dashboard (3000) y abre el navegador (STUB).
.DESCRIPTION
  TODO(module-d): implementar. Este archivo solo documenta los pasos previstos.
.PARAMETER Dev
  Modo desarrollo (hot reload: next dev + tsx watch + uvicorn --reload) en lugar de builds de produccion.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\start.ps1
#>
[CmdletBinding()]
param(
  [switch]$Dev
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')

# --- 1. Verificaciones ----------------------------------------------------------------
# TODO(module-d): comprobar node, pnpm, ffmpeg, apps\workers\.venv; si falta algo -> sugerir setup.ps1.
# TODO(module-d): cargar puertos desde .env (WEB_PORT=3000, API_PORT=3001, WORKERS_PORT=8001);
#                 si un puerto esta ocupado, avisar y salir.

# --- 2. Workers Python (FastAPI :8001) -------------------------------------------------
# TODO(module-d): Start-Process apps\workers\.venv\Scripts\python.exe -ArgumentList '-m','studio_workers'
#                 -WorkingDirectory apps\workers  (redirigir logs a storage\logs\workers.log)

# --- 3. API Node (Fastify :3001) --------------------------------------------------------
# TODO(module-d): if ($Dev) { pnpm --filter @studio/api dev } else { pnpm --filter @studio/api start }
#                 (si falta apps\api\dist -> pnpm build primero)

# --- 4. Dashboard (Next.js :3000) -------------------------------------------------------
# TODO(module-d): if ($Dev) { pnpm --filter @studio/web dev } else { pnpm --filter @studio/web start }

# --- 5. Esperar salud y abrir navegador -------------------------------------------------
# TODO(module-d): sondear http://localhost:3001/api/health y http://localhost:3000 (timeout ~60 s)
# TODO(module-d): Start-Process 'http://localhost:3000'

# --- 6. Apagado limpio ------------------------------------------------------------------
# TODO(module-d): Ctrl+C detiene los 3 procesos (guardar PIDs y Stop-Process en finally).

Write-Host "start.ps1 es un esqueleto (TODO). Repo: $RepoRoot" -ForegroundColor Yellow

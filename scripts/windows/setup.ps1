#Requires -Version 5.1
<#
.SYNOPSIS
  Studio - instalacion desde cero en Windows 10/11 (STUB).
.DESCRIPTION
  Deja la PC lista para ejecutar start.ps1. Idempotente: se puede correr varias veces.
  TODO(module-d): implementar cada paso. Este archivo solo documenta los pasos previstos.
.PARAMETER Cuda
  Instala dependencias CUDA para faster-whisper/RVC (requiere GPU NVIDIA). Por defecto: CPU.
.PARAMETER SkipModels
  No descarga modelos (whisper/piper/rvc).
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\setup.ps1
  powershell -ExecutionPolicy Bypass -File scripts\windows\setup.ps1 -Cuda
#>
[CmdletBinding()]
param(
  [switch]$Cuda,
  [switch]$SkipModels
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')

# --- 1. Prerrequisitos del sistema (winget) -------------------------------------------
# TODO(module-d): verificar winget disponible (App Installer); si falta, explicar como instalarlo.
# TODO(module-d): winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements
# TODO(module-d): winget install --id OpenJS.NodeJS.22 -e   (Node 22 fijo; no "LTS" que puede saltar a 24)
# TODO(module-d): winget install --id Python.Python.3.11 -e --version 3.11.9
# TODO(module-d): winget install --id Gyan.FFmpeg -e   (o descargar build a tools\ffmpeg y setear FFMPEG_PATH)
# TODO(module-d): winget install --id Microsoft.VCRedist.2015+.x64 -e
# TODO(module-d): refrescar PATH de la sesion actual (leer Machine+User PATH del registro).

# --- 2. Toolchain JS ------------------------------------------------------------------
# TODO(module-d): npm install -g pnpm@12   (NO corepack: falla con pnpm 12)
# TODO(module-d): pnpm install --frozen-lockfile   (en $RepoRoot)

# --- 3. Entorno Python de workers -----------------------------------------------------
# TODO(module-d): py -3.11 -m venv apps\workers\.venv
# TODO(module-d): apps\workers\.venv\Scripts\python -m pip install --upgrade pip
# TODO(module-d): apps\workers\.venv\Scripts\pip install -r apps\workers\requirements.txt
# TODO(module-d): apps\workers\.venv\Scripts\pip install -e apps\workers --no-deps
# TODO(module-d): torch en dos perfiles (ver docs/trabajo/fuentes-audio.md):
#   CPU : pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
#   CUDA: pip install torch==2.7.1+cu128 ... --index-url https://download.pytorch.org/whl/cu128
#   Auto-deteccion con nvidia-smi si no se pasa -Cuda. Luego pip install infer-rvc-python==1.3.1
#   (requiere antes: pip install "pip>=24" "setuptools<=80.6.0").
# TODO(module-d): if ($Cuda) { wheels nvidia-cublas-cu12 / nvidia-cudnn-cu12 para faster-whisper; USE_CUDA=true }

# --- 4. Configuracion -----------------------------------------------------------------
# TODO(module-d): si no existe .env, copiar .env.example -> .env (NUNCA sobrescribir uno existente).
# TODO(module-d): si -Cuda, setear USE_CUDA=true en .env; si FFmpeg quedo en tools\, setear FFMPEG_PATH.
# TODO(module-d): crear storage\{media,proxies,renders,exports,library,tmp} y models\{whisper,piper,rvc}.

# --- 5. Modelos -----------------------------------------------------------------------
# TODO(module-d): if (-not $SkipModels) {
#   - faster-whisper: pre-descargar modelo WHISPER_MODEL (default "small") a models\whisper
#   - Piper: python -m piper.download_voices es_AR-daniela-high --data-dir models\piper
#            (alternativa: es_MX-claude-high)
#   - RVC: hubert_base.pt + rmvpe.pt (lj1995/VoiceConversionWebUI) a models\rvc\_base;
#          los modelos de voz (.pth/.index) los aporta el usuario en models\rvc\<nombre>\
#   - Remotion: npx remotion browser ensure (Chrome Headless Shell)
# }

# --- 6. Build inicial -----------------------------------------------------------------
# TODO(module-d): pnpm build   (shared, motion-engines, remotion, api, web)

Write-Host "setup.ps1 es un esqueleto (TODO). Repo: $RepoRoot" -ForegroundColor Yellow

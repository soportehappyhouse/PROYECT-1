#Requires -Version 5.1
<#
.SYNOPSIS
  Studio - instalacion desde cero en Windows 10/11 (x64). Idempotente: se puede repetir.
.DESCRIPTION
  1. Prerrequisitos con winget: Git, Node.js 22, Python 3.11, FFmpeg (Gyan, build full), VC++ 2015+.
  2. .env (copia de .env.example si falta; nunca lo sobrescribe) y carpetas storage\ y models\.
  3. pnpm 12 (npm i -g pnpm@12, sin Corepack) + pnpm install + navegador de Remotion.
  4. Python: apps\workers\.venv con requirements.txt (CPU) o requirements-cuda.txt (-WithCuda).
  5. Modelos: voz Piper por defecto, modelo Whisper, activos base de RVC (rmvpe + hubert).
  6. pnpm build (necesario para start.ps1 sin -Dev).
  Corre como usuario normal: winget pide UAC solo para los instaladores de maquina (Node, VC++).
.PARAMETER WithCuda
  Instala torch CUDA 12.8 (cu128) y pone USE_CUDA=true en .env. Requiere GPU NVIDIA + driver 570+.
.PARAMETER WhisperModel
  Modelo faster-whisper a descargar (default: base). En .env nuevo tambien fija WHISPER_MODEL.
.PARAMETER PiperVoice
  Voz Piper a descargar (default: PIPER_DEFAULT_VOICE de .env, es_AR-daniela-high).
.PARAMETER SkipWinget
  No usa winget: asume Git, Node.js 22, Python 3.11 y FFmpeg ya en el PATH (solo verifica).
.PARAMETER SkipRvc
  No instala torch / infer-rvc-python (instalacion mas liviana; RVC queda deshabilitado).
.PARAMETER SkipModels
  No descarga modelos (whisper / piper / rvc).
.PARAMETER SkipBrowser
  No descarga Chrome Headless Shell para Remotion.
.PARAMETER SkipBuild
  No ejecuta pnpm build.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\setup.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\setup.ps1 -WithCuda
#>
[CmdletBinding()]
param(
    [Alias('Cuda')][switch]$WithCuda,
    [string]$WhisperModel = 'base',
    [string]$PiperVoice = '',
    [switch]$SkipWinget,
    [switch]$SkipRvc,
    [switch]$SkipModels,
    [switch]$SkipBrowser,
    [switch]$SkipBuild,
    [switch]$IncludeLegacyHubert
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
Initialize-Console
$started = Get-Date

Write-Host "Studio - setup (repo: $RepoRoot)" -ForegroundColor White
if ($RepoRoot.Length -gt 60) {
    Write-Careful "La ruta del repo es larga ($($RepoRoot.Length) caracteres). Recomendado: C:\dev\studio"
}

# ============================================================================ 0. sanity checks
Write-Step 'Verificando el sistema'
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Se requiere Windows de 64 bits.' }
Write-Info ("Windows {0}, PowerShell {1}" -f [Environment]::OSVersion.Version, $PSVersionTable.PSVersion)
$hasWinget = Test-Cmd 'winget'
if ($SkipWinget) { Write-Info '-SkipWinget: se usan Git/Node/Python/FFmpeg del PATH (sin instalar nada)' }
if (-not $hasWinget -and -not $SkipWinget) {
    Write-Bad 'winget no esta disponible. Instala "App Installer" desde Microsoft Store y reintenta:'
    Write-Info 'https://apps.microsoft.com/detail/9NBLGGH4NNS1  (o usa -SkipWinget e instala a mano)'
}
if (Test-LongPaths) {
    Add-Result 'Rutas largas (Windows)' ok 'LongPathsEnabled=1'
} else {
    Add-Result 'Rutas largas (Windows)' warn 'desactivadas; ver docs/INSTALACION-WINDOWS.md'
    Write-Careful 'Rutas largas desactivadas. Como administrador (opcional, recomendado):'
    Write-Info "New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force"
}

# ============================================================================ 1. winget packages
function Install-WingetPackage {
    param([string]$Id, [string[]]$Extra = @())
    if (-not $hasWinget -or $SkipWinget) { return $false }
    $wingetArgs = @('install', '-e', '--id', $Id, '--silent', '--accept-package-agreements', '--accept-source-agreements') + $Extra
    Write-Info ("> winget {0}" -f ($wingetArgs -join ' '))
    $ErrorActionPreference = 'Continue'
    & winget @wingetArgs | Out-Host
    $code = $LASTEXITCODE
    Update-SessionPath
    # 0 = ok; -1978335189 (0x8A15002B) = already installed / no applicable upgrade.
    return ($code -eq 0 -or $code -eq -1978335189)
}

Write-Step 'Prerrequisitos del sistema (winget)'
Update-SessionPath

# --- Git
if (-not (Test-Cmd 'git')) {
    if (-not (Install-WingetPackage 'Git.Git' @('--scope', 'user'))) { [void](Install-WingetPackage 'Git.Git') }
}
$gitVer = Get-CmdOutput 'git' @('--version')
if ($gitVer) {
    Add-Result 'Git' ok $gitVer
    # Long paths inside git checkouts (node_modules nests deeply). --global needs no admin.
    & git config --global core.longpaths true 2>$null | Out-Null
} else { Add-Result 'Git' fail 'no encontrado (winget install -e --id Git.Git)' }

# --- Node.js 22 (pinned major; OpenJS.NodeJS.LTS may jump to 24/26)
$nodeVer = Get-CmdOutput 'node' @('--version')
if (-not $nodeVer) {
    Write-Info 'Instalando Node.js 22 (pedira permiso de administrador / UAC)...'
    [void](Install-WingetPackage 'OpenJS.NodeJS.22')
    $nodeVer = Get-CmdOutput 'node' @('--version')
}
if ($nodeVer -and $nodeVer.StartsWith('v22.')) {
    Add-Result 'Node.js 22' ok $nodeVer
} elseif ($nodeVer) {
    Add-Result 'Node.js 22' fail "encontrado $nodeVer; desinstalalo e instala OpenJS.NodeJS.22"
} else {
    Add-Result 'Node.js 22' fail 'no encontrado (winget install -e --id OpenJS.NodeJS.22)'
}

# --- Python 3.11
$py311 = Find-Python311
if (-not $py311) {
    if (-not (Install-WingetPackage 'Python.Python.3.11' @('--scope', 'user', '--version', '3.11.9'))) {
        [void](Install-WingetPackage 'Python.Python.3.11' @('--scope', 'user'))
    }
    $py311 = Find-Python311
}
if ($py311) { Add-Result 'Python 3.11' ok $py311 }
else { Add-Result 'Python 3.11' fail 'no encontrado (winget install -e --id Python.Python.3.11)' }

# --- FFmpeg (Gyan full build: rubberband, libass, nvenc/qsv/amf)
$ffmpeg = Find-FfmpegExe
if (-not $ffmpeg) {
    [void](Install-WingetPackage 'Gyan.FFmpeg')
    $ffmpeg = Find-FfmpegExe
}
if ($ffmpeg) { Add-Result 'FFmpeg' ok $ffmpeg }
else { Add-Result 'FFmpeg' fail 'no encontrado (winget install -e --id Gyan.FFmpeg)' }

# --- Visual C++ 2015-2022 x64 runtime (torch, onnxruntime, ctranslate2)
$vc = Test-VCRedist
if (-not $vc) {
    Write-Info 'Instalando Visual C++ Redistributable x64 (UAC)...'
    [void](Install-WingetPackage 'Microsoft.VCRedist.2015+.x64')
    $vc = Test-VCRedist
}
if ($vc) { Add-Result 'VC++ Redistributable x64' ok $vc }
else { Add-Result 'VC++ Redistributable x64' warn 'no detectado (winget install -e --id Microsoft.VCRedist.2015+.x64)' }

# ============================================================================ 2. config + folders
Write-Step 'Configuracion (.env) y carpetas'
$envCreated = $false
if (-not (Test-Path $EnvFile)) {
    Copy-Item $EnvExample $EnvFile
    $envCreated = $true
    Write-Good '.env creado desde .env.example (completa las API keys opcionales si queres)'
} else {
    Write-Info '.env ya existe: no se modifica salvo los valores de este setup'
}
if ($envCreated) { Set-DotEnvValue 'WHISPER_MODEL' $WhisperModel }
if ($WithCuda) { Set-DotEnvValue 'USE_CUDA' 'true' }
if ($ffmpeg -and -not (Test-Cmd 'ffmpeg')) {
    # winget portable package not on PATH yet: pin absolute paths so api/workers find it.
    Set-DotEnvValue 'FFMPEG_PATH' $ffmpeg
    Set-DotEnvValue 'FFPROBE_PATH' (Join-Path (Split-Path $ffmpeg) 'ffprobe.exe')
    Write-Info "FFMPEG_PATH fijado en .env: $ffmpeg"
}
$storage = Get-StorageDir
$models = Get-ModelsDir
foreach ($d in @('media', 'proxies', 'renders', 'exports', 'library', 'tmp', 'logs', 'run')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $storage $d) | Out-Null
}
foreach ($d in @('whisper', 'piper', 'rvc\_base')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $models $d) | Out-Null
}
Add-Result '.env + carpetas' ok ("storage={0}  models={1}" -f $storage, $models)

# ============================================================================ 3. JS toolchain
Write-Step 'pnpm 12 + dependencias JS'
$pnpmOk = $false
if ($nodeVer) {
    try {
        $pnpmVer = Get-CmdOutput 'pnpm' @('--version')
        if (-not $pnpmVer -or -not $pnpmVer.StartsWith('12.')) {
            # Not Corepack: it cannot run pnpm 12 (native binary). Installs into %APPDATA%\npm (no admin).
            Invoke-Native 'npm' @('install', '-g', 'pnpm@12')
            Update-SessionPath
            $pnpmVer = Get-CmdOutput 'pnpm' @('--version')
        }
        if ($pnpmVer -and $pnpmVer.StartsWith('12.')) {
            Add-Result 'pnpm 12' ok $pnpmVer
            Invoke-Native 'pnpm' @('install')
            Add-Result 'Dependencias JS (pnpm install)' ok ''
            $pnpmOk = $true
        } else {
            Add-Result 'pnpm 12' fail "version: $pnpmVer"
        }
    } catch {
        Add-Result 'Dependencias JS (pnpm install)' fail $_.Exception.Message
    }
    if ($pnpmOk -and $SkipBrowser) {
        Add-Result 'Remotion (Chrome Headless Shell)' skip '-SkipBrowser'
    } elseif ($pnpmOk) {
        try {
            # Chrome Headless Shell for Remotion renders, run from the repo root: pnpm executes the
            # script inside packages\remotion, so it lands in packages\remotion\node_modules\.remotion
            # (one of the folders packages/remotion/src/browser.ts searches).
            Invoke-Native 'pnpm' @('--filter', '@studio/remotion', 'browser:ensure') $RepoRoot
            Add-Result 'Remotion (Chrome Headless Shell)' ok ''
        } catch {
            Add-Result 'Remotion (Chrome Headless Shell)' fail ("{0} - reintenta setup.ps1" -f $_.Exception.Message)
        }
    }
} else {
    Add-Result 'pnpm 12' skip 'requiere Node.js 22'
}

# ============================================================================ 4. Python workers
Write-Step 'Entorno Python de los workers (apps\workers\.venv)'
$venvOk = $false
$hasGpu = Test-Cmd 'nvidia-smi'
if ($WithCuda -and -not $hasGpu) { Write-Careful '-WithCuda sin nvidia-smi: se instala igual; sin GPU caera a CPU.' }
if (-not $WithCuda -and $hasGpu) { Write-Careful 'GPU NVIDIA detectada: podes re-ejecutar con -WithCuda para acelerar Whisper/RVC.' }
if ($py311) {
    try {
        $venvVer = $null
        if (Test-Path $VenvPython) {
            $venvVer = Get-CmdOutput $VenvPython @('-c', $PyVersionCode)
        }
        if ($venvVer -ne '3.11') {
            if (Test-Path (Join-Path $WorkersDir '.venv')) { Remove-Item -Recurse -Force (Join-Path $WorkersDir '.venv') }
            Invoke-Native $py311 @('-m', 'venv', '.venv') $WorkersDir
        }
        # Never Activate.ps1 (blocked by execution policy): always call .venv\Scripts\python.exe.
        Invoke-Native $VenvPython @('-m', 'pip', 'install', '--upgrade', 'pip>=24', 'setuptools<=80.6.0', 'wheel') $WorkersDir
        $profileName = 'cpu'
        if ($WithCuda) { $profileName = 'cuda' }
        if ($SkipRvc) { $profileName = "$profileName-norvc" }
        $reqFile = 'requirements.txt'
        if ($WithCuda) { $reqFile = 'requirements-cuda.txt' }
        $hash = (Get-FileHash (Join-Path $WorkersDir $reqFile) -Algorithm SHA256).Hash
        $stamp = Join-Path $WorkersDir '.venv\.studio-install'
        $wanted = "$profileName $hash"
        $current = ''
        if (Test-Path $stamp) { $current = (Get-Content $stamp -Raw).Trim() }
        if ($current -ne $wanted) {
            if ($SkipRvc) {
                Invoke-Native $VenvPython @('-m', 'pip', 'install', '-e', '.[whisper,tts]') $WorkersDir
            } else {
                Invoke-Native $VenvPython @('-m', 'pip', 'install', '-r', $reqFile) $WorkersDir
                Invoke-Native $VenvPython @('-m', 'pip', 'install', '-e', '.', '--no-deps') $WorkersDir
            }
            Set-Content -Path $stamp -Value $wanted -Encoding ASCII
        } else {
            Write-Info "Dependencias Python ya instaladas ($profileName); se omite pip install"
        }
        $check = Get-CmdOutput $VenvPython @('-c', 'import faster_whisper, piper, studio_workers; print(1)')
        if ($check -eq '1') {
            Add-Result 'Workers Python (.venv)' ok "perfil $profileName"
            $venvOk = $true
        } else {
            Add-Result 'Workers Python (.venv)' fail 'import faster_whisper/piper fallo'
        }
        if (-not $SkipRvc) {
            $torch = Get-CmdOutput $VenvPython @('-c', 'import torch; print(torch.__version__, torch.cuda.is_available())')
            if ($torch) {
                $state = 'ok'
                if ($WithCuda -and $torch -notmatch 'True$') { $state = 'warn' }
                Add-Result 'torch (RVC)' $state $torch
            } else {
                Add-Result 'torch (RVC)' fail 'import torch fallo (VC++ Redistributable?)'
            }
        } else {
            Add-Result 'torch (RVC)' skip '-SkipRvc'
        }
    } catch {
        Add-Result 'Workers Python (.venv)' fail $_.Exception.Message
    }
} else {
    Add-Result 'Workers Python (.venv)' skip 'requiere Python 3.11'
}

# ============================================================================ 5. models
Write-Step 'Modelos (Piper, Whisper, RVC base)'
if ($SkipModels) {
    Add-Result 'Modelos' skip '-SkipModels'
} elseif (-not $venvOk) {
    Add-Result 'Modelos' skip 'requiere el .venv de workers'
} else {
    if (-not $PiperVoice) { $PiperVoice = Get-EnvSetting 'PIPER_DEFAULT_VOICE' 'es_AR-daniela-high' }
    $whisperList = @($WhisperModel)
    $envWhisper = Get-EnvSetting 'WHISPER_MODEL' $WhisperModel
    if ($envWhisper -ne $WhisperModel) { $whisperList += $envWhisper }
    $cliArgs = @('-m', 'studio_workers.models_cli', '--piper', $PiperVoice, '--whisper') + $whisperList
    if (-not $SkipRvc) { $cliArgs += '--rvc-base' }
    if ($IncludeLegacyHubert) { $cliArgs += '--rvc-legacy-hubert' }
    try {
        Invoke-Native $VenvPython $cliArgs $WorkersDir
        Add-Result 'Voz Piper' ok $PiperVoice
        Add-Result 'Whisper' ok ($whisperList -join ', ')
        if (-not $SkipRvc) { Add-Result 'RVC base (rmvpe + hubert)' ok 'models\rvc\_base' }
    } catch {
        Add-Result 'Modelos' fail ("{0} - reintenta setup.ps1 (las descargas se reanudan)" -f $_.Exception.Message)
    }
}

# ============================================================================ 6. build
Write-Step 'Build (pnpm build)'
if ($SkipBuild) {
    Add-Result 'Build' skip '-SkipBuild (usa start.ps1 -Dev)'
} elseif (-not $pnpmOk) {
    Add-Result 'Build' skip 'requiere pnpm install'
} else {
    try {
        # NEXT_PUBLIC_API_URL / API_PORT from .env reach next.config.ts (inlined into the web build).
        Import-DotEnvToProcess
        Invoke-Native 'pnpm' @('build')
        Add-Result 'Build' ok 'pnpm build'
    } catch {
        Add-Result 'Build' fail ("{0} (podes usar start.ps1 -Dev)" -f $_.Exception.Message)
    }
}

# ============================================================================ 7. final check
# Required assets must exist after the run (not only "the step did not throw").
Write-Step 'Verificacion final (voz Piper, Whisper, navegador de Remotion)'
$missingAssets = @()
if (-not $SkipModels) {
    $voice = $PiperVoice
    if (-not $voice) { $voice = Get-EnvSetting 'PIPER_DEFAULT_VOICE' 'es_AR-daniela-high' }
    $piperDir = Join-Path $models 'piper'
    if (-not ((Test-Path (Join-Path $piperDir "$voice.onnx")) -and (Test-Path (Join-Path $piperDir "$voice.onnx.json")))) {
        $missingAssets += "voz Piper $voice (models\piper)"
    }
    $wModel = Get-EnvSetting 'WHISPER_MODEL' $WhisperModel
    $wHit = Get-ChildItem -Path (Join-Path $models 'whisper') -Filter 'model.bin' -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match ('models--[^\\]+--faster-whisper-' + [regex]::Escape($wModel) + '\\snapshots\\') } |
        Select-Object -First 1
    if (-not $wHit) { $missingAssets += "modelo Whisper $wModel (models\whisper)" }
}
if (-not $SkipBrowser) {
    $browserExe = Get-EnvSetting 'REMOTION_BROWSER_EXECUTABLE' ''
    $browserOk = $false
    if ($browserExe) {
        $browserOk = Test-Path (Resolve-RepoPath $browserExe)
    } else {
        $rel = 'node_modules\.remotion\chrome-headless-shell\win64\chrome-headless-shell-win64\chrome-headless-shell.exe'
        foreach ($root in @('packages\remotion', '.', 'apps\api')) {
            if (Test-Path (Join-Path (Join-Path $RepoRoot $root) $rel)) { $browserOk = $true }
        }
    }
    if (-not $browserOk) { $missingAssets += 'Chrome Headless Shell de Remotion (pnpm --filter @studio/remotion browser:ensure)' }
}
if ($missingAssets.Count -gt 0) {
    foreach ($m in $missingAssets) { Add-Result 'Falta' fail $m }
} else {
    Write-Good 'Activos requeridos presentes'
}

# ============================================================================ summary
$mins = [math]::Round(((Get-Date) - $started).TotalMinutes, 1)
Show-Results "Resumen de instalacion ($mins min)"
$failed = Get-FailedCount
if ($failed -eq 0) {
    Write-Host ''
    Write-Host 'Listo. Para abrir Studio:' -ForegroundColor Green
    Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\start.ps1'
    Write-Host 'Si Windows pregunta por el Firewall: todo escucha en 127.0.0.1; elegi "Cancelar" o solo "Redes privadas".'
    exit 0
}
Write-Host ''
Write-Host "$failed componente(s) con error. Diagnostico: scripts\windows\doctor.ps1" -ForegroundColor Red
foreach ($m in $missingAssets) { Write-Host "  FALTA: $m" -ForegroundColor Red }
Write-Host 'Si se instalo algo nuevo con winget, cerra y abri una terminal nueva y volve a correr setup.ps1.'
exit 1

#Requires -Version 5.1
<#
.SYNOPSIS
  Studio - instalacion en Windows 10/11 (x64). Incremental: reconoce lo ya instalado/descargado y
  solo hace lo que falta. Desde cero tarda lo que tarde (descargas grandes); repetirlo es rapido.
.DESCRIPTION
  1. Prerrequisitos con winget: Git, Node.js 22, Python 3.11, FFmpeg (Gyan, build full), VC++ 2015+.
     Si ya estan y la version alcanza: "ya instalado, se omite".
  2. .env (copia de .env.example si falta; nunca lo sobrescribe) y carpetas storage\ y models\.
  3. pnpm 12 + pnpm install (se omite si pnpm-lock.yaml y los package.json no cambiaron)
     + navegador de Remotion (se omite si ya esta).
  4. Python: apps\workers\.venv con requirements.txt (CPU) o requirements-cuda.txt (-WithCuda); se
     omite si el sello .venv\.studio-install coincide con el hash de requirements/pyproject.
  5. Modelos: models_cli --check muestra la tabla presentes/faltantes y despues se baja solo lo que
     falta (descargas reanudables, verificadas, registradas en models\manifest.json). RVC base
     (hubert + rmvpe) solo con -Full; si no, se pide al usar RVC (paquete rvc-base).
  5b. Entorno aislado GPL apps\workers\.venv-gpl (recorte de personas RVM, licencia GPL-3): solo
     con -Full o si ya existe (se actualiza si cambio vision_gpl\requirements.txt). Sin -Full lo
     crean los workers al descargar el paquete "matting" desde Ajustes (python -m venv + pip).
     Reutiliza el torch del .venv principal (no baja otra copia de ~2.5 GB).
  6. Paquetes de IA (models\packs.json): por defecto solo "core" (Whisper base + voz Daniela);
     con -Full todos en secuencia (whisper-turbo, voces-es, rvc-base, scenes, voz-limpia, matting,
     matting-image, sam2, reframe). Lo que ya esta se omite; el resto se baja bajo demanda desde
     Ajustes > Paquetes de IA.
  7. pnpm build (se omite si el build coincide con el hash del codigo y de .env).
  Al final: tabla con segundos por paso, "N pasos omitidos, M ejecutados" y el tiempo total
  (tambien en storage\run\setup-last.json).
  Corre como usuario normal: winget pide UAC solo para los instaladores de maquina (Node, VC++).
.PARAMETER Update
  Actualizacion tras bajar una version nueva (ZIP descomprimido encima de la misma carpeta o git
  pull). No toca git: corre todo en modo incremental, revisa tambien los modelos registrados en
  models\manifest.json y conserva el perfil anterior (CUDA / sin RVC).
.PARAMETER Force
  Ignora los sellos: rehace pnpm install, pip install, el build y vuelve a descargar los modelos.
.PARAMETER Full
  Descarga TODOS los paquetes de IA en secuencia (~4,1 GB: Whisper large-v3-turbo, 7 voces Piper,
  RVC base, PySceneDetect, DeepFilterNet, RVM + .venv-gpl, BiRefNet-lite, SAM 2.1, YuNet). Sin
  -Full solo se instala "core" y el resto se pide al usar cada funcion. Se puede repetir: lo ya
  descargado se omite y lo parcial se reanuda.
.PARAMETER WithCuda
  Instala torch CUDA 12.8 (cu128) y pone USE_CUDA=true en .env. Requiere GPU NVIDIA + driver 570+.
  No hace falta: si se detecta una GPU NVIDIA (nvidia-smi o el nombre del adaptador de video) CUDA
  se activa solo, tambien en -Update de una instalacion que estaba en CPU (una vez, ~2.5 GB).
  Una vez instalado se conserva en los re-run.
.PARAMETER NoCuda
  Fuerza el perfil CPU aunque haya GPU NVIDIA (USE_CUDA=false en .env). Igual que -WithCuda:$false.
  La eleccion queda registrada: los re-run siguientes no vuelven a cambiar a CUDA.
.PARAMETER WhisperModel
  Modelo faster-whisper a descargar (default: base). En .env nuevo tambien fija WHISPER_MODEL.
.PARAMETER PiperVoice
  Voz Piper a descargar (default: PIPER_DEFAULT_VOICE de .env, es_AR-daniela-high).
.PARAMETER SkipWinget
  No usa winget: asume Git, Node.js 22, Python 3.11 y FFmpeg ya en el PATH (solo verifica).
.PARAMETER SkipRvc
  Sin dependencias de RVC en el .venv (torch / infer-rvc-python; instalacion mas liviana, RVC queda
  deshabilitado). Se conserva en los re-run; -SkipRvc:$false instala RVC. Los modelos RVC base
  (paquete rvc-base) nunca se bajan por defecto: solo con -Full o al usar RVC.
.PARAMETER SkipOllama
  No instala ni inicia Ollama (winget Ollama.Ollama): el Asistente local (paquete agent-llm) queda
  deshabilitado. El modelo (qwen3:8b, ~5 GB) no se baja aca: se descarga desde Ajustes o con -Full.
.PARAMETER SkipModels
  No descarga modelos (whisper / piper / rvc).
.PARAMETER SkipBrowser
  No descarga Chrome Headless Shell para Remotion.
.PARAMETER SkipBuild
  No ejecuta pnpm build.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\setup.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\setup.ps1 -Update
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\setup.ps1 -WithCuda
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\setup.ps1 -WithCuda -Full
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\setup.ps1 -NoCuda
#>
[CmdletBinding()]
param(
    [Alias('Cuda')][switch]$WithCuda,
    [switch]$NoCuda,
    [string]$WhisperModel = 'base',
    [string]$PiperVoice = '',
    [switch]$Update,
    [switch]$Full,
    [switch]$Force,
    [switch]$SkipWinget,
    [switch]$SkipRvc,
    [switch]$SkipOllama,
    [switch]$SkipModels,
    [switch]$SkipBrowser,
    [switch]$SkipBuild,
    [switch]$IncludeLegacyHubert
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
Initialize-Console
# models_cli prints a check mark: Python stdio in UTF-8, decoded as UTF-8 by Initialize-Console.
$env:PYTHONIOENCODING = 'utf-8'
$started = Get-Date

# Minimum versions: an installed tool at or above them is kept ("ya instalado, se omite").
$MinGit = '2.40.0'
$MinNode = '22.12.0'   # package.json engines: >=22.12.0 <23

$modeLabel = 'instalacion'
if ($Update) { $modeLabel = 'actualizacion' }
Write-Host "Studio - setup, modo $modeLabel (repo: $RepoRoot)" -ForegroundColor White
if ($Update) {
    Write-Info 'Modo -Update: no se baja nada de git; se reutiliza todo lo ya instalado y se completa lo que falta.'
    Write-Info 'Se conservan .env, storage\ y models\ (ver "Actualizar" en docs\INSTALACION-WINDOWS.md).'
}
if ($Force) { Write-Careful '-Force: se ignoran los sellos de instalacion (se rehace todo lo rehacible).' }
if ($RepoRoot.Length -gt 60) {
    Write-Careful "La ruta del repo es larga ($($RepoRoot.Length) caracteres). Recomendado: C:\dev\studio"
}

# Previous Python profile (cuda / norvc) is kept unless the switch is passed explicitly: a re-run
# without -NoCuda must not silently swap a 2.5 GB CUDA torch for the CPU one.
$venvStamp = Join-Path $WorkersDir '.venv\.studio-install'
$prevProfile = ((Read-Stamp $venvStamp) -split '\s+')[0]
# CUDA: -NoCuda / -WithCuda win; else a previous -NoCuda (stamp line "cuda-choice nocuda") keeps
# CPU; else a previous CUDA profile stays; else an NVIDIA GPU switches to CUDA automatically, also on
# re-runs / -Update of an install that was on the CPU profile (once: the stamp records the result).
$gpuName = Get-NvidiaGpuName
$prevChoice = ''
foreach ($l in ((Read-Stamp $venvStamp) -split "`r?`n")) {
    if ($l -match '^\s*cuda-choice\s+(\S+)') { $prevChoice = $Matches[1] }
}
$cudaExplicit = $NoCuda -or $PSBoundParameters.ContainsKey('WithCuda')
$cudaSwitch = $false
if ($NoCuda) {
    $WithCuda = [switch]$false
    $cudaReason = '-NoCuda'
} elseif ($PSBoundParameters.ContainsKey('WithCuda')) {
    $cudaReason = '-WithCuda'
    if (-not $WithCuda) { $cudaReason = '-WithCuda:$false' }
} elseif ($prevChoice -eq 'nocuda') {
    $WithCuda = [switch]$false
    $cudaReason = 'elegiste -NoCuda en una instalacion anterior (-WithCuda para cambiarlo)'
} elseif ($prevProfile -like 'cuda*') {
    $WithCuda = [switch]$true
    $cudaReason = 'perfil CUDA de la instalacion anterior (-NoCuda para volver a CPU)'
} elseif ($gpuName) {
    $WithCuda = [switch]$true
    $cudaReason = "GPU NVIDIA detectada: $gpuName"
    if ($prevProfile) {
        $cudaSwitch = $true
        Write-Careful 'GPU NVIDIA detectada: cambiando a CUDA (descarga ~2.5 GB, una sola vez)'
        Write-Info 'Para quedarte en CPU: setup.ps1 -Update -NoCuda'
    }
} else {
    $cudaReason = 'no se detecto GPU NVIDIA'
}
# Recorded in the venv stamp (line 3) so the choice is not re-made on every run.
$cudaChoice = 'cpu'
if ($WithCuda) { $cudaChoice = 'cuda' }
if (-not $WithCuda -and ($NoCuda -or $cudaExplicit -or $prevChoice -eq 'nocuda')) { $cudaChoice = 'nocuda' }
$cudaMode = 'CPU'
if ($WithCuda) { $cudaMode = 'CUDA (GPU)' }
Write-Info "Aceleracion IA: $cudaMode - $cudaReason"
if (-not $PSBoundParameters.ContainsKey('SkipRvc') -and $prevProfile -like '*-norvc') {
    $SkipRvc = [switch]$true
    Write-Info 'Se conserva la instalacion sin RVC de la vez anterior (-SkipRvc:$false para instalar RVC).'
}

# ============================================================================ 0. sanity checks
Write-Step 'Verificando el sistema'
Start-StepClock
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Se requiere Windows de 64 bits.' }
Write-Info ("Windows {0}, PowerShell {1}" -f [Environment]::OSVersion.Version, $PSVersionTable.PSVersion)
$hasWinget = Test-Cmd 'winget'
if ($SkipWinget) { Write-Info '-SkipWinget: se usan Git/Node/Python/FFmpeg del PATH (sin instalar nada)' }
if (-not $hasWinget -and -not $SkipWinget) {
    Write-Bad 'winget no esta disponible. Instala "App Installer" desde Microsoft Store y reintenta:'
    Write-Info 'https://apps.microsoft.com/detail/9NBLGGH4NNS1  (o usa -SkipWinget e instala a mano)'
}
if (Test-LongPaths) {
    Add-Result 'Rutas largas (Windows)' ok 'LongPathsEnabled=1' -Seconds (Stop-StepClock)
} else {
    Add-Result 'Rutas largas (Windows)' warn 'desactivadas; ver docs/INSTALACION-WINDOWS.md' -Seconds (Stop-StepClock)
    Write-Careful 'Rutas largas desactivadas. Como administrador (opcional, recomendado):'
    Write-Info "New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force"
}

# ============================================================================ 1. winget packages
function Install-WingetPackage {
    param([string]$Id, [string[]]$Extra = @(), [switch]$Upgrade)
    if (-not $hasWinget -or $SkipWinget) { return $false }
    $verb = 'install'
    if ($Upgrade) { $verb = 'upgrade' }
    $wingetArgs = @($verb, '-e', '--id', $Id, '--silent', '--accept-package-agreements', '--accept-source-agreements') + $Extra
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
Start-StepClock
$gitAction = 'omitido'
$gitVer = Get-CmdOutput 'git' @('--version')
if (-not $gitVer) {
    $gitAction = ''
    if (Install-WingetPackage 'Git.Git' @('--scope', 'user')) { $gitAction = 'ejecutado' }
    elseif (Install-WingetPackage 'Git.Git') { $gitAction = 'ejecutado' }
    $gitVer = Get-CmdOutput 'git' @('--version')
} elseif (-not (Test-VersionAtLeast $gitVer $MinGit)) {
    Write-Info "$gitVer es anterior a $MinGit`: actualizando"
    $gitAction = ''
    if (Install-WingetPackage 'Git.Git' -Upgrade) { $gitAction = 'ejecutado' }
    $gitVer = Get-CmdOutput 'git' @('--version')
} else {
    Write-Omit $gitVer
}
if ($gitVer) {
    # Long paths inside git checkouts (node_modules nests deeply). --global needs no admin.
    & git config --global core.longpaths true 2>$null | Out-Null
    Add-Result 'Git' ok $gitVer -Action $gitAction -Seconds (Stop-StepClock)
} else { Add-Result 'Git' fail 'no encontrado (winget install -e --id Git.Git)' -Seconds (Stop-StepClock) }

# --- Node.js 22 (pinned major; OpenJS.NodeJS.LTS may jump to 24/26)
Start-StepClock
$nodeAction = 'omitido'
$nodeVer = Get-CmdOutput 'node' @('--version')
if (-not $nodeVer) {
    Write-Info 'Instalando Node.js 22 (pedira permiso de administrador / UAC)...'
    $nodeAction = ''
    if (Install-WingetPackage 'OpenJS.NodeJS.22') { $nodeAction = 'ejecutado' }
    $nodeVer = Get-CmdOutput 'node' @('--version')
} elseif ($nodeVer.StartsWith('v22.') -and -not (Test-VersionAtLeast $nodeVer $MinNode)) {
    Write-Info "Node.js $nodeVer es anterior a $MinNode`: actualizando (UAC)..."
    $nodeAction = ''
    if (Install-WingetPackage 'OpenJS.NodeJS.22' -Upgrade) { $nodeAction = 'ejecutado' }
    $nodeVer = Get-CmdOutput 'node' @('--version')
} elseif ($nodeVer.StartsWith('v22.')) {
    Write-Omit "Node.js $nodeVer"
}
if ($nodeVer -and $nodeVer.StartsWith('v22.')) {
    $state = 'ok'
    if (-not (Test-VersionAtLeast $nodeVer $MinNode)) { $state = 'warn' }
    Add-Result 'Node.js 22' $state $nodeVer -Action $nodeAction -Seconds (Stop-StepClock)
} elseif ($nodeVer) {
    Add-Result 'Node.js 22' fail "encontrado $nodeVer; desinstalalo e instala OpenJS.NodeJS.22" -Seconds (Stop-StepClock)
} else {
    Add-Result 'Node.js 22' fail 'no encontrado (winget install -e --id OpenJS.NodeJS.22)' -Seconds (Stop-StepClock)
}

# --- Python 3.11
Start-StepClock
$pyAction = 'omitido'
$py311 = Find-Python311
if (-not $py311) {
    $pyAction = ''
    if (Install-WingetPackage 'Python.Python.3.11' @('--scope', 'user', '--version', '3.11.9')) { $pyAction = 'ejecutado' }
    elseif (Install-WingetPackage 'Python.Python.3.11' @('--scope', 'user')) { $pyAction = 'ejecutado' }
    $py311 = Find-Python311
}
if ($py311) {
    $pyVer = Get-CmdOutput $py311 @('--version')
    if ($pyAction -eq 'omitido') { Write-Omit "$pyVer ($py311)" }
    Add-Result 'Python 3.11' ok "$pyVer  $py311" -Action $pyAction -Seconds (Stop-StepClock)
} else { Add-Result 'Python 3.11' fail 'no encontrado (winget install -e --id Python.Python.3.11)' -Seconds (Stop-StepClock) }

# --- FFmpeg (Gyan full build: rubberband, libass, nvenc/qsv/amf)
Start-StepClock
$ffAction = 'omitido'
$ffmpeg = Find-FfmpegExe
if (-not $ffmpeg) {
    $ffAction = ''
    if (Install-WingetPackage 'Gyan.FFmpeg') { $ffAction = 'ejecutado' }
    $ffmpeg = Find-FfmpegExe
}
if ($ffmpeg) {
    $ffVer = Get-CmdOutput $ffmpeg @('-hide_banner', '-version')
    if ($ffVer) { $ffVer = (($ffVer -split '\s+') | Select-Object -First 3) -join ' ' }
    if ($ffAction -eq 'omitido') { Write-Omit "$ffVer" }
    Add-Result 'FFmpeg' ok "$ffVer  $ffmpeg" -Action $ffAction -Seconds (Stop-StepClock)
} else { Add-Result 'FFmpeg' fail 'no encontrado (winget install -e --id Gyan.FFmpeg)' -Seconds (Stop-StepClock) }

# --- Visual C++ 2015-2022 x64 runtime (torch, onnxruntime, ctranslate2)
Start-StepClock
$vcAction = 'omitido'
$vc = Test-VCRedist
if (-not $vc) {
    Write-Info 'Instalando Visual C++ Redistributable x64 (UAC)...'
    $vcAction = ''
    if (Install-WingetPackage 'Microsoft.VCRedist.2015+.x64') { $vcAction = 'ejecutado' }
    $vc = Test-VCRedist
} else {
    Write-Omit "VC++ Redistributable $vc"
}
if ($vc) { Add-Result 'VC++ Redistributable x64' ok $vc -Action $vcAction -Seconds (Stop-StepClock) }
else { Add-Result 'VC++ Redistributable x64' warn 'no detectado (winget install -e --id Microsoft.VCRedist.2015+.x64)' -Seconds (Stop-StepClock) }

# --- Ollama (sprint 3: Asistente local; MIT). Optional: a failure here is a warning, not an error.
Start-StepClock
if ($SkipOllama) {
    Add-Result 'Ollama' skip '-SkipOllama (Asistente local deshabilitado)' -Seconds (Stop-StepClock)
} else {
    $ollamaAction = 'omitido'
    $ollamaExe = Find-OllamaExe
    if (-not $ollamaExe) {
        Write-Info 'Instalando Ollama (servicio local para el Asistente; ~1 GB)...'
        $ollamaAction = ''
        if (Install-WingetPackage 'Ollama.Ollama') { $ollamaAction = 'ejecutado' }
        $ollamaExe = Find-OllamaExe
    }
    if ($ollamaExe) {
        $ollamaVer = Get-OllamaVersion
        if (-not $ollamaVer) {
            Write-Info 'Iniciando el servicio de Ollama...'
            if (Start-OllamaService $ollamaExe) {
                $ollamaVer = Get-OllamaVersion
                if ($ollamaAction -eq 'omitido') { $ollamaAction = 'ejecutado' }
            }
        } elseif ($ollamaAction -eq 'omitido') {
            Write-Omit "Ollama $ollamaVer (servicio corriendo)"
        }
        if ($ollamaVer) {
            $models = @(Get-OllamaTags)
            $modelText = 'sin modelos (descarga el Asistente local en Ajustes)'
            if ($models.Count) { $modelText = 'modelos: ' + ($models -join ', ') }
            Add-Result 'Ollama' ok ("{0} - {1}" -f $ollamaVer, $modelText) -Action $ollamaAction -Seconds (Stop-StepClock)
        } else {
            Add-Result 'Ollama' warn ("instalado ({0}) pero el servicio no responde en {1}: abri Ollama desde el menu Inicio" -f $ollamaExe, (Get-OllamaUrl)) -Action $ollamaAction -Seconds (Stop-StepClock)
        }
    } else {
        Add-Result 'Ollama' warn 'no instalado (winget install -e --id Ollama.Ollama); el Asistente local queda deshabilitado' -Seconds (Stop-StepClock)
    }
}

# ============================================================================ 2. config + folders
Write-Step 'Configuracion (.env) y carpetas'
Start-StepClock
$cfgAction = 'omitido'
$envCreated = $false
if (-not (Test-Path $EnvFile)) {
    Copy-Item $EnvExample $EnvFile
    $envCreated = $true
    $cfgAction = 'ejecutado'
    Write-Good '.env creado desde .env.example (completa las API keys opcionales si queres)'
    if ($Update) { Write-Careful 'No habia .env: si tenias uno de la version anterior, copialo encima de este.' }
} else {
    Write-Info '.env ya existe: no se modifica salvo los valores de este setup'
}
if ($envCreated) { Set-DotEnvValue 'WHISPER_MODEL' $WhisperModel }
# USE_CUDA (only that key is edited): written on the first setup (new .env), when -WithCuda/-NoCuda
# is passed, or when a re-run switches a CPU install to CUDA because a GPU was detected. Otherwise a
# re-run (-Update) keeps the value the user left in .env.
$cudaValue = 'false'
if ($WithCuda) { $cudaValue = 'true' }
if (($envCreated -or $cudaExplicit -or $cudaSwitch) -and (Get-EnvSetting 'USE_CUDA' '') -ne $cudaValue) {
    Set-DotEnvValue 'USE_CUDA' $cudaValue
    Write-Info "USE_CUDA=$cudaValue en .env"
}
if ($ffmpeg -and -not (Test-Cmd 'ffmpeg') -and (Get-EnvSetting 'FFMPEG_PATH' '') -ne $ffmpeg) {
    # winget portable package not on PATH yet: pin absolute paths so api/workers find it.
    Set-DotEnvValue 'FFMPEG_PATH' $ffmpeg
    Set-DotEnvValue 'FFPROBE_PATH' (Join-Path (Split-Path $ffmpeg) 'ffprobe.exe')
    Write-Info "FFMPEG_PATH fijado en .env: $ffmpeg"
}
$storage = Get-StorageDir
$models = Get-ModelsDir
$dirs = @()
foreach ($d in @('media', 'proxies', 'renders', 'exports', 'library', 'tmp', 'logs', 'run')) { $dirs += (Join-Path $storage $d) }
foreach ($d in @('whisper', 'piper', 'rvc\_base')) { $dirs += (Join-Path $models $d) }
foreach ($d in $dirs) {
    if (-not (Test-Path $d)) {
        New-Item -ItemType Directory -Force -Path $d | Out-Null
        $cfgAction = 'ejecutado'
    }
}
if ($cfgAction -eq 'omitido') { Write-Omit '.env y carpetas storage\ / models\' }
Add-Result '.env + carpetas' ok ("storage={0}  models={1}" -f $storage, $models) -Action $cfgAction -Seconds (Stop-StepClock)

# ============================================================================ 3. JS toolchain
Write-Step 'pnpm 12 + dependencias JS'
$pnpmOk = $false
if ($nodeVer) {
    Start-StepClock
    try {
        $pnpmAction = 'omitido'
        $pnpmVer = Get-CmdOutput 'pnpm' @('--version')
        if (-not $pnpmVer -or -not $pnpmVer.StartsWith('12.')) {
            # Not Corepack: it cannot run pnpm 12 (native binary). Installs into %APPDATA%\npm (no admin).
            Invoke-Native 'npm' @('install', '-g', 'pnpm@12')
            Update-SessionPath
            $pnpmVer = Get-CmdOutput 'pnpm' @('--version')
            $pnpmAction = 'ejecutado'
        } else {
            Write-Omit "pnpm $pnpmVer"
        }
        if ($pnpmVer -and $pnpmVer.StartsWith('12.')) {
            Add-Result 'pnpm 12' ok $pnpmVer -Action $pnpmAction -Seconds (Stop-StepClock)
            # Skip when the lockfile + every package.json are byte-identical to the last install.
            $jsStamp = Join-Path $RepoRoot 'node_modules\.studio-install'
            $jsPrint = Get-JsDepsFingerprint $nodeVer $pnpmVer
            $modulesYaml = Join-Path $RepoRoot 'node_modules\.modules.yaml'
            if (-not $Force -and (Test-Path $modulesYaml) -and (Read-Stamp $jsStamp) -eq $jsPrint) {
                Write-Omit 'node_modules (pnpm-lock.yaml sin cambios)'
                Add-Result 'Dependencias JS (pnpm install)' ok 'pnpm-lock.yaml sin cambios' -Action omitido -Seconds (Stop-StepClock)
            } else {
                Invoke-Native 'pnpm' @('install')
                Write-Stamp $jsStamp $jsPrint
                Add-Result 'Dependencias JS (pnpm install)' ok 'pnpm install' -Action ejecutado -Seconds (Stop-StepClock)
            }
            $pnpmOk = $true
        } else {
            Add-Result 'pnpm 12' fail "version: $pnpmVer" -Seconds (Stop-StepClock)
        }
    } catch {
        Add-Result 'Dependencias JS (pnpm install)' fail $_.Exception.Message -Seconds (Stop-StepClock)
    }
    Start-StepClock
    if ($pnpmOk -and $SkipBrowser) {
        Add-Result 'Remotion (Chrome Headless Shell)' skip '-SkipBrowser'
    } elseif ($pnpmOk) {
        $browser = Find-RemotionBrowser
        if ($browser -and -not $Force) {
            Write-Omit 'Chrome Headless Shell de Remotion'
            Add-Result 'Remotion (Chrome Headless Shell)' ok 'ya descargado' -Action omitido -Seconds (Stop-StepClock)
        } else {
            try {
                # Chrome Headless Shell for Remotion renders, run from the repo root: pnpm executes the
                # script inside packages\remotion, so it lands in packages\remotion\node_modules\.remotion
                # (one of the folders packages/remotion/src/browser.ts searches).
                Invoke-Native 'pnpm' @('--filter', '@studio/remotion', 'browser:ensure') $RepoRoot
                Add-Result 'Remotion (Chrome Headless Shell)' ok 'descargado' -Action ejecutado -Seconds (Stop-StepClock)
            } catch {
                Add-Result 'Remotion (Chrome Headless Shell)' fail ("{0} - reintenta setup.ps1" -f $_.Exception.Message) -Seconds (Stop-StepClock)
            }
        }
    }
} else {
    Add-Result 'pnpm 12' skip 'requiere Node.js 22'
}

# ============================================================================ 4. Python workers
Write-Step 'Entorno Python de los workers (apps\workers\.venv)'
$venvOk = $false
if ($WithCuda -and -not $gpuName) { Write-Careful '-WithCuda sin GPU NVIDIA detectada: se instala igual; sin GPU caera a CPU.' }
if ($WithCuda -and $gpuName -and -not (Test-Cmd 'nvidia-smi')) { Write-Careful "Falta el driver NVIDIA (nvidia-smi) para $gpuName : instala el driver 570+ o CUDA caera a CPU." }
if ($py311) {
    Start-StepClock
    try {
        $pyStepAction = 'omitido'
        $venvVer = $null
        if (Test-Path $VenvPython) {
            $venvVer = Get-CmdOutput $VenvPython @('-c', $PyVersionCode)
        }
        if ($venvVer -ne '3.11') {
            if (Test-Path (Join-Path $WorkersDir '.venv')) { Remove-Item -Recurse -Force (Join-Path $WorkersDir '.venv') }
            Invoke-Native $py311 @('-m', 'venv', '.venv') $WorkersDir
            $pyStepAction = 'ejecutado'
        }
        $profileName = 'cpu'
        if ($WithCuda) { $profileName = 'cuda' }
        if ($SkipRvc) { $profileName = "$profileName-norvc" }
        $reqFile = 'requirements.txt'
        if ($WithCuda) { $reqFile = 'requirements-cuda.txt' }
        # Line 1 keeps the format of older setups ("<profile> <SHA256 of requirements>") so their
        # stamps are recognized; line 2 tracks pyproject.toml (editable install of studio_workers).
        $line1 = "$profileName $((Get-FileHash (Join-Path $WorkersDir $reqFile) -Algorithm SHA256).Hash)"
        $line2 = "pyproject $(Get-FileSha256 (Join-Path $WorkersDir 'pyproject.toml'))"
        $stampLines = @((Read-Stamp $venvStamp) -split "`r?`n" | ForEach-Object { $_.Trim() })
        $heavyOk = (-not $Force) -and ($stampLines[0] -eq $line1)
        $editableOk = $heavyOk -and ($stampLines.Count -gt 1) -and ($stampLines[1] -eq $line2)
        # Never Activate.ps1 (blocked by execution policy): always call .venv\Scripts\python.exe.
        if (-not $heavyOk) {
            if ($stampLines[0]) { Write-Info "Cambio el perfil o requirements ($($stampLines[0].Split(' ')[0]) -> $profileName): pip install" }
            Invoke-Native $VenvPython @('-m', 'pip', 'install', '--upgrade', 'pip>=24', 'setuptools<=80.6.0', 'wheel') $WorkersDir
            if ($SkipRvc) {
                Invoke-Native $VenvPython @('-m', 'pip', 'install', '-e', '.[whisper,tts]') $WorkersDir
            } else {
                Invoke-Native $VenvPython @('-m', 'pip', 'install', '-r', $reqFile) $WorkersDir
                Invoke-Native $VenvPython @('-m', 'pip', 'install', '-e', '.', '--no-deps') $WorkersDir
            }
            $pyStepAction = 'ejecutado'
        } elseif (-not $editableOk) {
            Write-Info 'pyproject.toml cambio: reinstalando solo studio_workers (sin dependencias)'
            Invoke-Native $VenvPython @('-m', 'pip', 'install', '-e', '.', '--no-deps') $WorkersDir
            $pyStepAction = 'ejecutado'
        } else {
            Write-Omit "dependencias Python (perfil $profileName, requirements sin cambios)"
        }
        $check = Get-CmdOutput $VenvPython @('-c', 'import faster_whisper, piper, studio_workers; print(1)')
        if ($check -eq '1') {
            Write-Stamp $venvStamp "$line1`n$line2`ncuda-choice $cudaChoice"
            Add-Result 'Workers Python (.venv)' ok "perfil $profileName" -Action $pyStepAction -Seconds (Stop-StepClock)
            $venvOk = $true
        } else {
            Remove-Item -Force $venvStamp -ErrorAction SilentlyContinue  # next run reinstalls
            Add-Result 'Workers Python (.venv)' fail 'import faster_whisper/piper fallo' -Seconds (Stop-StepClock)
        }
        if (-not $SkipRvc) {
            $torch = Get-CmdOutput $VenvPython @('-c', 'import torch; print(torch.__version__, torch.cuda.is_available())')
            if ($torch) {
                $state = 'ok'
                if ($WithCuda -and $torch -notmatch 'True$') { $state = 'warn' }
                Add-Result 'torch (RVC)' $state $torch -Seconds (Stop-StepClock)
            } else {
                Add-Result 'torch (RVC)' fail 'import torch fallo (VC++ Redistributable?)' -Seconds (Stop-StepClock)
            }
        } else {
            Add-Result 'torch (RVC)' skip '-SkipRvc'
        }
    } catch {
        Add-Result 'Workers Python (.venv)' fail $_.Exception.Message -Seconds (Stop-StepClock)
    }
} else {
    Add-Result 'Workers Python (.venv)' skip 'requiere Python 3.11'
}

# ============================================================================ 5. models
Write-Step 'Modelos (Piper, Whisper, RVC base): primero se revisa lo que ya esta'
if (-not $PiperVoice) { $PiperVoice = Get-EnvSetting 'PIPER_DEFAULT_VOICE' 'es_AR-daniela-high' }
if ($SkipModels) {
    Add-Result 'Modelos' skip '-SkipModels'
} elseif (-not $venvOk) {
    Add-Result 'Modelos' skip 'requiere el .venv de workers'
} else {
    Start-StepClock
    $whisperList = @($WhisperModel)
    $envWhisper = Get-EnvSetting 'WHISPER_MODEL' $WhisperModel
    if ($envWhisper -ne $WhisperModel) { $whisperList += $envWhisper }
    $cliArgs = @('-m', 'studio_workers.models_cli', '--piper', $PiperVoice, '--whisper') + $whisperList
    # Decision 6: RVC base (hubert + rmvpe, pack rvc-base) only with -Full; otherwise on demand.
    if ($Full -and -not $SkipRvc) { $cliArgs += '--rvc-base' }
    if ($IncludeLegacyHubert) { $cliArgs += '--rvc-legacy-hubert' }
    $runDir = Get-RunDir
    $checkReport = Join-Path $runDir 'models-check.json'
    $dlReport = Join-Path $runDir 'models-update.json'
    try {
        # --check --update: what was asked + every group already in models\manifest.json (offline).
        Invoke-Native $VenvPython ($cliArgs + @('--check', '--update', '--report', $checkReport)) $WorkersDir
        $check = Get-Content -Raw -Encoding UTF8 $checkReport | ConvertFrom-Json
        if ($check.missing -eq 0 -and -not $Force) {
            Write-Omit ("modelos: {0} elementos presentes y verificados (models\manifest.json)" -f $check.present)
            Add-Result 'Modelos' ok ("{0} elementos presentes" -f $check.present) -Action omitido -Seconds (Stop-StepClock)
        } else {
            Write-Info ("Faltan {0} de {1} elementos: se descargan solo esos (reanudables)" -f $check.missing, ($check.present + $check.missing))
            $mode = '--update'
            if ($Force) { $mode = '--force' }
            Invoke-Native $VenvPython ($cliArgs + @($mode, '--report', $dlReport)) $WorkersDir
            $dl = Get-Content -Raw -Encoding UTF8 $dlReport | ConvertFrom-Json
            Add-Result 'Modelos' ok ("{0} descargados, {1} ya estaban" -f $dl.downloaded, $dl.skipped) -Action ejecutado -Seconds (Stop-StepClock)
        }
    } catch {
        Add-Result 'Modelos' fail ("{0} - reintenta setup.ps1 (las descargas se reanudan)" -f $_.Exception.Message) -Seconds (Stop-StepClock)
    }
}

# ============================================================================ 5b. GPL venv (RVM)
# Decision 2 (plan v2): GPL code runs in its own venv/process. Created only when the matting pack
# is wanted (-Full) or already exists (incremental update); otherwise the workers create it when
# the pack is downloaded from the app. Same code path: models_cli --gpl-venv ensure.
Write-Step 'Entorno aislado GPL (apps\workers\.venv-gpl, recorte de personas RVM)'
$gplPython = Join-Path $WorkersDir '.venv-gpl\Scripts\python.exe'
if (-not $venvOk) {
    Add-Result 'Entorno GPL (.venv-gpl)' skip 'requiere el .venv de workers'
} elseif (-not ($Full -or (Test-Path $gplPython))) {
    Add-Result 'Entorno GPL (.venv-gpl)' skip 'se crea al descargar el paquete matting (o con -Full)'
} else {
    Start-StepClock
    $gplReport = Join-Path (Get-RunDir) 'gpl-venv.json'
    $gplArgs = @('-m', 'studio_workers.models_cli', '--gpl-venv', 'ensure', '--report', $gplReport)
    if ($Force) { $gplArgs += '--force' }
    try {
        Invoke-Native $VenvPython $gplArgs $WorkersDir
        $gv = Get-Content -Raw -Encoding UTF8 $gplReport | ConvertFrom-Json
        $gplAction = 'ejecutado'
        if ($gv.action -eq 'omitido') { $gplAction = 'omitido'; Write-Omit 'entorno GPL (.venv-gpl): requirements sin cambios' }
        Add-Result 'Entorno GPL (.venv-gpl)' ok ("{0} - {1}" -f $gv.state, $gv.dir) -Action $gplAction -Seconds (Stop-StepClock)
    } catch {
        Add-Result 'Entorno GPL (.venv-gpl)' fail ("{0} - reintenta setup.ps1 o descarga el paquete matting desde Ajustes" -f $_.Exception.Message) -Seconds (Stop-StepClock)
    }
}

# ============================================================================ 6. AI packs
Write-Step 'Paquetes de IA (core por defecto; -Full: todos en secuencia)'
if ($SkipModels) {
    Add-Result 'Paquetes de IA' skip '-SkipModels'
} elseif (-not $venvOk) {
    Add-Result 'Paquetes de IA' skip 'requiere el .venv de workers'
} else {
    Start-StepClock
    $packReport = Join-Path (Get-RunDir) 'packs-update.json'
    $packArgs = @('-m', 'studio_workers.models_cli', '--packs', 'download', 'core')
    if ($Full) { $packArgs = @('-m', 'studio_workers.models_cli', '--packs', 'all') }
    if ($Force) { $packArgs += '--force' }
    try {
        Invoke-Native $VenvPython ($packArgs + @('--report', $packReport)) $WorkersDir
        $pk = Get-Content -Raw -Encoding UTF8 $packReport | ConvertFrom-Json
        $packAction = 'ejecutado'
        if ($pk.installed -eq 0 -and $pk.failed -eq 0) { $packAction = 'omitido' }
        Add-Result 'Paquetes de IA' ok ("{0} instalados, {1} ya estaban" -f $pk.installed, $pk.skipped) -Action $packAction -Seconds (Stop-StepClock)
    } catch {
        $detail = $_.Exception.Message
        if (Test-Path $packReport) {
            try {
                $pk = Get-Content -Raw -Encoding UTF8 $packReport | ConvertFrom-Json
                $bad = @($pk.items | Where-Object { $_.action -eq 'failed' } | ForEach-Object { $_.id })
                if ($bad.Count) { $detail = "con error: $($bad -join ', ')" }
            } catch { }
        }
        Add-Result 'Paquetes de IA' fail ("{0} - reintenta setup.ps1 (se reanuda) o descargalos desde Ajustes" -f $detail) -Seconds (Stop-StepClock)
    }
    if (-not $Full) { Write-Info 'Los demas paquetes se descargan al usar cada funcion (o con setup.ps1 -Full).' }
}

# ============================================================================ 7. build
Write-Step 'Build (pnpm build)'
if ($SkipBuild) {
    Add-Result 'Build' skip '-SkipBuild (usa start.ps1 -Dev)'
} elseif (-not $pnpmOk) {
    Add-Result 'Build' skip 'requiere pnpm install'
} else {
    Start-StepClock
    try {
        $build = Get-WebBuildState
        if ($build.Fresh -and -not $Force) {
            Write-Omit "build de produccion ($($build.Reason))"
            Add-Result 'Build' ok $build.Reason -Action omitido -Seconds (Stop-StepClock)
        } else {
            Write-Info "Se compila: $($build.Reason)"
            # NEXT_PUBLIC_API_URL / API_PORT from .env reach next.config.ts (inlined into the web build).
            Import-DotEnvToProcess
            Invoke-Native 'pnpm' @('build')
            Save-WebBuildStamp
            Add-Result 'Build' ok 'pnpm build' -Action ejecutado -Seconds (Stop-StepClock)
        }
    } catch {
        Add-Result 'Build' fail ("{0} (podes usar start.ps1 -Dev)" -f $_.Exception.Message) -Seconds (Stop-StepClock)
    }
}

# ============================================================================ 8. final check
# Required assets must exist after the run (not only "the step did not throw").
Write-Step 'Verificacion final (voz Piper, Whisper, navegador de Remotion)'
$missingAssets = @()
if (-not $SkipModels) {
    $piperDir = Join-Path $models 'piper'
    if (-not ((Test-Path (Join-Path $piperDir "$PiperVoice.onnx")) -and (Test-Path (Join-Path $piperDir "$PiperVoice.onnx.json")))) {
        $missingAssets += "voz Piper $PiperVoice (models\piper)"
    }
    $wModel = Get-EnvSetting 'WHISPER_MODEL' $WhisperModel
    $wHit = Get-ChildItem -Path (Join-Path $models 'whisper') -Filter 'model.bin' -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match ('models--[^\\/]+--faster-(distil-)?whisper-' + [regex]::Escape($wModel) + '[\\/]snapshots[\\/]') } |
        Select-Object -First 1
    if (-not $wHit -and $wModel -notmatch '^(large|turbo)$') { $missingAssets += "modelo Whisper $wModel (models\whisper)" }
}
if (-not $SkipBrowser -and -not (Find-RemotionBrowser)) {
    $missingAssets += 'Chrome Headless Shell de Remotion (pnpm --filter @studio/remotion browser:ensure)'
}
if ($missingAssets.Count -gt 0) {
    foreach ($m in $missingAssets) { Add-Result 'Falta' fail $m }
} else {
    Write-Good 'Activos requeridos presentes'
}

# ============================================================================ summary
$totalSecs = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
$omitted = @($Results | Where-Object { $_.Action -eq 'omitido' }).Count
$executed = @($Results | Where-Object { $_.Action -eq 'ejecutado' }).Count
$failed = Get-FailedCount
Show-Results ("Resumen de {0} ({1} s = {2} min)" -f $modeLabel, $totalSecs, [math]::Round($totalSecs / 60, 1))
Write-Host (" {0} pasos omitidos (ya instalados), {1} ejecutados, tiempo total {2} s" -f $omitted, $executed, $totalSecs) -ForegroundColor White
try {
    $summary = [ordered]@{
        mode = $modeLabel; finished = (Get-Date).ToString('s'); seconds = $totalSecs
        omitted = $omitted; executed = $executed; failed = $failed
        steps = @($Results | ForEach-Object { [ordered]@{ component = $_.Component; state = $_.State; action = $_.Action; seconds = $_.Seconds; detail = $_.Detail } })
    }
    $summaryPath = Join-Path (Get-RunDir) 'setup-last.json'
    [IO.File]::WriteAllText($summaryPath, ($summary | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding $false))
} catch { Write-Careful "No se pudo escribir storage\run\setup-last.json: $($_.Exception.Message)" }
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
Write-Host 'Volver a correrlo es seguro: lo que ya quedo instalado o descargado se omite.'
exit 1

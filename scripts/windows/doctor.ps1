#Requires -Version 5.1
<#
.SYNOPSIS
  Studio - diagnostico: versiones, PATH, FFmpeg (filtros, incl. rubberband), GPU, Python, modelos,
  puertos y servicios. No modifica nada.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\doctor.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
Initialize-Console
Update-SessionPath

Write-Host "Studio - doctor (repo: $RepoRoot)" -ForegroundColor White

# ------------------------------------------------------------------ system
Write-Step 'Sistema'
$os = [Environment]::OSVersion.Version
Write-Info ("Windows {0} ({1}), PowerShell {2}" -f $os, $(if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }), $PSVersionTable.PSVersion)
Add-Result 'Windows 64 bits' $(if ([Environment]::Is64BitOperatingSystem) { 'ok' } else { 'fail' }) "$os"
Write-Info 'Politica de ejecucion:'
Get-ExecutionPolicy -List | ForEach-Object { Write-Info ("  {0,-14} {1}" -f $_.Scope, $_.ExecutionPolicy) }
if (Test-LongPaths) { Add-Result 'Rutas largas' ok 'LongPathsEnabled=1' }
else { Add-Result 'Rutas largas' warn 'desactivadas (ver INSTALACION-WINDOWS.md)' }
if ($RepoRoot.Length -gt 60) { Add-Result 'Ruta del repo' warn "$($RepoRoot.Length) caracteres; recomendado C:\dev\studio" }
else { Add-Result 'Ruta del repo' ok $RepoRoot }
$free = (Get-PSDrive -Name ($RepoRoot.Substring(0, 1)) -ErrorAction SilentlyContinue).Free
if ($free) {
    $gb = [math]::Round($free / 1GB, 1)
    $state = 'ok'
    if ($gb -lt 10) { $state = 'warn' }
    Add-Result 'Espacio libre' $state "$gb GB (recomendado >= 10 GB; CUDA ~ +4 GB)"
}

# ------------------------------------------------------------------ toolchain
Write-Step 'Herramientas'
$winget = Get-CmdOutput 'winget' @('--version')
Add-Result 'winget' $(if ($winget) { 'ok' } else { 'warn' }) $(if ($winget) { $winget } else { 'no disponible (App Installer)' })
$git = Get-CmdOutput 'git' @('--version')
Add-Result 'Git' $(if ($git) { 'ok' } else { 'fail' }) "$git"
$node = Get-CmdOutput 'node' @('--version')
$nodeState = 'fail'
if ($node -and $node.StartsWith('v22.')) { $nodeState = 'ok' } elseif ($node) { $nodeState = 'warn' }
Add-Result 'Node.js (22)' $nodeState $(if ($node) { "$node  $((Get-Command node).Source)" } else { 'no encontrado' })
$pnpm = Get-CmdOutput 'pnpm' @('--version')
Add-Result 'pnpm (12)' $(if ($pnpm -and $pnpm.StartsWith('12.')) { 'ok' } elseif ($pnpm) { 'warn' } else { 'fail' }) "$pnpm"
$py = Find-Python311
Add-Result 'Python 3.11' $(if ($py) { 'ok' } else { 'fail' }) "$py"
$storeAlias = Get-Command python -ErrorAction SilentlyContinue
if ($storeAlias -and $storeAlias.Source -match 'WindowsApps') {
    Write-Careful 'python apunta al alias de Microsoft Store. Desactivalo en Configuracion > Aplicaciones > Alias de ejecucion.'
}
$vc = Test-VCRedist
Add-Result 'VC++ Redistributable x64' $(if ($vc) { 'ok' } else { 'warn' }) "$vc"

# ------------------------------------------------------------------ ffmpeg
Write-Step 'FFmpeg'
$ffmpeg = Find-FfmpegExe
if ($ffmpeg) {
    $ver = Get-CmdOutput $ffmpeg @('-hide_banner', '-version')
    Add-Result 'FFmpeg' ok "$ver"
    Write-Info "Ruta: $ffmpeg"
    $ErrorActionPreference = 'Continue'
    $filters = (& $ffmpeg -hide_banner -filters 2>$null) -join "`n"
    $encoders = (& $ffmpeg -hide_banner -encoders 2>$null) -join "`n"
    $ErrorActionPreference = 'Stop'
    foreach ($f in @('rubberband', 'arnndn', 'afftdn', 'loudnorm', 'sidechaincompress', 'afir', 'ass', 'subtitles', 'xfade')) {
        $has = $filters -match ("(?m)^\s*\S+\s+" + [regex]::Escape($f) + "\s")
        $state = 'ok'
        if (-not $has) { $state = 'warn'; if ($f -eq 'ass' -or $f -eq 'subtitles') { $state = 'fail' } }
        $detail = 'presente'
        if (-not $has) {
            $detail = 'falta'
            if ($f -eq 'rubberband') { $detail = 'falta: se usa asetrate+atempo (build "full" de Gyan lo incluye)' }
        }
        Add-Result "  filtro $f" $state $detail
    }
    foreach ($e in @('libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'libmp3lame', 'libvpx-vp9', 'prores_ks')) {
        $has = $encoders -match ("(?m)^\s*\S+\s+" + [regex]::Escape($e) + "\s")
        $state = 'ok'
        if (-not $has) { $state = 'warn'; if ($e -eq 'libx264' -or $e -eq 'libmp3lame') { $state = 'fail' } }
        Add-Result "  encoder $e" $state $(if ($has) { 'presente' } else { 'falta' })
    }
} else {
    Add-Result 'FFmpeg' fail 'no encontrado (winget install -e --id Gyan.FFmpeg o FFMPEG_PATH en .env)'
}

# ------------------------------------------------------------------ GPU
Write-Step 'GPU'
try {
    Get-CimInstance Win32_VideoController -ErrorAction Stop | ForEach-Object { Write-Info ("Adaptador: {0} (driver {1})" -f $_.Name, $_.DriverVersion) }
} catch { }
if (Test-Cmd 'nvidia-smi') {
    $gpu = Get-CmdOutput 'nvidia-smi' @('--query-gpu=name,driver_version,memory.total', '--format=csv,noheader')
    Add-Result 'GPU NVIDIA' ok "$gpu"
} else {
    Add-Result 'GPU NVIDIA' skip 'no detectada: todo corre en CPU (normal)'
}
$useCuda = (Get-EnvSetting 'USE_CUDA' 'false') -eq 'true'
Write-Info "USE_CUDA en .env: $useCuda"

# ------------------------------------------------------------------ python env
Write-Step 'Workers Python'
if (Test-Path $VenvPython) {
    $code = 'import importlib.util as u; print(*[m for m in (' +
        "'faster_whisper','ctranslate2','piper','infer_rvc_python','torch','onnxruntime','studio_workers'" +
        ') if u.find_spec(m)], sep=chr(44))'
    $mods = Get-CmdOutput $VenvPython @('-c', $code)
    $present = @()
    if ($mods) { $present = $mods -split ',' }
    foreach ($m in @('faster_whisper', 'piper', 'studio_workers', 'torch', 'infer_rvc_python')) {
        $state = 'ok'
        if ($present -notcontains $m) {
            $state = 'fail'
            if ($m -eq 'torch' -or $m -eq 'infer_rvc_python') { $state = 'warn' }
        }
        Add-Result "  python: $m" $state $(if ($state -eq 'ok') { 'instalado' } else { 'falta (setup.ps1)' })
    }
    if ($present -contains 'torch') {
        $torch = Get-CmdOutput $VenvPython @('-c', 'import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available())')
        Write-Info "torch: $torch  (version, CUDA, cuda disponible)"
    }
    if ($present -contains 'ctranslate2') {
        $ct = Get-CmdOutput $VenvPython @('-c', 'import ctranslate2; print(ctranslate2.get_cuda_device_count())')
        Write-Info "ctranslate2: dispositivos CUDA = $ct"
    }
} else {
    Add-Result 'Workers Python (.venv)' fail 'no existe apps\workers\.venv (setup.ps1)'
}

# ------------------------------------------------------------------ config + models
Write-Step 'Configuracion y modelos'
if (Test-Path $EnvFile) {
    Add-Result '.env' ok 'presente'
    $map = Read-DotEnv
    foreach ($k in @('ELEVENLABS_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'FREESOUND_API_KEY')) {
        $set = $map.ContainsKey($k) -and $map[$k]
        Write-Info ("{0,-20} {1}" -f $k, $(if ($set) { 'configurada' } else { 'vacia (opcional)' }))
    }
} else {
    Add-Result '.env' fail 'falta (setup.ps1 lo crea desde .env.example)'
}
$models = Get-ModelsDir
$voices = @(Get-ChildItem -Path (Join-Path $models 'piper') -Filter '*.onnx' -ErrorAction SilentlyContinue | ForEach-Object { $_.BaseName })
Add-Result 'Voces Piper' $(if ($voices.Count) { 'ok' } else { 'warn' }) $(if ($voices.Count) { $voices -join ', ' } else { 'ninguna (setup.ps1 o POST /api/voice/models/download)' })
$wh = @(Get-ChildItem -Path (Join-Path $models 'whisper') -Directory -Filter 'models--*faster-whisper-*' -ErrorAction SilentlyContinue | ForEach-Object { ($_.Name -split 'faster-whisper-')[1] })
Add-Result 'Modelos Whisper' $(if ($wh.Count) { 'ok' } else { 'warn' }) $(if ($wh.Count) { $wh -join ', ' } else { 'ninguno (se descarga al primer uso)' })
$rmvpe = Test-Path (Join-Path $models 'rvc\_base\rmvpe.pt')
$hubert = Test-Path (Join-Path $models 'rvc\_base\hubert_base\config.json')
Add-Result 'RVC base (rmvpe/hubert)' $(if ($rmvpe -and $hubert) { 'ok' } else { 'warn' }) ("rmvpe={0} hubert={1}" -f $rmvpe, $hubert)
$rvcModels = @(Get-ChildItem -Path (Join-Path $models 'rvc') -Directory -ErrorAction SilentlyContinue | Where-Object { -not $_.Name.StartsWith('_') -and (Get-ChildItem $_.FullName -Filter '*.pth' -ErrorAction SilentlyContinue) } | ForEach-Object { $_.Name })
Add-Result 'Modelos de voz RVC' $(if ($rvcModels.Count) { 'ok' } else { 'skip' }) $(if ($rvcModels.Count) { $rvcModels -join ', ' } else { 'ninguno: copia <nombre>\*.pth (+ .index) a models\rvc\' })
$remotionCache = @(
    (Join-Path $RepoRoot 'node_modules\.remotion'),
    (Join-Path $RepoRoot 'packages\remotion\node_modules\.remotion')
) | Where-Object { Test-Path $_ }
Add-Result 'Remotion browser' $(if ($remotionCache) { 'ok' } else { 'warn' }) $(if ($remotionCache) { 'descargado' } else { 'no encontrado (npx remotion browser ensure)' })

# ------------------------------------------------------------------ ports / services
Write-Step 'Puertos y servicios'
$ports = Get-Ports
$checks = @(
    @('workers', $ports.Workers, "http://127.0.0.1:$($ports.Workers)/health"),
    @('api', $ports.Api, "http://127.0.0.1:$($ports.Api)/api/health"),
    @('web', $ports.Web, "http://127.0.0.1:$($ports.Web)/")
)
foreach ($c in $checks) {
    $owner = Get-PortOwner $c[1]
    if (-not $owner) { Add-Result ("puerto {0} ({1})" -f $c[1], $c[0]) skip 'libre (servicio detenido)'; continue }
    $ok = Test-HttpOk $c[2] 3
    $name = (Get-Process -Id $owner -ErrorAction SilentlyContinue).ProcessName
    Add-Result ("puerto {0} ({1})" -f $c[1], $c[0]) $(if ($ok) { 'ok' } else { 'warn' }) ("PID {0} {1}; health={2}" -f $owner, $name, $ok)
}
if (Test-HttpOk "http://127.0.0.1:$($ports.Workers)/health" 3) {
    try {
        $h = Invoke-RestMethod -Uri "http://127.0.0.1:$($ports.Workers)/health" -TimeoutSec 5
        Write-Info ("workers: cuda={0} whisper={1} piper={2} rvc={3}" -f $h.cuda, $h.capabilities.whisper, $h.capabilities.piper, $h.capabilities.rvc)
    } catch { }
}

Write-Step 'PATH (sesion actual)'
$env:Path -split ';' | Where-Object { $_ } | ForEach-Object { Write-Info $_ }

Show-Results 'Diagnostico de Studio'
if ((Get-FailedCount) -gt 0) { exit 1 }
exit 0

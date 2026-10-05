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
# models_cli prints a check mark: Python stdio in UTF-8, decoded as UTF-8 by Initialize-Console.
$env:PYTHONIOENCODING = 'utf-8'
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
$useCudaValue = Get-EnvSetting 'USE_CUDA' 'false'
$useCuda = $useCudaValue -eq 'true'
$gpuName = Get-NvidiaGpuName
# modo: what the running workers report (GET /gpu/status); if they are stopped, what .env + the
# detected GPU imply.
$cudaMode = 'cpu'
if ($useCuda -and $gpuName) { $cudaMode = 'gpu' }
try {
    $live = Invoke-RestMethod -Uri "http://127.0.0.1:$((Get-Ports).Workers)/gpu/status" -TimeoutSec 3
    if ($live.mode) { $cudaMode = [string]$live.mode }
} catch { }
$gpuLabel = '(ninguna)'
if ($gpuName) { $gpuLabel = $gpuName }
Write-Info "USE_CUDA=$useCudaValue / modo=$cudaMode / GPU=$gpuLabel"
if ($gpuName -and -not $useCuda) {
    $stamp = Read-Stamp (Join-Path $WorkersDir '.venv\.studio-install')
    if ($stamp -match 'cuda-choice\s+nocuda') {
        Write-Info 'Hay GPU NVIDIA pero elegiste CPU (-NoCuda). Para usarla: setup.ps1 -Update -WithCuda'
    } else {
        Write-Careful 'Hay GPU NVIDIA pero USE_CUDA=false: setup.ps1 -Update cambia a CUDA solo (descarga ~2.5 GB, una vez).'
    }
}

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
$remotionExe = Find-RemotionBrowser
Add-Result 'Remotion browser' $(if ($remotionExe) { 'ok' } else { 'warn' }) $(if ($remotionExe) { 'descargado' } else { 'no encontrado (pnpm --filter @studio/remotion browser:ensure)' })

# ------------------------------------------------------------------ models manifest + disk usage
Write-Step 'Manifiesto de modelos y espacio en disco'
$manifestPath = Join-Path $models 'manifest.json'
if (Test-Path $manifestPath) {
    try {
        $mf = Get-Content -Raw -Encoding UTF8 $manifestPath | ConvertFrom-Json
        $entries = @($mf.files.PSObject.Properties | ForEach-Object { $_.Value })
        $missingFiles = @()
        $badSize = @()
        foreach ($e in $entries) {
            $p = Join-Path $models ($e.path -replace '/', '\')
            if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { $missingFiles += $e.path; continue }
            if ((Get-Item -LiteralPath $p).Length -ne [int64]$e.size) { $badSize += $e.path }
        }
        $groups = @($entries | ForEach-Object { $_.group } | Sort-Object -Unique)
        Write-Info ("manifest.json: {0} archivos, actualizado {1}" -f $entries.Count, $mf.updated)
        foreach ($g in $groups) {
            $gs = @($entries | Where-Object { $_.group -eq $g })
            $bytes = [int64]0
            foreach ($e in $gs) { $bytes += [int64]$e.size }
            Write-Info ("  {0,-34} {1,3} archivo(s)  {2,10}" -f $g, $gs.Count, (Format-Bytes $bytes))
        }
        $state = 'ok'
        $detail = "{0} archivos registrados, todos presentes" -f $entries.Count
        if ($missingFiles.Count -or $badSize.Count) {
            $state = 'warn'
            $detail = "{0} faltan, {1} con otro tamano (setup.ps1 -Update los vuelve a bajar)" -f $missingFiles.Count, $badSize.Count
            foreach ($m in ($missingFiles + $badSize)) { Write-Careful "  $m" }
        }
        Add-Result 'Manifiesto de modelos' $state $detail
    } catch {
        Add-Result 'Manifiesto de modelos' warn ("models\manifest.json ilegible: {0}" -f $_.Exception.Message)
    }
} else {
    Add-Result 'Manifiesto de modelos' warn 'models\manifest.json no existe (setup.ps1 lo crea)'
}
if (Test-Path $VenvPython) {
    Write-Info 'Detalle (presentes / faltantes) segun models_cli --check --update --no-write:'
    $ErrorActionPreference = 'Continue'
    Push-Location $WorkersDir
    $voice = Get-EnvSetting 'PIPER_DEFAULT_VOICE' 'es_AR-daniela-high'
    $wModel = Get-EnvSetting 'WHISPER_MODEL' 'base'
    try {
        & $VenvPython -m studio_workers.models_cli --check --update --no-write --piper $voice --whisper $wModel 2>&1 |
            ForEach-Object { Write-Info "$_" }
    } finally { Pop-Location }
    $ErrorActionPreference = 'Stop'
}

# ------------------------------------------------------------------ AI packs (models\packs.json)
Write-Step 'Paquetes de IA'
if (Test-Path $VenvPython) {
    $ErrorActionPreference = 'Continue'
    Push-Location $WorkersDir
    try {
        $packOut = @(& $VenvPython -m studio_workers.models_cli --packs list --json 2>$null)
    } finally { Pop-Location }
    $ErrorActionPreference = 'Stop'
    $packJson = $packOut | Where-Object { "$_".StartsWith('{') } | Select-Object -Last 1
    if ($packJson) {
        try {
            $packList = ($packJson | ConvertFrom-Json).packs
            foreach ($p in $packList) {
                $size = Format-Bytes ([int64]$p.size_bytes)
                if ($p.installed) { Add-Result ("  pack {0}" -f $p.id) ok ("instalado ({0})" -f $size) }
                elseif ($p.partial) { Add-Result ("  pack {0}" -f $p.id) warn ("parcial: setup.ps1 -Full o Ajustes > Paquetes de IA lo reanuda ({0})" -f $size) }
                elseif ($p.id -eq 'core') { Add-Result ("  pack {0}" -f $p.id) fail ("falta ({0}): setup.ps1" -f $size) }
                else { Add-Result ("  pack {0}" -f $p.id) skip ("no descargado ({0}); se pide al usar la funcion" -f $size) }
            }
        } catch {
            Add-Result 'Paquetes de IA' warn ("salida ilegible: {0}" -f $_.Exception.Message)
        }
    } else {
        Add-Result 'Paquetes de IA' warn 'models_cli --packs list no respondio (setup.ps1)'
    }
} else {
    Add-Result 'Paquetes de IA' skip 'requiere apps\workers\.venv'
}
# GPL-isolated venv for RobustVideoMatting (pack matting): apps\workers\.venv-gpl
$gplDir = Join-Path $WorkersDir '.venv-gpl'
$gplPython = Join-Path $gplDir 'Scripts\python.exe'
$gplState = 'missing'
if (Test-Path $VenvPython) {
    $ErrorActionPreference = 'Continue'
    Push-Location $WorkersDir
    try {
        $gplOut = @(& $VenvPython -m studio_workers.models_cli --gpl-venv status --json 2>$null)
    } finally { Pop-Location }
    $ErrorActionPreference = 'Stop'
    $gplJson = $gplOut | Where-Object { "$_".StartsWith('{') } | Select-Object -Last 1
    if ($gplJson) { try { $gplState = ($gplJson | ConvertFrom-Json).state } catch { $gplState = 'missing' } }
} elseif (Test-Path $gplPython) {
    $gplState = 'ready'
}
if ($gplState -eq 'ready' -and (Test-Path $gplPython)) {
    $ErrorActionPreference = 'Continue'
    $gplTorch = (& $gplPython -c 'import torch; print(torch.__version__, "cuda" if torch.cuda.is_available() else "cpu")' 2>$null | Select-Object -Last 1)
    $ErrorActionPreference = 'Stop'
    if ($gplTorch) { Add-Result 'Entorno GPL (.venv-gpl)' ok ("listo, torch {0}" -f $gplTorch) }
    else { Add-Result 'Entorno GPL (.venv-gpl)' warn 'existe pero import torch fallo: setup.ps1 -Update -Force o volve a descargar el paquete matting' }
} elseif ($gplState -eq 'ready') {
    Add-Result 'Entorno GPL (.venv-gpl)' ok 'GPL_PYTHON definido en .env (interprete propio)'
} elseif ($gplState -eq 'stale') {
    Add-Result 'Entorno GPL (.venv-gpl)' warn 'vision_gpl\requirements.txt cambio: setup.ps1 -Update lo actualiza'
} else {
    Add-Result 'Entorno GPL (.venv-gpl)' skip 'no creado; se crea al descargar el paquete matting (recorte RVM)'
}
if (Test-Cmd 'nvidia-smi') {
    Write-Info 'GPU: si la VRAM se llena, el driver NVIDIA usa RAM compartida (5-10x mas lento) en vez de fallar.'
    Write-Info 'Panel de control NVIDIA > Configuracion 3D > "CUDA - Sysmem Fallback Policy": "Prefer No Sysmem Fallback" falla rapido.'
}

$storageRoot = Get-StorageDir
foreach ($pair in @(@('models\', $models), @('storage\', $storageRoot))) {
    $bytes = Get-FolderBytes $pair[1]
    Add-Result ("Espacio usado {0}" -f $pair[0]) ok ("{0}  ({1})" -f (Format-Bytes $bytes), $pair[1])
}
foreach ($sub in @('media', 'proxies', 'renders', 'exports', 'library', 'tmp', 'logs')) {
    $p = Join-Path $storageRoot $sub
    if (Test-Path $p) { Write-Info ("  storage\{0,-10} {1,10}" -f $sub, (Format-Bytes (Get-FolderBytes $p))) }
}

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
    try {
        $g = Invoke-RestMethod -Uri "http://127.0.0.1:$($ports.Workers)/gpu/status" -TimeoutSec 5
        $vram = 'n/d'
        if ($null -ne $g.vram_total_mb) { $vram = "{0}/{1} MB libres" -f $g.vram_free_mb, $g.vram_total_mb }
        $resident = '(ninguno)'
        if ($g.resident_model) { $resident = $g.resident_model }
        $gState = 'ok'
        if ($g.sysmem_fallback) { $gState = 'warn' }
        Add-Result 'GPU (workers)' $gState ("modo={0} {1} VRAM {2}, modelo residente {3}" -f $g.mode, $g.gpu_name, $vram, $resident)
        if ($g.sysmem_fallback) { Write-Careful 'VRAM casi llena con un modelo cargado: posible uso de RAM compartida (lento). POST /gpu/release o cerra otras apps.' }
    } catch { }
}

Write-Step 'PATH (sesion actual)'
$env:Path -split ';' | Where-Object { $_ } | ForEach-Object { Write-Info $_ }

Show-Results 'Diagnostico de Studio'
if ((Get-FailedCount) -gt 0) { exit 1 }
exit 0

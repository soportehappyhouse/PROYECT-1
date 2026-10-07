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
    Add-Result 'Espacio libre' $state "$gb GB (recomendado >= 10 GB; CUDA ~ +4 GB; voz avanzada ~ +6,2 GB; cambio de cara ~ +4 GB)"
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
# Sprint 4: only the isolated face swap tool (tools\facefusion\.venv) uses Python 3.12.
$py312 = Find-Python312
if ($py312) { Add-Result 'Python 3.12 (herramientas)' ok ("{0}  {1}" -f (Get-CmdOutput $py312 @('--version')), $py312) }
else { Add-Result 'Python 3.12 (herramientas)' warn 'falta: solo lo necesita el cambio de cara (setup.ps1 -Update lo instala con winget)' }
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
# Sprint 4: where the hubert came from (models\manifest.json: lj1995/VoiceConversionWebUI or the
# r3gm/hubert_base mirror the download falls back to when the official path answers 404).
$hubertOrigin = 'origen desconocido'
try {
    $mfPath = Join-Path $models 'manifest.json'
    if (Test-Path $mfPath) {
        $mfRvc = Get-Content -Raw -Encoding UTF8 $mfPath | ConvertFrom-Json
        $hEntry = $mfRvc.files.'rvc/_base/hubert_base/pytorch_model.bin'
        if ($hEntry -and $hEntry.source -match 'huggingface\.co/([^/]+/[^/]+)/') { $hubertOrigin = "hubert de $($Matches[1])" }
        elseif ($hEntry) { $hubertOrigin = 'hubert copiado a mano' }
    }
} catch { }
Add-Result 'RVC base (rmvpe/hubert)' $(if ($rmvpe -and $hubert) { 'ok' } else { 'warn' }) ("rmvpe={0} hubert={1} ({2})" -f $rmvpe, $hubert, $hubertOrigin)
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
                # Files without a published sha256 (SAM 2.1): size + sha256 are recorded in
                # models\manifest.json at the first download and compared from then on.
                if ($p.integrity -eq 'pending') {
                    # ASCII-only script (Windows PowerShell 5.1 reads it as ANSI): o-acute via [char].
                    Add-Result ("    integridad {0}" -f $p.id) warn ("verificaci{0}n pendiente de primera descarga (sin sha256 publicado: se registra en models\manifest.json al bajar)" -f [char]0x00F3)
                } elseif ($p.integrity -eq 'first-download') {
                    Write-Info ("    {0}: sha256 registrado en la primera descarga (models\manifest.json)" -f $p.id)
                }
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
# GPL-isolated venv for RobustVideoMatting (packs matting and matting-hq): apps\workers\.venv-gpl
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
    # Same check as models_cli --gpl-venv ensure (import numpy, torch), run from apps\workers like
    # the RVM runner; the last stderr line is shown so a failure says why (stale studio-main.pth
    # after moving the folder, numpy/torch mismatch...). setup.ps1 -Update now repairs it.
    $ErrorActionPreference = 'Continue'
    Push-Location $WorkersDir
    try {
        $gplLines = @(& $gplPython -c 'import numpy, torch; print("torch", torch.__version__, "cuda" if torch.cuda.is_available() else "cpu")' 2>&1 | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
    } catch { $gplLines = @("$($_.Exception.Message)") } finally { Pop-Location }
    $ErrorActionPreference = 'Stop'
    $gplTorch = $gplLines | Where-Object { $_ -like 'torch *' } | Select-Object -Last 1
    if ($gplTorch) { Add-Result 'Entorno GPL (.venv-gpl)' ok ("listo, {0}" -f $gplTorch) }
    else {
        $gplErr = $gplLines | Select-Object -Last 1
        if (-not $gplErr) { $gplErr = 'sin salida' }
        Add-Result 'Entorno GPL (.venv-gpl)' warn ("existe pero import torch fallo ({0}): setup.ps1 -Update lo repara (o -Update -Force)" -f $gplErr)
    }
} elseif ($gplState -eq 'ready') {
    Add-Result 'Entorno GPL (.venv-gpl)' ok 'GPL_PYTHON definido en .env (interprete propio)'
} elseif ($gplState -eq 'stale') {
    Add-Result 'Entorno GPL (.venv-gpl)' warn 'vision_gpl\requirements.txt cambio: setup.ps1 -Update lo actualiza'
} else {
    Add-Result 'Entorno GPL (.venv-gpl)' skip 'no creado; se crea al descargar el paquete matting o matting-hq (recorte RVM)'
}
# ------------------------------------------------------------------ sprint 4: isolated tools
# tools\facefusion\.venv (Python 3.12 + onnxruntime-gpu) and tools\chatterbox\.venv (torch 2.6):
# state, version/variant and the provider the check really loaded (verify --no-write: doctor never
# writes the stamp or the broken marker). Plus the licence mirror (storage\consent\licences.json,
# read only) and the RVC torch build.
Write-Step 'Herramientas aisladas (cambio de cara y voz avanzada)'
$toolStateEs = @{ ready = 'listo'; stale = 'desactualizado (setup.ps1 -Update)'; missing = 'no instalado'; broken = 'roto (volve a descargar el paquete)'; python = 'falta Python 3.12 (setup.ps1 -Update)' }
if (Test-Path $VenvPython) {
    foreach ($tool in @('facefusion', 'chatterbox')) {
        $label = 'FaceFusion (tools\facefusion)'
        if ($tool -eq 'chatterbox') { $label = 'Chatterbox (tools\chatterbox)' }
        $ErrorActionPreference = 'Continue'
        Push-Location $WorkersDir
        try {
            $action = 'status'
            if (Test-Path (Get-ToolVenvPython $tool)) { $action = 'verify' }
            $tvOut = @(& $VenvPython -m studio_workers.models_cli --tool-venv $tool $action --no-write --json 2>$null)
        } finally { Pop-Location }
        $ErrorActionPreference = 'Stop'
        $tvJson = $tvOut | Where-Object { "$_".StartsWith('{') } | Select-Object -Last 1
        if (-not $tvJson) { Add-Result $label warn 'models_cli --tool-venv no respondio'; continue }
        try { $tv = $tvJson | ConvertFrom-Json } catch { Add-Result $label warn 'salida ilegible'; continue }
        $stateText = $toolStateEs[[string]$tv.state]
        if (-not $stateText) { $stateText = [string]$tv.state }
        $parts = @($stateText)
        if ($tv.version) { $parts += "version $($tv.version)" }
        if ($tv.variant) { $parts += "variant $(([string]$tv.variant).ToUpper())" }
        if ($tool -eq 'facefusion' -and $tv.providers) {
            $prov = 'CPU'
            if (@($tv.providers) -contains 'CUDAExecutionProvider') { $prov = 'CUDA' }
            if ($tv.check -and $tv.check.session) { $prov = "$prov (sesion ORT real: $($tv.check.session))" }
            $parts += "proveedor $prov"
        }
        if ($tool -eq 'chatterbox' -and $tv.check -and $tv.check.torch) {
            $cudaText = 'no'
            if ($tv.check.cuda) { $cudaText = 'si' }
            $parts += "torch $($tv.check.torch), CUDA $cudaText"
        }
        if ($tool -eq 'chatterbox' -and $tv.state -ne 'missing') {
            # Hugging Face weights: trust on first download, then pinned to the recorded commit
            if ($tv.hf_pinned) { $parts += ("pesos fijados en {0}" -f ([string]$tv.hf_revision).Substring(0, 7)) }
            else { $parts += 'pesos de Hugging Face: verificacion pendiente (se fijan en la primera descarga)' }
        }
        if ($tv.base_python -and $tool -eq 'facefusion') { $parts += "base $($tv.base_python)" }
        $state = 'ok'
        if ($tv.state -eq 'missing') { $state = 'skip' }
        elseif ($tv.state -ne 'ready') { $state = 'warn' }
        if ($tv.state -eq 'missing') { $parts = @('no instalado: se crea al descargar su paquete desde Ajustes > Paquetes de IA') }
        if ($tv.error) { Write-Careful ("  {0}: {1}" -f $label, $tv.error) }
        Add-Result $label $state ($parts -join ', ')
    }
    # Licence mirror (written by the api on every accept/revoke; never edited here)
    $ErrorActionPreference = 'Continue'
    Push-Location $WorkersDir
    try { $licOut = @(& $VenvPython -m studio_workers.models_cli --licences --json 2>$null) } finally { Pop-Location }
    $ErrorActionPreference = 'Stop'
    $licJson = $licOut | Where-Object { "$_".StartsWith('{') } | Select-Object -Last 1
    if ($licJson) {
        try {
            $lic = $licJson | ConvertFrom-Json
            $fs = $lic.licences.faceswap
            if (-not $lic.exists) { Add-Result 'Licencia cambio de cara' skip 'no aceptada (se lee y acepta en Studio: Ajustes > Paquetes de IA)' }
            elseif (-not $lic.readable) { Add-Result 'Licencia cambio de cara' warn 'storage\consent\licences.json ilegible: aceptala de nuevo en Studio' }
            elseif ($fs.accepted) { Add-Result 'Licencia cambio de cara' ok ("aceptada ({0}, texto {1})" -f $fs.accepted_at, $fs.text_version) }
            elseif ($fs.text_version) { Add-Result 'Licencia cambio de cara' warn ("el texto cambio ({0} -> {1}): volve a leerla y aceptarla en Studio" -f $fs.text_version, $fs.current_version) }
            else { Add-Result 'Licencia cambio de cara' skip 'no aceptada (Ajustes > Paquetes de IA)' }
        } catch { Add-Result 'Licencia cambio de cara' warn 'espejo de licencias ilegible' }
    } else {
        Add-Result 'Licencia cambio de cara' warn 'models_cli --licences no respondio'
    }
    # RVC on CUDA (sprint 4): the torch of the workers venv must be the cu128 build to use the GPU.
    $rvcTorch = Get-CmdOutput $VenvPython @('-c', 'import torch; print(torch.__version__, torch.cuda.is_available())')
    if ($rvcTorch) {
        $rvcState = 'ok'
        $rvcText = "torch $rvcTorch (version, CUDA disponible)"
        if ((Get-EnvSetting 'USE_CUDA' 'false') -eq 'true' -and $rvcTorch -notmatch 'True$') {
            $rvcState = 'warn'
            $rvcText = "torch $rvcTorch sin CUDA con USE_CUDA=true: RVC corre en CPU (torch_cpu_build); setup.ps1 -Update -WithCuda"
        }
        Add-Result 'RVC (torch)' $rvcState $rvcText
    }
} else {
    Add-Result 'Herramientas aisladas' skip 'requiere apps\workers\.venv'
}
if (-not (Test-LongPaths)) {
    Write-Careful 'Rutas largas desactivadas: los entornos tools\*\.venv (torch, nvidia-*) pueden pasar 260 caracteres. Activalas o usa una ruta corta (C:\dev\studio).'
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

# ------------------------------------------------------------------ Ollama (Asistente local)
Write-Step 'Asistente local (Ollama)'
$agentModel = Get-EnvSetting 'AGENT_MODEL' 'qwen3:8b'
$ollamaExe = Find-OllamaExe
$ollamaVer = Get-OllamaVersion
if ($ollamaVer) {
    Add-Result 'Ollama' ok ("{0} en {1}" -f $ollamaVer, (Get-OllamaUrl))
    $tags = @(Get-OllamaTags)
    if ($tags.Count) { Write-Info ("modelos en Ollama: {0}" -f ($tags -join ', ')) }
    $want = $agentModel
    if ($want -notmatch ':') { $want = "${want}:latest" }
    if ($tags -contains $want) { Add-Result ("  modelo {0}" -f $agentModel) ok 'descargado (AGENT_MODEL)' }
    else { Add-Result ("  modelo {0}" -f $agentModel) skip 'no descargado: Ajustes > Asistente local (paquete agent-llm) o ollama pull' }
} elseif ($ollamaExe) {
    Add-Result 'Ollama' warn ("instalado ({0}) pero no responde en {1}: abri Ollama desde el menu Inicio" -f $ollamaExe, (Get-OllamaUrl))
} else {
    Add-Result 'Ollama' skip 'no instalado (setup.ps1 o winget install -e --id Ollama.Ollama); Asistente local deshabilitado'
}

# ------------------------------------------------------------------ Claude Code (Consola Claude)
Write-Step 'Consola Claude (Claude Code)'
$claudeExe = Find-ClaudeExe
$claudeVer = Get-ClaudeVersion $claudeExe
if ($claudeVer) {
    Add-Result 'Claude Code' ok ("{0}  {1}" -f $claudeVer, $claudeExe)
    # `claude auth status`: documented JSON + exit code (0 = logged in, 1 = not).
    $auth = Get-ClaudeAuthStatus $claudeExe
    if ($auth.LoggedIn -eq $true) {
        $method = $auth.Method
        if (-not $method) { $method = 'sesion' }
        $authState = 'ok'
        $authText = "sesion iniciada ($method)"
        if ($method -match 'api_key') {
            $authState = 'warn'
            $authText = "usa una API key ($method): Studio usa la suscripcion; corre claude auth login"
        }
        Add-Result '  inicio de sesion' $authState $authText
    } elseif ($auth.LoggedIn -eq $false) {
        Add-Result '  inicio de sesion' warn 'sin iniciar sesion: corre  claude auth login  (una vez, con tu cuenta de Claude.ai)'
    } else {
        Add-Result '  inicio de sesion' skip 'desconocido (version sin claude auth status): si la consola lo pide, escribi /login'
    }
} else {
    Add-Result 'Claude Code' skip 'no instalado: setup.ps1 (-WithClaude) o npm i -g @anthropic-ai/claude-code'
}
$mcpBuilt = Test-Path (Join-Path $RepoRoot 'packages\studio-mcp\dist\index.js')
$mcpJson = Test-Path (Join-Path $RepoRoot '.mcp.json')
if ($mcpBuilt -and $mcpJson) { Add-Result '  herramientas studio-mcp' ok '.mcp.json + packages\studio-mcp\dist' }
elseif (-not $mcpJson) { Add-Result '  herramientas studio-mcp' warn 'falta .mcp.json en la raiz del repo' }
else { Add-Result '  herramientas studio-mcp' warn 'sin compilar: pnpm build:packages (o setup.ps1)' }

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

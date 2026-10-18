#Requires -Version 5.1
<#
.SYNOPSIS
  Studio - verificador de la PC: mide en un solo paso lo que solo se puede medir en tu equipo.
.DESCRIPTION
  Con Studio abierto (scripts\windows\start.cmd), corre contra la API local:
    1. Test de rendimiento (perf.run): Whisper, Piper, RVC, escenas, recorte (RVM), Chatterbox,
       FaceFusion... lo que este instalado.
    2. Evaluar modelos, modo Rapida (agent.eval, 20 comandos del golden con Ollama).
    3. Separar voz y musica de 1 minuto (audio.stems, Demucs) con un audio generado con FFmpeg.
  Deja todo en storage\run\verificacion.json (y lo imprime): pegalo en el chat con Claude para
  cerrar los criterios "solo en la PC" (deuda #3, #4, #5, #7 y #9 del Sprint 6). No borra nada:
  el audio de prueba queda en Medios como "verificacion-stems-1min.wav".
.PARAMETER SinPerf
  No corre el Test de rendimiento.
.PARAMETER SinEval
  No corre Evaluar modelos.
.PARAMETER SinStems
  No corre la separacion de stems.
.PARAMETER TimeoutMin
  Minutos maximos por paso (default 30).
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\verificar-pc.ps1
#>
[CmdletBinding()]
param(
    [switch]$SinPerf,
    [switch]$SinEval,
    [switch]$SinStems,
    [int]$TimeoutMin = 30
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
Initialize-Console
Update-SessionPath

$Ports = Get-Ports
$Api = "http://127.0.0.1:$($Ports.Api)"
$Utf8 = New-Object System.Text.UTF8Encoding $false

function Invoke-Api([string]$Method, [string]$Route, $Body = $null) {
    $req = @{ Uri = "$Api$Route"; Method = $Method; UseBasicParsing = $true; TimeoutSec = 60 }
    if ($null -ne $Body) {
        $req.ContentType = 'application/json; charset=utf-8'
        $req.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 10 -Compress))
    }
    $r = Invoke-WebRequest @req
    if (-not $r.Content) { return $null }
    return ($r.Content | ConvertFrom-Json)
}

function Get-ApiErrorText($Err) {
    try {
        $resp = $Err.Exception.Response
        if ($resp) {
            $reader = New-Object IO.StreamReader($resp.GetResponseStream())
            $text = $reader.ReadToEnd()
            $json = $text | ConvertFrom-Json
            if ($json.error.message) { return "$($json.error.code): $($json.error.message)" }
            if ($json.message) { return "$($json.code): $($json.message)" }
            return $text
        }
    } catch { }
    return $Err.Exception.Message
}

function Wait-StudioJob([string]$JobId, [string]$Label) {
    $deadline = (Get-Date).AddMinutes($TimeoutMin)
    $last = ''
    while ($true) {
        $job = Invoke-Api 'GET' "/api/jobs/$JobId"
        if (@('succeeded', 'failed', 'canceled') -contains $job.status) { return $job }
        $stage = ''
        if ($job.detail -and $job.detail.stage_es) { $stage = $job.detail.stage_es }
        elseif ($job.message) { $stage = $job.message }
        $pct = [int]([double]$job.progress * 100)
        $line = "$Label $pct %  $stage"
        if ($job.detail -and $null -ne $job.detail.eta_s) { $line += "  (faltan ~$([int]$job.detail.eta_s) s)" }
        if ($line -ne $last) { Write-Info $line; $last = $line }
        if ((Get-Date) -gt $deadline) {
            try { Invoke-Api 'POST' "/api/jobs/$JobId/cancel" $null | Out-Null } catch { }
            throw "$Label no termino en $TimeoutMin min (cancelado)"
        }
        Start-Sleep -Seconds 2
    }
}

function Send-Upload([string]$File) {
    Add-Type -AssemblyName System.Net.Http
    $client = New-Object System.Net.Http.HttpClient
    $client.Timeout = [TimeSpan]::FromMinutes(5)
    $content = New-Object System.Net.Http.MultipartFormDataContent
    $stream = [IO.File]::OpenRead($File)
    try {
        $part = New-Object System.Net.Http.StreamContent($stream)
        $part.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse('audio/wav')
        $content.Add($part, 'file', [IO.Path]::GetFileName($File))
        $res = $client.PostAsync("$Api/api/media", $content).Result
        $text = $res.Content.ReadAsStringAsync().Result
        if (-not $res.IsSuccessStatusCode) { throw "Subida fallida ($([int]$res.StatusCode)): $text" }
        return ($text | ConvertFrom-Json)
    } finally {
        $stream.Dispose()
        $client.Dispose()
    }
}

$report = [ordered]@{
    version     = 1
    fecha       = (Get-Date).ToString('o')
    equipo      = $env:COMPUTERNAME
    gpu         = (Get-NvidiaGpuName)
    commit      = ''
    perf        = $null
    eval        = $null
    stems       = $null
    errores     = @()
}
try { $report.commit = (& git -C $script:RepoRoot rev-parse --short HEAD 2>$null) } catch { }

Write-Step 'Verificador de la PC (Studio)'
if (-not (Test-HttpOk "$Api/api/health" 5)) {
    Write-Bad "La API no responde en $Api. Abri Studio con scripts\windows\start.cmd y volve a correr esto."
    exit 1
}
Write-Good "API en $Api"

# ------------------------------------------------------------------ 1. Test de rendimiento
if (-not $SinPerf) {
    Write-Step '1/3 Test de rendimiento (puede tardar varios minutos)'
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try {
        $acc = Invoke-Api 'POST' '/api/ai/perf' @{}
        $job = Wait-StudioJob $acc.jobId 'Test de rendimiento'
        $perf = $null
        try { $perf = Invoke-Api 'GET' '/api/ai/perf' } catch { }
        $report.perf = [ordered]@{ status = $job.status; segundos = [math]::Round($sw.Elapsed.TotalSeconds, 1); error = $job.error; resultado = $perf }
        if ($job.status -eq 'succeeded') { Write-Good "Test de rendimiento listo ($([int]$sw.Elapsed.TotalSeconds) s)" }
        else { Write-Bad "Test de rendimiento: $($job.status) $($job.error)" }
    } catch {
        $msg = Get-ApiErrorText $_
        $report.perf = [ordered]@{ status = 'error'; error = $msg }
        $report.errores += "perf: $msg"
        Write-Bad "Test de rendimiento: $msg"
    }
}

# ------------------------------------------------------------------ 2. Evaluar modelos (Rapida)
if (-not $SinEval) {
    Write-Step '2/3 Evaluar modelos - Rapida (20 comandos con Ollama)'
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try {
        $acc = Invoke-Api 'POST' '/api/agent/eval' @{ dataset = 'golden'; mode = 'quick' }
        $job = Wait-StudioJob $acc.jobId 'Evaluar modelos'
        $report.eval = [ordered]@{ status = $job.status; segundos = [math]::Round($sw.Elapsed.TotalSeconds, 1); error = $job.error; resultado = $job.result }
        if ($job.status -eq 'succeeded') { Write-Good "Evaluacion lista ($([int]$sw.Elapsed.TotalSeconds) s; meta Rapida <= 180 s)" }
        else { Write-Bad "Evaluar modelos: $($job.status) $($job.error)" }
    } catch {
        $msg = Get-ApiErrorText $_
        $report.eval = [ordered]@{ status = 'error'; error = $msg }
        $report.errores += "eval: $msg"
        Write-Careful "Evaluar modelos: $msg (si falta Ollama o el modelo, instalalo en Ajustes y repeti)"
    }
}

# ------------------------------------------------------------------ 3. Stems de 1 minuto
if (-not $SinStems) {
    Write-Step '3/3 Separar voz y musica de 1 minuto (Demucs)'
    try {
        $ffmpeg = Find-FfmpegExe
        if (-not $ffmpeg) { throw 'No se encontro FFmpeg (corre setup.cmd)' }
        $tmp = Join-Path ([IO.Path]::GetTempPath()) 'verificacion-stems-1min.wav'
        # Two tones (voice-ish 220 Hz + "music" 660 Hz with a slow tremolo), 60 s stereo 44.1 kHz.
        $graph = 'sine=frequency=220:sample_rate=44100:duration=60[a];sine=frequency=660:sample_rate=44100:duration=60,tremolo=f=2[b];[a][b]amix=inputs=2,aformat=channel_layouts=stereo'
        & $ffmpeg -y -v error -f lavfi -i $graph $tmp
        if ($LASTEXITCODE -ne 0) { throw 'FFmpeg no pudo generar el audio de prueba' }
        $asset = Send-Upload $tmp
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $acc = Invoke-Api 'POST' '/api/audio/stems' @{ assetId = $asset.id; mode = 'two' }
        $job = Wait-StudioJob $acc.jobId 'Stems'
        $secs = [math]::Round($sw.Elapsed.TotalSeconds, 1)
        $device = $null
        if ($job.result -and $job.result.device) { $device = $job.result.device }
        $report.stems = [ordered]@{ status = $job.status; segundos = $secs; audio_s = 60; device = $device; meta_s = 60; error = $job.error; resultado = $job.result }
        if ($job.status -eq 'succeeded' -and $secs -lt 60) { Write-Good "Stems de 1 min en $secs s (meta < 60 s)" }
        elseif ($job.status -eq 'succeeded') { Write-Careful "Stems de 1 min en $secs s (meta < 60 s en GPU)" }
        else { Write-Bad "Stems: $($job.status) $($job.error)" }
    } catch {
        $msg = Get-ApiErrorText $_
        $report.stems = [ordered]@{ status = 'error'; error = $msg }
        $report.errores += "stems: $msg"
        Write-Careful "Stems: $msg (si falta el paquete, bajalo en Ajustes - Paquetes de IA)"
    }
}

# ------------------------------------------------------------------ report
$out = Join-Path (Get-RunDir) 'verificacion.json'
$json = $report | ConvertTo-Json -Depth 12
[IO.File]::WriteAllText($out, $json, $Utf8)
Write-Step 'Listo'
Write-Info "Resultado: $out"
Write-Info 'Copia el contenido de ese archivo y pegalo en el chat con Claude.'
try { Set-Clipboard -Value $json; Write-Good 'Copiado al portapapeles.' } catch { }
if ($report.errores.Count -gt 0) { exit 2 }
exit 0

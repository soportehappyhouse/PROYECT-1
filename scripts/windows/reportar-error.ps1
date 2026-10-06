#Requires -Version 5.1
<#
.SYNOPSIS
  Studio - reporte de error SIN la app: sirve aunque el dashboard o la API no arranquen.
.DESCRIPTION
  Junta en storage\reports\<yyyyMMdd-HHmmss>-<titulo>\ (y en un .zip al lado) todo lo que Claude
  necesita para reproducir y arreglar el problema:
    reporte.md     resumen legible con el bloque "Prompt para Claude" arriba
    reporte.json   lo mismo en formato maquina
    entorno.json   versiones (Windows, Node, pnpm, Python, FFmpeg, GPU, commit) y estado de servicios
    doctor.txt     salida completa de doctor.ps1
    jobs\          ultimos 20 trabajos de storage\studio.db (comando, stderr, tiempos)
    proyecto.json  ultimo proyecto guardado (rutas relativas, sin medios)
    logs\          ultimas 500 lineas de cada log de storage\logs
    env-redactado.txt  tu .env con las claves reemplazadas por [REDACTED]
  Abre la carpeta en el Explorador, imprime el "Prompt para Claude" y lo copia al portapapeles.
  Ver docs\REPORTAR-ERRORES.md.
.PARAMETER Titulo
  Titulo corto del problema (si falta, se pregunta).
.PARAMETER Pasos
  Que intentabas hacer, que esperabas y que paso (si falta, se pregunta).
.PARAMETER Severidad
  baja | media | alta | bloqueante (default media).
.PARAMETER SinDoctor
  No ejecuta doctor.ps1 (mas rapido).
.PARAMETER NoAbrir
  No abre el Explorador al terminar.
.PARAMETER NoInteractivo
  No pregunta nada (usa los parametros o valores por defecto).
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\reportar-error.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\reportar-error.ps1 -Titulo "No arranca la API" -Severidad bloqueante
#>
[CmdletBinding()]
param(
    [string]$Titulo = '',
    [string]$Pasos = '',
    [ValidateSet('baja', 'media', 'alta', 'bloqueante')][string]$Severidad = 'media',
    [switch]$SinDoctor,
    [switch]$NoAbrir,
    [switch]$NoInteractivo
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
Initialize-Console
Update-SessionPath

$Utf8 = New-Object System.Text.UTF8Encoding $false
$Redacted = '[REDACTED]'

# ------------------------------------------------------------------ redaction

# Values of secret-looking variables in .env are hidden literally everywhere (logs, doctor, db).
$SecretName = '[A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|authorization|auth[_-]?key|private[_-]?key|access[_-]?key|credential)[A-Za-z0-9_.-]*'
$script:SecretValues = @()
foreach ($kv in (Read-DotEnv).GetEnumerator()) {
    if ($kv.Key -match ('^' + $SecretName + '$') -and $kv.Value -and $kv.Value.Length -ge 6) {
        $script:SecretValues += $kv.Value
    }
}
$HomeDir = [Environment]::GetFolderPath('UserProfile')

function Protect-Text([string]$Text) {
    if (-not $Text) { return $Text }
    $out = $Text
    foreach ($s in $script:SecretValues) { $out = $out.Replace($s, $Redacted) }
    $rules = @(
        @('\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}', '$1 [REDACTED]'),
        @(('(?i)(["'']?' + $SecretName + '["'']?\s*[:=]\s*)(["'']?)(?!(?:null|true|false|undefined)\b)[^\s"'',;&}]+'), '$1$2[REDACTED]'),
        @('(?i)([?&](?:key|api_key|apikey|token|access_token|auth|sig|signature)=)[^&\s"'']+', '$1[REDACTED]'),
        @('\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}', '[REDACTED]'),
        @('\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}', '[REDACTED]'),
        @('\bgithub_pat_[A-Za-z0-9_]{20,}', '[REDACTED]'),
        @('\bxox[abposr]-[A-Za-z0-9-]{10,}', '[REDACTED]'),
        @('\bAKIA[0-9A-Z]{16}\b', '[REDACTED]'),
        @('\bAIza[0-9A-Za-z_-]{35}\b', '[REDACTED]'),
        @('\bhf_[A-Za-z0-9]{20,}', '[REDACTED]'),
        @('\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}', '[REDACTED]'),
        # Sprint 4: Personas registry paths (photos, voice samples, consent evidence) are hidden,
        # same rule as the api report (apps/api/src/reports/builder.ts).
        @('(?i)consent([\\/]+)(persons|archive)\1[^\s"''<>]*', 'consent/<oculto>')
    )
    foreach ($r in $rules) { $out = [regex]::Replace($out, $r[0], $r[1]) }
    if ($HomeDir -and $HomeDir.Length -gt 3) {
        $out = $out -ireplace [regex]::Escape($HomeDir), '~'
        $out = $out -ireplace [regex]::Escape($HomeDir.Replace('\', '\\')), '~'
        $out = $out -ireplace [regex]::Escape($HomeDir.Replace('\', '/')), '~'
    }
    return $out
}

function Protect-EnvText([string]$Text) {
    $lines = New-Object System.Collections.ArrayList
    foreach ($line in ($Text -split "`r?`n")) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $name = $Matches[1]
            $value = $Matches[2].Trim()
            if ($name -match ('^' + $SecretName + '$') -and $value -and $value -ne '""' -and $value -ne "''") {
                [void]$lines.Add("$name=$Redacted")
                continue
            }
        }
        [void]$lines.Add((Protect-Text $line))
    }
    return ($lines -join "`n")
}

# ------------------------------------------------------------------ file helpers

$script:Files = New-Object System.Collections.ArrayList

function Write-ReportText([string]$Relative, [string]$Text) {
    $path = Join-Path $script:ReportDir ($Relative -replace '/', '\')
    $parent = Split-Path $path -Parent
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    [IO.File]::WriteAllText($path, (Protect-Text $Text), $Utf8)
    [void]$script:Files.Add($Relative)
}

function Write-ReportJson([string]$Relative, $Value) {
    Write-ReportText $Relative ((ConvertTo-Json -InputObject $Value -Depth 12) + "`n")
}

function Get-Slug([string]$Text) {
    $norm = $Text.Normalize([Text.NormalizationForm]::FormD)
    $sb = New-Object System.Text.StringBuilder
    foreach ($ch in $norm.ToCharArray()) {
        if ([Globalization.CharUnicodeInfo]::GetUnicodeCategory($ch) -ne [Globalization.UnicodeCategory]::NonSpacingMark) { [void]$sb.Append($ch) }
    }
    $slug = ($sb.ToString().ToLowerInvariant() -replace '[^a-z0-9]+', '-').Trim('-')
    if ($slug.Length -gt 40) { $slug = $slug.Substring(0, 40).Trim('-') }
    if (-not $slug) { $slug = 'reporte' }
    return $slug
}

function Get-TailLines([string]$Path, [int]$Count) {
    try {
        $fs = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
        try {
            $max = [Math]::Min($fs.Length, 2MB)
            [void]$fs.Seek(-$max, 'End')
            $buf = New-Object byte[] $max
            $read = $fs.Read($buf, 0, $max)
            $text = $Utf8.GetString($buf, 0, $read)
        } finally { $fs.Dispose() }
        $lines = @($text -split "`r?`n")
        if ($max -lt (Get-Item $Path).Length -and $lines.Count -gt 1) { $lines = $lines[1..($lines.Count - 1)] }
        $lines = @($lines | Where-Object { $_ -ne '' })
        if ($lines.Count -gt $Count) { $lines = $lines[($lines.Count - $Count)..($lines.Count - 1)] }
        return $lines
    } catch { return @() }
}

# ------------------------------------------------------------------ questions

Write-Host 'Studio - reporte de error (modo sin conexion)' -ForegroundColor White
if (-not $Titulo -and -not $NoInteractivo) {
    $Titulo = Read-Host 'Titulo corto del problema (ej.: "start.ps1 no levanta la API")'
}
if (-not $Titulo) { $Titulo = 'Error sin titulo' }
if (-not $Pasos -and -not $NoInteractivo) {
    Write-Host 'Que intentabas hacer? Escribi los pasos, que esperabas y que paso.' -ForegroundColor Cyan
    Write-Host '(una linea por paso; Enter en una linea vacia para terminar)' -ForegroundColor Gray
    $lines = @()
    $n = 1
    while ($true) {
        $line = Read-Host ("  {0}" -f $n)
        if (-not $line) { break }
        $lines += ("{0}. {1}" -f $n, $line)
        $n++
    }
    $Pasos = $lines -join "`n"
}
if (-not $PSBoundParameters.ContainsKey('Severidad') -and -not $NoInteractivo) {
    $ans = Read-Host 'Severidad: 1=baja 2=media 3=alta 4=bloqueante (Enter = media)'
    switch ($ans) { '1' { $Severidad = 'baja' } '3' { $Severidad = 'alta' } '4' { $Severidad = 'bloqueante' } default { $Severidad = 'media' } }
}
$SeverityMap = @{ baja = 'low'; media = 'medium'; alta = 'high'; bloqueante = 'blocker' }
$SeverityLabel = @{
    baja = 'Baja (molestia menor)'; media = 'Media (hay un rodeo)'
    alta = 'Alta (no puedo terminar lo que hacia)'; bloqueante = 'Bloqueante (la app no sirve)'
}

# ------------------------------------------------------------------ folder

$storage = Get-StorageDir
$reportsRoot = Join-Path $storage 'reports'
$now = Get-Date
$baseId = '{0}-{1}' -f $now.ToString('yyyyMMdd-HHmmss'), (Get-Slug $Titulo)
$ReportId = $baseId
$i = 2
while ((Test-Path (Join-Path $reportsRoot $ReportId)) -or (Test-Path (Join-Path $reportsRoot "$ReportId.zip"))) {
    $ReportId = "$baseId-$i"
    $i++
}
$script:ReportDir = Join-Path $reportsRoot $ReportId
New-Item -ItemType Directory -Force -Path $script:ReportDir | Out-Null
$ZipPath = Join-Path $reportsRoot "$ReportId.zip"
Write-Step "Creando $script:ReportDir"

# ------------------------------------------------------------------ doctor

$doctorFailures = @()
if (-not $SinDoctor) {
    Write-Step 'Ejecutando doctor.ps1 (puede tardar un minuto)'
    $psExe = (Get-Process -Id $PID).Path
    $ErrorActionPreference = 'Continue'
    $doctorOut = & $psExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'doctor.ps1') 2>&1 | Out-String -Width 200
    $ErrorActionPreference = 'Stop'
    Write-ReportText 'doctor.txt' $doctorOut
    $failMark = Get-Mark fail
    $doctorFailures = @($doctorOut -split "`r?`n" | Where-Object { $_.Contains($failMark) } | ForEach-Object { $_.Trim() })
    Write-Good ("doctor.txt ({0} problemas marcados)" -f $doctorFailures.Count)
}

# ------------------------------------------------------------------ environment

Write-Step 'Versiones y servicios'
$node = Get-CmdOutput 'node' @('--version')
$pnpm = Get-CmdOutput 'pnpm' @('--version')
$python = $null
if (Test-Path $VenvPython) { $python = Get-CmdOutput $VenvPython @('--version') }
$ffmpegExe = Find-FfmpegExe
$ffmpeg = $null
if ($ffmpegExe) { $ffmpeg = Get-CmdOutput $ffmpegExe @('-hide_banner', '-version') }
$git = [ordered]@{ source = 'desconocido' }
$versionFile = Join-Path $RepoRoot 'VERSION'
if (Test-Path $versionFile) {
    $git = [ordered]@{ source = 'VERSION'; commit = ([IO.File]::ReadAllText($versionFile)).Trim() }
} elseif (Test-Cmd 'git') {
    $commit = Get-CmdOutput 'git' @('-C', $RepoRoot, 'rev-parse', 'HEAD')
    if ($commit) {
        $ErrorActionPreference = 'Continue'
        $dirty = @(& git -C $RepoRoot status --porcelain 2>$null).Count
        $ErrorActionPreference = 'Stop'
        $git = [ordered]@{
            source = 'git'; commit = $commit
            branch = (Get-CmdOutput 'git' @('-C', $RepoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'))
            dirtyFiles = $dirty
        }
    }
}
$osCaption = "$([Environment]::OSVersion.VersionString)"
$cpu = $null
$ramGb = $null
try {
    $osInfo = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    $osCaption = "{0} {1} (build {2})" -f $osInfo.Caption, $osInfo.Version, $osInfo.BuildNumber
    $ramGb = [math]::Round($osInfo.TotalVisibleMemorySize / 1MB, 1)
} catch { }
try { $cpu = (Get-CimInstance Win32_Processor -ErrorAction Stop | Select-Object -First 1).Name } catch { }
$gpus = @()
try { $gpus = @(Get-CimInstance Win32_VideoController -ErrorAction Stop | ForEach-Object { "{0} (driver {1})" -f $_.Name, $_.DriverVersion }) } catch { }
$nvidia = $null
if (Test-Cmd 'nvidia-smi') { $nvidia = Get-CmdOutput 'nvidia-smi' @('--query-gpu=name,driver_version,memory.total', '--format=csv,noheader') }
$ports = Get-Ports
$services = [ordered]@{}
foreach ($s in @(
        @('workers', "http://127.0.0.1:$($ports.Workers)/health"),
        @('api', "http://127.0.0.1:$($ports.Api)/api/health"),
        @('web', "http://127.0.0.1:$($ports.Web)/"))) {
    $services[$s[0]] = [ordered]@{ url = $s[1]; ok = (Test-HttpOk $s[1] 3) }
}
$workersHealth = $null
if ($services['workers'].ok) {
    try { $workersHealth = Invoke-RestMethod -Uri $services['workers'].url -TimeoutSec 5 } catch { }
}
$envMap = Read-DotEnv
$entorno = [ordered]@{
    collectedAt = (Get-Date).ToUniversalTime().ToString('o')
    origen = 'scripts/windows/reportar-error.ps1'
    git = $git
    os = [ordered]@{ caption = $osCaption; is64 = [Environment]::Is64BitOperatingSystem; cpu = $cpu; cpuCount = [Environment]::ProcessorCount; memoryGb = $ramGb; powershell = "$($PSVersionTable.PSVersion)" }
    versions = [ordered]@{ node = $node; pnpm = $pnpm; python = $python; ffmpeg = $ffmpeg; ffmpegPath = $ffmpegExe }
    gpu = [ordered]@{ nvidiaSmi = $nvidia; adapters = $gpus; useCuda = (Get-EnvSetting 'USE_CUDA' 'false') }
    services = $services
    workersHealth = $workersHealth
    config = [ordered]@{
        storageDir = $storage; modelsDir = (Get-ModelsDir); ports = $ports
        hwEncoder = (Get-EnvSetting 'HW_ENCODER' 'auto'); logLevel = (Get-EnvSetting 'LOG_LEVEL' 'info')
        envFile = (Test-Path $EnvFile)
    }
}
Write-ReportJson 'entorno.json' $entorno
Write-Good 'entorno.json'

# ------------------------------------------------------------------ .env (redacted)

if (Test-Path $EnvFile) {
    Write-ReportText 'env-redactado.txt' (Protect-EnvText ([IO.File]::ReadAllText($EnvFile)))
    Write-Good 'env-redactado.txt (claves ocultas)'
}

# ------------------------------------------------------------------ logs

Write-Step 'Logs (ultimas 500 lineas)'
$logsDir = Join-Path $storage 'logs'
$logErrors = @()
if (Test-Path $logsDir) {
    $recentLogs = @(Get-ChildItem -Path $logsDir -Filter '*.log' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Length -gt 0 -and $_.LastWriteTime -gt (Get-Date).AddDays(-3) } |
        Sort-Object LastWriteTime -Descending | Select-Object -First 10)
    foreach ($f in $recentLogs) {
        $tail = @(Get-TailLines $f.FullName 500)
        Write-ReportText ("logs/" + $f.Name) (($tail -join "`n") + "`n")
        $logErrors += @($tail | Where-Object { $_ -match '"level":\s*(50|60)\b' -or $_ -match '(?i)\b(error|exception|traceback)\b' } | Select-Object -Last 5 | ForEach-Object { "$($f.Name): $_" })
        Write-Good ("logs\{0}" -f $f.Name)
    }
} else {
    Write-Careful 'storage\logs no existe (la API nunca arranco o STORAGE_DIR es otro)'
}

# ------------------------------------------------------------------ jobs + project from SQLite

Write-Step 'Trabajos y proyecto (storage\studio.db)'
$dbPath = Join-Path $storage 'studio.db'
$dbData = $null
$dbNote = ''
if (Test-Path $dbPath) {
    $tmpJson = Join-Path $script:ReportDir '_db.json'
    if (Test-Cmd 'node') {
        $dbScript = Join-Path ([IO.Path]::GetTempPath()) 'studio-report-db.mjs'
        $code = @'
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const [apiPkg, dbPath, outPath] = process.argv.slice(2);
const require = createRequire(apiPkg);
const Database = require("better-sqlite3");
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const parse = (v) => { try { return JSON.parse(v); } catch { return v; } };
const jobs = db.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 20").all().map((r) => {
  for (const k of ["payload", "result", "diagnostics"]) if (typeof r[k] === "string") r[k] = parse(r[k]);
  if (typeof r.log_tail === "string") r.log_tail = r.log_tail.split("\n");
  return r;
});
let project = null;
try {
  const p = db.prepare("SELECT id, data, updated_at FROM projects ORDER BY updated_at DESC LIMIT 1").get();
  if (p) project = { id: p.id, updatedAt: p.updated_at, project: parse(p.data) };
} catch {}
writeFileSync(outPath, JSON.stringify({ via: "node", jobs, project }));
'@
        [IO.File]::WriteAllText($dbScript, $code, $Utf8)
        $ErrorActionPreference = 'Continue'
        & node $dbScript (Join-Path $RepoRoot 'apps\api\package.json') $dbPath $tmpJson 2>&1 | Out-Null
        $ErrorActionPreference = 'Stop'
        Remove-Item $dbScript -Force -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path $tmpJson) -and (Test-Cmd 'sqlite3')) {
        $ErrorActionPreference = 'Continue'
        $rows = & sqlite3 -readonly -json $dbPath 'SELECT * FROM jobs ORDER BY created_at DESC LIMIT 20;' 2>$null | Out-String
        $ErrorActionPreference = 'Stop'
        if ($rows.Trim()) {
            [IO.File]::WriteAllText($tmpJson, ('{"via":"sqlite3","jobs":' + $rows.Trim() + ',"project":null}'), $Utf8)
        }
    }
    if (Test-Path $tmpJson) {
        try { $dbData = Get-Content -Raw -Encoding UTF8 $tmpJson | ConvertFrom-Json } catch { $dbData = $null }
        Remove-Item $tmpJson -Force -ErrorAction SilentlyContinue
    }
    if (-not $dbData) {
        # Sprint 4: the database is never copied whole any more. Besides projects and jobs it holds
        # the Personas registry (names, consents, licence acceptances, consent_audit), which never
        # leaves the PC (docs/trabajo/sprint4-contratos.md, rule 6).
        $dbNote = 'No se pudo leer la base con node ni sqlite3: no se adjuntan trabajos (la base no se copia: tiene el registro de Personas).'
        Write-Careful $dbNote
    }
} else {
    $dbNote = 'storage\studio.db no existe (la API nunca arranco).'
    Write-Careful $dbNote
}

$failedJobs = @()
if ($dbData) {
    $recent = @($dbData.jobs | ForEach-Object {
            [ordered]@{ id = $_.id; type = $_.type; status = $_.status; createdAt = $_.created_at; startedAt = $_.started_at; finishedAt = $_.finished_at; error = $_.error }
        })
    Write-ReportJson 'jobs/recientes.json' $recent
    foreach ($j in @($dbData.jobs | Where-Object { $_.status -eq 'failed' } | Select-Object -First 10)) {
        Write-ReportJson ("jobs/{0}.json" -f $j.id) $j
        $failedJobs += $j
    }
    if ($dbData.project) {
        Write-ReportJson 'proyecto.json' ([ordered]@{ source = 'guardado'; updatedAt = $dbData.project.updatedAt; project = $dbData.project.project })
    }
    Write-Good ("{0} trabajos recientes, {1} fallidos" -f @($dbData.jobs).Count, $failedJobs.Count)
}

# ------------------------------------------------------------------ prompt + reporte.md / reporte.json

$relDir = $script:ReportDir
$relZip = $ZipPath
if ($script:ReportDir.StartsWith($RepoRoot, [StringComparison]::OrdinalIgnoreCase)) {
    $relDir = $script:ReportDir.Substring($RepoRoot.Length).TrimStart('\', '/') -replace '\\', '/'
    $relZip = $ZipPath.Substring($RepoRoot.Length).TrimStart('\', '/') -replace '\\', '/'
}
$listed = @($script:Files) + @('reporte.json', 'reporte.md', 'doctor.txt') | Sort-Object -Unique
if ($SinDoctor) { $listed = @($listed | Where-Object { $_ -ne 'doctor.txt' }) }

$p = New-Object System.Collections.ArrayList
[void]$p.Add('Hola Claude. Encontre un error en Studio (este repo). Reproducilo con los datos de abajo, encontra la causa y arreglalo con un test que lo cubra. Este reporte se genero con scripts/windows/reportar-error.ps1 (la app no estaba disponible o no se pudo usar el boton).')
[void]$p.Add('')
[void]$p.Add('## Contexto')
[void]$p.Add("- Reporte: $ReportId - '$Titulo'")
[void]$p.Add("- Severidad: $($SeverityLabel[$Severidad])")
[void]$p.Add("- Fecha: $($now.ToString('yyyy-MM-dd HH:mm:ss'))")
$commitText = 'commit desconocido'
if ($git.commit) { $commitText = "commit $($git.commit)"; if ($git.branch) { $commitText += " (rama $($git.branch))" } }
[void]$p.Add("- Studio, $commitText")
[void]$p.Add("- Sistema: $osCaption, PowerShell $($PSVersionTable.PSVersion), $([Environment]::ProcessorCount) CPU, $ramGb GB RAM")
$pyText = 'Python ?'
if ($python) { $pyText = $python }
$ffText = 'FFmpeg NO encontrado'
if ($ffmpeg) { $ffText = $ffmpeg -replace '\s+Copyright.*$', '' }
[void]$p.Add("- Node $node - pnpm $pnpm - $pyText - $ffText")
$gpuText = 'desconocida'
if ($nvidia) { $gpuText = $nvidia } elseif ($gpus.Count) { $gpuText = $gpus -join '; ' }
[void]$p.Add("- GPU: $gpuText (USE_CUDA=$(Get-EnvSetting 'USE_CUDA' 'false'))")
$svcText = @($services.Keys | ForEach-Object { if ($services[$_].ok) { "$_ ok" } else { "$_ NO responde" } }) -join ' - '
[void]$p.Add("- Servicios: $svcText")
[void]$p.Add('')
[void]$p.Add('## Pasos (lo que hacia el usuario)')
if ($Pasos) { [void]$p.Add($Pasos) } else { [void]$p.Add('(no los escribio)') }
[void]$p.Add('')
[void]$p.Add('## Error')
$anyError = $false
foreach ($j in @($failedJobs | Select-Object -First 3)) {
    $anyError = $true
    [void]$p.Add("- Trabajo $($j.id) ($($j.type)) fallo: $($j.error)")
    $cmds = @()
    if ($j.diagnostics -and $j.diagnostics.commands) { $cmds = @($j.diagnostics.commands) }
    if ($cmds.Count) { [void]$p.Add(('  Comando: `{0}` (salida: {1})' -f $cmds[-1].command, $cmds[-1].exitCode)) }
    $tail = @()
    if ($j.diagnostics -and $j.diagnostics.stderrTail) { $tail = @($j.diagnostics.stderrTail) } elseif ($j.log_tail) { $tail = @($j.log_tail) }
    if ($tail.Count) {
        if ($tail.Count -gt 25) { $tail = $tail[($tail.Count - 25)..($tail.Count - 1)] }
        [void]$p.Add('  Ultimas lineas de stderr/log:')
        [void]$p.Add('  ```')
        foreach ($l in $tail) { [void]$p.Add("  $l") }
        [void]$p.Add('  ```')
    }
}
foreach ($l in @($doctorFailures | Select-Object -First 10)) { $anyError = $true; [void]$p.Add("- doctor: $l") }
foreach ($l in @($logErrors | Select-Object -Last 8)) {
    $anyError = $true
    if ($l.Length -gt 400) { $l = $l.Substring(0, 400) + '...' }
    [void]$p.Add("- log: $l")
}
if ($dbNote) { [void]$p.Add("- Nota: $dbNote") }
if (-not $anyError) { [void]$p.Add('- No se encontro un error tecnico: ver pasos, doctor.txt y logs/.') }
[void]$p.Add('')
[void]$p.Add('## Archivos adjuntos')
[void]$p.Add("- Carpeta: $relDir/  (zip: $relZip)")
foreach ($f in $listed) { [void]$p.Add("  - $f") }
$startWith = 'reporte.json y jobs/*.json'
if (-not $SinDoctor) { $startWith = 'reporte.json, doctor.txt y jobs/*.json' }
[void]$p.Add("- Empeza por $startWith; entorno.json tiene las versiones; logs/ las ultimas 500 lineas de cada log.")
[void]$p.Add('- Si no podes leer esa carpeta, pedime que adjunte el .zip.')
$prompt = Protect-Text ($p -join "`n")

$md = New-Object System.Collections.ArrayList
[void]$md.Add("# Reporte de error - $Titulo")
[void]$md.Add('')
[void]$md.Add("- **Id:** ``$ReportId``")
[void]$md.Add("- **Fecha:** $($now.ToString('yyyy-MM-dd HH:mm:ss'))")
[void]$md.Add("- **Severidad:** $($SeverityLabel[$Severidad])")
[void]$md.Add("- **Carpeta:** ``$relDir`` - **Zip:** ``$relZip``")
[void]$md.Add('')
[void]$md.Add('## Prompt para Claude')
[void]$md.Add('')
[void]$md.Add('Copia el bloque completo y pegalo en la sesion de Claude Code de este repo (si la sesion no ve tu disco, adjunta tambien el .zip).')
[void]$md.Add('')
[void]$md.Add('````text')
[void]$md.Add($prompt)
[void]$md.Add('````')
[void]$md.Add('')
[void]$md.Add('## Privacidad')
[void]$md.Add('')
[void]$md.Add('Las claves de .env y todo lo que parece un token se reemplazaron por `[REDACTED]`, y tu carpeta de usuario por `~`. No se copian videos ni audios. Revisa doctor.txt y logs/ antes de compartir.')
[void]$md.Add('')
$markdown = $md -join "`n"

$reporte = [ordered]@{
    schemaVersion = 1
    id = $ReportId
    title = $Titulo
    severity = $SeverityMap[$Severidad]
    createdAt = $now.ToUniversalTime().ToString('o')
    origen = 'scripts/windows/reportar-error.ps1'
    steps = $Pasos
    includeMedia = $false
    jobIds = @($failedJobs | ForEach-Object { $_.id })
    doctorFailures = $doctorFailures
    logErrors = $logErrors
    files = $listed
    prompt = $prompt
}
Write-ReportJson 'reporte.json' $reporte
Write-ReportText 'reporte.md' $markdown

# ------------------------------------------------------------------ zip + explorer + console

Write-Step 'Comprimiendo'
try {
    if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
    Compress-Archive -Path $script:ReportDir -DestinationPath $ZipPath -CompressionLevel Optimal
    Write-Good $ZipPath
} catch {
    Write-Bad ("No se pudo crear el zip: {0}" -f $_.Exception.Message)
}

Write-Host ''
Write-Host ('=' * 78)
Write-Host ' PROMPT PARA CLAUDE (copialo y pegalo en la sesion de Claude Code del repo)' -ForegroundColor Cyan
Write-Host ('=' * 78)
Write-Host $prompt
Write-Host ('=' * 78)
$copied = $false
try {
    if (Get-Command Set-Clipboard -ErrorAction SilentlyContinue) {
        Set-Clipboard -Value $prompt
        $copied = $true
    }
} catch { }
if ($copied) { Write-Good 'El prompt ya esta copiado en el portapapeles (Ctrl+V para pegarlo).' }
Write-Info "Carpeta: $script:ReportDir"
Write-Info "Zip:     $ZipPath"
Write-Info 'Antes de compartirlo revisa doctor.txt y logs\ (ver docs\REPORTAR-ERRORES.md, seccion Privacidad).'

if (-not $NoAbrir -and $env:OS -eq 'Windows_NT') {
    try {
        if (Test-Path $ZipPath) { Start-Process explorer.exe -ArgumentList "/select,`"$ZipPath`"" }
        else { Start-Process explorer.exe -ArgumentList "`"$script:ReportDir`"" }
    } catch { }
}
exit 0

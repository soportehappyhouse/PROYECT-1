#Requires -Version 5.1
<#
.SYNOPSIS
  Studio - levanta workers (8001), API (3001) y dashboard (3000), espera a que respondan y abre
  el navegador.
.DESCRIPTION
  Por defecto cada servicio corre en su propia ventana de PowerShell (cerrarla lo detiene).
  Con -SingleConsole corren ocultos y sus logs se muestran aqui con prefijo [workers]/[api]/[web];
  Ctrl+C detiene todo. stop.ps1 detiene los servicios en ambos modos.
  Puertos: WEB_PORT / API_PORT / WORKERS_PORT de .env. Todo escucha en 127.0.0.1.
.PARAMETER Dev
  Modo desarrollo con recarga en caliente (next dev + tsx watch + uvicorn --reload).
.PARAMETER SingleConsole
  Una sola consola con logs prefijados (en vez de tres ventanas).
.PARAMETER NoBrowser
  No abre el navegador.
.PARAMETER TimeoutSec
  Espera maxima por servicio (default 180).
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\start.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\start.ps1 -Dev -SingleConsole
#>
[CmdletBinding()]
param(
    [switch]$Dev,
    [switch]$SingleConsole,
    [switch]$NoBrowser,
    [int]$TimeoutSec = 180
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
Initialize-Console
Update-SessionPath

# ============================================================================ 1. checks
Write-Step 'Verificando requisitos'
$missing = @()
if (-not (Test-Path $EnvFile)) { $missing += '.env (corre setup.ps1)' }
if (-not (Test-Cmd 'node')) { $missing += 'Node.js 22' }
if (-not (Test-Cmd 'pnpm')) { $missing += 'pnpm 12' }
if (-not (Test-Path $VenvPython)) { $missing += 'apps\workers\.venv' }
if (-not (Test-Path (Join-Path $RepoRoot 'node_modules'))) { $missing += 'node_modules (pnpm install)' }
if ($missing.Count -gt 0) {
    Write-Bad ('Falta: ' + ($missing -join ', '))
    Write-Host 'Ejecuta primero: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\setup.ps1'
    exit 1
}
if (-not (Find-FfmpegExe)) { Write-Careful 'FFmpeg no encontrado: importar/exportar fallara (ver doctor.ps1).' }

Import-DotEnvToProcess
$ports = Get-Ports
$logs = Join-Path (Get-StorageDir) 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$runDir = Get-RunDir
$pidFile = Join-Path $runDir 'pids.json'

if (-not $Dev) {
    # Same rule as setup.ps1: rebuild only when the code, the lockfile or the build-relevant .env
    # values (NEXT_PUBLIC_*, ports) changed since the last build (content hash, not dates).
    $build = Get-WebBuildState
    if (-not $build.Fresh) {
        Write-Step "Compilando (pnpm build): $($build.Reason)"
        Invoke-Native 'pnpm' @('build')
        Save-WebBuildStamp
    }
}

# ============================================================================ 2. services
$pnpmExe = Resolve-NativeExe 'pnpm'
$services = @(
    [pscustomobject]@{
        Name = 'workers'; Port = $ports.Workers; Color = 'Green'; Cwd = $WorkersDir
        Health = "http://127.0.0.1:$($ports.Workers)/health"
        Exe = $VenvPython
        DevArgs = @('-m', 'uvicorn', 'studio_workers.main:app', '--host', '127.0.0.1', '--port', "$($ports.Workers)", '--reload')
        ProdArgs = @('-m', 'studio_workers')
    },
    [pscustomobject]@{
        Name = 'api'; Port = $ports.Api; Color = 'Cyan'; Cwd = $RepoRoot
        Health = "http://127.0.0.1:$($ports.Api)/api/health"
        Exe = $pnpmExe
        DevArgs = @('--filter', '@studio/api', 'dev')
        ProdArgs = @('--filter', '@studio/api', 'start')
    },
    [pscustomobject]@{
        Name = 'web'; Port = $ports.Web; Color = 'Magenta'; Cwd = $RepoRoot
        Health = "http://127.0.0.1:$($ports.Web)/"
        Exe = $pnpmExe
        # -H 127.0.0.1: loopback only (no Windows Firewall prompt).
        DevArgs = @('--filter', '@studio/web', 'exec', 'next', 'dev', '-H', '127.0.0.1', '-p', "$($ports.Web)")
        ProdArgs = @('--filter', '@studio/web', 'exec', 'next', 'start', '-H', '127.0.0.1', '-p', "$($ports.Web)")
    }
)

Write-Step 'Puertos'
$toStart = @()
foreach ($s in $services) {
    $owner = Get-PortOwner $s.Port
    if ($owner) {
        if (Test-HttpOk $s.Health 3) {
            Write-Good ("{0} ya esta corriendo en :{1} (PID {2})" -f $s.Name, $s.Port, $owner)
            continue
        }
        Write-Bad ("El puerto {0} esta ocupado por otro programa (PID {1}). Cambialo en .env o cerralo." -f $s.Port, $owner)
        Write-Info 'Puertos reservados por Hyper-V/WSL: netsh interface ipv4 show excludedportrange protocol=tcp'
        exit 1
    }
    $toStart += $s
}

$mode = 'produccion'
if ($Dev) { $mode = 'desarrollo (hot reload)' }
Write-Step "Iniciando servicios en modo $mode"
$started = @()
foreach ($s in $toStart) {
    $argsList = $s.ProdArgs
    if ($Dev) { $argsList = $s.DevArgs }
    if ($SingleConsole) {
        $out = Join-Path $logs "$($s.Name).log"
        $err = Join-Path $logs "$($s.Name).err.log"
        # cmd /c lets CreateProcess run .cmd shims (pnpm.cmd) with redirected output.
        $cmdLine = '"' + $s.Exe + '" ' + ($argsList -join ' ')
        $p = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d', '/s', '/c', "`"$cmdLine`"") `
            -WorkingDirectory $s.Cwd -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $out -RedirectStandardError $err
    } else {
        $title = "Studio $($s.Name) :$($s.Port)"
        $quoted = ($argsList | ForEach-Object { ConvertTo-PsLiteral $_ }) -join ' '
        $inner = "`$Host.UI.RawUI.WindowTitle = $(ConvertTo-PsLiteral $title); " +
            "Set-Location -LiteralPath $(ConvertTo-PsLiteral $s.Cwd); & $(ConvertTo-PsLiteral $s.Exe) $quoted"
        $p = Start-Process -FilePath 'powershell.exe' -PassThru -WorkingDirectory $s.Cwd `
            -ArgumentList @('-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $inner)
    }
    Write-Info ("{0}: PID {1}" -f $s.Name, $p.Id)
    $started += [pscustomobject]@{ name = $s.Name; pid = $p.Id; port = $s.Port }
}
$previous = @()
if (Test-Path $pidFile) {
    try { $previous = @((Get-Content $pidFile -Raw | ConvertFrom-Json) | ForEach-Object { $_ }) } catch { $previous = @() }
}
$all = @($previous | Where-Object { $toStart.Name -notcontains $_.name }) + $started
ConvertTo-Json -InputObject @($all) | Set-Content -Path $pidFile -Encoding UTF8

# ============================================================================ 3. health + browser
function Show-NewLogLines {
    param([hashtable]$Offsets)
    foreach ($s in $toStart) {
        foreach ($file in @((Join-Path $logs "$($s.Name).log"), (Join-Path $logs "$($s.Name).err.log"))) {
            if (-not (Test-Path $file)) { continue }
            $fs = $null
            try {
                $fs = [IO.File]::Open($file, 'Open', 'Read', 'ReadWrite')
                $pos = 0L
                if ($Offsets.ContainsKey($file)) { $pos = $Offsets[$file] }
                if ($fs.Length -lt $pos) { $pos = 0L }
                [void]$fs.Seek($pos, 'Begin')
                $reader = New-Object IO.StreamReader($fs)
                $text = $reader.ReadToEnd()
                $Offsets[$file] = $fs.Length
                foreach ($line in ($text -split "`r?`n")) {
                    if ($line.Trim()) { Write-Host ("[{0}] {1}" -f $s.Name, $line) -ForegroundColor $s.Color }
                }
            } catch { } finally { if ($fs) { $fs.Dispose() } }
        }
    }
}

Write-Step 'Esperando a que respondan los servicios'
$offsets = @{}
$healthy = @{}
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline -and $healthy.Count -lt $services.Count) {
    foreach ($s in $services) {
        if (-not $healthy.ContainsKey($s.Name) -and (Test-HttpOk $s.Health 3)) {
            $healthy[$s.Name] = $true
            Write-Good ("{0} OK -> {1}" -f $s.Name, $s.Health)
        }
    }
    if ($SingleConsole) { Show-NewLogLines $offsets }
    Start-Sleep -Milliseconds 1500
}
foreach ($s in $services) {
    if ($healthy.ContainsKey($s.Name)) { Add-Result $s.Name ok $s.Health }
    else { Add-Result $s.Name fail ("sin respuesta en {0}s (revisa su ventana o storage\logs)" -f $TimeoutSec) }
}
if ($healthy.ContainsKey('api')) {
    # Incremental: unchanged files are skipped; new files dropped into storage\library get indexed.
    try {
        $scan = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($ports.Api)/api/library/scan" -TimeoutSec 300
        Add-Result 'biblioteca de sonidos' ok ("{0} archivos ({1} nuevos)" -f $scan.scanned, $scan.added)
    } catch {
        Add-Result 'biblioteca de sonidos' warn 'no se pudo indexar storage\library'
    }
}
$url = "http://localhost:$($ports.Web)"
Show-Results "Studio - $url"
if (-not $NoBrowser -and $healthy.ContainsKey('web')) { Start-Process $url }

if (-not $SingleConsole) {
    Write-Host 'Los servicios siguen en sus ventanas. Para detenerlos: scripts\windows\stop.ps1'
    if ((Get-FailedCount) -gt 0) { exit 1 }
    exit 0
}

# ============================================================================ 4. single console loop
Write-Host 'Logs en vivo (Ctrl+C detiene todo)...' -ForegroundColor White
try {
    while ($true) {
        Show-NewLogLines $offsets
        $alive = @($started | Where-Object { Get-Process -Id $_.pid -ErrorAction SilentlyContinue })
        if ($alive.Count -lt $started.Count) {
            Write-Bad 'Un servicio termino; deteniendo el resto.'
            Show-NewLogLines $offsets
            break
        }
        Start-Sleep -Milliseconds 700
    }
} finally {
    foreach ($s in $started) { Stop-ProcessTree $s.pid }
    if (Test-Path $pidFile) { Remove-Item $pidFile -Force }
    Write-Host 'Servicios detenidos.'
}

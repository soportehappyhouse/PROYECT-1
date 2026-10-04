#Requires -Version 5.1
<#
.SYNOPSIS
  Studio - detiene workers, API y dashboard iniciados por start.ps1.
.DESCRIPTION
  Mata el arbol de procesos de cada PID guardado en storage\run\pids.json y, si algun puerto de
  Studio sigue ocupado por node/python, tambien ese proceso.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\stop.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
Initialize-Console

$pidFile = Join-Path (Get-RunDir) 'pids.json'
$stopped = 0
if (Test-Path $pidFile) {
    $entries = @()
    try { $entries = @((Get-Content $pidFile -Raw | ConvertFrom-Json) | ForEach-Object { $_ }) } catch { $entries = @() }
    foreach ($e in $entries) {
        if (Get-Process -Id $e.pid -ErrorAction SilentlyContinue) {
            Stop-ProcessTree ([int]$e.pid)
            Write-Good ("{0} detenido (PID {1})" -f $e.name, $e.pid)
            $stopped++
        }
    }
    Remove-Item $pidFile -Force
}

$ports = Get-Ports
foreach ($port in @($ports.Web, $ports.Api, $ports.Workers)) {
    $owner = Get-PortOwner $port
    if (-not $owner) { continue }
    $proc = Get-Process -Id $owner -ErrorAction SilentlyContinue
    if ($proc -and @('node', 'python', 'pythonw') -contains $proc.ProcessName.ToLowerInvariant()) {
        Stop-ProcessTree $owner
        Write-Good ("Puerto {0} liberado ({1}, PID {2})" -f $port, $proc.ProcessName, $owner)
        $stopped++
    } elseif ($proc) {
        Write-Careful ("Puerto {0} ocupado por {1} (PID {2}); no se toca." -f $port, $proc.ProcessName, $owner)
    }
}
if ($stopped -eq 0) { Write-Info 'No habia servicios de Studio corriendo.' }

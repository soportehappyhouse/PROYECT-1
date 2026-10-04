#Requires -Version 5.1
<#
.SYNOPSIS
  Studio - descarga packs de audio CC0 de Kenney (kenney.nl) a storage\library\sfx\kenney\ con su
  archivo de atribucion y los indexa en la biblioteca (POST /api/library/scan).
.DESCRIPTION
  Licencia de los packs: Creative Commons CC0 1.0 (dominio publico; atribucion opcional, pero se
  guarda igual en _pack.json, ATTRIBUTION.txt y en la base de la biblioteca).
  kenney.nl no publica URLs fijas de los ZIP: el script busca el enlace .zip en la pagina de cada
  pack. Si la pagina cambia, descarga los ZIP a mano a una carpeta y usa -ZipDir.
.PARAMETER Packs
  Slugs de https://kenney.nl/assets/<slug>.
.PARAMETER ZipDir
  Carpeta con ZIP ya descargados (se usa el que contenga el slug en el nombre).
.PARAMETER Force
  Re-descarga packs ya importados.
.PARAMETER NoScan
  No llama a la API para indexar.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\library\import-cc0.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\library\import-cc0.ps1 -ZipDir $HOME\Downloads
#>
[CmdletBinding()]
param(
    [string[]]$Packs = @('interface-sounds', 'impact-sounds', 'digital-audio', 'rpg-audio', 'ui-audio', 'sci-fi-sounds'),
    [string]$ZipDir = '',
    [switch]$Force,
    [switch]$NoScan
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\windows\common.ps1')
Initialize-Console

$audioExt = @('.ogg', '.wav', '.mp3', '.flac')
$kenneyRoot = Join-Path (Get-StorageDir) 'library\sfx\kenney'
New-Item -ItemType Directory -Force -Path $kenneyRoot | Out-Null
$tmpRoot = Join-Path (Get-StorageDir) 'tmp\kenney'
New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null

function Get-PackZip([string]$Slug) {
    if ($ZipDir) {
        $local = Get-ChildItem -Path $ZipDir -Filter '*.zip' -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match [regex]::Escape($Slug) } | Select-Object -First 1
        if ($local) { return $local.FullName }
        throw "No hay ZIP para '$Slug' en $ZipDir"
    }
    $page = "https://kenney.nl/assets/$Slug"
    Write-Info "Pagina: $page"
    $html = (Invoke-WebRequest -Uri $page -UseBasicParsing -TimeoutSec 60).Content
    $m = [regex]::Match($html, 'href="([^"]+?\.zip)"')
    if (-not $m.Success) { throw "No se encontro el enlace .zip en $page (usa -ZipDir)" }
    $url = $m.Groups[1].Value
    if ($url.StartsWith('/')) { $url = "https://kenney.nl$url" }
    $zip = Join-Path $tmpRoot "$Slug.zip"
    Write-Info "Descargando $url"
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 600
    $bytes = [IO.File]::ReadAllBytes($zip)
    if ($bytes.Length -lt 10000 -or $bytes[0] -ne 0x50 -or $bytes[1] -ne 0x4B) {
        throw "La descarga de $Slug no es un ZIP valido ($($bytes.Length) bytes)"
    }
    return $zip
}

function Get-Title([string]$Slug) {
    $words = $Slug -split '-' | ForEach-Object { $_.Substring(0, 1).ToUpperInvariant() + $_.Substring(1) }
    return ($words -join ' ')
}

$imported = @()
foreach ($slug in $Packs) {
    Write-Step "Pack $slug"
    $dest = Join-Path $kenneyRoot $slug
    if ((Test-Path (Join-Path $dest '_pack.json')) -and -not $Force) {
        Write-Good 'ya importado (usa -Force para repetir)'
        Add-Result $slug ok 'ya importado'
        $imported += $slug
        continue
    }
    try {
        $zip = Get-PackZip $slug
        $extract = Join-Path $tmpRoot $slug
        if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
        Expand-Archive -Path $zip -DestinationPath $extract -Force
        if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
        New-Item -ItemType Directory -Force -Path $dest | Out-Null
        $count = 0
        Get-ChildItem -Path $extract -Recurse -File | Where-Object { $audioExt -contains $_.Extension.ToLowerInvariant() } | ForEach-Object {
            $rel = $_.FullName.Substring($extract.Length).TrimStart('\', '/')
            $rel = $rel -replace '^(?i)audio[\\/]', ''
            $target = Join-Path $dest $rel
            New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
            Copy-Item $_.FullName $target -Force
            $count++
        }
        $license = Get-ChildItem -Path $extract -Recurse -File -Filter 'License*.txt' | Select-Object -First 1
        if ($license) { Copy-Item $license.FullName (Join-Path $dest 'LICENSE-kenney.txt') -Force }
        $title = Get-Title $slug
        $manifest = [ordered]@{
            source      = 'kenney'
            kind        = 'sfx'
            license     = 'CC0-1.0'
            attribution = "$title by Kenney (www.kenney.nl) - CC0 1.0"
            author      = 'Kenney'
            url         = "https://kenney.nl/assets/$slug"
            tags        = @('kenney', 'cc0') + ($slug -split '-')
        }
        [IO.File]::WriteAllText((Join-Path $dest '_pack.json'), (ConvertTo-Json $manifest), (New-Object System.Text.UTF8Encoding $false))
        Remove-Item -Recurse -Force $extract
        Write-Good "$count archivos de audio"
        Add-Result $slug ok "$count archivos"
        $imported += $slug
    } catch {
        Write-Bad $_.Exception.Message
        Add-Result $slug fail $_.Exception.Message
    }
}

# Human-readable credits for the whole Kenney folder (regenerated each run).
$lines = @(
    'Sonidos de Kenney (www.kenney.nl) - licencia Creative Commons CC0 1.0 Universal',
    'https://creativecommons.org/publicdomain/zero/1.0/',
    'La atribucion no es obligatoria; se agradece mencionar a Kenney.',
    ''
)
Get-ChildItem -Path $kenneyRoot -Directory | ForEach-Object {
    $lines += ("- {0}: https://kenney.nl/assets/{1}" -f (Get-Title $_.Name), $_.Name)
}
[IO.File]::WriteAllLines((Join-Path $kenneyRoot 'ATTRIBUTION.txt'), [string[]]$lines, (New-Object System.Text.UTF8Encoding $false))

if (-not $NoScan) {
    Write-Step 'Indexando la biblioteca'
    $api = "http://127.0.0.1:$((Get-Ports).Api)"
    try {
        $r = Invoke-RestMethod -Method Post -Uri "$api/api/library/scan" -TimeoutSec 900
        Add-Result 'Indexado (API)' ok ("{0} archivos, {1} nuevos, {2} errores" -f $r.scanned, $r.added, @($r.errors).Count)
    } catch {
        Add-Result 'Indexado (API)' warn 'API no disponible: se indexa al iniciar start.ps1'
    }
}
Show-Results 'Packs CC0 de Kenney'
if ((Get-FailedCount) -gt 0) { exit 1 }

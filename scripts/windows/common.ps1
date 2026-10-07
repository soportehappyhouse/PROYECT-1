# Shared helpers for setup.ps1 / start.ps1 / stop.ps1 / doctor.ps1 (dot-sourced).
# Windows PowerShell 5.1+ compatible: no ternary/??/&&, ASCII-only source (emoji built at runtime).

$script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script:EnvFile = Join-Path $script:RepoRoot '.env'
$script:EnvExample = Join-Path $script:RepoRoot '.env.example'
$script:WorkersDir = Join-Path $script:RepoRoot 'apps\workers'
$script:VenvPython = Join-Path $script:WorkersDir '.venv\Scripts\python.exe'
# Python one-liners passed to native commands must not contain double quotes: Windows PowerShell
# 5.1 does not escape them when building the command line.
$script:PyVersionCode = 'import sys; print(sys.version_info[0], sys.version_info[1], sep=chr(46))'

function Initialize-Console {
    try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
    try {
        # PowerShell 5.1 defaults to TLS 1.0/1.1 for Invoke-WebRequest.
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch { }
}

function Get-Mark {
    param([ValidateSet('ok', 'fail', 'warn', 'skip')][string]$State)
    switch ($State) {
        'ok' { return [char]::ConvertFromUtf32(0x2705) }      # white heavy check mark
        'fail' { return [char]::ConvertFromUtf32(0x274C) }    # cross mark
        'warn' { return [char]::ConvertFromUtf32(0x26A0) }    # warning sign
        default { return '--' }
    }
}

function Write-Step([string]$Message) {
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Info([string]$Message) { Write-Host "    $Message" -ForegroundColor Gray }
function Write-Good([string]$Message) { Write-Host "    $(Get-Mark ok) $Message" -ForegroundColor Green }
function Write-Bad([string]$Message) { Write-Host "    $(Get-Mark fail) $Message" -ForegroundColor Red }
function Write-Careful([string]$Message) { Write-Host "    $(Get-Mark warn) $Message" -ForegroundColor Yellow }

# ------------------------------------------------------------------ results table

$script:Results = New-Object System.Collections.ArrayList
$script:StepClock = $null

function Add-Result {
    # Action: 'omitido' (already installed, nothing done), 'ejecutado' (work done now) or ''.
    # Seconds < 0 = not timed (doctor.ps1).
    param(
        [string]$Component,
        [ValidateSet('ok', 'fail', 'warn', 'skip')][string]$State,
        [string]$Detail = '',
        [string]$Action = '',  # '' | 'omitido' | 'ejecutado' (no ValidateSet: '' trips PS 5.1)
        [double]$Seconds = -1
    )
    [void]$script:Results.Add([pscustomobject]@{
            Component = $Component; State = $State; Detail = $Detail; Action = $Action; Seconds = $Seconds
        })
}

function Start-StepClock { $script:StepClock = [Diagnostics.Stopwatch]::StartNew() }

function Stop-StepClock {
    # Seconds since Start-StepClock (and restarts it, so consecutive results time themselves).
    if (-not $script:StepClock) { return -1 }
    $s = [math]::Round($script:StepClock.Elapsed.TotalSeconds, 1)
    $script:StepClock = [Diagnostics.Stopwatch]::StartNew()
    return $s
}

function Write-Omit([string]$What) {
    # "<check> ya instalado, se omite: <what>" (heavy check mark built at runtime: ASCII source).
    Write-Host ("    {0} ya instalado, se omite: {1}" -f [char]::ConvertFromUtf32(0x2714), $What) -ForegroundColor DarkGreen
}

function Show-Results([string]$Title) {
    $timed = @($script:Results | Where-Object { $_.Seconds -ge 0 }).Count -gt 0
    Write-Host ''
    Write-Host ('=' * 78)
    Write-Host " $Title"
    Write-Host ('=' * 78)
    foreach ($r in $script:Results) {
        $color = 'Green'
        if ($r.State -eq 'fail') { $color = 'Red' }
        elseif ($r.State -eq 'warn') { $color = 'Yellow' }
        elseif ($r.State -eq 'skip') { $color = 'DarkGray' }
        elseif ($r.Action -eq 'omitido') { $color = 'DarkGreen' }
        $name = $r.Component.PadRight(32)
        if ($timed) {
            $secs = ''
            if ($r.Seconds -ge 0) { $secs = ('{0,6:N1} s' -f $r.Seconds) }
            $act = ''
            if ($r.Action) { $act = "[$($r.Action)] " }
            Write-Host (" {0}  {1} {2,8}  {3}{4}" -f (Get-Mark $r.State), $name, $secs, $act, $r.Detail) -ForegroundColor $color
        } else {
            Write-Host (" {0}  {1} {2}" -f (Get-Mark $r.State), $name, $r.Detail) -ForegroundColor $color
        }
    }
    Write-Host ('=' * 78)
}

function Get-FailedCount {
    return @($script:Results | Where-Object { $_.State -eq 'fail' }).Count
}

# ------------------------------------------------------------------ PATH and commands

function Update-SessionPath {
    # winget/npm change PATH in the registry; the current session does not see it until reloaded.
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $extra = @(
        (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'),
        (Join-Path $env:APPDATA 'npm')
    )
    $parts = @()
    foreach ($chunk in @($machine, $user, $env:Path)) {
        if ($chunk) { $parts += ($chunk -split ';') }
    }
    $parts += $extra
    $seen = @{}
    $clean = New-Object System.Collections.ArrayList
    foreach ($p in $parts) {
        $t = $p.Trim()
        if ($t -and -not $seen.ContainsKey($t.ToLowerInvariant())) {
            $seen[$t.ToLowerInvariant()] = $true
            [void]$clean.Add($t)
        }
    }
    $env:Path = ($clean -join ';')
}

function Test-Cmd([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Resolve-NativeExe([string]$Name) {
    # Full path of the .exe/.cmd/.bat that PATH resolves $Name to (skips pnpm.ps1-style scripts).
    # cmd.exe needs it: a .cmd shim started as "pnpm" (quoted, no extension) gets a wrong %~dp0
    # (the current directory) and fails with "The system cannot find the path specified".
    $cmd = Get-Command $Name -CommandType Application -All -ErrorAction SilentlyContinue |
        Where-Object { @('.exe', '.cmd', '.bat', '.com') -contains [IO.Path]::GetExtension($_.Source).ToLowerInvariant() } |
        Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    return $Name
}

function Get-CmdOutput {
    # First line of a native command's stdout, or $null. Never throws.
    param([string]$Exe, [string[]]$Arguments = @())
    # Local 'Continue': under 'Stop', Windows PowerShell 5.1 turns native stderr into a terminating
    # error even when redirected.
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $Exe @Arguments 2>$null
        if ($LASTEXITCODE -ne 0 -and -not $out) { return $null }
        $first = @($out | Where-Object { $_ -and $_.ToString().Trim() })[0]
        if ($first) { return $first.ToString().Trim() }
    } catch { }
    return $null
}

function Invoke-Native {
    # Run a native command, stream its output, throw on non-zero exit code.
    param([string]$Exe, [string[]]$Arguments = @(), [string]$WorkingDirectory = $script:RepoRoot)
    $ErrorActionPreference = 'Continue'
    Write-Info ("> {0} {1}" -f $Exe, ($Arguments -join ' '))
    Push-Location $WorkingDirectory
    try {
        & $Exe @Arguments | Out-Host
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($code -ne 0) { throw ("'{0}' termino con codigo {1}" -f $Exe, $code) }
}

# ------------------------------------------------------------------ .env handling

function Read-DotEnv([string]$Path = $script:EnvFile) {
    $map = @{}
    if (-not (Test-Path $Path)) { return $map }
    foreach ($line in [IO.File]::ReadAllLines($Path)) {
        $t = $line.Trim()
        if (-not $t -or $t.StartsWith('#')) { continue }
        $i = $t.IndexOf('=')
        if ($i -lt 1) { continue }
        $key = $t.Substring(0, $i).Trim()
        $val = $t.Substring($i + 1).Trim()
        if ($val.Length -ge 2 -and (($val.StartsWith('"') -and $val.EndsWith('"')) -or ($val.StartsWith("'") -and $val.EndsWith("'")))) {
            $val = $val.Substring(1, $val.Length - 2)
        }
        $map[$key] = $val
    }
    return $map
}

function Get-EnvSetting([string]$Key, [string]$Default = '') {
    $map = Read-DotEnv
    if ($map.ContainsKey($Key) -and $map[$Key]) { return $map[$Key] }
    return $Default
}

function Set-DotEnvValue([string]$Key, [string]$Value, [string]$Path = $script:EnvFile) {
    # Replace KEY=... in place (or append). Keeps comments/other keys; writes UTF-8 without BOM.
    $lines = @()
    if (Test-Path $Path) { $lines = [IO.File]::ReadAllLines($Path) }
    $found = $false
    $out = New-Object System.Collections.ArrayList
    foreach ($line in $lines) {
        if ($line -match ('^\s*' + [regex]::Escape($Key) + '\s*=')) {
            [void]$out.Add("$Key=$Value")
            $found = $true
        } else {
            [void]$out.Add($line)
        }
    }
    if (-not $found) { [void]$out.Add("$Key=$Value") }
    [IO.File]::WriteAllLines($Path, [string[]]$out, (New-Object System.Text.UTF8Encoding $false))
}

function Import-DotEnvToProcess {
    # Child processes inherit these (web needs NEXT_PUBLIC_*). Existing env vars win. Never printed.
    $map = Read-DotEnv
    foreach ($k in $map.Keys) {
        if (-not [Environment]::GetEnvironmentVariable($k, 'Process')) {
            [Environment]::SetEnvironmentVariable($k, $map[$k], 'Process')
        }
    }
}

function Resolve-RepoPath([string]$Relative) {
    if ([IO.Path]::IsPathRooted($Relative)) { return $Relative }
    return [IO.Path]::GetFullPath((Join-Path $script:RepoRoot $Relative))
}

function Get-StorageDir { return Resolve-RepoPath (Get-EnvSetting 'STORAGE_DIR' './storage') }
function Get-ModelsDir { return Resolve-RepoPath (Get-EnvSetting 'MODELS_DIR' './models') }

function Get-Ports {
    return [pscustomobject]@{
        Web     = [int](Get-EnvSetting 'WEB_PORT' '3000')
        Api     = [int](Get-EnvSetting 'API_PORT' '3001')
        Workers = [int](Get-EnvSetting 'WORKERS_PORT' '8001')
    }
}

# ------------------------------------------------------------------ tools discovery

function Find-Python311 {
    # Prefer the py launcher; avoid the Microsoft Store alias (WindowsApps\python.exe stub).
    if (Test-Cmd 'py') {
        $exe = Get-CmdOutput 'py' @('-3.11', '-c', 'import sys; print(sys.executable)')
        if ($exe -and (Test-Path $exe)) { return $exe }
    }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\python.exe'),
        (Join-Path $env:ProgramFiles 'Python311\python.exe')
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -notmatch 'WindowsApps') {
        $v = Get-CmdOutput $cmd.Source @('-c', $script:PyVersionCode)
        if ($v -eq '3.11') { return $cmd.Source }
    }
    return $null
}

function Find-Python312 {
    # Sprint 4: base interpreter of tools\facefusion\.venv (FaceFusion 3.9.1 needs Python >= 3.12).
    # FACEFUSION_BASE_PYTHON (.env) wins; then the py launcher, the per-user / machine installs and
    # PATH (never the Microsoft Store alias). The workers resolve it the same way (toolvenv.py).
    $explicit = Get-EnvSetting 'FACEFUSION_BASE_PYTHON' ''
    if ($explicit) {
        if ((Test-Path $explicit) -and ((Get-CmdOutput $explicit @('-c', $script:PyVersionCode)) -eq '3.12')) { return $explicit }
        return $null
    }
    if (Test-Cmd 'py') {
        $exe = Get-CmdOutput 'py' @('-3.12', '-c', 'import sys; print(sys.executable)')
        if ($exe -and (Test-Path $exe)) { return $exe }
    }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'),
        (Join-Path $env:ProgramFiles 'Python312\python.exe')
    )
    foreach ($c in $candidates) {
        if ((Test-Path $c) -and ((Get-CmdOutput $c @('-c', $script:PyVersionCode)) -eq '3.12')) { return $c }
    }
    foreach ($name in @('python3.12', 'python')) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd -and $cmd.Source -notmatch 'WindowsApps') {
            $v = Get-CmdOutput $cmd.Source @('-c', $script:PyVersionCode)
            if ($v -eq '3.12') { return $cmd.Source }
        }
    }
    return $null
}

$script:ToolsDir = Join-Path $script:RepoRoot 'tools'
$script:ToolRuntimesFile = Join-Path $script:ToolsDir 'runtimes.json'

function Get-ToolVenvPython([string]$Tool) {
    # tools\<id>\.venv\Scripts\python.exe (sprint 4 isolated tools: facefusion, chatterbox)
    return (Join-Path $script:ToolsDir "$Tool\.venv\Scripts\python.exe")
}

function Find-FfmpegExe {
    $configured = Get-EnvSetting 'FFMPEG_PATH' ''
    if ($configured -and (Test-Path $configured)) { return $configured }
    $cmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $pkgRoot = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
    if (Test-Path $pkgRoot) {
        $hit = Get-ChildItem -Path $pkgRoot -Filter 'ffmpeg.exe' -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match 'Gyan\.FFmpeg' } | Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    return $null
}

function Test-VCRedist {
    foreach ($key in @(
            'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64',
            'HKLM:\SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64')) {
        try {
            $v = Get-ItemProperty -Path $key -ErrorAction Stop
            if ($v.Installed -eq 1) { return $v.Version }
        } catch { }
    }
    return $null
}

# NVIDIA GPU name, or $null: nvidia-smi first (driver installed), else the WMI video adapters
# (GPU present but driver/nvidia-smi missing). Used by setup.ps1 (CUDA auto) and doctor.ps1.
function Get-NvidiaGpuName {
    if (Test-Cmd 'nvidia-smi') {
        $name = Get-CmdOutput 'nvidia-smi' @('--query-gpu=name', '--format=csv,noheader')
        if ($name) { return $name }  # first line = first GPU
    }
    try {
        $adapter = Get-CimInstance Win32_VideoController -ErrorAction Stop |
            Where-Object { $_.Name -match 'NVIDIA' } | Select-Object -First 1
        if ($adapter) { return [string]$adapter.Name }
    } catch { }
    return $null
}

function Test-LongPaths {
    try {
        $v = Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -ErrorAction Stop
        return ($v.LongPathsEnabled -eq 1)
    } catch { return $false }
}

# ------------------------------------------------------------------ network / processes

function Test-HttpOk([string]$Url, [int]$TimeoutSec = 3) {
    try {
        $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop
        return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 400)
    } catch { return $false }
}

function Wait-HttpOk([string]$Url, [int]$TimeoutSec = 120) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-HttpOk $Url 3) { return $true }
        Start-Sleep -Milliseconds 1500
    }
    return $false
}

function Get-PortOwner([int]$Port) {
    # PID listening on the port, or $null. Get-NetTCPConnection exists on Windows 8+/Server 2012+.
    try {
        $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
        if ($c) { return [int]$c.OwningProcess }
    } catch { }
    return $null
}

function Stop-ProcessTree([int]$ProcessId) {
    # taskkill /T also kills children (pnpm -> node, powershell -> python) that Stop-Process misses.
    $ErrorActionPreference = 'Continue'
    & taskkill.exe /PID $ProcessId /T /F 2>$null | Out-Null
}

function ConvertTo-PsLiteral([string]$Value) {
    # Single-quoted PowerShell literal (for -Command strings built at runtime).
    return "'" + ($Value -replace "'", "''") + "'"
}

function Get-RunDir {
    $dir = Join-Path (Get-StorageDir) 'run'
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    return $dir
}


# ------------------------------------------------------------------ incremental install helpers

function Get-TextSha256([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))
        return ([BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
}

function Get-FileSha256([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return 'none' }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Add-RequirementsChain([string]$Path, [System.Collections.Generic.List[string]]$Files) {
    # Appends $Path and, depth first, every file it pulls in with -r/--requirement or
    # -c/--constraint (resolved like pip: relative to the folder of the file that includes it).
    # Each file once (cycles are harmless); a missing include is kept so it hashes as 'none'.
    $full = [IO.Path]::GetFullPath($Path)
    foreach ($f in $Files) { if ($f -ieq $full) { return } }
    $Files.Add($full)
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { return }
    $dir = [IO.Path]::GetDirectoryName($full)
    foreach ($raw in [IO.File]::ReadAllLines($full)) {
        $line = $raw.Trim()
        if ($line -notmatch '^(?:-r|--requirement|-c|--constraint)(?:\s*=\s*|\s*)(\S.*)$') { continue }
        $target = ($Matches[1] -replace '\s+#.*$', '').Trim().Trim([char[]]@('"', "'"))
        if (-not $target -or $target.Contains('://')) { continue }
        if (-not [IO.Path]::IsPathRooted($target)) { $target = Join-Path $dir $target }
        Add-RequirementsChain $target $Files
    }
}

function Get-RequirementsHash([string]$Path) {
    # Uppercase SHA256 for the "<profile> <HEX>" line of the .venv stamp. A file without -r/-c
    # includes hashes exactly like Get-FileHash (stamps of older setups stay valid); with includes
    # (requirements-cuda.txt -> requirements.txt) it is the hash of "<relative path>=<sha256>" of
    # every file in the chain, in include order, so a change in ANY of them triggers pip install.
    # Relative paths keep the value stable between runs and if the repo folder is moved.
    $files = New-Object 'System.Collections.Generic.List[string]'
    Add-RequirementsChain $Path $files
    if ($files.Count -eq 1) { return (Get-FileSha256 $files[0]).ToUpperInvariant() }
    $root = [IO.Path]::GetDirectoryName($files[0]).TrimEnd('\', '/')
    $parts = @()
    foreach ($f in $files) {
        $name = $f
        if ($f.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            $name = $f.Substring($root.Length + 1)
        }
        $parts += ('{0}={1}' -f $name.Replace('\', '/'), (Get-FileSha256 $f))
    }
    return (Get-TextSha256 ($parts -join "`n")).ToUpperInvariant()
}

function Read-Stamp([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    try { return ([IO.File]::ReadAllText($Path)).Trim() } catch { return '' }
}

function Write-Stamp([string]$Path, [string]$Value) {
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [IO.File]::WriteAllText($Path, $Value + "`n", (New-Object System.Text.UTF8Encoding $false))
}

function Test-VersionAtLeast([string]$Text, [string]$Minimum) {
    # First dotted number in $Text (e.g. 'git version 2.47.1.windows.1', 'v22.12.0') >= $Minimum.
    $m = [regex]::Match("$Text", '(\d+)\.(\d+)(?:\.(\d+))?')
    if (-not $m.Success) { return $false }
    $patch = 0
    if ($m.Groups[3].Success) { $patch = [int]$m.Groups[3].Value }
    $have = New-Object Version ([int]$m.Groups[1].Value), ([int]$m.Groups[2].Value), $patch
    return ($have -ge [Version]$Minimum)
}

$script:SkipSourceDirs = @('node_modules', '.next', 'dist', 'out', '.turbo', 'coverage', 'test', 'tests', '__tests__', '.remotion')

function Get-SourceFiles([string]$Dir) {
    # Recursive file list that never descends into node_modules/.next/dist (fast on big trees).
    $out = New-Object System.Collections.ArrayList
    if (-not (Test-Path -LiteralPath $Dir -PathType Container)) { return @() }
    $stack = New-Object System.Collections.Stack
    $stack.Push($Dir)
    while ($stack.Count -gt 0) {
        $d = $stack.Pop()
        foreach ($f in [IO.Directory]::GetFiles($d)) {
            $n = [IO.Path]::GetFileName($f)
            if ($n -like '*.tsbuildinfo' -or $n -eq 'next-env.d.ts' -or $n -match '\.test\.[cm]?[jt]sx?$') { continue }
            [void]$out.Add($f)
        }
        foreach ($sub in [IO.Directory]::GetDirectories($d)) {
            if ($script:SkipSourceDirs -notcontains [IO.Path]::GetFileName($sub)) { $stack.Push($sub) }
        }
    }
    return @($out | Sort-Object)
}

function Get-BuildEnvText {
    # Only the .env values that end up inside the production build (NEXT_PUBLIC_* and ports).
    $map = Read-DotEnv
    $keys = @($map.Keys | Where-Object { $_ -like 'NEXT_PUBLIC_*' -or $_ -like '*_PORT' } | Sort-Object)
    return (($keys | ForEach-Object { "$_=$($map[$_])" }) -join "`n")
}

function Get-WebBuildFingerprint {
    # sha256 over the content of every build input (web, api, packages, lockfile, build env).
    $sb = New-Object System.Text.StringBuilder
    $files = @()
    foreach ($d in @('apps\web', 'apps\api', 'packages')) { $files += @(Get-SourceFiles (Join-Path $script:RepoRoot $d)) }
    foreach ($f in @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json')) {
        $p = Join-Path $script:RepoRoot $f
        if (Test-Path -LiteralPath $p) { $files += $p }
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        foreach ($f in $files) {
            $rel = $f.Substring($script:RepoRoot.Length).TrimStart('\', '/').Replace('\', '/')
            $h = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($f))) -replace '-', ''
            [void]$sb.Append($rel).Append(':').Append($h).Append("`n")
        }
    } finally { $sha.Dispose() }
    [void]$sb.Append('env:').Append((Get-BuildEnvText))
    return Get-TextSha256 $sb.ToString()
}

$script:WebBuildStamp = Join-Path $script:RepoRoot 'apps\web\.next\.studio-build'

function Get-WebBuildState {
    # Fresh = both builds exist and nothing they depend on changed since (content hash stamp;
    # builds made by older versions without a stamp fall back to the old mtime rule and get adopted).
    $buildId = Join-Path $script:RepoRoot 'apps\web\.next\BUILD_ID'
    $apiOut = Join-Path $script:RepoRoot 'apps\api\dist\index.js'
    if (-not (Test-Path $buildId) -or -not (Test-Path $apiOut)) {
        return [pscustomobject]@{ Fresh = $false; Reason = 'no hay build de produccion'; Fingerprint = '' }
    }
    $fp = Get-WebBuildFingerprint
    $stamp = Read-Stamp $script:WebBuildStamp
    if ($stamp) {
        if ($stamp -eq $fp) { return [pscustomobject]@{ Fresh = $true; Reason = 'build al dia'; Fingerprint = $fp } }
        return [pscustomobject]@{ Fresh = $false; Reason = 'cambio el codigo o .env desde el ultimo build'; Fingerprint = $fp }
    }
    $built = (Get-Item $buildId).LastWriteTimeUtc
    $newest = [datetime]::MinValue
    $inputs = @()
    foreach ($d in @('apps\web', 'apps\api', 'packages')) { $inputs += @(Get-SourceFiles (Join-Path $script:RepoRoot $d)) }
    if (Test-Path $script:EnvFile) { $inputs += $script:EnvFile }
    foreach ($f in $inputs) {
        $t = [IO.File]::GetLastWriteTimeUtc($f)
        if ($t -gt $newest) { $newest = $t }
    }
    if ($newest -le $built) {
        Write-Stamp $script:WebBuildStamp $fp
        return [pscustomobject]@{ Fresh = $true; Reason = 'build previo al dia (adoptado)'; Fingerprint = $fp }
    }
    return [pscustomobject]@{ Fresh = $false; Reason = 'hay archivos mas nuevos que el build'; Fingerprint = $fp }
}

function Save-WebBuildStamp {
    # Computed after the build: next build may touch tsconfig.json.
    Write-Stamp $script:WebBuildStamp (Get-WebBuildFingerprint)
}

function Get-JsDepsFingerprint([string]$NodeVer, [string]$PnpmVer) {
    $parts = @("node=$NodeVer", "pnpm=$PnpmVer")
    $manifests = @('pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json')
    foreach ($group in @('apps', 'packages')) {
        $root = Join-Path $script:RepoRoot $group
        if (Test-Path $root) {
            foreach ($d in [IO.Directory]::GetDirectories($root) | Sort-Object) {
                if (Test-Path (Join-Path $d 'package.json')) {
                    $manifests += ($d.Substring($script:RepoRoot.Length).TrimStart('\', '/') + '\package.json')
                }
            }
        }
    }
    foreach ($m in $manifests) { $parts += ('{0}={1}' -f $m.Replace('\', '/'), (Get-FileSha256 (Join-Path $script:RepoRoot $m))) }
    return Get-TextSha256 ($parts -join "`n")
}

function Find-RemotionBrowser {
    # Path of Chrome Headless Shell for Remotion, or $null (same folders packages/remotion searches).
    $configured = Get-EnvSetting 'REMOTION_BROWSER_EXECUTABLE' ''
    if ($configured) {
        $p = Resolve-RepoPath $configured
        if (Test-Path $p) { return $p }
        return $null
    }
    $rel = 'node_modules\.remotion\chrome-headless-shell\win64\chrome-headless-shell-win64\chrome-headless-shell.exe'
    foreach ($root in @('packages\remotion', '.', 'apps\api')) {
        $p = Join-Path (Join-Path $script:RepoRoot $root) $rel
        if (Test-Path $p) { return $p }
    }
    return $null
}

function Get-FolderBytes([string]$Path) {
    # Total size of a folder (0 if missing). Uses .NET enumeration: fast, no PowerShell objects.
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return [int64]0 }
    $total = [int64]0
    try {
        $di = New-Object IO.DirectoryInfo $Path
        foreach ($f in $di.EnumerateFiles('*', [IO.SearchOption]::AllDirectories)) { $total += $f.Length }
    } catch { }
    return $total
}

function Format-Bytes([int64]$Bytes) {
    if ($Bytes -ge 1GB) { return ('{0:N1} GB' -f ($Bytes / 1GB)) }
    if ($Bytes -ge 1MB) { return ('{0:N0} MB' -f ($Bytes / 1MB)) }
    return ('{0:N0} KB' -f ($Bytes / 1KB))
}

# ------------------------------------------------------------------ sprint 3: Ollama (local agent)
function Get-OllamaUrl { return (Get-EnvSetting 'OLLAMA_URL' 'http://127.0.0.1:11434').TrimEnd('/') }

function Find-OllamaExe {
    # winget Ollama.Ollama installs per user in %LOCALAPPDATA%\Programs\Ollama.
    $cmd = Get-Command ollama -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($pair in @(@($env:LOCALAPPDATA, 'Programs\Ollama'), @($env:ProgramFiles, 'Ollama'))) {
        if (-not $pair[0]) { continue }
        $exe = Join-Path (Join-Path $pair[0] $pair[1]) 'ollama.exe'
        if (Test-Path $exe) { return $exe }
    }
    return $null
}

function Get-OllamaTags {
    # Model names from /api/tags, or $null when the service does not answer.
    try {
        $r = Invoke-RestMethod -Uri ((Get-OllamaUrl) + '/api/tags') -TimeoutSec 3 -ErrorAction Stop
        return @($r.models | ForEach-Object { $_.name })
    } catch { return $null }
}

function Get-OllamaVersion {
    try {
        $r = Invoke-RestMethod -Uri ((Get-OllamaUrl) + '/api/version') -TimeoutSec 3 -ErrorAction Stop
        return [string]$r.version
    } catch { return $null }
}

function Start-OllamaService([string]$Exe) {
    # The tray app ("ollama app.exe") starts the server and keeps it at login; else `ollama serve`.
    $app = Join-Path (Split-Path $Exe -Parent) 'ollama app.exe'
    if (Test-Path $app) { Start-Process -FilePath $app -WindowStyle Hidden | Out-Null }
    else { Start-Process -FilePath $Exe -ArgumentList 'serve' -WindowStyle Hidden | Out-Null }
    return (Wait-HttpOk ((Get-OllamaUrl) + '/api/version') 30)
}

# ------------------------------------------------------------------ Claude Code (Sprint 3b)
# Consola Claude: Claude Code CLI con la suscripcion de Claude.ai (claude auth login). Sin API key.

$script:ClaudeNpmPackage = '@anthropic-ai/claude-code'

function Find-ClaudeExe {
    # PATH first; then the native installer dir (~\.local\bin) and the npm global prefix
    # (`npm root -g` -> its parent holds claude.cmd, usually %APPDATA%\npm).
    $cmd = Get-Command claude -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    $candidates = @()
    if ($env:USERPROFILE) { $candidates += (Join-Path $env:USERPROFILE '.local\bin\claude.exe') }
    if ($env:APPDATA) { $candidates += (Join-Path $env:APPDATA 'npm\claude.cmd') }
    $npmRoot = Get-CmdOutput 'npm' @('root', '-g')
    if ($npmRoot) { $candidates += (Join-Path (Split-Path $npmRoot -Parent) 'claude.cmd') }
    foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
    return $null
}

function Get-ClaudeVersion([string]$Exe = '') {
    # "2.1.290 (Claude Code)" or $null.
    if (-not $Exe) { $Exe = Find-ClaudeExe }
    if (-not $Exe) { return $null }
    return Get-CmdOutput $Exe @('--version')
}

function Get-ClaudeAuthStatus([string]$Exe = '') {
    # `claude auth status` (documented: JSON, exit 0 = logged in, 1 = not). Returns
    # @{ LoggedIn = $true/$false/$null; Method = 'claude.ai' | ... }. $null LoggedIn = unknown
    # (older CLI without the subcommand).
    $result = @{ LoggedIn = $null; Method = '' }
    if (-not $Exe) { $Exe = Find-ClaudeExe }
    if (-not $Exe) { return $result }
    $ErrorActionPreference = 'Continue'
    try {
        $out = (& $Exe auth status 2>$null) -join "`n"
        $code = $LASTEXITCODE
        if ($out) {
            try {
                $json = $out | ConvertFrom-Json -ErrorAction Stop
                if ($null -ne $json.loggedIn) { $result.LoggedIn = [bool]$json.loggedIn }
                if ($json.authMethod) { $result.Method = [string]$json.authMethod }
                if ($null -eq $result.LoggedIn -and $result.Method) { $result.LoggedIn = ($result.Method -ne 'none') }
            } catch { }
        }
        if ($null -eq $result.LoggedIn -and ($code -eq 0 -or $code -eq 1) -and $out) {
            $result.LoggedIn = ($code -eq 0)
        }
    } catch { }
    return $result
}

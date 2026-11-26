# Installs (or updates) the MySQL Lens desktop app on Windows.
#
# PowerShell:
#   irm https://raw.githubusercontent.com/azizdevfull/mysql-lens/main/install.ps1 | iex
# cmd:
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/azizdevfull/mysql-lens/main/install.ps1 | iex"
#
# A specific version:  $env:MYSQL_LENS_VERSION = '0.5.0'; irm .../install.ps1 | iex
# The installer is per-user, so no administrator rights are needed.

$ErrorActionPreference = 'Stop'
# Invoke-WebRequest is many times slower while it draws its progress bar.
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$repo = 'https://github.com/azizdevfull/mysql-lens'

function Fail([string]$message) {
    Write-Host "MySQL Lens: $message" -ForegroundColor Red
    # `exit` would close the window when the script runs through `irm | iex`.
    throw $message
}

if ([Environment]::OSVersion.Platform -ne 'Win32NT') { Fail 'this installer is for Windows.' }
if (-not [Environment]::Is64BitOperatingSystem) { Fail 'a 64-bit Windows is required.' }

# Which version: the one asked for, or the latest release (from the updater manifest).
$version = $env:MYSQL_LENS_VERSION
if ($version) {
    $version = $version.TrimStart('v')
    if ($version -notmatch '^\d+\.\d+\.\d+$') { Fail "'$version' is not a version like 0.5.0." }
    $url = "$repo/releases/download/app-v$version/MySQL-Lens_${version}_x64-setup.exe"
} else {
    Write-Host 'Looking for the latest version...'
    try {
        $manifest = Invoke-RestMethod -UseBasicParsing -Uri "$repo/releases/latest/download/latest.json"
    } catch {
        Fail "could not reach GitHub ($($_.Exception.Message))."
    }
    $version = $manifest.version
    $url = $manifest.platforms.'windows-x86_64'.url
    if (-not $version -or -not $url) { Fail 'the release manifest has no Windows installer.' }
}

# The installer cannot replace the program while it is running.
if (Get-Process -Name 'mysql-lens' -ErrorAction SilentlyContinue) {
    Fail 'MySQL Lens is running. Close it and run this command again.'
}

$setup = Join-Path $env:TEMP "MySQL-Lens_${version}_x64-setup.exe"
Write-Host "Downloading MySQL Lens $version..."
try {
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $setup
} catch {
    Fail "download failed ($($_.Exception.Message))."
}

try {
    # A truncated download or an HTML error page is not a Windows program.
    $head = [byte[]]::new(2)
    $stream = [IO.File]::OpenRead($setup)
    try { [void]$stream.Read($head, 0, 2) } finally { $stream.Dispose() }
    if ((Get-Item $setup).Length -lt 1MB -or $head[0] -ne 0x4D -or $head[1] -ne 0x5A) {
        Fail 'the downloaded file is not a valid installer. Try again later.'
    }

    Write-Host 'Installing...'
    $p = Start-Process -FilePath $setup -ArgumentList '/S' -Wait -PassThru
    if ($p.ExitCode -ne 0) { Fail "the installer stopped with code $($p.ExitCode)." }
} finally {
    Remove-Item $setup -Force -ErrorAction SilentlyContinue
}

$exe = Join-Path $env:LOCALAPPDATA 'MySQL Lens\mysql-lens.exe'
Write-Host "MySQL Lens $version is installed." -ForegroundColor Green
if (Test-Path $exe) {
    Write-Host "Open it from the Start menu, or run: & '$exe'"
} else {
    Write-Host 'Open it from the Start menu.'
}
Write-Host 'Later versions install themselves from inside the app.'

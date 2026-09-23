# VinaX installer for Windows (PowerShell 5.1 or later).
#
#   irm https://raw.githubusercontent.com/Vinay1812007/VinaX-CLI/main/scripts/install.ps1 | iex
#
# Downloads the standalone vinax.exe for this machine from GitHub Releases, checks it against the
# release's SHA256SUMS, installs it and adds the folder to your user PATH. Environment variables:
#   VINAX_VERSION       version to install, e.g. 0.2.0 (default: latest)
#   VINAX_INSTALL_DIR   where to put vinax.exe (default: %LOCALAPPDATA%\vinax\bin)
#   VINAX_DOWNLOAD_BASE download from this URL instead of GitHub (mirrors, testing)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Repo = 'Vinay1812007/VinaX-CLI'
$Version = if ($env:VINAX_VERSION) { $env:VINAX_VERSION } else { 'latest' }
$InstallDir = if ($env:VINAX_INSTALL_DIR) { $env:VINAX_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'vinax\bin' }

$cpu = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$arch = if ($cpu -eq 'ARM64') { 'arm64' } else { 'x64' }
$asset = "vinax-windows-$arch.exe"

if ($env:VINAX_DOWNLOAD_BASE) {
  $base = $env:VINAX_DOWNLOAD_BASE.TrimEnd('/')
} elseif ($Version -eq 'latest') {
  $base = "https://github.com/$Repo/releases/latest/download"
} else {
  $base = "https://github.com/$Repo/releases/download/v$($Version.TrimStart('v'))"
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("vinax-" + [System.Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "Downloading $asset ($Version)..."
  $exe = Join-Path $tmp 'vinax.exe'
  $sums = Join-Path $tmp 'SHA256SUMS'
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $exe
  Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $sums

  $line = Get-Content $sums | Where-Object { $_ -match "\s\*?$([regex]::Escape($asset))$" } | Select-Object -First 1
  if (-not $line) { throw "SHA256SUMS does not list $asset" }
  $expected = ($line -split '\s+')[0].ToLower()
  $actual = (Get-FileHash -Algorithm SHA256 $exe).Hash.ToLower()
  if ($expected -ne $actual) { throw "checksum mismatch for $asset (expected $expected, got $actual)" }

  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $target = Join-Path $InstallDir 'vinax.exe'
  if (Test-Path $target) {
    # A running vinax.exe cannot be overwritten, but it can be renamed.
    Move-Item -Force $target "$target.old"
  }
  Move-Item -Force $exe $target
  $installed = & $target --version
  Write-Host "Installed VinaX $installed to $target"

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (($userPath -split ';') -contains $InstallDir)) {
    [Environment]::SetEnvironmentVariable('Path', "$InstallDir;$userPath", 'User')
    Write-Host "Added $InstallDir to your user PATH. Open a new terminal, then run: vinax"
  } else {
    Write-Host 'Run: vinax'
  }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

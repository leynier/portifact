# Portifact CLI installer for Windows.
#
#   irm https://portifact.com/install.ps1 | iex
#
# Environment variables:
#   PORTIFACT_VERSION         Version to install, for example 0.2.0. Defaults to the latest release.
#   PORTIFACT_INSTALL_DIR     Where to put the binary. Defaults to $HOME\.portifact\bin.
#   PORTIFACT_NO_MODIFY_PATH  Set to 1 to skip adding the install directory to the user PATH.
#   PORTIFACT_DOWNLOAD_URL    Base URL or local folder with the release assets. Used by tests.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Install-Portifact {
  $repo = 'leynier/portifact'

  # Use the operating system architecture, not the process one: an x64 PowerShell running under
  # emulation on Windows on Arm reports AMD64 but should still get the native arm64 build.
  # Win32_Processor reports the hardware (12 = ARM64, 9 = x64) regardless of emulation.
  $osArch = $null
  try {
    switch ((Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop | Select-Object -First 1).Architecture) {
      12 { $osArch = 'ARM64' }
      9 { $osArch = 'X64' }
    }
  } catch { }
  if (-not $osArch) {
    try { $osArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() } catch { }
  }
  if (-not $osArch) {
    $osArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  }
  $arch = switch ($osArch.ToUpperInvariant()) {
    { $_ -in 'X64', 'AMD64' } { 'x64' }
    'ARM64' { 'arm64' }
    default { throw "Unsupported architecture: $osArch" }
  }
  $archive = "portifact-windows-$arch.zip"

  if ($env:PORTIFACT_DOWNLOAD_URL) {
    $base = $env:PORTIFACT_DOWNLOAD_URL
  } elseif ($env:PORTIFACT_VERSION) {
    $base = "https://github.com/$repo/releases/download/v$($env:PORTIFACT_VERSION.TrimStart('v'))"
  } else {
    $base = "https://github.com/$repo/releases/latest/download"
  }

  $installDir = if ($env:PORTIFACT_INSTALL_DIR) { $env:PORTIFACT_INSTALL_DIR } else { Join-Path $HOME '.portifact\bin' }
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("portifact-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null

  try {
    function Get-Asset([string]$name) {
      $destination = Join-Path $tmp $name
      if ($base -match '^https?://') {
        Invoke-WebRequest -Uri "$base/$name" -OutFile $destination -UseBasicParsing
      } else {
        Copy-Item -Path (Join-Path $base $name) -Destination $destination
      }
      return $destination
    }

    Write-Host "Downloading Portifact for windows-$arch..."
    $archivePath = Get-Asset $archive
    $sumsPath = Get-Asset 'SHA256SUMS'

    $line = Get-Content $sumsPath | Where-Object { ($_ -split '\s+')[1] -eq $archive } | Select-Object -First 1
    if (-not $line) { throw "No checksum published for $archive" }
    $expected = ($line -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 -Path $archivePath).Hash.ToLowerInvariant()
    if ($expected -ne $actual) { throw "Checksum mismatch for $archive (expected $expected, got $actual)" }

    Expand-Archive -Path $archivePath -DestinationPath $tmp -Force
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    $exe = Join-Path $installDir 'portifact.exe'
    Move-Item -Path (Join-Path $tmp 'portifact.exe') -Destination $exe -Force

    $installed = & $exe --version
    Write-Host "Installed portifact $installed to $exe"

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = if ($userPath) { $userPath -split ';' } else { @() }
    if ($entries -notcontains $installDir) {
      if ($env:PORTIFACT_NO_MODIFY_PATH -eq '1') {
        Write-Host "Add $installDir to your PATH to use portifact."
      } else {
        $newPath = if ($userPath) { "$userPath;$installDir" } else { $installDir }
        [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
        Write-Host "Added $installDir to your user PATH. Open a new terminal to use portifact."
      }
    }
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

Install-Portifact

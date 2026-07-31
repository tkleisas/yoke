# Installs the latest Yoke release binary for Windows.
# Usage (PowerShell):
#   irm https://raw.githubusercontent.com/tkleisas/yoke/main/scripts/install.ps1 | iex
param(
  [string]$Version = "latest",
  [string]$InstallDir = "$env:LOCALAPPDATA\Yoke"
)

$ErrorActionPreference = "Stop"
$Repo = "tkleisas/yoke"

if ($Version -eq "latest") {
  $release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
  $Version = $release.tag_name.TrimStart("v")
}
if (-not $Version) {
  throw "Could not determine the latest version."
}

$Url = "https://github.com/$Repo/releases/download/v$Version/yoke-$Version-windows-latest.tar.gz"
$Temp = Join-Path $env:TEMP "yoke-install-$PID"
New-Item -ItemType Directory -Force -Path $Temp | Out-Null
try {
  Write-Host "Downloading Yoke v$Version..."
  Invoke-WebRequest -Uri $Url -OutFile (Join-Path $Temp "yoke.tar.gz")
  tar -xzf (Join-Path $Temp "yoke.tar.gz") -C $Temp

  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Copy-Item (Join-Path $Temp "yoke.exe") (Join-Path $InstallDir "yoke.exe") -Force
  Write-Host "Installed Yoke v$Version to $InstallDir\yoke.exe"
  Write-Host "Add $InstallDir to your PATH, then run: yoke"
} finally {
  Remove-Item -Recurse -Force $Temp -ErrorAction SilentlyContinue
}

# Builds the prebuilt Flutter templates into packages/cli/templates.
#
# The binaries are gitignored: they are release assets. Run this when you change
# the shell (Dart/Kotlin/C++) and want to test `mio build` locally.
#
#   ./scripts/build-templates.ps1                # android + windows
#   ./scripts/build-templates.ps1 -Platform android
#
# Requires Flutter (and Android SDK for APKs, Visual Studio for the Windows dir).
param(
  [ValidateSet("all", "android", "windows")]
  [string]$Platform = "all",
  [switch]$SkipUniversal
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$shell = Join-Path $root "shell"
$androidDir = Join-Path $root "packages\cli\templates\android"
$windowsDir = Join-Path $root "packages\cli\templates\windows"

function Build-Android([string]$targets, [string]$name) {
  Push-Location $shell
  try {
    $args = @("build", "apk", "--release", "-t", "lib/main_android.dart")
    if ($targets) { $args += @("--target-platform", $targets) }
    & flutter @args
    if ($LASTEXITCODE -ne 0) { throw "flutter build apk failed ($name)" }
    New-Item -ItemType Directory -Force -Path $androidDir | Out-Null
    Copy-Item "build/app/outputs/flutter-apk/app-release.apk" (Join-Path $androidDir $name) -Force
    Write-Host "Android $name -> $(Join-Path $androidDir $name)"
  } finally {
    Pop-Location
  }
}

if ($Platform -in @("all", "android")) {
  if (-not $SkipUniversal) {
    Build-Android "android-arm,android-arm64,android-x64" "mio-shell-universal.apk"
  }
  Build-Android "android-arm64" "mio-shell-arm64.apk"
}

if ($Platform -in @("all", "windows")) {
  Push-Location $shell
  try {
    & flutter build windows --release -t lib/main_windows.dart
    if ($LASTEXITCODE -ne 0) { throw "flutter build windows failed" }
  } finally {
    Pop-Location
  }
  Remove-Item $windowsDir -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $shell "build\windows\x64\runner\Release") $windowsDir -Recurse -Force
  $mb = [math]::Round(((Get-ChildItem $windowsDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
  Write-Host "Windows template -> $windowsDir ($mb MB)"
}

Get-ChildItem (Join-Path $root "packages\cli\templates") -Recurse -File |
  Where-Object { $_.Extension -in @(".apk", ".exe", ".dll") } |
  Select-Object FullName, Length

# Builds the example library for Windows (x64 DLL) and Android (arm64 / x64 .so).
#
#   ./build-native.ps1            # everything it can build on this machine
#   ./build-native.ps1 -Platform windows
#
# Outputs land in web/native/<abi>/, which is what `nativeApi.load("demo")` expects:
#   web/native/x64/demo.dll      (Windows)
#   web/native/arm64/demo.so     (Android arm64)
#   web/native/x64/demo.so       (Android x86_64, for the emulator)
param(
  [ValidateSet("all", "windows", "android")]
  [string]$Platform = "all"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $root "src\demo.c"
$outRoot = Join-Path $root "web\native"

function New-OutputDir([string]$abi) {
  $dir = Join-Path $outRoot $abi
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  return $dir
}

function Build-Windows {
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path $vswhere)) { throw "vswhere not found; install Visual Studio with the C++ workload" }
  $install = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if (-not $install) { throw "Visual Studio C++ tools not found" }
  $vcvars = Join-Path $install "VC\Auxiliary\Build\vcvars64.bat"
  if (-not (Test-Path $vcvars)) { throw "vcvars64.bat not found under $install" }

  $dir = New-OutputDir "x64"
  Push-Location $dir
  try {
    cmd /c "call `"$vcvars`" >nul 2>&1 && cl /nologo /LD /O2 `"$source`" /Fe:demo.dll"
    if ($LASTEXITCODE -ne 0) { throw "cl failed with $LASTEXITCODE" }
    Remove-Item *.obj, *.lib, *.exp -ErrorAction SilentlyContinue
  } finally {
    Pop-Location
  }
  Write-Host "Windows: $dir\demo.dll"
}

function Build-Android([string]$target, [string]$abi) {
  $ndkRoot = if ($env:ANDROID_HOME) { Join-Path $env:ANDROID_HOME "ndk" } else { $null }
  if (-not $ndkRoot -or -not (Test-Path $ndkRoot)) { throw "Android NDK not found (set ANDROID_HOME)" }
  $ndk = Get-ChildItem $ndkRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1
  $clang = Join-Path $ndk.FullName "toolchains\llvm\prebuilt\windows-x86_64\bin\clang.exe"
  if (-not (Test-Path $clang)) { throw "clang not found in $($ndk.FullName)" }

  $dir = New-OutputDir $abi
  $out = Join-Path $dir "demo.so"
  & $clang "--target=$target" -shared -fPIC -O2 -pthread `
    "-Wl,-z,max-page-size=16384" "-Wl,-soname,demo.so" -o $out $source
  if ($LASTEXITCODE -ne 0) { throw "clang failed with $LASTEXITCODE" }
  Write-Host "Android $abi`: $out"
}

if ($Platform -in @("all", "windows")) {
  try { Build-Windows } catch { Write-Warning "Windows build skipped: $_" }
}
if ($Platform -in @("all", "android")) {
  try { Build-Android "aarch64-linux-android24" "arm64" } catch { Write-Warning "arm64 build skipped: $_" }
  try { Build-Android "x86_64-linux-android24" "x64" } catch { Write-Warning "x64 build skipped: $_" }
}

Get-ChildItem $outRoot -Recurse -File | Select-Object FullName, Length

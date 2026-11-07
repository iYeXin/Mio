# Builds the Android tool bundle used for on-demand download.
#
#   ./scripts/build-tools-bundle.ps1                 # uses JAVA_HOME + ANDROID_HOME
#   ./scripts/build-tools-bundle.ps1 -Out artifacts/tools
#
# Produces, per platform, two archives plus a manifest fragment:
#   mio-tools-<platform>-tools.tar.gz   apksigner.jar + zipalign (~1.5 MB)
#   mio-tools-<platform>-jre.tar.gz     jlink JRE, java.base + java.logging (~18 MB)
#   manifest-<platform>.json            sizes and sha256, file:// URLs for local tests
#
# The release workflow runs the same steps on ubuntu/windows/macos and merges the
# fragments into mio-tools.json with real asset URLs.
param(
  [string]$JdkHome = $env:JAVA_HOME,
  [string]$BuildTools,
  [string]$Out = "artifacts/tools",
  [string]$PlatformKey
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$outDir = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path $root $Out }

if (-not $PlatformKey) {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  $os = if ($IsWindows) { "win32" } elseif ($IsMacOS) { "darwin" } else { "linux" }
  $PlatformKey = "$os-$arch"
}

if (-not $BuildTools) {
  $sdk = $env:ANDROID_HOME ?? $env:ANDROID_SDK_ROOT
  if (-not $sdk) { throw "Set ANDROID_HOME or pass -BuildTools <build-tools dir>" }
  $BuildTools = Get-ChildItem (Join-Path $sdk "build-tools") -Directory |
    Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName
}

if (-not $JdkHome) { throw "Set JAVA_HOME or pass -JdkHome <jdk>" }
$jlink = Join-Path $JdkHome "bin/jlink.exe"
if (-not (Test-Path $jlink)) { throw "jlink not found in $JdkHome (a full JDK is required)" }

New-Item -ItemType Directory -Force $outDir | Out-Null
$stage = Join-Path $outDir "stage-$PlatformKey"
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$stage/tools" | Out-Null

# tools: apksigner.jar + zipalign
$jar = Join-Path $BuildTools "lib/apksigner.jar"
if (-not (Test-Path $jar)) { $jar = Join-Path $BuildTools "apksigner.jar" }
$align = Join-Path $BuildTools "zipalign.exe"
if (-not (Test-Path $align)) { $align = Join-Path $BuildTools "zipalign" }
if (-not (Test-Path $jar) -or -not (Test-Path $align)) {
  throw "apksigner.jar / zipalign not found under $BuildTools"
}
Copy-Item $jar "$stage/tools/apksigner.jar"
Copy-Item $align "$stage/tools/$(Split-Path -Leaf $align)"
$lib64 = Join-Path (Split-Path -Parent $align) "lib64"
if (Test-Path $lib64) { Copy-Item $lib64 "$stage/tools/lib64" -Recurse }

$toolsArchive = Join-Path $outDir "mio-tools-$PlatformKey-tools.tar.gz"
Remove-Item $toolsArchive -Force -ErrorAction SilentlyContinue
tar -czf $toolsArchive -C "$stage/tools" .

# jre: a trimmed runtime, ~30 MB on disk
$jreDir = Join-Path $stage "jre"
& $jlink --module-path (Join-Path $JdkHome "jmods") `
  --add-modules java.base,java.logging,jdk.crypto.ec --strip-debug --no-man-pages --no-header-files `
  --compress=zip-6 --output $jreDir
if ($LASTEXITCODE -ne 0) { throw "jlink failed" }

$jreArchive = Join-Path $outDir "mio-tools-$PlatformKey-jre.tar.gz"
Remove-Item $jreArchive -Force -ErrorAction SilentlyContinue
tar -czf $jreArchive -C $jreDir .

function Get-Digest([string]$path) {
  (Get-FileHash -Path $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

$toolsSize = (Get-Item $toolsArchive).Length
$jreSize = (Get-Item $jreArchive).Length
$manifest = [ordered]@{
  schemaVersion = 2
  latest       = "1"
  bundles      = [ordered]@{
    "1" = [ordered]@{
      platforms = [ordered]@{
        $PlatformKey = [ordered]@{
          tools = [ordered]@{
            url    = ([uri]$toolsArchive).AbsoluteUri
            sha256 = Get-Digest $toolsArchive
            size   = $toolsSize
            strip  = 0
          }
          jre   = [ordered]@{
            url    = ([uri]$jreArchive).AbsoluteUri
            sha256 = Get-Digest $jreArchive
            size   = $jreSize
            strip  = 0
          }
        }
      }
    }
  }
}
$manifestPath = Join-Path $outDir "manifest-$PlatformKey.json"
$manifest | ConvertTo-Json -Depth 8 | Set-Content $manifestPath -NoNewline

Remove-Item $stage -Recurse -Force
Write-Host "platform: $PlatformKey"
Write-Host "tools: $([math]::Round($toolsSize / 1MB, 2)) MB -> $toolsArchive"
Write-Host "jre:   $([math]::Round($jreSize / 1MB, 2)) MB -> $jreArchive"
Write-Host "manifest: $manifestPath"

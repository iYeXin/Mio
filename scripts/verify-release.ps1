# Verifies the release checklist items that can be automated.
#
#   ./scripts/verify-release.ps1           # fast checks
#   ./scripts/verify-release.ps1 -Full     # also runs typecheck/build/tests
#
# Exit code 0 means everything checked out.
param(
  [switch]$Full
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

$failures = @()
$checks = 0

function Check([string]$name, [scriptblock]$test) {
  $script:checks += 1
  try {
    $result = & $test
    if ($result -eq $false) {
      $script:failures += $name
      Write-Host "FAIL  $name" -ForegroundColor Red
    } else {
      Write-Host "ok    $name" -ForegroundColor DarkGray
    }
  } catch {
    $script:failures += "$name ($_)"
    Write-Host "FAIL  $name — $_" -ForegroundColor Red
  }
}

function Read-Version([string]$path) {
  $text = Get-Content $path -Raw
  if ($text -match '"version"\s*:\s*"([^"]+)"') { return $Matches[1] }
  if ($text -match 'version:\s*(\S+)') { return $Matches[1] }
  throw "no version in $path"
}

# --- versions -------------------------------------------------------------

$rootVersion = Read-Version "package.json"
Check "root package.json has a release version" { $rootVersion -match '^\d+\.\d+\.\d+$' }

foreach ($pkg in @("packages/cli", "packages/api", "packages/android-tools")) {
  Check "$pkg/lib version matches root" {
    (Read-Version "$pkg/package.json") -eq $rootVersion
  }
}

Check "MIO_CLI_VERSION matches root version" {
  (Get-Content "packages/cli/src/constants.ts" -Raw) -match "MIO_CLI_VERSION = `"$rootVersion`""
}

Check "MIO_API_VERSION identical in CLI and shell" {
  $cli = [regex]::Match((Get-Content "packages/cli/src/constants.ts" -Raw), 'MIO_API_VERSION = "([^"]+)"').Groups[1].Value
  $shell = [regex]::Match((Get-Content "shell/lib/src/api.dart" -Raw), "mioApiVersion = '([^']+)'").Groups[1].Value
  $api = [regex]::Match((Get-Content "packages/api/bootstrap.js" -Raw), 'apiVersion: "([0-9.]+)"').Groups[1].Value
  $cli -ne "" -and $cli -eq $shell -and $cli -eq $api
}

# --- license / docs -------------------------------------------------------

Check "LICENSE exists" { Test-Path "LICENSE" }
Check "CHANGELOG mentions the release" {
  (Get-Content "CHANGELOG.md" -Raw).Contains("## $rootVersion")
}
foreach ($doc in @(
  "README.md", "CHANGELOG.md", "LICENSE",
  "docs/api.md", "docs/architecture.md", "docs/native-extensions.md",
  "docs/signing.md", "docs/release.md",
  "docs/template-maintenance.md", "docs/README.md"
)) {
  Check "$doc exists" { Test-Path $doc }
}

Check "every api.dart method is documented" {
  $api = Get-Content "shell/lib/src/api.dart" -Raw
  $docs = Get-Content "docs/api.md" -Raw
  $methods = [regex]::Matches($api, "case '([a-zA-Z]+\.[a-zA-Z]+)'") | ForEach-Object { $_.Groups[1].Value }
  $missing = $methods | Where-Object { $docs -notmatch [regex]::Escape($_.Split('.')[1]) }
  @($missing).Count -eq 0
}

Check "every error code is documented" {
  $docs = Get-Content "docs/api.md" -Raw
  $codes = @()
  foreach ($file in Get-ChildItem "shell/lib/src/*.dart") {
    $codes += [regex]::Matches((Get-Content $file.FullName -Raw), "MioApiException\(\s*'([A-Z_]+)'") |
      ForEach-Object { $_.Groups[1].Value }
  }
  $missing = ($codes | Sort-Object -Unique) | Where-Object { $docs -notmatch [regex]::Escape($_) }
  @($missing).Count -eq 0
}

# --- templates ------------------------------------------------------------

# Prebuilt templates are release assets, not source: only the scaffold is tracked.
Check "web template is tracked" { Test-Path "packages/cli/templates/web/index.html" }
Check "template binaries are gitignored" {
  $ignored = Get-Content ".gitignore" -Raw
  $ignored -match "templates/android/\*\.apk" -and $ignored -match "templates/windows/"
}
Check "release workflow publishes templates" {
  (Test-Path ".github/workflows/release.yml") -and
  ((Get-Content ".github/workflows/release.yml" -Raw) -match "softprops/action-gh-release")
}
Check "manifest writer exists" { Test-Path "scripts/write-template-manifest.mjs" }
Check "build-templates script exists" { Test-Path "scripts/build-templates.ps1" }
Check "web template has no node_modules" {
  -not (Test-Path "packages/cli/templates/web/node_modules")
}

Check "no build artifacts committed under templates" {
  -not (Test-Path "packages/cli/templates/web/dist")
}

# --- tests ----------------------------------------------------------------

if ($Full) {
  Check "pnpm -r typecheck" { pnpm -r typecheck *> $null; $LASTEXITCODE -eq 0 }
  Check "pnpm -r build" { pnpm -r build *> $null; $LASTEXITCODE -eq 0 }
  Check "pnpm -r test" { pnpm -r test *> $null; $LASTEXITCODE -eq 0 }
  Push-Location shell
  try {
    Check "flutter analyze" { flutter analyze *> $null; $LASTEXITCODE -eq 0 }
    Check "flutter test" { flutter test *> $null; $LASTEXITCODE -eq 0 }
  } finally {
    Pop-Location
  }
}

Write-Host ""
if ($failures.Count -eq 0) {
  Write-Host "$checks checks passed." -ForegroundColor Green
  exit 0
}
Write-Host "$($failures.Count) of $checks checks failed:" -ForegroundColor Red
$failures | ForEach-Object { Write-Host "  - $_" }
exit 1

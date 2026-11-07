<#
.SYNOPSIS
    Sign a Windows executable with Authenticode, without requiring signtool.

.DESCRIPTION
    Uses PowerShell's Set-AuthenticodeSignature, which works with any
    code-signing certificate that is present in the certificate store or in a
    .pfx file. Useful when the Windows SDK signing tools are not installed.

    This script is a convenience for development and for CI environments where
    installing the SDK is undesirable. For production you should prefer a
    CA-issued certificate and either signtool or your certificate vendor's
    signing tool.

.PARAMETER Exe
    Path to the executable to sign.

.PARAMETER Thumbprint
    Thumbprint of a code-signing certificate in Cert:\CurrentUser\My.

.PARAMETER PfxPath
    Path to a .pfx file. Requires PfxPassword.

.PARAMETER PfxPassword
    Password for the .pfx file.

.PARAMETER TimestampServer
    RFC 3161 timestamp server. Defaults to DigiCert.

.EXAMPLE
    ./sign-windows.ps1 -Exe build/mio/windows/App/App.exe -Thumbprint ABC123...

.EXAMPLE
    ./sign-windows.ps1 -Exe App.exe -PfxPath cert.pfx -PfxPassword $env:CERT_PASS
#>
[CmdletBinding(DefaultParameterSetName = 'Store')]
param(
    [Parameter(Mandatory = $true)]
    [string] $Exe,

    [Parameter(Mandatory = $true, ParameterSetName = 'Store')]
    [string] $Thumbprint,

    [Parameter(Mandatory = $true, ParameterSetName = 'Pfx')]
    [string] $PfxPath,

    [Parameter(Mandatory = $true, ParameterSetName = 'Pfx')]
    [string] $PfxPassword,

    [Parameter(Mandatory = $false)]
    [string] $TimestampServer = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Exe)) {
    throw "Executable not found: $Exe"
}

$resolved = (Resolve-Path -LiteralPath $Exe).Path

if ($PSCmdlet.ParameterSetName -eq 'Pfx') {
    if (-not (Test-Path -LiteralPath $PfxPath)) {
        throw "PFX not found: $PfxPath"
    }
    $secure = ConvertTo-SecureString -String $PfxPassword -AsPlainText -Force
    $cert = Get-PfxCertificate -FilePath $PfxPath -Password $secure
    if (-not $cert) {
        throw "Could not load a certificate from $PfxPath"
    }
}
else {
    $stores = @("Cert:\CurrentUser\My", "Cert:\LocalMachine\My")
    $cert = $null
    foreach ($store in $stores) {
        # String concatenation rather than Join-Path: Join-Path validates the
        # Cert: drive and fails in hosts where the certificate provider is not
        # available, even though the store itself may be readable.
        $path = "$store\$Thumbprint"
        $candidate = Get-ChildItem -Path $path -ErrorAction SilentlyContinue
        if ($candidate) {
            $cert = $candidate
            break
        }
    }
    if (-not $cert) {
        throw "Certificate $Thumbprint was not found in Cert:\CurrentUser\My or Cert:\LocalMachine\My"
    }
}

if (-not $cert.HasPrivateKey) {
    throw "Certificate $($cert.Thumbprint) has no accessible private key"
}

Write-Host "Signing $resolved"
Write-Host "  subject: $($cert.Subject)"
Write-Host "  sha1:    $($cert.Thumbprint)"

$result = Set-AuthenticodeSignature `
    -FilePath $resolved `
    -Certificate $cert `
    -HashAlgorithm SHA256 `
    -TimestampServer $TimestampServer

# A self-signed certificate produces UnknownError, and the status message is
# localized. Inspect the chain instead: if the only problem is an untrusted
# root, the signature is cryptographically valid and only needs the root
# installed for Windows to report it as trusted.
function Test-OnlyUntrustedRoot {
    param([System.Security.Cryptography.X509Certificates.X509Certificate2] $Certificate)

    $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
    $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
    $null = $chain.Build($Certificate)

    $statuses = @($chain.ChainStatus | ForEach-Object { $_.Status })
    if ($statuses.Count -eq 0) { return $false }
    $other = @($statuses | Where-Object { $_ -ne 'UntrustedRoot' })
    return $other.Count -eq 0
}

if ($result.Status -eq 'UnknownError' -and (Test-OnlyUntrustedRoot -Certificate $cert)) {
    Write-Warning "Signature embedded with a self-signed chain. Install the root certificate to make Windows report it as trusted."
}
elseif ($result.Status -ne 'Valid') {
    throw "Signing failed: $($result.Status) — $($result.StatusMessage)"
}

$check = Get-AuthenticodeSignature -FilePath $resolved
Write-Host ""
Write-Host "Status:    $($check.Status)"
Write-Host "Signer:    $($check.SignerCertificate.Subject)"
if ($check.TimeStamperCertificate) {
    Write-Host "Timestamp: $($check.TimeStamperCertificate.Subject)"
}

if (-not $check.SignerCertificate) {
    throw "The executable is not signed after the operation"
}

Write-Host "OK"

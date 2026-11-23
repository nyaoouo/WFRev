param(
    [Parameter(Mandatory)][string]$Java,
    [Parameter(Mandatory)][string]$Signer,
    [Parameter(Mandatory)][string]$Keystore,
    [Parameter(Mandatory)][string]$AlignedApk,
    [Parameter(Mandatory)][string]$Destination,
    [string]$KeyAlias = 'wf-local',
    [switch]$UseEnvironmentPasswords
)

$ErrorActionPreference = 'Stop'
$passwordArguments = @('--ks-pass', 'pass:android')
if ($UseEnvironmentPasswords) {
    if ([string]::IsNullOrEmpty($env:STARPOINT_SIGNING_STORE_PASSWORD)) {
        throw 'Set STARPOINT_SIGNING_STORE_PASSWORD before signing.'
    }
    $passwordArguments = @('--ks-pass', 'env:STARPOINT_SIGNING_STORE_PASSWORD')
    if (![string]::IsNullOrEmpty($env:STARPOINT_SIGNING_KEY_PASSWORD)) {
        $passwordArguments += @('--key-pass', 'env:STARPOINT_SIGNING_KEY_PASSWORD')
    }
}
$stagedApk = Join-Path (Split-Path -Parent $AlignedApk) "signed-$([guid]::NewGuid()).apk"
try {
    & $Java -jar $Signer sign --ks $Keystore @passwordArguments --ks-key-alias $KeyAlias --out $stagedApk $AlignedApk
    if ($LASTEXITCODE -ne 0) { throw "APK signing failed ($LASTEXITCODE)" }
    & $Java -jar $Signer verify $stagedApk
    if ($LASTEXITCODE -ne 0) { throw "APK verification failed ($LASTEXITCODE)" }

    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $Destination))
    if ([IO.File]::Exists($Destination)) {
        [IO.File]::Replace($stagedApk, $Destination, [NullString]::Value)
    } else {
        [IO.File]::Move($stagedApk, $Destination)
    }
    Write-Output "APK: $Destination"
} finally {
    [IO.File]::Delete($stagedApk)
    [IO.File]::Delete("$stagedApk.idsig")
}

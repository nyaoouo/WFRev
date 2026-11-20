param([switch]$Offline)

$ErrorActionPreference = 'Stop'
$server = Join-Path (Split-Path $PSScriptRoot) 'startpoint-cn-main'
$build = Join-Path $PSScriptRoot 'build'
$runtime = Join-Path $build 'runtime'

function Invoke-Tool($tool, [string[]]$arguments) {
    & $tool @arguments
    if ($LASTEXITCODE -ne 0) { throw "Tool failed: $tool ($LASTEXITCODE)" }
}

if (!(Test-Path -LiteralPath "$server/package-lock.json" -PathType Leaf)) {
    throw 'Extract the pinned StarPoint CN source into startpoint-cn-main first.'
}

$install = @('ci', '--ignore-scripts', '--no-audit', '--no-fund')
if ($Offline) { $install += '--offline' }

Push-Location -LiteralPath $server
try {
    Invoke-Tool 'npm.cmd' $install
    Invoke-Tool 'npm.cmd' @('run', 'build:server')
    Invoke-Tool 'node.exe' @('tools/server-bundle/build.cjs')
    Invoke-Tool 'node.exe' @('tools/server-bundle/verify.cjs')
} finally {
    Pop-Location
}

New-Item -ItemType Directory -Force -Path "$runtime/admin" | Out-Null
Copy-Item -LiteralPath "$server/package.json", "$server/package-lock.json" -Destination $runtime -Force
Copy-Item -LiteralPath "$server/admin/package.json" -Destination "$runtime/admin" -Force
Push-Location -LiteralPath $runtime
try {
    Invoke-Tool 'npm.cmd' ($install + @('--omit=dev', '--workspaces=false'))
} finally {
    Pop-Location
}

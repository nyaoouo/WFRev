param(
    [switch]$RepackOnly,
    [switch]$ReuseRuntimeArchive,
    [string]$ToolchainDirectory,
    [string]$ClientToolsDirectory
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$resources = Join-Path $root 'resources'
$server = Join-Path $root 'startpoint-cn-main'
$client = Join-Path $server 'local-client'
$clientTools = if ($ClientToolsDirectory) { (Resolve-Path -LiteralPath $ClientToolsDirectory).Path } else { $client }
$baseApk = Join-Path $resources 'V1.8.1.apk'
$javaBin = (Get-ChildItem -LiteralPath "$clientTools/jdk" -Directory | Select-Object -First 1).FullName + '/bin'
$buildTools = "$clientTools/build-tools/android-14"
$toolchain = if ($ToolchainDirectory) { (Resolve-Path -LiteralPath $ToolchainDirectory).Path } else { "$resources/toolchain" }
$llvm = "$toolchain/android-ndk-r30/toolchains/llvm/prebuilt/windows-x86_64"
$build = "$PSScriptRoot/build"
$decoded = "$build/decoded"
$runtime = "$build/runtime"
$serverBundle = "$server/dist/server-bundle"
if (!(Test-Path -LiteralPath "$serverBundle/server-manifest.json" -PathType Leaf)) {
    $serverBundle = "$build/server-bundle"
}
$nodeHeaders = "$toolchain/include/node"
$addon = "$server/node_modules/better-sqlite3"
$renameDependency = "$PSScriptRoot/rename-native-dependency.cjs"
$gameSwf = 'worldflipper_android_release.swf'
$overlay = "$build/overlay"

function Invoke-Tool($tool, [string[]]$arguments) {
    & $tool @arguments
    if ($LASTEXITCODE -ne 0) { throw "Tool failed: $tool ($LASTEXITCODE)" }
}

if (!(Test-Path -LiteralPath $baseApk -PathType Leaf)) { throw "Missing original client: $baseApk" }
if ($RepackOnly -and !(Test-Path -LiteralPath "$build/dex/classes.dex" -PathType Leaf)) {
    throw 'Run a full build before using -RepackOnly.'
}
if (($RepackOnly -or $ReuseRuntimeArchive) -and !(Test-Path -LiteralPath "$decoded/assets/starpoint/runtime.zip" -PathType Leaf)) {
    throw 'The runtime archive is missing. Run a full build without -ReuseRuntimeArchive.'
}
if (!$RepackOnly -and !(Test-Path -LiteralPath "$addon/src/better_sqlite3.cpp" -PathType Leaf)) {
    throw 'Run app/prepare-backend.ps1 before building the APK.'
}
if (!$RepackOnly -and !$ReuseRuntimeArchive -and !(Test-Path -LiteralPath "$serverBundle/server-manifest.json" -PathType Leaf)) {
    throw 'Run app/prepare-backend.ps1 to build and verify the embedded server bundle.'
}

New-Item -ItemType Directory -Force -Path "$build/classes", "$build/dex", "$resources/apktool-framework" | Out-Null
if (!(Test-Path -LiteralPath "$decoded/apktool.yml" -PathType Leaf)) {
    Invoke-Tool "$javaBin/java.exe" @('-jar', "$resources/apktool_3.0.3.jar", 'd', '--no-src',
        '-p', "$resources/apktool-framework", '-o', $decoded, $baseApk)
}
New-Item -ItemType Directory -Force -Path "$decoded/assets/starpoint" | Out-Null

function Build-BackendRuntime([string]$abi, [string]$triple) {
    $nodeLibrary = "$toolchain/bin/$abi"
    $libraries = "$decoded/lib/$abi"
    $sqliteObject = "$build/sqlite3-$abi.o"
    $flags = @("--target=${triple}28", "--sysroot=$llvm/sysroot", '-O2', '-fPIC')
    $definitions = [regex]::Matches(
        (Get-Content -Raw -LiteralPath "$addon/deps/defines.gypi"),
        "'([A-Z][A-Z0-9_]*(?:=-?[0-9]+)?)'"
    ) | ForEach-Object { '-D' + $_.Groups[1].Value }
    New-Item -ItemType Directory -Force -Path $libraries | Out-Null
    Invoke-Tool "$llvm/bin/clang.exe" ($flags + $definitions + @('-c',
        "$addon/deps/sqlite3/sqlite3.c", '-o', $sqliteObject))
    Invoke-Tool "$llvm/bin/clang++.exe" ($flags + @('-std=c++20', '-shared', "-I$nodeHeaders",
        "-I$addon/deps/sqlite3", "$addon/src/better_sqlite3.cpp", $sqliteObject,
        "-L$nodeLibrary", '-lnode', '-Wl,-z,max-page-size=16384', '-ldl', '-lm',
        '-o', "$libraries/libstarpoint_sqlite.so"))
    Invoke-Tool "$llvm/bin/clang++.exe" ($flags + @('-std=c++20', '-shared', "-I$nodeHeaders",
        "$PSScriptRoot/src/main/cpp/node_bridge.cpp", "-L$nodeLibrary", '-lnode',
        '-Wl,-z,max-page-size=16384', '-llog', '-o', "$libraries/libstarpoint_bridge.so"))
    Copy-Item -LiteralPath "$nodeLibrary/libnode.so" -Destination $libraries
    Copy-Item -LiteralPath "$llvm/sysroot/usr/lib/$triple/libc++_shared.so" -Destination "$libraries/libsp_cxx_dep.so"
    $relink = @($renameDependency, 'libc++_shared.so', 'libsp_cxx_dep.so',
        "$libraries/libnode.so", "$libraries/libstarpoint_bridge.so",
        "$libraries/libstarpoint_sqlite.so", "$libraries/libsp_cxx_dep.so")
    if ($abi -eq 'x86_64') {
        Invoke-Tool "$llvm/bin/clang++.exe" ($flags + @('-std=c++20', '-pie', "-I$nodeHeaders",
            "$PSScriptRoot/src/main/cpp/node_main.cpp", "-L$nodeLibrary", '-lnode',
            '-Wl,-z,max-page-size=16384', '-o', "$libraries/libstarpoint_exec.so"))
        $relink += "$libraries/libstarpoint_exec.so"
    }
    Invoke-Tool 'node.exe' $relink
}

if (!$RepackOnly) {
    Build-BackendRuntime 'arm64-v8a' 'aarch64-linux-android'
    Build-BackendRuntime 'x86_64' 'x86_64-linux-android'
    Invoke-Tool 'tar.exe' @('-xf', $baseApk, '-C', $decoded,
        'lib/arm64-v8a/libc++_shared.so')
}

$baseClient = "$build/base-client"
New-Item -ItemType Directory -Force -Path "$overlay/assets", $baseClient | Out-Null
Invoke-Tool 'tar.exe' @('-xf', $baseApk, '-C', $baseClient, "assets/$gameSwf")
Invoke-Tool 'node.exe' @("$PSScriptRoot/patch-payment-client.cjs", "$javaBin/java.exe",
    "$clientTools/ffdec/ffdec.jar", "$baseClient/assets/$gameSwf",
    "$overlay/assets/$gameSwf", "$build/payment-client")
$gameHash = (Get-FileHash -LiteralPath "$overlay/assets/$gameSwf" -Algorithm SHA256).Hash
$airVersion = [guid]::ParseExact($gameHash.Substring(0, 32), 'N').ToString()

$manifestPath = "$decoded/AndroidManifest.xml"
[xml]$manifest = Get-Content -Raw -Encoding utf8 -LiteralPath $manifestPath
$android = 'http://schemas.android.com/apk/res/android'
$queries = $manifest.DocumentElement.SelectSingleNode('queries')
if (!$queries) {
    $queries = $manifest.CreateElement('queries')
    [void]$manifest.DocumentElement.AppendChild($queries)
}
$airActivity = $manifest.SelectSingleNode("/manifest/application/activity[@*[local-name()='name']='air.com.leiting.wf.AppEntry']")
$initialContent = $airActivity.SelectSingleNode("meta-data[@*[local-name()='name']='initialcontent']")
[void]$initialContent.SetAttribute('value', $android, $gameSwf)
# Keep the Android save identity and invalidate AIR's executable cache when the SWF changes.
$airCacheId = $airActivity.SelectSingleNode("meta-data[@*[local-name()='name']='uniqueappversionid']")
[void]$airCacheId.SetAttribute('value', $android, $airVersion)
$browserQuery = $queries.SelectSingleNode("intent[data[@*[local-name()='scheme']='http']]")
if (!$browserQuery) {
    $browserQuery = $manifest.CreateElement('intent')
    $browserAction = $manifest.CreateElement('action')
    $browserAction.SetAttribute('name', $android, 'android.intent.action.VIEW')
    [void]$browserQuery.AppendChild($browserAction)
    $browserData = $manifest.CreateElement('data')
    $browserData.SetAttribute('scheme', $android, 'http')
    [void]$browserQuery.AppendChild($browserData)
    [void]$queries.AppendChild($browserQuery)
}
$application = $manifest.manifest.application
$application.SetAttribute('extractNativeLibs', $android, 'true')
$application.SetAttribute('debuggable', $android, 'false')
foreach ($permissionName in 'android.permission.FOREGROUND_SERVICE', 'android.permission.MANAGE_EXTERNAL_STORAGE') {
    if (!($manifest.manifest.'uses-permission' | Where-Object { $_.GetAttribute('name', $android) -eq $permissionName })) {
        $permission = $manifest.CreateElement('uses-permission')
        $permission.SetAttribute('name', $android, $permissionName)
        [void]$manifest.manifest.InsertBefore($permission, $application)
    }
}
$oldEntry = $application.activity | Where-Object { $_.GetAttribute('name', $android) -eq 'com.leiting.sdk.activity.PrivacyActivity' }
$oldLauncher = $oldEntry.SelectNodes('intent-filter') | Where-Object {
    $_.SelectSingleNode('action').GetAttribute('name', $android) -eq 'android.intent.action.MAIN'
}
if ($oldLauncher) { [void]$oldEntry.RemoveChild($oldLauncher) }
if (!($application.provider | Where-Object { $_.GetAttribute('name', $android) -eq 'local.starpoint.BackendRecoveryProvider' })) {
    $provider = $manifest.CreateElement('provider')
    $provider.SetAttribute('name', $android, 'local.starpoint.BackendRecoveryProvider')
    $provider.SetAttribute('authorities', $android, 'com.leiting.wf.starpoint-recovery')
    $provider.SetAttribute('exported', $android, 'false')
    [void]$application.AppendChild($provider)
}
if (!($application.activity | Where-Object { $_.GetAttribute('name', $android) -eq 'local.starpoint.PaymentCheckoutActivity' })) {
    $checkout = $manifest.CreateElement('activity')
    [void]$checkout.SetAttribute('name', $android, 'local.starpoint.PaymentCheckoutActivity')
    [void]$checkout.SetAttribute('exported', $android, 'true')
    [void]$checkout.SetAttribute('screenOrientation', $android, 'portrait')
    [void]$checkout.SetAttribute('theme', $android, '@android:style/Theme.Material.Light.NoActionBar')
    $filter = $manifest.CreateElement('intent-filter')
    $action = $manifest.CreateElement('action')
    [void]$action.SetAttribute('name', $android, 'android.intent.action.VIEW')
    [void]$filter.AppendChild($action)
    foreach ($categoryName in 'android.intent.category.DEFAULT', 'android.intent.category.BROWSABLE') {
        $category = $manifest.CreateElement('category')
        [void]$category.SetAttribute('name', $android, $categoryName)
        [void]$filter.AppendChild($category)
    }
    $data = $manifest.CreateElement('data')
    [void]$data.SetAttribute('scheme', $android, 'starpoint-checkout')
    [void]$data.SetAttribute('host', $android, 'order')
    [void]$filter.AppendChild($data)
    [void]$checkout.AppendChild($filter)
    [void]$application.AppendChild($checkout)
}
if (!($application.activity | Where-Object { $_.GetAttribute('name', $android) -eq 'local.starpoint.OfflineEntry' })) {
    $entry = $manifest.CreateElement('activity')
    $entry.SetAttribute('name', $android, 'local.starpoint.OfflineEntry')
    $entry.SetAttribute('exported', $android, 'true')
    $entry.SetAttribute('screenOrientation', $android, 'portrait')
    $filter = $manifest.CreateElement('intent-filter')
    $action = $manifest.CreateElement('action')
    $action.SetAttribute('name', $android, 'android.intent.action.MAIN')
    [void]$filter.AppendChild($action)
    $category = $manifest.CreateElement('category')
    $category.SetAttribute('name', $android, 'android.intent.category.LAUNCHER')
    [void]$filter.AppendChild($category)
    [void]$entry.AppendChild($filter)
    [void]$application.AppendChild($entry)
    $service = $manifest.CreateElement('service')
    $service.SetAttribute('name', $android, 'local.starpoint.OfflineServer')
    $service.SetAttribute('exported', $android, 'false')
    $service.SetAttribute('process', $android, ':starpoint')
    [void]$application.AppendChild($service)
}
$manifest.Save($manifestPath)

if (!$RepackOnly) {
$androidJar = "$toolchain/android-35/android.jar"
$sources = @(Get-ChildItem -Recurse -File -Filter '*.java' "$PSScriptRoot/src/main/java" | ForEach-Object FullName)
Invoke-Tool "$javaBin/javac.exe" (@('-encoding', 'UTF-8', '-source', '8', '-target', '8',
    '-classpath', $androidJar, '-d', "$build/classes") + $sources)
Invoke-Tool "$javaBin/jar.exe" @('cf', "$build/offline-classes.jar", '-C', "$build/classes", '.')
Invoke-Tool "$javaBin/java.exe" @('-cp', "$buildTools/lib/d8.jar", 'com.android.tools.r8.D8',
    '--lib', $androidJar, '--min-api', '28', '--output', "$build/dex", "$decoded/classes.dex",
    "$build/offline-classes.jar")
}

if (!$RepackOnly -and !$ReuseRuntimeArchive) {
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$archiveFile = [IO.File]::Create("$decoded/assets/starpoint/runtime.zip")
$archive = [IO.Compression.ZipArchive]::new($archiveFile, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($directory in @("$runtime/node_modules", $serverBundle)) {
        $directory = (Resolve-Path -LiteralPath $directory).Path
        $parent = Split-Path $directory
        foreach ($file in Get-ChildItem -LiteralPath $directory -Recurse -File -Force) {
            $relative = $file.FullName.Substring($parent.Length + 1).Replace('\', '/')
            if ($relative.StartsWith('node_modules/.bin/') -or $relative.StartsWith('node_modules/starpoint-admin/')) {
                continue
            }
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,
                $file.FullName, $relative, [IO.Compression.CompressionLevel]::Fastest)
        }
    }
} finally {
    $archive.Dispose()
    $archiveFile.Dispose()
}
}
$scriptArguments = @(
    foreach ($script in Get-ChildItem -LiteralPath "$PSScriptRoot/src/main/assets" -Filter '*.cjs' -File) {
        Copy-Item -LiteralPath $script.FullName -Destination "$decoded/assets/starpoint/$($script.Name)"
        '-C'; $decoded; "assets/starpoint/$($script.Name)"
    }
)

Invoke-Tool "$javaBin/java.exe" @('-jar', "$resources/apktool_3.0.3.jar", 'b', '-p',
    "$resources/apktool-framework", '-o', "$build/offline-unsigned.apk", $decoded)
New-Item -ItemType Directory -Force -Path $overlay | Out-Null
Invoke-Tool 'tar.exe' @('-xf', "$build/offline-unsigned.apk", '-C', $overlay, 'AndroidManifest.xml')
$integrated = "$build/offline-overlay.apk"
Copy-Item -LiteralPath $baseApk -Destination $integrated -Force
$armLibraries = @('libnode.so', 'libstarpoint_sqlite.so', 'libsp_cxx_dep.so', 'libstarpoint_bridge.so')
# Both payloads must be extracted while Android selects ARM64 for the game itself.
# Unique names let the x86_64 child resolve its own ELF dependencies in that directory.
$x64LibraryNames = [ordered]@{
    'libnode.so' = 'libn64x.so'
    'libstarpoint_sqlite.so' = 'libstarpoint_sqlite_x64.so'
    'libsp_cxx_dep.so' = 'libsp_x64_dep.so'
    'libstarpoint_exec.so' = 'libstarpoint_exec_x64.so'
}
$x64Stage = "$overlay/lib/arm64-v8a"
New-Item -ItemType Directory -Force -Path $x64Stage | Out-Null
foreach ($library in $x64LibraryNames.GetEnumerator()) {
    Copy-Item -LiteralPath "$decoded/lib/x86_64/$($library.Key)" -Destination "$x64Stage/$($library.Value)"
}
$x64Files = @($x64LibraryNames.Values | ForEach-Object { "$x64Stage/$_" })
Invoke-Tool 'node.exe' (@($renameDependency, 'libsp_cxx_dep.so', 'libsp_x64_dep.so') + $x64Files)
Invoke-Tool 'node.exe' (@($renameDependency, 'libnode.so', 'libn64x.so') +
    @($x64Files | Where-Object {$_ -ne "$x64Stage/libsp_x64_dep.so"}))
$nativeArguments = @(
    foreach ($library in $armLibraries) { '-C'; $decoded; "lib/arm64-v8a/$library" }
    foreach ($library in $x64LibraryNames.Values) { '-C'; $overlay; "lib/arm64-v8a/$library" }
)
# Preserve the existing resource table and game assets. Apktool is used to compile the manifest.
# AIR reads its executable SWF as an uncompressed APK asset.
Invoke-Tool "$javaBin/jar.exe" @('u0f', $integrated, '-C', $overlay, "assets/$gameSwf")
Invoke-Tool "$javaBin/jar.exe" (@('uf', $integrated,
    '-C', $overlay, 'AndroidManifest.xml',
    '-C', "$build/dex", 'classes.dex',
    '-C', $decoded, 'assets/starpoint/runtime.zip') + $scriptArguments + $nativeArguments)
Invoke-Tool "$buildTools/zipalign.exe" @('-p', '-f', '4', $integrated, "$build/offline-aligned.apk")
& "$PSScriptRoot/publish-apk.ps1" -Java "$javaBin/java.exe" -Signer "$buildTools/lib/apksigner.jar" `
    -Keystore "$client/local-test.jks" -AlignedApk "$build/offline-aligned.apk" `
    -Destination "$PSScriptRoot/dist/WorldFlipper-CN-Offline.apk"
Remove-Item -LiteralPath "$build/offline-unsigned.apk", $integrated, "$build/offline-aligned.apk" -Force

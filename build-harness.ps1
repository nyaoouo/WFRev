param([ValidateSet('arm64-v8a', 'x86_64')][string]$Abi = 'arm64-v8a')

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$client = "$root/startpoint-cn-main/local-client"
$build = "$PSScriptRoot/build"
$decoded = "$build/decoded"
$harness = "$build/harness"
$java = (Get-ChildItem -LiteralPath "$client/jdk" -Directory | Select-Object -First 1).FullName + '/bin'
$tools = "$client/build-tools/android-14"
$platform = "$root/resources/toolchain/android-35/android.jar"

function Invoke-Tool($tool, [string[]]$arguments) {
    & $tool @arguments
    if ($LASTEXITCODE -ne 0) { throw "Tool failed: $tool ($LASTEXITCODE)" }
}

New-Item -ItemType Directory -Force -Path "$harness/classes", "$harness/dex" | Out-Null
$manifestPath = "$harness/AndroidManifest.xml"
@'
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="local.starpoint.harness">
    <uses-sdk android:minSdkVersion="28" android:targetSdkVersion="30"/>
    <uses-permission android:name="android.permission.INTERNET"/>
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>
    <uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE"/>
    <application android:label="StarPoint Offline Test" android:debuggable="true"
                 android:extractNativeLibs="true" android:usesCleartextTraffic="true">
        <activity android:name="local.starpoint.OfflineEntry" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN"/>
                <category android:name="android.intent.category.LAUNCHER"/>
            </intent-filter>
        </activity>
        <service android:name="local.starpoint.OfflineServer" android:process=":starpoint" android:exported="false"/>
    </application>
</manifest>
'@ | Set-Content -Encoding utf8 -LiteralPath $manifestPath

$sources = @(Get-ChildItem -Recurse -File -Filter '*.java' "$PSScriptRoot/src/main/java" | ForEach-Object FullName)
Invoke-Tool "$java/javac.exe" (@('-encoding', 'UTF-8', '-source', '8', '-target', '8',
    '-classpath', $platform, '-d', "$harness/classes") + $sources)
Invoke-Tool "$java/jar.exe" @('cf', "$harness/classes.jar", '-C', "$harness/classes", '.')
Invoke-Tool "$java/java.exe" @('-cp', "$tools/lib/d8.jar", 'com.android.tools.r8.D8',
    '--lib', $platform, '--min-api', '28', '--output', "$harness/dex", "$harness/classes.jar")
$apk = "$harness/unsigned.apk"
Invoke-Tool "$tools/aapt2.exe" @('link', '-I', $platform, '--manifest', $manifestPath, '-o', $apk)
$scriptArguments = @(
    foreach ($script in Get-ChildItem -LiteralPath "$PSScriptRoot/src/main/assets" -Filter '*.cjs' -File) {
        Copy-Item -LiteralPath $script.FullName -Destination "$decoded/assets/starpoint/$($script.Name)"
        '-C'; $decoded; "assets/starpoint/$($script.Name)"
    }
)
Invoke-Tool "$java/jar.exe" (@('uf', $apk,
    '-C', "$harness/dex", 'classes.dex',
    '-C', $decoded, 'assets/starpoint/runtime.zip',
    '-C', $decoded, "lib/$Abi/libnode.so",
    '-C', $decoded, "lib/$Abi/libstarpoint_bridge.so",
    '-C', $decoded, "lib/$Abi/libstarpoint_sqlite.so",
    '-C', $decoded, "lib/$Abi/libsp_cxx_dep.so") + $scriptArguments)
Invoke-Tool "$tools/zipalign.exe" @('-p', '-f', '4', $apk, "$harness/aligned.apk")
& "$PSScriptRoot/publish-apk.ps1" -Java "$java/java.exe" -Signer "$tools/lib/apksigner.jar" `
    -Keystore "$client/local-test.jks" -AlignedApk "$harness/aligned.apk" `
    -Destination "$PSScriptRoot/dist/harness/StarPoint-Offline-Test-$Abi.apk"
Remove-Item -LiteralPath $apk, "$harness/aligned.apk" -Force

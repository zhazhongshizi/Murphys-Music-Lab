[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$BundleRoot,

    [switch]$AllowFixtureProviderForSpike
)

$ErrorActionPreference = 'Stop'
$resolvedRoot = (Resolve-Path -LiteralPath $BundleRoot -ErrorAction Stop).Path
$providerExe = Join-Path $resolvedRoot 'qqmusic-provider.exe'
if (-not (Test-Path -LiteralPath $providerExe -PathType Leaf)) {
    throw 'Release provider executable is missing.'
}

$guardRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
    'qqmusic-provider-release-guard-' + [System.Guid]::NewGuid().ToString('N')
)
$guardDevicePath = Join-Path $guardRoot 'qq-device.json'
[void](New-Item -ItemType Directory -Path $guardRoot)

$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $providerExe
$startInfo.WorkingDirectory = $resolvedRoot
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
$startInfo.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)
$escapedGuardDevicePath = $guardDevicePath.Replace('"', '\"')
$startInfo.Arguments = "--device-path `"$escapedGuardDevicePath`""

$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
$responseLine = $null
$started = $false
try {
    if (-not $process.Start()) {
        throw 'Unable to start the release provider guard process.'
    }
    $started = $true
    $request = '{"v":1,"id":"release-guard","method":"system.handshake","params":{"protocolVersion":1}}'
    $process.StandardInput.WriteLine($request)
    $process.StandardInput.Flush()
    $process.StandardInput.Close()

    $readTask = $process.StandardOutput.ReadLineAsync()
    if (-not $readTask.Wait([System.TimeSpan]::FromSeconds(10))) {
        throw 'Release provider handshake timed out.'
    }
    $responseLine = $readTask.Result
    if (-not $process.WaitForExit(10000)) {
        throw 'Release provider did not stop after the handshake input closed.'
    }
}
finally {
    if ($started -and -not $process.HasExited) {
        $process.Kill()
        [void]$process.WaitForExit(5000)
    }
    $process.Dispose()
    $resolvedGuardRoot = [System.IO.Path]::GetFullPath($guardRoot)
    $resolvedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    if ($resolvedGuardRoot.StartsWith(
        $resolvedTempRoot,
        [System.StringComparison]::OrdinalIgnoreCase
    ) -and (Test-Path -LiteralPath $resolvedGuardRoot)) {
        Remove-Item -LiteralPath $resolvedGuardRoot -Recurse -Force
    }
}

try {
    $response = $responseLine | ConvertFrom-Json -ErrorAction Stop
}
catch {
    throw 'Release provider returned an invalid handshake frame.'
}
if ($response.v -ne 1 -or $response.id -ne 'release-guard' -or $response.ok -ne $true) {
    throw 'Release provider returned an unexpected handshake frame.'
}
$mode = $response.result.provider.mode
if ($mode -eq 'live') {
    Write-Host 'Release provider mode: live'
}
elseif ($mode -eq 'fixture' -and $AllowFixtureProviderForSpike) {
    Write-Warning 'Fixture provider accepted only because -AllowFixtureProviderForSpike was explicitly supplied.'
    return
}

else { throw "Release builds require provider mode 'live'; received '$mode'." }
$manifestPath = Join-Path (Split-Path -Parent $resolvedRoot) 'provider-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'Multi-provider release manifest is missing.' }
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$expectedQq = $manifest.providers | Where-Object { $_.id -eq 'qqmusic' }
if ($response.result.provider.name -ne $expectedQq.name -or $response.result.provider.version -ne $expectedQq.version -or
    $response.result.protocol.version -ne $expectedQq.protocolVersion -or
    ($response.result.capabilities | ConvertTo-Json -Depth 20 -Compress) -ne ($expectedQq.capabilities | ConvertTo-Json -Depth 20 -Compress) -or
    ($response.result.implementedMethods | ConvertTo-Json -Depth 20 -Compress) -ne ($expectedQq.implementedMethods | ConvertTo-Json -Depth 20 -Compress)) {
    throw 'QQ release provider metadata differs from its manifest.'
}
$resourceRoot = Split-Path -Parent $resolvedRoot
$pin = Get-Content -Raw -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'providers/node/runtime.json') | ConvertFrom-Json
if ((Get-FileHash -LiteralPath (Join-Path $resourceRoot 'node/node.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pin.executableSha256) {
    throw 'Node release guard runtime hash mismatch.'
}
& (Join-Path $resourceRoot 'node/node.exe') (Join-Path $PSScriptRoot 'stage-node-resources.mjs') --handshakes $resourceRoot
if ($LASTEXITCODE -ne 0) { throw 'Node release provider handshake guard failed.' }

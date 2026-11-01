[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Join-Path (Split-Path -Parent $PSScriptRoot) ('output/validation/release-tools-' + (New-Guid).Guid)
$package = Join-Path $root 'package'
New-Item -ItemType Directory -Path (Join-Path $package 'provider') -Force | Out-Null
foreach ($name in @('Music-Lab.exe', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'UPGRADE.md')) {
    [IO.File]::WriteAllText((Join-Path $package $name), 'fixture')
}
[IO.File]::WriteAllText((Join-Path $package 'provider/payload.bin'), 'fixture')
[IO.File]::WriteAllText((Join-Path $package 'provider/manifest.sha256'), (('0' * 64) + '  payload.bin'))
$required = @('provider/qqmusic-provider.exe', 'node/node.exe', 'node/LICENSE', 'providers/node/runtime.json', 'providers/node/netease/main.mjs', 'providers/node/netease/upstream-lock.json', 'providers/node/bilibili/main.mjs', 'contracts/protocol-v2.schema.json', 'contracts/protocol-v2.constants.json', 'licenses/provider-g/dependencies.json')
foreach ($relative in $required) {
    $file = Join-Path $package $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force | Out-Null
    [IO.File]::WriteAllText($file, 'fixture')
}
$inventory = @($required + @('provider/payload.bin', 'provider/manifest.sha256') | ForEach-Object { @{ path = $_ } })
@{ schemaVersion = 1; files = $inventory } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $package 'provider-manifest.json') -Encoding utf8
function Assert-Rejected([scriptblock]$Action, [string]$Name, [string]$Message) {
    $rejected = $false
    try { & $Action | Out-Null } catch {
        if ($Message -and $_.Exception.Message -notlike $Message) { throw }
        $rejected = $true
    }
    if (-not $rejected) { throw "Expected rejection: $Name" }
}
& (Join-Path $PSScriptRoot 'test-portable-contents.ps1') -PackageRoot $package
Assert-Rejected { & (Join-Path $PSScriptRoot 'test-release-smoke.ps1') -PackageRoot $package } 'old executable without isolated mode' 'This executable does not support isolated checks*'
[IO.File]::WriteAllText((Join-Path $package 'debug.log'), 'fixture')
Assert-Rejected { & (Join-Path $PSScriptRoot 'test-portable-contents.ps1') -PackageRoot $package } 'runtime log'
Remove-Item -LiteralPath (Join-Path $package 'debug.log')
[IO.File]::WriteAllText((Join-Path $package 'provider/unlisted.sqlite3'), 'fixture')
Assert-Rejected { & (Join-Path $PSScriptRoot 'test-portable-contents.ps1') -PackageRoot $package } 'unlisted Provider file'
Remove-Item -LiteralPath (Join-Path $package 'provider/unlisted.sqlite3')
Remove-Item -LiteralPath (Join-Path $package 'provider/payload.bin')
Assert-Rejected { & (Join-Path $PSScriptRoot 'test-portable-contents.ps1') -PackageRoot $package } 'missing Provider file'
$inventory += @{ path = '../outside.bin' }
@{ schemaVersion = 1; files = $inventory } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $package 'provider-manifest.json') -Encoding utf8
Assert-Rejected { & (Join-Path $PSScriptRoot 'test-portable-contents.ps1') -PackageRoot $package } 'inventory traversal'
$inventory = @($required + @('provider/payload.bin', 'provider/manifest.sha256') | ForEach-Object { @{ path = $_ } })
[IO.File]::WriteAllText((Join-Path $package 'provider/payload.bin'), 'fixture')
@{ schemaVersion = 1; files = $inventory } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $package 'provider-manifest.json') -Encoding utf8
foreach ($forbidden in @('providers/node/netease/tests/fixture.mjs', 'providers/node/bilibili/public-media-probe.mjs', 'node/node.pdb', 'provider-state/synthetic.json', 'providers/node/netease/probe.js.txt', 'provider/credentials.json')) {
    $caseRoot = Join-Path $root ('forbidden-' + [guid]::NewGuid().ToString('N'))
    Copy-Item -LiteralPath $package -Destination $caseRoot -Recurse
    $fixturePath = Join-Path $caseRoot $forbidden
    New-Item -ItemType Directory -Path (Split-Path -Parent $fixturePath) -Force | Out-Null
    [IO.File]::WriteAllText($fixturePath, 'synthetic forbidden fixture')
    $expectedError = if ($forbidden.StartsWith('provider-state/')) { 'Unexpected portable entry*' } else { 'Forbidden portable resource*' }
    Assert-Rejected { & (Join-Path $PSScriptRoot 'test-portable-contents.ps1') -PackageRoot $caseRoot } $forbidden $expectedError
}
$source = Join-Path $root 'sources'
New-Item -ItemType Directory -Path (Join-Path $source 'src-tauri') -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $source 'package.json'), '{"version":"1.0.1"}')
[IO.File]::WriteAllText((Join-Path $source 'src-tauri/tauri.conf.json'), '{"version":"1.0.1"}')
[IO.File]::WriteAllText((Join-Path $source 'src-tauri/Cargo.toml'), "[package]`nname = `"qqmusic-gui`"`nversion = `"1.0.1`"")
[IO.File]::WriteAllText((Join-Path $source 'src-tauri/Cargo.lock'), "[[package]]`nname = `"qqmusic-gui`"`nversion = `"1.0.1`"")
& (Join-Path $PSScriptRoot 'assert-version-sources.ps1') -RepositoryRoot $source
[IO.File]::WriteAllText((Join-Path $source 'package.json'), '{"version":"1.0.2"}')
Assert-Rejected { & (Join-Path $PSScriptRoot 'assert-version-sources.ps1') -RepositoryRoot $source } 'version mismatch'
Write-Host "Release tools: 14 checks passed. Fixtures: $root"

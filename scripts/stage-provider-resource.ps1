[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = Join-Path $repositoryRoot 'provider\dist\qqmusic-provider'
$resourcesRoot = Join-Path $repositoryRoot 'src-tauri\resources'
$temporaryRoot = Join-Path $resourcesRoot ('multi-provider.staging-' + [guid]::NewGuid().ToString('N'))

if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'manifest.sha256') -PathType Leaf)) {
    throw 'Packaged provider manifest is missing. Run scripts/build-provider.ps1 first.'
}

& (Join-Path $PSScriptRoot 'verify-provider-manifest.ps1') -BundleRoot $sourceRoot -QqOnly

$resolvedResources = [System.IO.Path]::GetFullPath($resourcesRoot)
$resolvedTemporary = [System.IO.Path]::GetFullPath($temporaryRoot)
foreach ($candidate in @($resolvedTemporary)) {
    if (-not $candidate.StartsWith($resolvedResources + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to stage outside Tauri resources: '$candidate'."
    }
}

New-Item -ItemType Directory -Path $resourcesRoot -Force | Out-Null
if (Test-Path -LiteralPath $temporaryRoot) {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
Copy-Item -LiteralPath $sourceRoot -Destination (Join-Path $temporaryRoot 'provider') -Recurse
$node = & (Join-Path $PSScriptRoot 'bootstrap-node-runtime.ps1')
$python = Join-Path $repositoryRoot 'provider/.venv/Scripts/python.exe'
& $python (Join-Path $PSScriptRoot 'generate-provider-notices.py')
if ($LASTEXITCODE -ne 0) { throw 'Third-party inventory generation failed.' }
& $node (Join-Path $PSScriptRoot 'stage-node-resources.mjs') --stage $temporaryRoot
if ($LASTEXITCODE -ne 0) { throw 'Node resource staging failed.' }
New-Item -ItemType Directory -Path (Join-Path $temporaryRoot 'licenses') | Out-Null
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'licenses/provider-g') -Destination (Join-Path $temporaryRoot 'licenses/provider-g') -Recurse
& $node (Join-Path $PSScriptRoot 'stage-node-resources.mjs') --inventory $temporaryRoot
if ($LASTEXITCODE -ne 0) { throw 'Multi-provider inventory generation failed.' }
& (Join-Path $PSScriptRoot 'verify-provider-manifest.ps1') -BundleRoot (Join-Path $temporaryRoot 'provider')
& (Join-Path $PSScriptRoot 'assert-release-provider.ps1') -BundleRoot (Join-Path $temporaryRoot 'provider')
foreach ($name in @('provider', 'node', 'providers', 'contracts', 'licenses', 'provider-manifest.json')) {
    $target = [IO.Path]::GetFullPath((Join-Path $resourcesRoot $name))
    if (-not $target.StartsWith($resolvedResources + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Resource destination escapes resources root.' }
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    Move-Item -LiteralPath (Join-Path $temporaryRoot $name) -Destination $target
}
Remove-Item -LiteralPath $temporaryRoot
Write-Host "Staged all production providers and licenses: $resourcesRoot"

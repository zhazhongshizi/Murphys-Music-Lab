[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PackageRoot,
    [switch]$AllowDebugForValidation
)
$ErrorActionPreference = 'Stop'
# Keep the established portable/smoke entrypoints as the single implementation.
& (Join-Path $PSScriptRoot 'test-release-smoke.ps1') -PackageRoot $PackageRoot -AllowDebugForValidation:$AllowDebugForValidation

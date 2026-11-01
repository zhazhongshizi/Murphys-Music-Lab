$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $repoRoot 'providers/node/runtime.json') -Raw | ConvertFrom-Json
$runtimeRoot = Join-Path $repoRoot "output/node-$($manifest.version)"
$archive = Join-Path $runtimeRoot "node-v$($manifest.version)-win-x64.zip"
$expanded = Join-Path $runtimeRoot 'bundled'
$executable = Join-Path $expanded "node-v$($manifest.version)-win-x64/node.exe"
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest -Uri $manifest.archiveUrl -OutFile $archive -TimeoutSec 120
}
# Always verify both inputs, including when a previously expanded EXE exists.
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.archiveSha256) {
    throw 'Node archive hash mismatch; retained for inspection, not extracted'
}
if (-not (Test-Path -LiteralPath $executable)) {
    Expand-Archive -LiteralPath $archive -DestinationPath $expanded
}
if ((Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.executableSha256) {
    throw 'Node executable hash mismatch'
}
if ((& $executable --version) -ne "v$($manifest.version)") { throw 'Node runtime version mismatch' }
# Return only the verified executable path; retain LICENSE and the complete official ZIP.
Write-Output $executable

[CmdletBinding()]
param([Parameter(Mandatory)][string]$PackageRoot)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $PackageRoot).Path
$allowed = @('Music-Lab.exe', 'provider', 'node', 'providers', 'contracts', 'licenses', 'provider-manifest.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'UPGRADE.md')
$directories = @('provider', 'node', 'providers', 'contracts', 'licenses')
$entries = @(Get-ChildItem -LiteralPath $root -Force)
foreach ($entry in $entries) {
    if ($entry.Name -notin $allowed -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Unexpected portable entry: $($entry.Name)" }
    if (($entry.Name -in $directories) -ne $entry.PSIsContainer) { throw "Unexpected entry type: $($entry.Name)" }
}
foreach ($name in $allowed) { if ($name -notin $entries.Name) { throw "Missing portable entry: $name" } }
$manifest = Get-Content -LiteralPath (Join-Path $root 'provider-manifest.json') -Raw | ConvertFrom-Json
$expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($file in $manifest.files) {
    $relative = [string]$file.path
    if ($relative -match '(^/|\\|:|(^|/)\.\.?(/|$))' -or $relative.Split('/')[0] -notin $directories -or -not $expected.Add($relative)) { throw "Unsafe or duplicate inventory entry: $relative" }
}
foreach ($required in @('provider/qqmusic-provider.exe', 'provider/manifest.sha256', 'node/node.exe', 'node/LICENSE', 'providers/node/runtime.json', 'providers/node/netease/main.mjs', 'providers/node/netease/upstream-lock.json', 'providers/node/bilibili/main.mjs', 'contracts/protocol-v2.schema.json', 'contracts/protocol-v2.constants.json', 'licenses/provider-g/dependencies.json')) {
    if (-not $expected.Contains($required)) { throw "Missing required resource: $required" }
}
$actual = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$pending = [Collections.Generic.Stack[string]]::new()
foreach ($name in $directories) { $pending.Push((Join-Path $root $name)) }
while ($pending.Count) {
    foreach ($entry in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Portable contains a reparse point.' }
        $relative = $entry.FullName.Substring($root.Length + 1).Replace('\', '/')
        if ($relative -match '(^|/)(tests?|__tests__|fixtures?|__fixtures__|manual-spikes|provider-state|logs?|coverage|\.github|\.git|examples?|docs|\.bin)(/|$)' -or
            $relative -match '\.js\.txt$|\.(pdb|log|sqlite3?|db|py[co])$' -or
            $entry.Name -match '^(public-media-probe|handshake|write-fixture-entry|fake-provider|provider-media-probe|bilibili-production-probe)' -or
            $entry.Name -match '^(credentials?|cookies?|qq-device|device|auth)[^/]*\.json$') { throw "Forbidden portable resource: $relative" }
        if ($entry.PSIsContainer) { $pending.Push($entry.FullName); continue }
        if (-not $expected.Contains($relative)) { throw "Unlisted resource file: $relative" }
        [void]$actual.Add($relative)
    }
}
if (-not $actual.SetEquals($expected)) { throw 'Resource inventory has missing files.' }
Write-Host "Portable contents passed: $($actual.Count) resources; required runtime/providers/licenses present; no development fixtures, probes or user state."

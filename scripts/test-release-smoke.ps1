[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PackageRoot,
    [switch]$AllowDebugForValidation
)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'test-portable-contents.ps1') -PackageRoot $PackageRoot
$resolvedPackage = (Resolve-Path -LiteralPath $PackageRoot).Path
$sourceExecutable = Join-Path $resolvedPackage 'Music-Lab.exe'
# Older binaries ignore unknown arguments and could open real account data.
if (-not [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($sourceExecutable)).Contains('QQMusicGUI/IsolatedSmoke/v2')) {
    throw 'This executable does not support isolated checks. Rebuild first; no program was launched.'
}
# v2 uses a per-process isolated app identifier and independent data/credential
# stores, so the user's existing GUI can stay open throughout this check.
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$reviewRoot = Join-Path $repositoryRoot ('output/validation/release-smoke-' + (New-Guid).Guid)
New-Item -ItemType Directory -Path $reviewRoot | Out-Null
Get-ChildItem -LiteralPath $resolvedPackage -Force | Copy-Item -Destination $reviewRoot -Recurse
$executable = Join-Path $reviewRoot 'Music-Lab.exe'
$resultPath = Join-Path $reviewRoot '.release-smoke/data/result.json'
$phasePath = Join-Path $reviewRoot '.release-smoke/data/phase.txt'
$providerPaths = @((Join-Path $reviewRoot 'provider/qqmusic-provider.exe'), (Join-Path $reviewRoot 'node/node.exe'))
$info = [Diagnostics.ProcessStartInfo]::new()
$info.FileName = $executable
$info.Arguments = '--release-smoke'
$info.WorkingDirectory = $reviewRoot
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
# These directories contain Windows components only. All three Providers must
# resolve their interpreter/dependencies from the copied package, never PATH.
$info.EnvironmentVariables['PATH'] = "$env:SystemRoot\System32;$env:SystemRoot"
foreach ($key in @('NODE_PATH', 'NODE_OPTIONS', 'PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV')) { $info.EnvironmentVariables.Remove($key) }
$process = [Diagnostics.Process]::Start($info)
$owned = @{}
$unauthenticatedSamples = 0
$unauthenticatedProviderCount = 0
$unauthenticatedProviderTcpCount = 0
$deadline = [DateTime]::UtcNow.AddSeconds(180)
try {
    do {
        $phase = if (Test-Path -LiteralPath $phasePath) { [IO.File]::ReadAllText($phasePath) } else { 'unauthenticated' }
        $children = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='qqmusic-provider.exe' OR Name='python.exe'")
        # Do not attribute an allowed handshake child to the preceding phase if
        # the phase changed while CIM took the process snapshot.
        $phaseAfterSnapshot = if (Test-Path -LiteralPath $phasePath) { [IO.File]::ReadAllText($phasePath) } else { 'unauthenticated' }
        $unauthenticatedSample = $phase -eq 'unauthenticated' -and $phaseAfterSnapshot -eq 'unauthenticated'
        foreach ($child in $children) {
            if ($providerPaths -contains $child.ExecutablePath -and ($child.ParentProcessId -eq $process.Id -or $owned.ContainsKey([int]$child.ParentProcessId))) {
                $owned[[int]$child.ProcessId] = [pscustomobject]@{ id = [int]$child.ProcessId; parentId = [int]$child.ParentProcessId; path = [string]$child.ExecutablePath }
                if ($unauthenticatedSample) {
                    $unauthenticatedProviderCount++
                    $unauthenticatedProviderTcpCount += @(Get-NetTCPConnection -OwningProcess $child.ProcessId -ErrorAction SilentlyContinue).Count
                }
            }
        }
        if ($unauthenticatedSample) { $unauthenticatedSamples++ }
        if ([DateTime]::UtcNow -ge $deadline) { throw 'Isolated package check timed out.' }
        Start-Sleep -Milliseconds 100
        $process.Refresh()
    } while (-not $process.HasExited)
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw "Isolated package check exited with code $($process.ExitCode). See $resultPath" }
    $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
    if ($result.protocol -ne 'QQMusicGUI/IsolatedSmoke/v2' -or -not $result.passed -or -not $result.isolatedData -or $result.accountCredentialsAccessed -or -not $result.providersDisabledWithoutCredentials -or $result.instanceIdentifier -ne "dev.qqmusic.gui.isolated-smoke.p$($process.Id)" -or -not $result.providerAcl.Ok.mainAllowed -or -not $result.providerIpc.Ok.mainLoginReachedHandler) { throw 'Package startup/core/Provider IPC checks failed.' }
    if ($unauthenticatedSamples -lt 2 -or $unauthenticatedProviderCount -ne 0 -or $unauthenticatedProviderTcpCount -ne 0) { throw 'Fresh-data startup spawned a Provider or made a Provider connection.' }
    if ($result.channel -ne 'Release' -and -not $AllowDebugForValidation) { throw 'Expected a Release build.' }
    $remaining = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='qqmusic-provider.exe' OR Name='python.exe'" | Where-Object { $providerPaths -contains $_.ExecutablePath })
    if ($remaining.Count) { throw 'An owned packaged Provider remained after application exit.' }
    $observation = [ordered]@{
        cleanedPath = $info.EnvironmentVariables['PATH']; systemNodeOrPythonInPath = $false
        unauthenticatedSamples = $unauthenticatedSamples; unauthenticatedProviderProcessesObserved = $unauthenticatedProviderCount
        unauthenticatedProviderTcpConnectionsObserved = $unauthenticatedProviderTcpCount
        ownedChildrenObserved = @($owned.Values); providersRemainingAfterExit = $remaining.Count
        limitation = 'Process/TCP observations are sampled; deterministic disabled/generation checks and offline lifecycle regressions complement them. Account, audio and visual acceptance are separate.'
    }
    $observationPath = Join-Path $reviewRoot '.release-smoke/data/process-observations.json'
    [IO.File]::WriteAllText($observationPath, ($observation | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    Write-Host "Isolated $($result.channel) startup, real Provider IPC/ACL, three-Provider handshakes, schema-11 copy migration and cleanup passed: $resultPath"
    Write-Host "Clean-PATH/process evidence: $observationPath"
    Write-Host 'Actual account login, audio, desktop visual and phone Remote acceptance remain pending.'
}
finally {
    $running = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)"
    if ($running -and $running.ExecutablePath -eq $executable) { Stop-Process -Id $process.Id -Force }
    foreach ($entry in $owned.Values) {
        $child = Get-CimInstance Win32_Process -Filter "ProcessId=$($entry.id)"
        if ($child -and $child.ExecutablePath -eq $entry.path -and $child.ParentProcessId -eq $entry.parentId) { Stop-Process -Id $entry.id -Force }
    }
    $process.Dispose()
}

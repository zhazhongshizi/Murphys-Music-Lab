param([switch]$PublicMedia)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$node = & (Join-Path $PSScriptRoot 'bootstrap-node-runtime.ps1')
Push-Location $repoRoot
try {
    if (-not $PublicMedia) {
        & $node --test 'providers/node/tests/*.test.mjs'
        if ($LASTEXITCODE -ne 0) { throw 'Node probe tests failed' }
    }
    if ($PublicMedia) {
        $probe = Join-Path $repoRoot 'src-tauri/target/debug/provider-media-probe.exe'
        if (-not (Test-Path -LiteralPath $probe)) { throw 'Build provider-media-probe with manual-spikes first' }
        # ProcessStartInfo pipes keep signed CDN URLs off command lines and disk.
        $resolverInfo = [System.Diagnostics.ProcessStartInfo]::new()
        $resolverInfo.FileName = $node
        $resolverInfo.WorkingDirectory = $repoRoot
        $resolverInfo.Arguments = 'providers/node/bilibili/public-media-probe.mjs --public-probe BV1fK4y1t7hj'
        $resolverInfo.UseShellExecute = $false
        $resolverInfo.CreateNoWindow = $true
        $resolverInfo.RedirectStandardOutput = $true
        $resolverInfo.RedirectStandardError = $true
        $resolver = [System.Diagnostics.Process]::Start($resolverInfo)
        $descriptorTask = $resolver.StandardOutput.ReadToEndAsync()
        $resolverError = $resolver.StandardError.ReadToEndAsync()
        if (-not $resolver.WaitForExit(60000)) { $resolver.Kill(); throw 'Owned public resolver timed out' }
        if ($resolver.ExitCode -ne 0) { throw "Public resolver failed: $($resolverError.Result)" }
        $descriptor = $descriptorTask.Result
        $info = [System.Diagnostics.ProcessStartInfo]::new()
        $info.FileName = $probe
        $info.WorkingDirectory = $repoRoot
        $info.Arguments = '--stdin-public-probe'
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        $info.RedirectStandardInput = $true
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
        $native = [System.Diagnostics.Process]::Start($info)
        $native.StandardInput.Write($descriptor)
        $native.StandardInput.Close()
        $descriptor = $null
        $output = $native.StandardOutput.ReadToEndAsync()
        $diagnostic = $native.StandardError.ReadToEndAsync()
        if (-not $native.WaitForExit(180000)) { $native.Kill(); throw 'Owned native probe timed out' }
        if ($native.ExitCode -ne 0) { throw "Native probe failed: $($diagnostic.Result)" }
        Write-Output $output.Result
    }
} finally { Pop-Location }

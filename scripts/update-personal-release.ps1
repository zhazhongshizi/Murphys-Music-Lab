[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ArchivePath
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$output = (Resolve-Path -LiteralPath (Join-Path $repo 'output')).Path
$destination = Join-Path $output 'personal-release'
$archive = Get-Item -LiteralPath $ArchivePath
if ($archive.PSIsContainer -or $archive.Name -notmatch '^Murphys-Music-Lab_\d+\.\d+\.\d+.*_x64-portable_.+\.zip$') {
    throw 'Select a versioned Music Lab portable ZIP.'
}

foreach ($path in @($output, $destination)) {
    if ((Test-Path -LiteralPath $path) -and ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Refusing to update through a linked directory: '$path'."
    }
}

$work = Join-Path $output ('personal-release-update-' + [Guid]::NewGuid().ToString('N'))
$staged = Join-Path $work 'new'
$backup = Join-Path $work 'previous'
$moved = [Collections.Generic.List[string]]::new()
$installed = [Collections.Generic.List[string]]::new()
$keepBackup = $false
try {
    New-Item -ItemType Directory -Path $work | Out-Null
    Expand-Archive -LiteralPath $archive.FullName -DestinationPath $staged
    & (Join-Path $PSScriptRoot 'test-portable-contents.ps1') -PackageRoot $staged
    & (Join-Path $PSScriptRoot 'verify-provider-manifest.ps1') -BundleRoot (Join-Path $staged 'provider')
    $entries = @(Get-ChildItem -LiteralPath $staged -Force)
    $exe = Get-Item -LiteralPath (Join-Path $staged 'Music-Lab.exe')
    $version = $exe.VersionInfo.ProductVersion
    if (-not $version -or -not $archive.Name.StartsWith("Murphys-Music-Lab_${version}_x64-portable_", [StringComparison]::Ordinal)) {
        throw 'Portable executable version does not match the ZIP name.'
    }

    if (Test-Path -LiteralPath $destination) {
        $prefix = $destination + [IO.Path]::DirectorySeparatorChar
        $running = @(Get-CimInstance Win32_Process -Filter "Name='Music-Lab.exe' OR Name='qqmusic-provider.exe' OR Name='node.exe'" |
            Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })
        if ($running.Count) { throw 'Close the personal Music Lab instance before updating it.' }
    }
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    New-Item -ItemType Directory -Path $backup | Out-Null

    # Swap only package-owned entries. Keep adjacent local music, logs and databases.
    foreach ($entry in $entries) {
        $current = Join-Path $destination $entry.Name
        if (Test-Path -LiteralPath $current) {
            if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Unexpected linked entry in personal release: '$current'."
            }
            Move-Item -LiteralPath $current -Destination $backup
            $moved.Add($entry.Name)
        }
        Move-Item -LiteralPath $entry.FullName -Destination $destination
        $installed.Add($entry.Name)
    }
    Write-Host "Personal release updated: $version — $destination\Music-Lab.exe"
}
catch {
    try {
        foreach ($name in $installed) {
            Move-Item -LiteralPath (Join-Path $destination $name) -Destination $staged
        }
        foreach ($name in $moved) {
            Move-Item -LiteralPath (Join-Path $backup $name) -Destination $destination
        }
    }
    catch {
        $keepBackup = $true
        Write-Warning "Update recovery files were kept in '$work'."
    }
    throw
}
finally {
    if (-not $keepBackup -and (Test-Path -LiteralPath $work)) {
        $actual = (Resolve-Path -LiteralPath $work).Path
        if ($actual -eq $work -and (Split-Path -Parent $actual) -eq $output -and
            ((Get-Item -LiteralPath $actual -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
            Remove-Item -LiteralPath $actual -Recurse -Force
        }
    }
}

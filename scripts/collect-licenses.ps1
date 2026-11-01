# Collect upstream license texts from Cargo's resolved package source; no binaries are executed.
param([Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$Destination = [IO.Path]::GetFullPath($Destination)
$installerRoot = [IO.Path]::GetFullPath((Join-Path $workspace 'installer')) + [IO.Path]::DirectorySeparatorChar
if (-not $Destination.StartsWith($installerRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'License destination must be inside installer staging' }
$metadataText = & cargo metadata --locked --format-version 1 --filter-platform x86_64-pc-windows-msvc --manifest-path (Join-Path $workspace 'src-tauri\Cargo.toml')
if ($LASTEXITCODE -ne 0) { throw 'cargo metadata failed' }
$metadata = $metadataText | ConvertFrom-Json
New-Item -ItemType Directory -Path $Destination -Force | Out-Null
$index = @()
foreach ($package in $metadata.packages) {
  if ($package.name -eq 'namu') { continue }
  $packageDir = Split-Path -Parent $package.manifest_path
  $target = Join-Path $Destination ($package.name + '-' + $package.version)
  New-Item -ItemType Directory -Path $target -Force | Out-Null
  $notices = Get-ChildItem -LiteralPath $packageDir -File | Where-Object Name -Match '^(?i:license|licence|notice|copying|copyright)'
  foreach ($notice in $notices) { Copy-Item -LiteralPath $notice.FullName -Destination $target }
  if ($package.license_file) {
    $explicit = Join-Path $packageDir $package.license_file
    if (Test-Path -LiteralPath $explicit) { Copy-Item -LiteralPath $explicit -Destination $target }
  }
  $index += [pscustomobject]@{name=$package.name;version=$package.version;license=$package.license;repository=$package.repository}
}
$index | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $Destination 'index.json') -Encoding UTF8
Write-Host ("Collected Cargo license metadata for {0} packages" -f $index.Count)

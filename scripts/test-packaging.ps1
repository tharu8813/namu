# Local packaging fixtures; no installed runtime or user's model data is modified.
$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $PSScriptRoot
$fixture = Join-Path $workspace ("test-results\bundle-fixture-" + [guid]::NewGuid().ToString("N"))
$source = Join-Path $fixture 'source'
$destination = Join-Path $fixture 'bundle'
foreach ($relative in @('lib\ollama\cpu_avx2','lib\ollama\cuda_v12','lib\ollama\rocm')) {
  New-Item -ItemType Directory -Path (Join-Path $source $relative) -Force | Out-Null
}
foreach ($relative in @('ollama.exe','lib\ollama\ggml-base.dll','lib\ollama\cpu_avx2\ggml-cpu-avx2.dll','lib\ollama\cuda_v12\gpu.dll','lib\ollama\rocm\gpu.dll')) {
  Set-Content -LiteralPath (Join-Path $source $relative) -Value 'fixture only - never execute'
}
Set-Content -LiteralPath (Join-Path $source 'LICENSE') -Value 'fixture license'
& (Join-Path $PSScriptRoot 'prepare-ollama-bundle.ps1') -Source $source -Destination $destination
if (-not (Test-Path -LiteralPath (Join-Path $destination 'lib\ollama\cpu_avx2\ggml-cpu-avx2.dll'))) { throw 'CPU subdirectory was not preserved' }
if (Test-Path -LiteralPath (Join-Path $destination 'lib\ollama\cuda_v12')) { throw 'Unexpected GPU payload' }
if (-not (Test-Path -LiteralPath (Join-Path $destination 'LICENSE'))) { throw 'Missing runtime license' }
$rejected = $false
try { & (Join-Path $PSScriptRoot 'prepare-ollama-bundle.ps1') -Source $source -Destination $destination } catch { $rejected = $true }
if (-not $rejected) { throw 'Existing payload must not be overwritten' }
$package = Get-Content -LiteralPath (Join-Path $workspace 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$tauri = Get-Content -LiteralPath (Join-Path $workspace 'src-tauri\tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$cargo = [regex]::Match((Get-Content -LiteralPath (Join-Path $workspace 'src-tauri\Cargo.toml') -Raw), '(?m)^version = "([^"]+)"').Groups[1].Value
if ($package.version -ne $tauri.version -or $package.version -ne $cargo) { throw 'Package versions differ' }
Write-Host 'packaging: CPU backend subdirectories, excluded GPU libraries, license notices, no overwrite, consistent versions — passed'

param(
  [string]$Source = (Join-Path $env:LOCALAPPDATA "Programs\Ollama"),
  [string]$Destination = (Join-Path $PSScriptRoot "..\src-tauri\ollama-bundle")
)
# Copy a CPU-capable runtime, preserving CPU backend subdirectories and license notices.
$ErrorActionPreference = "Stop"
$Source = [IO.Path]::GetFullPath($Source)
$Destination = [IO.Path]::GetFullPath($Destination)
if (-not (Test-Path -LiteralPath (Join-Path $Source "ollama.exe"))) { throw "설치된 Ollama를 찾지 못했습니다: $Source" }
if (Test-Path -LiteralPath $Destination) { throw "기존 번들 폴더를 보존합니다. 검토 후 별도 경로로 준비하세요: $Destination" }
$libSource = Join-Path $Source "lib\ollama"
if (-not (Test-Path -LiteralPath $libSource)) { throw "지원하는 lib\ollama 런타임 구조가 없습니다. 공식 Ollama 배포본을 확인하세요." }
$stage = $Destination + ".partial-" + [guid]::NewGuid().ToString("N")
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item -LiteralPath (Join-Path $Source "ollama.exe") -Destination $stage
Get-ChildItem -LiteralPath $Source -File | Where-Object {
  $_.Extension -eq ".dll" -or $_.Name -match '(?i)license|notice|copying'
} | Copy-Item -Destination $stage
$libDestination = Join-Path $stage "lib\ollama"
New-Item -ItemType Directory -Path $libDestination -Force | Out-Null
Get-ChildItem -LiteralPath $libSource -File -Recurse | ForEach-Object {
  $relative = $_.FullName.Substring($libSource.Length).TrimStart('\')
  $parts = $relative.Split('\')
  $runtime = $_.Extension -in ".dll", ".exe"
  $license = $_.Name -match '(?i)license|notice|copying'
  if (($runtime -or $license) -and ($parts.Count -eq 1 -or $parts[0] -match '^cpu(?:[_-].*)?$')) {
    $target = Join-Path $libDestination $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $target
  }
}
$files = Get-ChildItem -LiteralPath $libDestination -Recurse -File
if (-not ($files | Where-Object Name -Match '^ggml.*\.dll$')) { throw "CPU 런타임 DLL이 없습니다. 부분 복사본을 보존했습니다: $stage" }
$notice = Get-ChildItem -LiteralPath $stage -Recurse -File | Where-Object Name -Match '(?i)license|notice|copying'
if (-not $notice) { throw "Ollama/llama.cpp 라이선스 고지가 없습니다. 공식 배포본의 고지를 포함한 뒤 다시 준비하세요. 부분 복사본: $stage" }
# No existing destination is overwritten.
Move-Item -LiteralPath $stage -Destination $Destination
$size = (Get-ChildItem -LiteralPath $Destination -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ("Ollama CPU 런타임 준비 완료: {0:N2} GB — {1}" -f ($size / 1GB), $Destination)

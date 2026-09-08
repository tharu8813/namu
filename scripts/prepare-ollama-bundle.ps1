# 설치된 공식 Ollama의 범용 CPU 런타임을 Tauri 번들 리소스로 복사한다.
# 모델과 CUDA/ROCm GPU 라이브러리는 포함하지 않는다. 모델은 사용자 계정의 .ollama 또는 OLLAMA_MODELS에 보관된다.
$ErrorActionPreference = "Stop"

$source = Join-Path $env:LOCALAPPDATA "Programs\Ollama"
$destination = Join-Path $PSScriptRoot "..\src-tauri\ollama-bundle"

if (-not (Test-Path -LiteralPath (Join-Path $source "ollama.exe"))) {
  throw "설치된 Ollama를 찾지 못했습니다: $source"
}
if (Test-Path -LiteralPath $destination) {
  throw "기존 번들 폴더가 있습니다. 버전을 바꾸려면 내용을 확인한 뒤 수동으로 교체하세요: $destination"
}

New-Item -ItemType Directory -Path $destination | Out-Null
Copy-Item -LiteralPath (Join-Path $source "ollama.exe") -Destination $destination
$libSource = Join-Path $source "lib\ollama"
$libDestination = Join-Path $destination "lib\ollama"
New-Item -ItemType Directory -Path $libDestination -Force | Out-Null
Get-ChildItem -LiteralPath $libSource -File -Include "*.dll", "*.exe" | Copy-Item -Destination $libDestination -Force

$size = (Get-ChildItem -LiteralPath $destination -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ("Ollama CPU 런타임 준비 완료: {0:N2} GB" -f ($size / 1GB))

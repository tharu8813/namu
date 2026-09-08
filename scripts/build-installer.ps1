<#
  Namu — 설치 프로그램 빌드
  1) 테스트  2) tauri build --no-bundle  3) payload 스테이징  4) ISCC 로 설치본 생성

  사용: powershell -ExecutionPolicy Bypass -File scripts\build-installer.ps1
  결과: installer\output\Namu-Setup-<버전>.exe
#>
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"

$exeName   = "Namu.exe"
$releaseDir = Join-Path $root "src-tauri\target\release"
$bundleDir  = Join-Path $root "src-tauri\ollama-bundle"
$payload    = Join-Path $root "installer\payload"

function Find-ISCC {
  $cands = @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
  )
  $hit = $cands | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $hit) { $hit = (Get-Command iscc -ErrorAction SilentlyContinue).Source }
  if (-not $hit) { throw "Inno Setup 6 (ISCC.exe) 를 찾지 못했습니다. https://jrsoftware.org/isdl.php 에서 설치하세요." }
  $hit
}

Write-Host "=== 테스트 ===" -ForegroundColor Cyan
node test.mjs
if ($LASTEXITCODE -ne 0) { throw "테스트 실패 — 빌드 중단" }

Write-Host "=== 앱 빌드 (tauri build --no-bundle) ===" -ForegroundColor Cyan
npm run build -- --no-bundle
if ($LASTEXITCODE -ne 0) { throw "tauri build 실패" }

$exe = Join-Path $releaseDir $exeName
if (-not (Test-Path $exe)) {
  # productName 이 아직 반영 안 된 경우 대비: release 폴더의 최신 .exe 를 찾는다
  $exe = Get-ChildItem $releaseDir -Filter *.exe -ErrorAction SilentlyContinue |
         Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
  if (-not $exe) { throw "빌드된 실행 파일을 $releaseDir 에서 찾지 못했습니다." }
}

Write-Host "=== payload 스테이징 ===" -ForegroundColor Cyan
if (Test-Path $payload) { Remove-Item $payload -Recurse -Force }
New-Item -ItemType Directory -Force -Path $payload | Out-Null

Copy-Item $exe (Join-Path $payload $exeName) -Force
# 실행 파일 옆의 런타임 DLL (WebView2Loader 등, 정적 링크면 없을 수 있음)
Get-ChildItem $releaseDir -Filter *.dll -ErrorAction SilentlyContinue |
  ForEach-Object { Copy-Item $_.FullName $payload -Force }

# 동봉 Ollama 런타임 — ollama\ollama.exe + ollama\lib\ollama\ 의 CPU 런타임만.
# lib\ollama\ 아래 cuda_v* · rocm_* · vulkan 서브폴더(GPU 런타임, 수 GB)는 제외한다.
# GPU 가속이 필요한 사용자는 공식 Ollama 를 따로 띄우면 앱이 그 인스턴스를 쓴다.
if (-not (Test-Path (Join-Path $bundleDir "ollama.exe"))) {
  throw "ollama-bundle 가 준비되지 않았습니다. scripts\prepare-ollama-bundle.ps1 을 먼저 실행하세요."
}
$libDst = Join-Path $payload "ollama\lib\ollama"
New-Item -ItemType Directory -Force -Path $libDst | Out-Null
Copy-Item (Join-Path $bundleDir "ollama.exe") (Join-Path $payload "ollama\ollama.exe") -Force
$libSrc = Join-Path $bundleDir "lib\ollama"
if (Test-Path $libSrc) {
  Get-ChildItem $libSrc -File |
    Where-Object { $_.Extension -in ".dll", ".exe" } |
    ForEach-Object { Copy-Item $_.FullName $libDst -Force }
}

$size = "{0:N1} MB" -f ((Get-ChildItem $payload -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)
Write-Host "payload: $payload  ($size)" -ForegroundColor DarkGray

Write-Host "=== 설치 프로그램 생성 (ISCC) ===" -ForegroundColor Cyan
$iscc = Find-ISCC
& $iscc "setup.iss"
if ($LASTEXITCODE -ne 0) { throw "ISCC 컴파일 실패" }

$out = Get-ChildItem (Join-Path $root "installer\output") -Filter *.exe |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Host "`n완료: $($out.FullName)" -ForegroundColor Green

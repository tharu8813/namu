<#
  Namu — 설치 프로그램 빌드
  1) 테스트  2) tauri build --no-bundle  3) payload 스테이징  4) ISCC 로 설치본 생성

  사용: powershell -ExecutionPolicy Bypass -File scripts\build-installer.ps1
  결과: installer\output\Namu-Setup-<버전>.exe
#>
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
. (Join-Path $PSScriptRoot 'dev-env.ps1')

$exeName   = "Namu.exe"
$releaseDir = Join-Path $root "src-tauri\target\release"
$bundleDir  = Join-Path $root "src-tauri\ollama-bundle"
$payload    = Join-Path $root ("installer\payload-" + [guid]::NewGuid().ToString("N"))
$packageVersion = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$tauriVersion = (Get-Content -LiteralPath (Join-Path $root 'src-tauri\tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($packageVersion -ne $tauriVersion) { throw 'package.json / tauri.conf.json 버전 불일치' }
if (-not (Test-Path -LiteralPath (Join-Path $bundleDir 'ollama.exe'))) { throw '동봉 런타임이 없습니다. prepare-ollama-bundle.ps1을 먼저 실행하세요.' }

function Find-ISCC {
  $cands = @(
    "${env:ProgramFiles(x86)}\Inno Setup 7\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 7\ISCC.exe",
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
Push-Location (Join-Path $root 'src-tauri')
try {
  cargo check --locked
  if ($LASTEXITCODE -ne 0) { throw 'Rust 컴파일 검사 실패' }
  cargo test --locked
  if ($LASTEXITCODE -ne 0) { throw 'Rust 테스트 실패' }
} finally { Pop-Location }

Write-Host "=== 앱 빌드 (tauri build --no-bundle) ===" -ForegroundColor Cyan
npm run build -- --no-bundle
if ($LASTEXITCODE -ne 0) { throw "tauri build 실패" }

$exe = Join-Path $releaseDir $exeName
if (-not (Test-Path $exe)) {
  throw "빌드된 Namu.exe를 찾지 못했습니다. 다른 실행 파일을 임의로 패키징하지 않습니다."
}

Write-Host "=== payload 스테이징 ===" -ForegroundColor Cyan
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
Copy-Item -LiteralPath $bundleDir -Destination (Join-Path $payload 'ollama') -Recurse
Copy-Item -LiteralPath (Join-Path $root 'LICENSE') -Destination (Join-Path $payload 'Namu-LICENSE.txt')
& (Join-Path $PSScriptRoot 'collect-licenses.ps1') -Destination (Join-Path $payload 'licenses')

$size = "{0:N1} MB" -f ((Get-ChildItem $payload -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)
Write-Host "payload: $payload  ($size)" -ForegroundColor DarkGray

Write-Host "=== 설치 프로그램 생성 (ISCC) ===" -ForegroundColor Cyan
$iscc = Find-ISCC
& $iscc "/DMyAppVersion=$packageVersion" "/DPayloadDir=$payload" "setup.iss"
if ($LASTEXITCODE -ne 0) { throw "ISCC 컴파일 실패" }

$out = Get-ChildItem (Join-Path $root "installer\output") -Filter *.exe |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Host "`n완료: $($out.FullName)" -ForegroundColor Green

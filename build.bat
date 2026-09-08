@echo off
setlocal
cd /d "%~dp0"
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
chcp 65001 >nul

where cargo >nul 2>nul || (echo [오류] cargo 를 찾을 수 없습니다. https://rustup.rs 에서 Rust 설치 후 새 창에서 다시 실행하세요. & exit /b 1)

if not exist node_modules (
  echo === npm install ===
  call npm install || exit /b 1
)

echo === 테스트 ===
call node test.mjs || (echo [오류] 테스트 실패 - 빌드 중단 & exit /b 1)

echo === 빌드 (tauri build) ===
call npm run build || exit /b 1

echo.
echo 완료.
echo   실행 파일 : src-tauri\target\release\local-ai-chat.exe
echo   설치본    : src-tauri\target\release\bundle\nsis\
endlocal

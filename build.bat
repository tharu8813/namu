@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (
  call npm.cmd ci || exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\dev.ps1" installer
exit /b %ERRORLEVEL%

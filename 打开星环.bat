@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "星环.exe" (
  start "" "星环.exe"
  exit /b 0
)
if exist "release\win-unpacked\Halora.exe" (
  start "" "release\win-unpacked\Halora.exe"
  exit /b 0
)
if exist "halora-app\Halora.exe" (
  start "" "halora-app\Halora.exe"
  exit /b 0
)
echo 还没有打包。先运行 npm run pack。
pause

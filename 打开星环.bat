@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "星环.exe" (
  start "" "星环.exe"
  exit /b 0
)
echo 还没有打包。先运行 npm run pack。
pause

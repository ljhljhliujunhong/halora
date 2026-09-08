@echo off
chcp 65001 >nul
set "APP=E:\VsCodeProject\Agent缓存文件\halora-app\Halora.exe"
if exist "%APP%" (
  start "" "%APP%"
  exit /b 0
)
set "APP=E:\VsCodeProject\Agent缓存文件\gongfang-app\Xinghuan.exe"
if exist "%APP%" (
  start "" "%APP%"
  exit /b 0
)
set "APP=E:\VsCodeProject\Agent缓存文件\gongfang-app\Gongfang.exe"
if exist "%APP%" (
  start "" "%APP%"
  exit /b 0
)
echo 还没有生成 Halora。
pause

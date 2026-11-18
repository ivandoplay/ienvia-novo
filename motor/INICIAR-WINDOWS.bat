@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-windows.ps1"
if errorlevel 1 (
  echo [Ienvia] Falha na preparacao. Confira o erro acima.
  pause
  exit /b 1
)
set "NODE_BIN=node"
if exist "%~dp0.runtime\node\node.exe" (
  "%~dp0.runtime\node\node.exe" -e "if(Number(process.versions.node.split('.')[0]) < 24) process.exit(1)" >nul 2>&1
  if not errorlevel 1 set "NODE_BIN=%~dp0.runtime\node\node.exe"
)
"%NODE_BIN%" "%~dp0src\iniciar-guiado.mjs"
if errorlevel 1 pause

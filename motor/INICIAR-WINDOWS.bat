@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-windows.ps1"
if errorlevel 1 (
  echo [Ienvia] Falha na preparacao. Confira o erro acima.
  pause
  exit /b 1
)
if exist "%~dp0.runtime\node\node.exe" (
  "%~dp0.runtime\node\node.exe" "%~dp0src\iniciar-guiado.mjs"
) else (
  node "%~dp0src\iniciar-guiado.mjs"
)
if errorlevel 1 pause

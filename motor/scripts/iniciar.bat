@echo off
setlocal
cd /d "%~dp0\.."

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-windows.ps1" -SomenteRuntime
if errorlevel 1 exit /b 1
set "NODE_BIN=node"
if exist ".runtime\node\node.exe" (
  set "NODE_BIN=.runtime\node\node.exe"
)

:loop
set "SUPERVISOR=src\supervisor.mjs"
if exist ".runtime\ienvia-bootstrap\supervisor.mjs" set "SUPERVISOR=.runtime\ienvia-bootstrap\supervisor.mjs"
"%NODE_BIN%" "%SUPERVISOR%" %*
if "%ERRORLEVEL%"=="42" (
  echo [Ienvia Motor] Reiniciando apos atualizacao automatica...
  timeout /t 2 /nobreak >nul
  goto loop
)
exit /b %ERRORLEVEL%

@echo off
setlocal
cd /d "%~dp0\.."

set "NODE_BIN=node"
if exist ".runtime\node\node.exe" (
  set "NODE_BIN=.runtime\node\node.exe"
)

:loop
"%NODE_BIN%" src\index.mjs %*
if "%ERRORLEVEL%"=="42" (
  echo [Ienvia Motor] Reiniciando apos atualizacao automatica...
  timeout /t 2 /nobreak >nul
  goto loop
)
exit /b %ERRORLEVEL%

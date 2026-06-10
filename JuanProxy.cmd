@echo off
setlocal

set "APP_DIR=%~dp0"
set "ELECTRON_CMD=%APP_DIR%node_modules\.bin\electron.cmd"
pushd "%APP_DIR%" || exit /b 1

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Install Node.js 22 or newer, then run this launcher again.
  pause
  popd
  exit /b 1
)

if not exist "%ELECTRON_CMD%" (
  echo Dependencies not found.
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    popd
    exit /b 1
  )
)

start "JuanProxy" "%ELECTRON_CMD%" .
popd
exit /b 0

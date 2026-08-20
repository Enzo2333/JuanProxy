@echo off
setlocal

set "APP_DIR=%~dp0"
set "ELECTRON_CMD=%APP_DIR%node_modules\.bin\electron.cmd"
set "JUANPROXY_ELECTRON_EXE=%APP_DIR%node_modules\electron\dist\electron.exe"
pushd "%APP_DIR%" || exit /b 1

call :stop_existing_juanproxy

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

:stop_existing_juanproxy
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$target = $env:JUANPROXY_ELECTRON_EXE; Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'electron.exe' -and $_.ExecutablePath -ieq $target } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 500"
exit /b 0

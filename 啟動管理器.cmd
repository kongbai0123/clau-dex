@echo off
rem Hand off to Electron and exit at once so no console window stays open.
set "ELECTRON=%~dp0node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" (
  echo Electron is missing. Run setup.ps1, or npm install and node node_modules\electron\install.js.
  pause
  exit /b 1
)
set ELECTRON_RUN_AS_NODE=
start "" "%ELECTRON%" "%~dp0."

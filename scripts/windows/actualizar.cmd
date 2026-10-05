@echo off
rem Double-click wrapper: incremental update after unzipping a new version over the same folder.
rem Keeps .env, storage\ and models\; only installs/downloads/rebuilds what changed or is missing.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -Update %*
pause

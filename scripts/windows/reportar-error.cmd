@echo off
rem Double-click wrapper: builds an error report even when the app does not start.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0reportar-error.ps1" %*
pause

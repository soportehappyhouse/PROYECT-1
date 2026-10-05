@echo off
rem Double-click wrapper: runs doctor.ps1 without changing the execution policy.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0doctor.ps1" %*
pause

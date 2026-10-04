@echo off
rem Double-click wrapper: runs start.ps1 without changing the execution policy.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*

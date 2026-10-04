@echo off
rem Double-click wrapper: runs stop.ps1 without changing the execution policy.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1" %*

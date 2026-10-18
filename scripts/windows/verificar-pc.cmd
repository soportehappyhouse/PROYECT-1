@echo off
rem Double-click wrapper: measures this PC (Test de rendimiento + Evaluar modelos Rapida + stems 1 min).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0verificar-pc.ps1" %*
pause

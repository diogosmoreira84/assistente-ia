@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Connect-Portal.ps1"
if errorlevel 1 pause

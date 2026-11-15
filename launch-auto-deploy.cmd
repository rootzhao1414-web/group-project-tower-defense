@echo off
setlocal
chcp 65001 >nul
node "%~dp0auto-deploy.mjs"
if errorlevel 1 pause

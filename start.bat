@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   Starting AI Hub ...
echo.
node server.js
echo.
echo   Server stopped.
pause

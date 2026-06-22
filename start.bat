@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Starting MD Stats...
npm start
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Failed to start. Make sure you have run: npm install
    pause
)

@echo off
echo.
echo   EXCH — Build System
echo   ====================
echo.
echo   [1/2] Installing dependencies...
call npm install
if %ERRORLEVEL% neq 0 (
    echo   ERROR: npm install failed.
    pause
    exit /b 1
)
echo.
echo   [2/2] Packaging into exchange.exe...
call npx -y @yao-pkg/pkg@5.12.0 . --targets node20-win-x64 --output exchange.exe --compress GZip
echo.
if exist exchange.exe (
    echo   ==========================================
    echo   Build successful!
    echo   Run exchange.exe to start the server.
    echo   ==========================================
) else (
    echo   Build failed. You can still run directly:
    echo     node server.js
)
echo.
pause

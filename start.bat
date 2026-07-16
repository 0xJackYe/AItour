@echo off
chcp 65001 >nul
title AItour - AI Travel Assistant

echo ================================
echo   AItour Starting...
echo ================================
echo.

:: Check dependencies
if not exist "node_modules" (
    echo Installing root dependencies...
    call npm install
)
if not exist "server\node_modules" (
    echo Installing server dependencies...
    cd server && call npm install && cd ..
)
if not exist "client\node_modules" (
    echo Installing client dependencies...
    cd client && call npm install && cd ..
)

echo Starting server and client...
echo   Server: http://localhost:3001
echo   Client: http://localhost:5173
echo.
echo Press Ctrl+C to stop.
echo.

npm run dev

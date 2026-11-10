@echo off
cd /d "%~dp0\.."
node agent-src\build-agent.js
pause

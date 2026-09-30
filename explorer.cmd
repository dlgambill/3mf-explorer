@echo off
REM 3MF Explorer launcher. Double-click to start, then open the URL it prints.
set NODE_NO_WARNINGS=1
cd /d "%~dp0"
if /I "%~1"=="scan" (
  node scan-cli.mjs %2 %3 %4 %5 %6 %7 %8 %9
) else (
  start "" http://localhost:7333
  node server.mjs
)

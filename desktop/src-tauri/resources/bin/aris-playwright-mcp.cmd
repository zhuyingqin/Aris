@echo off
setlocal

set "ROOT=%~dp0.."
set "NODE=%ROOT%\node\node.exe"
set "SCRIPT=%ROOT%\mcp\playwright\node_modules\@playwright\mcp\cli.js"
set "VERSION=0.0.76"

if exist "%SCRIPT%" (
  if exist "%NODE%" (
    "%NODE%" "%SCRIPT%" %*
    exit /b %ERRORLEVEL%
  )
  where node >nul 2>nul
  if %ERRORLEVEL% EQU 0 (
    node "%SCRIPT%" %*
    exit /b %ERRORLEVEL%
  )
)

where npx >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  npx -y @playwright/mcp@%VERSION% %*
  exit /b %ERRORLEVEL%
)

echo ARIS Playwright MCP runtime is missing. Rebuild the desktop bundle with `npm run build:resources`, or install Node.js/npm and retry. 1>&2
exit /b 1

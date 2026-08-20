@echo off
setlocal

set "ROOT=%~dp0.."
set "NODE=%ROOT%\node\node.exe"
set "SCRIPT=%ROOT%\mcp\playwright\node_modules\@playwright\mcp\cli.js"
set "VERSION=0.0.76"
rem The desktop worker owns the persistent browser when --cdp-endpoint is used.
rem Do not give MCP a second profile that can lock the same Edge user data dir.
set "HAS_CDP="
for %%A in (%*) do if /I "%%~A"=="--cdp-endpoint" set "HAS_CDP=1"
if not defined HAS_CDP if not defined PLAYWRIGHT_MCP_USER_DATA_DIR set "PLAYWRIGHT_MCP_USER_DATA_DIR=.somniq\tmp\browser\profile"
if not defined PLAYWRIGHT_MCP_OUTPUT_DIR set "PLAYWRIGHT_MCP_OUTPUT_DIR=.somniq\tmp\browser\output"
if defined PLAYWRIGHT_MCP_USER_DATA_DIR if not exist "%PLAYWRIGHT_MCP_USER_DATA_DIR%" mkdir "%PLAYWRIGHT_MCP_USER_DATA_DIR%" >nul 2>nul
if not exist "%PLAYWRIGHT_MCP_OUTPUT_DIR%" mkdir "%PLAYWRIGHT_MCP_OUTPUT_DIR%" >nul 2>nul

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

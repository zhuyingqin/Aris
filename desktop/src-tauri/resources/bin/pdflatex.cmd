@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "SELF=%~f0"
for /f "delims=" %%P in ('where pdflatex 2^>nul') do (
  set "CANDIDATE=%%~fP"
  set "CANDIDATE_DIR=%%~dpP"
  if /I not "!CANDIDATE!"=="%SELF%" if /I not "!CANDIDATE_DIR!"=="%~dp0" (
    "!CANDIDATE!" %*
    exit /b !ERRORLEVEL!
  )
)

set "ENTRY="
for %%A in (%*) do (
  echo %%~A | findstr /R /I "\.tex$" >nul && set "ENTRY=%%~A"
)

if not defined ENTRY if exist main.tex set "ENTRY=main.tex"
if not defined ENTRY (
  echo pdflatex fallback could not find a .tex entrypoint. 1>&2
  exit /b 2
)

set "TECTONIC_BIN=%ARIS_TECTONIC%"
if not defined TECTONIC_BIN set "TECTONIC_BIN=%~dp0tectonic.exe"
if not exist "%TECTONIC_BIN%" (
  echo pdflatex fallback requires tectonic.exe in resources\bin or ARIS_TECTONIC. 1>&2
  exit /b 127
)

"%TECTONIC_BIN%" --keep-logs --keep-intermediates "%ENTRY%"
exit /b %ERRORLEVEL%

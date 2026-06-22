@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "SELF=%~f0"
for /f "delims=" %%P in ('where latexmk 2^>nul') do (
  set "CANDIDATE=%%~fP"
  set "CANDIDATE_DIR=%%~dpP"
  if /I not "!CANDIDATE!"=="%SELF%" if /I not "!CANDIDATE_DIR!"=="%~dp0" (
    "!CANDIDATE!" %*
    exit /b !ERRORLEVEL!
  )
)

set "CLEAN="
set "ENTRY="
for %%A in (%*) do (
  if /I "%%~A"=="-C" set "CLEAN=1"
  echo %%~A | findstr /R /I "\.tex$" >nul && set "ENTRY=%%~A"
)

if defined CLEAN (
  del /q *.aux *.bbl *.bcf *.blg *.fdb_latexmk *.fls *.log *.out *.run.xml *.synctex.gz *.toc 2>nul
  exit /b 0
)

if not defined ENTRY if exist main.tex set "ENTRY=main.tex"
if not defined ENTRY (
  for %%F in (*.tex) do if not defined ENTRY set "ENTRY=%%~fF"
)
if not defined ENTRY (
  echo latexmk fallback could not find a .tex entrypoint. 1>&2
  exit /b 2
)

set "TECTONIC_BIN=%ARIS_TECTONIC%"
if not defined TECTONIC_BIN set "TECTONIC_BIN=%~dp0tectonic.exe"
if not exist "%TECTONIC_BIN%" (
  echo latexmk fallback requires tectonic.exe in resources\bin or ARIS_TECTONIC. 1>&2
  exit /b 127
)

"%TECTONIC_BIN%" --keep-logs --keep-intermediates "%ENTRY%"
exit /b %ERRORLEVEL%

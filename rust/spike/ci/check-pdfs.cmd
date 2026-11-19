@echo off
rem Reads every PDF in a folder with the Rust reader and prints one line of numbers per file (no statement text).
rem Drag the folder onto this file, or run:  check-pdfs.cmd C:\path\to\folder
if "%~1"=="" (
  echo Drag a folder with PDF files onto check-pdfs.cmd, or run: check-pdfs.cmd FOLDER
  pause
  exit /b 1
)
"%~dp0kb-spike-pdf.exe" summary "%~1"
pause

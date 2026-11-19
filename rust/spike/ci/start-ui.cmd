@echo off
rem Opens the Kasboek UI spike on the lock screen with the Windows Hello button and the typing field.
rem Options go after the command, for example:  start-ui.cmd --lang de --theme dark --scale 2
rem The log is startup.log, next to kasboek-ui-spike.exe (the previous run is startup.prev.log).
start "" "%~dp0kasboek-ui-spike.exe" --screen lock-hello --typing %*

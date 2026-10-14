@echo off
rem MAW Multiplayer local launcher (double-click for a menu, or drop a .mosp project onto this file).
rem The logic lives in scripts\multiplayer_local.py; this file avoids labels so LF line endings are safe.
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONUTF8=1
where py >nul 2>nul
if errorlevel 1 (set "MAW_MP_PYTHON=python") else (set "MAW_MP_PYTHON=py -3")
%MAW_MP_PYTHON% "%~dp0scripts\multiplayer_local.py" %*
if errorlevel 1 pause

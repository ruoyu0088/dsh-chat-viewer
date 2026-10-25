@echo off
setlocal
cd /d "%~dp0"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"

rem DSH Chat Viewer needs Python 3.14+ for the standard-library
rem `compression.zstd` module.  This project was developed with the
rem pixi environment at C:\pixi_env; change PYEXE if yours is elsewhere.
set "PYEXE=C:\pixi_env\.pixi\envs\default\python.exe"

if not exist "%PYEXE%" (
  echo.
  echo [ERROR] Python 3.14 was not found at:
  echo         %PYEXE%
  echo.
  echo DSH Chat Viewer only needs the standard library, but it requires
  echo Python 3.14+ because DSH session logs are zstd-compressed.
  echo Edit run.bat and set PYEXE to your Python 3.14 python.exe,
  echo or run:  python server.py
  echo.
  pause
  exit /b 2
)

"%PYEXE%" server.py %*
if errorlevel 1 (
  echo.
  echo server exited with an error.
  pause
)

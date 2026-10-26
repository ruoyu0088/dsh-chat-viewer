@echo off
setlocal
cd /d "%~dp0"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "MKL_THREADING_LAYER=TBB"

rem DSH Chat Viewer needs Python 3.14+ for the standard-library
rem `compression.zstd` module.  Resolution order:
rem   1. DSH_VIEWER_PYTHON environment variable
rem   2. this machine's pixi environment (keeps double-click working)
rem   3. "py -3.14"
rem   4. "python" from PATH, only if it is 3.14+
set "PYEXE="
set "PYARGS="

if defined DSH_VIEWER_PYTHON if exist "%DSH_VIEWER_PYTHON%" set "PYEXE=%DSH_VIEWER_PYTHON%"
if not defined PYEXE if exist "C:\pixi_env\.pixi\envs\default\python.exe" set "PYEXE=C:\pixi_env\.pixi\envs\default\python.exe"

if not defined PYEXE (
  py -3.14 -c "import sys; raise SystemExit(0 if sys.version_info >= (3,14) else 1)" >nul 2>nul
  if not errorlevel 1 (
    set "PYEXE=py"
    set "PYARGS=-3.14"
  )
)

if not defined PYEXE (
  python -c "import sys; raise SystemExit(0 if sys.version_info >= (3,14) else 1)" >nul 2>nul
  if not errorlevel 1 set "PYEXE=python"
)

if not defined PYEXE (
  echo.
  echo [ERROR] Python 3.14+ was not found.
  echo.
  echo DSH Chat Viewer only needs the standard library, but it requires
  echo Python 3.14+ because DSH session logs are zstd-compressed.
  echo.
  echo Set DSH_VIEWER_PYTHON to a Python 3.14 python.exe, or install one
  echo and run:  python server.py
  echo.
  pause
  exit /b 2
)

if defined PYARGS (
  %PYEXE% %PYARGS% server.py %*
) else (
  "%PYEXE%" server.py %*
)
if errorlevel 1 (
  echo.
  echo server exited with an error.
  pause
)

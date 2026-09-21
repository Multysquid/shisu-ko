@echo off
setlocal
REM One-time setup: creates an isolated Python environment under %USERPROFILE%\.shisu-ko
REM and installs faster-whisper, yt-dlp and the CUDA runtime libraries.

set "ROOT=%USERPROFILE%\.shisu-ko"
set "VENV=%ROOT%\venv"

REM Explorer shows a zip as a folder and, on a double-click, extracts only the clicked file
REM into a temporary place: this script then runs alone, and every sibling is missing.
if not exist "%~dp0server.py" (
  echo This file is running on its own, from inside a zip or a folder without the rest
  echo of Shisu-ko. Extract the whole zip first ^(right-click it, "Extract All..."^), then
  echo start server\setup.cmd from the extracted folder.
  pause
  exit /b 1
)

REM find-python.cmd sets PY to a Python 3.10+ that really runs (Windows answers "python" with a
REM Microsoft Store shortcut when none is on the PATH, and `where` cannot tell the two apart).
call "%~dp0find-python.cmd"
if not defined PY (
  echo Python 3.10 or newer is required, and none that runs was found.
  echo Install it from https://www.python.org/downloads/ and tick "Add python.exe to PATH",
  echo then run this script again. If Python is installed and this message still appears,
  echo Windows is answering "python" with its Store shortcut: turn python.exe off under
  echo Settings ^> Apps ^> Advanced app settings ^> App execution aliases, or repair the
  echo installation with "Add python.exe to PATH" ticked.
  pause
  exit /b 1
)

if not exist "%ROOT%\cache" mkdir "%ROOT%\cache"
if not exist "%ROOT%\models" mkdir "%ROOT%\models"

if not exist "%VENV%\Scripts\python.exe" (
  echo Creating virtual environment in %VENV% ...
  %PY% -m venv "%VENV%"
  if errorlevel 1 (
    echo Could not create the virtual environment.
    pause
    exit /b 1
  )
)

echo Installing Python packages (this downloads about 1.5 GB the first time) ...
"%VENV%\Scripts\python.exe" -m pip install --upgrade pip
"%VENV%\Scripts\python.exe" -m pip install -r "%~dp0requirements.txt"
if errorlevel 1 (
  echo Package installation failed.
  pause
  exit /b 1
)
echo Installing NVIDIA CUDA libraries for GPU inference (harmless on CPU-only machines) ...
"%VENV%\Scripts\python.exe" -m pip install nvidia-cublas-cu12 nvidia-cudnn-cu12

REM Register the native-messaging host behind the extension's "Start server" button before
REM the environment check, which reports whether it is registered.
"%VENV%\Scripts\python.exe" "%~dp0native_host.py" --register --verbose
echo.
echo Environment check:
"%VENV%\Scripts\python.exe" "%~dp0server.py" --check
echo.
echo Setup finished. Start the server with run.cmd
echo The Whisper large-v3 model (about 3 GB) is downloaded on the first start.
pause

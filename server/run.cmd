@echo off
setlocal
REM Starts the Shisu-ko transcription server and restarts it if it stops unexpectedly
REM (for example after a GPU driver reset). Extra arguments are passed through, e.g.
REM       run.cmd --model kotoba-tech/kotoba-whisper-v2.0-faster
REM       run.cmd --cookies-from-browser firefox
REM       run.cmd --check
REM       run.cmd --no-update     start without looking for a newer version first

set "VENV=%USERPROFILE%\.shisu-ko\venv"
if not exist "%VENV%\Scripts\python.exe" (
  echo The Python environment is missing. Run setup.cmd first.
  pause
  exit /b 1
)

REM Look for a newer version (git fast-forward, or the newest release for a downloaded folder)
REM and install it. That can replace this very file, and cmd reads batch files as it goes: the
REM jump to :loop shares the update's line, so everything after it is read from the new file.
REM Before that, register the native-messaging host behind the extension's "Start server"
REM button (cheap, idempotent), so a checkout that never re-ran setup.cmd gets the button too.
"%VENV%\Scripts\python.exe" "%~dp0native_host.py" --register
REM The server's exit code 4 (POST /update) jumps back to :update. That is safe although the
REM update may replace this file: the lines between the server's exit and "goto update" are read
REM from the old file, which nothing changed since the jump to :loop, and the "goto loop" that
REM shares the update's line was parsed before the update ran and looks the label up in the new
REM file, so no line is ever read from a stale offset.
:update
"%VENV%\Scripts\python.exe" "%~dp0update.py" %* & goto loop

:loop
REM Tells server.py that this loop is around: its POST /update (the extension's Update button)
REM answers yes only then, and exits with code 4 so that this loop runs the update. Set here
REM rather than at the top: a launcher from before this variable that has just updated itself
REM arrives in this file through its own, already parsed "goto loop", so only the lines after
REM :loop run for it, and the server it starts would otherwise refuse the button.
set "SHISUKO_LAUNCHER=1"
"%VENV%\Scripts\python.exe" "%~dp0server.py" %*
set "CODE=%ERRORLEVEL%"
if "%CODE%"=="0" goto end
if "%CODE%"=="2" goto end
if "%CODE%"=="4" goto update
echo.
echo The server stopped unexpectedly (exit code %CODE%). Restarting in 5 seconds... press Ctrl+C to quit.
timeout /t 5 /nobreak >nul
goto loop

:end
pause

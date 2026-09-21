@echo off
REM Puts the command of a Python 3.10 or newer that actually runs into PY, or leaves PY empty.
REM Windows ships a python.exe that is only a shortcut to the Microsoft Store: it answers
REM "Python was not found; run without arguments to install from the Microsoft Store ..." and
REM `where python` finds it like a real interpreter, so every candidate is run instead. The py
REM launcher comes first (the python.org installer registers it and it picks the newest
REM Python 3), then python, then python3. No setlocal: PY is meant for the caller, and nothing
REM is printed, because native-host.cmd calls this on a stdout that carries a protocol.
set "PY="
for %%C in ("py -3" "python" "python3") do (
  if not defined PY %%~C -c "import sys; sys.exit(sys.version_info < (3, 10))" >nul 2>nul && set "PY=%%~C"
)

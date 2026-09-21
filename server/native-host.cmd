@echo off
REM Native-messaging host for the extension's "Start server" button. Firefox runs this file
REM (registered by native_host.py --register) and talks to it over stdin/stdout, so nothing
REM here may print: the venv's Python runs the host, or the system Python before setup ran.
set "PY=%USERPROFILE%\.shisu-ko\venv\Scripts\python.exe"
if exist "%PY%" goto run
REM Before setup ran: a Python 3 that really runs, found the way setup.cmd finds it (the
REM helper prints nothing; Windows answers "python" with a Store shortcut otherwise).
call "%~dp0find-python.cmd"
if not defined PY exit /b 1
:run
%PY% "%~dp0native_host.py" %*

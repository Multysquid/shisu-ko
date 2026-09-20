@echo off
REM Native-messaging host for the extension's "Start server" button. Firefox runs this file
REM (registered by native_host.py --register) and talks to it over stdin/stdout, so nothing
REM here may print: the venv's Python runs the host, or the system Python before setup ran.
set "PY=%USERPROFILE%\.shisu-ko\venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"
"%PY%" "%~dp0native_host.py" %*

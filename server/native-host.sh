#!/usr/bin/env bash
# Native-messaging host for the extension's "Start server" button. Firefox runs this file
# (registered by native_host.py --register) and talks to it over stdin/stdout, so nothing
# here may print: the venv's Python runs the host, or the system Python before setup ran.
PY="${HOME}/.shisu-ko/venv/bin/python"
[ -x "$PY" ] || PY=python3
exec "$PY" "$(dirname "$0")/native_host.py" "$@"

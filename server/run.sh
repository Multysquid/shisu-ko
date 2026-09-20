#!/usr/bin/env bash
# Starts the Shisu-ko transcription server (Linux/macOS) and restarts it if it stops
# unexpectedly. Extra arguments are passed through, e.g. ./run.sh --cookies-from-browser firefox
# or ./run.sh --no-update to start without looking for a newer version first.
set -uo pipefail
VENV="${HOME}/.shisu-ko/venv"
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -x "${VENV}/bin/python" ] || { echo "Run ./setup.sh first"; exit 1; }

main() {
  # Looks for a newer version (git fast-forward, or the newest release for a downloaded
  # folder) and installs it; it never stops the server from starting.
  "${VENV}/bin/python" "${HERE}/update.py" "$@"
  # Registers the native-messaging host behind the extension's "Start server" button
  # (cheap, idempotent), so a checkout that never re-ran setup.sh gets the button too. After
  # the update, which writes files without their mode bits: registering restores the wrapper's.
  "${VENV}/bin/python" "${HERE}/native_host.py" --register
  while true; do
    "${VENV}/bin/python" "${HERE}/server.py" "$@"
    code=$?
    [ "$code" -eq 0 ] && exit 0
    [ "$code" -eq 2 ] && exit 2
    echo "The server stopped unexpectedly (exit code $code). Restarting in 5 seconds... press Ctrl+C to quit."
    sleep 5
  done
}

# The update may replace this file while it runs, and bash reads scripts as it goes: the whole
# loop lives in a function that was parsed before the update, and nothing follows this line.
main "$@"; exit

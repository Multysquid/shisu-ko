#!/usr/bin/env bash
# One-time setup for Linux/macOS: isolated Python environment under ~/.shisu-ko
set -euo pipefail
ROOT="${HOME}/.shisu-ko"
VENV="${ROOT}/venv"
HERE="$(cd "$(dirname "$0")" && pwd)"
# A copy of this file on its own (a zip browsed as a folder, a stray copy) has no siblings.
[ -f "${HERE}/server.py" ] || { echo "This script is running on its own, without the rest of Shisu-ko: extract the whole zip first, then start server/setup.sh from the extracted folder."; exit 1; }

command -v python3 >/dev/null 2>&1 || { echo "python3 (3.10+) is required"; exit 1; }
mkdir -p "${ROOT}/cache" "${ROOT}/models"
[ -x "${VENV}/bin/python" ] || python3 -m venv "${VENV}"
"${VENV}/bin/python" -m pip install --upgrade pip
"${VENV}/bin/python" -m pip install -r "${HERE}/requirements.txt"
if command -v nvidia-smi >/dev/null 2>&1; then
  "${VENV}/bin/python" -m pip install nvidia-cublas-cu12 nvidia-cudnn-cu12
fi
# The native-messaging host behind the extension's "Start server" button, registered before
# the environment check reports whether it is; a failure here (it prints why) must not undo
# the setup that just succeeded.
"${VENV}/bin/python" "${HERE}/native_host.py" --register --verbose || true
"${VENV}/bin/python" "${HERE}/server.py" --check
echo "Setup finished. Start the server with ./run.sh"

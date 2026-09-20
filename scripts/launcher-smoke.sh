#!/usr/bin/env bash
# Runs the real server/run.sh against stub server.py / update.py / native_host.py and checks
# the loop the popup's Update button relies on: register, update, start the server with
# SHISUKO_LAUNCHER=1, and after an exit with code 4 update again (which replaces run.sh with a
# longer file while it runs), register again and start again, until the server exits 0.
# Only stdlib Python, bash and a scratch HOME are needed; nothing outside the temp directory
# is touched. Usage: bash scripts/launcher-smoke.sh   (exit 0 = every step happened in order)
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export HOME="$WORK/home"
mkdir -p "$HOME/.shisu-ko" "$WORK/checkout/server"
python3 -m venv "$HOME/.shisu-ko/venv"
cp "$HERE/server/run.sh" "$WORK/checkout/server/run.sh"
LOG="$WORK/steps.log"

# Each server run appends its launcher variable and exits with the next code from the queue.
cat > "$WORK/checkout/server/server.py" <<'EOF'
import os, sys
from pathlib import Path
here = Path(__file__).resolve().parent
queue = here / "exit-codes.txt"
codes = queue.read_text().split()
code = int(codes.pop(0)) if codes else 0
queue.write_text(" ".join(codes))
Path(os.environ["SMOKE_LOG"]).open("a").write(f"server launcher={os.environ.get('SHISUKO_LAUNCHER', '')} args={' '.join(sys.argv[1:])} exit={code}\n")
sys.exit(code)
EOF
# The update replaces run.sh with a longer file (as a real update would), then records itself.
cat > "$WORK/checkout/server/update.py" <<'EOF'
import os, sys
from pathlib import Path
here = Path(__file__).resolve().parent
run = here / "run.sh"
text = run.read_text()
if "# updated" not in text:
    run.write_text("# updated\n# the update adds lines at the top, so every old byte offset is wrong now\n" + text)
Path(os.environ["SMOKE_LOG"]).open("a").write(f"update args={' '.join(sys.argv[1:])}\n")
EOF
cat > "$WORK/checkout/server/native_host.py" <<'EOF'
import os, sys
from pathlib import Path
Path(os.environ["SMOKE_LOG"]).open("a").write(f"register args={' '.join(sys.argv[1:])}\n")
EOF
echo "4 0" > "$WORK/checkout/server/exit-codes.txt"

# set -e must not end the script on a non-zero exit here: the code is what is being checked.
if SMOKE_LOG="$LOG" bash "$WORK/checkout/server/run.sh" --lookahead 0; then code=0; else code=$?; fi
echo "run.sh exited with $code"
cat "$LOG"
expected="update args=--lookahead 0
register args=--register
server launcher=1 args=--lookahead 0 exit=4
update args=--lookahead 0
register args=--register
server launcher=1 args=--lookahead 0 exit=0"
if [ "$code" -ne 0 ]; then echo "FAIL: run.sh should end with the server's exit code 0"; exit 1; fi
if [ "$(cat "$LOG")" != "$expected" ]; then echo "FAIL: the launcher did not run the steps in this order:"; echo "$expected"; exit 1; fi
grep -q "^# updated" "$WORK/checkout/server/run.sh" || { echo "FAIL: update.py did not replace run.sh"; exit 1; }
echo "OK: run.sh registers, updates, passes SHISUKO_LAUNCHER=1, and runs the update again after exit code 4"

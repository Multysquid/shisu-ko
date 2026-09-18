# AGENTS.md

Guidance for AI coding agents (and new contributors) working in this repository.
Read this before changing code; the README is the user-facing document.

## What this project is

Shisu-ko shows live Japanese subtitles on YouTube in Firefox. A local Python server transcribes
the video's audio with Whisper (faster-whisper / CTranslate2) a little ahead of the playhead; the
extension renders the cues as real DOM text so Yomitan can scan them, and can mine a screenshot
plus sentence audio into the newest Anki card via AnkiConnect.

```
addon/        Firefox extension, Manifest V3, plain JS, no build step
server/       server.py (single file) + setup/run scripts; runtime data in ~/.shisu-ko
docker/       Windows wrappers for docker compose, WSL Docker Engine installer
Dockerfile, compose.yaml, compose.cpu.yaml, .env.example
sign-addon.cmd   signs the extension through addons.mozilla.org (needs the owner's API key)
```

## Invariants (do not break these)

- Subtitles must stay ordinary DOM text (`textContent`), never canvas, never `<track>` cues,
  never shadow DOM. Yomitan and other popup dictionaries depend on it.
- Never use `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `eval` or `script.src` in the content
  script. youtube.com enforces Trusted Types; only `textContent`/`createElement` style DOM code works.
- The extension uses the `browser.*` promise API (Firefox). No `chrome.*` callbacks.
- All overlay classes and flags use the `shisuko-` / `__shisuko` prefix.
- `DEFAULT_SETTINGS` is duplicated in `addon/background.js`, `addon/content.js` and the popup
  field list. Keep them in sync when adding a setting.
- The server listens on `127.0.0.1:8790`. Port 8765 belongs to AnkiConnect; never use it.
- The server never exposes anything beyond `/health`, `/sync`, `/clip`, `/sessions`; it binds to
  localhost and validates `video_id` against `^[A-Za-z0-9_-]{6,20}$`.
- Runtime data lives in `~/.shisu-ko` (`SHISUKO_HOME` overrides it): `venv/`, `models/`, `cache/`.
  Cue caches are `cache/<video_id>.cues.json` and are only reused when model and language match.
- No absolute personal paths, no secrets and no `.env` in tracked files. `.env` is machine-specific
  and ignored; `.env.example` documents it.
- Line endings: LF everywhere, CRLF only for `*.cmd` (`.gitattributes` enforces this).

## How the server schedules work

`plan_window()` in `server/server.py` decides what to transcribe next: if the playhead is not
inside a covered range, a short `--first-window` (20 s) starts at the playhead; otherwise the next
`--window` (40 s) continues from the end of the covered range, up to `--lookahead` seconds ahead.
A segment touching the end of a window is dropped and the covered range ends where that segment
began, so the next window re-transcribes it whole. Word timestamps split segments into cues at
Japanese punctuation (`split_segment()`). These functions are pure; test them by importing the
module (register it in `sys.modules` before `exec_module` because of `from __future__ import annotations`).

## Commands

Native server (Windows): `server\setup.cmd` once, then `server\run.cmd [options]`.
Native server (Linux/macOS): `bash server/setup.sh`, then `server/run.sh`.
Diagnostics: `server\run.cmd --check`.

Docker: `docker\up.cmd`, `docker\logs.cmd`, `docker\down.cmd` (or `docker compose up -d` etc.).
`up.cmd` keeps a minimized "Shisu-ko WSL keep-alive" window open when Docker Engine runs inside
WSL, because WSL stops the distro (and Docker) seconds after the last WSL session ends.

Extension checks:

```
node --check addon/content.js addon/background.js addon/popup.js
npx web-ext lint --source-dir addon
npx web-ext build --source-dir addon --artifacts-dir dist --overwrite-dest
```

Server check: `python -W error -c "import ast; ast.parse(open('server/server.py', encoding='utf-8').read())"`.

Automated tests (also run in CI via `.github/workflows/tests.yml`, no GPU/network/Firefox needed):

```
pip install -r server/requirements-test.txt && python -m pytest server/tests
node --test "addon/tests/**/*.test.js"
```

`server/tests/_serverlib.py` loads `server.py` the way this file already recommends above
(`sys.modules` registration before `exec_module`). `addon/tests/_loadBackground.js` runs
`background.js` in a Node `vm` sandbox with `browser`/`fetch`/`btoa` stubbed out — top-level
`function` declarations become sandbox properties, but `const`/`let` (`DEFAULT_SETTINGS`,
`REQUEST_TIMEOUT_MS`) need an extra script run in the same context to expose them, since they
live in the global lexical environment rather than as globalThis properties. When adding a new
setting or a new pure helper, add a matching test rather than only exercising it manually.

Load the extension for manual testing via `about:debugging#/runtime/this-firefox` > Load Temporary
Add-on > `addon/manifest.json`. The content script can also be exercised outside Firefox by
concatenating a small `browser.*` shim with `content.css` and `content.js` and running it on a page
that contains `#movie_player.html5-video-player > video` with `?v=<video id>` in the URL.

## Gotchas learned the hard way

- Windows command lines are limited to about 32 KB. Put long scripts in files instead of
  inline heredocs when running tools from a shell.
- Hugging Face's xet transfer backend stalled on Windows; the server sets `HF_HUB_DISABLE_XET=1`.
- yt-dlp needs a JavaScript runtime (Deno preferred, Node 20+ works) for YouTube. The Docker image
  ships Deno; the native setup relies on what is installed.
- On Windows the CUDA libraries come from the `nvidia-cublas-cu12` / `nvidia-cudnn-cu12` wheels;
  `add_nvidia_dll_dirs()` must run before `ctranslate2` is imported.
- GPU memory is often shared with games or wallpaper apps. `load_model()` reads free VRAM with
  `nvidia-smi` and picks `int8_float16` below 4.5 GB; a driver reset shows up as a process death
  without a traceback (Windows LiveKernelEvent 141). The launchers restart the server; exit code 2
  means a startup error that must not be retried.
- AnkiConnect: send requests without a `Content-Type` header (a "simple" request needs no CORS
  preflight), call `requestPermission` first, find the newest card with `findNotes("added:1")`.
- `data_collection_permissions` in the manifest requires `strict_min_version` 140 or later.
- Regular Firefox only keeps signed add-ons; unsigned builds are temporary installs only.
- Screenshots fail on DRM-protected videos (tainted canvas); the audio clip still works.
- The native server and the container both use port 8790; run one at a time.

## Making changes

1. Keep `server.py` a single dependency-light file (stdlib + numpy + faster-whisper + yt-dlp + PyAV).
2. Bump `version` in `addon/manifest.json` and `VERSION` in `server/server.py` together.
3. Run the checks above, then test manually on a real YouTube video: subtitles appear, hover
   pauses, transcript panel works, Alt+Shift+M produces a toast and (with Anki running) fills the card.
4. Update README sections that describe changed behaviour; keep this file's invariants current.
5. Commit with a descriptive message; do not commit `.env`, `dist/` or anything from `~/.shisu-ko`.

## Release

- `npx web-ext build --source-dir addon --artifacts-dir dist --overwrite-dest` produces the zip.
- `sign-addon.cmd` (repository owner only) produces a signed `.xpi` for regular Firefox.
- Attach the zip/xpi to a GitHub release; rebuild the Docker image with `docker compose build`.

# Shisu-ko

[![Tests](https://github.com/Multysquid/shisu-ko/actions/workflows/tests.yml/badge.svg)](https://github.com/Multysquid/shisu-ko/actions/workflows/tests.yml)

Live Japanese subtitles for YouTube in Firefox, generated on your own machine by Whisper,
readable by [Yomitan](https://yomitan.wiki/), and minable into Anki with one key.

YouTube's own Japanese captions are often missing, auto-generated badly, or burned into the
video where a dictionary cannot reach them. Shisu-ko runs OpenAI's Whisper large-v3 locally,
transcribes the video a little ahead of where you are watching, and shows the result as real
page text over the player. Hover a line and the video pauses so you can look words up. When a
sentence is worth keeping, one key grabs the current frame and the sentence audio and files
both into the Anki card you just made.

## Features

- **Live subtitles** synchronized to the video, starting a few seconds after a video opens.
  The server keeps transcribing ahead of the playhead and caches everything, so seeking back
  or rewatching is instant.
- **Dictionary-friendly text.** Subtitles are ordinary DOM text, so Yomitan (or any popup
  dictionary) scans them. Hovering pauses the video; moving into the dictionary popup keeps it
  paused; moving back over the video resumes.
- **Transcript panel** with every line so far. Click a timestamp to jump there.
- **Sentence mining.** The mine button on a subtitle, on any transcript line, or Alt+Shift+M
  captures a screenshot and an MP3 clip of that sentence and either attaches them to the newest
  Anki card via AnkiConnect or saves them to your Downloads folder.
- **Your hardware, your choice of model.** Whisper large-v3 by default; one flag switches to
  `kotoba-whisper-v2.0-faster` (Japanese-specialised, about 6x faster) or a small CPU model.
- **Native or Docker.** A one-time setup script on Windows/Linux/macOS, or a container with
  GPU support that shares the same model folder.

## How it works

```
Firefox (addon/)                                 Local server (server/), http://127.0.0.1:8790
+----------------------------------+             +----------------------------------------------+
| content script on youtube.com    |  POST /sync | 1. yt-dlp downloads the audio track once      |
|  - video id + playhead, 1x/s     | ----------> | 2. PyAV decodes it to 16 kHz mono            |
|  - renders cues as DOM text      | <---------- | 3. faster-whisper transcribes windows,       |
|  - hover pauses, Yomitan scans   |   new cues  |    starting at the playhead, then ahead of it |
|  - screenshot via <canvas>       |  GET /clip  | 4. /clip cuts sentence audio from the source |
+----------------------------------+ ----------> +----------------------------------------------+
        | AnkiConnect (http://127.0.0.1:8765): storeMediaFile + updateNoteFields on the newest card
        v
      Anki
```

Why a local server instead of running the model in the browser: Whisper large-v3 has 1.5
billion parameters and needs a GPU, which a browser extension cannot use well. The extension
therefore only sends the video id and the current playhead once per second, and the server does
the heavy lifting with [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (CTranslate2).

How transcription is scheduled: when you open a video the server fetches the audio track with
[yt-dlp](https://github.com/yt-dlp/yt-dlp) (a few seconds), transcribes a short 20-second window
at the current position so the first subtitles appear quickly, then continues in 40-second
windows up to 15 minutes ahead of you. A sentence that is cut at a window edge is dropped and
re-transcribed at the start of the next window, so lines are never chopped. Seeking to an
untranscribed part starts a new short window there. Whisper's word timestamps are used to split
long segments into subtitle-sized cues at Japanese punctuation. Cues are saved per video in
`~/.shisu-ko/cache`, so a video you have watched before shows subtitles immediately.

## Requirements

- Firefox 140 or newer.
- For the native server: Python 3.10 or newer on the PATH, plus Node.js 20+ or Deno
  (yt-dlp needs a JavaScript runtime for YouTube).
- For the Docker server: Docker with the NVIDIA Container Toolkit (Docker Desktop on Windows
  has it built in). The image already contains Deno.
- An NVIDIA GPU with about 4 GB of free VRAM for large-v3. With less free memory the server
  switches to int8 weights automatically; without a GPU use a small model on the CPU.
- Optional: [Yomitan](https://yomitan.wiki/) for lookups, [Anki](https://apps.ankiweb.net/)
  with the [AnkiConnect](https://ankiweb.net/shared/info/2055492159) add-on for mining.

## Quick start

### 1. Start the server

**Native (Windows):** double-click `server\setup.cmd` once, then `server\run.cmd`.
**Native (Linux/macOS):** `bash server/setup.sh` once, then `server/run.sh`.

Setup creates an isolated Python environment in `~/.shisu-ko/venv` and installs faster-whisper,
yt-dlp and the CUDA runtime libraries; nothing else on the system is touched. The first start
downloads the Whisper large-v3 model (about 3 GB) into `~/.shisu-ko/models`. The server is ready
when it prints `Listening on http://127.0.0.1:8790`. Keep the window open while you watch; it
restarts itself if it ever crashes.

**Docker:** copy `.env.example` to `.env`, set `DATA_DIR` to where models and caches should
live, then run `docker\up.cmd` (Windows) or `docker compose up -d`. See [Docker](#docker) below.

### 2. Install the extension

Temporary install (until Firefox restarts):

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and choose `addon/manifest.json`.

Permanent install: regular Firefox only keeps signed add-ons. Get a free API key at
[addons.mozilla.org](https://addons.mozilla.org/developers/addon/api/key/), run `sign-addon.cmd`
(unlisted channel, nobody else sees it) and open the signed `.xpi` from `dist\`. Firefox
Developer Edition, Nightly and ESR can instead load the unsigned zip with
`xpinstall.signatures.required` set to `false` in `about:config`.

### 3. Watch

Open any YouTube video. The badge in the top-left corner of the player goes from "Fetching
audio…" to "Transcribing…" and the first subtitles appear after a few seconds. From then on the
server stays ahead of you. The toolbar popup holds all settings.

| Shortcut | Action |
|---|---|
| Alt+Shift+S | Toggle subtitles |
| Alt+Shift+T | Toggle the transcript panel |
| Alt+Shift+M | Mine the current sentence (screenshot + audio) |

Shortcuts can be changed in Firefox under Add-ons and themes > Manage Extension Shortcuts.

## Using it with Yomitan

Hover a subtitle: the video pauses while the pointer is on the text. Scan words with Yomitan as
usual. When the pointer moves into Yomitan's popup the video stays paused; it resumes about a
third of a second after the pointer comes back over the video. Pressing space or clicking play
also resumes. The transcript panel is plain text too, so earlier lines can be looked up, and its
timestamps seek the video.

## Sentence mining

Mining captures two things for the sentence you are looking at: a screenshot of the video frame
and an MP3 clip of the sentence audio, cut from the original track with a little padding on both
sides. Three ways to trigger it:

- hover the subtitle and click the pickaxe button that appears at its right edge,
- press Alt+Shift+M while watching,
- click the pickaxe on any line in the transcript panel (the video briefly jumps to that line to
  grab the matching frame, then jumps back).

Where the material goes is a popup setting:

**Anki (default).** Shisu-ko talks to AnkiConnect, finds the card added most recently today, and
fills its image and audio fields. This matches the usual Yomitan workflow:

1. Hover a word, click Yomitan's **+** to create the card (Yomitan fills the word, reading,
   sentence and glossary from its own template).
2. Press Alt+Shift+M. Shisu-ko uploads `shisuko_<video>_<time>.jpg` and `.mp3` to Anki's media
   folder and writes `<img src=...>` and `[sound:...]` into the fields.

The first time, Anki shows a dialog asking whether to allow the extension; click **Yes**.
Field names default to `Picture` and `SentenceAudio` (as used by common Japanese mining note
types); change them in the popup to match your note type. An optional sentence field is filled
with the subtitle text only when it is empty, so it never overwrites what Yomitan wrote. If Anki
is not running, the files are saved to Downloads instead (can be turned off).

**Downloads.** Files are saved to `Downloads/shisu-ko-mining/`, ready to drag into any card.

Notes: DRM-protected videos block screenshots (the audio clip still works). The Shisu-ko server
uses port 8790 precisely so that AnkiConnect can keep its default 8765.

## Settings (toolbar popup)

| Setting | Meaning |
|---|---|
| Show subtitles | Master switch for the overlay |
| Pause the video while a subtitle is hovered | Needed for comfortable Yomitan lookups |
| Show transcript panel | List of all cues so far, with jump and mine buttons |
| Hide YouTube's own captions | Avoids two subtitle layers |
| Show progress messages | The status badge; errors are always shown |
| Font size, keep subtitle after speech ends | Presentation; the linger time keeps short lines readable |
| Send screenshot and audio to | Anki (newest card) or Downloads |
| AnkiConnect URL, image/audio/sentence field | AnkiConnect connection and note fields |
| Audio padding, audio format | Extra time around the sentence; MP3 or WAV |
| Shisu-ko server URL | Default `http://127.0.0.1:8790` |

## Server options

Append options to `run.cmd` / `run.sh`, or put them in the `command:` line of `compose.yaml`.

| Option | Effect |
|---|---|
| `--model kotoba-tech/kotoba-whisper-v2.0-faster` | Japanese-specialised distilled model, about 6x faster and lighter on memory than large-v3 |
| `--model large-v3-turbo` | OpenAI's faster large model |
| `--model small --device cpu` | CPU-only operation |
| `--compute-type int8_float16` | Halves GPU memory use; chosen automatically when less than 4.5 GB is free |
| `--cookies-from-browser firefox` | Age-restricted or members-only videos, or when YouTube asks for a sign-in |
| `--cookies /path/cookies.txt` | Same, with an exported cookies file (use this inside Docker) |
| `--lookahead 0` | Transcribe to the end of the video instead of stopping 15 minutes ahead |
| `--window 60` | Longer windows are slightly more efficient, shorter ones react faster to seeking (default 40) |
| `--initial-prompt "こんにちは。今日は、いい天気ですね。"` | Nudges Whisper towards punctuated output |
| `--allow-remote-ejs` | Lets yt-dlp fetch updated YouTube challenge-solver scripts from GitHub |
| `--check` | Print environment diagnostics and exit |

Endpoints, for anyone building on the server: `GET /health`, `POST /sync`
(`{video_id, t, since}` returns new cues and covered ranges), `GET /clip?video_id=&start=&end=&format=mp3|wav`,
`GET /sessions` for debugging. The server only listens on 127.0.0.1.

## Docker

```
docker\up.cmd      build (first time) and start in the background; restarts after crashes
docker\logs.cmd    follow the server log
docker\down.cmd    stop
```

On Linux/macOS use `docker compose up -d`, `docker compose logs -f`, `docker compose down`.
Settings live in `.env` (copy `.env.example`): `DATA_DIR` is the host folder for models and
caches and `WHISPER_MODEL` the model. Point `DATA_DIR` at the native setup's `~/.shisu-ko` to
share the downloaded model. `compose.cpu.yaml` is a CPU-only variant.

The image is `python:3.12-slim` plus the pip-installed CUDA libraries and Deno, about 2 GB. The
GPU driver comes from the host through the NVIDIA Container Toolkit. Two ways to get that on
Windows:

- **Docker Desktop** with the WSL 2 backend (GPU support is built in).
- **Docker Engine inside WSL 2**, without Docker Desktop: run once
  `wsl -d Ubuntu -u root -- bash -c "tr -d '\r' < /mnt/c/<path to this folder>/docker/install-docker-wsl.sh | bash -s -- <your WSL user>"`.
  The `docker\*.cmd` wrappers detect which of the two is installed. Do not run both.
  WSL stops a distro a few seconds after its last session closes, which would take Docker and the
  server down with it, so `up.cmd` opens a minimized "Shisu-ko WSL keep-alive" window; leave it
  open while you watch, and close it (or run `down.cmd`) when you are done.

The extension does not change between native and Docker; both listen on `127.0.0.1:8790`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Badge says "Shisu-ko server offline" | Start `server\run.cmd` or `docker\up.cmd`. Check the server URL in the popup. |
| First start sits at "Loading Whisper model" for a long time | The 3 GB download runs at your connection speed. Hugging Face's xet transfer mode is disabled because it stalled on Windows; set `HF_HUB_DISABLE_XET=0` to try it. |
| "yt-dlp needs Node.js or Deno" | Install [Node.js](https://nodejs.org/) 20+ or [Deno](https://deno.com/), then restart the server. |
| "YouTube asks for a sign-in" | Restart with `--cookies-from-browser firefox` (native) or `--cookies /data/cookies.txt` (Docker). |
| Downloads fail after a YouTube update | Update yt-dlp: `~/.shisu-ko/venv/Scripts/python -m pip install -U yt-dlp` (Windows) or the `bin/python` equivalent; or start with `--allow-remote-ejs`. |
| Server says "Only N MiB of GPU memory is free" or restarts by itself | Other programs (games, Wallpaper Engine, VR software) hold most of the VRAM. The server switches to int8 weights; with under about 2.5 GB free the display driver can reset under load (Windows logs LiveKernelEvent 141). Close GPU-heavy apps or use `kotoba-whisper-v2.0-faster`. Cached cues survive restarts. |
| CPU fallback, transcription far too slow | `run.cmd --check` should list one CUDA device; update the NVIDIA driver or use `--model small`. |
| Mining says "AnkiConnect denied access" | Click **Yes** in the dialog Anki shows, then mine again. |
| Mining says the card has none of the fields | Set the image/audio field names in the popup to the fields of your note type. |
| No screenshot, only audio | The video is DRM-protected; the browser refuses to read its frames. |

`run.cmd --check` prints diagnostics; `GET http://127.0.0.1:8790/sessions` lists active sessions.

## Limitations

- Live streams are not supported yet. The server transcribes the downloaded audio track, which
  is what makes synchronised subtitles possible for normal videos.
- Subtitles are hidden while YouTube plays ads.
- YouTube changes its player regularly; yt-dlp usually needs an update within days.
- Whisper occasionally hallucinates on music or silence; the voice-activity filter removes most
  of it but not all.

Planned: a distilled, smaller Japanese model that could eventually run in the browser itself, and
live-stream support by capturing the audio the page is playing.

## Project layout

```
addon/                Firefox extension (Manifest V3)
  content.js          overlay, sync loop, hover-pause, transcript, mining trigger
  background.js       server proxy, settings, AnkiConnect and Downloads handling
  popup.*             settings UI
server/
  server.py           HTTP server: yt-dlp + faster-whisper + clip cutting
  setup.cmd/.sh       one-time environment setup     run.cmd/.sh   start (with auto-restart)
docker/               Windows wrappers for docker compose and the WSL engine installer
Dockerfile, compose.yaml, compose.cpu.yaml, .env.example
sign-addon.cmd        signs the extension through addons.mozilla.org
AGENTS.md             architecture notes, invariants and gotchas for contributors and coding agents
```

## Development

- Extension: `node --check addon/*.js`, `npx web-ext lint --source-dir addon`,
  `npx web-ext build --source-dir addon --artifacts-dir dist`.
- Server: `python -W error -c "import ast; ast.parse(open('server/server.py').read())"`,
  `server/run.cmd --check`. The planning and cue-splitting functions are pure and easy to unit
  test by importing `server.py` as a module (register it in `sys.modules` first because of the
  postponed annotations).
- Data lives in `~/.shisu-ko` (override with `SHISUKO_HOME`): `venv/`, `models/`, `cache/`.

## Tests

Automated tests cover the pure logic on both sides — no GPU, network or Firefox required — and
run in CI (see the badge at the top of this file) on every push and pull request via
[`.github/workflows/tests.yml`](.github/workflows/tests.yml).

**Server** (`server/tests/`): window planning (`plan_window`), interval merging, cue splitting
(`split_segment`), timestamp formatting, error message mapping, and the on-disk cue cache.

```
pip install -r server/requirements-test.txt
python -m pytest server/tests
```

**Extension** (`addon/tests/`): the pure/mockable parts of `background.js` (settings storage,
the server/AnkiConnect/Downloads proxying, sentence mining), run with Node's built-in test
runner against a `vm` sandbox that stands in for the WebExtension APIs.

```
node --test "addon/tests/**/*.test.js"
```

## Acknowledgements

Built on [faster-whisper](https://github.com/SYSTRAN/faster-whisper) and
[CTranslate2](https://github.com/OpenNMT/CTranslate2), [yt-dlp](https://github.com/yt-dlp/yt-dlp),
[PyAV](https://github.com/PyAV-Org/PyAV), OpenAI's [Whisper](https://github.com/openai/whisper)
and [Kotoba-Whisper](https://huggingface.co/kotoba-tech/kotoba-whisper-v2.0). The mining flow
follows the conventions of [Yomitan](https://yomitan.wiki/), [AnkiConnect](https://foosoft.net/projects/anki-connect/)
and [asbplayer](https://github.com/killergerbah/asbplayer).

## License

MIT, see [LICENSE](LICENSE).

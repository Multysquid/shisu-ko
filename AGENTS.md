# AGENTS.md

Guidance for AI coding agents (and new contributors) working in this repository.
Read this before changing code; the README is the user-facing document.

## What this project is

Shisu-ko shows live Japanese subtitles on YouTube in Firefox. A local Python server transcribes
the video's audio with Whisper (faster-whisper / CTranslate2) a little ahead of the playhead; the
extension renders the cues as real DOM text so Yomitan can scan them, and can mine a screenshot
plus sentence audio into the newest Anki card via AnkiConnect.

```
addon/        Firefox source extension, Manifest V3, plain JS; directly loadable without a build
              (match.js is shared by background.js and content.js; loaded before both)
server/       server.py (single file) + setup/run scripts; runtime data in ~/.shisu-ko
docker/       Windows wrappers for docker compose, WSL Docker Engine installer
Dockerfile, compose.yaml, compose.cpu.yaml, .env.example
flake.nix        Nix package/app/dev shell for the server and the extension build
sign-addon.cmd   signs the extension through addons.mozilla.org (needs the owner's API key)
```

## Invariants (do not break these)

- Subtitles must stay ordinary DOM text (`textContent`), never canvas, never `<track>` cues,
  never shadow DOM. Yomitan and other popup dictionaries depend on it.
- Never use `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `eval` or `script.src` in the content
  script. youtube.com enforces Trusted Types; only `textContent`/`createElement` style DOM code works.
- Application code uses the `browser.*` promise API. Firefox provides it natively; the shared
  `browser-api.js` adapter supplies it on Chrome, where its internal bridge necessarily calls
  `chrome.*` callbacks. Application code must not call `chrome.*` directly.
- All overlay classes and flags use the `shisuko-` / `__shisuko` prefix.
- Settings defaults live once in `addon/settings.js` (`SHISUKO_DEFAULT_SETTINGS`), loaded before
  `background.js`, `content.js` and `popup.js`. To add a setting, add it there and add the popup
  input with the same id; `addon/tests/settings.test.js` enforces both.
- The server listens on `127.0.0.1:8790`. Port 8765 belongs to AnkiConnect; never use it.
- The server never exposes anything beyond `/health`, `/sync`, `/clip`, `/sessions`; it binds to
  localhost, validates `video_id` against `^[A-Za-z0-9_-]{6,20}$`, and answers browser requests
  only from the extension's own origin or from pages on loopback hosts (`origin_allowed()`), so
  arbitrary websites cannot drive downloads and transcription.
- `enabled` in the settings is the master switch (the header toggle in the popup, Alt+Shift+S).
  Off must mean nothing happens on YouTube pages: no `/sync`, no overlay, no native-caption
  hiding, no arrow-key handling, no Anki polling. Only the toggle command itself keeps working.
- Live streams run on the stream's media clock, `getProgressState().current` of YouTube's player
  (read through `wrappedJSObject`, Firefox only), never on `video.currentTime`, which restarts at
  an arbitrary point on every page load. Every place the content script reads or seeks the
  playhead goes through `playhead()` / `seekPlayhead()`.
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
began, so the next window re-transcribes it whole. These functions are pure; test them by importing the
module (register it in `sys.modules` before `exec_module` because of `from __future__ import annotations`).

Cue building (`docs/subtitle-quality.md` is the rationale): the server runs Silero VAD itself on each
window (`speech_intervals()`, min speech 250 ms, min silence 300 ms) and passes the same options to
faster-whisper. Segments go through gates before becoming cues: no words, VAD overlap under 0.5,
faster-whisper's own word-anomaly score, repetition loops, and a gated phrase blocklist.
`build_cues(words, speech, limits)` then trims words outside speech, splits at sentence ends, long
pauses and `--max-cue-chars`/`--max-cue-seconds`, snaps starts to speech onsets, adds a lead-out into
following silence, merges fragments below `--min-cue-seconds`, and closes gaps under 0.5 s. Every cue
carries `seg`, the id of the Whisper segment it came from, so the extension can rejoin a sentence for
mining. Cue caches are format 2; older caches are ignored. `server/tools/cue_stats.py` and
`retranscribe.py` measure a cache before and after a change; keep them working.

Before the whole track is decoded (seconds for a long video), `Fetcher.make_preview()` decodes a
minute around the playhead into `Session.preview` (`(offset, samples)`) and marks the session
ready; `plan_window()` then only plans inside the preview and `audio_slice()` serves it. When the
playhead is within the first minute, a yt-dlp progress hook already runs that preview on the growing
`.part` file once enough bytes are in, so the first cues arrive while the download continues. The
full decode replaces it with `Session.audio` and clears the preview.

## How live streams work

yt-dlp reports `is_live`; `Fetcher.download()` then returns None and `Fetcher.follow_live()` runs
`LiveFollower` on the fetch thread instead of downloading. `DashLiveSource` asks yt-dlp (with
`live_from_start`) for the audio format's base URL and fetches `…&sq=N` segments: self-contained
fMP4 whose timestamps are the stream's media clock, verified to be the same clock as the player's
`getProgressState().current` (a DASH segment cross-correlates at 1.0 with the HLS audio at the
`PROGRAM-DATE-TIME` position, and the player's `ingestionTime` matches within ~0.2 s). The live
head comes from the `X-Head-Seqnum` response header; an expired URL (403) is refreshed once a
minute at most. The follower starts one segment before the playhead (`place_cursor()`), runs
forward to the head, waits for new segments, jumps after a seek, pauses while no client has
synced for `--client-timeout`, and exits after `--idle-minutes` (status `evicted`, refetched on
the next sync). Decoded audio lives in `Session.live_audio` (`LiveAudio`, 16 kHz chunks on the
stream clock, trimmed to `LIVE_KEEP_BEHIND` seconds behind the playhead); `audio_slice()`,
`plan_window()` (`plan_live_window()`: a window at the live edge waits until `LIVE_MIN_WINDOW`
seconds are there instead of being marked covered) and `/clip` read it. Live sessions are never
written to the cue cache; when the stream ends and comes back as a video, `Fetcher.fetch()` drops
the live cues and changes the session token so the client starts over on the video's clock.
`server/tests/test_live.py` drives the follower with a fake source and clock.

## How automatic mining works

`ankiPoll()` in `addon/background.js` watches AnkiConnect so the viewer never presses anything:
the content script asks once per sync tick (visible tab, no ad, not already mining) and the
background answers with the id of a note Yomitan has just created, plus what that note says
(`notesInfo`: its sentence field and its word field, `ankiWordField` or the field with `order` 0).
Four rules keep it from touching the wrong card.

- Baseline. Every poll remembers the highest `findNotes("added:1")` id. It reports nothing when
  that baseline cannot be trusted: first poll, previous poll failed, or more than 10 s since the
  previous successful one. Notes added while Anki was closed or no video was open stay untouched.
- One at a time. Two or more ids above the baseline mean an import or a sync, not a lookup, so
  the baseline moves and nothing is reported.
- Sentence guard. `addToAnki()` with an explicit note id scores the note's sentence field
  (`ankiSentenceField`, else `Sentence`) against the spoken sentence and against the cue text with
  `SHISUKO_MATCH.similarity`; below `MIN_SIMILARITY` on both it returns `{ mismatch: true }` and
  writes nothing. It is the same scoring the content script used to pick the cue, so the guard can
  no longer refuse what the matcher accepted.
- No downloads fallback. `mineCue` with `auto: true` never falls back to the Downloads folder: a
  failure the viewer did not ask for must not scatter files.

Polls are throttled to one request per 250 ms (several tabs poll the same background), and the
`requestPermission` handshake is retried at most once a minute until Anki grants it. Poll errors
are logged with `console.debug`, never toasted. A `notesInfo` that fails still reports the id,
with `note: null`, and the content script falls back to the cue at the playhead.

### Matching a card to its subtitle (`addon/match.js`)

`SHISUKO_MATCH` is a plain script loaded between `settings.js` and the two scripts that use it, in
both `background.scripts` and `content_scripts[0].js`.

- `normalize(text)` strips HTML tags, decodes `&nbsp; &amp; &lt; &gt; &quot; &#39;`, removes
  bracket furigana (`{sentence-furigana}` writes ` 食[た]べる`), all whitespace and punctuation.
- `similarity(a, b)` is 1 when either normalised text contains the other, otherwise the Dice
  coefficient of their character-bigram sets; `MIN_SIMILARITY` is 0.6. Dice, not the overlap
  coefficient: dividing by the smaller set alone passes two sentences that merely end the same way
  (別の字幕です against これはテスト字幕です scores 0.6), and containment already covers a card
  whose sentence is a real fragment of the cue. Either way the score is 0 unless the shorter text
  has at least 6 characters or covers half of the longer one: a three-character cue (ですね) inside
  a long card sentence is not a match, while a short cue's own card carries that same short
  sentence and still scores 1. Ties in `matchCue` break on that coverage first.
- `matchCue(cues, note, opts)` picks the cue a card belongs to: cues scoring below the threshold
  against the note's sentence are out, a cue containing the note's word gets +0.2, and ties break
  on `opts.rank(cue)` (the content script ranks pre-mined sentences, newest first) and then on
  distance from `opts.t`, the playhead. A card with no sentence matches on the word alone; a card
  with neither is nobody's, and `autoMine` falls back to `currentCueForMining()`.
- It stays O(n): containment is tried on every cue first and bigrams only if nothing contained.

### Pre-mined sentences

Nothing is captured when the card appears; it was captured while the line played. 400 ms after a
cue becomes active (`schedulePremine` in `content.js`), the content script reads the frame off the
video and sends `premine` to the background, and asks for the *next* sentence's clip as well, so a
lookup on either is already paid for. Hovering a line sends the frame again with `hover: true`:
that is the frame the viewer was actually looking at, and it pins the sentence.

The store is `premined`, a `Map` in `background.js` keyed by tab, video and sentence
(`cueIds[0]`). Entries hold the base64 frame, the clip and the promise fetching it
(`fetchClip(..., attempts = 1)`: nobody is waiting, and a failure simply leaves `audio` null for
the next attempt). Caps: 5 sentences per tab, 10 in all, oldest-touched unpinned first; a pinned
entry goes only when nothing else is left. Oversize payloads (3 MB image, 5 MB audio) are dropped.
`premineReset`, `tabs.onRemoved` and a new video or server session clear a tab. Nothing is ever
written to disk, and nothing survives a restart of the event page.

`mineCue` then uses it: an `imageDataUrl` sent with the message wins, else the held frame; the
held clip is used when its parameters still match the ones computed now (same start, end and
format to the millisecond), else the clip is fetched with the usual four tries and stored. Mining
does not remove an entry: two words from one line make two cards.

## Commands

Nix (any Linux with flakes, NixOS): `nix run . -- [options]` starts the server with CUDA
(`flake.nix`; CTranslate2 comes prebuilt from `cache.nixos-cuda.org`, onnxruntime is the CPU build
because only the VAD uses it). `nix run .#check`, `nix run .#tests`, `nix build .#addon`,
`nix develop` for a shell with Python, web-ext, Node and Deno. `.#server-cpu` is the CUDA-free variant.
Native server (Windows): `server\setup.cmd` once, then `server\run.cmd [options]`.
Native server (Linux/macOS): `bash server/setup.sh`, then `server/run.sh`.
Diagnostics: `server\run.cmd --check`.

Docker: `docker\up.cmd`, `docker\logs.cmd`, `docker\down.cmd` (or `docker compose up -d` etc.).
`up.cmd` keeps a minimized "Shisu-ko WSL keep-alive" window open when Docker Engine runs inside
WSL, because WSL stops the distro (and Docker) seconds after the last WSL session ends.

Extension checks and browser packages:

```
for file in addon/*.js; do node --check "$file"; done
npx web-ext lint --source-dir addon
npx web-ext build --source-dir addon --artifacts-dir dist --overwrite-dest --ignore-files "tests/**"

npm ci
npm test
npm run build
npx playwright install --with-deps chromium
npm run test:browser
```

`addon/manifest.json` is the Firefox source and remains directly loadable from
`about:debugging`. `node scripts/build.mjs` derives Chrome from that source into `dist/chrome`;
it never maintains a second application copy. `npm run watch` rebuilds after edits; reload the
unpacked extension in `chrome://extensions` and reload the YouTube tab. The build writes
versioned Firefox and Chrome ZIPs and excludes `addon/tests`, dotfiles, and development metadata.
Chrome's `service-worker.js` loads `browser-api.js`, `settings.js`, and `background.js` in that
order with classic `importScripts`, so settings globals retain the same behavior as Firefox.

Server check: `python -W error -c "import ast; ast.parse(open('server/server.py', encoding='utf-8').read())"`.

Automated tests (also run in CI via `.github/workflows/tests.yml`, no GPU/network/Firefox needed):

```
pip install -r server/requirements-test.txt && python -m pytest server/tests
node --test addon/tests/*.test.js
```

`server/tests/_serverlib.py` loads `server.py` the way this file already recommends above
(`sys.modules` registration before `exec_module`). `addon/tests/_loadBackground.js` runs
`background.js` in a Node `vm` sandbox with `browser`/`fetch`/`btoa` stubbed out — top-level
`function` declarations become sandbox properties, but `const`/`let` (`DEFAULT_SETTINGS`,
`REQUEST_TIMEOUT_MS`) need an extra script run in the same context to expose them, since they
live in the global lexical environment rather than as globalThis properties. `addon/tests/_loadContent.js` does the same for `content.js` by rewriting its IIFE to return its
pure helpers (`shouldSync`, `mergeCues`, `findActiveCue`, ...); it throws if the file's shape changes.
When adding a new setting or a new pure helper, add a matching test rather than only exercising
it manually.

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
- `browser.downloads.download()` refuses `data:` URLs ("Access denied for URL data:...", thrown
  synchronously before any promise exists): an extension may not load a URL that inherits its
  principal. Build a `Blob`, pass `URL.createObjectURL()` from the background page, revoke it later.

## Making changes

1. Keep `server.py` a single dependency-light file (stdlib + numpy + faster-whisper + yt-dlp + PyAV).
2. Bump `version` in `addon/manifest.json` and `VERSION` in `server/server.py` together.
3. Run the checks above, then test manually on a real YouTube video: subtitles appear, hover
   pauses, transcript panel works, Alt+Shift+M produces a toast and (with Anki running) fills the card.
4. Update README sections that describe changed behaviour; keep this file's invariants current.
5. Commit with a descriptive message; do not commit `.env`, `dist/` or anything from `~/.shisu-ko`.

## Release

- `npx web-ext build --source-dir addon --artifacts-dir dist --overwrite-dest --ignore-files "tests/**"` produces the zip (without the tests folder).
- `sign-addon.cmd` (repository owner only) produces a signed `.xpi` for regular Firefox.
- Attach the zip/xpi to a GitHub release; rebuild the Docker image with `docker compose build`.

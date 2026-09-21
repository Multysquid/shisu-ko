# AGENTS.md

Guidance for AI coding agents (and new contributors) working in this repository.
Read this before changing code; the README is the user-facing document.

## What this project is

Shisu-ko shows live Japanese subtitles on YouTube in Firefox and Chrome. A local Python server transcribes
the video's audio with Whisper (faster-whisper / CTranslate2) a little ahead of the playhead; the
extension renders the cues as real DOM text so Yomitan can scan them, and can mine a screenshot
plus sentence audio into the newest Anki card via AnkiConnect.

```
addon/        Firefox source extension, Manifest V3, plain JS; directly loadable without a build
              (match.js is shared by background.js and content.js; loaded before both)
server/       server.py (single file) + setup/run scripts + update.py; runtime data in ~/.shisu-ko
              native_host.py: the native-messaging host behind the popup's "Start server" button
              (stdlib only); native-host.cmd / native-host.sh wrap it, Firefox runs the wrapper
docker/       Windows wrappers for docker compose, WSL Docker Engine installer
Dockerfile, compose.yaml, compose.cpu.yaml, .env.example
flake.nix        Nix package/app/dev shell for the server and the extension build
sign-addon.cmd   signs the extension through addons.mozilla.org (needs the owner's API key)
publish-addon.cmd  submits a version to the public AMO listing; docs/amo/ holds the listing text and assets
```

## Invariants (do not break these)

- Subtitles must stay ordinary DOM text (`textContent`), never canvas, never `<track>` cues,
  never shadow DOM. Yomitan and other popup dictionaries depend on it.
- Never use `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `eval` or `script.src` in the content
  script. youtube.com enforces Trusted Types; only `textContent`/`createElement` style DOM code works.
- Settings are untrusted input before they reach CSS: every style value goes through a sanitiser
  in `applyStyleSettings()` (`clampNumber`, `oneOf`, `hexColor`, `fontStack` with
  `FONT_FAMILY_RE`, which admits only letters, digits, spaces, dots, hyphens and underscores). A
  font family that fails the rule falls back to the preset; no quote, semicolon or `url(` reaches
  the stylesheet. `popup.js` keeps copies of `FONT_FAMILY_RE`, the preset stacks and
  `MODEL_NAME_RE`; `addon/tests/popup-copies.test.js` keeps them equal to the originals.
- Application code uses the `browser.*` promise API. Firefox provides it natively; the shared
  `browser-api.js` adapter supplies it on Chrome, where its internal bridge necessarily calls
  `chrome.*` callbacks. Application code must not call `chrome.*` directly.
- All overlay classes and flags use the `shisuko-` / `__shisuko` prefix.
- Settings defaults live once in `addon/settings.js` (`SHISUKO_DEFAULT_SETTINGS`), loaded before
  `background.js`, `content.js` and `popup.js`. To add a setting, add it there and add the popup
  input with the same id; `addon/tests/settings.test.js` enforces both.
- The server listens on `127.0.0.1:8790`. Port 8765 belongs to AnkiConnect; never use it.
- The server never exposes anything beyond `/health`, `/sync`, `/clip`, `/sessions` and
  `POST /update`; it binds to localhost, validates `video_id` against `^[A-Za-z0-9_-]{6,20}$`,
  and answers browser requests only from the extension's own origin or from pages on loopback
  hosts (`origin_allowed()`), so arbitrary websites cannot drive downloads and transcription.
  `/update` is narrower (`update_origin_allowed()`: the extension's origin or no `Origin` header
  at all, never a page, since ending the server and making the launcher run git and pip is a
  capability only the popup has a use for) and answers 409 `{ok: false, error}` unless the
  server was started by `run.cmd` / `run.sh` (`SHISUKO_LAUNCHER=1`) without `--no-update` and
  without `SHISUKO_NO_UPDATE` (`App.update_blocker()`); otherwise it answers
  `{ok: true, restarting: true, version}` and the process exits with `EXIT_UPDATE` (4). The
  server never spawns `update.py` and never downloads a release itself; the launcher does.
- The add-on never installs itself: no `update_url` in the manifest, no `.xpi` download or
  install (`addon/tests/settings.test.js` enforces the manifest); its updates come from
  addons.mozilla.org. Its one remote request is the anonymous `GET` of
  `https://api.github.com/repos/Multysquid/shisu-ko/releases/latest` in `fetchLatestRelease()`,
  never with a token, cookie or identifier, and there is no second remote endpoint;
  `notifications` stays a required permission (the start-up check notifies with no popup open
  to ask for a grant). The privacy policy, description and reviewer notes in `docs/amo/` state
  exactly this, so a change here changes them too.
- The native host (`server/native_host.py`, name `shisuko`) answers only `status` and `start`.
  It never takes a path, a program or an argument from a message: the only thing it can run is
  the checkout's own `server/run.cmd` / `server/run.sh` (root = the parent of the folder the
  host file lives in), and it registers only under the user's own profile
  (`HKCU\Software\Mozilla\NativeMessagingHosts`, `~/.mozilla/native-messaging-hosts`,
  `~/Library/Application Support/Mozilla/NativeMessagingHosts`), never system-wide.
  `nativeMessaging` stays in `optional_permissions`, requested by the popup's click handler
  before its first `await` and by nothing else; the button is not a setting.
- A model name from a client (`model` in `/sync`) must match `MODEL_NAME_RE`
  (`^[A-Za-z0-9][A-Za-z0-9._-]{0,95}(/[A-Za-z0-9][A-Za-z0-9._-]{0,95})?$`) and contain no `..`;
  anything else is answered with `MODEL_NAME_HINT` and never stored. A valid name is reduced to
  its canonical alias (`canonical_model_name()`: `large`, `Systran/faster-whisper-large-v3` and
  `large-v3` are one model) and resolved through `faster_whisper.download_model()` before it is
  loaded. A raw client string must never reach `WhisperModel()`, which also opens local
  directories; only the operator's `--model` may be a folder, and it skips the download.
- `enabled` in the settings is the master switch (the header toggle in the popup, Alt+Shift+S).
  Off must mean nothing happens on YouTube pages: no `/sync`, no overlay, no native-caption
  hiding, no arrow-key handling, no Anki polling, no mining (the cues outlive the switch, so
  Alt+Shift+M would still find one). Only the toggle command itself keeps working: the command
  listener in `content.js` returns for every other command while `enabled` is false.
- The overlay lives in the page's DOM, where any script on youtube.com can dispatch events on
  it, so its handlers (`onMineClick`, `onTranscriptClick`, `onSubtitleEnter`, `onSubtitleLeave`,
  the transcript's close button) act only on trusted events (`ev.isTrusted`): a synthetic click
  must not write a card, save a file, seek or pause. The keyboard commands arrive through the
  browser, not the page. Text from the server is written into Anki's HTML fields only through
  `escapeHtml()` in `background.js`; the overlay shows it through `textContent`.
- Live streams run on the stream's media clock, `getProgressState().current` of YouTube's player
  (read through `wrappedJSObject`, Firefox only), never on `video.currentTime`, which restarts at
  an arbitrary point on every page load. Every place the content script reads or seeks the
  playhead goes through `playhead()` / `seekPlayhead()`.
- Runtime data lives in `~/.shisu-ko` (`SHISUKO_HOME` overrides it): `venv/`, `models/`, `cache/`,
  plus what the Start button brought: `server-<port>.lock` (`hold_instance_lock()` /
  `try_lock()`, held from before the model load until the server exits), `server.log` (the POSIX
  `launch()` appends the launched server's output there) and, on Windows only, the host manifest
  `native-messaging/shisuko.json` (`manifest_path()`; Linux and macOS keep it under Mozilla's
  own directories). Cue caches are only reused when model (compared canonically) and language
  match. The loaded model's cues are `cache/<video_id>.cues.json`; when another model takes the
  file over, `save_cache()` first archives the old cues as `cache/<video_id>.<slug>.cues.json`
  (slug: the canonical model name with everything outside `[A-Za-z0-9._-]` replaced by `_`), and
  `load_cache()` brings them back from there after a switch back.
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

Language watch: when `--language-patience` is above 0 (default 60) every window's speech-only
samples (`speech_samples()`, capped at 30 s) go through `model.detect_language()` before
transcription. `language_vote()` is the pure state machine over `Session.foreign_seconds`,
`heard` and `language_paused`: a foreign vote below the patience still transcribes, so one
misdetection never costs a subtitle; at the patience the session pauses, and every planned window
is then only listened to, until the target language is heard again.

What a paused session listens to goes into `Session.probed`, never into `covered`, and `probed`
is never written to the cache. That is the invariant that keeps a wrong pause cheap: `covered`
always means "Whisper has seen this", so a video paused by mistake can never cache as finished
and go permanently blank. `planned_ranges()` is the union the planners walk; hearing the target
language again empties `probed` and offers that audio back. `lookahead_for()` keeps the probes
within `LANGUAGE_PROBE_AHEAD` (90 s) of the playhead rather than `--lookahead`. A detector that
raises is never what silences a video: the window is transcribed unjudged. `--language-patience 0`
skips detection entirely and also refuses to restore a pause from the cache, so it really is the
cure the README offers. `/sync` and `/sessions` report `heard` and `language_paused`; the cache
stores them under `language_state`, discarded when `--language` changes. `retranscribe.py` sets
the patience to 0. `server/tests/test_language.py` covers the rules with a scripted model.

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

## How model switching works

The popup's `model` setting names the Whisper model the server should run; `--model` is only the
default. The content script sends it with every `/sync` (`modelForSync()`, trimmed, empty for the
default), and `App.request_model()` stores the wish: an empty name becomes the operator's
`--model` (not validated, it may be a folder), an invalid name is not stored (`model_state()`
answers that request with `MODEL_NAME_HINT`), a valid one is stored as its canonical alias
(`canonical_model_name()`, built lazily from `faster_whisper.utils._MODELS`: alias -> repo id ->
first alias, so `large` and `Systran/faster-whisper-large-v3` are `large-v3`), and a name that
failed less than `--retry-after` seconds ago is ignored (`in_cooldown()`), since the client
re-sends the setting every second.

`Transcriber.run()` calls `App.switch_model_if_wanted()` before every window, so the swap never
runs while a window is being transcribed. It is a small state machine over `wanted_model`,
`model_name`, `model_preparing`, `model_prepared`, `model_loading` and `model_error`, all under
`App.lock`:

1. Nothing wanted (`wanted == model_name`): drop leftover prepared files, clear `model_loading`.
2. Wanted but nothing in flight: start `prepare_model(wanted)` on a daemon thread
   (`prepare_thread`), set `model_preparing = model_loading = wanted`, keep transcribing with the
   old model. `prepare_model()` runs `download_model_files()`: `faster_whisper.download_model()`
   into `MODELS_DIR` plus a `model.bin` check, so a PyTorch checkpoint is refused before
   `WhisperModel()` sees it (the operator's `--model` folder skips the download). Nothing here
   touches the GPU, so a typo, a missing repo or an offline hub costs only a failed download:
   `model_error = (name, friendly_model_error())`, `model_failed_at`, `wanted_model` reset to the
   loaded model. There is no retry without a new request.
3. A download still running: keep transcribing, report the wanted name as loading (a change of
   mind cannot cancel a download; the new name waits behind it and stale files are dropped).
4. Files prepared for the wanted name: `self.model = None; gc.collect()` first, because on a GPU
   whose memory is mostly held by other programs two models rarely fit side by side, then
   `load_model(args, wanted, path=dir)`. Success: `model_name = wanted`, error cleared,
   `restart_sessions()`. Failure: `model_error`, `wanted_model = previous`, `reload_model(previous)`;
   if even that fails the server has no model left and calls `os._exit(3)` so the launcher
   restarts it on `--model`.

`restart_session()` clears cues, covered ranges, speech and `seg_next`, gives the session a new
token (the client drops everything on a token change, `dropCues()` in `content.js`), sets a
session without audio back to `pending` so `get_session()` fetches it again (the old model's
cache may have marked it covered without ever downloading), and calls `load_cache()` for the new
model. `/health` reports `model` (loaded, canonical), `default_model`, `model_loading`,
`model_error` as `{model, error, names}` (`names` from `model_spellings()`: every alias and the
repo id of the failed model, so the popup can match whatever spelling the viewer typed) and
`models` (`downloaded_models()`, the `models--owner--name` folders under canonical names).
`/sync` adds `model`, `model_loading` and `model_error`, the last judged for the name that
request carried and null for any other. `friendly_model_error()` turns huggingface_hub's
exceptions into one line: unknown size, not found on Hugging Face, could not reach Hugging Face,
no `model.bin`, else the last line of the message cut to 200 characters.

On the client, `content.js` keeps `state.modelLoading` / `state.modelError` from each answer,
shows `Loading model X… (a first use downloads it)` or `Shisu-ko: model X: <error>` (an error is
shown even with progress messages off, both parts capped by `truncate()`), and the storage
listener clears the verdict and syncs at once when the model setting changes. `popup.js` polls
`/health` every two seconds while open and in view (the same page is the options page, and a
hidden tab polls nothing until it is shown again): the badge says "Loading model" during a
switch, and
`modelErrorFor()` puts the server's verdict under the field only when the field's value (or the
default while empty) is one of the failed model's spellings.

Tests: `server/tests/test_model_switch.py` fakes `faster_whisper` in `sys.modules` (a
`download_model()` over a temp directory and a slice of `_MODELS`), stands the transcriber thread
down and calls `switch_model_if_wanted()` by hand (`tick()` joins the real prepare thread, a
blocking `Event` variant looks at the server mid-download); it covers names and aliases, the
prepare and swap, every failure path and the cooldown, the per-model cache files and both
endpoints. `addon/tests/content.test.js` covers the model name in `/sync`, the restart on a new
session token, the status texts and `fontStack()`; `addon/tests/popup-copies.test.js` keeps the
popup's copies of `FONT_FAMILY_RE`, the preset stacks and `MODEL_NAME_RE` equal to the originals
and the model hint in step with the `/health` shape.
## One tab at a time

Only one YouTube tab's `/sync` reaches the server. `background.js` elects it in `electSyncTab()`
(pure, tested in `addon/tests/tabs.test.js`). The rules, in order: the tab the viewer is watching
wins if it is the one asking; else the asker takes it when nobody holds it or the holder has been
quiet for `HOLD_TIMEOUT_MS` (12 s, two missed idle heartbeats); else a holder that is the watched
tab keeps it, playing or paused; else a playing asker beats a paused holder; else the holder keeps
it. The election never names a tab that did not ask — a focused tab claims the right on its own
next tick — because parking it on a tab that has stopped asking blanks every other tab until the
entry ages out.

Which tab is being watched comes from `tabs.onActivated` plus `windows.onFocusChanged`, and the
focus listener must ask `tabs.query({active: true, windowId})` itself: browsers fire
`onActivated` only when the selection inside a window changes, so a window whose tab was never
re-selected would otherwise stay unknown and its video starve in standby.

A refused tab gets `{status: "standby"}` from the background without a server call. The content
script treats that as "this tab is not the one talking to the server" and nothing more: it leaves
`offline`, the server status, the cues and `since` untouched, so a tab that stands by and comes
back keeps its subtitles, and it stops pre-mining and polling Anki, which is what kept `/clip`
reaching the server from a tab the election had refused. `statusText()` in `content.js` (pure,
tested) shows standby and the language pause even with `showStatus` off, since they are the only
answer to "why is nothing appearing?"; neither is styled as an error.

## How automatic mining works

`ankiPoll(tabId)` in `addon/background.js` watches AnkiConnect so the viewer never presses
anything: the content script asks once per sync tick (`ankiPollAllowed()`: `autoMine` on with
`mineTarget` `anki`, which is `autoAnkiMining()`; a visible tab, no ad, not already mining, not
standing by for another tab (`state.standby`, see "One tab at a time"), and not idle, meaning
two minutes after a plain pause or, during a hover pause, two minutes after the pointer was last
seen over the subtitle or the player, `hoverSeenAt`) and the background answers
with the id of a note Yomitan has just created, plus what that note says (`notesInfo`: its
sentence field and its word field, `ankiWordField` or the field with `order` 0).
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
`requestPermission` handshake is retried at most once a minute after the viewer clicked No:
`ankiPermission()` sets `permissionAskAt` a minute ahead before the request, because the polls
landing while Anki's dialog is up must not queue dialogs of their own, and pulls it back to
`ANKI_PERMISSION_RETRY_MS` (5 s) when no verdict came, so Anki not running is not a minute of
"denied" (the poll answers `offline: true` meanwhile). Poll errors are logged with
`console.debug`, never toasted. A `notesInfo` that fails still reports the id, with `note:
null`, and the content script falls back to the cue at the playhead.

The baseline is shared between tabs, so a note found by one tab's poll goes on a ledger
(`ankiWatch.reports`, kept for `ANKI_REPORT_WINDOW_MS`, 60 s) and `replayReport()` answers it,
with `replayed: true`, to every other tab that polls within the window, once per tab, before the
throttle and without a request of its own; each tab matches the card's sentence against its own
lines (`matchCue`), and the mine that writes into the note takes it off the ledger
(`forgetReport()` marks the entry `written`; it stays until the window drops it). While a mine
for a note runs (`mineCue()` keeps its promise in the entry's `mine`), the note is handed to no
other tab, a second mine for it waits for the first and writes only when that one wrote nothing
(else it answers `{ok: true, warning: true}` and "attached in another tab"), and a mine that
wrote nothing (a mismatch, no clip) gives the note back: the finder is mid-mine for seconds
when the other tab's tick lands, and two writes would leave the card with the later tab's frame
and clip. Only a note with a sentence goes on the ledger: one with a word alone, or one
`notesInfo` could not read, goes to the tab that found it, as before.

Every request on the mining path has a deadline, because the content script holds
`state.mining` until the `mine` message resolves: `fetchClip()` aborts each attempt after
`CLIP_TIMEOUT_MS` (30 s, body read included; "Whisper server timed out"), `addToAnki()` and
`storeMedia()` give AnkiConnect `ANKI_REQUEST_TIMEOUT_MS` (30 s) and its `requestPermission`
`ANKI_PERMISSION_TIMEOUT_MS` (60 s, the dialog), an abort reading "AnkiConnect did not answer in
time". The watcher's own `requestPermission` stays untimed: its poll resolves when the viewer
answers the dialog. Whatever is written into a note's HTML fields goes through `escapeHtml()`:
the sentence that fills an empty sentence field, and every text part `extendSentenceField()`
puts around its own `<b>`.

### Matching a card to its subtitle (`addon/match.js`)

`SHISUKO_MATCH` is a plain script loaded between `settings.js` and the two scripts that use it, in
both `background.scripts` and `content_scripts[0].js`.

- `normalize(text)` removes ruby readings first (`RUBY`: an `<rt>` or `<rp>` up to the next end
  tag; Yomitan's `{sentence-furigana}` and `{furigana}` write `<ruby>食<rt>た</rt></ruby>べる`,
  which stripping the tags alone would leave as 食たべる), then strips HTML tags, decodes
  `&nbsp; &amp; &lt; &gt; &quot; &#39;`, removes bracket furigana (`{sentence-furigana-plain}`
  writes ` 食[た]べる`), all whitespace and punctuation.
- `similarity(card, spoken)` takes the card's text first, and the order matters. It is 1 when
  the spoken text contains the card's sentence whole, however short (`contains()`: the server
  merges a short cue into its neighbour, 嘘でしょ。本当にそんなことがあったの, and Yomitan stops at
  the 。, so the card reads 嘘でしょ, four characters only that line explains), or when the card's
  sentence contains the spoken text and that text is a real share of it (`comparable()`: at
  least 6 characters, or half of the longer one, so a three-character cue, ですね, inside a long
  card sentence is not a match); otherwise the Dice coefficient of their character-bigram sets,
  0 unless comparable; `MIN_SIMILARITY` is 0.6. Dice, not the overlap coefficient: dividing by
  the smaller set alone passes two sentences that merely end the same way (別の字幕です against
  これはテスト字幕です scores 0.6), and containment already covers a card whose sentence is a real
  fragment of the cue.
- `matchCue(cues, note, opts)` picks the cue a card belongs to: cues scoring below the threshold
  against the note's sentence are out, a cue containing the note's word gets +0.2, and ties break
  on `share()`, then on `opts.rank(cue)` (the content script ranks pre-mined sentences, the one
  read last first) and then on distance from `opts.t`, the playhead. `share()` is 1 for a cue
  that runs past the sentence at a point where Yomitan cuts (`cutFrom()`: the sentence is a whole
  piece of the cue's raw text between 。！？!?．… or a newline, or of such a piece between quotes,
  「」『』 and the straight ones; Yomitan never cuts at 、), else the shorter text's length over
  the longer one's (`coverage()`), so a whole line beats a fragment of itself and a line that is
  the sentence beats one holding it mid-clause. A card with no sentence matches on the word alone; a card
  with neither is nobody's, and `autoMine` falls back to `currentCueForMining()`.
- It stays O(n): containment is tried on every cue first and bigrams only if nothing contained.

### Pre-mined sentences

Nothing is captured when the card appears; it was captured while the line played. 400 ms after a
cue becomes active (`schedulePremine` in `content.js`), the content script reads the frame off the
video and sends `premine` to the background, and asks for the *next* sentence's clip as well
(`ahead: true`), so a lookup on either is already paid for. The frame is read only while
`autoAnkiMining()` holds (`autoMine` on and `mineTarget` `anki`): a mine the viewer asks for takes
the frame on screen, so otherwise the `premine` carries no image and only the clip is prepared.
Hovering a line sends the frame again with `hover: true`: that is the frame the viewer was
actually looking at, and it pins the sentence; the same sentence at the same paused position is
not read back again (`hoverShot`). Every frame is drawn onto one shared canvas (`drawFrame()`),
let go after a tainted read. Premine and `premineReset` messages leave one at a time
(`premineTurn()`), and an answer from before `state.cueGeneration` changed (`dropCues()` bumps
it: a new video, a new session token) is not taken as the held list, since the new cues' ids
start at 0 again and would count as prepared with the old video's material.

The store is `premined`, a `Map` in `background.js` keyed by tab, video and sentence
(`cueIds[0]`). Entries hold the base64 frame, the clip and the promise fetching it
(`fetchClip(..., attempts = 1)`: nobody is waiting, and a failure simply leaves `audio` null for
the next attempt). Caps: 5 sentences per tab, 10 in all, oldest-touched unpinned first; a pinned
entry goes only when nothing else is left. Oversize payloads (3 MB image, 5 MB audio) are dropped.
`premineReset`, `tabs.onRemoved` and a new video or server session clear a tab. The inventory
answered to the tab (`heldFor()`) is ordered by `seen`, stamped by every message without `ahead`,
then by `touched`: a sentence only prepared ahead of its turn ranks behind the one on screen.
Nothing is ever written to disk, and nothing survives a restart of the event page.

`mineCue` then uses it: an `imageDataUrl` sent with the message wins, else the held frame; the
held clip is used when its parameters still match the ones computed now (same start, end and
format to the millisecond), else the clip is fetched with the usual four tries and stored. Mining
does not remove an entry: two words from one line make two cards.

## How the Start server button works

A WebExtension cannot spawn a process, so the popup's button goes through native messaging:
`background.js` sends `{cmd: "start"}` to the native host `shisuko`, and the host,
`server/native_host.py`, runs the checkout's own launcher. Firefox only: `register()` writes the
Mozilla host manifest, Chrome's would have to name the installed extension's id under its own
key, so `popup.js` hides the button unless `browser.runtime.getURL("")` is `moz-extension:`
(`START_AVAILABLE`). The host is stdlib only, so the wrapper can fall back to the system Python
before setup ran, and it never imports `server.py` (`VERSION` is read from it with a regex).

Protocol (Firefox's: 4-byte little-endian length, UTF-8 JSON, one request per message, answered
in order until stdin closes; `read_message()` / `write_message()`, `serve()`, `handle()`):
`{"cmd": "status"}` -> `{ok, running, version, root}`, `running` being a `/health` answer within
1.5 s (`server_running()`); `{"cmd": "start"}` -> `{ok: true, already: true}` for a running
server, `{ok: true, already: true, starting: true}` for one that holds the instance lock but
does not answer yet (its model is loading; `server_starting()`), else `launch()` and
`{ok: true, started: true, log}` (`log` null on Windows, the path of `~/.shisu-ko/server.log`
elsewhere) or `{ok: false, error}` in one line. Anything else, a request with extra keys
included, is `{ok: false, error: "unknown command"}`; a frame over 1 MiB is answered and ends
the host. The instance lock is `APP_DIR/server-<port>.lock`: `server.py` takes it in
`hold_instance_lock()` before `load_model()` and holds it until the process ends, a second
server exits 2. `try_lock()` exists in both files (`msvcrt.locking` / `fcntl.flock`); only
`LOCK_HELD_ERRNOS` mean "held", a filesystem that cannot lock at all counts as no lock.
`launch()` on Windows runs `cmd.exe /c start "Shisu-ko server" .\run.cmd` with `cwd=server/`
(cmd.exe splits a full path holding `&` or `(` even when quoted), `DETACHED_PROCESS |
CREATE_NEW_PROCESS_GROUP` and first `CREATE_BREAKAWAY_FROM_JOB`, retrying without it on
`PermissionError`; on POSIX `bash run.sh` with `start_new_session=True` and stdout/stderr
appended to the log (bash, not the file itself: a zip install has no mode bits). The browser
starts the host with arguments of its own (Firefox: manifest path and extension id); `main()`
serves whenever no action flag is given and stdin is not a terminal.

Registration (`native_host.py --register | --unregister | --status [--verbose]`, exit 0 on
success, quiet unless `--verbose`): the manifest `{name: "shisuko", description, path:
<wrapper>, type: "stdio", allowed_extensions: ["shisu-ko@multysquid.github.io"]}` goes to
`%USERPROFILE%\.shisu-ko\native-messaging\shisuko.json` (`SHISUKO_HOME` respected) plus the
default value of `HKCU\Software\Mozilla\NativeMessagingHosts\shisuko` on Windows, to
`~/.mozilla/native-messaging-hosts/shisuko.json` on Linux and to
`~/Library/Application Support/Mozilla/NativeMessagingHosts/shisuko.json` on macOS. The
wrapper is `server/native-host.cmd` (CRLF) or `server/native-host.sh` (LF, mode 755;
`register()` restores the bit a zip install drops): the venv's Python, else the system one, on
`native_host.py`. `setup.cmd` / `setup.sh` register and then run `--check`, which reports it;
`run.cmd` / `run.sh` register on every start, so an install that never re-ran setup gets the
button after a manual start, with one exception: the start that updates an older checkout to
this version does not register, because the old launcher is what runs (`run.cmd`'s old
`update.py ... & goto loop` jumps to `:loop` in the new file, below the register line; `run.sh`'s
already-parsed old `main()` has no register call), so it is the start after the update, or
setup, that registers. In `run.cmd` the call sits on its own line before the
`update.py ... & goto loop` line; in `run.sh` after the update, which rewrites the wrapper.
`launch()` passes no arguments to the launcher: a server the button started runs on `server.py`'s
defaults (`--model large-v3`, `--device auto`), and the popup's model setting only takes effect
after that default model is loaded.
`run_check()` in `server.py` loads `native_host.py` by path and prints `status_text()`.

Extension side: the popup's flow is `startFlow.state`, `idle -> requesting -> starting ->
waiting -> idle` once `/health` answers, or `failed` with the reason on the detail line and the
button back; the permission request is issued in the click handler before its first `await`
(it needs the user gesture). A server-address edit (`checkServer(true)`) puts a spent flow
(`failed`, and the update flow's `done` / `stale` / `failed` / `lost`) back to `idle`, since
its hint was judged at the old address, and overtakes a `/health` request still under way
(`healthAsked`: the old address may hold it up for the full timeout, and its answer is
dropped). The background owns the launch (`startServer()`): one
`sendNativeMessage` at a time (`startInFlight`), raced against `NATIVE_TIMEOUT_MS` (15 s), the
answer recorded with a `deadline` of `START_WINDOW_MS` (90 s, past any healthy model load) in
memory and in `browser.storage.session` (Firefox ends an idle event page after 30 s), so a
reopened popup resumes at "waiting" (`startServerStatus`) instead of offering a second start
while the first still loads; a `/health` answer through `apiRequest()` forgets the record.
`nativeError()` maps the browser's exceptions: "No such native application" / "not found" /
"forbidden" -> `launcher not registered` with `LAUNCHER_HINT`; permission wording, or no
`sendNativeMessage` at all -> `permission missing`; timeout -> `the launcher did not answer`;
the host's own `{ok: false, error}` passes through. The popup keeps `already` and the host's
`starting` (as `loading`) for the hint at the deadline: `START_ELSEWHERE_HINT` when the launcher
saw a server answering that the popup cannot reach, else `startNotUpHint(log)`. Badge texts:
`Checking server`, `Server offline`, `Starting server`, `Updating server`, `Loading model`,
`Server online`. A start and an update exclude each other: `requestStart()` refuses while
`pendingUpdate()` holds a record (`UPDATE_RUNNING_HINT`), `startStatus()` carries that record
as `updating` so a reopened popup hides the button before its first paint, and the popup
disables Update while `START_BUSY` and hides Start while `UPDATE_BUSY`.

Tests: `server/tests/test_native_host.py` (framing, `handle()` for every shape with `launch()`
never called, `serve()`, `launch()` with a recorded `Popen` on both platforms, the lock against
`server.py`'s, registration into a temp home with a fake `winreg` on every platform, `main()`,
the host over a real pipe, the wrapper run the way Firefox runs it, the launchers' register
lines); `server/tests/test_server.py` for `hold_instance_lock()`; `addon/tests/background.test.js`
(the message, the error mapping, the timeout, the record across an event-page restart);
`addon/tests/popup.test.js` (the flow against a fake document: resume, both deadline hints,
Chrome hiding the button, one host request per click); `addon/tests/browser-api.test.js` for
the Chrome bridge of `sendNativeMessage` and `storage.session`.

## How the update step works

`server/update.py` (stdlib only) runs first in `run.cmd` / `run.sh`, never in Docker or Nix. In a
git checkout it fetches the tracked upstream and fast-forwards (`merge --ff-only`); a diverged
branch, local changes git would overwrite, a detached HEAD or an unreachable remote leave the
tree alone with a message. In a folder without `.git` it compares `VERSION` with the newest
GitHub release tag (`v<VERSION>`, so keep bumping `VERSION`, the manifest and the tag together)
and unpacks the release zip over the folder, staging each file next to its target and
`os.replace()`-ing it, without deleting anything. Both paths reinstall `requirements.txt` into
the running interpreter when it changed (only inside a venv) and point out a changed
`addon/manifest.json` version. It always exits 0: the server must start even when the update
fails. `--no-update` or `SHISUKO_NO_UPDATE=1` skips it; `server.py` accepts `--no-update` too
(`args.no_update`) so the launchers can pass all arguments through, and reads it, like the
variable, as a reason to refuse `POST /update`.

The launchers also run the update on demand, for the popup's Update button: `run.cmd` /
`run.sh` set `SHISUKO_LAUNCHER=1` for the server they start, `POST /update` then marks
`App.exit_code = EXIT_UPDATE` (4), answers, and `stop_server_later()` calls `httpd.shutdown()`
from a helper thread after `SHUTDOWN_DELAY` (0.5 s, so the answer leaves the socket;
`shutdown()` blocks until `serve_forever()` returns, so the handler thread cannot call it),
and `main()` runs `server_close()` and then `sys.exit(app.exit_code)`; every worker is a daemon
thread, so nothing waits for a window. Exit code 4 means "run `update.py`, then start again":
`run.cmd` has `if "%CODE%"=="4" goto update` after the 0 and 2 branches, `run.sh`
`[ "$code" -eq 4 ] && { update.py "$@"; native_host.py --register; continue; }` (the register
call restores the wrapper's mode bits, which the zip update drops). Codes 0 and 2 keep their
meaning, every other code keeps the 5 s restart.

The update can replace the launcher that is running it. cmd.exe reads batch files incrementally,
so in `run.cmd` the update call and `goto loop` must stay on one line and the `:loop` label must
keep its name; `run.sh` keeps everything in `main()` and ends with `main "$@"; exit` for the same
reason. The code-4 path adds two rules. The `:update` label sits directly above that one-line
update call, so `goto update` lands on it: the lines between the server's exit and `goto update`
are read from the old file, which nothing changed since the jump to `:loop`, and the already
parsed `goto loop` looks its label up in the new file, so no line is ever read from a stale
offset. And `set "SHISUKO_LAUNCHER=1"` sits directly after `:loop`, not at the top: a launcher
from before the variable that has just updated itself arrives in the new file through its own,
already parsed `goto loop`, so only the lines after `:loop` run for it, and its server would
otherwise refuse the button. `run.sh` cannot help itself the same way (bash parsed the old
`main()`, which has no code-4 branch, before the update), so `export SHISUKO_LAUNCHER=1` sits
inside `main()` before the loop and the server's 409 text names "an older launcher that has not
been restarted since it was updated"; a restart by hand fixes it. `server/tests/test_update.py`
drives the real git against a bare repository in a temp directory and feeds a locally built zip
in place of the GitHub download; `server/tests/test_update_endpoint.py` covers the endpoint
over a real socket (the variable read strictly as `"1"`, both no-update switches, the latter
asserted equal to `update.skipped()` for nine values, the 409s, the answer followed by
`serve_forever()` returning and `main()` raising `SystemExit(4)`, the origin rule, `GET` 404,
the body guards) and the launcher texts (CRLF in `run.cmd`, `:update` right above the one-line
call, the variable inside the loop, the 0/2/4/restart order, `run.sh`'s export inside `main()`).

## How the update check works

The add-on side of updates lives in the "updates" section of `addon/background.js` and in
`popup.js`; the extension never installs itself (no `update_url`, no `.xpi` handling: its
updates come from addons.mozilla.org once the listing is live, and until then the release page
has the `.xpi`), it only tells the viewer and asks the server to update itself.

- Check. `fetchLatestRelease()` gets `GITHUB_LATEST_URL`
  (`https://api.github.com/repos/Multysquid/shisu-ko/releases/latest`, `Accept:
  application/vnd.github+json`, `UPDATE_CHECK_TIMEOUT_MS` 10 s). No host permission: GitHub's
  API answers cross-origin requests with `Access-Control-Allow-Origin: *`. `releaseFromApi()`
  reads `{version, tag, url, xpi}` (tag `v0.9.0` -> `0.9.0`; `html_url`; the
  `browser_download_url` of the `.xpi` asset or null; https only, since the popup opens `url`
  in a tab). `checkForUpdate({force})` answers from `storage.local.updateCheck`
  (`{checkedAt, latest, error}`) while it is fresh (`checkIsFresh()`: no error and under
  `UPDATE_CHECK_MAX_AGE_MS`, 24 h), else fetches; one check at a time (`checkInFlight`). A
  failure (offline, 403/429 rate limit, non-JSON, no `tag_name`) is stored as `error`, keeps the
  last `latest`, is logged with `console.debug` and never notifies; 404 means no release yet.
- When. `startupCheck()` on `runtime.onStartup` and `onInstalled`, but only once the profile
  has a stored check: a profile that never opened the popup makes no request on its own, which
  keeps `scripts/browser-smoke.mjs` (fresh Chromium profile, local fixtures) off GitHub; the
  smoke test seeds `updateCheck: {checkedAt: Date.now(), latest: null, error: null}` beside its
  settings. The popup's first `updateStatus` carries `check: true` (the day's check when the
  store is stale); "Check for updates" sends `checkForUpdate` with `force: true`.
- Decision. `parseVersion("v0.9.0") -> [0, 9, 0]` (non-numeric or missing parts are 0),
  `compareVersions(a, b) -> -1 | 0 | 1`, and `decideUpdate({latest, serverVersion,
  serverLauncher, extensionVersion, serverOnline})` -> `{server, extension}`. `server`:
  `current` (latest <= version), `newer` (latest > version and `launcher: true`), `cannot`
  (newer, `launcher: false`: Docker, Nix, a hand start, `--no-update`), `behind` (newer, no
  launcher flag: every 0.8.0 server, so no claim about run.cmd), `unknown` (no `latest`, or a
  server without a version such as the smoke fixture's `/health`), `offline` (no server).
  `extension`: `newer` when latest > `browser.runtime.getManifest().version`, else `current`.
  `serverInfo(health)` reads `version` and `launcher` from `/health`, null when missing.
  `popup.js` keeps copies of `parseVersion`, `compareVersions`, `UPDATE_SHUTDOWN_MS` and
  `UPDATE_WINDOW_MS`; `addon/tests/popup-copies.test.js` keeps them equal.
- Ask. `applyBadge()` sets the toolbar badge (`action.setBadgeText` "1", `BADGE_COLOR`
  `#5b6fb8`, never the alert red) for `newer`, `cannot`, `behind` or a newer extension and clears
  it otherwise; `notifyNewer()` creates one system notification per release and browser session
  (`notifiedVersion` in `storage.session`; id `shisuko-update`, "Shisu-ko <latest> is
  available" / "The server runs <server>. Click to update it now."), only for `newer`, only from
  the start-up check. `notifications.onClicked` runs `updateServer({watch: true})`; a request
  that fails there gets a notification of its own (`shisuko-update-failed`, whose click does
  nothing), except when the server already runs the release (`upToDate: true`: updated another
  way while the notification sat there, and the click's own clear was all there was to do);
  `updateStatus()` clears `shisuko-update` whenever the decision is `current`. Badge and
  notification helpers tolerate a missing API (the test sandbox, a content script). The
  popup's banner (`#update-banner`, `renderUpdate()`) names the release and the server's
  version with **Update** and **Not now** for `newer`, the reason and no Update button
  for `cannot` ("was not started by run.cmd / run.sh", the one text for every blocker, since
  `/health` carries only the flag and a `--no-update` server's 409 text is never fetched) and
  `behind` ("cannot be updated from
  here"), the release page link for an extension behind, and nothing for `offline` (the next
  start updates) or after "Not now" (`updateSnoozed` = latest in `storage.session`). The
  "Check for updates" link in the last drawer writes `#update-result` ("Newest release: 0.9.0,
  checked 3 min ago", "No release found, …", "Update check failed: <error> (last seen: X)").
- Update. Popup **Update** or the notification click -> `{type: "updateServer"}` ->
  `requestUpdate()`: `/health` first (so a spent record ends, see below), refuse without a POST
  (`{ok: false, upToDate: true, error}`) when the server already runs >= latest, else
  `POST /update` through `apiRequest()`. On
  `{ok: true, restarting: true}` the record `serverUpdate` `{requestedAt, from, to, deadline,
  down}` (`deadline` = `UPDATE_WINDOW_MS`, 120 s: the launcher's update plus a model load) goes
  to `storage.session` with a memory fallback (`sessionGet` / `sessionSet`), the notification is
  cleared and the popup gets `{ok, restarting, from, to, requestedAt, deadline}`; a 409 passes
  the server's text through as `{ok: false, error, refused: true}` (the banner shows it and
  drops the button), unreachable is `offline: true`. Every `/health` answer through
  `apiRequest()` passes `noteHealth()`: no answer marks the record `down`; a version >= `to` ends
  it, recomputes the badge and notifies "Shisu-ko updated to <version>" (`shisuko-updated`);
  the old version ends it silently once the server was seen down or `UPDATE_SHUTDOWN_MS` (10 s)
  has passed since the request (the old server closes its port within a second), because the
  old code back after a restart means `update.py` could not update. The notification path has
  no popup polling, so `watchUpdate()` polls `/health` every `UPDATE_POLL_MS` (3 s) until the
  record ends. The popup's `updateFlow` (`idle -> requesting -> updating -> done | stale |
  failed | lost`) mirrors it: badge "Updating server" with "Restarting with <latest>…", then
  "Updated to <version>", `stillOldHint()` ("The server restarted but still runs X; look at its
  window: update.py said why", banner stays) or, offline at the deadline, `UPDATE_LOST_HINT`
  with the Start button back. `refreshUpdate()` sends the popup's own `/health` answer with the
  question and re-asks only when the server's version, launcher flag or reachability changed or
  after an action; answers are numbered (`updateAsked`) so a slow first answer, held up by the
  check of GitHub, cannot overwrite the verdict for the server now on screen; an overtaken
  first answer makes the popup ask once more, since it carried the day's check, which the answer
  that overtook it was given without. It resolves to whether an answer was taken, and the banner
  is painted again only then. A reopened popup resumes the flow from `startServerStatus`
  (`updating`) before its first paint.
- Chrome. `browser-api.js` bridges `action.setBadgeText` / `setBadgeBackgroundColor`,
  `notifications.create` / `clear` (with `onClicked` passed through) and `tabs.create`; the
  endpoint is plain HTTP, so the flow is the same there.

Messages: `updateStatus {health?, check?}` -> `{latest, checkedAt, error, server: {version,
launcher} | null, decision, snoozed, updating, extensionVersion}`; `checkForUpdate {force?}` ->
`{checkedAt, latest, error}`; `updateServer` -> as above; `snoozeUpdate {version}` -> `{ok}`.

Tests: `addon/tests/background.test.js` (the version helpers and `decideUpdate`,
`releaseFromApi`, the store and its age, every failure of the check, the start-up check with
badge and one notification per session and its silence for `cannot` / `behind` / no server, a
browser without the APIs, `updateStatus`, `snoozeUpdate`, the `/update` request with its record
across an event-page restart, the `/health` polls that end it including the old version with
and without a poll that saw the server down, the notification click and its failure
notification, the refusal of a start during an update, the message switch);
`addon/tests/popup.test.js` (every banner verdict, the overtaken answer, Not now, Update to
"Updated to 0.9.0", the old version back, the deadline, a 409 in the banner, the resumed
update from both status messages, the Start/Update exclusion, Check for updates);
`addon/tests/browser-api.test.js` (the Chrome bridges); `addon/tests/settings.test.js`
(`notifications` required, no `update_url`); `addon/tests/popup-copies.test.js` (the copies).
`addon/tests/_loadBackground.js` stubs `action`, `notifications`, `runtime.onStartup` /
`onInstalled` / `getManifest` and exposes `startup()`, `clickNotification()` and `setNow()`.

## Commands

Nix (any Linux with flakes, NixOS): `nix run . -- [options]` starts the server with CUDA
(`flake.nix`; CTranslate2 comes prebuilt from `cache.nixos-cuda.org`, onnxruntime is the CPU build
because only the VAD uses it). `nix run .#check`, `nix run .#tests`, `nix build .#addon`,
`nix develop` for a shell with Python, web-ext, Node and Deno. `.#server-cpu` is the CUDA-free variant.
Native server (Windows): `server\setup.cmd` once, then `server\run.cmd [options]`.
Native server (Linux/macOS): `bash server/setup.sh`, then `server/run.sh`.
Diagnostics: `server\run.cmd --check` (also says whether the Start button's launcher is registered).
Start-button launcher, with the venv's Python (`run.cmd` / `setup.cmd` and their `.sh` twins do
this themselves): `~/.shisu-ko/venv/Scripts/python server/native_host.py --register --verbose`
(`venv/bin/python` on Linux/macOS), `--status`, `--unregister`.

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
Chrome's `service-worker.js` loads `browser-api.js`, `settings.js`, `match.js` and `background.js`
in that order with classic `importScripts`, so settings globals retain the same behavior as Firefox.

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
pure helpers (`shouldSync`, `mergeCues`, `findActiveCue`, `jumpTarget`, `fontStack`,
`modelForSync`, ...) and the handlers that drive them (`sync`, `premineNow`, `onKeyDown`,
`onMineClick`, `discover`, ...), the `browser.storage.onChanged` listener as `onSettingsChanged`
and the `runtime.onMessage` listener as `onCommand`; it throws if the file's shape changes. Its
`stubElement(tag)` keeps a child list (`appendChild`, `insertBefore`, `replaceChildren`, a
fragment that empties into its target), so a test can count the nodes a render makes and read
the transcript panel's order back, and a stub canvas yields no blob. `addon/tests/popup.test.js`
builds its fake document from `popup.html` (tags, types, range bounds, listeners a test can
fire) and plays the background with a `getSettings` / `saveSettings` pair that merges like
`background.js` and echoes the write to the storage listener.
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
  means a startup error that must not be retried. Exit code 3 asks for a restart: a broken GPU
  context, and also a failed model switch after which the previous model could not be reloaded,
  which would leave the server running without any model. Exit code 4 (`EXIT_UPDATE`) asks the
  launcher to run `update.py` before starting again; only `POST /update` produces it.
- AnkiConnect: send requests without a `Content-Type` header (a "simple" request needs no CORS
  preflight), call `requestPermission` first, find the newest card with `findNotes("added:1")`.
- `data_collection_permissions` in the manifest requires `strict_min_version` 140 or later.
- `notifications` is a required permission, not an optional one: the update notification is
  created from the start-up check, where no popup is open to ask for a grant. The GitHub check
  needs no host permission (`Access-Control-Allow-Origin: *`), but GitHub allows sixty
  unauthenticated API requests an hour per address, shared with everything else on the
  connection: hence one check a day, cached in `storage.local`, and the 403/429 text that asks
  to try again in an hour. Never add a token.
- Regular Firefox only keeps signed add-ons; unsigned builds are temporary installs only.
- Screenshots fail on DRM-protected videos (tainted canvas); the audio clip still works.
- The native server and the container both use port 8790; run one at a time.
- Firefox runs a `.cmd` native host through `cmd.exe /s /c "<host> <manifest path> <extension id>"`.
  stdout is the protocol, so the wrapper must not `echo`, `pause` or print anything (`@echo off`
  first), and the host has to accept those two arguments. Firefox keeps the host in a job
  object: a child that does not `CREATE_BREAKAWAY_FROM_JOB` dies with the host. And cmd.exe
  splits a quoted path holding `&`, `(` or `^`: name the launcher relative to `cwd`.
- `scripts/browser-smoke.mjs` waits for `#server-status` to read exactly `Server offline` and
  then `Server online`; keep those badge texts.
- `browser.downloads.download()` refuses `data:` URLs ("Access denied for URL data:...", thrown
  synchronously before any promise exists): an extension may not load a URL that inherits its
  principal. Build a `Blob`, pass `URL.createObjectURL()` from the background page, revoke it later.
- The toolbar popup's document dies with the click outside it that closes it, and a text field's
  `change` event fires on that very close: `flushSave()` in `popup.js` sends the save before any
  `await`, from `pagehide` and `visibilitychange` as well as the 150 ms debounce, and sends only
  the fields edited since the last save (`dirty`), because the form is not the only writer (the
  content script saves `enabled` and `showTranscript` for the commands) and a whole-form save
  would put back what another writer changed; `browser.storage.onChanged` brings such changes
  into the form. `saveSettings()` in `background.js` is a read-modify-write, so it runs one save
  at a time (`saveChain`): two in flight would drop a patch.
- YouTube's SPA keeps the watch page in the DOM when it leaves it: on a Short reached from a
  watch page `#movie_player` still exists, hidden, with its video, so `findPlayer()` asks for
  `#shorts-player` on `/shorts/` addresses first, or the Short would be fetched and transcribed
  on the hidden video's clock. An ad runs on a clock of its own: `/sync` still goes out during
  one (the server hears of a new video only through it, and a pre-roll ad used to hold up the
  fetch by its whole length), carrying `state.contentPlayhead`, the video's position as of the
  last request outside an ad, or the link's `t=` before the first.
- The player's focused controls (the volume slider, the settings menu, the radios and lists of
  its dialogs) take the arrow keys themselves; `KEY_SKIP_SELECTOR` names them by ARIA role,
  except the progress bar, whose arrows are the five second seek the subtitle jump replaces.
  `jumpTarget()` answers null, leaving YouTube's own seek alone, when there is no cue at all or
  the playhead and the target do not sit in the same covered range (`coveredRange()`): the last
  known line before an untranscribed stretch is not the previous line.

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
- `publish-addon.cmd` (repository owner only) submits the build to the public listing on
  addons.mozilla.org: `docs/amo/make_metadata.py` turns `docs/amo/{summary.txt,description.md,
  release-notes.md,reviewer-notes.md}` into the metadata JSON that `web-ext sign --channel listed`
  sends. The privacy policy, icon and screenshots in `docs/amo/` are set in the Developer Hub;
  `docs/amo/README.md` is the checklist. AMO refuses a version number that was uploaded before in
  either channel, so bump before signing or publishing. Update `release-notes.md` per release.
- Attach the zip/xpi to a GitHub release; rebuild the Docker image with `docker compose build`.

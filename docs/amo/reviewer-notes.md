WHAT THE ADD-ON IS

Shisu-ko shows live Japanese subtitles on YouTube. It is one half of a two-part program: a
companion server (server/server.py in the same repository, Python, MIT) runs on the user's own
computer, listens on http://127.0.0.1:8790, downloads the audio track of the video the user is
watching with yt-dlp and transcribes it with Whisper (faster-whisper). The extension sends the
video id, the current playback position and the name of the Whisper model chosen in the popup
(a faster-whisper size or a Hugging Face repo id; empty for the server's default) to that server
once per second while a video plays, receives subtitle cues back and renders them over the
player as plain DOM text (textContent), so
popup dictionaries such as Yomitan can scan them. Optionally it sends a screenshot of the video
frame and an MP3 clip of the sentence to Anki through the AnkiConnect add-on
(http://127.0.0.1:8765), or saves them to Downloads/shisu-ko-mining/.

Nothing is sent to us or to any third party. The extension only ever contacts youtube.com (as a
content script), the local server, the local AnkiConnect and, for its update check, GitHub's
public API (one anonymous GET, see PERMISSIONS). It contains no remote code, no
minified or generated code, no third-party libraries and no build step: the uploaded zip is the
source, identical to the addon/ folder of https://github.com/Multysquid/shisu-ko (tag v<version>).

This add-on id (shisu-ko@multysquid.github.io) already has unlisted, self-distributed versions
0.2.0 to 0.4.0 that were signed through the same account. This is the first listed version.

HOW TO TEST (about 10 minutes, no GPU or account needed)

The demo recording in the README shows the expected behaviour: https://github.com/Multysquid/shisu-ko

1. Get the server (Ubuntu 24.04, Python 3.10+, Node 20+ on PATH for yt-dlp):
     git clone https://github.com/Multysquid/shisu-ko && cd shisu-ko
     bash server/setup.sh          # creates ~/.shisu-ko/venv and installs faster-whisper, yt-dlp, numpy
                                   # (if it stops at "venv": sudo apt install python3-venv)
     server/run.sh --model small --device cpu
   The first start downloads the "small" Whisper model (about 500 MB) into ~/.shisu-ko/models.
   The server is ready when it prints "Listening on http://127.0.0.1:8790".
   (--model base or --model tiny are faster still; Japanese accuracy is lower but subtitles
   appear the same way. On CPU a 20-second window takes roughly 5-15 s with "small".)

2. Install the extension: about:debugging#/runtime/this-firefox > Load Temporary Add-on > the zip.

3. Click the toolbar icon. The popup shows "Server online" and a banner asking for access to
   youtube.com; click "Allow on YouTube" (host permissions are optional in Manifest V3, so the
   content script only runs after this grant).

4. Open any YouTube video with Japanese speech, for example one from
   https://www.youtube.com/@cijapanese. A badge in the top-left corner of the player goes from
   "Fetching audio..." through "Decoding audio..." to "Transcribing...", and the first subtitles
   appear after 10-30 s on CPU. Hovering a subtitle pauses the video and shows a pickaxe at its
   right edge; moving the pointer away resumes it. Alt+Shift+L opens the transcript panel;
   clicking a timestamp seeks the video.

5. Mining without Anki: open the popup, expand "Anki, clips and server", set "Send screenshot and
   audio to" to Downloads, then press Alt+Shift+M while a subtitle is shown. A toast confirms and
   two files (shisuko_<video>_<time>.jpg and .mp3) land in Downloads/shisu-ko-mining/.
   With Anki + AnkiConnect running instead, Alt+Shift+M attaches the two files to the newest
   note created today (Anki asks once whether to allow the extension). With Yomitan installed,
   creating a card from a hovered subtitle attaches them automatically.

6. Live streams: any live stream with DVR (for example one on
   https://www.youtube.com/@ANNnewsCH/streams). Subtitles trail the sound by a few seconds.

7. The switch in the popup header (Alt+Shift+S) turns everything off: no overlay, no requests to
   the server, no key handling, until it is switched on again.

8. Optional, the "Start server" button: stop the server (Ctrl+C in its terminal) and open the
   popup. The status line says "Server offline" and shows "Start server". Clicking it asks for
   the optional nativeMessaging permission ("Exchange messages with programs other than
   Firefox"); after "Allow", the extension asks the native-messaging host "shisuko" (registered
   by setup.sh in step 1, ~/.mozilla/native-messaging-hosts/shisuko.json) to run server/run.sh
   without any options, and the status line goes to "Starting server". The server therefore
   starts with server.py's defaults (--model large-v3, --device auto), not with the
   --model small --device cpu of step 1: on a machine without a GPU it first downloads large-v3
   (about 3 GB) into ~/.shisu-ko/models and then loads it on the CPU, which takes minutes,
   longer than the 90 s the popup waits. Expect the status line to fall back to "Server offline"
   with the hint "No answer from the server after 90 s: look at /home/<user>/.shisu-ko/server.log
   before starting it again; a first use downloads the model, which takes minutes" and the
   button to return. Clicking it again is harmless: the host sees the server's lock file and
   answers that it is already starting, so nothing is launched twice and the popup waits again.
   The status line reaches "Server online" once server.log prints "Listening on
   http://127.0.0.1:8790" (the server's output goes there when the button started it). The
   model can then be changed in the popup's "Transcription model" field, for example to "small",
   without restarting. Declining the permission only puts a hint on the status line.

9. Optional, the update check: expand "Anki, clips and server" in the popup and click "Check for
   updates". The line under it reads "Newest release: <release>, checked just now" (or why the
   check failed, offline). With a server older than that release the popup shows a banner
   "Shisu-ko <release> is available — the server runs <server's version>." with "Update" and
   "Not now", and the toolbar icon gets a badge. "Update" sends POST /update to the server;
   the server exits, run.sh runs the project's own update.py (git fast-forward) and starts it
   again, and the status line reads "Updating server" until the new version answers (up to
   two minutes, the model is loaded again). A server started without run.sh, or with
   --no-update, answers 409 and the banner says it cannot update itself. With a checkout at
   the newest release nothing but the result line shows.

PERMISSIONS

- storage: the settings (browser.storage.local).
- downloads: the Downloads fallback for mined screenshot/audio files (browser.downloads.download
  with a blob: URL created in the background script; the URL is revoked when the download ends).
- tabs: the popup calls browser.tabs.query({url: <youtube origins>}) to reload the open YouTube
  tabs after the host permission is granted (a query filtered by URL needs this permission); the
  background script routes the keyboard commands with tabs.query({active: true}) and
  tabs.sendMessage. Tab URLs are never stored; the only URL that leaves the browser is the
  address of the YouTube page being watched, sent to the local server in /sync (below).
- host permissions *://www.youtube.com/*, *://m.youtube.com/*, *://youtube.com/*: the content
  script that draws the subtitles.
- host permissions http://127.0.0.1/* and http://localhost/*: the companion server (port 8790)
  and AnkiConnect (port 8765). Both URLs are settings with these defaults.
- notifications: three notifications, all created in background.js (ids shisuko-update,
  shisuko-updated and shisuko-update-failed). "Shisu-ko <release> is available" / "The server
  runs <server's version>. Click to update it now." when a newer release of the server is out
  and the running server can update itself, at most once per release and browser session, and
  only from the check at browser start (runtime.onStartup / onInstalled); a check from the
  popup sets the badge and the banner and never notifies. "Shisu-ko updated to <version>" once
  the server answers with the new version after an update, whether the popup's Update button
  or the first notification asked for it. "Shisu-ko could not update the server" / the error,
  only when the request set off by a click on the first notification fails (refused, or the
  server offline), since no popup is open to say so. Clicking the first one runs the same
  update as the popup's Update button; a click on the other two, and dismissing any of them,
  does nothing. It is a required permission because the first notification comes from the
  check at browser start, where no popup is open to ask for a grant. A failed check never
  notifies.
- The update check itself needs no permission: background.js fetches
  https://api.github.com/repos/Multysquid/shisu-ko/releases/latest (GET, header Accept:
  application/vnd.github+json, no cookies, no token, no account, nothing about the user or
  the browser beyond what any HTTPS request carries), which GitHub answers with
  Access-Control-Allow-Origin: *. It runs when the browser starts, when the extension is
  installed or updated (runtime.onStartup / onInstalled) or when the popup opens, if the
  stored result is more than a day old or the last check failed (checkIsFresh(): a failure,
  offline or rate-limited, is tried again at the next of those occasions, one quick failure
  each), so at most once a day by itself while the checks succeed, and on every click
  of "Check for updates" in the popup; a profile that has never opened the popup makes no
  request at all. The answer (release version, tag, page URL, .xpi URL, time of the check) is
  kept in browser.storage.local under "updateCheck". The extension never downloads or installs
  the .xpi: it links to the release page until this listing is live, and the manifest has no
  update_url, so updates of the extension come from addons.mozilla.org.
- nativeMessaging (optional_permissions; requested with browser.permissions.request from the
  click on the popup's "Start server" button, which is shown only while the companion server
  does not answer): background.js sends the one message {cmd: "start"} to the native-messaging
  host "shisuko" with browser.runtime.sendNativeMessage. That host is server/native_host.py in
  the same repository (Python standard library only), registered for this extension id by the
  server's setup script, and it can do exactly one thing: start the companion server's own
  launcher (server/run.cmd or server/run.sh next to it). It takes no path, program or argument
  from the message, answers "unknown command" to anything else, and is never contacted by any
  other part of the extension. Without the grant the button only shows a hint.

CODE THAT MAY NEED A WORD

- content.js, liveClock(): reads YouTube's player API through player.wrappedJSObject
  (getVideoData().isLive and getProgressState().current). Only numbers/booleans are taken from
  the page and nothing is written to it. It is needed because on a live stream the <video>
  element's currentTime restarts at an arbitrary point on every page load, while the cues are
  on the stream's media clock.
- content.js, captureFrame(): draws the <video> element to a canvas and reads a JPEG for the
  mined screenshot. DRM-protected videos taint the canvas; the extension then attaches only the
  audio.
- background.js, apiRequest()/fetchClip(): the only requests to the server, POST /sync with
  {video_id, url, t, paused, since, model}, GET /clip?video_id&start&end&format (asked for
  the sentence being mined, and 400 ms after a line appears for that line and the next one, so
  the clip is ready when a card is created; see "Pre-mined sentences" in AGENTS.md), GET /health
  (the popup's status line, every 2 s while it is open; once at browser start and at install
  or update of the extension, from startupCheck(), for the badge and the start-up
  notification; and, after a click on the update notification, every 3 s for up to 120 s
  from watchUpdate(), with no popup open, to see the new version come up) and POST /update
  with an empty body
  (only from the popup's Update button or a click on the update notification; the server
  answers {ok, restarting, version} and exits so that its own launcher runs the project's
  update.py and starts it again, or 409 {ok: false, error} when it cannot); anki():
  AnkiConnect JSON
  requests (requestPermission, findNotes, storeMediaFile, updateNoteFields, and the fields of
  the one note being filled).
- background.js, startServer(): the only use of nativeMessaging (above). It remembers a
  launch in browser.storage.session (the host's answer and a deadline 90 s ahead) so a reopened
  popup does not start a second server while the first is still loading its model; the record
  is ignored past its deadline, cleared by a /health answer, replaced by the next launch, and
  gone with the browser session.
- background.js, checkForUpdate()/updateServer(): the update check (above) and the update
  request. Pure helpers compare versions (parseVersion, compareVersions, decideUpdate) and
  the badge (browser.action.setBadgeText "1") follows the comparison; the notification is
  created only by the check at browser start, and only when the server reports it was started
  by its launcher ("launcher" in /health). browser.storage.session holds three small records for the browser session:
  the version the notification was shown for, the version "Not now" was clicked for, and an
  update under way ({requestedAt, from, to, deadline, down}, ignored 120 s after the
  request), so a reopened popup follows the restart instead of asking for a second one;
  none of it is written to disk.
- The content script never uses innerHTML or similar: youtube.com enforces Trusted Types, so
  all DOM is built with createElement/textContent.

DATA COLLECTION DECLARATION

The manifest declares data_collection_permissions: none. The extension collects nothing and
transmits nothing about the user off the device: its peers besides youtube.com are two
programs on the same computer that the user installed for this purpose (the companion server
and Anki), and what they receive (the id and playback position of the video being watched; a
screenshot and an audio clip of the sentence being mined) is the add-on's stated primary
function. The one remote request, the anonymous release check against GitHub's public API
described under PERMISSIONS, carries no data about the user, the browser or the videos
watched. The privacy policy on the listing describes this in full.

CONTACT

Issues and questions: https://github.com/Multysquid/shisu-ko/issues

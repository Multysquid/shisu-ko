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
content script), the local server and the local AnkiConnect. It contains no remote code, no
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
   right edge; moving the pointer away resumes it. Alt+Shift+T opens the transcript panel;
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

PERMISSIONS

- storage: the settings (browser.storage.local).
- downloads: the Downloads fallback for mined screenshot/audio files (browser.downloads.download
  with a blob: URL created in the background script; the URL is revoked when the download ends).
- tabs: the popup calls browser.tabs.query({url: <youtube origins>}) to reload the open YouTube
  tabs after the host permission is granted (a query filtered by URL needs this permission); the
  background script routes the keyboard commands with tabs.query({active: true}) and
  tabs.sendMessage. Tab URLs are never stored or transmitted.
- host permissions *://www.youtube.com/*, *://m.youtube.com/*, *://youtube.com/*: the content
  script that draws the subtitles.
- host permissions http://127.0.0.1/* and http://localhost/*: the companion server (port 8790)
  and AnkiConnect (port 8765). Both URLs are settings with these defaults.

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
  {video_id, t, since, model} and GET /clip?video_id&start&end&format; anki(): AnkiConnect JSON
  requests (requestPermission, findNotes, storeMediaFile, updateNoteFields, and the fields of
  the one note being filled).
- The content script never uses innerHTML or similar: youtube.com enforces Trusted Types, so
  all DOM is built with createElement/textContent.

DATA COLLECTION DECLARATION

The manifest declares data_collection_permissions: none. The extension collects nothing and
transmits nothing off the device: its only peers besides youtube.com are two programs on the
same computer that the user installed for this purpose (the companion server and Anki), and
what they receive (the id and playback position of the video being watched; a screenshot and an
audio clip of the sentence being mined) is the add-on's stated primary function. The privacy
policy on the listing describes this in full.

CONTACT

Issues and questions: https://github.com/Multysquid/shisu-ko/issues

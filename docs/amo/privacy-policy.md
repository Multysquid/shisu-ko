**Shisu-ko privacy policy**

Shisu-ko is a Firefox extension that shows live Japanese subtitles on YouTube. It works together with a companion server that you install and run on your own computer. The developer operates no servers, has no accounts and receives no data from you. This policy lists everything the extension exchanges with other programs and what those programs do with it.

**What the extension sends, and to whom**

To the Shisu-ko server on your computer (http://127.0.0.1:8790 by default; the address is a setting): the id and page address of the YouTube video you are watching, your current playback position and whether the video is paused, the time of the last subtitle you received, and the name of the transcription model you chose in the popup (empty for the server's default), about once per second while a video is playing and the extension is switched on. It also requests an audio clip for a start and end time of that video: for the sentence you mine, and, so that a card can be filled at once, for each sentence shortly after it appears on screen and for the one after it. Those clips stay in the extension's memory (at most ten) and are discarded when the tab closes or the extension restarts. Nothing else is sent, and nothing is sent while the master switch in the popup is off.

To Anki on your computer, through the AnkiConnect add-on (http://127.0.0.1:8765 by default; the address is a setting), only if you mine sentences and keep the default "Anki" target: a screenshot of the current video frame, an MP3 or WAV clip of the sentence, and the subtitle text, written into the fields of the note you just created. To find that note the extension asks Anki for the ids of notes added today. If you choose the "Downloads" target instead, the screenshot and clip are saved into the Downloads/shisu-ko-mining folder of your computer and nothing is sent to Anki.

To a helper program on your computer, only when you click the Start server button in the popup, and only after Firefox has asked you for permission to exchange messages with it: a request to start the companion server. The helper is part of the same project, installed by the server's setup; it receives nothing else from the extension and starts nothing but that server. The extension remembers such a request for the browser session, so that reopening the popup does not start a second server: the record (the helper's answer and a time) is ignored after 90 seconds, cleared once the server answers or the next request replaces it, and gone when the browser session ends; it is never written to disk.

To GitHub (https://api.github.com), where the project is published: a request for the newest release of Shisu-ko, so that the extension can tell you when the server you are running is out of date and, if you ask, have the server update itself. The request is made when Firefox starts, when the extension is installed or updated, or when the popup opens, if the last check is more than a day old or did not succeed (while you are offline, each of those occasions tries once more), and whenever you click "Check for updates" in the popup; it is anonymous and contains nothing about you, your browser or the videos you watch. GitHub sees it like any visit to a web page (your IP address and the browser's user agent), and GitHub's own privacy statement applies to that. The answer (the release's version and tag, its page address, the download address of the extension package on that page and the time of the check) is stored in the extension's storage on your computer. The extension never downloads or installs anything from that answer; the update button only asks the server on your computer to update itself, which it does through its own launcher.

To youtube.com: nothing beyond what the page itself does. The extension reads the player's playback state on the page in order to place the subtitles; it does not modify your YouTube account, comments or history.

Apart from that release check, the extension never contacts the developer or any other remote service; it loads no remote code and contains no analytics, telemetry or advertising.

**What the companion server does on the network**

The server is a separate program from the same project, under your control. When the extension reports a video, the server downloads that video's audio track from YouTube with yt-dlp and transcribes it locally with Whisper. On its first start, and when you pick a model in the popup that is not on your computer yet, it downloads that speech-recognition model from Hugging Face. It stores the audio, the transcription cache and the model under ~/.shisu-ko on your computer. If you start it with --cookies-from-browser or --cookies, it reads your browser's YouTube cookies to fetch age-restricted or members-only videos; it does not do so otherwise. The server accepts requests only from this extension and from pages served on your own computer.

**What the extension stores**

Your settings (subtitle style and font, transcription model, shortcuts behaviour, server and Anki addresses, Anki field names) and the result of the last release check (the newest version and tag, its page address, the download address of the extension package, when it was checked, or why the check failed) are stored in Firefox's extension storage on your computer and nowhere else. Uninstalling the extension removes them. For the browser session only, the extension also remembers which release it has notified you about, which one you clicked "Not now" for, and an update of the server that is under way. The extension keeps no history of the videos you watched.

**Children, sale and sharing of data**

The extension collects no personal data, so there is nothing to sell, share or profile. It is not directed at children.

**Changes and contact**

Changes to this policy are published with the extension's release notes and on the project page, https://github.com/Multysquid/shisu-ko. Questions: https://github.com/Multysquid/shisu-ko/issues.

Last updated: 20 September 2026.

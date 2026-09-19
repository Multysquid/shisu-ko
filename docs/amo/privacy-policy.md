**Shisu-ko privacy policy**

Shisu-ko is a Firefox extension that shows live Japanese subtitles on YouTube. It works together with a companion server that you install and run on your own computer. The developer operates no servers, has no accounts and receives no data from you. This policy lists everything the extension exchanges with other programs and what those programs do with it.

**What the extension sends, and to whom**

To the Shisu-ko server on your computer (http://127.0.0.1:8790 by default; the address is a setting): the id of the YouTube video you are watching, your current playback position, and the time of the last subtitle you received, about once per second while a video is playing and the extension is switched on. When you mine a sentence it also requests an audio clip for a start and end time of that video. Nothing else is sent, and nothing is sent while the master switch in the popup is off.

To Anki on your computer, through the AnkiConnect add-on (http://127.0.0.1:8765 by default; the address is a setting), only if you mine sentences and keep the default "Anki" target: a screenshot of the current video frame, an MP3 or WAV clip of the sentence, and the subtitle text, written into the fields of the note you just created. To find that note the extension asks Anki for the ids of notes added today. If you choose the "Downloads" target instead, the screenshot and clip are saved into the Downloads/shisu-ko-mining folder of your computer and nothing is sent to Anki.

To youtube.com: nothing beyond what the page itself does. The extension reads the player's playback state on the page in order to place the subtitles; it does not modify your YouTube account, comments or history.

The extension never contacts the developer or any other remote service, loads no remote code, and contains no analytics, telemetry or advertising.

**What the companion server does on the network**

The server is a separate program from the same project, under your control. When the extension reports a video, the server downloads that video's audio track from YouTube with yt-dlp and transcribes it locally with Whisper. On its first start it downloads the speech-recognition model from Hugging Face. It stores the audio, the transcription cache and the model under ~/.shisu-ko on your computer. If you start it with --cookies-from-browser or --cookies, it reads your browser's YouTube cookies to fetch age-restricted or members-only videos; it does not do so otherwise. The server accepts requests only from this extension and from pages served on your own computer.

**What the extension stores**

Your settings (subtitle style, shortcuts behaviour, server and Anki addresses, Anki field names) are stored in Firefox's extension storage on your computer and nowhere else. Uninstalling the extension removes them. The extension keeps no history of the videos you watched.

**Children, sale and sharing of data**

The extension collects no personal data, so there is nothing to sell, share or profile. It is not directed at children.

**Changes and contact**

Changes to this policy are published with the extension's release notes and on the project page, https://github.com/Multysquid/shisu-ko. Questions: https://github.com/Multysquid/shisu-ko/issues.

Last updated: 19 September 2026.

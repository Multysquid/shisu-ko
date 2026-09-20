Shisu-ko shows live Japanese subtitles on YouTube in Firefox. A small server on your own computer transcribes the video's audio with OpenAI's Whisper a little ahead of where you are watching, and the extension draws the result over the player as ordinary page text. Nothing about you is sent to anyone: the server runs on your machine, and the only network traffic is the video's audio from YouTube, the one-time model download and a look at GitHub for a newer release, by the server's launcher before each start and by the extension once a day (see Privacy below).

**What you get**

- **Subtitles a few seconds after a video opens.** The server keeps transcribing ahead of the playhead and caches every line, so seeking back or rewatching is instant. Live streams work too.
- **Text a dictionary can read.** Subtitles are real page text, so [Yomitan](https://yomitan.wiki/) or any popup dictionary scans them. Hovering a line pauses the video, the dictionary popup keeps it paused, and moving back over the video resumes it.
- **A transcript panel** with every line so far. A timestamp jumps there, a pickaxe mines it.
- **Sentence mining without pressing anything.** The moment Yomitan adds a card, Shisu-ko attaches a screenshot of the frame you were reading and an MP3 clip of the whole sentence, through AnkiConnect. The pickaxe on a line, or Alt+Shift+M, does the same on demand, into the newest card or into your Downloads folder.
- **Your hardware, your model.** Whisper large-v3 by default on an NVIDIA GPU; the popup switches to the Japanese-specialised kotoba-whisper (about 6x faster), to a small model on the CPU or to any other faster-whisper model, without restarting the server.
- **Your fonts.** The subtitle font is a preset (gothic, rounded, mincho) or any font installed on your computer, with position, colour, box and outline adjustable.
- **A Start button for the server.** When the server is not running, the popup starts it for you; Firefox asks once for permission to talk to the small launcher that the server's setup registers.
- **Updates without leaving the browser.** The popup tells you when a newer release is out, and one click makes the server update itself and restart; the extension itself is updated by Firefox from this listing.

**You need the companion server**

The extension does nothing on its own. Download the server from the project page, start it, and the extension finds it at http://127.0.0.1:8790:

- Windows: run `server\setup.cmd` once, then `server\run.cmd`.
- Linux and macOS: `bash server/setup.sh` once, then `server/run.sh`.
- Also available as a Nix flake and as a Docker image with GPU support.

Requirements: Python 3.10 or newer, Node.js 20+ or Deno (yt-dlp needs a JavaScript runtime for YouTube), and an NVIDIA GPU with about 4 GB of free VRAM for large-v3; without a GPU, use a small model on the CPU. Optional: Yomitan for lookups, Anki with the AnkiConnect add-on for mining.

**Shortcuts**

- Alt+Shift+S turns Shisu-ko on or off (the switch in the popup header).
- Alt+Shift+L toggles the transcript panel.
- Alt+Shift+M mines the current sentence.
- Left and Right jump to the previous or next subtitle (can be turned off).

**Privacy**

The extension talks to the server on your own computer and, if you use mining, to Anki on your own computer. Its one remote request is an anonymous look at GitHub for the newest release, once a day (a check that failed, offline for instance, is tried again the next time the popup opens) and when you click Check for updates. It has no account, no analytics and no remote code. The privacy policy on this page lists exactly what is exchanged with those programs.

Shisu-ko is free software under the MIT license. Source code, setup guide, server options and troubleshooting: https://github.com/Multysquid/shisu-ko

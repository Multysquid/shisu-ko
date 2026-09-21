First version on addons.mozilla.org. Earlier versions were self-distributed through GitHub releases.

Since 0.3:

- **Word colours.** Two options in the popup, both off by default. "Colour words by their Anki card" colours every word of a subtitle, and of the transcript, that has a card in your deck by the card's state: green learned, yellow learning, orange suspended, red new; a verb or adjective is found in its conjugations. "Overbar by pitch accent" draws a bar over each such word in the colour of its pitch accent pattern (blue heiban, red atamadaka, orange nakadaka, green odaka), read from the card's pitch accent field as Yomitan writes it. The deck is the one your last mined card went to, or the one you choose; it is read again every half minute while a video is open, and the text stays scannable by Yomitan. Needs Anki with AnkiConnect, like mining.
- Setup asks which Whisper model to use, large-v3 or small, and downloads it with a progress bar; the server starts on that model unless told otherwise.
- Live streams get the same subtitles, transcript and mining as videos; the cues follow the stream's own clock, so they stay aligned after seeking and whatever your playback latency is.
- The switch in the popup header (Alt+Shift+S) is a master switch: off means nothing happens on YouTube pages until it is switched on again.
- A new card is matched to its subtitle by sentence and word (the note's word field, or the one named in the popup), and the screenshot and audio of every sentence are prepared while it plays, so the card is filled the moment it appears.
- The transcript panel shortcut is Alt+Shift+L (Chrome reserves Alt+Shift+T for its toolbar).
- The same source also runs in Chrome; the Chrome package is attached to the GitHub release.
- The Whisper model is picked in the popup: any faster-whisper size or Hugging Face repo id, downloaded on first use and swapped in while the video plays, without restarting the server.
- A subtitle font can be any font installed on the computer; the popup previews it and says whether the name was found.
- Mined files are saved through object URLs, which fixes the Downloads fallback in current Firefox versions.
- The manifest links to the project page.
- 0.9.0: **updates from the popup.** The extension looks at GitHub for the newest release (once a day, again at the next opening after a failed check, or on "Check for updates" in the popup) and, when the server you are running is older, shows a toolbar badge, one notification per browser session and a banner with an **Update** button: the server exits, its launcher installs the update and starts it again, and the popup follows the restart. A server not started by run.cmd / run.sh (Docker, Nix, by hand) is told to restart by hand instead. The extension itself is updated by Firefox from this listing; the new **notifications** permission ("Display notifications to you") is for those notifications, and Firefox asks you to approve it before it installs this update over an older version.
- 0.8.0: a **Start server** button in the popup. While the server is offline, one click starts it, with the server's default options, through a small launcher that the server's setup registers with Firefox (every start of the server registers it too, from the first start after the update to 0.8.0); Firefox asks once for permission to exchange messages with it.

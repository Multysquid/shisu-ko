First version on addons.mozilla.org. Earlier versions were self-distributed through GitHub releases.

Since 0.3:

- Live streams get the same subtitles, transcript and mining as videos; the cues follow the stream's own clock, so they stay aligned after seeking and whatever your playback latency is.
- The switch in the popup header (Alt+Shift+S) is a master switch: off means nothing happens on YouTube pages until it is switched on again.
- Mined files are saved through object URLs, which fixes the Downloads fallback in current Firefox versions.
- The manifest links to the project page.

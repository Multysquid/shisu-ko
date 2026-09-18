"use strict";

/*
 * Shared settings schema for Shisu-ko. This file is loaded before background.js, content.js and
 * popup.js (see manifest.json and popup.html), so all three see the same defaults.
 * To add a setting: add it here and add an input with the same id to popup.html.
 */

const SHISUKO_DEFAULT_SETTINGS = Object.freeze({
  // subtitles
  enabled: true,
  serverUrl: "http://127.0.0.1:8790",
  fontScale: 1.0,
  pauseOnHover: true,
  lingerSeconds: 3,
  showTranscript: false,
  hideNativeCaptions: false,
  showStatus: true,
  // sentence mining
  mineTarget: "anki", // "anki" (newest card via AnkiConnect) or "download"
  mineFallbackDownload: true,
  ankiUrl: "http://127.0.0.1:8765",
  ankiImageField: "Picture",
  ankiAudioField: "SentenceAudio",
  ankiSentenceField: "",
  clipPaddingMs: 200,
  clipFormat: "mp3",
});

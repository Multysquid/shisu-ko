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
  lingerSeconds: 0.3,
  showTranscript: false,
  hideNativeCaptions: false,
  showStatus: true,
  // Left/Right jump to the previous/next subtitle instead of YouTube's 5 s seek.
  arrowKeysJumpCues: true,
  // subtitle style and position. The defaults reproduce the look before these settings existed.
  subPosition: 11, // % of the player height between the bottom edge and the subtitle box
  subFont: "default", // "default" | "rounded" | "mincho" | "gothic-bold"
  subTextColor: "#ffffff",
  subBackgroundOpacity: 72, // % alpha of the black box behind the text
  subOutline: false, // draw a black outline instead of relying on the box
  transcriptSide: "right", // "right" | "left"
  // sentence mining
  mineTarget: "anki", // "anki" (newest card via AnkiConnect) or "download"
  // Attach screenshot + audio automatically when a new Anki note appears while a video is open.
  autoMine: true,
  mineFallbackDownload: true,
  ankiUrl: "http://127.0.0.1:8765",
  ankiImageField: "Picture",
  ankiAudioField: "SentenceAudio",
  ankiSentenceField: "",
  // Word/expression field, used to match a new card to its subtitle; empty means the note's
  // first field.
  ankiWordField: "",
  clipPaddingMs: 200,
  clipFormat: "mp3",
});

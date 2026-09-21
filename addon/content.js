"use strict";

/*
 * Shisu-ko content script for youtube.com.
 *
 * Responsibilities:
 *  - find the player and <video>, follow YouTube's single-page navigation
 *  - every second, tell the local Whisper server which video and playhead we are at
 *    and collect the timestamped cues it has produced so far
 *  - render the active cue as ordinary DOM text over the player so dictionary
 *    extensions such as Yomitan can scan it; pause the video while the text is hovered
 *  - optional transcript panel listing every cue (also plain text)
 *  - sentence mining: grab the current video frame and ask the background script to
 *    fetch the matching audio clip and file both into Anki or the Downloads folder, either on
 *    demand or by itself as soon as Yomitan has added a card
 */

(() => {
  if (window.__shisukoLoaded) return;
  window.__shisukoLoaded = true;
  // A reloaded or updated extension leaves this instance orphaned with a dead runtime; it must
  // tear itself down so the fresh instance can take over the player (see runtimeAlive()).
  const timers = [];

  const DEFAULT_SETTINGS = SHISUKO_DEFAULT_SETTINGS; // from settings.js

  const SYNC_INTERVAL_MS = 1000;
  const RENDER_INTERVAL_MS = 100;
  const DISCOVER_INTERVAL_MS = 750;
  // Heartbeat while a paused video needs nothing: slow enough to be free, far below the server's
  // 30 s client timeout (it stops transcribing for a session nobody has synced since then).
  const SYNC_IDLE_INTERVAL_MS = 5000;
  // The server's own --lookahead default: it transcribes no further ahead than this, so once the
  // covered range reaches it there is nothing left to ask for until the playhead moves.
  const SYNC_LOOKAHEAD_S = 900;
  // A video paused this long with nobody reading the subtitle is not being mined from.
  const PAUSE_POLL_IDLE_MS = 120000;
  const RESUME_DELAY_MS = 350;
  const TOAST_MS = 3500;
  const TOAST_MAX_CHARS = 240;
  // The status line is one line over the video; a server error can carry a traceback or a URL.
  const STATUS_ERROR_MAX_CHARS = 160;
  const STATUS_NAME_MAX_CHARS = 100;
  const MINE_RECENT_WINDOW_S = 6;
  const HOVER_CAPTURE_DELAY_MS = 400;
  // Long enough that skimming through a video prepares nothing, short enough that a sentence the
  // viewer actually reads is ready before the lookup. Reading a frame back stalls the main thread,
  // so it must not happen on the tick that puts the line on screen.
  const PREMINE_CAPTURE_DELAY_MS = 400;
  const ANKI_POLL_LOG_MS = 60000;
  // The deck index behind the word colours is asked for this often (the background keeps it as
  // long, so most asks come back "unchanged"); a failing ask is logged this often.
  const WORD_INDEX_REFRESH_MS = 30000;
  const WORD_INDEX_LOG_MS = 60000;
  // A card just mined must show its colour now, not after the interval. The background expires
  // its index once Anki has told it the card's deck, two answers after the mine, so the next ask
  // waits this long for that: an ask in between would be answered with the old index.
  const WORD_INDEX_MINE_DELAY_MS = 1500;
  // The settings the deck index depends on: a change to any of them starts it over.
  const WORD_SETTINGS = ["cardStatus", "pitchAccent", "cardStatusDeck", "ankiPitchField", "ankiWordField"];
  // A refreshed index that differs from the last in more words than this is walked line by line
  // like a new one: matching a line again costs about as much as looking for that many words in it.
  const WORD_INDEX_PROBE_MAX = 64;
  const HOVER_POLL_INTERVAL_MS = 300;
  const SENTENCE_MAX_GAP_S = 1.5; // cues of one segment further apart than this are not one sentence // a card is most likely to appear while a subtitle is hovered
  // A blank shorter than this reads as a flicker rather than a pause, so the text is held instead.
  const MIN_BLANK_S = 0.3;
  // Left this far into a line replays it instead of stepping back to the one before.
  const CUE_REPLAY_S = 1.0;
  const CUE_LEAD_IN_S = 0.15;
  // Elements whose own arrow key handling wins: text entry, YouTube's search box, the comments.
  const KEY_SKIP_SELECTOR = "input, textarea, select, [contenteditable], #search, ytd-comments";

  // ---- subtitle style ----
  const GOTHIC_STACK = '"Noto Sans JP", "Noto Sans CJK JP", "Yu Gothic UI", "Yu Gothic", "Meiryo", "Hiragino Sans", sans-serif';
  const SUB_FONTS = {
    default: GOTHIC_STACK,
    "gothic-bold": GOTHIC_STACK,
    rounded: '"M PLUS Rounded 1c", "Hiragino Maru Gothic ProN", "Hiragino Maru Gothic Pro", "Yu Gothic UI", "Yu Gothic", sans-serif',
    mincho: '"Noto Serif JP", "Noto Serif CJK JP", "Hiragino Mincho ProN", "Hiragino Mincho Pro", "Yu Mincho", "YuMincho", serif',
  };
  // A font family name as CSS may see it: letters and digits (Japanese names such as 游ゴシック
  // included), spaces, dots, hyphens and underscores. Anything else (quotes, semicolons, braces,
  // backslashes, url(...)) never reaches the stylesheet. popup.js keeps a copy for its preview.
  const FONT_FAMILY_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.\-]{0,99}$/u;
  const TRANSCRIPT_SIDES = ["right", "left"];
  const SUB_POSITION_MIN = 2;
  const SUB_POSITION_MAX = 40;
  // How far the box drops once YouTube's controls fade out: 11% - 4% at the default position.
  const AUTOHIDE_DROP = 7;
  const HOVER_ALPHA_STEP = 0.18; // 0.72 -> 0.90, the hover shade the overlay always had
  const PLAIN_SHADOW = "0 0 3px rgba(0, 0, 0, 0.9)";
  // Four 1px offsets carve the letter out of the video; the blur softens the corners they leave.
  const OUTLINE_SHADOW = "1px 1px 0 #000, -1px 1px 0 #000, 1px -1px 0 #000, -1px -1px 0 #000, 0 0 2px #000";

  const state = {
    settings: Object.assign({}, DEFAULT_SETTINGS),
    videoId: null,
    video: null,
    player: null,
    root: null,
    statusEl: null,
    toastEl: null,
    toastTimer: null,
    subWrap: null,
    subBox: null,
    subText: null,
    mineBtn: null,
    transcriptEl: null,
    transcriptList: null,
    cues: [],
    cueById: new Map(), // id -> cue, so no hot path scans the cue array
    since: 0,
    covered: [],
    duration: 0,
    serverStatus: "idle",
    serverError: null,
    offline: false,
    serverSession: null,
    modelLoading: null, // name of the model the server is loading right now; cues wait for it
    modelError: null, // why the model this client asked for cannot be used
    activeCueId: null,
    activeLineEl: null,
    transcriptDirty: true,
    transcriptAppendFrom: null, // index of the first unrendered cue when only appends are pending
    lineById: new Map(), // cue id -> transcript line element, maintained on append and rebuild
    // Transcript line -> its text span, and any element -> what renderText() last drew in it (see
    // drawKey): a refresh leaves a line alone when it would look the same, so a card reviewed in
    // Anki does not replace the nodes of every other line (nor what Yomitan holds on them).
    lineTexts: new WeakMap(),
    drawnKeys: new WeakMap(),
    // Cue -> the runs of its text under the index and colours they were found with (lookOf), and
    // the text's word boundaries, which no index changes: a panel rebuilt for a style change, and
    // a line a refresh finds untouched, cost no segmentation and no matching.
    cueLooks: new WeakMap(),
    transcriptHovered: false,
    hoverPaused: false,
    awaitingPlayerMove: false,
    resumeTimer: null,
    lastPointer: { x: 0, y: 0 },
    syncInFlight: false,
    mining: false,
    // What the background holds ready for this tab, newest sentence first: [{ key, cueIds, image,
    // audio }]. Replaced by every premine reply; the payloads themselves never come back here.
    premined: [],
    premineTimer: null,
    hoverCaptureTimer: null,
    ankiPollInFlight: false,
    lastAnkiPollLog: 0,
    // The deck's words as SHISUKO_WORDS.buildIndex() holds them, for the word colours: `at` is the
    // background's timestamp of the entries it was built from (the `since` of the next ask), `key`
    // a fingerprint of those entries, so an index refetched unchanged does not redraw the transcript.
    wordIndex: null,
    // Moves on with every index put in wordIndex (a new one or none): a cue's look is dated by
    // this number, not by the index it was found under, so a cue drawn while the transcript was
    // hidden (whose look no refresh visits) does not keep every index since in memory.
    wordIndexSerial: 0,
    wordIndexAt: 0,
    wordIndexKey: "",
    wordIndexAskedAt: 0,
    wordIndexInFlight: false,
    // Counts the times the index was started over: an ask from before a deck or field change
    // is answered for the old deck, and that answer is thrown away.
    wordIndexGeneration: 0,
    // The index the text on screen was last refreshed with (refreshWordMarks), and its serial:
    // the next refresh only looks at the lines holding a word the two indexes disagree on.
    wordIndexDrawn: null,
    wordIndexDrawnSerial: 0,
    lastWordIndexLog: 0,
    resizeObserver: null,
    videoListeners: null,
    lastSeekSync: 0,
    lastSyncAt: 0,
    pausedSince: 0, // when the video was last paused, 0 while it plays
    lastHref: null,
    rediscover: true, // re-query the player and video on the next discover() tick
    // A live stream's cues sit on the stream's media clock, which the player exposes as
    // getProgressState().current; video.currentTime restarts from an arbitrary point on every load.
    live: false,
    liveOffset: 0, // media clock minus video.currentTime, refreshed on every sync
  };

  // ------------------------------------------------------------ helpers

  function runtimeAlive() {
    try {
      return !!(browser.runtime && browser.runtime.id);
    } catch (err) {
      return false;
    }
  }

  function shutdown() {
    for (const t of timers) clearInterval(t);
    timers.length = 0;
    detach();
    clearHoverCapture();
    clearPremineTimer();
    clearResumeTimer();
    // An orphaned instance must stop swallowing arrow keys; the fresh one owns them now.
    window.removeEventListener("keydown", onKeyDown, true);
    if (state.root) state.root.remove();
    state.root = null;
    document.documentElement.classList.remove("shisuko-hide-native");
    try {
      delete window.__shisukoLoaded;
    } catch (err) {
      window.__shisukoLoaded = false;
    }
  }

  function sendMessage(msg) {
    try {
      return browser.runtime.sendMessage(msg).catch((err) => ({ ok: false, error: String(err) }));
    } catch (err) {
      return Promise.resolve({ ok: false, error: String(err) });
    }
  }

  function getVideoIdFromUrl(href) {
    try {
      const url = new URL(href);
      const v = url.searchParams.get("v");
      if (v && /^[A-Za-z0-9_-]{6,}$/.test(v)) return v;
      const m = url.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{6,})/);
      if (m) return m[1];
    } catch (err) {
      /* ignore malformed URLs */
    }
    return null;
  }

  // Text cut to `max` characters, the last one an ellipsis when something was cut. Pure.
  function truncate(text, max) {
    const s = String(text);
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }

  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const mm = String(m).padStart(2, "0");
    const ss = String(sec).padStart(2, "0");
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
  }

  function isAdPlaying() {
    const p = state.player;
    return !!(p && (p.classList.contains("ad-showing") || p.classList.contains("ad-interrupting")));
  }

  function isYouTubeElement(el) {
    // True for the player itself and for anything that belongs to YouTube's player DOM (or our
    // overlay). Walks up only as far as the player, so a dictionary popup that Yomitan appends
    // inside the fullscreen player element is not mistaken for part of the player.
    const player = state.player;
    if (!el || !player) return false;
    if (el === player) return true;
    let node = el;
    while (node && node !== player) {
      if (node.nodeType === 1) {
        if (node.tagName === "VIDEO") return true;
        const cls = typeof node.className === "string" ? node.className : "";
        if (/(^|\s)(ytp-|html5-|shisuko-)/.test(cls)) return true;
      }
      node = node.parentNode;
    }
    return false;
  }

  function cueById(id) {
    if (id === null || id === undefined) return null;
    return state.cueById.get(Number(id)) || null;
  }

  // ------------------------------------------------------------ playhead clock

  // The stream clock of a live player, or null for an ordinary video. Firefox lets a content
  // script call the page's player API through wrappedJSObject; only numbers are taken from it.
  function liveClock(player) {
    try {
      const api = player && player.wrappedJSObject;
      if (!api || typeof api.getVideoData !== "function" || typeof api.getProgressState !== "function") return null;
      const data = api.getVideoData();
      if (!data || !data.isLive) return null;
      const current = Number(api.getProgressState().current);
      return Number.isFinite(current) ? current : null;
    } catch (err) {
      return null;
    }
  }

  function updateLiveClock() {
    const current = state.video ? liveClock(state.player) : null;
    state.live = current !== null;
    state.liveOffset = state.live ? current - (Number(state.video.currentTime) || 0) : 0;
  }

  // Where the viewer is, on the clock the cues use. Pure given state.
  function playhead() {
    const t = state.video ? Number(state.video.currentTime) || 0 : 0;
    return state.live ? t + state.liveOffset : t;
  }

  function seekPlayhead(t) {
    state.video.currentTime = Math.max(0, t - (state.live ? state.liveOffset : 0));
  }

  // ------------------------------------------------------------ settings

  async function loadSettings() {
    const result = await sendMessage({ type: "getSettings" });
    if (result && typeof result === "object" && result.ok !== false) {
      state.settings = Object.assign({}, DEFAULT_SETTINGS, result);
    }
    applySettings();
  }

  function saveSettings(patch) {
    return sendMessage({ type: "saveSettings", settings: patch });
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings) return;
    const next = Object.assign({}, DEFAULT_SETTINGS, changes.settings.newValue || {});
    // A verdict belongs to the name it was given for. Keeping it under a corrected name would show
    // "model large-v3: not a model name" until the next round trip, up to five seconds while paused,
    // so the old verdict goes now and the server is asked about the new name at once.
    const modelChanged = modelForSync(next) !== modelForSync(state.settings);
    if (modelChanged) {
      state.modelError = null;
      state.modelLoading = null;
    }
    // The index belongs to a deck and the fields a word and its pitch are read from; with any of
    // them changed, or a colour switched, the lines go back to plain text now and the new deck is
    // asked for at once (never while off, and never from a tab without a video).
    const wordsChanged = WORD_SETTINGS.some((key) => next[key] !== state.settings[key]);
    if (wordsChanged) dropWordIndex();
    // The transcript's lines are built again only for a setting that decides what is in them; a
    // style setting (a slider being dragged in the popup writes several times a second) leaves
    // thousands of lines as they are, and refreshWordMarks() takes the colours off a dropped
    // index's lines without a rebuild either.
    const panelChanged = next.showTranscript !== state.settings.showTranscript || next.enabled !== state.settings.enabled;
    state.settings = next;
    applySettings({ rebuild: panelChanged });
    if (modelChanged) sync();
    if (wordsChanged) {
      refreshWordMarks();
      if (wordColoursOn()) pollWordIndex();
    }
  });

  // Settings come from storage, so every value is treated as untrusted input before it reaches CSS.
  function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function oneOf(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
  }

  function hexColor(value, fallback) {
    return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  }

  function fontFamilyName(value) {
    const name = typeof value === "string" ? value.trim() : "";
    return FONT_FAMILY_RE.test(name) ? name : "";
  }

  // The font-family value for the subtitle and the transcript: the preset's stack, with the
  // viewer's own installed font in front of it when the name is clean. The preset still decides
  // the weight. Pure: the two settings in, a CSS value out.
  function fontStack(subFont, subFontFamily) {
    const preset = SUB_FONTS[oneOf(subFont, Object.keys(SUB_FONTS), DEFAULT_SETTINGS.subFont)];
    const family = fontFamilyName(subFontFamily);
    return family ? `"${family}", ${preset}` : preset;
  }

  // The model name the server is asked for: the setting, trimmed; anything that is not a string
  // is the server's default. Pure. The server validates the name itself; this only cleans it.
  function modelForSync(settings) {
    const model = settings && settings.model;
    return typeof model === "string" ? model.trim() : "";
  }

  // Turn the style settings into custom properties that content.css reads. Setting them on
  // the root keeps the stylesheet the single place that decides where each value lands.
  function applyStyleSettings(root, s) {
    const bottom = clampNumber(s.subPosition, SUB_POSITION_MIN, SUB_POSITION_MAX, DEFAULT_SETTINGS.subPosition);
    const font = oneOf(s.subFont, Object.keys(SUB_FONTS), DEFAULT_SETTINGS.subFont);
    const alpha = clampNumber(s.subBackgroundOpacity, 0, 100, DEFAULT_SETTINGS.subBackgroundOpacity) / 100;
    const style = root.style;
    style.setProperty("--shisuko-sub-bottom", `${bottom}%`);
    // The controls have faded out, so the box drops by the same amount it does at the default.
    style.setProperty("--shisuko-sub-bottom-autohide", `${Math.max(SUB_POSITION_MIN, bottom - AUTOHIDE_DROP)}%`);
    style.setProperty("--shisuko-sub-font", fontStack(font, s.subFontFamily));
    style.setProperty("--shisuko-sub-weight", font === "gothic-bold" ? "700" : "400");
    style.setProperty("--shisuko-sub-color", hexColor(s.subTextColor, DEFAULT_SETTINGS.subTextColor));
    style.setProperty("--shisuko-sub-bg", `rgba(0, 0, 0, ${alpha})`);
    style.setProperty("--shisuko-sub-bg-hover", `rgba(0, 0, 0, ${Math.min(1, alpha + HOVER_ALPHA_STEP)})`);
    style.setProperty("--shisuko-sub-shadow", s.subOutline ? OUTLINE_SHADOW : PLAIN_SHADOW);
    root.classList.toggle("shisuko-transcript-left", oneOf(s.transcriptSide, TRANSCRIPT_SIDES, DEFAULT_SETTINGS.transcriptSide) === "left");
  }

  // `rebuild`: build the transcript's lines again (the overlay is new, or the settings that decide
  // what a line holds changed); without it a shown panel only takes on what is pending.
  function applySettings({ rebuild = true } = {}) {
    const s = state.settings;
    document.documentElement.classList.toggle("shisuko-hide-native", !!s.enabled && !!s.hideNativeCaptions);
    if (state.root) {
      state.root.classList.toggle("shisuko-hidden", !s.enabled);
      state.root.classList.toggle("shisuko-has-transcript", !!s.showTranscript);
      state.transcriptEl.classList.toggle("shisuko-hidden", !s.showTranscript);
      applyStyleSettings(state.root, s);
      if (s.showTranscript) {
        if (rebuild) {
          state.transcriptDirty = true;
          state.transcriptAppendFrom = null;
        }
        renderTranscript();
      }
    }
    if (!s.enabled) setSubtitle(null);
    updateFontSize();
    updateStatus();
  }

  // ------------------------------------------------------------ overlay DOM

  function buildOverlay(player) {
    const root = document.createElement("div");
    root.className = "shisuko-root";

    const statusEl = document.createElement("div");
    statusEl.className = "shisuko-status shisuko-hidden";
    root.appendChild(statusEl);

    const toastEl = document.createElement("div");
    toastEl.className = "shisuko-toast shisuko-hidden";
    root.appendChild(toastEl);

    const subWrap = document.createElement("div");
    subWrap.className = "shisuko-subwrap";
    const subBox = document.createElement("div");
    subBox.className = "shisuko-sub shisuko-hidden";
    subBox.setAttribute("lang", "ja");
    // Yomitan's sentence scan (without "layout-aware scan") walks straight across element
    // boundaries and would prepend YouTube's time display to the sentence. Invisible full stops
    // on both sides of the text end the scan at the box edge.
    const subText = document.createElement("span");
    subText.className = "shisuko-subtext";
    subBox.appendChild(makeSentinel("\u3002\n"));
    subBox.appendChild(subText);
    subBox.appendChild(makeSentinel("\n\u3002"));
    const mineBtn = document.createElement("button");
    mineBtn.type = "button";
    mineBtn.className = "shisuko-mine";
    mineBtn.textContent = "⛏";
    mineBtn.title = "Mine this sentence: screenshot + audio (Alt+Shift+M)";
    mineBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      mineCurrent();
    });
    subBox.appendChild(mineBtn);
    subWrap.appendChild(subBox);
    root.appendChild(subWrap);

    const transcriptEl = document.createElement("div");
    transcriptEl.className = "shisuko-transcript shisuko-hidden";
    const header = document.createElement("div");
    header.className = "shisuko-transcript-header";
    const title = document.createElement("span");
    title.textContent = "Transcript";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "shisuko-transcript-close";
    closeBtn.textContent = "×";
    closeBtn.title = "Hide transcript (Alt+Shift+L)";
    closeBtn.addEventListener("click", () => saveSettings({ showTranscript: false }));
    header.appendChild(title);
    header.appendChild(closeBtn);
    const list = document.createElement("div");
    list.className = "shisuko-transcript-list";
    list.setAttribute("lang", "ja");
    list.addEventListener("click", onTranscriptClick);
    // The panel does not scroll itself away under the reader's pointer (see highlightTranscript).
    list.addEventListener("mouseenter", () => { state.transcriptHovered = true; });
    list.addEventListener("mouseleave", () => { state.transcriptHovered = false; });
    transcriptEl.appendChild(header);
    transcriptEl.appendChild(list);
    root.appendChild(transcriptEl);

    subBox.addEventListener("mouseenter", onSubtitleEnter);
    subBox.addEventListener("mouseleave", onSubtitleLeave);

    player.appendChild(root);
    Object.assign(state, { root, statusEl, toastEl, subWrap, subBox, subText, mineBtn, transcriptEl, transcriptList: list });
    state.activeCueId = null;
    state.activeLineEl = null;
    state.transcriptDirty = true;
    state.transcriptAppendFrom = null;
    state.transcriptHovered = false;
    state.lineById.clear();
    applySettings();
  }

  function makeSentinel(text) {
    // A newline ends Yomitan's sentence in its default mode; the full stop covers the mode
    // where newlines are ignored. The span is clipped to nothing by content.css.
    const el = document.createElement("span");
    el.className = "shisuko-sentinel";
    el.setAttribute("aria-hidden", "true");
    el.textContent = text;
    return el;
  }

  function ensureOverlay(player) {
    if (state.root && state.root.isConnected && state.root.parentElement === player) return;
    if (state.root) state.root.remove();
    buildOverlay(player);
  }

  // ------------------------------------------------------------ discovery

  function discover() {
    if (!runtimeAlive()) {
      shutdown();
      return;
    }
    let player = state.player;
    let video = state.video;
    // The elements we hold are good until YouTube replaces them, and a replaced element is
    // disconnected; searching the whole document every tick only repeats an answer we already have.
    if (state.rediscover || !player || !player.isConnected || !video || !video.isConnected) {
      state.rediscover = false;
      player = document.querySelector("#movie_player") || document.querySelector(".html5-video-player");
      video = player
        ? player.querySelector("video.html5-main-video") || player.querySelector("video")
        : document.querySelector("video.html5-main-video");
    }
    if (player !== state.player || video !== state.video) attach(player, video);
    else if (player && (!state.root || !state.root.isConnected)) ensureOverlay(player);
    const href = location.href;
    if (href !== state.lastHref) {
      state.lastHref = href;
      const id = getVideoIdFromUrl(href);
      if (id !== state.videoId) onVideoChanged(id);
    }
  }

  function attach(player, video) {
    detach();
    state.player = player;
    state.video = video;
    if (player) {
      ensureOverlay(player);
      state.resizeObserver = new ResizeObserver(() => updateFontSize());
      state.resizeObserver.observe(player);
      player.addEventListener("mousemove", onPlayerMouseMove);
      updateFontSize();
    }
    if (video) {
      const onTime = () => render();
      const onSeek = () => {
        const now = Date.now();
        if (now - state.lastSeekSync > 250) {
          state.lastSeekSync = now;
          sync();
        }
      };
      const onPlay = () => {
        state.hoverPaused = false;
        state.awaitingPlayerMove = false;
        state.pausedSince = 0;
        clearResumeTimer();
        sync(); // playing again: back to the one second cadence at once, not at the next tick
      };
      const onPause = () => {
        if (!state.pausedSince) state.pausedSince = Date.now();
      };
      video.addEventListener("timeupdate", onTime);
      video.addEventListener("seeking", onSeek);
      video.addEventListener("play", onPlay);
      video.addEventListener("pause", onPause);
      state.videoListeners = { onTime, onSeek, onPlay, onPause };
      if (video.paused) state.pausedSince = Date.now();
    }
  }

  function detach() {
    if (state.video && state.videoListeners) {
      const { onTime, onSeek, onPlay, onPause } = state.videoListeners;
      state.video.removeEventListener("timeupdate", onTime);
      state.video.removeEventListener("seeking", onSeek);
      state.video.removeEventListener("play", onPlay);
      state.video.removeEventListener("pause", onPause);
    }
    state.videoListeners = null;
    if (state.player) state.player.removeEventListener("mousemove", onPlayerMouseMove);
    if (state.resizeObserver) {
      state.resizeObserver.disconnect();
      state.resizeObserver = null;
    }
  }

  // Forget every cue and everything keyed by a cue id: the transcript lines, the active line, the
  // hover frame, the covered ranges and the `since` cursor. Cue ids start at 0 again in every
  // fresh session (another video, a server restart, a model switch), so a stale entry in cueById
  // would make mergeCues() drop the new cue with the same id and cueById() answer with old text.
  function dropCues() {
    state.cues = [];
    state.cueById.clear();
    state.since = 0;
    state.covered = [];
    state.transcriptDirty = true;
    state.transcriptAppendFrom = null;
    state.lineById.clear();
    clearHoverCapture();
    // The cue ids the held sentences are keyed by mean nothing once the cues are gone.
    resetPremine();
    setSubtitle(null);
    // setSubtitle() already did this where there is an overlay; without one nothing else would.
    state.activeCueId = null;
    state.activeLineEl = null;
  }

  function onVideoChanged(id) {
    state.videoId = id;
    dropCues();
    state.duration = 0;
    state.serverStatus = id ? "connecting" : "idle";
    state.serverError = null;
    state.offline = false;
    state.serverSession = null;
    state.modelLoading = null;
    state.modelError = null;
    state.hoverPaused = false;
    state.awaitingPlayerMove = false;
    state.lastSyncAt = 0;
    state.pausedSince = state.video && state.video.paused ? Date.now() : 0;
    state.live = false;
    state.liveOffset = 0;
    clearResumeTimer();
    renderTranscript();
    updateStatus();
    if (id) sync();
  }

  // ------------------------------------------------------------ server sync

  // End of the covered range the playhead sits in, or null when this position is not covered.
  // Pure: the covered list and a time in, a time out.
  function coveredEnd(covered, t) {
    if (!Array.isArray(covered)) return null;
    for (const range of covered) {
      if (!Array.isArray(range) || range.length < 2) continue;
      if (t >= range[0] - 0.5 && t <= range[1] + 0.01) return range[1];
    }
    return null;
  }

  // Should the tick actually talk to the server? While the video plays, always: the playhead moves
  // and cues are wanted. While it is paused, only while the server still has work around the
  // playhead, plus a slow heartbeat so a restart, an error or a late cue is still noticed — and so
  // the server does not drop the session for want of a client.
  // Pure: { paused, t, status, covered, duration, lastSyncAt } and a clock in, a decision out.
  function shouldSync(st, now) {
    if (!st.paused) return true;
    if (now - (st.lastSyncAt || 0) >= SYNC_IDLE_INTERVAL_MS) return true;
    if (st.status !== "ready") return true; // still fetching, decoding, erroring: keep watching
    const duration = Number(st.duration) || 0;
    const target = duration > 0 ? Math.min(duration, st.t + SYNC_LOOKAHEAD_S) : Infinity;
    const ahead = coveredEnd(st.covered, st.t);
    return ahead === null || ahead < target - 0.5;
  }

  function syncTick() {
    const video = state.video;
    if (!video) return;
    pollForNewCard();
    pollWordIndex();
    const decision = {
      paused: !!video.paused,
      t: playhead(),
      status: state.serverStatus,
      covered: state.covered,
      duration: state.duration,
      lastSyncAt: state.lastSyncAt,
    };
    if (shouldSync(decision, Date.now())) sync();
  }

  async function sync() {
    const s = state.settings;
    if (!s.enabled || !state.videoId || !state.video || state.syncInFlight) return;
    if (isAdPlaying()) return;
    const videoId = state.videoId;
    updateLiveClock();
    state.syncInFlight = true;
    state.lastSyncAt = Date.now();
    let result;
    try {
      result = await sendMessage({
        type: "api",
        path: "/sync",
        body: {
          video_id: videoId,
          url: location.href,
          t: playhead(),
          paused: !!state.video.paused,
          since: state.since,
          model: modelForSync(s),
        },
      });
    } finally {
      state.syncInFlight = false;
    }
    if (videoId !== state.videoId) return;
    if (!result || !result.ok) {
      state.offline = true;
      state.serverStatus = "offline";
      state.serverError = (result && result.error) || "Server unreachable";
      updateStatus();
      return;
    }
    state.offline = false;
    const data = result.data || {};
    // Read before the session check: a model switch ends in a fresh session, and the status must
    // already say what is being loaded while the old one's cues are dropped. An older server sends
    // neither key, which is the same as nothing loading and nothing wrong. Both are judged for the
    // name this request carried: when the settings changed it while the request was out, the
    // storage listener dropped that name's verdict and could not ask about the new one (this
    // request was in flight), so this answer's verdict stays out and the new name goes right after.
    const modelChanged = modelForSync(s) !== modelForSync(state.settings);
    if (!modelChanged) {
      state.modelLoading = typeof data.model_loading === "string" && data.model_loading ? data.model_loading : null;
      state.modelError = typeof data.model_error === "string" && data.model_error ? data.model_error : null;
    }
    if (typeof data.session === "string" && data.session !== state.serverSession) {
      const restarted = state.serverSession !== null;
      state.serverSession = data.session;
      if (restarted) {
        // The server started a fresh session for this video (restart, model change): its cue ids
        // begin at 0 again, so drop what we have (the held sentences too) and fetch the new
        // transcript from the start. The cues in this answer were asked for with the old session's
        // `since`, so they are not taken; the status is the new session's and can be shown right away.
        dropCues();
        state.serverStatus = data.status || "unknown";
        state.serverError = data.error || null;
        renderTranscript();
        updateStatus();
        if (modelChanged) sync();
        return;
      }
    }
    state.serverStatus = data.status || "unknown";
    state.serverError = data.error || null;
    if (typeof data.duration === "number") state.duration = data.duration;
    if (Array.isArray(data.covered)) state.covered = data.covered;
    if (Array.isArray(data.cues) && data.cues.length) mergeCues(data.cues);
    if (typeof data.next === "number") state.since = data.next;
    updateStatus();
    render();
    if (modelChanged) sync(); // after this answer is applied, so the new request carries the right `since`
  }

  function mergeCues(incoming) {
    const seen = state.cueById; // already holds every cue: no need to rebuild an id set per response
    const before = state.cues.length;
    let lastStart = before ? state.cues[before - 1].start : -Infinity;
    let inOrder = true;
    let added = false;
    for (const raw of incoming) {
      if (!raw || typeof raw.text !== "string") continue;
      const seg = Number(raw.seg);
      const cue = {
        id: Number(raw.id),
        start: Number(raw.start) || 0,
        end: Number(raw.end) || 0,
        text: raw.text.trim(),
        // Cues built from one Whisper segment share a `seg`; an older server sends none, and then
        // every cue is a sentence of its own (see sentenceForCue).
        seg: Number.isFinite(seg) ? seg : null,
      };
      if (!cue.text || !Number.isFinite(cue.id) || seen.has(cue.id)) continue;
      seen.set(cue.id, cue);
      if (cue.start <= lastStart) inOrder = false;
      lastStart = cue.start;
      state.cues.push(cue);
      added = true;
    }
    if (added) {
      // Cues normally arrive in order, and then the array is already sorted: sorting thousands of
      // them again every second would be the one expensive thing on this path.
      if (!inOrder) state.cues.sort((a, b) => a.start - b.start || a.end - b.end);
      // New cues that all lie after the last rendered one keep the rendered prefix intact (the
      // sort is stable), so the panel can append them; anything else needs a full rebuild.
      const rebuildPending = state.transcriptDirty && state.transcriptAppendFrom === null;
      if (!rebuildPending) {
        if (inOrder) state.transcriptAppendFrom = state.transcriptAppendFrom === null ? before : Math.min(state.transcriptAppendFrom, before);
        else state.transcriptAppendFrom = null;
      }
      state.transcriptDirty = true;
      renderTranscript();
    }
  }

  // ------------------------------------------------------------ rendering

  function findActiveCue(t) {
    const cues = state.cues;
    if (!cues.length) return null;
    let lo = 0;
    let hi = cues.length - 1;
    let idx = -1;
    const target = t + 0.05;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= target) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (idx < 0) return null;
    for (let i = idx; i >= 0 && i > idx - 4; i--) {
      const c = cues[i];
      if (t >= c.start - 0.05 && t <= c.end + 0.05) return c;
    }
    // Past every candidate's end: keep the newest one up for a moment. A cue that arrived late and
    // sorted in behind the playhead only shortens that moment, because `next` is always the cue
    // following `last` in the current, freshly sorted array.
    const last = cues[idx];
    const next = cues[idx + 1];
    if (next && t >= next.start) return null;
    const linger = Math.max(0, Number(state.settings.lingerSeconds) || 0);
    const until = next && next.start - last.end < MIN_BLANK_S ? next.start : last.end + linger;
    return t <= until ? last : null;
  }

  // Where Left/Right should land. Pure: `cues` sorted by start, `t` the playhead, `direction`
  // -1 or +1. Returns the time to seek to, or null when nothing lies that way (only possible
  // going forward; backwards always has the start of the video). Left replays the current line
  // once the viewer is more than a second into it, the way asbplayer does, and steps back to the
  // line before it otherwise. Every target starts a shade early so the first syllable survives.
  function jumpTarget(cues, t, direction) {
    const list = cues || [];
    const target = t + 0.05;
    let idx = -1; // the last cue that has already started
    for (let lo = 0, hi = list.length - 1; lo <= hi; ) {
      const mid = (lo + hi) >> 1;
      if (list[mid].start <= target) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (direction > 0) {
      const next = list[idx + 1];
      return next ? leadIn(next.start) : null;
    }
    const cur = list[idx];
    if (cur && t - cur.start > CUE_REPLAY_S) return leadIn(cur.start);
    const prev = idx > 0 ? list[idx - 1] : null;
    return prev ? leadIn(prev.start) : 0;
  }

  function leadIn(start) {
    return Math.max(0, start - CUE_LEAD_IN_S);
  }

  function onKeyDown(ev) {
    if (!state.settings.enabled || !state.settings.arrowKeysJumpCues) return;
    if (ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey) return;
    const direction = ev.key === "ArrowLeft" ? -1 : ev.key === "ArrowRight" ? 1 : 0;
    if (!direction) return;
    const video = state.video;
    if (!video) return;
    // Typing in the search box or a comment: the arrows belong to the caret.
    const el = ev.target;
    if (el && typeof el.closest === "function" && el.closest(KEY_SKIP_SELECTOR)) return;
    const to = jumpTarget(state.cues, playhead(), direction);
    if (to === null) return; // no cue ahead: leave YouTube's five second seek alone
    // YouTube listens on the player while the event bubbles, so the capture phase is not enough
    // on its own; killing the rest of the dispatch here is what keeps the 5 s seek from firing.
    ev.preventDefault();
    ev.stopImmediatePropagation();
    const playing = !video.paused;
    // A jump is the viewer taking over, exactly as onPlay treats a manual resume.
    state.hoverPaused = false;
    state.awaitingPlayerMove = false;
    clearResumeTimer();
    seekPlayhead(to);
    if (playing) video.play().catch(() => {});
  }

  function render() {
    const video = state.video;
    if (!video || !state.subText || !state.settings.enabled) return;
    if (isAdPlaying()) {
      setSubtitle(null);
      return;
    }
    if (state.hoverPaused) return;
    setSubtitle(findActiveCue(playhead()));
  }

  function setSubtitle(cue) {
    if (!state.subBox) return;
    const id = cue ? cue.id : null;
    if (id === state.activeCueId) return;
    state.activeCueId = id;
    if (!cue) {
      state.subBox.classList.add("shisuko-hidden");
      state.subText.textContent = "";
    } else {
      renderText(state.subText, cue);
      state.subBox.classList.remove("shisuko-hidden");
      schedulePremine(cue);
    }
    highlightTranscript(cue);
  }

  function updateFontSize() {
    if (!state.player || !state.subBox) return;
    const h = state.player.clientHeight || 0;
    const scale = Number(state.settings.fontScale) || 1;
    const px = Math.min(96, Math.max(13, h * 0.047 * scale));
    state.subBox.style.fontSize = `${px.toFixed(1)}px`;
    if (state.transcriptEl) {
      const tpx = Math.min(22, Math.max(12, h * 0.022 * scale));
      state.transcriptEl.style.fontSize = `${tpx.toFixed(1)}px`;
    }
  }

  function coveredUntil(t) {
    return coveredEnd(state.covered, t);
  }

  function updateStatus() {
    const el = state.statusEl;
    if (!el) return;
    const s = state.settings;
    let text = null;
    let isError = false;
    if (s.enabled && state.videoId) {
      if (state.offline || state.serverStatus === "offline") {
        text = "Shisu-ko server offline. Start it with server/run.cmd or docker/up.cmd";
        isError = true;
      } else if (state.modelError) {
        // The model this viewer asked for is unusable: an error like the server's own, so it shows
        // even with progress messages off. The fix is in the popup, so the name goes in the text;
        // both are capped like a toast, since neither is ours.
        const name = truncate(modelForSync(s), STATUS_NAME_MAX_CHARS);
        text = `Shisu-ko: model${name ? " " + name : ""}: ${truncate(state.modelError, STATUS_ERROR_MAX_CHARS)}`;
        isError = true;
      } else if (state.modelLoading && state.serverStatus !== "error") {
        // Transcription waits for the load, whatever the session's status says meanwhile. A session
        // that failed is the exception: no load makes an audio fetch succeed, and its error must
        // not sit behind minutes of "Loading model" (or, with progress messages off, behind nothing).
        text = `Loading model ${state.modelLoading}… (a first use downloads it)`;
      } else {
        switch (state.serverStatus) {
          case "connecting":
            text = "Connecting to the Shisu-ko server…";
            break;
          case "pending":
          case "downloading":
            text = "Fetching audio…";
            break;
          case "decoding":
            text = "Decoding audio…";
            break;
          case "error":
            text = "Shisu-ko: " + (state.serverError || "error");
            isError = true;
            break;
          case "ready": {
            const t = playhead();
            const ahead = coveredUntil(t);
            if (ahead === null) text = "Transcribing…";
            else if (ahead - t < 8 && ahead < state.duration - 1) text = `Transcribing… (ready to ${formatTime(ahead)})`;
            break;
          }
          default:
            break;
        }
      }
    }
    if (!s.showStatus && !isError) text = null;
    // Only touch the DOM when something changed: every mutation wakes other extensions'
    // observers (Bitwarden re-walks the whole page after each one).
    const hidden = el.classList.contains("shisuko-hidden");
    if (!text) {
      if (!hidden) el.classList.add("shisuko-hidden");
      return;
    }
    if (el.textContent !== text) el.textContent = text;
    if (el.classList.contains("shisuko-status-error") !== isError) el.classList.toggle("shisuko-status-error", isError);
    if (hidden) el.classList.remove("shisuko-hidden");
  }

  function showToast(text, kind, ms) {
    const el = state.toastEl;
    if (!el) return;
    // An error can carry a whole URL or payload; a toast that fills the player helps nobody.
    el.textContent = truncate(text, TOAST_MAX_CHARS);
    let cls = "shisuko-toast";
    if (kind === "error") cls += " shisuko-toast-error";
    else if (kind === "warn") cls += " shisuko-toast-warn";
    else if (kind === "ok") cls += " shisuko-toast-ok";
    el.className = cls;
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => el.classList.add("shisuko-hidden"), ms || TOAST_MS);
  }

  // ------------------------------------------------------------ transcript panel

  function transcriptLine(cue) {
    const line = document.createElement("div");
    line.className = "shisuko-line";
    line.dataset.start = String(cue.start);
    line.dataset.id = String(cue.id);
    const time = document.createElement("span");
    time.className = "shisuko-time";
    time.textContent = formatTime(cue.start);
    time.title = "Jump here";
    const text = document.createElement("span");
    text.className = "shisuko-linetext";
    renderText(text, cue);
    state.lineTexts.set(line, text);
    const mine = document.createElement("button");
    mine.type = "button";
    mine.className = "shisuko-line-mine";
    mine.textContent = "⛏";
    mine.title = "Mine this sentence: screenshot + audio";
    line.appendChild(time);
    line.appendChild(text);
    line.appendChild(mine);
    state.lineById.set(cue.id, line);
    return line;
  }

  function renderTranscript() {
    const list = state.transcriptList;
    if (!list || !state.settings.showTranscript || !state.transcriptDirty) return;
    state.transcriptDirty = false;
    const from = state.transcriptAppendFrom;
    state.transcriptAppendFrom = null;
    // The map counts the lines already in the panel, so nothing walks the DOM to find out.
    const rendered = state.lineById.size;
    const frag = document.createDocumentFragment();
    if (from !== null && from > 0 && from === rendered && from <= state.cues.length) {
      // Only cues after the rendered ones arrived: append them instead of rebuilding thousands of nodes.
      for (let i = from; i < state.cues.length; i++) frag.appendChild(transcriptLine(state.cues[i]));
      list.appendChild(frag);
    } else {
      state.lineById.clear();
      for (const cue of state.cues) frag.appendChild(transcriptLine(cue));
      if (!state.cues.length) {
        const empty = document.createElement("div");
        empty.className = "shisuko-empty";
        empty.textContent = "No transcript yet.";
        frag.appendChild(empty);
      }
      list.replaceChildren(frag);
      state.activeLineEl = null;
    }
    if (state.activeCueId !== null) highlightTranscript(cueById(state.activeCueId));
  }

  function highlightTranscript(cue) {
    const list = state.transcriptList;
    if (!list || !state.settings.showTranscript) return;
    if (state.activeLineEl) state.activeLineEl.classList.remove("shisuko-active");
    state.activeLineEl = null;
    if (!cue) return;
    const line = state.lineById.get(cue.id);
    if (!line) return;
    line.classList.add("shisuko-active");
    state.activeLineEl = line;
    // matches(":hover") would flush style on every cue change; the two listeners on the list keep
    // the same answer for free. offsetTop below forces layout, so it stays behind this guard.
    if (!state.transcriptHovered) {
      list.scrollTop = line.offsetTop - list.clientHeight / 2 + line.offsetHeight / 2;
    }
  }

  function onTranscriptClick(ev) {
    const mineButton = ev.target.closest(".shisuko-line-mine");
    if (mineButton) {
      ev.preventDefault();
      const line = mineButton.closest(".shisuko-line");
      const cue = cueById(line && line.dataset.id);
      if (cue) mineCue(cue, { seekForFrame: cue.id !== state.activeCueId });
      return;
    }
    const time = ev.target.closest(".shisuko-time");
    if (!time || !state.video) return;
    const line = time.closest(".shisuko-line");
    const start = Number(line && line.dataset.start);
    if (!Number.isFinite(start)) return;
    seekPlayhead(start - 0.2);
    state.video.play().catch(() => {});
  }

  // ------------------------------------------------------------ word colours

  // Either colour needs the deck index; neither may cost anything while the add-on is off.
  function wordColoursOn() {
    const s = state.settings;
    return !!s.enabled && (!!s.cardStatus || !!s.pitchAccent);
  }

  function dropWordIndex() {
    state.wordIndex = null;
    state.wordIndexSerial++;
    state.wordIndexAt = 0;
    state.wordIndexKey = "";
    state.wordIndexAskedAt = 0;
    state.wordIndexGeneration++;
  }

  // How a cue's text is to be drawn now: `runs`, a string for plain text and an object for a word
  // whose card has something to show under the settings of now (null while the whole text is
  // plain), and `key`, its drawKey(). Found once per cue, index and pair of colours and kept in
  // cueLooks (the text's word boundaries with it, whatever the index), so that the panel rebuilt
  // for a style change, or a line the refresh finds untouched, asks the matcher nothing. The
  // look names the index it was found under by its serial, never by holding it: the index of a
  // 10k-word deck weighs a megabyte and a hidden transcript's cues are never visited again.
  function lookOf(cue) {
    const s = state.settings;
    const index = state.wordIndex;
    if (!wordColoursOn() || !index) return { runs: null, key: cue.text };
    const cardStatus = !!s.cardStatus;
    const pitchAccent = !!s.pitchAccent;
    const serial = state.wordIndexSerial;
    const known = state.cueLooks.get(cue);
    if (known && known.serial === serial && known.cardStatus === cardStatus && known.pitchAccent === pitchAccent) return known;
    const starts = known ? known.starts : SHISUKO_WORDS.wordStarts(cue.text);
    const runs = [];
    let plain = "";
    for (const run of SHISUKO_WORDS.markWords(cue.text, index, starts)) {
      const status = cardStatus && run.status ? run.status : null;
      const pitch = pitchAccent && run.pitch ? run.pitch : null;
      // A card with nothing to show here is text like any other, joined with its neighbours.
      if (!status && !pitch) {
        plain += run.text;
        continue;
      }
      if (plain) runs.push(plain);
      plain = "";
      runs.push({ text: run.text, status, pitch });
    }
    if (plain) runs.push(plain);
    const look = { serial, cardStatus, pitchAccent, starts, runs, key: drawKey(cue.text, runs) };
    state.cueLooks.set(cue, look);
    return look;
  }

  // One string per look of a line: the text and where each mark sits in it. Two draws with the
  // same key put the same nodes in.
  function drawKey(text, runs) {
    let key = text;
    if (!runs) return key;
    let at = 0;
    for (const run of runs) {
      if (typeof run === "string") {
        at += run.length;
        continue;
      }
      key += `\n${at} ${run.text.length} ${run.status || ""} ${run.pitch || ""}`;
      at += run.text.length;
    }
    return key;
  }

  function drawRuns(el, text, runs, key) {
    state.drawnKeys.set(el, key);
    if (!runs) {
      el.textContent = text;
      return;
    }
    const frag = document.createDocumentFragment();
    for (const run of runs) {
      if (typeof run === "string") {
        frag.appendChild(document.createTextNode(run));
        continue;
      }
      const span = document.createElement("span");
      span.className = "shisuko-word";
      if (run.status) span.dataset.status = run.status;
      if (run.pitch) span.dataset.pitch = run.pitch;
      span.textContent = run.text;
      frag.appendChild(span);
    }
    el.replaceChildren(frag);
  }

  // The one place a cue's text goes into an element, on screen and in the transcript. The text
  // stays DOM text nodes, which is what Yomitan scans; a word with a card sits in an inline span
  // that carries what the card says, and content.css colours it. Nothing else is ever put in.
  function renderText(el, cue) {
    const look = lookOf(cue);
    drawRuns(el, cue.text, look.runs, look.key);
  }

  // Draw the text again only where the index or the settings changed its look. Only for an
  // element renderText() last wrote: what anything else put in is not on record.
  function refreshText(el, cue) {
    const look = lookOf(cue);
    if (state.drawnKeys.get(el) === look.key) return;
    drawRuns(el, cue.text, look.runs, look.key);
  }

  // The strings a line must hold for its runs to differ under `next` from those under `prev`: a
  // word one index has a card for and the other not, or says something else about, or the stem
  // it is found by (a conjugated form starts with the stem and so does the word itself, so the
  // stem alone is looked for). Empty when the two say the same about every word; null when they
  // differ in more words than WORD_INDEX_PROBE_MAX, where matching the lines again is no dearer.
  function indexProbes(prev, next) {
    const changed = new Set();
    for (const [word, entry] of next.exact) {
      const was = prev.exact.get(word);
      if (!was || was.status !== entry.status || was.pitch !== entry.pitch) changed.add(word);
    }
    for (const word of prev.exact.keys()) if (!next.exact.has(word)) changed.add(word);
    if (changed.size > WORD_INDEX_PROBE_MAX) return null;
    if (!changed.size) return [];
    const probes = new Set();
    const stemmed = new Set();
    for (const stems of [prev.stems, next.stems]) {
      for (const [stem, list] of stems) {
        for (const { entry } of list) {
          if (!changed.has(entry.word)) continue;
          probes.add(stem);
          stemmed.add(entry.word);
        }
      }
    }
    for (const word of changed) if (!stemmed.has(word)) probes.add(word);
    return [...probes];
  }

  // Whether a transcript line looks under the index of now as it already does: what it shows are
  // the runs found under the index of serial `prevSerial` with the colours of now, and none of
  // `probes` is in its text, so the index of now finds the same runs. Those are then on record
  // for it too.
  function sameLook(el, cue, prevSerial, probes) {
    const look = state.cueLooks.get(cue);
    const s = state.settings;
    if (!look || look.serial !== prevSerial || look.cardStatus !== !!s.cardStatus || look.pitchAccent !== !!s.pitchAccent) return false;
    if (state.drawnKeys.get(el) !== look.key) return false;
    for (const probe of probes) if (cue.text.includes(probe)) return false;
    look.serial = state.wordIndexSerial;
    return true;
  }

  // Draw the line on screen and the transcript again with the index as it is now. A transcript
  // with every line up is walked line by line and only the lines that would look different are
  // touched, so nothing scrolls and the thousands of others keep their nodes; and against the
  // index of the last refresh, a line holding none of the words the two differ on is not even
  // matched again, so a card reviewed in Anki costs a look at each line's text. One with lines
  // still pending is rebuilt whole.
  function refreshWordMarks() {
    const index = state.wordIndex;
    const prev = state.wordIndexDrawn;
    const prevSerial = state.wordIndexDrawnSerial;
    const probes = prev && index && wordColoursOn() ? indexProbes(prev, index) : null;
    state.wordIndexDrawn = index;
    state.wordIndexDrawnSerial = state.wordIndexSerial;
    if (state.activeCueId !== null && state.subText) {
      const cue = cueById(state.activeCueId);
      if (cue && !(probes && sameLook(state.subText, cue, prevSerial, probes))) refreshText(state.subText, cue);
    }
    if (!state.settings.showTranscript || !state.transcriptList) return;
    if (!state.transcriptDirty && state.lineById.size === state.cues.length) {
      for (const cue of state.cues) {
        const text = state.lineTexts.get(state.lineById.get(cue.id));
        if (!text) continue;
        if (probes && sameLook(text, cue, prevSerial, probes)) continue;
        refreshText(text, cue);
      }
      return;
    }
    state.transcriptDirty = true;
    state.transcriptAppendFrom = null;
    renderTranscript();
  }

  // Ask the background for the deck's words. It runs from syncTick(), so a switched-off add-on
  // and a hidden tab never ask, and neither does a tab without a video (a settings change asks
  // from every tab, the home page and the player kept off a watch page included): the background
  // answers from its cache, and "unchanged" when it still holds what this tab was last given.
  async function pollWordIndex() {
    if (!wordColoursOn() || !state.video || !state.videoId || state.wordIndexInFlight) return;
    if (document.visibilityState !== "visible") return;
    const now = Date.now();
    if (now - state.wordIndexAskedAt < WORD_INDEX_REFRESH_MS) return;
    state.wordIndexAskedAt = now;
    state.wordIndexInFlight = true;
    const generation = state.wordIndexGeneration;
    let res;
    try {
      res = await sendMessage({ type: "cardStatus", since: state.wordIndexAt });
    } finally {
      state.wordIndexInFlight = false;
    }
    // Started over while the ask was out: this answer is about the deck or the fields of before,
    // and the next tick asks again (the stamp was reset with the index).
    if (!res || generation !== state.wordIndexGeneration) return;
    if (!res.ok) {
      // Turned off since the ask: nothing may stay coloured. Anki closed or a deck gone is
      // ordinary and gets a debug line, never a toast.
      if (res.reason === "off") {
        dropWordIndex();
        refreshWordMarks();
      } else {
        logWordIndexError(res.error || res.reason);
      }
      return;
    }
    if (res.unchanged || !Array.isArray(res.entries)) return;
    const at = Number(res.at) || 0;
    if (at === state.wordIndexAt) return;
    state.wordIndexAt = at;
    // The background refetches the deck every half minute and stamps it anew, yet the words rarely
    // change; a transcript of thousands of lines is only rebuilt when they did.
    const key = JSON.stringify(res.entries);
    if (key === state.wordIndexKey && state.wordIndex) return;
    state.wordIndex = SHISUKO_WORDS.buildIndex(res.entries);
    state.wordIndexSerial++;
    state.wordIndexKey = key;
    refreshWordMarks();
  }

  function logWordIndexError(error) {
    const now = Date.now();
    if (now - state.lastWordIndexLog < WORD_INDEX_LOG_MS) return;
    state.lastWordIndexLog = now;
    console.debug("Shisu-ko: word colours:", error || "unknown error");
  }

  // ------------------------------------------------------------ sentence mining

  function currentCueForMining() {
    if (state.activeCueId !== null) {
      const active = cueById(state.activeCueId);
      if (active) return active;
    }
    const t = playhead();
    let best = null;
    for (const c of state.cues) {
      if (c.start <= t + 0.5 && c.end >= t - MINE_RECENT_WINDOW_S && (!best || c.start > best.start)) best = c;
    }
    return best;
  }

  // The whole spoken sentence a cue belongs to. The server splits one Whisper segment into several
  // short cues and marks them with the same `seg`, so joining those in start order gives back the
  // sentence, and their outer bounds give its audio range. Pure: cues in, sentence out.
  function sentenceForCue(cues, cue) {
    if (!cue) return null;
    const own = { start: cue.start, end: cue.end, text: cue.text, cueIds: [cue.id] };
    if (!Number.isFinite(cue.seg)) return own;
    const all = cues.filter((c) => c && c.seg === cue.seg);
    if (all.length < 2) return own;
    all.sort((a, b) => a.start - b.start || a.end - b.end);
    // A segment can span a long pause (music, a cut); only the run of cues around this one that
    // sits within SENTENCE_MAX_GAP_S of its neighbours is the sentence.
    let i = all.indexOf(cue);
    if (i < 0) i = all.findIndex((c) => c.id === cue.id);
    if (i < 0) return own;
    let lo = i;
    while (lo > 0 && all[lo].start - all[lo - 1].end <= SENTENCE_MAX_GAP_S) lo--;
    let hi = i;
    while (hi < all.length - 1 && all[hi + 1].start - all[hi].end <= SENTENCE_MAX_GAP_S) hi++;
    const parts = all.slice(lo, hi + 1);
    if (parts.length < 2) return own;
    return {
      start: Math.min(...parts.map((c) => c.start)),
      end: Math.max(...parts.map((c) => c.end)),
      text: parts.map((c) => c.text).join(""),
      cueIds: parts.map((c) => c.id),
    };
  }

  // The sentence after this one, so its audio can be fetched before it is spoken. Pure: the cue
  // list and a sentence in, the sentence starting at the next cue after it out, or null at the end.
  function nextSentence(cues, sentence) {
    const list = cues || [];
    const ids = sentence && Array.isArray(sentence.cueIds) ? sentence.cueIds : [];
    if (!ids.length) return null;
    let last = -1;
    for (let i = 0; i < list.length; i++) {
      if (list[i] && ids.indexOf(list[i].id) >= 0 && i > last) last = i;
    }
    if (last < 0) return null;
    const next = list[last + 1];
    return next ? sentenceForCue(list, next) : null;
  }

  function captureFrame(video) {
    if (!video) return null;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return null;
    const scale = Math.min(1, 1280 / w);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    try {
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.85);
    } catch (err) {
      return null; // DRM-protected streams taint the canvas
    }
  }

  // ---- pre-mining: prepare every sentence that plays, before any card exists ----

  // Where a cue sits in what the background holds ready, Infinity when it holds nothing for it.
  // The newest sentence ranks first, so a card that could belong to two identical lines is given
  // the one the viewer just read. Pure: the held list and a cue in, an order out.
  function rankOfCue(held, cue) {
    const list = held || [];
    for (let i = 0; i < list.length; i++) {
      const ids = list[i] && list[i].cueIds;
      if (Array.isArray(ids) && cue && ids.indexOf(cue.id) >= 0) return i;
    }
    return Infinity;
  }

  function heldHas(key, what) {
    return state.premined.some((entry) => entry.key === key && entry[what]);
  }

  // Preparing material costs a frame read and a clip request, so it is spent only where a card can
  // follow: the add-on on, a video open, the server reachable, the tab in front, no ad running.
  function premineAllowed() {
    return !!(
      state.settings.enabled &&
      state.videoId &&
      state.video &&
      !state.offline &&
      document.visibilityState === "visible" &&
      !isAdPlaying()
    );
  }

  async function sendPremine(sentence, extra) {
    const res = await sendMessage(
      Object.assign(
        {
          type: "premine",
          videoId: state.videoId,
          key: sentence.cueIds[0],
          cueIds: sentence.cueIds,
          sentence: { start: sentence.start, end: sentence.end, text: sentence.text },
        },
        extra || {}
      )
    );
    if (res && res.ok && Array.isArray(res.held)) state.premined = res.held;
    return res;
  }

  function clearPremineTimer() {
    if (state.premineTimer) {
      clearTimeout(state.premineTimer);
      state.premineTimer = null;
    }
  }

  function resetPremine() {
    clearPremineTimer();
    // Nothing held means nothing to drop, and with the master switch off nothing is ever held: a
    // switched-off add-on sends no messages at all.
    if (state.premined.length) sendMessage({ type: "premineReset" });
    state.premined = [];
  }

  // A new line is on screen. Wait out the delay before touching the GPU, then prepare this
  // sentence and ask for the next one's audio, so a lookup on either is already paid for.
  function schedulePremine(cue) {
    clearPremineTimer();
    if (!cue || !premineAllowed()) return;
    const sentence = sentenceForCue(state.cues, cue);
    if (!sentence) return;
    const key = sentence.cueIds[0];
    state.premineTimer = setTimeout(() => {
      state.premineTimer = null;
      premineNow(key);
    }, PREMINE_CAPTURE_DELAY_MS);
  }

  async function premineNow(key) {
    if (!premineAllowed()) return;
    const active = cueById(state.activeCueId);
    const sentence = active ? sentenceForCue(state.cues, active) : null;
    if (!sentence || sentence.cueIds[0] !== key) return; // the line moved on while we waited
    if (!heldHas(key, "image")) {
      const imageDataUrl = await captureFrameAsync(state.video);
      if (!premineAllowed()) return;
      await sendPremine(sentence, { imageDataUrl });
    }
    const next = nextSentence(state.cues, sentence);
    if (next && !heldHas(next.cueIds[0], "audio")) await sendPremine(next, { ahead: true });
  }

  function captureHoverFrame() {
    // The frame to attach is the one on screen when the viewer hovered the line, but reading a
    // video frame back from the GPU stalls the main thread, so wait until Yomitan's scan has run
    // and encode off the main thread. It replaces the frame taken when the line appeared: this is
    // the one the viewer was looking at, and hovering pins the sentence against eviction.
    clearHoverCapture();
    const id = state.activeCueId;
    if (id === null || !premineAllowed()) return;
    state.hoverCaptureTimer = setTimeout(() => {
      state.hoverCaptureTimer = null;
      if (state.activeCueId !== id || !premineAllowed()) return;
      const sentence = sentenceForCue(state.cues, cueById(id));
      if (!sentence) return;
      captureFrameAsync(state.video).then((imageDataUrl) => {
        if (!imageDataUrl || state.activeCueId !== id) return;
        sendPremine(sentence, { imageDataUrl, hover: true });
      });
    }, HOVER_CAPTURE_DELAY_MS);
  }

  function clearHoverCapture() {
    if (state.hoverCaptureTimer) {
      clearTimeout(state.hoverCaptureTimer);
      state.hoverCaptureTimer = null;
    }
  }

  function captureFrameAsync(video) {
    return new Promise((resolve) => {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return resolve(null);
      const scale = Math.min(1, 1280 / w);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      try {
        canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          if (!blob) return resolve(null);
          const reader = new FileReader();
          reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        }, "image/jpeg", 0.85);
      } catch (err) {
        resolve(null); // DRM-protected streams taint the canvas
      }
    });
  }

  function seekTo(video, t) {
    // Setting currentTime to the position the media is already at fires no "seeked" event, so
    // the wait below would only end at the fallback timeout. Nothing to do in that case.
    if (Math.abs((Number(video.currentTime) || 0) - t) < 0.05) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        video.removeEventListener("seeked", finish);
        setTimeout(resolve, 80); // let the new frame paint before we grab it
      };
      video.addEventListener("seeked", finish);
      video.currentTime = t;
      setTimeout(finish, 1500);
    });
  }

  async function mineCue(cue, options) {
    if (!cue || state.mining || !state.video || !state.videoId) return;
    const opts = options || {};
    state.mining = true;
    showToast(opts.auto ? "Attaching to the new card…" : "Mining…", "info", 15000);
    try {
      const video = state.video;
      const sentence = sentenceForCue(state.cues, cue);
      const key = sentence ? sentence.cueIds[0] : null;
      // The viewer asking for this line gets the frame on screen now. An automatic mine takes the
      // pre-mined frame when there is one: it is the frame that was up while the line was read,
      // and by now the video has moved on. Only a line still on screen, or one worth seeking
      // back to, is captured afresh.
      const capture = !opts.auto || (!heldHas(key, "image") && (cue.id === state.activeCueId || !!opts.seekForFrame));
      let restore = null;
      if (capture && opts.seekForFrame) {
        restore = { t: video.currentTime, paused: video.paused };
        video.pause();
        await seekTo(video, Math.min(cue.end, cue.start + 0.4) - (state.live ? state.liveOffset : 0));
      }
      const imageDataUrl = capture ? captureFrame(video) : null;
      if (restore) {
        await seekTo(video, restore.t);
        if (!restore.paused) video.play().catch(() => {});
      }
      // Automatic mining leaves playback alone: the viewer is probably still in Yomitan's popup.
      if (!opts.auto) resumeAfterMining(video);
      const result = await sendMessage({
        type: "mine",
        videoId: state.videoId,
        key,
        cue: { start: cue.start, end: cue.end, text: cue.text },
        sentence: sentence ? { start: sentence.start, end: sentence.end, text: sentence.text } : null,
        imageDataUrl,
        noteId: opts.noteId,
        auto: !!opts.auto,
      });
      if (result && result.ok) {
        showToast(result.message || "Mined", result.warning ? "warn" : "ok");
        // The card the word colours are about was just made (or, with no deck chosen, the first
        // one, which tells the background the deck): the next ask goes out soon, not at the interval.
        state.wordIndexAskedAt = Date.now() - WORD_INDEX_REFRESH_MS + WORD_INDEX_MINE_DELAY_MS;
      } else if (result && result.mismatch) showToast(result.error, "warn", 6000);
      else showToast("Mining failed: " + ((result && result.error) || "unknown error"), "error", 6000);
    } catch (err) {
      showToast("Mining failed: " + String((err && err.message) || err), "error", 6000);
    } finally {
      state.mining = false;
    }
  }

  function resumeAfterMining(video) {
    // The frame is captured; keep watching while the server cuts the audio clip. Only a pause
    // caused by hovering the subtitle is undone here; a pause the viewer chose stays.
    if (!state.hoverPaused || !video || !video.paused) return;
    state.hoverPaused = false;
    state.awaitingPlayerMove = false;
    clearResumeTimer();
    video.play().catch(() => {});
  }

  // Is anyone plausibly mining right now? Polling costs a message and an AnkiConnect request per
  // second, so it is spent only where a card can appear: a visible tab, playing, or paused with the
  // viewer at the subtitle. A video left paused in a visible tab for two minutes is not being read.
  function ankiPollAllowed() {
    const s = state.settings;
    if (!s.enabled || !s.autoMine || state.offline) return false;
    // Nothing transcribed yet means nothing a new card could be given.
    if (!state.videoId || !state.cues.length) return false;
    if (document.visibilityState !== "visible" || isAdPlaying()) return false;
    if (state.hoverPaused || state.awaitingPlayerMove) return true;
    return !state.pausedSince || Date.now() - state.pausedSince < PAUSE_POLL_IDLE_MS;
  }

  // Ask the background whether Yomitan just created a card.
  async function pollForNewCard() {
    if (state.mining || state.ankiPollInFlight) return;
    if (!ankiPollAllowed()) return;
    state.ankiPollInFlight = true;
    let res;
    try {
      res = await sendMessage({ type: "ankiPoll" });
    } finally {
      state.ankiPollInFlight = false;
    }
    if (!res) return;
    // Anki being closed or not having granted access is normal; it must not raise toasts.
    if (!res.ok) logAnkiPollError(res.error);
    else if (res.newNoteId) autoMine(res.newNoteId, res.note);
  }

  function logAnkiPollError(error) {
    const now = Date.now();
    if (now - state.lastAnkiPollLog < ANKI_POLL_LOG_MS) return;
    state.lastAnkiPollLog = now;
    console.debug("Shisu-ko: Anki watch:", error || "unknown error");
  }

  // A card is matched to the line it is about, not assumed to be about the line playing now: by
  // the time Yomitan has written the note the video has moved on, and with pause-on-hover off it
  // has moved on by several lines. Only a card with neither sentence nor word to go on falls back
  // to the playhead. Sentences already prepared rank first, so two identical lines resolve to the
  // one the viewer just read.
  function autoMine(noteId, note) {
    const written = note ? SHISUKO_MATCH.normalize(note.sentence) : "";
    const word = note ? SHISUKO_MATCH.normalize(note.word) : "";
    let cue;
    if (written || word) {
      cue = SHISUKO_MATCH.matchCue(state.cues, note, { rank: (c) => rankOfCue(state.premined, c), t: playhead() });
      if (!cue) {
        showToast("New card's sentence matches no subtitle; nothing attached", "warn");
        return;
      }
    } else {
      cue = currentCueForMining();
      if (!cue) {
        showToast("New card detected but no subtitle to attach", "warn");
        return;
      }
    }
    const seekForFrame = cue.id !== state.activeCueId && !!(state.video && state.video.paused);
    mineCue(cue, { seekForFrame, noteId, auto: true });
  }

  function mineCurrent() {
    const cue = currentCueForMining();
    if (!cue) {
      showToast("No subtitle at this position to mine", "error");
      return;
    }
    mineCue(cue, { seekForFrame: false });
  }

  // ------------------------------------------------------------ pause while hovering

  function onSubtitleEnter() {
    clearResumeTimer();
    state.awaitingPlayerMove = false;
    captureHoverFrame();
    if (!state.settings.pauseOnHover || !state.video) return;
    if (!state.video.paused && !state.video.ended) {
      state.video.pause();
      state.hoverPaused = true;
    }
  }

  function onSubtitleLeave(ev) {
    clearHoverCapture();
    if (!state.hoverPaused) return;
    const related = ev.relatedTarget;
    // Leaving towards a dictionary popup (an iframe, or anything that is not part of the
    // player) keeps the video paused until the pointer comes back over the video.
    if (!related || related.tagName === "IFRAME" || !isYouTubeElement(related)) {
      state.awaitingPlayerMove = true;
      return;
    }
    scheduleResume();
  }

  function onPlayerMouseMove(ev) {
    // Mutated, not replaced: this runs on every mouse move across the player.
    state.lastPointer.x = ev.clientX;
    state.lastPointer.y = ev.clientY;
    if (!state.hoverPaused || !state.awaitingPlayerMove) return;
    if (state.subBox && state.subBox.contains(ev.target)) return;
    if (!isYouTubeElement(ev.target)) return;
    state.awaitingPlayerMove = false;
    scheduleResume();
  }

  function scheduleResume() {
    clearResumeTimer();
    state.resumeTimer = setTimeout(() => {
      state.resumeTimer = null;
      if (!state.hoverPaused || !state.video) return;
      if (state.subBox && state.subBox.matches(":hover")) return;
      const under = document.elementFromPoint(state.lastPointer.x, state.lastPointer.y);
      if (under && (under.tagName === "IFRAME" || !isYouTubeElement(under))) {
        state.awaitingPlayerMove = true;
        return;
      }
      state.hoverPaused = false;
      state.video.play().catch(() => {});
    }, RESUME_DELAY_MS);
  }

  function clearResumeTimer() {
    if (state.resumeTimer) {
      clearTimeout(state.resumeTimer);
      state.resumeTimer = null;
    }
  }

  // ------------------------------------------------------------ keyboard commands

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "command") return undefined;
    if (msg.name === "toggle-subtitles") saveSettings({ enabled: !state.settings.enabled });
    else if (msg.name === "toggle-transcript") saveSettings({ showTranscript: !state.settings.showTranscript });
    else if (msg.name === "mine-current") mineCurrent();
    return undefined;
  });

  // ------------------------------------------------------------ start

  loadSettings().then(() => {
    discover();
    timers.push(setInterval(discover, DISCOVER_INTERVAL_MS));
    timers.push(setInterval(syncTick, SYNC_INTERVAL_MS));
    timers.push(setInterval(render, RENDER_INTERVAL_MS));
    timers.push(setInterval(() => {
      if (state.hoverPaused || state.awaitingPlayerMove) pollForNewCard();
    }, HOVER_POLL_INTERVAL_MS));
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("yt-navigate-finish", () => {
      // YouTube swaps the player on navigation: the cached element must be looked up again.
      state.rediscover = true;
      setTimeout(discover, 50);
    });
    document.addEventListener("fullscreenchange", () => setTimeout(updateFontSize, 100));
  });
})();

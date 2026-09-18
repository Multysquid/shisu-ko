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
 *    fetch the matching audio clip and file both into Anki or the Downloads folder
 */

(() => {
  if (window.__shisukoLoaded) return;
  window.__shisukoLoaded = true;

  const DEFAULT_SETTINGS = {
    enabled: true,
    serverUrl: "http://127.0.0.1:8790",
    fontScale: 1.0,
    pauseOnHover: true,
    lingerSeconds: 3,
    showTranscript: false,
    hideNativeCaptions: false,
    showStatus: true,
  };

  const SYNC_INTERVAL_MS = 1000;
  const RENDER_INTERVAL_MS = 200;
  const DISCOVER_INTERVAL_MS = 750;
  const RESUME_DELAY_MS = 350;
  const TOAST_MS = 3500;
  const MINE_RECENT_WINDOW_S = 6;

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
    since: 0,
    covered: [],
    duration: 0,
    serverStatus: "idle",
    serverError: null,
    offline: false,
    activeCueKey: null,
    activeLineEl: null,
    transcriptDirty: true,
    hoverPaused: false,
    awaitingPlayerMove: false,
    resumeTimer: null,
    lastPointer: { x: 0, y: 0 },
    syncInFlight: false,
    mining: false,
    resizeObserver: null,
    videoListeners: null,
    lastSeekSync: 0,
  };

  // ------------------------------------------------------------ helpers

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
    const n = Number(id);
    return state.cues.find((c) => c.id === n) || null;
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
    state.settings = Object.assign({}, DEFAULT_SETTINGS, changes.settings.newValue || {});
    applySettings();
  });

  function applySettings() {
    const s = state.settings;
    document.documentElement.classList.toggle("shisuko-hide-native", !!s.hideNativeCaptions);
    if (state.root) {
      state.root.classList.toggle("shisuko-hidden", !s.enabled);
      state.root.classList.toggle("shisuko-has-transcript", !!s.showTranscript);
      state.transcriptEl.classList.toggle("shisuko-hidden", !s.showTranscript);
      if (s.showTranscript) {
        state.transcriptDirty = true;
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
    const subText = document.createElement("span");
    subText.className = "shisuko-subtext";
    subBox.appendChild(subText);
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
    closeBtn.title = "Hide transcript (Alt+Shift+T)";
    closeBtn.addEventListener("click", () => saveSettings({ showTranscript: false }));
    header.appendChild(title);
    header.appendChild(closeBtn);
    const list = document.createElement("div");
    list.className = "shisuko-transcript-list";
    list.setAttribute("lang", "ja");
    list.addEventListener("click", onTranscriptClick);
    transcriptEl.appendChild(header);
    transcriptEl.appendChild(list);
    root.appendChild(transcriptEl);

    subBox.addEventListener("mouseenter", onSubtitleEnter);
    subBox.addEventListener("mouseleave", onSubtitleLeave);

    player.appendChild(root);
    Object.assign(state, { root, statusEl, toastEl, subWrap, subBox, subText, mineBtn, transcriptEl, transcriptList: list });
    state.activeCueKey = null;
    state.activeLineEl = null;
    state.transcriptDirty = true;
    applySettings();
  }

  function ensureOverlay(player) {
    if (state.root && state.root.isConnected && state.root.parentElement === player) return;
    if (state.root) state.root.remove();
    buildOverlay(player);
  }

  // ------------------------------------------------------------ discovery

  function discover() {
    const player = document.querySelector("#movie_player") || document.querySelector(".html5-video-player");
    const video = player
      ? player.querySelector("video.html5-main-video") || player.querySelector("video")
      : document.querySelector("video.html5-main-video");
    if (player !== state.player || video !== state.video) attach(player, video);
    else if (player && (!state.root || !state.root.isConnected)) ensureOverlay(player);
    const id = getVideoIdFromUrl(location.href);
    if (id !== state.videoId) onVideoChanged(id);
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
        clearResumeTimer();
      };
      video.addEventListener("timeupdate", onTime);
      video.addEventListener("seeking", onSeek);
      video.addEventListener("play", onPlay);
      state.videoListeners = { onTime, onSeek, onPlay };
    }
  }

  function detach() {
    if (state.video && state.videoListeners) {
      const { onTime, onSeek, onPlay } = state.videoListeners;
      state.video.removeEventListener("timeupdate", onTime);
      state.video.removeEventListener("seeking", onSeek);
      state.video.removeEventListener("play", onPlay);
    }
    state.videoListeners = null;
    if (state.player) state.player.removeEventListener("mousemove", onPlayerMouseMove);
    if (state.resizeObserver) {
      state.resizeObserver.disconnect();
      state.resizeObserver = null;
    }
  }

  function onVideoChanged(id) {
    state.videoId = id;
    state.cues = [];
    state.since = 0;
    state.covered = [];
    state.duration = 0;
    state.serverStatus = id ? "connecting" : "idle";
    state.serverError = null;
    state.offline = false;
    state.transcriptDirty = true;
    state.hoverPaused = false;
    state.awaitingPlayerMove = false;
    clearResumeTimer();
    setSubtitle(null);
    renderTranscript();
    updateStatus();
    if (id) sync();
  }

  // ------------------------------------------------------------ server sync

  async function sync() {
    const s = state.settings;
    if (!s.enabled || !state.videoId || !state.video || state.syncInFlight) return;
    if (isAdPlaying()) return;
    const videoId = state.videoId;
    state.syncInFlight = true;
    let result;
    try {
      result = await sendMessage({
        type: "api",
        path: "/sync",
        body: {
          video_id: videoId,
          url: location.href,
          t: Number(state.video.currentTime) || 0,
          paused: !!state.video.paused,
          since: state.since,
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
    state.serverStatus = data.status || "unknown";
    state.serverError = data.error || null;
    if (typeof data.duration === "number") state.duration = data.duration;
    if (Array.isArray(data.covered)) state.covered = data.covered;
    if (Array.isArray(data.cues) && data.cues.length) mergeCues(data.cues);
    if (typeof data.next === "number") state.since = data.next;
    updateStatus();
    render();
  }

  function mergeCues(incoming) {
    const seen = new Set(state.cues.map((c) => c.id));
    let added = false;
    for (const raw of incoming) {
      if (!raw || typeof raw.text !== "string") continue;
      const cue = {
        id: Number(raw.id),
        start: Number(raw.start) || 0,
        end: Number(raw.end) || 0,
        text: raw.text.trim(),
      };
      if (!cue.text || !Number.isFinite(cue.id) || seen.has(cue.id)) continue;
      seen.add(cue.id);
      state.cues.push(cue);
      added = true;
    }
    if (added) {
      state.cues.sort((a, b) => a.start - b.start || a.end - b.end);
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
    const last = cues[idx];
    const next = cues[idx + 1];
    const linger = Math.max(0, Number(state.settings.lingerSeconds) || 0);
    if (t <= last.end + linger && (!next || t < next.start)) return last;
    return null;
  }

  function render() {
    const video = state.video;
    if (!video || !state.subText || !state.settings.enabled) return;
    if (isAdPlaying()) {
      setSubtitle(null);
      return;
    }
    if (state.hoverPaused) return;
    setSubtitle(findActiveCue(Number(video.currentTime) || 0));
  }

  function setSubtitle(cue) {
    if (!state.subBox) return;
    const key = cue ? String(cue.id) : null;
    if (key === state.activeCueKey) return;
    state.activeCueKey = key;
    if (!cue) {
      state.subBox.classList.add("shisuko-hidden");
      state.subText.textContent = "";
    } else {
      state.subText.textContent = cue.text;
      state.subBox.classList.remove("shisuko-hidden");
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
    for (const range of state.covered) {
      if (!Array.isArray(range) || range.length < 2) continue;
      if (t >= range[0] - 0.5 && t <= range[1] + 0.01) return range[1];
    }
    return null;
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
            const t = state.video ? Number(state.video.currentTime) || 0 : 0;
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
    if (!text) {
      el.classList.add("shisuko-hidden");
      return;
    }
    el.textContent = text;
    el.classList.toggle("shisuko-status-error", isError);
    el.classList.remove("shisuko-hidden");
  }

  function showToast(text, kind, ms) {
    const el = state.toastEl;
    if (!el) return;
    el.textContent = text;
    let cls = "shisuko-toast";
    if (kind === "error") cls += " shisuko-toast-error";
    else if (kind === "warn") cls += " shisuko-toast-warn";
    else if (kind === "ok") cls += " shisuko-toast-ok";
    el.className = cls;
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => el.classList.add("shisuko-hidden"), ms || TOAST_MS);
  }

  // ------------------------------------------------------------ transcript panel

  function renderTranscript() {
    const list = state.transcriptList;
    if (!list || !state.settings.showTranscript || !state.transcriptDirty) return;
    state.transcriptDirty = false;
    const frag = document.createDocumentFragment();
    for (const cue of state.cues) {
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
      text.textContent = cue.text;
      const mine = document.createElement("button");
      mine.type = "button";
      mine.className = "shisuko-line-mine";
      mine.textContent = "⛏";
      mine.title = "Mine this sentence: screenshot + audio";
      line.appendChild(time);
      line.appendChild(text);
      line.appendChild(mine);
      frag.appendChild(line);
    }
    if (!state.cues.length) {
      const empty = document.createElement("div");
      empty.className = "shisuko-empty";
      empty.textContent = "No transcript yet.";
      frag.appendChild(empty);
    }
    list.replaceChildren(frag);
    state.activeLineEl = null;
    if (state.activeCueKey) highlightTranscript(cueById(state.activeCueKey));
  }

  function highlightTranscript(cue) {
    const list = state.transcriptList;
    if (!list || !state.settings.showTranscript) return;
    if (state.activeLineEl) state.activeLineEl.classList.remove("shisuko-active");
    state.activeLineEl = null;
    if (!cue) return;
    const line = list.querySelector(`.shisuko-line[data-id="${cue.id}"]`);
    if (!line) return;
    line.classList.add("shisuko-active");
    state.activeLineEl = line;
    if (!list.matches(":hover")) {
      list.scrollTop = line.offsetTop - list.clientHeight / 2 + line.offsetHeight / 2;
    }
  }

  function onTranscriptClick(ev) {
    const mineButton = ev.target.closest(".shisuko-line-mine");
    if (mineButton) {
      ev.preventDefault();
      const line = mineButton.closest(".shisuko-line");
      const cue = cueById(line && line.dataset.id);
      if (cue) mineCue(cue, { seekForFrame: String(cue.id) !== state.activeCueKey });
      return;
    }
    const time = ev.target.closest(".shisuko-time");
    if (!time || !state.video) return;
    const line = time.closest(".shisuko-line");
    const start = Number(line && line.dataset.start);
    if (!Number.isFinite(start)) return;
    state.video.currentTime = Math.max(0, start - 0.2);
    state.video.play().catch(() => {});
  }

  // ------------------------------------------------------------ sentence mining

  function currentCueForMining() {
    if (state.activeCueKey) {
      const active = cueById(state.activeCueKey);
      if (active) return active;
    }
    const t = state.video ? Number(state.video.currentTime) || 0 : 0;
    let best = null;
    for (const c of state.cues) {
      if (c.start <= t + 0.5 && c.end >= t - MINE_RECENT_WINDOW_S && (!best || c.start > best.start)) best = c;
    }
    return best;
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

  function seekTo(video, t) {
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
    state.mining = true;
    showToast("Mining…", "info", 15000);
    try {
      const video = state.video;
      let restore = null;
      if (options && options.seekForFrame) {
        restore = { t: video.currentTime, paused: video.paused };
        video.pause();
        await seekTo(video, Math.min(cue.end, cue.start + 0.4));
      }
      const imageDataUrl = captureFrame(video);
      if (restore) {
        await seekTo(video, restore.t);
        if (!restore.paused) video.play().catch(() => {});
      }
      resumeAfterMining(video);
      const result = await sendMessage({
        type: "mine",
        videoId: state.videoId,
        cue: { start: cue.start, end: cue.end, text: cue.text },
        imageDataUrl,
      });
      if (result && result.ok) showToast(result.message || "Mined", result.warning ? "warn" : "ok");
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
    if (!state.settings.pauseOnHover || !state.video) return;
    if (!state.video.paused && !state.video.ended) {
      state.video.pause();
      state.hoverPaused = true;
    }
  }

  function onSubtitleLeave(ev) {
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
    state.lastPointer = { x: ev.clientX, y: ev.clientY };
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
    setInterval(discover, DISCOVER_INTERVAL_MS);
    setInterval(sync, SYNC_INTERVAL_MS);
    setInterval(render, RENDER_INTERVAL_MS);
    document.addEventListener("yt-navigate-finish", () => setTimeout(discover, 50));
    document.addEventListener("fullscreenchange", () => setTimeout(updateFontSize, 100));
  });
})();

"use strict";

/*
 * Background (event page). Jobs:
 *  1. Proxy API calls from content scripts to the local Whisper server.
 *  2. Own the settings object in browser.storage.local.
 *  3. Sentence mining: fetch the audio clip for a cue from the server and attach it, together
 *     with the screenshot taken by the content script, to an Anki card via AnkiConnect, or save
 *     both to the Downloads folder.
 *  4. Watch AnkiConnect for a note Yomitan has just added, so the content script can attach the
 *     material without the viewer pressing anything.
 *  5. Pre-mine: hold the screenshot and the audio clip of the sentences that just played, so a
 *     card gets them at once and still gets them after the line has gone from the screen.
 *  6. Start the server for the popup: an extension cannot spawn a process, so the request goes
 *     to the "shisuko" native host (server/native_host.py), which runs the project's launcher.
 *  7. Updates: ask GitHub for the newest release once a day, tell the viewer (toolbar badge, one
 *     system notification, the popup's banner) and, on request, ask the server to update itself:
 *     POST /update makes it exit so that run.cmd / run.sh run update.py and start it again. The
 *     extension never installs itself; its updates come from addons.mozilla.org.
 */

const DEFAULT_SETTINGS = SHISUKO_DEFAULT_SETTINGS; // from settings.js

const REQUEST_TIMEOUT_MS = 10000;

// The native host answers at once (it only spawns run.cmd / run.sh and reports), but
// sendNativeMessage has no timeout and no AbortSignal: a host that hangs, or a Python that takes
// its time on a cold disk, would leave the popup on "Starting…" for good. 15 s is well past a
// Python start-up and well short of the popup's own 90 s patience.
const NATIVE_TIMEOUT_MS = 15000;
const NATIVE_HOST = "shisuko";
// A launch is remembered for as long as the popup waits for the server. The popup document dies
// with every click outside it, and a reopened one must not offer a second start while the first
// is still loading its model, which is the whole time /health stays silent (server.py binds the
// port after load_model()): a second run.cmd would load a second model onto the same GPU. 90 s is
// past any healthy start (10-40 s on a GPU after the launcher's venv check, longer on a CPU);
// after it the popup shows the log hint and the button again, since a launch that failed has to
// be retried somehow. The record goes to storage.session as well as memory: Firefox ends an idle
// event page after 30 s, and a model load takes longer than that.
const START_WINDOW_MS = 90000;
const START_KEY = "startServer";
const LAUNCHER_HINT = "Run server\\setup.cmd (Windows) or bash server/setup.sh once, or start the server by hand once: run.cmd / run.sh register the launcher";
const NATIVE_PERMISSION_HINT = "Allow Shisu-ko to talk to its launcher when the browser asks";
const UPDATE_RUNNING_HINT = "The launcher restarts the server itself once update.py is done";

// Auto-mining watcher: poll AnkiConnect for a note Yomitan has just created.
const ANKI_POLL_THROTTLE_MS = 250;   // several tabs may poll; one request per interval is enough
// How long a permission verdict holds: a viewer who clicked No in Anki's dialog is asked again
// after a minute. No verdict at all (the request threw: Anki is not running, or still starting)
// is asked again after a few seconds: not on the next poll, which is a second away and, with
// autoMine on by default, would send a refused connection a second for as long as Anki stays
// closed, and not in a minute, which kept the watcher from a card made in the minute after
// Anki was started.
const ANKI_PERMISSION_RECHECK_MS = 60000;
const ANKI_PERMISSION_RETRY_MS = 5000;
const ANKI_POLL_TIMEOUT_MS = 5000;      // a hung poll would otherwise block the watcher for good
const ANKI_BASELINE_MAX_AGE_MS = 10000; // a gap this long means the baseline can no longer be trusted
// A note found by one tab's poll stays on a ledger this long for the tab the card was made in:
// two visible YouTube tabs both poll, and the first tick to land would otherwise take the note
// away from that tab. Which tab that is, the background cannot tell (it has no cues), so the note
// is answered once to every tab that asks, each matches the card's sentence against its own
// lines, and the tab whose mine then writes into the note takes it off the ledger. A minute,
// not a few seconds: the tab the card was made in may be mid-mine (its polls wait for the mine,
// and a mine can take a while: four tries for a clip the server is still fetching, 1.5 s apart,
// then the Anki round trips), or the viewer may have left it for a moment.
const ANKI_REPORT_WINDOW_MS = 60000;
// The other tabs match a card to a line of their own by its sentence, and a short sentence
// (はい, うん, the word alone) is in every video, mid-clause if not as a line: a tab on another
// video would attach its own frame, clip and sentence to the card. Only a sentence long enough
// to single out a line is replayed (the floor is comparable()'s in match.js); a shorter card
// goes to the tab that found it alone, as every card did before there was a ledger.
const ANKI_REPORT_MIN_CHARS = 6;
// A mine waits for its answer with nothing else the tab can do (the content script holds its
// mining flag until the message resolves), so every request on that path has a deadline: a
// /clip stuck behind a paused container or a laptop's sleep would otherwise end mining, and the
// Anki watch, for that tab until a reload. The clip is a few seconds of decoding on a busy
// server; AnkiConnect's requestPermission waits for the viewer to answer Anki's dialog, so it
// gets a minute, the other actions (a media upload, a field write) far less than that.
const CLIP_TIMEOUT_MS = 30000;
const ANKI_REQUEST_TIMEOUT_MS = 30000;
const ANKI_PERMISSION_TIMEOUT_MS = 60000;

const ankiWatch = { baseline: null, lastPollAt: 0, lastOk: false, permission: null, permissionAskAt: 0, reports: [] };

// Pre-mined sentences, keyed by tab, video and sentence. Memory only: this is material for a card
// that may never be made, and none of it is worth a file on disk. The caps keep a long session
// from growing without bound; five sentences per tab is far more than a reader is ever behind.
const PREMINE_PER_TAB = 5;
const PREMINE_TOTAL = 10;
const PREMINE_IMAGE_MAX_BYTES = 3 * 1024 * 1024;
const PREMINE_AUDIO_MAX_BYTES = 5 * 1024 * 1024;

const premined = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Every message from a content script used to re-read storage; at one sync tick and one Anki poll
// per second per tab that is two cross-process reads a second for a value that changes when the
// viewer touches the popup. The listener below is registered at the top level so the event page
// wakes up for a change it made while suspended.
let settingsCache = null;

// Frozen because every caller now shares one object: a stray write would change what the next
// caller reads, and a throw here is cheaper to find than that.
function cacheSettings(settings) {
  settingsCache = Object.freeze(settings);
  return settingsCache;
}

async function getSettings() {
  if (settingsCache) return settingsCache;
  const stored = await browser.storage.local.get("settings");
  return cacheSettings(Object.assign({}, DEFAULT_SETTINGS, stored.settings || {}));
}

// A save is a read, a merge and a write, and the cache only learns of the write once it is done:
// a second save landing during the first's storage write (the popup's flush and the content
// script's Alt+Shift+S both come through here) would merge its patch onto the settings from
// before the first and write the first patch away. One save at a time, in the order they came.
let saveChain = Promise.resolve();

function saveSettings(patch) {
  const save = saveChain.then(async () => {
    const current = await getSettings();
    const next = Object.assign({}, current, patch || {});
    await browser.storage.local.set({ settings: next });
    return cacheSettings(next);
  });
  // A failed write must not fail every save after it.
  saveChain = save.catch(() => {});
  return save;
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes && changes.settings) settingsCache = null;
});

function normalizeBase(url, fallback) {
  const value = String(url || fallback).trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(value) ? value : fallback;
}

// ------------------------------------------------------------------ one tab at a time

// The server transcribes one video per session and a second tab would fight the first for GPU,
// bandwidth and disk. So only one tab's /sync reaches it. The right belongs to the tab the viewer
// is watching -- the active tab of the focused window -- and otherwise stays where it is; the
// other tabs are told to stand by and take over the moment they are looked at.
const HOLD_TIMEOUT_MS = 12000; // two missed 5 s heartbeats: the tab left the video, was turned off or died
// How long a focused holder keeps the right without syncing. It has to exceed the content script's
// 5 s idle heartbeat, or a *paused* focused tab would look quiet between two heartbeats and the
// right would flap; it has to stay well under HOLD_TIMEOUT_MS so that a focused tab which really
// stopped syncing -- master switch off, an ad, the YouTube home page, a throttled background tab --
// hands the right on in one heartbeat instead of twelve seconds of blank overlays elsewhere.
const FOCUS_STALE_MS = 7000;

const activeTabs = new Map(); // windowId -> the tab active in it
const syncers = new Map();    // tabId -> { at, paused }: every tab that recently asked to sync
let focusedWindowId = null;
let holder = null;            // the tab allowed to talk to the server, or null

function focusedTabId() {
  if (focusedWindowId === null) return null;
  const id = activeTabs.get(focusedWindowId);
  return id === undefined ? null : id;
}

// Which tab may sync, given the one asking now. Pure: every input is an argument, so the rules can
// be tested without windows, tabs or a clock.
//
// No tab becomes the holder unless it is the one asking; only an existing holder keeps a right it
// already has. Naming a tab that did not ask looks tempting -- the focused tab is the one the
// viewer wants -- but a focused tab that has stopped syncing (the master switch, an ad, the
// YouTube home page) would then hold the right in silence and every other tab would stand by
// until its entry aged out. A focused tab that is not the holder needs no help: its own next tick
// takes the right through rule 1, a second later at most.
function electSyncTab(candidate, current, focused, tabs, now) {
  const fresh = (id, within) => {
    const seen = tabs.get(id);
    return !!seen && now - seen.at < within;
  };
  if (focused === candidate) return candidate;                          // 1. the viewer is watching the tab that is asking
  // 2. nobody holds it, the asker already holds it, or the holder has gone quiet. Past this line
  // `current` is a tab id with a fresh entry in `tabs`, which is what makes `held` below defined.
  if (current === null || current === undefined || current === candidate || !fresh(current, HOLD_TIMEOUT_MS)) return candidate;
  if (current === focused && fresh(current, FOCUS_STALE_MS)) return current; // 3. the watched tab keeps it, playing or paused
  const held = tabs.get(current);
  const asking = tabs.get(candidate); // the asker's entry, written just before this call; absent only in a test
  // 4. a playing video beats a holder that is paused, or that has gone quiet since the focus
  // window: a tab whose switch was turned off keeps reporting nothing, and the viewer should not
  // wait out the whole hold timeout for it.
  if (asking && !asking.paused && (held.paused || !fresh(current, FOCUS_STALE_MS))) return candidate;
  return current;                                                       // 5. otherwise the holder keeps it
}

browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
  activeTabs.set(windowId, tabId);
});

// WINDOW_ID_NONE means focus left the browser altogether. The last focused window keeps the
// priority then: switching to another app must not hand the right to some other tab.
//
// Browsers fire onActivated only when the tab selection changes *inside* a window, never when
// focus moves between windows, so a window we have not seen a selection change in has no entry
// here -- after a browser start, after the event page restarted. Ask for its active tab, or
// focusedTabId() answers null forever and the tab the viewer is actually watching stands by.
browser.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === browser.windows.WINDOW_ID_NONE) return undefined;
  focusedWindowId = windowId;
  return browser.tabs
    .query({ active: true, windowId })
    .then((tabs) => {
      for (const tab of tabs) {
        if (typeof tab.id === "number") activeTabs.set(windowId, tab.id);
      }
    })
    .catch(() => {});
});

// The event page starts after the windows already exist, so ask once for the current one.
browser.tabs
  .query({ active: true, lastFocusedWindow: true })
  .then((tabs) => {
    for (const tab of tabs) {
      if (typeof tab.id !== "number" || typeof tab.windowId !== "number") continue;
      activeTabs.set(tab.windowId, tab.id);
      // A focus change that fired while this query was out knows better than its answer does.
      if (focusedWindowId === null) focusedWindowId = tab.windowId;
    }
  })
  .catch(() => {});

// ------------------------------------------------------------------ Whisper server proxy

async function apiRequest(path, body) {
  if (typeof path !== "string" || !path.startsWith("/")) {
    return { ok: false, error: "Invalid API path" };
  }
  const settings = await getSettings();
  const base = normalizeBase(settings.serverUrl, DEFAULT_SETTINGS.serverUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const init = { method: body === undefined ? "GET" : "POST", signal: controller.signal, headers: {} };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetch(base + path, init);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (err) {
      return { ok: false, error: "Server returned a non-JSON response" };
    }
    if (!res.ok) {
      return { ok: false, error: (data && data.error) || `HTTP ${res.status}`, data };
    }
    if (path === "/health") {
      forgetStart(); // the popup's poll: the server the launch waited for is up
      await noteHealth(data);
    }
    return { ok: true, data };
  } catch (err) {
    const timedOut = err && err.name === "AbortError";
    if (path === "/health") await noteHealth(null);
    return { ok: false, offline: true, error: timedOut ? "Server timed out" : "Server unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ starting the server

// What the browser says when the native host is not there, in a line the viewer can act on.
// Firefox says "No such native application shisuko" whether the host manifest is missing or does
// not list this extension; Chrome splits that into "Specified native messaging host not found."
// and "Access to the specified native messaging host is forbidden." Anything about permission
// means the optional nativeMessaging grant is missing.
function nativeError(err) {
  const text = String((err && err.message) || err || "");
  if (/no such native application|not found|nonexistent|forbidden/i.test(text)) {
    return { ok: false, error: "launcher not registered", hint: LAUNCHER_HINT };
  }
  if (/permission|denied|not available/i.test(text)) {
    return { ok: false, error: "permission missing", hint: NATIVE_PERMISSION_HINT };
  }
  return { ok: false, error: text || "the launcher failed" };
}

let lastStart = null;     // the launch under way: its answer, {ok, started, already, loading, log, deadline}
let startInFlight = null; // the host's pending answer, shared by every request until it lands

function sessionArea() {
  const area = browser.storage && browser.storage.session;
  return area && typeof area.get === "function" && typeof area.set === "function" ? area : null;
}

// The launch under way, or null once its window has passed. Storage outranks memory: the event
// page may have been restarted since the launch, and this page then knows nothing.
async function pendingStart() {
  const area = sessionArea();
  if (area) {
    try {
      const stored = (await area.get(START_KEY))[START_KEY];
      lastStart = stored && typeof stored === "object" ? stored : null;
    } catch (err) {
      /* memory keeps what this event page saw */
    }
  }
  return lastStart && typeof lastStart.deadline === "number" && Date.now() < lastStart.deadline ? lastStart : null;
}

async function rememberStart(answer) {
  lastStart = answer;
  const area = sessionArea();
  if (!area) return;
  try {
    await area.set({ [START_KEY]: answer });
  } catch (err) {
    /* memory keeps it for as long as this event page lives */
  }
}

// A server that answers /health is what the launch was waiting for: the next request must reach
// the host again (it will find the server running, or start it again after it was stopped).
function forgetStart() {
  if (lastStart) rememberStart(null);
}

// Ask the native host to start the server, once: a request while a launch is under way is answered
// from that launch, without asking again, and requests that overlap share one answer. Resolves
// {ok: true, started|already, loading, log, deadline} or {ok: false, error, hint}; it never rejects,
// so the popup always has a line to show. The host's own verdict passes through untouched: it
// knows why run.cmd could not be launched.
function startServer() {
  if (!startInFlight) {
    startInFlight = requestStart().finally(() => {
      startInFlight = null;
    });
  }
  return startInFlight;
}

async function requestStart() {
  const pending = await pendingStart();
  if (pending) return pending;
  // An update is a restart the launcher runs itself: between the old server's exit and the new
  // one's port the host sees neither /health nor the instance lock and would launch run.cmd a
  // second time, two update.py runs on one folder. The popup hides the button for this; a popup
  // that has not heard of the record yet is refused here.
  if (await pendingUpdate()) return { ok: false, error: "an update is under way", hint: UPDATE_RUNNING_HINT };
  // Looked up at call time, not at load: Firefox adds the method once the permission is granted.
  const send = browser.runtime.sendNativeMessage;
  if (typeof send !== "function") return { ok: false, error: "permission missing", hint: NATIVE_PERMISSION_HINT };
  const timedOut = Symbol("timeout");
  let timer = null;
  const noAnswer = new Promise((resolve) => {
    timer = setTimeout(() => resolve(timedOut), NATIVE_TIMEOUT_MS);
  });
  try {
    const answer = await Promise.race([send.call(browser.runtime, NATIVE_HOST, { cmd: "start" }), noAnswer]);
    if (answer === timedOut) return { ok: false, error: "the launcher did not answer" };
    if (!answer || typeof answer !== "object") return { ok: false, error: "the launcher gave no answer" };
    if (!answer.ok) return { ok: false, error: String(answer.error || "the launcher refused") };
    const result = {
      ok: true,
      started: !!answer.started,
      already: !!answer.already,
      // The host's `starting`: a server launched (by an earlier click, or by hand) that holds its
      // instance lock but does not listen yet, its model still loading or downloading. Not an
      // `already` the popup may blame on the server URL, and not `starting`, which is the popup's
      // word for a launch under way (startStatus below).
      loading: !!answer.starting,
      log: typeof answer.log === "string" && answer.log ? answer.log : null,
      deadline: Date.now() + START_WINDOW_MS,
    };
    await rememberStart(result);
    return result;
  } catch (err) {
    return nativeError(err);
  } finally {
    clearTimeout(timer);
  }
}

// The popup's question on opening: is a start under way? With the launch's details, a reopened
// popup resumes watching it, button disabled, where the closed one left off. An update under
// way travels with the answer (`updating`, its record): the popup asks this before its first
// paint, and updateStatus, which also carries the record, may first wait ten seconds on GitHub,
// long enough for that paint to offer a start on top of the launcher's restart.
async function startStatus() {
  const start = startInFlight ? await startInFlight : await pendingStart();
  const status = !start || !start.ok ? { starting: false } : { starting: true, already: !!start.already, loading: !!start.loading, log: start.log, deadline: start.deadline };
  const updating = await pendingUpdate();
  if (updating) status.updating = updating;
  return status;
}

// ------------------------------------------------------------------ updates

// The newest release comes from GitHub's REST API, which answers cross-origin requests with
// Access-Control-Allow-Origin: *, so the manifest needs no host permission for it.
const GITHUB_LATEST_URL = "https://api.github.com/repos/Multysquid/shisu-ko/releases/latest";
// One check a day: releases are weeks apart, and GitHub allows sixty unauthenticated requests an
// hour per address. A check that failed does not count as one; it is tried again the next time
// the popup opens or the browser starts, which costs one quick failure while offline.
const UPDATE_CHECK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 10000;
// How long an update may take before the popup stops watching for the new server: the old one
// exits, the launcher runs update.py (a git fetch, or a release download and unpack) and the new
// one loads its model again, 10-40 s on a GPU and longer on a CPU. The popup owns the wait; the
// record lives here, in storage.session like the launch record, so a reopened popup resumes it
// and a restarted event page still knows about it.
const UPDATE_WINDOW_MS = 120000;
// The old server closes its port within a second of answering /update, so the old version seen
// this long after the request is the restarted server, whether or not a poll caught it down: the
// popup that asked closes with any click outside it, and nobody polls while it is closed. popup.js
// keeps a copy for its own verdict (addon/tests/popup-copies.test.js keeps the two equal).
const UPDATE_SHUTDOWN_MS = 10000;
// The notification path has no popup polling /health for it; the background polls at this pace
// itself, until the record ends or the window passes.
const UPDATE_POLL_MS = 3000;
const UPDATE_CHECK_KEY = "updateCheck"; // storage.local: {checkedAt, latest, error}
const UPDATE_KEY = "serverUpdate"; // storage.session: {requestedAt, from, to, deadline, down}
const SNOOZE_KEY = "updateSnoozed"; // storage.session: the version "Not now" was clicked for
const NOTIFIED_KEY = "notifiedVersion"; // storage.session: the version the notification was shown for
const UPDATE_NOTIFICATION = "shisuko-update";
const UPDATED_NOTIFICATION = "shisuko-updated";
const UPDATE_FAILED_NOTIFICATION = "shisuko-update-failed"; // its own id: a click on it must not post again
// The badge is a nudge, not an alarm: the popup's accent, dulled, and never the alert red.
const BADGE_COLOR = "#5b6fb8";

// storage.session with a memory fallback: a browser without the area keeps the value for the
// life of the event page, which is what the launch record does with `lastStart` above.
const sessionMemory = {};

async function sessionGet(key) {
  const area = sessionArea();
  if (area) {
    try {
      const stored = (await area.get(key))[key];
      return stored === undefined ? null : stored;
    } catch (err) {
      /* memory keeps what this event page saw */
    }
  }
  return Object.hasOwn(sessionMemory, key) ? sessionMemory[key] : null;
}

async function sessionSet(key, value) {
  sessionMemory[key] = value;
  const area = sessionArea();
  if (!area) return;
  try {
    await area.set({ [key]: value });
  } catch (err) {
    /* memory keeps it for as long as this event page lives */
  }
}

// "0.9.0" or "v0.9.0" as three numbers; a missing or unreadable part counts as 0, so a tag with
// a suffix still compares by what is in front of it and garbage sorts below every release.
function parseVersion(text) {
  const parts = String(text || "").trim().replace(/^v/i, "").split(".");
  return [0, 1, 2].map((i) => {
    const n = parseInt(parts[i], 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
}

function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (va[i] !== vb[i]) return va[i] < vb[i] ? -1 : 1;
  }
  return 0;
}

// The release GitHub's answer describes, or null when it names none. Only https URLs are kept:
// the popup opens the release page in a tab, and a page from an API answer is still a page.
function releaseFromApi(json) {
  if (!json || typeof json !== "object" || typeof json.tag_name !== "string" || !json.tag_name.trim()) return null;
  const tag = json.tag_name.trim();
  const https = (value) => (typeof value === "string" && /^https:\/\//i.test(value) ? value : null);
  const assets = Array.isArray(json.assets) ? json.assets : [];
  const xpi = assets.find((asset) => asset && typeof asset.name === "string" && asset.name.toLowerCase().endsWith(".xpi"));
  return { version: tag.replace(/^v/i, ""), tag, url: https(json.html_url), xpi: xpi ? https(xpi.browser_download_url) : null };
}

// What the newest release means for the two halves. The server can only be updated through
// /update when its launcher runs update.py after the exit (`launcher` in /health); one started
// by Docker, Nix or by hand says false. A server from before the flag (every 0.8.0, the first
// this extension meets) says nothing: when its version is behind it is "behind", a badge and a
// banner that name the release but make no claim about run.cmd, since the flag would be the
// only ground for one. A server without even a version, the smoke fixture, is "unknown": no
// banner and no guess. `serverOnline` tells that apart from no server at all.
function decideUpdate(input) {
  const { latest, serverVersion, serverLauncher, extensionVersion: extension, serverOnline } = input || {};
  const newest = latest && typeof latest.version === "string" && latest.version ? latest.version : null;
  const decision = { server: "unknown", extension: "current" };
  if (!newest) return decision;
  if (typeof extension === "string" && extension && compareVersions(newest, extension) > 0) decision.extension = "newer";
  if (typeof serverVersion === "string" && serverVersion) {
    if (compareVersions(newest, serverVersion) <= 0) decision.server = "current";
    else if (serverLauncher === true) decision.server = "newer";
    else if (serverLauncher === false) decision.server = "cannot";
    else decision.server = "behind";
  } else {
    decision.server = serverOnline ? "unknown" : "offline";
  }
  return decision;
}

// What /health says about the server for the update question: null without a server, and a
// null field for whatever an older server does not report.
function serverInfo(health) {
  if (!health || typeof health !== "object") return null;
  return {
    version: typeof health.version === "string" && health.version ? health.version : null,
    launcher: typeof health.launcher === "boolean" ? health.launcher : null,
  };
}

function extensionVersion() {
  try {
    const manifest = browser.runtime.getManifest();
    return manifest && typeof manifest.version === "string" ? manifest.version : null;
  } catch (err) {
    return null;
  }
}

async function readUpdateCheck() {
  try {
    const stored = (await browser.storage.local.get(UPDATE_CHECK_KEY))[UPDATE_CHECK_KEY];
    return stored && typeof stored === "object" ? stored : null;
  } catch (err) {
    return null;
  }
}

function checkIsFresh(check) {
  return !!check && !check.error && typeof check.checkedAt === "number" && Date.now() - check.checkedAt < UPDATE_CHECK_MAX_AGE_MS;
}

// {latest} or {error}, never a throw: a failed check is a line under the popup's button and a
// console.debug, never a notification. Nobody asked, and being offline is not news.
async function fetchLatestRelease() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(GITHUB_LATEST_URL, { headers: { Accept: "application/vnd.github+json" }, signal: controller.signal });
    if (res.status === 404) return { latest: null }; // no release published yet
    if (res.status === 403 || res.status === 429) return { error: "GitHub's rate limit is reached, try again in an hour" };
    if (!res.ok) return { error: `GitHub answered HTTP ${res.status}` };
    let json;
    try {
      json = await res.json();
    } catch (err) {
      return { error: "GitHub returned a non-JSON response" };
    }
    const latest = releaseFromApi(json);
    return latest ? { latest } : { error: "GitHub's answer names no release" };
  } catch (err) {
    return { error: err && err.name === "AbortError" ? "GitHub did not answer in time" : "could not reach GitHub" };
  } finally {
    clearTimeout(timer);
  }
}

let checkInFlight = null; // the check under way, shared by the popup and the start-up listener

// The stored check when it is fresh, else a new one: {checkedAt, latest, error}. A failure keeps
// the last release seen, so the banner still knows what is out there.
function checkForUpdate(opts) {
  if (!checkInFlight) {
    checkInFlight = runCheck(!!(opts && opts.force)).finally(() => {
      checkInFlight = null;
    });
  }
  return checkInFlight;
}

async function runCheck(force) {
  const cached = await readUpdateCheck();
  if (!force && checkIsFresh(cached)) return cached;
  const check = { checkedAt: Date.now(), latest: cached && cached.latest ? cached.latest : null, error: null };
  const verdict = await fetchLatestRelease();
  if (verdict.error) {
    check.error = verdict.error;
    console.debug("Shisu-ko: update check failed:", verdict.error);
  } else {
    check.latest = verdict.latest;
  }
  try {
    await browser.storage.local.set({ [UPDATE_CHECK_KEY]: check });
  } catch (err) {
    /* the answer still goes out; the next opening checks again */
  }
  return check;
}

// The toolbar badge and the notifications are nudges the popup does not need, so a browser (or
// the test sandbox) without the API loses nothing; the guards keep every path from throwing.
async function setBadge(on) {
  const api = browser.action;
  if (!api || typeof api.setBadgeText !== "function") return;
  try {
    if (on && typeof api.setBadgeBackgroundColor === "function") await api.setBadgeBackgroundColor({ color: BADGE_COLOR });
    await api.setBadgeText({ text: on ? "1" : "" });
  } catch (err) {
    /* no badge on this browser */
  }
}

// The badge follows the versions alone: a release newer than the server, whether or not the
// server can do anything about it, or newer than the extension.
function applyBadge(decision) {
  return setBadge(["newer", "cannot", "behind"].includes(decision.server) || decision.extension === "newer");
}

async function notify(id, title, message) {
  const api = browser.notifications;
  if (!api || typeof api.create !== "function") return false;
  try {
    await api.create(id, { type: "basic", iconUrl: browser.runtime.getURL("icons/icon-128.png"), title, message });
    return true;
  } catch (err) {
    console.debug("Shisu-ko: notification failed:", err);
    return false;
  }
}

async function clearNotification(id) {
  const api = browser.notifications;
  if (!api || typeof api.clear !== "function") return;
  try {
    await api.clear(id);
  } catch (err) {
    /* already gone */
  }
}

// One notification per release and browser session: the version it was shown for sits in
// storage.session, which the browser clears when it closes, so the next session asks once more.
async function notifyNewer(latest, serverVersion) {
  if ((await sessionGet(NOTIFIED_KEY)) === latest) return false;
  await sessionSet(NOTIFIED_KEY, latest);
  return notify(UPDATE_NOTIFICATION, `Shisu-ko ${latest} is available`, `The server runs ${serverVersion}. Click to update it now.`);
}

let lastUpdate; // the update under way; undefined until storage.session has been read once

// The update under way, or null once its window has passed. The background is the only writer,
// so storage is read once per event page and memory serves the popup's poll from there.
async function pendingUpdate() {
  if (lastUpdate === undefined) {
    const stored = await sessionGet(UPDATE_KEY);
    lastUpdate = stored && typeof stored === "object" ? stored : null;
  }
  return lastUpdate && typeof lastUpdate.deadline === "number" && Date.now() < lastUpdate.deadline ? lastUpdate : null;
}

async function rememberUpdate(record) {
  lastUpdate = record;
  await sessionSet(UPDATE_KEY, record);
}

// Every /health answer passes here: the popup's poll is how the background follows an update it
// requested. Seeing the server down tells a restart apart from the old server still answering
// (it closes its port within a second of the answer), and so does the time since the request
// (UPDATE_SHUTDOWN_MS) when no poll ran while it was down; the new version ends the record, and
// the old version after a restart means update.py could not update, so the banner is back and
// the next request is posted rather than answered from a record of a restart that is over.
async function noteHealth(data) {
  try {
    const record = await pendingUpdate();
    if (!record) return;
    if (!data) {
      if (!record.down) await rememberUpdate(Object.assign({}, record, { down: true }));
      return;
    }
    const server = serverInfo(data);
    if (!server || !server.version) return;
    const updated = record.to ? compareVersions(server.version, record.to) >= 0 : server.version !== record.from;
    if (updated) {
      await rememberUpdate(null);
      const check = await readUpdateCheck();
      await applyBadge(decideUpdate({ latest: check && check.latest, serverVersion: server.version, serverLauncher: server.launcher, extensionVersion: extensionVersion(), serverOnline: true }));
      await notify(UPDATED_NOTIFICATION, `Shisu-ko updated to ${server.version}`, "The server restarted with the new version.");
    } else if (record.down || Date.now() - record.requestedAt >= UPDATE_SHUTDOWN_MS) {
      await rememberUpdate(null);
    }
  } catch (err) {
    console.debug("Shisu-ko: could not follow the update:", err);
  }
}

// The popup's question: what is newest, what the server runs, and what follows from the two.
// The popup hands over the /health answer it already has (`health`, null while offline) so the
// server is not asked twice; a caller without one gets a /health call here. `check` asks for a
// check when the stored one is a day old (the popup opening); otherwise the store is read.
async function updateStatus(msg) {
  const check = (msg && msg.check ? await checkForUpdate() : await readUpdateCheck()) || { checkedAt: null, latest: null, error: null };
  let health;
  if (msg && Object.hasOwn(msg, "health")) {
    health = msg.health && typeof msg.health === "object" ? msg.health : null;
  } else {
    const res = await apiRequest("/health");
    health = res.ok && res.data && typeof res.data === "object" ? res.data : null;
  }
  const server = serverInfo(health);
  const extension = extensionVersion();
  const decision = decideUpdate({
    latest: check.latest,
    serverVersion: server ? server.version : null,
    serverLauncher: server ? server.launcher : null,
    extensionVersion: extension,
    serverOnline: !!server,
  });
  await applyBadge(decision);
  // A server seen at the release no longer needs the update the notification offers; a viewer
  // who restarted run.cmd by hand would otherwise find the offer still up.
  if (decision.server === "current") await clearNotification(UPDATE_NOTIFICATION);
  const snoozed = await sessionGet(SNOOZE_KEY);
  return {
    latest: check.latest || null,
    checkedAt: typeof check.checkedAt === "number" ? check.checkedAt : null,
    error: typeof check.error === "string" && check.error ? check.error : null,
    server,
    decision,
    snoozed: typeof snoozed === "string" ? snoozed : null,
    updating: await pendingUpdate(),
    extensionVersion: extension,
  };
}

async function snoozeUpdate(version) {
  if (typeof version !== "string" || !version) return { ok: false, error: "No version to snooze" };
  await sessionSet(SNOOZE_KEY, version);
  return { ok: true };
}

let updateInFlight = null; // the request under way, shared by the popup and the notification

// Ask the server to update itself, once: overlapping requests share one answer, and a request
// while an update is under way is answered from its record. Resolves {ok: true, restarting: true,
// from, to, requestedAt, deadline} or {ok: false, error, refused, offline}; it never rejects.
// `refused` marks the server's own verdict (409: not started by the launcher, or --no-update).
function updateServer(opts) {
  if (!updateInFlight) {
    updateInFlight = requestUpdate().finally(() => {
      updateInFlight = null;
    });
    if (opts && opts.watch) {
      updateInFlight.then((res) => {
        if (res.ok && !res.already) return watchUpdate();
        return undefined;
      }).catch(() => {});
    }
  }
  return updateInFlight;
}

async function requestUpdate() {
  // /health first: its answer passes through noteHealth(), which ends a record whose restart is
  // over (the old version back, or the new one up), so the pending check below sees the truth.
  const healthRes = await apiRequest("/health");
  const pending = await pendingUpdate();
  if (pending) return { ok: true, restarting: true, already: true, from: pending.from, to: pending.to, requestedAt: pending.requestedAt, deadline: pending.deadline };
  const check = await readUpdateCheck();
  const to = check && check.latest && typeof check.latest.version === "string" ? check.latest.version : null;
  const server = serverInfo(healthRes.ok ? healthRes.data : null);
  const from = server ? server.version : null;
  // The notification can be clicked long after the server was updated another way: nothing to
  // post, and nothing failed either, which `upToDate` tells the click apart from a refusal.
  if (from && to && compareVersions(from, to) >= 0) return { ok: false, upToDate: true, error: `the server already runs ${from}` };
  const res = await apiRequest("/update", {});
  if (!res.ok) {
    return { ok: false, error: res.error || "the server refused", refused: !res.offline && !!(res.data && res.data.error), offline: !!res.offline };
  }
  if (!res.data || res.data.restarting !== true) return { ok: false, error: "the server gave no answer" };
  const requestedAt = Date.now();
  const record = { requestedAt, from, to, deadline: requestedAt + UPDATE_WINDOW_MS, down: false };
  await rememberUpdate(record);
  await clearNotification(UPDATE_NOTIFICATION);
  return { ok: true, restarting: true, from, to, requestedAt, deadline: record.deadline };
}

// Poll /health for an update nobody watches from a popup; noteHealth() ends the record. Best
// effort: the browser may end an idle event page first, and the next popup catches up.
async function watchUpdate() {
  for (let i = 0; i < UPDATE_WINDOW_MS / UPDATE_POLL_MS; i++) {
    await sleep(UPDATE_POLL_MS);
    if (!(await pendingUpdate())) return;
    await apiRequest("/health");
  }
}

// The browser starting, or the extension installed or updated: check (from the store when it is
// fresh), set the badge, and say so once when the server could update itself right now. A
// profile that has never checked is left alone: its first check is the popup's, which every
// viewer opens to set the server up, and a fresh profile then makes no request on its own. That
// keeps scripts/browser-smoke.mjs, which loads the built extension into a fresh Chromium profile
// with local fixtures only, off api.github.com at install and start; the popup it opens honours a
// stored check (`updateCheck` with a fresh `checkedAt`), which the test can seed with its settings.
async function startupCheck() {
  try {
    if (!(await readUpdateCheck())) return;
    const status = await updateStatus({ check: true });
    if (status.decision.server === "newer" && status.latest && status.server) {
      await notifyNewer(status.latest.version, status.server.version);
    }
  } catch (err) {
    console.debug("Shisu-ko: update check at start failed:", err);
  }
}

for (const event of [browser.runtime.onStartup, browser.runtime.onInstalled]) {
  if (event && typeof event.addListener === "function") event.addListener(() => startupCheck());
}

if (browser.notifications && browser.notifications.onClicked && typeof browser.notifications.onClicked.addListener === "function") {
  browser.notifications.onClicked.addListener((id) => {
    if (id !== UPDATE_NOTIFICATION) return undefined;
    clearNotification(id);
    // The click asked for something and has no popup to answer in, so a request that did not
    // get through says so here: the notification would otherwise just vanish as if it had
    // worked. Checks stay silent; this is the one path the viewer set off. A server already at
    // the release (updated another way while the notification sat there) is no failure: the
    // stale notification is gone with the clear above, and that is all there was to do.
    return updateServer({ watch: true })
      .then((res) => (res.ok || res.upToDate ? undefined : notify(UPDATE_FAILED_NOTIFICATION, "Shisu-ko could not update the server", String(res.error || "the server gave no answer"))))
      .catch(() => {});
  });
}

// ------------------------------------------------------------------ mining helpers

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// `attempts` is 1 for pre-mining: nobody is waiting, and the next sentence will ask again anyway.
// A mine the viewer can see keeps the four tries, so a clip that is still being decoded arrives.
async function fetchClip(settings, videoId, start, end, attempts) {
  const tries = Math.max(1, Number(attempts) || 4);
  const base = normalizeBase(settings.serverUrl, DEFAULT_SETTINGS.serverUrl);
  const format = settings.clipFormat === "wav" ? "wav" : "mp3";
  const url = `${base}/clip?video_id=${encodeURIComponent(videoId)}&start=${start.toFixed(3)}&end=${end.toFixed(3)}&format=${format}`;
  for (let attempt = 0; attempt < tries; attempt++) {
    // One deadline per attempt, over the request and its body: a connection that hangs instead
    // of failing would otherwise never settle, and neither would the mine waiting on it.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLIP_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.status === 503) {
        if (attempt + 1 >= tries) break;
        await sleep(1500);
        continue;
      }
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          message = (await res.json()).error || message;
        } catch (err) {
          /* keep the status text */
        }
        return { ok: false, error: message };
      }
      const mime = (res.headers.get("Content-Type") || "audio/mpeg").split(";")[0].trim();
      const buffer = await res.arrayBuffer();
      return { ok: true, base64: bytesToBase64(buffer), mime, ext: mime === "audio/wav" ? "wav" : "mp3" };
    } catch (err) {
      return { ok: false, error: err && err.name === "AbortError" ? "Whisper server timed out" : "Whisper server unreachable" };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: "The server is still fetching this video's audio, try again in a moment" };
}

// ------------------------------------------------------------------ pre-mined sentences

function base64Bytes(base64) {
  const text = String(base64 || "");
  if (!text) return 0;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  return Math.floor((text.length * 3) / 4) - padding;
}

function premineId(tabId, videoId, key) {
  return `${tabId}|${videoId}|${key}`;
}

// The clip the whole sentence needs, the one place that decides it. Pre-mining and mining must
// agree to the millisecond, or a cached clip would be thrown away for one exactly like it.
function clipParams(settings, sentence) {
  const pad = Math.max(0, Number(settings.clipPaddingMs) || 0) / 1000;
  const start = Math.max(0, sentence.start - pad);
  const end = Math.max(start + 0.3, sentence.end + pad);
  return { start, end, format: settings.clipFormat === "wav" ? "wav" : "mp3" };
}

function sameClip(a, b) {
  return !!a && !!b && a.format === b.format && a.start.toFixed(3) === b.start.toFixed(3) && a.end.toFixed(3) === b.end.toFixed(3);
}

function premineEntry(tabId, videoId, key) {
  if (key === undefined || key === null || !videoId) return null;
  return premined.get(premineId(tabId, videoId, key)) || null;
}

function tabEntries(tabId) {
  const list = [];
  for (const entry of premined.values()) if (entry.tabId === tabId) list.push(entry);
  return list;
}

// The oldest entry that may go: a pinned one (the sentence the viewer is hovering) is given up
// only when there is nothing else left.
function evictionVictim(entries) {
  let pick = null;
  for (const entry of entries) {
    if (entry.pinned) continue;
    if (!pick || entry.touched < pick.touched) pick = entry;
  }
  if (pick) return pick;
  for (const entry of entries) if (!pick || entry.touched < pick.touched) pick = entry;
  return pick;
}

function dropPremined(entry) {
  premined.delete(premineId(entry.tabId, entry.videoId, entry.key));
}

function evictPremined(tabId) {
  let mine = tabEntries(tabId);
  while (mine.length > PREMINE_PER_TAB) {
    const victim = evictionVictim(mine);
    if (!victim) break;
    dropPremined(victim);
    mine = tabEntries(tabId);
  }
  while (premined.size > PREMINE_TOTAL) {
    const victim = evictionVictim([...premined.values()]);
    if (!victim) break;
    dropPremined(victim);
  }
}

// What this tab holds, the sentence read last first and the ones only prepared ahead of their turn
// last, without the payloads: the content script only needs to know whether a sentence already
// has its image and its audio, and the order is its tie-break between two identical lines.
function heldFor(tabId) {
  return tabEntries(tabId)
    .sort((a, b) => b.seen - a.seen || b.touched - a.touched)
    .map((entry) => ({ key: entry.key, cueIds: entry.cueIds, image: !!entry.image, audio: !!entry.audio }));
}

function dropTabPremined(tabId) {
  for (const entry of tabEntries(tabId)) dropPremined(entry);
}

// Prepare a sentence: keep the frame the content script captured and start the one clip request
// this sentence gets. Nothing is awaited; the reply is the tab's inventory, so the content script
// knows what it no longer has to capture.
async function premineSentence(msg, tabId) {
  const videoId = String((msg && msg.videoId) || "");
  const key = msg ? msg.key : null;
  const sentence = msg && msg.sentence;
  if (!videoId || key === undefined || key === null) return { ok: false, error: "Nothing to pre-mine" };
  if (!sentence || typeof sentence.start !== "number" || typeof sentence.end !== "number") {
    return { ok: false, error: "Nothing to pre-mine" };
  }
  const settings = await getSettings();
  const id = premineId(tabId, videoId, key);
  let entry = premined.get(id);
  if (!entry) {
    entry = { tabId, videoId, key, cueIds: [], sentence: null, image: null, audio: null, clip: null, audioPromise: null, pinned: false, touched: 0, seen: 0 };
    premined.set(id, entry);
  }
  entry.touched = Date.now();
  // The next sentence's clip is asked for while this one plays (`ahead`): that sentence has not
  // been read yet, so it keeps its place behind the ones that have (heldFor above), or a card
  // that fits two identical lines would go to the line that has not played. `touched` still
  // counts for eviction: the material is as fresh either way.
  if (!msg.ahead) entry.seen = entry.touched;
  if (Array.isArray(msg.cueIds)) entry.cueIds = msg.cueIds.slice();
  entry.sentence = { start: sentence.start, end: sentence.end, text: String(sentence.text || "") };

  const dataUrl = typeof msg.imageDataUrl === "string" ? msg.imageDataUrl : "";
  const comma = dataUrl.indexOf(",");
  if (comma >= 0) {
    const base64 = dataUrl.slice(comma + 1);
    // A frame this large is a bug somewhere, not a screenshot; holding ten of them is not free.
    if (base64 && base64Bytes(base64) <= PREMINE_IMAGE_MAX_BYTES) entry.image = { base64 };
  }
  if (msg.hover) {
    // The hovered sentence is the one being looked up: it outlives everything else in this tab.
    for (const other of tabEntries(tabId)) other.pinned = other === entry;
  }
  if (!entry.audio && !entry.audioPromise) {
    const params = clipParams(settings, entry.sentence);
    entry.clip = params;
    entry.audioPromise = fetchClip(settings, videoId, params.start, params.end, 1)
      .then((clip) => {
        entry.audioPromise = null;
        if (!clip.ok || base64Bytes(clip.base64) > PREMINE_AUDIO_MAX_BYTES) return null;
        entry.audio = { base64: clip.base64, mime: clip.mime, ext: clip.ext };
        return entry.audio;
      })
      .catch(() => {
        entry.audioPromise = null;
        return null;
      });
  }
  evictPremined(tabId);
  return { ok: true, held: heldFor(tabId) };
}

async function anki(url, action, params, timeoutMs) {
  // No Content-Type header on purpose: a "simple" request needs no CORS preflight, which
  // matters for the very first requestPermission call from a not-yet-allowed origin.
  // requestPermission blocks until the viewer answers Anki's dialog, so the watcher gives it no
  // timeout; a mine, which the tab waits on, gives it a long one.
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, {
      method: "POST",
      body: JSON.stringify({ action, version: 6, params: params || {} }),
      signal: controller.signal,
    });
    const data = await res.json();
    if (data && data.error) throw new Error(data.error);
    return data ? data.result : null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Two spellings of the same sentence compare equal: Yomitan wraps the looked-up word in <b>, may
// use entities and furigana brackets, and Whisper's spacing and punctuation need not match.
function normalizeSentence(text) {
  return SHISUKO_MATCH.normalize(text); // from match.js
}

// The spoken sentence the mined cue belongs to, as the content script joined it. An older content
// script, or a cue the server did not group, mines the cue on its own.
function sentenceOf(msg) {
  const cue = (msg && msg.cue) || {};
  const s = msg && msg.sentence;
  if (s && typeof s.start === "number" && typeof s.end === "number" && s.end > s.start) {
    return { start: s.start, end: s.end, text: typeof s.text === "string" && s.text ? s.text : cue.text };
  }
  return { start: cue.start, end: cue.end, text: cue.text };
}

// A field is HTML to Anki's reviewer, and a transcription is text: "1<2" or "A&B" written as it
// is would lose characters on the card, and the server, which the viewer names by URL, could put
// markup, or a script, into the collection through it. The overlay shows the same text through
// textContent; this is the one place it is written into HTML.
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Yomitan copies the sentence from the one cue it scanned, so the card keeps a fragment of what was
// said. Give it the whole sentence instead, carrying Yomitan's <b> around the looked-up word across.
// Returns null when there is nothing to extend: unrelated text, or the sentence is already there.
function extendSentenceField(existing, full) {
  const text = String(full || "");
  const have = normalizeSentence(existing);
  const want = normalizeSentence(text);
  if (!have || !want || have.length >= want.length || !want.includes(have)) return null;
  const bold = (/<b[^>]*>([\s\S]*?)<\/b>/i.exec(String(existing)) || [])[1];
  const word = normalizeSentence(bold || "");
  const at = word ? text.indexOf(word) : -1;
  if (at < 0) return escapeHtml(text);
  return escapeHtml(text.slice(0, at)) + "<b>" + escapeHtml(word) + "</b>" + escapeHtml(text.slice(at + word.length));
}

// The two fields that say what a card is about. The word is whatever the viewer configured, else
// the note's first field, which is where every Yomitan template puts the expression.
function noteSummary(info, settings) {
  const fields = (info && info.fields) || {};
  const read = (name) => String((fields[name] && fields[name].value) || "").trim();
  const sentenceName = String(settings.ankiSentenceField || "").trim() || "Sentence";
  const wordName = String(settings.ankiWordField || "").trim();
  let word = "";
  if (wordName) {
    word = read(wordName);
  } else {
    for (const value of Object.values(fields)) {
      if (value && Number(value.order) === 0) {
        word = String(value.value || "").trim();
        break;
      }
    }
  }
  return { sentence: read(sentenceName), word };
}

// `permissionAskAt` is when the next request may go: a minute after a verdict, a few seconds
// after none (ANKI_PERMISSION_RECHECK_MS / ANKI_PERMISSION_RETRY_MS).
async function ankiPermission(url) {
  if (ankiWatch.permission === "granted") return true;
  const now = Date.now();
  if (now < ankiWatch.permissionAskAt) return false;
  // Set before the request: it blocks on Anki's dialog, and the polls landing meanwhile must
  // not each queue a dialog of their own.
  ankiWatch.permissionAskAt = now + ANKI_PERMISSION_RECHECK_MS;
  let perm;
  try {
    perm = await anki(url, "requestPermission", {});
  } catch (err) {
    // No verdict came (Anki not running, or still starting). The minute's wait is for a viewer
    // who clicked No; here it would turn Anki's absence into a minute of "denied" during which
    // a card it makes is never looked at. A few seconds instead: Anki is noticed soon after it
    // starts, and a closed Anki costs a refused connection every few seconds, not every poll.
    ankiWatch.permissionAskAt = now + ANKI_PERMISSION_RETRY_MS;
    throw err;
  }
  ankiWatch.permission = (perm && perm.permission) || "denied";
  return ankiWatch.permission === "granted";
}

// The oldest note on the ledger this tab has not been given yet, or null. Every note is answered
// once per tab (the ledger is a list: two cards made from one line while their tab was mining
// the card before must both reach it, one per poll), and `replayed` tells the content script
// that the note may be another tab's: a line of its own that matches the card's sentence is
// its only reason to act on it. A note a mine is writing into right now (`mine`, see mineCue())
// is handed to nobody: the tab that found it is mid-mine for seconds (the clip, the Anki round
// trips) when the other tab's tick lands, and two tabs on one video, or on two sharing the
// line, would both match, and the later write would put its frame and clip on the card. A mine
// that wrote nothing gives the note back; one that wrote keeps it from every tab (`written`).
function replayReport(tabId, now) {
  ankiWatch.reports = ankiWatch.reports.filter((report) => now - report.at <= ANKI_REPORT_WINDOW_MS);
  const report = ankiWatch.reports.find((entry) => !entry.mine && !entry.written && !entry.tabs.includes(tabId));
  if (!report) return null;
  report.tabs.push(tabId);
  return { ok: true, newNoteId: report.id, note: report.note, replayed: true };
}

function reportFor(noteId) {
  const id = Number(noteId);
  return ankiWatch.reports.find((report) => report.id === id) || null;
}

// A note written into is nobody else's to attach to, whether an automatic mine or Alt+Shift+M
// in another tab wrote it: a tab polling afterwards is not handed a card that has its material,
// and a mine for it from a tab handed the card before (mineCue()) writes nothing. The entry
// stays on the ledger, marked, until the window drops it: that is how such a mine learns.
function forgetReport(noteId) {
  const report = reportFor(noteId);
  if (report) report.written = true;
}

// Report a note that appeared since the previous poll. Reports nothing whenever the baseline could
// be stale (first poll, previous poll failed, long gap) or when several notes arrived at once, so a
// card added while Anki was closed, or an import, is never touched. `tabId` is the asking tab:
// the baseline is shared, so a note is put on the ledger and answered to every tab that polls
// within the window.
async function ankiPoll(tabId) {
  const settings = await getSettings();
  if (!settings.autoMine || settings.mineTarget !== "anki") return { ok: true, newNoteId: null };
  const now = Date.now();
  // Before the throttle: the other tab's tick may land inside it, and this answer needs no request.
  const replay = replayReport(tabId, now);
  if (replay) return replay;
  const previousPollAt = ankiWatch.lastPollAt;
  if (now - previousPollAt < ANKI_POLL_THROTTLE_MS) return { ok: true, newNoteId: null };
  ankiWatch.lastPollAt = now;
  const url = normalizeBase(settings.ankiUrl, DEFAULT_SETTINGS.ankiUrl);
  try {
    if (!(await ankiPermission(url))) {
      ankiWatch.lastOk = false;
      // No verdict yet: the last request threw, and the next is a few seconds away.
      if (ankiWatch.permission === null) return { ok: false, offline: true, error: "Anki is not running or AnkiConnect is not installed" };
      return { ok: false, error: "AnkiConnect denied access. Click Yes in Anki's permission dialog." };
    }
    const ids = await anki(url, "findNotes", { query: "added:1" }, ANKI_POLL_TIMEOUT_MS);
    const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isFinite);
    const maxId = list.length ? Math.max(...list) : 0;
    const baseline = ankiWatch.baseline;
    const stale = baseline === null || !ankiWatch.lastOk || now - previousPollAt > ANKI_BASELINE_MAX_AGE_MS;
    ankiWatch.lastOk = true;
    if (stale || maxId > baseline) ankiWatch.baseline = maxId;
    if (stale || maxId <= baseline) return { ok: true, newNoteId: null };
    const added = list.filter((id) => id > baseline);
    if (added.length !== 1) return { ok: true, newNoteId: null };
    // What the card says is how the content script finds the line it came from. A note that
    // cannot be read is still reported: the content script then falls back to the playhead.
    let note = null;
    try {
      const infos = await anki(url, "notesInfo", { notes: [maxId] }, ANKI_POLL_TIMEOUT_MS);
      note = noteSummary(infos && infos[0], settings);
    } catch (err) {
      note = null;
    }
    // Only a card whose sentence says which line it is about goes on the ledger for the other
    // tabs: they match by sentence. One with a word alone would be attached by every tab whose
    // lines hold the word, one that could not be read would be attached the playhead of every
    // tab, and one whose sentence is a few characters (ANKI_REPORT_MIN_CHARS) is in the lines of
    // every video; such a card goes to the tab that found it, as it did before there was a ledger.
    if (note && SHISUKO_MATCH.normalize(note.sentence).length >= ANKI_REPORT_MIN_CHARS) {
      ankiWatch.reports.push({ id: maxId, note, at: now, tabs: [tabId], mine: null, written: false });
    }
    return { ok: true, newNoteId: maxId, note };
  } catch (err) {
    ankiWatch.lastOk = false;
    const network = err && err.name === "TypeError";
    return {
      ok: false,
      offline: true,
      error: network ? "Anki is not running or AnkiConnect is not installed" : String((err && err.message) || err),
    };
  }
}

// Anki may rename an uploaded file (recent versions lowercase it, and clashes get a suffix), so the
// field must reference the name storeMediaFile reports, not the one we asked for.
async function storeMedia(url, filename, base64) {
  const stored = await anki(url, "storeMediaFile", { filename, data: base64 }, ANKI_REQUEST_TIMEOUT_MS);
  return typeof stored === "string" && stored ? stored : filename;
}

async function addToAnki(settings, cue, image, audio, explicitNoteId, fullSentence) {
  const url = normalizeBase(settings.ankiUrl, DEFAULT_SETTINGS.ankiUrl);
  const wanted = Number(explicitNoteId);
  const targetId = Number.isFinite(wanted) && wanted > 0 ? wanted : null;
  const what = targetId === null ? "newest" : "new";
  try {
    const perm = await anki(url, "requestPermission", {}, ANKI_PERMISSION_TIMEOUT_MS);
    if (!perm || perm.permission !== "granted") {
      return { ok: false, error: "AnkiConnect denied access. Click Yes in Anki's permission dialog, then mine again." };
    }
    let noteId = targetId;
    if (noteId === null) {
      const ids = await anki(url, "findNotes", { query: "added:1" }, ANKI_REQUEST_TIMEOUT_MS);
      if (!Array.isArray(ids) || !ids.length) {
        return { ok: false, error: "No card was added today. Create the card with Yomitan first, then mine." };
      }
      noteId = Math.max(...ids);
    }
    const infos = await anki(url, "notesInfo", { notes: [noteId] }, ANKI_REQUEST_TIMEOUT_MS);
    const fields = (infos && infos[0] && infos[0].fields) || {};
    const sentence = fullSentence && fullSentence.text ? fullSentence : { text: cue.text };
    if (targetId !== null) {
      // The note was picked by id, not by the viewer: make sure it really is about this subtitle
      // before writing media into it.
      const guardName = String(settings.ankiSentenceField || "").trim() || "Sentence";
      const written = normalizeSentence((fields[guardName] && fields[guardName].value) || "");
      const spoken = normalizeSentence(sentence.text) || normalizeSentence(cue.text);
      // The card and the subtitle rarely agree word for word: Yomitan's sentence can stop short of
      // the cue, run past it, or carry furigana. The better of the two readings of what was said
      // has to clear the same bar the content script used to pick this cue.
      const best = Math.max(SHISUKO_MATCH.similarity(written, sentence.text), SHISUKO_MATCH.similarity(written, cue.text));
      if (written && spoken && best < SHISUKO_MATCH.MIN_SIMILARITY) {
        return { ok: false, mismatch: true, error: "The new card's sentence does not match the subtitle; nothing attached" };
      }
    }
    const update = {};
    const missing = [];
    if (image) {
      if (settings.ankiImageField in fields) {
        const stored = await storeMedia(url, image.filename, image.base64);
        update[settings.ankiImageField] = `<img src="${stored}">`;
      } else {
        missing.push(settings.ankiImageField);
      }
    }
    if (audio) {
      if (settings.ankiAudioField in fields) {
        const stored = await storeMedia(url, audio.filename, audio.base64);
        update[settings.ankiAudioField] = `[sound:${stored}]`;
      } else {
        missing.push(settings.ankiAudioField);
      }
    }
    // Same field the guard above reads: whoever holds the sentence gets the whole sentence.
    const sentenceField = String(settings.ankiSentenceField || "").trim();
    const fieldName = sentenceField || "Sentence";
    let extended = false;
    if (fieldName in fields) {
      const existing = String((fields[fieldName] && fields[fieldName].value) || "").trim();
      if (!existing) {
        // Filling an unconfigured field was never this add-on's business; only extending is.
        if (sentenceField) update[fieldName] = escapeHtml(sentence.text);
      } else {
        const grown = extendSentenceField(existing, sentence.text);
        if (grown !== null) {
          update[fieldName] = grown;
          extended = true;
        }
      }
    }
    if (!Object.keys(update).length) {
      return { ok: false, error: `The ${what} card has none of the fields ${missing.join(", ")}. Check the field names in the popup.` };
    }
    await anki(url, "updateNoteFields", { note: { id: noteId, fields: update } }, ANKI_REQUEST_TIMEOUT_MS);
    let message = `Added ${Object.keys(update).join(" + ")} to the ${what} Anki card`;
    if (extended) message += " (sentence extended to what was spoken)";
    if (missing.length) message += ` (no field named ${missing.join(", ")})`;
    return { ok: true, target: "anki", noteId, message };
  } catch (err) {
    if (err && err.name === "AbortError") {
      return { ok: false, error: "AnkiConnect did not answer in time (a permission dialog in Anki may be waiting)" };
    }
    const network = err && err.name === "TypeError";
    return { ok: false, error: network ? "Anki is not running or AnkiConnect is not installed" : String((err && err.message) || err) };
  }
}

// Firefox refuses data: URLs in downloads.download ("Access denied for URL data:...", bug
// 1622986), so the bytes go through a Blob and an object URL created here in the background,
// which the extension principal owns. The URL is revoked once the download has finished.
function base64ToBlob(base64, mime) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

const OBJECT_URL_TTL_MS = 120000;

async function downloadBlob(blob, filename) {
  // MV3 service workers do not expose URL.createObjectURL. Chrome accepts a
  // data URL for downloads, while Firefox requires the extension-owned object
  // URL below (Firefox rejects data URLs in downloads.download).
  if (/^chrome-extension:/.test(browser.runtime.getURL(""))) {
    const url = `data:${blob.type || "application/octet-stream"};base64,${bytesToBase64(await blob.arrayBuffer())}`;
    return browser.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false });
  }
  const url = URL.createObjectURL(blob);
  let release = () => {
    release = () => {};
    URL.revokeObjectURL(url);
  };
  const timer = setTimeout(() => release(), OBJECT_URL_TTL_MS);
  try {
    const id = await browser.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false });
    const onChanged = (delta) => {
      if (delta.id !== id || !delta.state) return;
      const state = delta.state.current;
      if (state === "complete" || state === "interrupted") {
        browser.downloads.onChanged.removeListener(onChanged);
        clearTimeout(timer);
        release();
      }
    };
    browser.downloads.onChanged.addListener(onChanged);
    return id;
  } catch (err) {
    clearTimeout(timer);
    release();
    throw err;
  }
}

async function downloadFiles(image, audio) {
  const jobs = [];
  const names = [];
  if (image) {
    names.push(image.filename);
    jobs.push(downloadBlob(base64ToBlob(image.base64, "image/jpeg"), "shisu-ko-mining/" + image.filename));
  }
  if (audio) {
    names.push(audio.filename);
    jobs.push(downloadBlob(base64ToBlob(audio.base64, audio.mime), "shisu-ko-mining/" + audio.filename));
  }
  if (!jobs.length) return { ok: false, error: "Nothing to save" };
  try {
    await Promise.all(jobs);
    return { ok: true, target: "download", message: `Saved ${names.join(" and ")} to Downloads/shisu-ko-mining` };
  } catch (err) {
    return { ok: false, error: "Download failed: " + String((err && err.message) || err) };
  }
}

// The clip and the frame this sentence was pre-mined with, when they are still the ones wanted.
// A setting the viewer changed since (padding, format) makes the held clip the wrong clip.
async function cachedClip(entry, params) {
  if (!entry || !sameClip(entry.clip, params)) return null;
  if (entry.audio) return entry.audio;
  if (entry.audioPromise) return (await entry.audioPromise) || null;
  return null;
}

// A mine into a note on the ledger holds the note while it runs (replayReport() hands it to no
// other tab). A second mine for it, from a tab handed the note before the first began (its
// poll landed first, or it was paused and seeking back for its frame), waits for the first and
// writes only when that one wrote nothing: two writes into one card, from two tabs on one video
// or on two sharing a line, would leave it with the later tab's frame and clip. Alt+Shift+M
// carries no note id and is the viewer's own business.
async function mineCue(msg, tabId) {
  const report = reportFor(msg && msg.noteId);
  if (!report) return mineCueNow(msg, tabId);
  while (report.mine) await report.mine.catch(() => {});
  if (report.written) {
    return { ok: true, target: "anki", noteId: report.id, warning: true, message: "The new card was attached in another tab" };
  }
  report.mine = mineCueNow(msg, tabId);
  try {
    return await report.mine;
  } finally {
    report.mine = null;
  }
}

async function mineCueNow(msg, tabId) {
  const settings = await getSettings();
  const cue = msg && msg.cue;
  if (!cue || typeof cue.start !== "number" || typeof cue.end !== "number") {
    return { ok: false, error: "No subtitle to mine" };
  }
  // The clip covers the whole sentence the cue belongs to; the file name still marks the cue.
  const sentence = sentenceOf(msg);
  const params = clipParams(settings, sentence);
  const base = `shisuko_${msg.videoId}_${Math.round(cue.start * 1000)}`;
  const entry = premineEntry(tabId, msg.videoId, msg.key);

  // A frame sent with the message beats the pre-mined one: the content script only sends one when
  // it knows better, and the pre-mined frame is there for when it has none.
  const sentImage = msg.imageDataUrl && msg.imageDataUrl.includes(",") ? msg.imageDataUrl.split(",")[1] : null;
  const imageBase64 = sentImage || (entry && entry.image ? entry.image.base64 : null);
  const image = imageBase64 ? { base64: imageBase64, filename: `${base}.jpg` } : null;

  let clip = await cachedClip(entry, params);
  if (clip) clip = { ok: true, base64: clip.base64, mime: clip.mime, ext: clip.ext };
  else {
    clip = await fetchClip(settings, msg.videoId, params.start, params.end);
    // A second word from the same sentence must not fetch the clip again.
    if (clip.ok && entry) {
      entry.clip = params;
      entry.audio = { base64: clip.base64, mime: clip.mime, ext: clip.ext };
      entry.touched = Date.now();
    }
  }
  const audio = clip.ok ? { base64: clip.base64, filename: `${base}.${clip.ext}`, mime: clip.mime } : null;
  if (!image && !audio) {
    return { ok: false, error: clip.error || "Neither screenshot nor audio could be captured" };
  }
  const warnings = [];
  if (!audio) warnings.push(`no audio (${clip.error})`);
  if (!image) warnings.push("no screenshot (blocked for this video)");

  let result;
  if (settings.mineTarget === "anki") {
    result = await addToAnki(settings, cue, image, audio, msg.noteId, sentence);
    // The card has its material: off the ledger the Anki watch keeps for the other tabs.
    if (result.ok) forgetReport(result.noteId);
    // Automatic mining never writes files: a failure the viewer did not ask for must stay quiet.
    if (!result.ok && !msg.auto && settings.mineFallbackDownload) {
      const fallback = await downloadFiles(image, audio);
      if (fallback.ok) {
        fallback.message = `Anki: ${result.error} Saved to Downloads instead.`;
        fallback.warning = true;
      }
      result = fallback;
    }
  } else {
    result = await downloadFiles(image, audio);
  }
  if (result.ok && warnings.length) result.message += ` (${warnings.join("; ")})`;
  return result;
}

// ------------------------------------------------------------------ messaging

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg !== "object") return undefined;
  // Pre-mined material belongs to the tab that captured it; the popup (no tab) gets -1 and holds none.
  const tabId = sender && sender.tab && typeof sender.tab.id === "number" ? sender.tab.id : -1;
  switch (msg.type) {
    case "api": {
      if (msg.path === "/sync" && tabId >= 0) {
        const now = Date.now();
        syncers.set(tabId, { at: now, paused: !!(msg.body && msg.body.paused) });
        holder = electSyncTab(tabId, holder, focusedTabId(), syncers, now);
        // Standing by is not an error: the tab keeps its overlay and its status line, and asks
        // again on the next tick, which is what makes taking over immediate.
        if (holder !== tabId) return Promise.resolve({ ok: true, data: { status: "standby" } });
      }
      return apiRequest(msg.path, msg.body);
    }
    case "getSettings":
      return getSettings();
    case "saveSettings":
      return saveSettings(msg.settings);
    case "mine":
      return mineCue(msg, tabId);
    case "premine":
      return premineSentence(msg, tabId);
    case "premineReset":
      dropTabPremined(tabId);
      return Promise.resolve({ ok: true });
    case "ankiPoll":
      return ankiPoll(tabId);
    case "startServer":
      return startServer();
    case "startServerStatus":
      return startStatus();
    case "updateStatus":
      return updateStatus(msg);
    case "checkForUpdate":
      return checkForUpdate({ force: !!msg.force });
    case "updateServer":
      return updateServer();
    case "snoozeUpdate":
      return snoozeUpdate(msg.version);
    default:
      return undefined;
  }
});

// A closed tab can never mine what it prepared, nor keep the right to sync.
browser.tabs.onRemoved.addListener((tabId) => {
  dropTabPremined(tabId);
  syncers.delete(tabId);
  for (const [windowId, id] of activeTabs) if (id === tabId) activeTabs.delete(windowId);
  if (holder === tabId) holder = null;
});

browser.commands.onCommand.addListener(async (name) => {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    browser.tabs.sendMessage(tab.id, { type: "command", name }).catch(() => {});
  }
});

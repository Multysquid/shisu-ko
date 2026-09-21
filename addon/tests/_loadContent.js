"use strict";

// addon/content.js wraps everything in an IIFE and exports nothing: nothing of ours may leak into
// youtube.com's page. To reach its pure helpers the source is rewritten for the test run so that the
// same IIFE returns them, and then executed in a `vm` sandbox with the handful of browser globals it
// touches while loading. The rewrite is checked, not assumed: if the file's shape changes the
// harness throws instead of quietly testing nothing.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SETTINGS_PATH = path.join(__dirname, "..", "settings.js");
const MATCH_PATH = path.join(__dirname, "..", "match.js");
const SOURCE_PATH = path.join(__dirname, "..", "content.js");

const OPEN = "(() => {";
const CLOSE = "})();";
const EXPORTS =
  "  return { state, shouldSync, coveredRange, coveredEnd, findActiveCue, jumpTarget, sentenceForCue, nextSentence, rankOfCue," +
  " premineAllowed, premineNow, captureHoverFrame, autoAnkiMining, resetPremine, getVideoIdFromUrl, mergeCues, cueById, ankiPollAllowed," +
  " currentCueForMining, liveClock, updateLiveClock, playhead, seekPlayhead, onKeyDown, onMineClick, onTranscriptClick, onSubtitleEnter," +
  " onSubtitleLeave, onPlayerMouseMove, modelForSync, fontStack, sync, onVideoChanged, setSubtitle, updateStatus, statusText, isShortsUrl," +
  " startTimeFromUrl, findPlayer, discover, pollForNewCard, autoMine, onTranscriptLineEnter, onTranscriptLineLeave };\n";

function instrument(source) {
  const open = source.indexOf(OPEN);
  const close = source.lastIndexOf(CLOSE);
  if (open < 0 || close < open) throw new Error(`content.js no longer wraps its body in ${OPEN} ... ${CLOSE}`);
  return (
    source.slice(0, open) +
    "globalThis.__shisukoExports = " +
    source.slice(open, close) +
    EXPORTS +
    source.slice(close)
  );
}

// Just enough of an element for the overlay code: classes, a child list that insertBefore,
// appendChild and replaceChildren keep in order (a fragment empties into its target the way a real
// one does), and for a canvas a context whose readback yields nothing, so no frame is ever encoded.
function stubElement(tag) {
  const classes = new Set();
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    isFragment: tag === "#fragment",
    children: [],
    parentNode: null,
    isConnected: true,
    dataset: {},
    style: { setProperty: () => {} },
    textContent: "",
    title: "",
    offsetTop: 0,
    offsetHeight: 0,
    clientHeight: 0,
    scrollTop: 0,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    setAttribute: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    contains: () => false,
    matches: () => false,
    closest: () => null,
    appendChild: (node) => el.insertBefore(node, null),
    insertBefore: (node, ref) => {
      const at = ref ? el.children.indexOf(ref) : el.children.length;
      if (at < 0) throw new Error("insertBefore: the reference node is not a child");
      const nodes = node.isFragment ? node.children.splice(0) : [node];
      for (const n of nodes) {
        if (n.parentNode) n.parentNode.removeChild(n);
        n.parentNode = el;
      }
      el.children.splice(at, 0, ...nodes);
      return node;
    },
    removeChild: (node) => {
      const at = el.children.indexOf(node);
      if (at >= 0) el.children.splice(at, 1);
      node.parentNode = null;
      return node;
    },
    replaceChildren: (...nodes) => {
      for (const c of el.children) c.parentNode = null;
      el.children = [];
      for (const n of nodes) el.appendChild(n);
    },
    remove: () => {
      if (el.parentNode) el.parentNode.removeChild(el);
    },
  };
  if (tag === "canvas") {
    el.getContext = () => ({ drawImage: () => {} });
    el.toBlob = (cb) => cb(null);
  }
  return el;
}

function loadContent(overrides = {}) {
  const sent = [];
  const storageListeners = []; // what content.js registered on browser.storage.onChanged
  const messageListeners = []; // and on browser.runtime.onMessage: the keyboard commands
  const sandbox = {
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    URL,
    Map,
    Set,
    Date,
    Promise,
    // attach() watches the player's size; a page with a player in it needs the observer to exist.
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    // The frame reader: a blob the canvas stub yields becomes a data URL, as in the page.
    FileReader: class {
      readAsDataURL(blob) {
        this.result = `data:image/jpeg;base64,${blob}`;
        Promise.resolve().then(() => this.onload && this.onload());
      }
    },
    window: { addEventListener: () => {}, removeEventListener: () => {} },
    location: { href: overrides.href || "https://www.youtube.com/watch?v=abcdef1234" },
    document: {
      documentElement: stubElement("html"),
      visibilityState: "visible",
      querySelector: () => null,
      addEventListener: () => {},
      createElement: (tag) => stubElement(tag),
      createDocumentFragment: () => stubElement("#fragment"),
    },
    browser: {
      runtime: {
        id: "shisu-ko@test",
        onMessage: { addListener: (fn) => messageListeners.push(fn) },
        sendMessage: async (msg) => {
          sent.push(msg);
          return msg.type === "getSettings" ? {} : { ok: true };
        },
      },
      storage: { onChanged: { addListener: (fn) => storageListeners.push(fn) } },
    },
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  new vm.Script(fs.readFileSync(SETTINGS_PATH, "utf8"), { filename: SETTINGS_PATH }).runInContext(sandbox);
  new vm.Script(fs.readFileSync(MATCH_PATH, "utf8"), { filename: MATCH_PATH }).runInContext(sandbox);
  new vm.Script(instrument(fs.readFileSync(SOURCE_PATH, "utf8")), { filename: SOURCE_PATH }).runInContext(sandbox);

  const api = sandbox.__shisukoExports;
  if (!api || typeof api.shouldSync !== "function") throw new Error("content.js did not hand the test harness its helpers");
  if (storageListeners.length !== 1) throw new Error(`content.js registered ${storageListeners.length} storage listeners, expected one`);
  if (messageListeners.length !== 1) throw new Error(`content.js registered ${messageListeners.length} message listeners, expected one`);
  return { api, sandbox, sent, onSettingsChanged: storageListeners[0], onCommand: messageListeners[0], stubElement };
}

module.exports = { loadContent, stubElement };

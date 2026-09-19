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
  "  return { state, shouldSync, coveredEnd, findActiveCue, jumpTarget, sentenceForCue, nextSentence, rankOfCue," +
  " premineAllowed, resetPremine, getVideoIdFromUrl, mergeCues, cueById, ankiPollAllowed, currentCueForMining, liveClock, updateLiveClock, playhead, seekPlayhead, onKeyDown };\n";

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

function stubElement() {
  const classes = new Set();
  return {
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
  };
}

function loadContent(overrides = {}) {
  const sent = [];
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
    window: { addEventListener: () => {}, removeEventListener: () => {} },
    location: { href: overrides.href || "https://www.youtube.com/watch?v=abcdef1234" },
    document: {
      documentElement: stubElement(),
      visibilityState: "visible",
      querySelector: () => null,
      addEventListener: () => {},
      createElement: () => stubElement(),
    },
    browser: {
      runtime: {
        id: "shisu-ko@test",
        onMessage: { addListener: () => {} },
        sendMessage: async (msg) => {
          sent.push(msg);
          return msg.type === "getSettings" ? {} : { ok: true };
        },
      },
      storage: { onChanged: { addListener: () => {} } },
    },
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  new vm.Script(fs.readFileSync(SETTINGS_PATH, "utf8"), { filename: SETTINGS_PATH }).runInContext(sandbox);
  new vm.Script(fs.readFileSync(MATCH_PATH, "utf8"), { filename: MATCH_PATH }).runInContext(sandbox);
  new vm.Script(instrument(fs.readFileSync(SOURCE_PATH, "utf8")), { filename: SOURCE_PATH }).runInContext(sandbox);

  const api = sandbox.__shisukoExports;
  if (!api || typeof api.shouldSync !== "function") throw new Error("content.js did not hand the test harness its helpers");
  return { api, sandbox, sent };
}

module.exports = { loadContent };

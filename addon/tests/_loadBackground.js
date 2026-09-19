"use strict";

// addon/background.js is a plain extension script (no exports): it expects a global `browser`
// WebExtension API and DOM globals like fetch/btoa. To unit-test its pure/mockable logic without
// Firefox, we run the file's source in a `vm` sandbox with those globals stubbed out. Top-level
// `function` declarations in script (non-module) code become properties of the global object even
// in strict mode, so the sandbox object ends up exposing normalizeBase, bytesToBase64, mineCue, etc.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SETTINGS_PATH = path.join(__dirname, "..", "settings.js");
const MATCH_PATH = path.join(__dirname, "..", "match.js");
const SOURCE_PATH = path.join(__dirname, "..", "background.js");

function makeMemoryStorage(initial) {
  let store = { ...(initial || {}) };
  return {
    async get(key) {
      if (key === undefined) return { ...store };
      return Object.prototype.hasOwnProperty.call(store, key) ? { [key]: store[key] } : {};
    },
    async set(patch) {
      store = { ...store, ...patch };
    },
    _dump() {
      return store;
    },
  };
}

// Minimal btoa: background.js only feeds it byte-string data built from Uint8Array.
function btoa(binary) {
  return Buffer.from(binary, "binary").toString("base64");
}

// background.js caches the settings and drops the cache when storage.onChanged reports a write, so
// the sandbox has to deliver that event the way Firefox does: after every storage.local.set.
function notifyingStorage(storage, listeners) {
  return {
    get: (key) => storage.get(key),
    async set(patch) {
      const before = await storage.get(undefined);
      await storage.set(patch);
      const changes = {};
      for (const key of Object.keys(patch)) changes[key] = { oldValue: before[key], newValue: patch[key] };
      for (const fn of listeners.onChanged.slice()) fn(changes, "local");
    },
  };
}

function loadBackground(overrides = {}) {
  const source = fs.readFileSync(SOURCE_PATH, "utf8");
  const storage = overrides.storage || makeMemoryStorage();
  const listeners = { onMessage: [], onCommand: [], onChanged: [], onTabRemoved: [] };

  const sandbox = {
    console,
    setTimeout: overrides.setTimeout || setTimeout,
    clearTimeout,
    AbortController,
    Uint8Array,
    btoa,
    atob: (b64) => Buffer.from(b64, "base64").toString("binary"),
    Blob,
    URL: {
      createObjectURL: overrides.createObjectURL || (() => "blob:moz-extension://test/" + Math.random().toString(16).slice(2)),
      revokeObjectURL: overrides.revokeObjectURL || (() => {}),
    },
    fetch: overrides.fetch || (async () => {
      throw new Error("fetch() was not mocked for this test");
    }),
    browser: {
      storage: {
        local: notifyingStorage(storage, listeners),
        onChanged: { addListener: (fn) => listeners.onChanged.push(fn) },
      },
      downloads: {
        download: overrides.download || (async () => 1),
        onChanged: { addListener: () => {}, removeListener: () => {} },
      },
      runtime: {
        getURL: () => overrides.runtimeURL || "moz-extension://test/",
        onMessage: { addListener: (fn) => listeners.onMessage.push(fn) },
      },
      commands: {
        onCommand: { addListener: (fn) => listeners.onCommand.push(fn) },
      },
      tabs: {
        query: async () => [],
        sendMessage: async () => {},
        onRemoved: { addListener: (fn) => listeners.onTabRemoved.push(fn) },
      },
    },
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  // settings.js defines SHISUKO_DEFAULT_SETTINGS in the shared global lexical scope, exactly as the
  // manifest loads it before background.js in Firefox.
  new vm.Script(fs.readFileSync(SETTINGS_PATH, "utf8"), { filename: SETTINGS_PATH }).runInContext(sandbox);
  // match.js sits between them in the manifest too: background.js reads SHISUKO_MATCH at load time.
  new vm.Script(fs.readFileSync(MATCH_PATH, "utf8"), { filename: MATCH_PATH }).runInContext(sandbox);
  new vm.Script(source, { filename: SOURCE_PATH }).runInContext(sandbox);
  // Top-level `const`/`let` (DEFAULT_SETTINGS, REQUEST_TIMEOUT_MS, sleep) live in the global
  // *lexical* environment, not as globalThis properties, but that environment is shared across
  // scripts run against the same context — so a second script can still see them by name and
  // copy them onto globalThis for the test harness to read.
  new vm.Script(
    "globalThis.DEFAULT_SETTINGS = DEFAULT_SETTINGS; globalThis.REQUEST_TIMEOUT_MS = REQUEST_TIMEOUT_MS;" +
      " globalThis.ankiWatch = ankiWatch; globalThis.premined = premined;",
    { filename: SOURCE_PATH }
  ).runInContext(sandbox);

  // Firefox hands every listener the sender as the second argument; the tab id in it is what
  // tells the pre-mine store whose material this is.
  function dispatch(msg, tabId) {
    const sender = tabId === undefined ? {} : { tab: { id: tabId } };
    for (const fn of listeners.onMessage) {
      const result = fn(msg, sender);
      if (result !== undefined) return result;
    }
    return undefined;
  }

  function closeTab(tabId) {
    for (const fn of listeners.onTabRemoved.slice()) fn(tabId, {});
  }

  return { sandbox, storage, listeners, dispatch, closeTab };
}

module.exports = { loadBackground, makeMemoryStorage };

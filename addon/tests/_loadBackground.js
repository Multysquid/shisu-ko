"use strict";

// addon/background.js is a plain extension script (no exports): it expects a global `browser`
// WebExtension API and DOM globals like fetch/btoa. To unit-test its pure/mockable logic without
// Firefox, we run the file's source in a `vm` sandbox with those globals stubbed out. Top-level
// `function` declarations in script (non-module) code become properties of the global object even
// in strict mode, so the sandbox object ends up exposing normalizeBase, bytesToBase64, mineCue, etc.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

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

function loadBackground(overrides = {}) {
  const source = fs.readFileSync(SOURCE_PATH, "utf8");
  const storage = overrides.storage || makeMemoryStorage();
  const listeners = { onMessage: [], onCommand: [] };

  const sandbox = {
    console,
    setTimeout: overrides.setTimeout || setTimeout,
    clearTimeout,
    AbortController,
    Uint8Array,
    btoa,
    fetch: overrides.fetch || (async () => {
      throw new Error("fetch() was not mocked for this test");
    }),
    browser: {
      storage: { local: storage },
      downloads: {
        download: overrides.download || (async () => ({})),
      },
      runtime: {
        onMessage: { addListener: (fn) => listeners.onMessage.push(fn) },
      },
      commands: {
        onCommand: { addListener: (fn) => listeners.onCommand.push(fn) },
      },
      tabs: {
        query: async () => [],
        sendMessage: async () => {},
      },
    },
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  new vm.Script(source, { filename: SOURCE_PATH }).runInContext(sandbox);
  // Top-level `const`/`let` (DEFAULT_SETTINGS, REQUEST_TIMEOUT_MS, sleep) live in the global
  // *lexical* environment, not as globalThis properties, but that environment is shared across
  // scripts run against the same context — so a second script can still see them by name and
  // copy them onto globalThis for the test harness to read.
  new vm.Script(
    "globalThis.DEFAULT_SETTINGS = DEFAULT_SETTINGS; globalThis.REQUEST_TIMEOUT_MS = REQUEST_TIMEOUT_MS;",
    { filename: SOURCE_PATH }
  ).runInContext(sandbox);

  return { sandbox, storage, listeners };
}

module.exports = { loadBackground, makeMemoryStorage };

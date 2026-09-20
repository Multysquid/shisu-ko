"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "browser-api.js"), "utf8");

function loadChrome() {
  const listeners = [];
  const calls = [];
  const chrome = {
    runtime: {
      lastError: null,
      getURL: () => "chrome-extension://test/",
      sendMessage(msg, callback) { calls.push(["sendMessage", msg]); callback({ echoed: msg }); },
      sendNativeMessage(application, msg, callback) { calls.push(["sendNativeMessage", application, msg]); callback({ ok: true, started: true }); },
      onMessage: { addListener(fn) { listeners.push(fn); } },
    },
    storage: { local: {
      get(key, callback) { callback({ [key]: 1 }); },
      set(value, callback) { callback(); },
    }, session: {
      get(key, callback) { calls.push(["session.get", key]); callback({ [key]: 2 }); },
      set(value, callback) { calls.push(["session.set", value]); callback(); },
    }, onChanged: {} },
    tabs: { query(q, callback) { callback([{ id: 7, q }]); }, reload(id, callback) { callback(); }, sendMessage(id, msg, callback) { callback({ id, msg }); } },
    permissions: { contains(_, callback) { callback(true); }, request(_, callback) { callback(false); } },
    downloads: { download(_, callback) { callback(12); }, onChanged: {} },
    commands: { onCommand: {} },
  };
  const sandbox = { chrome, console, Promise, globalThis: null };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(source).runInContext(sandbox);
  return { browser: sandbox.browser, chrome, listeners, calls };
}

test("Firefox browser namespace is preserved", () => {
  const native = { runtime: { getURL: () => "moz-extension://test/" } };
  const sandbox = { browser: native, globalThis: null };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(source).runInContext(sandbox);
  assert.equal(sandbox.browser, native);
});

test("content-script Chrome namespace does not assume privileged APIs exist", () => {
  const { chrome } = loadChrome();
  delete chrome.tabs;
  delete chrome.permissions;
  delete chrome.downloads;
  delete chrome.commands;
  const sandbox = { chrome, console, Promise, globalThis: null };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  assert.doesNotThrow(() => new vm.Script(source).runInContext(sandbox));
  assert.equal(sandbox.browser.tabs, undefined);
  assert.equal(sandbox.browser.downloads, undefined);
});

test("Chrome browser alias is bridged even when it is already present", async () => {
  const { browser, chrome } = loadChrome();
  const nativeAlias = { runtime: { getURL: () => "chrome-extension://test/" } };
  const sandbox = { browser: nativeAlias, chrome, console, Promise, globalThis: null };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(source).runInContext(sandbox);
  assert.notEqual(sandbox.browser, nativeAlias);
  assert.deepEqual(await sandbox.browser.runtime.sendMessage({ type: "ping" }), { echoed: { type: "ping" } });
});

test("Chrome callback APIs become promises", async () => {
  const { browser } = loadChrome();
  assert.deepEqual(await browser.runtime.sendMessage({ type: "ping" }), { echoed: { type: "ping" } });
  assert.deepEqual(await browser.tabs.query({ active: true }), [{ id: 7, q: { active: true } }]);
  assert.equal(await browser.permissions.contains({ origins: ["*"] }), true);
  assert.equal(await browser.downloads.download({ url: "data:x" }), 12);
});

test("Chrome storage.session is bridged like storage.local, and only where it exists", async () => {
  const { browser, chrome, calls } = loadChrome();
  assert.deepEqual(await browser.storage.session.get("startServer"), { startServer: 2 });
  assert.equal(await browser.storage.session.set({ startServer: null }), undefined);
  assert.deepEqual(calls.slice(-2), [["session.get", "startServer"], ["session.set", { startServer: null }]]);
  delete chrome.storage.session;
  const sandbox = { chrome, console, Promise, globalThis: null };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(source).runInContext(sandbox);
  assert.equal(sandbox.browser.storage.session, undefined);
  assert.equal(typeof sandbox.browser.storage.local.get, "function");
});

test("Chrome runtime.lastError rejects the promise", async () => {
  const { browser, chrome } = loadChrome();
  chrome.runtime.sendMessage = (_msg, callback) => {
    chrome.runtime.lastError = { message: "No receiver" };
    callback();
    chrome.runtime.lastError = null;
  };
  await assert.rejects(browser.runtime.sendMessage({}), /No receiver/);
});

test("runtime message bridge replies, envelopes errors, and leaves unknown messages alone", async () => {
  const { browser, listeners } = loadChrome();
  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === "ok") return Promise.resolve({ ok: true });
    if (msg.type === "bad") return Promise.reject(new Error("broken"));
  });
  const send = (msg) => new Promise((resolve) => {
    const claimed = listeners[0](msg, {}, resolve);
    if (claimed === undefined) resolve(undefined);
  });
  assert.deepEqual(await send({ type: "ok" }), { ok: true });
  assert.equal(JSON.stringify(await send({ type: "bad" })), JSON.stringify({ ok: false, error: "broken" }));
  assert.equal(await send({ type: "other" }), undefined);
});

test("runtime message bridge handles synchronous replies and throws", async () => {
  const { browser, listeners } = loadChrome();
  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === "sync") return { ok: true };
    if (msg.type === "throw") throw new Error("bad sync");
  });
  const send = (msg) => new Promise((resolve) => {
    const claimed = listeners[0](msg, {}, resolve);
    if (claimed === undefined) resolve(undefined);
  });
  assert.deepEqual(await send({ type: "sync" }), { ok: true });
  assert.equal(JSON.stringify(await send({ type: "throw" })), JSON.stringify({ ok: false, error: "bad sync" }));
});

test("Chrome sendNativeMessage is bridged to a promise, with lastError as a rejection", async () => {
  const { browser, chrome, calls } = loadChrome();
  assert.deepEqual(await browser.runtime.sendNativeMessage("shisuko", { cmd: "start" }), { ok: true, started: true });
  assert.deepEqual(calls.at(-1), ["sendNativeMessage", "shisuko", { cmd: "start" }]);
  chrome.runtime.sendNativeMessage = (_app, _msg, callback) => {
    chrome.runtime.lastError = { message: "Specified native messaging host not found." };
    callback();
    chrome.runtime.lastError = null;
  };
  // The bridge reads the chrome method at call time, so the swapped stub is what the wrapper runs.
  await assert.rejects(browser.runtime.sendNativeMessage("shisuko", { cmd: "start" }), /not found/);
});

test("a Chrome runtime without sendNativeMessage gets no wrapper for it", () => {
  const { chrome } = loadChrome();
  delete chrome.runtime.sendNativeMessage;
  const sandbox = { chrome, console, Promise, globalThis: null };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(source).runInContext(sandbox);
  assert.equal(typeof sandbox.browser.runtime.sendNativeMessage, "undefined");
  assert.equal(typeof sandbox.browser.permissions.request, "function");
});

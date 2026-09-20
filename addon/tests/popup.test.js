"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const ADDON = path.join(__dirname, "..");

// The start flow of popup.js, driven without Firefox. popup.js paints a handful of elements by id;
// the fake document hands out one plain object per id with the members the status line and the
// hints touch, and a test reads the badge, the detail and the button back from it.
function fakeElement() {
  const el = { textContent: "", className: "", disabled: false, hidden: false, value: "", placeholder: "", style: {}, options: [] };
  el.classList = {
    toggle: (name, force) => {
      if (name === "hidden") el.hidden = !!force;
    },
    add: () => {},
    remove: () => {},
  };
  el.addEventListener = () => {};
  return el;
}

// `answer` plays the background: it gets every runtime.sendMessage and returns the reply. The
// popup runs as Firefox's unless `runtimeURL` says otherwise: the button is for Firefox alone.
function loadPopup(answer, runtimeURL = "moz-extension://test/") {
  const elements = new Map();
  const document = {
    addEventListener: () => {},
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, fakeElement());
      return elements.get(id);
    },
    createElement: () => fakeElement(),
    body: { classList: { toggle: () => {} } },
  };
  const sandbox = {
    document,
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    browser: {
      runtime: { sendMessage: async (msg) => answer(msg), getURL: () => runtimeURL },
      permissions: { contains: async () => true, request: async () => true },
      tabs: { query: async () => [] },
    },
  };
  vm.createContext(sandbox);
  new vm.Script(fs.readFileSync(path.join(ADDON, "settings.js"), "utf8")).runInContext(sandbox);
  new vm.Script(fs.readFileSync(path.join(ADDON, "popup.js"), "utf8"), { filename: "popup.js" }).runInContext(sandbox);
  const api = new vm.Script("({ startFlow, resumeStart, checkServer, startServerFromPopup, startNotUpHint, START_NOT_UP_HINT, START_ELSEWHERE_HINT, OFFLINE_HINT })").runInContext(sandbox);
  return { ...api, el: (id) => document.getElementById(id) };
}

const offline = { ok: false, offline: true, error: "Server unreachable" };
const online = { ok: true, data: { model: "large-v3", device: "cuda", compute_type: "float16" } };

test("a reopened popup resumes the launch the background reports, with the button disabled", async () => {
  const deadline = Date.now() + 50000;
  const popup = loadPopup((msg) => (msg.type === "startServerStatus" ? { starting: true, already: false, deadline } : offline));
  await popup.resumeStart();
  assert.equal(popup.startFlow.state, "waiting");
  assert.equal(popup.startFlow.deadline, deadline);
  await popup.checkServer(false);
  assert.equal(popup.el("server-status").textContent, "Starting server");
  assert.equal(popup.el("server-detail").textContent, "launched, waiting for it to answer");
  const button = popup.el("start-server");
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "Starting…");
});

test("with no launch under way the popup offers the button", async () => {
  const popup = loadPopup((msg) => (msg.type === "startServerStatus" ? { starting: false } : offline));
  await popup.resumeStart();
  assert.equal(popup.startFlow.state, "idle");
  await popup.checkServer(true);
  assert.equal(popup.el("server-status").textContent, "Server offline");
  assert.equal(popup.el("server-detail").textContent, popup.OFFLINE_HINT);
  assert.equal(popup.el("start-server").hidden, false);
  assert.equal(popup.el("start-server").disabled, false);
  assert.equal(popup.el("start-server").textContent, "Start server");
});

test("past the deadline the detail points at the log and the button is back", async () => {
  const popup = loadPopup((msg) => (msg.type === "startServerStatus" ? { starting: true, deadline: Date.now() - 1 } : offline));
  await popup.resumeStart();
  await popup.checkServer(false);
  assert.equal(popup.startFlow.state, "failed");
  assert.equal(popup.el("server-status").textContent, "Server offline");
  assert.equal(popup.el("server-detail").textContent, popup.START_NOT_UP_HINT);
  assert.match(popup.START_NOT_UP_HINT, /server\.log/);
  assert.equal(popup.el("start-server").disabled, false);
});

// The launcher names the log it opened (server.log under SHISUKO_HOME, elsewhere than the hint's
// ~/.shisu-ko when the variable is set); a launch that failed at once has its reason only there.
test("past the deadline the detail names the log the launcher opened", async () => {
  const log = "/srv/shisuko/server.log";
  const popup = loadPopup((msg) => (msg.type === "startServerStatus" ? { starting: true, log, deadline: Date.now() - 1 } : offline));
  await popup.resumeStart();
  assert.equal(popup.startFlow.log, log);
  await popup.checkServer(false);
  assert.equal(popup.el("server-detail").textContent, popup.startNotUpHint(log));
  assert.match(popup.el("server-detail").textContent, /look at \/srv\/shisuko\/server\.log before/);
  assert.doesNotMatch(popup.el("server-detail").textContent, /\.shisu-ko\/server\.log/);
});

// The launcher's `starting` (the background's `loading`): a server launched, by an earlier click
// or by hand, that holds its instance lock while the model loads or downloads. It is not up at
// 127.0.0.1:8790 any more than one this popup launched, so the deadline must not blame the URL.
test("a server the launcher finds still loading is waited for like a launched one", async () => {
  let deadline = Date.now() + 50000;
  const popup = loadPopup((msg) => (msg.type === "startServer" ? { ok: true, started: false, already: true, loading: true, log: null, deadline } : offline));
  await popup.startServerFromPopup();
  assert.equal(popup.startFlow.state, "waiting");
  assert.equal(popup.startFlow.loading, true);
  assert.equal(popup.el("server-status").textContent, "Starting server");
  assert.equal(popup.el("server-detail").textContent, "still loading by the launcher's account, waiting for it to answer");
  assert.equal(popup.el("start-server").disabled, true);
  deadline = Date.now() - 1;
  popup.startFlow.deadline = deadline;
  await popup.checkServer(false);
  assert.equal(popup.startFlow.state, "failed");
  assert.equal(popup.el("server-detail").textContent, popup.START_NOT_UP_HINT);
  assert.equal(popup.el("start-server").disabled, false);
});

test("a server the launcher finds answering, and this popup does not, points at the server URL", async () => {
  const popup = loadPopup((msg) => (msg.type === "startServerStatus" ? { starting: true, already: true, loading: false, log: null, deadline: Date.now() - 1 } : offline));
  await popup.resumeStart();
  assert.equal(popup.el("server-detail").textContent, "already running by the launcher's account, waiting for it to answer");
  await popup.checkServer(false);
  assert.equal(popup.startFlow.state, "failed");
  assert.equal(popup.el("server-detail").textContent, popup.START_ELSEWHERE_HINT);
  assert.notEqual(popup.START_ELSEWHERE_HINT, popup.START_NOT_UP_HINT);
});

// native_host.py registers the launcher with Firefox only; on Chrome the button would answer
// "launcher not registered" with a hint (run setup.cmd) that registers nothing Chrome reads.
test("on Chrome the button stays hidden while the server is offline", async () => {
  const popup = loadPopup((msg) => (msg.type === "startServerStatus" ? { starting: false } : offline), "chrome-extension://test/");
  await popup.resumeStart();
  await popup.checkServer(true);
  assert.equal(popup.el("server-status").textContent, "Server offline");
  assert.equal(popup.el("server-detail").textContent, popup.OFFLINE_HINT);
  assert.equal(popup.el("start-server").hidden, true);
});

test("the server answering ends the wait and hides the button", async () => {
  let health = offline;
  const popup = loadPopup((msg) => (msg.type === "startServerStatus" ? { starting: true, deadline: Date.now() + 50000 } : health));
  await popup.resumeStart();
  await popup.checkServer(false);
  assert.equal(popup.el("server-status").textContent, "Starting server");
  health = online;
  await popup.checkServer(false);
  assert.equal(popup.startFlow.state, "idle");
  assert.equal(popup.el("server-status").textContent, "Server online");
  assert.equal(popup.el("start-server").hidden, true);
});

test("the click sends one startServer and follows the deadline the background answers", async () => {
  const deadline = Date.now() + 90000;
  const sent = [];
  const popup = loadPopup((msg) => {
    sent.push(msg.type);
    if (msg.type === "startServer") return { ok: true, started: true, already: false, log: null, deadline };
    return offline;
  });
  await Promise.all([popup.startServerFromPopup(), popup.startServerFromPopup()]); // a double click
  assert.equal(sent.filter((type) => type === "startServer").length, 1);
  assert.equal(popup.startFlow.state, "waiting");
  assert.equal(popup.startFlow.deadline, deadline);
  assert.equal(popup.el("start-server").disabled, true);
});

test("a refusal from the background puts its reason and hint on the detail line", async () => {
  const popup = loadPopup((msg) => (msg.type === "startServer" ? { ok: false, error: "launcher not registered", hint: "Run setup" } : offline));
  await popup.startServerFromPopup();
  assert.equal(popup.startFlow.state, "failed");
  assert.equal(popup.el("server-detail").textContent, "launcher not registered. Run setup");
  assert.equal(popup.el("start-server").disabled, false);
});

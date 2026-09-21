"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const ADDON = path.join(__dirname, "..");

// The start flow of popup.js, driven without Firefox. popup.js paints a handful of elements by id;
// the fake document hands out one plain object per id with the members the status line and the
// hints touch, and a test reads the badge, the detail and the button back from it. A select's
// options are its children: renderDeckOptions builds them with createElement and replaceChildren.
function fakeElement(id) {
  const el = {
    id,
    textContent: "",
    className: "",
    disabled: false,
    hidden: false,
    value: "",
    placeholder: "",
    style: { setProperty: () => {} },
    children: [],
    get options() {
      return this.children;
    },
    get firstChild() {
      return this.children[0] || null;
    },
  };
  el.classList = {
    toggle: (name, force) => {
      if (name === "hidden") el.hidden = !!force;
    },
    add: () => {},
    remove: () => {},
  };
  el.addEventListener = () => {};
  el.appendChild = (node) => el.children.push(node);
  el.replaceChildren = (...nodes) => {
    el.children = nodes;
  };
  return el;
}

// `answer` plays the background: it gets every runtime.sendMessage and returns the reply. The
// popup runs as Firefox's unless `runtimeURL` says otherwise: the button is for Firefox alone.
function loadPopup(answer, runtimeURL = "moz-extension://test/") {
  const elements = new Map();
  const document = {
    addEventListener: () => {},
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, fakeElement(id));
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
      tabs: { query: async () => [], create: async (opts) => opened.push(opts.url) },
    },
  };
  const opened = [];
  vm.createContext(sandbox);
  new vm.Script(fs.readFileSync(path.join(ADDON, "settings.js"), "utf8")).runInContext(sandbox);
  new vm.Script(fs.readFileSync(path.join(ADDON, "popup.js"), "utf8"), { filename: "popup.js" }).runInContext(sandbox);
  const api = new vm.Script(
    "({ startFlow, resumeStart, checkServer, startServerFromPopup, startNotUpHint, START_NOT_UP_HINT, START_ELSEWHERE_HINT, OFFLINE_HINT," +
      " updateFlow, refreshUpdate, updateServerFromPopup, snoozeUpdateFromPopup, checkForUpdatesFromPopup, openReleasePage, relativeTime, renderStatus," +
      " UPDATE_LOST_HINT, stillOldHint, renderDeckOptions, refreshDecks, DECK_NONE_HINT, init, onChange })"
  ).runInContext(sandbox);
  return { ...api, el: (id) => document.getElementById(id), opened };
}

const offline = { ok: false, offline: true, error: "Server unreachable" };
const online = { ok: true, data: { model: "large-v3", device: "cuda", compute_type: "float16" } };
// checkServer() paints the status line at once and asks the background about updates behind it;
// a turn of the event loop lets that answer land before a test reads the banner.
const settle = () => new Promise((resolve) => setImmediate(resolve));

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

// ------------------------------------------------------------------ updates

const LATEST = { version: "0.9.0", tag: "v0.9.0", url: "https://github.com/Multysquid/shisu-ko/releases/tag/v0.9.0", xpi: null };
const healthOf = (version, launcher) => ({ ok: true, data: { version, launcher, model: "large-v3", device: "cuda", compute_type: "float16" } });

// A background for the update flow: /health from `state.health`, updateStatus judged from the
// /health answer the popup sends with the question (the way background.js does, in short), and
// the other three messages answered from `state` and recorded.
function updateBackground(state) {
  const sent = [];
  const answer = (msg) => {
    sent.push(msg);
    switch (msg.type) {
      case "api":
        return state.health;
      case "startServerStatus":
        return { starting: false };
      case "updateStatus": {
        const health = msg.health;
        const server = health ? { version: typeof health.version === "string" ? health.version : null, launcher: typeof health.launcher === "boolean" ? health.launcher : null } : null;
        const latest = state.latest === undefined ? LATEST : state.latest;
        let verdict = "unknown";
        if (latest) {
          if (!server) verdict = "offline";
          else if (server.version === null) verdict = "unknown";
          else if (server.version >= latest.version) verdict = "current";
          else if (server.launcher === null) verdict = "behind";
          else verdict = server.launcher ? "newer" : "cannot";
        }
        return {
          latest,
          checkedAt: state.checkedAt === undefined ? Date.now() - 3 * 60000 : state.checkedAt,
          error: state.error || null,
          server,
          decision: { server: verdict, extension: state.extension || "current" },
          snoozed: state.snoozed || null,
          updating: state.updating || null,
          extensionVersion: "0.9.0",
        };
      }
      case "checkForUpdate":
        if (state.onCheck) state.onCheck();
        return { latest: state.latest === undefined ? LATEST : state.latest, checkedAt: Date.now(), error: state.error || null };
      case "updateServer":
        return typeof state.update === "function" ? state.update() : state.update;
      case "snoozeUpdate":
        state.snoozed = msg.version;
        return { ok: true };
      default:
        return offline;
    }
  };
  return { answer, sent, types: () => sent.map((m) => m.type) };
}

async function open(state, runtimeURL) {
  const bg = updateBackground(state);
  const popup = loadPopup(bg.answer, runtimeURL);
  await popup.resumeStart();
  await popup.checkServer(true);
  await settle();
  return { popup, bg, state };
}

test("a newer release than the server runs is offered in the banner", async () => {
  const { popup, bg } = await open({ health: healthOf("0.8.0", true) });
  assert.equal(popup.el("server-status").textContent, "Server online");
  assert.equal(popup.el("update-banner").hidden, false);
  assert.equal(popup.el("update-text").textContent, "Shisu-ko 0.9.0 is available — the server runs 0.8.0.");
  assert.equal(popup.el("update-now").hidden, false);
  assert.equal(popup.el("update-now").disabled, false);
  assert.equal(popup.el("update-now").textContent, "Update");
  assert.equal(popup.el("update-later").hidden, false);
  assert.equal(popup.el("update-release").hidden, true);
  // The first question of the popup asks for the day's check; the poll asks again only when the
  // server's answer changes.
  const asked = bg.sent.filter((m) => m.type === "updateStatus");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].check, true);
  assert.deepEqual(asked[0].health, healthOf("0.8.0", true).data);
  await popup.checkServer(false);
  await settle();
  assert.equal(bg.sent.filter((m) => m.type === "updateStatus").length, 1);
  assert.equal(popup.el("update-result").textContent, "Newest release: 0.9.0, checked 3 min ago");
});

test("a server not started by the launcher gets the explanation and no Update button", async () => {
  const { popup } = await open({ health: healthOf("0.8.0", false) });
  assert.equal(popup.el("update-banner").hidden, false);
  assert.equal(popup.el("update-text").textContent, "Shisu-ko 0.9.0 is available — the server runs 0.8.0 and was not started by run.cmd / run.sh, so it cannot update itself; restart it by hand to update");
  assert.equal(popup.el("update-now").hidden, true);
  assert.equal(popup.el("update-later").hidden, false);
});

test("a server from before the launcher flag gets a banner that names the release and no Update button", async () => {
  // Every 0.8.0 server: /health carries the version and nothing about the launcher.
  const { popup } = await open({ health: { ok: true, data: { version: "0.8.0", model: "large-v3", device: "cuda", compute_type: "float16" } } });
  assert.equal(popup.el("server-status").textContent, "Server online");
  assert.equal(popup.el("update-banner").hidden, false);
  assert.equal(popup.el("update-text").textContent, "Shisu-ko 0.9.0 is available — the server runs 0.8.0, which cannot be updated from here; restart it by hand to update (run.cmd / run.sh update it at start)");
  assert.equal(popup.el("update-now").hidden, true);
  assert.equal(popup.el("update-release").hidden, true);
  assert.equal(popup.el("update-later").hidden, false);
});

test("an extension behind the release is sent to the release page", async () => {
  const { popup } = await open({ health: healthOf("0.9.0", true), extension: "newer" });
  assert.equal(popup.el("update-text").textContent, "A newer extension (0.9.0) is on the release page; Firefox installs it from addons.mozilla.org once the listing is live");
  assert.equal(popup.el("update-now").hidden, true);
  assert.equal(popup.el("update-release").hidden, false);
  popup.openReleasePage();
  await settle();
  assert.deepEqual(popup.opened, [LATEST.url]);
});

test("no banner while the server is offline, and none for a server that says no version", async () => {
  const { popup } = await open({ health: offline });
  assert.equal(popup.el("server-status").textContent, "Server offline");
  assert.equal(popup.el("update-banner").hidden, true);
  assert.equal(popup.el("update-result").textContent, "Newest release: 0.9.0, checked 3 min ago");
  // The smoke fixture: {model, device, compute_type} and nothing else.
  const fixture = await open({ health: online });
  assert.equal(fixture.popup.el("server-status").textContent, "Server online");
  assert.equal(fixture.popup.el("server-detail").textContent, "large-v3 · cuda · float16");
  assert.equal(fixture.popup.el("update-banner").hidden, true);
  // Nothing newer, and no release known at all.
  const current = await open({ health: healthOf("0.9.0", true) });
  assert.equal(current.popup.el("update-banner").hidden, true);
  const none = await open({ health: healthOf("0.9.0", true), latest: null });
  assert.equal(none.popup.el("update-banner").hidden, true);
  assert.equal(none.popup.el("update-result").textContent, "No release found, checked 3 min ago");
});

test("an answer overtaken by a later question is dropped: a slow check of GitHub cannot take the banner down", async () => {
  // The popup opens while the server is offline and the day's check is due, with GitHub slow;
  // the server comes online before GitHub answers, and the second question, answered from the
  // store at once, puts the banner up. The first answer, "offline", then lands and must not undo
  // it: no further question would be asked while this popup lives.
  const state = { health: offline };
  const bg = updateBackground(state);
  let releaseFirst;
  const held = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const popup = loadPopup(async (msg) => {
    const answer = bg.answer(msg);
    if (msg.type === "updateStatus" && msg.check) await held;
    return answer;
  });
  await popup.resumeStart();
  await popup.checkServer(true);
  await settle();
  assert.equal(popup.el("update-banner").hidden, true);
  state.health = healthOf("0.8.0", true);
  await popup.checkServer(false);
  await settle();
  assert.equal(popup.el("update-banner").hidden, false);
  assert.equal(popup.el("update-text").textContent, "Shisu-ko 0.9.0 is available — the server runs 0.8.0.");
  releaseFirst();
  await settle();
  await settle();
  assert.equal(popup.el("update-banner").hidden, false, "the late answer is dropped");
  assert.equal(popup.el("update-now").hidden, false);
  assert.equal(bg.sent.filter((m) => m.type === "updateStatus").length, 2);
  // The same server again asks nothing more, and the banner is still up.
  await popup.checkServer(false);
  await settle();
  assert.equal(bg.sent.filter((m) => m.type === "updateStatus").length, 2);
  assert.equal(popup.el("update-banner").hidden, false);
});

test("Not now hides the banner for the session and tells the background", async () => {
  const { popup, bg, state } = await open({ health: healthOf("0.8.0", true) });
  await popup.snoozeUpdateFromPopup();
  assert.equal(popup.el("update-banner").hidden, true);
  assert.deepEqual(JSON.parse(JSON.stringify(bg.sent.filter((m) => m.type === "snoozeUpdate"))), [{ type: "snoozeUpdate", version: "0.9.0" }]);
  assert.equal(state.snoozed, "0.9.0");
  // A reopened popup is told the same and shows nothing.
  const again = await open(state);
  assert.equal(again.popup.el("update-banner").hidden, true);
});

test("Update asks the background, then watches /health until the new version answers", async () => {
  const state = { health: healthOf("0.8.0", true) };
  const { popup, bg } = await open(state);
  const requestedAt = Date.now();
  state.update = { ok: true, restarting: true, from: "0.8.0", to: "0.9.0", requestedAt, deadline: requestedAt + 120000 };
  await popup.updateServerFromPopup();
  assert.equal(bg.types().filter((t) => t === "updateServer").length, 1);
  assert.equal(popup.updateFlow.state, "updating");
  assert.equal(popup.el("server-status").textContent, "Updating server");
  assert.equal(popup.el("server-status").className, "badge");
  assert.equal(popup.el("server-detail").textContent, "Restarting with 0.9.0…");
  assert.equal(popup.el("update-banner").hidden, false, "the banner stays while the update runs");
  assert.equal(popup.el("update-now").disabled, true);
  assert.equal(popup.el("update-now").textContent, "Updating…");
  assert.equal(popup.el("update-later").hidden, true);
  assert.equal(popup.el("start-server").hidden, true);
  // The old server still answers for a moment, then nobody does, then the new one.
  await popup.checkServer(false);
  assert.equal(popup.updateFlow.state, "updating");
  state.health = offline;
  await popup.checkServer(false);
  assert.equal(popup.updateFlow.state, "updating");
  assert.equal(popup.updateFlow.down, true);
  assert.equal(popup.el("server-status").textContent, "Updating server");
  state.health = healthOf("0.9.0", true);
  await popup.checkServer(false);
  await settle();
  assert.equal(popup.updateFlow.state, "done");
  assert.equal(popup.el("server-status").textContent, "Server online");
  assert.equal(popup.el("server-status").className, "badge ok");
  assert.equal(popup.el("server-detail").textContent, "Updated to 0.9.0");
  assert.equal(popup.el("update-banner").hidden, true, "nothing is newer any more");
});

test("the old version back after the restart says update.py could not update, and the banner stays", async () => {
  const state = { health: healthOf("0.8.0", true) };
  const { popup } = await open(state);
  const requestedAt = Date.now();
  state.update = { ok: true, restarting: true, from: "0.8.0", to: "0.9.0", requestedAt, deadline: requestedAt + 120000 };
  await popup.updateServerFromPopup();
  state.health = offline;
  await popup.checkServer(false);
  state.health = healthOf("0.8.0", true);
  await popup.checkServer(false);
  await settle();
  assert.equal(popup.updateFlow.state, "stale");
  assert.equal(popup.el("server-status").textContent, "Server online");
  assert.equal(popup.el("server-detail").textContent, "The server restarted but still runs 0.8.0; look at its window: update.py said why");
  assert.equal(popup.el("update-banner").hidden, false);
  assert.equal(popup.el("update-now").disabled, false);
});

test("an old version long after the request counts as the restarted server even when no poll saw it down", async () => {
  const state = { health: healthOf("0.8.0", true) };
  const { popup } = await open(state);
  const requestedAt = Date.now() - 11000;
  state.update = { ok: true, restarting: true, from: "0.8.0", to: "0.9.0", requestedAt, deadline: requestedAt + 120000 };
  await popup.updateServerFromPopup();
  await popup.checkServer(false);
  assert.equal(popup.updateFlow.state, "stale");
  assert.equal(popup.el("server-detail").textContent, popup.stillOldHint("0.8.0"));
});

test("past the deadline without an answer the detail points at the log and the button is back", async () => {
  const state = { health: healthOf("0.8.0", true) };
  const { popup } = await open(state);
  state.update = { ok: true, restarting: true, from: "0.8.0", to: "0.9.0", requestedAt: Date.now(), deadline: Date.now() - 1 };
  await popup.updateServerFromPopup();
  state.health = offline;
  await popup.checkServer(false);
  await settle();
  assert.equal(popup.updateFlow.state, "lost");
  assert.equal(popup.el("server-status").textContent, "Server offline");
  assert.equal(popup.el("server-detail").textContent, popup.UPDATE_LOST_HINT);
  assert.match(popup.UPDATE_LOST_HINT, /120 s/);
  assert.equal(popup.el("start-server").hidden, false);
  assert.equal(popup.el("start-server").disabled, false);
  assert.equal(popup.el("update-banner").hidden, true, "offline: the next start updates");
});

test("a refusal from the server shows its reason in the banner without the Update button", async () => {
  const state = { health: healthOf("0.8.0", true), update: { ok: false, error: "started with --no-update", refused: true, offline: false } };
  const { popup } = await open(state);
  await popup.updateServerFromPopup();
  assert.equal(popup.updateFlow.state, "failed");
  assert.equal(popup.el("update-text").textContent, "Shisu-ko 0.9.0 is available — the server runs 0.8.0. The server cannot update itself: started with --no-update");
  assert.equal(popup.el("update-now").hidden, true);
  assert.equal(popup.el("server-status").textContent, "Server online");
  // A request that did not get through keeps the button for another try.
  const gone = await open({ health: healthOf("0.8.0", true), update: { ok: false, error: "Server unreachable", refused: false, offline: true } });
  await gone.popup.updateServerFromPopup();
  assert.equal(gone.popup.el("update-text").textContent, "Shisu-ko 0.9.0 is available — the server runs 0.8.0. The update failed: Server unreachable");
  assert.equal(gone.popup.el("update-now").hidden, false);
  assert.equal(gone.popup.el("update-now").disabled, false);
});

test("a reopened popup resumes an update the background reports", async () => {
  const requestedAt = Date.now() - 5000;
  const state = { health: offline, updating: { from: "0.8.0", to: "0.9.0", requestedAt, deadline: requestedAt + 120000, down: true } };
  const { popup } = await open(state);
  assert.equal(popup.updateFlow.state, "updating");
  assert.equal(popup.updateFlow.down, true);
  assert.equal(popup.el("server-status").textContent, "Updating server");
  assert.equal(popup.el("server-detail").textContent, "Restarting with 0.9.0…");
  assert.equal(popup.el("start-server").hidden, true);
  state.health = healthOf("0.9.0", true);
  await popup.checkServer(false);
  assert.equal(popup.updateFlow.state, "done");
});

// The day's check failed (GitHub blackholed) but kept the release, so the banner offered Update;
// the viewer clicked it and reopened the popup while update.py runs. The first updateStatus
// answer now waits ten seconds on GitHub; the record must reach the popup before that, with the
// startServerStatus answer, or its first paint offers a start on top of the launcher's restart.
test("a reopened popup learns of an update from startServerStatus, before a slow first updateStatus", async () => {
  const requestedAt = Date.now() - 5000;
  const updating = { from: "0.8.0", to: "0.9.0", requestedAt, deadline: requestedAt + 120000, down: false };
  const state = { health: offline, updating };
  const bg = updateBackground(state);
  let releaseFirst;
  const held = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const popup = loadPopup(async (msg) => {
    if (msg.type === "startServerStatus") return { starting: false, updating };
    const answer = bg.answer(msg);
    if (msg.type === "updateStatus" && msg.check) await held;
    return answer;
  });
  await popup.resumeStart();
  assert.equal(popup.updateFlow.state, "updating");
  assert.equal(popup.el("server-status").textContent, "Updating server");
  await popup.checkServer(popup.startFlow.state === "idle" && popup.updateFlow.state === "idle");
  await settle();
  assert.equal(popup.el("server-status").textContent, "Updating server");
  assert.equal(popup.el("server-detail").textContent, "Restarting with 0.9.0…");
  assert.equal(popup.el("start-server").hidden, true);
  assert.equal(popup.updateFlow.down, true);
  await popup.startServerFromPopup();
  assert.equal(bg.types().includes("startServer"), false, "no start while the update runs");
  // The slow answer lands and changes nothing; the new version then ends the update.
  releaseFirst();
  await settle();
  await settle();
  assert.equal(popup.updateFlow.state, "updating");
  assert.equal(popup.el("start-server").hidden, true);
  state.health = healthOf("0.9.0", true);
  await popup.checkServer(false);
  assert.equal(popup.updateFlow.state, "done");
  assert.equal(popup.el("server-detail").textContent, "Updated to 0.9.0");
});

test("a start under way disables Update, and an update hides Start", async () => {
  const state = { health: offline, latest: LATEST };
  const bg = updateBackground(state);
  const popup = loadPopup((msg) => (msg.type === "startServerStatus" ? { starting: true, deadline: Date.now() + 50000 } : bg.answer(msg)));
  await popup.resumeStart();
  await popup.checkServer(false);
  await settle();
  assert.equal(popup.startFlow.state, "waiting");
  // Offline shows no banner; the button's state is still kept right for the moment it shows.
  assert.equal(popup.el("update-now").disabled, true);
  await popup.updateServerFromPopup();
  assert.equal(bg.types().includes("updateServer"), false, "no update while a start is under way");
});

test("Check for updates asks for a check now and shows the result, or the failure", async () => {
  let checks = 0;
  const state = { health: healthOf("0.9.0", true), onCheck: () => checks++ };
  const { popup, bg } = await open(state);
  const before = bg.sent.length;
  await popup.checkForUpdatesFromPopup();
  assert.equal(checks, 1);
  assert.deepEqual(bg.sent.slice(before).map((m) => m.type), ["checkForUpdate", "updateStatus"]);
  assert.equal(bg.sent[before].force, true);
  assert.equal(bg.sent[before + 1].check, false);
  assert.equal(popup.el("check-updates").disabled, false);
  assert.equal(popup.el("update-result").textContent, "Newest release: 0.9.0, checked 3 min ago");
  assert.equal(popup.el("update-result").className, "hint");
  state.error = "could not reach GitHub";
  await popup.checkForUpdatesFromPopup();
  assert.equal(popup.el("update-result").textContent, "Update check failed: could not reach GitHub (last seen: 0.9.0)");
  assert.equal(popup.el("update-result").className, "hint warn");
});

test("relativeTime rounds to the unit that says something", () => {
  const { relativeTime } = loadPopup(() => offline);
  const now = 1000000000000;
  assert.equal(relativeTime(now - 10000, now), "just now");
  assert.equal(relativeTime(now - 59000, now), "just now");
  assert.equal(relativeTime(now - 3 * 60000, now), "3 min ago");
  assert.equal(relativeTime(now - 59 * 60000, now), "59 min ago");
  assert.equal(relativeTime(now - 90 * 60000, now), "2 h ago");
  assert.equal(relativeTime(now - 23 * 3600000, now), "23 h ago");
  assert.equal(relativeTime(now - 24 * 3600000, now), "1 day ago");
  assert.equal(relativeTime(now - 3 * 24 * 3600000, now), "3 days ago");
  assert.equal(relativeTime(now + 5000, now), "just now", "a clock that went backwards is not the future");
});

// ------------------------------------------------------------------ word colours

// Anki's decks as the background lists them (sorted there; the popup sorts again, so the order
// here does not matter) and the answers the ankiDecks message can carry.
const DECKS = ["Vocab", "Default", "Mining::JP"];
const decksOk = (seen) => ({ ok: true, decks: DECKS, seen });
const decksOffline = (seen) => ({ ok: false, reason: "offline", error: "Anki is not running or AnkiConnect is not installed", seen });
const optionsOf = (select) => select.options.map((o) => [o.value, o.textContent]);

// A popup with a background that answers getSettings from `settings` and ankiDecks from `anki`
// (a value or a function; a test that changes the answer as it goes hands in a function reading
// its own variable, which may hold a function in turn), recording every message type.
function deckPopup(settings, anki) {
  const sent = [];
  const answer = (value) => (typeof value === "function" ? answer(value()) : value);
  const popup = loadPopup((msg) => {
    sent.push(msg.type);
    if (msg.type === "getSettings") return settings;
    if (msg.type === "ankiDecks") return answer(anki);
    if (msg.type === "startServerStatus") return { starting: false };
    return offline;
  });
  return { popup, sent };
}

test("renderDeckOptions keeps the automatic entry first, names the seen deck in it, and keeps the stored deck even when unlisted", () => {
  const { popup } = deckPopup({}, null);
  const select = popup.el("cardStatusDeck");
  popup.renderDeckOptions(DECKS, null, "");
  const auto = select.options[0];
  assert.deepEqual(optionsOf(select), [["", "Automatic: no card mined yet"], ["Default", "Default"], ["Mining::JP", "Mining::JP"], ["Vocab", "Vocab"]]);
  assert.equal(select.value, "");
  popup.renderDeckOptions(DECKS, "Mining::JP", "Vocab");
  assert.equal(select.options[0], auto, "the automatic option is the same element");
  assert.equal(auto.textContent, "Automatic: Mining::JP");
  assert.equal(auto.value, "");
  assert.equal(select.value, "Vocab");
  // Anki offline: no list, and the stored deck still has its option, so the value survives.
  popup.renderDeckOptions([], null, "Old::Deck");
  assert.deepEqual(optionsOf(select), [["", "Automatic: no card mined yet"], ["Old::Deck", "Old::Deck"]]);
  assert.equal(select.value, "Old::Deck");
  // A stored deck Anki does not list sorts in among the others, once.
  popup.renderDeckOptions(DECKS, "Vocab", "Gone");
  assert.deepEqual(optionsOf(select), [["", "Automatic: Vocab"], ["Default", "Default"], ["Gone", "Gone"], ["Mining::JP", "Mining::JP"], ["Vocab", "Vocab"]]);
  assert.equal(select.value, "Gone");
  popup.renderDeckOptions(DECKS, "Vocab", "Vocab");
  assert.equal(optionsOf(select).filter(([value]) => value === "Vocab").length, 1);
  // Before Anki was asked the entry keeps the page's description; junk in the list is dropped.
  popup.renderDeckOptions(["Vocab", 5, null, ""], undefined, "");
  assert.deepEqual(optionsOf(select), [["", "Automatic: the deck of the last mined card"], ["Vocab", "Vocab"]]);
});

test("refreshDecks paints the hint: automatic with and without a seen deck, a manual deck listed or not, Anki offline", async () => {
  let anki = decksOk(null);
  const { popup, sent } = deckPopup({}, () => anki);
  const select = popup.el("cardStatusDeck");
  const hint = popup.el("deck-hint");
  await popup.refreshDecks();
  assert.deepEqual(sent, ["ankiDecks"]);
  assert.equal(hint.textContent, popup.DECK_NONE_HINT);
  assert.equal(hint.className, "hint warn");
  assert.equal(select.options[0].textContent, "Automatic: no card mined yet");
  anki = decksOk("Mining::JP");
  await popup.refreshDecks();
  assert.equal(hint.textContent, "Looking at Mining::JP");
  assert.equal(hint.className, "hint");
  assert.equal(select.options[0].textContent, "Automatic: Mining::JP");
  // A manual deck that Anki lists needs no hint; one it does not list is an error.
  select.value = "Vocab";
  await popup.refreshDecks();
  assert.equal(hint.textContent, "");
  assert.equal(hint.className, "hint");
  assert.equal(select.value, "Vocab");
  select.value = "Gone";
  await popup.refreshDecks();
  assert.equal(hint.textContent, "No deck named Gone in Anki");
  assert.equal(hint.className, "hint error");
  assert.equal(select.value, "Gone", "the stored deck is kept for Anki to come back with it");
  // Anki offline: its reason on the hint, the seen deck still named, the stored deck kept.
  anki = decksOffline("Mining::JP");
  await popup.refreshDecks();
  assert.equal(hint.textContent, "Anki is not running or AnkiConnect is not installed");
  assert.equal(hint.className, "hint warn");
  assert.deepEqual(optionsOf(select), [["", "Automatic: Mining::JP"], ["Gone", "Gone"]]);
  assert.equal(select.value, "Gone");
  // A message that fails outright reads the same way.
  anki = () => {
    throw new Error("Could not establish connection");
  };
  await popup.refreshDecks();
  assert.equal(hint.textContent, "Could not establish connection");
  assert.equal(hint.className, "hint warn");
});

test("an answer overtaken by a later question does not overwrite the hint", async () => {
  let releaseFirst;
  const held = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let asks = 0;
  const { popup } = deckPopup({}, async () => {
    if (++asks === 1) {
      await held;
      return decksOk("Old");
    }
    return decksOk("New");
  });
  const first = popup.refreshDecks();
  await popup.refreshDecks();
  assert.equal(popup.el("deck-hint").textContent, "Looking at New");
  releaseFirst();
  await first;
  assert.equal(popup.el("deck-hint").textContent, "Looking at New");
  assert.equal(popup.el("cardStatusDeck").options[0].textContent, "Automatic: New");
});

test("init asks Anki for its decks only when a word-colour feature is on, and keeps the stored deck either way", async () => {
  const off = deckPopup({ cardStatus: false, pitchAccent: false, cardStatusDeck: "Mining::JP" }, decksOk("Vocab"));
  await off.popup.init();
  await settle();
  assert.equal(off.sent.includes("ankiDecks"), false, "no ask for a viewer who never uses the feature");
  assert.equal(off.popup.el("cardStatusDeck").value, "Mining::JP");
  assert.deepEqual(optionsOf(off.popup.el("cardStatusDeck")), [["", "Automatic: the deck of the last mined card"], ["Mining::JP", "Mining::JP"]]);
  assert.equal(off.popup.el("deck-hint").textContent, "");

  const status = deckPopup({ cardStatus: true, pitchAccent: false, cardStatusDeck: "" }, decksOk("Vocab"));
  await status.popup.init();
  await settle();
  assert.equal(status.sent.filter((t) => t === "ankiDecks").length, 1);
  assert.equal(status.popup.el("deck-hint").textContent, "Looking at Vocab");
  assert.equal(status.popup.el("cardStatusDeck").options[0].textContent, "Automatic: Vocab");

  const pitch = deckPopup({ cardStatus: false, pitchAccent: true, cardStatusDeck: "Mining::JP" }, decksOffline(null));
  await pitch.popup.init();
  await settle();
  assert.equal(pitch.sent.filter((t) => t === "ankiDecks").length, 1);
  assert.equal(pitch.popup.el("cardStatusDeck").value, "Mining::JP", "an offline Anki does not lose the stored deck");
  assert.equal(pitch.popup.el("deck-hint").textContent, "Anki is not running or AnkiConnect is not installed");
});

test("a checkbox turned on or another deck asks Anki after the save; a checkbox turned off does not", async () => {
  const { popup, sent } = deckPopup({}, decksOk(null));
  const saved = () => new Promise((resolve) => setTimeout(resolve, 250));
  const checkbox = popup.el("cardStatus");
  checkbox.checked = true;
  popup.onChange({ target: checkbox });
  await saved();
  assert.deepEqual(sent, ["saveSettings", "ankiDecks"]);
  assert.equal(popup.el("deck-hint").textContent, popup.DECK_NONE_HINT);
  checkbox.checked = false;
  popup.onChange({ target: checkbox });
  await saved();
  assert.deepEqual(sent, ["saveSettings", "ankiDecks", "saveSettings"]);
  const pitch = popup.el("pitchAccent");
  pitch.checked = true;
  popup.onChange({ target: pitch });
  await saved();
  assert.deepEqual(sent.slice(3), ["saveSettings", "ankiDecks"]);
  const select = popup.el("cardStatusDeck");
  select.value = "Vocab";
  popup.onChange({ target: select });
  await saved();
  assert.deepEqual(sent.slice(5), ["saveSettings", "ankiDecks"]);
  assert.equal(popup.el("deck-hint").textContent, "");
  assert.equal(select.value, "Vocab");
  // Any other control saves and asks nothing.
  popup.onChange({ target: popup.el("pauseOnHover") });
  await saved();
  assert.deepEqual(sent.slice(7), ["saveSettings"]);
});

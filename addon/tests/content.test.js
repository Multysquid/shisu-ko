"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadContent } = require("./_loadContent");

// Arrays built inside the vm sandbox belong to another realm, so deepEqual rejects them on
// prototype identity alone; a JSON round trip compares them in this one.
const plain = (value) => JSON.parse(JSON.stringify(value));

const NOW = 1_000_000;

// A paused viewer on a video the server has fully transcribed around the playhead.
function idle(patch) {
  return Object.assign(
    { paused: true, t: 100, status: "ready", covered: [[0, 1200]], duration: 1200, lastSyncAt: NOW - 1000 },
    patch
  );
}

// ------------------------------------------------------------------ shouldSync

test("shouldSync keeps the one second cadence while the video plays", () => {
  const { api } = loadContent();
  assert.equal(api.shouldSync(idle({ paused: false }), NOW), true);
});

test("shouldSync skips the request when a paused video needs nothing", () => {
  const { api } = loadContent();
  assert.equal(api.shouldSync(idle(), NOW), false);
});

test("shouldSync keeps asking while the server still has work around the playhead", () => {
  const { api } = loadContent();
  // Covered only to 200 s of a 1200 s video, and the server transcribes 900 s ahead of 100 s.
  assert.equal(api.shouldSync(idle({ covered: [[0, 200]] }), NOW), true);
  // The playhead is not inside any covered range at all.
  assert.equal(api.shouldSync(idle({ t: 900, covered: [[0, 200]] }), NOW), true);
});

test("shouldSync keeps asking while the server is not ready", () => {
  const { api } = loadContent();
  for (const status of ["connecting", "pending", "downloading", "decoding", "error", "offline"]) {
    assert.equal(api.shouldSync(idle({ status }), NOW), true, status);
  }
});

test("shouldSync still beats every five seconds while paused", () => {
  const { api } = loadContent();
  assert.equal(api.shouldSync(idle({ lastSyncAt: NOW - 4999 }), NOW), false);
  assert.equal(api.shouldSync(idle({ lastSyncAt: NOW - 5000 }), NOW), true);
  assert.equal(api.shouldSync(idle({ lastSyncAt: 0 }), NOW), true);
});

test("shouldSync asks while the duration is still unknown", () => {
  const { api } = loadContent();
  assert.equal(api.shouldSync(idle({ duration: 0 }), NOW), true);
});

test("shouldSync stops once the covered range reaches the end of a short video", () => {
  const { api } = loadContent();
  // Shorter than the server's lookahead: the end of the video is the target, not playhead + 900 s.
  assert.equal(api.shouldSync(idle({ t: 30, duration: 60, covered: [[0, 60]] }), NOW), false);
  assert.equal(api.shouldSync(idle({ t: 30, duration: 60, covered: [[0, 45]] }), NOW), true);
});

// ------------------------------------------------------------------ coveredEnd

test("coveredEnd returns the end of the range holding the playhead, else null", () => {
  const { api } = loadContent();
  assert.equal(api.coveredEnd([[0, 40], [60, 90]], 20), 40);
  assert.equal(api.coveredEnd([[0, 40], [60, 90]], 70), 90);
  assert.equal(api.coveredEnd([[0, 40], [60, 90]], 50), null);
  assert.equal(api.coveredEnd(null, 10), null);
});

// ------------------------------------------------------------------ cue bookkeeping

test("mergeCues indexes cues by id, ignores repeats and keeps them in order", () => {
  const { api } = loadContent();
  api.mergeCues([
    { id: 0, start: 0, end: 1, text: "いち" },
    { id: 1, start: 1, end: 2, text: "に" },
  ]);
  api.mergeCues([
    { id: 1, start: 1, end: 2, text: "に" }, // already known
    { id: 2, start: 2, end: 3, text: "さん" },
  ]);
  assert.deepEqual(plain(api.state.cues.map((c) => c.id)), [0, 1, 2]);
  assert.equal(api.cueById(2).text, "さん");
  assert.equal(api.cueById(0).text, "いち"); // id 0 is a real cue, not "no cue"
  assert.equal(api.cueById(99), null);
});

test("mergeCues sorts a cue that arrives out of order", () => {
  const { api } = loadContent();
  api.mergeCues([{ id: 0, start: 10, end: 11, text: "あと" }]);
  api.mergeCues([{ id: 1, start: 2, end: 3, text: "さき" }]);
  assert.deepEqual(plain(api.state.cues.map((c) => c.start)), [2, 10]);
});

test("findActiveCue picks the cue at the playhead and lingers past the last one", () => {
  const { api } = loadContent();
  api.mergeCues([
    { id: 0, start: 0, end: 2, text: "いち" },
    { id: 1, start: 5, end: 7, text: "に" },
  ]);
  assert.equal(api.findActiveCue(1).id, 0);
  assert.equal(api.findActiveCue(6).id, 1);
  assert.equal(api.findActiveCue(4), null); // the blank between them is long enough to be a blank
  assert.equal(api.findActiveCue(7.2).id, 1); // lingerSeconds keeps the last cue up for a moment
  assert.equal(api.findActiveCue(9), null);
});

// ------------------------------------------------------------------ jumpTarget

// Three lines with a gap between the second and the third.
const JUMP_CUES = [
  { id: 0, start: 0, end: 2, text: "いち" },
  { id: 1, start: 5, end: 7, text: "に" },
  { id: 2, start: 20, end: 22, text: "さん" },
];

test("jumpTarget replays the current line once the viewer is a second into it", () => {
  const { api } = loadContent();
  assert.equal(api.jumpTarget(JUMP_CUES, 6.5, -1), 4.85); // 5 - the 0.15 s lead-in
  assert.equal(api.jumpTarget(JUMP_CUES, 9, -1), 4.85); // still the last line that started
});

test("jumpTarget steps back to the line before when the current one just started", () => {
  const { api } = loadContent();
  assert.equal(api.jumpTarget(JUMP_CUES, 5.5, -1), 0); // 0.5 s in: the viewer meant the line before
  assert.equal(api.jumpTarget(JUMP_CUES, 6, -1), 0); // exactly 1.0 s in is not yet a replay
  assert.equal(api.jumpTarget(JUMP_CUES, 20.5, -1), 4.85);
});

test("jumpTarget lands on the start of the video before the first line", () => {
  const { api } = loadContent();
  assert.equal(api.jumpTarget(JUMP_CUES, 0.5, -1), 0); // inside the first cue, less than a second
  assert.equal(api.jumpTarget(JUMP_CUES, 1.5, -1), 0); // replaying cue 0 clamps to 0 as well
  assert.equal(api.jumpTarget(JUMP_CUES, -1, -1), 0); // before every cue
});

test("jumpTarget moves to the next line, or reports none ahead", () => {
  const { api } = loadContent();
  assert.equal(api.jumpTarget(JUMP_CUES, 0, 1), 4.85);
  assert.equal(api.jumpTarget(JUMP_CUES, 6, 1), 19.85);
  assert.equal(api.jumpTarget(JUMP_CUES, 10, 1), 19.85); // in the gap: the next line still counts
  assert.equal(api.jumpTarget(JUMP_CUES, 20, 1), null); // on the last line, nothing ahead
  assert.equal(api.jumpTarget(JUMP_CUES, 60, 1), null);
});

test("jumpTarget with no cues rewinds to the start and reports nothing ahead", () => {
  const { api } = loadContent();
  assert.equal(api.jumpTarget([], 42, -1), 0);
  assert.equal(api.jumpTarget([], 42, 1), null);
});

// ------------------------------------------------------------------ Anki polling

test("ankiPollAllowed polls a playing video and stops on a hidden tab", () => {
  const { api, sandbox } = loadContent();
  api.mergeCues([{ id: 0, start: 0, end: 2, text: "いち" }]);
  api.state.videoId = "abcdef1234";
  assert.equal(api.ankiPollAllowed(), true);
  sandbox.document.visibilityState = "hidden";
  assert.equal(api.ankiPollAllowed(), false);
});

test("ankiPollAllowed gives up on a video left paused, and resumes for a reader", () => {
  const { api } = loadContent();
  api.mergeCues([{ id: 0, start: 0, end: 2, text: "いち" }]);
  api.state.videoId = "abcdef1234";
  api.state.pausedSince = Date.now() - 10_000;
  assert.equal(api.ankiPollAllowed(), true); // ten seconds: the viewer is probably still looking
  api.state.pausedSince = Date.now() - 180_000;
  assert.equal(api.ankiPollAllowed(), false);
  api.state.hoverPaused = true; // the pointer is on the subtitle: a lookup is in progress
  assert.equal(api.ankiPollAllowed(), true);
});

test("ankiPollAllowed stays quiet with nothing to attach or the feature off", () => {
  const { api } = loadContent();
  api.state.videoId = "abcdef1234";
  assert.equal(api.ankiPollAllowed(), false); // no cues yet
  api.mergeCues([{ id: 0, start: 0, end: 2, text: "いち" }]);
  assert.equal(api.ankiPollAllowed(), true);
  api.state.settings.autoMine = false;
  assert.equal(api.ankiPollAllowed(), false);
  api.state.settings.autoMine = true;
  api.state.offline = true;
  assert.equal(api.ankiPollAllowed(), false);
});

// ------------------------------------------------------------------ live streams

// A player element the way Firefox shows it to a content script: the page's API sits behind
// wrappedJSObject, and the video element restarts its own clock at an arbitrary point.
function livePlayer(current, isLive = true) {
  return {
    removeEventListener: () => {}, // discover() lets go of it once the test's fake page is gone
    wrappedJSObject: { getVideoData: () => ({ isLive }), getProgressState: () => ({ current }) },
  };
}

test("liveClock reads the stream clock from a live player and nothing from a video", () => {
  const { api } = loadContent();
  assert.equal(api.liveClock(livePlayer(100490.5)), 100490.5);
  assert.equal(api.liveClock(livePlayer(100490.5, false)), null);
  assert.equal(api.liveClock({ wrappedJSObject: {} }), null);
  assert.equal(api.liveClock(null), null);
  assert.equal(api.liveClock({ wrappedJSObject: { getVideoData: () => { throw new Error("gone"); }, getProgressState: () => ({}) } }), null);
});

test("playhead runs on the stream clock for a live stream and on video time otherwise", () => {
  const { api } = loadContent();
  api.state.video = { currentTime: 46810.4 };
  api.state.player = livePlayer(100490.4);
  api.updateLiveClock();
  assert.equal(api.state.live, true);
  assert.equal(api.playhead().toFixed(3), "100490.400");
  api.state.video.currentTime = 46812.4; // two seconds later, between syncs
  assert.equal(api.playhead().toFixed(3), "100492.400");
  api.seekPlayhead(100400.0);
  assert.equal(api.state.video.currentTime.toFixed(3), "46720.000"); // back on the element's clock

  api.state.player = livePlayer(0, false);
  api.updateLiveClock();
  assert.equal(api.state.live, false);
  assert.equal(api.playhead().toFixed(3), "46720.000");
});

// ------------------------------------------------------------------ master switch

test("the master switch also silences the arrow keys", () => {
  const { api } = loadContent();
  api.mergeCues([{ id: 0, start: 0, end: 2, text: "いち" }, { id: 1, start: 5, end: 7, text: "に" }]);
  api.state.video = { currentTime: 0, paused: true };
  const events = () => {
    let stopped = 0;
    return { key: "ArrowRight", target: { closest: () => null }, preventDefault: () => { stopped++; }, stopImmediatePropagation: () => { stopped++; }, count: () => stopped };
  };
  const on = events();
  api.onKeyDown(on);
  assert.equal(on.count(), 2);
  assert.equal(api.state.video.currentTime.toFixed(2), "4.85");
  api.state.settings.enabled = false;
  const off = events();
  api.onKeyDown(off);
  assert.equal(off.count(), 0); // YouTube keeps its own 5 s seek
});

// ------------------------------------------------------------------ sentences

// Four cues: two of one segment, then the same segment again after 13 s of music, then another.
const SENTENCE_CUES = [
  { id: 0, seg: 7, start: 0, end: 1, text: "あ" },
  { id: 1, seg: 7, start: 1.2, end: 2, text: "い" },
  { id: 2, seg: 7, start: 15, end: 16, text: "う" },
  { id: 3, seg: 8, start: 16.1, end: 17, text: "え" },
];

test("sentenceForCue joins the cues of a segment but stops at a long pause", () => {
  const { api } = loadContent();
  const sentenceForCue = api.sentenceForCue;
  assert.deepEqual(plain(sentenceForCue(SENTENCE_CUES, SENTENCE_CUES[1])), { start: 0, end: 2, text: "あい", cueIds: [0, 1] });
  assert.deepEqual(plain(sentenceForCue(SENTENCE_CUES, SENTENCE_CUES[2])), { start: 15, end: 16, text: "う", cueIds: [2] });
  assert.deepEqual(plain(sentenceForCue(SENTENCE_CUES, SENTENCE_CUES[3])), { start: 16.1, end: 17, text: "え", cueIds: [3] });
});

test("nextSentence steps past every cue of the sentence it is given", () => {
  const { api } = loadContent();
  const first = api.sentenceForCue(SENTENCE_CUES, SENTENCE_CUES[0]);
  assert.deepEqual(plain(api.nextSentence(SENTENCE_CUES, first)), { start: 15, end: 16, text: "う", cueIds: [2] });
  const third = api.sentenceForCue(SENTENCE_CUES, SENTENCE_CUES[2]);
  assert.deepEqual(plain(api.nextSentence(SENTENCE_CUES, third)), { start: 16.1, end: 17, text: "え", cueIds: [3] });
  // Nothing after the last one, and nothing to step from without cue ids.
  const last = api.sentenceForCue(SENTENCE_CUES, SENTENCE_CUES[3]);
  assert.equal(api.nextSentence(SENTENCE_CUES, last), null);
  assert.equal(api.nextSentence(SENTENCE_CUES, null), null);
  assert.equal(api.nextSentence(SENTENCE_CUES, { start: 0, end: 1, text: "x", cueIds: [99] }), null);
});

// ------------------------------------------------------------------ pre-mining

test("rankOfCue prefers the sentences the background is already holding, newest first", () => {
  const { api } = loadContent();
  const held = [
    { key: 4, cueIds: [4, 5], image: true, audio: true },
    { key: 2, cueIds: [2], image: true, audio: false },
  ];
  assert.equal(api.rankOfCue(held, { id: 5 }), 0);
  assert.equal(api.rankOfCue(held, { id: 2 }), 1);
  assert.equal(api.rankOfCue(held, { id: 9 }), Infinity);
  assert.equal(api.rankOfCue([], { id: 4 }), Infinity);
});

test("resetPremine tells the background only when the tab holds something", () => {
  const { api, sent } = loadContent();
  const before = sent.length;
  api.resetPremine();
  assert.equal(sent.length, before, "nothing held, nothing to drop");
  api.state.premined = [{ key: 4, cueIds: [4], image: true, audio: true }];
  api.resetPremine();
  assert.equal(sent[sent.length - 1].type, "premineReset");
  assert.deepEqual(plain(api.state.premined), []);
});

test("premineAllowed stops on a hidden tab, an offline server and the master switch", () => {
  const { api, sandbox } = loadContent();
  api.state.videoId = "abcdef1234";
  api.state.video = { currentTime: 0, paused: false };
  assert.equal(api.premineAllowed(), true);
  sandbox.document.visibilityState = "hidden";
  assert.equal(api.premineAllowed(), false);
  sandbox.document.visibilityState = "visible";
  api.state.offline = true;
  assert.equal(api.premineAllowed(), false);
  api.state.offline = false;
  api.state.settings.enabled = false;
  assert.equal(api.premineAllowed(), false);
});

// ------------------------------------------------------------------ model setting

test("modelForSync sends the trimmed model name and nothing for the server default", () => {
  const { api } = loadContent();
  assert.equal(api.modelForSync({ model: " kotoba-tech/kotoba-whisper-v2.0-faster " }), "kotoba-tech/kotoba-whisper-v2.0-faster");
  assert.equal(api.modelForSync({ model: "large-v3" }), "large-v3");
  assert.equal(api.modelForSync({ model: "" }), "");
  assert.equal(api.modelForSync({ model: "   " }), "");
  assert.equal(api.modelForSync({ model: 42 }), ""); // storage holds whatever was put there
  assert.equal(api.modelForSync({}), "");
  assert.equal(api.modelForSync(null), "");
});

// A sync round trip against a fake server answer; the sandbox has no player or overlay, so only
// the request body and the state matter here.
async function syncWith(answer, model) {
  const loaded = loadContent();
  const { api, sandbox, sent } = loaded;
  sandbox.browser.runtime.sendMessage = async (msg) => {
    sent.push(msg);
    return msg.path === "/sync" ? { ok: true, data: answer } : { ok: true };
  };
  api.state.videoId = "abcdef1234";
  api.state.video = { currentTime: 12, paused: true };
  api.state.settings.model = model;
  await api.sync();
  return { api, body: sent.find((m) => m.path === "/sync").body };
}

test("sync asks the server for the model in the settings, trimmed, or for its default", async () => {
  assert.equal((await syncWith({ status: "ready" }, " large-v3-turbo ")).body.model, "large-v3-turbo");
  assert.equal((await syncWith({ status: "ready" }, "")).body.model, "");
});

test("sync remembers what the server is loading and what it refused, and forgets both again", async () => {
  const loading = await syncWith({ status: "ready", session: "s1", model_loading: "medium", model_error: null }, "medium");
  assert.equal(loading.api.state.modelLoading, "medium");
  assert.equal(loading.api.state.modelError, null);
  const refused = await syncWith({ status: "ready", session: "s1", model_loading: null, model_error: "not a model name" }, "../x");
  assert.equal(refused.api.state.modelLoading, null);
  assert.equal(refused.api.state.modelError, "not a model name");
  const older = await syncWith({ status: "ready", session: "s1" }, ""); // a server from before the setting
  assert.equal(older.api.state.modelLoading, null);
  assert.equal(older.api.state.modelError, null);
});

// A sequence of /sync answers, each handed out once; the request bodies are kept for inspection.
// Every other message still goes to the loader's stub, which records it in `sent`.
function serverAnswering(sandbox, answers) {
  const bodies = [];
  const other = sandbox.browser.runtime.sendMessage;
  sandbox.browser.runtime.sendMessage = async (msg) => {
    if (msg.path !== "/sync") return other(msg);
    bodies.push(msg.body);
    if (!answers.length) throw new Error("the fake server ran out of answers");
    return { ok: true, data: answers.shift() };
  };
  return bodies;
}

const cue = (id, text) => ({ id, start: id * 2, end: id * 2 + 1.5, text, seg: id });

// content.js looks for the player once its settings have loaded, a few microtasks after loadContent();
// a fake video installed before that is let go of again as not on the page. Wait that out first.
const settled = () => new Promise((resolve) => setImmediate(resolve));

test("sync starts over on a new session token, so the new session's cue ids never meet the old ones", async () => {
  const { api, sandbox, sent } = loadContent();
  await settled();
  const bodies = serverAnswering(sandbox, [
    { status: "ready", session: "a", cues: [cue(0, "旧一"), cue(1, "旧二"), cue(2, "旧三")], next: 3, covered: [[0, 30]] },
    // The model switch: a fresh session whose ids begin at 0 again, answered for the old `since`.
    { status: "pending", session: "b", model_loading: "large-v3", cues: [], next: 3 },
    { status: "ready", session: "b", cues: [cue(0, "新一"), cue(1, "新二"), cue(2, "新三"), cue(3, "新四")], next: 4, covered: [[0, 40]] },
  ]);
  api.state.videoId = "abcdef1234";
  api.state.video = { currentTime: 0.5, paused: true };
  await api.sync();
  assert.equal(bodies[0].since, 0);
  assert.equal(api.cueById(0).text, "旧一");
  api.state.activeCueId = 2;
  api.state.premined = [{ key: 2, cueIds: [2], image: true }];

  await api.sync();
  assert.equal(bodies[1].since, 3);
  assert.equal(api.state.serverSession, "b");
  assert.deepEqual(plain(api.state.cues), []);
  assert.equal(api.cueById(0), null); // the old text is gone with the old ids
  assert.equal(api.state.cueById.size, 0);
  assert.equal(api.state.since, 0);
  assert.deepEqual(plain(api.state.covered), []);
  assert.equal(api.state.activeCueId, null);
  assert.deepEqual(plain(api.state.premined), []); // keyed by a cue id of the old session
  assert.ok(sent.some((m) => m.type === "premineReset"), "the background drops the held sentence too");
  assert.equal(api.state.modelLoading, "large-v3");
  assert.equal(api.state.serverStatus, "pending");

  await api.sync();
  assert.equal(bodies[2].since, 0);
  assert.deepEqual(plain(api.state.cues.map((c) => c.text)), ["新一", "新二", "新三", "新四"]);
  assert.equal(api.cueById(0).text, "新一");
  assert.equal(api.findActiveCue(0.5).text, "新一");
  assert.equal(api.findActiveCue(6.5).text, "新四");
  assert.equal(api.state.since, 4);
});

test("a changed model name drops the old name's verdict and asks the server at once", () => {
  const { api, sent, onSettingsChanged } = loadContent();
  api.state.videoId = "abcdef1234";
  api.state.video = { currentTime: 12, paused: true };
  api.state.settings.model = "nope/../x";
  api.state.modelError = "not a model name";
  api.state.modelLoading = "medium";
  const syncs = () => sent.filter((m) => m.path === "/sync");

  onSettingsChanged({ settings: { newValue: { model: "nope/../x", showStatus: false } } }, "local");
  assert.equal(api.state.modelError, "not a model name"); // another setting: the verdict stands
  assert.equal(api.state.modelLoading, "medium");
  assert.equal(api.state.settings.showStatus, false);
  assert.equal(syncs().length, 0);

  onSettingsChanged({ settings: { newValue: { model: " large-v3 " } } }, "local");
  assert.equal(api.state.settings.model, " large-v3 ");
  assert.equal(api.state.modelError, null);
  assert.equal(api.state.modelLoading, null);
  assert.equal(syncs().length, 1);
  assert.equal(syncs()[0].body.model, "large-v3");

  onSettingsChanged({ settings: { newValue: { model: "large-v3" } } }, "sync"); // not our area
  assert.equal(syncs().length, 1);
});

test("a model changed while a request is out: that answer's verdict is left out and the new name asked about", async () => {
  const { api, sandbox, onSettingsChanged } = loadContent();
  await settled();
  const bodies = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  sandbox.browser.runtime.sendMessage = async (msg) => {
    if (msg.path !== "/sync") return { ok: true };
    bodies.push(msg.body);
    if (bodies.length === 1) {
      await gate; // the first request stays out until the test lets it back
      return { ok: true, data: { status: "ready", session: "s1", model_loading: null, model_error: "not a model name", next: 3 } };
    }
    return { ok: true, data: { status: "ready", session: "s1", model_loading: "large-v3", model_error: null, next: 3 } };
  };
  api.state.videoId = "abcdef1234";
  api.state.video = { currentTime: 12, paused: true };
  api.state.settings.model = "../x";
  const first = api.sync();
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].model, "../x");

  onSettingsChanged({ settings: { newValue: { model: "large-v3" } } }, "local");
  assert.equal(bodies.length, 1); // in flight: nothing more went out
  assert.equal(api.state.modelError, null);
  release();
  await first;
  assert.equal(api.state.modelError, null); // the old name's verdict, not put back
  assert.equal(api.state.modelLoading, null);
  assert.equal(api.state.since, 3); // the rest of the answer still counts
  assert.equal(bodies.length, 2); // and the new name went out right after it
  assert.equal(bodies[1].model, "large-v3");
  assert.equal(bodies[1].since, 3);
  await settled();
  assert.equal(api.state.modelLoading, "large-v3");
  assert.equal(bodies.length, 2);

  // Changed and changed back while a request is out: its answer is about the current name.
  api.state.settings.model = "large-v3";
  const third = api.sync();
  onSettingsChanged({ settings: { newValue: { model: "small" } } }, "local");
  onSettingsChanged({ settings: { newValue: { model: " large-v3 " } } }, "local");
  await third;
  assert.equal(api.state.modelLoading, "large-v3");
  assert.equal(bodies.length, 3);
});

function statusElement() {
  const el = { textContent: "", classes: new Set() };
  el.classList = {
    add: (c) => el.classes.add(c),
    remove: (c) => el.classes.delete(c),
    contains: (c) => el.classes.has(c),
    toggle: (c, on) => (on ? el.classes.add(c) : el.classes.delete(c)),
  };
  return el;
}

test("updateStatus caps the server's model error like a toast", () => {
  const { api } = loadContent();
  const el = statusElement();
  api.state.statusEl = el;
  api.state.videoId = "abcdef1234";
  api.state.serverStatus = "ready";
  api.state.settings.model = "large-v3";
  api.state.modelError = "e".repeat(160);
  api.updateStatus();
  assert.equal(el.textContent, `Shisu-ko: model large-v3: ${"e".repeat(160)}`); // exactly the cap: untouched
  api.state.modelError = "e".repeat(161);
  api.updateStatus();
  assert.equal(el.textContent, `Shisu-ko: model large-v3: ${"e".repeat(159)}…`);
  api.state.settings.model = "x".repeat(300); // the server refuses it; the line still fits
  api.updateStatus();
  assert.equal(el.textContent, `Shisu-ko: model ${"x".repeat(99)}…: ${"e".repeat(159)}…`);
});

test("updateStatus shows a refused model even with progress messages off, and a load in progress", () => {
  const { api } = loadContent();
  const el = statusElement();
  api.state.statusEl = el;
  api.state.videoId = "abcdef1234";
  api.state.serverStatus = "ready";
  api.state.settings.showStatus = false;
  api.state.settings.model = "nope/../x";
  api.state.modelError = "not a model name";
  api.updateStatus();
  assert.equal(el.textContent, "Shisu-ko: model nope/../x: not a model name");
  assert.ok(el.classes.has("shisuko-status-error"));
  assert.ok(!el.classes.has("shisuko-hidden"));

  api.state.modelError = null;
  api.state.modelLoading = "large-v3-turbo";
  api.updateStatus();
  assert.ok(el.classes.has("shisuko-hidden")); // a plain progress message obeys the setting
  api.state.settings.showStatus = true;
  api.updateStatus();
  assert.equal(el.textContent, "Loading model large-v3-turbo… (a first use downloads it)");
  assert.ok(!el.classes.has("shisuko-status-error"));
});

// The audio fetch and the model load run on their own threads on the server: a members-only video
// fails within seconds while a first large-v3 downloads for minutes, and both come in one answer.
test("updateStatus keeps a failed session in front of a model load, even with progress messages off", () => {
  const { api } = loadContent();
  const el = statusElement();
  api.state.statusEl = el;
  api.state.videoId = "abcdef1234";
  api.state.serverStatus = "error";
  api.state.serverError = "This video is only available to members";
  api.state.modelLoading = "large-v3";
  api.state.settings.showStatus = false;
  api.updateStatus();
  assert.equal(el.textContent, "Shisu-ko: This video is only available to members");
  assert.ok(el.classes.has("shisuko-status-error"));
  assert.ok(!el.classes.has("shisuko-hidden"));

  api.state.settings.model = "large-v3";
  api.state.modelError = "no such model large-v3"; // the model's own verdict still comes first
  api.updateStatus();
  assert.equal(el.textContent, "Shisu-ko: model large-v3: no such model large-v3");

  api.state.modelError = null;
  api.state.serverStatus = "downloading"; // the retry: now the load is what transcription waits for
  api.state.settings.showStatus = true;
  api.updateStatus();
  assert.equal(el.textContent, "Loading model large-v3… (a first use downloads it)");
  assert.ok(!el.classes.has("shisuko-status-error"));
});

// ------------------------------------------------------------------ font family

const GOTHIC = '"Noto Sans JP", "Noto Sans CJK JP", "Yu Gothic UI", "Yu Gothic", "Meiryo", "Hiragino Sans", sans-serif';

test("fontStack puts an installed family in front of the preset's stack", () => {
  const { api } = loadContent();
  assert.equal(api.fontStack("default", "Yu Gothic UI"), `"Yu Gothic UI", ${GOTHIC}`);
  assert.equal(api.fontStack("default", "  游ゴシック  "), `"游ゴシック", ${GOTHIC}`); // trimmed, Japanese names allowed
  assert.equal(api.fontStack("gothic-bold", "UD Digi Kyokasho NP-R"), `"UD Digi Kyokasho NP-R", ${GOTHIC}`);
  assert.equal(api.fontStack("default", "M PLUS 1p"), `"M PLUS 1p", ${GOTHIC}`);
  assert.equal(api.fontStack("default", "Noto.Sans_JP"), `"Noto.Sans_JP", ${GOTHIC}`);
  assert.ok(api.fontStack("mincho", "Klee").startsWith('"Klee", "Noto Serif JP"'));
});

test("fontStack falls back to the preset alone for an empty or unusable family name", () => {
  const { api } = loadContent();
  assert.equal(api.fontStack("default", ""), GOTHIC);
  assert.equal(api.fontStack("default", undefined), GOTHIC);
  assert.equal(api.fontStack("default", 7), GOTHIC);
  assert.equal(api.fontStack("nonsense", ""), GOTHIC); // an unknown preset is the default one
  // Written as JS literals: "a\\b" holds a backslash, "a\bb" a backspace, "a\nb" a newline.
  for (const bad of ['Yu "Gothic"', "Yu; color: red", "a { b }", "a\\b", "a\bb", "a\nb", "Yu\tGothic", "url(https://evil.example/x)", "-leading", "x".repeat(101)]) {
    assert.equal(api.fontStack("default", bad), GOTHIC, JSON.stringify(bad));
  }
  assert.ok(!api.fontStack("default", "a\\b").includes("\\")); // a backslash would escape the closing quote
  assert.equal(api.fontStack("default", "x".repeat(100)), `"${"x".repeat(100)}", ${GOTHIC}`);
});

// ------------------------------------------------------------------ word colours

const words = require("../words");

// A deck as the background hands it over, [word, status, pitch], and a line holding both words.
const DECK = [["日本語", "learned", null], ["字幕", "new", "heiban"]];
const LINE = "これは日本語の字幕です";

// What renderText put into an element: a text node as its text, a span as class{marks}:text.
function nodes(el) {
  return el.childNodes.map((node) => {
    if (node.nodeType === 3) return node.textContent;
    const marks = Object.entries(node.dataset).map(([key, value]) => `${key}=${value}`).join(",");
    return `${node.className}{${marks}}:${node.textContent}`;
  });
}

// The deck's index as a poll would have left it. An async test gives it only after settled():
// the settings loaded at start-up replace whatever was put in state.settings before.
function giveIndex(api, settings) {
  Object.assign(api.state.settings, settings);
  api.state.wordIndex = words.buildIndex(DECK);
  api.state.wordIndexAt = 1000;
  api.state.wordIndexKey = JSON.stringify(DECK);
}

function withIndex(settings) {
  const loaded = loadContent();
  giveIndex(loaded.api, settings);
  return loaded;
}

// A subtitle box and its text span, as buildOverlay() would have made them.
function subtitleBox(api, sandbox) {
  api.state.subBox = sandbox.document.createElement("div");
  api.state.subText = sandbox.document.createElement("span");
}

// The background's answers to the cardStatus asks, handed out in order and the asks kept; every
// other message still goes to the loader's stub.
function backgroundAnswering(sandbox, answers) {
  const asks = [];
  const other = sandbox.browser.runtime.sendMessage;
  sandbox.browser.runtime.sendMessage = async (msg) => {
    if (msg.type !== "cardStatus") return other(msg);
    asks.push(msg);
    if (!answers.length) throw new Error("the fake background ran out of answers");
    return answers.shift();
  };
  return asks;
}

test("wordColoursOn needs the master switch and one of the two colours", () => {
  const { api } = loadContent();
  assert.equal(api.wordColoursOn(), false);
  api.state.settings.cardStatus = true;
  assert.equal(api.wordColoursOn(), true);
  api.state.settings.cardStatus = false;
  api.state.settings.pitchAccent = true;
  assert.equal(api.wordColoursOn(), true);
  api.state.settings.enabled = false;
  assert.equal(api.wordColoursOn(), false);
});

test("renderText writes plain text while both colours are off, or without an index", () => {
  const { api, sandbox } = withIndex({});
  const el = sandbox.document.createElement("span");
  api.renderText(el, LINE);
  assert.deepEqual(nodes(el), [LINE]);
  api.state.settings.cardStatus = true;
  api.state.settings.enabled = false;
  api.renderText(el, LINE);
  assert.deepEqual(nodes(el), [LINE]);
  api.state.settings.enabled = true;
  api.state.wordIndex = null;
  api.renderText(el, LINE);
  assert.deepEqual(nodes(el), [LINE]);
});

test("renderText marks the card's state only with cardStatus on, in spans holding text nodes", () => {
  const { api, sandbox } = withIndex({ cardStatus: true });
  const el = sandbox.document.createElement("span");
  api.renderText(el, LINE);
  assert.deepEqual(nodes(el), ["これは", "shisuko-word{status=learned}:日本語", "の", "shisuko-word{status=new}:字幕", "です"]);
  assert.equal(el.textContent, LINE); // the DOM text is the line, for Yomitan
  assert.equal(el.childNodes[1].childNodes[0].nodeType, 3);
  api.renderText(el, "字幕"); // drawn again: the old children go
  assert.deepEqual(nodes(el), ["shisuko-word{status=new}:字幕"]);
});

test("renderText marks the pitch only with pitchAccent on, and joins the text around it", () => {
  const { api, sandbox } = withIndex({ pitchAccent: true });
  const el = sandbox.document.createElement("span");
  api.renderText(el, LINE);
  // 日本語 has a card but no pitch: with the state not shown it is text like the rest.
  assert.deepEqual(nodes(el), ["これは日本語の", "shisuko-word{pitch=heiban}:字幕", "です"]);
  assert.equal(el.textContent, LINE);
});

test("renderText marks both with both colours on", () => {
  const { api, sandbox } = withIndex({ cardStatus: true, pitchAccent: true });
  const el = sandbox.document.createElement("span");
  api.renderText(el, LINE);
  assert.deepEqual(nodes(el), ["これは", "shisuko-word{status=learned}:日本語", "の", "shisuko-word{status=new,pitch=heiban}:字幕", "です"]);
  api.renderText(el, "");
  assert.deepEqual(nodes(el), []);
});

test("setSubtitle and transcriptLine draw their text through renderText", () => {
  const { api, sandbox } = withIndex({ cardStatus: true });
  subtitleBox(api, sandbox);
  api.mergeCues([{ id: 0, start: 0, end: 2, text: LINE }]);
  api.setSubtitle(api.cueById(0));
  assert.equal(api.state.activeCueId, 0);
  assert.ok(!api.state.subBox.classList.contains("shisuko-hidden"));
  assert.equal(nodes(api.state.subText)[1], "shisuko-word{status=learned}:日本語");
  assert.equal(api.state.subText.textContent, LINE);

  const line = api.transcriptLine(api.cueById(0));
  assert.equal(line.className, "shisuko-line");
  assert.equal(line.dataset.id, "0");
  const text = line.childNodes[1];
  assert.equal(text.className, "shisuko-linetext");
  assert.deepEqual(nodes(text), ["これは", "shisuko-word{status=learned}:日本語", "の", "shisuko-word{status=new}:字幕", "です"]);
  assert.equal(api.state.lineById.get(0), line);

  api.setSubtitle(null);
  assert.equal(api.state.subText.textContent, "");
  assert.ok(api.state.subBox.classList.contains("shisuko-hidden"));
});

test("refreshWordMarks redraws the line on screen and rebuilds the transcript while it is shown", () => {
  const { api, sandbox } = loadContent();
  api.state.settings.cardStatus = true;
  api.state.settings.showTranscript = true;
  subtitleBox(api, sandbox);
  api.state.transcriptList = sandbox.document.createElement("div");
  api.mergeCues([{ id: 0, start: 0, end: 2, text: LINE }, { id: 1, start: 3, end: 4, text: "字幕" }]);
  api.setSubtitle(api.cueById(0));
  const before = api.state.lineById.get(0);
  assert.deepEqual(nodes(api.state.subText), [LINE]); // no index yet
  assert.deepEqual(nodes(before.childNodes[1]), [LINE]);

  api.state.wordIndex = words.buildIndex(DECK);
  api.refreshWordMarks();
  assert.equal(nodes(api.state.subText).length, 5);
  assert.equal(api.state.transcriptList.childNodes.length, 2);
  const after = api.state.lineById.get(0);
  assert.notEqual(after, before); // a full rebuild
  assert.equal(nodes(after.childNodes[1]).length, 5);
  assert.deepEqual(nodes(api.state.lineById.get(1).childNodes[1]), ["shisuko-word{status=new}:字幕"]);
  assert.equal(api.state.transcriptDirty, false);
  assert.equal(api.state.transcriptAppendFrom, null);

  api.state.settings.showTranscript = false;
  api.state.wordIndex = null;
  api.refreshWordMarks();
  assert.deepEqual(nodes(api.state.subText), [LINE]);
  assert.equal(api.state.lineById.get(0), after); // a hidden transcript is left for applySettings()
  assert.equal(api.state.transcriptDirty, false);
});

test("pollWordIndex asks only with a colour on, the tab visible and the interval past, one ask at a time", async () => {
  const { api, sandbox } = loadContent();
  const asks = backgroundAnswering(sandbox, [{ ok: true, unchanged: true }, { ok: true, unchanged: true }]);
  await api.pollWordIndex();
  assert.equal(asks.length, 0); // both colours off
  api.state.settings.pitchAccent = true;
  sandbox.document.visibilityState = "hidden";
  await api.pollWordIndex();
  assert.equal(asks.length, 0);
  sandbox.document.visibilityState = "visible";
  await api.pollWordIndex();
  assert.equal(asks.length, 1);
  assert.deepEqual(plain(asks[0]), { type: "cardStatus", since: 0 });
  await api.pollWordIndex();
  assert.equal(asks.length, 1); // asked a moment ago
  api.state.wordIndexAskedAt = Date.now() - 30_000;
  api.state.wordIndexAt = 1000;
  await api.pollWordIndex();
  assert.equal(asks.length, 2);
  assert.equal(asks[1].since, 1000);
  api.state.wordIndexAskedAt = 0;
  api.state.settings.enabled = false;
  await api.pollWordIndex();
  assert.equal(asks.length, 2); // the master switch: nothing goes out

  // An ask still out: the next tick waits for it instead of sending a second one.
  api.state.settings.enabled = true;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  sandbox.browser.runtime.sendMessage = async (msg) => {
    asks.push(msg);
    await gate;
    return { ok: true, unchanged: true };
  };
  const pending = api.pollWordIndex();
  assert.equal(asks.length, 3);
  api.state.wordIndexAskedAt = 0;
  await api.pollWordIndex();
  assert.equal(asks.length, 3);
  release();
  await pending;
  assert.equal(api.state.wordIndexInFlight, false);
});

test("pollWordIndex keeps an unchanged index, moves the stamp for the same words and rebuilds on new ones", async () => {
  const { api, sandbox } = loadContent();
  await settled();
  api.state.settings.cardStatus = true;
  subtitleBox(api, sandbox);
  api.mergeCues([{ id: 0, start: 0, end: 2, text: LINE }]);
  api.setSubtitle(api.cueById(0));
  const asks = backgroundAnswering(sandbox, [
    { ok: true, deck: "Mining", automatic: true, at: 1000, entries: DECK },
    { ok: true, unchanged: true, at: 1000, deck: "Mining" },
    { ok: true, deck: "Mining", automatic: true, at: 2000, entries: DECK, stale: true },
    { ok: true, deck: "Mining", automatic: true, at: 3000, entries: [["日本語", "learning", null]] },
  ]);
  await api.pollWordIndex();
  assert.equal(api.state.wordIndexAt, 1000);
  assert.equal(api.state.wordIndex.size, 2);
  assert.equal(nodes(api.state.subText)[1], "shisuko-word{status=learned}:日本語");
  const built = api.state.wordIndex;

  api.state.wordIndexAskedAt = 0;
  await api.pollWordIndex();
  assert.equal(asks[1].since, 1000);
  assert.equal(api.state.wordIndex, built);

  // Refetched by the background and stamped anew, the same words: nothing is redrawn.
  const drawn = api.state.subText.childNodes[1];
  api.state.wordIndexAskedAt = 0;
  await api.pollWordIndex();
  assert.equal(api.state.wordIndexAt, 2000);
  assert.equal(api.state.wordIndex, built);
  assert.equal(api.state.subText.childNodes[1], drawn);

  // A card reviewed since: a new index, and the line drawn again.
  api.state.wordIndexAskedAt = 0;
  await api.pollWordIndex();
  assert.equal(asks[3].since, 2000);
  assert.equal(api.state.wordIndexAt, 3000);
  assert.equal(api.state.wordIndex.size, 1);
  assert.deepEqual(nodes(api.state.subText), ["これは", "shisuko-word{status=learning}:日本語", "の字幕です"]);
});

test("pollWordIndex drops the index when the background says off, and logs other failures once a minute", async () => {
  const { api, sandbox } = loadContent();
  await settled();
  giveIndex(api, { cardStatus: true });
  subtitleBox(api, sandbox);
  api.state.toastEl = sandbox.document.createElement("div");
  api.mergeCues([{ id: 0, start: 0, end: 2, text: LINE }]);
  api.setSubtitle(api.cueById(0));
  assert.equal(nodes(api.state.subText).length, 5);
  const logs = [];
  sandbox.console = { debug: (...args) => logs.push(args.join(" ")), log: () => {}, warn: () => {}, error: () => {} };
  backgroundAnswering(sandbox, [
    { ok: false, reason: "offline", error: "Anki is not running or AnkiConnect is not installed" },
    { ok: false, reason: "noDeck", error: "No card mined yet; pick a deck in the popup" },
    { ok: false, reason: "off" },
  ]);
  api.state.wordIndexAskedAt = 0;
  await api.pollWordIndex();
  assert.equal(logs.length, 1);
  assert.match(logs[0], /word colours: Anki is not running/);
  assert.equal(api.state.wordIndex.size, 2); // a failure keeps what there is
  assert.equal(nodes(api.state.subText).length, 5);
  assert.equal(api.state.toastEl.textContent, ""); // never a toast

  api.state.wordIndexAskedAt = 0;
  await api.pollWordIndex();
  assert.equal(logs.length, 1); // within the minute
  api.state.lastWordIndexLog = Date.now() - 60_000;
  api.state.wordIndexAskedAt = 0;
  await api.pollWordIndex();
  assert.equal(api.state.wordIndex, null);
  assert.equal(api.state.wordIndexAt, 0);
  assert.equal(logs.length, 1); // "off" is not a failure
  assert.deepEqual(nodes(api.state.subText), [LINE]);
  assert.equal(api.state.toastEl.textContent, "");
});

test("a changed deck or colour starts the index over and asks for the new one at once, never while off", async () => {
  const { api, sandbox, onSettingsChanged } = loadContent();
  await settled();
  giveIndex(api, { cardStatus: true });
  subtitleBox(api, sandbox);
  api.mergeCues([{ id: 0, start: 0, end: 2, text: LINE }]);
  api.setSubtitle(api.cueById(0));
  api.state.wordIndexAskedAt = Date.now();
  const asks = backgroundAnswering(sandbox, [{ ok: true, unchanged: true }, { ok: true, unchanged: true }, { ok: true, unchanged: true }]);

  onSettingsChanged({ settings: { newValue: { cardStatus: true, showStatus: false } } }, "local");
  assert.equal(api.state.wordIndex.size, 2); // another setting: the index stands
  assert.equal(api.state.wordIndexAt, 1000);
  assert.equal(asks.length, 0);

  onSettingsChanged({ settings: { newValue: { cardStatus: true, cardStatusDeck: "Vocab" } } }, "local");
  assert.equal(api.state.wordIndex, null);
  assert.equal(api.state.wordIndexAt, 0);
  assert.equal(api.state.wordIndexKey, "");
  assert.deepEqual(nodes(api.state.subText), [LINE]); // plain again at once
  assert.equal(asks.length, 1);
  assert.equal(asks[0].since, 0);
  await settled(); // the answer is back

  api.state.wordIndex = words.buildIndex(DECK);
  onSettingsChanged({ settings: { newValue: { cardStatus: false, cardStatusDeck: "Vocab" } } }, "local");
  assert.equal(api.state.wordIndex, null); // turned off: dropped, nothing asked
  assert.equal(asks.length, 1);

  onSettingsChanged({ settings: { newValue: { enabled: false, cardStatus: true, cardStatusDeck: "Other" } } }, "local");
  assert.equal(asks.length, 1); // the master switch off: a deck change asks nothing either

  onSettingsChanged({ settings: { newValue: { pitchAccent: true, ankiPitchField: "Pitch" } } }, "local");
  assert.equal(asks.length, 2);
  await settled();
  api.state.wordIndexAskedAt = 0;
  onSettingsChanged({ settings: { newValue: { pitchAccent: true, ankiPitchField: "Pitch", ankiWordField: "Word" } } }, "local");
  assert.equal(asks.length, 2); // the word field is the background's business (it drops its own cache)
});

test("the master switch off: syncTick sends nothing, the deck index included", async () => {
  const { api, sent } = loadContent();
  await settled();
  api.state.video = { currentTime: 0, paused: false };
  api.state.settings.cardStatus = true;
  api.state.settings.pitchAccent = true;
  api.state.settings.enabled = false;
  const before = sent.length;
  api.syncTick();
  assert.equal(sent.length, before);
  api.state.settings.enabled = true;
  api.syncTick();
  assert.deepEqual(plain(sent.slice(before).map((m) => m.type)), ["cardStatus", "api"]);
  assert.equal(sent[before].since, 0);
});

test("a new server session drops the cues but not the deck index", async () => {
  const { api, sandbox } = loadContent();
  await settled();
  giveIndex(api, { cardStatus: true });
  serverAnswering(sandbox, [
    { status: "ready", session: "a", cues: [cue(0, "旧一")], next: 1 },
    { status: "ready", session: "b", cues: [], next: 1 },
  ]);
  api.state.videoId = "abcdef1234";
  api.state.video = { currentTime: 0.5, paused: true };
  await api.sync();
  await api.sync();
  assert.deepEqual(plain(api.state.cues), []);
  assert.equal(api.state.wordIndex.size, 2);
  assert.equal(api.state.wordIndexAt, 1000);
});

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

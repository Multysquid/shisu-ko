"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadBackground } = require("./_loadBackground");

const plain = (value) => JSON.parse(JSON.stringify(value));

// Records every request that actually reached the server, and answers like /sync does. A tab told
// to stand by never gets here, so `calls` is the honest measure of what the election let through.
function recorder(calls) {
  return async (url, init) => {
    calls.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: "ready", cues: [] }) };
  };
}

const syncMsg = (paused = false) => ({
  type: "api",
  path: "/sync",
  body: { video_id: "abcdef1234", url: "https://www.youtube.com/watch?v=abcdef1234", t: 0, paused, since: 0 },
});

const status = (answer) => plain(answer).data.status;
const settled = () => new Promise((resolve) => setImmediate(resolve));

const T0 = 1_000_000;
const seen = (at, paused = false) => ({ at, paused });

// ------------------------------------------------------------------ electSyncTab (pure)
//
// One case per rule, each built so that deleting the rule it names changes the answer.

test("rule 1: the tab the viewer is watching takes the right by asking for it", () => {
  const { sandbox } = loadBackground();
  // Without rule 1 the playing holder would keep it (rule 5) and the watched tab would never sync.
  const tabs = new Map([[1, seen(T0)], [2, seen(T0, true)]]);
  assert.equal(sandbox.electSyncTab(2, 1, 2, tabs, T0), 2);
});

test("rule 2: a holder that has gone quiet hands the right to whoever asks", () => {
  const { sandbox } = loadBackground();
  const timeout = sandbox.HOLD_TIMEOUT_MS;
  const tabs = new Map([[1, seen(T0)], [2, seen(T0 + timeout + 1)]]);
  // Without rule 2 the silent playing holder would keep it through rules 4 and 5, forever.
  assert.equal(sandbox.electSyncTab(2, 1, null, tabs, T0 + timeout + 1), 2);
  // Rule 2 is also what makes the lookups in rule 4 safe: a holder nobody has ever heard from,
  // and no holder at all, both leave before `tabs.get(current)` is read.
  assert.equal(sandbox.electSyncTab(2, 7, null, tabs, T0), 2);
  assert.equal(sandbox.electSyncTab(2, null, null, tabs, T0), 2);
  assert.equal(sandbox.electSyncTab(2, undefined, null, tabs, T0), 2);
  assert.equal(sandbox.electSyncTab(2, 2, null, tabs, T0), 2); // the asker already holds it
});

test("rule 3: the watched tab keeps the right while it is paused, and loses it once it falls silent", () => {
  const { sandbox } = loadBackground();
  const stale = sandbox.FOCUS_STALE_MS;
  assert.ok(stale > 5000, "a paused tab syncs every 5 s: a shorter window would make the right flap");
  assert.ok(stale < sandbox.HOLD_TIMEOUT_MS, "a focused tab that stopped syncing must not hold on for the full timeout");
  const tabs = new Map([[1, seen(T0, true)], [2, seen(T0 + stale)]]);
  // Without rule 3 the paused watched tab would lose the right to a playing one (rule 4) the
  // moment the viewer stopped the video to read the line.
  assert.equal(sandbox.electSyncTab(2, 1, 1, tabs, T0 + stale - 1), 1);
  assert.equal(sandbox.electSyncTab(2, 1, 1, tabs, T0 + stale + 1), 2); // silent past the window: rule 4
});

test("rule 4: a playing video beats a paused one", () => {
  const { sandbox } = loadBackground();
  const tabs = new Map([[1, seen(T0, true)], [2, seen(T0)]]);
  // Without rule 4 the paused holder would keep the server while the viewer watches elsewhere.
  assert.equal(sandbox.electSyncTab(2, 1, null, tabs, T0), 2);
});

test("rule 5: otherwise the holder keeps the right", () => {
  const { sandbox } = loadBackground();
  const both = new Map([[1, seen(T0)], [2, seen(T0)]]);
  // Without rule 5 every asking tab would take the right in turn and the server would thrash.
  assert.equal(sandbox.electSyncTab(2, 1, null, both, T0), 1);
  const paused = new Map([[1, seen(T0)], [2, seen(T0, true)]]);
  assert.equal(sandbox.electSyncTab(2, 1, null, paused, T0), 1); // a paused asker beats nothing
});

test("the election never names a tab that is not asking", () => {
  const { sandbox } = loadBackground();
  const tabs = new Map([[1, seen(T0)], [2, seen(T0)], [3, seen(T0)]]);
  // Tab 3 is watched and fresh, but tab 2 asked: the answer is one of the two tabs in play, never
  // the bystander. Tab 3 takes the right back on its own next tick, through rule 1.
  assert.ok([1, 2].includes(sandbox.electSyncTab(2, 1, 3, tabs, T0)));
  assert.equal(sandbox.electSyncTab(3, 1, 3, tabs, T0), 3);
});

// ------------------------------------------------------------------ the listener

test("only the first syncing tab reaches the server", async () => {
  const calls = [];
  const { dispatch } = loadBackground({ fetch: recorder(calls) });
  assert.equal(status(await dispatch(syncMsg(), 1)), "ready");
  assert.equal(calls.length, 1);
  // The wire format a standby tab sees; content.js and the browser smoke test both read it.
  assert.deepEqual(plain(await dispatch(syncMsg(), 2)), { ok: true, data: { status: "standby" } });
  assert.equal(calls.length, 1); // nothing new went out
});

test("activating a tab in the focused window hands it the right on its next tick", async () => {
  const calls = [];
  const { dispatch, activateTab, focusWindow } = loadBackground({ fetch: recorder(calls) });
  await dispatch(syncMsg(), 1);
  assert.equal(status(await dispatch(syncMsg(), 2)), "standby");
  assert.equal(calls.length, 1);

  activateTab(2, 10);
  await focusWindow(10);
  assert.equal(status(await dispatch(syncMsg(), 2)), "ready"); // one tick, not twelve seconds
  assert.equal(calls.length, 2);
  assert.equal(status(await dispatch(syncMsg(), 1)), "standby");
  assert.equal(calls.length, 2);
});

// The regression for the focus handling that only listened to tabs.onActivated: browsers fire that
// event when the selection changes *inside* a window, never when focus moves between windows. A
// window whose selection has not changed since the event page started (a browser restart, a
// service worker restart) then has no entry at all, and the tab the viewer is watching would stand
// by forever.
test("focus moving to a window that never fired onActivated still finds its tab", async () => {
  const calls = [];
  const queries = [];
  const { dispatch, focusWindow } = loadBackground({
    fetch: recorder(calls),
    tabsQuery: async (query) => {
      queries.push(query);
      if (query.lastFocusedWindow) return []; // nothing focused when the event page started
      return query.windowId === 20 ? [{ id: 1, windowId: 20 }] : [];
    },
  });
  await settled();
  await dispatch(syncMsg(), 2); // tab 2, in some other window, holds the right
  assert.equal(status(await dispatch(syncMsg(), 1)), "standby");

  await focusWindow(20); // the viewer switches windows; no tab selection changed, so no onActivated
  assert.ok(queries.some((q) => q.active === true && q.windowId === 20));
  assert.equal(status(await dispatch(syncMsg(), 1)), "ready");
  assert.equal(status(await dispatch(syncMsg(), 2)), "standby");
  assert.equal(calls.length, 2);
});

// The regression for a rule that parked the right on the focused tab whether or not it was asking:
// the focused tab going quiet then blanked every other tab for the full HOLD_TIMEOUT_MS.
test("a watched tab that stops syncing releases the right after the focus window, not the hold timeout", async () => {
  const calls = [];
  const { dispatch, activateTab, focusWindow, sandbox, setNow } = loadBackground({ fetch: recorder(calls) });
  const { FOCUS_STALE_MS, HOLD_TIMEOUT_MS } = sandbox;
  setNow(T0);
  activateTab(1, 10);
  await focusWindow(10);
  await dispatch(syncMsg(true), 1); // the viewer paused this tab to read the line: it holds the right
  assert.equal(status(await dispatch(syncMsg(false), 2)), "standby");
  assert.equal(calls.length, 1);

  // Alt+Shift+S in tab 1 (the YouTube home page, a throttled tab: the same silence). It is still
  // the focused tab, and it never asks again.
  setNow(T0 + FOCUS_STALE_MS - 1);
  assert.equal(status(await dispatch(syncMsg(false), 2)), "standby");
  setNow(T0 + FOCUS_STALE_MS + 1);
  assert.equal(status(await dispatch(syncMsg(false), 2)), "ready");
  assert.ok(FOCUS_STALE_MS + 1 < HOLD_TIMEOUT_MS, "and well before the holder timeout");
  assert.equal(calls.length, 2);

  // The right went to the tab that asked for it, never to the silent one. When the viewer turns
  // tab 1 back on, its own next tick takes it back through rule 1.
  assert.equal(status(await dispatch(syncMsg(false), 1)), "ready");
  assert.equal(status(await dispatch(syncMsg(false), 2)), "standby");
  assert.equal(calls.length, 3);
});

test("a watched tab syncing through an ad keeps the right: to the election an ad is a playing video", async () => {
  const calls = [];
  const { dispatch, activateTab, focusWindow, sandbox, setNow } = loadBackground({ fetch: recorder(calls) });
  activateTab(1, 10);
  activateTab(2, 20);
  await focusWindow(10);
  // A 30 s mid-roll in tab 1. The content script keeps asking every second through it, on the
  // video's own position (the session must not time out under a long ad), so the ad is not one of
  // the silences FOCUS_STALE_MS is sized for: tab 2, playing in another window, waits it out.
  const ad = 30;
  assert.ok(ad * 1000 > sandbox.HOLD_TIMEOUT_MS, "longer than every timeout, so the right had every chance to pass");
  for (let s = 0; s <= ad; s++) {
    setNow(T0 + s * 1000);
    assert.equal(status(await dispatch(syncMsg(false), 1)), "ready", `${s} s`);
    assert.equal(status(await dispatch(syncMsg(false), 2)), "standby", `${s} s`);
  }
  assert.equal(calls.length, ad + 1);
});

test("losing browser focus altogether leaves the right where it is", async () => {
  const calls = [];
  const queries = [];
  const { dispatch, activateTab, focusWindow, sandbox } = loadBackground({
    fetch: recorder(calls),
    tabsQuery: async (query) => {
      queries.push(query);
      return [];
    },
  });
  activateTab(2, 10);
  await focusWindow(10);
  await dispatch(syncMsg(), 2);
  const asked = queries.length;

  await focusWindow(sandbox.browser.windows.WINDOW_ID_NONE); // the viewer switched to another app
  assert.equal(queries.length, asked, "WINDOW_ID_NONE is no window: nothing to ask about");
  assert.equal(status(await dispatch(syncMsg(), 1)), "standby");
  assert.equal(status(await dispatch(syncMsg(), 2)), "ready");
  assert.equal(calls.length, 2);
});

test("closing the holding tab frees the right and forgets it was a window's active tab", async () => {
  const calls = [];
  const { dispatch, activateTab, focusWindow, closeTab, sandbox } = loadBackground({ fetch: recorder(calls) });
  activateTab(2, 10);
  await focusWindow(10);
  await dispatch(syncMsg(), 2);
  assert.equal(status(await dispatch(syncMsg(), 1)), "standby");
  assert.equal(sandbox.activeTabs.get(10), 2);

  closeTab(2);
  assert.equal(sandbox.activeTabs.has(10), false, "a closed tab is nobody's active tab any more");
  assert.equal(sandbox.syncers.has(2), false);
  assert.equal(status(await dispatch(syncMsg(), 1)), "ready");
  assert.equal(calls.length, 2);
});

test("the popup and other paths are never held back", async () => {
  const calls = [];
  const { dispatch, sandbox } = loadBackground({ fetch: recorder(calls) });
  await dispatch(syncMsg(), 1);
  await dispatch({ type: "api", path: "/health" }, 2); // a second tab asking something else
  await dispatch({ type: "api", path: "/sync", body: { video_id: "abcdef1234" } }); // the popup: no tab
  assert.equal(calls.length, 3);
  assert.equal(sandbox.syncers.has(-1), false, "the popup is no tab and stands in no election");
  assert.equal(status(await dispatch(syncMsg(), 2)), "standby"); // and it did not take the right
});

test("a paused holder yields to a playing tab, a playing one does not", async () => {
  const calls = [];
  const { dispatch } = loadBackground({ fetch: recorder(calls) });
  await dispatch(syncMsg(true), 1);
  assert.equal(status(await dispatch(syncMsg(false), 2)), "ready");
  assert.equal(calls.length, 2);

  const other = [];
  const second = loadBackground({ fetch: recorder(other) });
  await second.dispatch(syncMsg(false), 1);
  assert.equal(status(await second.dispatch(syncMsg(true), 2)), "standby");
  assert.equal(other.length, 1);
});

test("the tab the viewer is watching keeps the right while it is paused", async () => {
  const calls = [];
  const { dispatch, activateTab, focusWindow } = loadBackground({ fetch: recorder(calls) });
  activateTab(1, 10);
  await focusWindow(10);
  await dispatch(syncMsg(true), 1); // paused, and watched
  assert.equal(status(await dispatch(syncMsg(false), 2)), "standby"); // a playing tab does not take it
  assert.equal(status(await dispatch(syncMsg(true), 1)), "ready");
  assert.equal(calls.length, 2);
});

test("a holder that has gone quiet past the timeout yields, watched or not", async () => {
  const calls = [];
  const { dispatch, sandbox, setNow } = loadBackground({ fetch: recorder(calls) });
  setNow(T0);
  await dispatch(syncMsg(), 1);
  assert.equal(status(await dispatch(syncMsg(), 2)), "standby");

  setNow(T0 + sandbox.HOLD_TIMEOUT_MS + 1);
  assert.equal(status(await dispatch(syncMsg(), 2)), "ready");
  assert.equal(calls.length, 2);
  assert.equal(status(await dispatch(syncMsg(), 1)), "standby"); // tab 2 holds it now
  assert.equal(calls.length, 2);
});

// The event page starts after the windows exist, so it asks once who is in front. That answer is
// stale by the time it arrives if a real focus change overtook it.
test("the startup seed does not overwrite a focus change that overtook it", async () => {
  const calls = [];
  let release;
  const seeding = new Promise((resolve) => (release = resolve));
  const { dispatch, focusWindow, sandbox } = loadBackground({
    fetch: recorder(calls),
    tabsQuery: async (query) => {
      if (query.lastFocusedWindow) {
        await seeding;
        return [{ id: 9, windowId: 30 }];
      }
      return query.windowId === 20 ? [{ id: 1, windowId: 20 }] : [];
    },
  });
  await dispatch(syncMsg(), 2); // tab 2 holds the right
  await focusWindow(20);        // and the viewer moves to the window showing tab 1

  release();
  await settled();
  assert.equal(sandbox.activeTabs.get(30), 9, "the seed still records what that window was showing");
  assert.equal(status(await dispatch(syncMsg(), 1)), "ready", "but the focus change is what counts");
  assert.equal(calls.length, 2);
});

test("the startup seed names the focused window when nothing else has", async () => {
  const calls = [];
  const { dispatch } = loadBackground({
    fetch: recorder(calls),
    tabsQuery: async (query) => (query.lastFocusedWindow ? [{ id: 2, windowId: 10 }] : []),
  });
  await settled();
  await dispatch(syncMsg(), 1);
  assert.equal(status(await dispatch(syncMsg(), 2)), "ready");
  assert.equal(status(await dispatch(syncMsg(), 1)), "standby");
  assert.equal(calls.length, 2);
});

test("a playing holder that stops syncing releases the right after the focus window too", () => {
  const { sandbox } = loadBackground();
  const { electSyncTab, FOCUS_STALE_MS, HOLD_TIMEOUT_MS } = sandbox;
  const now = 100000;
  // The holder is tab 2, focused, playing, and last heard from between the two timeouts.
  const tabs = new Map([
    [1, { at: now, paused: false }],
    [2, { at: now - (FOCUS_STALE_MS + 1000), paused: false }],
  ]);
  assert.ok(FOCUS_STALE_MS + 1000 < HOLD_TIMEOUT_MS, "the holder is still inside the hold timeout");
  assert.equal(electSyncTab(1, 2, 2, tabs, now), 1, "a playing tab takes over from a silent holder");
  // Still syncing: it keeps the right, whoever asks.
  tabs.set(2, { at: now, paused: false });
  assert.equal(electSyncTab(1, 2, 2, tabs, now), 2);
});

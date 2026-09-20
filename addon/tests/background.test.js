"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadBackground, makeMemoryStorage } = require("./_loadBackground");

// Results returned from the vm sandbox are plain objects from a *different* realm, so
// assert.deepEqual's reference-equality check on prototypes rejects them even when every field
// matches. Round-tripping through JSON compares the same objects in this realm instead.
const plain = (value) => JSON.parse(JSON.stringify(value));

// ------------------------------------------------------------------ normalizeBase

test("normalizeBase strips trailing slashes from a valid http(s) URL", () => {
  const { sandbox } = loadBackground();
  assert.equal(sandbox.normalizeBase("http://127.0.0.1:8790///", "fallback"), "http://127.0.0.1:8790");
  assert.equal(sandbox.normalizeBase("https://example.com/", "fallback"), "https://example.com");
});

test("normalizeBase falls back for missing or non-http(s) values", () => {
  const { sandbox } = loadBackground();
  assert.equal(sandbox.normalizeBase("", "http://127.0.0.1:8790"), "http://127.0.0.1:8790");
  assert.equal(sandbox.normalizeBase(undefined, "http://127.0.0.1:8790"), "http://127.0.0.1:8790");
  assert.equal(sandbox.normalizeBase("javascript:alert(1)", "http://127.0.0.1:8790"), "http://127.0.0.1:8790");
  assert.equal(sandbox.normalizeBase("ftp://example.com", "http://127.0.0.1:8790"), "http://127.0.0.1:8790");
});

// ------------------------------------------------------------------ bytesToBase64

test("bytesToBase64 matches Node's own base64 encoding", () => {
  const { sandbox } = loadBackground();
  const bytes = new Uint8Array([0, 1, 2, 255, 254, 253, 65, 66, 67]);
  const expected = Buffer.from(bytes).toString("base64");
  assert.equal(sandbox.bytesToBase64(bytes.buffer), expected);
});

test("bytesToBase64 handles buffers larger than its 0x8000 chunk size", () => {
  const { sandbox } = loadBackground();
  const bytes = new Uint8Array(0x8000 * 2 + 137);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  const expected = Buffer.from(bytes).toString("base64");
  assert.equal(sandbox.bytesToBase64(bytes.buffer), expected);
});

// ------------------------------------------------------------------ settings

test("getSettings merges stored values over the defaults", async () => {
  const storage = makeMemoryStorage({ settings: { fontScale: 1.5, mineTarget: "download" } });
  const { sandbox } = loadBackground({ storage });
  const settings = await sandbox.getSettings();
  assert.equal(settings.fontScale, 1.5);
  assert.equal(settings.mineTarget, "download");
  assert.equal(settings.serverUrl, sandbox.DEFAULT_SETTINGS.serverUrl); // untouched default
});

test("saveSettings patches on top of the current settings and persists them", async () => {
  const storage = makeMemoryStorage();
  const { sandbox } = loadBackground({ storage });
  const next = await sandbox.saveSettings({ fontScale: 2 });
  assert.equal(next.fontScale, 2);
  const again = await sandbox.getSettings();
  assert.equal(again.fontScale, 2);
  assert.equal(again.serverUrl, sandbox.DEFAULT_SETTINGS.serverUrl);
});

test("getSettings reads storage once and serves the rest from memory", async () => {
  let gets = 0;
  const base = makeMemoryStorage({ settings: { fontScale: 1.5 } });
  const storage = { get: (key) => (gets++, base.get(key)), set: (patch) => base.set(patch) };
  const { sandbox } = loadBackground({ storage });
  for (let i = 0; i < 20; i++) await sandbox.getSettings();
  assert.equal(gets, 1);
  assert.equal((await sandbox.getSettings()).fontScale, 1.5);
});

test("a settings change in storage drops the cache", async () => {
  let gets = 0;
  const base = makeMemoryStorage({ settings: { fontScale: 1.5 } });
  const storage = { get: (key) => (gets++, base.get(key)), set: (patch) => base.set(patch) };
  const { sandbox, listeners } = loadBackground({ storage });
  assert.equal((await sandbox.getSettings()).fontScale, 1.5);
  assert.equal(gets, 1);
  // What the popup does: write the new value, then let storage.onChanged tell everyone.
  await base.set({ settings: { fontScale: 3 } });
  for (const fn of listeners.onChanged) fn({ settings: { newValue: { fontScale: 3 } } }, "local");
  assert.equal((await sandbox.getSettings()).fontScale, 3);
  assert.equal(gets, 2);
});

test("a change to something other than the settings leaves the cache alone", async () => {
  let gets = 0;
  const base = makeMemoryStorage({ settings: { fontScale: 1.5 } });
  const storage = { get: (key) => (gets++, base.get(key)), set: (patch) => base.set(patch) };
  const { sandbox, listeners } = loadBackground({ storage });
  await sandbox.getSettings();
  for (const fn of listeners.onChanged) fn({ somethingElse: { newValue: 1 } }, "local");
  for (const fn of listeners.onChanged) fn({ settings: { newValue: {} } }, "sync"); // another area
  await sandbox.getSettings();
  assert.equal(gets, 1);
});

test("saveSettings makes the new value readable without another storage read", async () => {
  let gets = 0;
  const base = makeMemoryStorage();
  const storage = { get: (key) => (gets++, base.get(key)), set: (patch) => base.set(patch) };
  const { sandbox } = loadBackground({ storage });
  await sandbox.saveSettings({ fontScale: 2 });
  const getsAfterSave = gets;
  assert.equal((await sandbox.getSettings()).fontScale, 2);
  assert.equal(gets, getsAfterSave);
});

// ------------------------------------------------------------------ apiRequest

test("apiRequest rejects paths that do not start with /", async () => {
  const { sandbox } = loadBackground();
  const res = await sandbox.apiRequest("health", undefined);
  assert.deepEqual(plain(res), { ok: false, error: "Invalid API path" });
});

test("apiRequest sends GET for no body and returns parsed JSON on success", async () => {
  let seenUrl, seenInit;
  const fetch = async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return { ok: true, text: async () => JSON.stringify({ hello: "world" }) };
  };
  const { sandbox } = loadBackground({ fetch });
  const res = await sandbox.apiRequest("/health", undefined);
  assert.equal(seenUrl, sandbox.DEFAULT_SETTINGS.serverUrl + "/health");
  assert.equal(seenInit.method, "GET");
  assert.deepEqual(plain(res), { ok: true, data: { hello: "world" } });
});

test("apiRequest sends POST with a JSON body when a body is given", async () => {
  let seenInit;
  const fetch = async (_url, init) => {
    seenInit = init;
    return { ok: true, text: async () => "{}" };
  };
  const { sandbox } = loadBackground({ fetch });
  await sandbox.apiRequest("/sync", { video_id: "abc" });
  assert.equal(seenInit.method, "POST");
  assert.equal(seenInit.headers["Content-Type"], "application/json");
  assert.equal(seenInit.body, JSON.stringify({ video_id: "abc" }));
});

test("apiRequest reports a friendly error for a non-JSON response", async () => {
  const fetch = async () => ({ ok: true, text: async () => "<html>not json</html>" });
  const { sandbox } = loadBackground({ fetch });
  const res = await sandbox.apiRequest("/health", undefined);
  assert.deepEqual(plain(res), { ok: false, error: "Server returned a non-JSON response" });
});

test("apiRequest surfaces the server's error field on a non-ok response", async () => {
  const fetch = async () => ({ ok: false, status: 503, text: async () => JSON.stringify({ error: "busy" }) });
  const { sandbox } = loadBackground({ fetch });
  const res = await sandbox.apiRequest("/sync", {});
  assert.equal(res.ok, false);
  assert.equal(res.error, "busy");
});

test("apiRequest reports the server as unreachable when fetch throws", async () => {
  const fetch = async () => {
    throw new TypeError("NetworkError");
  };
  const { sandbox } = loadBackground({ fetch });
  const res = await sandbox.apiRequest("/health", undefined);
  assert.deepEqual(plain(res), { ok: false, offline: true, error: "Server unreachable" });
});

// ------------------------------------------------------------------ mineCue

const instantTimers = { setTimeout: (fn) => { fn(); return 0; } };

test("mineCue reports an error when the message carries no cue", async () => {
  const { sandbox } = loadBackground();
  const res = await sandbox.mineCue({ videoId: "abc123abc123" });
  assert.equal(res.ok, false);
  assert.match(res.error, /no subtitle/i);
});

test("mineCue saves screenshot and audio clip to Downloads when the target is 'download'", async () => {
  const storage = makeMemoryStorage({ settings: { mineTarget: "download" } });
  const fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "audio/mpeg" },
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  });
  const downloaded = [];
  const download = async (opts) => {
    downloaded.push(opts.filename);
    return {};
  };
  const { sandbox } = loadBackground({ storage, fetch, download, ...instantTimers });

  const res = await sandbox.mineCue({
    videoId: "abc123abc123",
    cue: { start: 10, end: 12 },
    imageDataUrl: "data:image/jpeg;base64,Zm9v",
  });

  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(downloaded.length, 2);
  assert.ok(downloaded.every((name) => name.startsWith("shisu-ko-mining/shisuko_abc123abc123_")));
});

test("mineCue retries the clip endpoint while it returns 503, then succeeds", async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    if (calls < 3) return { status: 503, ok: false };
    return {
      ok: true,
      status: 200,
      headers: { get: () => "audio/mpeg" },
      arrayBuffer: async () => new Uint8Array([9]).buffer,
    };
  };
  const storage = makeMemoryStorage({ settings: { mineTarget: "download" } });
  const download = async () => ({});
  const { sandbox } = loadBackground({ storage, fetch, download, ...instantTimers });

  const res = await sandbox.mineCue({ videoId: "abc123abc123", cue: { start: 0, end: 1 } });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(calls, 3);
});

test("mineCue falls back to Downloads when AnkiConnect is unreachable and mineFallbackDownload is on", async () => {
  const storage = makeMemoryStorage({ settings: { mineTarget: "anki", mineFallbackDownload: true } });
  const fetch = async (url) => {
    if (String(url).includes("/clip")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "audio/mpeg" },
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      };
    }
    // AnkiConnect endpoint: simulate "Anki not running" (a fetch-level TypeError).
    throw new TypeError("fetch failed");
  };
  const downloaded = [];
  const download = async (opts) => {
    downloaded.push(opts.filename);
    return {};
  };
  const { sandbox } = loadBackground({ storage, fetch, download, ...instantTimers });

  const res = await sandbox.mineCue({ videoId: "abc123abc123", cue: { start: 0, end: 1 } });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.warning, true);
  assert.match(res.message, /Anki/);
  assert.equal(downloaded.length, 1);
});

// ------------------------------------------------------------------ AnkiConnect watcher

// AnkiConnect speaks one POST per action; the mock dispatches on the action name and records calls.
function ankiFetch(handlers) {
  const calls = [];
  const fetch = async (_url, init) => {
    const req = JSON.parse(init.body);
    calls.push({ action: req.action, params: req.params });
    const handler = handlers[req.action];
    if (handler === undefined) throw new Error("unexpected AnkiConnect action " + req.action);
    const result = typeof handler === "function" ? handler(req.params) : handler;
    return { json: async () => ({ result, error: null }) };
  };
  return { fetch, calls, actions: () => calls.map((c) => c.action) };
}

const granted = { permission: "granted" };

// Put the previous poll far enough back to clear the throttle but inside the 10 s window
// that keeps the baseline trustworthy.
function allowNextPoll(sandbox) {
  sandbox.ankiWatch.lastPollAt = Date.now() - 1000;
}

test("ankiPoll takes a baseline on the first poll and reports nothing", async () => {
  const anki = ankiFetch({ requestPermission: granted, findNotes: [100, 101] });
  const { sandbox } = loadBackground({ fetch: anki.fetch });
  assert.deepEqual(plain(await sandbox.ankiPoll()), { ok: true, newNoteId: null });
  assert.equal(sandbox.ankiWatch.baseline, 101);
});

test("ankiPoll reports a single note added after the baseline", async () => {
  let ids = [100, 101];
  const anki = ankiFetch({ requestPermission: granted, findNotes: () => ids, notesInfo: () => YOMITAN_NOTE });
  const { sandbox } = loadBackground({ fetch: anki.fetch });
  await sandbox.ankiPoll();
  ids = [100, 101, 102];
  allowNextPoll(sandbox);
  assert.deepEqual(plain(await sandbox.ankiPoll()), { ok: true, newNoteId: 102, note: { sentence: "これは<b>猫</b>です。", word: "猫" } });
  // The note is reported once; a poll that finds nothing newer stays quiet.
  allowNextPoll(sandbox);
  assert.deepEqual(plain(await sandbox.ankiPoll()), { ok: true, newNoteId: null });
});

// What the content script matches a card against: the two fields that say what it is about. The
// word comes from the first field unless the viewer named one, because that is where every
// Yomitan template puts the expression.
const YOMITAN_NOTE = [
  {
    fields: {
      Expression: { value: "猫", order: 0 },
      Sentence: { value: "これは<b>猫</b>です。", order: 1 },
      Reading: { value: "ねこ", order: 2 },
    },
  },
];

test("ankiPoll reads the new card's sentence and its first field", async () => {
  let ids = [100];
  const anki = ankiFetch({ requestPermission: granted, findNotes: () => ids, notesInfo: () => YOMITAN_NOTE });
  const { sandbox } = loadBackground({ fetch: anki.fetch });
  await sandbox.ankiPoll();
  ids = [100, 101];
  allowNextPoll(sandbox);
  const res = await sandbox.ankiPoll();
  assert.deepEqual(plain(res.note), { sentence: "これは<b>猫</b>です。", word: "猫" });
  const asked = anki.calls.find((c) => c.action === "notesInfo");
  assert.deepEqual(plain(asked.params.notes), [101]);
});

test("ankiPoll takes the word from the field the viewer named", async () => {
  const storage = makeMemoryStorage({ settings: { ankiWordField: "Reading", ankiSentenceField: "Sentence" } });
  let ids = [100];
  const anki = ankiFetch({ requestPermission: granted, findNotes: () => ids, notesInfo: () => YOMITAN_NOTE });
  const { sandbox } = loadBackground({ storage, fetch: anki.fetch });
  await sandbox.ankiPoll();
  ids = [100, 101];
  allowNextPoll(sandbox);
  assert.deepEqual(plain((await sandbox.ankiPoll()).note), { sentence: "これは<b>猫</b>です。", word: "ねこ" });
});

test("ankiPoll still reports the card when its fields cannot be read", async () => {
  let ids = [100];
  const anki = ankiFetch({
    requestPermission: granted,
    findNotes: () => ids,
    notesInfo: () => {
      throw new Error("Anki went away");
    },
  });
  const { sandbox } = loadBackground({ fetch: anki.fetch });
  await sandbox.ankiPoll();
  ids = [100, 101];
  allowNextPoll(sandbox);
  // The baseline has moved on all the same: this card is never offered twice.
  assert.deepEqual(plain(await sandbox.ankiPoll()), { ok: true, newNoteId: 101, note: null });
  assert.equal(sandbox.ankiWatch.baseline, 101);
});

test("ankiPoll ignores a batch of several new notes", async () => {
  let ids = [100];
  const anki = ankiFetch({ requestPermission: granted, findNotes: () => ids });
  const { sandbox } = loadBackground({ fetch: anki.fetch });
  await sandbox.ankiPoll();
  ids = [100, 101, 102];
  allowNextPoll(sandbox);
  assert.deepEqual(plain(await sandbox.ankiPoll()), { ok: true, newNoteId: null });
  assert.equal(sandbox.ankiWatch.baseline, 102);
});

test("ankiPoll throttles polls closer together than the throttle interval", async () => {
  let ids = [100];
  const anki = ankiFetch({ requestPermission: granted, findNotes: () => ids });
  const { sandbox } = loadBackground({ fetch: anki.fetch });
  await sandbox.ankiPoll();
  const before = anki.calls.length;
  ids = [100, 101];
  assert.deepEqual(plain(await sandbox.ankiPoll()), { ok: true, newNoteId: null });
  assert.equal(anki.calls.length, before, "the throttled poll must not talk to AnkiConnect");
});

test("ankiPoll re-baselines after a failed poll instead of reporting a stale note", async () => {
  let ids = [100];
  let broken = false;
  const anki = ankiFetch({ requestPermission: granted, findNotes: () => ids });
  const fetch = async (url, init) => {
    if (broken) throw new TypeError("fetch failed");
    return anki.fetch(url, init);
  };
  const { sandbox } = loadBackground({ fetch });
  await sandbox.ankiPoll();

  broken = true;
  allowNextPoll(sandbox);
  const failed = await sandbox.ankiPoll();
  assert.equal(failed.ok, false);
  assert.equal(failed.offline, true);

  // Notes added while Anki was unreachable must not be attached to.
  broken = false;
  ids = [100, 101];
  allowNextPoll(sandbox);
  assert.deepEqual(plain(await sandbox.ankiPoll()), { ok: true, newNoteId: null });
  ids = [100, 101, 102];
  allowNextPoll(sandbox);
  assert.equal((await sandbox.ankiPoll()).newNoteId, 102);
});

test("ankiPoll stays silent when autoMine is off", async () => {
  const storage = makeMemoryStorage({ settings: { autoMine: false } });
  const { sandbox } = loadBackground({ storage });
  assert.deepEqual(plain(await sandbox.ankiPoll()), { ok: true, newNoteId: null });
});

// ------------------------------------------------------------------ normalizeSentence

test("normalizeSentence strips tags, whitespace and punctuation", () => {
  const { sandbox } = loadBackground();
  assert.equal(sandbox.normalizeSentence("これは <b>猫</b> です。"), "これは猫です");
  assert.equal(sandbox.normalizeSentence("a&nbsp;b\n c"), "abc");
  assert.equal(sandbox.normalizeSentence(null), "");
});

// ------------------------------------------------------------------ addToAnki with an explicit note

const MEDIA = {
  image: { filename: "shot.jpg", base64: "Zm9v" },
  audio: { filename: "clip.mp3", base64: "YmFy", mime: "audio/mpeg" },
};

function noteFields(sentence) {
  return [{ fields: { Picture: { value: "" }, SentenceAudio: { value: "" }, Sentence: { value: sentence } } }];
}

test("addToAnki writes to the note it is given without looking up the newest one", async () => {
  const anki = ankiFetch({
    requestPermission: granted,
    notesInfo: () => noteFields("これは<b>猫</b>です。"),
    storeMediaFile: (p) => p.filename,
    updateNoteFields: null,
  });
  const { sandbox } = loadBackground({ fetch: anki.fetch });
  const settings = await sandbox.getSettings();
  const res = await sandbox.addToAnki(settings, { text: "これは猫です。" }, MEDIA.image, MEDIA.audio, 555);

  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.noteId, 555);
  assert.ok(!anki.actions().includes("findNotes"), "an explicit note id needs no findNotes lookup");
  const update = anki.calls.find((c) => c.action === "updateNoteFields");
  assert.equal(update.params.note.id, 555);
  assert.equal(update.params.note.fields.Picture, '<img src="shot.jpg">');
  assert.equal(update.params.note.fields.SentenceAudio, "[sound:clip.mp3]");
});

test("addToAnki refuses a note whose sentence is about something else", async () => {
  const anki = ankiFetch({
    requestPermission: granted,
    notesInfo: () => noteFields("まったく別の文です。"),
    storeMediaFile: (p) => p.filename,
    updateNoteFields: null,
  });
  const { sandbox } = loadBackground({ fetch: anki.fetch });
  const settings = await sandbox.getSettings();
  const res = await sandbox.addToAnki(settings, { text: "これは猫です。" }, MEDIA.image, MEDIA.audio, 555);

  assert.equal(res.ok, false);
  assert.equal(res.mismatch, true);
  assert.ok(!anki.actions().includes("updateNoteFields"), "nothing may be written to a mismatched note");
  assert.ok(!anki.actions().includes("storeMediaFile"), "no media may be uploaded for a mismatched note");
});

test("addToAnki accepts a card whose sentence carries furigana and a changed ending", async () => {
  const anki = ankiFetch({
    requestPermission: granted,
    // What a Yomitan template with {sentence-furigana} writes into the note.
    notesInfo: () => noteFields(" 私[わたし]は<b> 猫[ねこ]</b>が 好[す]きです。"),
    storeMediaFile: (p) => p.filename,
    updateNoteFields: null,
  });
  const { sandbox } = loadBackground({ fetch: anki.fetch });
  const settings = await sandbox.getSettings();
  const res = await sandbox.addToAnki(settings, { text: "私は猫が好きです" }, MEDIA.image, MEDIA.audio, 555);
  assert.equal(res.ok, true, JSON.stringify(res));
});

test("addToAnki refuses a card that only ends like the subtitle", async () => {
  // Both sentences end in 字幕です and share nothing else. Scoring the shared bigrams against the
  // shorter sentence alone put this at exactly the threshold and let it through; the Chrome smoke
  // test caught it writing media into the wrong card.
  const anki = ankiFetch({
    requestPermission: granted,
    notesInfo: () => noteFields("別の字幕です"),
    storeMediaFile: (p) => p.filename,
    updateNoteFields: null,
  });
  const { sandbox } = loadBackground({ fetch: anki.fetch });
  const settings = await sandbox.getSettings();
  const res = await sandbox.addToAnki(settings, { text: "これはテスト字幕です" }, MEDIA.image, MEDIA.audio, 202);
  assert.equal(res.mismatch, true, JSON.stringify(res));
  assert.ok(!anki.actions().includes("storeMediaFile"), "no media may reach a mismatched note");
});

test("mineCue does not fall back to Downloads when mining automatically", async () => {
  const storage = makeMemoryStorage({ settings: { mineTarget: "anki", mineFallbackDownload: true } });
  const fetch = async (url) => {
    if (String(url).includes("/clip")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "audio/mpeg" },
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      };
    }
    throw new TypeError("fetch failed"); // Anki is not running
  };
  const downloaded = [];
  const download = async (opts) => {
    downloaded.push(opts.filename);
    return {};
  };
  const { sandbox } = loadBackground({ storage, fetch, download, ...instantTimers });

  const res = await sandbox.mineCue({
    videoId: "abc123abc123",
    cue: { start: 0, end: 1, text: "これは猫です。" },
    noteId: 555,
    auto: true,
  });
  assert.equal(res.ok, false);
  assert.equal(downloaded.length, 0, "automatic mining must never write files");
});

test("addToAnki references the filename Anki reports back, not the one it asked for", async () => {
  const anki = ankiFetch({
    requestPermission: granted,
    notesInfo: () => noteFields(""),
    storeMediaFile: (p) => p.filename.toLowerCase(), // Anki 26 lowercases media names
    updateNoteFields: null,
  });
  const { sandbox } = loadBackground({ fetch: anki.fetch });
  const settings = await sandbox.getSettings();
  const image = { ...MEDIA.image, filename: "shisuko_SAxvVpdUw24_6380.jpg" };
  const audio = { ...MEDIA.audio, filename: "shisuko_SAxvVpdUw24_6380.mp3" };
  const res = await sandbox.addToAnki(settings, { text: "猫" }, image, audio, 555);

  assert.equal(res.ok, true, JSON.stringify(res));
  const update = anki.calls.find((c) => c.action === "updateNoteFields");
  assert.equal(update.params.note.fields.Picture, '<img src="shisuko_saxvvpduw24_6380.jpg">');
  assert.equal(update.params.note.fields.SentenceAudio, "[sound:shisuko_saxvvpduw24_6380.mp3]");
});

// ------------------------------------------------------------------ the whole sentence, not the cue

// The server splits one spoken sentence into several short cues; the content script joins the cues
// sharing a `seg` and sends the result as msg.sentence. Everything below is about that join being
// what reaches Anki: the clip covers it, the guard compares against it, the card keeps it.

test("extendSentenceField grows a fragment into the full sentence and keeps Yomitan's bold", () => {
  const { sandbox } = loadBackground();
  assert.equal(
    sandbox.extendSentenceField("これは<b>猫</b>です。", "これは猫です。とても可愛い。"),
    "これは<b>猫</b>です。とても可愛い。"
  );
});

test("extendSentenceField writes the sentence plain when the bold word cannot be located", () => {
  const { sandbox } = loadBackground();
  // Normalising drops the space inside the bold span, so "thecat" is not in the raw sentence.
  assert.equal(
    sandbox.extendSentenceField("Look at <b>the cat</b>.", "Look at the cat. It sleeps."),
    "Look at the cat. It sleeps."
  );
});

test("extendSentenceField leaves a field that already holds the whole sentence alone", () => {
  const { sandbox } = loadBackground();
  assert.equal(sandbox.extendSentenceField("これは<b>猫</b>です。", "これは猫です。"), null);
  assert.equal(sandbox.extendSentenceField("これは<b>猫</b>です。とても可愛い。", "これは猫です。とても可愛い。"), null);
});

test("extendSentenceField refuses text that is not part of the sentence", () => {
  const { sandbox } = loadBackground();
  assert.equal(sandbox.extendSentenceField("まったく別の文です。", "これは猫です。とても可愛い。"), null);
  assert.equal(sandbox.extendSentenceField("", "これは猫です。"), null);
});

test("addToAnki rewrites the sentence field to the whole sentence and says so", async () => {
  const anki = ankiFetch({
    requestPermission: granted,
    notesInfo: () => noteFields("これは<b>猫</b>です。"),
    storeMediaFile: (p) => p.filename,
    updateNoteFields: null,
  });
  const { sandbox } = loadBackground({ fetch: anki.fetch });
  const settings = await sandbox.getSettings(); // ankiSentenceField unset: the guard's "Sentence"
  const res = await sandbox.addToAnki(settings, { text: "これは猫です。" }, MEDIA.image, MEDIA.audio, 555, {
    start: 10,
    end: 14,
    text: "これは猫です。とても可愛い。",
  });

  assert.equal(res.ok, true, JSON.stringify(res));
  const update = anki.calls.find((c) => c.action === "updateNoteFields");
  assert.equal(update.params.note.fields.Sentence, "これは<b>猫</b>です。とても可愛い。");
  assert.match(res.message, /sentence/i);
});

test("addToAnki leaves a sentence field that is already complete untouched", async () => {
  const anki = ankiFetch({
    requestPermission: granted,
    notesInfo: () => noteFields("これは<b>猫</b>です。とても可愛い。"),
    storeMediaFile: (p) => p.filename,
    updateNoteFields: null,
  });
  const { sandbox } = loadBackground({ fetch: anki.fetch });
  const settings = await sandbox.getSettings();
  const res = await sandbox.addToAnki(settings, { text: "これは猫です。" }, MEDIA.image, MEDIA.audio, 555, {
    start: 10,
    end: 14,
    text: "これは猫です。とても可愛い。",
  });

  assert.equal(res.ok, true, JSON.stringify(res));
  const update = anki.calls.find((c) => c.action === "updateNoteFields");
  assert.ok(!("Sentence" in update.params.note.fields), "a complete sentence must not be rewritten");
  assert.doesNotMatch(res.message, /sentence extended/i);
});

test("addToAnki accepts a note whose sentence matches a neighbouring cue of the same segment", async () => {
  // Yomitan copied its sentence from the cue after the one being mined. Comparing against the cue
  // alone would call this a different card; comparing against the joined sentence gets it right.
  const anki = ankiFetch({
    requestPermission: granted,
    notesInfo: () => noteFields("とても<b>可愛い</b>。"),
    storeMediaFile: (p) => p.filename,
    updateNoteFields: null,
  });
  const { sandbox } = loadBackground({ fetch: anki.fetch });
  const settings = await sandbox.getSettings();
  const res = await sandbox.addToAnki(settings, { text: "これは猫です。" }, MEDIA.image, MEDIA.audio, 555, {
    start: 10,
    end: 14,
    text: "これは猫です。とても可愛い。",
  });

  assert.equal(res.ok, true, JSON.stringify(res));
  const update = anki.calls.find((c) => c.action === "updateNoteFields");
  assert.equal(update.params.note.fields.Sentence, "これは猫です。とても<b>可愛い</b>。");
});

test("addToAnki still refuses an unrelated note, and writes no sentence into it", async () => {
  const anki = ankiFetch({
    requestPermission: granted,
    notesInfo: () => noteFields("まったく別の文です。"),
    storeMediaFile: (p) => p.filename,
    updateNoteFields: null,
  });
  const { sandbox } = loadBackground({ fetch: anki.fetch });
  const settings = await sandbox.getSettings();
  const res = await sandbox.addToAnki(settings, { text: "これは猫です。" }, MEDIA.image, MEDIA.audio, 555, {
    start: 10,
    end: 14,
    text: "これは猫です。とても可愛い。",
  });

  assert.equal(res.ok, false);
  assert.equal(res.mismatch, true);
  assert.ok(!anki.actions().includes("updateNoteFields"), "nothing may be written to a mismatched note");
});

test("addToAnki fills an empty sentence field with the whole sentence when one is configured", async () => {
  const storage = makeMemoryStorage({ settings: { ankiSentenceField: "Sentence" } });
  const anki = ankiFetch({
    requestPermission: granted,
    notesInfo: () => noteFields(""),
    storeMediaFile: (p) => p.filename,
    updateNoteFields: null,
  });
  const { sandbox } = loadBackground({ storage, fetch: anki.fetch });
  const settings = await sandbox.getSettings();
  const res = await sandbox.addToAnki(settings, { text: "これは猫です。" }, MEDIA.image, MEDIA.audio, 555, {
    start: 10,
    end: 14,
    text: "これは猫です。とても可愛い。",
  });

  assert.equal(res.ok, true, JSON.stringify(res));
  const update = anki.calls.find((c) => c.action === "updateNoteFields");
  assert.equal(update.params.note.fields.Sentence, "これは猫です。とても可愛い。");
});

test("mineCue cuts the clip over the sentence but names the file after the cue", async () => {
  const storage = makeMemoryStorage({ settings: { mineTarget: "download" } }); // clipPaddingMs 200 ms
  const urls = [];
  const fetch = async (url) => {
    urls.push(String(url));
    return {
      ok: true,
      status: 200,
      headers: { get: () => "audio/mpeg" },
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    };
  };
  const downloaded = [];
  const download = async (opts) => {
    downloaded.push(opts.filename);
    return {};
  };
  const { sandbox } = loadBackground({ storage, fetch, download, ...instantTimers });

  const res = await sandbox.mineCue({
    videoId: "abc123abc123",
    cue: { start: 10, end: 12, text: "これは猫です。" },
    sentence: { start: 8, end: 14, text: "これは猫です。とても可愛い。" },
  });

  assert.equal(res.ok, true, JSON.stringify(res));
  assert.match(urls[0], /start=7\.800&end=14\.200/);
  assert.deepEqual(downloaded, ["shisu-ko-mining/shisuko_abc123abc123_10000.mp3"]);
});

test("mineCue falls back to the cue's own range when no sentence is sent", async () => {
  const storage = makeMemoryStorage({ settings: { mineTarget: "download" } });
  const urls = [];
  const fetch = async (url) => {
    urls.push(String(url));
    return {
      ok: true,
      status: 200,
      headers: { get: () => "audio/mpeg" },
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    };
  };
  const { sandbox } = loadBackground({ storage, fetch, download: async () => ({}), ...instantTimers });

  await sandbox.mineCue({ videoId: "abc123abc123", cue: { start: 10, end: 12, text: "これは猫です。" } });
  assert.match(urls[0], /start=9\.800&end=12\.200/);
});

// ------------------------------------------------------------------ pre-mined sentences

const VIDEO = "abc123abc123";
// The background answers a premine before its clip request has come back; a turn of the event
// loop is what the content script gets for free on its next message.
const settle = () => new Promise((resolve) => setImmediate(resolve));

// One mock for both endpoints a mine touches: the Whisper server's /clip and AnkiConnect.
function miningFetch(handlers) {
  const clips = [];
  const calls = [];
  const fetch = async (url, init) => {
    if (String(url).includes("/clip")) {
      clips.push(String(url));
      return {
        ok: true,
        status: 200,
        headers: { get: () => "audio/mpeg" },
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      };
    }
    const req = JSON.parse(init.body);
    calls.push({ action: req.action, params: req.params });
    const handler = (handlers || {})[req.action];
    if (handler === undefined) throw new Error("unexpected AnkiConnect action " + req.action);
    const result = typeof handler === "function" ? handler(req.params) : handler;
    return { json: async () => ({ result, error: null }) };
  };
  return { fetch, clips, calls };
}

const jpeg = (text) => "data:image/jpeg;base64," + Buffer.from(text).toString("base64");

function premine(key, patch) {
  return Object.assign(
    {
      type: "premine",
      videoId: VIDEO,
      key,
      cueIds: [key],
      sentence: { start: key * 10, end: key * 10 + 2, text: `文${key}` },
    },
    patch
  );
}

test("premine keeps the frame and fetches the clip once, and reports what a tab holds", async () => {
  const mock = miningFetch();
  const { sandbox, dispatch } = loadBackground({ fetch: mock.fetch });
  const res = await dispatch(premine(0, { imageDataUrl: jpeg("frame") }), 1);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(plain(res.held), [{ key: 0, cueIds: [0], image: true, audio: false }]);
  await settle();
  assert.deepEqual(plain(sandbox.heldFor(1)), [{ key: 0, cueIds: [0], image: true, audio: true }]);
  // The same sentence again must not ask the server for the clip a second time.
  await dispatch(premine(0), 1);
  await settle();
  assert.equal(mock.clips.length, 1);
});

test("premine drops a screenshot too large to be one", async () => {
  const mock = miningFetch();
  const { sandbox, dispatch } = loadBackground({ fetch: mock.fetch });
  const huge = "data:image/jpeg;base64," + "A".repeat(5 * 1024 * 1024);
  await dispatch(premine(0, { imageDataUrl: huge }), 1);
  await settle();
  // The oversize frame is thrown away; everything else about the sentence still proceeds.
  assert.deepEqual(plain(sandbox.heldFor(1)), [{ key: 0, cueIds: [0], image: false, audio: true }]);
});

test("premine keeps five sentences per tab and drops the oldest", async () => {
  const mock = miningFetch();
  const { sandbox, dispatch } = loadBackground({ fetch: mock.fetch });
  for (let key = 0; key < 7; key++) await dispatch(premine(key, { imageDataUrl: jpeg("f") }), 1);
  const keys = sandbox.heldFor(1).map((e) => e.key).sort((a, b) => a - b);
  assert.deepEqual(plain(keys), [2, 3, 4, 5, 6]);
});

test("premine keeps the hovered sentence even when older ones are dropped", async () => {
  const mock = miningFetch();
  const { sandbox, dispatch } = loadBackground({ fetch: mock.fetch });
  await dispatch(premine(0, { imageDataUrl: jpeg("read"), hover: true }), 1);
  for (let key = 1; key < 7; key++) await dispatch(premine(key, { imageDataUrl: jpeg("f") }), 1);
  const keys = sandbox.heldFor(1).map((e) => e.key).sort((a, b) => a - b);
  assert.equal(keys.length, 5);
  assert.ok(keys.includes(0), "the sentence being looked up must survive: " + keys.join(","));
});

test("premine holds ten sentences across every tab", async () => {
  const mock = miningFetch();
  const { sandbox, dispatch } = loadBackground({ fetch: mock.fetch });
  for (let key = 0; key < 5; key++) await dispatch(premine(key), 1);
  for (let key = 0; key < 5; key++) await dispatch(premine(key), 2);
  assert.equal(sandbox.premined.size, 10);
  await dispatch(premine(0), 3);
  assert.equal(sandbox.premined.size, 10);
  assert.equal(sandbox.heldFor(1).length, 4, "the oldest tab gives up the oldest sentence");
  assert.equal(sandbox.heldFor(2).length, 5);
  assert.equal(sandbox.heldFor(3).length, 1);
});

test("a tab that navigates away or closes leaves nothing behind", async () => {
  const mock = miningFetch();
  const { sandbox, dispatch, closeTab } = loadBackground({ fetch: mock.fetch });
  await dispatch(premine(0), 1);
  await dispatch(premine(1), 2);
  await dispatch({ type: "premineReset" }, 1);
  assert.deepEqual(plain(sandbox.heldFor(1)), []);
  assert.equal(sandbox.heldFor(2).length, 1);
  closeTab(2);
  assert.equal(sandbox.premined.size, 0);
});

// ------------------------------------------------------------------ mining from the cache

function mineMsg(key, patch) {
  return Object.assign(
    {
      type: "mine",
      videoId: VIDEO,
      key,
      cue: { start: key * 10, end: key * 10 + 2, text: `文${key}` },
      sentence: { start: key * 10, end: key * 10 + 2, text: `文${key}` },
      noteId: 555,
    },
    patch
  );
}

const ankiOk = {
  requestPermission: granted,
  notesInfo: () => noteFields("文0"),
  storeMediaFile: (p) => p.filename,
  updateNoteFields: null,
};

test("mining a pre-mined sentence asks the server for nothing and uses the frame it kept", async () => {
  const mock = miningFetch(ankiOk);
  const { dispatch } = loadBackground({ fetch: mock.fetch, ...instantTimers });
  await dispatch(premine(0, { imageDataUrl: jpeg("the frame that was read") }), 1);
  await settle();
  assert.equal(mock.clips.length, 1);

  const res = await dispatch(mineMsg(0), 1);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(mock.clips.length, 1, "the clip was already there");
  const image = mock.calls.find((c) => c.action === "storeMediaFile" && c.params.filename.endsWith(".jpg"));
  assert.equal(Buffer.from(image.params.data, "base64").toString(), "the frame that was read");
});

test("a frame sent with the mine beats the pre-mined one", async () => {
  const mock = miningFetch(ankiOk);
  const { dispatch } = loadBackground({ fetch: mock.fetch, ...instantTimers });
  await dispatch(premine(0, { imageDataUrl: jpeg("prepared") }), 1);
  await settle();
  const res = await dispatch(mineMsg(0, { imageDataUrl: jpeg("captured now") }), 1);
  assert.equal(res.ok, true, JSON.stringify(res));
  const image = mock.calls.find((c) => c.action === "storeMediaFile" && c.params.filename.endsWith(".jpg"));
  assert.equal(Buffer.from(image.params.data, "base64").toString(), "captured now");
});

test("a clip cut with the old padding is fetched again, not reused", async () => {
  const mock = miningFetch(ankiOk);
  const { sandbox, dispatch } = loadBackground({ fetch: mock.fetch, ...instantTimers });
  await dispatch(premine(0), 1);
  await settle();
  assert.match(mock.clips[0], /start=0\.000&end=2\.200/);

  await sandbox.saveSettings({ clipPaddingMs: 500 });
  const res = await dispatch(mineMsg(0), 1);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(mock.clips.length, 2, "the held clip is the wrong length now");
  assert.match(mock.clips[1], /start=0\.000&end=2\.500/);
});

test("a sentence survives being mined: two words from one line make two cards", async () => {
  const mock = miningFetch(ankiOk);
  const { sandbox, dispatch } = loadBackground({ fetch: mock.fetch, ...instantTimers });
  await dispatch(premine(0, { imageDataUrl: jpeg("frame") }), 1);
  await settle();
  assert.equal((await dispatch(mineMsg(0), 1)).ok, true);
  assert.equal((await dispatch(mineMsg(0), 1)).ok, true);
  assert.equal(mock.clips.length, 1, "the second card reuses the same clip");
  assert.deepEqual(plain(sandbox.heldFor(1)), [{ key: 0, cueIds: [0], image: true, audio: true }]);
});

// ------------------------------------------------------------------ downloads fallback

test("downloadFiles hands Firefox object URLs, never data: URLs", async () => {
  const seen = [];
  const revoked = [];
  const download = async (options) => {
    seen.push(options);
    return seen.length;
  };
  const { sandbox } = loadBackground({
    download,
    createObjectURL: (blob) => `blob:moz-extension://test/${blob.type}`,
    revokeObjectURL: (url) => revoked.push(url),
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(), // the revoke timer must not keep the test runner alive
  });
  const image = { base64: Buffer.from("jpeg bytes").toString("base64"), filename: "a.jpg" };
  const audio = { base64: Buffer.from("mp3 bytes").toString("base64"), filename: "a.mp3", mime: "audio/mpeg" };
  const res = await sandbox.downloadFiles(image, audio);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(seen.map((o) => o.url), ["blob:moz-extension://test/image/jpeg", "blob:moz-extension://test/audio/mpeg"]);
  assert.deepEqual(seen.map((o) => o.filename), ["shisu-ko-mining/a.jpg", "shisu-ko-mining/a.mp3"]);
  assert.ok(seen.every((o) => !o.url.startsWith("data:")));
  assert.equal(revoked.length, 0, "the object URL must live until the download has finished");
});

test("downloadFiles uses Chrome data URLs in the service worker", async () => {
  const seen = [];
  const { sandbox } = loadBackground({
    runtimeURL: "chrome-extension://test/",
    download: async (options) => { seen.push(options); return seen.length; },
    createObjectURL: () => { throw new Error("service workers have no object URLs"); },
  });
  const imageBytes = Buffer.from([0, 255, 65]);
  const res = await sandbox.downloadFiles({ base64: imageBytes.toString("base64"), filename: "a.jpg" }, null);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(seen.length, 1);
  assert.match(seen[0].url, /^data:image\/jpeg;base64,/);
  assert.deepEqual(Buffer.from(seen[0].url.split(",", 2)[1], "base64"), imageBytes);
});

test("downloadFiles revokes the object URL when the download is refused", async () => {
  const revoked = [];
  const { sandbox } = loadBackground({
    download: async () => { throw new Error("Access denied for URL"); },
    revokeObjectURL: (url) => revoked.push(url),
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  });
  const res = await sandbox.downloadFiles({ base64: Buffer.from("x").toString("base64"), filename: "a.jpg" }, null);
  assert.equal(res.ok, false);
  assert.match(res.error, /Download failed: Access denied/);
  assert.equal(revoked.length, 1);
});

test("base64ToBlob decodes the bytes and keeps the mime type", async () => {
  const { sandbox } = loadBackground();
  const blob = sandbox.base64ToBlob(Buffer.from([0, 255, 65]).toString("base64"), "audio/mpeg");
  assert.equal(blob.type, "audio/mpeg");
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [0, 255, 65]);
});

// ------------------------------------------------------------------ startServer (native host)

// The native host answers one message and exits; the stub records what it was asked.
function nativeHost(answer) {
  const calls = [];
  const sendNativeMessage = async (application, message) => {
    calls.push({ application, message });
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer() : answer;
  };
  return { calls, sendNativeMessage };
}

// A launch's answer carries the deadline of its window (START_WINDOW_MS from the moment the host
// answered); the launch itself is compared without it.
function launched(res, expected) {
  assert.ok(Number.isFinite(res.deadline) && res.deadline > Date.now() + 80000 && res.deadline <= Date.now() + 90000, `deadline ${res.deadline}`);
  const { deadline, ...rest } = plain(res);
  assert.deepEqual(rest, expected);
}

test("startServer asks the shisuko host to start and resolves its answer", async () => {
  const host = nativeHost({ ok: true, started: true, log: null });
  const { sandbox } = loadBackground({ sendNativeMessage: host.sendNativeMessage });
  const res = await sandbox.startServer();
  assert.equal(sandbox.START_WINDOW_MS, 90000);
  launched(res, { ok: true, started: true, already: false, loading: false, log: null });
  assert.deepEqual(plain(host.calls), [{ application: "shisuko", message: { cmd: "start" } }]);
});

test("startServer treats an already running server as started, with the log path when there is one", async () => {
  const host = nativeHost({ ok: true, already: true, log: "/home/x/.shisu-ko/server.log" });
  const { sandbox } = loadBackground({ sendNativeMessage: host.sendNativeMessage });
  const res = await sandbox.startServer();
  launched(res, { ok: true, started: false, already: true, loading: false, log: "/home/x/.shisu-ko/server.log" });
});

// The host's `starting`: /health is silent but server.py holds its instance lock, so a server is
// loading its model (minutes on a first use). The popup must wait for it as for its own launch,
// not take it for a server at another address; `loading` here, since `starting` is the name of
// startStatus's own answer.
test("startServer passes the host's 'starting' on as 'loading'", async () => {
  const host = nativeHost({ ok: true, already: true, starting: true });
  const { sandbox, dispatch } = loadBackground({ sendNativeMessage: host.sendNativeMessage });
  const res = await sandbox.startServer();
  launched(res, { ok: true, started: false, already: true, loading: true, log: null });
  const status = await dispatch({ type: "startServerStatus" });
  assert.deepEqual(plain(status), { starting: true, already: true, loading: true, log: null, deadline: res.deadline });
});

test("startServer maps Firefox's missing-host error to 'launcher not registered' with the setup hint", async () => {
  const host = nativeHost(new Error("No such native application shisuko"));
  const { sandbox } = loadBackground({ sendNativeMessage: host.sendNativeMessage });
  const res = await sandbox.startServer();
  assert.equal(res.ok, false);
  assert.equal(res.error, "launcher not registered");
  assert.equal(res.hint, sandbox.LAUNCHER_HINT);
  assert.match(res.hint, /setup\.cmd/);
  assert.match(res.hint, /setup\.sh/);
});

test("startServer maps Chrome's two registration errors the same way", async () => {
  for (const text of ["Specified native messaging host not found.", "Access to the specified native messaging host is forbidden."]) {
    const host = nativeHost(new Error(text));
    const { sandbox } = loadBackground({ sendNativeMessage: host.sendNativeMessage });
    const res = await sandbox.startServer();
    assert.equal(res.error, "launcher not registered", text);
    assert.equal(res.hint, sandbox.LAUNCHER_HINT);
  }
});

test("startServer reports a missing nativeMessaging permission instead of throwing", async () => {
  const { sandbox } = loadBackground(); // no sendNativeMessage at all: the permission was never granted
  const res = await sandbox.startServer();
  assert.equal(res.ok, false);
  assert.equal(res.error, "permission missing");
  const denied = nativeHost(new Error("Access to this API is denied: the nativeMessaging permission is missing"));
  const other = loadBackground({ sendNativeMessage: denied.sendNativeMessage });
  assert.equal((await other.sandbox.startServer()).error, "permission missing");
});

test("startServer passes the host's own refusal through", async () => {
  const host = nativeHost({ ok: false, error: "run.cmd is missing" });
  const { sandbox } = loadBackground({ sendNativeMessage: host.sendNativeMessage });
  const res = await sandbox.startServer();
  assert.deepEqual(plain(res), { ok: false, error: "run.cmd is missing" });
});

test("startServer gives up on a host that never answers", async () => {
  const host = nativeHost(() => new Promise(() => {}));
  // The deadline timer fires at once, but the delay it was given is kept: the 15 s the popup's
  // 90 s is built on, and a slip to 15 ms would fail every click before the host's Python is up.
  const delays = [];
  const setTimeout = (fn, ms) => { delays.push(ms); fn(); return 0; };
  const { sandbox } = loadBackground({ sendNativeMessage: host.sendNativeMessage, setTimeout });
  assert.equal(sandbox.NATIVE_TIMEOUT_MS, 15000);
  const res = await sandbox.startServer();
  assert.deepEqual(plain(res), { ok: false, error: "the launcher did not answer" });
  assert.deepEqual(delays, [sandbox.NATIVE_TIMEOUT_MS]);
});

test("startServer refuses an answer that is not an object", async () => {
  const host = nativeHost(() => "yes");
  const { sandbox } = loadBackground({ sendNativeMessage: host.sendNativeMessage });
  const res = await sandbox.startServer();
  assert.deepEqual(plain(res), { ok: false, error: "the launcher gave no answer" });
});

test("a startServer message from the popup reaches the native host", async () => {
  const host = nativeHost({ ok: true, started: true });
  const { dispatch } = loadBackground({ sendNativeMessage: host.sendNativeMessage });
  const res = await dispatch({ type: "startServer" });
  launched(res, { ok: true, started: true, already: false, loading: false, log: null });
  assert.equal(host.calls.length, 1);
});

// The popup document dies with every click outside it. A reopened one asks whether a start is
// under way and must be told so for as long as the server can still be loading: the host only
// checks /health, which a loading server does not answer, so a second request would start a
// second server.
test("a second startServer request while the launch is under way is answered without the host", async () => {
  const host = nativeHost({ ok: true, started: true, log: "/home/x/.shisu-ko/server.log" });
  const { sandbox, dispatch } = loadBackground({ sendNativeMessage: host.sendNativeMessage });
  const first = await sandbox.startServer();
  const again = await dispatch({ type: "startServer" });
  assert.deepEqual(plain(again), plain(first));
  assert.equal(host.calls.length, 1);
  const status = await dispatch({ type: "startServerStatus" });
  assert.deepEqual(plain(status), { starting: true, already: false, loading: false, log: "/home/x/.shisu-ko/server.log", deadline: first.deadline });
});

test("startServerStatus reports no launch when none was requested or the last one failed", async () => {
  const { dispatch } = loadBackground();
  assert.deepEqual(plain(await dispatch({ type: "startServerStatus" })), { starting: false });
  const host = nativeHost({ ok: false, error: "run.cmd is missing" });
  const failed = loadBackground({ sendNativeMessage: host.sendNativeMessage });
  await failed.sandbox.startServer();
  assert.deepEqual(plain(await failed.dispatch({ type: "startServerStatus" })), { starting: false });
  // Nothing to answer from: the next request goes to the host again.
  await failed.sandbox.startServer();
  assert.equal(host.calls.length, 2);
});

test("the launch outlives the event page: a restarted background answers from storage.session", async () => {
  const host = nativeHost({ ok: true, started: true });
  const first = loadBackground({ sendNativeMessage: host.sendNativeMessage });
  const res = await first.sandbox.startServer();
  const restarted = loadBackground({ sendNativeMessage: host.sendNativeMessage, session: first.session });
  const status = await restarted.dispatch({ type: "startServerStatus" });
  assert.deepEqual(plain(status), { starting: true, already: false, loading: false, log: null, deadline: res.deadline });
  assert.deepEqual(plain(await restarted.sandbox.startServer()), plain(res));
  assert.equal(host.calls.length, 1);
});

test("a launch is remembered in memory alone on a browser without storage.session", async () => {
  const host = nativeHost({ ok: true, started: true });
  const { sandbox, dispatch } = loadBackground({ sendNativeMessage: host.sendNativeMessage, session: null });
  const res = await sandbox.startServer();
  assert.deepEqual(plain(await sandbox.startServer()), plain(res));
  assert.equal(host.calls.length, 1);
  assert.equal((await dispatch({ type: "startServerStatus" })).starting, true);
});

test("once the launch's window has passed the host is asked again", async () => {
  const host = nativeHost({ ok: true, started: true });
  const { sandbox, session } = loadBackground({ sendNativeMessage: host.sendNativeMessage });
  const res = await sandbox.startServer();
  await session.set({ startServer: { ...plain(res), deadline: Date.now() - 1 } });
  assert.deepEqual(plain(await sandbox.startStatus()), { starting: false });
  await sandbox.startServer();
  assert.equal(host.calls.length, 2);
});

test("a server that answers /health ends the launch, so the next request reaches the host", async () => {
  const host = nativeHost({ ok: true, started: true });
  const fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ model: "large-v3" }) });
  const { sandbox, session } = loadBackground({ sendNativeMessage: host.sendNativeMessage, fetch });
  await sandbox.startServer();
  assert.equal((await sandbox.apiRequest("/health")).ok, true);
  assert.deepEqual(plain(await sandbox.startStatus()), { starting: false });
  assert.equal((await session.get("startServer")).startServer, null);
  await sandbox.startServer();
  assert.equal(host.calls.length, 2);
});

test("requests that overlap share the host's one answer", async () => {
  let answer = null;
  const host = nativeHost(() => new Promise((resolve) => { answer = resolve; }));
  const { sandbox, dispatch } = loadBackground({ sendNativeMessage: host.sendNativeMessage });
  const one = sandbox.startServer();
  const two = dispatch({ type: "startServer" });
  const status = dispatch({ type: "startServerStatus" }); // waits for the verdict too
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.calls.length, 1);
  answer({ ok: true, started: true });
  const [a, b] = await Promise.all([one, two]);
  assert.deepEqual(plain(a), plain(b));
  assert.equal((await status).starting, true);
  assert.equal(host.calls.length, 1);
});

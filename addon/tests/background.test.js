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

// ------------------------------------------------------------------ updates

// What api.github.com/repos/<owner>/<repo>/releases/latest answers, cut to the fields the
// background reads plus a few it must ignore.
const RELEASE = {
  url: "https://api.github.com/repos/Multysquid/shisu-ko/releases/1",
  html_url: "https://github.com/Multysquid/shisu-ko/releases/tag/v0.9.0",
  tag_name: "v0.9.0",
  name: "Shisu-ko 0.9.0",
  draft: false,
  prerelease: false,
  assets: [
    { name: "shisu-ko-0.9.0-chrome.zip", browser_download_url: "https://github.com/Multysquid/shisu-ko/releases/download/v0.9.0/shisu-ko-0.9.0-chrome.zip", content_type: "application/zip", size: 1 },
    { name: "shisu_ko-0.9.0.xpi", browser_download_url: "https://github.com/Multysquid/shisu-ko/releases/download/v0.9.0/shisu_ko-0.9.0.xpi", content_type: "application/x-xpinstall", size: 1 },
  ],
};
const LATEST = { version: "0.9.0", tag: "v0.9.0", url: RELEASE.html_url, xpi: RELEASE.assets[1].browser_download_url };
const HOUR = 60 * 60 * 1000;

function jsonResponse(status, body) {
  const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
}

// One fetch for the three addresses an update touches: GitHub, /health and /update. Each handler
// is a response, a function returning one, or an Error to throw; the calls are recorded by path.
function updateFetch(handlers) {
  const calls = [];
  const fetch = async (url, init) => {
    const address = String(url);
    const which = address.includes("api.github.com") ? "github" : address.endsWith("/health") ? "health" : address.endsWith("/update") ? "update" : "other";
    calls.push({ which, method: (init && init.method) || "GET", headers: (init && init.headers) || {} });
    const handler = handlers[which];
    if (handler === undefined) throw new TypeError(`NetworkError: ${address}`);
    const res = typeof handler === "function" ? handler() : handler;
    if (res instanceof Error) throw res;
    return res;
  };
  return { fetch, calls, count: (which) => calls.filter((c) => c.which === which).length };
}

const healthOf = (version, launcher) => jsonResponse(200, { ok: true, version, launcher, model: "large-v3", device: "cuda", compute_type: "float16" });
const github = () => jsonResponse(200, RELEASE);
// A check made 25 hours ago: stale by the day's rule.
const staleCheck = () => ({ updateCheck: { checkedAt: Date.now() - 25 * HOUR, latest: { version: "0.8.5", tag: "v0.8.5", url: null, xpi: null }, error: null } });
const freshCheck = () => ({ updateCheck: { checkedAt: Date.now() - HOUR, latest: LATEST, error: null } });

test("parseVersion reads three numbers and shrugs at the rest", () => {
  const { sandbox } = loadBackground();
  const cases = [
    ["0.9.0", [0, 9, 0]], ["v0.9.0", [0, 9, 0]], ["V1.2.3", [1, 2, 3]], ["0.10.0", [0, 10, 0]], ["0.9", [0, 9, 0]], ["2", [2, 0, 0]],
    ["", [0, 0, 0]], [undefined, [0, 0, 0]], [null, [0, 0, 0]], ["garbage", [0, 0, 0]], ["0.9.0-rc1", [0, 9, 0]], ["a.b.c", [0, 0, 0]],
    [" 1.2.3 ", [1, 2, 3]], ["1.2.3.4", [1, 2, 3]], ["-1.2.3", [0, 2, 3]],
  ];
  for (const [text, expected] of cases) assert.deepEqual(plain(sandbox.parseVersion(text)), expected, String(text));
});

test("compareVersions orders releases numerically, whatever the spelling", () => {
  const { sandbox } = loadBackground();
  assert.equal(sandbox.compareVersions("0.9.0", "0.8.0"), 1);
  assert.equal(sandbox.compareVersions("0.8.0", "0.9.0"), -1);
  assert.equal(sandbox.compareVersions("0.9.0", "v0.9.0"), 0);
  assert.equal(sandbox.compareVersions("0.10.0", "0.9.0"), 1, "numeric, not lexical");
  assert.equal(sandbox.compareVersions("1.0.0", "0.99.99"), 1);
  assert.equal(sandbox.compareVersions("0.9", "0.9.0"), 0);
  assert.equal(sandbox.compareVersions("0.9.1", "0.9"), 1);
  assert.equal(sandbox.compareVersions("garbage", "0.0.1"), -1);
  assert.equal(sandbox.compareVersions("", ""), 0);
});

test("decideUpdate tells the server's case and the extension's apart", () => {
  const { sandbox } = loadBackground();
  const decide = (input) => plain(sandbox.decideUpdate(input));
  const latest = { version: "0.9.0" };
  assert.deepEqual(decide({ latest, serverVersion: "0.8.0", serverLauncher: true, extensionVersion: "0.9.0" }), { server: "newer", extension: "current" });
  assert.deepEqual(decide({ latest, serverVersion: "0.8.0", serverLauncher: false, extensionVersion: "0.9.0" }), { server: "cannot", extension: "current" });
  assert.deepEqual(decide({ latest, serverVersion: "0.9.0", serverLauncher: true, extensionVersion: "0.9.0" }), { server: "current", extension: "current" });
  assert.deepEqual(decide({ latest, serverVersion: "0.9.1", serverLauncher: false, extensionVersion: "0.9.0" }), { server: "current", extension: "current" }, "a server ahead of the release is current");
  assert.deepEqual(decide({ latest, serverVersion: null, serverLauncher: null, extensionVersion: "0.8.0" }), { server: "offline", extension: "newer" });
  assert.deepEqual(decide({ latest, serverVersion: "0.8.0", serverLauncher: true, extensionVersion: "0.8.0" }), { server: "newer", extension: "newer" });
  // The smoke fixture: online, but neither a version nor the launcher flag.
  assert.deepEqual(decide({ latest, serverVersion: null, serverLauncher: null, extensionVersion: "0.9.0", serverOnline: true }), { server: "unknown", extension: "current" });
  // A server from before the flag (0.8.0): behind the release, and no telling whether it can update itself.
  assert.deepEqual(decide({ latest, serverVersion: "0.8.0", serverLauncher: null, extensionVersion: "0.9.0" }), { server: "behind", extension: "current" });
  assert.deepEqual(decide({ latest, serverVersion: "0.9.0", serverLauncher: null, extensionVersion: "0.9.0" }), { server: "current", extension: "current" });
  // Nothing known about the newest release: nothing to say.
  assert.deepEqual(decide({ latest: null, serverVersion: "0.8.0", serverLauncher: true, extensionVersion: "0.8.0" }), { server: "unknown", extension: "current" });
  assert.deepEqual(decide({ latest: { version: "" }, serverVersion: "0.8.0", serverLauncher: true }), { server: "unknown", extension: "current" });
  assert.deepEqual(decide(undefined), { server: "unknown", extension: "current" });
  assert.deepEqual(decide({ latest: { version: "v0.10.0" }, serverVersion: "0.9.0", serverLauncher: true, extensionVersion: "0.9.0" }), { server: "newer", extension: "newer" });
});

test("releaseFromApi reads the version, the page and the xpi off GitHub's answer", () => {
  const { sandbox } = loadBackground();
  assert.deepEqual(plain(sandbox.releaseFromApi(RELEASE)), LATEST);
  const noAssets = plain(sandbox.releaseFromApi({ tag_name: "0.9.1", html_url: RELEASE.html_url }));
  assert.deepEqual(noAssets, { version: "0.9.1", tag: "0.9.1", url: RELEASE.html_url, xpi: null });
  assert.equal(plain(sandbox.releaseFromApi({ tag_name: "v0.9.0", assets: [{ name: "only.zip", browser_download_url: "https://x/only.zip" }] })).xpi, null);
  // No tag, no release; and a page that is not https is no page to open.
  assert.equal(sandbox.releaseFromApi({ html_url: RELEASE.html_url }), null);
  assert.equal(sandbox.releaseFromApi({ tag_name: "  " }), null);
  assert.equal(sandbox.releaseFromApi(null), null);
  assert.equal(sandbox.releaseFromApi("v0.9.0"), null);
  assert.equal(plain(sandbox.releaseFromApi({ tag_name: "v0.9.0", html_url: "javascript:alert(1)" })).url, null);
  assert.equal(plain(sandbox.releaseFromApi({ tag_name: "v0.9.0", assets: [{ name: "a.xpi", browser_download_url: "http://x/a.xpi" }] })).xpi, null);
});

test("checkForUpdate answers from a fresh store without asking GitHub", async () => {
  const storage = makeMemoryStorage(freshCheck());
  const mock = updateFetch({ github });
  const { sandbox } = loadBackground({ storage, fetch: mock.fetch });
  const res = await sandbox.checkForUpdate();
  assert.deepEqual(plain(res.latest), LATEST);
  assert.equal(res.error, null);
  assert.equal(mock.count("github"), 0);
});

test("checkForUpdate asks GitHub when the store is a day old, or when forced, and stores the answer", async () => {
  const storage = makeMemoryStorage(staleCheck());
  const mock = updateFetch({ github });
  const { sandbox } = loadBackground({ storage, fetch: mock.fetch });
  assert.equal(sandbox.UPDATE_CHECK_MAX_AGE_MS, 24 * HOUR);
  const before = Date.now();
  const res = await sandbox.checkForUpdate();
  assert.equal(mock.count("github"), 1);
  assert.deepEqual(plain(mock.calls[0].headers), { Accept: "application/vnd.github+json" });
  assert.deepEqual(plain(res.latest), LATEST);
  assert.ok(res.checkedAt >= before && res.checkedAt <= Date.now());
  assert.deepEqual(plain((await storage.get("updateCheck")).updateCheck), plain(res));
  // Fresh now: the next call is served from the store, a forced one is not.
  await sandbox.checkForUpdate();
  assert.equal(mock.count("github"), 1);
  await sandbox.checkForUpdate({ force: true });
  assert.equal(mock.count("github"), 2);
  assert.equal(sandbox.GITHUB_LATEST_URL, "https://api.github.com/repos/Multysquid/shisu-ko/releases/latest");
});

test("checkForUpdate stores a failure as an error, keeps the last release seen, and never throws", async () => {
  const cases = [
    ["offline", new TypeError("NetworkError when attempting to fetch resource."), /could not reach GitHub/],
    ["rate limit", jsonResponse(403, { message: "API rate limit exceeded" }), /rate limit/],
    ["server error", jsonResponse(500, "boom"), /HTTP 500/],
    ["not JSON", jsonResponse(200, "<html>not json</html>"), /non-JSON/],
    ["no tag", jsonResponse(200, { message: "Moved Permanently" }), /names no release/],
  ];
  for (const [name, answer, pattern] of cases) {
    const storage = makeMemoryStorage(staleCheck());
    const mock = updateFetch({ github: answer });
    const { sandbox } = loadBackground({ storage, fetch: mock.fetch });
    const res = await sandbox.checkForUpdate();
    assert.match(res.error, pattern, name);
    assert.equal(res.latest.version, "0.8.5", `${name}: the last release seen stays`);
    assert.equal((await storage.get("updateCheck")).updateCheck.error, res.error, name);
    // A failed check is no check: the next call tries again.
    await sandbox.checkForUpdate();
    assert.equal(mock.count("github"), 2, name);
  }
});

test("checkForUpdate takes a 404 for no release published yet", async () => {
  const storage = makeMemoryStorage(staleCheck());
  const mock = updateFetch({ github: jsonResponse(404, { message: "Not Found" }) });
  const { sandbox } = loadBackground({ storage, fetch: mock.fetch });
  const res = await sandbox.checkForUpdate();
  assert.equal(res.error, null);
  assert.equal(res.latest, null);
});

test("checks that overlap share one request", async () => {
  const storage = makeMemoryStorage();
  const mock = updateFetch({ github });
  const { sandbox, dispatch } = loadBackground({ storage, fetch: mock.fetch });
  const [a, b] = await Promise.all([sandbox.checkForUpdate({ force: true }), dispatch({ type: "checkForUpdate", force: true })]);
  assert.deepEqual(plain(a), plain(b));
  assert.equal(mock.count("github"), 1);
});

test("the browser starting checks, sets the badge and notifies once per release", async () => {
  const storage = makeMemoryStorage(staleCheck());
  const mock = updateFetch({ github, health: healthOf("0.8.0", true) });
  const bg = loadBackground({ storage, fetch: mock.fetch, extensionVersion: "0.9.0" });
  await bg.startup();
  assert.equal(mock.count("github"), 1);
  assert.equal(mock.count("health"), 1);
  assert.deepEqual(plain(bg.badge), [["color", "#5b6fb8"], ["text", "1"]]);
  assert.equal(bg.notifications.length, 1);
  const shown = bg.notifications[0];
  assert.equal(shown.id, "shisuko-update");
  assert.equal(shown.type, "basic");
  assert.equal(shown.title, "Shisu-ko 0.9.0 is available");
  assert.equal(shown.message, "The server runs 0.8.0. Click to update it now.");
  assert.equal(shown.iconUrl, "moz-extension://test/icons/icon-128.png");
  // Once per release and browser session: the extension installed again, or the check run again,
  // says nothing more; a restarted event page in the same session neither.
  await bg.startup(true);
  await bg.startup();
  assert.equal(bg.notifications.length, 1);
  assert.equal(mock.count("github"), 1, "the day's check is served from the store");
  const restarted = loadBackground({ storage, session: bg.session, fetch: mock.fetch, extensionVersion: "0.9.0" });
  await restarted.startup();
  assert.equal(restarted.notifications.length, 0);
  assert.deepEqual(plain(restarted.badge), [["color", "#5b6fb8"], ["text", "1"]]);
});

test("a server that cannot update itself, or none, gets the badge and no notification", async () => {
  const storage = makeMemoryStorage(freshCheck());
  const docker = loadBackground({ storage, fetch: updateFetch({ health: healthOf("0.8.0", false) }).fetch, extensionVersion: "0.9.0" });
  await docker.startup();
  assert.deepEqual(plain(docker.badge.at(-1)), ["text", "1"]);
  assert.equal(docker.notifications.length, 0);
  // Offline: the launcher updates it at the next start, and the extension is current.
  const offline = loadBackground({ storage, fetch: updateFetch({}).fetch, extensionVersion: "0.9.0" });
  await offline.startup();
  assert.deepEqual(plain(offline.badge), [["text", ""]]);
  assert.equal(offline.notifications.length, 0);
  // Only the extension is behind: the badge, and nothing to click, since its update is AMO's.
  const extension = loadBackground({ storage, fetch: updateFetch({}).fetch, extensionVersion: "0.8.0" });
  await extension.startup();
  assert.deepEqual(plain(extension.badge.at(-1)), ["text", "1"]);
  assert.equal(extension.notifications.length, 0);
  // A 0.8.0 server, which reports its version but no launcher flag: the badge, and no
  // notification, since nothing says whether /update would work.
  const older = loadBackground({ storage, fetch: updateFetch({ health: jsonResponse(200, { ok: true, version: "0.8.0", model: "large-v3", device: "cuda", compute_type: "float16" }) }).fetch, extensionVersion: "0.9.0" });
  await older.startup();
  assert.deepEqual(plain(older.badge.at(-1)), ["text", "1"]);
  assert.equal(older.notifications.length, 0);
  assert.deepEqual(plain((await older.dispatch({ type: "updateStatus", health: { version: "0.8.0" } })).decision), { server: "behind", extension: "current" });
  // Nothing newer: the badge is cleared, in case an earlier check set it.
  const current = loadBackground({ storage, fetch: updateFetch({ health: healthOf("0.9.0", true) }).fetch, extensionVersion: "0.9.0" });
  await current.startup();
  assert.deepEqual(plain(current.badge), [["text", ""]]);
});

test("a profile that has never checked makes no request at install or start; the popup's check is its first", async () => {
  // A fresh profile, as the Chrome smoke test loads one: nothing may leave for api.github.com,
  // and nothing for the server either, until the popup asks.
  const storage = makeMemoryStorage();
  const mock = updateFetch({ github, health: healthOf("0.8.0", true) });
  const bg = loadBackground({ storage, fetch: mock.fetch, extensionVersion: "0.9.0" });
  await bg.startup(true);
  await bg.startup();
  assert.deepEqual(mock.calls, []);
  assert.deepEqual(plain(bg.badge), []);
  assert.equal(bg.notifications.length, 0);
  assert.equal((await storage.get("updateCheck")).updateCheck, undefined);
  // The popup's first question checks; from then on the browser's start does too.
  const opened = await bg.dispatch({ type: "updateStatus", health: null, check: true });
  assert.equal(mock.count("github"), 1);
  assert.equal(opened.latest.version, "0.9.0");
  const later = loadBackground({ storage, fetch: mock.fetch, extensionVersion: "0.9.0" });
  await later.startup();
  assert.equal(mock.count("health"), 1);
  assert.deepEqual(plain(later.badge), [["color", "#5b6fb8"], ["text", "1"]]);
  assert.equal(later.notifications.length, 1);
  // A check the popup seeded (the smoke test's way of staying offline) counts as a check.
  const seeded = makeMemoryStorage({ updateCheck: { checkedAt: Date.now(), latest: null, error: null } });
  const quiet = loadBackground({ storage: seeded, fetch: mock.fetch, extensionVersion: "0.9.0" });
  await quiet.startup(true);
  assert.equal(mock.count("github"), 1);
  assert.deepEqual(plain(quiet.badge), [["text", ""]]);
});

test("the start-up check survives a browser without the badge or the notification API", async () => {
  const storage = makeMemoryStorage(freshCheck());
  const mock = updateFetch({ github, health: healthOf("0.8.0", true) });
  const bg = loadBackground({ storage, fetch: mock.fetch, extensionVersion: "0.9.0", action: null, notifications: null });
  await bg.startup();
  const status = await bg.dispatch({ type: "updateStatus" });
  assert.deepEqual(plain(status.decision), { server: "newer", extension: "current" });
  assert.deepEqual(plain(bg.badge), []);
  assert.deepEqual(plain(bg.notifications), []);
});

test("updateStatus answers the popup with the release, the server, the verdict and the flags", async () => {
  const storage = makeMemoryStorage(freshCheck());
  const mock = updateFetch({ github, health: healthOf("0.8.0", true) });
  const { dispatch } = loadBackground({ storage, fetch: mock.fetch, extensionVersion: "0.9.0" });
  // With the /health answer in the message the server is not asked again.
  const given = await dispatch({ type: "updateStatus", health: { version: "0.8.0", launcher: true }, check: true });
  assert.equal(mock.count("health"), 0);
  assert.equal(mock.count("github"), 0, "the store is fresh");
  assert.deepEqual(plain(given.latest), LATEST);
  assert.equal(typeof given.checkedAt, "number");
  assert.equal(given.error, null);
  assert.deepEqual(plain(given.server), { version: "0.8.0", launcher: true });
  assert.deepEqual(plain(given.decision), { server: "newer", extension: "current" });
  assert.equal(given.snoozed, null);
  assert.equal(given.updating, null);
  assert.equal(given.extensionVersion, "0.9.0");
  // Without one, /health is called; the smoke fixture's answer (no version, no flag) is unknown.
  const asked = await dispatch({ type: "updateStatus" });
  assert.equal(mock.count("health"), 1);
  assert.deepEqual(plain(asked.decision), { server: "newer", extension: "current" });
  const fixture = await dispatch({ type: "updateStatus", health: { model: "smoke", device: "cpu", compute_type: "test" } });
  assert.deepEqual(plain(fixture.server), { version: null, launcher: null });
  assert.deepEqual(plain(fixture.decision), { server: "unknown", extension: "current" });
  const offline = await dispatch({ type: "updateStatus", health: null });
  assert.equal(offline.server, null);
  assert.deepEqual(plain(offline.decision), { server: "offline", extension: "current" });
});

test("updateStatus runs the day's check when the popup opens and the store is stale", async () => {
  const storage = makeMemoryStorage(staleCheck());
  const mock = updateFetch({ github });
  const { dispatch } = loadBackground({ storage, fetch: mock.fetch, extensionVersion: "0.9.0" });
  const without = await dispatch({ type: "updateStatus", health: null });
  assert.equal(mock.count("github"), 0);
  assert.equal(without.latest.version, "0.8.5");
  const opened = await dispatch({ type: "updateStatus", health: null, check: true });
  assert.equal(mock.count("github"), 1);
  assert.equal(opened.latest.version, "0.9.0");
});

test("snoozeUpdate remembers the release for the browser session", async () => {
  const storage = makeMemoryStorage(freshCheck());
  const { dispatch, session } = loadBackground({ storage, fetch: updateFetch({}).fetch });
  assert.deepEqual(plain(await dispatch({ type: "snoozeUpdate", version: "0.9.0" })), { ok: true });
  assert.equal((await session.get("updateSnoozed")).updateSnoozed, "0.9.0");
  assert.equal((await dispatch({ type: "updateStatus", health: null })).snoozed, "0.9.0");
  assert.equal((await dispatch({ type: "snoozeUpdate" })).ok, false);
});

test("updateServer posts /update, remembers the request for the popup and answers with the versions", async () => {
  const storage = makeMemoryStorage(freshCheck());
  const mock = updateFetch({ health: healthOf("0.8.0", true), update: jsonResponse(200, { ok: true, restarting: true, version: "0.8.0" }) });
  const { sandbox, dispatch, session } = loadBackground({ storage, fetch: mock.fetch, extensionVersion: "0.9.0" });
  assert.equal(sandbox.UPDATE_WINDOW_MS, 120000);
  const before = Date.now();
  const res = await dispatch({ type: "updateServer" });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.restarting, true);
  assert.equal(res.from, "0.8.0");
  assert.equal(res.to, "0.9.0");
  assert.ok(res.requestedAt >= before && res.deadline === res.requestedAt + 120000);
  const posted = mock.calls.find((c) => c.which === "update");
  assert.equal(posted.method, "POST");
  const stored = (await session.get("serverUpdate")).serverUpdate;
  assert.deepEqual(plain(stored), { requestedAt: res.requestedAt, from: "0.8.0", to: "0.9.0", deadline: res.deadline, down: false });
  assert.deepEqual(plain((await dispatch({ type: "updateStatus", health: null })).updating), plain(stored));
  // A second request while the restart is under way is answered from the record, not posted.
  const again = await sandbox.updateServer();
  assert.equal(again.already, true);
  assert.equal(again.deadline, res.deadline);
  assert.equal(mock.count("update"), 1);
});

test("updateServer passes the server's refusal through, and says when it is unreachable", async () => {
  const storage = makeMemoryStorage(freshCheck());
  const refused = updateFetch({ health: healthOf("0.8.0", false), update: jsonResponse(409, { ok: false, error: "not started by run.cmd / run.sh" }) });
  const bg = loadBackground({ storage, fetch: refused.fetch, extensionVersion: "0.9.0" });
  const res = await bg.sandbox.updateServer();
  assert.deepEqual(plain(res), { ok: false, error: "not started by run.cmd / run.sh", refused: true, offline: false });
  assert.equal((await bg.session.get("serverUpdate")).serverUpdate, undefined, "a refused request leaves no record");
  const gone = loadBackground({ storage, fetch: updateFetch({}).fetch, extensionVersion: "0.9.0" });
  const offline = await gone.sandbox.updateServer();
  assert.equal(offline.ok, false);
  assert.equal(offline.offline, true);
  assert.equal(offline.refused, false);
  // A server that already runs the release is not restarted for nothing.
  const done = loadBackground({ storage, fetch: updateFetch({ health: healthOf("0.9.0", true), update: jsonResponse(200, { ok: true, restarting: true }) }).fetch });
  const skip = await done.sandbox.updateServer();
  assert.equal(skip.ok, false);
  assert.match(skip.error, /already runs 0\.9\.0/);
});

test("the popup's /health polls tell the background how the update went", async () => {
  const storage = makeMemoryStorage(freshCheck());
  let health = healthOf("0.8.0", true);
  const mock = updateFetch({ health: () => health, update: jsonResponse(200, { ok: true, restarting: true }) });
  const bg = loadBackground({ storage, fetch: mock.fetch, extensionVersion: "0.9.0" });
  await bg.sandbox.updateServer();
  bg.badge.length = 0;
  // The old server still answers for a moment: nothing changes.
  await bg.sandbox.apiRequest("/health");
  assert.equal((await bg.session.get("serverUpdate")).serverUpdate.down, false);
  // Then nobody does: the restart is under way.
  health = new TypeError("NetworkError");
  await bg.sandbox.apiRequest("/health");
  assert.equal((await bg.session.get("serverUpdate")).serverUpdate.down, true);
  // The new version answers: the record ends, the badge goes, and the viewer is told.
  health = healthOf("0.9.0", true);
  await bg.sandbox.apiRequest("/health");
  assert.equal((await bg.session.get("serverUpdate")).serverUpdate, null);
  assert.deepEqual(plain(bg.badge), [["text", ""]]);
  const told = bg.notifications.find((n) => n.id === "shisuko-updated");
  assert.equal(told.title, "Shisu-ko updated to 0.9.0");
  assert.equal((await bg.dispatch({ type: "updateStatus", health: { version: "0.9.0", launcher: true } })).updating, null);
});

test("the old version back after the restart ends the record without a word", async () => {
  const storage = makeMemoryStorage(freshCheck());
  let health = healthOf("0.8.0", true);
  const mock = updateFetch({ health: () => health, update: jsonResponse(200, { ok: true, restarting: true }) });
  const bg = loadBackground({ storage, fetch: mock.fetch, extensionVersion: "0.9.0" });
  await bg.sandbox.updateServer();
  health = new TypeError("NetworkError");
  await bg.sandbox.apiRequest("/health");
  health = healthOf("0.8.0", true);
  await bg.sandbox.apiRequest("/health");
  assert.equal((await bg.session.get("serverUpdate")).serverUpdate, null);
  assert.ok(!bg.notifications.some((n) => n.id === "shisuko-updated"));
  // The banner is back: the next request is posted again.
  await bg.sandbox.updateServer();
  assert.equal(mock.count("update"), 2);
});

test("the old version long after the request ends the record even when no poll saw the server down", async () => {
  // The popup closed with the click, so nobody polled while the server restarted; update.py could
  // not update and run.cmd brought 0.8.0 back. The first poll after that is a reopened popup's.
  const storage = makeMemoryStorage(freshCheck());
  const mock = updateFetch({ health: healthOf("0.8.0", true), update: jsonResponse(200, { ok: true, restarting: true }) });
  const bg = loadBackground({ storage, fetch: mock.fetch, extensionVersion: "0.9.0" });
  const t0 = Date.now();
  bg.setNow(t0);
  await bg.sandbox.updateServer();
  // Within the shutdown allowance the old server may still be answering: the record stays, and a
  // second request is answered from it.
  bg.setNow(t0 + 5000);
  await bg.sandbox.apiRequest("/health");
  assert.equal((await bg.session.get("serverUpdate")).serverUpdate.down, false);
  assert.equal((await bg.sandbox.updateServer()).already, true);
  assert.equal(mock.count("update"), 1);
  // Past it the old version is the restarted server: the record ends without a word, the popup
  // is not told to resume anything, and its Update click is posted again.
  bg.setNow(t0 + 11000);
  await bg.sandbox.apiRequest("/health");
  assert.equal((await bg.session.get("serverUpdate")).serverUpdate, null);
  assert.ok(!bg.notifications.some((n) => n.id === "shisuko-updated"));
  assert.equal((await bg.dispatch({ type: "updateStatus", health: healthOf("0.8.0", true).data })).updating, null);
  const again = await bg.sandbox.updateServer();
  assert.equal(again.already, undefined);
  assert.equal(again.restarting, true);
  assert.equal(mock.count("update"), 2);
  // The notification path polls nothing between clicks: a click alone, long after, posts too.
  bg.setNow(t0 + 40000);
  assert.equal((await bg.sandbox.updateServer()).already, undefined);
  assert.equal(mock.count("update"), 3);
});

test("the update record outlives the event page", async () => {
  const storage = makeMemoryStorage(freshCheck());
  const mock = updateFetch({ health: healthOf("0.8.0", true), update: jsonResponse(200, { ok: true, restarting: true }) });
  const first = loadBackground({ storage, fetch: mock.fetch, extensionVersion: "0.9.0" });
  const res = await first.sandbox.updateServer();
  const restarted = loadBackground({ storage, session: first.session, fetch: mock.fetch, extensionVersion: "0.9.0" });
  const status = await restarted.dispatch({ type: "updateStatus", health: null });
  assert.equal(status.updating.deadline, res.deadline);
  assert.equal((await restarted.sandbox.updateServer()).already, true);
  assert.equal(mock.count("update"), 1);
  // Past its window the record is spent.
  await first.session.set({ serverUpdate: { ...plain(res), deadline: Date.now() - 1 } });
  const later = loadBackground({ storage, session: first.session, fetch: mock.fetch, extensionVersion: "0.9.0" });
  assert.equal((await later.dispatch({ type: "updateStatus", health: null })).updating, null);
});

test("clicking the notification updates the server and the background follows it to the end", async () => {
  const storage = makeMemoryStorage(freshCheck());
  let health = healthOf("0.8.0", true);
  const mock = updateFetch({ health: () => health, update: () => {
    health = healthOf("0.9.0", true); // the launcher's restart, seen by the very next poll
    return jsonResponse(200, { ok: true, restarting: true });
  } });
  const bg = loadBackground({ storage, fetch: mock.fetch, extensionVersion: "0.9.0", ...instantTimers });
  await bg.clickNotification("some-other-notification");
  assert.equal(mock.count("update"), 0);
  await bg.clickNotification("shisuko-update");
  assert.equal(mock.count("update"), 1);
  await settle();
  assert.ok(bg.notifications.some((n) => n.id === "shisuko-update" && n.cleared), "the clicked notification is cleared");
  assert.ok(bg.notifications.some((n) => n.id === "shisuko-updated"), "the background polled /health and saw the new version");
  assert.equal((await bg.session.get("serverUpdate")).serverUpdate, null);
});

// The click asked for something: unlike a check, a request that did not get through must not
// vanish without a word, since no popup is open to show the result.
test("a notification click whose request fails says so in a notification of its own", async () => {
  const storage = makeMemoryStorage(freshCheck());
  const cases = [
    // The server stopped between the notification and the click.
    { handlers: {}, error: "Server unreachable" },
    // Restarted by hand without the launcher since the notification.
    { handlers: { health: healthOf("0.8.0", false), update: jsonResponse(409, { ok: false, error: "the server was not started by run.cmd / run.sh" }) }, error: "the server was not started by run.cmd / run.sh" },
    // Updated another way since the notification.
    { handlers: { health: healthOf("0.9.0", true), update: jsonResponse(200, { ok: true, restarting: true }) }, error: "the server already runs 0.9.0" },
  ];
  for (const { handlers, error } of cases) {
    const mock = updateFetch(handlers);
    const bg = loadBackground({ storage, fetch: mock.fetch, extensionVersion: "0.9.0", ...instantTimers });
    await bg.clickNotification("shisuko-update");
    await settle();
    const failed = bg.notifications.filter((n) => n.id === "shisuko-update-failed");
    assert.equal(failed.length, 1, error);
    assert.equal(failed[0].title, "Shisu-ko could not update the server");
    assert.equal(failed[0].message, error);
    assert.ok(!bg.notifications.some((n) => n.id === "shisuko-updated"));
    assert.equal((await bg.session.get("serverUpdate")).serverUpdate, undefined);
    // Its own id: a click on the failure posts nothing.
    const posted = mock.count("update");
    await bg.clickNotification("shisuko-update-failed");
    assert.equal(mock.count("update"), posted);
  }
  // The popup's request reports the same failure on its own line; no notification for it.
  const popup = loadBackground({ storage, fetch: updateFetch({}).fetch, extensionVersion: "0.9.0" });
  assert.equal((await popup.dispatch({ type: "updateServer" })).ok, false);
  assert.equal(popup.notifications.length, 0);
});

// Between the old server's exit and the new one's port the native host sees neither /health nor
// the instance lock, and would launch run.cmd a second time: two update.py runs on one folder.
test("startServer is refused while an update is under way, and startServerStatus carries the record", async () => {
  const storage = makeMemoryStorage(freshCheck());
  let health = healthOf("0.8.0", true);
  const mock = updateFetch({ health: () => health, update: jsonResponse(200, { ok: true, restarting: true }) });
  const host = nativeHost({ ok: true, started: true, log: null });
  const bg = loadBackground({ storage, fetch: mock.fetch, extensionVersion: "0.9.0", sendNativeMessage: host.sendNativeMessage });
  const res = await bg.sandbox.updateServer();
  assert.equal(res.restarting, true);
  const record = (await bg.session.get("serverUpdate")).serverUpdate;
  assert.deepEqual(plain(await bg.dispatch({ type: "startServerStatus" })), { starting: false, updating: plain(record) });
  const refused = await bg.dispatch({ type: "startServer" });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "an update is under way");
  assert.match(refused.hint, /launcher restarts the server itself/);
  assert.equal(host.calls.length, 0, "the host was not asked");
  // A restarted event page knows the record from storage.session and refuses too.
  const restarted = loadBackground({ storage, session: bg.session, fetch: mock.fetch, extensionVersion: "0.9.0", sendNativeMessage: host.sendNativeMessage });
  assert.equal((await restarted.dispatch({ type: "startServer" })).error, "an update is under way");
  assert.equal(host.calls.length, 0);
  // The new version ends the record: a start reaches the host again, and the status says nothing of an update.
  health = healthOf("0.9.0", true);
  await bg.sandbox.apiRequest("/health");
  assert.deepEqual(plain(await bg.dispatch({ type: "startServerStatus" })), { starting: false });
  assert.equal((await bg.dispatch({ type: "startServer" })).ok, true);
  assert.equal(host.calls.length, 1);
});

test("the message switch routes the four update messages", async () => {
  const storage = makeMemoryStorage(staleCheck());
  const mock = updateFetch({ github, health: healthOf("0.8.0", true), update: jsonResponse(200, { ok: true, restarting: true }) });
  const { dispatch } = loadBackground({ storage, fetch: mock.fetch, extensionVersion: "0.9.0" });
  assert.equal((await dispatch({ type: "checkForUpdate", force: true })).latest.version, "0.9.0");
  assert.equal(mock.count("github"), 1);
  assert.deepEqual(plain((await dispatch({ type: "updateStatus", health: null })).decision), { server: "offline", extension: "current" });
  assert.equal((await dispatch({ type: "snoozeUpdate", version: "0.9.0" })).ok, true);
  assert.equal((await dispatch({ type: "updateServer" })).restarting, true);
  assert.equal(mock.count("update"), 1);
});

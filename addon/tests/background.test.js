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

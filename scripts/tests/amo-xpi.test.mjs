import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ADDON_ID, PENDING_EXIT, downloadTarget, jwt, run, stateOf, versionUrl } from "../amo-xpi.mjs";

const ENV = { WEB_EXT_API_KEY: "user:1:2", WEB_EXT_API_SECRET: "s3cret" };
const FILE_URL = "https://addons.mozilla.org/firefox/downloads/file/1/shisu_ko-0.14.0.xpi";

function amo(states, { body = "signed bytes" } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    if (url === FILE_URL) return new Response(body);
    const state = states.length > 1 ? states.shift() : states[0];
    if (state === 404) return new Response("{}", { status: 404 });
    if (typeof state === "number") return new Response("nope", { status: state });
    return Response.json({ file: { status: state, url: FILE_URL } });
  };
  return { fetch, calls };
}

function harness(states, extra = {}) {
  const out = [], err = [];
  let clock = 0;
  const { fetch, calls } = amo(states, extra);
  const deps = {
    env: ENV, fetch, now: () => clock, sleep: async (ms) => { clock += ms; },
    log: (line) => out.push(line), warn: (line) => err.push(line),
  };
  return { deps, calls, out, err };
}

test("the token is an HS256 JWT signed with the secret and short-lived", () => {
  const token = jwt("user:1:2", "s3cret", 1_000_000);
  const [head, body, sig] = token.split(".");
  assert.equal(sig, createHmac("sha256", "s3cret").update(`${head}.${body}`).digest("base64url"));
  assert.deepEqual(JSON.parse(Buffer.from(head, "base64url")), { alg: "HS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(body, "base64url"));
  assert.equal(claims.iss, "user:1:2");
  assert.equal(claims.iat, 1000);
  assert.equal(claims.exp - claims.iat, 60);
  assert.notEqual(JSON.parse(Buffer.from(jwt("user:1:2", "s3cret").split(".")[1], "base64url")).jti, claims.jti);
});

test("the version URL takes a version number or a tag and nothing else", () => {
  const base = `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(ADDON_ID)}/versions/`;
  assert.equal(versionUrl("0.14.0"), `${base}0.14.0/`);
  assert.equal(versionUrl("v0.14.0"), `${base}0.14.0/`);
  for (const bad of ["", "latest", "0.14.0/../x", "1", "0.14.0-beta"]) assert.throws(() => versionUrl(bad));
});

test("states", () => {
  assert.equal(stateOf(null), "missing");
  assert.equal(stateOf({ file: { status: "unreviewed" } }), "pending");
  assert.equal(stateOf({}), "pending");
  assert.equal(stateOf({ file: { status: "public" } }), "public");
  assert.equal(stateOf({ file: { status: "disabled" } }), "disabled");
});

test("the signed file is only downloaded from addons.mozilla.org", () => {
  assert.deepEqual(downloadTarget(FILE_URL), { url: FILE_URL, name: "shisu_ko-0.14.0.xpi" });
  assert.throws(() => downloadTarget("http://addons.mozilla.org/x/a.xpi"));
  assert.throws(() => downloadTarget("https://addons.mozilla.org.evil.example/a.xpi"));
  assert.throws(() => downloadTarget("https://addons.mozilla.org/firefox/downloads/file/1/..%2Fa.xpi"));
  assert.throws(() => downloadTarget("https://addons.mozilla.org/firefox/downloads/file/1/"));
});

test("status prints the state", async () => {
  for (const [state, printed] of [[404, "missing"], ["unreviewed", "pending"], ["public", "public"]]) {
    const h = harness([state]);
    assert.equal(await run(["status", "0.14.0"], h.deps), 0);
    assert.deepEqual(h.out, [printed]);
    assert.match(h.calls[0].auth, /^JWT [\w-]+\.[\w-]+\.[\w-]+$/);
  }
});

test("fetch downloads an approved version, after waiting for the review", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amo-xpi-"));
  try {
    const h = harness(["unreviewed", "unreviewed", "public"]);
    assert.equal(await run(["fetch", "0.14.0", "--out", dir, "--wait", "600"], h.deps), 0);
    const path = join(dir, "shisu_ko-0.14.0.xpi");
    assert.deepEqual(h.out, [path]);
    assert.equal(readFileSync(path, "utf8"), "signed bytes");
    assert.equal(h.calls.at(-1).url, FILE_URL);
    assert.ok(h.calls.at(-1).auth.startsWith("JWT "));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetch gives up with the pending code when the wait runs out", async () => {
  const h = harness(["unreviewed"]);
  assert.equal(await run(["fetch", "0.14.0", "--wait", "90"], h.deps), PENDING_EXIT);
  assert.equal(h.calls.length, 4); // at 0, 30, 60 and 90 seconds
  const once = harness(["unreviewed"]);
  assert.equal(await run(["fetch", "0.14.0"], once.deps), PENDING_EXIT);
  assert.equal(once.calls.length, 1);
});

test("fetch fails for a missing or rejected version and on AMO errors", async () => {
  for (const state of [404, "disabled", 500]) {
    const h = harness([state]);
    assert.equal(await run(["fetch", "0.14.0", "--wait", "60"], h.deps), 1);
    assert.equal(h.out.length, 0);
  }
});

test("bad arguments and a missing key are usage errors", async () => {
  const h = harness(["public"]);
  assert.equal(await run(["fetch", "latest"], h.deps), 2);
  assert.equal(await run(["upload", "0.14.0"], h.deps), 2);
  assert.equal(await run(["fetch", "0.14.0", "--wait", "-1"], h.deps), 2);
  assert.equal(await run(["status", "0.14.0"], { ...h.deps, env: {} }), 2);
  assert.equal(h.calls.length, 0);
});

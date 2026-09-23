#!/usr/bin/env node
// Asks addons.mozilla.org about one version of the add-on and downloads its signed .xpi once AMO
// has approved it. The release workflows use it: the listed submission returns before the
// review, so the signed file for the GitHub release is fetched afterwards. Node only, no packages.
//
//   node scripts/amo-xpi.mjs status <version>
//     prints missing, pending, public or AMO's own file status (disabled: rejected)
//   node scripts/amo-xpi.mjs fetch <version> [--out <dir>] [--wait <seconds>]
//     downloads the signed file into <dir> (default dist/signed) and prints its path; exit 3 when
//     AMO has not approved the version by the end of the wait (default 0: ask once)
//
// Needs the AMO API key that web-ext sign takes: WEB_EXT_API_KEY and WEB_EXT_API_SECRET.
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const ADDON_ID = "shisu-ko@multysquid.github.io";
export const API = "https://addons.mozilla.org/api/v5/";
export const PENDING_EXIT = 3;
const POLL_MS = 30_000;
const VERSION_RE = /^\d+(\.\d+){1,3}$/;
const FILE_NAME_RE = /^[A-Za-z0-9._-]+\.xpi$/;

// AMO's API key is a JWT issuer and secret: every request carries a fresh HS256 token that
// lives a minute (AMO refuses one that lives longer than five).
export function jwt(key, secret, now = Date.now()) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const iat = Math.floor(now / 1000);
  const unsigned = `${part({ alg: "HS256", typ: "JWT" })}.${part({ iss: key, jti: randomUUID(), iat, exp: iat + 60 })}`;
  return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
}

export function versionUrl(version) {
  const plain = String(version).replace(/^v/, "");
  if (!VERSION_RE.test(plain)) throw new Error(`not a version number: ${version}`);
  return `${API}addons/addon/${encodeURIComponent(ADDON_ID)}/versions/${plain}/`;
}

export function stateOf(detail) {
  if (!detail) return "missing";
  const status = detail.file?.status;
  if (!status || status === "unreviewed") return "pending";
  return status;
}

// The token goes with the download, so the file is only ever fetched from AMO itself.
export function downloadTarget(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "addons.mozilla.org") {
    throw new Error(`refusing to download the signed file from ${parsed.origin}`);
  }
  const name = decodeURIComponent(parsed.pathname.split("/").pop() || "");
  if (!FILE_NAME_RE.test(name)) throw new Error(`unexpected file name in ${url}`);
  return { url: parsed.href, name };
}

function parseArgs(argv) {
  const [command, version, ...rest] = argv;
  const opts = { command, version, out: join("dist", "signed"), wait: 0 };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--out") opts.out = rest[++i];
    else if (rest[i] === "--wait") opts.wait = Number(rest[++i]);
    else throw new Error(`unknown argument: ${rest[i]}`);
  }
  if (!["status", "fetch"].includes(command) || !version || !opts.out || !(opts.wait >= 0)) {
    throw new Error("usage: amo-xpi.mjs status <version> | fetch <version> [--out <dir>] [--wait <seconds>]");
  }
  return opts;
}

export async function run(argv, {
  env = process.env,
  fetch = globalThis.fetch,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  now = Date.now,
  log = console.log,
  warn = console.error,
} = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
    versionUrl(opts.version);
  } catch (err) {
    warn(err.message);
    return 2;
  }
  const { WEB_EXT_API_KEY: key, WEB_EXT_API_SECRET: secret } = env;
  if (!key || !secret) {
    warn("WEB_EXT_API_KEY and WEB_EXT_API_SECRET are not set");
    return 2;
  }
  const headers = () => ({ Authorization: `JWT ${jwt(key, secret, now())}`, Accept: "application/json" });

  const detail = async () => {
    const response = await fetch(versionUrl(opts.version), { headers: headers() });
    if (response.status === 404) return null;
    if (!response.ok) {
      const text = (await response.text()).slice(0, 300);
      throw new Error(`AMO answered ${response.status} for ${opts.version}: ${text}`);
    }
    return response.json();
  };

  try {
    if (opts.command === "status") {
      log(stateOf(await detail()));
      return 0;
    }
    const deadline = now() + opts.wait * 1000;
    for (;;) {
      const info = await detail();
      const state = stateOf(info);
      if (state === "public") {
        const { url, name } = downloadTarget(info.file.url);
        const response = await fetch(url, { headers: headers() });
        if (!response.ok) throw new Error(`downloading ${name} failed: ${response.status}`);
        await mkdir(opts.out, { recursive: true });
        const path = join(opts.out, name);
        await writeFile(path, Buffer.from(await response.arrayBuffer()));
        log(path);
        return 0;
      }
      if (state !== "pending") {
        warn(`AMO has no signed file for ${opts.version}: ${state}`);
        return 1;
      }
      if (now() >= deadline) {
        warn(`AMO has not approved ${opts.version} yet`);
        return PENDING_EXIT;
      }
      await sleep(Math.min(POLL_MS, Math.max(0, deadline - now())));
    }
  } catch (err) {
    warn(err.message);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  process.exitCode = await run(process.argv.slice(2));
}

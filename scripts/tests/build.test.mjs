import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const dist = join(root, "dist");
const version = JSON.parse(readFileSync(join(root, "addon/manifest.json"))).version;
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assertZipIntegrity(path) {
  const zip = readFileSync(path);
  const end = zip.lastIndexOf(Buffer.from("PK\x05\x06"));
  assert.ok(end >= 0, `${path} has an end record`);
  const count = zip.readUInt16LE(end + 10);
  let cursor = zip.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(cursor), 0x02014b50);
    const size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString();
    const local = zip.readUInt32LE(cursor + 42);
    const localNameLength = zip.readUInt16LE(local + 26);
    const localExtraLength = zip.readUInt16LE(local + 28);
    const data = zip.subarray(local + 30 + localNameLength + localExtraLength, local + 30 + localNameLength + localExtraLength + size);
    assert.equal(crc32(data), zip.readUInt32LE(cursor + 16), `${path}:${name}`);
    assert.ok(!name.startsWith(".") && !name.includes("/tests/"));
    cursor += 46 + nameLength + extraLength + zip.readUInt16LE(cursor + 32);
  }
}

test("build emits Firefox and Chrome packages from the same version", () => {
  return import("../build.mjs").then(() => {
  const firefox = JSON.parse(readFileSync(join(dist, "firefox/manifest.json")));
  const chrome = JSON.parse(readFileSync(join(dist, "chrome/manifest.json")));
  assert.equal(firefox.version, chrome.version);
  assert.ok(firefox.browser_specific_settings.gecko);
  assert.deepEqual(firefox.background.scripts, ["browser-api.js", "settings.js", "match.js", "words.js", "background.js"]);
  assert.equal(chrome.background.service_worker, "service-worker.js");
  assert.equal(chrome.minimum_chrome_version, "120");
  assert.equal(chrome.browser_specific_settings, undefined);
  const server = readFileSync(join(root, "server/server.py"), "utf8");
  assert.equal(server.match(/^VERSION = "([^"]+)"/m)?.[1], firefox.version);
  assert.equal(chrome.icons["128"], "icons/icon-128.png");
  for (const path of Object.values(chrome.icons)) assert.ok(existsSync(join(dist, "chrome", path)));
  for (const path of ["background.js", "browser-api.js", "content.js", "match.js", "words.js", "settings.js", "popup.html", "icons/icon.svg"]) {
    assert.deepEqual(readFileSync(join(dist, "firefox", path)), readFileSync(join(dist, "chrome", path)), path);
  }
  assert.equal(readFileSync(join(dist, "chrome/service-worker.js"), "utf8"), "importScripts(\"browser-api.js\", \"settings.js\", \"match.js\", \"words.js\", \"background.js\");\n");
  });
});

test("built trees contain no development tests", () => {
  for (const browser of ["firefox", "chrome"]) {
    assert.equal(existsSync(join(dist, browser, "tests")), false);
    assert.equal(existsSync(join(dist, browser, "package.json")), false);
    assert.ok(existsSync(join(dist, browser, "manifest.json")));
  }
  assertZipIntegrity(join(dist, `shisu-ko-${version}-firefox.zip`));
  assertZipIntegrity(join(dist, `shisu-ko-${version}-chrome.zip`));
});

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const ADDON = path.join(__dirname, "..");

function loadSchema() {
  const sandbox = {};
  vm.createContext(sandbox);
  new vm.Script(fs.readFileSync(path.join(ADDON, "settings.js"), "utf8")).runInContext(sandbox);
  new vm.Script("globalThis.schema = SHISUKO_DEFAULT_SETTINGS;").runInContext(sandbox);
  return JSON.parse(JSON.stringify(sandbox.schema));
}

test("the schema is frozen and has the expected core keys", () => {
  const schema = loadSchema();
  for (const key of ["enabled", "serverUrl", "fontScale", "pauseOnHover", "lingerSeconds", "mineTarget", "ankiUrl"]) {
    assert.ok(key in schema, `missing ${key}`);
  }
  assert.equal(schema.serverUrl, "http://127.0.0.1:8790");
});

test("popup.html has an input for every setting", () => {
  const schema = loadSchema();
  const html = fs.readFileSync(path.join(ADDON, "popup.html"), "utf8");
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const key of Object.keys(schema)) assert.ok(ids.has(key), `popup.html has no input with id="${key}"`);
});

test("settings.js is loaded before the scripts that use it", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ADDON, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.background.scripts, ["settings.js", "background.js"]);
  for (const entry of manifest.content_scripts) assert.deepEqual(entry.js, ["settings.js", "content.js"]);
  const html = fs.readFileSync(path.join(ADDON, "popup.html"), "utf8");
  assert.ok(html.indexOf('src="settings.js"') < html.indexOf('src="popup.js"'));
  for (const file of ["background.js", "content.js"]) {
    assert.ok(!/const DEFAULT_SETTINGS = (Object\.freeze\()?\{/.test(fs.readFileSync(path.join(ADDON, file), "utf8")), `${file} still defines its own defaults`);
  }
});

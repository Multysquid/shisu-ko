"use strict";

// Every setting has an input with the same id in popup.html (checked by addon/tests/settings.test.js).
const FIELDS = Object.keys(SHISUKO_DEFAULT_SETTINGS);

// Firefox MV3 treats host permissions as optional: nothing is granted at install, so the content
// script never runs until the user allows youtube.com (clicking the toolbar icon only grants the
// current tab, for that visit). The banner makes the missing grant visible and fixable.
const YOUTUBE_ORIGINS = ["*://www.youtube.com/*", "*://m.youtube.com/*", "*://youtube.com/*"];

// The server's own rule for a model name (MODEL_NAME_RE in server.py), mirrored for an early hint
// only: the server decides, and a name the rule refuses would otherwise be taken for a directory.
const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,95})?$/;
const MODEL_HINT = "Applies while a video plays. A model not downloaded yet is fetched from Hugging Face on first use (faster-whisper/CTranslate2 format only).";
const MODEL_NAME_HINT = "Use a model size such as large-v3 or a Hugging Face repo id such as owner/name";
// A model load takes seconds to minutes; while the popup is open its status line follows along.
const HEALTH_REFRESH_MS = 2000;

// The subtitle font, as content.js builds it (FONT_FAMILY_RE, SUB_FONTS, fontStack there): the
// popup cannot import the content script, so the sample keeps a copy. Keep the two in step.
const FONT_FAMILY_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.\-]{0,99}$/u;
const GOTHIC_STACK = '"Noto Sans JP", "Noto Sans CJK JP", "Yu Gothic UI", "Yu Gothic", "Meiryo", "Hiragino Sans", sans-serif';
const SUB_FONTS = {
  default: GOTHIC_STACK,
  "gothic-bold": GOTHIC_STACK,
  rounded: '"M PLUS Rounded 1c", "Hiragino Maru Gothic ProN", "Hiragino Maru Gothic Pro", "Yu Gothic UI", "Yu Gothic", sans-serif',
  mincho: '"Noto Serif JP", "Noto Serif CJK JP", "Hiragino Mincho ProN", "Hiragino Mincho Pro", "Yu Mincho", "YuMincho", serif',
};
const FONT_PROBE_TEXT = "日本語の字幕 Subtitle 123";

let saveTimer = null;
// The debounced save only remembers the last event, so a server-address or model edit leaves a
// note here that the save flushes: "server" starts the status over, "model" refreshes the hint.
let serverCheckPending = null;
let health = null; // the last /health answer, null while the server is unreachable
let healthInFlight = false;

function readField(el) {
  if (el.type === "checkbox") return el.checked;
  if (el.type === "range" || el.type === "number") return Number(el.value);
  // A colour well always reports a normalised "#rrggbb"; trimming it would be harmless but a lie.
  if (el.type === "color") return el.value;
  return el.value.trim();
}

function readForm() {
  const patch = {};
  for (const key of FIELDS) {
    const el = document.getElementById(key);
    if (el) patch[key] = readField(el);
  }
  return patch;
}

// Each range shows its value and paints the travelled part of its own track (the --fill custom
// property; see popup.css), so the slider carries the value twice: by position and by length.
const RANGES = {
  fontScale: (v) => `${Math.round(v * 100)}%`,
  lingerSeconds: (v) => `${v.toFixed(1)} s`,
  subPosition: (v) => `${v}%`,
  subBackgroundOpacity: (v) => `${v}%`,
  clipPaddingMs: (v) => `${v} ms`,
};

// "Reset style" restores these and nothing else, so a botched experiment costs one click.
const STYLE_KEYS = ["subPosition", "subFont", "subFontFamily", "subTextColor", "subBackgroundOpacity", "subOutline", "transcriptSide"];

function updateOutputs() {
  for (const [id, format] of Object.entries(RANGES)) {
    const el = document.getElementById(id);
    const value = Number(el.value);
    const min = Number(el.min);
    el.style.setProperty("--fill", `${((value - min) / (Number(el.max) - min)) * 100}%`);
    document.getElementById(`${id}Out`).textContent = format(value);
  }
  const on = document.getElementById("enabled").checked;
  document.getElementById("enabled-label").textContent = on ? "On" : "Off";
  document.body.classList.toggle("off", !on);
  renderFontSample();
}

// Only touch the DOM when the text changed: the popup repaints on every mutation, and the status
// line is refreshed every two seconds.
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function setHint(el, text, kind) {
  setText(el, text);
  const cls = kind ? `hint ${kind}` : "hint";
  if (el.className !== cls) el.className = cls;
}

// ------------------------------------------------------------------ font family

function fontFamilyName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  return FONT_FAMILY_RE.test(name) ? name : "";
}

function fontStack(subFont, subFontFamily) {
  const preset = SUB_FONTS[Object.hasOwn(SUB_FONTS, subFont) ? subFont : SHISUKO_DEFAULT_SETTINGS.subFont];
  const family = fontFamilyName(subFontFamily);
  return family ? `"${family}", ${preset}` : preset;
}

// Firefox offers no list of installed fonts, but a canvas tells whether one name resolves: text
// set in '"<family>", <generic>' measures the same as the generic alone only when the family fell
// through to it. Three generics, so a family that happens to match one still differs from another.
function fontInstalled(family) {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return true; // nothing to measure with: better no warning than a wrong one
  for (const generic of ["monospace", "serif", "sans-serif"]) {
    ctx.font = `48px ${generic}`;
    const base = ctx.measureText(FONT_PROBE_TEXT).width;
    ctx.font = `48px "${family}", ${generic}`;
    if (ctx.measureText(FONT_PROBE_TEXT).width !== base) return true;
  }
  return false;
}

// The sample shows the stack the content script will use, weight from the preset included.
function renderFontSample() {
  const preset = document.getElementById("subFont").value;
  const typed = document.getElementById("subFontFamily").value.trim();
  const family = fontFamilyName(typed);
  const sample = document.getElementById("font-sample");
  sample.style.fontFamily = fontStack(preset, family);
  sample.style.fontWeight = preset === "gothic-bold" ? "700" : "400";
  const hint = document.getElementById("font-hint");
  if (!typed) setHint(hint, "Leave empty to use the preset.", "");
  else if (!family) setHint(hint, "A font name is letters, digits, spaces, dots, hyphens and underscores; the preset is used", "warn");
  else if (fontInstalled(family)) setHint(hint, `${family} is installed on this computer`, "");
  else setHint(hint, `${family} was not found on this computer; the preset is used`, "warn");
}

// ------------------------------------------------------------------ model

function modelNameOk(name) {
  return MODEL_NAME_RE.test(name) && !name.includes("..");
}

// The models already downloaded join the suggestions once the server has listed them.
function addModelSuggestions(names) {
  if (!Array.isArray(names)) return;
  const list = document.getElementById("model-suggestions");
  const known = new Set([...list.options].map((o) => o.value));
  for (const name of names) {
    if (typeof name !== "string" || known.has(name) || !modelNameOk(name)) continue;
    known.add(name);
    const option = document.createElement("option");
    option.value = name;
    list.appendChild(option);
  }
}

// The server's verdict on the model the field asks for (its own value, or the server's default
// while it is empty), or null. /health names the model its last failed load was for in the one
// spelling the server keeps (large-v3, whether the field said large or Systran/faster-whisper-large-v3)
// and lists the other spellings of the same weights in `names` (model_spellings() in server.py);
// the field's value must be one of them, compared exactly, since repo ids are case-sensitive. Only
// that name's verdict belongs under the field: a name the server has not judged shows the plain hint.
function modelErrorFor(value) {
  const failed = health && health.model_error;
  if (!failed || typeof failed.model !== "string" || typeof failed.error !== "string" || !failed.error) return null;
  const asked = value || (typeof health.default_model === "string" ? health.default_model.trim() : "");
  if (!asked) return null;
  const names = [failed.model, ...(Array.isArray(failed.names) ? failed.names : [])];
  return names.some((name) => typeof name === "string" && name.trim() === asked) ? failed.error : null;
}

function renderModelHint() {
  const value = document.getElementById("model").value.trim();
  const hint = document.getElementById("model-hint");
  const error = modelErrorFor(value);
  // The verdict on this very name outranks the load in progress: after a failed switch the server
  // reloads the previous model, and "Loading large-v3…" would hide why the new name was refused
  // (the badge still says a model is loading).
  if (value && !modelNameOk(value)) setHint(hint, MODEL_NAME_HINT, "warn");
  else if (error) setHint(hint, error, "error");
  else if (health && health.model_loading) setHint(hint, `Loading ${health.model_loading}…`, "");
  else setHint(hint, MODEL_HINT, "");
}

function renderModelField() {
  if (health) {
    const input = document.getElementById("model");
    if (typeof health.default_model === "string" && health.default_model) input.placeholder = `${health.default_model} (server default)`;
    addModelSuggestions(health.models);
  }
  renderModelHint();
}

function setField(el, value) {
  if (el.type === "checkbox") el.checked = !!value;
  else el.value = value === undefined || value === null ? "" : value;
}

async function resetStyle() {
  const patch = {};
  for (const key of STYLE_KEYS) {
    patch[key] = SHISUKO_DEFAULT_SETTINGS[key];
    const el = document.getElementById(key);
    if (el) setField(el, patch[key]);
  }
  updateOutputs();
  // A pending edit would otherwise land after the reset and put the old value back.
  clearTimeout(saveTimer);
  serverCheckPending = false;
  await browser.runtime.sendMessage({ type: "saveSettings", settings: patch });
}

function onChange(ev) {
  updateOutputs();
  // A new server address starts over; a new model name only needs the hint brought up to date.
  if (ev.target.id === "serverUrl") serverCheckPending = "server";
  else if (ev.target.id === "model" && serverCheckPending !== "server") serverCheckPending = "model";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const check = serverCheckPending;
    serverCheckPending = null;
    await browser.runtime.sendMessage({ type: "saveSettings", settings: readForm() });
    if (check) checkServer(check === "server");
  }, 150);
}

// The status line answers the popup's first question: can it transcribe right now? The badge word
// and its dot carry the state, the detail line the evidence (which model, which device) or the fix.
// Only the first check announces itself; the refreshes behind it change the text in place.
async function checkServer(first) {
  if (healthInFlight) return;
  const badge = document.getElementById("server-status");
  const detail = document.getElementById("server-detail");
  if (first) {
    setText(badge, "Checking server");
    badge.className = "badge";
    setText(detail, "");
  }
  healthInFlight = true;
  let res;
  try {
    res = await browser.runtime.sendMessage({ type: "api", path: "/health" }).catch(() => null);
  } finally {
    healthInFlight = false;
  }
  health = res && res.ok && res.data ? res.data : null;
  let word;
  let cls;
  let evidence;
  if (!health) {
    word = "Server offline";
    cls = "badge bad";
    evidence = "start server/run.cmd or docker/up.cmd";
  } else if (health.model_loading) {
    word = "Loading model";
    cls = "badge";
    evidence = String(health.model_loading);
  } else {
    word = "Server online";
    cls = "badge ok";
    evidence = `${health.model} · ${health.device} · ${health.compute_type}`;
  }
  setText(badge, word);
  if (badge.className !== cls) badge.className = cls;
  setText(detail, evidence);
  renderModelField();
}

// Reloading the open YouTube tabs is what actually injects the content script; a freshly granted
// permission does not reach pages that are already loaded.
async function reloadYouTubeTabs() {
  try {
    // tabs.query with a url filter needs the "tabs" permission to match against URLs.
    const tabs = await browser.tabs.query({ url: YOUTUBE_ORIGINS });
    for (const tab of tabs) await browser.tabs.reload(tab.id);
  } catch (err) {
    /* nothing to reload if the query is refused */
  }
}

async function setupPermissionBanner() {
  const banner = document.getElementById("permission-banner");
  const button = document.getElementById("grant-permission");
  try {
    if (await browser.permissions.contains({ origins: YOUTUBE_ORIGINS })) return;
    banner.classList.remove("hidden");
  } catch (err) {
    return; // no permissions API (older Firefox): leave the banner hidden
  }
  button.addEventListener("click", async () => {
    // request() must be called straight from the click handler; it needs the user gesture.
    const granted = await browser.permissions.request({ origins: YOUTUBE_ORIGINS }).catch(() => false);
    if (!granted) return;
    banner.classList.add("hidden");
    await reloadYouTubeTabs();
  });
}

async function init() {
  setupPermissionBanner();
  const settings = await browser.runtime.sendMessage({ type: "getSettings" });
  for (const key of FIELDS) {
    const el = document.getElementById(key);
    if (el) setField(el, settings[key]);
  }
  updateOutputs();
  document.getElementById("reset-style").addEventListener("click", resetStyle);
  for (const key of FIELDS) {
    const el = document.getElementById(key);
    if (!el) continue;
    // Text fields act once the edit is done (a URL, a model that would start a download); the
    // font family is the exception, it previews and applies as it is typed, like a slider.
    const live = el.type !== "text" || key === "subFontFamily";
    const eventName = live && el.tagName !== "SELECT" ? "input" : "change";
    el.addEventListener(eventName, onChange);
  }
  // The name hint answers while typing, before the change event saves anything.
  document.getElementById("model").addEventListener("input", renderModelHint);
  renderModelHint();
  checkServer(true);
  setInterval(() => checkServer(false), HEALTH_REFRESH_MS);
}

document.addEventListener("DOMContentLoaded", init);

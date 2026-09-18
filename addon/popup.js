"use strict";

// Every setting has an input with the same id in popup.html (checked by addon/tests/settings.test.js).
const FIELDS = Object.keys(SHISUKO_DEFAULT_SETTINGS);

let saveTimer = null;

function readField(el) {
  if (el.type === "checkbox") return el.checked;
  if (el.type === "range" || el.type === "number") return Number(el.value);
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

function updateOutputs() {
  const scale = Number(document.getElementById("fontScale").value);
  const linger = Number(document.getElementById("lingerSeconds").value);
  const padding = Number(document.getElementById("clipPaddingMs").value);
  document.getElementById("fontScaleOut").textContent = `${Math.round(scale * 100)}%`;
  document.getElementById("lingerOut").textContent = `${linger.toFixed(1)} s`;
  document.getElementById("clipPaddingOut").textContent = `${padding} ms`;
}

function onChange(ev) {
  updateOutputs();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await browser.runtime.sendMessage({ type: "saveSettings", settings: readForm() });
    if (ev.target.id === "serverUrl") checkServer();
  }, 150);
}

async function checkServer() {
  const el = document.getElementById("server-status");
  el.textContent = "Checking server…";
  el.className = "status";
  const res = await browser.runtime.sendMessage({ type: "api", path: "/health" }).catch(() => null);
  if (res && res.ok && res.data) {
    const d = res.data;
    el.textContent = `Server online · ${d.model} on ${d.device} (${d.compute_type})`;
    el.className = "status ok";
  } else {
    el.textContent = "Server offline. Run server/run.cmd or docker/up.cmd";
    el.className = "status bad";
  }
}

async function init() {
  const settings = await browser.runtime.sendMessage({ type: "getSettings" });
  for (const key of FIELDS) {
    const el = document.getElementById(key);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = !!settings[key];
    else el.value = settings[key] === undefined || settings[key] === null ? "" : settings[key];
  }
  updateOutputs();
  for (const key of FIELDS) {
    const el = document.getElementById(key);
    if (!el) continue;
    const eventName = el.type === "text" || el.tagName === "SELECT" ? "change" : "input";
    el.addEventListener(eventName, onChange);
  }
  checkServer();
}

document.addEventListener("DOMContentLoaded", init);

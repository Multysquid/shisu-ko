"use strict";

/*
 * Background (event page). Jobs:
 *  1. Proxy API calls from content scripts to the local Whisper server.
 *  2. Own the settings object in browser.storage.local.
 *  3. Sentence mining: fetch the audio clip for a cue from the server and attach it, together
 *     with the screenshot taken by the content script, to the newest Anki card via AnkiConnect,
 *     or save both to the Downloads folder.
 */

const DEFAULT_SETTINGS = SHISUKO_DEFAULT_SETTINGS; // from settings.js

const REQUEST_TIMEOUT_MS = 10000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getSettings() {
  const stored = await browser.storage.local.get("settings");
  return Object.assign({}, DEFAULT_SETTINGS, stored.settings || {});
}

async function saveSettings(patch) {
  const current = await getSettings();
  const next = Object.assign({}, current, patch || {});
  await browser.storage.local.set({ settings: next });
  return next;
}

function normalizeBase(url, fallback) {
  const value = String(url || fallback).trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(value) ? value : fallback;
}

// ------------------------------------------------------------------ Whisper server proxy

async function apiRequest(path, body) {
  if (typeof path !== "string" || !path.startsWith("/")) {
    return { ok: false, error: "Invalid API path" };
  }
  const settings = await getSettings();
  const base = normalizeBase(settings.serverUrl, DEFAULT_SETTINGS.serverUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const init = { method: body === undefined ? "GET" : "POST", signal: controller.signal, headers: {} };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetch(base + path, init);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (err) {
      return { ok: false, error: "Server returned a non-JSON response" };
    }
    if (!res.ok) {
      return { ok: false, error: (data && data.error) || `HTTP ${res.status}`, data };
    }
    return { ok: true, data };
  } catch (err) {
    const timedOut = err && err.name === "AbortError";
    return { ok: false, offline: true, error: timedOut ? "Server timed out" : "Server unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ mining helpers

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function fetchClip(settings, videoId, start, end) {
  const base = normalizeBase(settings.serverUrl, DEFAULT_SETTINGS.serverUrl);
  const format = settings.clipFormat === "wav" ? "wav" : "mp3";
  const url = `${base}/clip?video_id=${encodeURIComponent(videoId)}&start=${start.toFixed(3)}&end=${end.toFixed(3)}&format=${format}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      return { ok: false, error: "Whisper server unreachable" };
    }
    if (res.status === 503) {
      await sleep(1500);
      continue;
    }
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        message = (await res.json()).error || message;
      } catch (err) {
        /* keep the status text */
      }
      return { ok: false, error: message };
    }
    const mime = (res.headers.get("Content-Type") || "audio/mpeg").split(";")[0].trim();
    const buffer = await res.arrayBuffer();
    return { ok: true, base64: bytesToBase64(buffer), mime, ext: mime === "audio/wav" ? "wav" : "mp3" };
  }
  return { ok: false, error: "The server is still fetching this video's audio, try again in a moment" };
}

async function anki(url, action, params) {
  // No Content-Type header on purpose: a "simple" request needs no CORS preflight, which
  // matters for the very first requestPermission call from a not-yet-allowed origin.
  const res = await fetch(url, { method: "POST", body: JSON.stringify({ action, version: 6, params: params || {} }) });
  const data = await res.json();
  if (data && data.error) throw new Error(data.error);
  return data ? data.result : null;
}

async function addToAnki(settings, cue, image, audio) {
  const url = normalizeBase(settings.ankiUrl, DEFAULT_SETTINGS.ankiUrl);
  try {
    const perm = await anki(url, "requestPermission", {});
    if (!perm || perm.permission !== "granted") {
      return { ok: false, error: "AnkiConnect denied access. Click Yes in Anki's permission dialog, then mine again." };
    }
    const ids = await anki(url, "findNotes", { query: "added:1" });
    if (!Array.isArray(ids) || !ids.length) {
      return { ok: false, error: "No card was added today. Create the card with Yomitan first, then mine." };
    }
    const noteId = Math.max(...ids);
    const infos = await anki(url, "notesInfo", { notes: [noteId] });
    const fields = (infos && infos[0] && infos[0].fields) || {};
    const update = {};
    const missing = [];
    if (image) {
      if (settings.ankiImageField in fields) {
        await anki(url, "storeMediaFile", { filename: image.filename, data: image.base64 });
        update[settings.ankiImageField] = `<img src="${image.filename}">`;
      } else {
        missing.push(settings.ankiImageField);
      }
    }
    if (audio) {
      if (settings.ankiAudioField in fields) {
        await anki(url, "storeMediaFile", { filename: audio.filename, data: audio.base64 });
        update[settings.ankiAudioField] = `[sound:${audio.filename}]`;
      } else {
        missing.push(settings.ankiAudioField);
      }
    }
    const sentenceField = String(settings.ankiSentenceField || "").trim();
    if (sentenceField && sentenceField in fields) {
      const existing = ((fields[sentenceField] && fields[sentenceField].value) || "").trim();
      if (!existing) update[sentenceField] = cue.text;
    }
    if (!Object.keys(update).length) {
      return { ok: false, error: `The newest card has none of the fields ${missing.join(", ")}. Check the field names in the popup.` };
    }
    await anki(url, "updateNoteFields", { note: { id: noteId, fields: update } });
    let message = `Added ${Object.keys(update).join(" + ")} to the newest Anki card`;
    if (missing.length) message += ` (no field named ${missing.join(", ")})`;
    return { ok: true, target: "anki", noteId, message };
  } catch (err) {
    const network = err && err.name === "TypeError";
    return { ok: false, error: network ? "Anki is not running or AnkiConnect is not installed" : String((err && err.message) || err) };
  }
}

async function downloadFiles(image, audio) {
  const jobs = [];
  const names = [];
  if (image) {
    names.push(image.filename);
    jobs.push(browser.downloads.download({
      url: "data:image/jpeg;base64," + image.base64,
      filename: "shisu-ko-mining/" + image.filename,
      conflictAction: "uniquify",
      saveAs: false,
    }));
  }
  if (audio) {
    names.push(audio.filename);
    jobs.push(browser.downloads.download({
      url: `data:${audio.mime};base64,` + audio.base64,
      filename: "shisu-ko-mining/" + audio.filename,
      conflictAction: "uniquify",
      saveAs: false,
    }));
  }
  if (!jobs.length) return { ok: false, error: "Nothing to save" };
  try {
    await Promise.all(jobs);
    return { ok: true, target: "download", message: `Saved ${names.join(" and ")} to Downloads/shisu-ko-mining` };
  } catch (err) {
    return { ok: false, error: "Download failed: " + String((err && err.message) || err) };
  }
}

async function mineCue(msg) {
  const settings = await getSettings();
  const cue = msg && msg.cue;
  if (!cue || typeof cue.start !== "number" || typeof cue.end !== "number") {
    return { ok: false, error: "No subtitle to mine" };
  }
  const pad = Math.max(0, Number(settings.clipPaddingMs) || 0) / 1000;
  const start = Math.max(0, cue.start - pad);
  const end = Math.max(start + 0.3, cue.end + pad);
  const base = `shisuko_${msg.videoId}_${Math.round(cue.start * 1000)}`;

  const image = msg.imageDataUrl && msg.imageDataUrl.includes(",")
    ? { base64: msg.imageDataUrl.split(",")[1], filename: `${base}.jpg` }
    : null;

  const clip = await fetchClip(settings, msg.videoId, start, end);
  const audio = clip.ok ? { base64: clip.base64, filename: `${base}.${clip.ext}`, mime: clip.mime } : null;
  if (!image && !audio) {
    return { ok: false, error: clip.error || "Neither screenshot nor audio could be captured" };
  }
  const warnings = [];
  if (!audio) warnings.push(`no audio (${clip.error})`);
  if (!image) warnings.push("no screenshot (blocked for this video)");

  let result;
  if (settings.mineTarget === "anki") {
    result = await addToAnki(settings, cue, image, audio);
    if (!result.ok && settings.mineFallbackDownload) {
      const fallback = await downloadFiles(image, audio);
      if (fallback.ok) {
        fallback.message = `Anki: ${result.error} Saved to Downloads instead.`;
        fallback.warning = true;
      }
      result = fallback;
    }
  } else {
    result = await downloadFiles(image, audio);
  }
  if (result.ok && warnings.length) result.message += ` (${warnings.join("; ")})`;
  return result;
}

// ------------------------------------------------------------------ messaging

browser.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== "object") return undefined;
  switch (msg.type) {
    case "api":
      return apiRequest(msg.path, msg.body);
    case "getSettings":
      return getSettings();
    case "saveSettings":
      return saveSettings(msg.settings);
    case "mine":
      return mineCue(msg);
    default:
      return undefined;
  }
});

browser.commands.onCommand.addListener(async (name) => {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    browser.tabs.sendMessage(tab.id, { type: "command", name }).catch(() => {});
  }
});

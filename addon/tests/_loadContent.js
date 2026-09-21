"use strict";

// addon/content.js wraps everything in an IIFE and exports nothing: nothing of ours may leak into
// youtube.com's page. To reach its pure helpers the source is rewritten for the test run so that the
// same IIFE returns them, and then executed in a `vm` sandbox with the handful of browser globals it
// touches while loading. The rewrite is checked, not assumed: if the file's shape changes the
// harness throws instead of quietly testing nothing.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SETTINGS_PATH = path.join(__dirname, "..", "settings.js");
const MATCH_PATH = path.join(__dirname, "..", "match.js");
const WORDS_PATH = path.join(__dirname, "..", "words.js");
const SOURCE_PATH = path.join(__dirname, "..", "content.js");

const OPEN = "(() => {";
const CLOSE = "})();";
const EXPORTS =
  "  return { state, shouldSync, coveredEnd, findActiveCue, jumpTarget, sentenceForCue, nextSentence, rankOfCue," +
  " premineAllowed, resetPremine, getVideoIdFromUrl, mergeCues, cueById, ankiPollAllowed, currentCueForMining, liveClock, updateLiveClock, playhead, seekPlayhead, onKeyDown," +
  " modelForSync, fontStack, sync, updateStatus," +
  " renderText, refreshWordMarks, pollWordIndex, wordColoursOn, syncTick, setSubtitle, transcriptLine, mineCue };\n";

function instrument(source) {
  const open = source.indexOf(OPEN);
  const close = source.lastIndexOf(CLOSE);
  if (open < 0 || close < open) throw new Error(`content.js no longer wraps its body in ${OPEN} ... ${CLOSE}`);
  return (
    source.slice(0, open) +
    "globalThis.__shisukoExports = " +
    source.slice(open, close) +
    EXPORTS +
    source.slice(close)
  );
}

// words.js declares its export with `const`, which a vm script keeps in the context's lexical
// scope, out of the sandbox's reach. Declared with `var` it is a property of the sandbox
// (`sandbox.SHISUKO_WORDS`), so a test can put a counting wrapper in its place and see how often
// content.js asks the matcher; content.js reads the global at every call, never a copy of it.
const WORDS_DECLARATION = "const SHISUKO_WORDS = ";

function writableWords(source) {
  const at = source.indexOf(WORDS_DECLARATION);
  if (at < 0 || (at > 0 && source[at - 1] !== "\n")) throw new Error(`words.js no longer declares its export as \`${WORDS_DECLARATION.trim()}\``);
  return source.slice(0, at) + "var " + source.slice(at + "const ".length);
}

// Enough of a DOM node for what content.js builds: a class list, a data set, and children that
// the text content is read from and written to (a written text is one text node, like the DOM's).
// A fragment appended or put in place of the children hands its own children over and empties.
function textNode(text) {
  return { nodeType: 3, textContent: String(text) };
}

function adopt(parent, node) {
  if (node.nodeType === 11) {
    parent.childNodes.push(...node.childNodes);
    node.childNodes.length = 0;
  } else {
    parent.childNodes.push(node);
  }
}

function stubNode(nodeType, tag) {
  const classes = new Set();
  const el = {
    nodeType,
    tagName: tag,
    className: "",
    dataset: {},
    style: { setProperty: () => {} },
    childNodes: [],
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    setAttribute: () => {},
    addEventListener: () => {},
    appendChild: (node) => {
      adopt(el, node);
      return node;
    },
    replaceChildren: (...nodes) => {
      el.childNodes.length = 0;
      for (const node of nodes) adopt(el, node);
    },
  };
  Object.defineProperty(el, "textContent", {
    get: () => el.childNodes.map((node) => node.textContent).join(""),
    set: (text) => el.replaceChildren(...(text === "" ? [] : [textNode(text)])),
  });
  return el;
}

function stubElement(tag) {
  return stubNode(1, String(tag || "div").toUpperCase());
}

function loadContent(overrides = {}) {
  const sent = [];
  const storageListeners = []; // what content.js registered on browser.storage.onChanged
  const sandbox = {
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    URL,
    Map,
    Set,
    Date,
    Promise,
    window: { addEventListener: () => {}, removeEventListener: () => {} },
    location: { href: overrides.href || "https://www.youtube.com/watch?v=abcdef1234" },
    document: {
      documentElement: stubElement(),
      visibilityState: "visible",
      querySelector: () => null,
      addEventListener: () => {},
      createElement: (tag) => stubElement(tag),
      createTextNode: (text) => textNode(text),
      createDocumentFragment: () => stubNode(11, "#document-fragment"),
    },
    browser: {
      runtime: {
        id: "shisu-ko@test",
        onMessage: { addListener: () => {} },
        sendMessage: async (msg) => {
          sent.push(msg);
          return msg.type === "getSettings" ? {} : { ok: true };
        },
      },
      storage: { onChanged: { addListener: (fn) => storageListeners.push(fn) } },
    },
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  new vm.Script(fs.readFileSync(SETTINGS_PATH, "utf8"), { filename: SETTINGS_PATH }).runInContext(sandbox);
  new vm.Script(fs.readFileSync(MATCH_PATH, "utf8"), { filename: MATCH_PATH }).runInContext(sandbox);
  new vm.Script(writableWords(fs.readFileSync(WORDS_PATH, "utf8")), { filename: WORDS_PATH }).runInContext(sandbox);
  new vm.Script(instrument(fs.readFileSync(SOURCE_PATH, "utf8")), { filename: SOURCE_PATH }).runInContext(sandbox);

  const api = sandbox.__shisukoExports;
  if (!api || typeof api.shouldSync !== "function") throw new Error("content.js did not hand the test harness its helpers");
  if (storageListeners.length !== 1) throw new Error(`content.js registered ${storageListeners.length} storage listeners, expected one`);
  return { api, sandbox, sent, onSettingsChanged: storageListeners[0] };
}

module.exports = { loadContent };

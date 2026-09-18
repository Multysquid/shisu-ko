"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const match = require("../match");

const { normalize, similarity, matchCue, MIN_SIMILARITY } = match;

// ------------------------------------------------------------------ normalize

test("normalize strips the markup Yomitan puts around the looked-up word", () => {
  assert.equal(normalize("これは<b>猫</b>です。"), "これは猫です");
  assert.equal(normalize('<span class="x">猫</span>'), "猫");
});

test("normalize decodes the entities a card can carry", () => {
  assert.equal(normalize("a&nbsp;b&amp;c"), "ab&c");
  assert.equal(normalize("&lt;tag&gt; &quot;q&quot; &#39;s&#39;"), "<tag>qs");
});

test("normalize drops bracket furigana, whitespace and punctuation", () => {
  assert.equal(normalize(" 食[た]べる"), "食べる");
  assert.equal(normalize("「はい」、そうです！"), "はいそうです");
  assert.equal(normalize("Look at the cat."), "Lookatthecat");
  assert.equal(normalize(null), "");
  assert.equal(normalize(undefined), "");
});

// ------------------------------------------------------------------ similarity

test("similarity is 1 when either text contains the other", () => {
  assert.equal(similarity("これは猫です。", "これは<b>猫</b>です。とても可愛い。"), 1);
  assert.equal(similarity("これは猫です。とても可愛い。", "これは猫です"), 1);
  // Six normalised characters is enough on its own, whatever the other text's length.
  assert.equal(similarity("これは猫です", "これは猫です、とても可愛い、ずっと見ていられる。"), 1);
});

test("similarity ignores a scrap of text swallowed by a long sentence", () => {
  // "ですね" is inside almost any Japanese sentence; containment must not make it a match.
  assert.equal(similarity("今日はとてもいい天気ですね", "ですね"), 0);
  assert.equal(similarity("はい", "はい、そうですね、わかりました。"), 0);
  // Short against short is still a match: a card made from a short line carries that short line.
  assert.equal(similarity("ですね。", "ですね"), 1);
  assert.equal(similarity("そうですね", "そうですね。ええ"), 1);
});

test("similarity stays high across a one character difference", () => {
  const value = similarity("今日はとてもいい天気ですね", "今日はとてもいい天気ですよ");
  assert.ok(value > 0.9, String(value));
  assert.ok(value >= MIN_SIMILARITY);
});

test("similarity refuses two sentences that merely end the same way", () => {
  // Dividing the shared bigrams by the smaller set alone would score this 0.6 and let the guard
  // write into a card about something else; both sentences end in 字幕です and share nothing more.
  const value = similarity("別の字幕です", "これはテスト字幕です");
  assert.ok(value < MIN_SIMILARITY, String(value));
});

test("similarity is low for two unrelated Japanese sentences", () => {
  const value = similarity("今日はとてもいい天気ですね", "猫が窓から外を見ている");
  assert.ok(value < MIN_SIMILARITY, String(value));
});

test("similarity refuses to judge strings too short to carry bigrams", () => {
  assert.equal(similarity("猫", "犬"), 0);
  assert.equal(similarity("", "これは猫です"), 0);
  assert.equal(similarity("これは猫です", ""), 0);
});

// ------------------------------------------------------------------ matchCue

const CUES = [
  { id: 0, start: 0, text: "おはようございます" },
  { id: 1, start: 5, text: "これは猫です" },
  { id: 2, start: 9, text: "とても可愛いですね" },
];

test("matchCue finds the cue a card's sentence came from", () => {
  const cue = matchCue(CUES, { sentence: "これは<b>猫</b>です。", word: "猫" }, {});
  assert.equal(cue.id, 1);
});

test("matchCue breaks a tie by rank, then by distance from the playhead", () => {
  const twins = [
    { id: 0, start: 10, text: "これは猫です" },
    { id: 1, start: 40, text: "これは猫です" },
  ];
  const note = { sentence: "これは猫です。", word: "" };
  // Nothing to tell them apart but the playhead.
  assert.equal(matchCue(twins, note, { t: 38 }).id, 1);
  assert.equal(matchCue(twins, note, { t: 12 }).id, 0);
  // A pre-mined sentence wins even when the playhead has moved past it.
  assert.equal(matchCue(twins, note, { t: 38, rank: (c) => (c.id === 0 ? 0 : Infinity) }).id, 0);
});

test("matchCue lets the word decide between two sentences that both pass", () => {
  const cues = [
    { id: 0, start: 0, text: "今日はとてもいい天気でした" },
    { id: 1, start: 4, text: "今日はとてもいい天気ですよ猫" },
  ];
  const sentence = "今日はとてもいい天気ですね";
  // On the sentence alone cue 1 is the better match.
  assert.equal(matchCue(cues, { sentence, word: "" }, {}).id, 1);
  // The card's word only appears in cue 0, and that is worth more than the bigram edge.
  assert.equal(matchCue(cues, { sentence, word: "でした" }, {}).id, 0);
});

test("matchCue falls back to the word alone when the card has no sentence", () => {
  const cues = [
    { id: 0, start: 0, text: "猫が好きです" },
    { id: 1, start: 5, text: "黒い猫だ" },
  ];
  assert.equal(matchCue(cues, { sentence: "", word: "猫" }, { rank: (c) => (c.id === 1 ? 0 : Infinity) }).id, 1);
  assert.equal(matchCue(cues, { sentence: "", word: "犬" }, {}), null);
});

test("matchCue refuses a sentence below the threshold even when the word matches", () => {
  assert.equal(matchCue(CUES, { sentence: "まったく別の文です。", word: "猫" }, {}), null);
});

// A card's sentence is long; one cue in the list is the line it came from and another is a scrap
// of filler that any long sentence contains.
const LONG_SENTENCE = "昨日の夜は遅くまで起きていましたね";
const WITH_SCRAP = [
  { id: 0, start: 100, text: "ですね" },
  { id: 1, start: 200, text: "昨日の夜は遅くまで起きていましたね" },
];

test("matchCue ignores a cue too short to be what the card is about", () => {
  // Even ranked first, and even sitting at the playhead, the scrap is not a candidate.
  const cue = matchCue(WITH_SCRAP, { sentence: LONG_SENTENCE, word: "" }, { t: 100, rank: (c) => (c.id === 0 ? 0 : 1) });
  assert.equal(cue.id, 1);
});

test("matchCue attaches nothing when only the scrap is on the list", () => {
  assert.equal(matchCue([WITH_SCRAP[0]], { sentence: LONG_SENTENCE, word: "" }, {}), null);
});

test("matchCue prefers the cue that explains more of the card's sentence", () => {
  const cues = [
    { id: 0, start: 10, text: "昨日の夜は遅くまで" }, // a real prefix: contained, but half the card
    { id: 1, start: 20, text: "昨日の夜は遅くまで起きていましたね" },
  ];
  const note = { sentence: LONG_SENTENCE, word: "" };
  // Both score 1 on containment; the whole line wins over its own fragment, rank notwithstanding.
  assert.equal(matchCue(cues, note, { rank: (c) => (c.id === 0 ? 0 : 1) }).id, 1);
});

test("matchCue still matches a long cue inside a longer typed sentence", () => {
  const cues = [{ id: 0, start: 5, text: "夜は遅くまで起きて" }];
  const typed = "昨日の夜は遅くまで起きていましたね、本当に眠いです";
  assert.equal(matchCue(cues, { sentence: typed, word: "" }, {}).id, 0);
});

test("matchCue returns null when there is nothing to match on", () => {
  assert.equal(matchCue(CUES, { sentence: "", word: "" }, {}), null);
  assert.equal(matchCue(CUES, {}, {}), null);
  assert.equal(matchCue([], { sentence: "これは猫です" }, {}), null);
  assert.equal(matchCue(null, { sentence: "これは猫です" }, {}), null);
});

test("matchCue stays quick on a full length transcript", () => {
  const cues = [];
  for (let i = 0; i < 5000; i++) cues.push({ id: i, start: i * 3, text: `${i}番目の文です` });
  cues.push({ id: 5000, start: 15000, text: "これは猫です" });
  const started = Date.now();
  const cue = matchCue(cues, { sentence: "これは<b>猫</b>です。", word: "猫" }, { t: 0 });
  assert.equal(cue.id, 5000);
  assert.ok(Date.now() - started < 1000, "matching a whole transcript must not take a second");
});

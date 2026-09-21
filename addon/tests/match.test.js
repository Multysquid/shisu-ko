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
  assert.equal(normalize("はい．そうです．"), "はいそうです");
  assert.equal(normalize(null), "");
  assert.equal(normalize(undefined), "");
});

test("normalize drops the readings of HTML ruby, as {sentence-furigana} and {furigana} write them", () => {
  // Yomitan's ruby markers write <ruby>食<rt>た</rt></ruby>; only the -plain ones write brackets.
  // Stripping the tags alone would weave every reading into the kanji (今日きょうは学校がっこうで).
  const ruby =
    "<ruby>今日<rt>きょう</rt></ruby>は<ruby>学校<rt>がっこう</rt></ruby>で<ruby>友達<rt>ともだち</rt></ruby>と" +
    "<b><ruby>勉強<rt>べんきょう</rt></ruby></b>した";
  assert.equal(normalize(ruby), "今日は学校で友達と勉強した");
  assert.equal(normalize('<ruby>食<rp>(</rp><rt class="r">た</rt><rp>)</rp></ruby>べる'), "食べる");
  // The end tag of <rt> may be left out before </ruby>.
  assert.equal(normalize("<ruby>食<rt>た</ruby>べる"), "食べる");
  assert.equal(normalize("<RUBY>食<RT>た</RT></RUBY>べる"), "食べる");
});

test("a card written with ruby furigana matches its line and earns the word bonus", () => {
  const sentence = "<ruby>今日<rt>きょう</rt></ruby>は<ruby>学校<rt>がっこう</rt></ruby>で<b><ruby>勉強<rt>べんきょう</rt></ruby></b>した";
  const cues = [
    { id: 0, start: 0, text: "今日は学校で勉強した" },
    { id: 1, start: 5, text: "猫が窓から外を見ている" },
  ];
  assert.equal(similarity(sentence, cues[0].text), 1);
  assert.equal(matchCue(cues, { sentence, word: "<ruby>勉強<rt>べんきょう</rt></ruby>" }, {}).id, 0);
  // A card with no sentence matches on a ruby word alone.
  assert.equal(matchCue([{ id: 2, start: 9, text: "ご飯を食べる" }], { sentence: "", word: "<ruby>食<rt>た</rt></ruby>べる" }, {}).id, 2);
});

// ------------------------------------------------------------------ similarity

test("similarity is 1 when either text contains the other", () => {
  assert.equal(similarity("これは猫です。", "これは<b>猫</b>です。とても可愛い。"), 1);
  assert.equal(similarity("これは猫です。とても可愛い。", "これは猫です"), 1);
  // Six normalised characters is enough on its own, whatever the other text's length.
  assert.equal(similarity("これは猫です", "これは猫です、とても可愛い、ずっと見ていられる。"), 1);
});

test("similarity ignores a scrap of a line swallowed by a long card sentence", () => {
  // "ですね" is inside almost any Japanese sentence; a cue saying only that must not match a card
  // whose sentence merely holds it.
  assert.equal(similarity("今日はとてもいい天気ですね", "ですね"), 0);
  assert.equal(similarity("はい、そうですね、わかりました。", "はい"), 0);
  // Short against short is still a match: a card made from a short line carries that short line.
  assert.equal(similarity("ですね。", "ですね"), 1);
  assert.equal(similarity("そうですね", "そうですね。ええ"), 1);
});

test("similarity accepts a short card sentence that a longer line said", () => {
  // The other way round the bar does not apply: Yomitan stops its sentence at 。, and the server
  // merges a short cue into its neighbour, so the card made from this line reads 嘘でしょ。 and
  // the background guard must let the matcher's pick through.
  assert.equal(similarity("<b>嘘</b>でしょ。", "嘘でしょ。本当にそんなことがあったの"), 1);
  assert.equal(similarity("はい", "はい、そうですね、わかりました。"), 1);
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

// The server merges a cue shorter than --min-cue-seconds into its neighbour, and Yomitan cuts its
// sentence at 。！？: the card made from the merged line carries only its first few characters.
const MERGED = [
  { id: 0, start: 0, text: "おはようございます" },
  { id: 1, start: 4, text: "嘘でしょ。本当にそんなことがあったの" },
  { id: 2, start: 9, text: "分かった。じゃあ明日また来るね" },
  { id: 3, start: 14, text: "駄目だ。もう二度と会わない" },
  { id: 4, start: 19, text: "行こう。時間がないんだ" },
];

test("matchCue finds the merged line a short Yomitan sentence was cut from", () => {
  assert.equal(matchCue(MERGED, { sentence: "<b>嘘</b>でしょ。", word: "嘘" }, {}).id, 1);
  assert.equal(matchCue(MERGED, { sentence: "分かった。", word: "分かる" }, {}).id, 2);
  assert.equal(matchCue(MERGED, { sentence: "駄目だ。", word: "駄目" }, {}).id, 3);
  // The word is the dictionary form and appears nowhere; the sentence alone has to do.
  assert.equal(matchCue(MERGED, { sentence: "行こう。", word: "行く" }, {}).id, 4);
  assert.equal(matchCue(MERGED, { sentence: "行こう。", word: "" }, {}).id, 4);
});

test("matchCue still refuses a short sentence that no line said", () => {
  assert.equal(matchCue(MERGED, { sentence: "嘘だよ。", word: "嘘" }, {}), null);
});

test("matchCue lets rank decide between a line that is the short sentence and one that runs past it", () => {
  const cues = [
    { id: 0, start: 100, text: "嘘でしょ" },
    { id: 1, start: 400, text: "嘘でしょ。本当にそんなことがあったの" },
  ];
  const note = { sentence: "<b>嘘</b>でしょ。", word: "嘘" };
  // Both lines said the whole sentence; the one the viewer just read wins, wherever the playhead is.
  assert.equal(matchCue(cues, note, { t: 100, rank: (c) => (c.id === 1 ? 0 : Infinity) }).id, 1);
  assert.equal(matchCue(cues, note, { t: 400, rank: (c) => (c.id === 0 ? 0 : Infinity) }).id, 0);
  // Nothing pre-mined: the playhead decides.
  assert.equal(matchCue(cues, note, { t: 390 }).id, 1);
  assert.equal(matchCue(cues, note, { t: 110 }).id, 0);
});

test("matchCue gives a card cut from the transcript its own line, not the playing line that holds its words", () => {
  // The viewer at 10:00 scans はい in the transcript's line at 40:00 while the line playing, which
  // was pre-mined as every playing line is, holds はい too, mid-clause. Yomitan cuts its sentence
  // at 。！？, never at 、, so no card reading はい was made from はい、そうですね: the exact line
  // wins, whatever the rank and the playhead say.
  const cues = [
    { id: 1, start: 598, text: "はい、そうですね" },
    { id: 2, start: 602, text: "はいはい、わかりました" },
    { id: 3, start: 2400, text: "はい" },
  ];
  const note = { sentence: "はい", word: "はい" };
  assert.equal(matchCue(cues, note, { t: 600 }).id, 3);
  assert.equal(matchCue(cues, note, { t: 600, rank: (c) => (c.id === 1 ? 0 : Infinity) }).id, 3);
  const longer = [
    { id: 1, start: 598, text: "本当にそうですね、そう思いますよ" },
    { id: 3, start: 2400, text: "本当にそうですね" },
  ];
  const rank = (c) => (c.id === 1 ? 0 : Infinity);
  assert.equal(matchCue(longer, { sentence: "本当にそうですね", word: "" }, { t: 600, rank }).id, 3);
  // Nothing else said it: the line holding the words mid-clause is still the match.
  assert.equal(matchCue(cues.slice(0, 2), note, { t: 600 }).id, 1);
});

test("matchCue treats a quote as an end of the sentence, as Yomitan does", () => {
  // A word looked up inside 「」 gets the quoted words as its sentence, so the quoting line said
  // the sentence whole and rank decides, as between a line that is the sentence and one that runs
  // past it at 。.
  const cues = [
    { id: 0, start: 100, text: "はい" },
    { id: 1, start: 400, text: "彼は「はい」と答えた" },
  ];
  const note = { sentence: "はい", word: "はい" };
  assert.equal(matchCue(cues, note, { t: 100, rank: (c) => (c.id === 1 ? 0 : Infinity) }).id, 1);
  assert.equal(matchCue(cues, note, { t: 400, rank: (c) => (c.id === 0 ? 0 : Infinity) }).id, 0);
  assert.equal(matchCue(cues, note, { t: 390 }).id, 1);
  // The word outside the quotes: the sentence runs from 。 to 。 across them.
  const quoting = [
    { id: 0, start: 100, text: "彼は「はい」と答えた" },
    { id: 1, start: 400, text: "そうか。彼は「はい」と答えた。" },
  ];
  const outside = { sentence: "彼は「はい」と<b>答えた</b>。", word: "答える" };
  assert.equal(matchCue(quoting, outside, { t: 100, rank: (c) => (c.id === 1 ? 0 : Infinity) }).id, 1);
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

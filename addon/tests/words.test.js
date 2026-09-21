"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const words = require("../words");

const {
  STATUSES,
  PITCHES,
  plainText,
  plainWord,
  isKana,
  isHiragana,
  isKatakana,
  hasKanjiOrKatakana,
  moraCount,
  readingOf,
  parsePitch,
  pitchOf,
  statusOf,
  mergeStatus,
  buildIndex,
  wordStarts,
  markWords,
} = words;

// Yomitan's {pitch-accents} text format marks the drop with U+A71C.
const DROP = "ꜜ";

// The runs of markWords as one line: a matched run carries (status,pitch) after its text.
function shape(runs) {
  return runs.map((run) => run.text + (run.status || run.pitch ? `(${run.status},${run.pitch})` : "")).join(" | ");
}

function mark(text, entries, starts) {
  return shape(markWords(text, buildIndex(entries), starts));
}

// ------------------------------------------------------------------ constants

test("the object is frozen and lists the four statuses and four patterns", () => {
  assert.ok(Object.isFrozen(words));
  assert.deepEqual(STATUSES, ["new", "learning", "learned", "suspended"]);
  assert.deepEqual(PITCHES, ["heiban", "atamadaka", "nakadaka", "odaka"]);
});

// ------------------------------------------------------------------ plainText / plainWord

test("plainText drops ruby readings with their text and every other tag", () => {
  assert.equal(plainText("<ruby>食<rt>た</rt></ruby>べる"), "食べる");
  assert.equal(plainText("<ruby>食<rp>(</rp><rt>た</rt><rp>)</rp></ruby>べる"), "食べる");
  assert.equal(plainText("<RUBY>食<RT>た</RT></RUBY>べる"), "食べる");
  assert.equal(plainText("これは<b>猫</b>です。"), "これは猫です。");
  assert.equal(plainText('<span class="x">猫</span>'), "猫");
});

test("plainText decodes entities, collapses whitespace and trims", () => {
  assert.equal(plainText("a&nbsp;b&amp;c"), "a b&c");
  assert.equal(plainText("&lt;tag&gt; &quot;q&quot; &#39;s&#39;"), "<tag> \"q\" 's'");
  assert.equal(plainText("  猫 \n\t 犬  "), "猫 犬");
  assert.equal(plainText(null), "");
  assert.equal(plainText(undefined), "");
  assert.equal(plainText(""), "");
});

test("plainWord drops bracket furigana and keeps the kanji", () => {
  assert.equal(plainWord(" 食[た]べる"), "食べる");
  assert.equal(plainWord("お 茶[ちゃ]"), "お茶");
  assert.equal(plainWord(" 日本語[にほんご]"), "日本語");
  assert.equal(plainWord("<ruby>食<rt>た</rt></ruby>べる"), "食べる");
  assert.equal(plainWord("<b>猫</b>"), "猫");
});

test("plainWord takes the first line only and is empty when nothing is left", () => {
  assert.equal(plainWord("猫<br>ねこ"), "猫");
  assert.equal(plainWord("<div>猫</div><div>ねこ</div>"), "猫");
  assert.equal(plainWord("<br>猫"), "猫");
  assert.equal(plainWord(""), "");
  assert.equal(plainWord("<b></b>"), "");
  assert.equal(plainWord(null), "");
});

// ------------------------------------------------------------------ characters

test("the character classes tell hiragana, katakana and kanji apart", () => {
  assert.ok(isHiragana("あ"));
  assert.ok(!isHiragana("ア"));
  assert.ok(isKatakana("ア"));
  assert.ok(isKatakana("ｶ"));
  assert.ok(!isKatakana("あ"));
  assert.ok(isKana("ん") && isKana("ッ"));
  assert.ok(!isKana("漢") && !isKana("a") && !isKana("ー"));
  assert.ok(hasKanjiOrKatakana("食べる"));
  assert.ok(hasKanjiOrKatakana("コーヒー"));
  assert.ok(hasKanjiOrKatakana("人々"));
  assert.ok(!hasKanjiOrKatakana("たべる"));
  assert.ok(!hasKanjiOrKatakana("らーめん"));
  assert.ok(!hasKanjiOrKatakana(""));
  assert.ok(!hasKanjiOrKatakana(null));
});

test("moraCount counts kana, folds the small ones and gives ー a mora", () => {
  assert.equal(moraCount("きょうと"), 3);
  assert.equal(moraCount("トーキョー"), 4);
  assert.equal(moraCount("はし"), 2);
  assert.equal(moraCount("がっこう"), 4);
  assert.equal(moraCount("ふぁ"), 1);
  assert.equal(moraCount("abc"), 0);
  assert.equal(moraCount("漢字"), 0);
  assert.equal(moraCount(""), 0);
  assert.equal(moraCount(null), 0);
});

// ------------------------------------------------------------------ readingOf

test("readingOf takes the ruby text, the bracket furigana or the kana field", () => {
  assert.equal(readingOf("<ruby>食<rt>た</rt></ruby>べる"), "たべる");
  assert.equal(readingOf("<ruby>食<rp>(</rp><rt>た</rt><rp>)</rp></ruby>べる"), "たべる");
  assert.equal(readingOf("<ruby>日本<rt>にほん</rt></ruby><ruby>語<rt>ご</rt></ruby>"), "にほんご");
  assert.equal(readingOf(" 食[た]べる"), "たべる");
  assert.equal(readingOf("お 茶[ちゃ]"), "おちゃ");
  assert.equal(readingOf("たべる"), "たべる");
  assert.equal(readingOf("<b>コーヒー</b>"), "コーヒー");
});

test("readingOf is empty unless what is left is kana", () => {
  assert.equal(readingOf("食べる"), "");
  assert.equal(readingOf("taberu"), "");
  assert.equal(readingOf(""), "");
  assert.equal(readingOf(null), "");
});

// ------------------------------------------------------------------ parsePitch

test("parsePitch reads a category name, the first one by position", () => {
  assert.equal(parsePitch("heiban"), "heiban");
  assert.equal(parsePitch("heiban, odaka"), "heiban");
  assert.equal(parsePitch("odaka, heiban"), "odaka");
  assert.equal(parsePitch("Atamadaka"), "atamadaka");
  assert.equal(parsePitch("<b>Nakadaka</b>"), "nakadaka");
  assert.equal(parsePitch("頭高"), "atamadaka");
  assert.equal(parsePitch("平板"), "heiban");
  assert.equal(parsePitch("中高"), "nakadaka");
  assert.equal(parsePitch("尾高 (heiban)"), "odaka");
});

test("parsePitch reads a position in brackets, Yomitan's list included", () => {
  assert.equal(parsePitch("[0]"), "heiban");
  assert.equal(parsePitch("<ol><li>[0]</li><li>[3]</li></ol>"), "heiban");
  assert.equal(parsePitch("<ol><li>[1]</li><li>[0]</li></ol>"), "atamadaka");
  assert.equal(parsePitch("[2]", "はし", ""), "odaka");
  assert.equal(parsePitch("[2]", "さかな", ""), "nakadaka");
  assert.equal(parsePitch("[3]", "こころ", ""), "odaka");
});

test("parsePitch reads a bare number", () => {
  assert.equal(parsePitch("0"), "heiban");
  assert.equal(parsePitch(" 1 "), "atamadaka");
  assert.equal(parsePitch("2", "はし", ""), "odaka");
  assert.equal(parsePitch("2", "", "さかな"), "nakadaka");
});

test("parsePitch reads the drop mark of the text format", () => {
  assert.equal(parsePitch(`はし${DROP}`), "odaka");
  assert.equal(parsePitch(`は${DROP}し`), "atamadaka");
  assert.equal(parsePitch(`たま${DROP}ご`), "nakadaka");
  assert.equal(parsePitch(`きょ${DROP}うと`), "atamadaka");
  // No mark at all in that format is heiban.
  assert.equal(parsePitch("はし"), "heiban");
  assert.equal(parsePitch("<span>コーヒー</span>"), "heiban");
});

test("parsePitch counts the moras from the pitch text, else the reading, else the word", () => {
  // The pitch text is kana: its own count decides, whatever the reading says.
  assert.equal(parsePitch(`はし${DROP}`, "さかな", "魚"), "odaka");
  // A position alone: the reading, then the word.
  assert.equal(parsePitch("[3]", "さかな", ""), "odaka");
  assert.equal(parsePitch("[3]", "", "さかな"), "odaka");
  assert.equal(parsePitch("[3]", "魚", "魚"), "nakadaka");
  // Nothing to count: nakadaka, the more common of the two.
  assert.equal(parsePitch("[2]"), "nakadaka");
  assert.equal(parsePitch("[2]", null, undefined), "nakadaka");
  // 0 and 1 need no count.
  assert.equal(parsePitch("[0]", "", ""), "heiban");
  assert.equal(parsePitch("[1]", "", ""), "atamadaka");
});

test("parsePitch is null when the field says nothing it understands", () => {
  assert.equal(parsePitch(""), null);
  assert.equal(parsePitch(null), null);
  assert.equal(parsePitch(undefined), null);
  assert.equal(parsePitch("???"), null);
  assert.equal(parsePitch("<b></b>"), null);
  assert.equal(parsePitch("食べる"), null);
  assert.equal(parsePitch("[a]"), null);
});

// ------------------------------------------------------------------ pitchOf

function fields(list) {
  const out = {};
  list.forEach(([name, value], order) => {
    out[name] = { value, order };
  });
  return out;
}

test("pitchOf finds the pitch field by name and the reading beside it", () => {
  const note = fields([
    ["Word", "橋"],
    ["Reading", "はし"],
    ["PitchAccent", "[2]"],
  ]);
  assert.equal(pitchOf(note, {}), "odaka");
  assert.equal(pitchOf(fields([["Word", "魚"], ["Reading", "さかな"], ["Pitch Accent", "[2]"]]), {}), "nakadaka");
  assert.equal(pitchOf(fields([["Word", "橋"], ["Furigana", " 橋[はし]"], ["アクセント", "2"]]), {}), "odaka");
  assert.equal(pitchOf(fields([["Word", "橋"], ["Reading", "はし"], ["Pitch", "heiban"]]), {}), "heiban");
});

test("pitchOf prefers the field the settings name and falls back when it is missing", () => {
  const note = fields([
    ["Word", "橋"],
    ["Reading", "はし"],
    ["PitchAccent", "[0]"],
    ["Notes", "[2]"],
  ]);
  assert.equal(pitchOf(note, { ankiPitchField: "Notes" }), "odaka");
  assert.equal(pitchOf(note, { ankiPitchField: " Notes " }), "odaka");
  assert.equal(pitchOf(note, { ankiPitchField: "Missing" }), "heiban");
  assert.equal(pitchOf(note, { ankiPitchField: "" }), "heiban");
});

test("pitchOf takes the lowest-order matching field and never reads the pitch field as a reading", () => {
  const note = fields([
    ["Word", "橋"],
    ["PitchAccentReading", "[2]"],
    ["Accent", "[1]"],
    ["Reading", "はし"],
  ]);
  // Both match the pitch rule; the first by order is the pitch field, and the reading comes
  // from the field after it, not from the pitch field's own name.
  assert.equal(pitchOf(note, {}), "odaka");
  // The pitch field in first place is the note's word by the order-0 rule; "[2]" is no kana, so
  // the count is unknown.
  const pitchFirst = fields([["Pitch", "[2]"], ["Word", "橋"]]);
  assert.equal(pitchOf(pitchFirst, {}), "nakadaka");
});

test("pitchOf counts the word's moras when there is no reading", () => {
  assert.equal(pitchOf(fields([["Word", "さかな"], ["Pitch", "[3]"]]), {}), "odaka");
  assert.equal(pitchOf(fields([["Word", "魚"], ["Pitch", "[3]"]]), {}), "nakadaka");
  assert.equal(pitchOf(fields([["Word", "魚"], ["Kana", "さかな"], ["Pitch", "[3]"]]), { ankiWordField: "Kana" }), "odaka");
  assert.equal(pitchOf(fields([["Word", " 魚[さかな]"], ["Pitch", "[3]"]]), {}), "nakadaka");
});

test("pitchOf is null without a pitch field or a readable value", () => {
  assert.equal(pitchOf(fields([["Word", "橋"], ["Reading", "はし"]]), {}), null);
  assert.equal(pitchOf(fields([["Word", "橋"], ["Pitch", ""]]), {}), null);
  assert.equal(pitchOf(fields([["Word", "橋"], ["Pitch", "?"]]), {}), null);
  assert.equal(pitchOf({}, {}), null);
  assert.equal(pitchOf(null, null), null);
  assert.equal(pitchOf({ Pitch: "[0]" }, {}), null);
});

// ------------------------------------------------------------------ statusOf / mergeStatus

test("statusOf reads the five query sets in order of precedence", () => {
  const sets = {
    suspended: new Set([1]),
    unsuspended: new Set([2, 3, 4, 5]),
    new: new Set([2]),
    learning: new Set([3]),
    review: new Set([4]),
  };
  assert.equal(statusOf(sets, 1), "suspended");
  assert.equal(statusOf(sets, 2), "new");
  assert.equal(statusOf(sets, 3), "learning");
  assert.equal(statusOf(sets, 4), "learned");
  // Unsuspended but in no queue: buried in the learning queue.
  assert.equal(statusOf(sets, 5), "learning");
  // Not in the deck at all.
  assert.equal(statusOf(sets, 6), null);
  assert.equal(statusOf({}, 1), null);
  assert.equal(statusOf(null, 1), null);
});

test("statusOf lets a card that is both new and suspended count as suspended", () => {
  const sets = { suspended: new Set([1]), unsuspended: new Set(), new: new Set([1]), learning: new Set(), review: new Set() };
  assert.equal(statusOf(sets, 1), "suspended");
});

test("mergeStatus takes the least progress and keeps suspended only when both are", () => {
  assert.equal(mergeStatus(null, "learned"), "learned");
  assert.equal(mergeStatus("new", null), "new");
  assert.equal(mergeStatus(null, null), null);
  assert.equal(mergeStatus(undefined, "learning"), "learning");
  assert.equal(mergeStatus("learned", "new"), "new");
  assert.equal(mergeStatus("learning", "learned"), "learning");
  assert.equal(mergeStatus("learned", "learned"), "learned");
  assert.equal(mergeStatus("new", "learning"), "new");
  assert.equal(mergeStatus("suspended", "suspended"), "suspended");
  assert.equal(mergeStatus("suspended", "learned"), "learned");
  assert.equal(mergeStatus("new", "suspended"), "new");
  assert.equal(mergeStatus("bogus", "learned"), "learned");
});

// ------------------------------------------------------------------ buildIndex

test("buildIndex trims words, drops empty and overlong ones and merges duplicates", () => {
  const index = buildIndex([
    [" 猫 ", "learned", null],
    ["猫", "new", "heiban"],
    ["猫", "suspended", "odaka"],
    ["", "new", null],
    ["   ", "new", null],
    ["a".repeat(41), "new", null],
    ["a".repeat(40), "new", null],
    null,
    "犬",
    ["犬"],
  ]);
  assert.ok(Object.isFrozen(index));
  assert.equal(index.size, 3);
  assert.deepEqual(index.exact.get("猫"), { word: "猫", status: "new", pitch: "heiban", bounded: false });
  assert.deepEqual(index.exact.get("犬"), { word: "犬", status: null, pitch: null, bounded: false });
  assert.ok(index.exact.has("a".repeat(40)));
  assert.equal(index.maxLen, 40);
  assert.equal(buildIndex([]).size, 0);
  assert.equal(buildIndex(null).size, 0);
});

test("buildIndex ignores a status or pitch it does not know", () => {
  const index = buildIndex([["猫", "bogus", "flat"]]);
  assert.deepEqual(index.exact.get("猫"), { word: "猫", status: null, pitch: null, bounded: false });
});

test("buildIndex cuts a stem from the words with kanji or katakana only", () => {
  const index = buildIndex([
    ["勉強する", "new", null],
    ["美しい", "new", null],
    ["食べる", "new", null],
    ["書く", "new", null],
    ["サボる", "new", null],
    ["日本語", "new", null],
    ["コーヒー", "new", null],
    ["たべる", "new", null],
    ["する", "new", null],
    ["見", "new", null],
  ]);
  const kinds = (stem) => (index.stems.get(stem) || []).map((item) => `${item.entry.word}:${item.kind}`);
  assert.deepEqual(kinds("勉強"), ["勉強する:suru"]);
  assert.deepEqual(kinds("美し"), ["美しい:i-adj"]);
  assert.deepEqual(kinds("食べ"), ["食べる:ru"]);
  assert.deepEqual(kinds("書"), ["書く:く"]);
  assert.deepEqual(kinds("サボ"), ["サボる:ru"]);
  assert.equal(index.stems.size, 5);
  assert.equal(index.maxStemLen, 2);
  // Kana-only words match exactly and need a boundary after them.
  assert.equal(index.exact.get("たべる").bounded, true);
  assert.equal(index.exact.get("する").bounded, true);
  assert.equal(index.exact.get("食べる").bounded, false);
});

test("buildIndex keeps two words that share a stem", () => {
  const index = buildIndex([["帰る", "new", null], ["帰す", "learned", null]]);
  assert.deepEqual(index.stems.get("帰").map((item) => item.kind), ["ru", "す"]);
});

// ------------------------------------------------------------------ wordStarts

test("wordStarts follows the segmenter's word boundaries", () => {
  assert.deepEqual([...wordStarts("これは日本語の字幕です")].sort((a, b) => a - b), [0, 2, 3, 6, 7, 9]);
  assert.deepEqual([...wordStarts("")], [0]);
  assert.deepEqual([...wordStarts(null)], [0]);
  assert.ok(wordStarts("猫").has(0));
});

// ------------------------------------------------------------------ markWords

test("markWords marks the deck words of a line and joins the rest", () => {
  const deck = [["日本語", "learned", null], ["字幕", "new", "heiban"]];
  assert.equal(mark("これは日本語の字幕です", deck), "これは | 日本語(learned,null) | の | 字幕(new,heiban) | です");
  assert.equal(mark("これは日本語の字幕です", deck, new Set([0, 2, 3, 6, 7, 9])), "これは | 日本語(learned,null) | の | 字幕(new,heiban) | です");
  const runs = markWords("これは日本語の字幕です", buildIndex(deck));
  assert.deepEqual(runs[0], { text: "これは", status: null, pitch: null });
  assert.deepEqual(runs[1], { text: "日本語", status: "learned", pitch: null });
  assert.equal(runs.map((run) => run.text).join(""), "これは日本語の字幕です");
});

test("markWords returns one run for text without matches and none for no text", () => {
  assert.equal(mark("abc", []), "abc");
  assert.deepEqual(markWords("abc", buildIndex([])), [{ text: "abc", status: null, pitch: null }]);
  assert.deepEqual(markWords("abc", null), [{ text: "abc", status: null, pitch: null }]);
  assert.deepEqual(markWords("", buildIndex([["a", "new", null]])), []);
  assert.deepEqual(markWords(null, buildIndex([["a", "new", null]])), []);
  assert.equal(mark("猫が好き", [["犬", "new", null]]), "猫が好き");
});

test("markWords finds an ichidan verb in its conjugations, tails greedy", () => {
  const deck = [["食べる", "learned", null]];
  assert.equal(mark("食べました", deck), "食べました(learned,null)");
  assert.equal(mark("食べたことがある", deck), "食べた(learned,null) | ことがある");
  assert.equal(mark("食べる", deck), "食べる(learned,null)");
  assert.equal(mark("食べない", deck), "食べない(learned,null)");
  assert.equal(mark("食べられない", deck), "食べられない(learned,null)");
  assert.equal(mark("食べたいです", deck), "食べたいです(learned,null)");
  assert.equal(mark("食べ物", deck), "食べ物");
});

test("markWords needs the first piece: a bare stem is another word", () => {
  const deck = [["走る", "learned", null]];
  assert.equal(mark("走った", deck), "走った(learned,null)");
  assert.equal(mark("走者", deck), "走者");
  assert.equal(mark("走ります", deck), "走ります(learned,null)");
});

test("markWords finds an i-adjective in its forms", () => {
  const deck = [["美しい", "learned", null]];
  assert.equal(mark("美しかった", deck), "美しかった(learned,null)");
  assert.equal(mark("美しさ", deck), "美しさ(learned,null)");
  assert.equal(mark("美しくない", deck), "美しくない(learned,null)");
  assert.equal(mark("美しければ", deck), "美しければ(learned,null)");
  assert.equal(mark("美しい", deck), "美しい(learned,null)");
});

test("markWords follows the godan rows", () => {
  const write = [["書く", "learned", null]];
  assert.equal(mark("書かない", write), "書かない(learned,null)");
  assert.equal(mark("書いて", write), "書いて(learned,null)");
  assert.equal(mark("書店", write), "書店");
  assert.equal(mark("行った", [["行く", "learned", null]]), "行った(learned,null)");
  assert.equal(mark("泳いでいる", [["泳ぐ", "learned", null]]), "泳いでいる(learned,null)");
  assert.equal(mark("話します", [["話す", "learned", null]]), "話します(learned,null)");
  assert.equal(mark("待って", [["待つ", "learned", null]]), "待って(learned,null)");
  assert.equal(mark("死んだ", [["死ぬ", "learned", null]]), "死んだ(learned,null)");
  assert.equal(mark("遊んでいた", [["遊ぶ", "learned", null]]), "遊んでいた(learned,null)");
  assert.equal(mark("読みました", [["読む", "learned", null]]), "読みました(learned,null)");
  assert.equal(mark("会わなかった", [["会う", "learned", null]]), "会わなかった(learned,null)");
});

test("markWords takes a する verb with its endings or as the noun alone", () => {
  const deck = [["勉強する", "learned", null]];
  assert.equal(mark("勉強している", deck), "勉強している(learned,null)");
  assert.equal(mark("勉強が", deck), "勉強(learned,null) | が");
  assert.equal(mark("勉強しました", deck), "勉強しました(learned,null)");
  assert.equal(mark("勉強させられた", deck), "勉強させられた(learned,null)");
  // The noun alone takes no tails: 勉強です is 勉強 and です.
  assert.equal(mark("勉強です", deck), "勉強(learned,null) | です");
});

test("markWords finds 来る in 来なかった but not in 来週", () => {
  const deck = [["来る", "learned", null]];
  assert.equal(mark("来なかった", deck), "来なかった(learned,null)");
  assert.equal(mark("来週", deck), "来週");
});

test("markWords stops a hiragana word at a word boundary", () => {
  const deck = [["ある", "learned", null]];
  assert.equal(mark("あるいは", deck, new Set([0])), "あるいは");
  assert.equal(mark("ある。", deck, new Set([0, 2])), "ある(learned,null) | 。");
  assert.equal(mark("ある。", deck), "ある(learned,null) | 。");
  assert.equal(mark("ある", deck, new Set([0])), "ある(learned,null)");
  // Every index is a boundary when the caller says so.
  assert.equal(mark("あるいは", deck, new Set([0, 1, 2, 3])), "ある(learned,null) | いは");
});

test("markWords with the segmenter colours 食べる and not ある in あるいは食べる", () => {
  const deck = [["ある", "learned", null], ["食べる", "new", null]];
  assert.equal(mark("あるいは食べる", deck), "あるいは | 食べる(new,null)");
});

test("markWords lets an exact word win a tie and the longer span otherwise", () => {
  assert.equal(mark("見た", [["見", "new", null], ["見る", "learned", null]]), "見た(learned,null)");
  assert.equal(mark("見", [["見", "new", null], ["見る", "learned", null]]), "見(new,null)");
  assert.equal(mark("勉強", [["勉強", "new", null], ["勉強する", "learned", null]]), "勉強(new,null)");
  assert.equal(mark("日本語", [["日本", "new", null], ["日本語", "learned", null]]), "日本語(learned,null)");
});

test("markWords starts a match only at a word boundary", () => {
  assert.equal(mark("東京都", [["京都", "learned", null]], new Set([0, 2])), "東京都");
  assert.equal(mark("東京都", [["東京都", "learned", null]], new Set([0, 2])), "東京都(learned,null)");
  assert.equal(mark("東京都", [["京都", "learned", null]], new Set([0, 1])), "東 | 京都(learned,null)");
  assert.equal(mark("東京都", [["都", "learned", null]], new Set([0, 2])), "東京 | 都(learned,null)");
});

test("markWords accepts the boundaries as any iterable", () => {
  assert.equal(mark("東京都", [["京都", "learned", null]], [0, 1]), "東 | 京都(learned,null)");
});

test("markWords never overlaps and continues after a match", () => {
  const deck = [["猫", "new", "atamadaka"], ["犬", "learned", "nakadaka"], ["見る", "learning", null]];
  assert.equal(mark("猫と犬を見ました", deck), "猫(new,atamadaka) | と | 犬(learned,nakadaka) | を | 見ました(learning,null)");
  assert.equal(mark("猫猫", deck, new Set([0, 1])), "猫(new,atamadaka) | 猫(new,atamadaka)");
});

test("markWords stays quick on a long line against a large deck", () => {
  const entries = [];
  for (let i = 0; i < 3000; i++) entries.push([`語${i}る`, "learned", "heiban"]);
  entries.push(["日本語", "new", null]);
  const index = buildIndex(entries);
  const line = "これは日本語の字幕です。".repeat(400);
  const started = Date.now();
  const runs = markWords(line, index);
  assert.equal(runs.filter((run) => run.status === "new").length, 400);
  assert.equal(runs.map((run) => run.text).join(""), line);
  assert.ok(Date.now() - started < 1000, "marking a long line must not take a second");
});

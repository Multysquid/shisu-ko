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

// A plain-text pitch field may mark the drop with U+A71C.
const DROP = "ꜜ";

// Yomitan's {pitch-accents} field (26.9, `pitch-accent-list format='text'`), as its Anki
// template renderer writes it: createPronunciationText() plus applyClassStyles(), which inlines
// pronunciation-style.json and removes every class and data-* attribute. One inline-block <span>
// per mora with the kana and an empty line <span>; a high mora's line has a top border, the mora
// the pitch drops after a right border too. Checked against the real renderer's output.
function yomitanPitch(morae, n) {
  const high = (i) => (n === 0 ? i > 0 : n === 1 ? i < 1 : i > 0 && i < n);
  const LINE = "border-color:currentColor;";
  const HIGH = "display:block;user-select:none;pointer-events:none;position:absolute;top:0.1em;left:0;right:0;height:0;border-top-width:0.1em;border-top-style:solid;";
  const FALL = "right:-0.1em;height:0.4em;border-right-width:0.1em;border-right-style:solid;";
  let html = '<span style="display:inline;">';
  morae.forEach((mora, i) => {
    const drop = high(i) && !high(i + 1);
    html += `<span style="display:inline-block;position:relative;${drop ? "padding-right:0.1em;margin-right:0.1em;" : ""}">`;
    for (const ch of mora) html += `<span style="display:inline;">${ch}</span>`;
    html += `<span style="${LINE}${high(i) ? HIGH : ""}${drop ? FALL : ""}"></span></span>`;
  });
  return html + "</span>";
}

// The renderer's output for 橋 [2], verbatim.
const YOMITAN_HASHI_2 =
  '<span style="display:inline;"><span style="display:inline-block;position:relative;"><span style="display:inline;">は</span><span style="border-color:currentColor;"></span></span>' +
  '<span style="display:inline-block;position:relative;padding-right:0.1em;margin-right:0.1em;"><span style="display:inline;">し</span>' +
  '<span style="border-color:currentColor;display:block;user-select:none;pointer-events:none;position:absolute;top:0.1em;left:0;right:0;height:0;border-top-width:0.1em;border-top-style:solid;right:-0.1em;height:0.4em;border-right-width:0.1em;border-right-style:solid;"></span></span></span>';

// 鍵 [2] with a nasal second mora: the kana sits in a second inline-block <span> with the
// diacritic and the nasal indicator; the line <span> follows it.
const YOMITAN_KAGI_NASAL =
  '<span style="display:inline;"><span style="display:inline-block;position:relative;"><span style="display:inline;">か</span><span style="border-color:currentColor;"></span></span>' +
  '<span style="display:inline-block;position:relative;padding-right:0.1em;margin-right:0.1em;"><span style="display:inline-block;position:relative;"><span style="display:inline;">き</span>' +
  '<span style="position:absolute;width:0;height:0;opacity:0;">゚</span><span style="display:block;position:absolute;right:-0.125em;top:0.125em;width:0.375em;height:0.375em;border-radius:50%;box-sizing:border-box;z-index:1;border:1.5px solid #c83c28;"></span></span>' +
  '<span style="border-color:currentColor;display:block;user-select:none;pointer-events:none;position:absolute;top:0.1em;left:0;right:0;height:0;border-top-width:0.1em;border-top-style:solid;right:-0.1em;height:0.4em;border-right-width:0.1em;border-right-style:solid;"></span></span></span>';

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

// HTML lets </rt> and </rp> be left out before the next <rt>, <rp> or </ruby>. Yomitan writes
// them; a hand-written or third-party field may not, and match.js reads such a sentence, so the
// word must read the same way or the card never colours its word.
const RUBY_SHAPES = [
  ["<ruby>食<rt>た</rt></ruby>べる", "食べる", "たべる"],
  ["<ruby>食<rt>た</ruby>べる", "食べる", "たべる"],
  ["<ruby>食<rp>(</rp><rt>た</rt><rp>)</rp></ruby>べる", "食べる", "たべる"],
  ["<ruby>食<rp>(<rt>た<rp>)</ruby>べる", "食べる", "たべる"],
  ["<RUBY>食<RT>た</RUBY>べる", "食べる", "たべる"],
  ["<ruby>日本<rt>にほん</ruby><ruby>語<rt>ご</ruby>", "日本語", "にほんご"],
  ["<ruby>日本<rt>にほん</rt></ruby><ruby>語<rt>ご</rt></ruby>", "日本語", "にほんご"],
  ["<ruby><b>食</b><rt>た</ruby>べる", "食べる", "たべる"],
  [" 食[た]べる", "食べる", "たべる"],
  ["<b>食</b>べる", "食べる", ""],
];

test("plainText, plainWord and readingOf read a ruby whose end tags are left out", () => {
  for (const [html, word, reading] of RUBY_SHAPES) {
    assert.equal(plainWord(html), word, html);
    assert.equal(readingOf(html), reading, html);
    if (!html.includes("[")) assert.equal(plainText(html), word, html);
  }
});

test("plainWord agrees with SHISUKO_MATCH.normalize on every ruby shape", () => {
  // The background indexes a card's word with plainWord and matches its sentence with
  // match.js; the two must not drift apart on any shape of ruby again.
  const match = require("../match");
  for (const [html, word] of RUBY_SHAPES) {
    assert.equal(match.normalize(html), word, html);
    assert.equal(plainWord(html), match.normalize(html), html);
  }
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

test("plainWord and readingOf stay quick on a passage in the field", () => {
  // The furigana regex scans from every character when no bracket follows: unbounded, a
  // 30,000-character line costs close to a second per note.
  const passage = "これは字幕の長い文です。".repeat(2500);
  let started = Date.now();
  const word = plainWord(passage);
  assert.ok(Date.now() - started < 50, "plainWord on a 30,000-character line");
  assert.ok(word.length > 40, "a passage is still not a word");
  started = Date.now();
  assert.equal(plainWord(" 食[た]べる<br>" + passage), "食べる");
  assert.equal(plainWord("\n \n" + passage.slice(0, 200)), passage.slice(0, 200));
  assert.ok(Date.now() - started < 50);
  // readingOf: unclosed <ruby> restart its lazy scan, and the furigana regex runs on the rest.
  const ruby = "<ruby>あ".repeat(2000) + "<rt>い</rt>" + "う".repeat(20000);
  started = Date.now();
  assert.equal(readingOf(ruby), "");
  assert.equal(readingOf("か".repeat(20000)), "");
  assert.ok(Date.now() - started < 50, "readingOf on a long field");
  // A reading of ordinary length is read as before.
  assert.equal(readingOf("<ruby>日本<rp>(</rp><rt>にほん</rt><rp>)</rp></ruby><ruby>語<rp>(</rp><rt>ご</rt><rp>)</rp></ruby>".repeat(8)), "にほんご".repeat(8));
});

test("plainWord and parsePitch stay quick on a field of tags never closed", () => {
  // A "<" without its ">" once made every tag pattern scan to the end of the field from every
  // "<" after it: a 100,000-character run cost seconds per note, on the background's one thread.
  const fieldOf = (list) => {
    const out = {};
    list.forEach(([name, value], order) => {
      out[name] = { value, order };
    });
    return out;
  };
  const started = Date.now();
  assert.ok(plainWord("<".repeat(100000) + "猫").length > 40, "the run of < is text, and no word");
  assert.equal(plainWord("x<".repeat(15000)).length, 320);
  assert.ok(plainWord("<rt ".repeat(10000) + "あ".repeat(100000)).length > 40);
  // Unclosed <rt> still restart the scan for </rt>, so the raw value is cut before any pattern
  // runs; what is left of this one is tags only.
  assert.equal(plainWord("<rt>".repeat(10000) + "あ".repeat(100000)), "");
  assert.equal(plainText("<".repeat(100000)).length, 16000);
  assert.equal(parsePitch("<".repeat(100000)), null);
  assert.equal(parsePitch("<rt>".repeat(10000) + "あ".repeat(100000)), null);
  assert.equal(parsePitch('<span style="display:inline-block;position:relative;"'.repeat(3000)), null);
  assert.equal(parsePitch('<span style="'.repeat(10000)), null);
  assert.equal(pitchOf(fieldOf([["Word", "猫"], ["Pitch", "<".repeat(100000)]]), {}), null);
  assert.equal(pitchOf(fieldOf([["Word", "<".repeat(100000)], ["Pitch", "[2]"]]), {}), "nakadaka");
  assert.ok(Date.now() - started < 200, "a field of tags never closed must cost milliseconds");
  // Markup of ordinary length reads as before, a word after a long passage included.
  assert.equal(plainWord(" 食[た]べる<br>" + "これは字幕の長い文です。".repeat(2500)), "食べる");
  assert.equal(plainText('<span class="x" data-y="1">猫</span><br>犬'), "猫 犬");
  assert.equal(parsePitch(YOMITAN_HASHI_2, "", "橋"), "odaka");
  assert.equal(parsePitch("<ol><li>" + yomitanPitch(["に", "ほ", "ん", "ご"], 0) + "</li></ol>"), "heiban");
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

test("parsePitch reads the moras Yomitan's {pitch-accents} draws", () => {
  assert.equal(parsePitch(YOMITAN_HASHI_2, "はし", "橋"), "odaka");
  assert.equal(yomitanPitch(["は", "し"], 2), YOMITAN_HASHI_2);
  assert.equal(parsePitch(yomitanPitch(["は", "し"], 0), "はし", "端"), "heiban");
  assert.equal(parsePitch(yomitanPitch(["は", "し"], 1), "はし", "箸"), "atamadaka");
  assert.equal(parsePitch(yomitanPitch(["さ", "か", "な"], 2), "さかな", "魚"), "nakadaka");
  assert.equal(parsePitch(yomitanPitch(["こ", "こ", "ろ"], 3), "こころ", "心"), "odaka");
  // The moras are counted as drawn: きょ is one, and the reading or word is not consulted.
  assert.equal(parsePitch(yomitanPitch(["と", "う", "きょ", "う"], 0)), "heiban");
  assert.equal(parsePitch(yomitanPitch(["きょ", "う", "だ", "い"], 1)), "atamadaka");
  assert.equal(parsePitch(yomitanPitch(["に", "ほ", "ん"], 2), "", ""), "nakadaka");
  assert.equal(parsePitch(yomitanPitch(["に", "ほ", "ん"], 3), "", ""), "odaka");
  // A nasal mora's extra inline-block span is not a mora.
  assert.equal(parsePitch(YOMITAN_KAGI_NASAL, "かぎ", "鍵"), "odaka");
  // Several patterns: <ol><li>…</li></ol>, and the first counts, as with the positions.
  const list = (ns, morae) => `<ol>${ns.map((n) => `<li>${yomitanPitch(morae, n)}</li>`).join("")}</ol>`;
  assert.equal(parsePitch(list([0, 3], ["こ", "こ", "ろ"])), "heiban");
  assert.equal(parsePitch(list([3, 0], ["こ", "こ", "ろ"])), "odaka");
  assert.equal(parsePitch(list([2, 0], ["は", "し"])), "odaka");
  // The disambiguation the template may put before it changes nothing.
  assert.equal(parsePitch(`<em>(はし only) </em>${YOMITAN_HASHI_2}`, "はし", "橋"), "odaka");
});

test("parsePitch reads the drop mark of a plain-text field", () => {
  assert.equal(parsePitch(`はし${DROP}`), "odaka");
  assert.equal(parsePitch(`は${DROP}し`), "atamadaka");
  assert.equal(parsePitch(`たま${DROP}ご`), "nakadaka");
  assert.equal(parsePitch(`きょ${DROP}うと`), "atamadaka");
  // Kana alone, with no mark, is heiban in that format.
  assert.equal(parsePitch("はし"), "heiban");
  // Kana inside markup this does not read is not: Yomitan's own drawing never has ꜜ, so a
  // kana-only text can be any pattern behind unknown markup.
  assert.equal(parsePitch("<span>コーヒー</span>"), null);
  assert.equal(parsePitch("<b>はし</b>"), null);
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

test("pitchOf never takes a sentence's reading for the word's", () => {
  // Yomitan's {sentence-furigana} in a field named SentenceFurigana: the word's own reading
  // is elsewhere or nowhere, and the sentence's mora count must not make 橋 [2] nakadaka.
  const sentence = " 橋[はし]を 渡[わた]る";
  assert.equal(pitchOf(fields([["Word", "はし"], ["SentenceFurigana", sentence], ["PitchAccent", "[2]"]]), {}), "odaka");
  assert.equal(pitchOf(fields([["Word", "橋"], ["SentenceFurigana", sentence], ["Reading", "はし"], ["PitchAccent", "[2]"]]), {}), "odaka");
  assert.equal(pitchOf(fields([["Word", "橋"], ["SentenceReading", "はしをわたる"], ["PitchAccent", "[2]"]]), {}), "nakadaka");
  assert.equal(pitchOf(fields([["Word", "橋"], ["例文読み", "はしをわたる"], ["PitchAccent", "[2]"]]), {}), "nakadaka");
  // A word field the sentence's reading would have hidden.
  assert.equal(pitchOf(fields([["Expression", "さかな"], ["Sentence", "魚を食べる"], ["SentenceFurigana", " 魚[さかな]を 食[た]べる"], ["Pitch", "[3]"]]), {}), "odaka");
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

test("pitchOf moves on to the next pitch field when the first one has no readable value", () => {
  // {pitch-accent-graphs} is an SVG without text; the position sits in the field after it.
  const graph = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 150 100"><path d="M25 75 L75 25"></path><circle cx="25" cy="75" r="15"></circle></svg>';
  const note = fields([
    ["Word", "橋"],
    ["Reading", "はし"],
    ["PitchAccent", graph],
    ["PitchPosition", "[2]"],
  ]);
  assert.equal(pitchOf(note, {}), "odaka");
  assert.equal(pitchOf(fields([["Word", "橋"], ["Reading", "はし"], ["PitchAccent", ""], ["Accent", "[1]"]]), {}), "atamadaka");
  // The named field is taken as it is, readable or not.
  assert.equal(pitchOf(note, { ankiPitchField: "PitchAccent" }), null);
  assert.equal(pitchOf(note, { ankiPitchField: "PitchPosition" }), "odaka");
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

test("buildIndex cuts a stem from the words with kanji or katakana, and from a kana word with two kana to spare", () => {
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
  assert.deepEqual(kinds("たべ"), ["たべる:ru"]);
  assert.equal(index.stems.size, 6);
  assert.equal(index.maxStemLen, 2);
  // Kana-only words need a boundary after them, in every form.
  assert.equal(index.exact.get("たべる").bounded, true);
  assert.equal(index.exact.get("する").bounded, true);
  assert.equal(index.exact.get("食べる").bounded, false);
});

test("buildIndex gives a kana-only word a stem of two kana at least", () => {
  const index = buildIndex([
    ["かける", "new", null],
    ["つくる", "new", null],
    ["しまう", "new", null],
    ["もらう", "new", null],
    ["おいしい", "new", null],
    ["すごい", "new", null],
    ["びっくりする", "new", null],
    ["いう", "new", null],
    ["する", "new", null],
    ["くる", "new", null],
    ["みる", "new", null],
    ["いい", "new", null],
    ["あう", "new", null],
    ["こする", "new", null],
  ]);
  const kinds = (stem) => (index.stems.get(stem) || []).map((item) => `${item.entry.word}:${item.kind}`);
  assert.deepEqual(kinds("かけ"), ["かける:ru"]);
  assert.deepEqual(kinds("つく"), ["つくる:ru"]);
  assert.deepEqual(kinds("しま"), ["しまう:う"]);
  assert.deepEqual(kinds("もら"), ["もらう:う"]);
  assert.deepEqual(kinds("おいし"), ["おいしい:i-adj"]);
  assert.deepEqual(kinds("すご"), ["すごい:i-adj"]);
  assert.deepEqual(kinds("びっくり"), ["びっくりする:suru"]);
  // こする is a る verb with two kana to spare, not a する verb with one.
  assert.deepEqual(kinds("こす"), ["こする:ru"]);
  // A stem of one kana would be found at the start of every word beginning with it.
  for (const stem of ["い", "す", "く", "み", "あ", "こ"]) assert.deepEqual(kinds(stem), []);
  assert.equal(index.stems.size, 8);
  assert.equal(index.maxStemLen, 4);
  assert.equal(index.exact.get("かける").bounded, true);
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

test("markWords keeps the る of the potential and causative forms", () => {
  assert.equal(mark("行ける", [["行く", "learned", null]]), "行ける(learned,null)");
  assert.equal(mark("行けるよ", [["行く", "learned", null]]), "行ける(learned,null) | よ");
  assert.equal(mark("行けます", [["行く", "learned", null]]), "行けます(learned,null)");
  assert.equal(mark("行けた", [["行く", "learned", null]]), "行けた(learned,null)");
  assert.equal(mark("話せる", [["話す", "learned", null]]), "話せる(learned,null)");
  assert.equal(mark("会えるかな", [["会う", "learned", null]]), "会える(learned,null) | かな");
  const deck = [["食べる", "learned", null]];
  assert.equal(mark("食べれる", deck), "食べれる(learned,null)");
  assert.equal(mark("食べさせる", deck), "食べさせる(learned,null)");
  assert.equal(mark("食べさせられた", deck), "食べさせられた(learned,null)");
  assert.equal(mark("食べてる", deck), "食べてる(learned,null)");
  assert.equal(mark("見れる", [["見る", "learned", null]]), "見れる(learned,null)");
  assert.equal(mark("来れる", [["来る", "learned", null]]), "来れる(learned,null)");
});

test("markWords finds the ichidan forms whose first piece the godan rows reach through a tail", () => {
  const deck = [["食べる", "learned", null]];
  assert.equal(mark("食べたら", deck), "食べたら(learned,null)");
  assert.equal(mark("見たり見なかったり", [["見る", "learned", null]]), "見たり(learned,null) | 見なかったり(learned,null)");
  assert.equal(mark("食べましょう", deck), "食べましょう(learned,null)");
  assert.equal(mark("面白いでしょう", [["面白い", "learned", null]]), "面白いでしょう(learned,null)");
  assert.equal(mark("食べたでしょう", deck), "食べたでしょう(learned,null)");
  assert.equal(mark("食べるでしょう", deck), "食べるでしょう(learned,null)");
  assert.equal(mark("食べたくない", deck), "食べたくない(learned,null)");
  assert.equal(mark("食べたかった", deck), "食べたかった(learned,null)");
  assert.equal(mark("食べても", deck), "食べても(learned,null)");
  assert.equal(mark("食べなくて", deck), "食べなくて(learned,null)");
  assert.equal(mark("食べながら", deck), "食べながら(learned,null)");
  assert.equal(mark("食べなさい", deck), "食べなさい(learned,null)");
  assert.equal(mark("食べちゃう", deck), "食べちゃう(learned,null)");
  assert.equal(mark("食べそうだ", deck), "食べそうだ(learned,null)");
  assert.equal(mark("勉強すれば", [["勉強する", "learned", null]]), "勉強すれば(learned,null)");
});

test("markWords stops a form before the word that begins with a tail's kana", () => {
  const deck = [["食べる", "learned", null]];
  assert.equal(mark("食べるだけ", deck), "食べる(learned,null) | だけ");
  assert.equal(mark("食べただけ", deck), "食べた(learned,null) | だけ");
  assert.equal(mark("食べるために", deck), "食べる(learned,null) | ために");
  assert.equal(mark("食べたため", deck), "食べた(learned,null) | ため");
  assert.equal(mark("食べるたびに", deck), "食べる(learned,null) | たびに");
  assert.equal(mark("食べたうえで", deck), "食べた(learned,null) | うえで");
  assert.equal(mark("食べてばかり", deck), "食べて(learned,null) | ばかり");
  assert.equal(mark("食べたばかり", deck), "食べた(learned,null) | ばかり");
  assert.equal(mark("食べてずっと", deck), "食べて(learned,null) | ずっと");
  assert.equal(mark("食べてうれしい", deck), "食べて(learned,null) | うれしい");
  assert.equal(mark("食べたせいで", deck), "食べた(learned,null) | せいで");
  assert.equal(mark("食べたてんぷら", deck), "食べた(learned,null) | てんぷら");
  assert.equal(mark("食べていい", deck), "食べて(learned,null) | いい");
  assert.equal(mark("食べてもいい", deck), "食べても(learned,null) | いい");
  assert.equal(mark("食べたいけど", deck), "食べたい(learned,null) | けど");
  assert.equal(mark("高いうちに", [["高い", "learned", null]]), "高い(learned,null) | うちに");
  assert.equal(mark("高いだけ", [["高い", "learned", null]]), "高い(learned,null) | だけ");
  assert.equal(mark("見ていいよ", [["見る", "learned", null]]), "見て(learned,null) | いいよ");
  assert.equal(mark("書いていい", [["書く", "learned", null]]), "書いて(learned,null) | いい");
  // The pieces that do follow: だ after ん, た after まし and て, う after the o-row, and so on,
  // whatever the segmenter makes of the line (ICU cuts 食|べた|いと|思う and 食|べ|てい|たよ).
  assert.equal(mark("食べたんだけど", deck), "食べたんだ(learned,null) | けど");
  assert.equal(mark("食べました", deck), "食べました(learned,null)");
  assert.equal(mark("食べましたよ", deck), "食べました(learned,null) | よ");
  assert.equal(mark("食べたいです", deck), "食べたいです(learned,null)");
  assert.equal(mark("食べたいと思う", deck), "食べたい(learned,null) | と思う");
  assert.equal(mark("食べていた", deck), "食べていた(learned,null)");
  assert.equal(mark("食べていたよ", deck), "食べていた(learned,null) | よ");
  assert.equal(mark("食べていたでしょう", deck), "食べていたでしょう(learned,null)");
  assert.equal(mark("食べていられない", deck), "食べていられない(learned,null)");
  assert.equal(mark("食べていました", deck), "食べていました(learned,null)");
  assert.equal(mark("食べていれば", deck), "食べていれば(learned,null)");
  assert.equal(mark("食べてた", deck), "食べてた(learned,null)");
  assert.equal(mark("行こうか", [["行く", "learned", null]]), "行こう(learned,null) | か");
  assert.equal(mark("書かれれば", [["書く", "learned", null]]), "書かれれば(learned,null)");
  assert.equal(mark("勉強させられた", [["勉強する", "learned", null]]), "勉強させられた(learned,null)");
  // Without a segmenter every index is a boundary, and the answer is the same.
  assert.equal(mark("食べるだけ", deck, [0, 1, 2, 3, 4]), "食べる(learned,null) | だけ");
  assert.equal(mark("食べたいと思う", deck, [0, 1, 2, 3, 4, 5, 6]), "食べたい(learned,null) | と思う");
});

test("markWords follows ていく as it follows ている", () => {
  assert.equal(mark("生きていく", [["生きる", "new", null]]), "生きていく(new,null)");
  assert.equal(mark("生きていける", [["生きる", "new", null]]), "生きていける(new,null)");
  assert.equal(mark("生きていかない", [["生きる", "new", null]]), "生きていかない(new,null)");
  assert.equal(mark("見ていこう", [["見る", "new", null]]), "見ていこう(new,null)");
  const deck = [["食べる", "new", null]];
  assert.equal(mark("食べていきます", deck), "食べていきます(new,null)");
  assert.equal(mark("食べていって", deck), "食べていって(new,null)");
  assert.equal(mark("頑張っていきます", [["頑張る", "new", null]]), "頑張っていきます(new,null)");
  assert.equal(mark("泳いでいく", [["泳ぐ", "new", null]]), "泳いでいく(new,null)");
  assert.equal(mark("泳いでいる", [["泳ぐ", "new", null]]), "泳いでいる(new,null)");
  assert.equal(mark("食べていた", deck), "食べていた(new,null)");
  // The stem of いる or いく alone ends no span: 見ていかが is 見て and いかが.
  assert.equal(mark("食べていかがですか", deck), "食べて(new,null) | いかがですか");
  assert.equal(mark("食べてい", deck), "食べて(new,null) | い");
});

test("markWords ends a form before もらう and follows いただく to its end", () => {
  // て + も is the concessive ても only until ら follows: 〜てもらう is another verb.
  assert.equal(mark("食べてもらう", [["食べる", "learned", null]]), "食べて(learned,null) | もらう");
  assert.equal(mark("教えてもらえますか", [["教える", "learned", null]]), "教えて(learned,null) | もらえますか");
  assert.equal(mark("書いてもらった", [["書く", "learned", null]]), "書いて(learned,null) | もらった");
  assert.equal(mark("読んでもらえる", [["読む", "learned", null]]), "読んで(learned,null) | もらえる");
  assert.equal(mark("勉強してもらう", [["勉強する", "learned", null]]), "勉強して(learned,null) | もらう");
  assert.equal(mark("食べさせてもらう", [["食べる", "learned", null]]), "食べさせて(learned,null) | もらう");
  assert.equal(mark("食べてもいい", [["食べる", "learned", null]]), "食べても(learned,null) | いい");
  assert.equal(mark("食べても", [["食べる", "learned", null]]), "食べても(learned,null)");
  // 〜ていただく is a tail of its own, and where it is not followed the span never ends inside it.
  assert.equal(mark("食べていただく", [["食べる", "learned", null]]), "食べていただく(learned,null)");
  assert.equal(mark("教えていただけますか", [["教える", "learned", null]]), "教えていただけます(learned,null) | か");
  assert.equal(mark("教えていただけませんか", [["教える", "learned", null]]), "教えていただけません(learned,null) | か");
  assert.equal(mark("見ていただいて", [["見る", "learned", null]]), "見ていただいて(learned,null)");
  assert.equal(mark("読んでいただきました", [["読む", "learned", null]]), "読んでいただきました(learned,null)");
  assert.equal(mark("使わせていただきました", [["使う", "learned", null]]), "使わせていただきました(learned,null)");
  assert.equal(mark("食べていただければ", [["食べる", "learned", null]]), "食べていただければ(learned,null)");
  assert.equal(mark("食べていただこう", [["食べる", "learned", null]]), "食べていただこう(learned,null)");
  assert.equal(mark("食べていただかないと", [["食べる", "learned", null]]), "食べていただかない(learned,null) | と");
  assert.equal(mark("食べていただ", [["食べる", "learned", null]]), "食べて(learned,null) | いただ");
  assert.equal(mark("食べていた", [["食べる", "learned", null]]), "食べていた(learned,null)");
  assert.equal(mark("食べていたよ", [["食べる", "learned", null]]), "食べていた(learned,null) | よ");
  assert.equal(mark("書いただけ", [["書く", "learned", null]]), "書いた(learned,null) | だけ");
  assert.equal(mark("食べていただく", [["食べる", "learned", null]], [0, 1, 2, 3, 4, 5, 6]), "食べていただく(learned,null)");
  assert.equal(mark("食べてもらう", [["食べる", "learned", null]], [0, 1, 2, 3, 4, 5]), "食べて(learned,null) | もらう");
});

test("markWords needs a tail after a piece that is no form on its own", () => {
  // A godan verb's a-row and o-row: 行か needs ない, 行こ needs う.
  assert.equal(mark("聞こえる", [["聞く", "learned", null]]), "聞こえる");
  assert.equal(mark("聞こえた", [["聞く", "learned", null]]), "聞こえた");
  assert.equal(mark("死の恐怖", [["死ぬ", "learned", null]]), "死の恐怖");
  assert.equal(mark("死のゲーム", [["死ぬ", "learned", null]]), "死のゲーム");
  assert.equal(mark("聞こう", [["聞く", "learned", null]]), "聞こう(learned,null)");
  assert.equal(mark("死のう", [["死ぬ", "learned", null]]), "死のう(learned,null)");
  assert.equal(mark("行こうか", [["行く", "learned", null]]), "行こう(learned,null) | か");
  assert.equal(mark("行こっか", [["行く", "learned", null]]), "行こっ(learned,null) | か");
  assert.equal(mark("行こー", [["行く", "learned", null]]), "行こー(learned,null)");
  assert.equal(mark("行かなきゃ", [["行く", "learned", null]]), "行かなきゃ(learned,null)");
  assert.equal(mark("読まなきゃ", [["読む", "learned", null]]), "読まなきゃ(learned,null)");
  assert.equal(mark("帰らなきゃ", [["帰る", "learned", null]]), "帰らなきゃ(learned,null)");
  assert.equal(mark("食べなきゃ", [["食べる", "learned", null]]), "食べなきゃ(learned,null)");
  assert.equal(mark("食べなきゃだめ", [["食べる", "learned", null]]), "食べなきゃ(learned,null) | だめ");
  assert.equal(mark("勉強しなきゃ", [["勉強する", "learned", null]]), "勉強しなきゃ(learned,null)");
  assert.equal(mark("高くなきゃ", [["高い", "learned", null]]), "高くなきゃ(learned,null)");
  assert.equal(mark("行かねば", [["行く", "learned", null]]), "行かねば");
  assert.equal(mark("行かず", [["行く", "learned", null]]), "行かず(learned,null)");
  assert.equal(mark("帰らん", [["帰る", "learned", null]]), "帰らん(learned,null)");
  // An adjective's く-form is a deck entry of its own (多く): 多かった is not a form of it.
  assert.equal(mark("多かった", [["多く", "learned", null]]), "多かった");
  assert.equal(mark("多くない", [["多い", "learned", null]]), "多くない(learned,null)");
  // A する verb's さ, せ and す, unlike an adjective's さ.
  assert.equal(mark("電話さえ", [["電話する", "learned", null]]), "電話(learned,null) | さえ");
  assert.equal(mark("電話さえすれば", [["電話する", "learned", null]]), "電話(learned,null) | さえすれば");
  assert.equal(mark("勉強すら", [["勉強する", "learned", null]]), "勉強(learned,null) | すら");
  assert.equal(mark("勉強すべき", [["勉強する", "learned", null]]), "勉強(learned,null) | すべき");
  assert.equal(mark("勉強させる", [["勉強する", "learned", null]]), "勉強させる(learned,null)");
  assert.equal(mark("勉強される", [["勉強する", "learned", null]]), "勉強される(learned,null)");
  assert.equal(mark("勉強せず", [["勉強する", "learned", null]]), "勉強せず(learned,null)");
  assert.equal(mark("勉強せよ", [["勉強する", "learned", null]]), "勉強せよ(learned,null)");
  assert.equal(mark("勉強すれば", [["勉強する", "learned", null]]), "勉強すれば(learned,null)");
  assert.equal(mark("高さが", [["高い", "learned", null]]), "高さ(learned,null) | が");
  // けれ only reaches ければ, まし only ました.
  assert.equal(mark("食べるけれど", [["食べる", "learned", null]]), "食べる(learned,null) | けれど");
  assert.equal(mark("高いけれど", [["高い", "learned", null]]), "高い(learned,null) | けれど");
  assert.equal(mark("行ったけれども", [["行く", "learned", null]]), "行った(learned,null) | けれども");
  assert.equal(mark("食べたければ", [["食べる", "learned", null]]), "食べたければ(learned,null)");
  assert.equal(mark("高ければ", [["高い", "learned", null]]), "高ければ(learned,null)");
  // まし alone is no form, but 食べ is (the noun form), so a line cut there keeps the stem.
  assert.equal(mark("食べまし", [["食べる", "learned", null]]), "食べ(learned,null) | まし");
  assert.equal(mark("食べまして", [["食べる", "learned", null]]), "食べまして(learned,null)");
  assert.equal(mark("帰りまし", [["帰る", "learned", null]]), "帰り(learned,null) | まし");
  assert.equal(mark("聞こえる", [["聞く", "learned", null]], [0, 1, 2, 3]), "聞こえる");
  assert.equal(mark("電話さえ", [["電話する", "learned", null]], [0, 1, 2, 3]), "電話(learned,null) | さえ");
});

test("markWords ends a form before the word its last piece would begin", () => {
  const deck = [["食べる", "learned", null]];
  assert.equal(mark("食べたらしい", deck), "食べた(learned,null) | らしい");
  assert.equal(mark("食べたらしくない", deck), "食べた(learned,null) | らしくない");
  assert.equal(mark("行ったらしい", [["行く", "learned", null]]), "行った(learned,null) | らしい");
  assert.equal(mark("死んだらしい", [["死ぬ", "learned", null]]), "死んだ(learned,null) | らしい");
  assert.equal(mark("勉強したらしい", [["勉強する", "learned", null]]), "勉強した(learned,null) | らしい");
  assert.equal(mark("食べたら", deck), "食べたら(learned,null)");
  assert.equal(mark("食べたらね", deck), "食べたら(learned,null) | ね");
  assert.equal(mark("食べたらしばらく休む", deck), "食べたら(learned,null) | しばらく休む");
  assert.equal(mark("食べたくせに", deck), "食べた(learned,null) | くせに");
  assert.equal(mark("知ってたくせに", [["知る", "learned", null]]), "知ってた(learned,null) | くせに");
  assert.equal(mark("高かったくせに", [["高い", "learned", null]]), "高かった(learned,null) | くせに");
  assert.equal(mark("食べてたくさん寝た", deck), "食べて(learned,null) | たくさん寝た");
  assert.equal(mark("行ってたくさん食べた", [["行く", "learned", null]]), "行って(learned,null) | たくさん食べた");
  assert.equal(mark("高いたくさん", [["高い", "learned", null]]), "高い(learned,null) | たくさん");
  assert.equal(mark("食べたくらい", deck), "食べた(learned,null) | くらい");
  assert.equal(mark("食べたくて", deck), "食べたくて(learned,null)");
  assert.equal(mark("食べたくなる", deck), "食べたく(learned,null) | なる");
  assert.equal(mark("見ていきなり", [["見る", "learned", null]]), "見て(learned,null) | いきなり");
  assert.equal(mark("行っていきなり", [["行く", "learned", null]]), "行って(learned,null) | いきなり");
  assert.equal(mark("食べていきなり倒れた", deck), "食べて(learned,null) | いきなり倒れた");
  assert.equal(mark("買っていくらだった", [["買う", "learned", null]]), "買って(learned,null) | いくらだった");
  assert.equal(mark("食べていきます", deck), "食べていきます(learned,null)");
  assert.equal(mark("生きていきなさい", [["生きる", "learned", null]]), "生きていきなさい(learned,null)");
  assert.equal(mark("食べたらしい", deck, [0, 1, 2, 3, 4, 5]), "食べた(learned,null) | らしい");
  assert.equal(mark("見ていきなり", [["見る", "learned", null]], [0, 1, 2, 3, 4, 5]), "見て(learned,null) | いきなり");
});

test("markWords lets ん follow the forms it shortens and not ちゃ", () => {
  const deck = [["食べる", "learned", null]];
  assert.equal(mark("食べてちゃんと寝て", deck), "食べてちゃ(learned,null) | んと寝て");
  assert.equal(mark("見てちゃんと", [["見る", "learned", null]]), "見てちゃ(learned,null) | んと");
  assert.equal(mark("聞いてちゃんと答えろ", [["聞く", "learned", null]]), "聞いてちゃ(learned,null) | んと答えろ");
  assert.equal(mark("食べるじゃん", deck), "食べるじゃん(learned,null)");
  assert.equal(mark("食べません", deck), "食べません(learned,null)");
  assert.equal(mark("食べますんで", deck), "食べますんで(learned,null)");
  assert.equal(mark("行かん", [["行く", "learned", null]]), "行かん(learned,null)");
  assert.equal(mark("食べてんの", deck), "食べてん(learned,null) | の");
  assert.equal(mark("食べるんじゃない", deck), "食べるんじゃない(learned,null)");
  assert.equal(mark("食べたんだけど", deck), "食べたんだ(learned,null) | けど");
  // ICU cuts 勉強|せん|とい|て: the と of the contracted ておいて takes the form's colour like a
  // particle (it belongs to the form), and いて after it is いる to the matcher.
  assert.equal(mark("勉強せんといて", [["勉強する", "learned", null]]), "勉強せん(learned,null) | といて");
  assert.equal(mark("勉強すんの", [["勉強する", "learned", null]]), "勉強すん(learned,null) | の");
});

test("markWords does not end a span inside a compound", () => {
  assert.equal(mark("関係ないよ", [["関する", "learned", null]]), "関係ないよ");
  assert.equal(mark("関東地方", [["関する", "learned", null]]), "関東地方");
  assert.equal(mark("対応します", [["対する", "learned", null]]), "対応します");
  assert.equal(mark("結婚式", [["結婚する", "learned", null]]), "結婚式");
  assert.equal(mark("飲み物", [["飲む", "learned", null]]), "飲み物");
  assert.equal(mark("買い物", [["買う", "learned", null]]), "買い物");
  assert.equal(mark("行き先", [["行く", "learned", null]]), "行き先");
  assert.equal(mark("日本語", [["日本", "learned", null]], new Set([0])), "日本語");
  assert.equal(mark("日本語", [["日本", "learned", null]]), "日本語");
  assert.equal(mark("コーヒー", [["コーヒ", "learned", null]], new Set([0])), "コーヒー");
  // A boundary there, or a kana after it, makes it an end.
  assert.equal(mark("見た犬", [["見る", "learned", null]]), "見た(learned,null) | 犬");
  assert.equal(mark("食べた後", [["食べる", "learned", null]]), "食べた(learned,null) | 後");
  assert.equal(mark("電話番号", [["電話する", "learned", null]]), "電話(learned,null) | 番号");
  assert.equal(mark("日本語", [["日本", "learned", null]], new Set([0, 2])), "日本(learned,null) | 語");
  assert.equal(mark("関して", [["関する", "learned", null]]), "関して(learned,null)");
});

test("markWords needs the first piece: a bare stem is another word", () => {
  const deck = [["走る", "learned", null]];
  assert.equal(mark("走った", deck), "走った(learned,null)");
  assert.equal(mark("走者", deck), "走者");
  assert.equal(mark("走ります", deck), "走ります(learned,null)");
});

test("markWords never colours a particle by a card of its own, whatever the deck holds", () => {
  // Yomitan looks particles up like any word, so a deck can hold は, の or のは; painting the は of
  // every line would say nothing about the viewer's words. A particle takes the colour of the
  // word before it, and nothing else (のは after 私, never a pitch).
  const deck = [["の", "learned", null], ["は", "new", null], ["のは", "learned", "heiban"], ["私", "learned", null]];
  assert.equal(mark("私のは赤い", deck), "私(learned,null) | のは赤い");
  assert.equal(mark("日本の首都", [["の", "learned", null]]), "日本の首都");
  assert.equal(mark("これは本です", [["は", "new", null]]), "これは本です");
  assert.equal(mark("行くから", [["から", "learned", null], ["行く", "new", null]]), "行く(new,null) | から");
  assert.equal(buildIndex([["は", "new", null], ["のに", "new", null], ["でも", "new", null]]).size, 0);
  // A particle inside a longer word is still that word.
  assert.equal(mark("彼のはなし", [["はなし", "learned", null]]), "彼の | はなし(learned,null)");
  // The の fusions and かも, which ICU cuts as words of their own, are particles too: かも takes
  // 行く's colour, and the し of しれない, which ICU cuts into し|れ|ない, is no particle here.
  assert.equal(mark("行くかもしれない", [["かも", "new", null], ["行く", "learned", null]]), "行く(learned,null) | かもしれない");
  assert.equal(mark("東京への旅", [["への", "new", null]]), "東京への旅");
  assert.equal(mark("彼との約束", [["との", "new", null]]), "彼との約束");
  assert.equal(mark("家での生活", [["での", "new", null]]), "家での生活");
  assert.equal(buildIndex([["かも", "new", null], ["への", "new", null], ["との", "new", null], ["での", "new", null]]).size, 0);
});

test("markWords never colours the copula or an auxiliary, whatever the deck holds", () => {
  // です, だ, ます, ない or ん end nearly every line: a card for one of them (JMdict has them all)
  // would paint every line the same way a card for は would.
  assert.equal(mark("これは日本語の字幕です", [["です", "new", null]]), "これは日本語の字幕です");
  assert.equal(mark("いいですね", [["です", "new", null]]), "いいですね");
  assert.equal(mark("それは猫だ", [["だ", "new", null]]), "それは猫だ");
  assert.equal(mark("分からない", [["ない", "new", null]]), "分からない");
  assert.equal(mark("雨かもしれない", [["ない", "new", null], ["かも", "new", null]]), "雨かもしれない");
  assert.equal(mark("食べます", [["ます", "new", null]]), "食べます");
  assert.equal(mark("行くんだもん", [["ん", "new", null], ["もん", "new", null]]), "行くんだもん");
  assert.equal(mark("それじゃない", [["じゃ", "new", null]]), "それじゃない");
  assert.equal(mark("行くでしょう", [["でしょう", "new", null]]), "行くでしょう");
  assert.equal(mark("食べたい", [["たい", "new", null]]), "食べたい");
  const copula = ["だ", "だった", "だろう", "だろ", "です", "でした", "でしょう", "でしょ", "ます", "ません", "ました", "ない", "たい", "ん", "じゃ", "じゃん", "かも", "もん"];
  assert.equal(buildIndex(copula.map((word) => [word, "new", null])).size, 0);
  // The forms themselves are still found through the tables, and a kanji word is not a particle.
  assert.equal(mark("分からない", [["ない", "new", null], ["分かる", "learned", null]]), "分からない(learned,null)");
  assert.equal(mark("無い", [["無い", "new", null]]), "無い(new,null)");
});

test("markWords takes a verb's noun form as the verb", () => {
  // A godan verb's noun form is its stem plus the i-row piece; an ichidan verb's is the bare
  // stem, which ends in kana. A bare stem ending in a kanji stays another word.
  assert.equal(mark("終わりが来た", [["終わる", "learned", null]]), "終わり(learned,null) | が来た");
  assert.equal(mark("話しをした", [["話す", "learned", null]]), "話し(learned,null) | をした");
  assert.equal(mark("動きが速い", [["動く", "learned", null]]), "動き(learned,null) | が速い");
  assert.equal(mark("食べに行く", [["食べる", "learned", null]]), "食べ(learned,null) | に行く");
  assert.equal(mark("助けを呼ぶ", [["助ける", "new", null]]), "助け(new,null) | を呼ぶ");
  assert.equal(mark("流れが変わる", [["流れる", "learned", null]]), "流れ(learned,null) | が変わる");
  assert.equal(mark("考えは", [["考える", "learned", null]]), "考え(learned,null) | は");
  // A compound is not the verb (the span may not end before a kanji), and a kanji stem is not a form.
  assert.equal(mark("食べ物", [["食べる", "learned", null]]), "食べ物");
  assert.equal(mark("考え方", [["考える", "learned", null]]), "考え方");
  assert.equal(mark("走者", [["走る", "learned", null]]), "走者");
  assert.equal(mark("見物", [["見る", "learned", null]]), "見物");
  // The conjugated forms still win over the bare stem.
  assert.equal(mark("食べました", [["食べる", "learned", null]]), "食べました(learned,null)");
  assert.equal(mark("終わった", [["終わる", "learned", null]]), "終わった(learned,null)");
});

test("markWords grants the bare stem to an ichidan verb at a word boundary only", () => {
  // A godan る verb's stem ends in the a-row and is no form: ICU keeps 当たり前 in one segment,
  // so the り form may not end before 前, and the bare 当た must not step in for it.
  assert.equal(mark("当たり前だよ", [["当たる", "learned", null]], new Set([0, 4, 5])), "当たり前だよ");
  assert.equal(mark("当たり前だよ", [["当たる", "learned", null]]), "当たり前だよ");
  assert.equal(mark("変わり者", [["変わる", "learned", null]], new Set([0])), "変わり者");
  assert.equal(mark("曲がり角", [["曲がる", "learned", null]], new Set([0])), "曲がり角");
  assert.equal(mark("代わり映え", [["代わる", "learned", null]], new Set([0])), "代わり映え");
  assert.equal(mark("分かち合おう", [["分かる", "learned", null]]), "分かち合おう");
  assert.equal(mark("転がして", [["転がる", "learned", null]]), "転がして");
  assert.equal(mark("散らかして", [["散らかる", "learned", null]]), "散らかして");
  // An ichidan stem inside a compound ICU holds together is not the noun form.
  assert.equal(mark("見せかけ", [["見せる", "learned", null]], new Set([0])), "見せかけ");
  assert.equal(mark("生きがい", [["生きる", "learned", null]], new Set([0])), "生きがい");
  assert.equal(mark("混じり気", [["混じる", "learned", null]], new Set([0])), "混じり気");
  assert.equal(mark("見せかけ", [["見せる", "learned", null]]), "見せかけ");
  // At a boundary the noun form stands, and the conjugations are untouched.
  assert.equal(mark("見せかけ", [["見せる", "learned", null]], new Set([0, 2])), "見せ(learned,null) | かけ");
  assert.equal(mark("食べに行く", [["食べる", "learned", null]]), "食べ(learned,null) | に行く");
  assert.equal(mark("起きに", [["起きる", "learned", null]]), "起き(learned,null) | に");
  assert.equal(mark("当たりが出た", [["当たる", "learned", null]]), "当たり(learned,null) | が出た");
  assert.equal(mark("当たった", [["当たる", "learned", null]]), "当たった(learned,null)");
  assert.equal(mark("分かります", [["分かる", "learned", null]]), "分かります(learned,null)");
  assert.equal(mark("転がった", [["転がる", "learned", null]]), "転がった(learned,null)");
  assert.equal(mark("混じって", [["混じる", "learned", null]]), "混じって(learned,null)");
  // Without a segmenter every index is a boundary, and the row rule alone keeps the godan stems out.
  assert.equal(mark("当たり前だよ", [["当たる", "learned", null]], [0, 1, 2, 3, 4, 5]), "当たり(learned,null) | 前だよ");
  assert.equal(mark("転がして", [["転がる", "learned", null]], [0, 1, 2, 3]), "転がして");
  assert.equal(mark("分かち合おう", [["分かる", "learned", null]], [0, 1, 2, 3, 4]), "分かち合おう");
});

test("markWords never ends a span right after the 音便 kana", () => {
  // 行い is 行う's noun and 行います its polite form; 引っかかる and 追っかける are verbs of their
  // own: い, っ and ん before た or て are no form alone and reach nothing but た and て.
  const go = [["行く", "learned", null]];
  assert.equal(mark("会議を行います", go), "会議を行います");
  assert.equal(mark("彼の行いが悪い", go), "彼の行いが悪い");
  assert.equal(mark("行いました", go), "行いました");
  assert.equal(mark("行いたい", go), "行いたい");
  assert.equal(mark("彼の行いです", go), "彼の行いです");
  assert.equal(mark("引っかかった", [["引く", "learned", null]]), "引っかかった");
  assert.equal(mark("引っかけて", [["引く", "learned", null]]), "引っかけて");
  assert.equal(mark("追っかけ", [["追う", "learned", null]]), "追っかけ");
  assert.equal(mark("取っかかり", [["取る", "learned", null]]), "取っかかり");
  assert.equal(mark("飲んどけ", [["飲む", "learned", null]]), "飲んどけ");
  // The forms themselves, and 行う's own.
  assert.equal(mark("行った", go), "行った(learned,null)");
  assert.equal(mark("行って", go), "行って(learned,null)");
  assert.equal(mark("行ったら", go), "行ったら(learned,null)");
  assert.equal(mark("行きます", go), "行きます(learned,null)");
  assert.equal(mark("書いちゃう", [["書く", "learned", null]]), "書いちゃう(learned,null)");
  assert.equal(mark("書いとく", [["書く", "learned", null]]), "書いとく(learned,null)");
  assert.equal(mark("書いたいろいろ", [["書く", "learned", null]]), "書いた(learned,null) | いろいろ");
  assert.equal(mark("飲んでも", [["飲む", "learned", null]]), "飲んでも(learned,null)");
  assert.equal(mark("飲んでる", [["飲む", "learned", null]]), "飲んでる(learned,null)");
  assert.equal(mark("取った", [["取る", "learned", null]]), "取った(learned,null)");
  assert.equal(mark("行います", [["行う", "new", null]]), "行います(new,null)");
  assert.equal(mark("行いたい", [["行う", "new", null], ["行く", "learned", null]]), "行いたい(new,null)");
  assert.equal(mark("行いが悪い", [["行う", "new", null]]), "行い(new,null) | が悪い");
  // A す verb's し is a form alone (the noun) and takes ます, while it takes た and て like the 音便 kana.
  assert.equal(mark("話しをした", [["話す", "learned", null]]), "話し(learned,null) | をした");
  assert.equal(mark("話した", [["話す", "learned", null]]), "話した(learned,null)");
  assert.equal(mark("話して", [["話す", "learned", null]]), "話して(learned,null)");
  assert.equal(mark("話します", [["話す", "learned", null]]), "話します(learned,null)");
  assert.equal(mark("話したい", [["話す", "learned", null]]), "話したい(learned,null)");
  assert.equal(mark("会議を行います", go, [0, 1, 2, 3, 4, 5, 6]), "会議を行います");
  assert.equal(mark("引っかかった", [["引く", "learned", null]], [0, 1, 2, 3, 4, 5]), "引っかかった");
});

test("markWords admits the っ of a く verb after 行 alone", () => {
  // 行く is the one く verb whose 音便 is っ (行った); every other takes い (歩いた, 書いた). A kana
  // く verb whose stem is a word of its own would else be found in that word and the quotative
  // after it: ICU cuts ある|って|言|っ|た, and あるって is ある and って, not 歩く.
  const walk = [["あるく", "learned", null]];
  assert.equal(mark("あるって言った", walk), "あるって言った");
  assert.equal(mark("あるって言った", walk, new Set([0, 2, 4, 5, 6])), "あるって言った");
  assert.equal(mark("ここにあるって", walk), "ここにあるって");
  assert.equal(mark("はたらって", [["はたらく", "learned", null]]), "はたらって");
  assert.equal(mark("書って", [["書く", "learned", null]]), "書って");
  // The い forms and 行く's っ, in the word alone and in a compound ending in 行く.
  assert.equal(mark("あるいて", walk), "あるいて(learned,null)");
  assert.equal(mark("あるいた", walk), "あるいた(learned,null)");
  assert.equal(mark("書いた", [["書く", "learned", null]]), "書いた(learned,null)");
  assert.equal(mark("行った", [["行く", "learned", null]]), "行った(learned,null)");
  assert.equal(mark("連れて行った", [["連れて行く", "learned", null]]), "連れて行った(learned,null)");
});

test("markWords never ends a span right after かっ", () => {
  // かっ, なかっ and たかっ only exist before た: the かっ of かっこいい after a form is that word's.
  assert.equal(mark("あの時見たかっこいい人", [["見る", "learned", null]]), "あの時 | 見た(learned,null) | かっこいい人");
  assert.equal(mark("食べてかっこ悪い", [["食べる", "learned", null]]), "食べて(learned,null) | かっこ悪い");
  assert.equal(mark("高いかっこう", [["高い", "learned", null]]), "高い(learned,null) | かっこう");
  assert.equal(mark("高かっ", [["高い", "learned", null]]), "高かっ");
  assert.equal(mark("食べたかっ", [["食べる", "learned", null]]), "食べた(learned,null) | かっ");
  assert.equal(mark("食べたかった", [["食べる", "learned", null]]), "食べたかった(learned,null)");
  assert.equal(mark("食べたかったら", [["食べる", "learned", null]]), "食べたかったら(learned,null)");
  assert.equal(mark("食べなかった", [["食べる", "learned", null]]), "食べなかった(learned,null)");
  assert.equal(mark("高かったら", [["高い", "learned", null]]), "高かったら(learned,null)");
  assert.equal(mark("高くなかった", [["高い", "learned", null]]), "高くなかった(learned,null)");
  assert.equal(mark("書きたかった", [["書く", "learned", null]]), "書きたかった(learned,null)");
  assert.equal(mark("あの時見たかっこいい人", [["見る", "learned", null]], [...Array(11).keys()]), "あの時 | 見た(learned,null) | かっこいい人");
});

test("markWords lets よう be the volitional only after an ichidan-like piece", () => {
  // After る, た, ない, the u-row or an adjective, よう is 様: ように, ようだ, ような.
  const deck = [["食べる", "learned", null]];
  assert.equal(mark("食べるように言われた", deck), "食べる(learned,null) | ように言われた");
  assert.equal(mark("食べたような気がする", deck), "食べた(learned,null) | ような気がする");
  assert.equal(mark("食べないようにしている", deck), "食べない(learned,null) | ようにしている");
  assert.equal(mark("見るようになった", [["見る", "learned", null]]), "見る(learned,null) | ようになった");
  assert.equal(mark("行くようだ", [["行く", "learned", null]]), "行く(learned,null) | ようだ");
  assert.equal(mark("高いようで", [["高い", "learned", null]]), "高い(learned,null) | ようで");
  assert.equal(mark("勉強するように", [["勉強する", "learned", null]]), "勉強する(learned,null) | ように");
  assert.equal(mark("来るよう", [["来る", "learned", null]]), "来る(learned,null) | よう");
  // The volitional: 食べよう is a first piece, ましょう is ましょ + う, and the pieces that
  // conjugate like 食べ take よう; the potential's e-row does not (書けよう is no form).
  assert.equal(mark("食べよう", deck), "食べよう(learned,null)");
  assert.equal(mark("食べましょう", deck), "食べましょう(learned,null)");
  assert.equal(mark("食べていよう", deck), "食べていよう(learned,null)");
  assert.equal(mark("食べられよう", deck), "食べられよう(learned,null)");
  assert.equal(mark("書かせよう", [["書く", "learned", null]]), "書かせよう(learned,null)");
  assert.equal(mark("勉強しよう", [["勉強する", "learned", null]]), "勉強しよう(learned,null)");
  assert.equal(mark("書けよう", [["書く", "learned", null]]), "書け(learned,null) | よう");
  assert.equal(mark("食べるように言われた", deck, [...Array(10).keys()]), "食べる(learned,null) | ように言われた");
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

// The viewer's two lines, with the boundaries ICU gives them (probed with Node 24).
const BATH = "ちょうどこのお風呂の中で";
const BATH_STARTS = new Set([0, 4, 6, 7, 9, 10, 11]);
const BATH_DECK = [["ちょうど", "learned", null], ["この", "learned", null], ["風呂", "new", "heiban"], ["中", "learning", "atamadaka"]];
const CALL = "視聴者の方に話しかけていただくっていうね";
const CALL_STARTS = new Set([0, 2, 3, 4, 5, 6, 7, 8, 10, 11, 15, 19]);
const CALL_DECK = [["視聴者", "learned", null], ["方", "learned", null], ["話しかける", "new", null], ["いただく", "learning", null], ["いう", "learned", "heiban"]];

test("markWords gives the honorific prefix the colour of the word it fronts and leaves the particles plain", () => {
  // ICU cuts ちょうど|この|お|風呂|の|中|で: the お takes 風呂's status (never its pitch), since it
  // is part of the word; の and で have cards of their own or none, so the line reads
  // [ちょうどこの][お風呂][の][中][で].
  const want = "ちょうど(learned,null) | この(learned,null) | お(new,null) | 風呂(new,heiban) | の | 中(learning,atamadaka) | で";
  assert.equal(mark(BATH, BATH_DECK, BATH_STARTS), want);
  assert.equal(mark(BATH, BATH_DECK), want);
  assert.deepEqual(markWords(BATH, buildIndex(BATH_DECK), BATH_STARTS).slice(2, 5), [
    { text: "お", status: "new", pitch: null },
    { text: "風呂", status: "new", pitch: "heiban" },
    { text: "の", status: null, pitch: null },
  ]);
  assert.equal(mark(BATH, [["風呂", "new", null], ["中", "learning", null]], BATH_STARTS), "ちょうどこの | お(new,null) | 風呂(new,null) | の | 中(learning,null) | で");
  // A word with a pitch and no status has no colour to run on: its prefix is plain text like the
  // rest, joined with it.
  assert.equal(mark("お風呂", [["風呂", null, "heiban"]], new Set([0, 1])), "お | 風呂(null,heiban)");
  assert.equal(markWords("お風呂", buildIndex([["風呂", null, "heiban"]]), new Set([0, 1])).length, 2);
  assert.equal(mark("お風呂の中", [["風呂", null, "heiban"]], new Set([0, 1, 3, 4])), "お | 風呂(null,heiban) | の中");
  assert.equal(markWords("お風呂の中", buildIndex([["風呂", null, "heiban"]]), new Set([0, 1, 3, 4])).length, 3);
});

test("markWords finds the word after a quotative inside its segment", () => {
  // ICU keeps っていう in one segment, so いう never begins one: it is found after the って, which
  // takes the colour of 話しかけていただく before it, the segment being one piece. The particles
  // stay plain: [視聴者][の][方][に][話しかけていただくって][いう][ね].
  const want =
    "視聴者(learned,null) | の | 方(learned,null) | に | 話しかけていただく(new,null) | って(new,null) | いう(learned,heiban) | ね";
  assert.equal(mark(CALL, CALL_DECK, CALL_STARTS), want);
  assert.equal(mark(CALL, CALL_DECK), want);
  // The viewer's deck holds かける rather than 話しかける: its form runs to the same end.
  assert.equal(mark(CALL, [["かける", "new", null], ["いう", "learned", null]], CALL_STARTS), "視聴者の方に話し | かけていただく(new,null) | って(new,null) | いう(learned,null) | ね");
  // With nothing coloured before it, the quotative stays plain.
  assert.equal(mark(CALL, [["いう", "learned", null]], CALL_STARTS), "視聴者の方に話しかけていただくって | いう(learned,null) | ね");
  assert.equal(mark(CALL, [["いう", "learned", null]]), "視聴者の方に話しかけていただくって | いう(learned,null) | ね");
});

test("markWords tries the word after お or ご only where ICU cut the prefix off", () => {
  // お|風呂, ご|家族 and お|仕事 are cut; お茶, お前, お金, ご飯 and お母さん are words of their own,
  // so 前 in the deck never colours お前.
  assert.equal(mark("お茶", [["茶", "new", null]], new Set([0])), "お茶");
  assert.equal(mark("お茶", [["茶", "new", null]]), "お茶");
  assert.equal(mark("お前", [["前", "new", null]], new Set([0])), "お前");
  assert.equal(mark("お前", [["前", "new", null]]), "お前");
  assert.equal(mark("お母さん", [["母", "new", null]]), "お母さん");
  assert.equal(mark("ご飯", [["飯", "new", null]]), "ご飯");
  assert.equal(mark("お茶", [["お茶", "new", null]], new Set([0])), "お茶(new,null)");
  assert.equal(mark("お茶とお菓子", [["お茶", "new", null], ["お菓子", "learned", null]]), "お茶(new,null) | と | お菓子(learned,null)");
  assert.equal(mark("ご家族は", [["家族", "new", "nakadaka"]], new Set([0, 1, 3])), "ご(new,null) | 家族(new,nakadaka) | は");
  assert.equal(mark("ご家族は", [["家族", "new", "nakadaka"]]), "ご(new,null) | 家族(new,nakadaka) | は");
  assert.equal(mark("お仕事", [["仕事", "new", null]]), "お(new,null) | 仕事(new,null)");
  // The word itself, when the deck holds it, wins over the prefix rule.
  assert.equal(mark("お風呂", [["お風呂", "learned", null], ["風呂", "new", null]], new Set([0, 1])), "お風呂(learned,null)");
  // Without a boundary after the prefix nothing is tried there.
  assert.equal(mark("お風呂", [["風呂", "new", null]], new Set([0])), "お風呂");
});

test("markWords leaves the particles after a word plain", () => {
  // A particle is not part of the word and has no card of its own: まで is plain after 領域,
  // で after 中, です after 学生. The word alone takes the colour.
  const book = [["本", "new", "heiban"]];
  assert.equal(mark("本には", book, new Set([0, 1, 2])), "本(new,heiban) | には");
  assert.equal(mark("本には", book), "本(new,heiban) | には");
  assert.equal(mark("本からは", book), "本(new,heiban) | からは");
  assert.equal(mark("本にはねよな", book), "本(new,heiban) | にはねよな");
  assert.equal(mark("学生です", [["学生", "learned", null]], new Set([0, 2])), "学生(learned,null) | です");
  assert.equal(mark("学生です", [["学生", "learned", null]]), "学生(learned,null) | です");
  assert.equal(mark("猫だよね", [["猫", "learned", null]]), "猫(learned,null) | だよね");
  assert.equal(mark("猫にほん", [["猫", "new", null]], new Set([0, 1, 2])), "猫(new,null) | にほん");
  assert.equal(mark("猫がでた", [["猫", "new", null]]), "猫(new,null) | がでた");
  assert.equal(mark("猫を見た", [["猫", "new", null], ["見る", "learned", null]]), "猫(new,null) | を | 見た(learned,null)");
  // A conjugation is part of the word and still goes with it; the particle after it does not.
  assert.equal(mark("食べるんだよね", [["食べる", "learned", null]]), "食べるんだ(learned,null) | よね");
  assert.equal(mark("食べたよ", [["食べる", "learned", null]], new Set([0])), "食べた(learned,null) | よ");
  // A deck word after the particle is found as ever, and a particle the deck itself holds as a
  // word is dropped by buildIndex, so it never colours anything.
  assert.equal(mark("犬はねこ", [["ねこ", "new", null]]), "犬は | ねこ(new,null)");
  assert.equal(mark("猫かもしれない", [["猫", "new", null], ["かもしれない", "learned", null]]), "猫(new,null) | かもしれない(learned,null)");
  assert.equal(mark("学生ですね", [["学生", "new", null], ["ですね", "learned", null]]), "学生(new,null) | ですね(learned,null)");
  // The runs still add up to the text, and the plain pieces are joined into one run.
  const runs = markWords("本にはねよな", buildIndex(book));
  assert.equal(runs.map((run) => run.text).join(""), "本にはねよな");
  assert.deepEqual(runs[1], { text: "にはねよな", status: null, pitch: null });
});

test("markWords colours the deck word alone in the lines the viewer read it wrong in", () => {
  // The two lines that showed the bug: 領域まで and 領域の read as one red piece, though まで and
  // の have no card. Exactly one run carries a status in each, and it is 領域.
  const deck = [["領域", "new", null]];
  const lines = ["この時点でこっちの地声領域のE4に変えれる人なぁー", "で、余裕がある人はそのままA4の地声領域まで持っていってください。"];
  for (const line of lines) {
    const runs = markWords(line, buildIndex(deck));
    const coloured = runs.filter((run) => run.status);
    assert.deepEqual(coloured, [{ text: "領域", status: "new", pitch: null }]);
    assert.equal(runs.map((run) => run.text).join(""), line);
  }
  assert.equal(mark(lines[0], deck), "この時点でこっちの地声 | 領域(new,null) | のE4に変えれる人なぁー");
  assert.equal(mark(lines[1], deck), "で、余裕がある人はそのままA4の地声 | 領域(new,null) | まで持っていってください。");
});

test("markWords finds いう after という and っていう, not inside そういう", () => {
  const say = [["いう", "learned", null]];
  assert.equal(mark("という", say, new Set([0])), "と | いう(learned,null)");
  assert.equal(mark("という", say), "と | いう(learned,null)");
  assert.equal(mark("っていう", say, new Set([0])), "って | いう(learned,null)");
  assert.equal(mark("っていう", say), "って | いう(learned,null)");
  assert.equal(mark("彼という人", say, new Set([0, 1, 4])), "彼と | いう(learned,null) | 人");
  assert.equal(mark("彼という人", say), "彼と | いう(learned,null) | 人");
  assert.equal(mark("そういう", say, new Set([0])), "そういう");
  assert.equal(mark("そういう", say), "そういう");
  assert.equal(mark("そういうこと", say), "そういうこと");
  // The word must end the segment: いうな is one, and いう does not end it.
  assert.equal(mark("といった", say), "といった");
  assert.equal(mark("いう", say), "いう(learned,null)");
  // The quotative takes the colour of the run that ends where it begins: ICU holds it in one
  // segment with いう, so leaving it plain would cut that segment in two on screen.
  assert.equal(mark("猫という", [["猫", "new", null], ...say], new Set([0, 1])), "猫(new,null) | と(new,null) | いう(learned,null)");
  assert.equal(mark("猫という", [["猫", "new", null], ...say]), "猫(new,null) | と(new,null) | いう(learned,null)");
  assert.equal(mark("食べるという", [["食べる", "new", null], ...say]), "食べる(new,null) | と(new,null) | いう(learned,null)");
  assert.equal(mark("猫だっていう", [["猫", "new", null], ...say]), "猫(new,null) | だって | いう(learned,null)");
  // A deck word at the start wins: という itself, when a card holds it.
  assert.equal(mark("猫という", [["という", "learning", null], ...say]), "猫 | という(learning,null)");
  // The rule is for いう alone: ICU keeps ところ, とおる, とまる and とくに whole because they are
  // words of their own, and a card for ころ (頃), おる, まる or くに paints none of them.
  assert.equal(mark("ところ", [["ころ", "new", null]], new Set([0])), "ところ");
  assert.equal(mark("ところ", [["ころ", "new", null]]), "ところ");
  assert.equal(mark("今のところ", [["今", "new", null], ["ころ", "new", null]]), "今(new,null) | のところ");
  assert.equal(mark("私のところに来て", [["ころ", "new", null]]), "私のところに来て");
  assert.equal(mark("道をとおる", [["おる", "new", null]]), "道をとおる");
  assert.equal(mark("バスがとまる", [["まる", "new", null]]), "バスがとまる");
  assert.equal(mark("とくに", [["くに", "new", null]], new Set([0])), "とくに");
  assert.equal(mark("とくに", [["くに", "new", null]]), "とくに");
  // って before any other word is cut off by ICU, so that word begins a segment of its own.
  assert.equal(mark("ってこと", [["こと", "new", null]]), "って | こと(new,null)");
});

test("markWords finds a kana verb or adjective in its forms, at a word boundary only", () => {
  // ICU cuts し|まっ|た, わか|っ|た, つく|っ|た, おい|しか|っ|た and 話し|かけ|て|いただく.
  assert.equal(mark("しまった", [["しまう", "learned", null]], new Set([0, 1, 3])), "しまった(learned,null)");
  assert.equal(mark("しまった", [["しまう", "learned", null]]), "しまった(learned,null)");
  assert.equal(mark("わかった", [["わかる", "learned", null]], new Set([0, 2, 3])), "わかった(learned,null)");
  assert.equal(mark("わかった", [["わかる", "learned", null]]), "わかった(learned,null)");
  assert.equal(mark("わかりました", [["わかる", "learned", null]]), "わかりました(learned,null)");
  assert.equal(mark("つくった", [["つくる", "learned", null]]), "つくった(learned,null)");
  assert.equal(mark("つくれば", [["つくる", "learned", null]]), "つくれば(learned,null)");
  assert.equal(mark("もらった", [["もらう", "learned", null]]), "もらった(learned,null)");
  assert.equal(mark("おいしかった", [["おいしい", "learned", null]]), "おいしかった(learned,null)");
  assert.equal(mark("おいしくない", [["おいしい", "learned", null]]), "おいしくない(learned,null)");
  assert.equal(mark("すごかった", [["すごい", "learned", null]]), "すごかった(learned,null)");
  assert.equal(mark("すごく", [["すごい", "learned", null]]), "すごく(learned,null)");
  assert.equal(mark("びっくりした", [["びっくりする", "learned", null]]), "びっくりした(learned,null)");
  assert.equal(mark("びっくりだ", [["びっくりする", "learned", null]]), "びっくり(learned,null) | だ");
  assert.equal(mark("かけて", [["かける", "learned", null]], new Set([0, 2])), "かけて(learned,null)");
  assert.equal(mark("話しかけて", [["かける", "learned", null]], new Set([0, 1, 2, 4])), "話し | かけて(learned,null)");
  assert.equal(mark("話しかけて", [["かける", "learned", null]]), "話し | かけて(learned,null)");
  assert.equal(mark("食べてしまった", [["食べる", "new", null], ["しまう", "learned", null]]), "食べて(new,null) | しまった(learned,null)");
  assert.equal(mark("食べさせてもらった", [["食べる", "new", null], ["もらう", "learned", null]]), "食べさせて(new,null) | もらった(learned,null)");
  // The form must end at a boundary, as the exact word must: いれば is いる and ば (ば is no first
  // piece), and a kana stem alone is no noun form (かけ in かけ|ら, いれ in い|れ|ば).
  assert.equal(mark("いれば", [["いれる", "learned", null]], new Set([0, 1, 2])), "いれば");
  assert.equal(mark("いれば", [["いれる", "learned", null]]), "いれば");
  assert.equal(mark("かけら", [["かける", "learned", null]], new Set([0, 2])), "かけら");
  assert.equal(mark("かけら", [["かける", "learned", null]]), "かけら");
  assert.equal(mark("かけに行く", [["かける", "learned", null]]), "かけに行く");
  assert.equal(mark("しまいこむ", [["しまう", "learned", null]], new Set([0])), "しまいこむ");
  assert.equal(mark("しまい", [["しまう", "learned", null]], new Set([0])), "しまい(learned,null)");
  // The one-kana stems stay exact: いう is not in いった, する not in した.
  assert.equal(mark("いった", [["いう", "learned", null]]), "いった");
  assert.equal(mark("した", [["する", "learned", null]]), "した");
  assert.equal(mark("いい", [["いい", "learned", null]]), "いい(learned,null)");
  assert.equal(mark("いいよ", [["いい", "learned", null]]), "いい(learned,null) | よ");
  // A kanji verb's forms end where endsWord() lets them; a kana verb's at a boundary, or where
  // ICU fused the form's ending with the particle after it (below). A segment that begins at
  // the word is no such fusion.
  assert.equal(mark("食べたよ", [["食べる", "learned", null]], new Set([0])), "食べた(learned,null) | よ");
  assert.equal(mark("たべたよ", [["たべる", "learned", null]], new Set([0])), "たべたよ");
  assert.equal(mark("たべたよ", [["たべる", "learned", null]], new Set([0, 3])), "たべた(learned,null) | よ");
});

test("markWords ends a kana verb's form inside the segment ICU made of its ending and a particle", () => {
  // ICU fuses the sentence-final particle with た and ます (わか|っ|たよ, かけ|たよ, でき|ますよ,
  // ちがい|ますよ), so the form ends at no boundary: it may end where the rest of a segment that
  // began inside the form is a particle. The particle itself stays plain.
  const wakaru = [["わかる", "new", null]];
  assert.equal(mark("わかったよ", wakaru, new Set([0, 2, 3])), "わかった(new,null) | よ");
  assert.equal(mark("わかったよ", wakaru), "わかった(new,null) | よ");
  assert.equal(mark("わかったね", wakaru), "わかった(new,null) | ね");
  assert.equal(mark("わかったか", wakaru), "わかった(new,null) | か");
  assert.equal(mark("わかったの", wakaru), "わかった(new,null) | の");
  assert.equal(mark("すごかったね", [["すごい", "new", null]]), "すごかった(new,null) | ね");
  assert.equal(mark("おいしかったよ", [["おいしい", "new", null]]), "おいしかった(new,null) | よ");
  assert.equal(mark("できたよ", [["できる", "new", null]], new Set([0, 2])), "できた(new,null) | よ");
  assert.equal(mark("できますよ", [["できる", "new", null]]), "できます(new,null) | よ");
  assert.equal(mark("かけたよ", [["かける", "new", null]]), "かけた(new,null) | よ");
  assert.equal(mark("もらったよ", [["もらう", "new", null]]), "もらった(new,null) | よ");
  assert.equal(mark("ちがいますよ", [["ちがう", "new", null]]), "ちがいます(new,null) | よ");
  // The guards stand: the rest of the segment must be a particle, and the segment must begin
  // after the word (ことば, あいだ, はなし and こんにちは are one segment with こと, あい, はな and
  // こんにち; は|しか, as ICU cuts it, holds はし at no boundary).
  assert.equal(mark("いれば", [["いれる", "new", null]]), "いれば");
  assert.equal(mark("かけら", [["かける", "new", null]]), "かけら");
  assert.equal(mark("かけに行く", [["かける", "new", null]]), "かけに行く");
  assert.equal(mark("しまいこむ", [["しまう", "new", null]], new Set([0])), "しまいこむ");
  assert.equal(mark("あるいは", [["ある", "new", null]]), "あるいは");
  assert.equal(mark("ことば", [["こと", "new", null]], new Set([0])), "ことば");
  assert.equal(mark("ことば", [["こと", "new", null]]), "ことば");
  assert.equal(mark("あいだ", [["あい", "new", null]]), "あいだ");
  assert.equal(mark("はなし", [["はな", "new", null]]), "はなし");
  assert.equal(mark("こんにちは", [["こんにち", "new", null]]), "こんにちは");
  assert.equal(mark("はしか", [["はし", "new", null]], new Set([0, 1])), "はしか");
  // かけたらしい and かけたくさん (かけ|たらしい, かけ|たくさん) stay plain: らしい and くさん are no
  // particles, and NOT_BEFORE keeps た from ending the form before them.
  assert.equal(mark("かけたらしい", [["かける", "new", null]]), "かけたらしい");
  assert.equal(mark("かけたくさん", [["かける", "new", null]]), "かけたくさん");
});

test("markWords takes a kana word found whole over a form of it that adds particles alone", () => {
  // A kana noun ending in a verb's kana has a stem to the tables (いく + つ), so the copula after
  // it reads as a form's tail (いくつ + です): the word itself, at a boundary, wins over that, and
  // the copula is a particle of its own, with the status and without the overbar. ICU cuts
  // いくつ|です|か, けっこう|です, いくつ|で|しょう, いくつ|で|した.
  const some = [["いくつ", "new", "heiban"]];
  assert.equal(mark("いくつですか", some), "いくつ(new,heiban) | ですか");
  assert.equal(mark("いくつですか", some, new Set([0, 3, 5])), "いくつ(new,heiban) | ですか");
  assert.equal(mark("いくつですか", some, [0, 1, 2, 3, 4, 5]), "いくつ(new,heiban) | ですか");
  assert.equal(mark("いくつでしょう", some), "いくつ(new,heiban) | でしょう");
  assert.equal(mark("いくつでした", some), "いくつ(new,heiban) | でした");
  assert.equal(mark("けっこうです", [["けっこう", "new", "heiban"]]), "けっこう(new,heiban) | です");
  assert.equal(mark("きょうです", [["きょう", "new", "atamadaka"]]), "きょう(new,atamadaka) | です");
  assert.equal(mark("ふつうですね", [["ふつう", "learned", "heiban"]]), "ふつう(learned,heiban) | ですね");
  assert.equal(mark("ほんとうです", [["ほんとう", "new", "heiban"]]), "ほんとう(new,heiban) | です");
  // A kana verb or adjective loses nothing: its copula is plain either way, and a form that adds
  // more than particles still wins.
  assert.equal(mark("わかるんだ", [["わかる", "new", "heiban"]]), "わかる(new,heiban) | んだ");
  assert.equal(mark("おいしいです", [["おいしい", "new", "heiban"]]), "おいしい(new,heiban) | です");
  assert.equal(mark("わかるまい", [["わかる", "new", "heiban"]]), "わかるまい(new,heiban)");
  assert.equal(mark("わかりました", [["わかる", "new", "heiban"]]), "わかりました(new,heiban)");
  // Another word's form still overtakes the word found whole, and a kanji word keeps the form.
  assert.equal(mark("あるいて", [["ある", "new", null], ["あるく", "learned", null]]), "あるいて(learned,null)");
  assert.equal(mark("食べるでしょう", [["食べる", "new", "heiban"]]), "食べるでしょう(new,heiban)");
});

test("markWords finds くれる after the て ICU fused with its く", () => {
  // ICU cuts 食|べ|てく|れ|た, 書|い|てく|れ|た and かけ|てく|れ|た: the index after such a て is a
  // boundary to the matcher, where くれる begins and かけて ends.
  const deck = [["食べる", "new", null], ["くれる", "learned", null]];
  assert.equal(mark("食べてくれた", deck, new Set([0, 1, 2, 4, 5])), "食べて(new,null) | くれた(learned,null)");
  assert.equal(mark("食べてくれた", deck), "食べて(new,null) | くれた(learned,null)");
  assert.equal(mark("食べてくれない", deck), "食べて(new,null) | くれない(learned,null)");
  assert.equal(mark("食べてくれました", deck), "食べて(new,null) | くれました(learned,null)");
  assert.equal(mark("食べてくれる", deck), "食べて(new,null) | くれる(learned,null)");
  assert.equal(mark("書いてくれた", [["書く", "new", null], ["くれる", "learned", null]]), "書いて(new,null) | くれた(learned,null)");
  assert.equal(mark("かけてくれた", [["かける", "new", null], ["くれる", "learned", null]], new Set([0, 2, 4, 5])), "かけて(new,null) | くれた(learned,null)");
  assert.equal(mark("かけてくれた", [["かける", "new", null], ["くれる", "learned", null]]), "かけて(new,null) | くれた(learned,null)");
  assert.equal(mark("読んでくれた", [["読む", "new", null], ["くれる", "learned", null]]), "読んで(new,null) | くれた(learned,null)");
  // Only a て or で at a start, and only before く: nothing opens inside てき or after a て that
  // is not one.
  assert.equal(mark("てくれた", [["くれる", "learned", null]], new Set([0])), "て | くれた(learned,null)");
  assert.equal(mark("てきた", [["きる", "learned", null]], new Set([0])), "てきた");
  assert.equal(mark("すてくれた", [["くれる", "learned", null]], new Set([0])), "すてくれた");
  // The caller's set of starts is left as it was.
  const starts = new Set([0, 1, 2, 4, 5]);
  markWords("食べてくれた", buildIndex(deck), starts);
  assert.deepEqual([...starts], [0, 1, 2, 4, 5]);
});

test("markWords gives a kana word whose stem is a particle no forms", () => {
  // からい's stem から is a particle: からかった would be its かっ + た. The word itself is found.
  const hot = [["からい", "new", null]];
  assert.deepEqual(buildIndex(hot).stems.get("から"), undefined);
  assert.equal(mark("猫をからかった", hot), "猫をからかった");
  assert.equal(mark("からかった", hot), "からかった");
  assert.equal(mark("からい", hot), "からい(new,null)");
  assert.equal(mark("ならった", [["ならう", "new", null]]), "ならった");
  assert.equal(mark("しかった", [["しかる", "new", null]]), "しかった");
  // The kanji twin keeps its stem.
  assert.equal(mark("辛かった", [["辛い", "new", null]]), "辛かった(new,null)");
  assert.deepEqual(buildIndex([["辛い", "new", null]]).stems.get("辛").map((item) => item.kind), ["i-adj"]);
});

test("markWords stays quick on a long line against a large deck", () => {
  const entries = [];
  for (let i = 0; i < 3000; i++) entries.push([`語${i}る`, "learned", "heiban"]);
  entries.push(["日本語", "new", null]);
  const index = buildIndex(entries);
  const line = "これは日本語の字幕です。".repeat(400);
  const started = Date.now();
  const runs = markWords(line, index);
  assert.equal(runs.filter((run) => run.text === "日本語" && run.status === "new").length, 400);
  assert.equal(runs.filter((run) => run.status).length, 400);
  assert.equal(runs.map((run) => run.text).join(""), line);
  assert.ok(Date.now() - started < 1000, "marking a long line must not take a second");
});

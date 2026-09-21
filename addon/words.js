"use strict";

/*
 * Word colours: which words of a subtitle have an Anki card, and what that card says about them.
 * Loaded before background.js and content.js (see manifest.json), so both sides read a note the
 * same way:
 *  - the background turns a deck's notes into [word, status, pitch] entries,
 *  - the content script builds an index from them and marks the words of every line.
 *
 * A card's word is a dictionary form; the subtitle has it conjugated (食べる, 食べました). The
 * matcher therefore knows a handful of endings: enough to find a verb or adjective in its usual
 * shapes without a morphological analyser. Everything here is pure; there is no DOM.
 */

const SHISUKO_WORDS = (() => {
  const STATUSES = Object.freeze(["new", "learning", "learned", "suspended"]);
  const PITCHES = Object.freeze(["heiban", "atamadaka", "nakadaka", "odaka"]);

  // A deck word longer than this is a sentence pasted into the word field, not a word.
  const MAX_WORD_LEN = 40;
  // Particles are never coloured, whatever the deck says: a card for は or のは (Yomitan looks
  // them up like any word) would otherwise paint the は of every line. Case, binding, adverbial,
  // conjunctive and sentence-final particles, the fusions Yomitan's dictionaries carry, and the
  // copula and auxiliaries a learner mines as words (です, だ, ます, ない, たい, the contraction ん),
  // which end nearly every line the same way.
  const PARTICLES = new Set([
    "は", "が", "を", "に", "へ", "と", "で", "の", "も", "や", "か", "ね", "よ", "な", "わ", "ぞ", "ぜ", "さ", "し", "て", "ば",
    "から", "まで", "より", "こそ", "さえ", "すら", "しか", "だけ", "ばかり", "ほど", "くらい", "ぐらい", "など", "なんて", "なんか",
    "きり", "っきり", "のみ", "だって", "とか", "って", "ってば", "やら", "だの", "なり", "ずつ", "だに", "ながら", "つつ", "たり",
    "けど", "けれど", "けれども", "のに", "ので", "のは", "のが", "のを", "のか", "には", "とは", "では", "へは", "とも", "にも",
    "でも", "へも", "への", "との", "での", "かも", "かな", "かしら", "っけ", "よね", "ねえ", "なあ", "かい", "ても", "たら", "なら",
    "だ", "だった", "だろう", "だろ", "です", "でした", "でしょう", "でしょ", "ます", "ません", "ました", "ない", "たい", "ん",
    "じゃ", "じゃん", "もん",
  ]);
  const PARTICLE_MAX_LEN = Math.max(...[...PARTICLES].map((piece) => piece.length));
  // A particle takes the colour of the word it attaches to (お風呂の, 中で, 学生です), up to this
  // many in a row (本にはね: には and ね).
  const PARTICLE_CHAIN_MAX = 3;
  // What a particle is not taken before: the kana that makes it the start of a verb ICU has cut
  // into single kana instead (猫|が|で|た, 猫|に|も|ら|っ|た, 猫|は|よ|か|っ|た), the common ones.
  // なら before ない, なく, なかっ, なけれ or ん is なる's negative (猫にならない), not the
  // conditional; で before て or た is 出る; な before に is 何, before れ, っ or る it is なる and
  // before で 撫でる; ね before て or た is 寝る; よ before か is よかった and before ん 呼んだ; の
  // before ん is 飲んだ (and のんびり); や before っ is やる; し before ま, れ, て or た is しまう,
  // しれない and する; も before ら is もらう and before て もてる; か before っ or え is 買う and
  // 帰る; と before っ is 取る.
  const PARTICLE_NOT_BEFORE = {
    なら: ["ない", "なく", "なかっ", "なけれ", "ん"],
    で: ["て", "た"],
    な: ["に", "れ", "っ", "る", "で"],
    ね: ["て", "た"],
    よ: ["か", "ん"],
    の: ["ん"],
    や: ["っ"],
    し: ["ま", "れ", "て", "た"],
    も: ["ら", "て"],
    か: ["っ", "え"],
    と: ["っ"],
  };
  // The particles no word begins with: を and へ are taken whatever kana follows them (猫|を|み|た,
  // 猫|を|た|べた), where が, で or も would be the first kana of a verb as often as not. Not は:
  // はいる, はしる, はなす and はじめる are common kana verbs.
  const PARTICLES_ONLY = new Set(["を", "へ"]);
  // The endings of いる that follow its い in a segment of their own: a single い before one of
  // them is いる (猫|も|い|た, 猫|に|い|て), a word for the particle before it, and so is the い ICU
  // fused with a one-kana particle (猫|がい|た, 猫|はい|て, 猫|とい|た, 猫|がい|ない, 猫|がい|ます,
  // 猫|がい|れ|ば: がい, はい and とい are words to it), where the particle ends at no boundary.
  const IRU_ENDINGS = ["た", "て", "ない", "なかっ", "なく", "ます", "まし", "ませ", "る", "れば", "よう", "たい"];
  // The て or で of a て-form ICU fuses with the く of the auxiliary after it (食|べ|てく|れ|た,
  // 書|い|てく|れ|た, かけ|てく|れ; not 読|んで|く|れ|た or 言|って|く|れ|た, which it cuts), so that
  // くれる never begins a segment there and かけて ends inside one: the index after such a て is
  // a boundary too.
  const TE_FORM = new Set(["て", "で"]);
  // The honorific prefixes ICU cuts off the word they front (お|風呂, ご|家族, お|仕事): the prefix
  // takes the word's colour. It keeps お茶, お前, お金, ご飯 and お母さん whole, and those are words
  // of their own, so 前 in a deck never colours お前.
  const HONORIFICS = new Set(["お", "ご"]);
  // The quotative pieces ICU keeps in one segment with いう (という, っていう, 彼|という|人), so
  // that いう never begins a segment: いう may begin right after one. Longest first. Only いう:
  // ICU cuts って off every other word (って|こと, って|もの) and keeps ところ, とおる, とまる and
  // とくに whole because they are words of their own, so ころ in a deck never colours ところ.
  const QUOTATIVES = ["って", "と"];
  const QUOTED_WORD = "いう";
  // The regexes below scan a line from every character when no bracket follows, so a passage in
  // the word field would cost its length squared. A line this long holds no word (the index drops
  // any over MAX_WORD_LEN, furigana brackets included), and a reading field this long is no
  // reading: a 20-kanji word with <ruby><rp> markup on every kanji fits.
  const MAX_WORD_FIELD_LEN = 8 * MAX_WORD_LEN;
  const MAX_READING_FIELD_LEN = 1000;
  // What stripMarkup() and parsePitch() read of a raw field at most. A field is third-party
  // content (a shared deck), so the tag patterns below stop at the next "<" rather than scanning
  // to the end of the field from every "<" that is never closed, and since an unclosed <rt> still
  // restarts the scan for its end tag, the length itself is bounded too: a word with ruby markup on
  // every kanji, or a {pitch-accents} field drawing four patterns of a ten-mora word (under 8,000
  // characters), is well within it.
  const MAX_FIELD_HTML_LEN = 16000;

  // A tag runs to the next ">" but never across a "<" (a literal "<" inside an attribute value
  // would end it early; Anki's editor writes &lt; for one).
  const TAGS = /<[^<>]*>/g;
  const ENTITIES = /&(nbsp|amp|lt|gt|quot|#39);/gi;
  const ENTITY_TEXT = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
  // Ruby readings, and the parentheses shown around them where ruby is not supported. HTML lets
  // the end tag of <rt> and <rp> be left out before the next <rt>, <rp> or </ruby>
  // (<ruby>食<rt>た</ruby>べる), so the reading runs to the next end tag of any of the three, the
  // rule match.js's RUBY reads by too, so a card's word and its sentence read alike. The end tag
  // goes with the match rather than being left to TAGS (a lookahead): that keeps a field of
  // unclosed <rt> at milliseconds, and TAGS would drop it anyway.
  const RT_RP = /<(?:rt|rp)\b[^<>]*>[\s\S]*?<\/(?:rt|rp|ruby)\b[^<>]*>/gi;
  const HAS_RT = /<rt\b/i;
  const RUBY = /<ruby\b[^<>]*>([\s\S]*?)<\/ruby\s*>/gi;
  // Run on the content of one <ruby>: a reading whose </rt> is left out ends at the next rt or
  // rp tag or at the end of that content.
  const RT = /<rt\b[^<>]*>([\s\S]*?)(?=<\/?(?:rt|rp|ruby)\b|$)/gi;
  const LINE_BREAKS = /<br\s*\/?>|<\/(?:p|div|li|tr)\s*>/gi;
  // Yomitan's furigana format: a space marks where a kanji run starts and its reading follows in
  // brackets (" 食[た]べる", "お 茶[ちゃ]"). $1 is the kanji, $2 the reading.
  const FURIGANA = /\s?(\S+?)\[([^\]]*)\]/g;
  const BRACKETS = /\[[^\]]*\]/g;
  const SPACE = /\s+/g;

  const HIRAGANA = /^\p{Script=Hiragana}$/u;
  const KATAKANA = /^\p{Script=Katakana}$/u;
  const KANJI_OR_KATAKANA = /[\p{Script=Han}\p{Script=Katakana}]/u;
  // What a word never ends before, short of a word boundary: a kanji or katakana continues it
  // (関係, 日本語), and so does ー. Tested on a two-character slice, so a kanji beyond the BMP counts.
  const KANJI_OR_KATAKANA_NEXT = /^[\p{Script=Han}\p{Script=Katakana}ーｰ]/u;
  // ー and ・ belong to neither script (Unicode files them under Common); a reading may hold them.
  const KANA_ONLY = /^[\p{Script=Hiragana}\p{Script=Katakana}ー・ｰ]+$/u;
  // The small kana that glide onto the mora before them; っ and ん are moras of their own.
  const SMALL_KANA = new Set([..."ゃゅょャュョぁぃぅぇぉァィゥェォヮゎ"]);

  function str(value) {
    return value === undefined || value === null ? "" : String(value);
  }

  function stripMarkup(html) {
    return str(html)
      .slice(0, MAX_FIELD_HTML_LEN)
      .replace(RT_RP, "")
      .replace(LINE_BREAKS, "\n")
      .replace(TAGS, "")
      .replace(ENTITIES, (_m, name) => ENTITY_TEXT[String(name).toLowerCase()] || "");
  }

  function plainText(html) {
    return stripMarkup(html).replace(SPACE, " ").trim();
  }

  // The word a card is about: its first line, without furigana. "" when the field holds nothing.
  function plainWord(html) {
    for (const raw of stripMarkup(html).split("\n")) {
      const line = raw.trimStart().slice(0, MAX_WORD_FIELD_LEN);
      const word = line.replace(FURIGANA, "$1").replace(BRACKETS, "").replace(SPACE, " ").trim();
      if (word) return word;
    }
    return "";
  }

  function isHiragana(ch) {
    return HIRAGANA.test(str(ch));
  }

  function isKatakana(ch) {
    return KATAKANA.test(str(ch));
  }

  function isKana(ch) {
    return isHiragana(ch) || isKatakana(ch);
  }

  function hasKanjiOrKatakana(text) {
    return KANJI_OR_KATAKANA.test(str(text));
  }

  function kanaOnly(text) {
    return KANA_ONLY.test(text);
  }

  function moraCount(kana) {
    let count = 0;
    for (const ch of str(kana)) {
      if (SMALL_KANA.has(ch)) continue;
      if (ch === "ー" || ch === "ｰ" || isKana(ch)) count++;
    }
    return count;
  }

  // The reading a field carries: the <rt> texts of its ruby, the brackets of its furigana, else
  // the field itself. "" unless what is left is kana, so a kanji field never counts as a reading.
  function readingOf(html) {
    let text = str(html);
    if (text.length > MAX_READING_FIELD_LEN) return "";
    if (HAS_RT.test(text)) {
      text = text.replace(RUBY, (_m, inner) => {
        const parts = [];
        for (const found of inner.matchAll(RT)) parts.push(found[1]);
        return parts.length ? parts.join("") : inner;
      });
    }
    const reading = plainText(text).replace(FURIGANA, "$2").replace(SPACE, "");
    return kanaOnly(reading) ? reading : "";
  }

  // Yomitan writes the pattern in one of three ways: {pitch-accent-categories} names it,
  // {pitch-accent-positions} gives the mora the pitch drops after ("[2]", or a list of them), and
  // {pitch-accents} draws it: one <span> per mora, styled inline since Anki keeps no stylesheet
  // ("display:inline-block;position:relative;"), holding the mora and an empty line <span>
  // ("border-color:currentColor;…") whose style is a top border on a high mora and a right border
  // on the mora the pitch drops after; no right border anywhere is heiban. Several patterns come
  // as <ol><li>…</li></ol>, and the first counts, as with the positions. A nasal mora wraps its
  // kana in a second inline-block <span>, so the moras are counted by their line spans.
  const LIST_ITEM = /<li\b/i;
  const MORA_SPAN = /<span style="[^"<>]*display:\s*inline-block[^"<>]*"[^<>]*>/i;
  const MORA_LINE = /<span style="[^"<>]*border-color:[^"<>]*"[^<>]*>/i;
  const DROP_LINE = /border-right-width/i;
  const HAS_TAG = /<[a-z]/i;

  // The drop position and the mora count that markup draws, or null when the value holds none.
  function drawnPitch(raw) {
    for (const piece of raw.split(LIST_ITEM)) {
      const lines = [];
      for (const chunk of piece.split(MORA_SPAN).slice(1)) {
        const line = MORA_LINE.exec(chunk);
        if (line) lines.push(line[0]);
      }
      if (lines.length) return { n: lines.findIndex((line) => DROP_LINE.test(line)) + 1, moras: lines.length };
    }
    return null;
  }

  const CATEGORY = /heiban|平板|atamadaka|頭高|nakadaka|中高|odaka|尾高/i;
  const CATEGORY_OF = {
    heiban: "heiban",
    平板: "heiban",
    atamadaka: "atamadaka",
    頭高: "atamadaka",
    nakadaka: "nakadaka",
    中高: "nakadaka",
    odaka: "odaka",
    尾高: "odaka",
  };
  const POSITION = /\[(\d+)\]/;
  const DIGITS_ONLY = /^[\d\s]+$/;
  const DOWNSTEP = "ꜜ";

  // A position alone does not name the pattern: the drop after the last mora is odaka, earlier
  // nakadaka, so the mora count comes from the drawn moras, the pitch text, the reading or the
  // word, whichever is kana. Unknown counts read as nakadaka, the more common of the two. Plain
  // text may also mark the drop with ꜜ ("はしꜜ") or, being kana alone, mean heiban; markup that
  // draws nothing this reads is not a pattern.
  function parsePitch(text, reading, word) {
    const raw = str(text).slice(0, MAX_FIELD_HTML_LEN);
    const plain = plainText(raw);
    if (!plain) return null;
    const named = CATEGORY.exec(plain);
    if (named) return CATEGORY_OF[named[0].toLowerCase()];

    let n = null;
    let moras = -1;
    const drawn = drawnPitch(raw);
    const position = POSITION.exec(plain);
    const drop = plain.indexOf(DOWNSTEP);
    if (drawn) ({ n, moras } = drawn);
    else if (position) n = Number(position[1]);
    else if (DIGITS_ONLY.test(plain)) n = Number(/\d+/.exec(plain)[0]);
    else if (drop >= 0) n = moraCount(plain.slice(0, drop));
    else if (!HAS_TAG.test(raw) && kanaOnly(plain.replace(SPACE, ""))) n = 0;
    if (n === null) return null;
    if (n === 0) return "heiban";
    if (n === 1) return "atamadaka";

    if (moras < 0) {
      const kana = plain.split(DOWNSTEP).join("").replace(SPACE, "");
      if (kanaOnly(kana)) moras = moraCount(kana);
      else if (kanaOnly(str(reading))) moras = moraCount(reading);
      else if (kanaOnly(str(word))) moras = moraCount(word);
    }
    return n === moras ? "odaka" : "nakadaka";
  }

  const PITCH_FIELD = /pitch|accent|アクセント/i;
  const READING_FIELD = /reading|furigana|読み|よみ/i;
  // A sentence's reading (SentenceFurigana, 例文読み) is not the word's: its mora count would
  // make every odaka word nakadaka on a note type without a reading field for the word.
  const SENTENCE_FIELD = /sentence|文/i;

  // A note's fields as AnkiConnect's notesInfo lists them, lowest `order` first.
  function fieldsInOrder(fields) {
    const list = [];
    for (const [name, field] of Object.entries(fields || {})) {
      if (!field || typeof field !== "object") continue;
      const order = Number(field.order);
      list.push({ name, value: str(field.value), order: Number.isFinite(order) ? order : Infinity });
    }
    return list.sort((a, b) => a.order - b.order);
  }

  // The pitch field is the one the settings name, else every field whose name says pitch in
  // order, the first with a readable value deciding: a graph field ({pitch-accent-graphs}, an SVG
  // with no text) before a position field must not hide the position.
  function pitchOf(fields, settings) {
    const s = settings || {};
    const list = fieldsInOrder(fields);
    const wanted = str(s.ankiPitchField).trim();
    const named = wanted ? list.find((field) => field.name === wanted) : undefined;
    const candidates = named ? [named] : list.filter((field) => PITCH_FIELD.test(field.name));
    if (!candidates.length) return null;
    // The same rule as the background's noteSummary(): the named field, else the first one.
    const wordName = str(s.ankiWordField).trim();
    const wordField = wordName ? list.find((field) => field.name === wordName) : list.find((field) => field.order === 0);
    const word = wordField ? plainWord(wordField.value) : "";
    for (const pitch of candidates) {
      const readingField = list.find((field) => field !== pitch && READING_FIELD.test(field.name) && !SENTENCE_FIELD.test(field.name));
      const reading = readingField ? readingOf(readingField.value) : "";
      const found = parsePitch(pitch.value, reading, word);
      if (found) return found;
    }
    return null;
  }

  // `sets` holds the note ids of the five findNotes queries the background runs on a deck.
  function statusOf(sets, noteId) {
    const has = (name) => {
      const set = sets && sets[name];
      return !!set && typeof set.has === "function" && set.has(noteId);
    };
    if (!has("unsuspended")) return has("suspended") ? "suspended" : null;
    if (has("new")) return "new";
    if (has("learning")) return "learning";
    if (has("review")) return "learned";
    // Unsuspended, yet in none of the three sets. On Anki 2.1.44 and later every unsuspended
    // card's type is new, learn or review, so nothing reaches this line; an older Anki, or a
    // set a search left out, gets the middle guess rather than no colour.
    return "learning";
  }

  const PROGRESS = { new: 0, learning: 1, learned: 2 };

  // Two notes for one word: the one with the least progress decides, and a suspended note only
  // counts when there is no other.
  function mergeStatus(a, b) {
    const x = STATUSES.includes(a) ? a : null;
    const y = STATUSES.includes(b) ? b : null;
    if (x === null) return y;
    if (y === null) return x;
    if (x === "suspended") return y;
    if (y === "suspended") return x;
    return PROGRESS[x] <= PROGRESS[y] ? x : y;
  }

  // ------------------------------------------------------------ the matcher

  // Conjugation tables. A dictionary form is cut before its ending and remembered by that stem;
  // in the text, the stem must be followed by a first piece of its kind (the inflected ending)
  // and then by any run of tail pieces (auxiliaries), so 食べる finds 食べました and 書く finds
  // 書かない. A kana-only word needs a stem of two kana at least (かける, しまう, おいしい; いう,
  // する, くる, みる and いい match exactly only: a stem of one kana would be found in every line)
  // and, like its exact form, must end at a word boundary.
  const FIRST_PIECES = {
    suru: ["する", "し", "さ", "せ", "す", "すれ"],
    "i-adj": ["い", "く", "かっ", "けれ", "さ", "そう", "くて", "くない", "ければ"],
    ru: [
      "る", "た", "て", "ない", "なく", "なきゃ", "ます", "まし", "ませ", "ましょ", "たい", "たく", "たかっ", "たら", "たり", "ても", "ちゃ", "とく",
      "そう", "ながら", "なさい", "まい", "られ", "させ", "よう", "れば", "ろ", "よ", "ず", "ん", "ら", "り", "れ", "っ", "なかっ", "なけれ",
    ],
    う: [..."わいうえおっ"],
    く: [..."かきくけこいっ"],
    ぐ: [..."がぎぐげごい"],
    す: [..."さしすせそ"],
    つ: [..."たちつてとっ"],
    ぬ: [..."なにぬねのん"],
    ぶ: [..."ばびぶべぼん"],
    む: [..."まみむめもん"],
  };
  const TAIL_PIECES = [
    "た", "て", "で", "だ", "ない", "なく", "なかっ", "なけれ", "なきゃ", "ます", "まし", "ませ", "ん", "たい", "たく", "たかっ",
    "れ", "れる", "られ", "られる", "せ", "せる", "させ", "させる", "ば", "う", "よ", "よう", "ろ", "る", "い", "けれ", "ず",
    "ちゃ", "じゃ", "てる", "でる", "てい", "でい", "いる", "いた", "いて", "います", "いない", "ましょ", "でし", "でしょ", "です",
    "たら", "だら", "たり", "だり", "ても", "でも", "ながら", "なさい", "まい", "とく", "どく", "いか", "いき", "いく", "いけ", "いこ", "いっ",
    "いただく", "いただき", "いただけ", "いただい", "いただこ", "いただか", "っ", "ー",
  ];
  // 使わせていただきました is わ + せ + て + いただき + まし + た: five tails after the first piece.
  const MAX_TAILS = 5;
  const GODAN = new Set([..."うくぐすつぬぶむ"]);
  // The kana an ichidan verb's stem ends in (食べ, 起き, 見せ, 感じ); a godan る verb's stem ends in
  // the a-row (当た, 変わ, 終わ) or a kanji (帰, 走).
  const IE_ROW = /^[いきぎしじちぢにひびぴみりえけげせぜてでねへべぺめれ]$/u;

  // A tail of one kana is also the first kana of many words (だけ, ため, うち, ばかり, ずっと,
  // せい, いい), so every such tail, and the auxiliaries いる, いく and いただく, names what it may
  // follow: a tail or a first piece by its text, a godan first piece by its row (a, e, o) or
  // "onbin", the 音便 kana before た and て, a する verb's さ, せ and す as "suru:さ" and so on.
  // So だ follows ん (食べるんだ) and not る (食べるだけ), た follows 音便, まし and て (書いた,
  // 食べました, 食べてた) and not る or た (食べるため, 食べたため), う follows the o-row (行こう) and
  // not い (高いうち), ん follows the forms it shortens (食べるん, 食べません, 行かん, 食べてん) and
  // not ちゃ (食べてちゃんと). Longer tails follow anything, as before, but for よう: it is the
  // volitional only after the ichidan-like pieces and a する verb's し (食べられよう, 食べていよう,
  // 勉強しよう), and after る, た, ない, the u-row or an adjective it is 様 (食べるように, 行くようだ).
  // A stem that conjugates like an ichidan verb (られ, させ, the passive せ and れ, the potential
  // e-row, いる's い) takes what 食べ takes, except that た after いる's stem is the tail いた (食べて
  // + いた, never て + い + た), so that one rule below keeps 食べていただく from ending inside いただく.
  const GODAN_ROWS = ["a", "i", "u", "e", "o"];
  const ICHIDAN_LIKE = ["e", "られ", "させ", "せ", "れ", "い", "てい", "でい"];
  const AFTER = {};
  const follows = (pieces, prevs) => {
    for (const piece of pieces) AFTER[piece] = new Set(prevs);
  };
  follows(["た", "だ"], ["onbin", "shi", "っ", "し", "かっ", "なかっ", "たかっ", "まし", "でし", "そう", "て", "で", "いっ", "いただい", "ん", "e", "られ", "させ", "せ", "れ"]);
  follows(["て", "で", "てい", "でい", "てる", "でる"], ["onbin", "shi", "っ", "し", "まし", "でし", "なく", "たく", "ない", "くない", "て", "で", "いっ", "いただい", "ん", ...ICHIDAN_LIKE]);
  follows(["う"], ["o", "よ", "ろ", "いこ", "いただこ", "ましょ", "でしょ", "ちゃ", "じゃ"]);
  follows(["ず"], ["a", "ら", "いただか", "suru:せ", ...ICHIDAN_LIKE]);
  follows(["ば"], ["e", "れ", "すれ", "いけ", "いただけ", "けれ", "なけれ"]);
  follows(["せ"], ["a", "ら", "suru:さ"]);
  follows(["れ"], ["a", "ら", "suru:さ", "いただけ", ...ICHIDAN_LIKE]);
  follows(["ろ"], ["し", "だ", ...ICHIDAN_LIKE]);
  follows(["る"], ["て", "で", "いけ", "いただけ", ...ICHIDAN_LIKE]);
  follows(["よ"], ["suru:せ"]);
  // The volitional of the ichidan-like pieces, not the potential's (書けよう is no form).
  follows(["よう"], ["し", ...ICHIDAN_LIKE.filter((piece) => piece !== "e")]);
  // The volitional without its う (行こっか, 行こー).
  follows(["っ", "ー"], ["o"]);
  follows(["なきゃ"], ["a", "ら", "し", "く", "たく", "て", "で", "じゃ", ...ICHIDAN_LIKE]);
  follows(["い", "いる", "いた", "いて", "います", "いない", "いか", "いき", "いく", "いけ", "いこ", "いっ"], ["て", "で", "ちゃ", "じゃ"]);
  follows(["いただく", "いただき", "いただけ", "いただい", "いただこ", "いただか"], ["て", "で"]);
  follows(
    ["ん"],
    [
      "a", "u", "e", "adj", "ら", "る", "た", "だ", "て", "で", "ない", "くない", "ます", "ませ", "です", "たい", "れ", "れる", "られ", "られる", "せ", "せる",
      "させ", "させる", "suru:せ", "suru:す", "てる", "でる", "いる", "いた", "いない", "いく", "いけ", "いただく", "いただけ", "とく", "どく", "する", "じゃ",
    ],
  );
  // What is no form on its own, so that a span never ends right after it: the stem of いる,
  // いく or いただく (食べてい, 見ていか, 見ていただい), a godan verb's a-row and o-row (行か needs
  // ない, 行こ needs う; the ru piece ら is the a-row of 帰る), its 音便 kana (書い, 行っ, 飲ん: 行い
  // is 行う's noun, 引っかかる is a verb of its own), a する verb's さ, せ and す (勉強さ needs
  // せる, 勉強す is 勉強すべき's), かっ, なかっ and たかっ (they only reach かった: 見たかっこいい is
  // 見た and かっこいい), けれ and なけれ (they only reach ければ), まし and でし (they only reach
  // ました, まして and でした).
  const OPEN_TAILS = new Set([
    "い", "てい", "でい", "いか", "いこ", "いっ", "いただい", "いただこ", "いただか", "a", "o", "onbin", "ら", "suru:さ", "suru:せ",
    "suru:す", "かっ", "なかっ", "たかっ", "けれ", "なけれ", "まし", "でし",
  ]);
  // What the 音便 kana may be followed by: the た and て pieces only. Every other tail after it
  // begins another word (行います, 行いたい, 彼の行いです are 行う's, 飲んどけ is 飲む and どけ), so
  // the pieces it reaches are listed rather than what each of them may follow.
  const NEXT = {
    onbin: new Set(["た", "だ", "て", "で", "てる", "でる", "てい", "でい", "ちゃ", "じゃ", "とく", "どく", "たら", "だら", "たり", "だり", "ても", "でも"]),
  };
  // What a piece may not end a span before: the kana that makes it the start of another word or
  // auxiliary instead. ても before ら is 〜てもらう (the end after 食べて remains), たら before しい,
  // しく, しか, しけ or しさ is 〜たらしい (食べた stays), たく before せ, さ or ら is くせに, たくさん
  // or くらい (and た before くさん: 食べてたくさん is 食べて and たくさん, 食べてたくせに keeps 食べてた),
  // いき before な is いきなり, いく before ら is いくら, and いた before だ is いただく: whether the
  // text reaches いただく through its own tails or not, the span never ends inside it.
  const NOT_BEFORE = {
    ても: ["ら"],
    でも: ["ら"],
    たら: ["しい", "しく", "しか", "しけ", "しさ"],
    だら: ["しい", "しく", "しか", "しけ", "しさ"],
    たく: ["せ", "さ", "ら"],
    た: ["くさん"],
    いき: ["な"],
    いく: ["ら"],
    いた: ["だ"],
  };

  // Whether the text at `pos` begins the word that `prev` may not end a span before.
  function startsWordAfter(prev, text, pos) {
    const next = NOT_BEFORE[prev];
    return !!next && next.some((kana) => text.startsWith(kana, pos));
  }

  function firstRole(kind, piece) {
    // An adjective's い is its ending, not いる's stem: 高いだけ is 高い and だけ.
    if (kind === "i-adj" && piece === "い") return "adj";
    // A する verb's さ, せ and す are not the adjective's さ (高さ is a form, 勉強さ is not).
    if (kind === "suru" && (piece === "さ" || piece === "せ" || piece === "す")) return "suru:" + piece;
    // A る verb's っ is the 音便 kana of a godan one (取った), no form alone (取っかかり).
    if (kind === "ru" && piece === "っ") return "onbin";
    if (!GODAN.has(kind)) return piece;
    const row = FIRST_PIECES[kind].indexOf(piece);
    // A す verb's し takes た and て like the 音便 kana (話した), but it is a form alone (話し, the
    // noun) and takes ます (話します), so it has a role of its own.
    if (kind === "す" && row === 1) return "shi";
    return row >= GODAN_ROWS.length ? "onbin" : GODAN_ROWS[row];
  }

  function table(pieces) {
    return Object.freeze({ pieces: new Set(pieces), maxLen: Math.max(...pieces.map((piece) => piece.length)) });
  }

  const FIRST = {};
  for (const [kind, pieces] of Object.entries(FIRST_PIECES)) FIRST[kind] = table(pieces);
  const TAIL = table(TAIL_PIECES);

  function stemOf(word) {
    const least = hasKanjiOrKatakana(word) ? 1 : 2;
    const found = cutStem(word, least);
    // A kana stem that is a particle gets no forms: からかった would be からい's かっ + た, and no
    // form of an adjective or verb in speech begins with から, なら, かな or しか (習う, 叶う and
    // 叱る written in kana match exactly only).
    return found && PARTICLES.has(found.stem) ? null : found;
  }

  function cutStem(word, least) {
    if (word.length >= least + 2 && word.endsWith("する")) return { stem: word.slice(0, -2), kind: "suru" };
    if (word.length < least + 1) return null;
    const last = word.slice(-1);
    if (last === "い") return { stem: word.slice(0, -1), kind: "i-adj" };
    if (last === "る") return { stem: word.slice(0, -1), kind: "ru" };
    if (GODAN.has(last)) return { stem: word.slice(0, -1), kind: last };
    return null;
  }

  // entries: [word, status, pitch] per note. One word from two notes is merged. The index holds
  // Maps keyed by the exact word and by the stem, so a position in the text costs a few lookups
  // whatever the size of the deck.
  function buildIndex(entries) {
    const exact = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!Array.isArray(entry)) continue;
      const word = str(entry[0]).trim();
      if (!word || word.length > MAX_WORD_LEN || PARTICLES.has(word)) continue;
      const status = STATUSES.includes(entry[1]) ? entry[1] : null;
      const pitch = PITCHES.includes(entry[2]) ? entry[2] : null;
      const known = exact.get(word);
      if (known) {
        known.status = mergeStatus(known.status, status);
        if (known.pitch === null) known.pitch = pitch;
      } else {
        // A word without kanji or katakana must end at a word boundary of the text, else ある is
        // found inside あるいは.
        exact.set(word, { word, status, pitch, bounded: !hasKanjiOrKatakana(word) });
      }
    }
    const stems = new Map();
    const heads = new Set();
    let maxLen = 0;
    let maxStemLen = 0;
    for (const entry of exact.values()) {
      Object.freeze(entry);
      heads.add(entry.word[0]);
      maxLen = Math.max(maxLen, entry.word.length);
      const found = stemOf(entry.word);
      if (!found) continue;
      const list = stems.get(found.stem);
      if (list) list.push({ entry, kind: found.kind });
      else stems.set(found.stem, [{ entry, kind: found.kind }]);
      maxStemLen = Math.max(maxStemLen, found.stem.length);
    }
    return Object.freeze({ size: exact.size, exact, stems, heads, maxLen, maxStemLen });
  }

  let segmenter = null;

  // Where a word may begin. ICU's dictionary segmentation keeps あるいは in one piece and cuts
  // これは into これ|は; without it, anywhere.
  function wordStarts(text) {
    const s = str(text);
    const starts = new Set([0]);
    if (segmenter === null) {
      try {
        segmenter =
          typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
            ? new Intl.Segmenter("ja", { granularity: "word" })
            : false;
      } catch (err) {
        segmenter = false;
      }
    }
    if (segmenter) {
      try {
        for (const piece of segmenter.segment(s)) starts.add(piece.index);
        return starts;
      } catch (err) {
        // Fall through: every index.
      }
    }
    for (let i = 1; i < s.length; i++) starts.add(i);
    return starts;
  }

  // Every end reachable from `pos`, after the piece `prev`, with up to `left` tail pieces, added
  // to `ends`. Taking the longest piece each time is not enough (泳いでいる is で+いる, not
  // でい+る), so every split is tried; the table is small and the depth is five.
  function tailEnds(text, pos, prev, left, ends) {
    if (!OPEN_TAILS.has(prev) && !startsWordAfter(prev, text, pos)) ends.add(pos);
    if (left === 0) return;
    const next = NEXT[prev];
    for (let len = Math.min(TAIL.maxLen, text.length - pos); len >= 1; len--) {
      const piece = text.slice(pos, pos + len);
      if (!TAIL.pieces.has(piece)) continue;
      if (next && !next.has(piece)) continue;
      const after = AFTER[piece];
      if (after && !after.has(prev)) continue;
      tailEnds(text, pos + len, piece, left - 1, ends);
    }
  }

  // Whether `stop` is the end of the text or a word boundary.
  function atBoundary(text, stop, starts) {
    return stop === text.length || starts.has(stop);
  }

  // Where a form of a bounded word beginning at `from` may end: at a boundary, or inside the
  // segment ICU made of the form's ending and the particle after it (わか|っ|たよ, かけ|たよ,
  // でき|ますよ, ちがい|ますよ: the ending never ends at a boundary there), that is when the
  // segment holding `stop` begins after `from` and what remains of it is a particle. A segment
  // beginning at `from` is no such fusion: ことば, あいだ, はなし and こんにちは are one segment
  // with こと, あい, はな and こんにち, and a card for one of those paints none of them. The exact
  // word has no ending to be fused and ends at a boundary only (はし in は|しか, as ICU cuts it).
  function boundedEnd(text, from, stop, starts) {
    if (atBoundary(text, stop, starts)) return true;
    let seg = stop;
    while (seg > from && !starts.has(seg)) seg--;
    return seg > from && particleShapes(text, stop, starts).length > 0;
  }

  // Whether a span may end at `stop`: at the end of the text, at a word boundary, or before
  // anything but a kanji, katakana or ー. ICU keeps a compound in one segment, so 関 is not
  // coloured in 関係, 飲み not in 飲み物 and 日本 not in 日本語, while 見た may end before 犬
  // (見|た|犬) and 電話 before 番号 (電話|番号).
  function endsWord(text, stop, starts) {
    if (atBoundary(text, stop, starts)) return true;
    return !KANJI_OR_KATAKANA_NEXT.test(text.slice(stop, stop + 2));
  }

  // Where a form of the word whose stem ends at `pos` ends, or -1 when the text there is no form
  // of it: the furthest end the pieces reach that a word may end at. A する verb is also its noun
  // alone (勉強 in 勉強が), and so is an ichidan verb's stem, which ends in an i-row or e-row kana,
  // at a word boundary (食べ in 食べに行く, 助け in 助けを呼ぶ, 考え, 流れ: the 連用形 is the noun).
  // The boundary keeps it out of a compound ICU holds together (見せ in 見せかけ, 生き in 生きがい);
  // a godan る verb's stem ends in the a-row (当た, 変わ) and is no form (its noun is the り piece,
  // 当たり, found through the tables like 話し and 動き); every other kind needs its first piece,
  // since a bare stem ending in a kanji is another word (走 in 走者, 見 in 見物). A `bounded`
  // entry (a kana-only word, beginning at `from`) gets no bare `ru` stem (its `suru` noun stays,
  // at a boundary: びっくり in びっくり|だ), and its forms end where boundedEnd() admits: ICU cuts
  // a kana run it does not know into single kana (い|れ|ば, かけ|ら), where かけ would be かける's
  // noun and いれ いれる's at every such cut.
  function continuationEnd(text, from, pos, kind, starts, bounded) {
    const first = FIRST[kind];
    const ends = new Set();
    if (kind === "suru" || (kind === "ru" && !bounded && IE_ROW.test(text[pos - 1]) && atBoundary(text, pos, starts))) ends.add(pos);
    for (let len = Math.min(first.maxLen, text.length - pos); len >= 1; len--) {
      const piece = text.slice(pos, pos + len);
      if (!first.pieces.has(piece)) continue;
      // 行く is the one く verb whose 音便 is っ alone (行った): 行い is 行う's (行いたい, 行いました).
      if (piece === "い" && kind === "く" && text[pos - 1] === "行") continue;
      tailEnds(text, pos + len, firstRole(kind, piece), MAX_TAILS, ends);
    }
    let best = -1;
    for (const end of ends) if (end > best && (bounded ? boundedEnd(text, from, end, starts) : endsWord(text, end, starts))) best = end;
    return best;
  }

  // The longest word found at `i`; on a tie the exact word beats a conjugation.
  function matchAt(text, i, index, starts) {
    const remaining = text.length - i;
    let end = i;
    let found = null;
    for (let len = Math.min(index.maxLen, remaining); len >= 1; len--) {
      const entry = index.exact.get(text.slice(i, i + len));
      if (!entry) continue;
      const stop = i + len;
      if (entry.bounded ? !atBoundary(text, stop, starts) : !endsWord(text, stop, starts)) continue;
      end = stop;
      found = entry;
      break;
    }
    for (let len = Math.min(index.maxStemLen, remaining); len >= 1; len--) {
      const list = index.stems.get(text.slice(i, i + len));
      if (!list) continue;
      for (const { entry, kind } of list) {
        const stop = continuationEnd(text, i, i + len, kind, starts, entry.bounded);
        if (stop > end) {
          end = stop;
          found = entry;
        }
      }
    }
    return found ? { end, entry: found } : null;
  }

  // Whether `at` holds the い of いる: い, then a boundary and one of IRU_ENDINGS.
  function iruAt(text, at, starts) {
    return text[at] === "い" && starts.has(at + 1) && IRU_ENDINGS.some((piece) => text.startsWith(piece, at + 1));
  }

  // The lengths of the pieces in a particle's shape at `pos`, longest first: the entries of
  // PARTICLES there that end at a word boundary (には and に in 本|に|は, で in 中|で; not に in
  // 猫|にんじん, not と in 食べる|という) or, one kana long, right before the い of いる that ICU
  // fused with them (が in 猫|がい|た).
  function particleShapes(text, pos, starts) {
    const lens = [];
    for (let len = Math.min(PARTICLE_MAX_LEN, text.length - pos); len >= 1; len--) {
      if (!PARTICLES.has(text.slice(pos, pos + len))) continue;
      if (atBoundary(text, pos + len, starts) || (len === 1 && iruAt(text, pos + 1, starts))) lens.push(len);
    }
    return lens;
  }

  // Whether the particle of `len` characters at `pos` is one PARTICLE_NOT_BEFORE refuses there.
  function refusedParticle(text, pos, len) {
    const next = PARTICLE_NOT_BEFORE[text.slice(pos, pos + len)];
    return !!next && next.some((kana) => text.startsWith(kana, pos + len));
  }

  // The lengths of the particles at `pos` that a colour may run on to: the shapes not refused.
  function particleLens(text, pos, starts) {
    return particleShapes(text, pos, starts).filter((len) => !refusedParticle(text, pos, len));
  }

  // Whether what begins at `at` reads as a word rather than as kana ICU has cut up: the end of
  // the text, anything but hiragana (a kanji, katakana, punctuation, a space), a piece in a
  // particle's shape (taken or not: 出て in 猫|が|で|て|きた lets が stand, and so does の in
  // 猫|が|の|ぼ|っ|た), the い of いる (猫|も|い|た, 猫|がい|た), or a segment of two kana or more
  // not ending in っ.
  function wordFollows(text, at, starts) {
    if (at === text.length || !isHiragana(text[at]) || particleShapes(text, at, starts).length || iruAt(text, at, starts)) return true;
    let end = at + 1;
    while (end < text.length && !starts.has(end)) end++;
    return end - at >= 2 && text[end - 1] !== "っ";
  }

  // The particles after a word that take its colour, as their lengths in order: entries of
  // PARTICLES in a row, each ending at a word boundary, the run reaching furthest of those that
  // a word follows (wordFollows(), or a deck word, with or without an honorific or quotative in
  // front: の in 私|の|お|風呂), or that end in one of PARTICLES_ONLY, cut to PARTICLE_CHAIN_MAX.
  // ICU cuts a kana verb it does not know into single kana (猫|が|で|た, 猫|に|も|ら|っ|た,
  // 猫|は|よ|か|っ|た), and the first of them is a particle as often as not: so a particle before
  // a single kana that is no particle is not taken (猫|が|す|わっ|た colours nothing past 猫),
  // PARTICLE_NOT_BEFORE names the verbs met most (が is taken in 猫がでた and 猫がでてきた, に in
  // 猫にもらった, never にも, は in 猫はねた and 猫はよかった, かも in 猫かもしれない, and で, も, ね,
  // よ and し are not, rather than でた, もらった, ねた, よかった and しれない being painted), and a
  // verb cut into a particle and two kana or more (猫|が|に|げた, 猫|を|さ|が|した) is a known gap.
  // A deck word at that position ends the chain and counts as a word (かもしれない in the deck,
  // in 猫|かも|し|れ|ない). Without a segmenter every segment is one kana, so a particle is then
  // taken at the end of the text, before anything but hiragana, before another particle or
  // before the い of いる only.
  function particlesAt(text, pos, starts, tryAt) {
    let best = [];
    let bestEnd = pos;
    const walk = (at, lens) => {
      const word = starts.has(at) && tryAt(at);
      const last = lens.length ? text.slice(at - lens[lens.length - 1], at) : "";
      if (lens.length && (word || PARTICLES_ONLY.has(last) || wordFollows(text, at, starts))) {
        const taken = lens.slice(0, PARTICLE_CHAIN_MAX);
        const end = pos + taken.reduce((sum, len) => sum + len, 0);
        if (end > bestEnd) {
          best = taken;
          bestEnd = end;
        }
      }
      // A chain of PARTICLE_CHAIN_MAX was recorded above whenever a further particle follows
      // (its shape makes wordFollows() true), and a longer walk cuts to the same three pieces,
      // so it never does better: this keeps the walk at PARTICLE_MAX_LEN ** PARTICLE_CHAIN_MAX
      // nodes, where a line of alternating particles (猫のにのにのに…) would else cost 2 ** n.
      if (word || lens.length >= PARTICLE_CHAIN_MAX) return;
      for (const len of particleLens(text, at, starts)) {
        lens.push(len);
        walk(at + len, lens);
        lens.pop();
      }
    };
    walk(pos, []);
    return best;
  }

  // The word boundaries the matcher goes by: `starts`, plus the index after a て or で that ICU
  // fused with the く of the auxiliary behind it (TE_FORM: 食|べ|てく|れ|た), where a word may
  // begin and a bounded one end. `starts` itself is never written (the content script keeps
  // it per cue): the set is copied when there is something to add.
  function boundsOf(text, starts) {
    let bounds = starts;
    for (const pos of starts) {
      if (!TE_FORM.has(text[pos]) || text[pos + 1] !== "く" || starts.has(pos + 1)) continue;
      if (bounds === starts) bounds = new Set(starts);
      bounds.add(pos + 1);
    }
    return bounds;
  }

  // The text as runs, in order: a matched run carries its entry's status and pitch, the text
  // between matches is one run with neither. `starts` is the set of indices a word may begin at.
  // Three things take a colour without being a deck word: the honorific prefix ICU cut off the
  // word (お in お|風呂, its status and no pitch, before the word's own run), the particles after
  // a word (の in お風呂の, で in 中で, each a run of its own with the word's status), and a
  // quotative that fronts a word inside one segment (って in っていう, with the status of the run
  // it follows, plain when none does).
  function markWords(text, index, starts) {
    const s = str(text);
    const runs = [];
    const plain = (piece) => runs.push({ text: piece, status: null, pitch: null });
    if (!s) return runs;
    if (!index || !index.size) {
      plain(s);
      return runs;
    }
    const bounds = boundsOf(s, starts instanceof Set ? starts : starts ? new Set(starts) : wordStarts(s));
    const heads = index.heads;
    const tryAt = (pos) => (!heads || heads.has(s[pos]) ? matchAt(s, pos, index, bounds) : null);
    let i = 0;
    // Where the text not yet in a run begins: the end of the last coloured run, and its status.
    let from = 0;
    let last = null;
    // The word at the start `pos`: the deck word there, else the one after an honorific prefix
    // (ICU cut it off: お|風呂, not お前) or, for いう alone, a quotative (the word ends the
    // segment: いう in っていう, not in そういう), with the length of what fronts it and the colour
    // that takes.
    const wordAt = (pos) => {
      let hit = tryAt(pos);
      if (hit) return { lead: 0, status: null, hit };
      if (HONORIFICS.has(s[pos]) && bounds.has(pos + 1)) {
        hit = tryAt(pos + 1);
        if (hit) return { lead: 1, status: hit.entry.status, hit };
      }
      const quote = QUOTATIVES.find((piece) => s.startsWith(piece, pos));
      if (quote) {
        hit = tryAt(pos + quote.length);
        if (hit && hit.entry.word === QUOTED_WORD && atBoundary(s, hit.end, bounds)) return { lead: quote.length, status: from === pos ? last : null, hit };
      }
      return null;
    };
    while (i < s.length) {
      const found = bounds.has(i) ? wordAt(i) : null;
      if (!found) {
        i++;
        continue;
      }
      const { lead, hit } = found;
      const start = i + lead;
      if (lead && found.status !== null) {
        if (from < i) plain(s.slice(from, i));
        runs.push({ text: s.slice(i, start), status: found.status, pitch: null });
      } else if (from < start) plain(s.slice(from, start));
      last = hit.entry.status;
      runs.push({ text: s.slice(start, hit.end), status: last, pitch: hit.entry.pitch });
      i = hit.end;
      // A word with a pitch and no status has no colour to run on: its particles stay plain text.
      if (last !== null) {
        for (const len of particlesAt(s, i, bounds, wordAt)) {
          runs.push({ text: s.slice(i, i + len), status: last, pitch: null });
          i += len;
        }
      }
      from = i;
    }
    if (from < s.length) plain(s.slice(from));
    return runs;
  }

  return Object.freeze({
    STATUSES,
    PITCHES,
    MAX_WORD_LEN,
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
  });
})();

// The Node tests require this file directly; Firefox has no `module`.
if (typeof module !== "undefined" && module.exports) module.exports = SHISUKO_WORDS;

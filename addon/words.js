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

  const TAGS = /<[^>]*>/g;
  const ENTITIES = /&(nbsp|amp|lt|gt|quot|#39);/gi;
  const ENTITY_TEXT = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
  // Ruby readings, and the parentheses shown around them where ruby is not supported.
  const RT_RP = /<(rt|rp)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
  const HAS_RT = /<rt\b/i;
  const RUBY = /<ruby\b[^>]*>([\s\S]*?)<\/ruby\s*>/gi;
  const RT = /<rt\b[^>]*>([\s\S]*?)<\/rt\s*>/gi;
  const LINE_BREAKS = /<br\s*\/?>|<\/(?:p|div|li|tr)\s*>/gi;
  // Yomitan's furigana format: a space marks where a kanji run starts and its reading follows in
  // brackets (" 食[た]べる", "お 茶[ちゃ]"). $1 is the kanji, $2 the reading.
  const FURIGANA = /\s?(\S+?)\[([^\]]*)\]/g;
  const BRACKETS = /\[[^\]]*\]/g;
  const SPACE = /\s+/g;

  const HIRAGANA = /^\p{Script=Hiragana}$/u;
  const KATAKANA = /^\p{Script=Katakana}$/u;
  const KANJI_OR_KATAKANA = /[\p{Script=Han}\p{Script=Katakana}]/u;
  // ー and ・ belong to neither script (Unicode files them under Common); a reading may hold them.
  const KANA_ONLY = /^[\p{Script=Hiragana}\p{Script=Katakana}ー・ｰ]+$/u;
  // The small kana that glide onto the mora before them; っ and ん are moras of their own.
  const SMALL_KANA = new Set([..."ゃゅょャュョぁぃぅぇぉァィゥェォヮゎ"]);

  function str(value) {
    return value === undefined || value === null ? "" : String(value);
  }

  function stripMarkup(html) {
    return str(html)
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
    for (const line of stripMarkup(html).split("\n")) {
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
  // {pitch-accents} in its text form marks the drop inside the reading ("はしꜜ"; no mark: heiban).
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
  // nakadaka, so the mora count comes from the pitch text, the reading or the word, whichever is
  // kana. Unknown counts read as nakadaka, the more common of the two.
  function parsePitch(text, reading, word) {
    const plain = plainText(text);
    if (!plain) return null;
    const named = CATEGORY.exec(plain);
    if (named) return CATEGORY_OF[named[0].toLowerCase()];

    let n = null;
    const position = POSITION.exec(plain);
    const drop = plain.indexOf(DOWNSTEP);
    if (position) n = Number(position[1]);
    else if (DIGITS_ONLY.test(plain)) n = Number(/\d+/.exec(plain)[0]);
    else if (drop >= 0) n = moraCount(plain.slice(0, drop));
    else if (kanaOnly(plain.replace(SPACE, ""))) n = 0;
    if (n === null) return null;
    if (n === 0) return "heiban";
    if (n === 1) return "atamadaka";

    const kana = plain.split(DOWNSTEP).join("").replace(SPACE, "");
    let moras = -1;
    if (kanaOnly(kana)) moras = moraCount(kana);
    else if (kanaOnly(str(reading))) moras = moraCount(reading);
    else if (kanaOnly(str(word))) moras = moraCount(word);
    return n === moras ? "odaka" : "nakadaka";
  }

  const PITCH_FIELD = /pitch|accent|アクセント/i;
  const READING_FIELD = /reading|furigana|読み|よみ/i;

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

  function pitchOf(fields, settings) {
    const s = settings || {};
    const list = fieldsInOrder(fields);
    const wanted = str(s.ankiPitchField).trim();
    let pitch = wanted ? list.find((field) => field.name === wanted) : undefined;
    if (!pitch) pitch = list.find((field) => PITCH_FIELD.test(field.name));
    if (!pitch) return null;
    const readingField = list.find((field) => field !== pitch && READING_FIELD.test(field.name));
    const reading = readingField ? readingOf(readingField.value) : "";
    // The same rule as the background's noteSummary(): the named field, else the first one.
    const wordName = str(s.ankiWordField).trim();
    const wordField = wordName ? list.find((field) => field.name === wordName) : list.find((field) => field.order === 0);
    const word = wordField ? plainWord(wordField.value) : "";
    return parsePitch(pitch.value, reading, word);
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
    // Unsuspended, yet in none of the three queues: a card buried in the learning queue.
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

  // Conjugation tables. A dictionary form with a kanji or katakana in it is cut before its ending
  // and remembered by that stem; in the text, the stem must be followed by a first piece of its
  // kind (the inflected ending) and then by any run of tail pieces (auxiliaries), so 食べる finds
  // 食べました and 書く finds 書かない. Kana-only verbs match exactly only: a stem of one or two
  // kana would be found in every line.
  const FIRST_PIECES = {
    suru: ["する", "し", "さ", "せ", "す"],
    "i-adj": ["い", "く", "かっ", "けれ", "さ", "そう", "くて", "くない", "ければ"],
    ru: ["る", "た", "て", "ない", "ます", "まし", "ませ", "たい", "られ", "させ", "よう", "れば", "ろ", "よ", "ず", "ん", "ら", "り", "れ", "っ", "なかっ", "なけれ"],
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
    "た", "て", "で", "だ", "ない", "なく", "なかっ", "なけれ", "ます", "まし", "ませ", "ん", "たい", "たく", "たかっ",
    "れ", "れる", "られ", "られる", "せ", "せる", "させ", "させる", "ば", "う", "よう", "ろ", "い", "かっ", "けれ", "ず",
    "ちゃ", "じゃ", "てる", "でる", "てい", "でい", "いる", "いた", "いて", "います", "いない", "ましょ", "でし", "です",
    "たら", "だら", "たり", "だり", "ても", "でも", "ながら", "なさい", "まい", "とく", "どく",
  ];
  const MAX_TAILS = 4;
  const GODAN = new Set([..."うくぐすつぬぶむ"]);

  function table(pieces) {
    return Object.freeze({ pieces: new Set(pieces), maxLen: Math.max(...pieces.map((piece) => piece.length)) });
  }

  const FIRST = {};
  for (const [kind, pieces] of Object.entries(FIRST_PIECES)) FIRST[kind] = table(pieces);
  const TAIL = table(TAIL_PIECES);

  function stemOf(word) {
    if (!hasKanjiOrKatakana(word)) return null;
    if (word.length >= 3 && word.endsWith("する")) return { stem: word.slice(0, -2), kind: "suru" };
    if (word.length < 2) return null;
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
      if (!word || word.length > MAX_WORD_LEN) continue;
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

  // The furthest end reachable from `pos` with up to `left` tail pieces. Taking the longest piece
  // each time is not enough (泳いでいる is で+いる, not でい+る), so every split is tried; the
  // table is small and the depth is four.
  function tailEnd(text, pos, left) {
    let best = pos;
    if (left === 0) return best;
    for (let len = Math.min(TAIL.maxLen, text.length - pos); len >= 1; len--) {
      if (!TAIL.pieces.has(text.slice(pos, pos + len))) continue;
      const end = tailEnd(text, pos + len, left - 1);
      if (end > best) best = end;
    }
    return best;
  }

  // Where a form of the word whose stem ends at `pos` ends, or -1 when the text there is no form
  // of it. A する verb is also its noun alone (勉強 in 勉強が); every other kind needs its first
  // piece, since a bare stem is another word (走 in 走者).
  function continuationEnd(text, pos, kind) {
    const first = FIRST[kind];
    let best = kind === "suru" ? pos : -1;
    for (let len = Math.min(first.maxLen, text.length - pos); len >= 1; len--) {
      if (!first.pieces.has(text.slice(pos, pos + len))) continue;
      const end = tailEnd(text, pos + len, MAX_TAILS);
      if (end > best) best = end;
    }
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
      if (entry.bounded && stop !== text.length && !starts.has(stop)) continue;
      end = stop;
      found = entry;
      break;
    }
    for (let len = Math.min(index.maxStemLen, remaining); len >= 1; len--) {
      const list = index.stems.get(text.slice(i, i + len));
      if (!list) continue;
      for (const { entry, kind } of list) {
        const stop = continuationEnd(text, i + len, kind);
        if (stop > end) {
          end = stop;
          found = entry;
        }
      }
    }
    return found ? { end, entry: found } : null;
  }

  // The text as runs, in order: a matched run carries its entry's status and pitch, the text
  // between matches is one run with neither. `starts` is the set of indices a word may begin at.
  function markWords(text, index, starts) {
    const s = str(text);
    const runs = [];
    const plain = (piece) => runs.push({ text: piece, status: null, pitch: null });
    if (!s) return runs;
    if (!index || !index.size) {
      plain(s);
      return runs;
    }
    const bounds = starts instanceof Set ? starts : starts ? new Set(starts) : wordStarts(s);
    const heads = index.heads;
    let i = 0;
    let from = 0;
    while (i < s.length) {
      const hit = bounds.has(i) && (!heads || heads.has(s[i])) ? matchAt(s, i, index, bounds) : null;
      if (!hit) {
        i++;
        continue;
      }
      if (from < i) plain(s.slice(from, i));
      runs.push({ text: s.slice(i, hit.end), status: hit.entry.status, pitch: hit.entry.pitch });
      i = hit.end;
      from = i;
    }
    if (from < s.length) plain(s.slice(from));
    return runs;
  }

  return Object.freeze({
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
  });
})();

// The Node tests require this file directly; Firefox has no `module`.
if (typeof module !== "undefined" && module.exports) module.exports = SHISUKO_WORDS;

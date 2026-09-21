"use strict";

/*
 * Shared matching between what a card says and what a subtitle said. Loaded before background.js
 * and content.js (see manifest.json), so both score the same way:
 *  - the content script picks the cue a new Yomitan card belongs to,
 *  - the background checks that same card before it writes media into it.
 *
 * Yomitan's sentence is never byte-identical to the cue: it carries <b> around the looked-up word,
 * HTML entities, furigana in brackets or in ruby, and it may stop short of the cue or run past it.
 * Comparing normalised character bigrams survives all of that and still says no to an unrelated card.
 *
 * The two sides of every comparison are not interchangeable: the card's text always comes first
 * (`similarity(card, spoken)`, the note's sentence against the cues in `matchCue`). Yomitan cuts
 * its sentence out of the line on screen at 。！？, so it is a piece of what was said, while a cue
 * inside the card's sentence may be a scrap that any sentence holds.
 */

const SHISUKO_MATCH = (() => {
  // A card and a subtitle agreeing on 60% of their bigrams are about the same line; below that the
  // overlap is what any two Japanese sentences share (particles, です, ます).
  const MIN_SIMILARITY = 0.6;
  // The bonus is small on purpose: it reorders two cues that already passed the threshold, it
  // never lifts one below it.
  const WORD_BONUS = 0.2;

  const TAGS = /<[^>]*>/g;
  // Yomitan's {sentence-furigana} and {furigana} write the reading as HTML ruby,
  // <ruby>食<rt>た</rt></ruby>べる: stripping the tags alone would leave 食たべる. The reading goes
  // with its <rt> (and an <rp> fallback), whose end tag may be left out before </ruby>.
  const RUBY = /<(?:rt|rp)\b[^>]*>[\s\S]*?(?=<\/(?:rt|rp|ruby)\b)/gi;
  const ENTITIES = /&(nbsp|amp|lt|gt|quot|#39);/gi;
  const ENTITY_TEXT = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
  // Yomitan's {sentence-furigana-plain} writes the reading in brackets after the kanji: " 食[た]べる".
  const FURIGANA = /\[[^\]]*\]/g;
  const SPACE = /\s+/g;
  const PUNCTUATION = /[。、！？!?…・「」『』（）()〝〟“”"'.,．]/g;
  // Where Yomitan, by default, ends the sentence it cuts out of the text on screen: its sentence
  // terminators and a line break, plus the quotes it stops at when the looked-up word sits inside
  // them. normalize() drops every one of them, so a sentence Yomitan cut out of a line is one of
  // the line's pieces between these, normalised.
  const TERMINATORS = /[。！？!?．…\n]/;
  const QUOTES = /[「」『』"']/;

  function normalize(text) {
    return String(text === undefined || text === null ? "" : text)
      .replace(RUBY, "")
      .replace(TAGS, "")
      .replace(ENTITIES, (_m, name) => ENTITY_TEXT[String(name).toLowerCase()] || "")
      .replace(FURIGANA, "")
      .replace(SPACE, "")
      .replace(PUNCTUATION, "");
  }

  function bigrams(s) {
    const set = new Set();
    for (let i = 0; i + 1 < s.length; i++) set.add(s.slice(i, i + 2));
    return set;
  }

  // How much of the longer text the shorter one accounts for. Both arguments already normalised.
  function coverage(a, b) {
    const longer = Math.max(a.length, b.length);
    return longer ? Math.min(a.length, b.length) / longer : 0;
  }

  // A cue of three characters (ですね, はい, そうそう) sits inside almost any long sentence, and
  // containment alone would score it 1 and let it outrank the cue the card really came from. It
  // counts only when it is a real share of what is being compared. The card's own sentence is
  // held to no such bar, see contains(): the server merges a short cue into its neighbour
  // (嘘でしょ。本当にそんなことがあったの) and Yomitan stops at the 。, so the card reads 嘘でしょ,
  // four characters that only that line explains.
  function comparable(a, b) {
    return Math.min(a.length, b.length) >= 6 || coverage(a, b) >= 0.5;
  }

  // Whether the line said the card's sentence, or the card's sentence is the line. Both arguments
  // already normalised. A line holding the card's sentence whole said it, however short the
  // sentence is; a line inside the card's sentence only counts when it is a real share of it.
  function contains(card, spoken) {
    return spoken.includes(card) || (comparable(card, spoken) && card.includes(spoken));
  }

  // Whether Yomitan could have cut `sentence` (normalised) out of `raw`, a line as it is on
  // screen: the sentence is a whole piece of the line between terminators, or between a
  // terminator and a quote. A line holding the sentence mid-clause (はい inside はい、そうですね)
  // said the words, but no card that reads はい was made from it: Yomitan never cuts at 、.
  function cutFrom(raw, sentence) {
    for (const piece of String(raw === undefined || raw === null ? "" : raw).split(TERMINATORS)) {
      if (normalize(piece) === sentence) return true;
      if (QUOTES.test(piece)) for (const inner of piece.split(QUOTES)) if (normalize(inner) === sentence) return true;
    }
    return false;
  }

  // How much of the card's sentence and the cue is common to both, the tie-break between cues
  // that match alike: a whole line beats a fragment of itself, and the line that is the sentence
  // beats a line that merely holds it mid-clause, since the viewer at 10:00 who scans はい in the
  // transcript's line at 40:00 does not want the frame and the audio of はい、そうですね playing
  // now, however recently that line was read. A line that runs past the sentence at a terminator
  // said it whole: the server merges a short cue into its neighbour (嘘でしょ。本当にそんなこと
  // があったの) and Yomitan cuts 嘘でしょ out of it, so that line explains all of the sentence and
  // ties with a line that is the sentence, and rank, the line the viewer just read, decides
  // between them. `sentence` and `text` already normalised, `raw` the cue's text as shown.
  function share(sentence, text, raw) {
    if (text.length > sentence.length && text.includes(sentence) && cutFrom(raw, sentence)) return 1;
    return coverage(sentence, text);
  }

  // Both arguments already normalised, the card's text first. Beyond containment, the Dice
  // coefficient: dividing by both bigram counts asks how much of each text the other explains.
  // Dividing by the smaller one instead (the overlap coefficient) scores a short sentence that
  // merely ends the same way as high as a real match: 別の字幕です against これはテスト字幕です
  // shares 字幕です and would pass. A card whose sentence is a genuine fragment of the cue needs
  // no help from the metric; containment scores it 1.
  function score(card, spoken) {
    if (!card || !spoken) return 0;
    if (contains(card, spoken)) return 1;
    if (!comparable(card, spoken) || card.length < 3 || spoken.length < 3) return 0;
    const first = bigrams(card);
    const second = bigrams(spoken);
    const [small, large] = first.size <= second.size ? [first, second] : [second, first];
    let shared = 0;
    for (const gram of small) if (large.has(gram)) shared++;
    return (2 * shared) / (first.size + second.size);
  }

  // What the card says against what was said, in that order.
  function similarity(card, spoken) {
    return score(normalize(card), normalize(spoken));
  }

  function toRank(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : Infinity;
  }

  // The cue a new card is about, or null. `note` is { sentence, word } as Anki holds them;
  // `opts.rank` orders equally good cues (the content script ranks pre-mined sentences first) and
  // `opts.t` is the playhead, the last tie-break.
  function matchCue(cues, note, opts) {
    const list = Array.isArray(cues) ? cues : [];
    const options = opts || {};
    const rankOf = typeof options.rank === "function" ? options.rank : null;
    const t = Number(options.t) || 0;
    const sentence = normalize(note && note.sentence);
    const word = normalize(note && note.word);
    if (!sentence && !word) return null;

    let best = null;
    let bestScore = 0;
    let bestCoverage = 0;
    let bestRank = Infinity;
    let bestDistance = Infinity;

    // Score first, then how much of the card's sentence the cue accounts for (share()), then the
    // caller's order, then the playhead.
    const offer = (cue, value, common) => {
      if (value <= 0) return;
      const rank = rankOf ? toRank(rankOf(cue)) : Infinity;
      const distance = Math.abs((Number(cue.start) || 0) - t);
      const better =
        !best ||
        value > bestScore ||
        (value === bestScore &&
          (common > bestCoverage ||
            (common === bestCoverage && (rank < bestRank || (rank === bestRank && distance < bestDistance)))));
      if (!better) return;
      best = cue;
      bestScore = value;
      bestCoverage = common;
      bestRank = rank;
      bestDistance = distance;
    };

    if (!sentence) {
      // No sentence to explain, so nothing to rank by coverage; rank and the playhead decide.
      for (const cue of list) {
        const text = normalize(cue && cue.text);
        if (text && text.includes(word)) offer(cue, 1, 0);
      }
      return best;
    }

    // Most cards match a cue outright; scoring bigrams for thousands of cues is only worth it when
    // none does. The normalised texts are kept so the second pass does not redo the work.
    const texts = new Array(list.length);
    let contained = false;
    for (let i = 0; i < list.length; i++) {
      const cue = list[i];
      const text = normalize(cue && cue.text);
      texts[i] = text;
      if (!text || !contains(sentence, text)) continue;
      contained = true;
      offer(cue, 1 + (word && text.includes(word) ? WORD_BONUS : 0), share(sentence, text, cue.text));
    }
    if (contained) return best;

    for (let i = 0; i < list.length; i++) {
      const text = texts[i];
      if (!text) continue;
      const value = score(sentence, text);
      if (value < MIN_SIMILARITY) continue;
      offer(list[i], value + (word && text.includes(word) ? WORD_BONUS : 0), share(sentence, text, list[i].text));
    }
    return best;
  }

  return Object.freeze({ normalize, similarity, matchCue, MIN_SIMILARITY });
})();

// The Node tests require this file directly; Firefox has no `module`.
if (typeof module !== "undefined" && module.exports) module.exports = SHISUKO_MATCH;

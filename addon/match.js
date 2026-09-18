"use strict";

/*
 * Shared matching between what a card says and what a subtitle said. Loaded before background.js
 * and content.js (see manifest.json), so both score the same way:
 *  - the content script picks the cue a new Yomitan card belongs to,
 *  - the background checks that same card before it writes media into it.
 *
 * Yomitan's sentence is never byte-identical to the cue: it carries <b> around the looked-up word,
 * HTML entities, furigana in brackets, and it may stop short of the cue or run past it. Comparing
 * normalised character bigrams survives all of that and still says no to an unrelated card.
 */

const SHISUKO_MATCH = (() => {
  // A card and a subtitle agreeing on 60% of their bigrams are about the same line; below that the
  // overlap is what any two Japanese sentences share (particles, です, ます).
  const MIN_SIMILARITY = 0.6;
  // The bonus is small on purpose: it reorders two cues that already passed the threshold, it
  // never lifts one below it.
  const WORD_BONUS = 0.2;

  const TAGS = /<[^>]*>/g;
  const ENTITIES = /&(nbsp|amp|lt|gt|quot|#39);/gi;
  const ENTITY_TEXT = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
  // Yomitan's {sentence-furigana} writes the reading in brackets after the kanji: " 食[た]べる".
  const FURIGANA = /\[[^\]]*\]/g;
  const SPACE = /\s+/g;
  const PUNCTUATION = /[。、！？!?…・「」『』（）()〝〟“”"'.,]/g;

  function normalize(text) {
    return String(text === undefined || text === null ? "" : text)
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
  // counts only when it is a real share of what is being compared. Nothing legitimate is lost: the
  // card made from a short cue carries that same short sentence, so its coverage is 1.
  function comparable(a, b) {
    return Math.min(a.length, b.length) >= 6 || coverage(a, b) >= 0.5;
  }

  // Both arguments already normalised. The Dice coefficient: dividing by both bigram counts asks
  // how much of each text the other explains. Dividing by the smaller one instead (the overlap
  // coefficient) scores a short sentence that merely ends the same way as high as a real match:
  // 別の字幕です against これはテスト字幕です shares 字幕です and would pass. A card whose sentence
  // is a genuine fragment of the cue needs no help from the metric; containment below scores it 1.
  function score(a, b) {
    if (!a || !b || !comparable(a, b)) return 0;
    if (a.includes(b) || b.includes(a)) return 1;
    if (a.length < 3 || b.length < 3) return 0;
    const first = bigrams(a);
    const second = bigrams(b);
    const [small, large] = first.size <= second.size ? [first, second] : [second, first];
    let shared = 0;
    for (const gram of small) if (large.has(gram)) shared++;
    return (2 * shared) / (first.size + second.size);
  }

  function similarity(a, b) {
    return score(normalize(a), normalize(b));
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

    // Score first, then how much of the card's sentence the cue explains, so a whole line beats a
    // fragment of itself; then the caller's order, then the playhead.
    const offer = (cue, value, share) => {
      if (value <= 0) return;
      const rank = rankOf ? toRank(rankOf(cue)) : Infinity;
      const distance = Math.abs((Number(cue.start) || 0) - t);
      const better =
        !best ||
        value > bestScore ||
        (value === bestScore &&
          (share > bestCoverage ||
            (share === bestCoverage && (rank < bestRank || (rank === bestRank && distance < bestDistance)))));
      if (!better) return;
      best = cue;
      bestScore = value;
      bestCoverage = share;
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
      if (!text || !comparable(sentence, text)) continue;
      if (!text.includes(sentence) && !sentence.includes(text)) continue;
      contained = true;
      offer(cue, 1 + (word && text.includes(word) ? WORD_BONUS : 0), coverage(sentence, text));
    }
    if (contained) return best;

    for (let i = 0; i < list.length; i++) {
      const text = texts[i];
      if (!text) continue;
      const value = score(sentence, text);
      if (value < MIN_SIMILARITY) continue;
      offer(list[i], value + (word && text.includes(word) ? WORD_BONUS : 0), coverage(sentence, text));
    }
    return best;
  }

  return Object.freeze({ normalize, similarity, matchCue, MIN_SIMILARITY });
})();

// The Node tests require this file directly; Firefox has no `module`.
if (typeof module !== "undefined" && module.exports) module.exports = SHISUKO_MATCH;

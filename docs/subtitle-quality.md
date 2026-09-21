# Subtitle timing quality: standards, gaps, and a plan

Scope: cue timing and cue segmentation for the live Japanese overlay. Not transcription accuracy.
Everything about faster-whisper below was read from the installed 1.2.1 source at
`result-python/lib/python3.14/site-packages/faster_whisper/` (`transcribe.py`, `vad.py`), not from memory.

## (a) The numeric standards

| Rule | Netflix general | Netflix Japanese | BBC | JP film-subtitling trade practice |
|---|---|---|---|---|
| Min duration | 5/6 s = 20 frames @24fps | 500 ms | ~0.3 s per word (1.2 s for 4 words) | 0.5 s |
| Max duration | 7 s | (defers to general) | not stated | 7 s (some houses 6.5 s) |
| Lines | 2 | 2 | 2 (3 exceptionally) | 2 |
| Chars per line | 42 (Latin) | 13 full-width horizontal, 11 vertical; SDH 16 | ~68% of frame width | 13–14 horizontal, 10–11 vertical |
| Reading speed | 17 cps adult / 15 cps children (English) | 4 cps subtitles, 7 cps SDH | 160–180 wpm ≈ 0.33–0.375 s/word | 4 chars/s ("1秒4文字") |
| Min gap between cues | 2 frames (83 ms @24fps), all frame rates | — | "minimum gap time should be a second and a half" | — |
| Forbidden gaps | 3–11 frames: close to 2 frames. Legal gaps are 2 frames, or ≥12 frames (0.5 s) | — | — | — |
| In-cue vs audio | first frame of audio, within 1–2 frames (42–83 ms) is acceptable | — | cue up as the speaker starts | — |
| Out-cue vs audio | extend ≥0.5 s past end of audio when no cue follows | — | — | — |
| Shot changes | zones at 7 / 8–11 / 12 frames around the cut | — | a reason to vary timing | — |

Sources: [Netflix General Requirements](https://partnerhelp.netflixstudios.com/hc/en-us/articles/215758617-Timed-Text-Style-Guide-General-Requirements),
[Netflix Subtitle Timing Guidelines](https://partnerhelp.netflixstudios.com/hc/en-us/articles/360051554394-Timed-Text-Style-Guide-Subtitle-Timing-Guidelines),
[Netflix Japanese TTSG](https://partnerhelp.netflixstudios.com/hc/en-us/articles/215767517-Japanese-Timed-Text-Style-Guide),
[Netflix Subtitle Templates](https://partnerhelp.netflixstudios.com/hc/en-us/articles/219375728-Timed-Text-Style-Guide-Subtitle-Templates),
BBC Subtitle Guidelines v1.2.3 via [Clevercast's reproduction](https://www.clevercast.com/bbc-subtitling-guidelines/),
JP practice via [Vook](https://vook.vc/n/1339) and [映像翻訳.com](https://www.eizou-honyaku.com/category/jimaku/014.html).

Contradictions and unverified points, stated plainly:

- Netflix's own pages disagree on minimum duration: General Requirements says 5/6 s (0.833 s), the
  Timing Guidelines page says "20 frames (or 4/5 sec)" (0.8 s), and the Japanese guide says 500 ms.
  Treat 0.8 s as the general floor and 0.5 s as the Japanese floor.
- BBC's "minimum gap 1.5 s" and Netflix's "minimum gap 2 frames" look opposed but are not. Both say the
  same thing: a gap is either invisible (~0.1 s) or clearly deliberate (Netflix ≥0.5 s, BBC ≥1.5 s).
  The forbidden zone is the middle — long enough to see the screen blank, short enough to read as a glitch.
- I could not reach the primary BBC source (`bbc.co.uk` refused the fetch, `bbc.github.io/subtitle-guidelines`
  returned 404, the `bbc/subtitle-guidelines` repo is not public via the API). BBC numbers here are second-hand.
- The 4 cps Japanese reading speed is a **translation condensation budget**, not a transcription target.
  Japanese spontaneous speech runs roughly 7–9 morae/s; a verbatim transcript is physically ~6–10 chars/s.
  No verbatim pipeline can hit 4 cps without deleting words. The reachable target is Netflix's SDH 7 cps,
  and even that will be exceeded on fast speech. Chasing the 4 cps number would be chasing the wrong standard.

What professional guidance says "good" feels like, stripped to mechanics: cue in at speech onset (never after
it, at most ~2 frames early); cue out a beat *after* the audio, not on the last phoneme; close small gaps so a
run of dialogue reads as one flow instead of a strobe; keep durations within a narrow band so the eye stops
re-acquiring the text box; never let text outlive its audio by more than the deliberate lead-out.

## (b) What Shisu-ko does now, gap by gap

| Standard | Shisu-ko today | Gap |
|---|---|---|
| Min duration 0.5–0.8 s | `max(b, a + 0.4)` in `Transcriber.process()` | floor is 0.4 s, half the general minimum |
| Max duration ≤7 s | `--max-cue-seconds 7.0` | meets it, but 7 s + `lingerSeconds` 3 = 10 s on screen |
| Chars per cue ≤26 (JP) | `--max-cue-chars 42` | 42 is the *Latin* number; ~1.6× over the Japanese limit |
| Min gap 2 frames, no gaps in 0.08–0.5 s | no gap rule at all | every sub-0.5 s silence becomes a visible blink |
| In-cue at onset ±83 ms | first word's `start` from cross-attention DTW | unmeasured; first-word timings are the least reliable ones Whisper produces |
| Out-cue ≥0.5 s past audio | last word's `end`, then up to 3 s of client-side linger | lead-out is not in the data; it is a fixed 3 s client hack |
| No cues over non-speech | `vad_filter=True` only | VAD decides what the model *hears*, never what a cue *is* |
| Merge fragments | only folds a trailing cue shorter than 4 chars | no general merge, so 1–2 word cues survive and flicker |
| Split at pauses | splits on `。！？…` and `、`, on char count, on 7 s | never splits on a silence, so a 3 s pause sits inside one cue |

Three structural facts about faster-whisper 1.2.1 that matter here and are not obvious from the call site:

1. `vad_filter=True` does not merely gate. `transcribe()` runs Silero, then `collect_chunks()`
   **concatenates the speech and discards the silence** before the encoder ever sees it, in chunks up to
   `chunk_length` (30 s). Timestamps come back through `SpeechTimestampsMap`, which maps each word by its
   midpoint. So cue times are already VAD-derived — but the pipeline never sees those intervals, so it cannot
   snap to them, extend into them, or use them to judge a cue.
2. Passing a `vad_parameters` dict causes `max_speech_duration_s` to be popped and forced to 30. Also, the
   library's own default for the `vad_filter` path is `min_silence_duration_ms=160`; Shisu-ko's 400 is more
   conservative than that, while `VadOptions`' bare default is 2000. Unstated parameters take
   `VadOptions` defaults: `threshold=0.5`, `neg_threshold=threshold-0.15=0.35`, **`min_speech_duration_ms=0`**.
   Zero is the important one: a single 32 ms window above 0.5 becomes a speech chunk, so drum hits and
   vocal-ish synth transients are fed to the model. That is the direct cause of complaint (1).
3. `hallucination_silence_threshold` (default `None`, unused here) measures silence gaps *on the collapsed
   timeline*. With `vad_filter=True` the long silences are already gone, so the feature is largely toothless
   in this configuration. Its detector, however, is reusable: `word_anomaly_score()` scores a word +1 for
   `probability < 0.15`, `+ (0.133 - d) * 15` when shorter than 133 ms, `+ (d - 2.0)` when longer than 2 s;
   a segment is anomalous when the sum over its first 8 non-punctuation words is ≥3, or ≥ the word count.
4. Word timestamps are already patched by heuristics: `add_word_timestamps()` caps the median word duration
   at 0.7 s, truncates words longer than 2× median at sentence marks, and overrides the first or last word's
   time with the segment-level time when it looks too long. The source comments call these "hack". Conclusion:
   **first and last word boundaries are the least trustworthy numbers in the output** — exactly the two the
   cue builder uses for in and out times.

Client side: `lingerSeconds` 3 keeps a cue up to 3 s past its end unless the next cue has started. Combined
with a stretched final-word `end`, a cue can outlive its audio by 4–5 s. `RENDER_INTERVAL_MS` is 200 and
`timeupdate` fires ~4 Hz, so cue transitions carry ±200 ms of jitter — a quarter of a minimum-length cue.

## (c) Proposal, in priority order

### P0.1 — Own the VAD intervals (enables everything else)

`from faster_whisper.vad import VadOptions, get_speech_timestamps` and run it on the same window before
`model.transcribe()`. `get_vad_model()` is `functools.lru_cache`d over a 1.2 MB ONNX (`silero_vad_v6.onnx`),
so this reuses the already-loaded model: one extra CPU forward pass per 40 s window, milliseconds.
Pass the identical options dict to `transcribe()` so both passes see the same intervals.

Options: `threshold=0.5`, `neg_threshold=0.35`, `min_speech_duration_ms=250`,
`min_silence_duration_ms=300`, `speech_pad_ms=200`.

- `min_speech_duration_ms` 0 → 250 kills music transients at the source. Expected effect: the large majority
  of non-speech cues disappear before decoding. Risk: drops genuine one-mora interjections (はい, ん) — the
  short backchannels a learner wants. 250 ms is chosen to sit just above them being lost; verify empirically.
- `min_silence_duration_ms` 400 → 300 gives finer boundaries to snap to. Do **not** go below ~250: Japanese
  sokuon (っ) and pre-plosive closures are 150–200 ms of genuine silence *inside* a word, and Silero will
  split there.
- Do not pass `clip_timestamps` instead of `vad_filter`. In that path faster-whisper skips `collect_chunks()`,
  so every short utterance becomes its own 30 s-padded encoder pass. A 40 s window with 12 utterances would
  cost ~12 encodes instead of ~2. Wrong trade for an ahead-of-playhead pipeline.
- Note: `faster_whisper.vad` is not in the package `__all__`. Pin the version and cover it with a test.

### P0.2 — Hallucination filters (complaint 1)

Apply per segment, before `split_segment()`:

1. Drop segments with no words, or whose text after stripping punctuation is empty (already partly done by `JUNK_RE`).
2. **VAD overlap gate.** Compute `overlap = |cue ∩ speech intervals| / cue duration`. Drop when `< 0.5`,
   unless the text is ≥8 chars *and* mean word probability ≥0.5. Effect: the single highest-value filter —
   it directly encodes "no text where there is no voice". Risk: near-zero; VAD already gated the audio, so
   a cue failing this test is one whose timestamps drifted off its own chunk.
3. **Port `word_anomaly_score` / `is_segment_anomaly`** with upstream's thresholds (above) and drop anomalous
   segments whose VAD overlap is < 0.8. ~15 lines, reuses numbers someone else tuned. Risk: false positives
   on very fast speech (short words score on the `d < 0.133` term); the overlap gate is the safety.
4. **Repetition.** Drop a cue when any substring of ≥2 chars repeats ≥3 times consecutively, or when
   `compression_ratio > 2.2` for the segment. Whisper loops look exactly like this.
5. **Phrase blocklist**, gated, never unconditional: ご視聴ありがとうございました / ご覧いただきありがとうございます /
   チャンネル登録 / おやすみなさい / 字幕 + credit strings. Drop only when VAD overlap < 0.8 **or** the cue is
   isolated (≥3 s of silence on both sides). Risk: these are real sentences in real videos; the gate is what
   keeps the filter from deleting a genuine sign-off.
6. Set `hallucination_silence_threshold=2.0` anyway — free, harmless, but expect little from it (see (b).3).
   `condition_on_previous_text=False` is already correct and should stay.

### P0.3 — Sung lyrics (music videos, 歌枠)

**Observation.** An anime opening (a 34 s Short, sung over music) came out with `cues: 0` and the whole video
covered: Silero heard no speech at all (`speech: []`; 0 s at the 0.5 threshold, 2.7 s at 0.2), so nothing
of it ever reached the decoder. Whisper without the VAD transcribes the same audio cleanly (four segments,
`avg_logprob` −0.18, compression ratio 1.28); with the VAD at 0.2 it produced one garbled fragment. P0.1
therefore has a blind spot: singing is not speech to the detector, and a music video stays blank.

**Rule** (`wants_lyrics()`, `--lyrics auto`, the default): a window in which the detector heard less than
`LYRICS_MAX_SPEECH_S` (1 s) of speech, whose samples have an RMS of at least `LYRICS_MIN_RMS` (0.02, about
−34 dBFS), and in which Whisper's language head then hears the target language (`Transcriber.sung_in_target()`:
the window's own samples, at most `LANGUAGE_DETECT_SECONDS` of them, with probability at least
`LANGUAGE_MIN_PROB`, 0.7), is transcribed with `vad_filter=False`, everything else unchanged. Sung windows
measure 0.11–0.47, a timelapse's background music 0.015, room tone far less, so the RMS floor keeps quiet
windows on the old path, where they cost nothing; the language verdict keeps loud non-speech there too (rain,
a crowd, an engine, an English song under a montage: on the old path faster-whisper decodes nothing of a
window Silero heard nothing in, while a full no-VAD decode of every such window would hand its inventions to
the gates, and an English song came out as English lines in a Japanese track). The Short's two windows score
`ja` 0.966 and 0.974 on the CPU, so sung Japanese clears the watch's own threshold. The verdict costs one
encoder pass and is no vote: the language watch runs on the detector's intervals and casts none on such a
window, and `sung_in_target()` never touches `language_vote()`, so a foreign song never pauses a video; it is
asked whatever `--language-patience` says (it guards a decode, not the pause), and a head that raises leaves
the window to the lyrics path, since a detector failure must never silence a video. Live streams take the
same path.

**Gates** (`lyrics_reason()`, in place of P0.2's; there is no VAD overlap to excuse a segment with):

1. "empty" as in P0.2.
2. "unsure": `no_speech_prob > LYRICS_MAX_NO_SPEECH` (0.9), or `avg_logprob < LYRICS_MIN_LOGPROB` (−0.8), or
   the mean word probability under `LYRICS_MIN_WORD_PROB` (0.35). Measured on this machine's cached videos,
   large-v3 int8 on the CPU: sung decode windows score `no_speech_prob` 0.07–0.42 as a rule, but a rap verse
   scored 0.59 (fourteen lines, all right) and an eighteen-voice chorus 0.80 (千本桜, every line right), while
   the one line made up over real background music (a drawing video's BGM) scored 0.47 and a sign-off over a
   2.3 s instrumental outro 0.85. The decoder's own "not speech" probability is no judge of singing, so it only
   refuses what the decoder is all but sure of (Whisper's own `no_speech_threshold` is 0.6 and acts only
   together with a failed log-probability). `avg_logprob` separates better: sung windows −0.14 to −0.58, made-up
   lines −0.49 to −0.91. The word probability catches garbled pieces (それられ at 0.30; genuine lines from 0.48).
3. "anomaly": `is_segment_anomaly()` unconditionally (P0.2 applies it only under a low overlap). Cost: a very fast
   sung line can fall to it (ないないない 止めらんないない…, three lines of one song in the sample).
4. "repetition" as in P0.2.
5. "blocklist": any phrase, unconditionally. This is what actually stops the instrumental case: over background
   music Whisper's favourite invention is ご視聴ありがとうございました, at scores the other gates accept.

**Cues.** The accepted segments' word spans (`lyrics_spans()`) stand in for the speech intervals: nothing is
trimmed, a start snaps to its segment, the lead-out reaches into the gap before the next one, and they are
stored as the window's speech, so the sync's speech list and the cache carry the sung lines (`/clip` never
reads `Session.speech`: it slices the audio by the times the client sends).

**Result.** The Short gives its four lines (seven cues); the rap verse fifteen lines, the chorus six; a 40 s
window of background music gives nothing. **Risk:** an instrumental window may still yield a made-up line the
gates let through (a phrase off the blocklist with a plausible log-probability), so a music video may show a
wrong line now and then where it used to show nothing; and a sung window the head is unsure of (a rap verse
over loud music, a chorus, a window too short to judge well) stays blank. `--lyrics off` restores the old
behaviour: such windows stay blank.

**Caches from before the rule.** A record written without it (a server before 0.11.3, or `--lyrics off`)
marked a sung stretch covered with nothing in it, and `load_cache()` would have read it as finished: the fix
would never reach a video already watched. So `save_cache()` writes the rule the record was made under
(`"lyrics"`), and `load_cache()` under `--lyrics auto` gives a record without `"lyrics": "auto"` its blank
stretches back: `unheard_stretches()` lists the parts of `covered` of at least 1.5 s (`plan_window()`'s own
floor, so nothing unplannable is created) that no speech interval and no cue touches, `subtract_intervals()`
takes them out of `covered`, the cues and the rest stay, and a session no longer covered to the end is fetched
again and planned over those stretches, where `wants_lyrics()` judges each window anew (a silent one costs a
Silero pass and is covered again). `CACHE_FORMAT` stays 2: the record is migrated, not dropped.

### P1 — Rewrite `split_segment()` as `build_cues(words, speech_intervals)` (complaint 2)

Constants: `MIN_DUR 0.8`, `HARD_MIN_DUR 0.5`, `MAX_DUR 6.0`, `MAX_CHARS 26` (13 × 2 lines, Netflix JP),
`SOFT_CHARS 20`, `LEAD_IN 0.08`, `LEAD_OUT 0.50`, `MIN_GAP 0.10`, `DEAD_ZONE 0.50`, `PAUSE_SPLIT 0.45`.

1. **Trim.** Drop leading/trailing words whose midpoint falls outside every speech interval by >150 ms.
   Kills the stretched first/last word that (b).4 warns about.
2. **Break candidates**, in priority order: sentence-end punctuation; an inter-word gap ≥ `PAUSE_SPLIT`
   that coincides with a VAD silence ≥0.35 s; `、` once the buffer is ≥60% of `MAX_CHARS`; hard break at
   `MAX_CHARS` or `MAX_DUR`, backing off to the last clause boundary inside the final 40% of the buffer.
   The pause rule is what stops a 3 s pause living inside one cue.
3. **Snap in-cue.** `start = clamp(first_word.start, onset - LEAD_IN, onset + 0.30)` where `onset` is the
   containing speech interval's start. Meets Netflix's "within 1–2 frames of first audio" as closely as
   Whisper's alignment allows.
4. **Lead-out.** `end = last_word.end`; if the following silence ≥0.4 s, extend by `min(LEAD_OUT, silence - 0.1)`.
   Never past `next_cue.start - MIN_GAP`. This moves the lead-out from the client into the data, where it belongs.
5. **Minimum duration.** If `end - start < MIN_DUR`, extend into trailing silence; if still short and the
   neighbour is within 1.0 s, merge when the result stays ≤ `MAX_CHARS` and ≤ `MAX_DUR`; otherwise accept,
   but never below `HARD_MIN_DUR`.
6. **Merge fragments.** Adjacent cues separated by < 0.35 s merge when combined chars ≤ `MAX_CHARS` and
   duration ≤ `MAX_DUR`. This is the main anti-flicker rule.
7. **Normalise gaps.** Any gap in (`MIN_GAP`, `DEAD_ZONE`) closes to `MIN_GAP` by extending the earlier cue.
   Netflix's chaining rule, translated to seconds.
8. **Dedup across windows** by interval overlap, not string equality: drop a fresh cue overlapping an
   existing one by >50% of the shorter. The current `|Δstart| < 0.3 and text equal` test misses re-transcribed
   boundary segments that came back slightly reworded.

Expected effect: cue duration collapses into roughly [0.8, 6.0] instead of [0.4, 7.0]; the sub-0.5 s blanks
vanish; in/out times stop depending on Whisper's worst two numbers. Risks: `MAX_CHARS` 42 → 26 raises cue
count ~1.5× — more text swaps, partly offset by rule 6. More importantly, **shorter cues cut sentences, and
the mined Anki sentence comes from the cue**. That is a genuine conflict between display and mining; either
mine cue ± neighbours, or keep a `sentence_id` on each cue so mining can rejoin them. Decide before shipping.

### P2 — Overlay rules

- `lingerSeconds` 3 → **0.3**, and cap the popup input at 1.0. Once P1.4 puts the lead-out in `end`, linger's
  only remaining job is absorbing the ±200 ms render jitter. Keeping 3 s on top of a real lead-out is what
  makes text outlive its audio. Risk: none beyond taste; the setting stays user-adjustable.
- **Never blank for less than 0.3 s.** If the next cue starts within 0.3 s of the current one's end, hold the
  current text instead of clearing. Belt-and-braces for gaps P1.7 missed (cues arriving out of order).
- `RENDER_INTERVAL_MS` 200 → 100, or drive from `requestVideoFrameCallback`. Cheap; halves transition jitter.
- Clamp `findActiveCue`'s linger by the next cue's start *including* cues that arrive later — already the
  behaviour, but re-check after the dedup change in P1.8, which can insert a cue behind the playhead.

### P3 — Alternatives considered, and why not now

- **WhisperX-style forced alignment.** Japanese is supported: `whisperx/alignment.py` maps `ja` to
  `jonatasgrosman/wav2vec2-large-xlsr-53-japanese` and lists `ja` in `LANGUAGES_WITHOUT_SPACES`
  ([repo](https://github.com/m-bain/whisperX/blob/main/whisperx/alignment.py),
  [paper](https://www.robots.ox.ac.uk/~vgg/publications/2023/Bain23/bain23.pdf)). Two problems: it is a
  character-level CTC model, not a phoneme model, so kanji outside its vocab, digits and Latin loanwords get
  no timing at all; and it adds a second GPU model plus a second pass to a pipeline that must stay ahead of
  the playhead. Verdict: not worth it until P0–P2 are measured. Revisit only if measured start error stays >0.25 s.
- **stable-ts.** Its `suppress_silence` / `use_word_position` / `regroup` do roughly what P1 does, but inside
  a different transcription wrapper ([repo](https://github.com/jianfch/stable-ts)). Adopting it means giving
  up the single-file, dependency-light `server.py` invariant. Borrow the ideas, not the dependency.
- **Source separation (Demucs/UVR) for music.** Correct fix for sung vocals, far too slow for live. No.

## (d) What to measure

The cue caches already on disk (`~/.shisu-ko/cache/<video_id>.cues.json`) are a free corpus — every metric
below is computable from them plus one Silero pass over the audio. Add optional per-cue diagnostic fields
(`avg_logprob`, `no_speech_prob`, `vad_overlap`) behind a flag so the filters can be tuned from data.

| Metric | How | Target after the change |
|---|---|---|
| Cue duration distribution | p5 / p50 / p95; % < 0.8 s; % > 6 s | <2% under 0.8 s; 0% over 6 s; p50 in 1.5–3 s |
| Gap distribution | % of gaps in (0.1 s, 0.5 s) | <2% (today: unbounded) |
| Blank islands | count of blanks < 0.3 s per minute | 0 |
| Chars per second | p50, p95, % over 12 | p95 ≤ 12; report, do not enforce |
| Non-speech cues | cues with VAD overlap < 0.5, per minute | ~0 |
| Hallucination clips | fixed set: 60 s silence, 60 s BGM, an OP theme, a talking head | 0 cues on the first three |
| Overlay churn | text swaps per minute; mean on-screen time per cue | churn down vs baseline; on-screen ≥1.5 s median |
| Sync error | one hand-timed 2-minute clip; mean and p90 of \|start error\|, \|end error\| | median \|start error\| < 0.15 s |

Method: keep the decoded audio and re-run only the cue builder, so old and new are compared on identical
Whisper output — otherwise beam-search nondeterminism swamps the effect. The pure functions
(`plan_window`, `split_segment`/`build_cues`) are already unit-testable per `AGENTS.md`; every rule in P1 has
a number, so every rule gets a test with a synthetic word list.

Honest caveat: none of the targets above are validated against this codebase yet. They are derived from the
standards in (a) and from the faster-whisper source, not from a measured baseline. Measure first; the
baseline numbers may move the targets.

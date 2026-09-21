"""Sung lyrics: a window Silero hears nothing in, whose audio is not silence, is transcribed
without the detector and gated on Whisper's own confidence (docs/subtitle-quality.md, P0.3).

Nothing here loads a model; the fake below records what transcribe() was asked for and answers
with scripted segments, and detect_speech is replaced by what the test says Silero heard.
"""
from __future__ import annotations

import importlib.util
import logging
import math
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from _serverlib import load_server

server = load_server()
VIDEO = "abcdefabcdef"
RATE = server.SAMPLE_RATE
W = server.Word


def words(spec, prob: float = 0.9):
    """[("text", start, end), ...] -> [Word]."""
    return [W(text, start, end, prob) for text, start, end in spec]


def seg(text: str, ws, no_speech: float = 0.1, logprob: float = -0.2, compression: float = 1.2):
    """A faster-whisper segment as lyrics_reason reads it: text, words and the decoder's own scores."""
    return SimpleNamespace(text=text, start=ws[0].start, end=ws[-1].end, words=ws, no_speech_prob=no_speech,
                           avg_logprob=logprob, compression_ratio=compression)


def line(text: str, start: float, end: float, prob: float = 0.9, **scores):
    """One sung line whose words share [start, end) evenly, two characters a word."""
    pieces = [text[i:i + 2] for i in range(0, len(text), 2)]
    step = (end - start) / len(pieces)
    ws = words([(p, start + i * step, start + (i + 1) * step) for i, p in enumerate(pieces)], prob)
    return seg(text, ws, **scores)


def tone(seconds: float, amplitude: float = 0.3) -> np.ndarray:
    """A 440 Hz sine: rms amplitude / sqrt(2), 0.21 at the default, well above LYRICS_MIN_RMS."""
    t = np.arange(int(seconds * RATE), dtype=np.float32) / RATE
    return (amplitude * np.sin(2 * math.pi * 440.0 * t)).astype(np.float32)


def silence(seconds: float) -> np.ndarray:
    return np.zeros(int(seconds * RATE), dtype=np.float32)


SUNG = [line("君の声が聞こえる夜に", 1.0, 4.0), line("星を数えて眠る", 6.0, 8.5)]


# --------------------------------------------------------------------------- rms and the decision

def test_rms_of_silence_is_zero_and_of_a_tone_its_amplitude_over_root_two():
    assert server.rms(silence(2.0)) == 0.0
    assert server.rms(silence(0.0)) == 0.0
    assert server.rms(tone(2.0, 0.3)) == pytest.approx(0.3 / math.sqrt(2), abs=1e-3)
    assert server.rms(tone(2.0, 0.001)) < server.LYRICS_MIN_RMS  # room tone stays below the floor


def test_wants_lyrics_needs_next_to_no_speech_and_a_signal():
    args = SimpleNamespace(lyrics="auto")
    loud = tone(20.0)
    assert server.wants_lyrics(args, loud, [], 0.0, 20.0) is True
    assert server.wants_lyrics(args, loud, [[5.0, 5.9]], 0.0, 20.0) is True      # under a second: a transient
    assert server.wants_lyrics(args, loud, [[5.0, 6.0]], 0.0, 20.0) is False     # a second of speech is talk
    assert server.wants_lyrics(args, loud, [[30.0, 40.0]], 0.0, 20.0) is True    # speech outside the window does not count
    assert server.wants_lyrics(args, silence(20.0), [], 0.0, 20.0) is False
    assert server.wants_lyrics(SimpleNamespace(lyrics="off"), loud, [], 0.0, 20.0) is False
    assert server.wants_lyrics(SimpleNamespace(), loud, [], 0.0, 20.0) is True   # the default is auto


# --------------------------------------------------------------------------- lyrics_reason

def test_a_confident_sung_line_passes():
    s = SUNG[0]
    assert server.lyrics_reason(s, s.words) is None


def test_a_segment_without_words_or_text_is_empty():
    assert server.lyrics_reason(seg("テキスト", words([("テキスト", 0.0, 1.0)])), []) == "empty"
    ws = words([("…", 0.0, 1.0)])
    assert server.lyrics_reason(seg("…", ws), ws) == "empty"


def test_the_decoder_doubting_its_own_segment_is_unsure():
    s = line("君の声が聞こえる夜に", 1.0, 4.0, no_speech=0.95)
    assert server.lyrics_reason(s, s.words) == "unsure"
    s = line("君の声が聞こえる夜に", 1.0, 4.0, logprob=-1.0)
    assert server.lyrics_reason(s, s.words) == "unsure"
    s = line("君の声が聞こえる夜に", 1.0, 4.0, prob=0.2)
    assert server.lyrics_reason(s, s.words) == "unsure"
    at_the_edges = line("君の声が聞こえる夜に", 1.0, 4.0, prob=0.35, no_speech=0.9, logprob=-0.8)
    assert server.lyrics_reason(at_the_edges, at_the_edges.words) is None
    chorus = line("君の声が聞こえる夜に", 1.0, 4.0, no_speech=0.8)  # an 18-voice chorus scored this, every line right
    assert server.lyrics_reason(chorus, chorus.words) is None


def test_a_repetition_loop_is_rejected_whatever_its_scores():
    s = line("ラララ" * 6, 1.0, 4.0)
    assert server.lyrics_reason(s, s.words) == "repetition"


def test_a_sign_off_phrase_is_rejected_without_any_vad_evidence_to_rescue_it():
    s = line("ご視聴ありがとうございました", 1.0, 4.0)
    assert server.lyrics_reason(s, s.words) == "blocklist"


def test_an_anomalous_segment_is_rejected_whatever_its_scores():
    # Ten words crammed into a tenth of a second: faster-whisper's own anomaly score, applied
    # unconditionally since there is no VAD overlap to excuse it.
    ws = words([(c, i * 0.01, (i + 1) * 0.01) for i, c in enumerate("あいうえおかきくけこ")])
    assert server.lyrics_reason(seg("あいうえおかきくけこ", ws), ws) == "anomaly"


# --------------------------------------------------------------------------- spans and cues

def test_lyrics_spans_are_the_word_spans_of_the_segments_that_pass():
    segs = SUNG + [line("ご視聴ありがとうございました", 10.0, 12.0)]
    assert server.lyrics_spans(segs, 100.0) == [[101.0, 104.0], [106.0, 108.5]]
    assert server.lyrics_spans([], 0.0) == []


def test_build_window_cues_on_a_lyrics_window_snaps_to_the_segments_and_reaches_into_the_gaps():
    segs = SUNG + [line("ご視聴ありがとうございました", 10.0, 12.0)]
    spans = server.lyrics_spans(segs, 0.0)
    drops: dict = {}
    cues, next_id = server.build_window_cues(segs, 0.0, spans, server.CueLimits(), 3, drops, lyrics=True)
    assert [c["text"] for c in cues] == ["君の声が聞こえる夜に", "星を数えて眠る"]
    assert [c["seg"] for c in cues] == [3, 4]
    assert next_id == 5
    assert cues[0]["start"] == pytest.approx(1.0)        # the line starts where its first word does
    assert cues[0]["end"] == pytest.approx(4.5)          # ... and holds half a second into the gap
    assert cues[1]["start"] == pytest.approx(6.0)
    assert drops == {"blocklist": 1, "_text": [("blocklist", "ご視聴ありがとうございました")]}


# --------------------------------------------------------------------------- Transcriber.process

class FakeModel:
    """Records what transcribe() was asked for; answers with the scripted segments.

    As faster-whisper does, it decodes nothing with `vad_filter` on when the detector `heard`
    nothing. detect_language() answers `verdict` for every window and keeps the samples it was
    given: sung Japanese by default, so a loud speechless window takes the lyrics path.
    """

    def __init__(self, segs, verdict=("ja", 0.95), heard=()):
        self.segs = list(segs)
        self.verdict = verdict
        self.heard = list(heard)
        self.calls: list = []
        self.detections = 0
        self.judged: list = []

    def detect_language(self, audio=None, **kwargs):
        self.detections += 1
        self.judged.append(audio)
        return self.verdict[0], self.verdict[1], []

    def transcribe(self, audio, **kwargs):
        self.calls.append(kwargs)
        if kwargs.get("vad_filter") and not self.heard:
            return iter([]), None
        return iter(list(self.segs)), None


def make_worker(monkeypatch, tmp_path, segs=SUNG, speech=(), verdict=("ja", 0.95), **args_overrides):
    monkeypatch.setattr(server, "CACHE_DIR", tmp_path)
    heard = [list(iv) for iv in speech]
    monkeypatch.setattr(server, "detect_speech", lambda audio, offset=0.0: [[offset + a, offset + b] for a, b in heard])
    base = dict(first_window=20.0, window=20.0, lookahead=900.0, model="large-v3", language="ja",
                language_patience=30.0, beam_size=1, initial_prompt="", idle_minutes=30, client_timeout=30.0,
                lyrics="auto")
    base.update(args_overrides)
    model = FakeModel(segs, verdict, heard)
    app = server.App(SimpleNamespace(**base), model=model, device="cpu", compute_type="int8")
    app.fetcher = SimpleNamespace(fetch=lambda s: None)
    return server.Transcriber(app), model


def session(audio):
    return server.Session(video_id=VIDEO, url="u", status="ready", audio=audio, duration=len(audio) / RATE)


def test_no_speech_in_a_loud_window_is_transcribed_without_the_detector(monkeypatch, tmp_path):
    worker, model = make_worker(monkeypatch, tmp_path)
    s = session(tone(40.0))
    worker.process(s, 0.0, 20.0)
    assert len(model.calls) == 1
    assert model.calls[0]["vad_filter"] is False
    assert "vad_parameters" not in model.calls[0]
    assert model.calls[0]["word_timestamps"] is True  # everything else as before
    assert [c["text"] for c in s.cues] == ["君の声が聞こえる夜に", "星を数えて眠る"]
    assert [c["seg"] for c in s.cues] == [0, 1]
    assert s.speech == [[1.0, 4.0], [6.0, 8.5]]  # the sung lines are the window's speech
    assert s.covered == [[0.0, 20.0]]
    assert s.busy is None


def test_a_quiet_window_without_speech_takes_the_usual_path(monkeypatch, tmp_path):
    worker, model = make_worker(monkeypatch, tmp_path)
    s = session(silence(40.0))
    worker.process(s, 0.0, 20.0)
    assert model.calls[0]["vad_filter"] is True
    assert model.calls[0]["vad_parameters"] == server.VAD_PARAMS
    assert s.speech == []


def test_speech_heard_takes_the_usual_path(monkeypatch, tmp_path):
    worker, model = make_worker(monkeypatch, tmp_path, speech=[[0.5, 3.0]])
    s = session(tone(40.0))
    worker.process(s, 0.0, 20.0)
    assert model.calls[0]["vad_filter"] is True
    assert "vad_parameters" in model.calls[0]
    assert s.speech == [[0.5, 3.0]]


def test_lyrics_off_takes_the_usual_path(monkeypatch, tmp_path):
    worker, model = make_worker(monkeypatch, tmp_path, lyrics="off")
    s = session(tone(40.0))
    worker.process(s, 0.0, 20.0)
    assert model.calls[0]["vad_filter"] is True
    assert "vad_parameters" in model.calls[0]
    assert s.speech == []


def test_a_rejected_line_takes_no_segment_id_and_no_span(monkeypatch, tmp_path):
    segs = [SUNG[0], line("ご視聴ありがとうございました", 10.0, 12.0), SUNG[1]]
    worker, _model = make_worker(monkeypatch, tmp_path, segs=segs)
    s = session(tone(40.0))
    worker.process(s, 0.0, 20.0)
    assert [c["text"] for c in s.cues] == ["君の声が聞こえる夜に", "星を数えて眠る"]
    assert [c["seg"] for c in s.cues] == [0, 1]
    assert s.seg_next == 2
    assert s.speech == [[1.0, 4.0], [6.0, 8.5]]


def test_the_log_line_says_which_way_the_window_went(monkeypatch, tmp_path, caplog):
    caplog.set_level(logging.INFO, logger="shisu-ko")
    segs = SUNG + [line("ご視聴ありがとうございました", 10.0, 12.0)]
    worker, _model = make_worker(monkeypatch, tmp_path, segs=segs)
    s = session(tone(40.0))
    worker.process(s, 0.0, 20.0)
    assert any("2 cues" in r.getMessage() and "[lyrics] [dropped blocklist:1]" in r.getMessage() for r in caplog.records)

    caplog.clear()
    worker.process(s, 20.0, 40.0)
    assert any("cues" in r.getMessage() and "[lyrics]" in r.getMessage() for r in caplog.records)

    caplog.clear()
    usual, _model = make_worker(monkeypatch, tmp_path, speech=[[0.5, 3.0]])
    usual.process(session(tone(40.0)), 0.0, 20.0)
    assert not any("[lyrics]" in r.getMessage() for r in caplog.records)


def test_a_lyrics_window_casts_no_language_vote(monkeypatch, tmp_path):
    # The watch runs before the decision and hears no speech, so it asks the head nothing; the
    # one detection is the lyrics rule's own, on the window's samples, and it is no vote.
    worker, model = make_worker(monkeypatch, tmp_path)
    s = session(tone(40.0))
    worker.process(s, 0.0, 20.0)
    assert model.detections == 1
    assert len(model.judged[0]) == 20 * RATE
    assert s.heard is None and s.foreign_seconds == 0.0 and s.language_paused is False
    assert s.cues


# --------------------------------------------------------------------------- the language verdict

def test_a_loud_window_sung_in_another_language_stays_with_the_detector(monkeypatch, tmp_path):
    # An English song under a montage: loud, no speech to Silero, and English to the head. The
    # VAD path decodes nothing of it, and the verdict is no vote: nothing pauses.
    worker, model = make_worker(monkeypatch, tmp_path, verdict=("en", 0.99))
    s = session(tone(40.0))
    worker.process(s, 0.0, 20.0)
    assert model.detections == 1
    assert model.calls[0]["vad_filter"] is True
    assert model.calls[0]["vad_parameters"] == server.VAD_PARAMS
    assert s.cues == [] and s.speech == []
    assert s.covered == [[0.0, 20.0]]
    assert s.heard is None and s.foreign_seconds == 0.0 and s.language_paused is False


def test_a_loud_window_the_head_is_unsure_of_stays_with_the_detector(monkeypatch, tmp_path):
    # Rain, a crowd, an engine: the head guesses, below LANGUAGE_MIN_PROB, and nothing is decoded.
    worker, model = make_worker(monkeypatch, tmp_path, verdict=("ja", 0.4))
    s = session(tone(40.0))
    worker.process(s, 0.0, 20.0)
    assert model.detections == 1
    assert model.calls[0]["vad_filter"] is True
    assert s.cues == [] and s.speech == []
    assert s.heard is None and s.language_paused is False


def test_a_loud_window_sung_in_the_target_language_takes_the_lyrics_path(monkeypatch, tmp_path):
    worker, model = make_worker(monkeypatch, tmp_path, verdict=("ja", server.LANGUAGE_MIN_PROB))
    s = session(tone(40.0))
    worker.process(s, 0.0, 20.0)
    assert model.detections == 1
    assert model.calls[0]["vad_filter"] is False
    assert [c["text"] for c in s.cues] == ["君の声が聞こえる夜に", "星を数えて眠る"]


def test_a_failing_head_leaves_the_window_to_the_lyrics_path(monkeypatch, tmp_path, caplog):
    # A detector failure must never silence a video: decoded as sung, unjudged, with a warning.
    caplog.set_level(logging.WARNING, logger="shisu-ko")
    worker, model = make_worker(monkeypatch, tmp_path)
    monkeypatch.setattr(model, "detect_language", lambda **kwargs: (_ for _ in ()).throw(RuntimeError("no encoder")))
    s = session(tone(40.0))
    worker.process(s, 0.0, 20.0)
    assert model.calls[0]["vad_filter"] is False
    assert [c["text"] for c in s.cues] == ["君の声が聞こえる夜に", "星を数えて眠る"]
    assert s.heard is None and s.language_paused is False
    assert any("language detection of a sung window failed" in r.getMessage() for r in caplog.records)


def test_the_verdict_is_asked_whatever_the_language_patience(monkeypatch, tmp_path):
    # --language-patience 0 turns the pause off; this check guards a decode, not the pause.
    worker, model = make_worker(monkeypatch, tmp_path, verdict=("en", 0.99), language_patience=0.0)
    s = session(tone(40.0))
    worker.process(s, 0.0, 20.0)
    assert model.detections == 1
    assert model.calls[0]["vad_filter"] is True
    assert s.cues == []

    worker, model = make_worker(monkeypatch, tmp_path, language_patience=0.0)
    s = session(tone(40.0))
    worker.process(s, 0.0, 20.0)
    assert model.detections == 1
    assert model.calls[0]["vad_filter"] is False
    assert s.cues


def test_the_head_is_not_asked_when_the_window_is_talk_or_silence_or_lyrics_off(monkeypatch, tmp_path):
    # Whatever the loudness rule refuses is never judged: no encoder pass is spent on it.
    worker, model = make_worker(monkeypatch, tmp_path)
    worker.process(session(silence(40.0)), 0.0, 20.0)
    assert model.detections == 0

    worker, model = make_worker(monkeypatch, tmp_path, lyrics="off")
    worker.process(session(tone(40.0)), 0.0, 20.0)
    assert model.detections == 0

    # Speech heard, below the watch's LANGUAGE_MIN_SPEECH but at least a second: talk, unjudged.
    worker, model = make_worker(monkeypatch, tmp_path, speech=[[0.5, 2.0]])
    worker.process(session(tone(40.0)), 0.0, 20.0)
    assert model.detections == 0
    assert model.calls[0]["vad_filter"] is True


def test_a_live_stream_takes_the_same_path(monkeypatch, tmp_path):
    worker, model = make_worker(monkeypatch, tmp_path)
    s = server.Session(video_id=VIDEO, url="u", status="ready", live=True, live_audio=server.LiveAudio())
    s.live_audio.add(100.0, tone(30.0))
    worker.process(s, 100.0, 120.0)
    assert model.calls[0]["vad_filter"] is False
    assert [c["text"] for c in s.cues] == ["君の声が聞こえる夜に", "星を数えて眠る"]
    assert s.speech == [[101.0, 104.0], [106.0, 108.5]]


# --------------------------------------------------------------------------- the cue cache

def test_subtract_intervals_cuts_the_holes_out():
    assert server.subtract_intervals([[0.0, 10.0]], [[2.0, 3.0], [8.0, 12.0]]) == [[0.0, 2.0], [3.0, 8.0]]
    assert server.subtract_intervals([[0.0, 10.0]], [[0.0, 10.0]]) == []
    assert server.subtract_intervals([[0.0, 10.0]], []) == [[0.0, 10.0]]
    assert server.subtract_intervals([], [[0.0, 10.0]]) == []
    assert server.subtract_intervals([[0.0, 4.0], [6.0, 10.0]], [[3.0, 7.0]]) == [[0.0, 3.0], [7.0, 10.0]]
    assert server.subtract_intervals([[0.0, 10.0]], [[-5.0, 1.0], [9.0, 15.0]]) == [[1.0, 9.0]]


def test_unheard_stretches_are_the_covered_parts_no_speech_and_no_cue_touches():
    cues = [{"start": 5.0, "end": 8.0, "text": "a"}]
    # The gap before the speech is under the floor; the one between speech and cue is not.
    assert server.unheard_stretches([[0.0, 30.0]], [[1.0, 2.0]], cues) == [[2.0, 5.0], [8.0, 30.0]]
    assert server.unheard_stretches([[0.0, 30.0]], [[1.0, 2.0]], cues, min_seconds=25.0) == []
    assert server.unheard_stretches([[0.0, 34.04]], [], []) == [[0.0, 34.04]]   # the Short
    assert server.unheard_stretches([[0.0, 10.0]], [[0.0, 10.0]], []) == []
    assert server.unheard_stretches([], [], []) == []
    # A speech interval straddling the start of a gap shortens it; one touching the end closes it.
    assert server.unheard_stretches([[0.0, 20.0]], [[0.0, 4.0], [18.5, 25.0]], []) == [[4.0, 18.5]]


def make_app(monkeypatch, tmp_path, **args_overrides):
    monkeypatch.setattr(server, "CACHE_DIR", tmp_path)
    base = dict(model="large-v3", language="ja", idle_minutes=30, language_patience=60.0, lyrics="auto")
    base.update(args_overrides)
    return server.App(SimpleNamespace(**base), model=None, device="cpu", compute_type="int8")


def write_record(tmp_path, cues, covered, speech, duration=34.04, **extra):
    """A format-2 record as a server before the lyrics rule wrote it: no "lyrics" key."""
    import json

    data = {"video_id": VIDEO, "title": "OP", "duration": duration, "format": server.CACHE_FORMAT,
            "model": "large-v3", "language": "ja", "cues": cues, "covered": covered, "speech": speech,
            "language_state": {"foreign_seconds": 0.0, "heard": None, "paused": False}}
    data.update(extra)
    (tmp_path / f"{VIDEO}.cues.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def test_a_music_video_cached_before_the_rule_is_offered_to_the_planner_again(monkeypatch, tmp_path, caplog):
    # The Short's own record: covered to the end, nothing heard, nothing decoded. Loading it as
    # ready would keep it blank for ever; instead nothing is covered and the audio is fetched anew.
    caplog.set_level(logging.INFO, logger="shisu-ko")
    app = make_app(monkeypatch, tmp_path)
    write_record(tmp_path, cues=[], covered=[[0.0, 34.04]], speech=[])
    s = server.Session(video_id=VIDEO, url="u")
    app.load_cache(s)
    assert s.title == "OP" and s.duration == 34.04
    assert s.covered == [] and s.cues == [] and s.speech == []
    assert s.status == "pending"
    assert any("34 s were covered before the lyrics rule" in r.getMessage() for r in caplog.records)


def test_a_talk_video_cached_before_the_rule_keeps_its_cues_and_gives_back_its_blank_stretch(monkeypatch, tmp_path):
    app = make_app(monkeypatch, tmp_path)
    cues = [{"start": 1.0, "end": 4.0, "text": "これは", "seg": 0}, {"start": 4.2, "end": 20.0, "text": "テスト", "seg": 1}]
    write_record(tmp_path, cues=cues, covered=[[0.0, 60.0]], speech=[[0.8, 19.5]], duration=60.0)
    s = server.Session(video_id=VIDEO, url="u")
    app.load_cache(s)
    assert [c["text"] for c in s.cues] == ["これは", "テスト"]
    assert [c["seg"] for c in s.cues] == [0, 1] and s.seg_next == 2
    assert s.speech == [[0.8, 19.5]]
    assert s.covered == [[0.0, 20.0]]  # the song bridge after the talk is transcribed again
    assert s.status == "pending"


def test_a_record_written_under_the_rule_loads_untouched(monkeypatch, tmp_path):
    app = make_app(monkeypatch, tmp_path)
    write_record(tmp_path, cues=[], covered=[[0.0, 34.04]], speech=[], lyrics="auto")
    s = server.Session(video_id=VIDEO, url="u")
    app.load_cache(s)
    assert s.covered == [[0.0, 34.04]]
    assert s.status == "ready"


def test_a_record_written_with_lyrics_off_is_offered_again_under_auto(monkeypatch, tmp_path):
    # --lyrics off covers a sung window with nothing in it just as the old server did.
    app = make_app(monkeypatch, tmp_path)
    write_record(tmp_path, cues=[], covered=[[0.0, 34.04]], speech=[], lyrics="off")
    s = server.Session(video_id=VIDEO, url="u")
    app.load_cache(s)
    assert s.covered == [] and s.status == "pending"


def test_lyrics_off_loads_an_old_record_untouched(monkeypatch, tmp_path):
    app = make_app(monkeypatch, tmp_path, lyrics="off")
    write_record(tmp_path, cues=[], covered=[[0.0, 34.04]], speech=[])
    s = server.Session(video_id=VIDEO, url="u")
    app.load_cache(s)
    assert s.covered == [[0.0, 34.04]]
    assert s.status == "ready"


def test_save_cache_writes_the_rule_and_its_own_record_reloads_as_covered(monkeypatch, tmp_path):
    import json

    app = make_app(monkeypatch, tmp_path)
    s = server.Session(video_id=VIDEO, url="u", duration=34.04)
    s.covered = [[0.0, 34.04]]  # a window the head heard no Japanese in: covered, nothing in it
    app.save_cache(s)
    data = json.loads((tmp_path / f"{VIDEO}.cues.json").read_text(encoding="utf-8"))
    assert data["lyrics"] == "auto"
    assert data["format"] == server.CACHE_FORMAT  # no bump: older records are migrated, not dropped

    reloaded = server.Session(video_id=VIDEO, url="u")
    app.load_cache(reloaded)
    assert reloaded.covered == [[0.0, 34.04]]
    assert reloaded.status == "ready"

    off = make_app(monkeypatch, tmp_path, lyrics="off")
    off.save_cache(s)
    assert json.loads((tmp_path / f"{VIDEO}.cues.json").read_text(encoding="utf-8"))["lyrics"] == "off"


# --------------------------------------------------------------------------- --lyrics

def test_parse_args_takes_auto_or_off(monkeypatch, tmp_path):
    monkeypatch.setattr(server, "CONFIG_PATH", tmp_path / "config.json")
    assert server.parse_args([]).lyrics == "auto"
    assert server.parse_args(["--lyrics", "off"]).lyrics == "off"
    with pytest.raises(SystemExit):
        server.parse_args(["--lyrics", "maybe"])


def load_retranscribe():
    """server/tools/retranscribe.py as a module, the way test_setup_model.py loads it: its own
    load_server() finds shisuko_server in sys.modules, so it drives this test's server module,
    and the HF_HUB_OFFLINE=1 its import sets for the process is put back afterwards."""
    name = "shisuko_retranscribe"
    cached = sys.modules.get(name)
    if cached is not None:
        return cached
    offline = os.environ.get("HF_HUB_OFFLINE")
    path = Path(__file__).resolve().parent.parent / "tools" / "retranscribe.py"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    finally:
        if offline is None:
            os.environ.pop("HF_HUB_OFFLINE", None)
        else:
            os.environ["HF_HUB_OFFLINE"] = offline
    return module


def test_retranscribe_takes_the_lyrics_switch_too(monkeypatch, tmp_path):
    """The measuring tool drives process() like the server, so a cache can be measured both ways."""
    monkeypatch.setattr(server, "CONFIG_PATH", tmp_path / "config.json")
    tool = load_retranscribe()
    assert tool.server is server
    assert tool.parse_args([VIDEO, "--out", str(tmp_path / "x")]).lyrics == "auto"
    assert tool.parse_args([VIDEO, "--out", str(tmp_path / "x"), "--lyrics", "off"]).lyrics == "off"
    with pytest.raises(SystemExit):
        tool.parse_args([VIDEO, "--out", str(tmp_path / "x"), "--lyrics", "maybe"])

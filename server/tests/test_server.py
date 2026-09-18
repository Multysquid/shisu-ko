"""Unit tests for the pure planning / cue-splitting / formatting helpers in server/server.py.

These do not touch the network, GPU or a real Whisper model: only the functions that are
plain data in, data out, as called out in the README's Development section.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from _serverlib import load_server

server = load_server()


def make_args(**overrides):
    base = dict(first_window=20.0, window=40.0, lookahead=900.0)
    base.update(overrides)
    return SimpleNamespace(**base)


def make_word(word: str, start: float, end: float):
    return SimpleNamespace(word=word, start=start, end=end)


def make_segment(text: str, start: float, end: float, words=None):
    return SimpleNamespace(text=text, start=start, end=end, words=words)


# --------------------------------------------------------------------------- fmt_time

@pytest.mark.parametrize(
    "seconds, expected",
    [
        (0, "0:00"),
        (5, "0:05"),
        (65, "1:05"),
        (599, "9:59"),
        (3600, "1:00:00"),
        (3661, "1:01:01"),
        (-5, "0:00"),  # clamped to zero
    ],
)
def test_fmt_time(seconds, expected):
    assert server.fmt_time(seconds) == expected


# --------------------------------------------------------------------------- merge_intervals

def test_merge_intervals_sorts_and_merges_overlaps():
    # [0,5] and [4,12] overlap into [0,12]; [10,20] then overlaps that too, so everything
    # collapses into a single interval.
    out = server.merge_intervals([[10, 20], [0, 5], [4, 12]])
    assert out == [[0, 20]]


def test_merge_intervals_merges_adjacent_within_gap():
    out = server.merge_intervals([[0, 5], [5.03, 10]], gap=0.05)
    assert out == [[0, 10]]


def test_merge_intervals_keeps_far_apart_intervals_separate():
    out = server.merge_intervals([[0, 5], [6, 10]], gap=0.05)
    assert out == [[0, 5], [6, 10]]


def test_merge_intervals_drops_empty_or_inverted_intervals():
    out = server.merge_intervals([[5, 5], [10, 2]])
    assert out == []


def test_merge_intervals_empty_input():
    assert server.merge_intervals([]) == []


# --------------------------------------------------------------------------- find_covering / next_start_after

def test_find_covering_returns_matching_interval():
    intervals = [(0.0, 5.0), (10.0, 20.0)]
    assert server.find_covering(intervals, 12.0) == (10.0, 20.0)


def test_find_covering_respects_tolerance():
    intervals = [(0.0, 5.0)]
    assert server.find_covering(intervals, 5.2, tol=0.25) == (0.0, 5.0)
    assert server.find_covering(intervals, 5.3, tol=0.25) is None


def test_find_covering_no_match_returns_none():
    assert server.find_covering([(0.0, 5.0)], 7.0) is None


def test_next_start_after_picks_smallest_start_greater_than_t():
    intervals = [(0.0, 5.0), (20.0, 25.0), (10.0, 15.0)]
    assert server.next_start_after(intervals, 5.0) == 10.0


def test_next_start_after_returns_none_when_nothing_later():
    assert server.next_start_after([(0.0, 5.0)], 5.0) is None


# --------------------------------------------------------------------------- friendly_error

@pytest.mark.parametrize(
    "message, expected_snippet",
    [
        ("ERROR: Sign in to confirm you're not a bot", "sign-in"),
        ("This video is Private video", "private"),
        ("This video is members-only, join this channel", "Members-only"),
        ("No javascript runtime could be found", "Node.js or Deno"),
        ("ERROR: Video unavailable", "unavailable"),
    ],
)
def test_friendly_error_recognizes_known_causes(message, expected_snippet):
    result = server.friendly_error(RuntimeError(message))
    assert expected_snippet.lower() in result.lower()


def test_friendly_error_falls_back_to_last_line_truncated():
    long_line = "x" * 300
    exc = RuntimeError(f"first line\n{long_line}")
    result = server.friendly_error(exc)
    assert result == long_line[:200]
    assert len(result) == 200


def test_friendly_error_uses_class_name_when_message_empty():
    class Boom(Exception):
        pass

    assert server.friendly_error(Boom()) == "Boom"


# --------------------------------------------------------------------------- split_segment

def test_split_segment_without_words_returns_single_offset_cue():
    seg = make_segment("hello", 1.0, 2.0, words=None)
    cues = server.split_segment(seg, offset=100.0, max_chars=42, max_seconds=7.0)
    assert cues == [(101.0, 102.0, "hello")]


def test_split_segment_empty_text_returns_nothing():
    seg = make_segment("   ", 0.0, 1.0)
    assert server.split_segment(seg, offset=0.0, max_chars=42, max_seconds=7.0) == []


def test_split_segment_flushes_at_sentence_end():
    words = [
        make_word("これは", 0.0, 0.4),
        make_word("テストです", 0.4, 1.0),
        make_word("。", 1.0, 1.1),
    ]
    seg = make_segment("これはテストです。", 0.0, 1.1, words=words)
    cues = server.split_segment(seg, offset=0.0, max_chars=42, max_seconds=7.0)
    assert len(cues) == 1
    start, end, text = cues[0]
    assert text == "これはテストです。"
    assert start == pytest.approx(0.0)
    assert end == pytest.approx(1.1)


def test_split_segment_applies_offset_to_word_timestamps():
    words = [make_word("あああああああああ", 5.0, 6.0), make_word("。", 6.0, 6.2)]
    seg = make_segment("あああああああああ。", 5.0, 6.2, words=words)
    cues = server.split_segment(seg, offset=1000.0, max_chars=42, max_seconds=7.0)
    assert len(cues) == 1
    start, end, _ = cues[0]
    assert start == pytest.approx(1005.0)
    assert end == pytest.approx(1006.2)


def test_split_segment_flushes_on_max_chars_without_punctuation():
    words = [make_word("あ", float(i), float(i) + 0.5) for i in range(10)]
    seg = make_segment("あ" * 10, 0.0, 10.0, words=words)
    cues = server.split_segment(seg, offset=0.0, max_chars=5, max_seconds=100.0)
    assert len(cues) >= 2
    assert all(len(text) <= 5 for _, _, text in cues[:-1])


def test_split_segment_flushes_on_max_seconds():
    # Two long (>=4 char, so the trailing-fragment fold does not re-merge them) words with no
    # punctuation: duration alone should force a flush after each one.
    words = [make_word("あいうえお", 0.0, 4.0), make_word("かきくけこ", 4.0, 8.0)]
    seg = make_segment("あいうえおかきくけこ", 0.0, 8.0, words=words)
    cues = server.split_segment(seg, offset=0.0, max_chars=42, max_seconds=3.0)
    assert [text for _, _, text in cues] == ["あいうえお", "かきくけこ"]


def test_split_segment_flushes_on_clause_break_past_threshold():
    words = [
        make_word("ああああああ", 0.0, 0.6),  # 6 chars, threshold = 10 * 0.6 = 6
        make_word("、", 0.6, 0.7),
        make_word("いいいい", 0.7, 1.0),  # >=4 chars so the trailing-fragment fold leaves it alone
    ]
    seg = make_segment("ああああああ、いいいい", 0.0, 1.0, words=words)
    cues = server.split_segment(seg, offset=0.0, max_chars=10, max_seconds=100.0)
    assert [text for _, _, text in cues] == ["ああああああ、", "いいいい"]


def test_split_segment_folds_tiny_trailing_fragment_into_previous_cue():
    words = [
        make_word("これはテストです", 0.0, 0.9),
        make_word("。", 0.9, 1.0),
        make_word("ね", 1.0, 1.2),  # trailing 1-char fragment, never flushed by punctuation
    ]
    seg = make_segment("これはテストです。ね", 0.0, 1.2, words=words)
    cues = server.split_segment(seg, offset=0.0, max_chars=42, max_seconds=100.0)
    assert len(cues) == 1
    start, end, text = cues[0]
    assert text == "これはテストです。ね"
    assert end == pytest.approx(1.2)


# --------------------------------------------------------------------------- JUNK_RE / VIDEO_ID_RE

@pytest.mark.parametrize("text", ["", "   ", "...", "―", "_"])
def test_junk_re_matches_punctuation_only_text(text):
    assert server.JUNK_RE.match(text)


@pytest.mark.parametrize("text", ["hello", "あ", "a.", "42"])
def test_junk_re_rejects_text_with_content(text):
    assert not server.JUNK_RE.match(text)


@pytest.mark.parametrize("video_id", ["dQw4w9WgXcQ", "abcdef", "A_B-C123456789"])
def test_video_id_re_accepts_youtube_ids(video_id):
    assert server.VIDEO_ID_RE.match(video_id)


@pytest.mark.parametrize("video_id", ["", "short", "has space", "semi;colon", "x" * 21])
def test_video_id_re_rejects_invalid_ids(video_id):
    assert not server.VIDEO_ID_RE.match(video_id)


# --------------------------------------------------------------------------- Session.fully_covered

def test_session_fully_covered_true_when_one_interval_spans_the_video():
    s = server.Session(video_id="abcdefabcdef", url="u", duration=100.0, covered=[[0.0, 100.0]])
    assert s.fully_covered()


def test_session_fully_covered_false_with_gaps_or_multiple_intervals():
    s = server.Session(video_id="abcdefabcdef", url="u", duration=100.0, covered=[[0.0, 50.0], [50.0, 100.0]])
    assert not s.fully_covered()


def test_session_fully_covered_false_with_no_duration():
    s = server.Session(video_id="abcdefabcdef", url="u", duration=0.0, covered=[[0.0, 0.0]])
    assert not s.fully_covered()


# --------------------------------------------------------------------------- plan_window

def test_plan_window_none_when_session_not_ready():
    s = server.Session(video_id="abcdefabcdef", url="u", status="pending")
    assert server.plan_window(s, make_args()) is None


def test_plan_window_starts_a_fresh_window_from_the_playhead():
    s = server.Session(video_id="abcdefabcdef", url="u", status="ready", audio=object(), duration=120.0, want_t=10.0)
    window = server.plan_window(s, make_args(first_window=20.0))
    assert window == (9.5, 29.5)


def test_plan_window_continues_after_a_covered_region():
    s = server.Session(
        video_id="abcdefabcdef", url="u", status="ready", audio=object(),
        duration=200.0, want_t=5.0, covered=[[0.0, 30.0]],
    )
    window = server.plan_window(s, make_args(window=40.0, lookahead=0))
    assert window == (30.0, 70.0)


def test_plan_window_none_when_fully_covered_to_the_end():
    s = server.Session(
        video_id="abcdefabcdef", url="u", status="ready", audio=object(),
        duration=100.0, want_t=0.0, covered=[[0.0, 100.0]],
    )
    assert server.plan_window(s, make_args()) is None


def test_plan_window_stops_at_lookahead_limit():
    s = server.Session(
        video_id="abcdefabcdef", url="u", status="ready", audio=object(),
        duration=1000.0, want_t=0.0, covered=[[0.0, 30.0]],
    )
    assert server.plan_window(s, make_args(lookahead=10.0)) is None


def test_plan_window_ignores_lookahead_when_disabled():
    s = server.Session(
        video_id="abcdefabcdef", url="u", status="ready", audio=object(),
        duration=1000.0, want_t=0.0, covered=[[0.0, 30.0]],
    )
    assert server.plan_window(s, make_args(lookahead=0, window=40.0)) == (30.0, 70.0)


def test_plan_window_is_clipped_by_the_next_covered_region():
    s = server.Session(
        video_id="abcdefabcdef", url="u", status="ready", audio=object(),
        duration=200.0, want_t=0.0, covered=[[0.0, 10.0], [15.0, 20.0]],
    )
    window = server.plan_window(s, make_args(window=40.0, lookahead=0))
    assert window == (10.0, 15.0)


def test_plan_window_merges_tiny_remaining_gap_instead_of_returning_it():
    s = server.Session(
        video_id="abcdefabcdef", url="u", status="ready", audio=object(),
        duration=200.0, want_t=0.0, covered=[[0.0, 10.0], [10.8, 20.0]],
    )
    result = server.plan_window(s, make_args(window=40.0, lookahead=0))
    assert result is None
    assert s.covered == [[0.0, 20.0]]


# --------------------------------------------------------------------------- App cache round trip

def test_app_cache_round_trips_cues_for_matching_model_and_drops_for_different_model(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "CACHE_DIR", tmp_path)

    args = make_args(model="large-v3", language="ja", idle_minutes=30)
    app = server.App(args, model=None, device="cpu", compute_type="int8")

    original = server.Session(video_id="abcdefabcdef", url="u")
    original.title = "A great video"
    original.cues = [{"start": 0.0, "end": 1.0, "text": "hello"}]
    original.covered = [[0.0, 1.0]]
    original.duration = 10.0
    app.save_cache(original)

    reloaded = server.Session(video_id="abcdefabcdef", url="u")
    app.load_cache(reloaded)
    assert reloaded.title == "A great video"
    assert [c["text"] for c in reloaded.cues] == ["hello"]
    assert reloaded.covered == [[0.0, 1.0]]

    other_model_args = make_args(model="a-different-model", language="ja", idle_minutes=30)
    other_app = server.App(other_model_args, model=None, device="cpu", compute_type="int8")
    reloaded_other = server.Session(video_id="abcdefabcdef", url="u")
    other_app.load_cache(reloaded_other)
    assert reloaded_other.title == "A great video"
    assert reloaded_other.cues == []

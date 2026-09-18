"""/clip must recover when the cue cache marks a video ready but its audio file is gone."""
from __future__ import annotations

import time
from types import SimpleNamespace

import pytest

from _serverlib import load_server

server = load_server()
VIDEO = "abcdefabcdef"


def make_app(monkeypatch, tmp_path):
    monkeypatch.setattr(server, "CACHE_DIR", tmp_path)
    args = SimpleNamespace(first_window=20.0, window=40.0, lookahead=900.0, model="large-v3", language="ja", idle_minutes=30)
    app = server.App(args, model=None, device="cpu", compute_type="int8")
    calls = []
    app.fetcher = SimpleNamespace(fetch=lambda s: calls.append(s.video_id))
    return app, calls


def wait_for(predicate, timeout=2.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


def test_clip_refetches_audio_for_a_cache_only_ready_session(monkeypatch, tmp_path):
    app, calls = make_app(monkeypatch, tmp_path)
    s = server.Session(video_id=VIDEO, url="u", status="ready", duration=100.0, covered=[[0.0, 100.0]])
    with app.lock:
        app.sessions[VIDEO] = s
    with pytest.raises(server.ClipNotReady):
        app.clip(VIDEO, 1.0, 3.0, "mp3")
    assert wait_for(lambda: calls == [VIDEO])
    assert s.status == "pending"  # the stub fetcher leaves it there; the real one moves it to downloading/ready


def test_clip_does_not_restart_a_fetch_already_in_flight(monkeypatch, tmp_path):
    app, calls = make_app(monkeypatch, tmp_path)
    s = server.Session(video_id=VIDEO, url="u", status="downloading", fetching=True)
    with app.lock:
        app.sessions[VIDEO] = s
    with pytest.raises(server.ClipNotReady):
        app.clip(VIDEO, 1.0, 3.0, "mp3")
    time.sleep(0.2)
    assert calls == []


def test_clip_validates_the_range_before_touching_sessions(monkeypatch, tmp_path):
    app, _ = make_app(monkeypatch, tmp_path)
    with pytest.raises(ValueError):
        app.clip(VIDEO, 5.0, 5.0, "mp3")
    with pytest.raises(ValueError):
        app.clip(VIDEO, 0.0, server.MAX_CLIP_SECONDS + 1, "mp3")

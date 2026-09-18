"""Every /sync answer carries a per-session token so clients notice when the server started over."""
from __future__ import annotations

from types import SimpleNamespace

from _serverlib import load_server

server = load_server()
VIDEO = "abcdefabcdef"


def make_app(monkeypatch, tmp_path):
    monkeypatch.setattr(server, "CACHE_DIR", tmp_path)
    args = SimpleNamespace(first_window=20.0, window=40.0, lookahead=900.0, model="large-v3", language="ja", idle_minutes=30)
    app = server.App(args, model=None, device="cpu", compute_type="int8")
    app.fetcher = SimpleNamespace(fetch=lambda s: None)
    return app


def test_sessions_get_distinct_tokens():
    a = server.Session(video_id=VIDEO, url="u")
    b = server.Session(video_id=VIDEO, url="u")
    assert a.token and b.token and a.token != b.token


def test_sync_reports_the_session_token(monkeypatch, tmp_path):
    app = make_app(monkeypatch, tmp_path)
    first = app.sync(VIDEO, "u", 0.0, 0)
    second = app.sync(VIDEO, "u", 5.0, 0)
    assert first["session"] == second["session"] == app.sessions[VIDEO].token


def test_new_server_session_has_a_new_token(monkeypatch, tmp_path):
    app = make_app(monkeypatch, tmp_path)
    token = app.sync(VIDEO, "u", 0.0, 0)["session"]
    with app.lock:
        del app.sessions[VIDEO]  # what a restart or cache reset amounts to
    assert app.sync(VIDEO, "u", 0.0, 0)["session"] != token

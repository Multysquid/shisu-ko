"""server/native_host.py: the native-messaging host behind the popup's "Start server" button.

The protocol is driven through in-memory streams, the launcher through a recorded
subprocess.Popen (and, on Windows, a real `start` on stub checkouts), and the registration into
a temp home with a recorded winreg. Nothing here touches the real registry, Firefox or the real
checkout's launchers: the checkout's wrappers are run for `status` only, which starts nothing.
"""
from __future__ import annotations

import errno
import http.server
import importlib.util
import io
import json
import os
import re
import struct
import subprocess
import sys
import threading
from pathlib import Path

import pytest

_HOST_PATH = Path(__file__).resolve().parent.parent / "native_host.py"
SERVER_DIR = _HOST_PATH.parent
ROOT = SERVER_DIR.parent
WINDOWS = sys.platform == "win32"
windows_only = pytest.mark.skipif(not WINDOWS, reason="Windows launch and registry")
posix_only = pytest.mark.skipif(WINDOWS, reason="POSIX launch and manifest folder")


def load_host():
    name = "shisuko_native_host"
    cached = sys.modules.get(name)
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location(name, _HOST_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


nh = load_host()


def frame(obj) -> bytes:
    data = json.dumps(obj).encode("utf-8")
    return struct.pack("<I", len(data)) + data


def unframe(data: bytes) -> list:
    """Every message on a stream of framed answers."""
    out, i = [], 0
    while i < len(data):
        (n,) = struct.unpack("<I", data[i:i + 4])
        out.append(json.loads(data[i + 4:i + 4 + n].decode("utf-8")))
        i += 4 + n
    assert i == len(data), "trailing bytes after the last frame"
    return out


# --- framing -----------------------------------------------------------------------------------

def test_messages_round_trip_through_the_length_prefix():
    out = io.BytesIO()
    nh.write_message(out, {"ok": True, "text": "日本語", "n": None})
    raw = out.getvalue()
    assert struct.unpack("<I", raw[:4])[0] == len(raw) - 4
    assert nh.read_message(io.BytesIO(raw)) == {"ok": True, "text": "日本語", "n": None}


def test_read_message_returns_eof_at_the_end_even_mid_message_but_not_for_null():
    assert nh.read_message(io.BytesIO(b"")) is nh.EOF
    assert nh.read_message(io.BytesIO(b"\x05\x00")) is nh.EOF
    assert nh.read_message(io.BytesIO(struct.pack("<I", 10) + b"{}")) is nh.EOF
    assert nh.read_message(io.BytesIO(frame(None))) is None, "a JSON null is a message, not the end"


def test_read_message_refuses_oversize_frames_without_reading_them():
    stream = io.BytesIO(struct.pack("<I", nh.MAX_MESSAGE_BYTES + 1) + b"x")
    with pytest.raises(nh.MessageTooLarge):
        nh.read_message(stream)
    assert stream.tell() == 4, "only the header was consumed"
    assert nh.read_message(io.BytesIO(frame("x" * 100))) == "x" * 100


def test_read_message_raises_on_bad_json_after_consuming_the_frame():
    stream = io.BytesIO(struct.pack("<I", 3) + b"{ab" + frame({"cmd": "status"}))
    with pytest.raises(ValueError):
        nh.read_message(stream)
    assert nh.read_message(stream) == {"cmd": "status"}


# --- handle() ----------------------------------------------------------------------------------

def never_launch(root):
    raise AssertionError(f"launch() must not run for this request (root {root})")


def test_status_reports_running_version_and_root(tmp_path):
    answer = nh.handle({"cmd": "status"}, running=lambda: True, launch=never_launch, root=tmp_path)
    assert answer == {"ok": True, "running": True, "version": nh.VERSION, "root": str(tmp_path)}
    assert nh.handle({"cmd": "status"}, running=lambda: False, launch=never_launch)["running"] is False
    assert nh.handle({"cmd": "status"}, running=lambda: False, launch=never_launch)["root"] == str(ROOT)


def test_start_launches_only_when_the_server_is_down(tmp_path):
    calls = []

    def launch(root):
        calls.append(root)
        return {"ok": True, "started": True, "log": None}

    assert nh.handle({"cmd": "start"}, running=lambda: True, launch=launch,
                     starting=lambda: pytest.fail("a running server needs no lock check")) == {"ok": True, "already": True}
    assert calls == []
    assert nh.handle({"cmd": "start"}, running=lambda: False, launch=launch, root=tmp_path, starting=lambda: False) == {
        "ok": True, "started": True, "log": None}
    assert calls == [tmp_path]


def test_start_waits_for_a_launched_server_that_is_still_loading():
    """The model load keeps /health silent for a while; the lock says a server is on its way."""
    answer = nh.handle({"cmd": "start"}, running=lambda: False, launch=never_launch, starting=lambda: True)
    assert answer == {"ok": True, "already": True, "starting": True}


def test_start_turns_a_launch_failure_into_one_line():
    def launch(root):
        raise FileNotFoundError("run.cmd is missing\nsecond line")

    answer = nh.handle({"cmd": "start"}, running=lambda: False, launch=launch, starting=lambda: False)
    assert answer == {"ok": False, "error": "run.cmd is missing second line"}


def test_server_starting_follows_the_instance_lock(tmp_path):
    data = tmp_path / "data"
    env = {"SHISUKO_HOME": str(data)}
    assert nh.server_starting(environ=env) is False
    held = nh.try_lock(data / nh.LOCK_NAME)
    assert held is not None
    try:
        assert nh.server_starting(environ=env) is True
        assert nh.try_lock(data / nh.LOCK_NAME) is None
    finally:
        held.close()
    assert nh.server_starting(environ=env) is False
    (tmp_path / "file").write_text("")
    assert nh.server_starting(environ={"SHISUKO_HOME": str(tmp_path / "file")}) is False, "no usable lock: as before"


def lock_call_raises(monkeypatch, code: int) -> None:
    """Make the platform's non-blocking lock call fail with `code`, the file itself opening fine."""
    def raise_(*args):
        raise OSError(code, os.strerror(code))
    if WINDOWS:
        monkeypatch.setattr(nh.msvcrt, "locking", raise_)
    else:
        monkeypatch.setattr(nh.fcntl, "flock", raise_)


def test_server_starting_reads_only_a_held_lock_as_starting(tmp_path, monkeypatch):
    """ENOLCK (an NFS home without a lock manager), EOPNOTSUPP, EINVAL: the file cannot be locked at all.

    Read as held, every "start" would answer "already" without launching: a button that never works.
    """
    env = {"SHISUKO_HOME": str(tmp_path / "data")}
    lock_call_raises(monkeypatch, errno.ENOLCK)
    with pytest.raises(OSError):
        nh.try_lock(tmp_path / "data" / nh.LOCK_NAME)
    assert nh.server_starting(environ=env) is False
    lock_call_raises(monkeypatch, errno.EACCES if WINDOWS else errno.EWOULDBLOCK)
    assert nh.try_lock(tmp_path / "data" / nh.LOCK_NAME) is None, "what a held lock raises"
    assert nh.server_starting(environ=env) is True


def test_the_lock_is_the_one_server_py_holds_while_it_loads(tmp_path, monkeypatch):
    from _serverlib import load_server

    server = load_server()
    data = tmp_path / "data"
    monkeypatch.setattr(server, "APP_DIR", data)
    monkeypatch.setattr(server, "INSTANCE_LOCK", None)
    assert server.instance_lock_path(nh.PORT) == data / nh.LOCK_NAME
    assert server.hold_instance_lock(nh.PORT) is True
    try:
        assert nh.server_starting(environ={"SHISUKO_HOME": str(data)}) is True
    finally:
        server.INSTANCE_LOCK.close()
    assert nh.server_starting(environ={"SHISUKO_HOME": str(data)}) is False


@pytest.mark.parametrize("request_", [
    {"cmd": "stop"},
    {"cmd": "start", "path": "C:\\evil.exe"},
    {"cmd": "start", "args": ["--model", "x"]},
    {"cmd": ["start"]},
    {"cmd": None},
    {"command": "start"},
    {},
    ["start"],
    "start",
    42,
    None,
    True,
])
def test_anything_but_a_bare_command_is_unknown(request_):
    answer = nh.handle(request_, running=lambda: pytest.fail("running() must not be asked"), launch=never_launch)
    assert answer == {"ok": False, "error": "unknown command"}


# --- serve() -----------------------------------------------------------------------------------

def test_serve_answers_each_message_in_order_and_stops_at_eof(monkeypatch):
    monkeypatch.setattr(nh, "server_running", lambda: False)
    monkeypatch.setattr(nh, "server_starting", lambda: False)
    monkeypatch.setattr(nh, "launch", lambda root: {"ok": True, "started": True, "log": None})
    nested = b"[" * 50000 + b"]" * 50000  # well under MAX_MESSAGE_BYTES, past json's recursion limit
    stdin = io.BytesIO(frame({"cmd": "status"}) + struct.pack("<I", 3) + b"{ab" + frame("junk") + frame(None)
                       + struct.pack("<I", len(nested)) + nested + frame({"cmd": "start"}))
    stdout = io.BytesIO()
    assert nh.serve(stdin, stdout) == 0
    answers = unframe(stdout.getvalue())
    assert [a["ok"] for a in answers] == [True, False, False, False, False, True]
    assert answers[0]["running"] is False and answers[0]["version"] == nh.VERSION
    assert answers[1:5] == [{"ok": False, "error": "unknown command"}] * 4
    assert answers[5] == {"ok": True, "started": True, "log": None}


def test_serve_stops_after_an_oversize_frame(monkeypatch):
    monkeypatch.setattr(nh, "launch", never_launch)
    stdin = io.BytesIO(struct.pack("<I", 2 * nh.MAX_MESSAGE_BYTES) + frame({"cmd": "start"}))
    stdout = io.BytesIO()
    assert nh.serve(stdin, stdout) == 1
    (answer,) = unframe(stdout.getvalue())
    assert answer["ok"] is False and "exceeds" in answer["error"]


# --- launch() ----------------------------------------------------------------------------------

class RecordedPopen:
    """Stands in for subprocess.Popen: records the call, starts nothing."""

    def __init__(self, calls, fail_first=None):
        self.calls, self.fail_first = calls, fail_first

    def __call__(self, argv, **kwargs):
        if self.fail_first is not None and not self.calls:
            self.calls.append((argv, kwargs))
            raise self.fail_first
        self.calls.append((argv, kwargs))
        return object()


def fake_checkout(tmp_path: Path) -> Path:
    root = tmp_path / "checkout"
    (root / "server").mkdir(parents=True)
    (root / "server" / "run.cmd").write_bytes(b"@echo off\r\n")
    (root / "server" / "run.sh").write_bytes(b"#!/usr/bin/env bash\n")
    return root


@windows_only
def test_launch_on_windows_opens_a_console_with_the_repo_launcher_and_nothing_else(tmp_path, monkeypatch):
    root = fake_checkout(tmp_path)
    calls = []
    monkeypatch.setattr(nh.subprocess, "Popen", RecordedPopen(calls))
    assert nh.launch(root) == {"ok": True, "started": True, "log": None}
    (argv, kwargs), = calls
    server_dir = root / "server"
    # Relative to cwd, never the full path: cmd.exe splits a checkout path holding & ^ ( even in quotes.
    assert argv == ["cmd.exe", "/c", "start", "Shisu-ko server", ".\\run.cmd"]
    assert kwargs["cwd"] == str(server_dir)
    flags = kwargs["creationflags"]
    assert flags & subprocess.DETACHED_PROCESS and flags & subprocess.CREATE_NEW_PROCESS_GROUP
    assert flags & subprocess.CREATE_BREAKAWAY_FROM_JOB, "the first try leaves Firefox's job object"
    assert kwargs["stdin"] == kwargs["stdout"] == kwargs["stderr"] == subprocess.DEVNULL
    assert kwargs["close_fds"] is True


@windows_only
def test_launch_on_windows_retries_without_breakaway_when_the_job_forbids_it(tmp_path, monkeypatch):
    root = fake_checkout(tmp_path)
    calls = []
    monkeypatch.setattr(nh.subprocess, "Popen", RecordedPopen(calls, fail_first=PermissionError(13, "denied")))
    assert nh.launch(root)["started"] is True
    assert len(calls) == 2 and calls[0][0] == calls[1][0]
    assert calls[1][1]["creationflags"] == subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
    assert calls[1][1]["cwd"] == str(root / "server")


@windows_only
def test_launch_on_windows_runs_the_launcher_from_a_path_cmd_would_split(tmp_path, monkeypatch):
    """A real `start` in checkouts named like `R&D space`: the argv above is what makes them work."""
    import time

    monkeypatch.delenv("NoDefaultCurrentDirectoryInExePath", raising=False)  # a `.\\` path needs no lookup anyway
    # Every launch happens before any window closes: Windows Terminal, the default console host
    # on Windows 11, loses a console handed to it while it is closing its last tab (the process
    # never runs, about one `start` in eight when the previous stub exits at the same moment),
    # so the stubs keep their window open a few seconds and the markers are checked afterwards.
    markers = []
    for name in ("R&D space", "shisu-ko (1)", "plain"):
        root = tmp_path / name
        (root / "server").mkdir(parents=True)
        (root / "server" / "run.cmd").write_bytes(
            b'@echo off\r\necho ran> "%~dp0marker.txt"\r\nping -n 6 127.0.0.1 > nul\r\nexit\r\n')
        assert nh.launch(root)["started"] is True
        markers.append((name, root / "server" / "marker.txt"))
    for name, marker in markers:
        for _ in range(100):
            if marker.exists():
                break
            time.sleep(0.1)
        assert marker.exists(), f"run.cmd never ran in {name!r}"


@posix_only
def test_launch_on_posix_starts_the_repo_launcher_in_a_new_session_logging_to_the_data_dir(tmp_path, monkeypatch):
    root = fake_checkout(tmp_path)
    home = tmp_path / "data"
    calls = []
    monkeypatch.setattr(nh.subprocess, "Popen", RecordedPopen(calls))
    answer = nh.launch(root, environ={"SHISUKO_HOME": str(home)})
    (argv, kwargs), = calls
    # Through bash: run.sh is tracked without its executable bit, and a zip update drops it anyway.
    assert argv == ["bash", str(root / "server" / "run.sh")]
    assert kwargs["cwd"] == str(root / "server")
    assert kwargs["start_new_session"] is True and kwargs["close_fds"] is True
    assert kwargs["stdin"] == subprocess.DEVNULL and kwargs["stderr"] == subprocess.STDOUT
    assert Path(kwargs["stdout"].name) == home / "server.log" and "a" in kwargs["stdout"].mode
    assert kwargs["stdout"].closed, "the host does not keep the log open"
    assert answer == {"ok": True, "started": True, "log": str(home / "server.log")}


@posix_only
def test_launch_on_posix_logs_under_the_home_when_shisuko_home_is_unset(tmp_path, monkeypatch):
    root = fake_checkout(tmp_path)
    calls = []
    monkeypatch.setattr(nh.subprocess, "Popen", RecordedPopen(calls))
    answer = nh.launch(root, environ={"HOME": str(tmp_path)})
    assert answer["log"] == str(tmp_path / ".shisu-ko" / "server.log")


def test_launch_refuses_a_checkout_without_the_launcher(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(nh.subprocess, "Popen", RecordedPopen(calls))
    with pytest.raises(FileNotFoundError):
        nh.launch(tmp_path, environ={"SHISUKO_HOME": str(tmp_path / "data")})
    assert calls == []
    answer = nh.handle({"cmd": "start"}, running=lambda: False, launch=nh.launch, root=tmp_path, starting=lambda: False)
    assert answer["ok"] is False and "missing" in answer["error"]


def test_the_default_launcher_is_the_checkouts_own():
    assert nh.ROOT == ROOT
    assert nh.wrapper_path(platform="win32") == SERVER_DIR / "native-host.cmd"
    assert nh.wrapper_path(platform="linux") == SERVER_DIR / "native-host.sh"
    assert nh.wrapper_path(platform="darwin") == SERVER_DIR / "native-host.sh"
    assert (SERVER_DIR / "run.cmd").is_file() and (SERVER_DIR / "run.sh").is_file()


def test_the_host_reports_the_version_of_server_py(tmp_path):
    """One version per checkout: the host has no constant of its own to forget at a release."""
    text = (SERVER_DIR / "server.py").read_text(encoding="utf-8")
    assert nh.VERSION == re.search(r'^VERSION\s*=\s*"([^"]+)"', text, re.MULTILINE).group(1)
    assert nh.VERSION == nh.server_version() != "unknown"
    assert nh.server_version(tmp_path) == "unknown"


# --- server_running() --------------------------------------------------------------------------

class _Health(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        body = b'{"ok": true}'
        self.send_response(200 if self.path == "/health" else 404)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def test_server_running_asks_health_and_never_raises():
    httpd = http.server.HTTPServer(("127.0.0.1", 0), _Health)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        port = httpd.server_address[1]
        assert nh.server_running(f"http://127.0.0.1:{port}/health", timeout=2) is True
        assert nh.server_running(f"http://127.0.0.1:{port}/other", timeout=2) is False
    finally:
        httpd.shutdown()
        httpd.server_close()
    assert nh.server_running(f"http://127.0.0.1:{port}/health", timeout=0.5) is False


# --- registration ------------------------------------------------------------------------------

def test_manifest_names_the_host_the_wrapper_and_the_extension(tmp_path):
    wrapper = tmp_path / "native-host.sh"
    assert nh.manifest(wrapper) == {
        "name": "shisuko",
        "description": "Starts the Shisu-ko transcription server",
        "path": str(wrapper),
        "type": "stdio",
        "allowed_extensions": ["shisu-ko@multysquid.github.io"],
    }
    # The only extension the host answers is the add-on itself: a gecko id changed on one side
    # gets "No such native application" from Firefox, which no re-run of setup can fix.
    addon = json.loads((ROOT / "addon" / "manifest.json").read_text(encoding="utf-8"))
    assert nh.EXTENSION_ID == addon["browser_specific_settings"]["gecko"]["id"]


def test_manifest_path_per_platform(tmp_path):
    home = tmp_path / "home"
    env = {"HOME": str(home), "USERPROFILE": str(home)}
    assert nh.manifest_path(environ=env, platform="win32") == home / ".shisu-ko" / "native-messaging" / "shisuko.json"
    assert nh.manifest_path(environ=env, platform="linux") == home / ".mozilla" / "native-messaging-hosts" / "shisuko.json"
    assert nh.manifest_path(environ=env, platform="darwin") == (
        home / "Library" / "Application Support" / "Mozilla" / "NativeMessagingHosts" / "shisuko.json")
    data = tmp_path / "elsewhere"
    assert nh.manifest_path(environ=dict(env, SHISUKO_HOME=str(data)), platform="win32") == data / "native-messaging" / "shisuko.json"
    assert nh.manifest_path(environ=dict(env, SHISUKO_HOME=str(data)), platform="linux") == home / ".mozilla" / "native-messaging-hosts" / "shisuko.json"
    assert nh.manifest_path(home=home, environ={}, platform="linux") == home / ".mozilla" / "native-messaging-hosts" / "shisuko.json"


class FakeWinreg:
    """Just enough of winreg to record what register()/unregister() do to HKCU."""
    HKEY_CURRENT_USER = "HKCU"
    REG_SZ = 1

    class Key:
        def __init__(self, reg, sub):
            self.reg, self.sub = reg, sub

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def __init__(self):
        self.values, self.calls = {}, []

    def CreateKey(self, hive, sub):  # noqa: N802
        self.calls.append(("create", hive, sub))
        self.values.setdefault(sub, None)
        return self.Key(self, sub)

    def OpenKey(self, hive, sub):  # noqa: N802
        if sub not in self.values:
            raise FileNotFoundError(sub)
        return self.Key(self, sub)

    def SetValueEx(self, key, name, reserved, kind, value):  # noqa: N802
        self.calls.append(("set", key.sub, name, kind, value))
        self.values[key.sub] = (value, kind)

    def QueryValueEx(self, key, name):  # noqa: N802
        assert name == ""
        value = self.values[key.sub]
        if value is None:
            raise FileNotFoundError(name)
        return value

    def DeleteKey(self, hive, sub):  # noqa: N802
        if sub not in self.values:
            raise FileNotFoundError(sub)
        self.calls.append(("delete", hive, sub))
        del self.values[sub]


@pytest.fixture
def home(tmp_path, monkeypatch):
    """A temp home and a recorded registry in place of winreg, with the host's Windows switch on.

    The registry branch is what registers the host on the project's main platform, and CI runs
    on Linux: nothing in register()/unregister()/registered() touches the platform beyond that
    switch, so the branch runs everywhere. The manifest still lands where this platform's
    Firefox looks (manifest_path() keys on sys.platform).
    """
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(nh, "winreg", FakeWinreg())
    monkeypatch.setattr(nh, "WINDOWS", True)
    return home


def env_for(home: Path, **extra) -> dict:
    return {"HOME": str(home), "USERPROFILE": str(home), **extra}


def test_register_writes_the_manifest_where_firefox_looks(home, tmp_path):
    root = fake_checkout(tmp_path)
    env = env_for(home)
    assert nh.registered(environ=env) is None
    path = nh.register(root, environ=env)
    assert path == nh.manifest_path(environ=env)
    assert path.is_relative_to(home)
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data == nh.manifest(nh.wrapper_path(root))
    assert Path(data["path"]).name == ("native-host.cmd" if WINDOWS else "native-host.sh")
    assert nh.registered(environ=env) == path
    reg = nh.winreg
    assert reg.values[nh.REGISTRY_KEY] == (str(path), reg.REG_SZ)
    assert reg.calls == [("create", "HKCU", nh.REGISTRY_KEY), ("set", nh.REGISTRY_KEY, "", reg.REG_SZ, str(path))]
    assert nh.REGISTRY_KEY == r"Software\Mozilla\NativeMessagingHosts\shisuko"
    if not WINDOWS:
        assert path.parent.name == ("NativeMessagingHosts" if sys.platform == "darwin" else "native-messaging-hosts")
    assert nh.register(root, environ=env) == path, "registering twice is fine"


def test_register_honours_shisuko_home_on_windows_only(home, tmp_path):
    root = fake_checkout(tmp_path)
    data = tmp_path / "data"
    env = env_for(home, SHISUKO_HOME=str(data))
    path = nh.register(root, environ=env)
    if WINDOWS:
        assert path == data / "native-messaging" / "shisuko.json"
    else:
        assert path.is_relative_to(home), "Firefox reads its own folders, SHISUKO_HOME cannot move them"
    assert nh.registered(environ=env) == path


def test_unregister_takes_everything_away_again(home, tmp_path):
    root = fake_checkout(tmp_path)
    env = env_for(home)
    assert nh.unregister(environ=env) is False
    path = nh.register(root, environ=env)
    assert nh.unregister(environ=env) is True
    assert not path.exists()
    assert nh.registered(environ=env) is None
    assert nh.REGISTRY_KEY not in nh.winreg.values
    assert nh.winreg.calls[-1] == ("delete", "HKCU", nh.REGISTRY_KEY)
    assert nh.unregister(environ=env) is False


def test_windows_registration_needs_both_the_registry_value_and_the_file(home, tmp_path):
    root = fake_checkout(tmp_path)
    env = env_for(home)
    path = nh.register(root, environ=env)
    path.unlink()
    assert nh.registered(environ=env) is None, "a dangling registry value is not a registration"
    nh.register(root, environ=env)
    nh.winreg.values.clear()
    assert nh.registered(environ=env) is None, "a manifest nobody points at is not one either"


@posix_only
def test_register_gives_the_wrapper_its_executable_bit_back(tmp_path):
    """Firefox executes native-host.sh itself; a zip update writes it without the bit."""
    root = fake_checkout(tmp_path)
    wrapper = root / "server" / "native-host.sh"
    wrapper.write_bytes(b"#!/usr/bin/env bash\n")
    wrapper.chmod(0o644)
    env = env_for(tmp_path / "home")
    path = nh.register(root, environ=env)
    assert wrapper.stat().st_mode & 0o111 == 0o111
    assert json.loads(path.read_text(encoding="utf-8"))["path"] == str(wrapper)
    (root / "server" / "native-host.sh").unlink()
    assert nh.register(root, environ=env) == path, "a missing wrapper is --status's business, not a crash here"


def test_status_text_says_where_and_whether(home, tmp_path):
    root = fake_checkout(tmp_path)
    env = env_for(home)
    assert nh.status_text(root, environ=env) == "not registered (run setup or start the server once)"
    path = nh.register(root, environ=env)
    assert nh.status_text(root, environ=env) == f"registered at {path}"
    other = fake_checkout(tmp_path / "other")
    text = nh.status_text(other, environ=env)
    assert text.startswith(f"registered at {path} (points at {nh.wrapper_path(root)}")
    assert "--register" in text


# --- entry point -------------------------------------------------------------------------------

def test_main_status_prints_one_line(monkeypatch, capsys):
    monkeypatch.setattr(nh, "status_text", lambda: "registered at /x/shisuko.json")
    assert nh.main(["--status"]) == 0
    assert capsys.readouterr().out == "Start button launcher: registered at /x/shisuko.json\n"


def test_main_register_is_quiet_unless_verbose(monkeypatch, capsys):
    calls = []
    monkeypatch.setattr(nh, "register", lambda: calls.append("register") or Path("x") / "shisuko.json")
    monkeypatch.setattr(nh, "unregister", lambda: calls.append("unregister") or True)
    assert nh.main(["--register"]) == 0
    assert capsys.readouterr() == ("", "")
    assert nh.main(["--register", "--verbose"]) == 0
    assert str(Path("x") / "shisuko.json") in capsys.readouterr().out
    assert nh.main(["--verbose", "--unregister"]) == 0
    assert "removed" in capsys.readouterr().out
    assert calls == ["register", "register", "unregister"]


def test_main_reports_a_failed_registration_on_stderr(monkeypatch, capsys):
    def boom():
        raise PermissionError("registry is read-only")

    monkeypatch.setattr(nh, "register", boom)
    assert nh.main(["--register"]) == 1
    out, err = capsys.readouterr()
    assert out == "" and "registry is read-only" in err


def test_main_refuses_two_actions_and_a_terminal_without_one(monkeypatch, capsys):
    monkeypatch.setattr(nh, "serve", lambda stdin, stdout: pytest.fail("must not serve"))
    assert nh.main(["--register", "--status"]) == 2
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True)  # a person at a keyboard, never a browser
    assert nh.main([]) == 2
    assert nh.main(["--start"]) == 2, "a mistyped flag gets the usage, not a host waiting for input"
    assert capsys.readouterr().err.count("usage") == 3


def test_main_without_flags_serves_the_protocol(monkeypatch):
    seen = []
    monkeypatch.setattr(nh, "serve", lambda stdin, stdout: seen.append((stdin, stdout)) or 0)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: False)  # also under pytest -s
    assert nh.main([]) == 0, "pytest's captured stdin has no descriptor; the binary-mode step must shrug"
    assert seen == [(sys.stdin.buffer, sys.stdout.buffer)]


FIREFOX_ARGS = [r"C:\Users\x\.shisu-ko\native-messaging\shisuko.json", nh.EXTENSION_ID]
CHROME_ARGS = [f"chrome-extension://{'a' * 32}/", "--parent-window=123456"]


@pytest.mark.parametrize("argv", [FIREFOX_ARGS, CHROME_ARGS, [*FIREFOX_ARGS, "--verbose"]])
def test_main_serves_with_the_arguments_a_browser_passes(monkeypatch, argv):
    """Firefox hands every host its manifest path and the extension id; they are not flags."""
    seen = []
    monkeypatch.setattr(nh, "serve", lambda stdin, stdout: seen.append(1) or 0)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: False)
    assert nh.main(argv) == 0
    assert seen == [1]


def test_the_host_answers_over_a_real_pipe():
    """The whole thing as Firefox drives it: a process with the manifest path and the extension id
    as arguments, framed stdin, framed stdout, EOF."""
    requests = frame({"cmd": "status"}) + frame({"cmd": "nope"}) + frame(["start"]) + frame(None)
    argv = [sys.executable, str(_HOST_PATH), str(nh.manifest_path()), nh.EXTENSION_ID]
    done = subprocess.run(argv, input=requests, capture_output=True, timeout=30)
    assert done.returncode == 0, done.stderr
    answers = unframe(done.stdout)
    assert answers[0]["ok"] is True and answers[0]["version"] == nh.VERSION and answers[0]["root"] == str(ROOT)
    assert isinstance(answers[0]["running"], bool)
    assert answers[1:] == [{"ok": False, "error": "unknown command"}] * 3


def test_the_wrapper_forwards_the_browsers_arguments_to_the_host():
    """The checkout's own wrapper, started the way Firefox starts it, answers a framed request."""
    wrapper = nh.wrapper_path()
    args = [str(nh.manifest_path()), nh.EXTENSION_ID]
    if WINDOWS:
        # Firefox runs a .cmd host as cmd.exe /s/c "<host> <args>", quoting what holds whitespace.
        quoted = " ".join(f'"{a}"' if re.search(r'[\s"]', a) else a for a in (str(wrapper), *args))
        command = f'cmd.exe /s /c "{quoted}"'
    else:
        command = [str(wrapper), *args]  # executed directly: the checkout's bit must be set
    done = subprocess.run(command, input=frame({"cmd": "status"}), capture_output=True, timeout=60)
    assert done.returncode == 0, done.stderr
    (answer,) = unframe(done.stdout)
    assert answer["ok"] is True and answer["version"] == nh.VERSION and answer["root"] == str(ROOT)


# --- the wrappers and the launchers ------------------------------------------------------------

def test_wrappers_run_the_host_and_nothing_else():
    cmd = (SERVER_DIR / "native-host.cmd").read_bytes()
    assert cmd.startswith(b"@echo off\r\n") and b"\n" not in cmd.replace(b"\r\n", b"")
    # The venv first (Firefox's PATH may hold no usable python, e.g. the Store alias stub), the
    # system python before setup ran; the venv paths are the ones setup.cmd / setup.sh create.
    assert b'set "PY=%USERPROFILE%\\.shisu-ko\\venv\\Scripts\\python.exe"\r\n' in cmd
    assert b'if not exist "%PY%" set "PY=python"\r\n' in cmd
    assert b'"%PY%" "%~dp0native_host.py" %*' in cmd
    assert b"echo " not in cmd.lower().replace(b"@echo off", b""), "a .cmd host may not print"
    sh = (SERVER_DIR / "native-host.sh").read_bytes()
    assert sh.startswith(b"#!/usr/bin/env bash\n") and b"\r" not in sh
    assert b'PY="${HOME}/.shisu-ko/venv/bin/python"\n' in sh
    assert b'[ -x "$PY" ] || PY=python3\n' in sh
    assert b'exec "$PY" "$(dirname "$0")/native_host.py" "$@"' in sh
    assert b"echo" not in sh, "a shell host may not print"


def test_launchers_register_the_host():
    run_cmd = (SERVER_DIR / "run.cmd").read_bytes().decode("utf-8")
    assert '"%~dp0native_host.py" --register' in run_cmd
    lines = run_cmd.replace("\r\n", "\n").split("\n")
    register = next(i for i, line in enumerate(lines) if "native_host.py" in line)
    update = next(i for i, line in enumerate(lines) if "update.py" in line and "goto loop" in line)
    assert register < update, "the register call precedes the update line that may replace run.cmd"
    assert '"%~dp0native_host.py" --register' in (SERVER_DIR / "setup.cmd").read_text(encoding="utf-8")
    for name in ("run.sh", "setup.sh"):
        assert '"${HERE}/native_host.py" --register' in (SERVER_DIR / name).read_text(encoding="utf-8")

#!/usr/bin/env python3
"""
Local transcription server for Shisu-ko, the Firefox extension that overlays live Whisper
subtitles on YouTube for Japanese learners.

The extension posts {video_id, url, t, since} to /sync about once a second while a
YouTube video plays. For each new video the server downloads the audio track with
yt-dlp, decodes it to 16 kHz mono, and a single worker thread transcribes it with
faster-whisper, starting at the current playhead and continuing ahead of it in
windows. Cues are returned incrementally, cached on disk, and the extension renders
them as ordinary DOM text so dictionary tools such as Yomitan can scan them.

Endpoints
  GET  /health -> {ok, version, model, device, compute_type, language}
  POST /sync   -> {ok, status, error, duration, title, covered, cues, next, busy}
  GET  /clip?video_id=..&start=..&end=..&format=mp3|wav -> audio clip of a sentence (mining)

Everything lives under ~/.shisu-ko (override with the SHISUKO_HOME environment variable):
the Python environment, downloaded models, cached audio and cue files.
"""
from __future__ import annotations

import argparse
import glob
import io
import json
import logging
import os
import re
import shutil
import site
import subprocess
import sys
import threading
import time
import wave
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, urlsplit

VERSION = "0.2.0"
SAMPLE_RATE = 16000
APP_DIR = Path(os.environ.get("SHISUKO_HOME") or (Path.home() / ".shisu-ko"))
CACHE_DIR = APP_DIR / "cache"
MODELS_DIR = APP_DIR / "models"
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,20}$")
AUDIO_SUFFIXES = {".webm", ".m4a", ".opus", ".mp4", ".mp3", ".ogg", ".oga", ".wav", ".mka", ".aac"}

log = logging.getLogger("shisu-ko")


def add_nvidia_dll_dirs() -> list:
    """Make pip-installed CUDA libraries (nvidia-cublas-cu12, nvidia-cudnn-cu12) visible on Windows."""
    found = []
    if os.name != "nt":
        return found
    roots = set(site.getsitepackages())
    try:
        roots.add(site.getusersitepackages())
    except Exception:
        pass
    for root in roots:
        for directory in glob.glob(os.path.join(root, "nvidia", "*", "bin")):
            try:
                os.add_dll_directory(directory)
            except (OSError, AttributeError):
                continue
            os.environ["PATH"] = directory + os.pathsep + os.environ.get("PATH", "")
            found.append(directory)
    return found


# The Hugging Face "xet" transfer backend has stalled on some Windows machines; plain HTTPS
# downloads are slower to start but reliable. Set HF_HUB_DISABLE_XET=0 to opt back in.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

NVIDIA_DIRS = add_nvidia_dll_dirs()

import numpy as np  # noqa: E402  (after the DLL setup on purpose)


# --------------------------------------------------------------------------- helpers

def fmt_time(seconds: float) -> str:
    seconds = max(0, int(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def merge_intervals(intervals, gap: float = 0.05) -> list:
    merged: list = []
    for a, b in sorted((float(a), float(b)) for a, b in intervals if float(b) > float(a)):
        if merged and a <= merged[-1][1] + gap:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return merged


def find_covering(intervals, t: float, tol: float = 0.25):
    for a, b in intervals:
        if a - tol <= t <= b + tol:
            return (a, b)
    return None


def next_start_after(intervals, t: float):
    best = None
    for a, _ in intervals:
        if a > t and (best is None or a < best):
            best = a
    return best


SENTENCE_END = set("。！？!?…")
CLAUSE_BREAK = set("、,，")
JUNK_RE = re.compile(r"^[\s\W_]*$")


def split_segment(seg, offset: float, max_chars: int, max_seconds: float) -> list:
    """Turn one Whisper segment into subtitle-sized (start, end, text) cues using word timestamps."""
    text = (seg.text or "").strip()
    if not text:
        return []
    words = list(getattr(seg, "words", None) or [])
    if not words:
        return [(offset + float(seg.start), offset + float(seg.end), text)]

    cues: list = []
    buf: list = []

    def flush():
        if not buf:
            return
        joined = "".join(w.word for w in buf).strip()
        if joined:
            cues.append((offset + float(buf[0].start), offset + float(buf[-1].end), joined))
        buf.clear()

    for w in words:
        buf.append(w)
        joined = "".join(x.word for x in buf).strip()
        n = len(joined)
        duration = float(buf[-1].end) - float(buf[0].start)
        last = joined[-1:]
        if (last in SENTENCE_END and n >= 8) or n >= max_chars or duration >= max_seconds:
            flush()
        elif last in CLAUSE_BREAK and n >= max_chars * 0.6:
            flush()
    flush()

    # Fold a tiny trailing fragment into the previous cue.
    if len(cues) >= 2 and len(cues[-1][2]) < 4:
        a, _, t1 = cues[-2]
        _, b, t2 = cues[-1]
        cues[-2:] = [(a, b, t1 + t2)]
    return cues


# --------------------------------------------------------------------------- sessions

@dataclass
class Session:
    video_id: str
    url: str
    status: str = "pending"  # pending | downloading | decoding | ready | error | evicted
    error: Optional[str] = None
    title: str = ""
    duration: float = 0.0
    audio: Optional[np.ndarray] = None
    cues: list = field(default_factory=list)
    covered: list = field(default_factory=list)
    want_t: float = 0.0
    last_sync: float = field(default_factory=time.time)
    busy: Optional[list] = None
    fetching: bool = False
    lock: threading.RLock = field(default_factory=threading.RLock)

    def cache_path(self) -> Path:
        return CACHE_DIR / f"{self.video_id}.cues.json"

    def fully_covered(self) -> bool:
        return (
            self.duration > 0
            and len(self.covered) == 1
            and self.covered[0][0] <= 0.3
            and self.covered[0][1] >= self.duration - 0.3
        )


def plan_window(s: Session, args) -> Optional[tuple]:
    """Pick the next [start, end) window to transcribe for a session, or None if idle."""
    if s.status != "ready" or s.audio is None or s.duration <= 0:
        return None
    t = min(max(0.0, s.want_t), s.duration)
    cov = find_covering(s.covered, t)
    if cov is None:
        start = max(0.0, t - 0.5)
        size = args.first_window
    else:
        start = cov[1]
        if start >= s.duration - 0.05:
            return None
        if args.lookahead > 0 and start - t > args.lookahead:
            return None
        size = args.window
    end = min(start + size, s.duration)
    nxt = next_start_after(s.covered, start + 0.01)
    if nxt is not None:
        end = min(end, nxt)
    if end - start < 1.5:
        s.covered = merge_intervals(s.covered + [[start, end]])
        return None
    return (start, end)


# --------------------------------------------------------------------------- audio fetching

class YtdlpLogger:
    def debug(self, msg):
        log.debug("yt-dlp: %s", msg)

    def info(self, msg):
        log.debug("yt-dlp: %s", msg)

    def warning(self, msg):
        log.warning("yt-dlp: %s", msg)

    def error(self, msg):
        log.error("yt-dlp: %s", msg)


def friendly_error(exc: Exception) -> str:
    msg = str(exc) or exc.__class__.__name__
    low = msg.lower()
    if "sign in to confirm" in low or "not a bot" in low:
        return "YouTube asks for a sign-in. Restart the server with --cookies-from-browser firefox (or --cookies /data/cookies.txt in Docker)"
    if "private video" in low:
        return "This video is private"
    if "members-only" in low or "join this channel" in low:
        return "Members-only video. Restart the server with --cookies-from-browser firefox"
    if "javascript runtime" in low:
        return "yt-dlp needs Node.js or Deno installed to download from YouTube"
    if "video unavailable" in low:
        return "Video unavailable"
    if "live stream" in low:
        return msg
    last = msg.strip().splitlines()[-1] if msg.strip() else msg
    return last[:200]


def find_cached_audio(video_id: str) -> Optional[Path]:
    for p in CACHE_DIR.glob(f"{video_id}.*"):
        if p.suffix.lower() in AUDIO_SUFFIXES and p.is_file() and p.stat().st_size > 0:
            return p
    return None


class Fetcher:
    def __init__(self, args):
        self.args = args

    def js_runtimes(self) -> dict:
        spec = (self.args.js_runtime or "auto").strip()
        if spec and spec != "auto":
            name, _, path = spec.partition(":")
            return {name.strip().lower(): ({"path": path.strip()} if path.strip() else {})}
        runtimes = {}
        for name in ("deno", "node", "bun"):
            if shutil.which(name):
                runtimes[name] = {}
        return runtimes or {"deno": {}}

    def ytdlp_options(self, video_id: str) -> dict:
        opts = {
            "format": "bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best",
            "outtmpl": str(CACHE_DIR / f"{video_id}.%(ext)s"),
            "quiet": True,
            "noprogress": True,
            "noplaylist": True,
            "retries": 3,
            "fragment_retries": 3,
            "socket_timeout": 30,
            "logger": YtdlpLogger(),
            "js_runtimes": self.js_runtimes(),
        }
        if self.args.cookies_from_browser:
            opts["cookiesfrombrowser"] = (self.args.cookies_from_browser,)
        if self.args.cookies:
            opts["cookiefile"] = self.args.cookies
        if self.args.allow_remote_ejs:
            opts["remote_components"] = ["ejs:github"]
        return opts

    def fetch(self, s: Session) -> None:
        try:
            with s.lock:
                s.status = "downloading"
                s.error = None
            path = find_cached_audio(s.video_id)
            if path is None:
                log.info("[%s] downloading audio", s.video_id)
                path = self.download(s)
            else:
                log.info("[%s] using cached audio %s", s.video_id, path.name)
            with s.lock:
                s.status = "decoding"
            from faster_whisper.audio import decode_audio

            audio = decode_audio(str(path), sampling_rate=SAMPLE_RATE)
            audio = np.ascontiguousarray(audio, dtype=np.float32)
            with s.lock:
                s.audio = audio
                s.duration = float(len(audio)) / SAMPLE_RATE
                s.status = "ready"
            log.info("[%s] audio ready, %s long%s", s.video_id, fmt_time(s.duration), f": {s.title}" if s.title else "")
        except Exception as exc:  # noqa: BLE001
            log.error("[%s] fetching audio failed: %s", s.video_id, exc)
            with s.lock:
                s.status = "error"
                s.error = friendly_error(exc)
        finally:
            with s.lock:
                s.fetching = False

    def download(self, s: Session) -> Path:
        import yt_dlp

        url = f"https://www.youtube.com/watch?v={s.video_id}"
        with yt_dlp.YoutubeDL(self.ytdlp_options(s.video_id)) as ydl:
            info = ydl.extract_info(url, download=False)
            if info.get("is_live"):
                raise RuntimeError("Live streams are not supported yet")
            with s.lock:
                s.title = info.get("title") or ""
            try:
                ydl.process_ie_result(info, download=True)
            except Exception as exc:  # noqa: BLE001
                log.debug("[%s] process_ie_result failed (%s); retrying with a plain download", s.video_id, exc)
                if find_cached_audio(s.video_id) is None:
                    ydl.download([url])
        path = find_cached_audio(s.video_id)
        if path is None:
            raise RuntimeError("yt-dlp finished but no audio file was produced")
        return path


# --------------------------------------------------------------------------- audio clips (sentence mining)

CLIP_RATE = 48000
MAX_CLIP_SECONDS = 60.0


class ClipNotReady(Exception):
    """Raised when the audio for a video has not been fetched yet."""


def _wav_bytes(samples: np.ndarray, rate: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(np.ascontiguousarray(samples, dtype=np.int16).tobytes())
    return buf.getvalue()


def _mp3_bytes(samples: np.ndarray, rate: int, bit_rate: int = 96000) -> bytes:
    import av

    buf = io.BytesIO()
    with av.open(buf, mode="w", format="mp3") as out:
        stream = out.add_stream("libmp3lame", rate=rate, layout="mono", format="s16p")
        stream.bit_rate = bit_rate
        frame = av.AudioFrame.from_ndarray(np.ascontiguousarray(samples, dtype=np.int16).reshape(1, -1), format="s16", layout="mono")
        frame.sample_rate = rate
        frame.pts = 0
        resampler = av.AudioResampler(format="s16p", layout="mono", rate=rate)
        for f in list(resampler.resample(frame)) + list(resampler.resample(None)):
            for packet in stream.encode(f):
                out.mux(packet)
        for packet in stream.encode(None):
            out.mux(packet)
    return buf.getvalue()


def _decode_range(src: Path, start: float, end: float, rate: int = CLIP_RATE) -> np.ndarray:
    """Decode [start, end) seconds of an audio file as int16 mono at `rate` (PyAV, no ffmpeg binary needed)."""
    import av

    chunks = []
    with av.open(str(src)) as container:
        stream = container.streams.audio[0]
        resampler = av.AudioResampler(format="s16", layout="mono", rate=rate)
        try:
            container.seek(int(max(0.0, start - 2.0) / float(stream.time_base)), stream=stream, backward=True, any_frame=False)
        except Exception:  # noqa: BLE001
            pass
        state = {"t0": None, "pos": 0}

        def take(rf):
            arr = rf.to_ndarray()
            n = arr.shape[-1]
            t_chunk = state["t0"] + state["pos"] / rate
            i0 = int(max(0, round((start - t_chunk) * rate)))
            i1 = int(min(n, round((end - t_chunk) * rate)))
            if i1 > i0:
                chunks.append(arr[0, i0:i1])
            state["pos"] += n

        for frame in container.decode(stream):
            if frame.pts is None:
                continue
            if state["t0"] is None:
                state["t0"] = float(frame.pts * stream.time_base)
            for rf in resampler.resample(frame):
                take(rf)
            if state["t0"] + state["pos"] / rate >= end + 0.1:
                break
        if state["t0"] is not None:
            for rf in resampler.resample(None):
                take(rf)
    if not chunks:
        return np.zeros(0, dtype=np.int16)
    return np.concatenate(chunks)


def make_clip(video_id: str, start: float, end: float, fmt: str, fallback_audio: Optional[np.ndarray]):
    """Return (bytes, mime, extension) for the [start, end) audio clip of a video."""
    samples = None
    rate = CLIP_RATE
    src = find_cached_audio(video_id)
    if src is not None:
        try:
            samples = _decode_range(src, start, end, rate)
            if len(samples) < rate * 0.2:
                samples = None
        except Exception as exc:  # noqa: BLE001
            log.warning("[%s] clip decode from the source file failed (%s); using the 16 kHz copy", video_id, exc)
    if samples is None and fallback_audio is not None:
        a, b = int(start * SAMPLE_RATE), int(end * SAMPLE_RATE)
        samples = np.clip(fallback_audio[a:b] * 32767.0, -32768, 32767).astype(np.int16)
        rate = SAMPLE_RATE
    if samples is None or len(samples) == 0:
        raise RuntimeError("no audio available for this range")
    if fmt == "mp3":
        try:
            return _mp3_bytes(samples, rate), "audio/mpeg", "mp3"
        except Exception as exc:  # noqa: BLE001
            log.warning("mp3 encoding unavailable (%s); returning wav", exc)
    return _wav_bytes(samples, rate), "audio/wav", "wav"


# --------------------------------------------------------------------------- transcription

class Transcriber(threading.Thread):
    def __init__(self, app: "App"):
        super().__init__(daemon=True, name="transcriber")
        self.app = app

    def run(self) -> None:
        while True:
            try:
                picked = self.app.pick_work()
                if picked is None:
                    time.sleep(0.15)
                    continue
                self.process(*picked)
            except Exception:  # noqa: BLE001
                log.exception("transcriber loop error")
                time.sleep(1.0)

    def process(self, s: Session, start: float, end: float) -> None:
        args = self.app.args
        with s.lock:
            if s.audio is None:
                return
            audio = s.audio[int(start * SAMPLE_RATE): int(end * SAMPLE_RATE)]
            s.busy = [round(start, 2), round(end, 2)]
            boundary_free = end < s.duration - 0.05 and find_covering(s.covered, end + 0.01, tol=0.0) is None

        t0 = time.time()
        try:
            segments, _info = self.app.model.transcribe(
                audio,
                language=args.language,
                task="transcribe",
                beam_size=args.beam_size,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 400, "speech_pad_ms": 200},
                word_timestamps=True,
                condition_on_previous_text=False,
                initial_prompt=args.initial_prompt or None,
                temperature=[0.0, 0.2, 0.4, 0.6],
                no_speech_threshold=0.6,
                log_prob_threshold=-1.0,
                compression_ratio_threshold=2.4,
            )
            segs = list(segments)
        except Exception as exc:  # noqa: BLE001
            log.error("[%s] transcription of %s-%s failed: %s", s.video_id, fmt_time(start), fmt_time(end), exc)
            if "cuda" in str(exc).lower() or "cudnn" in str(exc).lower() or "cublas" in str(exc).lower():
                log.error("The GPU context looks broken (driver reset or out of memory). Exiting so the launcher can restart the server.")
                os._exit(3)
            with s.lock:
                s.busy = None
                s.covered = merge_intervals(s.covered + [[start, end]])
            return

        # A segment touching the end of the window is probably cut mid-sentence; drop it and let
        # the next window start where it began.
        new_end = end
        if boundary_free and len(segs) > 1 and float(segs[-1].end) > (end - start) - 1.0:
            dropped = segs.pop()
            new_end = min(end, max(start + 1.0, start + float(dropped.start)))

        fresh = []
        for seg in segs:
            for a, b, text in split_segment(seg, start, args.max_cue_chars, args.max_cue_seconds):
                if JUNK_RE.match(text):
                    continue
                fresh.append({"start": round(a, 2), "end": round(max(b, a + 0.4), 2), "text": text})

        added = 0
        with s.lock:
            recent = s.cues[-80:]
            for cue in fresh:
                if any(abs(r["start"] - cue["start"]) < 0.3 and r["text"] == cue["text"] for r in recent):
                    continue
                cue["id"] = len(s.cues)
                s.cues.append(cue)
                recent.append(cue)
                added += 1
            s.covered = merge_intervals(s.covered + [[start, new_end]])
            s.busy = None
        elapsed = time.time() - t0
        log.info(
            "[%s] %s-%s: %d cues in %.1fs (%.0fx realtime)",
            s.video_id, fmt_time(start), fmt_time(new_end), added, elapsed, (new_end - start) / max(elapsed, 1e-3),
        )
        self.app.save_cache(s)


# --------------------------------------------------------------------------- application

class App:
    def __init__(self, args, model, device: str, compute_type: str):
        self.args = args
        self.model = model
        self.device = device
        self.compute_type = compute_type
        self.sessions: dict = {}
        self.lock = threading.Lock()
        self.fetcher = Fetcher(args)
        self.last_evict = time.time()
        self.transcriber = Transcriber(self)
        self.transcriber.start()

    def health(self) -> dict:
        return {
            "ok": True,
            "version": VERSION,
            "model": self.args.model,
            "device": self.device,
            "compute_type": self.compute_type,
            "language": self.args.language,
        }

    def sessions_summary(self) -> dict:
        with self.lock:
            sessions = list(self.sessions.values())
        out = []
        for s in sessions:
            with s.lock:
                out.append({
                    "video_id": s.video_id, "status": s.status, "title": s.title, "duration": s.duration,
                    "cues": len(s.cues), "covered": s.covered, "want_t": s.want_t, "busy": s.busy,
                    "idle_seconds": round(time.time() - s.last_sync, 1),
                })
        return {"ok": True, "sessions": out}

    def get_session(self, video_id: str, url: str) -> Session:
        with self.lock:
            s = self.sessions.get(video_id)
            if s is None:
                s = Session(video_id=video_id, url=url)
                self.load_cache(s)
                self.sessions[video_id] = s
        with s.lock:
            need_fetch = s.status in ("pending", "evicted") and not s.fetching
            if need_fetch:
                s.fetching = True
        if need_fetch:
            threading.Thread(target=self.fetcher.fetch, args=(s,), daemon=True, name=f"fetch-{video_id}").start()
        return s

    def sync(self, video_id: str, url: str, t: float, since: int) -> dict:
        s = self.get_session(video_id, url)
        with s.lock:
            s.want_t = max(0.0, float(t))
            s.last_sync = time.time()
            since = max(0, min(int(since), len(s.cues)))
            resp = {
                "ok": True,
                "status": s.status,
                "error": s.error,
                "duration": s.duration,
                "title": s.title,
                "covered": [[round(a, 2), round(b, 2)] for a, b in s.covered],
                "cues": s.cues[since:],
                "next": len(s.cues),
                "busy": s.busy,
            }
        self.maybe_evict()
        return resp

    def clip(self, video_id: str, start: float, end: float, fmt: str):
        """Audio clip for sentence mining. Raises ClipNotReady while the audio is still being fetched."""
        if end <= start:
            raise ValueError("end must be after start")
        if end - start > MAX_CLIP_SECONDS:
            raise ValueError(f"clip longer than {MAX_CLIP_SECONDS:.0f} seconds")
        with self.lock:
            s = self.sessions.get(video_id)
        fallback = None
        if s is not None:
            with s.lock:
                fallback = s.audio
                if s.duration:
                    end = min(end, s.duration)
        if find_cached_audio(video_id) is None and fallback is None:
            self.get_session(video_id, f"https://www.youtube.com/watch?v={video_id}")
            raise ClipNotReady()
        return make_clip(video_id, max(0.0, start), end, fmt, fallback)

    def pick_work(self):
        with self.lock:
            sessions = sorted(self.sessions.values(), key=lambda x: x.last_sync, reverse=True)
        for s in sessions:
            with s.lock:
                window = plan_window(s, self.args)
                if window:
                    return (s, window[0], window[1])
        return None

    def maybe_evict(self) -> None:
        now = time.time()
        if now - self.last_evict < 60:
            return
        self.last_evict = now
        with self.lock:
            sessions = list(self.sessions.values())
        for s in sessions:
            with s.lock:
                if s.status == "ready" and s.audio is not None and now - s.last_sync > self.args.idle_minutes * 60:
                    s.audio = None
                    s.status = "evicted"
                    log.info("[%s] released audio after %d idle minutes", s.video_id, self.args.idle_minutes)

    def load_cache(self, s: Session) -> None:
        path = s.cache_path()
        if not path.is_file():
            return
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            log.warning("[%s] ignoring unreadable cue cache: %s", s.video_id, exc)
            return
        s.title = data.get("title") or ""
        if data.get("model") != self.args.model or data.get("language") != self.args.language:
            return  # cues from another model are not reused, the title is
        s.cues = [c for c in data.get("cues", []) if isinstance(c, dict)]
        for i, c in enumerate(s.cues):
            c["id"] = i
        s.covered = merge_intervals(data.get("covered", []))
        s.duration = float(data.get("duration") or 0.0)
        if s.fully_covered():
            s.status = "ready"  # nothing left to transcribe, no need to fetch the audio again
        log.info("[%s] loaded %d cached cues", s.video_id, len(s.cues))

    def save_cache(self, s: Session) -> None:
        with s.lock:
            data = {
                "video_id": s.video_id, "title": s.title, "duration": s.duration,
                "model": self.args.model, "language": self.args.language,
                "cues": list(s.cues), "covered": [list(iv) for iv in s.covered],
            }
        tmp = s.cache_path().with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, s.cache_path())
        except Exception as exc:  # noqa: BLE001
            log.warning("[%s] could not write cue cache: %s", s.video_id, exc)


# --------------------------------------------------------------------------- HTTP

EXTENSION_ORIGIN_PREFIXES = ("moz-extension://", "chrome-extension://", "safari-web-extension://")
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def origin_allowed(origin: Optional[str]) -> bool:
    """Browser origins that may use the server: the extension itself and pages served on this machine.

    Requests without an Origin header (curl, the Docker health check, other local tools) are not
    browser cross-origin requests and are handled separately by the caller.
    """
    if not origin or origin == "null":
        return False
    if origin.startswith(EXTENSION_ORIGIN_PREFIXES):
        return True
    parts = urlsplit(origin)
    return parts.scheme in ("http", "https") and (parts.hostname or "") in LOOPBACK_HOSTS


class Handler(BaseHTTPRequestHandler):
    app: App = None  # type: ignore[assignment]
    protocol_version = "HTTP/1.1"
    server_version = f"ShisuKo/{VERSION}"

    def log_message(self, fmt, *args):  # quieter than the default
        log.debug("http: " + fmt, *args)

    def _origin_ok(self) -> bool:
        """True for non-browser clients (no Origin header) and for allowed browser origins."""
        origin = self.headers.get("Origin")
        return origin is None or origin_allowed(origin)

    def _cors(self) -> None:
        origin = self.headers.get("Origin")
        if not origin or not origin_allowed(origin):
            return  # no CORS headers: the browser refuses to hand the response to the page
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")

    def _reject_origin(self) -> None:
        log.warning("rejected request from origin %s", self.headers.get("Origin"))
        self._json(403, {"ok": False, "error": "origin not allowed"})

    def _json(self, code: int, payload) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802
        if not self._origin_ok():
            self._reject_origin()
            return
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if not self._origin_ok():
            self._reject_origin()
            return
        path = self.path.split("?", 1)[0]
        if path == "/health":
            self._json(200, self.app.health())
        elif path == "/sessions":
            self._json(200, self.app.sessions_summary())
        elif path == "/clip":
            self._clip(urlsplit(self.path).query)
        else:
            self._json(404, {"ok": False, "error": "not found"})

    def _clip(self, query: str) -> None:
        qs = parse_qs(query)
        video_id = qs.get("video_id", [""])[0]
        if not VIDEO_ID_RE.match(video_id):
            self._json(400, {"ok": False, "error": "invalid video_id"})
            return
        try:
            start = float(qs.get("start", ["0"])[0])
            end = float(qs.get("end", ["0"])[0])
        except ValueError:
            self._json(400, {"ok": False, "error": "invalid start/end"})
            return
        fmt = "wav" if qs.get("format", ["mp3"])[0].lower() == "wav" else "mp3"
        try:
            data, mime, ext = self.app.clip(video_id, start, end, fmt)
        except ClipNotReady:
            self._json(503, {"ok": False, "error": "audio not ready yet, retry in a moment"})
            return
        except ValueError as exc:
            self._json(400, {"ok": False, "error": str(exc)})
            return
        except Exception as exc:  # noqa: BLE001
            log.exception("clip failed")
            self._json(500, {"ok": False, "error": str(exc)})
            return
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition", f'inline; filename="{video_id}_{int(start * 1000)}.{ext}"')
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:  # noqa: N802
        if not self._origin_ok():
            self._reject_origin()
            return
        path = self.path.split("?", 1)[0]
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length > 65536:
                self._json(413, {"ok": False, "error": "request too large"})
                return
            raw = self.rfile.read(length) if length else b""
            body = json.loads(raw.decode("utf-8") or "{}")
            if not isinstance(body, dict):
                raise ValueError("body must be an object")
        except Exception:  # noqa: BLE001
            self._json(400, {"ok": False, "error": "invalid JSON body"})
            return
        if path != "/sync":
            self._json(404, {"ok": False, "error": "not found"})
            return
        video_id = str(body.get("video_id") or "")
        if not VIDEO_ID_RE.match(video_id):
            self._json(400, {"ok": False, "error": "invalid video_id"})
            return
        try:
            t = float(body.get("t") or 0.0)
            since = int(body.get("since") or 0)
        except (TypeError, ValueError):
            self._json(400, {"ok": False, "error": "invalid t/since"})
            return
        try:
            self._json(200, self.app.sync(video_id, str(body.get("url") or ""), t, since))
        except Exception as exc:  # noqa: BLE001
            log.exception("sync failed")
            self._json(500, {"ok": False, "error": str(exc)})


# --------------------------------------------------------------------------- startup

def cuda_available() -> bool:
    try:
        import ctranslate2

        return ctranslate2.get_cuda_device_count() > 0
    except Exception:  # noqa: BLE001
        return False


def gpu_memory_mb():
    """(free, total) GPU memory in MiB via nvidia-smi, or None if unavailable."""
    exe = shutil.which("nvidia-smi")
    if exe is None and os.name == "nt":
        candidate = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "nvidia-smi.exe")
        exe = candidate if os.path.exists(candidate) else None
    if not exe:
        return None
    try:
        out = subprocess.run([exe, "--query-gpu=memory.free,memory.total", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=5).stdout.strip().splitlines()
        free, total = (int(float(x.strip())) for x in out[0].split(","))
        return free, total
    except Exception:  # noqa: BLE001
        return None


LOW_VRAM_MB = 4500      # below this, int8 weights are used automatically
CRITICAL_VRAM_MB = 2500  # below this, warn that the driver may reset under load


def load_model(args):
    from faster_whisper import WhisperModel

    device = args.device
    if device == "auto":
        device = "cuda" if cuda_available() else "cpu"
    compute = args.compute_type
    if device == "cuda":
        mem = gpu_memory_mb()
        if mem:
            free, total = mem
            log.info("GPU memory: %d MiB free of %d MiB", free, total)
            if compute == "auto":
                compute = "float16" if free >= LOW_VRAM_MB else "int8_float16"
            if free < LOW_VRAM_MB:
                log.warning("Only %d MiB of GPU memory is free, so other applications are holding most of it. "
                            "Using %s weights. Close GPU-heavy apps (games, wallpaper engines, VR software) for best speed and stability.",
                            free, compute)
            if free < CRITICAL_VRAM_MB:
                log.warning("Very little GPU memory is free (%d MiB). Transcription may be slow and the display driver may reset "
                            "under load. Consider closing other GPU apps, or run with --device cpu --model small.", free)
    if compute == "auto":
        compute = "float16" if device == "cuda" else "int8"
    log.info("Loading Whisper model '%s' on %s (%s); models are stored in %s", args.model, device, compute, MODELS_DIR)
    kwargs = {"device": device, "compute_type": compute, "download_root": str(MODELS_DIR)}
    if args.cpu_threads:
        kwargs["cpu_threads"] = args.cpu_threads
    try:
        model = WhisperModel(args.model, **kwargs)
    except Exception as exc:  # noqa: BLE001
        if device != "cuda":
            raise
        log.warning("CUDA initialisation failed (%s). Falling back to CPU int8, which is slow for large models.", exc)
        device, compute = "cpu", "int8"
        kwargs.update(device=device, compute_type=compute)
        model = WhisperModel(args.model, **kwargs)
    try:
        t0 = time.time()
        segs, _ = model.transcribe(np.zeros(SAMPLE_RATE * 2, dtype=np.float32), language=args.language, beam_size=1, vad_filter=False)
        list(segs)
        log.info("Model ready (warm-up took %.1fs)", time.time() - t0)
    except Exception as exc:  # noqa: BLE001
        log.warning("Warm-up transcription failed: %s", exc)
    return model, device, compute


def run_check() -> None:
    print(f"Python {sys.version.split()[0]} at {sys.executable}")
    print(f"Data directory: {APP_DIR}")
    print(f"NVIDIA library directories registered: {len(NVIDIA_DIRS)}")
    try:
        import ctranslate2

        n = ctranslate2.get_cuda_device_count()
        print(f"CTranslate2 {ctranslate2.__version__}: {n} CUDA device(s)" + ("" if n else "  -> CPU fallback; consider --model small"))
    except Exception as exc:  # noqa: BLE001
        print(f"CTranslate2 import failed: {exc}")
    try:
        import faster_whisper

        print(f"faster-whisper {faster_whisper.__version__}")
    except Exception as exc:  # noqa: BLE001
        print(f"faster-whisper import failed: {exc}")
    try:
        import yt_dlp.version

        print(f"yt-dlp {yt_dlp.version.__version__}")
    except Exception as exc:  # noqa: BLE001
        print(f"yt-dlp import failed: {exc}")
    runtimes = {name: shutil.which(name) for name in ("deno", "node", "bun")}
    for name, path in runtimes.items():
        print(f"JS runtime {name}: {path or 'not found'}")
    if not any(runtimes.values()):
        print("WARNING: yt-dlp needs Node.js or Deno to download from YouTube.")
    models = sorted(p.name for p in MODELS_DIR.glob("models--*")) if MODELS_DIR.is_dir() else []
    print("Downloaded models: " + (", ".join(models) if models else "none yet (downloaded on first start)"))


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Shisu-ko: local Whisper transcription server for the Firefox extension")
    p.add_argument("--host", default="127.0.0.1", help="bind address (keep it local)")
    p.add_argument("--port", type=int, default=8790, help="default 8790 (8765 is left free for AnkiConnect)")
    p.add_argument("--model", default="large-v3", help="faster-whisper model size or CTranslate2 repo, e.g. large-v3, large-v3-turbo, kotoba-tech/kotoba-whisper-v2.0-faster")
    p.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    p.add_argument("--compute-type", default="auto", help="float16, int8_float16, int8, ... (auto = float16 on GPU, int8 on CPU)")
    p.add_argument("--language", default="ja")
    p.add_argument("--beam-size", type=int, default=5)
    p.add_argument("--initial-prompt", default="", help="optional text prompt given to Whisper for every window")
    p.add_argument("--window", type=float, default=40.0, help="seconds of audio transcribed per step (shorter reacts faster to seeking, longer is slightly more efficient)")
    p.add_argument("--first-window", type=float, default=20.0, help="shorter first step after a seek so subtitles appear quickly")
    p.add_argument("--lookahead", type=float, default=900.0, help="stop transcribing this many seconds ahead of the playhead (0 = whole video)")
    p.add_argument("--max-cue-chars", type=int, default=42)
    p.add_argument("--max-cue-seconds", type=float, default=7.0)
    p.add_argument("--idle-minutes", type=int, default=30, help="release decoded audio of videos not synced for this long")
    p.add_argument("--cpu-threads", type=int, default=0)
    p.add_argument("--cookies-from-browser", default="", help="e.g. firefox, for age-restricted or members-only videos")
    p.add_argument("--cookies", default="", help="path to a Netscape-format cookies.txt for yt-dlp (use this inside Docker, e.g. /data/cookies.txt)")
    p.add_argument("--js-runtime", default="auto", help="JS runtime for yt-dlp: auto, node, deno, bun, or name:path")
    p.add_argument("--allow-remote-ejs", action="store_true", help="let yt-dlp fetch updated challenge-solver scripts from GitHub")
    p.add_argument("--log-level", default="INFO")
    p.add_argument("--check", action="store_true", help="print environment diagnostics and exit")
    return p.parse_args(argv)


def main() -> None:
    args = parse_args()
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            pass
    logging.basicConfig(level=getattr(logging, args.log_level.upper(), logging.INFO), format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("faster_whisper").setLevel(logging.WARNING)
    for noisy in ("httpx", "httpcore", "huggingface_hub", "urllib3", "filelock"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    MODELS_DIR.mkdir(parents=True, exist_ok=True)

    if args.check:
        run_check()
        return

    try:
        model, device, compute = load_model(args)
    except Exception as exc:  # noqa: BLE001
        log.error("Could not load the model '%s': %s", args.model, exc)
        sys.exit(2)
    app = App(args, model, device, compute)
    Handler.app = app
    try:
        server = ThreadingHTTPServer((args.host, args.port), Handler)
    except OSError as exc:
        log.error("Cannot listen on %s:%d (%s). Is another server already running?", args.host, args.port, exc)
        sys.exit(2)
    server.daemon_threads = True
    log.info("Listening on http://%s:%d  (Ctrl+C to stop)", args.host, args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Shutting down")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

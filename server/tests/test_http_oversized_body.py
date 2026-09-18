"""An oversized POST is answered with 413 and the connection is closed instead of reused."""
from __future__ import annotations

import socket
import threading
from types import SimpleNamespace

import pytest

from _serverlib import load_server

server = load_server()


@pytest.fixture
def http_port():
    server.Handler.app = SimpleNamespace(health=lambda: {"ok": True})
    httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    httpd.daemon_threads = True
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield httpd.server_address[1]
    finally:
        httpd.shutdown()
        httpd.server_close()
        server.Handler.app = None


def read_response_head(sock):
    """Read up to the end of the headers; returns (head, body bytes that already arrived with it)."""
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = sock.recv(4096)
        if not chunk:
            break
        data += chunk
    head, _, rest = data.partition(b"\r\n\r\n")
    return head.decode("latin-1"), rest


def test_oversized_post_gets_413_and_the_connection_is_closed(http_port):
    with socket.create_connection(("127.0.0.1", http_port), timeout=5) as sock:
        sock.sendall(b"POST /sync HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 70000\r\n\r\n")
        head, _ = read_response_head(sock)  # the server must answer before the body arrives
        assert head.startswith("HTTP/1.1 413")
        assert "connection: close" in head.lower()
        # Drain until the server closes; without the fix this would time out with the socket still open.
        while sock.recv(4096):
            pass


def test_normal_requests_keep_the_connection_open(http_port):
    with socket.create_connection(("127.0.0.1", http_port), timeout=5) as sock:
        for _ in range(2):
            sock.sendall(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            head, body = read_response_head(sock)  # small responses arrive together with their body
            assert head.startswith("HTTP/1.1 200")
            assert "connection: close" not in head.lower()
            length = int(next(l for l in head.split("\r\n") if l.lower().startswith("content-length:")).split(":")[1])
            while len(body) < length:
                body += sock.recv(4096)
            assert len(body) == length

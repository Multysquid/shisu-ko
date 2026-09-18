"""Only the extension and loopback pages may use the server from a browser."""
from __future__ import annotations

import pytest

from _serverlib import load_server

server = load_server()


@pytest.mark.parametrize("origin", [
    "moz-extension://0f3c2a9e-1b2c-4d5e-8f90-123456789abc",
    "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    "safari-web-extension://ABCDEF12-3456-7890-ABCD-EF1234567890",
    "http://127.0.0.1:8766",
    "http://localhost:3000",
    "https://localhost",
])
def test_extension_and_loopback_origins_are_allowed(origin):
    assert server.origin_allowed(origin)


@pytest.mark.parametrize("origin", [
    "https://evil.example",
    "https://www.youtube.com",
    "http://127.0.0.1.evil.example",
    "http://localhost.evil.example:8790",
    "file://",
    "null",
    "",
    None,
])
def test_other_origins_are_rejected(origin):
    assert not server.origin_allowed(origin)

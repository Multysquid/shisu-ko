"""Loads server/server.py as an importable module.

server.py is a script, not a package, and uses `from __future__ import annotations`
(postponed evaluation), so it must be registered in sys.modules under its own name
before exec, the same way the "Development" section of the README describes.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_MODULE_NAME = "shisuko_server"
_SERVER_PATH = Path(__file__).resolve().parent.parent / "server.py"


def load_server():
    cached = sys.modules.get(_MODULE_NAME)
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location(_MODULE_NAME, _SERVER_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[_MODULE_NAME] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        del sys.modules[_MODULE_NAME]
        raise
    return module

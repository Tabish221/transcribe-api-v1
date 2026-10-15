"""
Reads the shared settings file ../.env (KEY=VALUE per line, '#' starts a comment line).
A real environment variable with the same name wins over the file. No extra package needed.

    from env import setting, require_setting
    key = require_setting("TRANSCRIBE_API_KEY")
"""

import os
import sys
from pathlib import Path

ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


def _read(path):
    values = {}
    if not path.is_file():
        return values
    # utf-8-sig: Notepad sometimes saves a BOM at the start of the file.
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]  # KEY="value" -> value
        values[name.strip()] = value
    return values


_values = _read(ENV_FILE)


def setting(name, default=""):
    """The environment variable if it is set (not empty), else the value from .env, else default."""
    return os.environ.get(name) or _values.get(name) or default


def require_setting(name):
    """Like setting(), but stops the program with a clear message when the value is missing."""
    value = setting(name)
    if not value:
        sys.exit(f"ERROR: {name} is missing. Add it to {ENV_FILE}")
    return value


def key_hint(key):
    """'tk_1234...' - never print the whole API key."""
    return key[:7] + "..."

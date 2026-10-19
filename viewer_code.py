"""Code the agent produced, kept for the viewer's "Agent code" panel.

Pure Python (no ComfyUI imports) so it can be tested on its own. viewer_api.py
puts three routes on top of it:

  POST /bepic/code   a snippet in (agentY sends every piece of code it makes)
  GET  /bepic/code   the recent snippets, newest first (a freshly opened viewer
                     shows the history)
  GET  /bepic/text   a text file from an allowed folder (the file browser)

A snippet is plain data: {id, title, language, code, source, conversation, turn,
ts}. Nothing here executes it, and the page only ever shows it as text. The shape
leaves room for "edit and send back to the agent" later: ``id`` names the
snippet, ``source`` the tool it came from, ``conversation``/``turn`` where.
"""
from __future__ import annotations

import hashlib
import os
import threading
import time

MAX_CODE_BYTES = 400_000     # one snippet; longer is cut, with a note
MAX_SNIPPETS = 200           # kept in memory per session
MAX_TEXT_FILE = 1_000_000    # a text file opened from the browser

LANGUAGES = ("python", "javascript", "typescript", "tsx", "jsx", "json", "shell",
             "markdown", "html", "css", "yaml", "toml", "text")

_ALIASES = {
    "py": "python", "python3": "python", "py3": "python",
    "js": "javascript", "mjs": "javascript", "cjs": "javascript", "node": "javascript",
    "ts": "typescript", "sh": "shell", "bash": "shell", "zsh": "shell", "console": "shell",
    "ps1": "shell", "powershell": "shell", "bat": "shell", "cmd": "shell",
    "md": "markdown", "yml": "yaml", "htm": "html", "txt": "text", "plain": "text",
    "plaintext": "text", "": "text",
}
_EXT = {".py": "python", ".pyw": "python", ".js": "javascript", ".mjs": "javascript",
        ".cjs": "javascript", ".jsx": "jsx", ".ts": "typescript", ".tsx": "tsx",
        ".json": "json", ".sh": "shell", ".bash": "shell", ".ps1": "shell",
        ".bat": "shell", ".md": "markdown", ".html": "html", ".htm": "html",
        ".css": "css", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
        ".txt": "text", ".log": "text", ".ini": "text", ".cfg": "text",
        ".csv": "text", ".jsonl": "json"}

TEXT_EXTS = frozenset(_EXT)


def language_of(name: str = "", fallback: str = "text") -> str:
    """A language from a fence tag (``py``) or a file name (``a.tsx``)."""
    name = str(name or "").strip().lower()
    if "." in name:
        return _EXT.get(os.path.splitext(name)[1] or name, fallback)
    name = _ALIASES.get(name, name)
    return name if name in LANGUAGES else fallback


def snippet_id(language: str, code: str) -> str:
    return hashlib.sha1(f"{language}\0{code}".encode("utf-8", "replace")).hexdigest()[:16]


def _clean(value, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


class CodeStore:
    """Snippets per session, newest first; identical code is kept once."""

    def __init__(self, cap: int = MAX_SNIPPETS) -> None:
        self._cap = cap
        self._lock = threading.Lock()
        self._sessions: dict[str, list[dict]] = {}

    def add(self, data: dict, session: str = "agentY") -> tuple[dict | None, bool]:
        """Store a snippet. Returns (snippet, is_new); (None, False) when empty."""
        if not isinstance(data, dict):
            return None, False
        code = data.get("code")
        if not isinstance(code, str) or not code.strip():
            return None, False
        note = ""
        raw = code.encode("utf-8", "replace")
        if len(raw) > MAX_CODE_BYTES:
            code = raw[:MAX_CODE_BYTES].decode("utf-8", "ignore")
            note = "cut at %d KB" % (MAX_CODE_BYTES // 1000)
        language = language_of(data.get("language"), "text") if data.get("language") \
            else language_of(data.get("title"), "text")
        sid = snippet_id(language, code)
        session = _clean(data.get("session") or session, 60) or "agentY"
        with self._lock:
            items = self._sessions.setdefault(session, [])
            for old in items:
                if old["id"] == sid:
                    return old, False
            snip = {
                "id": sid,
                "title": _clean(data.get("title"), 120) or "Code",
                "language": language,
                "code": code,
                "source": _clean(data.get("source"), 60),
                "conversation": _clean(data.get("conversation"), 80),
                "turn": _clean(data.get("turn"), 40),
                "ts": float(data.get("ts") or time.time()),
                "note": note,
            }
            items.insert(0, snip)
            del items[self._cap:]
            return snip, True

    def recent(self, session: str = "agentY", limit: int = 50) -> list[dict]:
        with self._lock:
            return [dict(s) for s in self._sessions.get(session, [])[:max(1, limit)]]

    def clear(self, session: str = "agentY") -> None:
        with self._lock:
            self._sessions.pop(session, None)


def read_text_file(path: str) -> tuple[str, str, bool]:
    """(text, language, truncated) of a file; UnicodeDecodeError-safe."""
    with open(path, "rb") as fh:
        raw = fh.read(MAX_TEXT_FILE + 1)
    cut = len(raw) > MAX_TEXT_FILE
    if b"\0" in raw[:4096]:
        raise ValueError("binary file")
    text = raw[:MAX_TEXT_FILE].decode("utf-8", "replace")
    text = text.replace(chr(13) + chr(10), chr(10))
    return text, language_of(path), cut

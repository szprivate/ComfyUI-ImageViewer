"""Raise the process's open-file limit (the soft one) when it is low.

ComfyUI's page imports every .js file of a node pack as an extension at startup - this viewer has a few
hundred - and on macOS the shell's default limit is 256 open files for the WHOLE ComfyUI process. A server
already holding many files then ran out while serving them, some imports failed and the viewer's button
never appeared (Sebastian 2026-11-24). Only the soft limit is raised, never above the hard one, and
never on Windows (no such limit there). IMAGE_VIEWER_KEEP_FILE_LIMIT=1 leaves it alone.
"""
from __future__ import annotations

import os
import sys

WANT = 8192


def raise_limit(want: int = WANT):
    """(before, after) soft limits, or None when nothing was done."""
    if os.name == "nt" or os.environ.get("IMAGE_VIEWER_KEEP_FILE_LIMIT", "").strip() in ("1", "true", "yes"):
        return None
    try:
        import resource
    except ImportError:
        return None
    try:
        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    except (OSError, ValueError):
        return None
    if soft == resource.RLIM_INFINITY or soft >= want:
        return None
    cap = want if hard == resource.RLIM_INFINITY else min(want, hard)
    # macOS refuses a soft limit above kern.maxfilesperproc (often 10240 or 24576) even with an unlimited
    # hard one: try smaller steps down to what is already there.
    for target in (cap, 4096, 2048, 1024):
        if target <= soft:
            break
        try:
            resource.setrlimit(resource.RLIMIT_NOFILE, (target, hard))
            return soft, target
        except (OSError, ValueError):
            continue
    return None


def apply():
    got = raise_limit()
    if got:
        print(f"[ComfyUI-ImageViewer] open-file limit raised from {got[0]} to {got[1]}", file=sys.stderr)
    return got

"""Render a comp from the command line: its Write nodes (each its own files), or its Output to a path.

    python scripts/comp_render.py shot.comp.json                       every Write, all its frames
    python scripts/comp_render.py shot.comp.json --writes main,mattes --first 0 --last 99 --handles 8
    python scripts/comp_render.py shot.comp.json --frames 1001-1010 --frame-offset 1001     one farm chunk
    python scripts/comp_render.py shot.comp.json --output out/shot.####.exr                the Output node
    python scripts/comp_render.py shot.comp.json --list                                     what it would write

Use ComfyUI's own interpreter (it has numpy, Pillow, PyAV and OpenColorIO); nothing of ComfyUI itself is loaded.
Frames are the comp's (from 0); ``--frames a-b`` keeps only those of the planned frames (a farm task's chunk),
after ``--frame-offset`` is taken off them. Exit status 0 when everything was written, 1 on an error, 2 on
wrong arguments. The Python API this uses is ``src/comp_api.py``.
"""
from __future__ import annotations

import argparse
import importlib
import json
import os
import sys
import time
import types

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.normpath(os.path.join(HERE, "..", "src"))


def api():
    """The viewer's ``src`` package, loaded under a name of its own (its modules import each other relatively)."""
    name = "imageviewer_cli"
    if name not in sys.modules:
        pkg = types.ModuleType(name)
        pkg.__path__ = [SRC]
        sys.modules[name] = pkg
    return importlib.import_module(f"{name}.comp_api")


def frames_arg(text):
    a, _, b = str(text).partition("-")
    if text.startswith("-"):
        raise argparse.ArgumentTypeError("frames are a-b with a >= 0 (use --frame-offset for frames before 0)")
    try:
        a = int(a)
        b = int(b) if b else a
    except ValueError:
        raise argparse.ArgumentTypeError("frames are a-b, e.g. 1001-1010") from None
    return (min(a, b), max(a, b))


def main(argv=None):
    ap = argparse.ArgumentParser(prog="comp_render", description="Render a *.comp.json's Write nodes or its Output.")
    ap.add_argument("comp", help="the comp file")
    ap.add_argument("--writes", default="", help="Write nodes by id or name, comma separated (default: all)")
    ap.add_argument("--first", type=int, default=None, help="first comp frame (default: each Write's own)")
    ap.add_argument("--last", type=int, default=None, help="last comp frame (default: each Write's own)")
    ap.add_argument("--handles", type=int, default=None, help="extra frames each side (default: each Write's own)")
    ap.add_argument("--frames", type=frames_arg, default=None, help="only these planned frames, a-b (after the offset)")
    ap.add_argument("--frame-offset", type=int, default=0, help="taken off --frames (Deadline frames are never below 0)")
    ap.add_argument("--output", default="", help="render the Output node to this path instead (a # pattern or a film)")
    ap.add_argument("--first-number", type=int, default=1001, help="with --output: the file number of comp frame 0")
    ap.add_argument("--list", action="store_true", help="print what would be written (JSON) and stop")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args(argv)
    A = api()
    try:
        c = A.Comp.open(a.comp)
        if a.list:
            plans = A.CW.plan(c.data, c.path, [c._id(w) for w in a.writes.split(",") if w.strip()] or None,
                              a.first, a.last, a.handles)
            print(json.dumps([{"id": p["id"], "name": p["name"], "pattern": p["pattern"], "type": p["type"],
                               "first": p["frames"][0], "last": p["frames"][-1]} for p in plans], indent=1))
            return 0
        t0 = time.time()

        def progress(done, total):
            if not a.quiet:
                print(f"\r{done}/{total}", end="", file=sys.stderr, flush=True)
        if a.output:
            frames = None
            if a.first is not None or a.last is not None:
                frames = range(a.first or 0, (a.last if a.last is not None else c.format["frames"] - 1) + 1)
            files = c.render_output(a.output, frames, a.first_number, progress=progress)
            if not a.quiet:
                print(f"\n{len(files)} file(s), {time.time() - t0:.1f} s: {files[0] if files else ''}", file=sys.stderr)
            return 0
        window = None
        if a.frames:
            window = (a.frames[0] - a.frame_offset, a.frames[1] - a.frame_offset)
        writes = [w.strip() for w in a.writes.split(",") if w.strip()] or None
        got = c.render(writes, a.first, a.last, a.handles, window=window, progress=progress)
        if not a.quiet:
            print("", file=sys.stderr)
            for w in got:
                print(f"{w['name']}: {w['frames']} frame(s) -> {w['pattern']}", file=sys.stderr)
            print(f"{time.time() - t0:.1f} s", file=sys.stderr)
        return 0
    except (ValueError, OSError) as e:
        print(f"comp_render: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

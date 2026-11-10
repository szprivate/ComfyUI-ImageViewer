"""What a ``POST /imageviewer/push`` names, turned into the files to show.

The agent says "show me clip 3" or "open these frames": a file, a folder, an
image sequence written as ``frame_%04d.png`` / ``frame_####.png`` / ``frame_*.png``,
or an ``.otio`` cut (which stands for the film rendered beside it). This module
only decides WHICH files; the route turns them into frames and the page shows them.
No aiohttp in here, so it can be tested on its own.
"""
from __future__ import annotations

import glob
import os
import re

_NATURAL = re.compile(r"(\d+)")
_PATTERN = re.compile(r"%0?\d*d|#+|[*?]")


def natural_key(name):
    """frame_2 before frame_10."""
    return [int(t) if t.isdigit() else t.lower() for t in _NATURAL.split(str(name))]


def _glob_of(raw):
    """The glob for a sequence pattern, or None for a plain path."""
    if not _PATTERN.search(os.path.basename(raw)):
        return None
    return _PATTERN.sub("*", raw)


def _film_beside(otio, video_exts, may_serve):
    stem = os.path.splitext(otio)[0]
    for ext in sorted(video_exts):
        for cand in (stem + ext, stem + ext.upper()):
            if os.path.isfile(cand) and may_serve(cand):
                return cand
    return None


def expand(raw_paths, image_exts, video_exts, *, may_serve, is_allowed, cap=200):
    """(files, refused, cuts): the media files to show in order, what could not be
    shown (the raw text), and ``{film: otio}`` for each film that came with its cut."""
    files, refused, cuts, seen = [], [], {}, set()
    exts = {e.lower() for e in image_exts} | {e.lower() for e in video_exts}

    def add(path):
        key = os.path.normcase(os.path.abspath(path))
        if key in seen or len(files) >= cap:
            return
        seen.add(key)
        files.append(os.path.abspath(path))

    for raw in raw_paths:
        if not raw or not isinstance(raw, str):
            continue
        p = os.path.abspath(raw)
        if raw.lower().endswith(".otio"):
            if not is_allowed(p) or not os.path.isfile(p):
                refused.append(raw)
                continue
            film = _film_beside(p, video_exts, may_serve)
            if not film:
                refused.append(raw)          # a cut with no film rendered yet
                continue
            cuts[os.path.abspath(film)] = p
            add(film)
            continue
        pattern = _glob_of(raw)
        if pattern:
            hits = sorted((h for h in glob.glob(os.path.abspath(pattern))
                           if os.path.splitext(h)[1].lower() in exts and os.path.isfile(h)
                           and may_serve(h)), key=lambda h: natural_key(os.path.basename(h)))
            if not hits:
                refused.append(raw)
            for h in hits:
                add(h)
            continue
        if os.path.isdir(p):
            if not is_allowed(p):
                refused.append(raw)
                continue
            names = sorted((n for n in os.listdir(p) if os.path.splitext(n)[1].lower() in exts),
                           key=natural_key)
            found = [os.path.join(p, n) for n in names if may_serve(os.path.join(p, n))]
            if not found:
                refused.append(raw)
            for h in found:
                add(h)
            continue
        if not may_serve(p) or not os.path.isfile(p):
            refused.append(raw)
            continue
        add(p)
    return files, refused, cuts


def split_pushed(raw_paths, *, is_allowed, is_scene, dataset_of=None):
    """(motion, lora, rest): which of the pushed paths open a panel rather than a media tab.

    A motion-graphics scene (``*.mgscene.json``) is not media, so the test for it is the allowed
    folders (``is_allowed``) and that the file exists - NOT ``may_serve``, which only passes pictures,
    films, sound and 3D files and refused every scene (the Motion panel never opened for an agent's
    new scene). A LoRA dataset's ``manifest.json`` (``dataset_of(raw)`` true) opens the Dataset panel.
    Anything else, and a scene that is missing or outside the allowed folders, stays in ``rest``
    (which the caller reports as refused)."""
    motion, lora, rest = [], [], []
    for raw in raw_paths:
        if dataset_of is not None and dataset_of(raw):
            lora.append(os.path.abspath(raw))
        elif is_scene(raw):
            p = os.path.abspath(raw)
            if os.path.isfile(p) and is_allowed(p):
                motion.append(p)
            else:
                rest.append(raw)
        else:
            rest.append(raw)
    return motion, lora, rest


def split_lone_cuts(raw_paths, *, is_allowed, may_serve, video_exts):
    """(cuts, rest): the ``.otio`` files that open the Edit panel by themselves.

    A cut with a film rendered beside it stands for that film (``expand``); a cut with NO film
    beside it has nothing to show in a media tab, so it is opened as a cut: its tab and the Edit
    panel. Only inside the allowed folders (``is_allowed``) and only a file that exists; any other
    ``.otio`` stays in ``rest`` (the caller reports it as refused)."""
    cuts, rest = [], []
    for raw in raw_paths:
        if isinstance(raw, str) and raw.lower().endswith(".otio"):
            p = os.path.abspath(raw)
            if is_allowed(p) and os.path.isfile(p) and not _film_beside(p, video_exts, may_serve):
                cuts.append(p)
                continue
        rest.append(raw)
    return cuts, rest


def split_paint(raw_paths, *, is_allowed):
    """(paint, rest): the ``.ora`` / ``.psd`` files, which open in a Paint tab (they are not media,
    so the test is the allowed folders and that the file exists; anything else stays in ``rest``)."""
    paint, rest = [], []
    for raw in raw_paths:
        if isinstance(raw, str) and os.path.splitext(raw)[1].lower() in (".ora", ".psd"):
            p = os.path.abspath(raw)
            if is_allowed(p) and os.path.isfile(p):
                paint.append(p)
                continue
        rest.append(raw)
    return paint, rest


def split_comps(raw_paths, *, is_allowed):
    """(comps, rest): the ``*.comp.json`` files, which open in a Comp tab (not media either: the test is the
    allowed folders and that the file exists; anything else stays in ``rest``)."""
    comps, rest = [], []
    for raw in raw_paths:
        if isinstance(raw, str) and raw.lower().endswith(".comp.json"):
            p = os.path.abspath(raw)
            if is_allowed(p) and os.path.isfile(p):
                comps.append(p)
                continue
        rest.append(raw)
    return comps, rest

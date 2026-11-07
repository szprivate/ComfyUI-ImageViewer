"""What is left of the viewer's old name.

Until 1.18 the viewer was called "bEpic". Everything is called ComfyUI Image
Viewer now; this module reads what was saved under the old names, so nothing a
user set up or saved is lost:

- environment variables ``BEPIC_*`` (``BEPIC_VIEWER_ROOTS`` ...) count as their
  ``IMAGE_VIEWER_*`` names while those are not set (:func:`adopt_old_env`, run
  first thing by ``__init__.py``);
- the per-user folder ``~/.bepic_viewer`` (folders the viewer may open, its
  settings) is copied to ``~/.comfyui_image_viewer`` once (:func:`user_dir`);
- settings ids ``bEpic.Viewer.*`` read as ``ImageViewer.*`` (:func:`renamed_setting`);
- a cut's (.otio) notes under ``metadata.bepic`` and titles of generator kind
  ``bepic.title`` read as ``metadata.imageviewer`` / ``imageviewer.title``
  (:func:`renamed_otio`, applied where a cut is read);
- a Paint document's (.ora) ``bepic.json`` is read when there is no
  ``imageviewer.json`` (paint_io.py).

The node ids live in nodes.py (``LEGACY_NODE_IDS``), the routes in
viewer_api.py (``/bepic/*`` still answers), the page's side in
``js/imageViewer_legacy.js``.
"""

import os
import shutil

OLD_ENV_PREFIXES = (("BEPIC_VIEWER_", "IMAGE_VIEWER_"), ("BEPIC_", "IMAGE_VIEWER_"))
# Not the viewer's: the Worlds pack keeps its own names.
_NOT_OURS = ("BEPIC_WORLDS",)

OLD_SETTING, NEW_SETTING = "bEpic.Viewer.", "ImageViewer."
OLD_META, NEW_META = "bepic", "imageviewer"
OLD_TITLE, NEW_TITLE = "bepic.title", "imageviewer.title"

USER_DIR_NAME, OLD_USER_DIR_NAME = ".comfyui_image_viewer", ".bepic_viewer"


def adopt_old_env(environ=None):
    """Set each ``IMAGE_VIEWER_*`` variable from its old ``BEPIC_*`` name when
    only the old one is set. Returns the names that were set."""
    env = os.environ if environ is None else environ
    done = []
    for name in list(env):
        if name.startswith(_NOT_OURS):
            continue
        for old, new in OLD_ENV_PREFIXES:
            if name.startswith(old):
                now = new + name[len(old):]
                if now not in env:
                    env[now] = env[name]
                    done.append(now)
                break
    return done


def user_dir(home=None):
    """``~/.comfyui_image_viewer``; the first time, a copy of ``~/.bepic_viewer``
    when that is there (it is left as it was, for an older viewer)."""
    home = home or os.path.expanduser("~")
    new = os.path.join(home, USER_DIR_NAME)
    old = os.path.join(home, OLD_USER_DIR_NAME)
    if not os.path.exists(new) and os.path.isdir(old):
        try:
            shutil.copytree(old, new)
        except Exception as e:
            print(f"[ImageViewer] could not copy {old} to {new}: {e}")
    return new


def renamed_setting(key):
    """A settings id under its current name."""
    if isinstance(key, str) and key.startswith(OLD_SETTING):
        return NEW_SETTING + key[len(OLD_SETTING):]
    return key


def renamed_otio(obj):
    """Rename the old notes in a cut read from an .otio (a dict tree), in place:
    every ``metadata.bepic`` becomes ``metadata.imageviewer`` (merged under
    it when both are there; the new one wins) and a ``bepic.title`` generator
    becomes ``imageviewer.title``. Returns *obj*."""
    stack = [obj]
    while stack:
        cur = stack.pop()
        if isinstance(cur, list):
            stack.extend(cur)
            continue
        if not isinstance(cur, dict):
            continue
        meta = cur.get("metadata")
        if isinstance(meta, dict) and OLD_META in meta:
            old = meta.pop(OLD_META)
            new = meta.get(NEW_META)
            if isinstance(old, dict) and isinstance(new, dict):
                meta[NEW_META] = {**old, **new}
            elif new is None:
                meta[NEW_META] = old
        if cur.get("generator_kind") == OLD_TITLE:
            cur["generator_kind"] = NEW_TITLE
        stack.extend(v for v in cur.values() if isinstance(v, (dict, list)))
    return obj

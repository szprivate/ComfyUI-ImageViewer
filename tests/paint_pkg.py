"""Paint's Python modules (paint_math, paint_io, paint_ops) loaded without ComfyUI: they use relative
imports, so they are put in a package of their own whose path is the repo's src/. For the tests."""
import importlib
import os
import sys
import types

import numpy as np  # noqa: F401 - re-exported for the tests

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if "imageviewer_paint_pkg" not in sys.modules:
    _pkg = types.ModuleType("imageviewer_paint_pkg")
    _pkg.__path__ = [os.path.join(_ROOT, "src")]
    sys.modules["imageviewer_paint_pkg"] = _pkg
paint_math = importlib.import_module("imageviewer_paint_pkg.paint_math")
paint_io = importlib.import_module("imageviewer_paint_pkg.paint_io")
paint_ops = importlib.import_module("imageviewer_paint_pkg.paint_ops")
paint_style = importlib.import_module("imageviewer_paint_pkg.paint_style")
paint_select = importlib.import_module("imageviewer_paint_pkg.paint_select")
paint_smart = importlib.import_module("imageviewer_paint_pkg.paint_smart")

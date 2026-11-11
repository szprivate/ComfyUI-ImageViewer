"""Run UniRig's run.py with PyTorch's safe (weights-only) checkpoint loading kept on.

PyTorch 2.6+ loads checkpoints weights-only: tensors and plain containers, nothing that can run
code. UniRig's skin checkpoint also stores its training settings as python-box objects
(box.box.Box, box.box_list.BoxList), which the safe loader refuses. Here those two names are
read as plain data instead - a Box as an OrderedDict, a BoxList as a list - so the loader stays
safe (no Box code runs, nothing else is allowed) and UniRig, which only needs the weights from
the file, loads it. Then run.py runs as `python run.py ...` would, in UniRig's folder.

Usage: python unirig_launch.py run.py --task=... (run.py's own arguments)
"""
import collections
import os
import runpy
import sys


class BoxAsDict:
    """box.box.Box in a checkpoint, read as an OrderedDict of its items."""

    def __new__(cls, *args, **kwargs):
        return collections.OrderedDict()


class BoxListAsList(list):
    """box.box_list.BoxList in a checkpoint, read as a list of its items."""

    def __setstate__(self, state):
        if isinstance(state, dict):
            self.extend(state.get("items", []))


def read_box_as_data():
    try:
        import torch
    except ImportError:
        return
    add = getattr(getattr(torch, "serialization", None), "add_safe_globals", None)
    if add is None:            # an older PyTorch, which loads these checkpoints anyway
        return
    try:
        add([(BoxAsDict, "box.box.Box"), (BoxListAsList, "box.box_list.BoxList")])
    except (TypeError, ValueError):   # a PyTorch without the (object, name) form
        pass


def main():
    script = os.path.abspath(sys.argv[1])
    read_box_as_data()
    sys.argv = [script, *sys.argv[2:]]
    sys.path.insert(0, os.path.dirname(script))
    runpy.run_path(script, run_name="__main__")


if __name__ == "__main__":
    main()

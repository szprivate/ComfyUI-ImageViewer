"""Comp's grain profiles: what a Grain, Degrain or Regrain node's Analyse measures, at full size.

The page draws at a proxy scale, where grain is mostly averaged away, so a profile is measured here: the node's
input(s) are rendered at full size (``comp_model.render_node``) on a few frames, measured by ``comp_extra``'s
``analyse_grain`` (the twin of the page's ``analyseGrain``), and the frames' numbers merged (their median). What
is measured per node:

- Grain: its plate input (else what comes in), as a picture with grain in it;
- Degrain: what comes in;
- Regrain: the plate less the degrained plate (the grain itself), sorted by the degrained plate's brightness.

Every frame is sorted into the brightness bins of the first, so the frames' bins are the same ones.
"""
from __future__ import annotations

from . import comp_model as M

MAX_FRAMES = 12
TYPES = ("grain", "degrain", "regrain")


class GrainError(ValueError):
    pass


def _node(comp, node_id):
    comp, _ = M.normalize(comp)
    comp = M.G.flatten(comp)    # a node inside a group is named by its flat id, "<group>/<id>"
    n = next((x for x in comp["nodes"] if x["id"] == node_id), None)
    if n is None:
        raise GrainError(f"no node {node_id!r} in the comp")
    if n.get("type") not in TYPES:
        raise GrainError(f"{node_id} is not a Grain, Degrain or Regrain node")
    return comp, n


def _inputs(n):
    ins = list(n.get("inputs") or []) + [None, None, None]
    t = n["type"]
    if t == "regrain":
        if not ins[1] or not ins[2]:
            raise GrainError("wire the plate and the degrained plate into the Regrain first")
        return [ins[1], ins[2]]
    if t == "grain":
        if not (ins[1] or ins[0]):
            raise GrainError("wire a plate into the Grain's plate input first")
        return [ins[1] or ins[0]]
    if not ins[0]:
        raise GrainError("nothing comes into the Degrain")
    return [ins[0]]


def analyse(comp, node_id, frames, sources, ocio=None):
    """{profile, frames, width, height}: the node's grain measured on *frames* (at most MAX_FRAMES) at full size."""
    X = M._X
    comp, n = _node(comp, node_id)
    ids = _inputs(n)
    fs = []
    for f in frames or [0]:
        try:
            g = int(f)
        except (TypeError, ValueError):
            continue
        if g not in fs:
            fs.append(g)
    fs = fs[:MAX_FRAMES] or [0]
    rng = None
    profs = []
    size = None
    for f in fs:
        memo = {}
        pics = [M.render_node(comp, i, f, sources, 1.0, memo=memo, ocio=ocio) for i in ids]
        h, w = pics[0].shape[:2]
        pics = [pics[0]] + [M.conform(p, w, h) for p in pics[1:]]
        got = X.analyse_inputs(n["type"], pics)
        if got is None:
            continue
        noise, guide = got
        p = X.analyse_grain(noise, guide, 1.0, rng)
        rng = rng or (p["lo"], p["hi"])
        profs.append(p)
        size = size or (w, h)
    prof = X.merge_profiles(profs)
    if prof is None:
        raise GrainError("nothing could be measured")
    return {"profile": prof, "frames": fs, "width": size[0], "height": size[1]}

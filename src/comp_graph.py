"""Comp: a graph with groups, Dots, backdrops and sticky notes rendered FLAT - js/imageViewer_compGraph.js in Python.

``flatten(comp)`` lays every group's nodes out at the top level with ids ``"<group id>/<their id>"``, takes Dots,
group Inputs and Outputs and the groups themselves out of the wires (a wire to one goes to what it passes on),
leaves backdrops and notes out; a disabled group passes its first input. Each flat node carries its graph's
scope under ``"__scope"`` (what expressions look other nodes up in: that graph, then the ones around it). The
flat comp is marked ``"_flat"`` and ``"_alias"`` says what a group's or a Dot's id stands for. Standard library only."""
import copy

SEP = "/"
GRAPH_ONLY = {"backdrop", "sticky"}
PASSING = {"dot", "group", "group_input", "group_output"}


class Scope:
    """One graph's nodes by their ids, the comp's format and the scope around it. Never copied."""

    def __init__(self, fmt, parent=None):
        self.nodes = {}
        self.format = fmt
        self.parent = parent

    def find(self, nid):
        s = self
        while s is not None:
            if nid in s.nodes:
                return s.nodes[nid]
            s = s.parent
        return None

    def __deepcopy__(self, memo):
        return self

    def __copy__(self):
        return self


def group_inputs(g):
    """A group's Input nodes, in the order of its ports."""
    ns = [(n, i) for i, n in enumerate((g or {}).get("nodes") or []) if isinstance(n, dict) and n.get("type") == "group_input"]
    ns.sort(key=lambda t: (t[0].get("index") if isinstance(t[0].get("index"), (int, float)) else 1e9, t[1]))
    return [n for n, _ in ns]


def group_output(g):
    for n in (g or {}).get("nodes") or []:
        if isinstance(n, dict) and n.get("type") == "group_output":
            return n
    return None


def _needs(nodes):
    return any(isinstance(n, dict) and (n.get("type") in PASSING or n.get("type") in GRAPH_ONLY or n.get("expr")) for n in nodes or [])


def flatten(comp):
    """The comp the renderer sees (see the module's text); the comp itself when there is nothing to flatten."""
    if not comp or comp.get("_flat") or not _needs(comp.get("nodes")):
        return comp
    nodes, alias = [], {}

    def lay(level, prefix, ins, ports, parent):
        scope = Scope(comp.get("format"), parent)
        for n in level or []:
            if not isinstance(n, dict):
                continue
            fid = prefix + str(n.get("id"))
            t = n.get("type")
            raw_in = n.get("inputs") or []

            def up(i, raw_in=raw_in):
                return prefix + raw_in[i] if i < len(raw_in) and raw_in[i] else None
            if t in GRAPH_ONLY:
                continue
            if t in ("dot", "group_output"):
                alias[fid] = up(0)
                continue
            if t == "group_input":
                k = ports.get(n.get("id"))
                alias[fid] = ins[k] if ins is not None and k is not None and k < len(ins) else None
                continue
            if t == "group":
                gi = [up(i) for i in range(len(raw_in))]
                if n.get("disable"):
                    alias[fid] = gi[0] if gi else None
                    continue
                lay(n.get("nodes"), fid + SEP, gi, {x.get("id"): k for k, x in enumerate(group_inputs(n))}, scope)
                go = group_output(n)
                alias[fid] = fid + SEP + go["id"] if go else None
                continue
            c = dict(n)
            c.pop("__scope", None)
            c["id"] = fid
            c["inputs"] = [up(i) for i in range(len(raw_in))]
            # A Paint stroke that follows a Transform names it by its id in this graph.
            if prefix and isinstance(n.get("strokes"), list):
                c["strokes"] = [dict(st, link=prefix + st["link"]) if isinstance(st, dict) and isinstance(st.get("link"), str) and st["link"] else st
                                for st in n["strokes"]]
            nodes.append(c)
            scope.nodes[n.get("id")] = c
        for c in scope.nodes.values():
            c["__scope"] = scope

    lay(comp.get("nodes"), "", None, {}, None)

    def final(i):
        d = 0
        while i and i in alias and d < 512:
            i = alias[i]
            d += 1
        return None if d >= 512 else i
    for c in nodes:
        c["inputs"] = [final(i) for i in c["inputs"]]
    flat = dict(comp)
    flat["nodes"] = nodes
    flat["output"] = final(comp.get("output"))
    flat["_flat"] = True
    flat["_alias"] = {k: final(k) for k in alias}
    return flat


def resolve(flat, nid):
    """What a flat id stands for (a Dot or a group: the node whose picture it passes on)."""
    a = (flat or {}).get("_alias") or {}
    return a.get(nid, nid)


def flat_node(comp, fid):
    """The node of the tree a flat id names."""
    def find(level, rest):
        for n in level or []:
            if not isinstance(n, dict):
                continue
            if n.get("id") == rest:
                return n
            if n.get("type") == "group" and rest.startswith(str(n.get("id")) + SEP):
                r = find(n.get("nodes"), rest[len(str(n["id"])) + len(SEP):])
                if r is not None:
                    return r
        return None
    return find((comp or {}).get("nodes"), fid) if isinstance(fid, str) else None


def strip(comp):
    """A comp without the scopes the flattening put on its nodes (for writing it out)."""
    out = copy.copy(comp)
    out["nodes"] = [{k: v for k, v in n.items() if k != "__scope"} for n in comp.get("nodes") or []]
    out.pop("_flat", None)
    out.pop("_alias", None)
    return out

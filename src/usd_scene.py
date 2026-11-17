"""A 3D scene saved as USD: the file Save scene writes and Open scene reads.

usd_io writes and reads stages; this is what turns that into the scene's own
file format:

    shot_v003.usda              the scene: one prim per Outliner row
    assets/hero_1a2b3c4d5e.usdc a mesh, converted once from hero.glb
    assets/Terrain_9f8e7d.usdc  a terrain, as the page built it

Every mesh is **referenced** from the scene (a payload: a reference the stage
can leave unloaded), never written into it, so the scene layer stays small and
an asset is shared by every version that uses it. A USD asset is referenced
where it lies. Any other mesh is converted into `assets/` beside the scene,
named after the file and a hash of where it is and when it changed, so saving
again re-uses the copy; the item still shows the original file, and falls back
to the copy when that file is gone. What the page built itself (a terrain, a
scatter, a depth mesh, an FBX the server cannot read) arrives as arrays from
the page and is written the same way.

Everything the viewer needs to open the scene exactly as it was - keys,
constraints, rigs, layers, the clip sequencer - rides in customData
(`imageViewer:item` on each prim, `imageViewer:scene` on the root), so other
applications see a plain stage and this viewer loses nothing.
"""

import hashlib
import json
import os
import re

try:                                    # as part of the package
    from . import usd_io
except ImportError:                     # loaded on its own (tests)
    import usd_io                       # type: ignore

FORMAT = 2                              # what `imageViewer:format` says on a saved scene
SCENE_EXTS = (".usda", ".usdc", ".usd")
# Meshes the server converts itself (trimesh); the rest come from the page.
CONVERTIBLE = {".glb", ".gltf", ".obj", ".ply", ".stl"}
# Kinds whose geometry only the page has: it is built from their settings.
BUILT_KINDS = ("terrain", "scatter", "depthmesh")
_VDIR = re.compile(r"^v\d{3,}$", re.I)


def is_scene_file(path):
    return os.path.splitext(str(path or ""))[1].lower() in SCENE_EXTS


def assets_dir(scene_path):
    """Where a scene's converted meshes go: `assets/` beside it, or beside the
    shot's version folders when the scene sits in one (`.../v003/`), so every
    version shares one copy of each asset."""
    folder = os.path.dirname(os.path.abspath(scene_path))
    if _VDIR.match(os.path.basename(folder)):
        folder = os.path.dirname(folder)
    return os.path.join(folder, "assets")


def _stem(name):
    stem = os.path.splitext(os.path.basename(str(name or "mesh")))[0]
    return re.sub(r"[^A-Za-z0-9_-]", "_", stem)[:48] or "mesh"


def _file_key(path):
    st = os.stat(path)
    key = f"{os.path.normcase(os.path.abspath(path))}|{st.st_size}|{int(st.st_mtime)}"
    return hashlib.sha1(key.encode("utf-8", "replace")).hexdigest()[:10]


def converted_mesh(src_path, out_dir):
    """`src_path` (a .glb, .obj, ...) as a .usdc in `out_dir`, converted the
    first time and re-used after. Returns its path."""
    try:
        from . import model_writer      # needs ComfyUI's folder_paths
    except ImportError:
        import model_writer             # type: ignore
    ext = os.path.splitext(src_path)[1].lower()
    target = os.path.join(out_dir, f"{_stem(src_path)}_{_file_key(src_path)}.usdc")
    if os.path.isfile(target):
        return target
    os.makedirs(out_dir, exist_ok=True)
    with open(src_path, "rb") as fh:
        data = fh.read()
    model_writer.convert(data, ext.lstrip("."), "usdc", target)
    return target


def built_mesh(name, geo, out_dir):
    """Meshes the page sent (usd_io.write_geometry_layer's shape) as a .usdc in
    `out_dir`, named by their content: the same terrain saved twice is one file."""
    key = hashlib.sha1(json.dumps(geo, sort_keys=True).encode("utf-8")).hexdigest()[:10]
    target = os.path.join(out_dir, f"{_stem(name)}_{key}.usdc")
    if not os.path.isfile(target):
        usd_io.write_geometry_layer(target, geo)
    return target


def _sanitize(name):
    """A node's name as model_writer names its prim."""
    out = re.sub(r"[^A-Za-z0-9_]", "_", str(name or ""))
    return ("m_" + out) if out[:1].isdigit() else out


def _map_edits(edits, layer_path):
    """The Outliner's edits on a converted mesh, onto the prims the conversion
    wrote: it lays every mesh flat under its root, named after the node, so a
    path the page knows (its node tree) is matched by its last name."""
    if not (edits.get("overs") or edits.get("variants")):
        return edits
    from pxr import Usd
    stage = Usd.Stage.Open(layer_path, load=Usd.Stage.LoadNone)
    root = stage.GetDefaultPrim() if stage else None
    if not root:
        return {}
    names = {}
    for prim in Usd.PrimRange(root):
        if prim != root:
            rel = str(prim.GetPath())[len(str(root.GetPath())) + 1:]
            names.setdefault(prim.GetName(), rel)
    out = {"overs": {}, "variants": {}}
    for which in ("overs", "variants"):
        for rel, value in (edits.get(which) or {}).items():
            leaf = _sanitize(str(rel).strip("/").split("/")[-1]) if rel else ""
            if leaf in names:
                out[which][names[leaf]] = value
    return out


def save(scene, path, baked=None, geometry=None):
    """Write `scene` (a parsed scene dict) as a USD scene at `path`.

    `baked` is the same scene with constraints and clips turned into keys -
    what other applications should see move; the scene itself is what this
    viewer keeps. `geometry` is {item id: {"meshes": [...]}} from the page.
    Returns {"path", "assets": [files written or re-used], "notes": [what
    could only be kept as a path]}.
    """
    scene = scene or {}
    baked = baked or scene
    geometry = geometry or {}
    path = os.path.abspath(path)
    out_dir = assets_dir(path)
    payloads, edits, notes, assets = {}, {}, [], []
    true_items = {it.get("id"): it for it in scene.get("items") or [] if isinstance(it, dict)}

    for item in baked.get("items") or []:
        if not isinstance(item, dict):
            continue
        ident, kind = item.get("id"), item.get("kind")
        geo = geometry.get(ident)
        try:
            if kind == "model":
                src = item.get("src") or {}
                # Read from the item as kept: a baked copy carries the same src.
                kept = (true_items.get(ident) or item).get("usd") or {}
                found = usd_io.src_file(src)
                if found and not os.path.isfile(found):
                    found = None
                if found and usd_io.is_usd(found):
                    # Referenced where it lies; a src by ComfyUI name is spelled as a path here.
                    if not src.get("path"):
                        payloads[ident] = found
                elif found and os.path.splitext(found)[1].lower() in CONVERTIBLE:
                    payloads[ident] = converted_mesh(found, out_dir)
                    edits[ident] = _map_edits(kept, payloads[ident])
                elif geo and geo.get("meshes"):
                    payloads[ident] = built_mesh(item.get("name") or "model", geo, out_dir)
                    edits[ident] = _map_edits(kept, payloads[ident])
                else:
                    notes.append(f"{item.get('name')}: kept as a path only (no mesh this could convert)")
            elif kind in BUILT_KINDS and geo and geo.get("meshes"):
                payloads[ident] = built_mesh(item.get("name") or kind, geo, out_dir)
        except Exception as e:                       # one bad mesh must not lose the scene
            notes.append(f"{item.get('name')}: mesh not written ({e})")
        if ident in payloads and os.path.abspath(payloads[ident]).startswith(os.path.abspath(out_dir) + os.sep):
            assets.append(payloads[ident])

    scene_data = {k: v for k, v in scene.items() if k != "items"}
    scene_data["order"] = [it.get("id") for it in scene.get("items") or [] if isinstance(it, dict)]
    usd_io.export_scene(baked, path, bake=True, payloads=payloads, geometry=geometry,
                        item_json=true_items, scene_data=scene_data, resolve=usd_io.src_file,
                        sidecars=assets, edits=edits)
    _stamp(path, notes)
    return {"path": path, "assets": sorted(set(assets)), "notes": notes}


def _stamp(path, notes):
    from pxr import Usd
    stage = Usd.Stage.Open(path, load=Usd.Stage.LoadNone)
    prim = stage.GetPrimAtPath("/previz")
    if prim:
        prim.SetCustomDataByKey("imageViewer:format", FORMAT)
        if notes:
            prim.SetCustomDataByKey("imageViewer:notes", json.dumps(notes))
    stage.GetRootLayer().Save()


def load(path):
    """A saved scene back as the scene dict it was (usd_io.import_scene reads
    our own stages item by item)."""
    return usd_io.import_scene(path)


# ── the Outliner's view of an asset: its prims ───────────────────────────────

def _rel(prim, base):
    p, b = str(prim.GetPath()), str(base.GetPath())
    return "" if p == b else p[len(b) + 1:] if b != "/" else p.lstrip("/")


def _arcs(prim):
    out = []
    for spec in prim.GetPrimStack():
        for which, label in (("payloadList", "payload"), ("referenceList", "reference")):
            arcs = getattr(spec, which, None)
            if arcs is None:
                continue
            for name in ("prependedItems", "explicitItems", "appendedItems"):
                for arc in list(getattr(arcs, name, []) or []):
                    out.append({"kind": label, "asset": arc.assetPath or "", "prim": str(arc.primPath or "")})
    return out


def prim_tree(path, prim=None, edits=None, limit=4000):
    """The prims of the stage at `path` below `prim` (else its default prim),
    composed with `edits` applied, as rows for the Outliner:
    [{rel, name, parent, type, kind, arcs, variants: {set: {choices, selection}},
      visible, active}], parents first. `truncated` says the list was cut."""
    from pxr import Usd, UsdGeom
    stage = Usd.Stage.Open(os.path.abspath(path), load=Usd.Stage.LoadAll)
    if stage is None:
        raise ValueError(f"could not open {os.path.basename(path)}")
    base = stage.GetPrimAtPath(prim) if prim else stage.GetDefaultPrim()
    if not base or not base.IsValid():
        base = stage.GetPseudoRoot()
    if edits:
        stage.SetEditTarget(stage.GetSessionLayer())
        usd_io.apply_edits(stage, base.GetPath(), edits)
    rows, cut = [], False
    it = iter(Usd.PrimRange.AllPrims(base))
    for p in it:
        if p == base:
            continue
        if len(rows) >= limit:
            cut = True
            break
        variants = {}
        vsets = p.GetVariantSets()
        for name in vsets.GetNames():
            vs = vsets.GetVariantSet(name)
            variants[name] = {"choices": list(vs.GetVariantNames()), "selection": vs.GetVariantSelection()}
        img = UsdGeom.Imageable(p)
        model = Usd.ModelAPI(p)
        rows.append({
            "rel": _rel(p, base),
            "name": p.GetName(),
            "parent": _rel(p.GetParent(), base) if p.GetParent() != base else "",
            "type": p.GetTypeName() or "",
            "kind": (model.GetKind() if model else "") or "",
            "arcs": _arcs(p),
            "variants": variants,
            "visible": (img.GetVisibilityAttr().Get() != UsdGeom.Tokens.invisible) if img else True,
            "active": p.IsActive(),
        })
    root_variants = {}
    vsets = base.GetVariantSets()
    for name in vsets.GetNames():
        vs = vsets.GetVariantSet(name)
        root_variants[name] = {"choices": list(vs.GetVariantNames()), "selection": vs.GetVariantSelection()}
    return {"root": str(base.GetPath()), "prims": rows, "truncated": cut, "variants": root_variants}


def edits_key(edits):
    """A short key for a set of edits (what a display copy is cached under)."""
    if not edits or not (edits.get("overs") or edits.get("variants")):
        return ""
    blob = json.dumps({"o": edits.get("overs") or {}, "v": edits.get("variants") or {}}, sort_keys=True)
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()[:12]

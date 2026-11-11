"""A small skinned humanoid as a .glb, for the rigging tests.

Written by hand, so the tests own every number in it: a T-posed figure about
1.8 units tall standing on the grid, Y up, facing +Z, its left arm along +X —
the same way round a Mixamo or VRM character comes in. Each bone gets a box of
its own, weighted fully to that bone, so a pose is easy to read off the
vertices.

    python tests/rig_fixture.py out.glb [--prefix mixamorig:] [--names unreal|generic]

`--names generic` names the bones bone_0, bone_1, ... the way an auto-rigger
that knows nothing about humans does, so the topology matcher is what has to
find the limbs.
"""
import json
import struct
import sys

# name, parent, head position (world, rest), tail used for the box
BONES = [
    ("Hips", None, (0.0, 1.0, 0.0)),
    ("Spine", "Hips", (0.0, 1.1, 0.0)),
    ("Spine1", "Spine", (0.0, 1.25, 0.0)),
    ("Spine2", "Spine1", (0.0, 1.4, 0.0)),
    ("Neck", "Spine2", (0.0, 1.55, 0.0)),
    ("Head", "Neck", (0.0, 1.65, 0.0)),
    ("HeadTop_End", "Head", (0.0, 1.85, 0.0)),
    ("LeftShoulder", "Spine2", (0.06, 1.5, 0.0)),
    ("LeftArm", "LeftShoulder", (0.18, 1.5, 0.0)),
    ("LeftForeArm", "LeftArm", (0.46, 1.5, 0.0)),
    ("LeftHand", "LeftForeArm", (0.72, 1.5, 0.0)),
    ("LeftHandMiddle1", "LeftHand", (0.8, 1.5, 0.0)),
    ("LeftHandMiddle4", "LeftHandMiddle1", (0.9, 1.5, 0.0)),
    ("RightShoulder", "Spine2", (-0.06, 1.5, 0.0)),
    ("RightArm", "RightShoulder", (-0.18, 1.5, 0.0)),
    ("RightForeArm", "RightArm", (-0.46, 1.5, 0.0)),
    ("RightHand", "RightForeArm", (-0.72, 1.5, 0.0)),
    ("RightHandMiddle1", "RightHand", (-0.8, 1.5, 0.0)),
    ("RightHandMiddle4", "RightHandMiddle1", (-0.9, 1.5, 0.0)),
    ("LeftUpLeg", "Hips", (0.1, 0.95, 0.0)),
    ("LeftLeg", "LeftUpLeg", (0.1, 0.52, 0.01)),
    ("LeftFoot", "LeftLeg", (0.1, 0.09, 0.0)),
    ("LeftToeBase", "LeftFoot", (0.1, 0.02, 0.12)),
    ("LeftToe_End", "LeftToeBase", (0.1, 0.02, 0.2)),
    ("RightUpLeg", "Hips", (-0.1, 0.95, 0.0)),
    ("RightLeg", "RightUpLeg", (-0.1, 0.52, 0.01)),
    ("RightFoot", "RightLeg", (-0.1, 0.09, 0.0)),
    ("RightToeBase", "RightFoot", (-0.1, 0.02, 0.12)),
    ("RightToe_End", "RightToeBase", (-0.1, 0.02, 0.2)),
]

UNREAL = {
    "Hips": "pelvis", "Spine": "spine_01", "Spine1": "spine_02", "Spine2": "spine_03",
    "Neck": "neck_01", "Head": "head", "HeadTop_End": "head_end",
    "LeftShoulder": "clavicle_l", "LeftArm": "upperarm_l", "LeftForeArm": "lowerarm_l",
    "LeftHand": "hand_l", "LeftHandMiddle1": "middle_01_l", "LeftHandMiddle4": "middle_end_l",
    "RightShoulder": "clavicle_r", "RightArm": "upperarm_r", "RightForeArm": "lowerarm_r",
    "RightHand": "hand_r", "RightHandMiddle1": "middle_01_r", "RightHandMiddle4": "middle_end_r",
    "LeftUpLeg": "thigh_l", "LeftLeg": "calf_l", "LeftFoot": "foot_l", "LeftToeBase": "ball_l",
    "LeftToe_End": "ball_end_l",
    "RightUpLeg": "thigh_r", "RightLeg": "calf_r", "RightFoot": "foot_r", "RightToeBase": "ball_r",
    "RightToe_End": "ball_end_r",
}


def _box(c0, c1, r):
    """Eight corners and twelve triangles of a box around the segment c0-c1."""
    lo = [min(a, b) - r for a, b in zip(c0, c1)]
    hi = [max(a, b) + r for a, b in zip(c0, c1)]
    v = [(x, y, z) for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])]
    f = [(0, 1, 3), (0, 3, 2), (4, 6, 7), (4, 7, 5), (0, 4, 5), (0, 5, 1),
         (2, 3, 7), (2, 7, 6), (0, 2, 6), (0, 6, 4), (1, 5, 7), (1, 7, 3)]
    return v, f


def build(prefix="", names="mixamo", skinned=True, morphs=()):
    """The figure as a .glb; skinned=False: the same mesh with no skeleton (a model to auto-rig).
    `morphs`: blendshape (morph target) names; each moves the head's box - the first one down
    0.05, every other one along +X by 0.01 x its place - so a weight is easy to read off it."""
    index = {b[0]: i for i, b in enumerate(BONES)}
    heads = {b[0]: b[2] for b in BONES}

    def nm(n):
        if names == "unreal":
            return UNREAL[n]
        if names == "generic":
            return f"bone_{index[n]}"
        return prefix + n

    children = {b[0]: [c[0] for c in BONES if c[1] == b[0]] for b in BONES}
    positions, normals, joints, weights, indices = [], [], [], [], []
    for name, parent, head in BONES:
        kids = children[name]
        if not kids:
            continue                      # an end bone carries no box of its own
        tail = heads[kids[0]]
        v, f = _box(head, tail, 0.035)
        base = len(positions)
        for p in v:
            positions.append(p)
            normals.append((0.0, 1.0, 0.0))
            joints.append((index[name], 0, 0, 0))
            weights.append((1.0, 0.0, 0.0, 0.0))
        indices.extend(base + i for tri in f for i in tri)

    nodes = []
    for i, (name, parent, head) in enumerate(BONES):
        ph = heads[parent] if parent else (0.0, 0.0, 0.0)
        node = {"name": nm(name), "translation": [head[k] - ph[k] for k in range(3)]}
        kids = [index[c] for c in children[name]]
        if kids:
            node["children"] = kids
        nodes.append(node)
    mesh_node = len(nodes)
    nodes.append({"name": "Body", "mesh": 0, "skin": 0})
    arm_node = len(nodes)
    nodes.append({"name": "Armature", "children": [0, mesh_node]})

    # Inverse bind matrices: bones carry no rotation, so each is a translation.
    ibm = []
    for _, _, head in BONES:
        ibm.extend([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -head[0], -head[1], -head[2], 1])

    blobs = []

    def add(data, fmt, count, comp, typ, target=None, minmax=None):
        raw = struct.pack("<" + fmt * (len(data)), *data)
        while len(raw) % 4:
            raw += b"\0"
        offset = sum(len(b) for b in blobs)
        blobs.append(raw)
        view = {"buffer": 0, "byteOffset": offset, "byteLength": len(raw)}
        if target:
            view["target"] = target
        acc = {"bufferView": len(views), "componentType": comp, "count": count, "type": typ}
        if minmax:
            acc["min"], acc["max"] = minmax
        views.append(view)
        accessors.append(acc)
        return len(accessors) - 1

    views, accessors = [], []
    flat = [c for p in positions for c in p]
    mn = [min(p[k] for p in positions) for k in range(3)]
    mx = [max(p[k] for p in positions) for k in range(3)]
    a_pos = add(flat, "f", len(positions), 5126, "VEC3", 34962, (mn, mx))
    a_nrm = add([c for p in normals for c in p], "f", len(normals), 5126, "VEC3", 34962)
    a_jnt = add([c for p in joints for c in p], "H", len(joints), 5123, "VEC4", 34962)
    a_wgt = add([c for p in weights for c in p], "f", len(weights), 5126, "VEC4", 34962)
    a_idx = add(indices, "I", len(indices), 5125, "SCALAR", 34963)
    a_ibm = add(ibm, "f", len(BONES), 5126, "MAT4")
    targets = []
    # The head's box: 8 vertices for every boxed bone before it.
    start = 8 * sum(1 for name, _, _ in BONES[:index["Head"]] if children[name])
    for k, mname in enumerate(morphs):
        d = (0.0, -0.05, 0.0) if k == 0 else (0.01 * k, 0.0, 0.0)
        delta = [(d if start <= i < start + 8 else (0.0, 0.0, 0.0)) for i in range(len(positions))]
        lo = [min(v[c] for v in delta) for c in range(3)]
        hi = [max(v[c] for v in delta) for c in range(3)]
        targets.append({"POSITION": add([c for v in delta for c in v], "f", len(delta), 5126, "VEC3", 34962, (lo, hi))})

    if not skinned:
        nodes = [{"name": "Body", "mesh": 0}]
        arm_node = 0
    gltf = {
        "asset": {"version": "2.0", "generator": "imageviewer rig fixture"},
        "scene": 0,
        "scenes": [{"nodes": [arm_node]}],
        "nodes": nodes,
        "meshes": [{"name": "Body", "primitives": [{
            "attributes": dict({"POSITION": a_pos, "NORMAL": a_nrm},
                               **({"JOINTS_0": a_jnt, "WEIGHTS_0": a_wgt} if skinned else {})),
            "indices": a_idx, **({"targets": targets} if targets else {})}],
            **({"extras": {"targetNames": list(morphs)}, "weights": [0.0] * len(morphs)} if morphs else {})}],
        "skins": [{"joints": list(range(len(BONES))), "inverseBindMatrices": a_ibm, "skeleton": 0}] if skinned else [],
        "buffers": [{"byteLength": sum(len(b) for b in blobs)}],
        "bufferViews": views,
        "accessors": accessors,
    }
    if not skinned:
        del gltf["skins"]
    js = json.dumps(gltf, separators=(",", ":")).encode()
    while len(js) % 4:
        js += b" "
    bin_ = b"".join(blobs)
    total = 12 + 8 + len(js) + 8 + len(bin_)
    return (struct.pack("<III", 0x46546C67, 2, total)
            + struct.pack("<II", len(js), 0x4E4F534A) + js
            + struct.pack("<II", len(bin_), 0x004E4942) + bin_)


if __name__ == "__main__":
    out = sys.argv[1]
    prefix = ""
    names = "mixamo"
    args = sys.argv[2:]
    if "--prefix" in args:
        prefix = args[args.index("--prefix") + 1]
    if "--names" in args:
        names = args[args.index("--names") + 1]
    with open(out, "wb") as fh:
        fh.write(build(prefix, names))

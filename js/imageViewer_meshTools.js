// imageViewer_meshTools.js
// The modeling operations as ONE function of (mesh, selection, numbers), and
// what numbers each one has - pure, so the view can run an operation again and
// again while its size is dragged (a live preview), the "adjust last
// operation" box can run it again from the mesh before it, and the panel and
// the agent commit exactly the same result.
//
// Lengths in `params` are in SCENE units; `toLocal(d)` turns one into the
// mesh's own units (its node may be scaled).
//
// Clean-room: written from how polygon editing behaves, no code of any program.
import * as MD from "./imageViewer_meshData.js";
import * as MO from "./imageViewer_meshOps.js";
import * as MX from "./imageViewer_meshModel.js";

/**
 * The numbers of each operation, in the order the adjust box shows them.
 * kind: len (a scene length), share (0..1), int, bool, axis, side.
 * `opt` is the edit option it is remembered as (imageViewer_view3dMeshEdit.js).
 * `drag`: the number a drag in the view changes.
 */
export const MESH_TOOL_PARAMS = {
    extrude: [{ key: "amount", label: "Distance", kind: "len", opt: "extrude", step: 0.05, drag: true },
              { key: "individual", label: "Each face", kind: "bool", opt: "individual" }],
    inset: [{ key: "amount", label: "Thickness", kind: "len", opt: "inset", step: 0.01, min: 0, drag: true },
            { key: "individual", label: "Each face", kind: "bool", opt: "individual" }],
    bevel: [{ key: "amount", label: "Width", kind: "len", opt: "bevel", step: 0.01, min: 0, drag: true }],
    loopcut: [{ key: "share", label: "Along the ring", kind: "share", opt: "cut", step: 0.05, min: 0.01, max: 0.99, drag: true }],
    weld: [{ key: "amount", label: "Distance", kind: "len", opt: "weld", step: 0.001, min: 0 }],
    subdivide: [{ key: "levels", label: "Times", kind: "int", step: 1, min: 1, max: 3 }],
    mirror: [{ key: "axis", label: "Axis", kind: "axis", opt: "mirrorAxis" },
             { key: "tol", label: "Weld seam", kind: "len", opt: "weld", step: 0.001, min: 0 }],
    symmetrize: [{ key: "axis", label: "Axis", kind: "axis", opt: "mirrorAxis" },
                 { key: "side", label: "Keep side", kind: "side", opt: "mirrorSide" },
                 { key: "tol", label: "Weld seam", kind: "len", opt: "weld", step: 0.001, min: 0 }],
};

/** Operations whose size is set by dragging in the view (the tools of the tool column). */
export const DRAG_TOOLS = ["extrude", "inset", "bevel", "loopcut"];

export const MESH_TOOL_LABELS = {
    extrude: "Extrude", inset: "Inset", bevel: "Bevel", loopcut: "Loop cut", weld: "Merge by distance",
    subdivide: "Subdivide", mirror: "Mirror", symmetrize: "Symmetrize", bridge: "Bridge", fill: "Fill hole",
    connect: "Connect", merge: "Merge vertices", flip: "Flip normals", delete: "Delete",
};

/** Operations that act on the whole mesh, so they need no selection. */
export const WHOLE_MESH = ["fill", "weld", "subdivide", "mirror", "symmetrize"];

/** The numbers an operation starts from: the remembered edit options, then what was given. */
export function toolParams(name, options = {}, given = {}) {
    const out = {};
    for (const p of MESH_TOOL_PARAMS[name] || []) {
        let v = given[p.key] !== undefined ? given[p.key] : (p.opt ? options[p.opt] : undefined);
        if (v === undefined) v = p.kind === "int" ? 1 : p.kind === "bool" ? false : p.kind === "axis" ? "x" : p.kind === "side" ? 1 : 0;
        out[p.key] = cleanParam(p, v);
    }
    if (given.edge !== undefined) out.edge = given.edge;
    return out;
}

/** One number held to what its row allows. */
export function cleanParam(p, v) {
    if (p.kind === "bool") return v === true;
    if (p.kind === "axis") return MX.AXES.includes(v) ? v : "x";
    if (p.kind === "side") return Number(v) === -1 ? -1 : 1;
    let n = Number(v);
    if (!Number.isFinite(n)) n = p.kind === "int" ? 1 : 0;
    if (p.kind === "int") n = Math.round(n);
    if (p.min !== undefined) n = Math.max(p.min, n);
    if (p.max !== undefined) n = Math.min(p.max, n);
    return n;
}

/** The edit options that remember an operation's numbers (so the next one starts there). */
export function optionsFromParams(name, params) {
    const out = {};
    for (const p of MESH_TOOL_PARAMS[name] || []) if (p.opt && params[p.key] !== undefined) out[p.opt] = params[p.key];
    return out;
}

/** A dragged amount rounded to steps (Ctrl held while dragging). */
export function snapAmount(v, step) {
    return step > 0 ? Math.round(v / step) * step : v;
}

/**
 * Run an operation on a working mesh (MD.unpack). `sel` = {mode, ids}.
 * Returns {mesh, ids, mode, note?} or {error, title}. The mesh given is not changed.
 */
export function runMeshOp(work, name, sel, params = {}, toLocal = (d) => d) {
    const mode = sel.mode;
    const ids = sel.ids || [];
    if (!ids.length && !WHOLE_MESH.includes(name) && !(name === "loopcut" && params.edge)) {
        return { title: "Nothing selected", error: "Pick vertices, edges or faces first." };
    }
    const P = toolParams(name, {}, params);
    if (name === "extrude" || name === "inset") {
        const faces = MD.selFaces(work, mode, ids);
        if (!faces.length) return { title: `Nothing to ${name}`, error: "It works on faces: select at least one." };
        const res = name === "extrude"
            ? MD.extrudeFaces(work, faces, toLocal(P.amount), { individual: P.individual })
            : MD.insetFaces(work, faces, toLocal(P.amount), { individual: P.individual });
        return { mesh: res.mesh, ids: res.ids, mode: "face" };
    }
    if (name === "delete") { const r = MD.deleteSel(work, mode, ids); return { mesh: r.mesh, ids: r.ids || [], mode }; }
    if (name === "merge") { const r = MD.mergeVertices(work, mode, ids); return { mesh: r.mesh, ids: r.ids || [], mode: "vertex" }; }
    if (name === "bevel" || name === "loopcut") {
        const edges = MD.convertSel(work, mode, "edge", ids);
        if (name === "loopcut") {
            const key = params.edge || edges[edges.length - 1];
            if (!key) return { title: "No edge", error: "Point at an edge (or select one) to cut across its ring." };
            const r = MO.loopCut(work, key, P.share);
            if (!r.ids.length) return { title: "Nothing to cut", error: "That edge has no ring of four-sided faces across it." };
            return { mesh: r.mesh, ids: r.ids, mode: "edge" };
        }
        if (!edges.length) return { title: "No edges selected", error: "Select an edge (or the faces whose edges to use) first." };
        const r = MO.bevelEdges(work, edges, toLocal(P.amount));
        return { mesh: r.mesh, ids: r.ids, mode: "face" };
    }
    if (name === "bridge" || name === "fill" || name === "connect") {
        const r = name === "bridge" ? MO.bridge(work, mode, ids) : name === "fill" ? MO.fillHoles(work, mode, ids) : MO.connect(work, mode, ids);
        if (r.error) return { title: `Cannot ${name}`, error: r.error };
        if (!r.ids || !r.ids.length) {
            const why = { bridge: "Nothing to join.", fill: "The mesh has no holes there.",
                          connect: "Select two corners of one face, or two edges of one face." }[name];
            return { title: `Nothing to ${name}`, error: why };
        }
        return { mesh: r.mesh, ids: r.ids, mode: name === "connect" ? "edge" : "face" };
    }
    if (name === "weld") {
        const r = MO.mergeByDistance(work, toLocal(P.amount), mode, ids.length ? ids : null);
        if (!r.merged) return { title: "Nothing welded", error: "No vertices lie that close together." };
        return { mesh: r.mesh, ids: r.ids || [], mode: "vertex", note: `${r.merged} vertices merged.` };
    }
    if (name === "subdivide") return { mesh: MX.subdivide(work, P.levels), ids: [], mode };
    if (name === "mirror" || name === "symmetrize") {
        const mesh = MX.mirrorMesh(work, P.axis, { symmetrize: name === "symmetrize", side: P.side, tol: toLocal(P.tol) });
        if (!mesh.f.length) return { title: "Nothing left", error: "No face lies wholly on the side kept." };
        return { mesh, ids: [], mode };
    }
    if (name === "flip") return { mesh: MD.flipFaces(work, MD.selFaces(work, mode, ids)), ids, mode };
    return { title: "Unknown", error: `No operation called ${name}.` };
}

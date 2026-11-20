// imageViewer_previzAgentMesh.js
// The agent's hands on modeling: editable meshes made, converted, edited and
// described. agentY-core's animate_scene sends these through POST
// /imageviewer/rig/agent like the rest of SCENE_AGENT_ACTIONS
// (imageViewer_previzAgentScene.js lists them; rig_routes.AGENT_ACTIONS too).
//
// An edit names its components by description (imageViewer_meshModel.js
// resolveSelection): "all", ids, {side: "+y"}, {along: "y"}, {box: [lo, hi]},
// with `expand: "loop" | "ring"` and `grow`. Each edit is one undo step, the
// same one the Mesh menu takes. Distances are in scene units.

import * as S from "./imageViewer_scene3d.js";
import * as MD from "./imageViewer_meshData.js";
import * as MX from "./imageViewer_meshModel.js";

export const MESH_AGENT_ACTIONS = [
    "mesh_add", "mesh_convert", "mesh_info", "mesh_edit", "mesh_set", "mesh_apply_subdiv", "mesh_boolean",
];

/** mesh_edit's ops: what the Mesh menu does, plus move. */
export const MESH_EDIT_OPS = ["extrude", "inset", "bevel", "loopcut", "bridge", "fill", "connect", "weld", "merge",
                              "flip", "delete", "subdivide", "mirror", "symmetrize", "move"];

/** The edit mode each op works in when the agent does not say. */
const OP_MODE = { extrude: "face", inset: "face", bevel: "edge", loopcut: "edge", bridge: "face", fill: "vertex",
                  connect: "vertex", weld: "vertex", merge: "vertex", flip: "face", delete: "face",
                  subdivide: "face", mirror: "face", symmetrize: "face", move: "vertex" };

export const PrevizAgentMeshMixin = {

    _asaMesh(scene, w) {
        const it = this._asaItem(scene, w, "mesh");
        if (it.kind !== "mesh") throw new Error(`${it.name} is a ${it.kind || "group"}, not an editable mesh (mesh_convert makes it one)`);
        return it;
    },

    _asaMeshInfo(it) {
        return { id: it.id, name: it.name, subdiv: it.subdiv || 0, uv: it.uv || null, smooth: !!it.smooth,
                 ...MX.describeMesh(MD.unpack(it.mesh)) };
    },

    async _asa_mesh_add(scene, a) {
        const shape = ["box", "plane", "sphere", "cylinder", "cone", "torus"].includes(a.shape) ? a.shape : "box";
        const it = await this.previzAddMesh(shape);
        if (!it) throw new Error("could not add a mesh");
        let changed = false;
        if (a.name) { it.name = S.uniqueName(scene, String(a.name)); changed = true; }
        for (const k of ["position", "rotation", "scale"]) {
            if (Array.isArray(a[k]) && a[k].length === 3 && a[k].every((x) => Number.isFinite(Number(x)))) { it[k] = a[k].map(Number); changed = true; }
        }
        if (a.parent) { it.parent = this._asaItem(scene, a.parent, "parent").id; changed = true; }
        if (typeof a.color === "string" && /^#[0-9a-f]{6}$/i.test(a.color)) { it.color = a.color; changed = true; }
        if (changed) await this.previzChanged({ reload: true });
        return this._asaMeshInfo(it);
    },

    async _asa_mesh_convert(scene, a) {
        const ids = this._asaIds(scene, a.items || a.item);
        if (!ids.length) throw new Error("name the shapes or models to convert (items)");
        const ok = await this.previzConvertToMesh(ids);
        if (!ok) throw new Error("nothing could be converted (a model still loading, or not a shape or model)");
        return { meshes: ids.map((id) => S.itemById(this.previzScene(), id)).filter((it) => it && it.kind === "mesh").map((it) => this._asaMeshInfo(it)) };
    },

    _asa_mesh_info(scene, a) {
        const it = this._asaMesh(scene, a.item);
        const out = this._asaMeshInfo(it);
        if (a.select !== undefined) {
            const mode = ["vertex", "edge", "face"].includes(a.mode) ? a.mode : "face";
            out.selected = { mode, ids: MX.resolveSelection(MD.unpack(it.mesh), mode, a.select).slice(0, 200) };
        }
        return out;
    },

    /** One edit on the components a selection describes (see the file's head). */
    async _asa_mesh_edit(scene, a) {
        const it = this._asaMesh(scene, a.item);
        const op = String(a.op || "");
        if (!MESH_EDIT_OPS.includes(op)) throw new Error(`op is one of ${MESH_EDIT_OPS.join(", ")}`);
        const mode = ["vertex", "edge", "face"].includes(a.mode) ? a.mode : OP_MODE[op];
        const work = MD.unpack(it.mesh);
        const ids = MX.resolveSelection(work, mode, a.select);
        const view = this._modelView();
        if (op === "move") return this._asaMeshMove(it, work, mode, ids, a);
        const needs = !["fill", "weld", "subdivide", "mirror", "symmetrize"].includes(op);
        if (needs && !ids.length) throw new Error("the selection finds nothing on this mesh (mesh_info with select shows what it finds)");
        const wasEditing = view.meshEditing();
        view.meshEditBegin(it.id, mode);
        view.meshEditSetSelection(ids, "replace", mode);
        const opts = {};
        const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
        if (num(a.amount) !== undefined) {
            const key = { extrude: "extrude", inset: "inset", bevel: "bevel", weld: "weld", loopcut: "cut" }[op];
            if (key) opts[key] = num(a.amount);
        }
        if (a.individual !== undefined) opts.individual = !!a.individual;
        if (["x", "y", "z"].includes(a.axis)) opts.mirrorAxis = a.axis;
        if (a.side !== undefined) opts.mirrorSide = Number(a.side) < 0 ? -1 : 1;
        let ok;
        try {
            ok = await this.previzMeshOp(op, opts);
        } finally {
            if (!wasEditing && view.meshEditing()) view.meshEditEnd();
        }
        if (!ok) throw new Error(`${op} changed nothing (the notice in the viewer says why)`);
        const after = S.itemById(this.previzScene(), it.id);
        return after ? { op, selected: ids.length, mesh: this._asaMeshInfo(after) } : { op, removed: it.id };
    },

    /** Move components by an offset (scene units), with a soft fall-off radius if given. One undo step. */
    async _asaMeshMove(it, work, mode, ids, a) {
        const off = Array.isArray(a.offset) ? [0, 1, 2].map((k) => Number(a.offset[k]) || 0) : null;
        if (!off) throw new Error("move needs offset [x, y, z]");
        if (!ids.length) throw new Error("the selection finds nothing on this mesh");
        const view = this._modelView();
        // The offset in the mesh's own space: through the inverse of its item's turn and scale.
        const local = this._asaMeshLocalVector(it.id, off);
        const verts = MD.convertSel(work, mode, "vertex", ids);
        const radius = Number(a.soft) > 0 ? view.meshEditLocalLength(Number(a.soft)) : 0;
        const { softWeights } = await import("./imageViewer_meshOps.js");
        const w = radius > 0 ? softWeights(work, verts, radius) : new Map(verts.map((i) => [i, 1]));
        for (const [i, k] of w) for (let c = 0; c < 3; c++) work.v[i][c] += local[c] * k;
        const packed = MD.cleanMesh(MD.pack(work));
        if (!packed) throw new Error("the moved mesh could not be kept");
        this.previzSnapshot(`move ${it.name}'s vertices`);
        it.mesh = packed;
        await this.previzChanged({ reload: true });
        return { op: "move", moved: w.size, mesh: this._asaMeshInfo(it) };
    },

    /** A world-space offset as one in an item's mesh space. */
    _asaMeshLocalVector(id, v) {
        const view = this._modelView();
        const entry = view._entries && view._entries.get(id);
        if (!entry || !view.libs) return v;
        const { THREE } = view.libs;
        const body = view._bodyOf(entry);
        body.updateMatrixWorld(true);
        const inv = body.matrixWorld.clone().invert();
        const o = new THREE.Vector3(0, 0, 0).applyMatrix4(inv);
        const p = new THREE.Vector3(...v).applyMatrix4(inv);
        return [p.x - o.x, p.y - o.y, p.z - o.z];
    },

    _asa_mesh_set(scene, a) {
        const it = this._asaMesh(scene, a.item);
        let any = false;
        if (a.subdiv !== undefined) { this.previzMeshSetSubdiv(a.subdiv, [it.id]); any = true; }
        if (a.uv !== undefined) {
            const patch = typeof a.uv === "string" ? { type: a.uv } : a.uv && typeof a.uv === "object" ? a.uv : { type: "none" };
            this.previzMeshSetUv(patch, [it.id]);
            any = true;
        }
        if (a.smooth !== undefined) { this.previzMeshSetSmooth(!!a.smooth, [it.id]); any = true; }
        if (typeof a.color === "string" && /^#[0-9a-f]{6}$/i.test(a.color)) {
            this.previzSnapshot(`colour ${it.name}`);
            it.color = a.color;
            this.previzChanged({ reload: true });
            any = true;
        }
        if (!any) throw new Error("give subdiv, uv, smooth or color");
        return this._asaMeshInfo(S.itemById(this.previzScene(), it.id));
    },

    async _asa_mesh_apply_subdiv(scene, a) {
        const it = this._asaMesh(scene, a.item);
        if (a.levels !== undefined) this.previzMeshSetSubdiv(a.levels, [it.id]);
        const ok = await this.previzMeshApplySubdiv([it.id]);
        if (!ok) throw new Error("no subdivision level to apply (give levels)");
        return this._asaMeshInfo(S.itemById(this.previzScene(), it.id));
    },

    async _asa_mesh_boolean(scene, a) {
        const op = MX.BOOLEAN_OPS.includes(a.op) ? a.op : null;
        if (!op) throw new Error(`op is one of ${MX.BOOLEAN_OPS.join(", ")}`);
        const ids = this._asaIds(scene, a.items);
        if (ids.length < 2) throw new Error("items: the mesh to keep first, then the others");
        const ok = await this.previzMeshBoolean(op, ids);
        if (!ok) throw new Error(`${op} left nothing; nothing was changed`);
        const keep = S.itemById(this.previzScene(), ids[0]);
        return { op, kept: this._asaMeshInfo(keep), hidden: ids.slice(1) };
    },
};

// Modeling in the 3D space, the panel's side (PrevizModelingMixin, onto the panel).
//
// An editable mesh is a scene item of kind "mesh" (imageViewer_scene3d.js), its
// vertices and faces in `item.mesh` (imageViewer_meshData.js, pure). The view
// draws it and runs the edit mode (imageViewer_view3dMeshEdit.js); every change
// it makes comes back here and is written into the item as ONE undo step
// (a whole-scene snapshot, like every other edit of the shot).

import * as S from "./imageViewer_scene3d.js";
import * as MD from "./imageViewer_meshData.js";
import * as MO from "./imageViewer_meshOps.js";
import { notice } from "./imageViewer_exportUI.js";

const SHAPES = [
    ["box", "Box"], ["plane", "Plane"], ["sphere", "Sphere"], ["cylinder", "Cylinder"],
    ["cone", "Cone"], ["torus", "Torus"],
];

export const PrevizModelingMixin = {

    /** The hooks the view calls (merged into its hooks by mixinModel). */
    _previzModelingHooks() {
        return {
            onMeshEditState: (sel, id) => this._previzMeshState(sel, id),
            onMeshEditDrag: (id, phase, packed) => this._previzMeshDrag(id, phase, packed),
            onMeshOp: (name, opts) => this.previzMeshOp(name, opts),
        };
    },

    _previzMeshItem(id) {
        const scene = this.previzScene();
        return scene && id ? S.itemById(scene, id) : null;
    },

    /** Tab can do something: a mesh is edited, or the selection is a mesh, a shape or a model. */
    previzCanEditMesh() {
        const view = this._model3d;
        if (view && view.meshEditing && view.meshEditing()) return true;
        const item = this._previzMeshItem(this._previzSelection);
        return !!item && (item.kind === "mesh" || item.kind === "primitive");
    },

    // ── Into and out of edit mode ───────────────────────────────────────────

    /** Tab: out of edit mode, or into it on the selected mesh (a shape is converted first). */
    async previzMeshEditToggle() {
        const view = this._modelView();
        if (view.meshEditing()) { view.meshEditEnd(); return true; }
        const item = this._previzMeshItem(this._previzSelection);
        if (!item) return false;
        if (item.kind !== "mesh") {
            const ok = await this.previzConvertToMesh([item.id]);
            if (!ok) return false;
        }
        return view.meshEditBegin(item.id);
    },

    previzMeshMode(mode) {
        const view = this._modelView();
        if (view.meshEditing()) view.meshEditSetMode(mode);
    },

    /**
     * Shapes and models become editable meshes, in place: the same item (id,
     * name, parent, transform, keys), drawn from its own vertices from now on.
     */
    async previzConvertToMesh(ids = null) {
        const scene = this.previzScene();
        if (!scene) return false;
        const list = (ids || this.previzSelectedIds()).map((id) => S.itemById(scene, id))
            .filter((it) => it && (it.kind === "primitive" || it.kind === "model"));
        if (!list.length) {
            notice("info", "Nothing to convert", "Select a shape or a model first.");
            return false;
        }
        const view = this._modelView();
        // A model's meshes are read before the snapshot: a model with nothing to read stays as it is.
        const fromModels = new Map();
        for (const it of list) {
            if (it.kind !== "model") continue;
            const packed = view.meshFromEntry(it.id);
            if (packed) fromModels.set(it.id, packed);
        }
        const doable = list.filter((it) => it.kind === "primitive" || fromModels.has(it.id));
        if (!doable.length) {
            notice("info", "Not converted", "That model has no meshes yet (still loading?), or more than an editable mesh can hold.");
            return false;
        }
        this.previzSnapshot(doable.length > 1 ? `convert ${doable.length} to meshes` : `convert ${doable[0].name} to mesh`);
        for (const it of doable) {
            if (it.kind === "primitive") { S.primitiveToMesh(it); continue; }
            it.kind = "mesh";
            it.mesh = fromModels.get(it.id);
            it.smooth = true;
            it.color = it.color || "#9a9a9a";
            for (const k of ["src", "usd", "atlasOrient", "atlasViews", "atlasPoints", "blendshapes", "rigPoseBase"]) delete it[k];
        }
        if (doable.some((it) => fromModels.has(it.id))) {
            notice("info", "Converted to a mesh", "The model's file is no longer used: its materials and its own animation stay behind.");
        }
        await this.previzChanged({ reload: true });
        return true;
    },

    /** Create ▸ Mesh: a shape that is an editable mesh from the start. */
    async previzAddMesh(type = "box") {
        const scene = this.previzScene();
        if (!scene) return null;
        this.previzSnapshot(`add ${type} mesh`);
        const item = S.makePrimitiveItem(type);
        S.primitiveToMesh(item);
        item.name = S.uniqueName(scene, `${item.name} mesh`);
        scene.items.push(item);
        this._previzSelection = item.id;
        await this.previzChanged({ reload: true });
        return item;
    },

    // ── What the view tells ─────────────────────────────────────────────────

    _previzMeshState(sel, id) {
        this._previzMeshSel = sel;
        // The Channel Box's Edit button says which way it goes.
        const b = this.container && this.container.querySelector(".cb-mesh-edit");
        if (b) b.textContent = id ? "Done editing" : "Edit mesh";
    },

    /** The gizmo moved components: one undo step for the drag, the item's mesh written at its end. */
    _previzMeshDrag(id, phase, packed) {
        const item = this._previzMeshItem(id);
        if (!item) return;
        if (phase === "start") { this.previzBeginDrag(`move ${item.name}'s vertices`); return; }
        if (phase === "end" && packed) {
            item.mesh = packed;
            this.previzEndDrag();
            this.previzChanged({ reload: true });
            return;
        }
        // Nothing moved: no step is kept.
        if (this._previzDragging) {
            const state = this._undoState();
            if (state.past.length) state.past.pop();
            this._previzRefreshUndoButtons();
        }
        this.previzEndDrag();
    },

    // ── Operations on the selected components ──────────────────────────────

    /** extrude / inset / delete / merge / flip on what is selected in edit mode. */
    async previzMeshOp(name, opts = null) {
        const view = this._modelView();
        const id = view.meshEditing();
        const item = this._previzMeshItem(id);
        if (!item || item.kind !== "mesh") return false;
        const o = { ...view.meshEditOptions(), ...(opts || {}) };
        const sel = view.meshEditSelection();
        const work = MD.unpack(item.mesh);
        if (!sel.ids.length && name !== "fill" && name !== "weld") {
            notice("info", "Nothing selected", "Pick vertices, edges or faces first.");
            return false;
        }
        let res = null;
        let mode = sel.mode;
        if (name === "extrude" || name === "inset") {
            const faces = MD.selFaces(work, sel.mode, sel.ids);
            if (!faces.length) { notice("info", `Nothing to ${name}`, "It works on faces: select at least one."); return false; }
            res = name === "extrude"
                ? MD.extrudeFaces(work, faces, view.meshEditLocalLength(o.extrude), { individual: o.individual })
                : MD.insetFaces(work, faces, view.meshEditLocalLength(o.inset), { individual: o.individual });
            mode = "face";
        } else if (name === "delete") {
            res = MD.deleteSel(work, sel.mode, sel.ids);
        } else if (name === "merge") {
            res = MD.mergeVertices(work, sel.mode, sel.ids);
            mode = "vertex";
        } else if (name === "bevel" || name === "loopcut") {
            const edges = MD.convertSel(work, sel.mode, "edge", sel.ids);
            if (!edges.length) { notice("info", "No edges selected", "Select an edge (or the faces whose edges to use) first."); return false; }
            res = name === "bevel"
                ? MO.bevelEdges(work, edges, view.meshEditLocalLength(o.bevel))
                : MO.loopCut(work, edges[edges.length - 1], o.cut);
            mode = name === "bevel" ? "face" : "edge";
        } else if (name === "bridge" || name === "fill" || name === "connect") {
            res = name === "bridge" ? MO.bridge(work, sel.mode, sel.ids)
                : name === "fill" ? MO.fillHoles(work, sel.mode, sel.ids)
                : MO.connect(work, sel.mode, sel.ids);
            if (res.error) { notice("info", `Cannot ${name}`, res.error); return false; }
            if (!res.ids || !res.ids.length) {
                const why = { bridge: "Nothing to join.", fill: "The mesh has no holes there.",
                              connect: "Select two corners of one face, or two edges of one face." }[name];
                notice("info", `Nothing to ${name}`, why);
                return false;
            }
            mode = name === "connect" ? "edge" : "face";
        } else if (name === "weld") {
            res = MO.mergeByDistance(work, view.meshEditLocalLength(o.weld), sel.mode, sel.ids);
            if (!res.merged) { notice("info", "Nothing welded", "No vertices lie that close together."); return false; }
            notice("info", "Welded", `${res.merged} vertices merged.`);
            mode = "vertex";
        } else if (name === "flip") {
            const faces = MD.selFaces(work, sel.mode, sel.ids);
            res = { mesh: MD.flipFaces(work, faces), ids: sel.ids };
        } else {
            return false;
        }
        const packed = MD.cleanMesh(MD.pack(res.mesh));
        if (!packed && name !== "delete") return false;
        this.previzSnapshot(`${name} (${item.name})`);
        if (!packed) {
            // Everything went: the item goes with it.
            scene3dRemove(this.previzScene(), item.id);
            view.meshEditEnd();
            this._previzSelection = null;
            await this.previzChanged({ reload: true });
            return true;
        }
        item.mesh = packed;
        await this.previzChanged({ reload: true });
        if (view.meshEditing() === item.id) view.meshEditSetSelection(res.ids || [], "replace", mode);
        return true;
    },

    /** all / none / invert / grow, in edit mode. */
    previzMeshSelect(how) {
        const view = this._modelView();
        const item = this._previzMeshItem(view.meshEditing());
        if (!item) return;
        const sel = view.meshEditSelection();
        const work = MD.unpack(item.mesh);
        const ids = how === "all" ? MD.allOf(work, sel.mode)
            : how === "invert" ? MD.invertSel(work, sel.mode, sel.ids)
            : how === "grow" ? MD.growSel(work, sel.mode, sel.ids)
            : how === "loop" || how === "ring" ? MO.selectLoops(work, MD.convertSel(work, sel.mode, "edge", sel.ids), how === "ring")
            : [];
        view.meshEditSetSelection(ids, "replace", how === "loop" || how === "ring" ? "edge" : sel.mode);
    },

    /** Soft selection on / off. */
    previzMeshToggleSoft() {
        const view = this._modelView();
        if (!view || !view.setMeshEditOptions) return;
        const on = !view.meshEditOptions().soft;
        view.setMeshEditOptions({ soft: on });
        notice("info", on ? "Soft selection on" : "Soft selection off", on ? "Moves now carry what lies near the selection along." : "");
    },

    /** Smooth or flat shading on the selected meshes. */
    previzMeshSetSmooth(on, ids = null) {
        const scene = this.previzScene();
        if (!scene) return;
        const list = (ids || this.previzSelectedIds()).map((id) => S.itemById(scene, id)).filter((it) => it && it.kind === "mesh");
        if (!list.length) return;
        this.previzSnapshot(on ? "smooth shading" : "flat shading");
        for (const it of list) it.smooth = !!on;
        this.previzChanged({ reload: true });
    },

    // ── The Mesh menu ───────────────────────────────────────────────────────

    _previzMeshMenuEntries() {
        const view = this._model3d;
        const editing = !!(view && view.meshEditing && view.meshEditing());
        const item = this._previzMeshItem(this._previzSelection);
        const kind = item && item.kind;
        const mode = editing ? view.meshEditMode() : null;
        const o = view && view.meshEditOptions ? view.meshEditOptions() : {};
        const why = editing ? "" : "Edit a mesh first (Tab)";
        const op = (label, name, cmd) => ({ label, cmd, disabled: !editing, title: why, run: () => this.previzMeshOp(name) });
        const tick = (on, label) => (on ? "✓ " : "") + label;
        return [
            { label: "Convert to editable mesh", disabled: kind !== "primitive" && kind !== "model",
              title: "Select a shape or a model", run: () => this.previzConvertToMesh() },
            { label: tick(editing, "Edit mesh"), cmd: "View3DMeshEdit", disabled: !editing && !this.previzCanEditMesh(),
              title: "Select a mesh or a shape", run: () => this.previzMeshEditToggle() },
            { label: "Create mesh", sub: () => SHAPES.map(([type, label]) => ({ label, run: () => this.previzAddMesh(type) })) },
            "-",
            { label: tick(mode === "vertex", "Vertices"), cmd: "MeshVertexMode", disabled: !editing, title: why, run: () => this.previzMeshMode("vertex") },
            { label: tick(mode === "edge", "Edges"), cmd: "MeshEdgeMode", disabled: !editing, title: why, run: () => this.previzMeshMode("edge") },
            { label: tick(mode === "face", "Faces"), cmd: "MeshFaceMode", disabled: !editing, title: why, run: () => this.previzMeshMode("face") },
            { label: "Select all", cmd: "MeshSelectAll", disabled: !editing, title: why, run: () => this.previzMeshSelect("all") },
            { label: "Invert selection", cmd: "MeshInvert", disabled: !editing, title: why, run: () => this.previzMeshSelect("invert") },
            { label: "Grow selection", cmd: "MeshGrow", disabled: !editing, title: why, run: () => this.previzMeshSelect("grow") },
            { label: "Select loop", cmd: "MeshSelectLoop", disabled: !editing, title: why || "Or double-click an edge", run: () => this.previzMeshSelect("loop") },
            { label: "Select ring", cmd: "MeshSelectRing", disabled: !editing, title: why || "Or Ctrl+double-click an edge", run: () => this.previzMeshSelect("ring") },
            "-",
            op("Extrude", "extrude", "MeshExtrude"),
            op("Inset", "inset", "MeshInset"),
            op("Bevel", "bevel", "MeshBevel"),
            op("Loop cut", "loopcut", "MeshLoopCut"),
            op("Bridge", "bridge", "MeshBridge"),
            op("Fill holes", "fill", "MeshFill"),
            op("Connect", "connect", "MeshConnect"),
            op("Merge vertices", "merge"),
            op("Merge by distance", "weld", "MeshWeld"),
            op("Flip normals", "flip"),
            op("Delete", "delete", "MeshDelete"),
            "-",
            { label: tick(o.individual, "Each face on its own"), disabled: !view,
              run: () => view.setMeshEditOptions({ individual: !o.individual }) },
            { label: tick(o.soft, "Soft selection"), cmd: "MeshSoft", disabled: !view,
              run: () => this.previzMeshToggleSoft() },
            { label: tick(o.xray, "X-ray selection"), disabled: !view,
              run: () => view.setMeshEditOptions({ xray: !o.xray }) },
            { label: tick(kind === "mesh" && item.smooth, "Smooth shading"), disabled: kind !== "mesh",
              title: "Select a mesh", run: () => this.previzMeshSetSmooth(!(item && item.smooth)) },
        ];
    },

    // ── Channel Box rows of a mesh ──────────────────────────────────────────

    _cbMeshRows(t, item, doc) {
        const st = MD.meshStats(item.mesh);
        const info = doc.createElement("div");
        info.className = "cb-row cb-mesh-info";
        info.append(
            Object.assign(doc.createElement("span"), { className: "cb-label", textContent: "Mesh" }),
            Object.assign(doc.createElement("span"), { className: "cb-val",
                textContent: `${st.verts} vertices · ${st.edges} edges · ${st.faces} faces` }),
        );
        t.append(info);
        const row = doc.createElement("div");
        row.className = "cb-row";
        const tag = Object.assign(doc.createElement("span"), { className: "cb-label", textContent: "Shading" });
        const sel = doc.createElement("select");
        sel.className = "cb-val cb-sel cb-mesh-smooth";
        for (const [v, label] of [["flat", "flat"], ["smooth", "smooth"]]) {
            sel.append(Object.assign(doc.createElement("option"), { value: v, textContent: label }));
        }
        sel.value = item.smooth ? "smooth" : "flat";
        sel.onchange = () => this.previzMeshSetSmooth(sel.value === "smooth");
        row.append(tag, sel);
        t.append(row);
        const edit = doc.createElement("button");
        edit.type = "button";
        edit.className = "previz-btn cb-mesh-edit";
        const view = this._model3d;
        edit.textContent = view && view.meshEditing && view.meshEditing() === item.id ? "Done editing" : "Edit mesh";
        edit.title = "Edit its vertices, edges and faces (Tab)";
        edit.onclick = () => this.previzMeshEditToggle();
        t.append(edit);
    },
};

function scene3dRemove(scene, id) {
    if (!scene) return;
    scene.items = scene.items.filter((it) => it.id !== id);
    for (const it of scene.items) if (it.parent === id) it.parent = null;
}

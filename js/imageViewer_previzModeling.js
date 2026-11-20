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
import * as MX from "./imageViewer_meshModel.js";
import * as MT from "./imageViewer_meshTools.js";
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
            onMeshOp: (name) => this.previzMeshTool(name),
            onMeshToolCommit: (name, params) => this._previzMeshToolCommit(name, params),
            onMeshAdjust: (params) => this._previzMeshAdjust(params),
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

    /**
     * Run an operation on what is selected in edit mode, at once: one undo
     * step. `opts` are its numbers (imageViewer_meshTools.js MESH_TOOL_PARAMS,
     * e.g. {amount}) or the older edit-option names ({extrude, inset, bevel,
     * cut, weld, mirrorAxis, mirrorSide, individual}); missing ones come from
     * the remembered edit options. The "adjust last operation" box is offered
     * afterwards (`adjust: false` leaves it).
     */
    async previzMeshOp(name, opts = null, { adjust = true } = {}) {
        const view = this._modelView();
        const id = view.meshEditing();
        const item = this._previzMeshItem(id);
        if (!item || item.kind !== "mesh") return false;
        const o = { ...view.meshEditOptions(), ...(opts || {}) };
        const params = MT.toolParams(name, o, opts || {});
        const sel = view.meshEditSelection();
        const base = item.mesh;
        const res = MT.runMeshOp(MD.unpack(base), name, sel, params, (d) => view.meshEditLocalLength(d));
        if (res.error) { notice("info", res.title, res.error); return false; }
        if (res.note) notice("info", MT.MESH_TOOL_LABELS[name] || name, res.note);
        const ok = await this._previzMeshWrite(item, name, res, { snapshot: true });
        if (!ok) return true;
        // The numbers are remembered, so the next one starts from them.
        view.setMeshEditOptions(MT.optionsFromParams(name, params));
        if (adjust && MT.MESH_TOOL_PARAMS[name] && view.meshAdjustOffer) {
            this._previzMeshLast = { id: item.id, name, base, sel, params, packed: item.mesh };
            view.meshAdjustOffer(name, params, item.mesh);
        }
        return true;
    },

    /** Write an operation's result into the item (one undo step unless `snapshot` is false). False = the item went. */
    async _previzMeshWrite(item, name, res, { snapshot = true } = {}) {
        const view = this._modelView();
        const packed = MD.cleanMesh(MD.pack(res.mesh));
        if (snapshot) this.previzSnapshot(`${name} (${item.name})`);
        if (!packed) {
            // Everything went: the item goes with it.
            scene3dRemove(this.previzScene(), item.id);
            view.meshEditEnd();
            this._previzSelection = null;
            await this.previzChanged({ reload: true });
            return false;
        }
        item.mesh = packed;
        await this.previzChanged({ reload: true });
        if (view.meshEditing() === item.id) view.meshEditSetSelection(res.ids || [], "replace", res.mode);
        return true;
    },

    /**
     * Ctrl+E, I, Ctrl+B, Ctrl+R, the menu and the bar: the operation follows
     * the mouse in the view until a click (Enter) keeps it or Esc (a right
     * click) drops it. Operations with nothing to drag run at once.
     */
    previzMeshTool(name) {
        const view = this._modelView();
        if (view && view.meshToolModal && MT.DRAG_TOOLS.includes(name) && view.meshToolModal(name)) return true;
        return this.previzMeshOp(name);
    },

    /** The view's live drag ended: commit it with the numbers it showed. */
    _previzMeshToolCommit(name, params) {
        return this.previzMeshOp(name, params);
    },

    /**
     * The adjust box changed a number: the last operation again from the mesh
     * before it, in place of its result - no new undo step.
     */
    async _previzMeshAdjust(params) {
        const last = this._previzMeshLast;
        const view = this._modelView();
        const item = last && this._previzMeshItem(last.id);
        if (!item || item.mesh !== last.packed || view.meshEditing() !== item.id) {
            if (view.meshAdjustHide) view.meshAdjustHide();
            return false;
        }
        const p = MT.toolParams(last.name, {}, { ...last.params, ...params });
        const res = MT.runMeshOp(MD.unpack(last.base), last.name, last.sel, p, (d) => view.meshEditLocalLength(d));
        if (res.error) { notice("info", res.title, res.error); return false; }
        const ok = await this._previzMeshWrite(item, last.name, res, { snapshot: false });
        if (!ok) { this._previzMeshLast = null; return true; }
        last.params = p;
        last.packed = item.mesh;
        view.setMeshEditOptions(MT.optionsFromParams(last.name, p));
        view.meshAdjustOffer(last.name, p, item.mesh);
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

    // ── Whole meshes: subdivision, UVs, booleans ────────────────────────────

    _previzMeshItems(ids = null) {
        const scene = this.previzScene();
        if (!scene) return [];
        return (ids || this.previzSelectedIds()).map((id) => S.itemById(scene, id)).filter((it) => it && it.kind === "mesh");
    },

    /** The level the selected meshes are drawn subdivided at (the cage is kept and edited). */
    previzMeshSetSubdiv(level, ids = null) {
        const list = this._previzMeshItems(ids);
        if (!list.length) return false;
        const n = MX.cleanSubdiv(level);
        this.previzSnapshot(`subdivision ${n}`);
        for (const it of list) { if (n) it.subdiv = n; else delete it.subdiv; }
        this.previzChanged({ reload: true });
        return true;
    },

    /** Make the drawn subdivision the mesh itself: the cage is replaced, the level goes back to 0. */
    async previzMeshApplySubdiv(ids = null) {
        const list = this._previzMeshItems(ids).filter((it) => MX.cleanSubdiv(it.subdiv));
        if (!list.length) { notice("info", "Nothing to apply", "Set a subdivision level on a mesh first."); return false; }
        const made = list.map((it) => MD.cleanMesh(MD.pack(MX.subdivide(MD.unpack(it.mesh), MX.cleanSubdiv(it.subdiv)))));
        if (made.some((m) => !m)) { notice("info", "Too big", "The subdivided mesh would have more vertices than a mesh may hold."); return false; }
        this.previzSnapshot("apply subdivision");
        list.forEach((it, k) => { it.mesh = made[k]; it.smooth = true; delete it.subdiv; });
        await this.previzChanged({ reload: true });
        return true;
    },

    /** A UV projection on the selected meshes ({type, axis, scale, checker}, merged); type "none" takes it off. */
    previzMeshSetUv(patch, ids = null) {
        const list = this._previzMeshItems(ids);
        if (!list.length) return false;
        this.previzSnapshot("UVs");
        for (const it of list) {
            const next = MX.cleanUv({ ...(it.uv || { type: "box" }), ...(patch || {}) });
            if (next) it.uv = next; else delete it.uv;
        }
        this.previzChanged({ reload: true });
        return true;
    },

    /**
     * Union, subtract or intersect: the first selected mesh keeps the result,
     * the others are hidden (their own meshes are left as they were). Shapes
     * are converted first. One undo step.
     */
    async previzMeshBoolean(op = "union", ids = null) {
        const scene = this.previzScene();
        const view = this._modelView();
        if (!scene || !view) return false;
        if (!MX.BOOLEAN_OPS.includes(op)) return false;
        let list = (ids || this.previzSelectedIds()).map((id) => S.itemById(scene, id)).filter(Boolean);
        list = list.filter((it) => it.kind === "mesh" || it.kind === "primitive");
        if (list.length < 2) {
            notice("info", "Select two meshes", "Select the mesh to keep, then the one(s) to " + (op === "subtract" ? "take from it" : op === "intersect" ? "intersect it with" : "join to it") + ".");
            return false;
        }
        if (view.meshEditing()) view.meshEditEnd();
        this.previzSnapshot(`${op} ${list[0].name}`);
        let converted = false;
        for (const it of list) if (it.kind === "primitive") { S.primitiveToMesh(it); converted = true; }
        if (converted) await this.previzChanged({ reload: true, snapshot: false });
        const [a, ...rest] = list;
        let mesh = MD.unpack(a.mesh);
        for (const b of rest) {
            const m = view.meshMatrixBetween(b.id, a.id);
            if (!m) continue;
            mesh = MX.booleanMesh(mesh, MX.transformMesh(MD.unpack(b.mesh), m), op);
        }
        mesh = MX.dissolveCoplanar(mesh);
        const packed = MD.cleanMesh(MD.pack(mesh));
        if (!packed) {
            notice("info", `Nothing left`, `The ${op} leaves no faces; nothing was changed.`);
            const state = this._undoState();
            if (state.past.length) this.previzUndo();
            return false;
        }
        a.mesh = packed;
        a.smooth = false;
        for (const b of rest) b.visible = false;
        this._previzSelection = a.id;
        this._previzAlso = new Set();
        await this.previzChanged({ reload: true });
        notice("info", op[0].toUpperCase() + op.slice(1), `${rest.map((b) => b.name).join(", ")} ${rest.length > 1 ? "are" : "is"} hidden now.`);
        return true;
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
        const op = (label, name, cmd) => ({ label, cmd, disabled: !editing, title: why, run: () => this.previzMeshTool(name) });
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
            op("Fill hole", "fill", "MeshFill"),
            op("Connect", "connect", "MeshConnect"),
            op("Merge vertices", "merge"),
            op("Merge by distance", "weld", "MeshWeld"),
            op("Flip normals", "flip"),
            op("Delete", "delete", "MeshDelete"),
            "-",
            op("Subdivide", "subdivide"),
            op("Mirror", "mirror", "MeshMirror"),
            op("Symmetrize", "symmetrize"),
            { label: "Mirror axis", disabled: !view, sub: () => MX.AXES.map((a) => ({ label: tick(o.mirrorAxis === a, a.toUpperCase()),
                run: () => view.setMeshEditOptions({ mirrorAxis: a }) })) },
            "-",
            { label: "Subdivision level", disabled: kind !== "mesh", title: "Select a mesh",
              sub: () => [0, 1, 2, 3].map((n) => ({ label: tick(((item && item.subdiv) || 0) === n, n ? `${n}` : "Off"), run: () => this.previzMeshSetSubdiv(n) })) },
            { label: "Apply subdivision", disabled: !(kind === "mesh" && item.subdiv), title: "Set a level first",
              run: () => this.previzMeshApplySubdiv() },
            { label: "UVs", disabled: kind !== "mesh", title: "Select a mesh", sub: () => [
                ...MX.UV_TYPES.map((t) => ({ label: tick(((item && item.uv && item.uv.type) || "none") === t, t === "none" ? "None" : t[0].toUpperCase() + t.slice(1)),
                    run: () => this.previzMeshSetUv({ type: t }) })),
                "-",
                { label: tick(!!(item && item.uv && item.uv.checker), "Show checker"), disabled: !(item && item.uv),
                  run: () => this.previzMeshSetUv({ checker: !(item.uv && item.uv.checker) }) },
            ] },
            { label: "Boolean", sub: () => MX.BOOLEAN_OPS.map((b) => ({ label: b[0].toUpperCase() + b.slice(1),
                title: "The first selected keeps the result", run: () => this.previzMeshBoolean(b) })) },
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
        const pick = (label, cls, options, value, change) => {
            const r = doc.createElement("div");
            r.className = "cb-row";
            const s2 = doc.createElement("select");
            s2.className = `cb-val cb-sel ${cls}`;
            for (const [v, l] of options) s2.append(Object.assign(doc.createElement("option"), { value: v, textContent: l }));
            s2.value = value;
            s2.onchange = () => change(s2.value);
            r.append(Object.assign(doc.createElement("span"), { className: "cb-label", textContent: label }), s2);
            t.append(r);
        };
        pick("Subdivision", "cb-mesh-subdiv", [["0", "off"], ["1", "1"], ["2", "2"], ["3", "3"]], String(item.subdiv || 0),
             (v) => this.previzMeshSetSubdiv(Number(v)));
        pick("UVs", "cb-mesh-uv", MX.UV_TYPES.map((u) => [u, u]), (item.uv && item.uv.type) || "none",
             (v) => this.previzMeshSetUv({ type: v }));
        if (item.uv) {
            pick("UV axis", "cb-mesh-uvaxis", MX.AXES.map((a) => [a, a.toUpperCase()]), item.uv.axis, (v) => this.previzMeshSetUv({ axis: v }));
            pick("Checker", "cb-mesh-checker", [["off", "off"], ["on", "on"]], item.uv.checker ? "on" : "off",
                 (v) => this.previzMeshSetUv({ checker: v === "on" }));
        }
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

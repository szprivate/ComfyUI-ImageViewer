// imageViewer_view3dMeshEdit.js
// Editable polygon meshes in the 3D view: drawing one, and its edit mode.
//
// A mesh item (`kind: "mesh"`, imageViewer_scene3d.js makeMeshItem) keeps its
// vertices and faces itself, packed (imageViewer_meshData.js). It is drawn
// like a shape: one three.js Mesh under the item's inner node, rebuilt when
// the item's `mesh` is a new object (every edit makes one) or its shading
// changes.
//
// Edit mode works on ONE mesh: its vertices, edges or faces are picked with a
// click or a box (Maya's modifiers: plain replaces, Shift toggles, Ctrl takes
// out, Ctrl+Shift adds), and the gizmo - W / E / R, local or world - moves,
// turns or scales them about their middle. A drag goes to the panel once, as
// one undo step, when it ends (hooks.onMeshEditDrag); the operations
// (extrude, inset, delete ...) are the panel's, which writes the new mesh and
// hands the selection back (meshEditSetSelection).
//
// What edit mode draws (points, edge lines, the selected faces) is an overlay
// at the scene's top, its matrix copied from the mesh's node each frame - so
// it is never picked, framed, snapped to, exported or rendered.
//
// Clean-room: written from how polygon editing behaves, no code of any program.
import * as MD from "./imageViewer_meshData.js";

const STORE = "imageviewer.viewer.meshEdit";
const PICK_PX = 14;             // a vertex within this many pixels of a click is taken
const EDGE_PX = 10;
const COLORS = {
    vert: [0.06, 0.06, 0.07], vertSel: [1.0, 0.54, 0.12],
    edge: [0.10, 0.10, 0.11], edgeSel: [1.0, 0.62, 0.2],
    face: 0xff8a1f,
};

/** The edit options kept per viewer. */
export function cleanMeshEditOptions(raw) {
    const o = raw && typeof raw === "object" ? raw : {};
    const num = (v, d, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
    return {
        extrude: num(o.extrude, 0.25, -1000, 1000),
        inset: num(o.inset, 0.1, 0, 1000),
        individual: o.individual === true,
        xray: o.xray === true,
    };
}

/** Which ids a box or click leaves selected, by the view's modifiers. */
export function combineSel(before, picked, how) {
    const out = new Set(how === "replace" ? [] : before);
    for (const id of picked) {
        if (how === "remove") out.delete(id);
        else if (how === "toggle") { if (out.has(id)) out.delete(id); else out.add(id); }
        else out.add(id);
    }
    return [...out];
}

/** The distance in pixels from p to the segment a-b (all [x, y]). */
export function segmentDistance(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export const View3DMeshEditMixin = {

    // ── Drawing a mesh item ─────────────────────────────────────────────────

    _buildMesh(entry, item) {
        const { THREE } = this.libs;
        const work = MD.unpack(item.mesh);
        const geometry = this._meshGeometry(work, !!item.smooth);
        const material = new THREE.MeshStandardMaterial({
            color: new THREE.Color(item.color || "#9a9a9a"), roughness: 0.85, metalness: 0,
            // An open mesh (a plane, a box with a face taken out) is looked into from behind as often as not.
            side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = "editmesh";
        const group = new THREE.Group();
        group.add(mesh);
        this._bodyOf(entry).add(group);
        entry.object = group;
        entry.editMesh = mesh;
        entry.material = material;
        entry.color = item.color;
        entry.meshRef = item.mesh;
        entry.smooth = !!item.smooth;
        entry.key = "mesh";
        entry.stats = this._statsOf(group, "mesh");
        this._keepOriginal(mesh, material);
        if (this._me && this._me.id === item.id) this._meAfterBuild(entry);
        return entry;
    },

    /** True when the item's mesh or shading is not what is drawn any more. */
    _meshStale(entry, item) {
        return entry.meshRef !== item.mesh || entry.smooth !== !!item.smooth;
    },

    _meshGeometry(work, smooth) {
        const { THREE } = this.libs;
        const t = MD.meshTriangles(work, smooth);
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(t.position, 3));
        g.setAttribute("normal", new THREE.BufferAttribute(t.normal, 3));
        g.computeBoundingBox();
        g.computeBoundingSphere();
        g.userData.triFace = t.triFace;
        return g;
    },

    /**
     * An editable mesh of what an item draws now (a model's meshes, a shape),
     * in the item's own inner space, welded: packed, or null when it has none.
     */
    meshFromEntry(id) {
        const entry = this._entries.get(id);
        if (!entry || !entry.object || !this.libs) return null;
        const { THREE } = this.libs;
        const host = this._bodyOf(entry);
        host.updateMatrixWorld(true);
        const inv = host.matrixWorld.clone().invert();
        const all = [];
        let count = 0;
        entry.object.traverse((o) => {
            if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
            if (o.userData && (o.userData.imageViewerSplatBounds || o.userData.imageViewerLightGlyph)) return;
            if (o.name === "splatbounds") return;
            const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
            const pos = g.attributes.position;
            const m = inv.clone().multiply(o.matrixWorld);
            const p = new THREE.Vector3();
            for (let i = 0; i < pos.count; i++) {
                p.fromBufferAttribute(pos, i).applyMatrix4(m);
                all.push(p.x, p.y, p.z);
            }
            count += pos.count;
            if (g !== o.geometry) g.dispose();
        });
        if (!count || count > MD.MAX_VERTS * 3) return null;
        return MD.cleanMesh(MD.meshFromTriangles(all));
    },

    // ── Edit mode ────────────────────────────────────────────────────────────

    meshEditOptions() {
        if (!this._meOpts) {
            let raw = null;
            try { raw = JSON.parse(this.win.localStorage.getItem(STORE) || "null"); } catch (_) { /* storage off */ }
            this._meOpts = cleanMeshEditOptions(raw);
        }
        return { ...this._meOpts };
    },

    setMeshEditOptions(patch) {
        this._meOpts = cleanMeshEditOptions({ ...this.meshEditOptions(), ...(patch || {}) });
        try { this.win.localStorage.setItem(STORE, JSON.stringify(this._meOpts)); } catch (_) { /* storage off */ }
        this._meBarSync();
        return this.meshEditOptions();
    },

    /** The mesh item being edited, or null. */
    meshEditing() { return this._me ? this._me.id : null; },
    meshEditMode() { return this._me ? this._me.mode : null; },
    meshEditSelection() { return this._me ? { mode: this._me.mode, ids: [...this._me.sel] } : null; },

    /** Into edit mode on a mesh item; false when it is not one. */
    meshEditBegin(id, mode = null) {
        const entry = this._entries.get(id);
        if (!entry || !entry.item || entry.item.kind !== "mesh" || !this.libs) return false;
        if (this._me && this._me.id !== id) this.meshEditEnd();
        if (this._msOn && this.setMeasure) this.setMeasure(false);
        const { THREE } = this.libs;
        if (!this._me) {
            const group = new THREE.Group();
            group.name = "meshEdit";
            group.matrixAutoUpdate = false;
            group.userData.imageViewerNoShadow = true;
            this.scene.add(group);
            const handle = new THREE.Object3D();
            handle.name = "meshEditHandle";
            this.scene.add(handle);
            this._me = { id, mode: MD.MESH_MODES.includes(mode) ? mode : "vertex", sel: new Set(),
                         group, handle, work: null, drag: null, offsetMats: new Set() };
            this._meGroup = group;
        } else if (MD.MESH_MODES.includes(mode)) {
            this._me.mode = mode;
        }
        this.selected = id;
        this.root.classList.add("mesh-editing");
        this._meBarBuild();
        this._meAfterBuild(entry);
        this._syncSelection();
        this._meTell();
        this.requestRender();
        return true;
    },

    meshEditEnd() {
        const me = this._me;
        if (!me) return;
        if (me.drag) this._meDragEnd(false);
        for (const m of me.offsetMats) { m.polygonOffset = false; m.needsUpdate = true; }
        this._meClearOverlay();
        if (me.group.parent) me.group.parent.remove(me.group);
        if (me.handle.parent) me.handle.parent.remove(me.handle);
        if (this.gizmo && this.gizmo.object === me.handle) this.gizmo.detach();
        this._me = null;
        this._meGroup = null;
        this.root.classList.remove("mesh-editing");
        if (this._meBar) { this._meBar.remove(); this._meBar = null; }
        this._syncSelection();
        this._meTell();
        this.requestRender();
    },

    /** Vertex, edge or face: the selection is carried over (convertSel). */
    meshEditSetMode(mode) {
        const me = this._me;
        if (!me || !MD.MESH_MODES.includes(mode) || mode === me.mode) return;
        const work = me.work || { v: [], f: [] };
        me.sel = new Set(MD.convertSel(work, me.mode, mode, [...me.sel]));
        me.mode = mode;
        this._meRedrawOverlay();
        this._syncSelection();
        this._meTell();
    },

    /** Set the selection (after an operation, or from the panel): `how` replace / toggle / remove / add. */
    meshEditSetSelection(ids, how = "replace", mode = null) {
        const me = this._me;
        if (!me) return;
        if (mode && MD.MESH_MODES.includes(mode)) me.mode = mode;
        me.sel = new Set(combineSel(me.sel, ids || [], how));
        if (me.work) me.sel = new Set(MD.pruneSel(me.work, me.mode, [...me.sel]));
        this._meRedrawOverlay();
        this._syncSelection();
        this._meTell();
    },

    /** A world distance as one in the edited mesh's own units (its node may be scaled). */
    meshEditLocalLength(d) {
        const host = this._meHost();
        if (!host || !this.libs) return d;
        const s = new this.libs.THREE.Vector3();
        host.updateMatrixWorld(true);
        host.matrixWorld.decompose(new this.libs.THREE.Vector3(), new this.libs.THREE.Quaternion(), s);
        const k = (Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.z)) / 3;
        return k > 1e-9 ? d / k : d;
    },

    _meTell() {
        if (this.hooks.onMeshEditState) this.hooks.onMeshEditState(this.meshEditSelection(), this.meshEditing());
        this._meBarSync();
    },

    _meEntry() { return this._me ? this._entries.get(this._me.id) : null; },
    _meHost() {
        const entry = this._meEntry();
        return entry && entry.editMesh ? entry.editMesh.parent : null;
    },

    /** The mesh item was drawn again (an edit, an undo): read it, keep what is still selected, draw the overlay. */
    _meAfterBuild(entry) {
        const me = this._me;
        if (!me || !entry || !entry.item) return;
        me.work = MD.unpack(entry.item.mesh);
        me.sel = new Set(MD.pruneSel(me.work, me.mode, [...me.sel]));
        this._meRedrawOverlay();
        if (this.gizmo) this._syncSelection();
    },

    /** After the scene was set: the edited item may be gone, or no longer a mesh. */
    _meAfterScene() {
        const entry = this._meEntry();
        if (!entry || !entry.item || entry.item.kind !== "mesh") this.meshEditEnd();
    },

    _meClearOverlay() {
        const me = this._me;
        if (!me) return;
        for (const c of [...me.group.children]) {
            me.group.remove(c);
            if (c.geometry) c.geometry.dispose();
            if (c.material) c.material.dispose();
        }
        me.pts = me.lines = me.faces = null;
    },

    /** Points, edge lines and the selected faces, from the working mesh. */
    _meRedrawOverlay() {
        const me = this._me;
        if (!me || !this.libs) return;
        const { THREE } = this.libs;
        this._meClearOverlay();
        const work = me.work;
        if (!work) return;
        me.edges = MD.meshEdges(work);
        const pos = new Float32Array(work.v.length * 3);
        work.v.forEach((p, i) => { pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2]; });
        const vsel = me.mode === "vertex" ? me.sel : new Set();
        const vcol = new Float32Array(work.v.length * 3);
        for (let i = 0; i < work.v.length; i++) vcol.set(vsel.has(i) ? COLORS.vertSel : COLORS.vert, i * 3);
        const pg = new THREE.BufferGeometry();
        pg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        pg.setAttribute("color", new THREE.BufferAttribute(vcol, 3));
        me.pts = new THREE.Points(pg, new THREE.PointsMaterial({
            size: me.mode === "vertex" ? 7 : 3, sizeAttenuation: false, vertexColors: true,
            toneMapped: false, fog: false, depthTest: true }));
        me.pts.renderOrder = 3;
        me.group.add(me.pts);

        const esel = me.mode === "edge" ? me.sel : new Set();
        const fsel = me.mode === "face" ? me.sel : null;
        // In face mode a face's edges light up with it.
        const faceEdges = new Set();
        if (fsel) for (const fi of fsel) {
            const face = work.f[fi];
            if (face) for (let k = 0; k < face.length; k++) faceEdges.add(MD.edgeKey(face[k], face[(k + 1) % face.length]));
        }
        const lp = new Float32Array(me.edges.length * 6), lc = new Float32Array(me.edges.length * 6);
        me.edges.forEach(([a, b], k) => {
            lp.set(work.v[a], k * 6); lp.set(work.v[b], k * 6 + 3);
            const key = MD.edgeKey(a, b);
            const c = esel.has(key) || faceEdges.has(key) ? COLORS.edgeSel : COLORS.edge;
            lc.set(c, k * 6); lc.set(c, k * 6 + 3);
        });
        const lg = new THREE.BufferGeometry();
        lg.setAttribute("position", new THREE.BufferAttribute(lp, 3));
        lg.setAttribute("color", new THREE.BufferAttribute(lc, 3));
        me.lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, toneMapped: false, fog: false }));
        me.lines.renderOrder = 2;
        me.group.add(me.lines);

        if (fsel && fsel.size) {
            const tri = [];
            for (const fi of fsel) {
                const face = work.f[fi];
                if (!face) continue;
                for (const t of MD.triangulateFace(work, face)) for (const i of t) tri.push(...work.v[i]);
            }
            const fg = new THREE.BufferGeometry();
            fg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(tri), 3));
            me.faces = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({
                color: COLORS.face, transparent: true, opacity: 0.35, side: THREE.DoubleSide,
                depthWrite: false, toneMapped: false, fog: false,
                polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
            me.faces.renderOrder = 1;
            me.group.add(me.faces);
        }
        this._meTick();
        this.requestRender();
    },

    /** Every frame while editing: the overlay follows the mesh, the mesh draws a little behind its lines. */
    _meTick() {
        const me = this._me;
        if (!me) return;
        const host = this._meHost();
        if (!host) return;
        host.updateMatrixWorld(true);
        me.group.matrix.copy(host.matrixWorld);
        me.group.matrixWorldNeedsUpdate = true;
        me.group.visible = this._shownUp ? this._shownUp(host) : true;
        const entry = this._meEntry();
        const mat = entry && entry.editMesh && entry.editMesh.material;
        if (mat && !mat.polygonOffset) {
            mat.polygonOffset = true; mat.polygonOffsetFactor = 1; mat.polygonOffsetUnits = 1;
            mat.needsUpdate = true;
            me.offsetMats.add(mat);
        }
    },

    // ── Picking components ──────────────────────────────────────────────────

    /** Screen points (canvas pixels) of every vertex, and which face the camera sees the front of. */
    _meScreen() {
        const me = this._me;
        const host = this._meHost();
        if (!me || !me.work || !host || !this.libs) return null;
        const { THREE } = this.libs;
        const cam = this.activeCameraObject();
        cam.updateMatrixWorld();
        host.updateMatrixWorld(true);
        const W = this.canvas.clientWidth || this.canvas.getBoundingClientRect().width;
        const H = this.canvas.clientHeight || this.canvas.getBoundingClientRect().height;
        const v = new THREE.Vector3();
        const scr = me.work.v.map((p) => {
            v.set(p[0], p[1], p[2]).applyMatrix4(host.matrixWorld).project(cam);
            return v.z < -1 || v.z > 1 ? null : [(v.x + 1) / 2 * W, (1 - v.y) / 2 * H];
        });
        const camPos = cam.getWorldPosition(new THREE.Vector3());
        const camDir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
        const nm = new THREE.Matrix3().getNormalMatrix(host.matrixWorld);
        const front = me.work.f.map((face) => {
            const n = new THREE.Vector3(...MD.faceNormalRaw(me.work, face)).applyMatrix3(nm);
            const c = new THREE.Vector3(...MD.faceCentroid(me.work, face)).applyMatrix4(host.matrixWorld);
            const toCam = cam.isOrthographicCamera ? camDir.clone().negate() : camPos.clone().sub(c);
            return n.dot(toCam) > 0;
        });
        const vFront = new Array(me.work.v.length).fill(false);
        me.work.f.forEach((face, fi) => { if (front[fi]) for (const i of face) vFront[i] = true; });
        // A vertex no face uses is always there to pick.
        const used = new Array(me.work.v.length).fill(false);
        for (const face of me.work.f) for (const i of face) used[i] = true;
        used.forEach((u, i) => { if (!u) vFront[i] = true; });
        return { scr, front, vFront };
    },

    /** The face under the pointer (a ray against the drawn triangles), or -1. */
    _meFaceUnder(x, y) {
        const entry = this._meEntry();
        if (!entry || !entry.editMesh || !this.libs) return -1;
        const { THREE } = this.libs;
        const W = this.canvas.clientWidth || this.canvas.getBoundingClientRect().width;
        const H = this.canvas.clientHeight || this.canvas.getBoundingClientRect().height;
        const ray = new THREE.Raycaster();
        ray.setFromCamera(new THREE.Vector2(x / W * 2 - 1, -(y / H) * 2 + 1), this.activeCameraObject());
        // The Display menu sorts meshes onto layers of their own; the ray must see that one.
        ray.layers.enableAll();
        const hit = ray.intersectObject(entry.editMesh, false)[0];
        const tf = entry.editMesh.geometry.userData.triFace;
        return hit && tf ? tf[hit.faceIndex] : -1;
    },

    /** What a click at canvas pixel (x, y) picks: an id of the current mode, or null. */
    meshEditPickAt(x, y) {
        const me = this._me;
        if (!me || !me.work) return null;
        const s = this._meScreen();
        if (!s) return null;
        const xray = this.meshEditOptions().xray;
        const fi = this._meFaceUnder(x, y);
        const p = [x, y];
        if (me.mode === "face") {
            if (fi >= 0) return fi;
            return null;
        }
        if (me.mode === "vertex") {
            let best = null, bd = Infinity;
            const onFace = new Set(fi >= 0 ? me.work.f[fi] : []);
            s.scr.forEach((q, i) => {
                if (!q || !(xray || s.vFront[i] || onFace.has(i))) return;
                const d = Math.hypot(q[0] - x, q[1] - y);
                if ((d <= PICK_PX || onFace.has(i)) && d < bd) { bd = d; best = i; }
            });
            return best;
        }
        let best = null, bd = Infinity;
        const faceKeys = new Set();
        if (fi >= 0) {
            const face = me.work.f[fi];
            for (let k = 0; k < face.length; k++) faceKeys.add(MD.edgeKey(face[k], face[(k + 1) % face.length]));
        }
        for (const [a, b] of me.edges || []) {
            const qa = s.scr[a], qb = s.scr[b];
            if (!qa || !qb) continue;
            const key = MD.edgeKey(a, b);
            if (!(xray || (s.vFront[a] && s.vFront[b]) || faceKeys.has(key))) continue;
            const d = segmentDistance(p, qa, qb);
            if ((d <= EDGE_PX || faceKeys.has(key)) && d < bd) { bd = d; best = key; }
        }
        return best;
    },

    /** The ids of the current mode inside a box (canvas pixels; a lasso when `poly`). */
    meshEditIdsInBox(r, poly = null) {
        const me = this._me;
        if (!me || !me.work) return [];
        const s = this._meScreen();
        if (!s) return [];
        const xray = this.meshEditOptions().xray;
        const inPoly = (x, y) => {
            if (!poly) return true;
            let inside = false;
            for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
                const [xi, yi] = poly[i], [xj, yj] = poly[j];
                if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
            }
            return inside;
        };
        const inside = (q) => q && q[0] >= r.x0 && q[0] <= r.x1 && q[1] >= r.y0 && q[1] <= r.y1 && inPoly(q[0], q[1]);
        if (me.mode === "vertex") {
            return s.scr.map((q, i) => (inside(q) && (xray || s.vFront[i]) ? i : -1)).filter((i) => i >= 0);
        }
        if (me.mode === "edge") {
            const out = [];
            for (const [a, b] of me.edges || []) {
                const qa = s.scr[a], qb = s.scr[b];
                if (!qa || !qb || !(xray || (s.vFront[a] && s.vFront[b]))) continue;
                if (inside([(qa[0] + qb[0]) / 2, (qa[1] + qb[1]) / 2])) out.push(MD.edgeKey(a, b));
            }
            return out;
        }
        const out = [];
        me.work.f.forEach((face, fi) => {
            if (!(xray || s.front[fi])) return;
            const pts = face.map((i) => s.scr[i]);
            if (pts.some((q) => !q)) return;
            const c = [pts.reduce((t, q) => t + q[0], 0) / pts.length, pts.reduce((t, q) => t + q[1], 0) / pts.length];
            if (inside(c)) out.push(fi);
        });
        return out;
    },

    /** The canvas press in edit mode: a click picks, a drag boxes. True = taken. */
    _meDown(e) {
        const me = this._me;
        if (!me || e.button !== 0 || e.altKey || this._walk) return false;
        // The gizmo's handles have the press while one is under the pointer.
        if (this.gizmo && this.gizmo.object === me.handle && this.gizmo.axis) return false;
        const rect = this.canvas.getBoundingClientRect();
        const how = e.ctrlKey || e.metaKey ? (e.shiftKey ? "add" : "remove") : e.shiftKey ? "toggle" : "replace";
        const st = { x: e.clientX, y: e.clientY, rect, how, box: null,
                     lasso: this.selectShape && this.selectShape() === "lasso" ? [[e.clientX, e.clientY]] : null };
        const win = this.win;
        const move = (ev) => {
            if (!st.box) {
                if (Math.abs(ev.clientX - st.x) <= 3 && Math.abs(ev.clientY - st.y) <= 3) return;
                st.box = this.doc.createElement("div");
                st.box.className = "model-marquee";
                this.root.append(st.box);
            }
            if (st.lasso) st.lasso.push([ev.clientX, ev.clientY]);
            const host = this.root.getBoundingClientRect();
            const x0 = Math.min(st.x, ev.clientX), x1 = Math.max(st.x, ev.clientX);
            const y0 = Math.min(st.y, ev.clientY), y1 = Math.max(st.y, ev.clientY);
            Object.assign(st.box.style, { left: `${x0 - host.left}px`, top: `${y0 - host.top}px`,
                                          width: `${x1 - x0}px`, height: `${y1 - y0}px` });
        };
        const up = (ev) => {
            win.removeEventListener("pointermove", move, true);
            win.removeEventListener("pointerup", up, true);
            if (!this._me) return;
            if (st.box) {
                st.box.remove();
                const r = {
                    x0: Math.min(st.x, ev.clientX) - rect.left, x1: Math.max(st.x, ev.clientX) - rect.left,
                    y0: Math.min(st.y, ev.clientY) - rect.top, y1: Math.max(st.y, ev.clientY) - rect.top,
                };
                const poly = st.lasso && st.lasso.length > 2 ? st.lasso.map(([x, y]) => [x - rect.left, y - rect.top]) : null;
                this.meshEditSetSelection(this.meshEditIdsInBox(r, poly), st.how);
            } else {
                const id = this.meshEditPickAt(ev.clientX - rect.left, ev.clientY - rect.top);
                this.meshEditSetSelection(id === null ? [] : [id], id === null && st.how !== "replace" ? "add" : st.how);
            }
        };
        win.addEventListener("pointermove", move, true);
        win.addEventListener("pointerup", up, true);
        return true;
    },

    // ── The gizmo on the selected components ────────────────────────────────

    /** Called by _syncSelection; true = edit mode decided where the gizmo goes. */
    _meSyncGizmo() {
        const me = this._me;
        if (!me) return false;
        // Picking another item (the Outliner) ends editing this one.
        if (this.selected !== me.id) { this.meshEditEnd(); return false; }
        this._ensureGizmo();
        if (!this.gizmo) return true;
        this.gizmo.camera = this.activeCameraObject();
        const host = this._meHost();
        const c = me.work && me.sel.size ? MD.selCentroid(me.work, me.mode, [...me.sel]) : null;
        if (!host || !c || this.gizmoMode === "select") {
            if (this.gizmo.object) this.gizmo.detach();
            return true;
        }
        if (me.drag) return true;
        const { THREE } = this.libs;
        host.updateMatrixWorld(true);
        const at = new THREE.Vector3(...c).applyMatrix4(host.matrixWorld);
        me.handle.position.copy(at);
        if ((this.gizmoSpace || "local") === "local") host.getWorldQuaternion(me.handle.quaternion);
        else me.handle.quaternion.identity();
        me.handle.scale.set(1, 1, 1);
        me.handle.updateMatrixWorld(true);
        this.gizmo.setMode(this.gizmoMode);
        if (this.gizmo.object !== me.handle) this.gizmo.attach(me.handle);
        return true;
    },

    /** The gizmo's dragging-changed while it holds the components; true = handled. */
    _meGizmoDragging(on) {
        const me = this._me;
        if (!me || !this.gizmo || this.gizmo.object !== me.handle) return false;
        if (on) this._meDragStart();
        else this._meDragEnd(true);
        return true;
    },

    _meDragStart() {
        const me = this._me;
        const host = this._meHost();
        if (!me || !host || !me.work) return;
        const { THREE } = this.libs;
        host.updateMatrixWorld(true);
        me.handle.updateMatrixWorld(true);
        const verts = [...MD.selVertices(me.work, me.mode, [...me.sel])];
        me.drag = {
            from: me.handle.matrixWorld.clone().invert(),
            hostInv: host.matrixWorld.clone().invert(),
            base: verts.map((i) => [i, new THREE.Vector3(...me.work.v[i]).applyMatrix4(host.matrixWorld)]),
            moved: false,
        };
        if (this.hooks.onMeshEditDrag) this.hooks.onMeshEditDrag(me.id, "start");
    },

    /** objectChange while the gizmo holds the components; true = handled. */
    _meGizmoMove() {
        const me = this._me;
        if (!me || !this.gizmo || this.gizmo.object !== me.handle) return false;
        const d = me.drag;
        if (!d) return true;
        me.handle.updateMatrixWorld(true);
        const M = me.handle.matrixWorld.clone().multiply(d.from);
        const p = new this.libs.THREE.Vector3();
        for (const [i, w] of d.base) {
            p.copy(w).applyMatrix4(M).applyMatrix4(d.hostInv);
            me.work.v[i] = [p.x, p.y, p.z];
        }
        d.moved = true;
        this._meLiveRedraw();
        return true;
    },

    _meDragEnd(commit) {
        const me = this._me;
        const d = me && me.drag;
        if (!d) return;
        me.drag = null;
        if (commit && d.moved && this.hooks.onMeshEditDrag) {
            this.hooks.onMeshEditDrag(me.id, "end", MD.pack(me.work));
        } else if (this.hooks.onMeshEditDrag) {
            this.hooks.onMeshEditDrag(me.id, "cancel");
        }
        this._syncSelection();
    },

    /** The drawn mesh and the overlay take the working mesh as it is, mid-drag. */
    _meLiveRedraw() {
        const me = this._me;
        const entry = this._meEntry();
        if (!me || !entry || !entry.editMesh) return;
        const t = MD.meshTriangles(me.work, !!entry.item.smooth);
        const g = entry.editMesh.geometry;
        g.attributes.position.array.set(t.position);
        g.attributes.position.needsUpdate = true;
        g.attributes.normal.array.set(t.normal);
        g.attributes.normal.needsUpdate = true;
        g.computeBoundingSphere();
        g.computeBoundingBox();
        if (me.pts) {
            const a = me.pts.geometry.attributes.position;
            me.work.v.forEach((v, i) => a.array.set(v, i * 3));
            a.needsUpdate = true;
        }
        if (me.lines) {
            const a = me.lines.geometry.attributes.position;
            (me.edges || []).forEach(([x, y], k) => { a.array.set(me.work.v[x], k * 6); a.array.set(me.work.v[y], k * 6 + 3); });
            a.needsUpdate = true;
        }
        if (me.faces) {
            const tri = [];
            for (const fi of me.sel) {
                const face = me.work.f[fi];
                if (!face) continue;
                for (const tr of MD.triangulateFace(me.work, face)) for (const i of tr) tri.push(...me.work.v[i]);
            }
            const a = me.faces.geometry.attributes.position;
            if (a.array.length === tri.length) { a.array.set(tri); a.needsUpdate = true; }
        }
        this.requestRender();
    },

    // ── The bar over the view while editing ─────────────────────────────────

    _meBarBuild() {
        if (this._meBar || !this.stage) return;
        const doc = this.doc;
        const bar = doc.createElement("div");
        bar.className = "model-mesh-bar";
        const btn = (label, title, run, data) => {
            const b = doc.createElement("button");
            b.type = "button";
            b.className = "model-mesh-btn";
            b.textContent = label;
            b.title = title;
            if (data) b.dataset.mode = data;
            b.addEventListener("click", (e) => { e.stopPropagation(); run(); });
            bar.append(b);
            return b;
        };
        const num = (key, title, step) => {
            const i = doc.createElement("input");
            i.type = "number";
            i.step = String(step);
            i.className = "model-mesh-num";
            i.dataset.opt = key;
            i.title = title;
            i.addEventListener("change", () => this.setMeshEditOptions({ [key]: Number(i.value) }));
            i.addEventListener("keydown", (e) => e.stopPropagation());
            bar.append(i);
            return i;
        };
        const sep = () => bar.append(Object.assign(doc.createElement("span"), { className: "model-mesh-sep" }));
        bar.append(Object.assign(doc.createElement("span"), { className: "model-mesh-title", textContent: "Edit mesh" }));
        btn("Vertex", "Vertices (1)", () => this.meshEditSetMode("vertex"), "vertex");
        btn("Edge", "Edges (2)", () => this.meshEditSetMode("edge"), "edge");
        btn("Face", "Faces (3)", () => this.meshEditSetMode("face"), "face");
        sep();
        btn("Extrude", "Extrude the selected faces by the distance beside it (Ctrl+E)", () => this._meOp("extrude"));
        num("extrude", "How far Extrude lifts the faces (scene units)", 0.05);
        btn("Inset", "Inset the selected faces by the distance beside it (I)", () => this._meOp("inset"));
        num("inset", "How far Inset draws the border in (scene units)", 0.01);
        const ind = doc.createElement("label");
        ind.className = "model-mesh-check";
        ind.title = "Extrude and inset each face on its own, not touching faces as one region";
        const cb = Object.assign(doc.createElement("input"), { type: "checkbox" });
        cb.dataset.opt = "individual";
        cb.addEventListener("change", () => this.setMeshEditOptions({ individual: cb.checked }));
        ind.append(cb, doc.createTextNode(" Each face"));
        bar.append(ind);
        sep();
        btn("Merge", "Weld the selected vertices into one at their middle", () => this._meOp("merge"));
        btn("Flip", "Turn the selected faces round (flip their normals)", () => this._meOp("flip"));
        btn("Delete", "Delete the selection (Del)", () => this._meOp("delete"));
        sep();
        const xr = doc.createElement("label");
        xr.className = "model-mesh-check";
        xr.title = "Pick through the mesh: what is behind is selected too";
        const xcb = Object.assign(doc.createElement("input"), { type: "checkbox" });
        xcb.dataset.opt = "xray";
        xcb.addEventListener("change", () => this.setMeshEditOptions({ xray: xcb.checked }));
        xr.append(xcb, doc.createTextNode(" X-ray"));
        bar.append(xr);
        btn("Done", "Leave edit mode (Tab)", () => this.meshEditEnd());
        for (const ev of ["pointerdown", "wheel", "dblclick"]) bar.addEventListener(ev, (e) => e.stopPropagation());
        this.stage.append(bar);
        this._meBar = bar;
        this._meBarSync();
    },

    _meBarSync() {
        const bar = this._meBar;
        if (!bar) return;
        const o = this.meshEditOptions();
        const me = this._me;
        for (const b of bar.querySelectorAll("[data-mode]")) b.classList.toggle("on", !!me && me.mode === b.dataset.mode);
        for (const i of bar.querySelectorAll("input[data-opt]")) {
            const k = i.dataset.opt;
            if (i.type === "checkbox") i.checked = !!o[k];
            else if (this.doc.activeElement !== i) i.value = String(o[k]);
        }
        const n = me ? me.sel.size : 0;
        bar.dataset.count = String(n);
    },

    _meOp(name) {
        if (this.hooks.onMeshOp) this.hooks.onMeshOp(name, this.meshEditOptions());
    },
};

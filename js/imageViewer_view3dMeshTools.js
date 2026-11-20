// imageViewer_view3dMeshTools.js
// The modeling tools you drag (View3DMeshToolsMixin, onto Model3DView): the
// tool column's Extrude, Inset, Bevel and Loop cut while a mesh is edited, an
// on-screen handle for each, the live preview while a size is dragged, and
// the "adjust last operation" box at the view's bottom left.
//
// A tool picked in the column: a drag in the view sizes the operation (from 0),
// a click still picks. Ctrl+E / I / Ctrl+B / Ctrl+R, the menu and the bar run
// the operation MODAL: it follows the mouse from the size used last, a click or
// Enter keeps it, Esc or a right click drops it. Ctrl while dragging takes
// steps. Nothing is written while it is previewed: the result is drawn from
// the pure operation (imageViewer_meshTools.js) run on the mesh as it was, and
// the panel commits the same numbers as ONE undo step (hooks.onMeshToolCommit).
// The adjust box then runs it again from the mesh before it, in place of its
// result, with no new undo step (hooks.onMeshAdjust).
//
// Clean-room: written from how polygon editing behaves, no code of any program.
import * as MD from "./imageViewer_meshData.js";
import * as MT from "./imageViewer_meshTools.js";

const SVGNS = "http://www.w3.org/2000/svg";
const DRAG_PX = 3;              // a press moved further than this is a drag
const HANDLE_PX = 70;           // the extrude arrow's length on screen
const EDGE_HOVER_PX = 30;       // Loop cut takes the edge nearest the pointer within this
const STEPS = { len: 0.1, share: 0.05 };

const TOOLS = [
    ["extrude", "Extrude", "Extrude: drag in the view to pull the selected faces out (Ctrl+E)", "icon-mesh-extrude"],
    ["inset", "Inset", "Inset: drag in the view to draw a border into the selected faces (I)", "icon-mesh-inset"],
    ["bevel", "Bevel", "Bevel: drag in the view to chamfer the selected edges (Ctrl+B)", "icon-mesh-bevel"],
    ["loopcut", "Loop cut", "Loop cut: point at an edge to see the cut, click to make it, drag to slide it (Ctrl+R)", "icon-mesh-loopcut"],
];

export const View3DMeshToolsMixin = {

    // ── The tool column while editing ───────────────────────────────────────

    _mtToolsBuild() {
        if (this._mtCol || !this.ui || !this.ui.tools) return;
        const doc = this.doc;
        const col = doc.createElement("div");
        col.className = "model-mesh-tools";
        col.append(Object.assign(doc.createElement("div"), { className: "model-toolcol-sep" }));
        this._mtBtns = {};
        for (const [name, label, title, icon] of TOOLS) {
            const b = doc.createElement("button");
            b.type = "button";
            b.className = "model-btn model-icon-btn model-mesh-tool";
            b.textContent = label;
            b.title = title;
            b.dataset.tool = `mesh-${name}`;
            b.addEventListener("click", (e) => { e.stopPropagation(); this.meshToolSet(this.meshTool() === name ? null : name); });
            if (this.hooks.setIcon) this.hooks.setIcon(b, icon);
            this._mtBtns[name] = b;
            col.append(b);
        }
        const soft = doc.createElement("button");
        soft.type = "button";
        soft.className = "model-btn model-icon-btn model-mesh-tool";
        soft.textContent = "Soft";
        soft.dataset.tool = "mesh-soft";
        soft.title = "Soft selection: a move carries what lies near the selection along (B)";
        soft.addEventListener("click", (e) => { e.stopPropagation(); this.setMeshEditOptions({ soft: !this.meshEditOptions().soft }); });
        if (this.hooks.setIcon) this.hooks.setIcon(soft, "icon-mesh-soft");
        this._mtBtns.soft = soft;
        col.append(soft);
        // After the gizmo tools and Measure, before Local / World.
        const after = this.ui.measureBtn;
        if (after && after.parentNode === this.ui.tools) after.after(col); else this.ui.tools.append(col);
        this._mtCol = col;
        if (!this._mtHoverWired && this.stage) {
            this._mtHoverWired = true;
            this.stage.addEventListener("pointermove", (e) => this._mtHover(e), true);
            this.stage.addEventListener("pointerleave", () => { this._mtXY = null; this._mtCutPreview(null); });
        }
        this._mtToolsSync();
    },

    _mtToolsRemove() {
        this._mtSessionEnd(false);
        this.meshAdjustHide();
        if (this._mtCol) { this._mtCol.remove(); this._mtCol = null; this._mtBtns = null; }
        if (this._mtSvg) { this._mtSvg.remove(); this._mtSvg = null; }
        if (this._mtHud) { this._mtHud.remove(); this._mtHud = null; }
        this._mtCutKey = null;
    },

    _mtToolsSync() {
        if (!this._mtBtns) return;
        const t = this.meshTool();
        for (const [name] of TOOLS) this._mtBtns[name].classList.toggle("active", t === name);
        this._mtBtns.soft.classList.toggle("active", !!this.meshEditOptions().soft);
    },

    /** The drag tool picked in the column (null: the gizmo tools). */
    meshTool() { return this._me ? this._me.tool || null : null; },

    meshToolSet(name) {
        const me = this._me;
        if (!me) return;
        me.tool = MT.DRAG_TOOLS.includes(name) ? name : null;
        if (me.tool && this._msOn && this.setMeasure) this.setMeasure(false);
        this._mtCutPreview(null);
        this._syncSelection();
        this._syncToolbar();
        this.requestRender();
    },

    // ── The handle on screen, every frame ───────────────────────────────────

    _mtSvgEl() {
        if (!this._mtSvg && this.stage) {
            const svg = this.doc.createElementNS(SVGNS, "svg");
            svg.setAttribute("class", "model-mesh-handle");
            this.stage.append(svg);
            this._mtSvg = svg;
        }
        return this._mtSvg;
    },

    /** Canvas pixels -> the stage's own pixels (the SVG lies over the whole stage). */
    _mtStageOffset() {
        const c = this.canvas.getBoundingClientRect(), s = this.stage.getBoundingClientRect();
        return [c.left - s.left, c.top - s.top];
    },

    /** Where the selection's middle and the faces' way out lie, in the world and on screen. */
    _mtFrame(mesh, sel) {
        const host = this._meHost();
        if (!host || !this.libs || !mesh || !sel.ids.length) return null;
        const { THREE } = this.libs;
        host.updateMatrixWorld(true);
        const c = MD.selCentroid(mesh, sel.mode, sel.ids);
        if (!c) return null;
        const C = new THREE.Vector3(...c).applyMatrix4(host.matrixWorld);
        const n = [0, 0, 0];
        for (const fi of MD.selFaces(mesh, sel.mode, sel.ids)) {
            const fn = MD.faceNormal(mesh, mesh.f[fi]);
            n[0] += fn[0]; n[1] += fn[1]; n[2] += fn[2];
        }
        const N = new THREE.Vector3(...n).applyMatrix3(new THREE.Matrix3().getNormalMatrix(host.matrixWorld));
        if (N.lengthSq() < 1e-12) N.set(0, 1, 0);
        N.normalize();
        const cam = this.activeCameraObject();
        cam.updateMatrixWorld();
        const cs = this._mtProject(C);
        // Pixels per scene unit at the selection's depth.
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
        const cr = this._mtProject(C.clone().add(right));
        const ppu = cs && cr ? Math.max(1e-6, Math.hypot(cr[0] - cs[0], cr[1] - cs[1])) : 100;
        return { C, N, cs, ppu };
    },

    /** A world point on the canvas (canvas pixels), or null behind the camera. */
    _mtProject(p) {
        const W = this.canvas.clientWidth || this.canvas.getBoundingClientRect().width;
        const H = this.canvas.clientHeight || this.canvas.getBoundingClientRect().height;
        const v = p.clone().project(this.activeCameraObject());
        return v.z < -1 || v.z > 1 ? null : [(v.x + 1) / 2 * W, (1 - v.y) / 2 * H];
    },

    /** Called from _meTick: the picked tool's handle over the selection. */
    _mtTick() {
        const me = this._me;
        const svg = this._mtSvgEl();
        if (!svg) return;
        const tool = this._mt ? this._mt.name : me && me.tool;
        let html = "";
        if (me && tool && tool !== "loopcut" && me.work && me.sel.size) {
            const f = this._mtFrame(me.work, { mode: me.mode, ids: [...me.sel] });
            if (f && f.cs) {
                const [ox, oy] = this._mtStageOffset();
                const x = f.cs[0] + ox, y = f.cs[1] + oy;
                if (tool === "extrude") {
                    const tip = this._mtProject(f.C.clone().addScaledVector(f.N, HANDLE_PX / f.ppu));
                    if (tip) {
                        const tx = tip[0] + ox, ty = tip[1] + oy;
                        html = `<line class="mh-line" x1="${x}" y1="${y}" x2="${tx}" y2="${ty}"/>`
                             + `<circle class="mh-dot" cx="${x}" cy="${y}" r="3"/>`
                             + `<circle class="mh-grip" cx="${tx}" cy="${ty}" r="7"/>`
                             + `<path class="mh-plus" d="M${tx - 4} ${ty}h8M${tx} ${ty - 4}v8"/>`;
                    }
                } else {
                    html = `<circle class="mh-ring" cx="${x}" cy="${y}" r="38"/><circle class="mh-dot" cx="${x}" cy="${y}" r="3"/>`;
                }
            }
        }
        if (this._mtCutLines) html += this._mtCutLines;
        if (svg._html !== html) { svg.innerHTML = html; svg._html = html; }
    },

    // ── Loop cut: the edge under the pointer and its preview ────────────────

    /** The edge of `mesh` nearest canvas pixel (x, y), within EDGE_HOVER_PX, or null. */
    _mtEdgeAt(mesh, x, y) {
        const host = this._meHost();
        if (!host || !mesh || !this.libs) return null;
        const { THREE } = this.libs;
        host.updateMatrixWorld(true);
        const v = new THREE.Vector3();
        const scr = mesh.v.map((p) => this._mtProject(v.set(p[0], p[1], p[2]).applyMatrix4(host.matrixWorld)));
        let best = null, bd = EDGE_HOVER_PX;
        for (const [a, b] of MD.meshEdges(mesh)) {
            const qa = scr[a], qb = scr[b];
            if (!qa || !qb) continue;
            const dx = qb[0] - qa[0], dy = qb[1] - qa[1];
            const l2 = dx * dx + dy * dy;
            const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - qa[0]) * dx + (y - qa[1]) * dy) / l2)) : 0;
            const d = Math.hypot(x - qa[0] - t * dx, y - qa[1] - t * dy);
            if (d < bd) {
                bd = d;
                // The share runs from the key's first end, as MO.loopCut's ring does.
                const key = MD.edgeKey(a, b);
                const share = MD.edgeEnds(key)[0] === a ? t : 1 - t;
                best = { key, share };
            }
        }
        return best;
    },

    /** The new edges a cut would make, drawn as lines over the view (null clears). */
    _mtCutPreview(cut) {
        const me = this._me;
        let lines = "";
        const key = cut ? `${cut.key}@${cut.share.toFixed(3)}` : null;
        if (cut && me && me.work) {
            const res = MT.runMeshOp(me.work, "loopcut", { mode: me.mode, ids: [] }, { share: cut.share, edge: cut.key });
            const host = this._meHost();
            if (!res.error && host) {
                const [ox, oy] = this._mtStageOffset();
                const { THREE } = this.libs;
                host.updateMatrixWorld(true);
                for (const id of res.ids) {
                    const [a, b] = MD.edgeEnds(id);
                    const pa = this._mtProject(new THREE.Vector3(...res.mesh.v[a]).applyMatrix4(host.matrixWorld));
                    const pb = this._mtProject(new THREE.Vector3(...res.mesh.v[b]).applyMatrix4(host.matrixWorld));
                    if (pa && pb) lines += `<line class="mh-cut" x1="${pa[0] + ox}" y1="${pa[1] + oy}" x2="${pb[0] + ox}" y2="${pb[1] + oy}"/>`;
                }
            }
        }
        this._mtCutKey = key;
        this._mtCutLines = lines;
        this._mtTick();
    },

    _mtHover(e) {
        this._mtXY = { x: e.clientX, y: e.clientY };
        const me = this._me;
        if (!me || this._mt || me.tool !== "loopcut" || e.buttons) return;
        const r = this.canvas.getBoundingClientRect();
        this._mtCutPreview(this._mtEdgeAt(me.work, e.clientX - r.left, e.clientY - r.top));
    },

    // ── A live session: the operation previewed while its size moves ───────

    /** Ctrl+E and the rest: the operation follows the mouse until a click keeps it. False = not started. */
    meshToolModal(name) {
        const me = this._me;
        if (!me || !me.work || !MT.DRAG_TOOLS.includes(name)) return false;
        if (this._mt) this._mtSessionEnd(false);
        const sel = { mode: me.mode, ids: [...me.sel] };
        if (name !== "loopcut") {
            // Nothing it can work on: the panel says why.
            if (MT.runMeshOp(me.work, name, sel, { amount: 0 }).error) return false;
        }
        const params = MT.toolParams(name, this.meshEditOptions());
        const xy = this._mtXY ? { ...this._mtXY } : null;
        this._mtSessionStart(name, { modal: true, params, ref: xy, start: params[this._mtKey(name)] });
        if (name === "loopcut") {
            // The edge under the pointer, else the selected one.
            const r = this.canvas.getBoundingClientRect();
            const hit = xy ? this._mtEdgeAt(this._mt.base, xy.x - r.left, xy.y - r.top) : null;
            const edges = MD.convertSel(this._mt.base, sel.mode, "edge", sel.ids);
            if (hit) { this._mt.params.edge = hit.key; this._mt.params.share = hit.share; }
            else if (edges.length) this._mt.params.edge = edges[edges.length - 1];
        }
        this._mtPreview();
        const win = this.win;
        const onMove = (ev) => this._mtMove(ev.clientX, ev.clientY, ev.ctrlKey || ev.metaKey);
        const onDown = (ev) => {
            ev.stopImmediatePropagation();
            ev.preventDefault();
            if (ev.button === 0) this.meshToolFinish(true); else this.meshToolFinish(false);
        };
        const onMenu = (ev) => { ev.preventDefault(); ev.stopImmediatePropagation(); };
        const onKey = (ev) => { if (this.meshToolKey(ev)) { ev.stopImmediatePropagation(); ev.preventDefault(); } };
        win.addEventListener("pointermove", onMove, true);
        win.addEventListener("pointerdown", onDown, true);
        win.addEventListener("contextmenu", onMenu, true);
        win.addEventListener("keydown", onKey, true);
        this._mt.off = () => {
            win.removeEventListener("pointermove", onMove, true);
            win.removeEventListener("pointerdown", onDown, true);
            // The right click's context menu comes after its pointerdown.
            win.setTimeout(() => win.removeEventListener("contextmenu", onMenu, true), 300);
            win.removeEventListener("keydown", onKey, true);
        };
        return true;
    },

    /** Enter keeps, Esc drops a live operation; true = the key was its. */
    meshToolKey(e) {
        if (!this._mt) return false;
        if (e.key === "Enter") { this.meshToolFinish(true); return true; }
        if (e.key === "Escape") { this.meshToolFinish(false); return true; }
        return false;
    },

    /** The live operation is running (for tests). */
    meshToolLive() { return this._mt ? { name: this._mt.name, params: { ...this._mt.params }, error: this._mt.error || null } : null; },

    _mtKey(name) { const p = (MT.MESH_TOOL_PARAMS[name] || []).find((q) => q.drag); return p ? p.key : null; },

    _mtSessionStart(name, { modal, params, ref, start }) {
        const me = this._me;
        this.meshAdjustHide();
        this._mtCutPreview(null);
        const base = MD.copyMesh(me.work);
        const sel = { mode: me.mode, ids: [...me.sel] };
        this._mt = { name, modal, params: { ...params }, ref, start: start || 0, base, sel,
                     frame: this._mtFrame(base, sel), off: null, error: null };
        this.root.classList.add("mesh-tool-live");
        this._syncSelection();
    },

    /** The pointer moved: the dragged number from how far it went, then the preview. */
    _mtMove(cx, cy, ctrl) {
        const s = this._mt;
        if (!s) return;
        const r = this.canvas.getBoundingClientRect();
        const x = cx - r.left, y = cy - r.top;
        if (!s.ref) s.ref = { x: cx, y: cy };
        const key = this._mtKey(s.name);
        const spec = (MT.MESH_TOOL_PARAMS[s.name] || []).find((p) => p.key === key);
        let v = s.params[key];
        if (s.name === "loopcut") {
            if (s.modal) {
                // Modal: the cut follows whichever edge is under the pointer.
                const hit = this._mtEdgeAt(s.base, x, y);
                if (hit) { s.params.edge = hit.key; v = hit.share; }
            } else if (s.params.edge) {
                v = this._mtShareOn(s.base, s.params.edge, x, y);
            }
        } else if (s.frame && s.name === "extrude") {
            const t = this._mtAlong(s.frame, x, y), t0 = this._mtAlong(s.frame, s.ref.x - r.left, s.ref.y - r.top);
            if (t !== null && t0 !== null) v = s.start + (t - t0);
        } else if (s.frame && s.frame.cs) {
            const d = Math.hypot(x - s.frame.cs[0], y - s.frame.cs[1]);
            const d0 = Math.hypot(s.ref.x - r.left - s.frame.cs[0], s.ref.y - r.top - s.frame.cs[1]);
            v = s.start + (d - d0) / s.frame.ppu;
        }
        if (ctrl && spec && STEPS[spec.kind]) v = MT.snapAmount(v, STEPS[spec.kind]);
        if (spec) s.params[key] = MT.cleanParam(spec, v);
        this._mtPreview();
    },

    /** How far along the faces' way out the pointer's ray comes nearest (scene units from the middle). */
    _mtAlong(f, x, y) {
        const { THREE } = this.libs;
        const W = this.canvas.clientWidth || this.canvas.getBoundingClientRect().width;
        const H = this.canvas.clientHeight || this.canvas.getBoundingClientRect().height;
        const ray = new THREE.Raycaster();
        ray.setFromCamera(new THREE.Vector2(x / W * 2 - 1, -(y / H) * 2 + 1), this.activeCameraObject());
        const O = ray.ray.origin, D = ray.ray.direction;
        const w0 = f.C.clone().sub(O);
        const b = f.N.dot(D), d = f.N.dot(w0), e = D.dot(w0);
        const den = 1 - b * b;
        if (Math.abs(den) < 1e-6) return null;      // looking straight along it
        return (b * e - d) / den;
    },

    /** The share along edge `key` (from its first end) nearest canvas pixel (x, y). */
    _mtShareOn(mesh, key, x, y) {
        const host = this._meHost();
        const { THREE } = this.libs;
        const [a, b] = MD.edgeEnds(key);
        const pa = this._mtProject(new THREE.Vector3(...mesh.v[a]).applyMatrix4(host.matrixWorld));
        const pb = this._mtProject(new THREE.Vector3(...mesh.v[b]).applyMatrix4(host.matrixWorld));
        if (!pa || !pb) return 0.5;
        const dx = pb[0] - pa[0], dy = pb[1] - pa[1];
        const l2 = dx * dx + dy * dy;
        return l2 > 0 ? ((x - pa[0]) * dx + (y - pa[1]) * dy) / l2 : 0.5;
    },

    /** Run the operation on the mesh as it was and draw the result (nothing is written). */
    _mtPreview() {
        const s = this._mt;
        const me = this._me;
        const entry = this._meEntry();
        if (!s || !me || !entry || !entry.editMesh) return;
        const res = MT.runMeshOp(s.base, s.name, s.sel, s.params, (d) => this.meshEditLocalLength(d));
        s.error = res.error || null;
        const show = res.error ? { mesh: s.base, ids: s.sel.ids, mode: s.sel.mode } : res;
        this._mtDraw(entry, show.mesh, show.ids, show.mode);
        this._mtHudShow(res.error ? `${MT.MESH_TOOL_LABELS[s.name]}: ${res.error}` : null);
    },

    _mtDraw(entry, mesh, ids, mode) {
        const me = this._me;
        me.work = mesh;
        me.mode = mode;
        me.sel = new Set(ids);
        const old = entry.editMesh.geometry;
        entry.editMesh.geometry = this._meshGeometry(mesh, !!entry.item.smooth, entry.item.uv);
        if (old) old.dispose();
        this._meRedrawOverlay();
    },

    _mtHudShow(err) {
        const s = this._mt;
        if (!this._mtHud && this.stage) {
            this._mtHud = Object.assign(this.doc.createElement("div"), { className: "model-mesh-hud" });
            this.stage.append(this._mtHud);
        }
        const hud = this._mtHud;
        if (!hud) return;
        if (!s) { hud.style.display = "none"; return; }
        hud.style.display = "";
        const key = this._mtKey(s.name);
        const spec = (MT.MESH_TOOL_PARAMS[s.name] || []).find((p) => p.key === key);
        const v = s.params[key];
        const num = spec && spec.kind === "share" ? `${Math.round(v * 100)} %` : Number(v).toFixed(3);
        hud.textContent = err || `${MT.MESH_TOOL_LABELS[s.name]}  ${spec ? spec.label.toLowerCase() : ""} ${num}`
            + (s.modal ? "   ·   click or Enter keeps, Esc drops, Ctrl steps" : "   ·   Ctrl steps");
        hud.classList.toggle("error", !!err);
        const xy = this._mtXY;
        if (xy) {
            const sr = this.stage.getBoundingClientRect();
            hud.style.left = `${Math.min(sr.width - 40, xy.x - sr.left + 16)}px`;
            hud.style.top = `${Math.max(0, xy.y - sr.top + 18)}px`;
        }
    },

    /** Keep (true) or drop the live operation. */
    meshToolFinish(keep) {
        const s = this._mt;
        if (!s) return;
        this._mtSessionEnd(true);
        if (keep && !s.error && this.hooks.onMeshToolCommit) this.hooks.onMeshToolCommit(s.name, { ...s.params });
    },

    /** Put the mesh back as it was before the preview (the commit, if any, rebuilds it). */
    _mtSessionEnd(restore) {
        const s = this._mt;
        if (!s) return;
        this._mt = null;
        if (s.off) s.off();
        this.root.classList.remove("mesh-tool-live");
        this._mtHudShow(null);
        const entry = this._meEntry();
        if (restore && this._me && entry && entry.editMesh) this._mtDraw(entry, s.base, s.sel.ids, s.sel.mode);
        this._syncSelection();
        this.requestRender();
    },

    // ── A drag with a tool picked in the column ─────────────────────────────

    /** From _meDown: a press with a drag tool picked. True = taken (a click still picks). */
    _mtDown(e) {
        const me = this._me;
        if (!me || !me.tool || e.button !== 0 || e.altKey) return false;
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top;
        const name = me.tool;
        let edge = null;
        if (name === "loopcut") {
            edge = this._mtEdgeAt(me.work, x, y);
            if (!edge) return false;              // off every edge: picking and boxing as ever
        } else {
            const sel = { mode: me.mode, ids: [...me.sel] };
            if (!sel.ids.length || MT.runMeshOp(me.work, name, sel, { amount: 0 }).error) return false;
        }
        const win = this.win;
        const press = { x: e.clientX, y: e.clientY };
        let live = false;
        const move = (ev) => {
            if (!live) {
                if (Math.hypot(ev.clientX - press.x, ev.clientY - press.y) <= DRAG_PX) return;
                live = true;
                const params = MT.toolParams(name, this.meshEditOptions(), name === "loopcut" ? { edge: edge.key, share: edge.share } : {});
                this._mtSessionStart(name, { modal: false, params, ref: press, start: name === "loopcut" ? edge.share : 0 });
            }
            this._mtXY = { x: ev.clientX, y: ev.clientY };
            this._mtMove(ev.clientX, ev.clientY, ev.ctrlKey || ev.metaKey);
        };
        const up = (ev) => {
            win.removeEventListener("pointermove", move, true);
            win.removeEventListener("pointerup", up, true);
            if (live) { this.meshToolFinish(true); return; }
            if (name === "loopcut") {
                // A click cuts where the preview showed.
                this._mtCutPreview(null);
                if (this.hooks.onMeshToolCommit) this.hooks.onMeshToolCommit("loopcut", { edge: edge.key, share: MT.cleanParam({ kind: "share", min: 0.01, max: 0.99 }, edge.share) });
                return;
            }
            const id = this.meshEditPickAt(ev.clientX - rect.left, ev.clientY - rect.top);
            const how = ev.ctrlKey || ev.metaKey ? (ev.shiftKey ? "add" : "remove") : ev.shiftKey ? "toggle" : "replace";
            this.meshEditSetSelection(id === null ? [] : [id], id === null && how !== "replace" ? "add" : how);
        };
        win.addEventListener("pointermove", move, true);
        win.addEventListener("pointerup", up, true);
        return true;
    },

    // ── Adjust last operation ───────────────────────────────────────────────

    /** The box with the last operation's numbers; `packed` is the mesh it made (it goes when that changes). */
    meshAdjustOffer(name, params, packed) {
        const specs = MT.MESH_TOOL_PARAMS[name];
        if (!specs || !this.stage || !this._me) return;
        let a = this._meAdjust;
        if (!a || a.name !== name) {
            this.meshAdjustHide();
            a = this._mtAdjustBuild(name, specs);
        }
        a.packed = packed;
        a.params = { ...params };
        for (const el of a.el.querySelectorAll("[data-key]")) {
            const k = el.dataset.key;
            if (this.doc.activeElement === el) continue;
            if (el.type === "checkbox") el.checked = !!params[k];
            else el.value = typeof params[k] === "number" && el.type === "number" ? String(+params[k].toFixed(4)) : String(params[k]);
        }
    },

    meshAdjustHide() {
        if (this._meAdjust) { this._meAdjust.el.remove(); this._meAdjust = null; }
    },

    /** What the box shows now (for tests). */
    meshAdjustState() { return this._meAdjust ? { name: this._meAdjust.name, params: { ...this._meAdjust.params } } : null; },

    /** A number changed in the box: the panel runs the operation again (at most one at a time, the newest wins). */
    async meshAdjustSet(patch) {
        const a = this._meAdjust;
        if (!a || !this.hooks.onMeshAdjust) return;
        a.want = { ...(a.want || {}), ...patch };
        if (a.busy) return;
        while (a.want && this._meAdjust === a) {
            const p = a.want;
            a.want = null;
            a.busy = true;
            try { await this.hooks.onMeshAdjust(p); } finally { a.busy = false; }
        }
    },

    _mtAdjustBuild(name, specs) {
        const doc = this.doc;
        const box = doc.createElement("div");
        box.className = "model-mesh-adjust";
        const head = doc.createElement("div");
        head.className = "mma-head";
        head.append(Object.assign(doc.createElement("span"), { textContent: MT.MESH_TOOL_LABELS[name] || name }));
        const x = Object.assign(doc.createElement("button"), { type: "button", className: "mma-close", textContent: "×", title: "Close" });
        x.addEventListener("click", () => this.meshAdjustHide());
        head.append(x);
        box.append(head);
        const a = { name, el: box, packed: null, params: {}, busy: false, want: null };
        for (const p of specs) {
            const row = doc.createElement("label");
            row.className = "mma-row";
            const lab = Object.assign(doc.createElement("span"), { className: "mma-label", textContent: p.label });
            row.append(lab);
            let input;
            if (p.kind === "bool") {
                input = Object.assign(doc.createElement("input"), { type: "checkbox" });
                input.addEventListener("change", () => this.meshAdjustSet({ [p.key]: input.checked }));
            } else if (p.kind === "axis" || p.kind === "side") {
                input = doc.createElement("select");
                const opts = p.kind === "axis" ? [["x", "X"], ["y", "Y"], ["z", "Z"]] : [["1", "+ side"], ["-1", "− side"]];
                for (const [v, l] of opts) input.append(Object.assign(doc.createElement("option"), { value: v, textContent: l }));
                input.addEventListener("change", () => this.meshAdjustSet({ [p.key]: p.kind === "side" ? Number(input.value) : input.value }));
            } else {
                input = Object.assign(doc.createElement("input"), { type: "number", step: String(p.step || 0.01) });
                if (p.min !== undefined) input.min = String(p.min);
                if (p.max !== undefined) input.max = String(p.max);
                input.addEventListener("change", () => this.meshAdjustSet({ [p.key]: Number(input.value) }));
                // Drag the label sideways to change the number live.
                lab.classList.add("scrub");
                lab.title = "Drag sideways to change it (Ctrl: finer)";
                lab.addEventListener("pointerdown", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const x0 = e.clientX, v0 = Number(a.params[p.key]) || 0;
                    const mv = (ev) => {
                        const k = ev.ctrlKey || ev.metaKey ? 0.1 : 1;
                        const v = MT.cleanParam(p, v0 + Math.round((ev.clientX - x0) / 4) * (p.step || 0.01) * k);
                        input.value = String(+Number(v).toFixed(4));
                        this.meshAdjustSet({ [p.key]: v });
                    };
                    const upf = () => { this.win.removeEventListener("pointermove", mv, true); this.win.removeEventListener("pointerup", upf, true); };
                    this.win.addEventListener("pointermove", mv, true);
                    this.win.addEventListener("pointerup", upf, true);
                });
            }
            input.dataset.key = p.key;
            input.className = "mma-input";
            input.addEventListener("keydown", (e) => e.stopPropagation());
            row.append(input);
            box.append(row);
        }
        for (const ev of ["pointerdown", "wheel", "dblclick"]) box.addEventListener(ev, (e) => e.stopPropagation());
        this.stage.append(box);
        this._meAdjust = a;
        return a;
    },
};

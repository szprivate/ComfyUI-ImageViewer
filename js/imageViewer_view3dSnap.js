/**
 * Snapping in the 3D view (Sebastian 2026-11-20: "a point / grid / 3d snapping
 * tool ... should also be able to snap to locators"). Clean-room: written from
 * how snapping behaves for the user - a dragged handle jumps onto what is
 * under the pointer - with nothing taken from any program's code.
 *
 * While snapping is on, a Move (or pivot) drag puts the item's origin on:
 *   1. a locator's centre, an item's pivot, a point of a mesh / point cloud
 *      near the pointer (within SNAP_PX on screen),
 *   2. else the nearest point on an edge of the triangle under the pointer,
 *   3. else the surface under the pointer (when Surface is on),
 *   4. else the grid: the position the gizmo gives, rounded to the grid's
 *      spacing on the axes being dragged.
 * A drag along one axis or in one plane keeps to it: the target is taken onto
 * that line / plane through where the drag began.
 *
 * The finder (`snapFind`) is also what the measure tool places its points with.
 * The pure part (options, picking among candidates, axes, the grid) is tested in
 * tests/test_view3d_snap.mjs.
 */

export const SNAP_STORE = "imageviewer.viewer.snap3d";
export const SNAP_PX = 12;            // how near (screen px) a point must be to win
export const EDGE_PX = 8;             // edges need to be nearer than points
export const SNAP_KINDS = [
    { key: "points", label: "Points", tip: "Points of meshes and point clouds near the pointer" },
    { key: "edges", label: "Edges", tip: "The nearest point on an edge of the face under the pointer" },
    { key: "locators", label: "Locators", tip: "A locator's centre" },
    { key: "pivots", label: "Pivots", tip: "The pivot (origin) of any other item" },
    { key: "surface", label: "Surface", tip: "Anywhere on the surface under the pointer" },
    { key: "grid", label: "Grid", tip: "Whole grid steps along the axes being dragged" },
];
const DEFAULTS = { on: false, points: true, edges: true, locators: true, pivots: true, surface: false, grid: true };
// Which candidate wins when two are as near.
const RANK = { locator: 0, pivot: 1, point: 2, edge: 3, surface: 4, grid: 5, ground: 6 };

/** The options as stored, held to their shape. */
export function cleanSnapOptions(o) {
    const out = { ...DEFAULTS };
    if (o && typeof o === "object") for (const k of Object.keys(DEFAULTS)) if (k in o) out[k] = !!o[k];
    return out;
}

/**
 * The candidate that wins: a point (a locator, a pivot, a mesh point) within
 * reach before any edge - an edge runs under the pointer right up to the point
 * it ends in - then the nearest on screen; a locator before a pivot before a
 * point at the same distance. cands: [{x, y, kind, ...}] in client pixels.
 */
export function pickSnap(cands, px, py, radius = SNAP_PX, edgeRadius = EDGE_PX) {
    let best = null, bestD = Infinity;
    for (const c of cands || []) {
        const d = Math.hypot(c.x - px, c.y - py);
        const edge = c.kind === "edge";
        if (d > (edge ? edgeRadius : radius)) continue;
        const score = (edge ? 1e6 : 0) + d + (RANK[c.kind] ?? 9) * 1e-3;
        if (score < bestD) { bestD = score; best = c; }
    }
    return best;
}

/** The axes a gizmo handle moves along: "X" -> [0], "XY" -> [0, 1], "XYZ" / anything else -> null (free). */
export function axesOf(axis) {
    if (!axis || typeof axis !== "string") return null;
    if (axis === "XYZ" || axis === "XYZE" || axis === "E") return null;
    const out = [];
    for (const [i, c] of ["X", "Y", "Z"].entries()) if (axis.includes(c)) out.push(i);
    return out.length ? out : null;
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * The target `t` taken onto the line / plane through `s` that the dragged axes
 * span. dirs: the three axis directions (unit vectors, world space), axes: the
 * indices that may move (null = all, t as it is).
 */
export function constrainTo(s, t, dirs, axes) {
    if (!axes) return [t[0], t[1], t[2]];
    const d = [t[0] - s[0], t[1] - s[1], t[2] - s[2]];
    const out = [s[0], s[1], s[2]];
    for (const i of axes) {
        const k = dot(d, dirs[i]);
        out[0] += k * dirs[i][0]; out[1] += k * dirs[i][1]; out[2] += k * dirs[i][2];
    }
    return out;
}

/**
 * Grid snapping of `p`: its coordinate along each dragged axis rounded to the
 * step, the others kept. World axes: the world's coordinates. The item's own
 * axes (dirs, orthonormal): its coordinates along them, measured from the world
 * origin - the same as the world's while the item is not turned, a grid turned
 * with the item when it is.
 */
export function snapToGrid(p, step, dirs, axes, world) {
    if (!(step > 0)) return [p[0], p[1], p[2]];
    const r = (v) => Math.round(v / step) * step;
    const which = axes || [0, 1, 2];
    if (world) {
        const out = [p[0], p[1], p[2]];
        for (const i of which) out[i] = r(out[i]);
        return out;
    }
    const c = [0, 1, 2].map((i) => dot(p, dirs[i]));
    for (const i of which) c[i] = r(c[i]);
    const out = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
        out[0] += c[i] * dirs[i][0]; out[1] += c[i] * dirs[i][1]; out[2] += c[i] * dirs[i][2];
    }
    return out;
}

/** The point on segment a-b (screen) nearest (px, py): {t, d}. */
export function nearestOnSegment(ax, ay, bx, by, px, py) {
    const vx = bx - ax, vy = by - ay;
    const len2 = vx * vx + vy * vy;
    let t = len2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return { t, d: Math.hypot(ax + vx * t - px, ay + vy * t - py) };
}

const SNAP_CSS_LABEL = { locator: "locator", pivot: "pivot", point: "point", edge: "edge", surface: "surface", grid: "grid", ground: "ground" };

export const View3DSnapMixin = {
    snapOptions() {
        if (!this._snapOpts) {
            let saved = null;
            try { saved = JSON.parse(this.win.localStorage.getItem(SNAP_STORE) || "null"); } catch (_) { /* private window */ }
            this._snapOpts = cleanSnapOptions(saved);
        }
        return this._snapOpts;
    },

    setSnapOptions(patch) {
        this._snapOpts = cleanSnapOptions({ ...this.snapOptions(), ...(patch || {}) });
        try { this.win.localStorage.setItem(SNAP_STORE, JSON.stringify(this._snapOpts)); } catch (_) { /* private window */ }
        if (!this._snapOpts.on) this._snapMarkHide();
        this._snapSyncButton();
        if (this._snapMenu && this._snapMenu._sync) this._snapMenu._sync();
    },

    snapOn() { return !!this.snapOptions().on; },
    toggleSnap(on) { this.setSnapOptions({ on: on === undefined ? !this.snapOn() : !!on }); },

    // ── The tool column's button and its options ─────────────────────────────

    _snapBuildButton(el) {
        const wrap = el("div", "model-snap-wrap");
        const btn = el("button", "model-btn model-icon-btn model-snap-btn", "Snap");
        btn.dataset.tool = "snap";
        btn.onclick = () => this.toggleSnap();
        btn.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); this.toggleSnapMenu(); };
        if (this.hooks.setIcon) this.hooks.setIcon(btn, "icon-magnet");
        const more = el("button", "model-btn model-snap-more", "▸");
        more.title = "What to snap to";
        more.onclick = (e) => { e.stopPropagation(); this.toggleSnapMenu(); };
        wrap.append(btn, more);
        this._snapBtn = btn;
        this._snapMore = more;
        this._snapWrap = wrap;
        this._snapSyncButton();
        return wrap;
    },

    _snapSyncButton() {
        const b = this._snapBtn;
        if (!b) return;
        const o = this.snapOptions();
        b.classList.toggle("active", o.on);
        const what = SNAP_KINDS.filter((k) => o[k.key]).map((k) => k.label.toLowerCase()).join(", ") || "nothing";
        b.title = o.on
            ? `Snapping on: a Move drag snaps to ${what} - click to turn it off (N; right-click: what to snap to)`
            : `Snap a Move drag to ${what} (N; right-click: what to snap to)`;
    },

    toggleSnapMenu(open) {
        if (!this.root || !this._snapWrap) return;
        const was = !!this._snapMenu;
        const want = open === undefined ? !was : !!open;
        if (was) { this._snapMenu.remove(); this._snapMenu = null; if (this._snapMenuOff) this._snapMenuOff(); }
        if (!want) return;
        const d = this.doc;
        const menu = d.createElement("div");
        menu.className = "model-display-menu model-snap-menu";
        menu.addEventListener("pointerdown", (e) => e.stopPropagation());
        const rows = [];
        const row = (key, label, tip, hotkey) => {
            const r = d.createElement("label");
            r.className = "model-display-row";
            r.title = tip || "";
            const box = d.createElement("input");
            box.type = "checkbox";
            box.dataset.snap = key;
            const text = d.createElement("span");
            text.textContent = label;
            r.append(box, text);
            if (hotkey) r.append(Object.assign(d.createElement("span"), { className: "model-display-key", textContent: hotkey }));
            box.onchange = () => this.setSnapOptions({ [key]: box.checked });
            rows.push(() => { box.checked = !!this.snapOptions()[key]; });
            menu.append(r);
        };
        row("on", "Snapping", "Snapping on / off", "N");
        menu.append(Object.assign(d.createElement("div"), { className: "model-display-sep" }));
        for (const k of SNAP_KINDS) row(k.key, k.label, k.tip);
        menu._sync = () => rows.forEach((f) => f());
        menu._sync();
        this._snapWrap.append(menu);
        this._snapMenu = menu;
        const win = this.win;
        const close = (e) => {
            const path = e.composedPath ? e.composedPath() : [e.target];
            if (path.includes(menu) || path.includes(this._snapMore) || path.includes(this._snapBtn)) return;
            if (e.type === "keydown" && e.key !== "Escape") return;
            this.toggleSnapMenu(false);
        };
        win.addEventListener("pointerdown", close, true);
        win.addEventListener("keydown", close, true);
        this._snapMenuOff = () => {
            win.removeEventListener("pointerdown", close, true);
            win.removeEventListener("keydown", close, true);
            this._snapMenuOff = null;
        };
    },

    // ── Finding what is under the pointer ────────────────────────────────────

    /** Whether `obj` belongs to an item in `exclude` (itself or under one). */
    _snapExcluded(obj, exclude) {
        if (!exclude || !exclude.size) return false;
        for (let n = obj; n; n = n.parent) {
            const id = n.userData && n.userData.imageViewerItemId;
            if (id && exclude.has(id)) return true;
        }
        return false;
    },

    _snapShown(obj) {
        for (let n = obj; n; n = n.parent) if (n.visible === false) return false;
        return true;
    },

    /** A world point on screen: {x, y} in client pixels, or null behind the camera. */
    _snapToScreen(v, cam, rect) {
        const p = v.clone().project(cam);
        if (!(p.z >= -1 && p.z <= 1)) return null;
        return { x: rect.left + (p.x + 1) / 2 * rect.width, y: rect.top + (1 - p.y) / 2 * rect.height };
    },

    /**
     * What to snap to under (cx, cy): {p: THREE.Vector3 (world), kind, x, y} or
     * null. opts: {exclude: Set of item ids, kinds: options to use instead of the
     * stored ones (the measure tool asks for points / surface whatever is set)}.
     * Grid snapping is not here: it needs the drag's own position.
     */
    snapFind(cx, cy, opts = {}) {
        if (!this.libs || !this.canvas) return null;
        const { THREE } = this.libs;
        const o = opts.kinds || this.snapOptions();
        const exclude = opts.exclude || null;
        const cam = this.activeCameraObject();
        const rect = this.canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        cam.updateMatrixWorld();
        const cands = [];
        // Locators and pivots: every item's origin.
        if (o.locators || o.pivots) {
            for (const entry of this._entries.values()) {
                if (!entry.root || !entry.item) continue;
                if (exclude && exclude.has(entry.item.id)) continue;
                if (this._snapExcluded(entry.root, exclude)) continue;
                if (!this._snapShown(entry.root)) continue;
                const isLoc = !!entry.locator;
                if (isLoc ? !o.locators : !o.pivots) continue;
                entry.root.updateWorldMatrix(true, false);
                const p = new THREE.Vector3().setFromMatrixPosition(entry.root.matrixWorld);
                const s = this._snapToScreen(p, cam, rect);
                if (s) cands.push({ ...s, p, kind: isLoc ? "locator" : "pivot", id: entry.item.id });
            }
        }
        // Geometry: a few rays round the pointer, so a point a little off the
        // face under the pointer (or a point at a silhouette) is found too.
        let surface = null;
        if (o.points || o.edges || o.surface) {
            const roots = [];
            for (const entry of this._entries.values()) {
                if (entry.object && entry.root.visible) roots.push(entry.root);
            }
            const ray = new THREE.Raycaster();
            ray.layers.mask = this._dispMask ? this._dispMask() : ray.layers.mask;
            ray.params.Points.threshold = 0.02 * (cam.position.length() || 1);
            const off = SNAP_PX * 0.7;
            const seen = new Set();
            for (const [dx, dy] of [[0, 0], [off, 0], [-off, 0], [0, off], [0, -off]]) {
                const ndc = new THREE.Vector2(((cx + dx - rect.left) / rect.width) * 2 - 1,
                                              -((cy + dy - rect.top) / rect.height) * 2 + 1);
                ray.setFromCamera(ndc, cam);
                let hit = null;
                for (const h of ray.intersectObjects(roots, true)) {
                    if (!(h.object.isMesh || h.object.isPoints)) continue;
                    if (h.object.userData && (h.object.userData.imageViewerLocator || h.object.userData.imageViewerLightGlyph)) continue;
                    if (!this._snapShown(h.object) || this._snapExcluded(h.object, exclude)) continue;
                    hit = h;
                    break;
                }
                if (!hit) continue;
                if (dx === 0 && dy === 0) surface = hit;
                const key = `${hit.object.uuid}:${hit.face ? `${hit.face.a},${hit.face.b},${hit.face.c}` : hit.index}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const obj = hit.object;
                obj.updateWorldMatrix(true, false);
                const inst = obj.isInstancedMesh && hit.instanceId != null ? new THREE.Matrix4() : null;
                if (inst) obj.getMatrixAt(hit.instanceId, inst);
                const vertex = (i) => {
                    const v = new THREE.Vector3();
                    if (obj.getVertexPosition) obj.getVertexPosition(i, v);
                    else v.fromBufferAttribute(obj.geometry.attributes.position, i);
                    if (inst) v.applyMatrix4(inst);
                    return v.applyMatrix4(obj.matrixWorld);
                };
                if (obj.isPoints && hit.index != null) {
                    if (o.points) {
                        const p = vertex(hit.index);
                        const s = this._snapToScreen(p, cam, rect);
                        if (s) cands.push({ ...s, p, kind: "point" });
                    }
                    continue;
                }
                if (!hit.face) continue;
                const tri = [hit.face.a, hit.face.b, hit.face.c].map(vertex);
                const scr = tri.map((p) => this._snapToScreen(p, cam, rect));
                if (o.points) tri.forEach((p, i) => { if (scr[i]) cands.push({ ...scr[i], p, kind: "point" }); });
                if (o.edges) {
                    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
                        if (!scr[a] || !scr[b]) continue;
                        const { t } = nearestOnSegment(scr[a].x, scr[a].y, scr[b].x, scr[b].y, cx, cy);
                        // The screen share is not the world share under perspective: walk the
                        // world edge to the point whose projection is nearest instead.
                        const p = this._snapEdgePoint(tri[a], tri[b], cam, rect, cx, cy, t);
                        const s = this._snapToScreen(p, cam, rect);
                        if (s) cands.push({ ...s, p, kind: "edge" });
                    }
                }
            }
        }
        const best = pickSnap(cands, cx, cy);
        if (best) return best;
        if (o.surface && surface) {
            const s = this._snapToScreen(surface.point, cam, rect);
            return { ...(s || { x: cx, y: cy }), p: surface.point.clone(), kind: "surface" };
        }
        return null;
    },

    /** The point on world edge a-b whose projection is nearest (cx, cy), starting from share t. */
    _snapEdgePoint(a, b, cam, rect, cx, cy, t) {
        const at = (u) => a.clone().lerp(b, u);
        const dist = (u) => {
            const s = this._snapToScreen(at(u), cam, rect);
            return s ? Math.hypot(s.x - cx, s.y - cy) : Infinity;
        };
        // Golden-section search on [0, 1] about t (the distance is unimodal along a line).
        let lo = 0, hi = 1;
        const g = 0.6180339887;
        let x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo);
        let f1 = dist(x1), f2 = dist(x2);
        for (let i = 0; i < 24; i++) {
            if (f1 < f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - g * (hi - lo); f1 = dist(x1); }
            else { lo = x1; x1 = x2; f1 = f2; x2 = lo + g * (hi - lo); f2 = dist(x2); }
        }
        const u = (lo + hi) / 2;
        return at(Number.isFinite(dist(u)) ? u : t);
    },

    // ── Snapping a gizmo drag ────────────────────────────────────────────────

    /** Pointer moves over the canvas, read before the gizmo moves the object (capture phase). */
    _snapTrackPointer(e) {
        this._snapPtr = { x: e.clientX, y: e.clientY };
    },

    /** dragging-changed: where the dragged object began. */
    _snapDragStart(on) {
        if (!on) { this._snapDrag = null; this._snapMarkHide(); return; }
        const obj = this.gizmo && this.gizmo.object;
        if (!obj || !this.libs) { this._snapDrag = null; return; }
        const { THREE } = this.libs;
        obj.updateWorldMatrix(true, false);
        const exclude = new Set();
        // Moving an item: its own geometry (and what hangs under it) is not a target.
        // Moving a pivot: the item's own points are exactly what one wants.
        if (!this.pivotMode) {
            if (this.selected) exclude.add(this.selected);
            for (const id of this._alsoIds || []) exclude.add(id);
        }
        this._snapDrag = { start: new THREE.Vector3().setFromMatrixPosition(obj.matrixWorld), exclude };
    },

    /** objectChange: put the dragged object on the snap target. Translate / pivot drags only. */
    _snapApply() {
        const drag = this._snapDrag;
        const gizmo = this.gizmo;
        if (!drag || !gizmo || !gizmo.object || !this.snapOn() || !this.libs) { this._snapMarkHide(); return; }
        if (gizmo.mode !== "translate") { this._snapMarkHide(); return; }
        const { THREE } = this.libs;
        const obj = gizmo.object;
        obj.updateWorldMatrix(true, false);
        const now = new THREE.Vector3().setFromMatrixPosition(obj.matrixWorld);
        const axes = axesOf(gizmo.axis);
        const world = gizmo.space === "world";
        const q = new THREE.Quaternion();
        if (!world) obj.getWorldQuaternion(q);
        const dirs = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((v) => {
            const d = new THREE.Vector3(...v).applyQuaternion(q).normalize();
            return [d.x, d.y, d.z];
        });
        const s = drag.start.toArray();
        let target = null, kind = null, at = null;
        const ptr = this._snapPtr;
        const hit = ptr ? this.snapFind(ptr.x, ptr.y, { exclude: drag.exclude }) : null;
        if (hit) {
            target = constrainTo(s, hit.p.toArray(), dirs, axes);
            kind = hit.kind;
            at = hit.p;
        } else if (this.snapOptions().grid) {
            const step = this.gridEffective ? this.gridEffective().spacing : 1;
            target = snapToGrid(now.toArray(), step, dirs, axes, world);
            kind = "grid";
        }
        if (!target) { this._snapMarkHide(); return; }
        const w = new THREE.Vector3(...target);
        const local = obj.parent ? obj.parent.worldToLocal(w.clone()) : w.clone();
        obj.position.copy(local);
        obj.updateMatrixWorld(true);
        this._snapMarkShow(at || w, kind);
    },

    // ── The mark that says what it snapped to ────────────────────────────────

    _snapMarkShow(p, kind) {
        if (!this.stage || !this.libs) return;
        const cam = this.activeCameraObject();
        const rect = this.canvas.getBoundingClientRect();
        const s = this._snapToScreen(p, cam, rect);
        if (!s) { this._snapMarkHide(); return; }
        let m = this._snapMark;
        if (!m || m.ownerDocument !== this.doc) {
            m = this.doc.createElement("div");
            m.className = "model-snap-mark";
            m.append(this.doc.createElement("i"), this.doc.createElement("span"));
            this._snapMark = m;
        }
        if (m.parentNode !== this.stage) this.stage.append(m);
        const sr = this.stage.getBoundingClientRect();
        m.style.left = `${s.x - sr.left}px`;
        m.style.top = `${s.y - sr.top}px`;
        m.dataset.kind = kind;
        m.lastChild.textContent = SNAP_CSS_LABEL[kind] || kind;
        m.style.display = "";
    },

    _snapMarkHide() {
        if (this._snapMark) this._snapMark.style.display = "none";
    },
};

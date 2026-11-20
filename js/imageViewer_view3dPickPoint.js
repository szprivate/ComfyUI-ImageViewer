// imageViewer_view3dPickPoint.js
// One point picked on the geometry of the 3D view (View3DPickPointMixin, on Model3DView): Matchmove's "Pin to
// geometry" asks for the spot a track sits on. While it waits, the left button belongs to it (Alt still
// navigates): the point under the pointer snaps to a vertex or an edge as the measure tool's points do, else lands
// on the surface, with snapping's mark showing where; a click hands it over, Esc or pickPointEnd() stops.
//
// Also itemPointWorld(id, vertex): an item's origin or one of its vertices in world space (the agent pins by
// item and vertex).
//
// Written from scratch, clean-room.

export const View3DPickPointMixin = {
    /**
     * Wait for a click on the geometry. opts: {exclude: Set of item ids not to land on (the matchmove's own plate
     * and locators), onPick({p: [x, y, z], kind, item, name}), onEnd(picked)}. A new call ends the one before.
     */
    pickPointBegin(opts = {}) {
        this.pickPointEnd(false);
        const pp = this._pp = { exclude: opts.exclude || null, onPick: opts.onPick || null, onEnd: opts.onEnd || null };
        const cv = this.canvas;
        if (cv) {
            pp.move = (e) => this._ppMove(e);
            pp.key = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.pickPointEnd(false); } };
            cv.addEventListener("pointermove", pp.move);
            const win = cv.ownerDocument.defaultView || window;
            win.addEventListener("keydown", pp.key, true);
            pp.win = win;
            pp.cv = cv;
        }
        if (this.root) this.root.classList.add("picking-point");
        return true;
    },

    pickPointActive() { return !!this._pp; },

    pickPointEnd(picked = false) {
        const pp = this._pp;
        if (!pp) return;
        this._pp = null;
        if (pp.cv && pp.move) pp.cv.removeEventListener("pointermove", pp.move);
        if (pp.win && pp.key) pp.win.removeEventListener("keydown", pp.key, true);
        if (this.root) this.root.classList.remove("picking-point");
        if (this._snapMarkHide) this._snapMarkHide();
        if (pp.onEnd) pp.onEnd(picked);
    },

    /** The point under (cx, cy): a vertex or an edge near the pointer, else the surface; null over nothing. */
    _ppTarget(cx, cy) {
        const pp = this._pp;
        if (!this.snapFind) return null;
        const hit = this.snapFind(cx, cy, { kinds: { points: true, edges: true, surface: true }, exclude: pp && pp.exclude });
        return hit && hit.p ? hit : null;
    },

    _ppMove(e) {
        if (!this._pp || (e.buttons && !e.altKey)) return;
        const t = this._ppTarget(e.clientX, e.clientY);
        if (t && this._snapMarkShow) this._snapMarkShow(t.p, t.kind);
        else if (this._snapMarkHide) this._snapMarkHide();
        this.requestRender && this.requestRender();
    },

    /** _onPointerDown hands the press here first while picking: true = taken. */
    _ppDown(e) {
        const pp = this._pp;
        if (!pp || e.altKey || e.button !== 0) return false;
        const t = this._ppTarget(e.clientX, e.clientY);
        if (!t) return true;                       // over nothing: keep waiting
        const item = this._pick ? this._pick(e) : null;
        const entry = item && this._entries ? this._entries.get(item) : null;
        const got = { p: [t.p.x, t.p.y, t.p.z], kind: t.kind === "point" || t.kind === "edge" || t.kind === "locator" || t.kind === "pivot" ? t.kind : "surface",
                      item: item && !(pp.exclude && pp.exclude.has(item)) ? item : "",
                      name: entry && entry.item ? String(entry.item.name || "") : "" };
        if (!got.item) got.name = "";
        const cb = pp.onPick;
        this.pickPointEnd(true);
        if (cb) cb(got);
        return true;
    },

    /**
     * Item `id`'s origin, or with `vertex` (an index) that vertex of its first mesh, in world space: [x, y, z] or
     * null (no such item, no such vertex).
     */
    itemPointWorld(id, vertex = null) {
        const entry = this._entries && this._entries.get(id);
        if (!entry || !entry.root || !this.libs) return null;
        const { THREE } = this.libs;
        entry.root.updateWorldMatrix(true, true);
        if (vertex === null || vertex === undefined) {
            const v = new THREE.Vector3().setFromMatrixPosition(entry.root.matrixWorld);
            return [v.x, v.y, v.z];
        }
        let mesh = null;
        entry.root.traverse((o) => { if (!mesh && o.isMesh && o.geometry && o.geometry.attributes.position) mesh = o; });
        const n = Math.round(Number(vertex));
        if (!mesh || !(n >= 0) || n >= mesh.geometry.attributes.position.count) return null;
        const v = new THREE.Vector3();
        if (mesh.getVertexPosition) mesh.getVertexPosition(n, v);
        else v.fromBufferAttribute(mesh.geometry.attributes.position, n);
        v.applyMatrix4(mesh.matrixWorld);
        return [v.x, v.y, v.z];
    },
};

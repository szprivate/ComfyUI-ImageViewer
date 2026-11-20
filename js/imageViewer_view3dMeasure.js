/**
 * The measure tool of the 3D view (Sebastian 2026-11-20: "add a measure tool
 * to the tool bar"). Clean-room.
 *
 * Click to put down points; each new point measures the stretch from the one
 * before, and a point between two stretches shows the angle there. The points
 * land on what snapping finds (points, edges, locators, pivots, and always the
 * surface under the pointer), else on the ground (y = 0) in a perspective view
 * or the plane through the orbit centre facing a flat view. Grid snapping, when
 * on, rounds a point on the ground to the grid. A press on a point already put
 * down drags it.
 *
 * Enter or a double-click ends the chain (the next click starts another), Esc
 * ends it and, with none open, clears every measurement; Backspace takes the
 * last point away. Scene units are metres (the USD writer's metersPerUnit 1, a
 * matchmove solved with a distance is in metres), so lengths read in m / cm / mm.
 *
 * Measurements are a tool, not part of the scene: they are not saved, never
 * rendered and not path traced. The pure part (lengths, angles, the wording)
 * is tested in tests/test_view3d_measure.mjs.
 */

export const MEASURE_PICK_PX = 8;     // how near a press must be to a point to drag it
const COLOR = 0xffd23c;

/** A length in metres, in the unit that reads best. */
export function formatLength(m) {
    if (!Number.isFinite(m)) return "-";
    const a = Math.abs(m);
    const num = (v, unit) => {
        const digits = Math.abs(v) >= 100 ? 1 : Math.abs(v) >= 10 ? 2 : 3;
        return `${Number(v.toFixed(digits))} ${unit}`;
    };
    if (a >= 1000) return num(m / 1000, "km");
    if (a >= 1 || a === 0) return num(m, "m");
    if (a >= 0.01) return num(m * 100, "cm");
    return num(m * 1000, "mm");
}

/** An angle in degrees, to a tenth. */
export function formatAngle(deg) {
    return Number.isFinite(deg) ? `${Number(deg.toFixed(1))}°` : "-";
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (v) => Math.hypot(v[0], v[1], v[2]);

/** The angle at b between b->a and b->c, degrees (null when a stretch has no length). */
export function angleAt(a, b, c) {
    const u = sub(a, b), v = sub(c, b);
    const lu = len(u), lv = len(v);
    if (!(lu > 1e-12 && lv > 1e-12)) return null;
    const cos = Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (lu * lv)));
    return Math.acos(cos) * 180 / Math.PI;
}

/**
 * Everything about a chain of points ([[x, y, z], ...], metres):
 * {segments: [{length, delta, mid}], angles: [{at, deg}], total, rise, flat, count}.
 * `rise` is the height from the first point to the last, `flat` the distance
 * between them on the ground (x / z), `slope` the rise over that, in degrees.
 */
export function measureReadout(points) {
    const pts = (points || []).filter((p) => Array.isArray(p) && p.length >= 3 && p.every(Number.isFinite));
    const segments = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
        const d = sub(pts[i], pts[i - 1]);
        const l = len(d);
        total += l;
        segments.push({ length: l, delta: d, mid: [(pts[i][0] + pts[i - 1][0]) / 2, (pts[i][1] + pts[i - 1][1]) / 2, (pts[i][2] + pts[i - 1][2]) / 2] });
    }
    const angles = [];
    for (let i = 1; i + 1 < pts.length; i++) {
        const deg = angleAt(pts[i - 1], pts[i], pts[i + 1]);
        if (deg !== null) angles.push({ at: i, deg });
    }
    const first = pts[0], last = pts[pts.length - 1];
    const rise = pts.length > 1 ? last[1] - first[1] : 0;
    const flat = pts.length > 1 ? Math.hypot(last[0] - first[0], last[2] - first[2]) : 0;
    const slope = pts.length > 1 && (flat > 1e-12 || Math.abs(rise) > 1e-12) ? Math.atan2(rise, flat) * 180 / Math.PI : 0;
    return { count: pts.length, segments, angles, total, rise, flat, slope };
}

/** The readout as lines of text, for the info box (and the agent / tests). */
export function readoutLines(points) {
    const r = measureReadout(points);
    if (r.count < 2) return r.count ? ["Click the next point"] : [];
    const out = [];
    if (r.segments.length === 1) {
        const [dx, dy, dz] = r.segments[0].delta;
        out.push(`Distance ${formatLength(r.total)}`);
        out.push(`ΔX ${formatLength(dx)}  ΔY ${formatLength(dy)}  ΔZ ${formatLength(dz)}`);
    } else {
        out.push(`Total ${formatLength(r.total)} over ${r.segments.length} stretches`);
        out.push(`Ends apart ${formatLength(len(sub(points[points.length - 1], points[0])))}`);
        for (const a of r.angles) out.push(`Angle at point ${a.at + 1}: ${formatAngle(a.deg)}`);
    }
    if (Math.abs(r.rise) > 1e-9) out.push(`Rise ${formatLength(r.rise)} over ${formatLength(r.flat)} (${formatAngle(r.slope)})`);
    return out;
}

export const View3DMeasureMixin = {
    measureActive() { return !!this._msOn; },

    /** Turn the tool on / off. The measurements stay until cleared (or the view goes). */
    setMeasure(on) {
        const want = !!on;
        if (want === !!this._msOn) return;
        this._msOn = want;
        if (!this._ms) this._ms = { chains: [], open: false };
        const c = this.canvas;
        if (want) {
            if (this._sp && this.scatterPaintEnd) this.scatterPaintEnd();
            if (this._tb && this.terrainBrushEnd) this.terrainBrushEnd();
            this._msMove = (e) => this._msPointerMove(e);
            this._msUp = (e) => this._msPointerUp(e);
            this._msKey = (e) => this._msKeyDown(e);
            this._msDbl = (e) => { if (this._msOn && !e.altKey) { this._msFinishChain(); e.preventDefault(); } };
            this._msLeave = () => { this._msHover = null; this._msDraw(); };
            if (c) {
                c.addEventListener("pointermove", this._msMove);
                c.addEventListener("pointerup", this._msUp);
                c.addEventListener("dblclick", this._msDbl);
                c.addEventListener("pointerleave", this._msLeave);
            }
            this._msWin = this.win;
            this._msWin.addEventListener("keydown", this._msKey, true);
            this._msCanvas = c;
            this.root.classList.add("measuring");
        } else {
            const cv = this._msCanvas;
            if (cv) {
                cv.removeEventListener("pointermove", this._msMove);
                cv.removeEventListener("pointerup", this._msUp);
                cv.removeEventListener("dblclick", this._msDbl);
                cv.removeEventListener("pointerleave", this._msLeave);
            }
            if (this._msWin) this._msWin.removeEventListener("keydown", this._msKey, true);
            this._msCanvas = null;
            this._msWin = null;
            this._msHover = null;
            this._msDragPt = null;
            if (this._ms) this._ms.open = false;
            this.root.classList.remove("measuring");
            if (this._snapMarkHide) this._snapMarkHide();
        }
        this._syncSelection();
        this._syncToolbar();
        this._msDraw();
        this.requestRender();
    },

    toggleMeasure() { this.setMeasure(!this._msOn); },

    /** Every measurement as plain numbers: [[[x, y, z], ...], ...] (for tests and the agent). */
    measurements() {
        return (this._ms ? this._ms.chains : []).map((ch) => ch.map((pt) => pt.p.toArray()));
    },

    clearMeasurements() {
        if (this._ms) { this._ms.chains = []; this._ms.open = false; }
        this._msDraw();
        this.requestRender();
    },

    _msFinishChain() {
        const ms = this._ms;
        if (!ms || !ms.open) return false;
        ms.open = false;
        const last = ms.chains[ms.chains.length - 1];
        if (last && last.length < 2) ms.chains.pop();
        this._msDraw();
        this.requestRender();
        return true;
    },

    _msKeyDown(e) {
        if (!this._msOn) return;
        const t = e.composedPath ? e.composedPath()[0] : e.target;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ""))) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        // Only while the pointer is over the view or the chain is open: the rest of the viewer keeps its keys.
        const ms = this._ms;
        let took = true;
        if (e.key === "Enter") took = this._msFinishChain();
        else if (e.key === "Escape") {
            if (!this._msFinishChain()) {
                if (ms && ms.chains.length) this.clearMeasurements();
                else this.setMeasure(false);
            }
        } else if (e.key === "Backspace" || e.key === "Delete") {
            const ch = ms && ms.chains[ms.chains.length - 1];
            if (e.key === "Delete" || !ch) { if (ms && ms.chains.length) this.clearMeasurements(); else took = false; }
            else {
                ch.pop();
                if (!ch.length) { ms.chains.pop(); ms.open = false; } else ms.open = true;
                this._msDraw();
                this.requestRender();
            }
        } else took = false;
        if (took) { e.preventDefault(); e.stopImmediatePropagation(); }
    },

    /** Where a measure point goes under (cx, cy): {p, kind}. */
    _msTarget(cx, cy) {
        const { THREE } = this.libs;
        const o = this.snapOptions ? this.snapOptions() : {};
        const on = !!o.on;
        // The surface always; the rest as snapping is set (all of them while it is off - measuring
        // wants exact points, and a point a few pixels off a vertex is never meant).
        const kinds = on ? { ...o, surface: true } : { points: true, edges: true, locators: true, pivots: true, surface: true };
        const hit = this.snapFind ? this.snapFind(cx, cy, { kinds }) : null;
        if (hit) return { p: hit.p.clone(), kind: hit.kind };
        const cam = this.activeCameraObject();
        const rect = this.canvas.getBoundingClientRect();
        const ndc = new THREE.Vector2(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
        const ray = new THREE.Raycaster();
        ray.setFromCamera(ndc, cam);
        let plane;
        if (cam.isOrthographicCamera) {
            const n = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
            plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, this.controls ? this.controls.target : new THREE.Vector3());
        } else {
            plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        }
        const p = ray.ray.intersectPlane(plane, new THREE.Vector3());
        if (!p) return null;
        if (on && o.grid && this.gridEffective) {
            const step = this.gridEffective().spacing;
            if (step > 0) {
                const r = (v) => Math.round(v / step) * step;
                if (cam.isOrthographicCamera) { p.x = r(p.x); p.y = r(p.y); p.z = r(p.z); }
                else { p.x = r(p.x); p.z = r(p.z); }
                return { p, kind: "grid" };
            }
        }
        return { p, kind: "ground" };
    },

    /** The point put down nearest (cx, cy) on screen within MEASURE_PICK_PX: {chain, index} or null. */
    _msPointAt(cx, cy) {
        const ms = this._ms;
        if (!ms || !this._snapToScreen) return null;
        const cam = this.activeCameraObject();
        const rect = this.canvas.getBoundingClientRect();
        let best = null, bestD = MEASURE_PICK_PX;
        ms.chains.forEach((ch, ci) => ch.forEach((pt, i) => {
            const s = this._snapToScreen(pt.p, cam, rect);
            if (!s) return;
            const d = Math.hypot(s.x - cx, s.y - cy);
            if (d <= bestD) { bestD = d; best = { chain: ci, index: i }; }
        }));
        return best;
    },

    /** _onPointerDown hands the press here first while measuring: true = taken. */
    _msDown(e) {
        if (!this._msOn || e.altKey || e.button !== 0 || !this.libs) return false;
        const ms = this._ms;
        const at = this._msPointAt(e.clientX, e.clientY);
        // A press on a point of a chain that is finished (or the open chain's own, not its last)
        // picks it up to move it.
        if (at && !(ms.open && at.chain === ms.chains.length - 1 && at.index === ms.chains[at.chain].length - 1)) {
            this._msDragPt = at;
            try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* synthetic */ }
            return true;
        }
        const t = this._msTarget(e.clientX, e.clientY);
        if (!t) return true;
        if (!ms.open) { ms.chains.push([]); ms.open = true; }
        ms.chains[ms.chains.length - 1].push(t);
        this._msHover = null;
        this._msDraw();
        this.requestRender();
        return true;
    },

    _msPointerMove(e) {
        if (!this._msOn || !this.libs) return;
        if (e.buttons && !this._msDragPt) return;      // a navigation drag
        const t = this._msTarget(e.clientX, e.clientY);
        if (this._msDragPt) {
            const { chain, index } = this._msDragPt;
            const ch = this._ms.chains[chain];
            if (t && ch && ch[index]) ch[index] = t;
        } else {
            this._msHover = t;
        }
        if (t && this._snapMarkShow && t.kind !== "ground") this._snapMarkShow(t.p, t.kind);
        else if (this._snapMarkHide) this._snapMarkHide();
        this._msDraw();
        this.requestRender();
    },

    _msPointerUp(e) {
        if (this._msDragPt) {
            this._msDragPt = null;
            try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) { /* synthetic */ }
        }
    },

    // ── Drawing ──────────────────────────────────────────────────────────────

    /** The lines and dots (three.js, drawn over everything) and the labels / info box (HTML). */
    _msDraw() {
        if (!this.libs || !this.scene) return;
        const { THREE } = this.libs;
        const ms = this._ms || { chains: [] };
        const segs = [], dots = [];
        ms.chains.forEach((ch, ci) => {
            ch.forEach((pt, i) => {
                dots.push(pt.p);
                if (i) segs.push(ch[i - 1].p, pt.p);
            });
            if (ms.open && ci === ms.chains.length - 1 && this._msHover && ch.length) segs.push(ch[ch.length - 1].p, this._msHover.p);
        });
        if (!this._msGroup) {
            const g = new THREE.Group();
            g.name = "measure";
            g.renderOrder = 1000;
            const lineMat = new THREE.LineBasicMaterial({ color: COLOR, depthTest: false, depthWrite: false, transparent: true, toneMapped: false, fog: false });
            const dotMat = new THREE.PointsMaterial({ color: COLOR, size: 7, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true, toneMapped: false, fog: false });
            const lines = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat);
            const pts = new THREE.Points(new THREE.BufferGeometry(), dotMat);
            for (const o of [lines, pts]) { o.renderOrder = 1000; o.raycast = () => {}; o.frustumCulled = false; o.userData.imageViewerNoShadow = true; }
            g.add(lines, pts);
            this._msGroup = g;
            this._msLines = lines;
            this._msDots = pts;
        }
        if (this._msGroup.parent !== this.scene) this.scene.add(this._msGroup);
        const set = (obj, list) => {
            obj.geometry.dispose();
            obj.geometry = new THREE.BufferGeometry().setFromPoints(list);
        };
        set(this._msLines, segs);
        set(this._msDots, dots);
        this._msGroup.visible = segs.length > 0 || dots.length > 0;
        this._msLabels();
    },

    /** The labels beside each stretch and angle, and the info box: placed every frame from _tick. */
    _msLabels() {
        if (!this.stage || !this.libs) return;
        const ms = this._ms || { chains: [] };
        const has = ms.chains.some((ch) => ch.length) || (this._msOn);
        let box = this._msBox;
        if (!has) { if (box) box.style.display = "none"; return; }
        const d = this.doc;
        if (!box || box.ownerDocument !== d) {
            box = d.createElement("div");
            box.className = "model-measure";
            const info = d.createElement("div");
            info.className = "model-measure-info";
            box.append(info);
            this._msBox = box;
            this._msInfo = info;
            this._msLabelEls = [];
        }
        if (box.parentNode !== this.stage) this.stage.append(box);
        box.style.display = "";
        // The info box: the chain being drawn, else the last one.
        const pick = ms.chains[ms.chains.length - 1];
        const pts = pick ? pick.map((pt) => pt.p.toArray()) : [];
        if (ms.open && this._msHover && pick) pts.push(this._msHover.p.toArray());
        const lines = readoutLines(pts);
        const tips = this._msOn
            ? (ms.open ? "Enter / double-click: end · Backspace: take the last point back · Esc: end" : "Click to measure · drag a point to move it · Esc: clear")
            : "";
        this._msInfo.textContent = "";
        if (this._msOn || lines.length) {
            const head = d.createElement("b");
            head.textContent = "Measure";
            this._msInfo.append(head);
            for (const l of lines) this._msInfo.append(Object.assign(d.createElement("div"), { textContent: l }));
            if (tips) this._msInfo.append(Object.assign(d.createElement("div"), { className: "tip", textContent: tips }));
            this._msInfo.style.display = "";
        } else this._msInfo.style.display = "none";
        // Labels in the stage at the stretches' middles and the corners.
        const want = [];
        ms.chains.forEach((ch, ci) => {
            const p = ch.map((pt) => pt.p.toArray());
            if (ms.open && ci === ms.chains.length - 1 && this._msHover && ch.length) p.push(this._msHover.p.toArray());
            const r = measureReadout(p);
            r.segments.forEach((s) => want.push({ at: s.mid, text: formatLength(s.length), cls: "len" }));
            r.angles.forEach((a) => want.push({ at: p[a.at], text: formatAngle(a.deg), cls: "ang" }));
        });
        this._msWanted = want;
        this._msPlace();
    },

    /** Put the labels where their points are on screen now (the camera may have moved). */
    _msPlace() {
        const box = this._msBox;
        if (!box || box.style.display === "none" || !this.libs || !this.canvas) return;
        const { THREE } = this.libs;
        const want = this._msWanted || [];
        const labels = this._msLabelEls || (this._msLabelEls = []);
        while (labels.length < want.length) {
            const el = this.doc.createElement("span");
            el.className = "model-measure-label";
            box.append(el);
            labels.push(el);
        }
        const cam = this.activeCameraObject();
        const rect = this.canvas.getBoundingClientRect();
        const sr = this.stage.getBoundingClientRect();
        labels.forEach((el, i) => {
            const w = want[i];
            const s = w && this._snapToScreen ? this._snapToScreen(new THREE.Vector3(...w.at), cam, rect) : null;
            if (!s) { el.style.display = "none"; return; }
            el.style.display = "";
            el.textContent = w.text;
            el.dataset.kind = w.cls;
            el.style.left = `${s.x - sr.left}px`;
            el.style.top = `${s.y - sr.top}px`;
        });
    },
};

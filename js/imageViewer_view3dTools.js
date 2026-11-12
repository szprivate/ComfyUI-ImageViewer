// imageViewer_view3dTools.js
// Model3DView's working tools, as Maya's viewport has them (clean-room: written
// from how the tools behave, not from any of Maya's code):
//
//   - the Display menu: switch whole kinds of things off and on in the view -
//     polygons, curves (rig controls are curves), joints, cameras, image
//     planes, splats, point clouds, the grid (Shift+1 .. Shift+8);
//   - joints drawn for every model that has bones (a line from each bone to
//     its parent and a dot at each joint), hidden inside meshes unless X-ray;
//   - the marquee: a left drag that starts on nothing (or on an object, with
//     the Select tool) draws a box and selects what it touches;
//   - framing (F): the selection, keeping the direction the camera looks in;
//   - scrubbing the timeline with K held and the left button dragged.
//
// Hidden kinds are three.js layers the viewport's camera and the picking ray
// leave out, never `visible` flags: those belong to the scene (an item's own
// eye in the outliner) and to the code that hides helpers for a render. A
// render (beginRender) sees every layer, so a shot is never missing something
// only because it was put out of the way while working.

// Layer per kind. 0 is everything else (the grid, the gizmo, the lights).
import { isPickable } from "./imageViewer_sceneLayers.js";

export const DISPLAY_KINDS = [
    { key: "polygons",    label: "Polygons",     layer: 1 },
    { key: "curves",      label: "Curves",       layer: 2, tip: "Rig controls and any lines a model brings" },
    { key: "joints",      label: "Joints",       layer: 3, tip: "The bones of every model that has a skeleton" },
    { key: "cameras",     label: "Cameras",      layer: 4 },
    { key: "imageplanes", label: "Image Planes", layer: 5 },
    { key: "splats",      label: "Splats",       layer: 6, tip: "Gaussian splats" },
    { key: "points",      label: "Point Clouds", layer: 7 },
    { key: "grid",        label: "Grid",         layer: 0 },
];

const STORE = "imageviewer.viewer.display3d";
const JOINT_COLOR = 0x5aa0ff;

/** The kind a drawable object belongs to, or "" for one left on layer 0. */
export function displayKindOf(obj, item) {
    if (!obj) return "";
    if (obj.userData && obj.userData.imageViewerJoints) return "joints";
    if (obj.userData && (obj.userData.imageViewerSplat || obj.userData.imageViewerSplatBounds)) return "splats";
    if (obj.name === "splatbounds") return "splats";
    if (obj.name === "imageplane" || (item && item.kind === "imageplane" && obj.isMesh)) return "imageplanes";
    if (obj.isCameraHelper || (obj.userData && obj.userData.imageViewerCameraHelper)) return "cameras";
    if (item && item.kind === "environment") return "";        // the sky is not an object
    if (obj.isPoints) return "points";
    if (obj.isLine) return "curves";
    if (obj.isMesh) return "polygons";
    return "";
}

/** Whether a screen rectangle (x0 < x1, y0 < y1) holds the point. */
const inRect = (r, x, y) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;

export const View3DToolsMixin = {

    // ── Display ──────────────────────────────────────────────────────────────

    /** The kinds switched off, read once from the viewer's own store. */
    _dispHidden() {
        if (!this._dispOff) {
            let saved = null;
            try { saved = JSON.parse(this.win.localStorage.getItem(STORE) || "null"); } catch (_) { saved = null; }
            this._dispOff = new Set(Array.isArray(saved && saved.off) ? saved.off : []);
            this._dispXray = !!(saved && saved.xray);
        }
        return this._dispOff;
    },

    _dispSave() {
        try {
            this.win.localStorage.setItem(STORE, JSON.stringify({ off: [...this._dispHidden()], xray: !!this._dispXray }));
        } catch (_) { /* private window: kept for this page only */ }
    },

    isDisplayed(kind) {
        if (kind === "grid") return !!this.showGrid;
        return !this._dispHidden().has(kind);
    },

    /** Switch one kind on or off (`on` undefined flips it). */
    setDisplayed(kind, on) {
        if (!DISPLAY_KINDS.some((k) => k.key === kind)) return;
        const want = on === undefined ? !this.isDisplayed(kind) : !!on;
        if (kind === "grid") { this.setGrid(want); this._dispMenuSync(); return; }
        const off = this._dispHidden();
        if (want) off.delete(kind); else off.add(kind);
        this._dispSave();
        // What is hidden cannot stay selected-for-dragging under a gizmo you cannot see.
        this._dispMenuSync();
        this.requestRender();
    },

    /** Every kind on (true) or off (false), the grid included. */
    setAllDisplayed(on) {
        for (const k of DISPLAY_KINDS) {
            if (k.key === "grid") this.setGrid(!!on);
            else if (on) this._dispHidden().delete(k.key);
            else this._dispHidden().add(k.key);
        }
        this._dispSave();
        this._dispMenuSync();
        this.requestRender();
    },

    setJointXray(on) {
        this._dispHidden();
        this._dispXray = !!on;
        this._dispSave();
        this._dispMenuSync();
        this.requestRender();
    },

    /** The layers a camera / ray may see: 0 and every kind that is on. */
    _dispMask() {
        const off = this._dispHidden();
        let mask = 1;
        for (const k of DISPLAY_KINDS) if (k.layer && !off.has(k.key)) mask |= 1 << k.layer;
        return mask;
    },

    /**
     * Before a frame of the viewport: every drawable moved onto its kind's
     * layer (new loads arrive on layer 0), the joints placed, and the camera
     * told which layers to draw. Called from _tick only; a render sees all.
     */
    _dispApply(cam) {
        const kinds = new Map(DISPLAY_KINDS.map((k) => [k.key, k.layer]));
        const sort = (obj, item) => {
            const kind = displayKindOf(obj, item);
            const layer = kind ? kinds.get(kind) : 0;
            if (obj.layers.mask !== (1 << layer)) obj.layers.set(layer);
            // Spark draws splats itself and goes by `visible`, not by layers.
            if (obj.userData && obj.userData.imageViewerSplat) {
                const want = !this._dispHidden().has("splats");
                if (obj.userData.imageViewerDispVisible === undefined) obj.userData.imageViewerDispVisible = true;
                if (obj.visible !== want && !this._rendering) obj.visible = want;
            }
        };
        for (const entry of this._entries.values()) {
            const item = entry.item;
            if (entry.root) entry.root.traverse((o) => { if (o !== entry.root) sort(o, item); });
            if (entry.helper) {
                entry.helper.userData.imageViewerCameraHelper = true;
                entry.helper.traverse((o) => sort(o, item));
            }
            // A camera's look-at target and its line go with the cameras.
            if (entry.aimViz) entry.aimViz.traverse((o) => { if (o !== entry.aimViz) sort(o, item); });
        }
        this._jointsSync();
        if (cam && cam.layers) cam.layers.mask = this._rendering ? 0xffffffff : this._dispMask();
    },

    // ── Joints ───────────────────────────────────────────────────────────────

    /**
     * One LineSegments + Points per model with bones, in world space, rebuilt
     * when the skeleton changes and re-placed every frame from the bones.
     */
    _jointsSync() {
        const { THREE } = this.libs || {};
        if (!THREE || !this.scene) return;
        if (!this._joints) this._joints = new Map();
        const show = !this._dispHidden().has("joints");
        const seen = new Set();
        if (show) this.scene.updateMatrixWorld();
        for (const [id, entry] of this._entries) {
            if (!entry.bones || !entry.bones.size || !entry.object) continue;
            seen.add(id);
            let j = this._joints.get(id);
            const bones = [...entry.bones.values()].filter((b) => b && b.isBone);
            if (!j || j.count !== bones.length || j.object !== entry.object) {
                if (j) this._jointsDrop(id);
                const pairs = bones.filter((b) => b.parent && b.parent.isBone);
                const lineGeo = new THREE.BufferGeometry();
                lineGeo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(pairs.length * 6), 3));
                const dotGeo = new THREE.BufferGeometry();
                dotGeo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(bones.length * 3), 3));
                const lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: JOINT_COLOR }));
                const dots = new THREE.Points(dotGeo, new THREE.PointsMaterial({ color: JOINT_COLOR, size: 6, sizeAttenuation: false }));
                const group = new THREE.Group();
                group.name = "joints";
                for (const o of [group, lines, dots]) {
                    o.userData.imageViewerJoints = id;
                    o.frustumCulled = false;
                    o.layers.set(3);
                }
                group.add(lines, dots);
                this.scene.add(group);
                j = { group, lines, dots, bones, pairs, count: bones.length, object: entry.object };
                this._joints.set(id, j);
            }
            const visible = show && entry.root.visible && this._shownUp(entry.root);
            j.group.visible = visible;
            if (!visible) continue;
            for (const m of [j.lines.material, j.dots.material]) {
                if (m.depthTest === !!this._dispXray) { m.depthTest = !this._dispXray; m.needsUpdate = true; }
                m.transparent = !!this._dispXray;
            }
            const v = new THREE.Vector3();
            const lp = j.lines.geometry.attributes.position;
            j.pairs.forEach((b, i) => {
                v.setFromMatrixPosition(b.parent.matrixWorld); lp.setXYZ(i * 2, v.x, v.y, v.z);
                v.setFromMatrixPosition(b.matrixWorld); lp.setXYZ(i * 2 + 1, v.x, v.y, v.z);
            });
            lp.needsUpdate = true;
            const dp = j.dots.geometry.attributes.position;
            j.bones.forEach((b, i) => { v.setFromMatrixPosition(b.matrixWorld); dp.setXYZ(i, v.x, v.y, v.z); });
            dp.needsUpdate = true;
            j.lines.geometry.computeBoundingSphere();
            j.dots.geometry.computeBoundingSphere();
        }
        for (const id of [...this._joints.keys()]) if (!seen.has(id)) this._jointsDrop(id);
    },

    _jointsDrop(id) {
        const j = this._joints && this._joints.get(id);
        if (!j) return;
        this.scene.remove(j.group);
        for (const o of [j.lines, j.dots]) { o.geometry.dispose(); o.material.dispose(); }
        this._joints.delete(id);
    },

    /** Whether nothing above `obj` is hidden. */
    _shownUp(obj) {
        for (let o = obj; o; o = o.parent) if (!o.visible) return false;
        return true;
    },

    // ── The Display menu ─────────────────────────────────────────────────────

    _dispBuildButton(el) {
        const btn = el("button", "model-btn model-display-btn", "Display ▾");
        btn.title = "Show / hide kinds of things in the view (Shift+1 .. Shift+8)";
        btn.onclick = (e) => { e.stopPropagation(); this.toggleDisplayMenu(); };
        return btn;
    },

    toggleDisplayMenu(open) {
        if (!this.root || !this.ui) return;
        const was = !!this._dispMenu;
        const want = open === undefined ? !was : !!open;
        if (was) { this._dispMenu.remove(); this._dispMenu = null; this._dispMenuOff && this._dispMenuOff(); }
        if (!want) return;
        const d = this.doc;
        const menu = d.createElement("div");
        menu.className = "model-display-menu";
        menu.addEventListener("pointerdown", (e) => e.stopPropagation());
        const rows = [];
        const row = (label, tip, isOn, flip, hotkey) => {
            const r = d.createElement("label");
            r.className = "model-display-row";
            if (tip) r.title = tip;
            const box = d.createElement("input");
            box.type = "checkbox";
            const text = d.createElement("span");
            text.textContent = label;
            r.append(box, text);
            if (hotkey) {
                const k = d.createElement("span");
                k.className = "model-display-key";
                k.textContent = hotkey;
                r.append(k);
            }
            box.onchange = () => { flip(box.checked); };
            rows.push(() => { box.checked = isOn(); });
            menu.append(r);
            return box;
        };
        const allOn = () => DISPLAY_KINDS.every((k) => this.isDisplayed(k.key));
        const all = row("All", "Every kind on / off", allOn, (on) => this.setAllDisplayed(on));
        all.dataset.kind = "all";
        menu.append(Object.assign(d.createElement("div"), { className: "model-display-sep" }));
        DISPLAY_KINDS.forEach((k, i) => {
            const box = row(k.label, k.tip || "", () => this.isDisplayed(k.key), (on) => this.setDisplayed(k.key, on), `Shift+${i + 1}`);
            box.dataset.kind = k.key;
        });
        menu.append(Object.assign(d.createElement("div"), { className: "model-display-sep" }));
        const xr = row("X-Ray Joints", "Joints drawn through the meshes around them",
                       () => !!this._dispXray, (on) => this.setJointXray(on));
        xr.dataset.kind = "xray";
        menu._sync = () => rows.forEach((r) => r());
        menu._sync();
        this.ui.look.append(menu);
        this._dispMenu = menu;
        this._dispMenuSync();
        const win = this.win;
        const close = (e) => {
            const path = e.composedPath ? e.composedPath() : [e.target];
            if (path.includes(menu) || path.includes(this.ui.displayBtn)) return;
            if (e.type === "keydown" && e.key !== "Escape") return;
            this.toggleDisplayMenu(false);
        };
        win.addEventListener("pointerdown", close, true);
        win.addEventListener("keydown", close, true);
        this._dispMenuOff = () => {
            win.removeEventListener("pointerdown", close, true);
            win.removeEventListener("keydown", close, true);
            this._dispMenuOff = null;
        };
    },

    _dispMenuSync() {
        if (this._dispMenu && this._dispMenu._sync) this._dispMenu._sync();
        if (this.ui && this.ui.displayBtn) {
            const some = DISPLAY_KINDS.some((k) => !this.isDisplayed(k.key));
            this.ui.displayBtn.classList.toggle("partial", some);
        }
    },

    // ── Framing (F) ──────────────────────────────────────────────────────────

    /**
     * Frame the given items, keeping the direction the camera looks from (as
     * Maya's F): the view slides and dollies until their bounds fill it.
     * Nothing to frame: false, and nothing moves.
     */
    frameItems(ids) {
        if (!this.libs || !this.controls) return false;
        const { THREE } = this.libs;
        const box = new THREE.Box3();
        const v = new THREE.Vector3();
        for (const id of ids || []) {
            const entry = this._entries.get(id);
            if (!entry) continue;
            if (entry.camera) { box.expandByPoint(entry.camera.getWorldPosition(v)); continue; }
            const before = box.clone();
            box.expandByObject(entry.root);
            if (box.equals(before)) box.expandByPoint(entry.root.getWorldPosition(v));
        }
        if (box.isEmpty()) return false;
        if (this._paneOrthoActive()) return this._paneFrameOrtho(box);
        const center = box.getCenter(new THREE.Vector3());
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        const radius = Math.max(sphere.radius, 0.05);
        const cam = this.activeCameraObject();
        const dir = cam.getWorldPosition(new THREE.Vector3()).sub(this.controls.target);
        if (dir.lengthSq() < 1e-12) dir.set(1, 1, 1);
        dir.normalize();
        const fov = (cam.fov || 35) * Math.PI / 180;
        const fit = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * (cam.aspect || 1)));
        const distance = (radius / Math.sin(fit / 2)) * 1.1;
        cam.position.copy(center).addScaledVector(dir, distance);
        cam.near = Math.min(cam.near, Math.max(1e-4, distance / 1000));
        cam.far = Math.max(cam.far, distance * 100);
        cam.lookAt(center);
        cam.updateProjectionMatrix();
        this._target = center.clone();
        this.controls.target.copy(center);
        this.controls.update();
        if (cam !== this.camera && this.hooks.onCameraMoved) {
            const moved = this._entries.get(this.scene3d.activeCamera);
            this.hooks.onCameraMoved(this.scene3d.activeCamera, this.readTransform(cam, moved && moved.item));
        }
        this.requestRender();
        return true;
    },

    // ── The marquee ──────────────────────────────────────────────────────────

    /**
     * A left press without Alt: the start of a box, unless a gizmo handle is
     * under the pointer (it takes the drag) or, with a move / rotate / scale
     * tool, an object is (a click on it selects; Maya's tools drag the box
     * from empty space only). The Select tool boxes from anywhere.
     */
    _mqDown(e) {
        if (e.button !== 0 || e.altKey || this._walk || this._placingNote) return false;
        if (this.gizmo && this.gizmo.object && this.gizmo.axis && this.gizmoMode !== "select") return false;
        // A camera's look-at target has a gizmo of its own, in every tool (imageViewer_cameraAim3d.js).
        if (this._aimGizmoHot && this._aimGizmoHot()) return false;
        if (this.gizmoMode !== "select" && this._pick(e)) return false;
        const rect = this.canvas.getBoundingClientRect();
        this._mq = { x: e.clientX, y: e.clientY, rect, id: e.pointerId, box: null,
                     mode: e.ctrlKey || e.metaKey ? (e.shiftKey ? "add" : "remove") : e.shiftKey ? "toggle" : "replace" };
        const win = this.win;
        const move = (ev) => this._mqMove(ev);
        const up = (ev) => { win.removeEventListener("pointermove", move, true); win.removeEventListener("pointerup", up, true); this._mqUp(ev); };
        win.addEventListener("pointermove", move, true);
        win.addEventListener("pointerup", up, true);
        return true;
    },

    _mqMove(e) {
        const m = this._mq;
        if (!m) return;
        if (!m.box) {
            if (Math.abs(e.clientX - m.x) <= 3 && Math.abs(e.clientY - m.y) <= 3) return;
            m.box = this.doc.createElement("div");
            m.box.className = "model-marquee";
            this.root.append(m.box);
        }
        const host = this.root.getBoundingClientRect();
        const x0 = Math.min(m.x, e.clientX), x1 = Math.max(m.x, e.clientX);
        const y0 = Math.min(m.y, e.clientY), y1 = Math.max(m.y, e.clientY);
        Object.assign(m.box.style, { left: `${x0 - host.left}px`, top: `${y0 - host.top}px`,
                                     width: `${x1 - x0}px`, height: `${y1 - y0}px` });
    },

    _mqUp(e) {
        const m = this._mq;
        this._mq = null;
        if (!m || !m.box) return;
        m.box.remove();
        // The pointer-up that ends a box is no click: _onPointerUp must not pick.
        this._mqJustBoxed = true;
        const r = m.rect;
        const box = {
            x0: Math.min(m.x, e.clientX) - r.left, x1: Math.max(m.x, e.clientX) - r.left,
            y0: Math.min(m.y, e.clientY) - r.top, y1: Math.max(m.y, e.clientY) - r.top,
        };
        const ids = this.idsInRect(box);
        if (this.hooks.onMarquee) this.hooks.onMarquee(ids, m.mode);
    },

    /**
     * The scene items with something drawn inside `r` (canvas pixels, from
     * the top left). An item counts when a vertex of it lies inside, or when
     * its surface is under one of a grid of points across the box - so a
     * plane bigger than the box, with no corner in it, is caught too.
     */
    idsInRect(r) {
        if (!this.libs || !this.canvas) return [];
        const { THREE } = this.libs;
        const cam = this.activeCameraObject();
        const W = this.canvas.clientWidth || this.canvas.getBoundingClientRect().width;
        const H = this.canvas.clientHeight || this.canvas.getBoundingClientRect().height;
        cam.updateMatrixWorld();
        this.scene.updateMatrixWorld();
        const mask = this._dispMask();
        const v = new THREE.Vector3();
        const toScreen = (p) => {
            v.copy(p).project(cam);
            if (v.z < -1 || v.z > 1) return null;
            return [(v.x + 1) / 2 * W, (1 - v.y) / 2 * H];
        };
        const lookingThrough = this.scene3d && this.scene3d.activeCamera;
        const found = new Set();
        const candidates = [];
        for (const [id, entry] of this._entries) {
            const item = entry.item;
            if (!item || item.kind === "group" || id === lookingThrough) continue;
            // A template or reference layer's items are not picked, by a box either.
            if (this._layerStates && !isPickable(this._layerStates, id)) continue;
            if (entry.isControl ? !(entry.root.visible && this._shownUp(entry.root)) : !this._shownUp(entry.root)) continue;
            const drawn = [];
            const take = (o) => {
                if (!(o.isMesh || o.isLine || o.isPoints)) return;
                if (o.layers.mask && !(o.layers.mask & mask)) return;
                if (!o.visible && o.name !== "splatbounds" && !(o.userData && o.userData.imageViewerSplatBounds)) return;
                if (!o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
                drawn.push(o);
            };
            entry.root.traverse(take);
            if (entry.helper && entry.helper.visible) take(entry.helper);
            if (!drawn.length) continue;
            candidates.push([id, drawn]);
        }
        const p = new THREE.Vector3();
        for (const [id, drawn] of candidates) {
            let hit = false;
            for (const o of drawn) {
                const pos = o.geometry.attributes.position;
                const n = pos.count;
                const stride = Math.max(1, Math.floor(n / 20000));
                for (let i = 0; i < n && !hit; i += stride) {
                    p.fromBufferAttribute(pos, i);
                    if (o.isSkinnedMesh && o.applyBoneTransform) o.applyBoneTransform(i, p);
                    p.applyMatrix4(o.matrixWorld);
                    const s = toScreen(p);
                    if (s && inRect(r, s[0], s[1])) hit = true;
                }
                if (hit) break;
            }
            if (hit) found.add(id);
        }
        // Surfaces across the box: a 7 x 7 grid of rays.
        const ray = new THREE.Raycaster();
        ray.layers.mask = mask;
        const roots = candidates.map(([, drawn]) => drawn).flat();
        const idOf = (o) => {
            for (let n = o; n; n = n.parent) if (n.userData && n.userData.imageViewerItemId) return n.userData.imageViewerItemId;
            return null;
        };
        const ndc = new THREE.Vector2();
        for (let gy = 0; gy <= 6; gy++) {
            for (let gx = 0; gx <= 6; gx++) {
                const x = r.x0 + (r.x1 - r.x0) * gx / 6, y = r.y0 + (r.y1 - r.y0) * gy / 6;
                ndc.set(x / W * 2 - 1, -(y / H) * 2 + 1);
                ray.setFromCamera(ndc, cam);
                for (const h of ray.intersectObjects(roots.filter((o) => o.isMesh), false)) {
                    const id = idOf(h.object);
                    if (id) { found.add(id); break; }
                }
            }
        }
        // In the order the scene lists them, so a selection reads the same every time.
        return [...this._entries.keys()].filter((id) => found.has(id)
            && !(this._layerStates && !isPickable(this._layerStates, id)));
    },

    // ── Scrubbing with K ─────────────────────────────────────────────────────

    /** K held + left drag: the timeline follows the pointer, the view's width = the range. */
    _kscrubDown(e) {
        if (e.button !== 0 || !this.hooks.scrubHeld || !this.hooks.scrubHeld()) return false;
        const start = this.hooks.onScrubStart ? this.hooks.onScrubStart() : null;
        if (!start) return false;
        const width = this.canvas.getBoundingClientRect().width || 1;
        const x0 = e.clientX;
        const win = this.win;
        const move = (ev) => {
            const frames = (ev.clientX - x0) / width * Math.max(1, start.span);
            if (this.hooks.onScrub) this.hooks.onScrub(start.frame + frames);
        };
        const up = () => {
            win.removeEventListener("pointermove", move, true);
            win.removeEventListener("pointerup", up, true);
            this.root.classList.remove("scrubbing");
            this._kscrubbing = false;
        };
        this._kscrubbing = true;
        this.root.classList.add("scrubbing");
        win.addEventListener("pointermove", move, true);
        win.addEventListener("pointerup", up, true);
        return true;
    },
};

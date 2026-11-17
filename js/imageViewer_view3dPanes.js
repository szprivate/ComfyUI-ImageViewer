// imageViewer_view3dPanes.js
// The 3D view as several views at once, as Houdini's viewport layouts: one
// view, two side by side or stacked, one big and two small, or four. Each pane
// shows a perspective view (the free camera, or the scene camera looked
// through) or a flat one - top, front, right, left, back, bottom - and has a
// menu of its own at its top right; the dividers are dragged to size them.
//
// One WebGL canvas covers the stage and every pane is drawn into its own part
// of it (viewport + scissor). The pane under the mouse is the ACTIVE one: it
// takes the gizmo, the wheel, picking, the marquee and F. Everything that
// turns a pointer into a ray reads the canvas's rect, so while several panes
// are up the canvas answers getBoundingClientRect / clientWidth / clientHeight
// with the active pane's box (`_paneHookCanvas`) - the orbit controls, the
// gizmo and the view's own picking then work in that pane unchanged.
//
// A flat view does not tumble: Alt + left pans it, the wheel zooms it.
//
// Several perspective views (Sebastian 2026-11-17): besides "persp" - the
// free camera, or the scene camera looked through - "persp2" .. "persp4" are
// perspective views of their own, each with its own free camera, or looking
// through a scene camera of its own (the pane menu's Look through, or a
// camera dragged from the Outliner onto the pane). Each pane also has its own
// shading (`shading[slot]`): the toolbar's Shading, the View menu and the keys
// set the ACTIVE pane's, the pane menu any pane's. Path traced shading traces
// one pane at a time (the active one when it is path traced, else the one it
// traced last), the others draw raster.
// Clean-room: written from how the layouts behave, no code from any program.

const KEY = "imageviewer.viewer.view3dPanes";

export const PANE_VIEWS = [
    ["persp", "Perspective"],
    ["persp2", "Perspective 2"],
    ["persp3", "Perspective 3"],
    ["persp4", "Perspective 4"],
    ["top", "Top"],
    ["front", "Front"],
    ["right", "Right"],
    ["left", "Left"],
    ["back", "Back"],
    ["bottom", "Bottom"],
];

// Where a flat view's camera stands (from the target) and which way is up on screen.
const ORTHO = {
    top:    { dir: [0, 1, 0],  up: [0, 0, -1] },
    bottom: { dir: [0, -1, 0], up: [0, 0, 1] },
    front:  { dir: [0, 0, 1],  up: [0, 1, 0] },
    back:   { dir: [0, 0, -1], up: [0, 1, 0] },
    right:  { dir: [1, 0, 0],  up: [0, 1, 0] },
    left:   { dir: [-1, 0, 0], up: [0, 1, 0] },
};

export const PANE_LAYOUTS = [
    ["single", "One view"],
    ["2h", "Two side by side"],
    ["2v", "Two stacked"],
    ["3", "One big, two small"],
    ["quad", "Four views"],
];

const SLOTS = { single: 1, "2h": 2, "2v": 2, "3": 3, quad: 4 };

/** Whether a view kind is a perspective one ("persp", "persp2" ...). Pure. */
export const isPerspKind = (kind) => /^persp\d?$/.test(String(kind || ""));

/** The perspective views that have a camera of their own (not the scene's free camera). */
export const EXTRA_PERSP = ["persp2", "persp3", "persp4"];

// Where an extra perspective view looks from at first, from the scene's middle.
const PERSP_FROM = { persp2: [-1, 0.55, 1], persp3: [1, 0.55, -1], persp4: [-1, 0.55, -1] };

const finite3 = (v) => Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(Number(x)));
const GAP = 2;      // px between panes: the divider you drag

/**
 * The panes of a layout inside a stage of W x H, as {slot, x, y, w, h} in
 * stage pixels from its top left. `split` = [x share, y share]. Pure.
 */
export function paneRects(layout, split, W, H, focus = 0) {
    const sx = Math.min(0.9, Math.max(0.1, Number(split && split[0]) || 0.5));
    const sy = Math.min(0.9, Math.max(0.1, Number(split && split[1]) || 0.5));
    const xw = Math.round(W * sx), yh = Math.round(H * sy);
    const g = GAP / 2;
    const L = (x) => Math.max(0, x);
    switch (layout) {
    case "2h": return [
        { slot: 0, x: 0, y: 0, w: L(xw - g), h: H },
        { slot: 1, x: xw + g, y: 0, w: L(W - xw - g), h: H }];
    case "2v": return [
        { slot: 0, x: 0, y: 0, w: W, h: L(yh - g) },
        { slot: 1, x: 0, y: yh + g, w: W, h: L(H - yh - g) }];
    case "3": return [
        { slot: 0, x: 0, y: 0, w: L(xw - g), h: H },
        { slot: 1, x: xw + g, y: 0, w: L(W - xw - g), h: L(yh - g) },
        { slot: 2, x: xw + g, y: yh + g, w: L(W - xw - g), h: L(H - yh - g) }];
    case "quad": return [
        { slot: 0, x: 0, y: 0, w: L(xw - g), h: L(yh - g) },
        { slot: 1, x: xw + g, y: 0, w: L(W - xw - g), h: L(yh - g) },
        { slot: 2, x: 0, y: yh + g, w: L(xw - g), h: L(H - yh - g) },
        { slot: 3, x: xw + g, y: yh + g, w: L(W - xw - g), h: L(H - yh - g) }];
    default: return [{ slot: focus, x: 0, y: 0, w: W, h: H }];
    }
}

/**
 * The state as it is kept, made whole. Pure. `modes`: the shading modes there
 * are (a pane's shading is kept only when it is one of them; null = not set).
 * `shading[slot]`: a pane's shading; `through[kind]`: the scene camera an extra
 * perspective view looks through; `cams[kind]`: where its own camera stands.
 */
export function cleanPaneState(s, modes = null) {
    const kinds = PANE_VIEWS.map(([k]) => k);
    const out = { layout: "single", split: [0.5, 0.5], views: ["top", "persp", "front", "right"], focus: 1,
                  shading: [null, null, null, null], through: {}, cams: {} };
    if (!s || typeof s !== "object") return out;
    if (Array.isArray(s.shading) && s.shading.length === 4) {
        out.shading = s.shading.map((m) => (typeof m === "string" && (!modes || modes.includes(m)) ? m : null));
    }
    if (s.through && typeof s.through === "object") {
        for (const k of EXTRA_PERSP) {
            const id = s.through[k];
            if (typeof id === "string" && id && id.length < 200) out.through[k] = id;
        }
    }
    if (s.cams && typeof s.cams === "object") {
        for (const k of EXTRA_PERSP) {
            const c = s.cams[k];
            if (!c || !finite3(c.position) || !finite3(c.target)) continue;
            out.cams[k] = { position: c.position.map(Number), target: c.target.map(Number) };
            if (Number.isFinite(Number(c.fov)) && c.fov > 1 && c.fov < 179) out.cams[k].fov = Number(c.fov);
        }
    }
    if (SLOTS[s.layout]) out.layout = s.layout;
    if (Array.isArray(s.split) && s.split.length === 2) {
        out.split = s.split.map((v) => Math.min(0.9, Math.max(0.1, Number(v) || 0.5)));
    }
    if (Array.isArray(s.views) && s.views.length === 4 && s.views.every((v) => kinds.includes(v))
        && new Set(s.views).size === 4) out.views = s.views.slice();
    if (!out.views.includes("persp")) out.views[0] = "persp";
    if (Number.isInteger(s.focus) && s.focus >= 0 && s.focus < 4) out.focus = s.focus;
    return out;
}

/**
 * The perspective view a camera dropped on pane `slot` goes into: the pane's
 * own when it is a perspective one, else the first extra perspective view not
 * on screen (`shown`: the views of the panes on screen), else "persp2". Pure.
 */
export function perspForDrop(views, slot, shown) {
    if (isPerspKind(views[slot])) return views[slot];
    return EXTRA_PERSP.find((k) => !shown.includes(k)) || EXTRA_PERSP[0];
}

/** Show `kind` in `slot`: a view is in one pane only, so the pane that had it takes this one's. Pure. */
export function setSlotView(views, slot, kind) {
    const out = views.slice();
    const had = out.indexOf(kind);
    if (had >= 0) out[had] = out[slot];
    out[slot] = kind;
    return out;
}

// The orientation axes (Blender's navigation gizmo): +X red, +Y green, +Z
// blue as labelled balls, the negative ends as faint ones, turned with the
// pane's camera. A click on a ball looks along that axis; a drag tumbles.
const AXES = [
    ["x", [1, 0, 0], "#f0425c"], ["y", [0, 1, 0], "#7fc93a"], ["z", [0, 0, 1], "#3d8bf2"],
    ["-x", [-1, 0, 0], "#f0425c"], ["-y", [0, -1, 0], "#7fc93a"], ["-z", [0, 0, -1], "#3d8bf2"],
];
const AXES_SIZE = 84, AXES_R = 28;
// The flat view a click on a ball turns a flat pane into.
const AXIS_VIEW = { x: "right", "-x": "left", y: "top", "-y": "bottom", z: "front", "-z": "back" };

/** Where each axis end lands on the gizmo for a camera turned by quaternion q (x, y, z, w), back to front. Pure. */
export function axesLayout(q, size = AXES_SIZE, R = AXES_R) {
    // The inverse turn takes world directions into the camera's frame.
    const [x, y, z, w] = [-q[0], -q[1], -q[2], q[3]];
    const rot = (v) => {
        const [vx, vy, vz] = v;
        const ix = w * vx + y * vz - z * vy, iy = w * vy + z * vx - x * vz;
        const iz = w * vz + x * vy - y * vx, iw = -x * vx - y * vy - z * vz;
        return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z,
                iz * w + iw * -z + ix * -y - iy * -x];
    };
    const c = size / 2;
    return AXES.map(([id, v, color]) => {
        const r = rot(v);
        return { id, color, x: c + r[0] * R, y: c - r[1] * R, depth: r[2], neg: id[0] === "-" };
    }).sort((a, b) => a.depth - b.depth);
}

export const View3DPanesMixin = {

    // ── State ────────────────────────────────────────────────────────────────

    _paneState() {
        if (!this._panes) {
            let saved = null;
            try { saved = JSON.parse(this.win.localStorage.getItem(KEY) || "null"); } catch (_) { /* none */ }
            const modes = this.materialModes ? this.materialModes().map(([m]) => m) : null;
            const s = this._panes = cleanPaneState(saved, modes);
            s.active = s.focus;
            // Each pane's shading: what it had, else the viewer's. One view on its own
            // starts as the Settings say, as it always did.
            s.shading = s.shading.map((m) => m || this.materialMode);
            if (s.layout === "single") s.shading[s.focus] = this.materialMode;
            else if (s.shading[s.active] !== this.materialMode) {
                // Made before anything is drawn (_buildDom): the looks go on as the meshes come.
                this.materialMode = s.shading[s.active];
            }
        }
        return this._panes;
    },

    _paneSave() {
        const s = this._paneState();
        this._paneKeepCams();
        try {
            this.win.localStorage.setItem(KEY, JSON.stringify({ layout: s.layout, split: s.split, views: s.views, focus: s.focus,
                                                                shading: s.shading, through: s.through, cams: s.cams }));
        } catch (_) { /* private window */ }
    },

    /** Where the extra perspective views' own cameras stand, into the state (kept with it). */
    _paneKeepCams() {
        const s = this._paneState();
        if (!this._paneCams || !this.controls) return;
        const kind = this.paneActiveKind();
        if (this._paneCams[kind] && this.controls.object === this._paneCams[kind].cam) this._paneCams[kind].target.copy(this.controls.target);
        for (const k of EXTRA_PERSP) {
            const c = this._paneCams[k];
            if (!c) continue;
            s.cams[k] = { position: c.cam.position.toArray(), target: c.target.toArray(), fov: c.cam.fov };
        }
    },

    /** The navigation ended in an extra perspective view: keep where its camera stands. */
    _paneCamMoved() {
        if (EXTRA_PERSP.includes(this.paneActiveKind()) && !this.paneThroughId()) this._paneSave();
    },

    /**
     * The scene camera the pane showing `kind` looks through (the active pane's by
     * default), or null: the free camera, a flat view, or a camera that is gone.
     */
    paneThroughId(kind = this.paneActiveKind()) {
        if (this._walk) return null;
        if (kind === "persp") return (this.scene3d && this.scene3d.activeCamera) || null;
        if (!EXTRA_PERSP.includes(kind)) return null;
        const id = this._paneState().through[kind];
        const entry = id && this._entries && this._entries.get(id);
        return entry && entry.camera ? id : null;
    },

    /** The shading of pane `slot`. */
    paneShading(slot) {
        const s = this._paneState();
        return s.shading[slot] || this.materialMode;
    },

    /** Set pane `slot`'s shading; the active pane's is the viewer's own (setMaterialMode). */
    setPaneShading(slot, mode) {
        const s = this._paneState();
        if (slot === s.active) { this.setMaterialMode(mode); return; }
        if (this.materialModes && !this.materialModes().some(([m]) => m === mode)) return;
        s.shading[slot] = mode;
        this._paneSave();
        if (mode === "pathtraced" && this._ptModeChanged) this._ptModeChanged();
        // The "Path traced" note goes when no pane is traced any more.
        if (this._ptBadge) this._ptBadge();
        this._panePlace();
        this.requestRender();
    },

    /** Called by setMaterialMode: the active pane takes the mode. */
    _paneShadeSet(mode) {
        const s = this._paneState();
        if (s.shading[s.active] === mode) return;
        s.shading[s.active] = mode;
        this._paneSave();
        this._panePlace();
    },

    /** Put `mode`'s look on every mesh (for drawing one pane); cheap when it is on already. */
    _paneLook(mode) {
        if ((this._lookApplied || this.materialMode) === mode || !this._originals) return;
        for (const [mesh, original] of this._originals) this._lookOn(mesh, original, mode);
        this._lookApplied = mode;
    },

    /**
     * The pane path traced shading traces now, or -1: the active pane when it is
     * path traced, else the one traced last while it still is, else the first.
     */
    _paneTracedSlot() {
        const s = this._paneState();
        const on = this._paneRects().filter((p) => p.w >= 2 && p.h >= 2).map((p) => p.slot);
        const traced = (slot) => on.includes(slot) && this.paneShading(slot) === "pathtraced";
        if (traced(s.active)) return (this._ptPane = s.active);
        if (Number.isInteger(this._ptPane) && traced(this._ptPane)) return this._ptPane;
        const first = on.find(traced);
        return (this._ptPane = first === undefined ? -1 : first);
    },

    /**
     * Let pane `slot` look through scene camera `id` (null: its own free camera).
     * A flat pane becomes a perspective view for it; the main perspective view
     * looks through it as Look through does (the scene's camera, hooks.onLookThrough).
     */
    paneLookThrough(slot, id) {
        const s = this._paneState();
        const entry = id ? this._entries.get(id) : null;
        if (id && !(entry && entry.camera)) return false;
        const shown = this._paneRects().map((p) => p.kind);
        const kind = perspForDrop(s.views, slot, shown);
        if (s.views[slot] !== kind) this.setPaneView(slot, kind);
        this._paneActivate(slot);
        if (kind === "persp") {
            if (this.hooks.onLookThrough) this.hooks.onLookThrough(id || null);
            else this.setActiveCamera(id || null);
        } else {
            if (id) s.through[kind] = id;
            else delete s.through[kind];
            this._paneSave();
            this._paneBindControls();
        }
        this._panePlace();
        this.requestRender();
        return true;
    },

    /** The view in the active pane: "persp", "top", ... */
    paneActiveKind() {
        const s = this._paneState();
        return s.views[s.active] || "persp";
    },

    /** The active pane is a flat view (top, front ...). */
    _paneOrthoActive() {
        return !this._walk && !this._rendering && !isPerspKind(this.paneActiveKind());
    },

    /** The active pane draws through a camera of its own (a flat view, an extra perspective view). */
    _paneOwnCamActive() {
        return !this._walk && !this._rendering && this.paneActiveKind() !== "persp";
    },

    /** The panes on screen now, with their view. */
    _paneRects() {
        const s = this._paneState();
        const W = Math.max(1, this.stage ? this.stage.clientWidth : 1);
        const H = Math.max(1, this.stage ? this.stage.clientHeight : 1);
        return paneRects(s.layout, s.split, W, H, s.focus).map((r) => ({ ...r, kind: s.views[r.slot] }));
    },

    /** One perspective view filling the stage: the plain case, drawn as before (bloom and all). */
    _panePlain() {
        const s = this._paneState();
        return this._walk || (s.layout === "single" && s.views[s.focus] === "persp");
    },

    // ── Cameras ──────────────────────────────────────────────────────────────

    /** The camera of a flat view, made on first use and framed on the scene. */
    _paneOrtho(kind) {
        if (!this._paneCams) this._paneCams = {};
        let c = this._paneCams[kind];
        if (c) return c;
        const { THREE } = this.libs;
        const spec = ORTHO[kind];
        const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1e5);
        cam.up.set(...spec.up);
        c = { cam, target: new THREE.Vector3(), half: 5, dir: new THREE.Vector3(...spec.dir) };
        this._paneCams[kind] = c;
        const box = new THREE.Box3();
        const subject = this._sceneBoundsSubject && this._sceneBoundsSubject();
        if (subject) box.setFromObject(subject);
        if (box.isEmpty()) box.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1));
        this._paneFrameOrtho(box, kind, 16 / 9);
        return c;
    },

    /**
     * The own camera of an extra perspective view: made on first use, where it
     * stood last time or framed on the scene from its own side.
     */
    _panePersp(kind) {
        if (!this._paneCams) this._paneCams = {};
        let c = this._paneCams[kind];
        if (c) return c;
        const { THREE } = this.libs;
        const base = this.camera;
        const cam = new THREE.PerspectiveCamera(base ? base.fov : 35, 1, base ? base.near : 0.01, base ? base.far : 1e5);
        c = { cam, target: new THREE.Vector3(), persp: true };
        this._paneCams[kind] = c;
        const kept = this._paneState().cams[kind];
        if (kept) {
            cam.position.fromArray(kept.position);
            c.target.fromArray(kept.target);
            if (kept.fov) cam.fov = kept.fov;
            cam.far = Math.max(cam.far, cam.position.distanceTo(c.target) * 100);
            cam.lookAt(c.target);
        } else {
            const box = new THREE.Box3();
            const subject = this._sceneBoundsSubject && this._sceneBoundsSubject();
            if (subject) box.setFromObject(subject);
            if (box.isEmpty()) box.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1));
            const size = box.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z) || 1;
            const center = box.getCenter(new THREE.Vector3());
            const dir = new THREE.Vector3(...(PERSP_FROM[kind] || [1, 0.55, 1])).normalize();
            cam.position.copy(center).addScaledVector(dir, maxDim * 2.4);
            cam.near = Math.min(0.01, maxDim / 1000);
            cam.far = Math.max(10000, maxDim * 100);
            c.target.copy(center);
            cam.lookAt(center);
        }
        cam.updateProjectionMatrix();
        return c;
    },

    /** The camera a pane draws through. */
    _paneCamera(kind) {
        if (kind === "persp") return this._perspCameraObject();
        if (EXTRA_PERSP.includes(kind)) {
            const id = this.paneThroughId(kind);
            return id ? this._entries.get(id).camera : this._panePersp(kind).cam;
        }
        return this._paneOrtho(kind).cam;
    },

    /** Where the orbit controls circle in the pane showing `kind`. */
    _paneTarget(kind) {
        if (kind === "persp") return this._perspTarget || this.controls.target;
        if (EXTRA_PERSP.includes(kind)) {
            const id = this.paneThroughId(kind);
            if (id) {
                // Looking through a scene camera: in front of it, as Look through puts it.
                const { THREE } = this.libs;
                const entry = this._entries.get(id);
                if (entry.aimTarget) return entry.aimTarget.clone();
                const cam = entry.camera;
                const pos = cam.getWorldPosition(new THREE.Vector3());
                const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
                const d = Math.max(1, this.controls.target.distanceTo(pos));
                return pos.addScaledVector(fwd, d);
            }
            return this._panePersp(kind).target;
        }
        return this._paneOrtho(kind).target;
    },

    /** Remember where the controls circle for the view `kind` before they go to another pane. */
    _paneKeepTarget(kind) {
        if (!this.controls) return;
        if (kind === "persp") this._perspTarget = this.controls.target.clone();
        else if (this._paneCams && this._paneCams[kind] && !this.paneThroughId(kind)) this._paneCams[kind].target.copy(this.controls.target);
    },

    /** A pane's name on its label: the camera it looks through, Persp, Persp 2, Top ... */
    _paneName(kind) {
        if (isPerspKind(kind)) {
            const id = this.paneThroughId(kind);
            const entry = id && this._entries.get(id);
            if (entry && entry.item) return entry.item.name;
            return kind === "persp" ? "Persp" : `Persp ${kind.slice(5)}`;
        }
        return (PANE_VIEWS.find(([k]) => k === kind) || [kind, kind])[1];
    },

    /** Fit a flat view onto `box` (keeps its direction). */
    _paneFrameOrtho(box, kind = this.paneActiveKind(), aspect = null) {
        const { THREE } = this.libs;
        const c = this._paneOrtho(kind);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const up = c.cam.up.clone();
        const right = new THREE.Vector3().crossVectors(up, c.dir).normalize();
        const absDot = (a, b) => Math.abs(a.x) * b.x + Math.abs(a.y) * b.y + Math.abs(a.z) * b.z;
        const hu = absDot(up, size) / 2, hr = absDot(right, size) / 2;
        if (aspect === null) {
            const r = this._paneRects().find((p) => p.kind === kind);
            aspect = r && r.h ? r.w / r.h : 16 / 9;
        }
        c.half = Math.max(0.05, Math.max(hu, hr / aspect) * 1.15);
        const reach = Math.max(size.x, size.y, size.z, 1);
        c.target.copy(center);
        c.cam.position.copy(center).addScaledVector(c.dir, reach * 20);
        c.cam.near = 0.01;
        c.cam.far = reach * 60;
        c.cam.zoom = 1;
        c.cam.lookAt(center);
        c.cam.updateProjectionMatrix();
        if (this.controls && this.controls.object === c.cam) {
            this.controls.target.copy(center);
            this.controls.update();
        }
        this.requestRender();
        return true;
    },

    /** Size a pane's camera to the pane it is drawn in. */
    _paneFitCam(cam, kind, w, h) {
        const aspect = h > 0 ? w / h : 1;
        if (cam.isOrthographicCamera) {
            const half = this._paneOrtho(kind).half;
            cam.left = -half * aspect; cam.right = half * aspect;
            cam.top = half; cam.bottom = -half;
        } else {
            cam.aspect = aspect;
        }
        cam.updateProjectionMatrix();
    },

    // ── The active pane ──────────────────────────────────────────────────────

    /** Make `slot` the pane the mouse works in: the controls and the gizmo go over to its camera. */
    _paneActivate(slot) {
        const s = this._paneState();
        if (slot === s.active || slot < 0) return;
        const before = this.paneActiveKind();
        this._paneKeepTarget(before);
        s.active = slot;
        if (s.layout !== "single") s.focus = slot;
        // The viewer's shading is the active pane's.
        const mode = this.paneShading(slot);
        if (mode !== this.materialMode && this.setMaterialMode) this.setMaterialMode(mode);
        this._paneBindControls();
        this._panePlace();
    },

    /** Point the orbit controls and the gizmo at the active pane's camera. */
    _paneBindControls() {
        if (!this.controls || !this.libs) return;
        const kind = this.paneActiveKind();
        const cam = this.activeCameraObject();
        const target = this._paneTarget(kind);
        this.controls.object = cam;
        this.controls.target.copy(target);
        this.controls.enableRotate = isPerspKind(kind);
        this.controls.update();
        this._paneGizmoFit(cam, this._paneActiveBox());
        this._applyNavButtons(false);
        this.requestRender();
    },

    /** The pane (slot) under a client point, or -1. */
    _paneAt(x, y) {
        if (!this.stage) return -1;
        const r = this.stage.getBoundingClientRect();
        const px = x - r.left, py = y - r.top;
        for (const p of this._paneRects()) {
            if (px >= p.x && px < p.x + p.w && py >= p.y && py < p.y + p.h) return p.slot;
        }
        return -1;
    },

    /** The active pane's box in stage pixels, or null when one view fills the stage. */
    _paneActiveBox() {
        const s = this._paneState();
        if (s.layout === "single") return null;
        return this._paneRects().find((p) => p.slot === s.active) || null;
    },

    /**
     * The canvas answers for the active pane: its rect and size are that
     * pane's while several are up (see the top of this file).
     */
    _paneHookCanvas(canvas) {
        const view = this;
        const E = (this.win.Element || Element).prototype;
        const rectOf = E.getBoundingClientRect;
        const cw = Object.getOwnPropertyDescriptor(E, "clientWidth").get;
        const ch = Object.getOwnPropertyDescriptor(E, "clientHeight").get;
        Object.defineProperty(canvas, "getBoundingClientRect", { configurable: true, value() {
            const r = rectOf.call(canvas);
            const p = view._paneActiveBox();
            if (!p) return r;
            const R = view.win.DOMRect || DOMRect;
            return new R(r.left + p.x, r.top + p.y, p.w, p.h);
        } });
        Object.defineProperty(canvas, "clientWidth", { configurable: true, get() {
            const p = view._paneActiveBox();
            return p ? p.w : cw.call(canvas);
        } });
        Object.defineProperty(canvas, "clientHeight", { configurable: true, get() {
            const p = view._paneActiveBox();
            return p ? p.h : ch.call(canvas);
        } });
    },

    /**
     * Put the gizmos (the transform gizmo and a camera's look-at gizmo) on
     * `cam` for a pane of box `p` (null: one view fills the stage) and bring
     * their handles up to date.
     *
     * three's TransformControls sizes its handles as a share of the view's
     * HEIGHT, so in a pane half the stage's height they came out half as big -
     * and their invisible pick shapes with them, which is what made an axis
     * hard to hit. The size is scaled by stage height / pane height, so the
     * handles keep the pixel size they have in a single view. The handles'
     * matrices are also what the hover and the press test the ray against:
     * after drawing every pane they were left as the LAST pane drew them
     * (another camera, another scale), so they are made again for the pane
     * the mouse is in.
     */
    _paneGizmoFit(cam, p) {
        const H = Math.max(1, this.stage ? this.stage.clientHeight : 1);
        const k = p && p.h > 0 ? H / p.h : 1;
        for (const [g, helper] of [[this.gizmo, this.gizmoHelper], [this._aimGizmo, this._aimGizmoHelper]]) {
            if (!g) continue;
            if (g._ivBaseSize === undefined) g._ivBaseSize = g.size;
            if (cam) g.camera = cam;
            const size = g._ivBaseSize * k;
            if (Math.abs(g.size - size) > 1e-6) g.size = size;
            if (helper && g.object) helper.updateMatrixWorld();
        }
    },

    // ── Drawing ──────────────────────────────────────────────────────────────

    /**
     * Draw every pane. False when one perspective view fills the stage, which
     * _tick draws as it always did (through bloom when the world has it).
     */
    _paneRenderAll() {
        if (this._panePlain() || !this.renderer) {
            // Back to one view: the gizmos' own size again.
            if (this.gizmo && this.gizmo._ivBaseSize !== undefined && this.gizmo.size !== this.gizmo._ivBaseSize) this._paneGizmoFit(null, null);
            return false;
        }
        const r = this.renderer;
        const W = Math.max(1, this.stage.clientWidth), H = Math.max(1, this.stage.clientHeight);
        const grid = this.grid;
        const rot = grid ? grid.rotation.clone() : null;
        // The gaps between the panes are the dividers: darker than the views.
        const { THREE } = this.libs;
        const cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
        r.setScissorTest(false);
        r.setViewport(0, 0, W, H);
        r.setClearColor(0x111111, 1);
        r.clear();
        r.setClearColor(cc, ca);
        r.setScissorTest(true);
        const tracedSlot = this._paneTracedSlot();
        // A camera's frustum is drawn in every pane but the one looking through it.
        const helpers = [];
        for (const e of this._entries.values()) if (e.camera && e.helper) helpers.push(e);
        const showHelpers = (throughId) => {
            for (const e of helpers) e.helper.visible = e.helperShown !== false && e.item.id !== throughId;
        };
        for (const p of this._paneRects()) {
            if (p.w < 2 || p.h < 2) continue;
            const cam = this._paneCamera(p.kind);
            showHelpers(this.paneThroughId(p.kind));
            this._paneLook(this.paneShading(p.slot));
            this._paneFitCam(cam, p.kind, p.w, p.h);
            r.setViewport(p.x, H - p.y - p.h, p.w, p.h);
            r.setScissor(p.x, H - p.y - p.h, p.w, p.h);
            // The grid lies in the plane a flat view looks at.
            if (grid) {
                if (p.kind === "front" || p.kind === "back") grid.rotation.set(Math.PI / 2, 0, 0);
                else if (p.kind === "right" || p.kind === "left") grid.rotation.set(0, 0, Math.PI / 2);
                else grid.rotation.set(0, 0, 0);
            }
            this._paneGizmoFit(cam, p);
            this._dispApply(cam);
            // Path traced shading traces the active pane (imageViewer_view3dPathTrace.js); null = raster.
            if (p.slot === tracedSlot) this._ptPaneName = this._paneName(p.kind);
            const traced = p.slot === tracedSlot && this._ptViewportTick ? this._ptViewportTick(cam, p) : null;
            if (traced === null) r.render(this.scene, cam);
            else if (traced) this._ptMore = true;
        }
        r.setScissorTest(false);
        r.setViewport(0, 0, W, H);
        if (grid && rot) grid.rotation.copy(rot);
        // Back to the active pane's look and frustums: what picking and the rest of the frame see.
        this._paneLook(this.materialMode);
        showHelpers(this.paneThroughId());
        // The perspective camera's aspect goes back to the active pane's, which picking reads,
        // and the gizmos' handles to how that pane drew them, which the hover and press test.
        const act = this._paneActiveBox();
        if (act) this._paneFitCam(this.activeCameraObject(), this.paneActiveKind(), act.w, act.h);
        this._paneGizmoFit(this.activeCameraObject(), act);
        return true;
    },

    // ── Layout and the panes' chrome ─────────────────────────────────────────

    setPaneLayout(layout) {
        if (!SLOTS[layout]) return;
        const s = this._paneState();
        if (layout === "single") s.focus = s.active;
        s.layout = layout;
        // Chosen by hand, a layout is not a maximised pane any more (togglePaneMaximised sets it again).
        delete s.restore;
        // The active pane has to be one that is on screen.
        const slots = paneRects(layout, s.split, 100, 100, s.focus).map((p) => p.slot);
        if (!slots.includes(s.active)) {
            const persp = s.views.indexOf("persp");
            this._paneActivate(slots.includes(persp) ? persp : slots[0]);
        }
        this._paneSave();
        this._paneBuild();
        this._resize();
        this._paneBindControls();
        this._syncGate();
        this._syncToolbar();
    },

    /** Show `kind` in pane `slot` (the pane that showed it takes this one's view). */
    setPaneView(slot, kind) {
        const s = this._paneState();
        if (!PANE_VIEWS.some(([k]) => k === kind)) return;
        this._paneKeepTarget(this.paneActiveKind());
        s.views = setSlotView(s.views, slot, kind);
        this._paneSave();
        this._paneBindControls();
        this._panePlace();
        this._syncGate();
    },

    /** Maximise a pane (Houdini's Space+B), or put the layout back. */
    togglePaneMaximised(slot = this._paneState().active) {
        const s = this._paneState();
        if (s.layout === "single") {
            this.setPaneLayout(s.restore || "quad");
            return;
        }
        const was = s.layout;
        s.active = slot;
        this.setPaneLayout("single");
        s.restore = was;
    },

    /**
     * What Space over the stage would do: the slot of the pane under the mouse in a
     * split layout, "restore" in a pane maximised from one, else null (Space plays).
     */
    paneSpaceTarget() {
        const xy = this._paneHoverXY;
        if (!xy || !this.stage || !this.stage.isConnected) return null;
        const s = this._paneState();
        if (s.layout === "single") return s.restore ? "restore" : null;
        const slot = this._paneAt(xy[0], xy[1]);
        return slot >= 0 ? slot : null;
    },

    /** Space over a pane: maximise it, or put the layout it came from back. */
    paneSpaceToggle() {
        const t = this.paneSpaceTarget();
        if (t === null) return false;
        if (t === "restore") this.togglePaneMaximised();
        else this.togglePaneMaximised(t);
        return true;
    },

    /** Build the panes' frames, labels and dividers for the layout. */
    _paneBuild() {
        if (!this.stage) return;
        const d = this.doc;
        if (this._paneLayer) this._paneLayer.remove();
        const layer = d.createElement("div");
        layer.className = "model-panes";
        const s = this._paneState();
        this._paneEls = {};
        for (const p of paneRects(s.layout, s.split, 100, 100, s.focus)) {
            const box = d.createElement("div");
            box.className = "model-pane";
            box.dataset.slot = String(p.slot);
            const label = d.createElement("button");
            label.className = "model-pane-label";
            label.title = "This view: perspective, top, front, right ... and the layout";
            label.onclick = (e) => { e.stopPropagation(); this._paneMenu(p.slot, label); };
            label.addEventListener("pointerdown", (e) => e.stopPropagation());
            const axes = this._paneAxesBuild(p.slot);
            const shade = d.createElement("span");
            shade.className = "model-pane-shade";
            shade.style.display = "none";
            box.append(label, shade, axes.svg);
            layer.append(box);
            this._paneEls[p.slot] = { box, label, shade, axes };
        }
        const dividers = [];
        if (s.layout === "2h" || s.layout === "3" || s.layout === "quad") dividers.push("x");
        if (s.layout === "2v" || s.layout === "3" || s.layout === "quad") dividers.push("y");
        this._paneDividers = {};
        for (const axis of dividers) {
            const div = d.createElement("div");
            div.className = `model-pane-split ${axis}`;
            div.title = "Drag to size the views; double-click to even them out";
            div.addEventListener("pointerdown", (e) => this._paneSplitDown(e, axis));
            div.addEventListener("dblclick", () => {
                s.split[axis === "x" ? 0 : 1] = 0.5;
                this._paneSave();
                this._resize();
            });
            layer.append(div);
            this._paneDividers[axis] = div;
        }
        this.stage.append(layer);
        this._paneLayer = layer;
        if (!this._paneWired) {
            this._paneWired = true;
            // The pane under the mouse is the one it works in - set before anything else hears the press.
            const pick = (e) => {
                if (e.type === "pointermove" && e.buttons) return;
                if (this._paneState().layout === "single") return;
                const slot = this._paneAt(e.clientX, e.clientY);
                if (slot >= 0) this._paneActivate(slot);
            };
            // Where the mouse is over the stage, for Space (paneSpaceTarget).
            this.stage.addEventListener("pointermove", (e) => { this._paneHoverXY = [e.clientX, e.clientY]; }, true);
            this.stage.addEventListener("pointerleave", () => { this._paneHoverXY = null; });
            this.stage.addEventListener("pointerdown", pick, true);
            this.stage.addEventListener("pointermove", pick, true);
            this.stage.addEventListener("wheel", pick, { capture: true, passive: true });
            // A camera dragged from the Outliner onto a pane: that pane looks through it (Sebastian 2026-11-17).
            const camOf = () => (this.hooks.draggedCamera ? this.hooks.draggedCamera() : null);
            const mark = (slot) => {
                for (const [k, el] of Object.entries(this._paneEls || {})) el.box.classList.toggle("drop-camera", Number(k) === slot);
            };
            this.stage.addEventListener("dragover", (e) => {
                if (!camOf()) return;
                const slot = this._paneAt(e.clientX, e.clientY);
                if (slot < 0) { mark(-1); return; }
                e.preventDefault();
                e.stopPropagation();
                // "move": what the Outliner's rows allow (another effect would refuse the drop).
                try { e.dataTransfer.dropEffect = "move"; } catch (_) { /* read-only */ }
                mark(slot);
            });
            this.stage.addEventListener("dragleave", (e) => {
                if (!e.relatedTarget || !this.stage.contains(e.relatedTarget)) mark(-1);
            });
            this.stage.addEventListener("drop", (e) => {
                const id = camOf();
                mark(-1);
                if (!id) return;
                const slot = this._paneAt(e.clientX, e.clientY);
                if (slot < 0) return;
                e.preventDefault();
                e.stopPropagation();
                this.paneLookThrough(slot, id);
            });
        }
        this._panePlace();
    },

    /** Put the frames, labels and dividers where the panes are now. */
    _panePlace() {
        if (!this._paneLayer || !this.stage) return;
        const s = this._paneState();
        const px = (v) => `${Math.round(v)}px`;
        const many = s.layout !== "single";
        const name = (kind) => this._paneName(kind);
        const shadeLabel = (m) => {
            const row = this.materialModes ? this.materialModes().find(([v]) => v === m) : null;
            return row ? row[1] : m;
        };
        for (const p of this._paneRects()) {
            const el = this._paneEls && this._paneEls[p.slot];
            if (!el) continue;
            Object.assign(el.box.style, { left: px(p.x), top: px(p.y), width: px(p.w), height: px(p.h) });
            el.box.classList.toggle("active", many && p.slot === s.active);
            el.box.dataset.kind = p.kind;
            el.label.textContent = `${name(p.kind)} ▾`;
            // Each pane's own shading, said on it when the panes do not all look alike.
            const mode = this.paneShading(p.slot);
            el.box.dataset.shading = mode;
            if (el.shade) {
                const differs = many && this._paneRects().some((q) => this.paneShading(q.slot) !== mode);
                el.shade.textContent = differs ? shadeLabel(mode) : "";
                el.shade.style.display = differs ? "" : "none";
            }
        }
        const W = this.stage.clientWidth, H = this.stage.clientHeight;
        const dx = this._paneDividers && this._paneDividers.x;
        const dy = this._paneDividers && this._paneDividers.y;
        if (dx) {
            const x = Math.round(W * s.split[0]);
            Object.assign(dx.style, { left: px(x - 3), top: "0px", width: "6px",
                                       height: s.layout === "quad" || s.layout === "2h" || s.layout === "3" ? px(H) : "0px" });
        }
        if (dy) {
            const y = Math.round(H * s.split[1]);
            const x0 = s.layout === "3" ? Math.round(W * s.split[0]) : 0;
            Object.assign(dy.style, { left: px(x0), top: px(y - 3), width: px(W - x0), height: "6px" });
        }
    },

    // ── The orientation axes ─────────────────────────────────────────────────

    _paneAxesBuild(slot) {
        const NS = "http://www.w3.org/2000/svg";
        const d = this.doc;
        const svg = d.createElementNS(NS, "svg");
        svg.setAttribute("class", "model-axes");
        svg.setAttribute("width", String(AXES_SIZE));
        svg.setAttribute("height", String(AXES_SIZE));
        svg.setAttribute("viewBox", `0 0 ${AXES_SIZE} ${AXES_SIZE}`);
        const bg = d.createElementNS(NS, "circle");
        bg.setAttribute("class", "model-axes-bg");
        bg.setAttribute("cx", String(AXES_SIZE / 2));
        bg.setAttribute("cy", String(AXES_SIZE / 2));
        bg.setAttribute("r", String(AXES_R + 12));
        svg.append(bg);
        const parts = {};
        for (const [id, , color] of AXES) {
            const g = d.createElementNS(NS, "g");
            g.setAttribute("class", "model-axis" + (id[0] === "-" ? " neg" : ""));
            g.dataset.axis = id;
            const line = d.createElementNS(NS, "line");
            line.setAttribute("stroke", color);
            line.setAttribute("stroke-width", "2");
            const ball = d.createElementNS(NS, "circle");
            ball.setAttribute("r", id[0] === "-" ? "6.5" : "8");
            ball.setAttribute("fill", color);
            if (id[0] === "-") { ball.setAttribute("fill-opacity", "0.35"); ball.setAttribute("stroke", color); }
            g.append(line, ball);
            if (id[0] !== "-") {
                const t = d.createElementNS(NS, "text");
                t.textContent = id.toUpperCase();
                t.setAttribute("text-anchor", "middle");
                t.setAttribute("dominant-baseline", "central");
                g.append(t);
                parts[id] = { g, line, ball, t };
            } else {
                parts[id] = { g, line, ball };
            }
            const title = d.createElementNS(NS, "title");
            title.textContent = `Look along ${id[0] === "-" ? "-" : "+"}${id.slice(-1).toUpperCase()} (drag to turn the view)`;
            g.append(title);
            svg.append(g);
        }
        svg.addEventListener("pointerdown", (e) => this._paneAxesDown(e, slot));
        return { svg, parts, sig: "" };
    },

    /** Turn every pane's axes with its camera; cheap when nothing turned. */
    _paneAxesDraw() {
        if (!this._paneEls || !this.libs) return;
        const { THREE } = this.libs;
        const q = new THREE.Quaternion();
        const c = AXES_SIZE / 2;
        for (const p of this._paneRects()) {
            const el = this._paneEls[p.slot];
            if (!el || !el.axes) continue;
            const cam = this._paneCamera(p.kind);
            cam.getWorldQuaternion(q);
            const sig = [q.x, q.y, q.z, q.w].map((v) => v.toFixed(4)).join(",");
            if (sig === el.axes.sig) continue;
            el.axes.sig = sig;
            const order = axesLayout([q.x, q.y, q.z, q.w]);
            for (const a of order) {
                const part = el.axes.parts[a.id];
                part.line.setAttribute("x1", String(c));
                part.line.setAttribute("y1", String(c));
                part.line.setAttribute("x2", a.x.toFixed(1));
                part.line.setAttribute("y2", a.y.toFixed(1));
                part.line.style.display = a.neg ? "none" : "";
                part.ball.setAttribute("cx", a.x.toFixed(1));
                part.ball.setAttribute("cy", a.y.toFixed(1));
                if (part.t) { part.t.setAttribute("x", a.x.toFixed(1)); part.t.setAttribute("y", a.y.toFixed(1)); }
                el.axes.svg.append(part.g);          // back to front
            }
        }
    },

    _paneAxesDown(e, slot) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        this._paneActivate(slot);
        const g = e.target.closest && e.target.closest("[data-axis]");
        const axis = g && g.dataset.axis;
        const win = this.win;
        const persp = isPerspKind(this.paneActiveKind());
        const start = { x: e.clientX, y: e.clientY };
        let dragging = false;
        const id = e.pointerId;
        const move = (ev) => {
            if (!persp) return;
            if (!dragging && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 3) return;
            if (!dragging) {
                dragging = true;
                this._tumble = { pivot: this.controls.target.clone(), x: start.x, y: start.y, id, moved: false };
            }
            this._tumbleMove(ev);
        };
        const up = (ev) => {
            win.removeEventListener("pointermove", move, true);
            win.removeEventListener("pointerup", up, true);
            if (dragging) { this._tumbleEnd(ev); return; }
            if (axis) this.lookAlongAxis(axis, slot);
        };
        win.addEventListener("pointermove", move, true);
        win.addEventListener("pointerup", up, true);
    },

    /**
     * Look along an axis (Blender's numpad views): a perspective pane turns to
     * look from that side at what it looked at, a flat pane becomes that flat view.
     */
    lookAlongAxis(axis, slot = this._paneState().active) {
        if (!this.libs || !this.controls) return;
        this._paneActivate(slot);
        if (!isPerspKind(this.paneActiveKind())) {
            this.setPaneView(slot, AXIS_VIEW[axis]);
            return;
        }
        const { THREE } = this.libs;
        const spec = AXES.find(([a]) => a === axis);
        if (!spec) return;
        const cam = this.activeCameraObject();
        const target = this.controls.target.clone();
        const dist = Math.max(1e-3, cam.position.distanceTo(target));
        cam.position.copy(target).addScaledVector(new THREE.Vector3(...spec[1]), dist);
        cam.lookAt(target);
        cam.updateMatrixWorld();
        this.controls.update();
        if (this._reportCamera) this._reportCamera(false);
        this.requestRender();
    },

    _paneSplitDown(e, axis) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const s = this._paneState();
        const win = this.win;
        const r = this.stage.getBoundingClientRect();
        const move = (ev) => {
            const v = axis === "x" ? (ev.clientX - r.left) / Math.max(1, r.width) : (ev.clientY - r.top) / Math.max(1, r.height);
            s.split[axis === "x" ? 0 : 1] = Math.min(0.9, Math.max(0.1, v));
            this._panePlace();
            this.requestRender();
        };
        const up = () => {
            win.removeEventListener("pointermove", move, true);
            win.removeEventListener("pointerup", up, true);
            this._paneSave();
            this._resize();
        };
        win.addEventListener("pointermove", move, true);
        win.addEventListener("pointerup", up, true);
    },

    /** The menu at a pane's top right: its view, maximise, the layouts. */
    _paneMenu(slot, anchor) {
        this._paneActivate(slot);
        const s = this._paneState();
        const kind = s.views[slot];
        const tick = (on, label) => (on ? "✓ " : "") + label;
        const entries = PANE_VIEWS.map(([k, label], i) => ({
            label: tick(k === kind, label), run: () => this.setPaneView(slot, k),
        }));
        // Perspective views first, then the flat ones.
        entries.splice(PANE_VIEWS.findIndex(([k]) => !isPerspKind(k)), 0, "-");
        entries.push("-");
        if (isPerspKind(kind)) {
            const through = this.paneThroughId(kind);
            const cams = ((this.scene3d && this.scene3d.items) || []).filter((it) => it.kind === "camera" && this._entries.get(it.id));
            entries.push({ label: "Look through", sub: [
                { label: tick(!through, kind === "persp" ? "Free camera" : "Own camera"), run: () => this.paneLookThrough(slot, null) },
                ...(cams.length ? ["-"] : []),
                ...cams.map((it) => ({ label: tick(through === it.id, it.name), run: () => this.paneLookThrough(slot, it.id) })),
            ] });
        }
        if (this.materialModes) {
            const mode = this.paneShading(slot);
            entries.push({ label: "Shading", sub: this.materialModes().map(([m, label]) => ({
                label: tick(mode === m, label), run: () => this.setPaneShading(slot, m) })) });
        }
        entries.push("-");
        entries.push({ label: s.layout === "single" ? "Show all views" : "Maximise this view",
                       run: () => this.togglePaneMaximised(slot) });
        entries.push({ label: "Frame all", run: () => this.resetView() });
        entries.push({ label: "Layout", sub: PANE_LAYOUTS.map(([l, label]) => ({
            label: (l === s.layout ? "✓ " : "") + label, run: () => this.setPaneLayout(l) })) });
        const r = anchor.getBoundingClientRect();
        if (this.hooks.openMenu) this.hooks.openMenu(entries, r.left, r.bottom + 2, anchor);
    },
};

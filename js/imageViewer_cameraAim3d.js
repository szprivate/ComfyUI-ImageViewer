// imageViewer_cameraAim3d.js
// A camera's look-at target in the viewport (Sebastian 2026-11-12; the data
// side is imageViewer_cameraAim.js). Mixed onto Model3DView.
//
//   - A camera whose target is on is turned to face it in applyFrame
//     (_aimOrient), keeping the roll its own Rotate channels give (_aimRollOf:
//     the twist about the view axis, measured against looking level with +Y up).
//   - Its target is drawn as a small cross with a line from the camera, and
//     while that camera is selected a second gizmo (translate, world axes) sits
//     on the target, so it is dragged in the canvas like any object
//     (_aimGizmoSync). The drag is handed to the panel through hooks.onAimTarget.
//   - Navigating through a scene camera: the orbit controls look at their own
//     centre after every pan and dolly. That centre is now put on the camera's
//     view axis when a move starts and the roll is put back after each step
//     (_aimNavStart / _aimNavChange), so a camera without a target keeps the
//     direction it was given; a camera with one navigates about its target, and
//     the move is reported with the target (_aimReported).
//
// Clean-room: written from what a look-at camera does, not from any program's code.
import { aimOn, AIM_PROPS } from "./imageViewer_cameraAim.js";
import { currentValue } from "./imageViewer_scene3d.js";

const MARK_COLOR = 0xd9b44a;        // the target, as the cameras' frustums are drawn
const MARK_SELECTED = 0xffd75e;

export const CameraAim3DMixin = {

    /** The world point a camera looks at at `frame` (every layer and key counted). */
    aimTargetOf(item, frame = this.sceneFrame) {
        if (!item) return null;
        return AIM_PROPS.map((p) => Number(currentValue(this.scene3d, item, p, Math.round(frame || 0))) || 0);
    },

    /**
     * The roll of an orientation: how far it is turned about its own view axis
     * from looking the same way level, with the world's +Y up. Radians.
     */
    _aimRollOf(q) {
        const { THREE } = this.libs;
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
        const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), fwd, new THREE.Vector3(0, 1, 0));
        const level = new THREE.Quaternion().setFromRotationMatrix(m);
        const twist = level.invert().multiply(q);
        return 2 * Math.atan2(twist.z, twist.w);
    },

    /** Turn a camera object to face `target` (a Vector3, world), keeping its roll. */
    _aimOrient(cam, target) {
        const { THREE } = this.libs;
        const pos = cam.getWorldPosition(new THREE.Vector3());
        if (pos.distanceToSquared(target) < 1e-12) return false;
        const roll = this._aimRollOf(cam.quaternion);
        cam.up.set(0, 1, 0);
        cam.lookAt(target);
        if (roll) cam.rotateZ(roll);
        cam.updateMatrixWorld();
        return true;
    },

    /** From applyFrame, after a camera is placed: aimed, it is turned to its target. */
    _aimApply(entry) {
        if (!entry || !entry.camera) return;
        const item = entry.item;
        if (!aimOn(item)) { entry.aimTarget = null; return; }
        const { THREE } = this.libs;
        const t = this.aimTargetOf(item);
        entry.aimTarget = new THREE.Vector3(...t);
        // While its target is being dragged the handle is where the pointer has it.
        if (this._aimGizmo && this._aimGizmo.dragging && this._aimGizmo.object && this._aimEntryId === item.id) {
            entry.aimTarget.copy(this._aimGizmo.object.position);
        }
        this._aimOrient(entry.root, entry.aimTarget);
    },

    // ── Drawing the target ──────────────────────────────────────────────────

    /** The cross and the line of every aimed camera, placed; the gizmo on the selected one's. */
    _aimSync() {
        if (!this.libs || !this.scene) return;
        const { THREE } = this.libs;
        const activeId = this.scene3d && this.scene3d.activeCamera;
        const size = 0.3 * ((this.gridOptions && this.gridOptions().auto) ? (this._gridAutoScale || 1) : 1);
        for (const entry of this._entries.values()) {
            if (!entry.camera) continue;
            const want = !!(entry.aimTarget && entry.root.visible);
            if (!want) {
                if (entry.aimViz) entry.aimViz.visible = false;
                continue;
            }
            if (!entry.aimViz) entry.aimViz = this._aimMakeViz(THREE, entry.item.id);
            const viz = entry.aimViz;
            viz.visible = true;
            const sel = this.selected === entry.item.id;
            viz.userData.mark.material.color.setHex(sel ? MARK_SELECTED : MARK_COLOR);
            viz.userData.line.material.color.setHex(sel ? MARK_SELECTED : MARK_COLOR);
            viz.userData.mark.position.copy(entry.aimTarget);
            viz.userData.mark.scale.setScalar(size);
            // Looking through the camera the line runs along the view: only the cross shows.
            const pos = entry.root.getWorldPosition(new THREE.Vector3());
            const attr = viz.userData.line.geometry.getAttribute("position");
            attr.setXYZ(0, pos.x, pos.y, pos.z);
            attr.setXYZ(1, entry.aimTarget.x, entry.aimTarget.y, entry.aimTarget.z);
            attr.needsUpdate = true;
            viz.userData.line.geometry.computeBoundingSphere();
            viz.userData.line.visible = entry.item.id !== activeId;
        }
        this._aimGizmoSync();
    },

    _aimMakeViz(THREE, id) {
        const viz = new THREE.Group();
        viz.name = "aimtarget";
        viz.userData.imageViewerCameraHelper = true;
        // A cross of three lines and a diamond around it, one unit across (scaled in _aimSync).
        const p = [];
        for (const [a, b] of [[[-1, 0, 0], [1, 0, 0]], [[0, -1, 0], [0, 1, 0]], [[0, 0, -1], [0, 0, 1]]]) p.push(...a, ...b);
        const ring = [[0.6, 0, 0], [0, 0.6, 0], [-0.6, 0, 0], [0, -0.6, 0]];
        for (let i = 0; i < 4; i++) p.push(...ring[i], ...ring[(i + 1) % 4]);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
        const mark = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: MARK_COLOR, depthTest: false }));
        mark.name = "aimtarget-mark";
        mark.renderOrder = 2;
        const lineGeo = new THREE.BufferGeometry();
        lineGeo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(6), 3));
        const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: MARK_COLOR, transparent: true, opacity: 0.6 }));
        line.name = "aimtarget-line";
        for (const o of [mark, line]) { o.userData.imageViewerCameraHelper = true; o.userData.imageViewerAimOf = id; }
        viz.add(mark, line);
        viz.userData.mark = mark;
        viz.userData.line = line;
        this.scene.add(viz);
        return viz;
    },

    /** From _removeEntry: the camera's target goes with it. */
    _aimDrop(entry) {
        if (!entry || !entry.aimViz) return;
        if (this._aimGizmo && this._aimEntryId === entry.item.id) this._aimGizmo.detach();
        entry.aimViz.parent && entry.aimViz.parent.remove(entry.aimViz);
        entry.aimViz.traverse((o) => { o.geometry && o.geometry.dispose(); o.material && o.material.dispose(); });
        entry.aimViz = null;
    },

    // ── The target's gizmo ──────────────────────────────────────────────────

    _aimEnsureGizmo() {
        if (this._aimGizmo || !this.libs || !this.renderer || !this.canvas) return this._aimGizmo || null;
        const { THREE, TransformControls } = this.libs;
        const g = new TransformControls(this.activeCameraObject(), this.canvas);
        g.setMode("translate");
        g.setSpace("world");
        g.setSize(0.7);
        g.addEventListener("change", () => this.requestRender());
        g.addEventListener("dragging-changed", (e) => {
            if (this.controls) this.controls.enabled = !e.value;
            this._aimDragging = !!e.value;
            if (!e.value && this.hooks.onTransformEnd) this.hooks.onTransformEnd(this._aimEntryId);
        });
        g.addEventListener("objectChange", () => {
            const entry = this._aimEntryId && this._entries.get(this._aimEntryId);
            if (!entry || !this._aimHandle) return;
            const t = this._aimHandle.position;
            entry.aimTarget = t.clone();
            this._aimOrient(entry.root, entry.aimTarget);
            if (entry.helper) entry.helper.update();
            if (this.hooks.onAimTarget) this.hooks.onAimTarget(entry.item.id, t.toArray(), true);
            this._aimSync();
            this.requestRender();
        });
        this._aimHandle = new THREE.Object3D();
        this._aimHandle.name = "AimHandle";
        this.scene.add(this._aimHandle);
        const helper = g.getHelper ? g.getHelper() : g;
        helper.name = "GizmoAimTarget";
        this.scene.add(helper);
        this._aimGizmo = g;
        this._aimGizmoHelper = helper;
        return g;
    },

    /** The target's gizmo on the selected camera's target, when it has one. */
    _aimGizmoSync() {
        const entry = this.selected ? this._entries.get(this.selected) : null;
        const want = !!(entry && entry.camera && entry.aimTarget && entry.root.visible && this.scene3d);
        if (!want) {
            if (this._aimGizmo && this._aimGizmo.object) this._aimGizmo.detach();
            this._aimEntryId = null;
            return;
        }
        const g = this._aimEnsureGizmo();
        if (!g) return;
        g.camera = this.activeCameraObject();
        this._aimEntryId = entry.item.id;
        if (!g.dragging) this._aimHandle.position.copy(entry.aimTarget);
        this._aimHandle.updateMatrixWorld();
        if (g.object !== this._aimHandle) g.attach(this._aimHandle);
        if (this._aimGizmoHelper) this._aimGizmoHelper.updateMatrixWorld();
    },

    /** Whether a press lands on the target's gizmo (it then has the drag, not the marquee). */
    _aimGizmoHot() {
        return !!(this._aimGizmo && this._aimGizmo.object && (this._aimGizmo.axis || this._aimGizmo.dragging));
    },

    _aimDisposeGizmo() {
        if (!this._aimGizmo) return;
        this._aimGizmo.detach();
        this._aimGizmo.dispose();
        if (this._aimGizmoHelper) this.scene.remove(this._aimGizmoHelper);
        if (this._aimHandle) this.scene.remove(this._aimHandle);
        this._aimGizmo = null;
        this._aimGizmoHelper = null;
        this._aimHandle = null;
    },

    // ── Navigating through a scene camera ───────────────────────────────────

    /** The scene camera being looked through, as its entry, or null (the free camera, a flat pane). */
    _aimNavEntry() {
        if (this._walk || (this._paneOrthoActive && this._paneOrthoActive())) return null;
        const id = this.scene3d && this.scene3d.activeCamera;
        const entry = id ? this._entries.get(id) : null;
        return entry && entry.camera && this.controls && this.controls.object === entry.camera ? entry : null;
    },

    /**
     * A pan or dolly through a scene camera starts: the orbit centre goes onto
     * its view axis (its target, when it has one), so the controls' look-at
     * changes nothing, and its roll is remembered.
     */
    _aimNavStart() {
        const entry = this._aimNavEntry();
        this._aimNav = null;
        if (!entry) return;
        const { THREE } = this.libs;
        const cam = entry.camera;
        if (entry.aimTarget) {
            this.controls.target.copy(entry.aimTarget);
        } else {
            const pos = cam.getWorldPosition(new THREE.Vector3());
            const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
            const d = Math.max(0.1, this.controls.target.clone().sub(pos).dot(fwd)) || 5;
            this.controls.target.copy(pos).addScaledVector(fwd, d);
        }
        this._aimNav = { id: entry.item.id, roll: this._aimRollOf(cam.quaternion) };
    },

    /** After each step of the orbit controls (which look at their centre): the roll put back. */
    _aimNavChange() {
        const n = this._aimNav;
        const entry = this._aimNavEntry();
        if (!n || !entry || entry.item.id !== n.id) return;
        if (n.roll) {
            entry.camera.rotateZ(n.roll);
            entry.camera.updateMatrixWorld();
        }
        if (entry.aimTarget) entry.aimTarget.copy(this.controls.target);
    },

    /** A camera move reported to the scene: with the target, when the camera has one. */
    _aimReported(id, transform) {
        const entry = id ? this._entries.get(id) : null;
        if (entry && entry.aimTarget && this.controls && this.controls.object === entry.camera) {
            return { ...transform, aimTarget: this.controls.target.toArray() };
        }
        return transform;
    },
};

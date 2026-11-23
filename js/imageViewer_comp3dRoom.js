// imageViewer_comp3dRoom.js
// The 3D room of Comp's viewer (Sebastian 2026-11-23, part 3 of the Comp 3D plan): the 2D / 3D switch in the
// picture's bar shows the scene a Render3D draws as a room to look around in - the 3D space's own viewport (the
// hidden Model3DView of imageViewer_comp3dEngine.js, brought into the picture's place while the room is up), with
// its grid, its orbit / pan / dolly navigation and its gizmo. In it: what the last Render3D drew (Comp's cards,
// shapes, points and lights, a SceneFile's models), the render camera as a frustum, and a gizmo on the selected
// Card / Shape / Light / Camera that writes its translate / rotate / scale - live, one undo step a drag, a key
// when the value is animated (the editor's `api.gizmo`).
//
// Comp's numbers are the room's: y up, a camera looking down its own -z, rotations in degrees about x, then y,
// then z (comp3d's eulerXYZ = Rx·Ry·Rz, which is three's "XYZ" order). The room is display only: what it shows
// is in the scene's linear values through the viewport's sRGB output, and nothing of it reaches a render (the
// engine's render() hides the room's group).
//
// Installed onto Comp3DEngine's prototype by Object.assign (see the end of imageViewer_comp3dEngine.js).

/** The node types the gizmo moves, and which of their numbers it writes. */
export const ROOM_MOVABLE = { card3d: ["translate", "rotate", "scale"], geo3d: ["translate", "rotate", "scale"],
    light3d: ["translate", "rotate"], camera3d: ["translate", "rotate"] };

/** The corners of a Comp camera's view at distance d (its own space, then through its world matrix): [[x, y, z] x 4]. */
export function frustumCorners(cam, d = 1) {
    const out = [];
    for (const [nx, ny] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const x = ((nx - (cam.sx || 0)) * d) / cam.k, y = (ny * d) / cam.ky, z = -d;
        const m = cam.world;
        out.push([m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]]);
    }
    return out;
}

const ROOM_STOPPED = ["pointerdown", "pointerup", "pointermove", "wheel", "dblclick", "contextmenu", "click"];

export const RoomMixin = {
    /** Is the room up? */
    get roomOpen() { return !!this._room; },

    /**
     * Show the room in `stage` (an element the viewport fills). api: {selected() -> node id or null,
     * paramsOf(id) -> {type, translate, rotate, scale} or null, gizmo(id, patch, phase "start" | "move" | "end")}.
     */
    async openRoom(stage, api) {
        if (!(await this.ensure())) return false;
        if (this._room) this.closeRoom();
        const v = this.view, { THREE, TransformControls } = v.libs;
        this._roomHome = this.box.parentNode;
        stage.append(this.box);
        this.box.classList.add("comp3d-room");
        Object.assign(this.box.style, { position: "absolute", left: "0", top: "0", width: "100%", height: "100%", visibility: "visible", pointerEvents: "auto", zIndex: "3" });
        if (v.grid) v.grid.visible = true;
        const group = new THREE.Group();
        group.name = "comp3d-room";
        v.scene.add(group);
        // The room is looked at through the free camera: a SceneFile's scene may name a camera of its own, which the
        // perspective view would otherwise look through (and navigating would move it). Put back by closeRoom.
        if (v.paneThroughId) {
            const through = Object.getPrototypeOf(v).paneThroughId;
            v.paneThroughId = function (kind = this.paneActiveKind()) { return kind === "persp" ? null : through.call(this, kind); };
        }
        // Alt + left tumbles about what is under the pointer, as in the 3D space: the room's own objects count too
        // (they are not scene items, which is all the view's own look asks).
        v._surfaceUnder = function (e) {
            const own = Object.getPrototypeOf(this)._surfaceUnder.call(this, e);
            if (own || !this._room3d) return own;
            const rect = this.canvas.getBoundingClientRect();
            const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
            const ray = new THREE.Raycaster();
            ray.setFromCamera(ndc, this.activeCameraObject());
            const hit = ray.intersectObjects(this._room3d.children, true).find((h) => h.object.isMesh || h.object.isPoints);
            return hit ? hit.point : null;
        };
        // The camera the room is seen through (the viewport's pane camera, which navigation moves).
        const gizmo = new TransformControls(v.activeCameraObject ? v.activeCameraObject() : v.camera, v.canvas);
        gizmo.setSpace("local");
        const helper = gizmo.getHelper ? gizmo.getHelper() : gizmo;
        helper.name = "comp3d-room-gizmo";
        v.scene.add(helper);
        const proxy = new THREE.Object3D();
        v.scene.add(proxy);
        v._room3d = group;
        const room = this._room = { api, group, gizmo, helper, proxy, id: null, built: null, framed: false, drag: false };
        gizmo.addEventListener("change", () => v.requestRender());
        gizmo.addEventListener("dragging-changed", (e) => {
            room.drag = !!e.value;
            if (v.controls) v.controls.enabled = !e.value;
            if (room.id) api.gizmo(room.id, this._roomPatch(), e.value ? "start" : "end");
        });
        gizmo.addEventListener("objectChange", () => { if (room.drag && room.id) api.gizmo(room.id, this._roomPatch(), "move"); });
        // W / E / R as everywhere in the 3D space, while the pointer is over the room.
        room.keys = (e) => {
            if (!this._room || e.ctrlKey || e.metaKey || e.altKey || !this.box.matches(":hover")) return;
            if (this.roomKey(e.key.toLowerCase())) { e.preventDefault(); e.stopPropagation(); }
        };
        this.doc.addEventListener("keydown", room.keys, true);
        // The picture's own presses (pan, paint, pick) stay out of the room: what reaches the box stops there.
        room.stop = (e) => e.stopPropagation();
        for (const ev of ROOM_STOPPED) this.box.addEventListener(ev, room.stop);
        v._resize();
        this.roomSync();
        return true;
    },

    /** W / E / R: the gizmo's move / turn / scale (scale only on what has one); F frames the selection, else all.
     *  True when it was the room's. */
    roomKey(k) {
        const room = this._room;
        if (room && k === "f") { this._roomFrame(this._last, room.id && room.gizmo.object ? room.proxy : null); return true; }
        const mode = k === "w" ? "translate" : k === "e" ? "rotate" : k === "r" ? "scale" : null;
        if (!room || !mode) return false;
        if (mode === "scale" && room.id && !(ROOM_MOVABLE[(room.api.paramsOf(room.id) || {}).type] || []).includes("scale")) return true;
        room.gizmo.setMode(mode);
        this.view.requestRender();
        return true;
    },

    closeRoom() {
        const room = this._room;
        if (!room) return;
        this._room = null;
        const v = this.view;
        this.doc.removeEventListener("keydown", room.keys, true);
        for (const ev of ROOM_STOPPED) this.box.removeEventListener(ev, room.stop);
        room.gizmo.detach();
        if (room.gizmo.dispose) room.gizmo.dispose();
        v.scene.remove(room.helper); v.scene.remove(room.proxy);
        this._roomClear(room);
        v.scene.remove(room.group);
        if (v.controls) v.controls.enabled = true;
        if (Object.prototype.hasOwnProperty.call(v, "paneThroughId")) delete v.paneThroughId;
        if (Object.prototype.hasOwnProperty.call(v, "_surfaceUnder")) delete v._surfaceUnder;
        v._room3d = null;
        if (v.grid) v.grid.visible = false;
        this.box.classList.remove("comp3d-room");
        Object.assign(this.box.style, { position: "absolute", width: "1px", height: "1px", visibility: "hidden", pointerEvents: "none", left: "-10px", top: "-10px", zIndex: "" });
        if (this._roomHome) this._roomHome.append(this.box);
        v._resize();
    },

    _roomClear(room) {
        for (const o of [...room.group.children]) {
            room.group.remove(o);
            o.traverse((x) => { if (x.geometry) x.geometry.dispose(); if (x.material) x.material.dispose(); });
        }
    },

    /** The room again from what the last Render3D drew and the editor's selection (after every draw). */
    roomSync() {
        const room = this._room;
        if (!room || !this.view) return;
        const v = this.view, { THREE } = v.libs;
        const last = this._last;
        if (last && room.built !== last) {
            room.built = last;
            this._roomClear(room);
            for (const ob of last.objs) {
                if (ob.kind === "mesh") {
                    const map = ob.proj ? null : ob.tex ? this._texture(THREE, ob.tex) : null;
                    const m = ob.proj ? this._compMaterial(THREE, ob, false, false)
                        : new THREE.MeshBasicMaterial({ map, color: map ? 0xffffff : 0xbfbfbf, transparent: true, premultipliedAlpha: true, side: THREE.DoubleSide, alphaTest: 1e-4 });
                    const mesh = new THREE.Mesh(this._meshOf(THREE, ob), m);
                    mesh.frustumCulled = false;
                    room.group.add(mesh);
                } else if (ob.kind === "points") {
                    const p = this._pointsOf(THREE, ob, 1, false);
                    p.frustumCulled = false;
                    room.group.add(p);
                } else if (ob.kind === "light") {
                    const c = ob.color || [1, 1, 1];
                    const g = new THREE.Mesh(new THREE.OctahedronGeometry(0.08), new THREE.MeshBasicMaterial({ color: new THREE.Color(c[0], c[1], c[2]), wireframe: true }));
                    new THREE.Matrix4().set(...ob.world).decompose(g.position, g.quaternion, g.scale);
                    g.scale.set(1, 1, 1);
                    room.group.add(g);
                }
            }
            if (last.cam) room.group.add(this._roomFrustum(THREE, last.cam));
            if (!room.framed) { room.framed = true; this._roomFrame(last); }
        }
        const seen = v.activeCameraObject ? v.activeCameraObject() : v.camera;
        if (room.gizmo.camera !== seen) room.gizmo.camera = seen;
        // The gizmo on the selected node that it can move.
        const id = room.api.selected();
        const p = id ? room.api.paramsOf(id) : null;
        if (!p || !ROOM_MOVABLE[p.type] || (p.type === "camera3d" && p.from_scene)) {
            room.id = null;
            if (room.gizmo.object) room.gizmo.detach();
        } else if (!room.drag) {
            room.id = id;
            const t = p.translate || [0, 0, 0], r = p.rotate || [0, 0, 0], s = p.scale || [1, 1, 1];
            room.proxy.position.set(t[0], t[1], t[2]);
            room.proxy.rotation.set((r[0] * Math.PI) / 180, (r[1] * Math.PI) / 180, (r[2] * Math.PI) / 180, "XYZ");
            room.proxy.scale.set(s[0], s[1], s[2]);
            room.proxy.updateMatrixWorld(true);
            if (room.gizmo.object !== room.proxy) room.gizmo.attach(room.proxy);
            if (room.gizmo.mode === "scale" && !ROOM_MOVABLE[p.type].includes("scale")) room.gizmo.setMode("translate");
        }
        v.requestRender();
    },

    /** The gizmo's object as the node's numbers (degrees; rounded as a field would show them). */
    _roomPatch() {
        const room = this._room, o = room.proxy, p = room.api.paramsOf(room.id) || {};
        const r4 = (x) => Math.round(x * 10000) / 10000, d = (x) => Math.round(((x * 180) / Math.PI) * 100) / 100;
        const out = { translate: [r4(o.position.x), r4(o.position.y), r4(o.position.z)], rotate: [d(o.rotation.x), d(o.rotation.y), d(o.rotation.z)] };
        if ((ROOM_MOVABLE[p.type] || []).includes("scale")) out.scale = [r4(o.scale.x), r4(o.scale.y), r4(o.scale.z)];
        return out;
    },

    _roomFrustum(THREE, cam) {
        const c = frustumCorners(cam, 0.6), e = cam.pos || [cam.world[3], cam.world[7], cam.world[11]];
        const pts = [];
        for (let i = 0; i < 4; i++) pts.push(e, c[i], c[i], c[(i + 1) % 4]);
        // A mark for "up": a little triangle on the top edge.
        const mid = [(c[2][0] + c[3][0]) / 2, (c[2][1] + c[3][1]) / 2, (c[2][2] + c[3][2]) / 2];
        const up = [mid[0] + (mid[0] - (c[0][0] + c[1][0]) / 2) * 0.25, mid[1] + (mid[1] - (c[0][1] + c[1][1]) / 2) * 0.25, mid[2] + (mid[2] - (c[0][2] + c[1][2]) / 2) * 0.25];
        pts.push(c[3], up, up, c[2]);
        const g = new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(Float32Array.from(pts.flat()), 3));
        const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffb347 }));
        l.name = "comp3d-room-camera";
        l.frustumCulled = false;
        return l;
    },

    /** The free view looks at what is there from behind and above the render camera. With `only` (F with something
     *  selected): that object fills the view, seen from where the view already looks. */
    _roomFrame(last, only) {
        const v = this.view, { THREE } = v.libs;
        const cam = v.activeCameraObject ? v.activeCameraObject() : v.camera;
        if (only) {
            const c = only.getWorldPosition(new THREE.Vector3());
            const s = Math.max(0.5, only.getWorldScale(new THREE.Vector3()).length());
            const back = cam.position.clone().sub(v.controls ? v.controls.target : c);
            if (back.lengthSq() < 1e-9) back.set(0, 0, 1);
            cam.position.copy(c).addScaledVector(back.normalize(), s * 2.2);
            cam.lookAt(c);
            if (v.controls) { v.controls.target.copy(c); v.controls.update(); }
            v.requestRender();
            return;
        }
        const box = new THREE.Box3().setFromObject(this._room.group);
        const centre = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
        const size = box.isEmpty() ? 2 : Math.max(1, box.getSize(new THREE.Vector3()).length());
        const e = last && last.cam && last.cam.pos ? new THREE.Vector3(...last.cam.pos) : new THREE.Vector3(0, 0, 2);
        const dir = e.clone().sub(centre);
        if (dir.lengthSq() < 1e-9) dir.set(0, 0, 1);
        dir.normalize().add(new THREE.Vector3(0.6, 0.5, 0)).normalize();
        cam.position.copy(centre).addScaledVector(dir, size * 1.6);
        cam.lookAt(centre);
        if (v.controls) { v.controls.target.copy(centre); v.controls.update(); }
        v.requestRender();
    },

    /** For tests: what the room holds. */
    roomInfo() {
        const room = this._room;
        if (!room) return null;
        return { objects: room.group.children.length, gizmo: room.id, mode: room.gizmo.mode,
            camera: room.group.children.some((o) => o.name === "comp3d-room-camera"), shown: this.box.style.visibility === "visible" };
    },
};

// imageViewer_atlas3d.js
// How an Atlas world is shown in the 3D space (mixed into Model3DView), as World Labs' own Viewfinder shows it
// (Sebastian 2026-11-11):
//
//   - its VIEWS: every picture of the world (the ones it was made from, and every render added to it since)
//     stays in the world at the camera Atlas has for it - a wire frustum from the camera to the picture,
//     drawn a little way in front of it. They are not scene items: they come from world.json
//     (`atlasSetViews`, the panel reads GET /imageviewer/atlas_world), hang under the world item's body - so
//     they follow the world when it is moved or set upright - and are never in a render, a depth pass or a
//     click. `item.atlasViews === false` hides them.
//   - as a POINT CLOUD (`item.atlasPoints`): each mesh of world.glb is drawn as its vertices, coloured from
//     its own picture, and the mesh itself is hidden. Chisel's depth pass still sees the meshes.
//
// Clean-room: written from how the Viewfinder looks, no code of World Labs'.

const VIEW_COLOR = 0xffa040;
const MAX_TEX_SIDE = 1024;          // the picture read back for the point colours

const noRaycast = () => {};

export const Atlas3DMixin = {

    /** The world's views, in its mesh frame: [{id, right, up, fwd, pos, image, aspect, fov, source}]. */
    atlasSetViews(itemId, views) {
        if (!this._atlasViewData) this._atlasViewData = new Map();
        this._atlasViewData.set(itemId, Array.isArray(views) ? views : []);
        const st = this._atlasViewsShown && this._atlasViewsShown.get(itemId);
        if (st) st.sig = "";            // drawn again at the next frame
        this._atlasSync();
        this.requestRender();
    },

    /** The views as they are drawn ({count, ids}), for tests and the agent. */
    atlasViewsInfo(itemId) {
        const st = this._atlasViewsShown && this._atlasViewsShown.get(itemId);
        if (!st || !st.group) return { count: 0, shown: false, ids: [] };
        return { count: st.group.children.length, shown: st.group.visible, ids: st.group.children.map((c) => c.userData.atlasViewId) };
    },

    /** Called at the end of every applyFrame: views and points follow the items' settings. */
    _atlasSync() {
        const { THREE } = this.libs || {};
        if (!THREE || !this._entries) return;
        if (!this._atlasViewsShown) this._atlasViewsShown = new Map();
        for (const [id, entry] of this._entries) {
            const item = entry.item;
            if (!item || item.kind !== "model") continue;
            this._atlasSyncPoints(entry, item.atlasPoints === true);
            const data = this._atlasViewData && this._atlasViewData.get(id);
            this._atlasSyncViews(entry, data && item.atlasViews !== false && entry.object ? data : null);
        }
        for (const [id, st] of this._atlasViewsShown) {
            if (!this._entries.has(id)) { this._atlasDropViews(st); this._atlasViewsShown.delete(id); }
        }
    },

    // ── Views ──────────────────────────────────────────────────────────────────

    _atlasDropViews(st) {
        if (!st || !st.group) return;
        if (st.group.parent) st.group.parent.remove(st.group);
        st.group.traverse((o) => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) {
                if (o.material.map) o.material.map.dispose();
                o.material.dispose();
            }
        });
        st.group = null;
    },

    /** How far in front of its camera a view's picture is drawn: a share of the world's size. */
    _atlasViewDistance(entry) {
        const { THREE } = this.libs;
        const body = this._bodyOf(entry);
        const box = new THREE.Box3();
        body.updateWorldMatrix(true, false);
        const inv = new THREE.Matrix4().copy(body.matrixWorld).invert();
        const m = new THREE.Matrix4();
        entry.object.updateWorldMatrix(true, true);
        entry.object.traverse((o) => {
            const g = o.isMesh && o.geometry;
            if (!g) return;
            if (!g.boundingBox) g.computeBoundingBox();
            if (!g.boundingBox) return;
            m.multiplyMatrices(inv, o.matrixWorld);
            box.union(g.boundingBox.clone().applyMatrix4(m));
        });
        const size = box.isEmpty() ? 4 : box.getSize(new THREE.Vector3()).length();
        return Math.max(0.05, Math.min(2, size * 0.035));
    },

    _atlasSyncViews(entry, views) {
        const st = this._atlasViewsShown.get(entry.item.id) || {};
        this._atlasViewsShown.set(entry.item.id, st);
        if (!views || !views.length) { this._atlasDropViews(st); st.sig = ""; return; }
        const sig = views.map((v) => `${v.id}:${v.image}:${(v.pos || []).join(",")}`).join("|");
        if (st.group && st.sig === sig && st.object === entry.object && st.group.parent === this._bodyOf(entry)) return;
        this._atlasDropViews(st);
        st.sig = sig;
        st.object = entry.object;
        st.group = this._atlasBuildViews(entry, views);
        this._bodyOf(entry).add(st.group);
    },

    _atlasBuildViews(entry, views) {
        const { THREE } = this.libs;
        const group = new THREE.Group();
        group.name = "atlasviews";
        group.userData.imageViewerOverlay = true;
        const d = this._atlasViewDistance(entry);
        const src = entry.item.src || {};
        for (const v of views) {
            const r = new THREE.Vector3(...v.right), u = new THREE.Vector3(...v.up), f = new THREE.Vector3(...v.fwd);
            const back = f.clone().negate();
            const one = new THREE.Group();
            one.userData.atlasViewId = v.id;
            one.userData.imageViewerOverlay = true;
            one.matrixAutoUpdate = false;
            one.matrix.makeBasis(r, u, back).setPosition(new THREE.Vector3(...v.pos));
            const h = 2 * d * Math.tan(((Number(v.fov) || 50) * Math.PI) / 360);
            const w = h * (Number(v.aspect) || 16 / 9);
            // The frustum: four edges from the camera to the picture's corners, and the picture's frame.
            const c = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
            const pts = [];
            for (const [x, y] of c) pts.push(0, 0, 0, x, y, -d);
            for (let i = 0; i < 4; i++) {
                const [x0, y0] = c[i], [x1, y1] = c[(i + 1) % 4];
                pts.push(x0, y0, -d, x1, y1, -d);
            }
            // A small mark for "up", as camera icons have.
            pts.push(-w / 6, h / 2, -d, 0, h / 2 + h / 6, -d, 0, h / 2 + h / 6, -d, w / 6, h / 2, -d);
            const lg = new THREE.BufferGeometry();
            lg.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
            const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: VIEW_COLOR, toneMapped: false }));
            lines.raycast = noRaycast;
            lines.userData.imageViewerOverlay = true;
            lines.userData.imageViewerCameraHelper = true;          // the Display menu's "cameras"
            one.add(lines);
            const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({
                color: 0xffffff, side: THREE.DoubleSide, toneMapped: false, transparent: true, opacity: 0.92,
            }));
            plane.position.set(0, 0, -d);
            plane.name = "imageplane";
            plane.raycast = noRaycast;
            plane.userData.imageViewerOverlay = true;
            one.add(plane);
            const url = this.hooks.srcUrl && v.image ? this.hooks.srcUrl({ path: v.image, external: !!src.external }) : "";
            if (url) {
                this._loadTexture(url).then((tex) => {
                    if (!plane.parent) { tex.dispose(); return; }
                    tex.colorSpace = THREE.SRGBColorSpace;
                    plane.material.map = tex;
                    plane.material.needsUpdate = true;
                    this.requestRender();
                }).catch(() => {});
            }
            one.updateMatrixWorld(true);
            group.add(one);
        }
        return group;
    },

    // ── Point cloud ───────────────────────────────────────────────────────────

    _atlasSyncPoints(entry, on) {
        const pc = entry.atlasPts;
        if (pc && (!on || pc.object !== entry.object)) {
            for (const [mesh, points] of pc.list) {
                if (points.parent) points.parent.remove(points);
                points.geometry.dispose();
                points.material.dispose();
                if (pc.object === entry.object) mesh.visible = true;
            }
            entry.atlasPts = null;
        }
        if (!on || !entry.object || entry.atlasPts) return;
        entry.atlasPts = { object: entry.object, list: this._atlasBuildPoints(entry) };
    },

    _atlasBuildPoints(entry) {
        const { THREE } = this.libs;
        const meshes = [];
        entry.object.traverse((o) => { if (o.isMesh && o.geometry && o.geometry.attributes.position) meshes.push(o); });
        const d = this._atlasViewDistance(entry);
        const list = [];
        for (const mesh of meshes) {
            const pos = mesh.geometry.attributes.position;
            const uv = mesh.geometry.attributes.uv;
            const mat = (this._originals && this._originals.get(mesh)) || mesh.material;
            const colors = new Float32Array(pos.count * 3).fill(0.8);
            const pixels = this._atlasTexturePixels(mat && mat.map);
            if (pixels && uv) {
                const { w, h, data, flipY } = pixels;
                for (let i = 0; i < pos.count; i++) {
                    const s = Math.min(w - 1, Math.max(0, Math.floor(uv.getX(i) * w)));
                    const t = uv.getY(i);
                    const y = Math.min(h - 1, Math.max(0, Math.floor((flipY ? 1 - t : t) * h)));
                    const k = (y * w + s) * 4;
                    // sRGB to linear: the colour buffer is linear, the picture is not.
                    for (let c = 0; c < 3; c++) {
                        const x = data[k + c] / 255;
                        colors[i * 3 + c] = x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
                    }
                }
            }
            const g = new THREE.BufferGeometry();
            g.setAttribute("position", pos);
            g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
            const points = new THREE.Points(g, new THREE.PointsMaterial({
                size: d * 0.06, sizeAttenuation: true, vertexColors: true, toneMapped: false,
            }));
            points.name = "atlaspoints";
            points.raycast = noRaycast;
            points.userData.imageViewerAtlasPoints = true;
            points.position.copy(mesh.position);
            points.quaternion.copy(mesh.quaternion);
            points.scale.copy(mesh.scale);
            mesh.parent.add(points);
            mesh.visible = false;
            list.push([mesh, points]);
        }
        return list;
    },

    /** A texture's picture as RGBA bytes, at most MAX_TEX_SIDE on a side, or null. */
    _atlasTexturePixels(tex) {
        const img = tex && tex.image;
        const iw = img && (img.width || img.naturalWidth), ih = img && (img.height || img.naturalHeight);
        if (!iw || !ih) return null;
        const k = Math.min(1, MAX_TEX_SIDE / Math.max(iw, ih));
        const w = Math.max(1, Math.round(iw * k)), h = Math.max(1, Math.round(ih * k));
        try {
            const cv = this.doc.createElement("canvas");
            cv.width = w; cv.height = h;
            const ctx = cv.getContext("2d", { willReadFrequently: true });
            ctx.drawImage(img, 0, 0, w, h);
            // three flips a picture on upload when flipY is set: v = 0 is then the picture's last row.
            return { w, h, data: ctx.getImageData(0, 0, w, h).data, flipY: tex.flipY !== false };
        } catch (_) {
            return null;
        }
    },

    /** For a depth pass: the world's meshes as meshes again (and the points away); `undo` puts it back. */
    _atlasDepthBegin() {
        const undo = [];
        for (const entry of (this._entries || new Map()).values()) {
            const pc = entry.atlasPts;
            if (!pc) continue;
            for (const [mesh, points] of pc.list) {
                undo.push([mesh, mesh.visible], [points, points.visible]);
                mesh.visible = true;
                points.visible = false;
            }
        }
        return () => { for (const [o, v] of undo) o.visible = v; };
    },
};

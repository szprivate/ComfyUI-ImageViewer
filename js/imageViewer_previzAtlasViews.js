// imageViewer_previzAtlasViews.js
// The panel side of how an Atlas world is shown (the drawing is imageViewer_atlas3d.js):
//   - the world's views, read from world.json whenever the world (re)loads - so a render added to the world
//     shows up as a new camera with its picture once the world is reloaded after it;
//   - "Show views" / "Show as point cloud" in the Atlas menu (kept on the world item);
//   - "Camera from view ▸": a scene camera exactly where Atlas has that view, to look through or render from;
//   - "Rebuild mesh": world.glb made again from the depth maps on disk with the cleaned meshes (no spikes at
//     silhouettes), by the agentY host; free, a few seconds.
import { api } from "../../scripts/api.js";
import { notice } from "./imageViewer_exportUI.js";
import * as S from "./imageViewer_scene3d.js";

async function jsonOf(res) {
    let body = {};
    try { body = await res.json(); } catch (_) { /* not JSON */ }
    if (!res.ok) throw new Error(body.error || `the viewer server answered ${res.status}`);
    return body;
}

/** Euler XYZ degrees of a rotation matrix with these columns (right, up, back). */
function eulerXYZ(r, u, b) {
    // m = [r u b] column-major; three's Euler XYZ from a rotation matrix.
    const m11 = r[0], m12 = u[0], m13 = b[0];
    const m22 = u[1], m23 = b[1];
    const m32 = u[2], m33 = b[2];
    const y = Math.asin(Math.max(-1, Math.min(1, m13)));
    let x, z;
    if (Math.abs(m13) < 0.9999999) {
        x = Math.atan2(-m23, m33);
        z = Math.atan2(-m12, m11);
    } else {
        x = Math.atan2(m32, m22);
        z = 0;
    }
    const deg = 180 / Math.PI;
    return [x * deg, y * deg, z * deg];
}

export const PrevizAtlasViewsMixin = {

    /** Read the world's views and hand them to the 3D view. Answers them (or [] when they cannot be read). */
    async previzAtlasLoadViews(item) {
        if (!item || !item.src || !item.src.path) return [];
        try {
            const info = await jsonOf(await api.fetchApi(`/imageviewer/atlas_world?path=${encodeURIComponent(item.src.path)}`));
            const views = Array.isArray(info.views) ? info.views : [];
            this._atlasViewList = { id: item.id, views };
            const view = this._modelView && this._modelView();
            if (view && view.atlasSetViews) view.atlasSetViews(item.id, views);
            return views;
        } catch (_) {
            return [];
        }
    },

    async _previzAtlasSet(field, value, label) {
        const item = this.previzAtlasItem && this.previzAtlasItem();
        if (!item) return;
        this.previzSnapshot(label);
        if (value) item[field] = field === "atlasViews" ? undefined : true;
        else if (field === "atlasViews") item.atlasViews = false;
        else delete item[field];
        if (item.atlasViews === undefined) delete item.atlasViews;
        await this.previzChanged();
        if (field === "atlasViews" && value && !(this._atlasViewList && this._atlasViewList.id === item.id)) {
            await this.previzAtlasLoadViews(item);
        }
    },

    previzAtlasToggleViews() {
        const item = this.previzAtlasItem && this.previzAtlasItem();
        if (item) return this._previzAtlasSet("atlasViews", item.atlasViews === false, "show / hide the world's views");
    },

    previzAtlasTogglePoints() {
        const item = this.previzAtlasItem && this.previzAtlasItem();
        if (item) return this._previzAtlasSet("atlasPoints", item.atlasPoints !== true, "world as point cloud");
    },

    /** A scene camera where Atlas has this view: parented to the world, so it moves with it. */
    async previzAtlasCameraFromView(v) {
        const item = this.previzAtlasItem && this.previzAtlasItem();
        if (!item || !v) return null;
        const scene = this.previzScene();
        this.previzSnapshot("camera from Atlas view");
        const back = v.fwd.map((x) => -x);
        const cam = S.makeCameraItem(`Atlas view ${v.id}`, {
            position: v.pos.slice(),
            rotation: eulerXYZ(v.right, v.up, back),
            fov: Math.round((Number(v.fov) || 50) * 100) / 100,
            parent: item.id,
        });
        // The camera's gate is the picture's shape.
        const a = Number(v.aspect) || 16 / 9;
        const w = Array.isArray(cam.resolution) ? cam.resolution[0] : 1280;
        cam.resolution = [w, Math.max(2, Math.round(w / a / 2) * 2)];
        scene.items.push(cam);
        if (this.previzSelect) this.previzSelect(cam.id);
        await this.previzChanged();
        notice("info", "Camera from Atlas view", `"${cam.name}" stands where Atlas has that view; look through it to see the picture's framing.`);
        return cam;
    },

    /** world.glb made again from the depth maps on disk, with the cleaned meshes; then shown. */
    async previzAtlasRebuild() {
        const item = this.previzAtlasItem && this.previzAtlasItem();
        if (!item) { notice("warn", "Rebuild mesh", "Open an Atlas world first."); return null; }
        if (this._atlasRebuilding) return null;
        this._atlasRebuilding = true;
        notice("info", "Rebuild mesh", "Building the world's mesh again from its depth maps…");
        try {
            const out = await jsonOf(await api.fetchApi("/imageviewer/atlas_rebuild", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ world_path: item.src.path }),
            }));
            const fresh = await this.previzAtlasReloadWorld(item);
            notice("info", "Mesh rebuilt", fresh ? "The cleaned mesh is showing." : "The mesh was rebuilt; re-open the world to see it.");
            return out;
        } catch (e) {
            notice("error", "Rebuild mesh", (e && e.message) || String(e));
            return null;
        } finally {
            this._atlasRebuilding = false;
        }
    },

    /** The Atlas menu's entries for how the world is shown. */
    previzAtlasViewEntries(world) {
        const item = world ? this.previzAtlasItem() : null;
        const need = "Open an Atlas world in the 3D space first.";
        const views = (item && this._atlasViewList && this._atlasViewList.id === item.id) ? this._atlasViewList.views : [];
        return [
            { label: `${item && item.atlasViews !== false ? "\u2713 " : ""}Show views`, disabled: !world,
              title: world ? "Every picture of the world at the camera Atlas has for it" : need,
              run: () => this.previzAtlasToggleViews() },
            { label: `${item && item.atlasPoints === true ? "\u2713 " : ""}Show as point cloud`, disabled: !world,
              title: world ? "Draw the world's mesh as its points, coloured by its pictures" : need,
              run: () => this.previzAtlasTogglePoints() },
            { label: "Camera from view", disabled: !world || !views.length,
              title: !world ? need : views.length ? "A scene camera where Atlas has a view" : "The world has no views with a camera",
              sub: views.map((v) => ({ label: `View ${v.id}${v.source ? ` · ${v.source}` : ""}`,
                                             run: () => this.previzAtlasCameraFromView(v) })) },
            { label: "Rebuild mesh", disabled: !world,
              title: world ? "Make the world's mesh again from its depth maps, cleaned (no spikes at the borders). Free."
                  : need, run: () => this.previzAtlasRebuild() },
        ];
    },
};

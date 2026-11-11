// imageViewer_previzAtlasOrient.js
// Auto-orient an Atlas world in the 3D space, and the Atlas menu.
//
// Auto-orient (Sebastian 2026-11-11: "walking through an Atlas scene is almost impossible"): the world's mesh
// lies in its first picture's camera frame, so a photo that looked down gives a tilted floor. When the world
// comes up in the 3D space, and whenever its world.json has a camera more than when it was last oriented (a
// view added by Render with Atlas, Chisel, the agent), the world item is turned upright with its floor at
// y = 0 (imageViewer_atlasOrient.js does the maths). Scene cameras that are not animated go along, so what
// they look at stays. The world's transform is an ordinary edit: one undo step, and the renders follow it
// (they send the world's matrix). The menu's "Auto-orient world" does it on demand.
//
// The Atlas menu: every Atlas tool in one place - the Previz panel's "Atlas" button and the bar's 3D menu
// (a submenu there) open the same entries (`previzAtlasMenuEntries`).
import { api } from "../../scripts/api.js";
import { notice } from "./imageViewer_exportUI.js";
import { pref, PREF } from "./imageViewer_settings.js";
import * as O from "./imageViewer_atlasOrient.js";
import * as S from "./imageViewer_scene3d.js";

const MAX_POINTS = 20000;

async function worldCameras(path) {
    const res = await api.fetchApi(`/imageviewer/atlas_world?path=${encodeURIComponent(path)}`);
    let body = {};
    try { body = await res.json(); } catch (_) { /* not JSON */ }
    if (!res.ok) throw new Error(body.error || `the viewer server answered ${res.status}`);
    return body;
}

export const PrevizAtlasOrientMixin = {

    /** A sample of the world mesh's vertices in its own (mesh) frame, flat [x, y, z, ...], or null. */
    _atlasMeshPoints(item) {
        const view = this._modelView && this._modelView();
        const entry = view && view._entries && view._entries.get(item.id);
        const body = entry && view._bodyOf(entry);
        if (!body || !entry.object) return null;
        const { THREE } = view.libs || {};
        if (!THREE) return null;
        body.updateWorldMatrix(true, true);
        const inv = new THREE.Matrix4().copy(body.matrixWorld).invert();
        const meshes = [];
        let total = 0;
        entry.object.traverse((o) => {
            const pos = o.isMesh && o.geometry && o.geometry.attributes && o.geometry.attributes.position;
            if (pos) { meshes.push([o, pos]); total += pos.count; }
        });
        if (!total) return null;
        const step = Math.max(1, Math.ceil(total / MAX_POINTS));
        const out = [];
        const v = new THREE.Vector3();
        const m = new THREE.Matrix4();
        for (const [o, pos] of meshes) {
            m.multiplyMatrices(inv, o.matrixWorld);
            for (let i = 0; i < pos.count; i += step) {
                v.fromBufferAttribute(pos, i).applyMatrix4(m);
                out.push(v.x, v.y, v.z);
            }
        }
        return out;
    },

    /**
     * Stand the Atlas world upright, its floor at y = 0. `force`: even when it was oriented with as many cameras.
     * Answers what it did ({tilt, how}) or null when there was nothing to do.
     */
    async previzAtlasOrient({ force = true, quiet = false } = {}) {
        const key = this.activeTab;
        const item = this.previzAtlasItem && this.previzAtlasItem(key);
        if (!item) { if (!quiet) notice("warn", "Auto-orient world", "Open an Atlas world first."); return null; }
        if (this._atlasOrienting) return null;
        if (S.isAnimated(item, "position") || S.isAnimated(item, "rotation")) {
            if (!quiet) notice("warn", "Auto-orient world", "The world has keyframes on its position or rotation; take them off first.");
            return null;
        }
        this._atlasOrienting = true;
        try {
            const info = await worldCameras(item.src.path);
            if (!force && item.atlasOrient && item.atlasOrient.frames === info.frames) return null;
            const points = this._atlasMeshPoints(item);
            if (!points) return null;                       // not loaded yet: the load will ask again
            // The page may have moved on while the cameras were read.
            if (this.activeTab !== key || this.previzAtlasItem(key) !== item) return null;
            const orient = O.orientWorld(info.cameras || [], points);
            const place = O.placeWorld(orient, item);
            const scene = this.previzScene(key);
            this.previzSnapshot("auto-orient world");
            const delta = O.worldDelta({ rotation: item.rotation, position: item.position }, place);
            item.rotation = place.rotation;
            item.position = place.position;
            item.atlasOrient = { frames: info.frames || 0 };
            // Cameras that are not animated go along, so they keep looking at what they looked at.
            for (const cam of scene.items) {
                if (cam.kind !== "camera" || cam.parent || S.isAnimated(cam, "position") || S.isAnimated(cam, "rotation")) continue;
                const moved = O.carry(delta, cam);
                cam.position = moved.position;
                cam.rotation = moved.rotation;
            }
            await this.previzChanged();
            const how = orient.floor ? "its floor" : orient.how === "cameras" ? "its cameras" : "its first camera";
            if (!quiet || orient.tilt > 2) {
                notice("info", "World set upright", `Levelled by ${how} (it was ${orient.tilt.toFixed(1)}° off), `
                    + "floor at 0. Ctrl+Z puts it back.");
            }
            return { tilt: orient.tilt, how: orient.how };
        } catch (e) {
            if (!quiet) notice("error", "Auto-orient world", (e && e.message) || String(e));
            return null;
        } finally {
            this._atlasOrienting = false;
        }
    },

    /** A model finished loading: an Atlas world not yet oriented with all its cameras is oriented now. */
    previzAtlasMaybeOrient(itemId) {
        if (!this.isPrevizTab || !this.isPrevizTab()) return;
        const item = this.previzAtlasItem && this.previzAtlasItem();
        if (!item || item.id !== itemId) return;
        // Its views (the pictures at their cameras), read again: a render added to the world is one more.
        if (this.previzAtlasLoadViews) this.previzAtlasLoadViews(item);
        this.previzAtlasOrient({ force: false, quiet: true });
    },

    /** Every Atlas tool, as menu entries (the Previz panel's Atlas button, the 3D bar menu's Atlas submenu). */
    previzAtlasMenuEntries() {
        const world = !!(this.isPrevizTab && this.isPrevizTab() && this.previzAtlasItem && this.previzAtlasItem());
        const need = "Open an Atlas world in the 3D space first (New Atlas world, or atlas_open_in_viewer).";
        const entries = [
            { label: "New Atlas world…", title: "Describe a place or bring pictures of it; World Labs Atlas makes a world",
              run: () => this.atlasCreateDialog() },
            "-",
            { label: "Render view with Atlas…", disabled: !world, title: world ? "World Labs paints a new picture from "
                + "the camera you look through" : need, run: () => this.previzAtlasDialog() },
        ];
        if (pref(PREF.atlasMove) === true) {
            const sc = world ? this.previzScene() : null;
            const animated = !!(sc && sc.items.some((i) => i.kind === "camera"
                && (S.isAnimated(i, "position") || S.isAnimated(i, "rotation"))));
            entries.push({ label: "Render camera with Atlas…", disabled: !world || !animated,
                           title: !world ? need : animated ? "World Labs paints views along the camera's keyframed animation"
                               : "Needs a camera with keyframes on the timeline (two at least)",
                           run: () => this.previzAtlasMoveDialog() });
        }
        entries.push(
            { label: "Chisel this view…", disabled: !world, title: world ? "Atlas Chisel at the camera you look through"
                : need, run: () => this.atlasChiselDialog() },
            "-",
            { label: "Auto-orient world", disabled: !world, title: world ? "Stand the world upright with its floor at 0 "
                + "(done by itself when it opens and when it gets a new view)" : need,
              run: () => this.previzAtlasOrient({ force: true }) },
            ...(this.previzAtlasViewEntries ? ["-", ...this.previzAtlasViewEntries(world), "-"] : []),
            { label: "Export Gaussian splat…", disabled: !world, title: world ? "World Labs builds a Gaussian splat "
                + "from the world's views (posedImages2Splats)" : need, run: () => this.atlasSplatDialog() },
        );
        return entries;
    },

    /** The Previz panel's Atlas button: the Atlas menu under it. */
    previzAtlasMenu(button) {
        const r = button.getBoundingClientRect();
        this._previzOpenMenu(this.previzAtlasMenuEntries(), r.left, r.bottom + 2, button);
    },
};

// bEpicViewer_mixinPreviz.js
// The previz side of a 3D tab: several models in one scene, a transform gizmo,
// cameras you can look through, and keyframes on the viewer's own timeline.
//
// A 3D tab starts as a plain model tab (one model, as it always was). Turning
// previz on gives that tab a scene — `scene3d.js` data, shown by the scene half
// of `Model3DView`, edited through the panel built here.
//
// While previz is on, the tab's timeline is the SHOT's timeline: frame 0..length
// of the scene, not the tab's media frames. Keyframe ticks share the strip the
// Roto tool uses (#kf-ticks); a 3D tab has no roto, so they can't collide.
import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";
import * as S from "./bEpicViewer_scene3d.js";

const VEC_LABELS = ["X", "Y", "Z"];
// Maya's manipulator keys, which is what the hotkeys below bind to.
export const PrevizMixin = {

    // ── Scene per tab ────────────────────────────────────────────────────────

    previzScene(key = this.activeTab) {
        return (this._scenes && this._scenes[key]) || null;
    },

    isPrevizTab(key = this.activeTab) {
        return !!this.previzScene(key);
    },

    /** Frames the timeline covers while previz is on. */
    previzFrameCount(key = this.activeTab) {
        const scene = this.previzScene(key);
        return scene ? Math.max(1, scene.length) : 0;
    },

    _setScene(key, scene) {
        if (!this._scenes) this._scenes = {};
        if (scene) this._scenes[key] = scene;
        else delete this._scenes[key];
    },

    /**
     * Make this tab's scene, if it hasn't got one.
     *
     * Called from the 3D view's own entry point, so opening a model IS opening
     * a scene that holds it. Building needs the server (a dropped file has to
     * be resolved to something the scene can point at), so it runs in the
     * background and hands back nothing; the reload at the end comes back
     * through here with the scene in place.
     */
    _previzBuildForTab(key = this.activeTab) {
        const scene = this.previzScene(key);
        if (scene) return scene;
        if (!this._previzBuilding) this._previzBuilding = {};
        if (this._previzBuilding[key]) return null;
        this._previzBuilding[key] = true;
        this.enterPreviz(key).finally(() => { delete this._previzBuilding[key]; });
        return null;
    },

    /**
     * Turn the current 3D tab into a scene. Whatever the tab is showing becomes
     * its first object, so the scene starts from the model already on screen.
     */
    async enterPreviz(key = this.activeTab) {
        if (this.previzScene(key)) return this.previzScene(key);
        const scene = S.makeScene();
        const frames = (this.allTabs[key] || []).filter((f) => this._frameIsModel(f));
        for (const frame of frames) {
            const item = S.makeModelItem(await this._previzSrcFor(frame), frame.name || frame.filename);
            item.name = S.uniqueName(scene, item.name);
            item.fromTab = true;             // replaced when the node sends new media
            scene.items.push(item);
        }
        this._setScene(key, scene);
        this._previzSelection = scene.items.length ? scene.items[0].id : null;
        // The scene first, so the frame change below shows it instead of racing
        // a second load against it.
        await this.previzChanged({ reload: true });
        this.applyTimelineBounds();
        this.setFrame(0);
        return scene;
    },

    /**
     * Open (or build) a scene node's previz tab and show it — what the node's
     * "Open in Image Viewer" button calls. The tab normally appears only once
     * the node has run; here it is made from the node itself, so a shot can be
     * built before anything is queued.
     */
    openPrevizForNode(node, { key, label, sceneData, renderName } = {}) {
        if (!key) return null;
        if (!this.allTabs[key]) {
            this.allTabs[key] = [];
            this.tabLabels[key] = label || key;
            if (node && node.id != null) this.tabSourceNodeIds[key] = node.id;
            if (!this.tabOrder.includes(key)) this.tabOrder.push(key);
            this._rebuildTabBar(null);
        } else if (node && node.id != null) {
            this.tabSourceNodeIds[key] = node.id;
        }
        if (renderName) {
            if (!this._previzRenderNames) this._previzRenderNames = {};
            this._previzRenderNames[key] = renderName;
        }
        this.previzAdoptSceneData(key, sceneData || "", { always: true });
        this.requestPanelOpen();
        this.switchTab(key);
        return this.previzScene(key);
    },

    /** What a scene item needs to find a model file again. */
    _srcOfFrame(frame) {
        if (!frame) return null;
        const src = { name: frame.name || frame.filename || "model", format: frame.format || null };
        if (frame.path) { src.path = frame.path; src.external = !!frame.external; }
        // A file dropped from the desktop lives on a blob: URL and ALSO carries
        // a made-up filename (see _frameForDroppedFile). Asking the server for
        // that name fetches nothing, which left an empty object with only its
        // gizmo on screen — the blob is the real source.
        else if (frame.url) src.url = frame.url;
        else if (frame.filename) {
            src.filename = frame.filename;
            src.subfolder = frame.subfolder || "";
            src.type = frame.type || "output";
        }
        return src;
    },

    /**
     * A source the scene can still find later. A blob: URL dies with the page,
     * so a dropped model is copied into ./input/3d first — where the Load 3D
     * node reads from too. The blob is kept when that fails, so the model at
     * least shows for this session.
     */
    async _previzSrcFor(frame) {
        const src = this._srcOfFrame(frame);
        if (!src || !src.url) return src;
        try {
            const res = await fetch(src.url);
            if (!res.ok) throw new Error(`fetch ${res.status}`);
            const blob = await res.blob();
            const name = this._basename(frame.name || frame.filename || "model.glb");
            const body = new FormData();
            body.append("image", new File([blob], name, { type: "application/octet-stream" }), name);
            body.append("subfolder", "3d");
            body.append("type", "input");
            body.append("overwrite", "true");
            const up = await api.fetchApi("/upload/image", { method: "POST", body });
            if (up.status !== 200) throw new Error(`upload ${up.status}`);
            const data = await up.json();
            return {
                name: src.name, format: src.format,
                filename: data.name, subfolder: data.subfolder || "3d",
                type: data.type || "input",
            };
        } catch (e) {
            console.warn("[bEpicViewer] could not copy the dropped model into ./input/3d", e);
            return src;
        }
    },

    // ── Editing ──────────────────────────────────────────────────────────────

    /**
     * Push the scene into the view and the UI after any edit.
     * `reload` re-reconciles the three objects (an item was added or removed);
     * without it only the transforms are re-applied, which is what dragging the
     * gizmo or scrubbing the timeline needs.
     */
    previzChanged({ reload = false, persist = true, light = false } = {}) {
        const scene = this.previzScene();
        if (!scene) return Promise.resolve();
        const view = this._modelView();
        const done = reload ? view.setScene(scene, this.currentFrame || 0)
                            : (view.applyFrame(this.currentFrame || 0), Promise.resolve());
        // Adding, duplicating or deleting an item moves the selection; without
        // this the gizmo stayed on whatever was selected before, so dragging it
        // moved something other than the item the panel was showing.
        if (view.selected !== this._previzSelection) view.select(this._previzSelection);
        // `light` is for the middle of a drag: rebuilding the outliner on every
        // mouse move is a lot of DOM for something that hasn't changed.
        if (light) this._previzRefreshFields();
        else this._previzRenderPanel();
        this._previzRenderTicks();
        this.previzRefreshCurves();
        if (persist) {
            this.previzPersist();
            this.queuePersistViewerState();
        }
        return done;
    },

    /** Gizmo mode from a hotkey (W / E / R), and Q for no gizmo at all. */
    previzSetGizmoMode(mode) {
        if (!this.isPrevizTab()) return;
        const view = this._modelView();
        if (mode === "none") this.previzSelect(null);
        else view.setGizmoMode(mode);
        this._previzRenderPanel();
    },

    previzToggleGizmoSpace() {
        if (!this.isPrevizTab()) return;
        const view = this._modelView();
        view.setGizmoSpace(view.gizmoSpace === "local" ? "world" : "local");
        this._previzRenderPanel();
    },

    /**
     * Select an item — or, with `add`, take it into the selection alongside
     * whatever is already there.
     *
     * One of them is the primary: it wears the gizmo, fills the transform
     * fields and draws its curves, and it is the one you clicked last. The
     * rest are along for what acts on a group of things — Group, Delete,
     * Duplicate.
     */
    previzSelect(id, { add = false } = {}) {
        const also = this._previzAlso || (this._previzAlso = new Set());
        if (!id) {
            also.clear();
            this._previzSelection = null;
        } else if (!add) {
            also.clear();
            this._previzSelection = id;
        } else if (this.previzIsSelected(id)) {
            // Shift-clicking something already in takes it out again.
            also.delete(id);
            if (this._previzSelection === id) {
                const rest = [...also];
                this._previzSelection = rest.length ? rest.pop() : null;
                if (this._previzSelection) also.delete(this._previzSelection);
            }
        } else {
            if (this._previzSelection) also.add(this._previzSelection);
            this._previzSelection = id;
        }
        if (this._model3d) {
            this._model3d.select(this._previzSelection);
            this._model3d.setAlsoSelected([...also]);
        }
        this._previzRenderPanel();
        this._previzRenderTicks();
        this.previzRefreshCurves();
    },

    previzIsSelected(id) {
        return !!id && (id === this._previzSelection || !!(this._previzAlso && this._previzAlso.has(id)));
    },

    /** Everything selected, the primary last — the order Group reads them in. */
    previzSelectedIds() {
        const also = [...(this._previzAlso || [])].filter((id) => S.itemById(this.previzScene(), id));
        return this._previzSelection ? [...also, this._previzSelection] : also;
    },

    previzSelectedItem() {
        return S.itemById(this.previzScene(), this._previzSelection);
    },

    async previzAddModels(items) {
        const scene = this.previzScene();
        if (!scene || !items || !items.length) return 0;
        this.previzSnapshot(items.length > 1 ? "add models" : "add model");
        const wasEmpty = scene.items.length === 0;
        let added = 0;
        for (const it of items) {
            const src = await this._previzSrcFor(it);
            if (!src || (!src.path && !src.filename && !src.url)) continue;
            const item = S.makeModelItem(src, src.name);
            item.name = S.uniqueName(scene, item.name);
            scene.items.push(item);
            this._previzSelection = item.id;
            added++;
        }
        if (!added) return 0;
        await this.previzChanged({ reload: true });
        // The first model in an empty scene is what the camera should frame.
        if (wasEmpty && this._model3d) this._model3d.resetView();
        return added;
    },

    /**
     * Add a blocking shape. It lands at the middle of the view rather than at
     * the world origin, so it appears where you are looking instead of
     * somewhere off screen.
     */
    async previzAddPrimitive(type) {
        const scene = this.previzScene();
        if (!scene) return null;
        this.previzSnapshot(`add ${type}`);
        const wasEmpty = scene.items.length === 0;
        const item = S.makePrimitiveItem(type);
        item.name = S.uniqueName(scene, item.name);
        const view = this._modelView();
        const at = view.viewFocus && view.viewFocus();
        if (at) item.position = [at[0], item.position[1] + at[1], at[2]];
        scene.items.push(item);
        this._previzSelection = item.id;
        await this.previzChanged({ reload: true });
        if (wasEmpty && this._model3d) this._model3d.resetView();
        return item;
    },

    /** A camera where the viewport is looking right now. */
    previzAddCamera() {
        const scene = this.previzScene();
        if (!scene) return null;
        this.previzSnapshot("add camera");
        const view = this._modelView();
        const at = view.viewTransform();
        const item = S.makeCameraItem(S.uniqueName(scene, "Camera"), {
            position: at.position, rotation: at.rotation, fov: at.fov,
        });
        scene.items.push(item);
        this._previzSelection = item.id;
        this.previzChanged({ reload: true });
        return item;
    },

    /**
     * Copy an item, and everything under it if it is a group.
     * Takes one id, several, or none for whatever is selected.
     */
    previzDuplicate(id = null) {
        const scene = this.previzScene();
        if (!scene) return;
        const ids = this._previzIdList(id);
        if (ids.length > 1) {
            this.previzSnapshot(`duplicate ${ids.length} items`);
            // Each in turn, and no snapshot of its own: the one above covers
            // the lot, so a single undo puts the scene back.
            for (const one of ids) this._previzDuplicateOne(one, { snapshot: false });
            this.previzChanged({ reload: true });
            return;
        }
        this._previzDuplicateOne(ids[0] || null, { snapshot: true });
        this.previzChanged({ reload: true });
    },

    /** One id, several, or the current selection — as a plain list of ids. */
    _previzIdList(id) {
        if (Array.isArray(id)) return id.filter(Boolean);
        if (id) return [id];
        return this.previzSelectedIds();
    },

    _previzDuplicateOne(id, { snapshot = true } = {}) {
        const scene = this.previzScene();
        const item = id ? S.itemById(scene, id) : this.previzSelectedItem();
        if (!scene || !item) return;
        if (snapshot) this.previzSnapshot(`duplicate ${item.name}`);

        const branch = [item, ...S.descendantsOf(scene, item.id)];
        const newId = new Map();
        const copies = branch.map((src) => {
            const copy = JSON.parse(JSON.stringify(src));
            copy.id = S.newId(src.kind === "camera" ? "c" : src.kind === "group" ? "g" : "m");
            copy.name = S.uniqueName(scene, src.name);
            newId.set(src.id, copy.id);
            return copy;
        });
        // Inside the copy, parents point at the copies; the top of it keeps the
        // parent the original had.
        copies.forEach((copy, i) => {
            const was = branch[i].parent;
            copy.parent = (was && newId.has(was)) ? newId.get(was) : (i === 0 ? was || null : null);
        });
        scene.items.splice(scene.items.indexOf(item) + branch.length, 0, ...copies);
        this._previzSelection = copies[0].id;
        if (this._previzAlso) this._previzAlso.clear();
    },

    /**
     * Delete an item — a group takes what it holds with it.
     * Takes one id, several, or none for whatever is selected.
     */
    previzDelete(id = null) {
        const scene = this.previzScene();
        if (!scene) return;
        const ids = this._previzIdList(id);
        const gone = new Set();
        for (const one of ids) {
            const item = S.itemById(scene, one);
            if (!item) continue;
            gone.add(item);
            for (const child of S.descendantsOf(scene, item.id)) gone.add(child);
        }
        if (!gone.size) return;
        const first = S.itemById(scene, ids[0]);
        const label = ids.length > 1 ? `delete ${ids.length} items`
            : (gone.size > 1 ? `delete ${first.name} and ${gone.size - 1} inside it`
                             : `delete ${first.name}`);
        this.previzSnapshot(label);
        scene.items = scene.items.filter((it) => !gone.has(it));
        if ([...gone].some((it) => it.id === scene.activeCamera)) scene.activeCamera = null;
        this._previzSelection = scene.items.length ? scene.items[0].id : null;
        if (this._previzAlso) this._previzAlso.clear();
        this.previzChanged({ reload: true });
        if (this._model3d) this._model3d.setActiveCamera(scene.activeCamera);
    },

    /**
     * Insert, as in Maya: the gizmo drags the pivot instead of the object.
     * It is a mode of the view, not of the scene, so it goes away with the tab.
     */
    previzTogglePivotMode(on) {
        this._previzPivotMode = on === undefined ? !this._previzPivotMode : !!on;
        const view = this._modelView();
        if (view.setPivotMode) view.setPivotMode(this._previzPivotMode);
        this._previzRenderPanel();
        return this._previzPivotMode;
    },

    /** Move an item's pivot without moving the item. */
    previzSetPivot(id, pivot) {
        const item = S.itemById(this.previzScene(), id);
        const view = this._modelView();
        if (!item || !view._pivotShiftLocal || !view.libs) return;
        const frame = Math.round(this.currentFrame || 0);
        const at = S.evaluate(item, frame);
        const { THREE } = view.libs;
        const now = at.pivot || [0, 0, 0];
        const e = new THREE.Vector3(pivot[0] - now[0], pivot[1] - now[1], pivot[2] - now[2]);
        this.previzApplyTransform(id, view._pivotShiftLocal(at, e), ["position", "pivot"]);
    },

    /** The pivot into the middle of the thing, which is where it usually wants
     *  to be — and nothing moves. */
    previzCentrePivot(id = null) {
        const view = this._modelView();
        if (!view.pivotCentre) return;
        const ids = this._previzIdList(id);
        if (!ids.length) return;
        this.previzSnapshot(ids.length > 1 ? `centre ${ids.length} pivots` : "centre pivot");
        for (const one of ids) {
            const next = view.pivotCentre(one);
            if (next) this.previzApplyTransform(one, next, ["position", "pivot"]);
        }
        this.previzChanged();
    },

    previzLookThrough(id) {
        const scene = this.previzScene();
        if (!scene) return;
        scene.activeCamera = scene.activeCamera === id ? null : (id || null);
        if (this._model3d) this._model3d.setActiveCamera(scene.activeCamera);
        this.previzChanged();
    },

    /**
     * Write a transform onto the selected item. A property that is already
     * animated — or autokey being on — puts a key at the current frame instead
     * of moving the item for the whole shot, which is what would silently undo
     * the animation.
     */
    previzApplyTransform(id, transform, props, { live = false } = {}) {
        const scene = this.previzScene();
        const item = S.itemById(scene, id);
        if (!item) return;
        // One step per drag, taken as the drag starts; a typed-in number is an
        // edit of its own and gets its own step.
        if (live) this.previzBeginDrag(`move ${item.name}`);
        else if (!this._previzDragging) this.previzSnapshot(`move ${item.name}`);
        const frame = Math.round(this.currentFrame || 0);
        const write = (target, prop, value) => {
            if (this._previzAutokey || S.isAnimated(target, prop)) S.setKeyframe(target, prop, frame, value);
            else target[prop] = Array.isArray(value) ? value.slice() : value;
        };
        // Everything else that is selected comes along, by the same amount.
        // Anything inside a selected group is left out: its parent is already
        // carrying it, and moving both would move it twice.
        const others = this.previzSelectedIds().filter((x) => x !== id);
        const carried = new Set();
        for (const one of [id, ...others]) {
            for (const child of S.descendantsOf(scene, one)) carried.add(child.id);
        }
        const movers = others.filter((x) => !carried.has(x)).map((x) => S.itemById(scene, x)).filter(Boolean);

        for (const prop of props || ["position", "rotation", "scale"]) {
            const value = transform[prop];
            if (value === undefined) continue;
            if (movers.length && Array.isArray(value) && prop !== "pivot") {
                const before = S.valueAt(item, prop, frame);
                for (const other of movers) {
                    const ov = S.valueAt(other, prop, frame);
                    // Scale is a ratio — adding it would make a small thing
                    // huge and a huge thing wrong.
                    const next = prop === "scale"
                        ? ov.map((v, i) => (before[i] ? v * (value[i] / before[i]) : v))
                        : ov.map((v, i) => v + (value[i] - before[i]));
                    write(other, prop, next);
                }
            }
            write(item, prop, value);
        }
        // Mid-drag the scene only needs the numbers; the panel, the node widget
        // and the saved state catch up when the drag ends (onTransformEnd).
        if (live) this._previzRefreshFields();
        else this.previzChanged();
    },

    /**
     * Re-read the selection's numbers into the transform fields, without
     * rebuilding the panel — cheap enough to run on every mouse move while a
     * gizmo or the camera is being dragged.
     */
    _previzRefreshFields() {
        const ui = this._previzUI;
        const item = this.previzSelectedItem();
        if (!ui || !ui.props || !item || !ui.root || ui.root.style.display === "none") return;
        const doc = ui.root.ownerDocument;
        if (doc.activeElement && doc.activeElement.classList.contains("previz-num")) return;
        this._previzRenderProps(ui, doc);
    },

    /** Key every animatable property of the selection at the current frame. */
    /** Key everything selected — one key press, one step, however many items. */
    previzKeyAll(prop) {
        const items = this.previzSelectedIds()
            .map((id) => S.itemById(this.previzScene(), id)).filter(Boolean);
        if (!items.length) return;
        this.previzSnapshot(prop ? `key ${prop}` : "key");
        const frame = Math.round(this.currentFrame || 0);
        for (const item of items) {
            const props = prop ? [prop] : (item.kind === "camera"
                ? ["position", "rotation", "fov"] : ["position", "rotation", "scale"]);
            for (const p of props) {
                S.setKeyframe(item, p, frame, S.valueAt(item, p, frame), this._previzEase || "smooth");
            }
        }
        this.previzChanged();
    },

    previzDeleteKey() {
        const items = this.previzSelectedIds()
            .map((id) => S.itemById(this.previzScene(), id)).filter(Boolean);
        if (!items.length) return;
        this.previzSnapshot("delete key");
        const frame = Math.round(this.currentFrame || 0);
        for (const item of items) S.removeKeyframe(item, frame);
        this.previzChanged();
    },

    /**
     * Show the shot's frame rate and length in the timeline's own fields.
     *
     * The previz panel used to carry a second pair, which then had to be kept
     * in step with the transport's — two places saying the same thing, and one
     * of them lying whenever the other was used. The timeline owns both now:
     * the fps box plays the shot AND sets its rate, and the frame counter at
     * the end of the slider is the last frame of the shot.
     */
    /**
     * The keying controls, in the transport beside the timeline.
     *
     * They used to sit at the foot of the previz panel, which put the thing
     * you press while watching the playhead a rail away from the playhead.
     * Built once and shown only while a 3D tab is up, since keying an image
     * means nothing.
     */
    previzEnsureKeyBar() {
        const host = this.container;
        if (!host || !host.querySelector) return null;
        if (this._previzKeyBar && this._previzKeyBar.bar.isConnected) return this._previzKeyBar;
        const transport = host.querySelector(".transport");
        if (!transport) return null;
        const doc = transport.ownerDocument;

        const bar = doc.createElement("div");
        bar.className = "previz-keybar";
        const button = (icon, fallback, title, run) => {
            const b = doc.createElement("button");
            b.className = "previz-keybtn sprite-icon";
            b.textContent = fallback;
            b.title = title;
            this._setIcon(b, icon);
            b.onclick = run;
            bar.append(b);
            return b;
        };
        const key = button("icon-circle-plus", "+", "Key the selected item's transform here",
                           () => this.previzKeyAll());
        const del = button("icon-circle-x", "\u00d7", "Remove the key under the playhead",
                           () => this.previzDeleteKey());
        const auto = button("icon-circle", "\u25cb", "Autokey: every move sets a key at this frame",
                            () => { this._previzAutokey = !this._previzAutokey; this._previzRenderPanel(); });
        const ease = doc.createElement("select");
        ease.className = "previz-sel previz-ease";
        for (const [v, label] of [["smooth", "Smooth"], ["linear", "Linear"], ["hold", "Hold"]]) {
            ease.append(Object.assign(doc.createElement("option"), { value: v, textContent: label }));
        }
        ease.title = "How new keys leave their frame";
        ease.onchange = () => {
            this._previzEase = ease.value;
            // Re-ease the keys the selection has at this frame, so the menu
            // also works as "change the key I am standing on".
            const frame = Math.round(this.currentFrame || 0);
            for (const id of this.previzSelectedIds()) {
                const item = S.itemById(this.previzScene(), id);
                if (!item) continue;
                for (const prop of S.TRACKS) {
                    for (const k of S.track(item, prop)) if (k.f === frame) k.ease = ease.value;
                }
            }
            this.previzChanged();
        };
        bar.append(ease);

        const fps = transport.querySelector("#fps-in");
        transport.insertBefore(bar, fps || transport.firstChild);
        this._previzKeyBar = { bar, key, del, auto, ease };
        return this._previzKeyBar;
    },

    previzSyncTimelineFields() {
        // Through the container, like every other reader of these two: the
        // popout moves the whole tree into another document and this still
        // finds them there.
        const host = this.container;
        if (!host || !host.querySelector) return;
        const scene = this.previzScene();
        const fpsEl = host.querySelector("#fps-in");
        const endEl = host.querySelector("#total-f");
        const doc = (endEl || fpsEl || host).ownerDocument;
        const previz = !!scene;
        if (fpsEl && previz && doc.activeElement !== fpsEl) fpsEl.value = String(scene.fps);
        // The keying controls belong to the same band as the timeline.
        const keys = this.previzEnsureKeyBar();
        if (keys) {
            keys.bar.style.display = scene ? "flex" : "none";
            if (scene) {
                const frame = Math.round(this.currentFrame || 0);
                keys.key.title = `Key the selected item's transform at frame ${frame}`;
                keys.auto.classList.toggle("on", !!this._previzAutokey);
                keys.auto.title = this._previzAutokey
                    ? "Autokey is on: every move sets a key at this frame"
                    : "Autokey: every move sets a key at this frame";
                if (keys.ease.value !== (this._previzEase || "smooth")) {
                    keys.ease.value = this._previzEase || "smooth";
                }
            }
        }
        if (!endEl) return;
        // A plain readout everywhere else: the length of a clip or a batch is
        // what it is, and only a shot you are building can be told how long.
        endEl.readOnly = !previz;
        endEl.classList.toggle("editable", previz);
        endEl.title = previz ? "The shot's last frame — type to make it longer or shorter"
                             : "Last frame";
        if (previz && doc.activeElement !== endEl) endEl.value = String(Math.max(1, scene.length) - 1);
    },

    /**
     * Make room for a model's own animation.
     *
     * A clip used to play in real time, off to one side of the timeline. Now
     * the timeline scrubs it, so a 300-frame walk cycle in a 120-frame shot
     * would simply stop halfway. An untouched shot grows to fit it; one that
     * has been keyed, or whose length was set by hand, is left alone — the
     * length is then a decision, not a default.
     */
    previzFitClipLength(frames) {
        const scene = this.previzScene();
        if (!scene || !(frames > scene.length)) return;
        if (scene.lengthSet || S.isAnimatedScene(scene)) return;
        scene.length = Math.round(frames);
        this.applyTimelineBounds();
        this.previzSyncTimelineFields();
        this.previzChanged({ persist: true, light: true });
    },

    previzSetSceneField(field, value) {
        const scene = this.previzScene();
        if (!scene) return;
        this.previzSnapshot(field === "fps" ? "frame rate" : "shot length");
        if (field === "fps") scene.fps = Math.max(0.1, Number(value) || S.DEFAULT_FPS);
        if (field === "length") {
            scene.length = Math.max(1, Math.round(Number(value) || S.DEFAULT_LENGTH));
            scene.lengthSet = true;          // said out loud: don't grow it for me
            this.applyTimelineBounds();
        }
        this.previzChanged();
    },

    // ── Persistence ──────────────────────────────────────────────────────────

    /** Keep the scene on its bEpic 3D Scene node, so it travels with the graph. */
    previzPersist(key = this.activeTab) {
        const scene = this.previzScene(key);
        if (!scene) return;
        const nodeId = this.tabSourceNodeIds && this.tabSourceNodeIds[key];
        if (nodeId == null) return;
        try {
            const node = app.graph.getNodeById(nodeId);
            const widget = node && (node.widgets || []).find((w) => w && w.name === "scene_data");
            if (!widget) return;
            const json = S.serializeScene(scene);
            if (widget.value === json) return;
            widget.value = json;
            if (app.graph) app.graph.setDirtyCanvas(true, false);
        } catch (e) {
            console.warn("[bEpicViewer] could not store the scene on its node", e);
        }
    },

    /**
     * Scene JSON a bEpic 3D Scene node sent with its tab. `always` makes the tab
     * a previz tab even when the scene is empty, which is what a freshly dropped
     * node needs: something to open the 3D view and its panel on.
     */
    previzAdoptSceneData(key, raw, { always = false } = {}) {
        const incoming = S.parseScene(raw);
        const current = this.previzScene(key);
        // The node is the source of truth only when the viewer has nothing yet:
        // otherwise a re-run would throw away edits made since.
        if (current && current.items.length) return current;
        if (!incoming.items.length && !always) return current;
        this._setScene(key, incoming);
        this._previzSelection = incoming.items.length ? incoming.items[0].id : null;
        return incoming;
    },

    // ── Timeline ─────────────────────────────────────────────────────────────

    /** Keyframe ticks for the selected item, on the strip Roto also uses. */
    _previzRenderTicks() {
        const host = this.container && this.container.querySelector("#kf-ticks");
        if (!host) return;
        if (!this.isPrevizTab()) { host.innerHTML = ""; return; }
        const scene = this.previzScene();
        const item = this.previzSelectedItem();
        const frames = item ? S.keyframeFrames(item) : S.sceneKeyframes(scene);
        const bounds = this.getTimelineBounds();
        const span = Math.max(1, bounds.max - bounds.min);
        const cur = Math.round(this.currentFrame || 0);
        host.innerHTML = "";
        const doc = host.ownerDocument;
        for (const f of frames) {
            if (f < bounds.min || f > bounds.max) continue;
            const tick = doc.createElement("div");
            tick.className = "kf-tick" + (f === cur ? " cur" : "");
            tick.style.left = `${((f - bounds.min) / span) * 100}%`;
            tick.title = `Keyframe ${f} — click to go there, double-click to delete`;
            tick.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); this.setFrame(f); };
            tick.ondblclick = (e) => {
                e.preventDefault(); e.stopPropagation();
                if (item) { S.removeKeyframe(item, f); this.previzChanged(); }
            };
            host.appendChild(tick);
        }
    },

    // ── Panel ────────────────────────────────────────────────────────────────

    /**
     * Put the panel away. The body it built stays with it, so turning previz
     * back on picks up the outliner, the fields and the scroll position it had.
     */
    _previzHidePanel() {
        this._previzPanelOn = false;
        this._previzCloseAddMenu();
        if (this._previzUI && this._previzUI.root) this._previzUI.root.style.display = "none";
        if (this.isPanelDocked("previz")) this.setPanelDocked("previz", false);
        // The curves describe the same scene, so they go with it.
        if (this._previzHideCurves) this._previzHideCurves();
        // And the timeline's last-frame box goes back to being a readout.
        this.previzSyncTimelineFields();
    },

    /**
     * Fill the dock panel in.
     *
     * The panel element itself comes from the markup and is owned by the dock
     * (rail, width, title bar, dragging); previz only puts a body inside it, so
     * an undocked viewer takes the whole thing with it and nothing here needs
     * to know which window it ended up in.
     */
    _previzBuildPanel() {
        const host = this.previzPanel;
        if (!host) return null;
        const doc = host.ownerDocument;
        const el = (tag, cls, text) => {
            const n = doc.createElement(tag);
            if (cls) n.className = cls;
            if (text !== undefined) n.textContent = text;
            return n;
        };
        const root = el("div", "previz-body");

        const actions = el("div", "previz-actions");
        const newBtn = el("button", "previz-btn previz-icon");
        newBtn.title = "New scene — empties this one (Ctrl+Z brings it back)";
        newBtn.textContent = "\u25a1";          // stands in if the skin is missing
        this._setIcon(newBtn, "icon-file");
        newBtn.onclick = () => this.previzNewScene();
        const addBtn = el("button", "previz-btn previz-add previz-icon");
        addBtn.title = "Add a model, a camera, a group or a shape";
        addBtn.textContent = "+";               // stands in if the skin is missing
        this._setIcon(addBtn, "icon-circle-plus");
        addBtn.onclick = () => this._previzToggleAddMenu(addBtn);
        const exportBtn = el("button", "previz-btn previz-icon");
        exportBtn.title = "Save, export or render this shot";
        exportBtn.textContent = "\u2193";
        this._setIcon(exportBtn, "icon-save");
        exportBtn.onclick = () => this._previzToggleExportMenu(exportBtn);
        const undoBtn = el("button", "previz-btn previz-step");
        undoBtn.textContent = "↩";              // stands in if the skin is missing
        this._setIcon(undoBtn, "icon-undo");
        undoBtn.onclick = () => this.previzUndo();
        const redoBtn = el("button", "previz-btn previz-step");
        redoBtn.textContent = "↪";
        this._setIcon(redoBtn, "icon-redo");
        redoBtn.onclick = () => this.previzRedo();

        // Duplicate and Delete live on the item itself, under a right-click —
        // they act on one row, so they belong on the row rather than on a bar
        // that has to guess which one you mean.
        actions.append(newBtn, addBtn, exportBtn, undoBtn, redoBtn);

        const list = el("div", "previz-list");
        // The space below the tree is "no parent": dropping a row here lifts it
        // out of whatever group it was in.
        list.ondragover = (e) => {
            if (!this._previzDragItem || e.target.closest(".previz-item")) return;
            e.preventDefault();
            this._previzClearDropMarks();
            list.classList.add("drop-into");
        };
        list.ondragleave = () => list.classList.remove("drop-into");
        list.ondrop = (e) => {
            if (!this._previzDragItem || e.target.closest(".previz-item")) return;
            e.preventDefault();
            this._previzClearDropMarks();
            this.previzReparent(this._previzDragItem, null);
        };

        const props = el("div", "previz-props");

        root.append(actions, list, props);
        // The title bar the dock built is a sibling and stays; only previz's own
        // body is replaced.
        this._previzCloseAddMenu();
        host.querySelectorAll(":scope > .previz-body").forEach((n) => n.remove());
        host.appendChild(root);
        this._previzUI = { root, list, props, undoBtn, redoBtn };
        return this._previzUI;
    },

    /**
     * The "+" menu: a model, a camera, or a shape to block the scene out.
     *
     * It hangs off .main-area rather than the panel because the panel clips its
     * own overflow, and it is built on demand so the listeners that close it
     * come from whichever document the viewer is living in.
     */
    /**
     * The panel's menus — the "+" list, and an item's right-click list.
     *
     * Hung off .panel-container rather than the panel: a panel clips its own
     * overflow, and it can be docked anywhere, including the bottom rail. The
     * container is the one element that is always an ancestor and is already
     * positioned, so the arithmetic below works from wherever the panel is.
     */
    _previzMenuHost() {
        const p = this.previzPanel;
        if (!p) return null;
        return p.closest(".panel-container") || p.closest(".main-area") || p.parentNode;
    },

    /**
     * Put `entries` on screen at (x, y) in client coordinates.
     * An entry is { label, run, disabled } or the string "-" for a separator.
     * `anchor`, when given, is the button that opened it: a press on it closes
     * the menu rather than immediately reopening it.
     */
    _previzOpenMenu(entries, x, y, anchor = null) {
        this._previzCloseAddMenu();
        const host = this._previzMenuHost();
        if (!host) return null;
        const doc = host.ownerDocument;

        const menu = doc.createElement("div");
        menu.className = "previz-menu";
        for (const e of entries) {
            if (e === "-") {
                menu.append(Object.assign(doc.createElement("div"), { className: "previz-menu-sep" }));
                continue;
            }
            const b = doc.createElement("button");
            b.className = "previz-menu-item";
            b.textContent = e.label;
            b.disabled = !!e.disabled;
            b.onclick = () => { this._previzCloseAddMenu(); e.run(); };
            menu.append(b);
        }
        host.appendChild(menu);

        // Where it was asked for, then pulled back inside the viewer.
        const h = host.getBoundingClientRect();
        menu.style.left = `${x - h.left}px`;
        menu.style.top  = `${y - h.top}px`;
        const m = menu.getBoundingClientRect();
        if (m.bottom > h.bottom) menu.style.top  = `${Math.max(0, y - h.top - m.height)}px`;
        if (m.right  > h.right)  menu.style.left = `${Math.max(0, h.width - m.width - 4)}px`;

        // composedPath, because a listener on the document sees every event from
        // inside the shadow root retargeted to the host element.
        this._previzAddMenu = menu;
        this._previzAddMenuAway = (ev) => {
            if (ev.type === "keydown") { if (ev.key === "Escape") this._previzCloseAddMenu(); return; }
            const path = ev.composedPath ? ev.composedPath() : [];
            if (path.includes(menu) || (anchor && path.includes(anchor))) return;
            this._previzCloseAddMenu();
        };
        // Kept, rather than read back off the menu later: undocking moves the
        // menu into another document, and the listeners stay on this one.
        this._previzAddMenuDoc = doc;
        doc.addEventListener("pointerdown", this._previzAddMenuAway, true);
        doc.addEventListener("keydown", this._previzAddMenuAway, true);
        return menu;
    },

    /** Everything that puts something INTO the scene, under one button. */
    _previzToggleAddMenu(anchor) {
        if (this._previzAddMenu) { this._previzCloseAddMenu(); return; }
        const entries = [
            { label: "Model\u2026", run: () => this.previzAddFromBrowser() },
            { label: "Camera", run: () => this.previzAddCamera() },
            { label: "Group", run: () => this.previzAddGroup() },
            "-",
        ];
        for (const spec of S.PRIMITIVES) {
            entries.push({ label: spec.label, run: () => this.previzAddPrimitive(spec.type) });
        }
        entries.push("-");
        entries.push({ label: "Import USD\u2026", run: () => this.previzImportUsd() });
        entries.push({ label: "Load scene\u2026", run: () => this.previzLoadSceneFile() });
        const a = anchor.getBoundingClientRect();
        this._previzOpenMenu(entries, a.left, a.bottom + 2, anchor);
    },

    /** ...and everything that takes something OUT of it. */
    _previzToggleExportMenu(anchor) {
        if (this._previzAddMenu) { this._previzCloseAddMenu(); return; }
        const a = anchor.getBoundingClientRect();
        this._previzOpenMenu([
            { label: "Save scene\u2026", run: () => this.previzSaveSceneFile() },
            { label: "Export USD\u2026", run: () => this.previzExportUsd() },
            "-",
            { label: "Render\u2026", run: () => this.previzRenderDialog() },
        ], a.left, a.bottom + 2, anchor);
    },

    /**
     * Empty the scene and start again.
     *
     * Not a question: it is one undo step like any other, and asking "are you
     * sure" about something Ctrl+Z takes back is noise.
     */
    previzNewScene() {
        const scene = this.previzScene();
        if (!scene) return;
        this.previzSnapshot("new scene");
        scene.items = [];
        scene.activeCamera = null;
        this._previzSelection = null;
        if (this._previzCollapsed) this._previzCollapsed.clear();
        this.previzChanged({ reload: true });
    },

    /**
     * Right-click on a row in the outliner.
     *
     * A row that is part of the current selection keeps it, so a menu opened
     * on one of five acts on all five; a row outside it selects itself first,
     * because acting on something you cannot see selected is a nasty surprise.
     */
    _previzItemMenu(id, ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (!this.previzIsSelected(id)) this.previzSelect(id);
        const item = S.itemById(this.previzScene(), id);
        if (!item) return;
        const ids = this.previzSelectedIds();
        const many = ids.length > 1;
        const count = `${ids.length} items`;
        this._previzOpenMenu([
            { label: many ? `Group ${count}` : "Group", run: () => this.previzGroupSelection() },
            "-",
            { label: many ? `Duplicate ${count}` : "Duplicate", run: () => this.previzDuplicate(ids) },
            { label: many ? `Delete ${count}` : "Delete", run: () => this.previzDelete(ids) },
        ], ev.clientX, ev.clientY);
    },

    /**
     * Put everything selected into a new group.
     *
     * The group is made at the origin with no transform of its own, so nothing
     * moves: each item keeps the local numbers it had, and they are now read
     * against a parent that is the identity. Anything whose own parent is also
     * in the selection is left where it is — it is already coming along.
     */
    previzGroupSelection() {
        const scene = this.previzScene();
        const ids = this.previzSelectedIds();
        if (!scene || !ids.length) return null;
        const chosen = new Set(ids);
        const tops = ids.filter((id) => {
            const item = S.itemById(scene, id);
            return item && !(item.parent && chosen.has(item.parent));
        });
        if (!tops.length) return null;
        this.previzSnapshot(tops.length > 1 ? `group ${tops.length} items` : "group");
        const group = S.makeGroupItem(S.uniqueName(scene, "Group"));
        // Where the group lands in the tree: with the items it takes in, when
        // they share a parent, so grouping inside a set stays inside that set.
        const parents = new Set(tops.map((id) => S.itemById(scene, id).parent || null));
        group.parent = parents.size === 1 ? [...parents][0] : null;
        scene.items.push(group);
        for (const id of tops) S.setParent(scene, id, group.id);
        this._previzSelection = group.id;
        if (this._previzAlso) this._previzAlso.clear();
        this.previzChanged({ reload: true });
        return group;
    },

    _previzCloseAddMenu() {
        if (!this._previzAddMenu) return;
        const doc = this._previzAddMenuDoc;
        doc.removeEventListener("pointerdown", this._previzAddMenuAway, true);
        doc.removeEventListener("keydown", this._previzAddMenuAway, true);
        this._previzAddMenu.remove();
        this._previzAddMenu = null;
        this._previzAddMenuAway = null;
        this._previzAddMenuDoc = null;
    },

    _previzRenderPanel() {
        if (!this.isPrevizTab()) { this._previzHidePanel(); return; }
        const ui = (this._previzUI && this._previzUI.root && this._previzUI.root.isConnected)
            ? this._previzUI : this._previzBuildPanel();
        if (!ui) return;
        ui.root.style.display = "flex";
        // Previz coming on is what opens the panel. After that the dock owns
        // it, so one put away by hand stays away — and stays undrawn, which is
        // worth having while playback calls through here every frame.
        if (!this._previzPanelOn) {
            this._previzPanelOn = true;
            this.setPanelDocked("previz", true);
        }
        // Before the early return below: the timeline's fields and the keying
        // buttons belong to the tab, and a previz panel put away by hand must
        // not take them with it.
        this.previzSyncTimelineFields();
        if (!this.isPanelDocked("previz")) return;
        const scene = this.previzScene();
        const doc = ui.root.ownerDocument;

        this._previzRefreshUndoButtons();

        // Outliner: the tree, parents before their children.
        ui.list.innerHTML = "";
        const collapsed = this._previzCollapsed || (this._previzCollapsed = new Set());
        const drawLevel = (parentId, depth) => {
            for (const item of S.childrenOf(scene, parentId)) {
                ui.list.append(this._previzOutlinerRow(item, depth, doc, scene));
                if (!collapsed.has(item.id)) drawLevel(item.id, depth + 1);
            }
        };
        drawLevel(null, 0);
        if (!scene.items.length) {
            ui.list.append(Object.assign(doc.createElement("div"), {
                className: "previz-empty",
                textContent: "Drop a model in, or use + Model.",
            }));
        }

        this._previzRenderProps(ui, doc);
    },


    /**
     * One row of the outliner.
     *
     * Dragging a row onto another makes it a child of that one; dropping it on
     * the empty space below the tree puts it back at the top. That is the whole
     * grouping interface — there is no "add to group" command, because the
     * thing you want to say is where it goes.
     */
    _previzOutlinerRow(item, depth, doc, scene) {
        const collapsed = this._previzCollapsed || (this._previzCollapsed = new Set());
        const row = doc.createElement("div");
        row.className = "previz-item"
            + (this.previzIsSelected(item.id) ? " selected" : "")
            + (item.id === this._previzSelection ? " primary" : "");
        row.style.paddingLeft = `${4 + depth * 12}px`;
        row.dataset.itemId = item.id;
        row.draggable = true;
        row.onclick = (e) => this.previzSelect(item.id, { add: e.shiftKey || e.ctrlKey || e.metaKey });
        row.oncontextmenu = (e) => this._previzItemMenu(item.id, e);

        const kids = S.childrenOf(scene, item.id);
        const twisty = doc.createElement("span");
        twisty.className = "previz-twisty" + (kids.length ? "" : " empty");
        twisty.textContent = kids.length ? (collapsed.has(item.id) ? "\u25b8" : "\u25be") : "";
        if (kids.length) {
            twisty.title = collapsed.has(item.id) ? "Show what is inside" : "Fold this away";
            twisty.onclick = (e) => {
                e.stopPropagation();
                if (collapsed.has(item.id)) collapsed.delete(item.id); else collapsed.add(item.id);
                this._previzRenderPanel();
            };
        }

        const eye = doc.createElement("button");
        eye.className = "previz-eye" + (item.visible === false ? " off" : "");
        eye.textContent = item.visible === false ? "\u25cc" : "\u25c9";
        eye.title = item.kind === "group" ? "Show / hide the group and what is in it" : "Show / hide";
        eye.onclick = (e) => {
            e.stopPropagation();
            item.visible = item.visible === false;
            this.previzChanged();
        };

        const name = doc.createElement("span");
        name.className = "previz-name";
        const mark = item.kind === "camera" ? "\ud83c\udfa5" : item.kind === "group" ? "\ud83d\udcc1" : "\ud83e\uddca";
        name.textContent = `${mark} ${item.name}`;
        name.title = item.kind === "model" && item.src ? (item.src.path || item.src.filename || "") : item.name;

        row.append(twisty, eye, name);
        if (item.kind === "camera") {
            const look = doc.createElement("button");
            look.className = "previz-look" + (scene.activeCamera === item.id ? " active" : "");
            look.textContent = "\u25a3";
            look.title = scene.activeCamera === item.id ? "Back to the free view" : "Look through this camera";
            look.onclick = (e) => { e.stopPropagation(); this.previzLookThrough(item.id); };
            row.append(look);
        }
        const failed = this._model3d ? this._model3d.itemError(item.id) : "";
        if (failed) {
            const warn = doc.createElement("span");
            warn.className = "previz-warn";
            warn.textContent = "!";
            warn.title = `This file could not be loaded:\n${failed}`;
            row.append(warn);
        }
        if (S.keyframeFrames(item).length) {
            const dot = doc.createElement("span");
            dot.className = "previz-anim";
            dot.textContent = "\u2022";
            dot.title = `${S.keyframeFrames(item).length} keyframes`;
            row.append(dot);
        }

        row.ondragstart = (e) => {
            this._previzDragItem = item.id;
            row.classList.add("dragging");
            try { e.dataTransfer.setData("text/plain", item.name); } catch (_) {}
            if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        };
        row.ondragend = () => {
            this._previzDragItem = null;
            row.classList.remove("dragging");
            this._previzClearDropMarks();
        };
        row.ondragover = (e) => {
            const dragged = this._previzDragItem;
            if (!dragged || !S.canParent(scene, dragged, item.id)) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
            this._previzClearDropMarks();
            row.classList.add("drop-into");
        };
        row.ondragleave = () => row.classList.remove("drop-into");
        row.ondrop = (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._previzClearDropMarks();
            this.previzReparent(this._previzDragItem, item.id);
        };
        return row;
    },

    _previzClearDropMarks() {
        const ui = this._previzUI;
        if (!ui || !ui.list) return;
        ui.list.querySelectorAll(".drop-into").forEach((n) => n.classList.remove("drop-into"));
        ui.list.classList.remove("drop-into");
    },

    /** Move an item under a group — or out of every group, for a null parent. */
    previzReparent(id, parentId) {
        const scene = this.previzScene();
        if (!scene || !id) return false;
        const item = S.itemById(scene, id);
        if (!item || (item.parent || null) === (parentId || null)) return false;
        if (!S.canParent(scene, id, parentId)) return false;
        const into = parentId ? S.itemById(scene, parentId) : null;
        this.previzSnapshot(into ? `move ${item.name} into ${into.name}` : `move ${item.name} out`);
        S.setParent(scene, id, parentId || null);
        this.previzChanged({ reload: true });
        return true;
    },

    /** A new, empty group — what a USD Xform comes in as, and a folder to fill. */
    previzAddGroup() {
        const scene = this.previzScene();
        if (!scene) return null;
        this.previzSnapshot("add group");
        const item = S.makeGroupItem(S.uniqueName(scene, "Group"));
        // Made where the selection is, so grouping what you are looking at does
        // not move it across the shot.
        const selected = this.previzSelectedItem();
        if (selected) item.parent = selected.parent || null;
        scene.items.push(item);
        this._previzSelection = item.id;
        this.previzChanged({ reload: true });
        return item;
    },

    _previzRenderProps(ui, doc) {
        const item = this.previzSelectedItem();
        ui.props.innerHTML = "";
        if (!item) return;
        const frame = Math.round(this.currentFrame || 0);

        // The camera you are looking through has no handles on screen to grab,
        // so the gizmo steps aside for it — said out loud, because an absent
        // gizmo otherwise looks like a broken one.
        const scene = this.previzScene();
        if (item.kind === "camera" && scene && scene.activeCamera === item.id) {
            const note = doc.createElement("div");
            note.className = "previz-note";
            note.textContent = "Looking through this camera. Press ▣ to step outside and move it.";
            ui.props.append(note);
        }

        const nameIn = doc.createElement("input");
        nameIn.className = "previz-text";
        nameIn.value = item.name;
        nameIn.title = "Name";
        nameIn.onchange = () => {
            item.name = S.uniqueName(this.previzScene(), nameIn.value.trim() || item.name);
            this.previzChanged();
        };
        ui.props.append(nameIn);

        const vecRow = (prop, label, step) => {
            const row = doc.createElement("div");
            row.className = "previz-row";
            const tag = doc.createElement("span");
            tag.className = "previz-label";
            tag.textContent = label;
            row.append(tag);
            const value = S.valueAt(item, prop, frame);
            for (let i = 0; i < 3; i++) {
                const box = doc.createElement("input");
                box.className = "previz-num";
                box.type = "number";
                box.step = String(step);
                box.value = String(Math.round(value[i] * 1000) / 1000);
                box.title = `${label} ${VEC_LABELS[i]}`;
                box.onchange = () => {
                    const next = S.valueAt(item, prop, frame).slice();
                    next[i] = Number(box.value) || 0;
                    // A pivot is where a thing turns, not where it is: typing
                    // one moves the pivot and leaves the item alone.
                    if (prop === "pivot") { this.previzSetPivot(item.id, next); return; }
                    this.previzApplyTransform(item.id, { [prop]: next }, [prop]);
                };
                row.append(box);
            }
            const key = doc.createElement("button");
            key.className = "previz-key" + (S.track(item, prop).some((k) => k.f === frame) ? " on" : "");
            key.textContent = "◆";
            key.title = `Key ${label.toLowerCase()} at frame ${frame}`;
            key.onclick = () => this.previzKeyAll(prop);
            row.append(key);
            ui.props.append(row);
        };

        if (item.kind === "primitive") {
            const row = doc.createElement("div");
            row.className = "previz-row";
            row.append(Object.assign(doc.createElement("span"),
                                     { className: "previz-label", textContent: "Colour" }));
            const swatch = doc.createElement("input");
            swatch.type = "color";
            swatch.className = "previz-color";
            swatch.value = item.color || S.DEFAULT_COLOR;
            swatch.oninput = () => {
                item.color = swatch.value;
                // A colour change repaints the shape; it doesn't rebuild it.
                this.previzChanged({ reload: true });
            };
            row.append(swatch);
            ui.props.append(row);
        }

        vecRow("position", "Move", 0.1);
        vecRow("rotation", "Rotate", 1);
        if (item.kind === "model" || item.kind === "group") vecRow("scale", "Scale", 0.01);
        if (item.kind !== "camera") {
            vecRow("pivot", "Pivot", 0.1);
            const row = doc.createElement("div");
            row.className = "previz-row";
            row.append(Object.assign(doc.createElement("span"),
                                     { className: "previz-label", textContent: "" }));
            const move = doc.createElement("button");
            move.className = "previz-btn" + (this._previzPivotMode ? " active" : "");
            move.textContent = "Move pivot";
            move.title = "Drag the pivot with the gizmo instead of the object (Insert)";
            move.onclick = () => this.previzTogglePivotMode();
            const centre = doc.createElement("button");
            centre.className = "previz-btn";
            centre.textContent = "Centre";
            centre.title = "Put the pivot in the middle of the item, without moving it";
            centre.onclick = () => this.previzCentrePivot();
            row.append(move, centre);
            ui.props.append(row);
        }

        if (item.kind === "camera") {
            const row = doc.createElement("div");
            row.className = "previz-row";
            row.append(Object.assign(doc.createElement("span"), { className: "previz-label", textContent: "FOV" }));
            const fov = doc.createElement("input");
            fov.className = "previz-num";
            fov.type = "number"; fov.step = "1"; fov.min = "1"; fov.max = "170";
            fov.value = String(Math.round(S.valueAt(item, "fov", frame)));
            fov.onchange = () => {
                const v = Math.min(170, Math.max(1, Number(fov.value) || 35));
                if (this._previzAutokey || S.isAnimated(item, "fov")) S.setKeyframe(item, "fov", frame, v);
                else item.fov = v;
                this.previzChanged();
            };
            const key = doc.createElement("button");
            key.className = "previz-key" + (S.track(item, "fov").some((k) => k.f === frame) ? " on" : "");
            key.textContent = "◆";
            key.title = `Key the field of view at frame ${frame}`;
            key.onclick = () => this.previzKeyAll("fov");
            row.append(fov, key);
            ui.props.append(row);
        }

    },

    // ── Rendering the shot ───────────────────────────────────────────────────

    previzRenderName(key = this.activeTab) {
        return (this._previzRenderNames && this._previzRenderNames[key]) || "shot";
    },

    /**
     * Render the shot through the active camera and leave it in ./output/previz,
     * which the bEpic 3D Scene node reads back as its IMAGE output. The viewport
     * is what renders, so what you see is what the workflow gets.
     *
     * Frames go up one at a time — a canvas can only hand over one picture —
     * and `format` decides what stays behind: "mp4" has the server encode them
     * into <name>.mp4 and drop the stills, "png" keeps the stills themselves,
     * which is what a single frame or a trip through another tool wants.
     */
    async previzRender({ width = 1920, height = 1080, format = "mp4" } = {}) {
        const scene = this.previzScene();
        if (!scene || this._previzRendering) return null;
        const view = this._modelView();
        const name = this.previzRenderName();
        const total = Math.max(1, scene.length);
        const wasFrame = Math.round(this.currentFrame || 0);
        this._previzRendering = true;
        let done = 0;
        let firstPath = null, framesDir = null, moviePath = null;
        try {
            for (let f = 0; f < total; f++) {
                view.applyFrame(f);
                const dataurl = view.renderToDataURL(width, height);
                if (!dataurl) throw new Error("the renderer produced no image");
                const res = await fetch(api.apiURL("/bepic/previz_frame"), {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name, index: f, dataurl, first: f === 0 }),
                });
                const info = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(info.error || `the server answered ${res.status}`);
                if (f === 0) { firstPath = info.path || null; framesDir = info.dir || null; }
                done++;
                view._setStatus(`Rendering ${name}: frame ${f + 1} of ${total}…`);
            }
            if (format === "png") {
                view._setStatus(`Wrote ${done} PNG${done === 1 ? "" : "s"} into output/previz/${name}/`);
            } else {
                view._setStatus(`Encoding ${done} frames…`);
                const enc = await fetch(api.apiURL("/bepic/previz_encode"), {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name, fps: scene.fps || 24 }),
                });
                const encData = await enc.json().catch(() => ({}));
                if (!enc.ok) throw new Error(encData.error || `the server answered ${enc.status}`);
                moviePath = encData.path || null;
                view._setStatus(`Wrote output/previz/${name}.mp4, ${done} frames long.`);
            }
            // The shot goes back to the graph it was built for: a loader node
            // pointing at what was just written, exactly as dragging a history
            // frame onto the canvas would make one.
            const made = await this.previzNodeForRender(
                format === "png"
                    ? { kind: "image", isSequence: done > 1, seqDir: framesDir, path: firstPath }
                    : { kind: "video", path: moviePath });
            if (made) view._setStatus(`${view.ui.status.textContent} Dropped a ${made} node on the graph.`);
        } catch (e) {
            console.warn("[bEpicViewer] previz render failed", e);
            view._setStatus(`Render stopped after ${done} frames.\n${(e && e.message) || e}`, true);
        } finally {
            this._previzRendering = false;
            view.restoreSize();
            this.setFrame(wasFrame);
            const win = this._viewerWindow();
            win.setTimeout(() => { if (!this._previzRendering) view._setStatus(""); }, 5000);
        }
        return done;
    },

    /**
     * Put a finished render on the ComfyUI canvas as a loader node.
     *
     * The same road a history frame takes when it is dragged onto the graph
     * (bEpicViewer_mixinDnD.js): a VHS "(Path)" loader that reads the file
     * where it lies when VHS is installed, and one of ComfyUI's own loaders
     * over an uploaded copy when it is not. A render that produced no path —
     * an older server, a failed encode — is simply not dropped.
     */
    async previzNodeForRender(payload) {
        if (!payload || (!payload.path && !payload.seqDir)) return null;
        if (!this._createLoaderForPayload) return null;
        try {
            await this._createLoaderForPayload(payload, null, [0, 0]);
            if (app.graph) app.graph.setDirtyCanvas(true, false);
            return payload.kind === "video" ? "video" : (payload.isSequence ? "image sequence" : "image");
        } catch (e) {
            console.warn("[bEpicViewer] could not put the render on the graph", e);
            return null;
        }
    },

    /** Ask for a size and a format, then render. Kept in the panel so the popout
     *  has it too. */
    previzRenderDialog() {
        if (!this.isPrevizTab()) return;
        const ui = this._previzUI;
        if (!ui) return;
        if (ui.renderForm && ui.renderForm.isConnected) { ui.renderForm.remove(); ui.renderForm = null; return; }
        const doc = ui.root.ownerDocument;
        const scene = this.previzScene();
        const form = doc.createElement("div");
        form.className = "previz-row previz-renderform";
        const w = doc.createElement("input");
        w.className = "previz-num"; w.type = "number"; w.step = "16"; w.min = "16";
        w.value = String(this._previzRenderW || 1920); w.title = "Render width";
        const h = doc.createElement("input");
        h.className = "previz-num"; h.type = "number"; h.step = "16"; h.min = "16";
        h.value = String(this._previzRenderH || 1080); h.title = "Render height";
        const fmt = doc.createElement("select");
        fmt.className = "previz-sel";
        for (const [v, label] of [["mp4", "MP4"], ["png", "PNG"]]) {
            fmt.append(Object.assign(doc.createElement("option"), { value: v, textContent: label }));
        }
        // A one-frame shot is a still, and a one-frame clip is an awkward way to
        // hand a still to the rest of the workflow.
        fmt.value = this._previzRenderFormat
            || (scene && Math.max(1, scene.length) === 1 ? "png" : "mp4");
        fmt.title = "MP4: one clip. PNG: the frames themselves, in output/previz/<name>/";
        const go = doc.createElement("button");
        go.className = "previz-btn";
        go.textContent = "Go";
        go.onclick = () => {
            this._previzRenderW = Math.max(16, Number(w.value) || 1920);
            this._previzRenderH = Math.max(16, Number(h.value) || 1080);
            this._previzRenderFormat = fmt.value;
            form.remove();
            ui.renderForm = null;
            this.previzRender({ width: this._previzRenderW, height: this._previzRenderH,
                                format: this._previzRenderFormat });
        };
        form.append(Object.assign(doc.createElement("span"), { className: "previz-label", textContent: "Size" }),
                    w, h, fmt, go);
        ui.root.appendChild(form);
        ui.renderForm = form;
    },

    // ── Scene files ──────────────────────────────────────────────────────────

    async previzSaveSceneFile() {
        const scene = this.previzScene();
        if (!scene) return;
        const win = this._viewerWindow();
        const name = win.prompt("Save this scene as", this.previzRenderName());
        if (!name) return;
        try {
            const res = await fetch(api.apiURL("/bepic/scene"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, scene }),
            });
            const data = await res.json().catch(() => ({}));
            const view = this._modelView();
            view._setStatus(res.ok ? `Saved as output/3d_scenes/${data.name}.json`
                : `Could not save: ${data.error || res.status}`, !res.ok);
            win.setTimeout(() => view._setStatus(""), 4000);
        } catch (e) {
            console.warn("[bEpicViewer] could not save the scene", e);
        }
    },

    async previzLoadSceneFile() {
        const win = this._viewerWindow();
        let names = [];
        try {
            const res = await fetch(api.apiURL("/bepic/scenes"));
            const data = await res.json();
            names = (data.scenes || []).map((s) => s.name);
        } catch (e) { /* offline: fall through to the prompt */ }
        const pick = win.prompt(
            names.length ? `Load which scene?\n${names.join("\n")}` : "Load which scene?",
            names[0] || "");
        if (!pick) return;
        try {
            const res = await fetch(api.apiURL(`/bepic/scene?name=${encodeURIComponent(pick)}`));
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || res.status);
            const scene = S.parseScene(data.scene);
            this._setScene(this.activeTab, scene);
            this._previzSelection = scene.items.length ? scene.items[0].id : null;
            this.applyTimelineBounds();
            this.setFrame(0);
            this.previzChanged({ reload: true });
        } catch (e) {
            console.warn("[bEpicViewer] could not load the scene", e);
            const view = this._modelView();
            view._setStatus(`Could not load that scene.\n${(e && e.message) || e}`, true);
            win.setTimeout(() => view._setStatus(""), 4000);
        }
    },

    // ── USD stages ───────────────────────────────────────────────────────────

    /** Write the shot out as a USD stage, for the rest of the pipeline. */
    async previzExportUsd() {
        const scene = this.previzScene();
        if (!scene) return;
        const win = this._viewerWindow();
        const name = win.prompt(
            "Export this shot as a USD stage.\n\n" +
            "A name lands in output/3d_scenes; a full path (.usda / .usdc) writes there.",
            this.previzRenderName());
        if (!name) return;
        const body = /[\\/]/.test(name) ? { scene, path: name } : { scene, name };
        const view = this._modelView();
        try {
            const res = await fetch(api.apiURL("/bepic/usd_export"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `the server answered ${res.status}`);
            view._setStatus(`Exported ${data.name}`);
        } catch (e) {
            console.warn("[bEpicViewer] USD export failed", e);
            view._setStatus(`Could not export the stage.\n${(e && e.message) || e}`, true);
        }
        win.setTimeout(() => view._setStatus(""), 5000);
    },

    /** Replace the scene with one read from a USD stage. */
    async previzImportUsd() {
        const win = this._viewerWindow();
        let listed = [];
        try {
            const res = await fetch(api.apiURL("/bepic/usd_stages"));
            const data = await res.json();
            listed = (data.stages || []).map((s) => s.name);
        } catch (e) { /* offline: the prompt still takes a path */ }
        const pick = win.prompt(
            "Import a USD stage — a full path, or a name from output/3d_scenes." +
            (listed.length ? `\n\n${listed.join("\n")}` : ""),
            listed[0] || "");
        if (!pick) return;
        const view = this._modelView();
        try {
            const path = /[\\/]/.test(pick) ? pick : `${await this._previzScenesDir()}/${pick}`;
            const res = await fetch(api.apiURL(`/bepic/usd_import?path=${encodeURIComponent(path)}`));
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `the server answered ${res.status}`);
            const scene = S.parseScene(data.scene);
            if (!scene.items.length) throw new Error("that stage has nothing this viewer can place");
            this._setScene(this.activeTab, scene);
            this._previzSelection = scene.items[0].id;
            this.applyTimelineBounds();
            this.setFrame(0);
            await this.previzChanged({ reload: true });
            if (this._model3d) this._model3d.resetView();
            view._setStatus(`Imported ${scene.items.length} item${scene.items.length === 1 ? "" : "s"}`);
        } catch (e) {
            console.warn("[bEpicViewer] USD import failed", e);
            view._setStatus(`Could not import that stage.\n${(e && e.message) || e}`, true);
        }
        win.setTimeout(() => view._setStatus(""), 5000);
    },

    async _previzScenesDir() {
        if (this._previzScenesFolder) return this._previzScenesFolder;
        try {
            const res = await fetch(api.apiURL("/bepic/usd_stages"));
            const data = await res.json();
            if (data.dir) this._previzScenesFolder = data.dir;
        } catch (e) { /* the prompt's own path still works */ }
        return this._previzScenesFolder || "";
    },

    /** + Model: take the file browser's selection, or open it to make one. */
    previzAddFromBrowser() {
        const picked = this._selectedBrowserFiles ? (this._selectedBrowserFiles() || []) : [];
        const models = picked.filter((f) => f && f.kind === "model");
        if (models.length) {
            this.previzAddModels(models.map((f) => ({ path: f.path, name: f.name, kind: "model" })));
            return;
        }
        if (this.setPanelDocked) this.setPanelDocked("browser", true);
        const view = this._modelView();
        view._setStatus("Pick a model in the File Browser, then press + Model again — or drag it in here.");
        const win = this._viewerWindow();
        win.setTimeout(() => view._setStatus(""), 6000);
    },
};

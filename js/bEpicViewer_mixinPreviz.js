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
const GIZMO_MODES = [["translate", "Move", "W"], ["rotate", "Rotate", "E"], ["scale", "Scale", "R"]];

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
     * Turn the current 3D tab into a scene. Whatever the tab is showing becomes
     * its first object, so previz starts from the model already on screen.
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

    /** Leave previz. The scene is kept, so turning it back on resumes it. */
    exitPreviz(key = this.activeTab) {
        const scene = this.previzScene(key);
        if (!scene) return;
        if (!this._previzKept) this._previzKept = {};
        this._previzKept[key] = scene;
        this._setScene(key, null);
        if (this._model3d) this._model3d.setScene(S.makeScene(), 0);
        this._previzHidePanel();
        this.previzRefreshCurves();          // takes the curve strip down with it
        this.applyTimelineBounds();
        this.refreshView();
        this.queuePersistViewerState();
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

    togglePreviz(key = this.activeTab) {
        if (this.isPrevizTab(key)) { this.exitPreviz(key); return false; }
        const kept = this._previzKept && this._previzKept[key];
        if (kept) {
            this._setScene(key, kept);
            this.applyTimelineBounds();
            this.setFrame(0);
            this.previzChanged({ reload: true });
        } else {
            this.enterPreviz(key);
        }
        return true;
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

    previzSelect(id) {
        this._previzSelection = id || null;
        if (this._model3d) this._model3d.select(id);
        this._previzRenderPanel();
        this._previzRenderTicks();
        this.previzRefreshCurves();
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

    previzDuplicate() {
        const scene = this.previzScene();
        const item = this.previzSelectedItem();
        if (!scene || !item) return;
        this.previzSnapshot(`duplicate ${item.name}`);
        const copy = JSON.parse(JSON.stringify(item));
        copy.id = S.newId(item.kind === "camera" ? "c" : "m");
        copy.name = S.uniqueName(scene, item.name);
        scene.items.splice(scene.items.indexOf(item) + 1, 0, copy);
        this._previzSelection = copy.id;
        this.previzChanged({ reload: true });
    },

    previzDelete() {
        const scene = this.previzScene();
        const item = this.previzSelectedItem();
        if (!scene || !item) return;
        this.previzSnapshot(`delete ${item.name}`);
        scene.items = scene.items.filter((it) => it !== item);
        if (scene.activeCamera === item.id) scene.activeCamera = null;
        this._previzSelection = scene.items.length ? scene.items[0].id : null;
        this.previzChanged({ reload: true });
        if (this._model3d) this._model3d.setActiveCamera(scene.activeCamera);
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
        const item = S.itemById(this.previzScene(), id);
        if (!item) return;
        // One step per drag, taken as the drag starts; a typed-in number is an
        // edit of its own and gets its own step.
        if (live) this.previzBeginDrag(`move ${item.name}`);
        else if (!this._previzDragging) this.previzSnapshot(`move ${item.name}`);
        const frame = Math.round(this.currentFrame || 0);
        for (const prop of props || ["position", "rotation", "scale"]) {
            const value = transform[prop];
            if (value === undefined) continue;
            if (this._previzAutokey || S.isAnimated(item, prop)) S.setKeyframe(item, prop, frame, value);
            else item[prop] = Array.isArray(value) ? value.slice() : value;
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
    previzKeyAll(prop) {
        const item = this.previzSelectedItem();
        if (!item) return;
        this.previzSnapshot(prop ? `key ${prop}` : "key");
        const frame = Math.round(this.currentFrame || 0);
        const props = prop ? [prop] : (item.kind === "camera"
            ? ["position", "rotation", "fov"] : ["position", "rotation", "scale"]);
        for (const p of props) S.setKeyframe(item, p, frame, S.valueAt(item, p, frame), this._previzEase || "smooth");
        this.previzChanged();
    },

    previzDeleteKey() {
        const item = this.previzSelectedItem();
        if (!item) return;
        this.previzSnapshot("delete key");
        S.removeKeyframe(item, Math.round(this.currentFrame || 0));
        this.previzChanged();
    },

    previzSetSceneField(field, value) {
        const scene = this.previzScene();
        if (!scene) return;
        this.previzSnapshot(field === "fps" ? "frame rate" : "shot length");
        if (field === "fps") scene.fps = Math.max(0.1, Number(value) || S.DEFAULT_FPS);
        if (field === "length") {
            scene.length = Math.max(1, Math.round(Number(value) || S.DEFAULT_LENGTH));
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
        const addBtn = el("button", "previz-btn previz-add");
        addBtn.title = "Add a model, a camera or a shape";
        addBtn.textContent = "+";               // stands in if the skin is missing
        this._setIcon(addBtn, "icon-circle-plus");
        addBtn.onclick = () => this._previzToggleAddMenu(addBtn);
        const dupBtn = el("button", "previz-btn", "Duplicate");
        dupBtn.onclick = () => this.previzDuplicate();
        const delBtn = el("button", "previz-btn", "Delete");
        delBtn.onclick = () => this.previzDelete();

        const undoBtn = el("button", "previz-btn previz-step");
        undoBtn.textContent = "↩";              // stands in if the skin is missing
        this._setIcon(undoBtn, "icon-undo");
        undoBtn.onclick = () => this.previzUndo();
        const redoBtn = el("button", "previz-btn previz-step");
        redoBtn.textContent = "↪";
        this._setIcon(redoBtn, "icon-redo");
        redoBtn.onclick = () => this.previzRedo();

        actions.append(addBtn, dupBtn, delBtn, undoBtn, redoBtn);

        const gizmoRow = el("div", "previz-row previz-gizmo");
        const gizmoBtns = {};
        for (const [mode, label, key] of GIZMO_MODES) {
            const b = el("button", "previz-btn", label);
            b.title = `${label} the selected item (${key})`;
            b.onclick = () => { this._modelView().setGizmoMode(mode); this._previzRenderPanel(); };
            gizmoBtns[mode] = b;
            gizmoRow.append(b);
        }
        const spaceBtn = el("button", "previz-btn", "World");
        spaceBtn.title = "Gizmo axes: world or the item's own (scale is always local)";
        spaceBtn.onclick = () => {
            const view = this._modelView();
            view.setGizmoSpace(view.gizmoSpace === "local" ? "world" : "local");
            this._previzRenderPanel();
        };
        gizmoRow.append(spaceBtn);

        const list = el("div", "previz-list");

        const props = el("div", "previz-props");

        const foot = el("div", "previz-foot");
        const fpsIn = el("input", "previz-num");
        fpsIn.type = "number"; fpsIn.step = "0.01"; fpsIn.min = "0.1"; fpsIn.title = "Scene frame rate";
        fpsIn.onchange = () => this.previzSetSceneField("fps", fpsIn.value);
        const lenIn = el("input", "previz-num");
        lenIn.type = "number"; lenIn.step = "1"; lenIn.min = "1"; lenIn.title = "Shot length, in frames";
        lenIn.onchange = () => this.previzSetSceneField("length", lenIn.value);
        foot.append(el("span", "previz-label", "fps"), fpsIn, el("span", "previz-label", "frames"), lenIn);
        const renderBtn = el("button", "previz-btn previz-render", "Render…");
        renderBtn.title = "Render the shot through the active camera into ./output/previz";
        renderBtn.onclick = () => this.previzRenderDialog();
        const saveBtn = el("button", "previz-btn", "Save");
        saveBtn.title = "Save this scene as a file in output/3d_scenes";
        saveBtn.onclick = () => this.previzSaveSceneFile();
        const loadBtn = el("button", "previz-btn", "Load");
        loadBtn.title = "Load a saved scene";
        loadBtn.onclick = () => this.previzLoadSceneFile();
        const usdOut = el("button", "previz-btn", "USD ↑");
        usdOut.title = "Export this shot as a USD stage (payloaded assets, baked animation)";
        usdOut.onclick = () => this.previzExportUsd();
        const usdIn = el("button", "previz-btn", "USD ↓");
        usdIn.title = "Build the scene from a USD stage";
        usdIn.onclick = () => this.previzImportUsd();
        // The dock's own ✕ puts the panel away; leaving previz is a different
        // thing and belongs with the other scene-wide commands.
        const leaveBtn = el("button", "previz-btn", "Leave previz");
        leaveBtn.title = "Leave previz (the scene is kept)";
        leaveBtn.onclick = () => this.exitPreviz();
        foot.append(renderBtn, saveBtn, loadBtn, usdOut, usdIn, leaveBtn);

        root.append(actions, gizmoRow, list, props, foot);
        // The title bar the dock built is a sibling and stays; only previz's own
        // body is replaced.
        this._previzCloseAddMenu();
        host.querySelectorAll(":scope > .previz-body").forEach((n) => n.remove());
        host.appendChild(root);
        this._previzUI = { root, list, props, fpsIn, lenIn, gizmoBtns, spaceBtn, undoBtn, redoBtn };
        return this._previzUI;
    },

    /**
     * The "+" menu: a model, a camera, or a shape to block the scene out.
     *
     * It hangs off .main-area rather than the panel because the panel clips its
     * own overflow, and it is built on demand so the listeners that close it
     * come from whichever document the viewer is living in.
     */
    _previzToggleAddMenu(anchor) {
        if (this._previzAddMenu) { this._previzCloseAddMenu(); return; }
        const host = this.previzPanel && this.previzPanel.closest(".main-area");
        if (!host) return;
        const doc = host.ownerDocument;

        const menu = doc.createElement("div");
        menu.className = "previz-menu";
        const item = (label, run) => {
            const b = doc.createElement("button");
            b.className = "previz-menu-item";
            b.textContent = label;
            b.onclick = () => { this._previzCloseAddMenu(); run(); };
            menu.append(b);
        };
        item("Model…", () => this.previzAddFromBrowser());
        item("Camera", () => this.previzAddCamera());
        menu.append(Object.assign(doc.createElement("div"), { className: "previz-menu-sep" }));
        for (const spec of S.PRIMITIVES) item(spec.label, () => this.previzAddPrimitive(spec.type));
        host.appendChild(menu);

        // Under the button, then pulled back inside whatever room .main-area has.
        const a = anchor.getBoundingClientRect();
        const h = host.getBoundingClientRect();
        menu.style.left = `${a.left - h.left}px`;
        menu.style.top  = `${a.bottom - h.top + 2}px`;
        const m = menu.getBoundingClientRect();
        if (m.bottom > h.bottom) menu.style.top  = `${Math.max(0, a.top - h.top - m.height - 2)}px`;
        if (m.right  > h.right)  menu.style.left = `${Math.max(0, h.width - m.width - 4)}px`;

        // composedPath, because a listener on the document sees every event from
        // inside the shadow root retargeted to the host element.
        this._previzAddMenu = menu;
        this._previzAddMenuAway = (ev) => {
            if (ev.type === "keydown") { if (ev.key === "Escape") this._previzCloseAddMenu(); return; }
            const path = ev.composedPath ? ev.composedPath() : [];
            if (path.includes(menu) || path.includes(anchor)) return;
            this._previzCloseAddMenu();
        };
        // Kept, rather than read back off the menu later: undocking moves the
        // menu into another document, and the listeners stay on this one.
        this._previzAddMenuDoc = doc;
        doc.addEventListener("pointerdown", this._previzAddMenuAway, true);
        doc.addEventListener("keydown", this._previzAddMenuAway, true);
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
        if (!this.isPanelDocked("previz")) return;
        const scene = this.previzScene();
        const doc = ui.root.ownerDocument;

        if (doc.activeElement !== ui.fpsIn) ui.fpsIn.value = String(scene.fps);
        if (doc.activeElement !== ui.lenIn) ui.lenIn.value = String(scene.length);
        const mode = this._model3d ? this._model3d.gizmoMode : "translate";
        for (const [m, btn] of Object.entries(ui.gizmoBtns)) btn.classList.toggle("active", m === mode);
        this._previzRefreshUndoButtons();
        const space = (this._model3d && this._model3d.gizmoSpace) || "local";
        ui.spaceBtn.textContent = space === "local" ? "Local" : "World";
        ui.spaceBtn.classList.toggle("active", space === "local");

        // Outliner
        ui.list.innerHTML = "";
        for (const item of scene.items) {
            const row = doc.createElement("div");
            row.className = "previz-item" + (item.id === this._previzSelection ? " selected" : "");
            row.onclick = () => this.previzSelect(item.id);

            const eye = doc.createElement("button");
            eye.className = "previz-eye" + (item.visible === false ? " off" : "");
            eye.textContent = item.visible === false ? "◌" : "◉";
            eye.title = "Show / hide";
            eye.onclick = (e) => {
                e.stopPropagation();
                item.visible = item.visible === false;
                this.previzChanged();
            };

            const name = doc.createElement("span");
            name.className = "previz-name";
            name.textContent = `${item.kind === "camera" ? "🎥" : "🧊"} ${item.name}`;
            name.title = item.kind === "model" && item.src ? (item.src.path || item.src.filename || "") : item.name;

            row.append(eye, name);
            if (item.kind === "camera") {
                const look = doc.createElement("button");
                look.className = "previz-look" + (scene.activeCamera === item.id ? " active" : "");
                look.textContent = "▣";
                look.title = scene.activeCamera === item.id ? "Back to the free view" : "Look through this camera";
                look.onclick = (e) => { e.stopPropagation(); this.previzLookThrough(item.id); };
                row.append(look);
            }
            const failed = this._model3d ? this._model3d.itemError(item.id) : "";
            if (failed) {
                const warn = doc.createElement("span");
                warn.className = "previz-warn";
                warn.textContent = "!";
                warn.title = `This file could not be loaded:
${failed}`;
                row.append(warn);
            }
            if (S.keyframeFrames(item).length) {
                const dot = doc.createElement("span");
                dot.className = "previz-anim";
                dot.textContent = "•";
                dot.title = `${S.keyframeFrames(item).length} keyframes`;
                row.append(dot);
            }
            ui.list.append(row);
        }
        if (!scene.items.length) {
            ui.list.append(Object.assign(doc.createElement("div"), {
                className: "previz-empty",
                textContent: "Drop a model in, or use + Model.",
            }));
        }

        this._previzRenderProps(ui, doc);
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
        if (item.kind === "model") vecRow("scale", "Scale", 0.01);

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

        const keyRow = doc.createElement("div");
        keyRow.className = "previz-row previz-keys";
        const keyAll = doc.createElement("button");
        keyAll.className = "previz-btn";
        keyAll.textContent = `Key @ ${frame}`;
        keyAll.title = "Key this item's transform at the current frame";
        keyAll.onclick = () => this.previzKeyAll();
        const delKey = doc.createElement("button");
        delKey.className = "previz-btn";
        delKey.textContent = "Delete key";
        delKey.onclick = () => this.previzDeleteKey();
        const auto = doc.createElement("button");
        auto.className = "previz-btn" + (this._previzAutokey ? " active" : "");
        auto.textContent = "Auto";
        auto.title = "Autokey: every move you make sets a key at the current frame";
        auto.onclick = () => { this._previzAutokey = !this._previzAutokey; this._previzRenderPanel(); };
        const ease = doc.createElement("select");
        ease.className = "previz-sel";
        for (const [v, label] of [["smooth", "Smooth"], ["linear", "Linear"], ["hold", "Hold"]]) {
            ease.append(Object.assign(doc.createElement("option"), { value: v, textContent: label }));
        }
        ease.value = this._previzEase || "smooth";
        ease.title = "How new keys leave their frame";
        ease.onchange = () => {
            this._previzEase = ease.value;
            // Re-ease the keys this item has at this frame, so the menu also
            // works as "change the key I am standing on".
            for (const prop of S.TRACKS) {
                for (const k of S.track(item, prop)) if (k.f === frame) k.ease = ease.value;
            }
            this.previzChanged();
        };
        keyRow.append(keyAll, delKey, auto, ease);
        ui.props.append(keyRow);
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
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.error || `the server answered ${res.status}`);
                }
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
                view._setStatus(`Wrote output/previz/${name}.mp4, ${done} frames long.`);
            }
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

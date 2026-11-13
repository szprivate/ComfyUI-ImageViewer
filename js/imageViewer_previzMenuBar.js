// imageViewer_previzMenuBar.js
// The 3D space's menu bar, across the top of the canvas (Maya's panel menus,
// Blender's header): File, Edit, Create, Rig, Animate, Constrain, World, Terrain, View,
// Windows. The Outliner was the place for these once; it is the tree only now.
//
// The view (imageViewer_model3d.js) makes the bar and keeps the shading,
// grid, display and layout controls at its right end; the panel fills the
// menus in here (hooks.buildMenuBar). Every menu is built when it opens, from
// the same entry lists the old buttons used, so what is enabled is always
// what is true now. Once one menu is open, moving onto another opens that one.
import { rigMenuOf } from "./imageViewer_previzRig.js";
import { viewerActionKeyLabel } from "./imageViewer_keymap.js";
import { DISPLAY_KINDS } from "./imageViewer_view3dTools.js";
import { MATERIAL_MODES } from "./imageViewer_model3d.js";
import { PANE_VIEWS, PANE_LAYOUTS } from "./imageViewer_view3dPanes.js";

// The panels of the 3D space, as the bar's 3D group lists them.
// The third field is the keymap action that shows / hides it (bindable in Settings -> Keybinding).
const WINDOWS = [
    ["Outliner", "previz", "View3DPrevizPanel"],
    // The Parameters panel: on a 3D tab it is the Channel Box.
    ["Channel Box", "params", "View3DChannelBox"],
    ["Curve Editor", "curves", "View3DCurvesPanel"],
    ["Dope Sheet", "dopeSheet", "View3DDopeSheet"],
    ["Anim Layers", "animLayers"],
    ["Layers", "layers3d"],
    ["Character Picker", "picker"],
    ["Clip Sequencer", "clips", "View3DClipsPanel"],
    ["History", "history"],
];

// [label, class (kept from the old Outliner buttons, so nothing that looks for them breaks), entries]
const MENUS = [
    ["File", "previz-mb-file", (p) => p._previzFileMenuEntries()],
    ["Edit", "previz-mb-edit", (p) => p._previzEditBarEntries()],
    ["Create", "previz-mb-create", (p) => p._previzAddMenuEntries()],
    ["Rig", "previz-rig", (p, a) => rigMenuOf(p._previzRigMenuEntries(a), "rig")],
    ["Animate", "previz-anim", (p, a) => [...p._previzKeyMenuEntries(), "-", ...rigMenuOf(p._previzRigMenuEntries(a), "anim")]],
    ["Constrain", "previz-constrain", (p) => p._previzConstrainMenuEntries()],
    ["World", "previz-atlas-menu", (p) => p._previzWorldBarEntries()],
    ["Terrain", "previz-mb-terrain", (p) => p._previzTerrainMenuEntries()],
    ["View", "previz-mb-view", (p) => p._previzViewMenuEntries()],
    ["Windows", "previz-mb-windows", (p) => p._previzWindowsMenuEntries()],
];

const tick = (on, label) => (on ? "✓ " : "") + label;

export const PrevizMenuBarMixin = {

    /** Fill the view's menu bar (`host`, its left part) with the menus. */
    previzBuildMenuBar(host) {
        const doc = host.ownerDocument;
        host.textContent = "";
        this._previzMenuBtns = {};
        for (const [label, cls, entries] of MENUS) {
            const b = doc.createElement("button");
            b.className = `model-mb-btn previz-btn ${cls}`;
            b.textContent = label;
            b.dataset.menu = label.toLowerCase();
            b.onclick = () => this.previzMenuBarOpen(label.toLowerCase(), b, true);
            b.addEventListener("mouseenter", () => {
                // Maya's and Blender's menu bars: one open, the next follows the mouse.
                if (this._previzBarMenu && this._previzAddMenu && this._previzBarMenu !== b) {
                    this.previzMenuBarOpen(label.toLowerCase(), b, false);
                }
            });
            b._entries = entries;
            host.append(b);
            this._previzMenuBtns[label.toLowerCase()] = b;
        }
    },

    /** Open (or with `toggle`, close again) one of the bar's menus by its name. */
    previzMenuBarOpen(name, anchor = null, toggle = false) {
        const b = anchor || (this._previzMenuBtns && this._previzMenuBtns[name]);
        if (!b) return null;
        const open = this._previzAddMenu && this._previzBarMenu === b;
        if (this._previzBarMenu) this._previzBarMenu.classList.remove("open");
        this._previzCloseAddMenu();
        this._previzBarMenu = null;
        if (open && toggle) return null;
        if (!this.previzScene()) return null;
        const r = b.getBoundingClientRect();
        const menu = this._previzOpenMenu(b._entries(this, b), r.left, r.bottom + 2, b);
        if (menu) {
            this._previzBarMenu = b;
            b.classList.add("open");
            // The menu closes itself (a pick, a click away, Esc): the button lets go then too.
            const win = b.ownerDocument.defaultView;
            const watch = () => {
                if (this._previzAddMenu === menu && menu.isConnected) { win.requestAnimationFrame(watch); return; }
                b.classList.remove("open");
                if (this._previzBarMenu === b) this._previzBarMenu = null;
            };
            win.requestAnimationFrame(watch);
        }
        return menu;
    },

    /** Light the bar's World menu while an Atlas world is open. */
    _previzMenuBarSync() {
        const w = this._previzMenuBtns && this._previzMenuBtns.world;
        if (w) w.classList.toggle("has-world", !!(this.previzAtlasItem && this.previzAtlasItem()));
    },

    // ── The menus ─────────────────────────────────────────────────────────

    _previzFileMenuEntries() {
        const exports = rigMenuOf(this._previzRigMenuEntries(null), "file");
        return [
            { label: "New scene", cmd: "PrevizNewScene", run: () => this.previzNewScene() },
            { label: "Open scene…", cmd: "PrevizLoadScene", run: () => this.previzLoadSceneFile() },
            { label: "Open USD / Alembic…", cmd: "PrevizImportUsd", run: () => this.previzImportUsd() },
            { label: "Import Model…", cmd: "PrevizAddModel", title: "Add models to the scene from a file "
                + "(glTF, FBX, OBJ, STL, PLY, USD, splats); the File Browser's selected models go in at once",
              run: () => this.previzImportModel() },
            { label: "Reference scene…", title: "Bring a saved scene in under a namespace, linked: "
                + "a newer version of the file is picked up here", run: () => this.previzReferenceDialog() },
            "-",
            { label: "Save scene…", cmd: "PrevizSaveScene", run: () => this.previzSaveSceneFile() },
            { label: "Export USD…", cmd: "PrevizExportUsd", run: () => this.previzExportUsd() },
            ...(exports.length ? [{ label: "Export character", sub: exports }] : []),
            "-",
            { label: "Render…", cmd: "PrevizRender", run: () => this.previzRenderDialog() },
            { label: "Playblast…", cmd: "PrevizPlayblast", disabled: !this.previzPlayblastDialog, run: () => this.previzPlayblastDialog() },
        ];
    },

    _previzEditBarEntries() {
        const ids = this.previzSelectedIds();
        const many = ids.length > 1;
        const none = !ids.length;
        const why = "Select something first.";
        return [
            { label: "Undo", cmd: "PrevizUndo", disabled: !this.previzCanUndo(), title: "Nothing to undo", run: () => this.previzUndo() },
            { label: "Redo", cmd: "PrevizRedo", disabled: !this.previzCanRedo(), title: "Nothing to redo", run: () => this.previzRedo() },
            "-",
            { label: "Select all", cmd: "PrevizSelectAll", run: () => this.previzSelectAll() },
            { label: "Rename", cmd: "PrevizRename", disabled: none || many, title: none ? why : "One item at a time.",
              run: () => this.previzBeginRename(ids[0]) },
            { label: many ? `Duplicate ${ids.length} items` : "Duplicate", cmd: "PrevizDuplicate", disabled: none, title: why,
              run: () => this.previzDuplicate(ids) },
            { label: many ? `Delete ${ids.length} items` : "Delete", cmd: "PrevizDelete", disabled: none, title: why,
              run: () => this.previzDelete(ids) },
            { label: "Group", cmd: "PrevizGroup", disabled: none, title: why, run: () => this.previzGroupSelection() },
            "-",
            { label: "Tool", sub: [
                ["select", "Select", "GizmoSelect"], ["translate", "Move", "GizmoMove"],
                ["rotate", "Rotate", "GizmoRotate"], ["scale", "Scale", "GizmoScale"],
            ].map(([mode, label, cmd]) => ({ label: tick(this._modelView().gizmoMode === mode, label), cmd,
                                             run: () => this.previzSetGizmoMode(mode) })).concat(["-",
                { label: tick(this._modelView().gizmoSpace === "local", "Local axes"), cmd: "GizmoSpace",
                  run: () => this.previzToggleGizmoSpace() }]) },
            "-",
            ...this._previzEditMenuEntries(),
        ];
    },

    /** Keying the selection, at the top of Animate: the keys Maya has for it. */
    _previzKeyMenuEntries() {
        const none = !this.previzSelectedIds().length;
        const why = "Select something first.";
        const key = (label, cmd, run) => ({ label, cmd, disabled: none, title: why, run });
        return [
            key("Set key", "PrevizKeyS", () => this.previzKeyAll()),
            key("Key selected channels", "PrevizKeyChannels", () => this.previzKeySelectedChannels()),
            key("Key translate", "PrevizKeyMove", () => this.previzKeyAll("position")),
            key("Key rotate", "PrevizKeyRotate", () => this.previzKeyAll("rotation")),
            key("Key scale", "PrevizKeyScale", () => this.previzKeyAll("scale")),
            key("Delete key at playhead", "PrevizDeleteKey", () => this.previzDeleteKey()),
            { label: tick(!!this._previzAutokey, "Autokey"), cmd: "PrevizAutokey", run: () => this.previzToggleAutokey() },
        ];
    },

    _previzWorldBarEntries() {
        const world = this.previzHasWorld && this.previzHasWorld();
        const walking = !!(this._model3d && this._model3d.walking);
        const out = [
            { label: tick(walking, "Walk"), cmd: "WorldWalk", disabled: !(this.previzCanMove && this.previzCanMove()),
              title: "Walk through the world: W A S D, mouse to look, Esc stops. Needs a world.",
              run: () => this.previzWalkToggle() },
            { label: "Match to reference", disabled: !world, title: world
                ? "Set exposure, light, fog and glow from the world's reference picture" : "Needs a world.",
              run: () => this.previzMatchReference() },
            { label: "Note…", cmd: "WorldNote", disabled: !world, title: world ? "Pin a note to a spot" : "Needs a world.",
              run: () => this.previzFeedbackPlace() },
        ];
        const atlas = this.previzAtlasMenuEntries ? this.previzAtlasMenuEntries() : [];
        if (atlas.length) out.push("-", { label: "Atlas", disabled: true, title: "World Labs Atlas" }, ...atlas);
        return out;
    },

    _previzViewMenuEntries() {
        const view = this._modelView();
        const scene = this.previzScene();
        const cams = (scene && scene.items || []).filter((it) => it.kind === "camera");
        const pane = view._paneState ? view._paneState() : null;
        const kind = view.paneActiveKind ? view.paneActiveKind() : "persp";
        return [
            { label: "Frame selected", cmd: "FitView", run: () => this.previzFKey ? this.previzFKey() : view.resetView() },
            { label: "Frame all", run: () => view.resetView() },
            "-",
            { label: "Shading", sub: MATERIAL_MODES.map(([v, l]) => ({
                label: tick(view.materialMode === v, l), cmd: `View3D${v[0].toUpperCase()}${v.slice(1)}`, run: () => view.setMaterialMode(v) })) },
            { label: tick(!!(view.ptRasterWhileMoving && view.ptRasterWhileMoving()), "Path traced: raster while moving"),
              title: "With Path traced shading: draw the view raster while an object moves or the shot plays, and trace again once it is still",
              disabled: !view.ptRasterWhileMoving, run: () => view.ptSetRasterWhileMoving(!view.ptRasterWhileMoving()) },
            { label: tick(view.showGrid, "Grid"), cmd: "View3DGrid", run: () => view.setGrid(!view.showGrid) },
            { label: "Grid options…", title: "Size, spacing and major lines of the grid",
              disabled: !view.toggleGridMenu, run: () => view.toggleGridMenu(true) },
            { label: "Default lights", title: "The studio lights a scene gets when it has none of its own", sub: [
                ["auto", "Auto (off once the scene has a light)"], ["on", "Always on"], ["off", "Off"],
            ].map(([v, l]) => ({ label: tick(this.previzDefaultLights() === v, l), run: () => this.previzSetDefaultLights(v) })) },
            { label: "Show", sub: [
                { label: "All", run: () => view.setAllDisplayed(true) },
                "-",
                ...DISPLAY_KINDS.map((k, i) => ({ label: tick(view.isDisplayed(k.key), k.label), keys: `Shift+${i + 1}`,
                                                  run: () => view.setDisplayed(k.key) })),
                "-",
                { label: tick(!!view._dispXray, "X-Ray Joints"), run: () => view.setJointXray(!view._dispXray) },
            ] },
            "-",
            ...(pane ? [
                { label: "Layout", sub: PANE_LAYOUTS.map(([l, label]) => ({
                    label: tick(pane.layout === l, label), run: () => view.setPaneLayout(l) })) },
                { label: "This view", sub: PANE_VIEWS.map(([k, label]) => ({
                    label: tick(kind === k, label), run: () => view.setPaneView(pane.active, k) })) },
                { label: pane.layout === "single" ? "Show all views" : "Maximise this view",
                  // Space toggles a split layout and a pane maximised from one; a single view picked by hand plays.
                  keys: (pane.layout !== "single" || pane.restore) && viewerActionKeyLabel("View3DMaximisePane")
                      ? `${viewerActionKeyLabel("View3DMaximisePane")} over a view` : "",
                  run: () => view.togglePaneMaximised() },
            ] : []),
            { label: "Look through", sub: [
                { label: tick(!scene || !scene.activeCamera, "Free camera"),
                  run: () => scene && scene.activeCamera && this.previzLookThrough(scene.activeCamera) },
                ...cams.map((c) => ({ label: tick(scene.activeCamera === c.id, c.name),
                                      run: () => { if (scene.activeCamera !== c.id) this.previzLookThrough(c.id); } })),
            ] },
        ];
    },

    _previzWindowsMenuEntries() {
        return WINDOWS.map(([label, id, cmd]) => ({
            label: tick(this.isPanelDocked && this.isPanelDocked(id), label), cmd,
            run: () => this.togglePanelDocked(id),
        }));
    },
};

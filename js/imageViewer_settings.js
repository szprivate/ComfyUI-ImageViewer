// imageViewer_settings.js    Settings → ComfyUI Image Viewer
//
// The viewer's defaults as ComfyUI settings, so they live with the user's other
// settings (on the server, per user) rather than in one browser's storage.
// Hotkeys are not here: they are ComfyUI commands, rebound in Settings →
// Keybinding (imageViewer_keymap.js).
//
// Three kinds of entry:
//   - a default the panel starts from (frame rate, loop mode, compare mode, …),
//     applied to the live panel too when it changes — `panelApply`;
//   - one that IS the panel's state and is written back when the panel changes
//     it (history limit, sequence folding, the browser's kind filter) — so the
//     two can never disagree;
//   - the folders the viewer may open, which belong to the SERVER
//     (~/.comfyui_image_viewer/roots.txt, see path_access.py), not to a setting: that entry
//     is a custom editor that talks to /imageviewer/roots and stores nothing itself;
//   - the workflows Paint's Generate runs, which are files on the server too
//     (~/.comfyui_image_viewer/paint_workflows/, paint_generate.py): a custom
//     editor that talks to /imageviewer/paint/workflows.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import * as S from "./imageViewer_scene3d.js";

const P = "ImageViewer.";
const CAT = "ComfyUI Image Viewer";

export const PREF = {
    folders:        P + "Folders.Allowed",
    paintWorkflows: P + "Paint.Workflows",
    browserStart:   P + "Browser.StartFolder",
    browserFold:    P + "Browser.FoldSequences",
    browserKinds:   P + "Browser.Kinds",
    fps:            P + "Playback.FPS",
    loop:           P + "Playback.Loop",
    compareMode:    P + "View.CompareMode",
    showInfo:       P + "View.ShowInfo",
    historyLimit:   P + "History.Limit",
    dockSide:       P + "Dock.Side",
    dockLastSide:   P + "Dock.LastSide",
    dockWidth:      P + "Dock.Width",
    dockHeight:     P + "Dock.Height",
    annotColor:     P + "Annotate.Color",
    annotSize:      P + "Annotate.BrushSize",
    annotTextSize:  P + "Annotate.TextSize",
    grid3d:         P + "3D.Grid",
    material3d:     P + "3D.Material",
    sceneFps:       P + "Previz.FPS",
    sceneLength:    P + "Previz.Length",
    cameraRes:      P + "Previz.CameraResolution",
    renderFormat:   P + "Previz.RenderFormat",
    renderQuality:  P + "Previz.RenderQuality",
    renderScale:    P + "Previz.RenderScale",
    renderAA:       P + "Previz.RenderAA",
    renderBg:       P + "Previz.RenderBackground",
    renderColor:    P + "Previz.RenderColor",
    atlasMove:      P + "Experimental.AtlasCameraMove",
};

const DEFAULTS = {};          // id → defaultValue, filled from the table below

/** A setting's value, or its default when ComfyUI's settings aren't up yet. */
export function pref(id) {
    try {
        const v = app.extensionManager.setting.get(id);
        if (v !== undefined && v !== null) return v;
    } catch (e) { /* settings store not ready */ }
    return DEFAULTS[id];
}

/** Write a setting back (the panel changed the state it mirrors). */
export function setPref(id, value) {
    try {
        if (pref(id) === value) return;
        const r = app.extensionManager.setting.set(id, value);
        if (r && r.catch) r.catch((e) => console.warn(`[ImageViewer] could not save ${id}`, e));
    } catch (e) { /* settings store not ready */ }
}

/** The browser's kind filter as the route takes it ("" for everything).
 *  The setting says "all": ComfyUI's dropdown can't show an empty value. */
export function prefKinds() {
    const v = String(pref(PREF.browserKinds) || "");
    // "Media only" took in sound later: a setting saved before that means the same choice.
    if (v === "image,video,model") return "image,video,audio,model";
    return v === "all" ? "" : v;
}

/** "#rrggbb" from a colour setting, which ComfyUI stores without the "#". */
export function prefColor(id) {
    const v = String(pref(id) || "").trim().replace(/^#/, "");
    return /^[0-9a-f]{6}$/i.test(v) ? `#${v.toLowerCase()}` : `#${DEFAULTS[id]}`;
}

// ── Previz: the data model is pure (no app import), so it is told ────────────

const RESOLUTIONS = [
    ["1920x1080", "HD 1080 (1920×1080)"], ["1280x720", "HD 720 (1280×720)"],
    ["3840x2160", "UHD 4K (3840×2160)"], ["2048x1080", "DCI 2K (2048×1080)"],
    ["4096x2160", "DCI 4K (4096×2160)"], ["1080x1080", "Square (1080×1080)"],
    ["1080x1920", "Vertical (1080×1920)"], ["2048x858", "Scope 2.39 (2048×858)"],
];

function applySceneDefaults() {
    const [w, h] = String(pref(PREF.cameraRes)).split("x").map(Number);
    S.setNewSceneDefaults({
        fps: Number(pref(PREF.sceneFps)),
        length: Number(pref(PREF.sceneLength)),
        resolution: w > 0 && h > 0 ? [w, h] : null,
    });
    S.setRenderDefaults({
        format: pref(PREF.renderFormat),
        quality: pref(PREF.renderQuality),
        scale: Number(pref(PREF.renderScale)),
        aa: Number(pref(PREF.renderAA)),
        background: pref(PREF.renderBg),
        color: prefColor(PREF.renderColor),
    });
}

// ── The table ────────────────────────────────────────────────────────────────

let _getPanel = () => null;

/** Hand a changed setting to the live panel, if there is one yet. */
function panelApply(id) {
    return (value) => {
        const panel = _getPanel();
        if (panel && panel.applyViewerPref) {
            try { panel.applyViewerPref(id, value); }
            catch (e) { console.warn(`[ImageViewer] applying ${id} failed`, e); }
        }
    };
}

const opts = (pairs) => pairs.map(([value, text]) => ({ value, text }));

// Higher sortOrder sorts first, and a section sorts by its highest entry.
function defs() {
    const sec = (section, name) => [CAT, section, name];
    return [
        // ── Folders ──
        {
            id: PREF.folders, category: sec("Folders", "Allowed"),
            name: "Folders the viewer may open",
            tooltip: "The file browser and every viewer route are confined to these folders, " +
                     "each with everything inside it, subfolders included. " +
                     "Kept on the ComfyUI machine in ~/.comfyui_image_viewer/roots.txt, not in your settings.",
            type: (name, setter, value) => renderFolderEditor(),
            defaultValue: "", sortOrder: 1000,
        },
        // ── Paint ──
        {
            id: PREF.paintWorkflows, category: sec("Paint", "Workflows"),
            name: "Generate workflows",
            tooltip: "The ComfyUI workflow each of Paint's Generate actions runs: one that comes with the viewer, " +
                     "one of your own (from the canvas or an API-format file), or agentY building one. " +
                     "Kept on the ComfyUI machine in ~/.comfyui_image_viewer/paint_workflows/, not in your settings.",
            type: () => renderPaintWorkflowEditor(),
            defaultValue: "", sortOrder: 900,
        },
        // ── File browser ──
        {
            id: PREF.browserStart, category: sec("File Browser", "StartFolder"),
            name: "Start folder",
            tooltip: "Where the file browser opens when the page loads. Empty: the folder it was " +
                     "last left in (ComfyUI's input folder the first time). Must be an allowed folder.",
            type: "text", defaultValue: "", sortOrder: 900,
        },
        {
            id: PREF.browserFold, category: sec("File Browser", "FoldSequences"),
            name: "Fold image sequences",
            tooltip: "Show a numbered run of images (shot.1001.exr, shot.1002.exr, …) as one entry. " +
                     "Also switched from the browser's kind menu.",
            type: "boolean", defaultValue: false, sortOrder: 890,
            onChange: panelApply(PREF.browserFold),
        },
        {
            id: PREF.browserKinds, category: sec("File Browser", "Kinds"),
            name: "Show",
            tooltip: "Which files the browser lists. Also changed from the browser's kind menu.",
            type: "combo", defaultValue: "all",
            options: opts([["all", "All files"], ["image,video,audio,model", "Media only"], ["image", "Images"],
                           ["video", "Video"], ["audio", "Audio"], ["model", "3D models"], ["other", "Everything else"]]),
            sortOrder: 880, onChange: panelApply(PREF.browserKinds),
        },
        // ── Playback ──
        {
            id: PREF.fps, category: sec("Playback", "FPS"),
            name: "Frame rate for image sequences",
            tooltip: "What a sequence of images plays at. A video plays at its own rate, a previz " +
                     "shot at the shot's.",
            type: "number", defaultValue: 25, attrs: { min: 1, max: 240, step: 1 }, sortOrder: 800,
            onChange: panelApply(PREF.fps),
        },
        {
            id: PREF.loop, category: sec("Playback", "Loop"),
            name: "Loop mode", type: "combo", defaultValue: "loop",
            options: opts([["loop", "Loop"], ["ping-pong", "Ping-Pong"], ["once", "Once"]]),
            sortOrder: 790, onChange: panelApply(PREF.loop),
        },
        // ── View ──
        {
            id: PREF.compareMode, category: sec("View", "CompareMode"),
            name: "Compare opens as",
            tooltip: "How two images are shown when compare is switched on. The rotate button " +
                     "still cycles through all three.",
            type: "combo", defaultValue: "vertical",
            options: opts([["vertical", "Wipe, left / right"], ["horizontal", "Wipe, top / bottom"],
                           ["contact", "Side by side"]]),
            sortOrder: 700,
        },
        {
            id: PREF.showInfo, category: sec("View", "ShowInfo"),
            name: "Show the overlays on the canvas",
            tooltip: "Everything drawn over the picture: the size read-out, the exposure bar, " +
                     "the path bar, the tool bar and the rest. The Toggle Overlays button (S) " +
                     "still toggles them for the session.",
            type: "boolean", defaultValue: true, sortOrder: 690,
            onChange: panelApply(PREF.showInfo),
        },
        {
            id: PREF.historyLimit, category: sec("View", "HistoryLimit"),
            name: "History snapshots kept (one history for all tabs)",
            tooltip: "Older snapshots are dropped. Also set from the history panel's footer.",
            type: "number", defaultValue: 100, attrs: { min: 1, max: 500, step: 1 }, sortOrder: 680,
            onChange: panelApply(PREF.historyLimit),
        },
        // ── Docking (the viewer as a panel of the page; imageViewer_mixinPageDock.js) ──
        {
            id: PREF.dockSide, category: sec("Docking", "Side"),
            name: "Viewer placement",
            tooltip: "Floating: the viewer sits over the canvas. Docked: it is a panel of its own " +
                     "beside the canvas, which gets the rest of the window, so ComfyUI's side panels " +
                     "still open next to it. Also switched from the viewer's header button and its " +
                     "layout menu.",
            type: "combo", defaultValue: "",
            options: opts([["", "Floating"], ["right", "Docked right"], ["left", "Docked left"],
                           ["bottom", "Docked bottom"]]),
            sortOrder: 670, onChange: panelApply(PREF.dockSide),
        },
        {
            id: PREF.dockWidth, category: sec("Docking", "Width"),
            name: "Docked width (left / right)",
            tooltip: "In pixels. Also set by dragging the docked viewer's inner edge.",
            type: "number", defaultValue: 520, attrs: { min: 240, max: 4000, step: 10 }, sortOrder: 660,
            onChange: panelApply(PREF.dockWidth),
        },
        {
            id: PREF.dockHeight, category: sec("Docking", "Height"),
            name: "Docked height (bottom)",
            tooltip: "In pixels. Also set by dragging the docked viewer's top edge.",
            type: "number", defaultValue: 360, attrs: { min: 240, max: 4000, step: 10 }, sortOrder: 650,
            onChange: panelApply(PREF.dockHeight),
        },
        {
            // Which side the header button docks to: the last one used. State, not a choice.
            id: PREF.dockLastSide, category: sec("Docking", "LastSide"),
            name: "Last docked side", type: "hidden", defaultValue: "right",
        },
        // ── Annotate ──
        {
            id: PREF.annotColor, category: sec("Annotate", "Color"),
            name: "Pen colour", type: "color", defaultValue: "ff3b30", sortOrder: 600,
            onChange: panelApply(PREF.annotColor),
        },
        {
            id: PREF.annotSize, category: sec("Annotate", "BrushSize"),
            name: "Pen size (px)", type: "number", defaultValue: 0,
            tooltip: "0: sized to the picture, so a stroke reads the same on a 512 px image and a 4K one.",
            attrs: { min: 0, max: 200, step: 1 }, sortOrder: 590,
            onChange: panelApply(PREF.annotSize),
        },
        {
            id: PREF.annotTextSize, category: sec("Annotate", "TextSize"),
            name: "Text size (px)", type: "number", defaultValue: 0,
            tooltip: "0: sized to the picture.",
            attrs: { min: 0, max: 400, step: 1 }, sortOrder: 580,
            onChange: panelApply(PREF.annotTextSize),
        },
        // ── 3D ──
        {
            id: PREF.grid3d, category: sec("3D", "Grid"),
            name: "Grid", type: "combo", defaultValue: "comfy",
            options: opts([["comfy", "Follow ComfyUI"], ["on", "On"], ["off", "Off"]]),
            tooltip: "Whether a 3D tab opens with its ground grid shown. Follow ComfyUI: as Settings → 3D → Initial Grid Visibility.",
            sortOrder: 500,
        },
        {
            id: PREF.material3d, category: sec("3D", "Material"),
            name: "Shading", type: "combo", defaultValue: "original",
            options: opts([["original", "Original"], ["clay", "Clay"], ["normal", "Normal"],
                           ["wireframe", "Wireframe"]]),
            tooltip: "How a 3D tab opens. The 3D toolbar still switches it.",
            sortOrder: 490,
        },
        // ── Previz ──
        {
            id: PREF.sceneFps, category: sec("Previz", "FPS"),
            name: "New shot: frame rate", type: "number", defaultValue: S.DEFAULT_FPS,
            attrs: { min: 1, max: 240, step: 1 }, sortOrder: 400, onChange: applySceneDefaults,
        },
        {
            id: PREF.sceneLength, category: sec("Previz", "Length"),
            name: "New shot: length (frames)", type: "number", defaultValue: S.DEFAULT_LENGTH,
            attrs: { min: 1, max: 100000, step: 1 }, sortOrder: 390, onChange: applySceneDefaults,
        },
        {
            id: PREF.cameraRes, category: sec("Previz", "CameraResolution"),
            name: "New camera: resolution", type: "combo",
            defaultValue: S.DEFAULT_RESOLUTION.join("x"), options: opts(RESOLUTIONS),
            sortOrder: 380, onChange: applySceneDefaults,
        },
        {
            id: PREF.renderFormat, category: sec("Previz", "RenderFormat"),
            name: "Render: format", type: "combo", defaultValue: S.RENDER_DEFAULTS.format,
            options: opts([["mp4", "MP4"], ["mov", "MOV"], ["webm", "WebM"], ["png", "PNG sequence"]]),
            tooltip: "For a shot that has never been rendered. A shot keeps what its render dialog last used.",
            sortOrder: 370, onChange: applySceneDefaults,
        },
        {
            id: PREF.renderQuality, category: sec("Previz", "RenderQuality"),
            name: "Render: quality", type: "combo", defaultValue: S.RENDER_DEFAULTS.quality,
            options: opts([["high", "High"], ["medium", "Medium"], ["low", "Low"]]),
            sortOrder: 360, onChange: applySceneDefaults,
        },
        {
            id: PREF.renderScale, category: sec("Previz", "RenderScale"),
            name: "Render: scale", type: "combo", defaultValue: String(S.RENDER_DEFAULTS.scale),
            options: opts([25, 50, 75, 100, 150, 200].map((v) => [String(v), `${v}%`])),
            sortOrder: 350, onChange: applySceneDefaults,
        },
        {
            id: PREF.renderAA, category: sec("Previz", "RenderAA"),
            name: "Render: anti-aliasing", type: "combo", defaultValue: String(S.RENDER_DEFAULTS.aa),
            options: opts([["1", "Off"], ["2", "2×"], ["4", "4×"]]),
            sortOrder: 340, onChange: applySceneDefaults,
        },
        {
            id: PREF.renderBg, category: sec("Previz", "RenderBackground"),
            name: "Render: background", type: "combo", defaultValue: S.RENDER_DEFAULTS.background,
            options: opts([["viewer", "As the viewport"], ["color", "Colour"], ["transparent", "Transparent"]]),
            sortOrder: 330, onChange: applySceneDefaults,
        },
        {
            id: PREF.renderColor, category: sec("Previz", "RenderColor"),
            name: "Render: background colour", type: "color",
            defaultValue: S.RENDER_DEFAULTS.color.replace(/^#/, ""),
            sortOrder: 320, onChange: applySceneDefaults,
        },
        // ── Experimental ──
        {
            id: PREF.atlasMove, category: sec("Experimental", "AtlasCameraMove"),
            name: "Atlas camera move (paid, untested)",
            tooltip: "Shows the \"Atlas move\" button in the Previz panel: World Labs paints views along a keyframed " +
                     "camera. It costs World Labs credits and has not had a real run yet, so it is off. agentY " +
                     "must have it on too ([atlas] camera_move_enabled).",
            type: "boolean", defaultValue: false, sortOrder: 10,
        },
    ];
}

/** The `settings` array for registerExtension. */
export function viewerSettings(getPanel) {
    if (getPanel) _getPanel = getPanel;
    const list = defs();
    for (const d of list) {
        DEFAULTS[d.id] = d.defaultValue;
        if (d.id === PREF.folders) continue;          // the server's list, not a setting
        // Every change is also written to the per-user file (see below).
        const own = d.onChange;
        d.onChange = (value, old) => {
            if (own) own(value, old);
            keepForUser(d.id, value);
        };
    }
    return list;
}
// Defaults are known before registration too (pref() falls back to them).
for (const d of defs()) DEFAULTS[d.id] = d.defaultValue;

// ── Kept per user, not per ComfyUI user directory ────────────────────────────
//
// ComfyUI stores settings in its user directory, and a launcher can give every
// project its own (AYON does), so a setting changed in one project would be at
// its default in the next. The server keeps the viewer's settings in one file
// per OS user (viewer_settings.py): loaded here at startup and laid over
// ComfyUI's values, and written back on every change. ComfyUI's dialog stays
// the place they are edited.

let _userSync = false;        // true once the startup load is done: changes are written from then
const _pending = {};
let _pendingTimer = null;

function keepForUser(id, value) {
    if (!_userSync || value === undefined) return;
    _pending[id] = value;
    if (_pendingTimer) return;
    _pendingTimer = setTimeout(flushUserSettings, 300);
}

async function flushUserSettings() {
    _pendingTimer = null;
    const values = { ..._pending };
    for (const k of Object.keys(_pending)) delete _pending[k];
    if (!Object.keys(values).length) return;
    try {
        const res = await api.fetchApi("/imageviewer/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ values }),
        });
        // 404: a ComfyUI still running the viewer's previous version. The
        // settings then live in ComfyUI's own store only, as before.
        if (!res.ok && res.status !== 404) console.warn("[ImageViewer] settings not saved for the user:", res.status);
    } catch (e) {
        console.warn("[ImageViewer] settings not saved for the user", e);
    }
}

async function loadUserSettings() {
    let stored = null;
    try {
        const res = await api.fetchApi("/imageviewer/settings", { cache: "no-store" });
        if (res.ok) stored = (await res.json()).values;
    } catch (e) { /* server without the route, or unreachable */ }
    if (!stored || typeof stored !== "object") return;

    const seed = {};
    for (const id of Object.keys(DEFAULTS)) {
        if (id === PREF.folders || id === PREF.paintWorkflows) continue;
        const here = pref(id);
        if (id in stored) {
            // The user's file wins over what this ComfyUI user directory holds.
            if (stored[id] !== here) {
                try { await app.extensionManager.setting.set(id, stored[id]); }
                catch (e) { console.warn(`[ImageViewer] could not apply ${id}`, e); }
            }
        } else if (here !== DEFAULTS[id]) {
            // Changed here before the file existed (or before it knew this
            // setting): take it over rather than lose it.
            seed[id] = here;
        }
    }
    if (Object.keys(seed).length) {
        Object.assign(_pending, seed);
        await flushUserSettings();
    }
}

/** Called once ComfyUI's settings have loaded, before the panel is built. */
export async function applyStartupPrefs() {
    await loadUserSettings();
    _userSync = true;
    applySceneDefaults();
}

// ── The panel side ───────────────────────────────────────────────────────────
// A mixin like the others: one flat object of methods on the panel.

export const PrefsMixin = {

    /** The defaults the panel starts from, before any saved state is restored. */
    _applyStartupViewerPrefs() {
        this._setFpsUi(Math.max(1, Number(pref(PREF.fps)) || 25));
        this._setLoopUi(pref(PREF.loop));
        this.showOverlays = !!pref(PREF.showInfo);
        this.historyLimit = Number(pref(PREF.historyLimit)) || this.historyLimit;
    },

    _setLoopUi(mode) {
        this.loopMode = ["loop", "ping-pong", "once"].includes(mode) ? mode : "loop";
        const sel = this.shadowRoot && this.shadowRoot.getElementById("loop-sel");
        if (sel) sel.value = this.loopMode;
    },

    /** A setting changed in Settings → ComfyUI Image Viewer while the panel is up. */
    applyViewerPref(id, value) {
        if (!this.container) return;              // still starting; it reads them itself
        switch (id) {
            case PREF.fps:
                // A video or a previz shot has its own rate; it is the image
                // sequences' default that changed.
                if (this._videoMode || (this.isPrevizTab && this.isPrevizTab())) {
                    if (this._savedFps != null) this._savedFps = Number(value) || 25;
                    return;
                }
                this._setFpsUi(Math.max(1, Number(value) || 25));
                if (this.isPlaying) { this.stop(); this.play(); }
                return;
            case PREF.loop:
                return this._setLoopUi(value);
            case PREF.showInfo:
                if (!!value !== !!this.showOverlays) this.toggleOverlays(!!value);
                return;
            case PREF.historyLimit:
                if (Number(value) !== this.historyLimit) this.setHistoryLimit(value);
                return;
            case PREF.browserFold:
                if (!!value !== !!this._browserFold && this.toggleBrowserFold) this.toggleBrowserFold(!!value);
                return;
            case PREF.browserKinds:
                if (this.browserKindSel && prefKinds() !== (this._browserKinds || "")) {
                    this.browserKindSel.value = prefKinds();
                    this._browserFilterChanged({ now: true });
                }
                return;
            case PREF.dockSide:
                if (this.setPageDock && String(value || "") !== this.pageDockSide()) {
                    this.setPageDock(String(value || ""), { save: false });
                }
                return;
            case PREF.dockWidth:
            case PREF.dockHeight:
                if (this._pageDockSync && this.pageDockSide()) {
                    this._pageDockSync();
                    this._pageDockLaidOut();
                }
                return;
            case PREF.annotColor:
                if (this._annot) this._annot.color = prefColor(PREF.annotColor);
                if (this._annotSetColor && this._annotSwatches) this._annotSetColor(this._annot.color);
                return;
            case PREF.annotSize:
            case PREF.annotTextSize:
                if (this._annot) {
                    this._annotApplySizePrefs();
                    if (this._annotPanel && this._annotBuildPanel && this._annotPanel.isConnected) this._annotBuildPanel();
                }
                return;
        }
    },

    _annotApplySizePrefs() {
        const size = Number(pref(PREF.annotSize)) || 0;
        const text = Number(pref(PREF.annotTextSize)) || 0;
        if (size > 0) this._annot.size = size;
        if (text > 0) this._annot.textSize = text;
        // Either one set by hand stops the picture-relative sizing.
        this._annot.userSized = size > 0 || text > 0;
    },

    /** The compare layout a fresh compare opens in. */
    _prefCompareMode() {
        const m = pref(PREF.compareMode);
        return ["vertical", "horizontal", "contact"].includes(m) ? m : "vertical";
    },
};

// ── The folder editor ────────────────────────────────────────────────────────
//
// Rendered by ComfyUI's settings dialog through the setting's `type` function.
// The dialog throws the element away whenever it re-renders, so everything it
// shows comes from the server each time.

const CSS = `
.imageviewer-roots { display:flex; flex-direction:column; gap:8px; width:100%; min-width:320px;
    font-size:13px; color:var(--p-text-color, #ddd); }
.imageviewer-roots-h { font-size:11px; text-transform:uppercase; letter-spacing:.05em; opacity:.6; margin-top:4px; }
.imageviewer-roots-list { display:flex; flex-direction:column; gap:3px; }
.imageviewer-roots-row { display:flex; align-items:center; gap:8px; padding:4px 8px; border-radius:4px;
    background:var(--comfy-input-bg, #222); border:1px solid var(--border-color, #444); }
.imageviewer-roots-row.imageviewer-roots-fixed { opacity:.7; }
.imageviewer-roots-path { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    font-family:ui-monospace, Consolas, monospace; font-size:12px; direction:rtl; text-align:left; }
.imageviewer-roots-label { opacity:.6; font-size:11px; white-space:nowrap; }
.imageviewer-roots-bad { color:#ff9d4d; font-size:11px; white-space:nowrap; }
.imageviewer-roots button { background:var(--comfy-menu-bg, #333); color:inherit; cursor:pointer;
    border:1px solid var(--border-color, #555); border-radius:4px; padding:3px 10px; font-size:12px; }
.imageviewer-roots button:hover:not(:disabled) { border-color:#f60; color:#f60; }
.imageviewer-roots button:disabled { opacity:.4; cursor:default; }
.imageviewer-roots button.imageviewer-roots-x { padding:1px 7px; }
.imageviewer-roots-add { display:flex; gap:6px; }
.imageviewer-roots-add input { flex:1; min-width:0; background:var(--comfy-input-bg, #222); color:inherit;
    border:1px solid var(--border-color, #555); border-radius:4px; padding:4px 8px;
    font-family:ui-monospace, Consolas, monospace; font-size:12px; }
.imageviewer-roots-note { font-size:12px; opacity:.7; line-height:1.4; }
.imageviewer-roots-err { font-size:12px; color:#ff6b6b; white-space:pre-wrap; }
.imageviewer-roots-pick { border:1px solid var(--border-color, #555); border-radius:4px; padding:6px;
    display:flex; flex-direction:column; gap:6px; }
.imageviewer-roots-pick-bar { display:flex; gap:6px; align-items:center; }
.imageviewer-roots-pick-list { max-height:220px; overflow:auto; display:flex; flex-direction:column; }
.imageviewer-roots-pick-item { padding:3px 6px; cursor:pointer; border-radius:3px; white-space:nowrap;
    overflow:hidden; text-overflow:ellipsis; }
.imageviewer-roots-pick-item:hover { background:rgba(255,102,0,.15); color:#f60; }
.imageviewer-pwf-row { display:flex; flex-direction:column; gap:4px; padding:6px 8px; border-radius:4px;
    background:var(--comfy-input-bg, #222); border:1px solid var(--border-color, #444); }
.imageviewer-pwf-line { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.imageviewer-pwf-name { min-width:150px; font-weight:600; }
.imageviewer-pwf-line select { flex:1; min-width:180px; background:var(--comfy-input-bg, #222); color:inherit;
    border:1px solid var(--border-color, #555); border-radius:4px; padding:3px 6px; font-size:12px; }
.imageviewer-pwf-status { font-size:11px; opacity:.75; line-height:1.4; }
.imageviewer-pwf-status.imageviewer-pwf-warn { color:#ff9d4d; opacity:1; }
`;

function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === "style") el.style.cssText = v;
        else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
        else if (k in el) el[k] = v;
        else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
}

async function rootsCall(path, body) {
    const res = await api.fetchApi(path, body === undefined ? {} : {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (res.status === 404 && !data) {
        throw new Error("This ComfyUI is still running the viewer's previous version. Restart ComfyUI once to change this here.");
    }
    if (!res.ok) throw new Error((data && data.error) || `${res.status} ${res.statusText}`);
    return data;
}

function badge(status) {
    if (status === "ok") return null;
    return h("span", { className: "imageviewer-roots-bad",
                       title: "Not reachable right now: a drive not mounted, or a typo." },
             status === "missing" ? "not found" : "invalid");
}

function renderFolderEditor() {
    const root = h("div", { className: "imageviewer-roots" }, h("style", { textContent: CSS }));
    const body = h("div", { className: "imageviewer-roots-note" }, "Reading the folder list…");
    root.append(body);

    let state = null;          // the server's last answer
    let picker = null;         // the open folder picker, if any

    const err = h("div", { className: "imageviewer-roots-err" });
    const showError = (e) => { err.textContent = e ? (e.message || String(e)) : ""; };

    const save = async (entries) => {
        showError(null);
        try {
            state = await rootsCall("/imageviewer/roots", { entries });
            draw();
            refreshPanelBrowser();
        } catch (e) { showError(e); }
    };

    const row = (path, { label, status, fixed, onRemove }) => h("div",
        { className: `imageviewer-roots-row${fixed ? " imageviewer-roots-fixed" : ""}`, title: path },
        h("span", { className: "imageviewer-roots-path" }, h("bdi", {}, path)),
        badge(status),
        label ? h("span", { className: "imageviewer-roots-label" }, label) : null,
        onRemove ? h("button", { className: "imageviewer-roots-x", title: "Remove this folder", disabled: !state.editable,
                                 onclick: onRemove }, "✕") : null);

    function draw() {
        body.replaceChildren();
        body.className = "";
        const entries = state.file_entries.map((e) => e.entry);
        const input = h("input", { type: "text", placeholder: "Folder path, e.g. W:\\projects or \\\\server\\share",
                                   disabled: !state.editable, spellcheck: false });
        const add = () => {
            const v = input.value.trim();
            if (v) save([...entries, v]);
        };
        input.addEventListener("keydown", (e) => {
            e.stopPropagation();                 // keep ComfyUI's hotkeys out of the field
            if (e.key === "Enter") { e.preventDefault(); add(); }
        });
        const pickSlot = h("div");
        const browseBtn = h("button", { disabled: !state.editable, title: "Pick a folder on the ComfyUI machine",
                                        onclick: () => {
                                            if (picker) { picker.remove(); picker = null; return; }
                                            picker = folderPicker(input.value.trim(), (p) => {
                                                picker.remove(); picker = null;
                                                save([...entries, p]);
                                            });
                                            pickSlot.append(picker);
                                        } }, "Browse…");
        body.append(
            h("div", { className: "imageviewer-roots-h" }, "Added folders — each with all its subfolders"),
            state.file_entries.length
                ? h("div", { className: "imageviewer-roots-list" }, state.file_entries.map((e, i) => row(e.path, {
                    status: e.status, label: e.entry !== e.path ? e.entry : "",
                    onRemove: () => save(entries.filter((_, j) => j !== i)),
                })))
                : h("div", { className: "imageviewer-roots-note" }, "None yet."),
            h("div", { className: "imageviewer-roots-add" }, input, browseBtn,
              h("button", { disabled: !state.editable, onclick: add }, "Add")),
            pickSlot,
            err,
        );
        if (state.env.length) {
            body.append(
                h("div", { className: "imageviewer-roots-h" }, `From ${state.env_var}`),
                h("div", { className: "imageviewer-roots-list" }, state.env.map((e) =>
                    row(e.path, { status: e.status, fixed: true, label: "environment" }))),
            );
        }
        body.append(
            h("div", { className: "imageviewer-roots-h" }, "Always"),
            h("div", { className: "imageviewer-roots-list" }, state.comfy.map((e) =>
                row(e.path, { status: e.status, fixed: true, label: e.label }))),
            h("div", { className: "imageviewer-roots-note" },
              state.editable
                  ? `A folder allows everything inside it, at any depth. Saved on the ComfyUI machine in ` +
                    `${state.file}. Takes effect at once; no restart.`
                  : state.reason),
        );
    }

    rootsCall("/imageviewer/roots")
        .then((data) => { state = data; draw(); })
        .catch((e) => { body.className = "imageviewer-roots-err"; body.textContent = `Could not read the folder list. ${e.message || e}`; });
    return root;
}

/** A folder tree of the ComfyUI machine (folders only), for picking one. */
function folderPicker(start, onPick) {
    const box = h("div", { className: "imageviewer-roots-pick" });
    const where = h("span", { className: "imageviewer-roots-path", style: "direction:ltr" });
    const up = h("button", { title: "Up one folder" }, "↑");
    const use = h("button", {}, "Use this folder");
    const list = h("div", { className: "imageviewer-roots-pick-list" });
    const err = h("div", { className: "imageviewer-roots-err" });
    box.append(h("div", { className: "imageviewer-roots-pick-bar" }, up, where, use), list, err);

    let current = null;
    const go = async (path) => {
        err.textContent = "";
        let data;
        try { data = await rootsCall("/imageviewer/roots/folders", { path }); }
        catch (e) {
            // A typed path that isn't a folder: start from the top instead.
            if (path) return go("");
            err.textContent = e.message || String(e);
            return;
        }
        current = data;
        where.textContent = data.path || "This computer";
        use.disabled = !data.path;
        up.disabled = data.parent === null || data.parent === undefined;
        list.replaceChildren(...(data.dirs.length
            ? data.dirs.map((d) => h("div", { className: "imageviewer-roots-pick-item", title: d.path,
                                               onclick: () => go(d.path) }, `📁 ${d.name}`))
            : [h("div", { className: "imageviewer-roots-note" }, "No folders inside.")]));
    };
    up.onclick = () => { if (current && current.parent != null) go(current.parent); };
    use.onclick = () => { if (current && current.path) onPick(current.path); };
    go(start || "");
    return box;
}

function refreshPanelBrowser() {
    const panel = _getPanel();
    if (panel && panel._browserLoaded && panel.browseTo) {
        try { panel.browseTo(panel._browserDir, { force: true }); } catch (e) { /* not open */ }
    }
}

// ── The workflows of Paint's Generate ────────────────────────────────────────
//
// Like the folder editor: rendered by the settings dialog, everything read from the
// server each time (GET /imageviewer/paint/workflows), every change a POST there.

/** "3 (LoadImage)" for a slot of a graph, from /imageviewer/paint/workflows' `slots`. */
function slotText(slots) {
    if (!slots) return "";
    const p = [`picture in: node ${slots.image || "none"}`];
    if (slots.mask) p.push(`mask: node ${slots.mask}`);
    p.push(slots.prompt ? `prompt: node ${slots.prompt[0]}.${slots.prompt[1]}` : "no prompt");
    p.push(`result: node ${slots.output || "none"}`);
    if (slots.seeds && slots.seeds.length) p.push(`${slots.seeds.length} seed${slots.seeds.length > 1 ? "s" : ""} new each run`);
    return p.join(" · ");
}

function missingText(miss) {
    return (miss || []).map((m) => (m.kind === "model" ? `${m.what} (${m.folder})` : `node ${m.what}`)).join(", ");
}

/** The workflow name ComfyUI's tab bar shows for the canvas, else "canvas". */
function canvasWorkflowName() {
    try {
        const w = app.extensionManager && app.extensionManager.workflow && app.extensionManager.workflow.activeWorkflow;
        const n = w && (w.filename || w.path || w.key);
        if (n) return String(n).replace(/^.*[\\/]/, "").replace(/\.json$/i, "");
    } catch (_) { /* older frontend */ }
    return "canvas";
}

export function renderPaintWorkflowEditor() {
    const root = h("div", { className: "imageviewer-roots" }, h("style", { textContent: CSS }));
    const body = h("div", { className: "imageviewer-roots-note" }, "Reading the workflows…");
    const err = h("div", { className: "imageviewer-roots-err" });
    root.append(body);
    let state = null;
    const said = {};                      // action -> what the last change said (the slots found)

    const call = async (bodyJson) => {
        err.textContent = "";
        try {
            const data = await rootsCall("/imageviewer/paint/workflows", bodyJson);
            state = data;
            if (bodyJson.action && data.slots) said[bodyJson.action] = slotText(data.slots);
            const panel = _getPanel();
            if (panel) panel._paintWf = null;          // the Generate buttons ask again
            draw();
        } catch (e) { err.textContent = e.message || String(e); }
    };

    const fromCanvas = async (action) => {
        let p;
        try { p = await app.graphToPrompt(); }
        catch (e) { err.textContent = `The canvas could not be read: ${e.message || e}`; return; }
        await call({ action, graph: p && p.output ? p.output : p, name: canvasWorkflowName(), source: "canvas" });
    };

    const fromFile = (action) => {
        const inp = h("input", { type: "file", accept: ".json,application/json", style: "display:none" });
        inp.addEventListener("change", async () => {
            const f = inp.files && inp.files[0];
            inp.remove();
            if (!f) return;
            let graph;
            try { graph = JSON.parse(await f.text()); }
            catch (e) { err.textContent = `${f.name} is not JSON: ${e.message || e}`; return; }
            await call({ action, graph, name: f.name.replace(/\.json$/i, ""), source: "file" });
        });
        root.append(inp);
        inp.click();
    };

    function draw() {
        body.className = "";
        body.replaceChildren(h("div", { className: "imageviewer-roots-h" }, "What each Generate action runs"));
        for (const [a, info] of Object.entries(state.actions)) {
            const sel = h("select", { title: "The workflow this action runs" });
            for (const w of info.workflows) {
                sel.append(h("option", { value: w.id, textContent: w.label + (w.id === info.default ? " - default" : "")
                                                                  + (w.missing.length ? " - missing models" : "") }));
            }
            if (info.custom) sel.append(h("option", { value: "custom", textContent: `My workflow: ${info.custom.name || "custom"}` }));
            sel.append(h("option", { value: "agent", textContent: "agentY builds one (asks the agent)" }));
            sel.value = info.choice;
            sel.addEventListener("change", () => call({ action: a, choice: sel.value }));
            const chosen = info.choice === "custom" ? info.custom : info.workflows.find((w) => w.id === info.choice);
            const miss = chosen && chosen.missing && chosen.missing.length ? missingText(chosen.missing) : "";
            const lines = [];
            if (miss) {
                const offered = chosen.missing.every((m) => m.url);       // a built-in's model files: offered when it first runs
                lines.push(h("div", { className: "imageviewer-pwf-status imageviewer-pwf-warn" },
                             offered ? `Not on this machine: ${miss} - Paint offers to download them when it first runs` : `Not on this machine: ${miss}`));
            }
            if (info.custom) {
                const t = said[a] || slotText(info.custom.slots);
                lines.push(h("div", { className: "imageviewer-pwf-status" },
                             `Yours (${info.custom.source === "canvas" ? "from the canvas" : "from a file"}${info.custom.saved ? ", " + String(info.custom.saved).slice(0, 16).replace("T", " ") : ""}): ${t}`));
            }
            body.append(h("div", { className: "imageviewer-pwf-row" },
                h("div", { className: "imageviewer-pwf-line" },
                  h("span", { className: "imageviewer-pwf-name" }, info.label), sel),
                h("div", { className: "imageviewer-pwf-line" },
                  h("button", { title: "The workflow on the canvas now (as ComfyUI would queue it) becomes yours for this action",
                                onclick: () => fromCanvas(a) }, "Use the canvas"),
                  h("button", { title: "A workflow saved with Export (API)", onclick: () => fromFile(a) }, "Load API file…"),
                  info.custom ? h("button", { title: "Forget your own; the default is used again", onclick: () => call({ action: a, graph: null }) }, "Remove mine") : null),
                lines));
        }
        body.append(err, h("div", { className: "imageviewer-roots-note" },
            "Your own workflow needs a picture input and a result: name the nodes paint:image (Load Image), paint:mask (Load Image (as Mask), " +
            "optional - else the selection is the picture's alpha), paint:prompt (where the words go) and paint:output (Save / Preview Image); " +
            "without those names the first Load Image, the positive prompt and the last Save Image are taken. Seeds are new on every run. " +
            `Kept on the ComfyUI machine in ${state.folder}.`));
    }

    rootsCall("/imageviewer/paint/workflows")
        .then((data) => { state = data; draw(); })
        .catch((e) => { body.className = "imageviewer-roots-err"; body.textContent = `Could not read the workflows. ${e.message || e}`; });
    return root;
}

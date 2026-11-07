// imageViewer.js    main entry point
// The ViewerPanel class is assembled from focused mixin modules so the
// overall codebase stays manageable while sharing one prototype chain.
// First: moves what was saved under the old "bEpic" names before anything reads it.
import { renameLegacyNodes, migrateSettings } from "./imageViewer_legacy.js";
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

import { LayoutMixin }   from "./imageViewer_mixinLayout.js";
import { HistoryMixin, HISTORY_LIMIT_DEFAULT, HISTORY_LIMIT_OLD_DEFAULT, HISTORY_KEY, HISTORY_VIEW_TAB, VIEWER_TAB_LABEL, clampHistoryLimit }  from "./imageViewer_mixinHistory.js";
import { mergeTabHistories, snapshotTab, isMediaTabKey, isFeedTabKey, foldIntoTab, groupFromLabel, packSnapshot, unpackSnapshot } from "./imageViewer_historyData.js";
import { PrevizWorldMixin } from "./imageViewer_previzWorld.js";
import { PlaybackMixin } from "./imageViewer_mixinPlayback.js";
import { ParamsMixin }   from "./imageViewer_mixinParams.js";
import { UIMixin }       from "./imageViewer_mixinUI.js";
import { ColorMixin }    from "./imageViewer_color.js";
import { ToolsMixin }    from "./imageViewer_tools.js";
import { RotoMixin }     from "./imageViewer_roto.js";
import { AnnotateMixin } from "./imageViewer_annotate.js";
import { AnnotateVideoMixin } from "./imageViewer_annotateVideo.js";
import { DnDMixin }      from "./imageViewer_mixinDnD.js";
import { BrowserMixin }  from "./imageViewer_mixinBrowser.js";
import { DockMixin }     from "./imageViewer_mixinDock.js";
import { PageDockMixin } from "./imageViewer_mixinPageDock.js";
import { ReconnectMixin } from "./imageViewer_mixinReconnect.js";
import { ModelMixin }    from "./imageViewer_mixinModel.js";
import { PrevizMixin }   from "./imageViewer_mixinPreviz.js";
import { PrevizCurvesMixin } from "./imageViewer_previzCurves.js";
import { RotoCurvesMixin } from "./imageViewer_rotoCurves.js";
import { HistoryTagsMixin } from "./imageViewer_historyTags.js";
import { AgentYMixin, namedTabInfo } from "./imageViewer_agentY.js";
import { AgentPanelMixin } from "./imageViewer_agentPanel.js";
import { AgentStateMixin } from "./imageViewer_agentState.js";
import { ContactGridMixin } from "./imageViewer_contactGrid.js";
import { ParamAnimMixin } from "./imageViewer_paramAnim.js";
import { ParamCurvesMixin } from "./imageViewer_paramCurves.js";
import { ViewTabsMixin } from "./imageViewer_viewTabs.js";
import { CodePanelMixin } from "./imageViewer_codePanel.js";
import { DepsPanelMixin } from "./imageViewer_depsPanel.js";
import { MgPanelMixin } from "./imageViewer_mgPanel.js";
import { PaintPanelMixin } from "./imageViewer_paintPanel.js";
import { LoraPanelMixin } from "./imageViewer_loraPanel.js";
import { PrevizChannelsMixin } from "./imageViewer_previzChannels.js";
import { PrevizRenderMixin } from "./imageViewer_previzRender.js";
import { PrevizShotMixin } from "./imageViewer_previzShot.js";
import { PrevizAtlasMixin } from "./imageViewer_previzAtlas.js";
import { PrevizUndoMixin } from "./imageViewer_previzUndo.js";
import { EditTimelineMixin } from "./imageViewer_editTimeline.js";
import { EditPlayMixin } from "./imageViewer_editPlay.js";
import { EditPanelsMixin } from "./imageViewer_editPanels.js";
import { EditMediaMixin } from "./imageViewer_editMedia.js";
import { EditKeysMixin } from "./imageViewer_editKeys.js";
import { EditAutoMixin } from "./imageViewer_editAuto.js";
import { EditTakesMixin } from "./imageViewer_editTakes.js";
import { EditResolveMixin } from "./imageViewer_editResolve.js";
import { EditTrimMixin } from "./imageViewer_editTrim.js";
import { EditAudioMixin } from "./imageViewer_editAudio.js";
import { EditProxyMixin } from "./imageViewer_editProxy.js";
import { AudioViewMixin } from "./imageViewer_audio.js";
import { EditTwoUpMixin } from "./imageViewer_editTwoUp.js";
import { EditPasteMixin } from "./imageViewer_editPaste.js";
import { EditOpenMixin } from "./imageViewer_editOpen.js";
import { EditDialogsMixin } from "./imageViewer_editDialogs.js";
import { EditXfadeMixin } from "./imageViewer_editXfade.js";
import { EditVolLineMixin } from "./imageViewer_editVolLine.js";
import { EditSectionsMixin } from "./imageViewer_editSections.js";
import { EditAfxPlayMixin } from "./imageViewer_editAfxPlay.js";
import { EditAfxMixin } from "./imageViewer_editAfx.js";
import { BarGroupsMixin } from "./imageViewer_barGroups.js";
import { ExportViewMixin } from "./imageViewer_exportView.js";
import { FullscreenMixin } from "./imageViewer_fullscreen.js";
import { SendFromNodeMixin, registerSendToViewerMenu, sendSelectionToViewer } from "./imageViewer_sendFromNode.js";
import {
    registerSendNode, registerToolNode, senderTabInfo, isViewerSourceNode, IMAGE_VIEWER_SCENE_NODE,
    IMAGE_VIEWER_SEND_NODE, IMAGE_VIEWER_ROTO_NODE, IMAGE_VIEWER_SAM3_NODE,
} from "./imageViewer_nodeTools.js";
import { viewerCommands, viewerKeybindings, VIEWER_TARGET_ID } from "./imageViewer_keymap.js";
import { parseScene } from "./imageViewer_scene3d.js";
import { viewerSettings, applyStartupPrefs, PrefsMixin, pref, setPref, PREF } from "./imageViewer_settings.js";

let globalViewerPanel = null;
const watchedNodeIds  = new Set();

// Tab keys the user opened by hand rather than ones mirroring a node in the
// graph: 📂 Open Folder, 📥 dropped files, and 🖼/🎬 "Send to Image Viewer".
// Nothing in the graph backs them, so the stale-tab sweep must leave them be.
// "world:" tabs come from the bEpic Worlds pack (or an agent through it).
// "previz:" tabs are shots an agent asked for (previz_shot.py).
// "edit:" tabs are cuts being worked on in the Edit panel.
// "motion:" tabs are motion-graphics scenes in the Motion editor; "paint:" tabs are pictures in Paint.
// "code:" tabs are the Agent code reader (a file, or the agent's feed); "dataset:" tabs are LoRA datasets.
const USER_TAB_PREFIXES = ["folder_", "dropped_", "loader_", "world:", "previz:", "edit:", "motion:", "paint:", "code:", "dataset:", "named:"];
let isViewerPanelToggledOn = false;
let _actionBarStateRetryTimer = null;

function _ensureActionBarActiveStyle() {
    const styleId = "comfyui-image-viewer-actionbar-active-style";
    if (document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
        [title="Toggle ComfyUI Image Viewer"].comfyui-image-viewer-actionbar-active,
        button[title="Toggle ComfyUI Image Viewer"].comfyui-image-viewer-actionbar-active {
            color: #f60 !important;
        }
    `;
    document.head.appendChild(style);
}

function _updateActionBarButtonState() {
    _ensureActionBarActiveStyle();
    try {
        const nodes = Array.from(document.querySelectorAll('[title="Toggle ComfyUI Image Viewer"]'));
        if (nodes.length > 0) {
            nodes.forEach((node) => {
                node.classList.toggle('comfyui-image-viewer-actionbar-active', isViewerPanelToggledOn);
            });
            if (_actionBarStateRetryTimer) {
                clearTimeout(_actionBarStateRetryTimer);
                _actionBarStateRetryTimer = null;
            }
        } else if (!_actionBarStateRetryTimer) {
            _actionBarStateRetryTimer = setTimeout(() => {
                _actionBarStateRetryTimer = null;
                _updateActionBarButtonState();
            }, 200);
        }
    } catch (e) {
        if (_actionBarStateRetryTimer) {
            clearTimeout(_actionBarStateRetryTimer);
            _actionBarStateRetryTimer = null;
        }
    }
}

function _setViewerPanelToggle(nextState, { syncDisplay = true } = {}) {
    isViewerPanelToggledOn = !!nextState;
    if (!globalViewerPanel) return;
    globalViewerPanel.setViewerToggleState(isViewerPanelToggledOn, { syncDisplay });
    _updateActionBarButtonState();
}

function _toggleViewerPanelFromUi() {
    _setViewerPanelToggle(!isViewerPanelToggledOn, { syncDisplay: true });
}

/** Show this scene node's previz tab, opening the viewer if it is closed. */
function _openPrevizFromNode(node) {
    _setViewerPanelToggle(true, { syncDisplay: true });
    const panel = globalViewerPanel || document.querySelector("comfyui-image-viewer-panel");
    if (!panel || !panel.openPrevizForNode) return;
    const info = senderTabInfo(node);
    if (!info) return;
    const widget = (name) => (node.widgets || []).find((w) => w && w.name === name);
    panel.openPrevizForNode(node, {
        key: info.key,
        label: info.label,
        sceneData: (widget("scene_data") || {}).value || "",
        renderName: (widget("render_name") || {}).value || "",
    });
}

// The panel a keymap command should act on: the viewer, but only while it is on
// screen. Firing playback or channel changes at a closed panel would be invisible.
function _activeViewerPanel() {
    const panel = globalViewerPanel || document.querySelector("comfyui-image-viewer-panel");
    if (!panel) return null;
    return panel.isViewerVisible && panel.isViewerVisible() ? panel : null;
}

// Preload CSS + HTML + icon skin in parallel so they are ready before the first
// element is connected to the DOM.
const timestamp    = Date.now();
const cssPromise   = fetch(new URL(`./imageViewer.css?v=${timestamp}`,            import.meta.url)).then(r => r.text());
const htmlPromise  = fetch(new URL(`./imageViewer.html?v=${timestamp}`,           import.meta.url)).then(r => r.text());
const iconsPromise = fetch(new URL(`./imageViewer_iconsUIsvg.json?v=${timestamp}`, import.meta.url)).then(r => r.json());

/**
 * Icon-to-button mapping.  Each entry maps a DOM id (or special key)
 * to the icon key in the JSON skin file.
 */
const ICON_MAP = {
    'play':              'icon-play',
    's-start':           'icon-skip-start',
    's-end':             'icon-skip-end',
    's-prev':            'icon-prev',
    's-next':            'icon-next',
    'fit-btn':           'icon-fit',
    'overlays-btn':      'icon-overlays',
    'rotate-btn':        'icon-rotate-slider',
    'close-panel-btn':   'icon-close',
    'undock-btn':        'icon-undock',
    'layout-btn':        'icon-layout',
    'history-toggle-btn':'icon-history',
    'params-btn':        'icon-params',
    'range-btn':         'icon-range',
    'refresh':           'icon-refresh',
    'browser-toggle-btn':'icon-folder',
    'clear-cache-btn':   'icon-delete',
    'history-clear-btn': 'icon-delete',
    'help-btn':          'icon-help',
    'params-lock-btn':   'icon-unlock',
};

// 
class ViewerPanel extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });

        //  State
        this.allTabs             = {};
        this.activeTab           = null;
        this.compareTab          = null;
        this.isComparing         = false;
        this.showOverlays        = true;
        this.customLayouts       = {};
        this.tabLabels           = {};
        this.tabColors           = {};
        this.historyTags         = {};    // image key → tag id (HistoryTagsMixin)
        this.historyTagFilter    = "";
        this.sliderPos           = 50;
        this.isDraggingSlider    = false;
        this.sliderMode          = "vertical";
        this.currentFrame        = 0;
        this.isPlaying           = false;
        this.direction           = 1;
        this.fps                 = 25;
        this.exposure            = 0;
        this.channelView         = 'all';
        this.isExposureModifierActive = false;
        this.isExposureDragging  = false;
        this.loopMode            = "loop";
        this.zoom                = 1.0;
        this.panX                = 0;
        this.panY                = 0;
        this.isDraggingPanel     = false;
        this.dragStartX          = 0;
        this.dragStartY          = 0;
        this.isHovered           = false;
        this.playbackRange       = null;
        this.isSelectingRange    = false;
        this.isInputRangeLocked  = false;
        this.lockedTimelineRange = null;
        this.originalNodeValues  = new Map();
        this.popoutWindow        = null;
        this.paramsSide          = "right";
        this.selectedNodeIds     = [];
        this.history             = {};
        this.tabViewState        = {};
        this.isViewingHistory    = false;
        this.previewBackup       = null;
        this.tabOrder            = [];
        this.paramsLocked        = false;
        this.tabSourceNodeIds    = {};
        this.paramTextSizes      = {};
        this.paramResizeObservers = [];
        // Mixin optimisation: fast-path skip signatures
        this._historyPanelSig    = null;
        this._lastTransformSig   = null;
        this._persistTimer       = null;
        this._isRestoringViewerState = false;
        // Nothing is saved until init has read the saved state back: a save
        // before that writes the EMPTY start state over the user's history
        // (see persistViewerState).
        this._viewerStateRestored = false;
        this._beforeUnloadHandler = null;
        this.viewerToggleEnabled = false;

        this.init();
    }

    setViewerToggleState(enabled, { syncDisplay = true } = {}) {
        this.viewerToggleEnabled = !!enabled;
        if (!syncDisplay) return;
        if (this.viewerToggleEnabled) {
            if (!this.popoutWindow || this.popoutWindow.closed) this.style.display = "flex";
        } else {
            if (!this.popoutWindow || this.popoutWindow.closed) this.style.display = "none";
        }
    }

    requestPanelOpen() {
        if (!this.viewerToggleEnabled) return;
        if (!this.popoutWindow || this.popoutWindow.closed) this.style.display = "flex";
    }

    connectedCallback() {
        // Named so the viewer's keybindings can name it as their target element —
        // that is what keeps ComfyUI from dispatching them app-wide. See
        // imageViewer_keymap.js. Set here rather than in the constructor, which is
        // not allowed to give the element attributes, and guarded so a second
        // panel can't duplicate the id.
        if (!this.id && !document.getElementById(VIEWER_TARGET_ID)) this.id = VIEWER_TARGET_ID;

        if (!this._beforeUnloadHandler) {
            this._beforeUnloadHandler = () => this.persistViewerState();
            window.addEventListener('beforeunload', this._beforeUnloadHandler);
        }
        // agentY's tags in the history filter (HistoryTagsMixin).
        if (this.startAgentTagWatch) this.startAgentTagWatch();
    }

    disconnectedCallback() {
        if (this._agentTagTimer) { clearInterval(this._agentTagTimer); this._agentTagTimer = null; }
        this.persistViewerState();
        if (this._beforeUnloadHandler) {
            window.removeEventListener('beforeunload', this._beforeUnloadHandler);
            this._beforeUnloadHandler = null;
        }
    }

    _getViewerStateStorageKey() {
        let path = 'default';
        try { path = (window?.location?.pathname || 'default'); } catch (e) {}
        return `imageViewer:state:v1:${path}`;
    }

    queuePersistViewerState() {
        if (this._isRestoringViewerState || !this._viewerStateRestored) return;
        if (this._persistTimer) clearTimeout(this._persistTimer);
        this._persistTimer = setTimeout(() => {
            this._persistTimer = null;
            this.persistViewerState();
        }, 150);
    }

    persistViewerState() {
        // Before init has restored, this panel holds the empty state it was
        // built with, and saving it would wipe the history and agent tabs the
        // last session left. Things that run that early do exist: agentY's tag
        // watch starts the moment the panel is attached (connectedCallback) and
        // queued a save while init still waited on its userdata reads, which
        // emptied the saved state on every slow start (a ComfyUI restart).
        if (this._isRestoringViewerState || !this._viewerStateRestored) return;
        try {
            // Dropped-file tabs live on blob: URLs that die on reload — never
            // persist them (they would restore as broken images).
            const isDropped = (frames) => (frames || []).some((fr) => fr && fr.dropped);
            // The one history, without what dropped files made (blob: URLs too).
            const history = {
                [HISTORY_KEY]: ((this.history || {})[HISTORY_KEY] || []).filter((s) =>
                    !String(snapshotTab(s)).startsWith('dropped_') && !isDropped(s)),
            };
            // The Viewer tab showing a dropped file is saved showing the newest
            // snapshot of it that is kept; with none, it is not saved.
            const tabs = { ...(this.allTabs || {}) };
            if (isDropped(tabs[HISTORY_VIEW_TAB])) {
                const kept = history[HISTORY_KEY].find((s) => snapshotTab(s) === HISTORY_VIEW_TAB);
                if (kept) tabs[HISTORY_VIEW_TAB] = kept;
                else delete tabs[HISTORY_VIEW_TAB];
            }
            const keepKey = (k) => !String(k).startsWith('dropped_') && !isDropped(tabs[k])
                                   && (k !== HISTORY_VIEW_TAB || !!tabs[k]);
            const pick = (obj) => {
                const out = {};
                Object.keys(obj || {}).forEach((k) => { if (keepKey(k)) out[k] = obj[k]; });
                return out;
            };
            const activeTab = keepKey(this.activeTab) ? (this.activeTab || null) : null;
            // Sequences in their saved form (packSnapshot, imageViewer_historyData.js).
            const packAll = (obj) => {
                const out = {};
                for (const [k, v] of Object.entries(obj)) out[k] = packSnapshot(v);
                return out;
            };
            const payload = {
                version: 1,
                allTabs: packAll(pick(tabs)),
                history: { [HISTORY_KEY]: history[HISTORY_KEY].map(packSnapshot) },
                historyCollapsed: [...(this.historyCollapsed instanceof Set ? this.historyCollapsed : (this.historyCollapsed || []))],
                tabViewState: pick(this.tabViewState),
                tabLabels: pick(this.tabLabels),
                tabColors: pick(this.tabColors),
                historyTags: this.historyTagsToPersist ? this.historyTagsToPersist(history) : {},
                historyTagFilter: this.historyTagFilter || "",
                tabOrder: (Array.isArray(this.tabOrder) ? this.tabOrder : []).filter(keepKey),
                activeTab,
                browserDir: this._browserDir || null,
                browserFilter: {
                    text: this._browserFilter || "",
                    kinds: this._browserKinds || "",
                    foldSequences: !!this._browserFold,
                },
                // Previz scenes belong to their tab. A scene on a Image Viewer 3D Scene
                // node is also kept there, but a scene built on a plain model
                // tab has nowhere else to live.
                scenes: pick(this._scenes || {}),
                dock: this.serializeDock ? this.serializeDock() : null,
                historyLimit: clampHistoryLimit(this.historyLimit),
                savedAt: Date.now(),
            };
            window.localStorage.setItem(this._getViewerStateStorageKey(), JSON.stringify(payload));
        } catch (e) {
            console.warn('imageViewer persist state failed', e);
        }
    }

    restoreViewerState() {
        let raw = null;
        let parsed = null;
        try {
            raw = window.localStorage.getItem(this._getViewerStateStorageKey());
            if (!raw) return false;
            parsed = JSON.parse(raw);
        } catch (e) {
            console.warn('imageViewer restore state parse failed', e);
            return false;
        }

        if (!parsed || typeof parsed !== 'object') return false;

        // The limit is a setting now (Settings → ComfyUI Image Viewer). A limit this
        // browser kept from before is taken over once, while the setting is
        // still at its default.
        // The old default (40 per tab) is no choice of the user's: it is not taken over.
        if (parsed.historyLimit != null) {
            const kept = clampHistoryLimit(parsed.historyLimit);
            if (kept !== HISTORY_LIMIT_DEFAULT && kept !== HISTORY_LIMIT_OLD_DEFAULT
                && Number(pref(PREF.historyLimit)) === HISTORY_LIMIT_DEFAULT) {
                this.historyLimit = kept;
                setPref(PREF.historyLimit, kept);
                this._syncHistoryLimitInput();
            }
        }
        if (typeof parsed.historyTagFilter === 'string') this.historyTagFilter = parsed.historyTagFilter;
        if (Array.isArray(parsed.historyCollapsed)) this.historyCollapsed = new Set(parsed.historyCollapsed.map(String));
        if (parsed.historyTags && typeof parsed.historyTags === 'object') {
            this.historyTags = JSON.parse(JSON.stringify(parsed.historyTags));
        }

        // Sequences come back from their saved form (unpackSnapshot); an older save is read as it is.
        const unpackAll = (obj, each) => {
            const out = {};
            for (const [k, v] of Object.entries(obj)) out[k] = each(v);
            return out;
        };
        const restoredTabs = (parsed.allTabs && typeof parsed.allTabs === 'object') ? unpackAll(parsed.allTabs, unpackSnapshot) : {};
        const restoredHistory = (parsed.history && typeof parsed.history === 'object')
            ? unpackAll(parsed.history, (stack) => (Array.isArray(stack) ? stack.map(unpackSnapshot) : stack)) : {};
        const restoredTabViewState = (parsed.tabViewState && typeof parsed.tabViewState === 'object') ? parsed.tabViewState : {};
        const restoredLabels = (parsed.tabLabels && typeof parsed.tabLabels === 'object') ? parsed.tabLabels : {};
        const restoredColors = (parsed.tabColors && typeof parsed.tabColors === 'object') ? parsed.tabColors : {};
        const restoredOrder = Array.isArray(parsed.tabOrder) ? parsed.tabOrder : [];
        const restoredActive = typeof parsed.activeTab === 'string' ? parsed.activeTab : null;
        const restoredScenes = (parsed.scenes && typeof parsed.scenes === 'object') ? parsed.scenes : {};

        // How the panels were arranged, restored ahead of the early-out below —
        // a session that opened no tabs still deserves its layout back.
        //
        // This runs after applyFactoryDefault (see init), so without a guard it
        // would always win, and "Make Current Layout default" would appear to
        // forget every panel position the moment you reloaded. Whichever the
        // user set LAST wins instead: save a default and it opens that way; drag
        // a panel afterwards and THAT is what comes back next time. A default
        // saved before this change carries no stamp and counts as older, which
        // is the behaviour those sessions already had.
        const dockSavedAt = Number(parsed.savedAt) || 0;
        const defaultSavedAt = Number(this.factoryDefaultLayout && this.factoryDefaultLayout.savedAt) || 0;
        if (parsed.dock && this.applyDockData && dockSavedAt >= defaultSavedAt) {
            try { this.applyDockData(parsed.dock); }
            catch (e) { console.warn('imageViewer: could not restore the dock layout', e); }
        }

        const keys = Object.keys(restoredTabs);
        if (keys.length === 0 && Object.keys(restoredHistory).length === 0) return false;

        this._isRestoringViewerState = true;
        try {
            this.allTabs = JSON.parse(JSON.stringify(restoredTabs));
            // One history for every tab. A viewer from before kept one per tab:
            // those are merged into it, each snapshot remembering its tab.
            const perTab = Object.keys(restoredHistory).some((k) => k !== HISTORY_KEY);
            this.history = perTab
                ? { [HISTORY_KEY]: mergeTabHistories(restoredHistory, restoredOrder, clampHistoryLimit(this.historyLimit)) }
                : JSON.parse(JSON.stringify(restoredHistory));
            this.tabViewState = JSON.parse(JSON.stringify(restoredTabViewState));
            this.tabLabels = JSON.parse(JSON.stringify(restoredLabels));
            this.tabColors = JSON.parse(JSON.stringify(restoredColors));
            this._scenes = {};
            for (const [k, raw] of Object.entries(restoredScenes)) {
                const scene = parseScene(raw);
                // A 3D tab opened empty from the bar ("Open 3D…") is a scene with nothing in it yet.
                if (scene.items.length || String(k).startsWith("previz:new-")) this._scenes[k] = scene;
            }

            // The tabs that only showed media are the one Viewer tab now: their
            // snapshots are its, it shows what the one that was up showed (else
            // what it showed itself, else the newest of theirs), and it takes the
            // first one's place in the bar.
            let order = restoredOrder, active = restoredActive;
            // ...and so are the tabs of Send to Viewer nodes and agentY's named
            // tabs, each a group under its old name.
            const isFeed = (k) => isFeedTabKey(k, (key) => this._isFeedNodeTabKey(key));
            const folded = Object.keys(this.allTabs).filter((k) => isMediaTabKey(k) || isFeed(k));
            if (folded.length) {
                const groups = {};
                for (const k of folded) if (isFeed(k)) groups[k] = groupFromLabel(this.tabLabels[k] || k);
                const stack = foldIntoTab(this.history[HISTORY_KEY] || [], folded, HISTORY_VIEW_TAB, groups);
                this.history[HISTORY_KEY] = stack;
                const shown = (folded.includes(active) && this.allTabs[active])
                    || this.allTabs[HISTORY_VIEW_TAB]
                    || stack.find((s) => snapshotTab(s) === HISTORY_VIEW_TAB)
                    || this.allTabs[folded[0]];
                for (const k of folded) {
                    delete this.allTabs[k]; delete this.tabLabels[k]; delete this.tabColors[k]; delete this.tabViewState[k];
                }
                this.allTabs[HISTORY_VIEW_TAB] = JSON.parse(JSON.stringify(shown));
                this.tabLabels[HISTORY_VIEW_TAB] = VIEWER_TAB_LABEL;
                const at = order.findIndex((k) => folded.includes(k) || k === HISTORY_VIEW_TAB);
                order = order.filter((k) => !folded.includes(k) && k !== HISTORY_VIEW_TAB);
                order.splice(at < 0 ? order.length : Math.min(at, order.length), 0, HISTORY_VIEW_TAB);
                if (folded.includes(active)) active = HISTORY_VIEW_TAB;
            }
            if (this.allTabs[HISTORY_VIEW_TAB]) this.tabLabels[HISTORY_VIEW_TAB] = VIEWER_TAB_LABEL;

            const known = order.filter(k => !!this.allTabs[k]);
            const added = Object.keys(this.allTabs).filter(k => !known.includes(k));
            this.tabOrder = [...known, ...added];

            if (active && this.allTabs[active]) this.activeTab = active;
            else this.activeTab = this.tabOrder[0] || Object.keys(this.allTabs)[0] || null;

            this.previewBackup = null;
            this.isViewingHistory = false;
            this.currentHistoryKey = null;
            this.currentHistoryIndex = null;

            this._historyPanelSig = null;
            this._rebuildTabBar(null);
            this.renderHistoryPanel();

            return true;
        } catch (e) {
            console.warn('imageViewer restore state apply failed', e);
            return false;
        } finally {
            this._isRestoringViewerState = false;
        }
    }

    //  Async init 
    async init() {
        const [css, html, icons] = await Promise.all([cssPromise, htmlPromise, iconsPromise]);

        // Store the icon skin so dynamic swaps (play/pause, lock/unlock, etc.)
        // can look up SVG strings at runtime.
        this._iconSkin = icons;

        const style = document.createElement('style');
        style.textContent = css + `
            .img-layer {
                top:0; left:0; right:0; bottom:0; margin:auto;
                width:auto; height:auto;
                max-width:100%; max-height:100%;
            }
            .tab, .history-thumb { user-select:none; }
            .history-thumb.selected { border:1px solid #f60; }
            .history-thumb[draggable="true"] { cursor: grab; }
            #viewport.imageviewer-drop-hover { outline: 2px dashed #f60; outline-offset: -6px; }
            #viewport.imageviewer-drop-hover::after {
                content: "Drop images or videos to open";
                position: absolute; left: 50%; top: 12px; transform: translateX(-50%);
                background: rgba(20,20,20,0.85); color: #f60; font-size: 12px;
                padding: 4px 10px; border-radius: 4px; pointer-events: none; z-index: 40;
            }
        `;
        this.shadowRoot.appendChild(style);

        this.container           = document.createElement('div');
        this.container.className = 'panel-container';
        this.container.innerHTML = html;
        this.shadowRoot.appendChild(this.container);

        this.container.onmouseenter = () => { this.isHovered = true;  };
        // mousemove bubbles up from the canvas and every child, so hover stays
        // correct even when onmouseenter was missed (panel shown under the
        // cursor) — otherwise hotkeys silently die while over the canvas.
        this.container.onmousemove  = () => { if (!this.isHovered) this.isHovered = true; };
        this.container.onmouseleave = () => { this.isHovered = false; };
        // Capture phase: ComfyUI's global keybinding handler also sits on window,
        // in the bubble phase and registered earlier, so this is the only place a
        // hotkey the viewer claims can be stopped before ComfyUI acts on it too.
        window.addEventListener('keydown', (e) => this.handleKeyDown(e), true);
        window.addEventListener('keyup', (e) => this.handleKeyUp(e));

        this._cacheElements();
        this._applyStartupViewerPrefs();   // Settings → ComfyUI Image Viewer
        this._initParamsPanel();
        this._initHistoryPanel();
        this._initToolbarButtons();
        // Guarded: the browser panel is a side feature, and nothing about it is
        // worth taking the whole viewer down for if a future edit throws here.
        try { this._initFileBrowser(); }   // needs the toolbar button it toggles from
        catch (e) { console.warn('imageViewer: file browser failed to start', e); }
        // Last: it adopts all three panels into rails, so they must exist first.
        try { this._initAgentPanel(); }   // the agentY chat panel's slot, before the dock adopts it
        catch (e) { console.warn('imageViewer: agentY panel failed to start', e); }
        try { this._initDock(); }
        catch (e) { console.warn('imageViewer: docking failed to start', e); }
        this._applyIconSkin();          // inject inline SVGs from the JSON skin

        await this.loadFactoryDefault();
        await this.loadLayouts();
        this.applyFactoryDefault();
        // After the floating layout is in place: docking remembers it to go back to.
        try { this._initPageDock(); }
        catch (e) { console.warn('imageViewer: page docking failed to start', e); }
        // Layout menu population can mutate nearby controls in some browsers,
        // so re-assert icon skin once layouts are ready.
        this._applyIconSkin();

        this._bindToolbarHandlers();
        try { this._initFullscreen(); }
        catch (e) { console.warn('imageViewer: full screen failed to start', e); }

        this.setupZoomAndPan();
        this.setupResizing();
        this.setupCompareSlider();
        this.setupPanelDragging();
        this.setupTimelineEvents();
        this._initTools();
        this.setupExplorerDrop();      // OS files → viewport
        this.setupGraphDropTarget();   // history thumb → ComfyUI graph
        this.setupTimelineFrameDrag(); // shift-drag the frame on screen → graph

        this.currentParamNodeId  = null;
        this.currentHistoryKey   = null;
        this.currentHistoryIndex = null;
        this.historyCompare      = null;
        try { this.restoreViewerState(); }
        finally { this._viewerStateRestored = true; }   // from here on saves are safe
        this.startParamMonitor();
        this._initReconnect();
        this._editTlListenTakes();      // agentY's new versions of shots come in as takes (imageViewer_editTakes.js)
    }

    //  Element reference cache 
    _cacheElements() {
        const sr = this.shadowRoot;
        this.imgBase          = sr.getElementById('img-base');
        this.imgCompare       = sr.getElementById('img-compare');
        this.videoBase        = sr.getElementById('video-base');
        this.videoCompare     = sr.getElementById('video-compare');
        this.imgFrame         = sr.getElementById('img-frame');
        this.contactContainer = sr.getElementById('contact-container');
        this.slider           = sr.getElementById('compare-slider');
        this.timeline         = sr.getElementById('timeline');
        this.playBtn          = sr.getElementById('play');
        this.viewport         = sr.getElementById('viewport');
        this.rotateBtn        = sr.getElementById('rotate-btn');
        this.tabBar           = sr.getElementById('tab-bar');
        this.tabsContainer    = sr.getElementById('tabs-container');
        this.closeBtn         = sr.getElementById('close-panel-btn');
        this.overlaysBtn      = sr.getElementById('overlays-btn');
        this.shapeOverlay     = sr.getElementById('shape-overlay');
        this.layoutSel        = sr.getElementById('layout-sel');
        this.refreshBtn       = sr.getElementById('refresh');
        this.helpBtn          = sr.getElementById('help-btn');
        this.helpOverlay      = sr.getElementById('hotkey-help');
        this.exposureControl  = sr.getElementById('exposure-control');
        this.exposureSlider   = sr.getElementById('exposure-slider');
        this.exposureValue    = sr.getElementById('exposure-value');
        this.rgbChannelSel    = sr.getElementById('rgb-channel-sel');
        this.colorInSel       = sr.getElementById('color-in-sel');
        this.previzPanel      = sr.getElementById('previz-panel');
        this.totalFrameEl     = sr.getElementById('total-f');
        this.curvesPanel      = sr.getElementById('curves-panel');
        // The Roto Curves panel came later still; made beside the Animation
        // Curves when a cached older markup lacks it, like the Channel Box below.
        this.rotoCurvesPanel  = sr.getElementById('roto-curves-panel');
        // A cached markup from the release that gave the drawing tools a dock
        // panel of their own; they live in the Parameters panel now.
        sr.getElementById('tool-dock-panel')?.remove();
        // Parameter Curves (keyed node parameters), made here too for an older markup.
        this.paramCurvesPanel = sr.getElementById('param-curves-panel');
        if (!this.paramCurvesPanel && this.curvesPanel && this.curvesPanel.parentNode) {
            const pc = this.curvesPanel.ownerDocument.createElement('div');
            pc.id = 'param-curves-panel';
            pc.className = 'curves-panel right';
            this.curvesPanel.parentNode.insertBefore(pc, this.curvesPanel.nextSibling);
            this.paramCurvesPanel = pc;
        }
        // The Edit panel (the cut beside a film) is always made here: no markup carries it.
        this.editTimelinePanel = sr.getElementById('edit-timeline-panel');
        if (!this.editTimelinePanel && this.curvesPanel && this.curvesPanel.parentNode) {
            const ep = this.curvesPanel.ownerDocument.createElement('div');
            ep.id = 'edit-timeline-panel';
            ep.className = 'curves-panel edit-panel';
            this.curvesPanel.parentNode.insertBefore(ep, this.curvesPanel.nextSibling);
            this.editTimelinePanel = ep;
        }
        // Its two companions (imageViewer_editPanels.js), made the same way.
        for (const [prop, id] of [["editInspectorPanel", "edit-inspector-panel"], ["editEffectsPanel", "edit-effects-panel"]]) {
            this[prop] = sr.getElementById(id);
            if (!this[prop] && this.curvesPanel && this.curvesPanel.parentNode) {
                const panel = this.curvesPanel.ownerDocument.createElement('div');
                panel.id = id;
                panel.className = 'curves-panel edit-side-panel right';
                this.curvesPanel.parentNode.insertBefore(panel, this.curvesPanel.nextSibling);
                this[prop] = panel;
            }
        }
        if (!this.rotoCurvesPanel && this.curvesPanel && this.curvesPanel.parentNode) {
            const rc = this.curvesPanel.ownerDocument.createElement('div');
            rc.id = 'roto-curves-panel';
            rc.className = 'curves-panel right';
            this.curvesPanel.parentNode.insertBefore(rc, this.curvesPanel.nextSibling);
            this.rotoCurvesPanel = rc;
        }
        // (Agent code and Dataset are tabs of the main canvas now - imageViewer_viewTabs.js - not panels.)
        // Motion (imageViewer_mgPanel.js): a scene is a TAB; its properties and timeline (with the layer list)
        // are these two dock panels, each holding one part of the tab's editor (a .mg-slot the glue fills).
        for (const [id, prop, cls] of [['motionProps', 'motionPropsPanel', 'motion-props'],
                                       ['motionTimeline', 'motionTimelinePanel', 'motion-timeline']]) {
            let mp = sr.getElementById(`${id}-panel`);
            if (!mp && this.curvesPanel && this.curvesPanel.parentNode) {
                const doc = this.curvesPanel.ownerDocument;
                mp = doc.createElement('div');
                mp.id = `${id}-panel`;
                mp.className = `curves-panel motion-part-panel ${cls} right`;
                const slot = doc.createElement('div');
                slot.className = 'mg-slot';
                mp.appendChild(slot);
                this.curvesPanel.parentNode.insertBefore(mp, this.curvesPanel.nextSibling);
            }
            this[prop] = mp;
        }
        // Paint (imageViewer_paintPanel.js): a picture is a TAB; its Layers and Properties are these
        // two dock panels, each holding one part of the tab's editor (a .paint-slot the glue fills).
        for (const [id, prop, cls] of [['paintLayers', 'paintLayersPanel', 'paint-layers'],
                                       ['paintProps', 'paintPropsPanel', 'paint-props-panel'],
                                       ['paintHistory', 'paintHistoryPanel', 'paint-history-panel']]) {
            let pp = sr.getElementById(`${id}-panel`);
            if (!pp && this.curvesPanel && this.curvesPanel.parentNode) {
                const doc = this.curvesPanel.ownerDocument;
                pp = doc.createElement('div');
                pp.id = `${id}-panel`;
                pp.className = `curves-panel paint-part-panel ${cls} right`;
                const slot = doc.createElement('div');
                slot.className = 'paint-slot';
                pp.appendChild(slot);
                this.curvesPanel.parentNode.insertBefore(pp, this.curvesPanel.nextSibling);
            }
            this[prop] = pp;
        }
        // The Channel Box came after the others; a cached older markup lacks
        // it, so it is made here beside the Outliner rather than going missing.
        this.channelsPanel    = sr.getElementById('channels-panel');
        if (!this.channelsPanel && this.previzPanel && this.previzPanel.parentNode) {
            const cb = this.previzPanel.ownerDocument.createElement('div');
            cb.id = 'channels-panel';
            cb.className = 'previz-panel channels-panel right';
            this.previzPanel.parentNode.insertBefore(cb, this.previzPanel.nextSibling);
            this.channelsPanel = cb;
        }
    }

    /** Set inline SVG icon on an element from the loaded skin. */
    _setIcon(el, iconKey) {
        if (!el || !this._iconSkin) return;
        const svg = this._iconSkin[iconKey];
        if (svg) el.innerHTML = svg;
    }

    /** Inject SVG icons into all .sprite-icon buttons based on ICON_MAP. */
    _applyIconSkin() {
        const sr = this.shadowRoot;
        for (const [id, iconKey] of Object.entries(ICON_MAP)) {
            const el = sr.getElementById(id);
            if (el) this._setIcon(el, iconKey);
        }
    }

    _syncHistoryToggleState() {
        if (!this.historyToggleBtn) return;
        this.historyToggleBtn.classList.toggle('active', this.isPanelDocked('history'));
    }

    //  Parameters panel bootstrap 
    _initParamsPanel() {
        const sr = this.shadowRoot;

        this.paramsPanel = sr.getElementById('params-panel');

        if (!this.paramsPanel) {
            const mainArea     = document.createElement("div");
            mainArea.className = "main-area";
            if (this.viewport && this.viewport.parentNode) {
                this.viewport.parentNode.insertBefore(mainArea, this.viewport);
                mainArea.appendChild(this.viewport);
            }
            this.paramsPanel              = document.createElement("div");
            this.paramsPanel.id           = "params-panel";
            this.paramsPanel.className    = "params-panel right";
            this.paramsPanel.innerHTML    = `
                <div class="params-header">
                    <span id="params-title">No Node Selected</span>
                    <button id="params-lock-btn" title="Lock  freeze to currently selected node"></button>
                </div>
                <div id="params-content" class="params-content"></div>
            `;
            mainArea.appendChild(this.paramsPanel);
        }

        // Robustness: ensure required child elements exist in cached HTML
        if (!this.paramsPanel.classList.contains('right') && !this.paramsPanel.classList.contains('left')) {
            this.paramsPanel.classList.add('right');
        }
        const pq = (id) => this.paramsPanel.querySelector(`#${id}`);
        const header = this.paramsPanel.querySelector('.params-header');
        if (header && !header.querySelector('#params-lock-btn')) {
            const b = document.createElement('button'); b.id = 'params-lock-btn'; b.title = 'Lock  freeze to currently selected node'; b.textContent = '';
            header.appendChild(b);
        }

        this.paramsContent  = sr.getElementById('params-content')  || pq('params-content');
        this.paramsTitle    = sr.getElementById('params-title')     || pq('params-title');
        this.paramsLockBtn  = sr.getElementById('params-lock-btn')  || pq('params-lock-btn');

        this.paramsBtn = sr.getElementById('params-btn');
        if (!this.paramsBtn) {
            this.paramsBtn           = document.createElement("button");
            this.paramsBtn.id        = "params-btn";
            this.paramsBtn.innerText = "";
            this.paramsBtn.title     = "Toggle Parameters Panel";
            const histBtn = sr.getElementById('history-toggle-btn');
            if (histBtn && histBtn.parentNode) histBtn.parentNode.insertBefore(this.paramsBtn, histBtn.nextSibling);
            else if (this.refreshBtn && this.refreshBtn.parentNode) this.refreshBtn.parentNode.insertBefore(this.paramsBtn, this.refreshBtn);
        }

        this.paramsPanel.style.display = "none";
        this.paramsBtn.style.color     = "#eee";

        if (this.paramsLockBtn) this.paramsLockBtn.onclick = () => {
            this.toggleParamsLock();
            this.paramsLockBtn.classList.toggle('locked', this.paramsLocked);
        };

        this.paramsBtn.onclick = () => {
            if (!this.paramsPanel) return;
            // The button's own state and filling the panel in are both handled
            // by applyDockLayout (_syncPanelToggleButtons / _onPanelShown).
            this.togglePanelDocked('params');
        };
    }

    //  History panel bootstrap 
    _initHistoryPanel() {
        const sr = this.shadowRoot;

        this.historyStrip   = sr.getElementById('history-strip');
        this.historyClearBtn = sr.getElementById('history-clear-btn');
        this.historyPanel   = sr.getElementById('history-panel');
        this.historyLimitInput = sr.getElementById('history-limit-input');

        if (this.historyLimit == null) this.historyLimit = HISTORY_LIMIT_DEFAULT;
        if (this.historyLimitInput) {
            this._syncHistoryLimitInput();
            // Committed on Enter, blur or the spinner — not per keystroke, or
            // typing "35" would pass through 3 and throw history away.
            this.historyLimitInput.addEventListener('change', () =>
                this.setHistoryLimit(this.historyLimitInput.value));
            // The panel's own click handler leaves compare mode — the "Keep"
            // text is part of the control too — and ComfyUI's key handler on
            // window would take Backspace or Delete as "delete the selected
            // nodes", since from outside the shadow root no input is focused.
            const control = this.historyLimitInput.closest('.history-limit') || this.historyLimitInput;
            for (const type of ['click', 'mousedown']) {
                control.addEventListener(type, (ev) => ev.stopPropagation());
            }
            for (const type of ['keydown', 'keyup']) {
                this.historyLimitInput.addEventListener(type, (ev) => ev.stopPropagation());
            }
        }

        // Placement is the dock mixin's business now — see applyDockLayout.
        if (this.historyPanel) this.historyPanel.style.display = 'none';

        if (this.historyClearBtn) {
            this.historyClearBtn.disabled = true;
            // Sits in the flow at the foot of the panel. It used to be pinned
            // over the top of the strip with the panel reserving 48px of padding
            // for it, which the title bar now occupies.
            Object.assign(this.historyClearBtn.style, {
                flex: '1 1 auto', minWidth: '40px',
                background: 'rgba(30,30,30,0.9)', color: '#fff', border: '1px solid #444',
                padding: '6px', textAlign: 'center', cursor: 'pointer',
            });
            this.historyClearBtn.addEventListener('click', (ev) => ev.stopPropagation());
            this.historyClearBtn.onclick = () => {
                const dlgWin = this.historyClearBtn.ownerDocument?.defaultView || window;
                // A tag filter on: only what it shows goes (HistoryTagsMixin).
                if (this.clearHistoryFiltered && this.clearHistoryFiltered(dlgWin)) return;
                // One history for every tab: Clear clears all of it.
                const n = ((this.history || {})[HISTORY_KEY] || []).length;
                if (!n) return;
                if (!dlgWin.confirm(`Clear the whole history (${n} snapshot${n === 1 ? '' : 's'}, every tab's)?`)) return;
                // What a tab shows from an older snapshot goes back to its own picture first.
                if (this.isViewingHistory && this.restoreHistoryView) this.restoreHistoryView();
                this.history = {};
                this.previewBackup       = null;
                this.isViewingHistory    = false;
                this._historyPanelSig    = null;
                this.clearHistorySelection?.();
                if (this.historyStrip)   this.historyStrip.innerHTML = '';
                // Keep the history panel open after clearing — just refresh its (now empty) strip.
                if (this.renderHistoryPanel) this.renderHistoryPanel();
                this._syncHistoryToggleState();
                if (this.historyClearBtn) this.historyClearBtn.disabled = true;
                this.currentHistoryKey   = null;
                this.currentHistoryIndex = null;
                this.queuePersistViewerState();
            };
        }

        this.historyToggleBtn = sr.getElementById('history-toggle-btn');
        if (this.historyToggleBtn) {
            // Rendering the strip on the way in is _onPanelShown's job (mixinDock).
            this.historyToggleBtn.onclick = () => this.togglePanelDocked('history');
        }

        this._syncHistoryToggleState();

        if (this.historyPanel) {
            this.historyPanel.addEventListener('click', (e) => {
                if (this.historyCompare) { this.exitHistoryCompare(); return; }
                if (this.isComparing)    { this.toggleCompare(); return; }
                if (!this.isViewingHistory) return;
                if (e.target && e.target.closest &&
                    (e.target.closest('.history-thumb') || e.target.closest('.history-path') || e.target.closest('.history-thumb-wrapper'))) return;
                this.jumpToLatestVisibleHistory();
            });
        }

    }

    //  Toolbar: dynamic button creation 
    _initToolbarButtons() {
        const sr = this.shadowRoot;

        this.undockBtn = sr.getElementById('undock-btn');
        if (!this.undockBtn) {
            this.undockBtn           = document.createElement("button");
            this.undockBtn.id        = "undock-btn";
            this.undockBtn.className = "sprite-icon";
            this.undockBtn.innerText = "";
            this.undockBtn.title     = "Undock to separate window";
            if (this.closeBtn) this.closeBtn.parentNode.insertBefore(this.undockBtn, this.closeBtn);
        }
        this.undockBtn.onclick = () => this.toggleUndock();

        // Open cut... lives on the Edit panel's bar (imageViewer_editOpen.js), not up here.
        sr.getElementById('open-cut-btn')?.remove();

        // Dock to the page / float (imageViewer_mixinPageDock.js). Made here, not
        // in the markup, like the buttons below: a cached copy of the markup from
        // before it existed would otherwise simply not have it.
        this.pageDockBtn = sr.getElementById('pagedock-btn');
        if (!this.pageDockBtn) {
            this.pageDockBtn           = document.createElement("button");
            this.pageDockBtn.id        = "pagedock-btn";
            this.pageDockBtn.className = "sprite-icon";
            this.pageDockBtn.innerText = "";
            this.undockBtn.parentNode.insertBefore(this.pageDockBtn, this.undockBtn);
        }
        this._setIcon(this.pageDockBtn, 'icon-dock-right');
        this.pageDockBtn.onclick = () => this.togglePageDock();

        this.rangeBtn           = document.createElement("button");
        this.rangeBtn.id        = "range-btn";
        this.rangeBtn.className = "sprite-icon";
        this.rangeBtn.title     = "Sync Input Range to Selection";
        this.rangeBtn.onclick   = () => { this.toggleInputRange(); };
        const sEndBtn = sr.getElementById('s-end');
        if (sEndBtn && sEndBtn.parentNode) sEndBtn.parentNode.insertBefore(this.rangeBtn, sEndBtn.nextSibling);
        else if (this.refreshBtn) this.refreshBtn.parentNode.insertBefore(this.rangeBtn, this.refreshBtn);

        this.browserToggleBtn           = document.createElement('button');
        this.browserToggleBtn.id        = 'browser-toggle-btn';
        this.browserToggleBtn.className = 'sprite-icon';
        this.browserToggleBtn.title     = 'Toggle File Browser';
        const clearCacheBtn = sr.getElementById('clear-cache-btn');
        if (clearCacheBtn && clearCacheBtn.parentNode) clearCacheBtn.parentNode.insertBefore(this.browserToggleBtn, clearCacheBtn);
        else if (this.historyToggleBtn && this.historyToggleBtn.parentNode) {
            this.historyToggleBtn.parentNode.insertBefore(this.browserToggleBtn, this.historyToggleBtn.nextSibling);
        }

        // layout-sel doesn't exist in HTML — create it as an invisible overlay
        // on top of the layout button so native dropdown behavior stays intact.
        const layoutBtn = sr.getElementById('layout-btn');
        if (layoutBtn) {
            layoutBtn.classList.add('sprite-icon');
            this._setIcon(layoutBtn, 'icon-layout');

            if (!sr.getElementById('layout-sel')) {
                const wrap = document.createElement('div');
                wrap.className = 'layout-picker-wrap';
                layoutBtn.parentNode.insertBefore(wrap, layoutBtn);
                wrap.appendChild(layoutBtn);

                const sel = document.createElement('select');
                sel.id = 'layout-sel';
                sel.title = 'Panel Layout';
                wrap.appendChild(sel);
                this.layoutSel = sel;
            } else {
                this.layoutSel = sr.getElementById('layout-sel');
            }
        }
    }

    //  Toolbar handler wiring 
    _bindToolbarHandlers() {
        const sr = this.shadowRoot;

        this.helpBtn.onclick      = () => this.toggleHelpOverlay(true);
        this.helpOverlay.onclick  = () => { this.helpOverlay.style.display = "none"; };

        if (this.layoutSel) this.layoutSel.onchange = async (e) => {
            const val = e.target.value;
            if      (val.startsWith("__dock__:")) this.setPageDock(val.slice(9));
            else if (val === "__store__")        this.storeCurrentLayout();
            else if (val === "__make_default__") this.storeFactoryDefault();
            else if (val === "__manage__")       this.openManagePanel();
            else                                 this.applyLayout(val);
            this.layoutSel.value = "";
            this.layoutSel.blur();
        };

        this._applyOverlays();
        this.playBtn.onclick      = () => {
            this.isPlaying ? this.stop() : this.play();
            this.playBtn.classList.toggle('playing', this.isPlaying);
        };
        sr.getElementById('s-start').onclick  = () => this.setFrame(this.getTimelineBounds().min);
        sr.getElementById('s-end').onclick    = () => this.setFrame(this.getTimelineBounds().max);
        sr.getElementById('s-prev').onclick   = () => this.step(-1);
        sr.getElementById('s-next').onclick   = () => this.step(1);
        sr.getElementById('fit-btn').onclick  = () => this.fitView();
        sr.getElementById('loop-sel').onchange = (e) => { this.loopMode = e.target.value; };
        this.refreshBtn.onclick   = () => { this.refreshBtn.classList.add('running'); app.queuePrompt(0); };
        this.bindClearButton();

        this.rotateBtn.onclick = () => this.cycleSliderMode();
        if (this.closeBtn) this.closeBtn.onclick = () => { this.style.display = 'none'; };
        this.overlaysBtn.onclick = () => this.toggleOverlays();

        // The last-frame box: a readout, except on a previz tab, where it is
        // how long the shot is (see previzSyncTimelineFields).
        const endEl = sr.getElementById('total-f');
        if (endEl && 'value' in endEl) {
            endEl.onchange = () => {
                if (!(this.isPrevizTab && this.isPrevizTab())) return;
                const last = Math.max(0, Math.round(Number(endEl.value) || 0));
                this.previzSetSceneField('length', last + 1);
                this.previzSyncTimelineFields();
            };
        }

        // A motion tab: the boxes are the scene's own length and frame rate (the viewer's bar is its transport).
        // On commit, not per keystroke: each is one undoable edit.
        if (endEl && 'value' in endEl) {
            endEl.addEventListener('change', () => {
                if (!this._mgOn || endEl.readOnly) return;
                this.mgSetComp({ duration: Math.max(0, Math.round(Number(endEl.value) || 0)) + 1 });
            });
        }
        sr.getElementById('fps-in').addEventListener('change', (e) => {
            if (this._mgOn) this.mgSetComp({ fps: Math.max(1, parseInt(e.target.value, 10) || 1) });
        });
        sr.getElementById('fps-in').oninput = (e) => {
            let val = parseInt(e.target.value);
            if (!val || val < 1) val = 1;
            this.fps = val;
            // On a previz tab this IS the shot's frame rate: what it plays at
            // is what it renders at and what a USD stage is written with.
            if (this.isPrevizTab && this.isPrevizTab()) this.previzSetSceneField('fps', val);
            if (this._videoMode) {
                // Re-time the <video> live (no restart needed) instead of driving
                // a frame interval.
                this._applyVideoPlaybackRate();
            } else if (this.isPlaying) {
                this.stop(); this.play();
            }
        };
        sr.getElementById('zoom-sel').onchange = (e) => {
            // "Fit" is relative to the viewport; the % presets are relative to the
            // media's actual pixel size (see setPixelZoom).
            if (e.target.value === "fit") this.fitView();
            else this.setPixelZoom(parseFloat(e.target.value));
            e.target.selectedIndex = 0;
        };
        this.timeline.oninput = (e) => { this.stop(); this.setFrame(parseInt(e.target.value)); };

        if (this.exposureSlider) {
            this.exposureSlider.oninput = (e) => this.setExposure(parseFloat(e.target.value));
            this.setExposure(parseFloat(this.exposureSlider.value || '0'));
        } else {
            this.applyExposure();
        }

        if (this.rgbChannelSel) {
            this.rgbChannelSel.onchange = (e) => this.setChannelView(e.target.value);
            this.setChannelView(this.rgbChannelSel.value || 'all');
        }
        this.initColor();

        if (this.exposureControl) {
            this.exposureControl.oncontextmenu = (e) => {
                e.preventDefault();
                this.resetExposure();
            };
            this.exposureControl.onmousedown = (e) => {
                if (e.button !== 0) return;
                if (e.target === this.exposureSlider) return;
                // A menu in the bar is being opened, not the exposure reset.
                if (e.target.closest && e.target.closest('select')) return;
                this.resetExposure();
            };
        }

        this.imgBase.onload = () => {
            if (!this.imgBase.naturalWidth && this.imgBase.src) return;
            if (this.zoom === 1.0 && this.panX === 0 && this.panY === 0) this.fitView();
            this.updateShapeInfo();
        };

        this.pathBar               = document.createElement('div');
        this.pathBar.className     = 'path-bar';
        this.pathBar.style.display = 'none';
        this.pathBar.addEventListener('mousedown', e => e.stopPropagation());
        this.viewport.appendChild(this.pathBar);
    }

    // 
    // Node registration + data ingestion
    // 

    registerNode(nodeId) {
        if (!this.container) return;
        if (!this.allTabs[nodeId]) this.allTabs[nodeId] = [];
        this.requestPanelOpen();
        this.scrapeNodeImages(nodeId);
        this.refreshTabs();
        if (!this.activeTab) this.switchTab(nodeId);
        this.queuePersistViewerState();
    }

    unregisterNode(nodeId) {
        if (!this.container) return;
        delete this.allTabs[nodeId];
        // The history keeps what the node made (one history for all tabs).
        if (this.activeTab === nodeId) {
            const keys = Object.keys(this.allTabs);
            if (keys.length > 0) this.switchTab(keys[0]);
            else { this.activeTab = null; this.imgBase.src = ""; this._updatePathBar(null); }
        }
        this.refreshTabs();
        this.queuePersistViewerState();
    }

    // Lightweight tab-bar rebuild used when nodes are added/removed without new data.
    refreshTabs() {
        if (!this.container) return;
        const allKeys = Object.keys(this.allTabs);
        const known   = this.tabOrder.filter(k => allKeys.includes(k));
        const added   = allKeys.filter(k => !known.includes(k));
        this.tabOrder = [...known, ...added];
        this._rebuildTabBar(null);
        this.updateTabHighlights();
        this.queuePersistViewerState();
    }

    scrapeNodeImages(nodeId) {
        const node = app.graph.getNodeById(nodeId);
        if (!node || !node.imgs || node.imgs.length === 0) return;
        const scrapped = [];
        node.imgs.forEach(imgObj => {
            try {
                const url    = new URL(imgObj.src, window.location.href);
                const params = new URLSearchParams(url.search);
                if (params.has("filename")) {
                    scrapped.push({
                        filename:  params.get("filename"),
                        subfolder: params.get("subfolder") || "",
                        type:      params.get("type") || "input",
                    });
                }
            } catch (e) { console.error("ImageViewer: Failed to parse image URL", imgObj.src); }
        });
        if (scrapped.length > 0) this.allTabs[nodeId] = scrapped;
    }

    /**
     * Whether a viewer update is a render for the Viewer tab, and under what
     * group: a Send to Viewer node's (its tab name, else what feeds it), or a
     * send naming a tab with no such node on the graph (an agent's workflow).
     * Roto, SAM3 and 3D Scene nodes keep tabs of their own. -> {key, group} | null:
     * `key` is the tab it would have had (folded in if it is still open).
     */
    _feedGroupFor(senderNode, data, key = "tab") {
        if (data.scene_data !== undefined) return null;
        const info = senderTabInfo(senderNode);
        const type = senderNode && senderNode.type;
        if (type === IMAGE_VIEWER_SCENE_NODE) return null;
        if (info && type === IMAGE_VIEWER_SEND_NODE) return { key: info.key, group: info.label };
        // A Roto / SAM3 node's picture too: its tool works on the Viewer tab,
        // on the node of the snapshot on screen (ToolsMixin._bindActiveTool).
        if (info && (type === IMAGE_VIEWER_ROTO_NODE || type === IMAGE_VIEWER_SAM3_NODE)) {
            const named = info.key.startsWith('send_label_');
            return { key: info.key, group: named ? info.label : `${type === IMAGE_VIEWER_ROTO_NODE ? 'Roto' : 'SAM3'}: ${info.label}` };
        }
        // A send whose node is not on the open graph (an agent running a
        // workflow of its own): its group is in its frames, else the name it
        // carries. A sender naming its own tab ("world:...") keeps it.
        if (data.tab_name || (!info && /^tab\d*$/.test(String(key)))) {
            const named = namedTabInfo(data.tab_name || "");
            return { key: named.key, group: data.tab_name ? named.label : "" };
        }
        return null;
    }

    /** Whether tab `key` is a Send to Viewer, Roto or SAM3 node's (a node of the open graph says so). */
    _isFeedNodeTabKey(key) {
        const k = String(key || "");
        if (!k.startsWith('send_')) return false;
        const feeds = [IMAGE_VIEWER_SEND_NODE, IMAGE_VIEWER_ROTO_NODE, IMAGE_VIEWER_SAM3_NODE];
        try {
            for (const n of (app.graph && app.graph.nodes) || []) {
                if (n && feeds.includes(n.type)) {
                    const info = senderTabInfo(n);
                    if (info && info.key === k) return true;
                }
            }
        } catch (_) { /* no graph yet */ }
        return false;
    }

    updateData(data, node) {
        if (!this.container || !data.tabs) return;

        this.viewerNode  = node || null;
        const senderNode = node || app.graph.getNodeById(data.unique_id);

        let openedKey = null;
        let fedViewer = false;
        Object.keys(data.tabs).forEach(k => {
            // What a Send to Viewer node or the agent sends is a group of the
            // one Viewer tab, named as its tab was (imageViewer_historyData.js
            // isFeedTabKey): no tab of its own. A tab it had before is folded in.
            const feed = this._feedGroupFor(senderNode, data, k);
            if (feed) {
                if (this.allTabs[feed.key]) this.foldTabsIntoViewer([feed.key]);
                const snap = Array.isArray(data.tabs[k]) ? data.tabs[k] : [];
                const shown = this.takeRenderInViewer(snap, {
                    group: feed.group, nodeId: senderNode && senderNode.id != null ? senderNode.id : null,
                    focus: !!(data.focus_tab || data.open),
                });
                if (shown) { openedKey = shown; fedViewer = true; }
                return;
            }
            let finalKey = k;
            // Every node that owns a tab — the send node and both tool nodes —
            // keys it the same way (see senderTabInfo): an explicit tab_name
            // groups them, an empty one gives the node a tab of its own.
            let info = senderTabInfo(senderNode);
            // A send that names its tab but whose node (if the open graph even has
            // one by that id) does not - an agent running a workflow of its own -
            // is filed by the name it carries, so all of its pictures share a tab.
            if (data.tab_name && (!info || info.key.startsWith('send_') && !info.key.startsWith('send_label_'))) {
                info = namedTabInfo(data.tab_name);
            }
            if (info) {
                finalKey = info.key;
                this.tabLabels[finalKey] = info.label;
                if (senderNode && !info.key.startsWith('named:')) this.tabSourceNodeIds[finalKey] = senderNode.id;
            }

            if (!this.tabSourceNodeIds[finalKey]) {
                if (k.startsWith('tab') && node && node.inputs) {
                    const inputIdx = parseInt(k.replace('tab', ''), 10) - 1;
                    const linkId = node.inputs[inputIdx]?.link;
                    const link = linkId != null ? app.graph.links[linkId] : null;
                    if (link && link.origin_id != null) this.tabSourceNodeIds[finalKey] = link.origin_id;
                    else if (node && node.id != null) this.tabSourceNodeIds[finalKey] = node.id;
                } else if (node && node.id != null) {
                    this.tabSourceNodeIds[finalKey] = node.id;
                }
            }

            openedKey = finalKey;
            // A previz node sends its scene with the tab, so opening a saved
            // workflow rebuilds the shot before anything has run.
            // A sender with no node on the graph (the worlds pack, an agent)
            // names its own tab.
            if (data.tab_label && !this.tabLabels[finalKey]) this.tabLabels[finalKey] = data.tab_label;
            if (data.scene_data !== undefined && this.previzAdoptSceneData) {
                // A previz node's tab is always a scene, even an empty one —
                // otherwise a fresh node would show nothing and there would be
                // no 3D view to switch previz on from. A world sent again
                // (`scene_replace`) is a new version: it replaces what's there.
                this.previzAdoptSceneData(finalKey, data.scene_data,
                                          { always: true, replace: !!data.scene_replace });
                if (data.scene_replace && this.activeTab === finalKey && this._model3d) {
                    this.previzChanged({ reload: true, persist: false });
                }
            }
            if (data.render_name) {
                if (!this._previzRenderNames) this._previzRenderNames = {};
                this._previzRenderNames[finalKey] = data.render_name;
            }

            // History push
            let didPrepend = false;
            try {
                didPrepend = this.pushHistorySnapshot(finalKey, data.tabs[k]);
            } catch (e) { console.warn('imageViewer history capture failed', e); }


            const keepPinnedSelection = (typeof this.isHistorySelectionPinned === 'function')
                ? this.isHistorySelectionPinned(finalKey)
                : false;

            // Merge incoming tab entries into any existing entries for this finalKey.
            try {
                const incoming = Array.isArray(data.tabs[k]) ? data.tabs[k] : [];
                if (!(keepPinnedSelection && this.activeTab === finalKey)) {
                    this.allTabs[finalKey] = incoming.slice();
                }
            } catch (e) {
                if (!(keepPinnedSelection && this.activeTab === finalKey)) {
                    this.allTabs[finalKey] = Array.isArray(data.tabs[k]) ? data.tabs[k].slice() : [];
                }
            }

            if (!keepPinnedSelection && this.activeTab === finalKey) {
                this.currentHistoryKey = HISTORY_KEY;
                this.currentHistoryIndex = 0;
                this.isViewingHistory = false;
                this.previewBackup = null;
                this.historyCompare = null;
            }
        });

        // Remove stale keys. User-opened tabs (Open Folder, dropped files,
        // "Send to Image Viewer") aren't backed by a node in the graph, so they
        // are user-managed and never auto-removed.
        const expected = new Set();
        app.graph.nodes.forEach(n => {
            if (isViewerSourceNode(n)) {
                const info = senderTabInfo(n);
                if (info) expected.add(info.key);
            }
            if (n.type === 'imageViewer') {
                n.inputs.forEach((inp, idx) => { if (inp.link) expected.add(`tab${idx + 1}`); });
            }
        });
        // A Send to Viewer node's tab left from before (restored before the
        // graph was there to say whose it was) is a group of the Viewer tab.
        const leftover = Object.keys(this.allTabs).filter((k) => this._isFeedNodeTabKey(k));
        if (leftover.length) this.foldTabsIntoViewer(leftover);
        Object.keys(this.allTabs).forEach(existingKey => {
            if (USER_TAB_PREFIXES.some(p => existingKey.startsWith(p))) return;
            if (!expected.has(existingKey) && !(data.tabs && Object.values(data.tabs).some(arr => arr === this.allTabs[existingKey]))) {
                delete this.allTabs[existingKey];
                delete this.tabLabels[existingKey];
                delete this.tabSourceNodeIds[existingKey];
            }
        });

        // Maintain ordered tab list
        {
            const allKeys = Object.keys(this.allTabs);
            const known   = this.tabOrder.filter(k => allKeys.includes(k));
            const added   = allKeys.filter(k => !known.includes(k));
            this.tabOrder = [...known, ...added];
        }

        this._rebuildTabBar(node);
        // A world opened for the user to look at comes to the front.
        if (data.focus_tab && !fedViewer) {
            const key = Object.keys(data.tabs).find((k) => this.allTabs[k]);
            if (key && key !== this.activeTab) {
                if (this.isComparing) this.toggleCompare();
                this.switchTab(key);
                this.updateTabHighlights();
            }
        }

        this._historyPanelSig = null;
        this.requestPanelOpen();
        this.renderHistoryPanel();
        this.queuePersistViewerState();
        // An agent asked to have this shown (POST /imageviewer/push with focus / panel).
        if (data.open && openedKey && this.agentOpenRequest) {
            this.agentOpenRequest(data.open, openedKey).catch((e) => console.warn("imageViewer: open request failed", e));
        }
    }

    // Build the tab-bar DOM from this.tabOrder.
    // Called by updateData, refreshTabs, and whatever opens files off disk.
    _rebuildTabBar(node) {
        const container = this.tabsContainer || this.tabBar;
        if (!container) return;
        container.innerHTML = "";

        const frag = document.createDocumentFragment();

        this.tabOrder.forEach(k => {
            const btn = this._makeTabButton(k, this._resolveTabLabel(k, node));
            btn.classList.toggle('active', this.activeTab === k);

            btn.onclick = (ev) => {
                if (this.historyCompare) this.exitHistoryCompare();

                if (ev.shiftKey) {
                    if (this.isComparing && this.compareTab === k) {
                        this.toggleCompare();
                        this.updateTabHighlights();
                        return;
                    }
                    if (this.activeTab && this.activeTab !== k) {
                        this.compareTab = k;
                        if (!this.isComparing) {
                            this.toggleCompare();          // ends in setFrame + updateTransform
                        } else {
                            // Already comparing: only the compare source changed, so
                            // zoom/pan are untouched and updateTransform would skip
                            // its no-op signature. Re-derive the compare layer's own
                            // scale/clip against the new media explicitly, the same
                            // way enterHistoryCompare does — without this the second
                            // tab keeps the scale computed for the previous one.
                            this.setFrame(this.currentFrame);
                            this._syncCompareLayout();
                            this._scheduleCompareSync();
                        }
                        this.updateTabHighlights();
                        return;
                    }
                }

                if (this.isComparing) this.toggleCompare();
                this.switchTab(k);
                this.updateTabHighlights();
            };

            const closeX       = document.createElement('span');
            closeX.className   = 'tab-close';
            closeX.title       = 'Close tab';
            this._setIcon(closeX, 'icon-close');
            closeX.onclick     = (e) => { e.stopPropagation(); this.closeTab(k); };
            btn.appendChild(closeX);

            frag.appendChild(btn);
        });

        container.appendChild(frag);

        if (!this.activeTab || !this.allTabs[this.activeTab]) {
            if (this.tabOrder.length > 0) this.switchTab(this.tabOrder[0]);
        } else {
            this.switchTab(this.activeTab);
        }
        this.updateTabHighlights();

        // Keep the "Send to Viewer" nodes tinted to match their tab color even
        // after nodes are (re)added or state is restored on a fresh graph.
        if (this.tabColors && typeof this._applyColorToTabNodes === 'function') {
            Object.keys(this.tabColors).forEach(k => this._applyColorToTabNodes(k, this.tabColors[k]));
        }
    }

    _resolveTabLabel(k, node) {
        if (this.tabLabels[k]) return this.tabLabels[k];
        if (k.startsWith("tab")) {
            let label = k.replace("tab", "Input ");
            if (node) {
                const inputIdx = parseInt(k.replace("tab", "")) - 1;
                const link     = node.inputs[inputIdx]?.link;
                if (link) {
                    const originNode = app.graph.getNodeById(app.graph.links[link].origin_id);
                    if (originNode) label = originNode.title || originNode.type;
                }
            }
            return label;
        }
        const n = app.graph.getNodeById(k);
        return n ? (n.title || n.type) : `Node ${k}`;
    }
}

// 
// Apply all mixins onto the prototype
// 
Object.assign(
    ViewerPanel.prototype,
    LayoutMixin,
    HistoryMixin,
    PlaybackMixin,
    ParamsMixin,
    UIMixin,
    ColorMixin,
    ToolsMixin,
    RotoMixin,
    AnnotateMixin,
    AnnotateVideoMixin,
    DnDMixin,
    BrowserMixin,
    DockMixin,
    PageDockMixin,
    SendFromNodeMixin,
    ReconnectMixin,
    ModelMixin,
    PrevizMixin,
    PrevizCurvesMixin,
    RotoCurvesMixin,
    HistoryTagsMixin,
    AgentYMixin,
    AgentStateMixin,
    ContactGridMixin,
    AgentPanelMixin,
    ParamAnimMixin,
    ParamCurvesMixin,
    ViewTabsMixin,
    CodePanelMixin,
    DepsPanelMixin,
    MgPanelMixin,
    PaintPanelMixin,
    LoraPanelMixin,
    PrevizChannelsMixin,
    PrevizRenderMixin,
    PrevizShotMixin,
    PrevizAtlasMixin,
    PrevizUndoMixin,
    EditTimelineMixin,
    EditPlayMixin,
    EditPanelsMixin,
    EditMediaMixin,
    EditKeysMixin,
    EditAutoMixin,
    EditTakesMixin,
    EditResolveMixin,
    EditTrimMixin,
    EditAudioMixin,
    EditProxyMixin,
    AudioViewMixin,
    EditTwoUpMixin,
    EditPasteMixin,
    EditDialogsMixin,
    EditOpenMixin,
    EditXfadeMixin,
    EditVolLineMixin,
    EditSectionsMixin,
    EditAfxPlayMixin,
    EditAfxMixin,
    BarGroupsMixin,
    ExportViewMixin,
    FullscreenMixin,
    PrevizWorldMixin,
    PrefsMixin,
);

if (!customElements.get("comfyui-image-viewer-panel")) {
    customElements.define("comfyui-image-viewer-panel", ViewerPanel);
}

export function mountStandaloneViewer(target = document.body) {
    if (!target) return null;
    let panel = target.querySelector("comfyui-image-viewer-panel") || document.querySelector("comfyui-image-viewer-panel");
    if (!panel) {
        panel = document.createElement("comfyui-image-viewer-panel");
        target.appendChild(panel);
    }
    panel.setViewerToggleState(true, { syncDisplay: true });
    return panel;
}

function _isViewerOnlyMode() {
    try {
        const sp = new URLSearchParams(window.location.search || "");
        return sp.has("image_viewer_only") || sp.has("bepic_viewer_only");   // the old name, from a bookmark
    } catch (e) {
        return false;
    }
}

function _applyViewerOnlyMode(panel) {
    if (!panel) return;
    const styleId = "comfyui-image-viewer-only-style";
    if (!document.getElementById(styleId)) {
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = `
            body.comfyui-image-viewer-only > *:not(comfyui-image-viewer-panel) {
                display: none !important;
            }
            body.comfyui-image-viewer-only comfyui-image-viewer-panel {
                position: fixed !important;
                inset: 0 !important;
                display: flex !important;
                width: 100vw !important;
                height: 100vh !important;
                z-index: 2147483647 !important;
                margin: 0 !important;
            }
        `;
        document.head.appendChild(style);
    }

    document.body.classList.add("comfyui-image-viewer-only");
    panel.style.display = "flex";
    // Read by viewerState() (imageViewer_agentState.js), which reads no DOM.
    panel._viewerOnly = true;
}

// 
// ComfyUI extension registration
// 
try {
app.registerExtension({
    name: "ComfyUI.ImageViewer",
    // Settings → ComfyUI Image Viewer: the defaults, and the folders the viewer may open.
    settings: viewerSettings(() => globalViewerPanel),
    commands: [
        {
            id:    "ImageViewer.toggleViewer",
            label: "Toggle ComfyUI Image Viewer",
            function: () => {
                _toggleViewerPanelFromUi();
            },
        },
        // The right-click "Send to Image Viewer" entry, reachable from the
        // keyboard. No default combo — it is listed in Settings → Keybinding for
        // the user to assign, since every unmodified key is already spoken for.
        {
            id:    "ImageViewer.sendSelectionToViewer",
            label: "ComfyUI Image Viewer: Send Selected Node To Image Viewer (runs the branch when needed)",
            function: () => sendSelectionToViewer({
                getPanel:  () => globalViewerPanel,
                showPanel: () => _setViewerPanelToggle(true, { syncDisplay: true }),
            }),
        },
        // One command per viewer hotkey, which is what puts them in
        // Settings → Keybinding for rebinding. They act on the visible panel, so
        // a combo assigned there also works with the cursor off the viewer.
        ...viewerCommands(_activeViewerPanel),
    ],
    keybindings: viewerKeybindings(),
    menuCommands: [
        { path: ["Extensions", "ComfyUI Image Viewer"],
          commands: ["ImageViewer.toggleViewer", "ImageViewer.sendSelectionToViewer"] },
    ],
    actionBarButtons: [
        {
            icon:    "pi pi-eye",
            label:   "Image Viewer",          // short: the action bar is narrow
            tooltip: "Toggle ComfyUI Image Viewer",
            onClick: () => {
                _toggleViewerPanelFromUi();
            },
        },
    ],

    // A workflow saved while the viewer was "bEpic" names its nodes by the old
    // ids: they load as the nodes they are now.
    beforeConfigureGraph(graphData) {
        try { renameLegacyNodes(graphData); } catch (e) {}
    },

    async setup() {
        // Settings saved under "bEpic.Viewer.*" become "ImageViewer.*" (once).
        try { await migrateSettings(app.extensionManager?.setting, Object.values(PREF)); }
        catch (e) { console.warn("imageViewer: old settings not carried over", e); }
        // Before the panel exists: it reads its defaults as it is built.
        try { await applyStartupPrefs(); }
        catch (e) { console.warn("imageViewer: settings failed to load", e); }
        globalViewerPanel = document.createElement("comfyui-image-viewer-panel");
        document.body.appendChild(globalViewerPanel);
        _setViewerPanelToggle(false, { syncDisplay: true });
        _updateActionBarButtonState();
        window.imageViewerApi = Object.assign(window.imageViewerApi || {}, {
            show: () => _setViewerPanelToggle(true, { syncDisplay: true }),
            // What the user picked in the history strip, for agentY (imageViewer_historySelection.js).
            historySelection: () => globalViewerPanel?.agentHistorySelection?.() || null,
            // What the viewer is showing (tab, item, frame, range, compare, view) and the
            // Annotation tool's marks on it, for agentY (imageViewer_viewerState.js).
            viewerState: () => globalViewerPanel?.agentViewerState?.() || null,
            annotations: (opts) => globalViewerPanel?.agentViewerAnnotations?.(opts || {}) || null,
            // Show the history item that is this file, for agentY's Manage tags page.
            showPath: (path) => !!globalViewerPanel?.agentShowPath?.(path),
        });
        // A reload takes back the popout the previous page left open, so the
        // toolbar button has to show the viewer as on again.
        globalViewerPanel.addEventListener("imageviewer-popout-adopted", () => {
            _setViewerPanelToggle(true, { syncDisplay: false });
        });

        if (_isViewerOnlyMode()) {
            _applyViewerOnlyMode(globalViewerPanel);
            _setViewerPanelToggle(true, { syncDisplay: false });
            _updateActionBarButtonState();
        }

        api.addEventListener("executed", (e) => {
            if (globalViewerPanel && globalViewerPanel.refreshBtn) {
                globalViewerPanel.refreshBtn.classList.remove('running');
            }
            if (!e.detail || !e.detail.node) return;
            const nodeId = e.detail.node.toString();
            if (watchedNodeIds.has(nodeId) && e.detail.output && e.detail.output.images) {
                globalViewerPanel.updateNodeImages(nodeId, e.detail.output.images);
            }
        });

        // The worlds pack asks (for an agent) to match a world to its reference.
        api.addEventListener("imageviewer.world.calibrate", (e) => {
            const name = e.detail && e.detail.name;
            if (name && globalViewerPanel.previzMatchWorld) globalViewerPanel.previzMatchWorld(name);
        });

        // A previz shot an agent asked for (previz_shot.py): render it and report back.
        api.addEventListener("imageviewer.previz.render", (e) => {
            try { globalViewerPanel?.previzShotRun?.(e.detail); }
            catch (err) { console.warn("imageViewer: previz shot not run", err); }
        });

        // Code the agent produced (viewer_code.py): the Agent code panel's feed.
        api.addEventListener("imageviewer.code.update", (e) => {
            try { globalViewerPanel?.codePanelReceive?.(e.detail); }
            catch (err) { console.warn("imageViewer: agent code not shown", err); }
        });

        // An agent opened a motion-graphics scene (POST /imageviewer/push with a .mgscene.json).
        api.addEventListener("imageviewer.mg.open", (e) => {
            try {
                const bridge = window.imageViewerApi || {};
                try { if (bridge.show) bridge.show(); } catch (_) { /* already up */ }
                if (e.detail && e.detail.path) globalViewerPanel?.mgOpenFile?.(e.detail.path);
            } catch (err) { console.warn("imageViewer: motion scene not opened", err); }
        });

        // An agent opened a picture in Paint (POST /imageviewer/push with an .ora / .psd, or panel "paint").
        api.addEventListener("imageviewer.paint.open", (e) => {
            try {
                const bridge = window.imageViewerApi || {};
                try { if (bridge.show) bridge.show(); } catch (_) { /* already up */ }
                if (e.detail && e.detail.path) globalViewerPanel?.paintOpen?.(e.detail.path);
            } catch (err) { console.warn("imageViewer: picture not opened in Paint", err); }
        });
        // (The agent changing a picture, "imageviewer.paint.changed", is listened to by each panel: PaintPanelMixin._paintState.)

        // An agent opened a LoRA dataset (POST /imageviewer/push with its manifest.json).
        api.addEventListener("imageviewer.lora.open", (e) => {
            try {
                const bridge = window.imageViewerApi || {};
                try { if (bridge.show) bridge.show(); } catch (_) { /* already up */ }
                if (e.detail && e.detail.path) globalViewerPanel?.loraOpen?.(e.detail.path);
            } catch (err) { console.warn("imageViewer: lora dataset not opened", err); }
        });

        // An agent opened a cut with no film beside it (POST /imageviewer/push with an .otio): its tab and the Edit panel.
        api.addEventListener("imageviewer.edit.open", (e) => {
            try {
                const bridge = window.imageViewerApi || {};
                try { if (bridge.show) bridge.show(); } catch (_) { /* already up */ }
                if (e.detail && e.detail.path) globalViewerPanel?.editTlOpenPath?.(e.detail.path);
            } catch (err) { console.warn("imageViewer: cut not opened", err); }
        });

        api.addEventListener("imageviewer.viewer.update", (e) => {
            // "Send to Image Viewer (run branch)" queues a prompt with its own
            // throwaway sink node. That sink has no counterpart in the graph, so
            // it is routed to its originating node's tab instead of the normal
            // node-mirroring path.
            if (globalViewerPanel.consumeInlineSend?.(e.detail)) return;
            const node = app.graph.getNodeById(e.detail.unique_id);
            globalViewerPanel.updateData(e.detail, node);
        });
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === "imageViewer") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                onNodeCreated?.apply(this, arguments);
                this.addWidget("button", "Add Image Input",   null, () => { this.addInput(`images_${this.inputs.length + 1}`, "IMAGE"); });
                this.addWidget("button", "Remove Last Input", null, () => { if (this.inputs.length > 1) this.removeInput(this.inputs.length - 1); });
                this.addWidget("button", "Toggle Viewer",     null, () => { _toggleViewerPanelFromUi(); });
                this.setSize([240, 140]);
            };
        }

        if (nodeData.name === IMAGE_VIEWER_SEND_NODE) {
            registerSendNode(nodeType, nodeData);
        }

        if (nodeData.name === IMAGE_VIEWER_SCENE_NODE) {
            // scene_data is written by the previz panel, not by hand.
            registerToolNode(nodeType, nodeData, "scene");
            const onSceneNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = onSceneNodeCreated?.apply(this, arguments);
                // Without this the tab only appears after a run, and a scene
                // has to be built before there is anything to run.
                this.addWidget("button", "Open in Image Viewer", null,
                               () => _openPrevizFromNode(this));
                return r;
            };
        }

        if (nodeData.name === IMAGE_VIEWER_ROTO_NODE) {
            registerToolNode(nodeType, nodeData, "roto");
        }

        if (nodeData.name === IMAGE_VIEWER_SAM3_NODE) {
            registerToolNode(nodeType, nodeData, "sam3");
        }

        // Right-click → "Send to Image Viewer" on any node holding a media file
        // (VHS + native loaders alike). The entry hides itself on nodes without
        // one, so this is safe to register for every node type.
        registerSendToViewerMenu(nodeType, {
            getPanel:  () => globalViewerPanel,
            showPanel: () => _setViewerPanelToggle(true, { syncDisplay: true }),
        });
    },
});
} catch (e) {
    console.warn("ComfyUI Image Viewer standalone mode: extension registration skipped", e);
}

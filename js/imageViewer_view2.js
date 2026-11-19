// A second view: another open tab, shown in a panel beside the picture (Sebastian 2026-11-19: "main views
// should become panels as well ... more panels side by side"). Dock id `view2`, "Second view".
//
// It shows a 3D tab's scene through a Model3DView of its own (its own camera, shading, panes and grid; it
// can look through any of the scene's cameras while the main view looks through another), or a picture /
// film tab's picture. It can show the tab that is up too: the same scene from a second camera. It edits
// nothing - no selection, no gizmo, no camera written back - and follows the viewer's one time: the frame
// the main view is on when it shows the tab that is up, else the frame that tab was left on.
//
// Kept per viewer in localStorage `imageviewer.viewer.view2` ({tab, cam}). Drawn by a frame loop in the
// panel's own window while the panel is up and in front; the 3D view is re-reconciled when the scene's
// items change and has its frame applied when the frame moves (and every POLL_MS, so edits show).
import { Model3DView } from "./imageViewer_model3d.js";

const STORE = "imageviewer.viewer.view2";
const POLL_MS = 150;
const FREE = "";              // the view's own camera, not one of the scene's

export const View2Mixin = {

    _v2State() {
        if (!this._v2) {
            let saved = null;
            try { saved = JSON.parse(localStorage.getItem(STORE) || "null"); } catch (_) { saved = null; }
            this._v2 = { tab: (saved && typeof saved.tab === "string") ? saved.tab : "",
                         cam: (saved && typeof saved.cam === "string") ? saved.cam : FREE,
                         ui: null, view: null, raf: 0, sig: "", frame: null, polled: 0, shown: "" };
        }
        return this._v2;
    },

    _v2Save() {
        const s = this._v2State();
        try { localStorage.setItem(STORE, JSON.stringify({ tab: s.tab, cam: s.cam })); } catch (_) { /* private window */ }
    },

    /** The tabs it can show: 3D scenes, and tabs of pictures and films. */
    view2Tabs() {
        const out = [];
        for (const k of this.tabOrder || Object.keys(this.allTabs || {})) {
            const kind = this._v2KindOf(k);
            if (kind) out.push({ key: k, kind, label: this._historyTabLabel ? this._historyTabLabel(k) : k });
        }
        return out;
    },

    _v2KindOf(k) {
        if (!k) return "";
        if (this.isPrevizTab && this.isPrevizTab(k)) return "3d";
        const space = this._tabSpaceKind ? this._tabSpaceKind(k) : "";
        if (space !== "" && space !== "viewer") return "";
        if (this.isViewTab && this.isViewTab(k)) return "";
        const frames = this.allTabs && this.allTabs[k];
        if (!Array.isArray(frames) || !frames.length) return "";
        if (this._frameIsModel && frames.some((f) => this._frameIsModel(f))) return "";
        return "picture";
    },

    /** The tab shown: the one chosen while it is open, else the first 3D tab that is not up, else any. */
    view2Tab() {
        const s = this._v2State();
        const list = this.view2Tabs();
        if (list.some((t) => t.key === s.tab)) return s.tab;
        const pick = list.find((t) => t.kind === "3d" && t.key !== this.activeTab)
            || list.find((t) => t.key !== this.activeTab) || list[0];
        return pick ? pick.key : "";
    },

    view2Show(tab) {
        const s = this._v2State();
        s.tab = tab || "";
        s.sig = ""; s.frame = null;
        this._v2Save();
        this.view2Refresh();
    },

    /** The scene camera it looks through ("" = its own). */
    view2SetCamera(id) {
        const s = this._v2State();
        s.cam = id || FREE;
        this._v2Save();
        if (s.view && s.view.scene3d) { s.view._resize(); s.view.applyFrame(s.view.sceneFrame || 0); s.view.requestRender(); }
        this._v2DrawBar();
    },

    // ── Drawing ──────────────────────────────────────────────────────────────

    _v2Build() {
        const s = this._v2State();
        const host = this.view2Panel;
        if (!host) return null;
        if (s.ui && s.ui.root.parentNode === host && s.ui.root.ownerDocument === host.ownerDocument) return s.ui;
        const d = host.ownerDocument;
        const el = (tag, cls) => { const n = d.createElement(tag); if (cls) n.className = cls; return n; };
        // The title bar the dock gave it stays; only an old body goes.
        const old = host.querySelector(":scope > .v2-root");
        if (old) old.remove();
        const root = el("div", "v2-root");
        const bar = el("div", "v2-bar");
        const tabSel = el("select", "v2-tab");
        tabSel.title = "What this view shows";
        tabSel.onchange = () => this.view2Show(tabSel.value);
        const camSel = el("select", "v2-cam");
        camSel.title = "The camera it looks through";
        camSel.onchange = () => this.view2SetCamera(camSel.value);
        const info = el("span", "v2-info");
        bar.append(tabSel, camSel, info);
        const stage = el("div", "v2-stage");
        const pic = el("div", "v2-pic");
        const img = el("img", "v2-img");
        img.alt = "";
        const vid = el("video", "v2-video");
        vid.muted = true; vid.playsInline = true; vid.preload = "auto";
        const empty = el("div", "v2-empty");
        empty.textContent = "Open a 3D scene or a picture in a tab to see it here.";
        pic.append(img, vid);
        stage.append(pic, empty);
        root.append(bar, stage);
        host.appendChild(root);
        // A view made in another document (the pop-out) has its canvas there: made again.
        if (s.view) { try { s.view.dispose(); } catch (_) { /* gone */ } s.view = null; }
        s.ui = { root, bar, tabSel, camSel, info, stage, pic, img, vid, empty };
        s.sig = ""; s.frame = null; s.shown = "";
        return s.ui;
    },

    _v2View() {
        const s = this._v2State();
        if (!s.view) {
            s.view = new Model3DView(s.ui.stage, {
                resolveResource: (name, frame) => this._modelResourceUrl ? this._modelResourceUrl(name, frame) : null,
                srcUrl: (src) => this.buildImgUrl(src, { noColor: true }),
                plateInfo: (src) => this.plateInfo ? this.plateInfo(src) : null,
                plateFrameUrl: (src, n) => this.plateFrameUrl ? this.plateFrameUrl(src, n) : null,
                setIcon: (el, key) => this._setIcon && this._setIcon(el, key),
                // Its own camera, panes and display kinds, kept apart from the main view's.
                perspThrough: () => this._v2CamId(),
                storeSuffix: ".view2",
            });
        }
        return s.view;
    },

    /** The camera chosen, while it is one of the shown scene's cameras. */
    _v2CamId() {
        const s = this._v2State();
        const scene = this.previzScene ? this.previzScene(this.view2Tab()) : null;
        if (!s.cam || !scene) return null;
        return (scene.items || []).some((it) => it.id === s.cam && it.kind === "camera") ? s.cam : null;
    },

    /** The frame the shown tab is on. */
    _v2FrameOf(tab) {
        if (tab === this.activeTab) return Math.round(this.currentFrame || 0);
        const st = this.getTabViewState ? this.getTabViewState(tab) : null;
        return Math.round((st && Number.isFinite(st.frame)) ? st.frame : 0);
    },

    _v2DrawBar() {
        const s = this._v2State(), ui = s.ui;
        if (!ui) return;
        const tab = this.view2Tab();
        const list = this.view2Tabs();
        const tsig = list.map((t) => t.key + "\u0001" + t.label).join("\u0002") + "|" + tab;
        if (ui.tabSel.dataset.sig !== tsig) {
            ui.tabSel.textContent = "";
            for (const t of list) {
                const o = ui.tabSel.ownerDocument.createElement("option");
                o.value = t.key;
                o.textContent = t.label + (t.key === this.activeTab ? " (up)" : "");
                ui.tabSel.appendChild(o);
            }
            ui.tabSel.value = tab;
            ui.tabSel.disabled = !list.length;
            ui.tabSel.dataset.sig = tsig;
        }
        const scene = this._v2KindOf(tab) === "3d" && this.previzScene ? this.previzScene(tab) : null;
        const cams = scene ? (scene.items || []).filter((it) => it.kind === "camera") : [];
        const csig = cams.map((c) => c.id + "\u0001" + (c.name || c.id)).join("\u0002") + "|" + (this._v2CamId() || "");
        if (ui.camSel.dataset.sig !== csig) {
            ui.camSel.textContent = "";
            const add = (v, label) => {
                const o = ui.camSel.ownerDocument.createElement("option");
                o.value = v; o.textContent = label; ui.camSel.appendChild(o);
            };
            add(FREE, "Perspective");
            for (const c of cams) add(c.id, c.name || c.id);
            ui.camSel.value = this._v2CamId() || FREE;
            ui.camSel.dataset.sig = csig;
        }
        ui.camSel.style.display = scene ? "" : "none";
    },

    /** Draw what it shows now; called by the loop and whenever something about it changed. */
    view2Refresh() {
        if (!this.view2Panel) return;
        const s = this._v2State();
        const ui = this._v2Build();
        if (!ui) return;
        this._v2DrawBar();
        const tab = this.view2Tab();
        const kind = this._v2KindOf(tab);
        ui.root.dataset.kind = kind || "none";
        ui.root.dataset.tab = tab;
        ui.empty.style.display = kind ? "none" : "";
        if (kind !== "3d" && s.view) s.view.hide();
        if (kind !== "picture") { ui.pic.style.display = "none"; this._v2PicStop(); }
        if (kind === "3d") this._v2Draw3d(tab);
        else if (kind === "picture") this._v2DrawPicture(tab);
        s.shown = tab;
    },

    _v2Draw3d(tab) {
        const s = this._v2State();
        const scene = this.previzScene(tab);
        const view = this._v2View();
        const frame = this._v2FrameOf(tab);
        // The items' ids and the files they show: a change there is a reconcile, anything else a frame.
        const sig = (scene.items || []).map((it) => it.id + ":" + (it.parent || "") + ":" + JSON.stringify(it.src || "")).join("|");
        const now = (view.win || window).performance.now();
        if (s.loading) return;
        if (view.scene3d !== scene || s.sig !== sig || !view.visible) {
            s.sig = sig; s.frame = frame; s.polled = now;
            if (view.scene3d === scene && view.visible) view.setScene(scene, frame);
            else if (view.scene3d === scene && view.reveal()) view.applyFrame(frame);
            else {
                s.loading = view.setScene(scene, frame)
                    .then(() => { if (this._v2Up()) { view.reveal(); view.applyFrame(this._v2FrameOf(tab)); } else view.hide(); })
                    .catch((e) => console.warn("imageViewer: the second view could not show the scene", e))
                    .finally(() => { s.loading = null; });
            }
        } else if (s.frame !== frame || now - s.polled > POLL_MS) {
            s.frame = frame; s.polled = now;
            view.applyFrame(frame);
        }
        s.ui.info.textContent = `frame ${frame}`;
    },

    _v2DrawPicture(tab) {
        const s = this._v2State(), ui = s.ui;
        const frames = this.allTabs[tab] || [];
        const n = this._v2FrameOf(tab);
        ui.pic.style.display = "";
        const first = frames[0];
        if (first && this._frameIsVideo && this._frameIsVideo(first)) {
            const url = this.buildImgUrl(first);
            ui.img.style.display = "none";
            ui.vid.style.display = "";
            if (ui.vid.dataset.src !== url) { ui.vid.dataset.src = url; ui.vid.src = url; }
            const fps = Number(first.fps) || this.fps || 24;
            const t = (n + 0.5) / fps;
            if (Number.isFinite(ui.vid.duration) && ui.vid.readyState >= 1 && Math.abs(ui.vid.currentTime - t) > 0.5 / fps) {
                ui.vid.currentTime = Math.min(t, Math.max(0, ui.vid.duration - 0.001));
            }
            ui.info.textContent = `frame ${n}`;
            return;
        }
        this._v2PicStop();
        const f = frames[Math.max(0, Math.min(frames.length - 1, n))];
        const url = f ? this.buildImgUrl(f) : "";
        ui.img.style.display = url ? "" : "none";
        if (ui.img.dataset.src !== url) { ui.img.dataset.src = url; ui.img.src = url; }
        ui.info.textContent = frames.length > 1 ? `frame ${Math.max(0, Math.min(frames.length - 1, n))}` : "";
    },

    _v2PicStop() {
        const ui = this._v2State().ui;
        if (!ui || !ui.vid.dataset.src) return;
        ui.vid.removeAttribute("src"); delete ui.vid.dataset.src;
        try { ui.vid.load(); } catch (_) { /* nothing loaded */ }
        ui.vid.style.display = "none";
    },

    // ── Up and down ──────────────────────────────────────────────────────────

    _v2Up() {
        return !!(this.view2Panel && this.isPanelDocked && this.isPanelDocked("view2")
            && (!this.isPanelFront || this.isPanelFront("view2"))
            && !(this.isPanelCollapsed && this.isPanelCollapsed("view2")));
    },

    /** The panel came into view (DockMixin._onPanelShown): draw, and keep drawing while it is up. */
    view2Wake() {
        const s = this._v2State();
        this.view2Refresh();
        if (s.raf) return;
        const win = (this.view2Panel && this.view2Panel.ownerDocument.defaultView) || window;
        const tick = () => {
            s.raf = 0;
            if (!this._v2Up()) { this.view2Sleep(); return; }
            try { this.view2Refresh(); } catch (e) { console.warn("imageViewer: the second view could not draw", e); }
            s.rafWin = win;
            s.raf = win.requestAnimationFrame(tick);
        };
        s.rafWin = win;
        s.raf = win.requestAnimationFrame(tick);
    },

    view2Sleep() {
        const s = this._v2State();
        if (s.raf && s.rafWin) s.rafWin.cancelAnimationFrame(s.raf);
        s.raf = 0;
        if (s.view) s.view.hide();
        this._v2PicStop();
    },

    /** The viewer moved into another window: everything is made again there. */
    _v2AfterMove() {
        const s = this._v2State();
        if (!s.ui) return;
        this.view2Sleep();
        s.ui = null;
        if (this._v2Up()) this.view2Wake();
    },
};

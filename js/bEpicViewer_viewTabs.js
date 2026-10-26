// bEpicViewer_viewTabs.js
// Tabs whose whole content is a page of the viewer's own, not media: the Agent code reader ("code:<path>", or
// "code:" for the agent's live feed) and a LoRA Dataset ("dataset:<name>"). They open in the MAIN CANVAS, the way
// a Motion scene does (bEpicViewer_mgPanel.js): one layer over the viewport holds every such tab's element, the
// tab bar shows them, several can be open at once, and nothing of them lives in a dock panel.
//
// A kind is a small handler object (made by the mixin that owns the feature, named in VT_KINDS):
//   restore(key)        -> the record's fields for a tab that came back with the page (the key says what it was)
//   build(rec, key)     -> fill rec.el once, the first time the tab is shown
//   shown(rec, key)     -> the tab came to the front (each time)
//   isDirty(rec)        -> unsaved changes? closing asks once
//   dirtyText(rec)      -> what to say about them
//   dispose(rec)        -> the tab is gone
// The tab itself is opened with vtOpen(kind, key, label, fields).

export const VT_KINDS = {
    code:    { prefix: "code:",    handler: "_codeTabKind",  icon: "\u{1F4C4} " },
    dataset: { prefix: "dataset:", handler: "_loraTabKind",  icon: "\u{1F5C2} " },
};

export const ViewTabsMixin = {

    _vtState() {
        if (!this._vt) this._vt = { tabs: {}, host: null };
        return this._vt;
    },

    /** The kind of a view tab key ("code", "dataset"), or "" when the key is something else. */
    vtKindOf(key = this.activeTab) {
        if (typeof key !== "string") return "";
        for (const [kind, spec] of Object.entries(VT_KINDS)) if (key.startsWith(spec.prefix)) return kind;
        return "";
    },

    isViewTab(key = this.activeTab) { return !!this.vtKindOf(key); },

    _vtHandler(kind) {
        const spec = VT_KINDS[kind];
        return spec && typeof this[spec.handler] === "function" ? this[spec.handler]() : null;
    },

    /** Open (or focus) a view tab. `fields` seed a new record; an existing one is returned to `onExisting`. */
    vtOpen(kind, key, label, fields = {}) {
        const st = this._vtState();
        let rec = st.tabs[key];
        const existed = !!(rec && this.allTabs[key]);
        if (!existed) {
            rec = st.tabs[key] = { kind, key, el: null, built: false, ...fields };
            this.allTabs[key] = [];
            this.tabLabels[key] = VT_KINDS[kind].icon + label;
            if (!this.tabOrder.includes(key)) this.tabOrder.push(key);
            this._rebuildTabBar(null);
        }
        if (this.requestPanelOpen) this.requestPanelOpen();
        this.switchTab(key);
        return { rec, existed };
    },

    /** Change a tab's title (a dataset picked inside its tab). */
    vtRelabel(key, label) {
        const kind = this.vtKindOf(key);
        if (!kind || !this.tabLabels[key]) return;
        this.tabLabels[key] = VT_KINDS[kind].icon + label;
        this._rebuildTabBar(null);
        if (this.queuePersistViewerState) this.queuePersistViewerState();
    },

    /** The layer in the viewport that every view tab sits in (made once). */
    _vtHostEl() {
        const st = this._vtState();
        if (st.host && st.host.isConnected) return st.host;
        const doc = this.viewport.ownerDocument;
        const host = doc.createElement("div");
        host.className = "view-tabs";
        // The viewport pans, zooms and swallows the context menu; a page has its own say over all of it.
        for (const type of ["mousedown", "wheel", "contextmenu", "dblclick"]) {
            host.addEventListener(type, (e) => e.stopPropagation());
        }
        this.viewport.append(host);
        st.host = host;
        return host;
    },

    /** switchTab came to a view tab: its page takes the main canvas. */
    vtEnter(key) {
        const st = this._vtState();
        const kind = this.vtKindOf(key);
        const h = this._vtHandler(kind);
        let rec = st.tabs[key];
        if (!rec) rec = st.tabs[key] = { kind, key, el: null, built: false, ...(h && h.restore ? h.restore(key) : {}) };
        this._vtOn = true;
        this.viewport.classList.add("view-mode");
        const host = this._vtHostEl();
        host.style.display = "block";
        if (!rec.el) {
            rec.el = host.ownerDocument.createElement("div");
            rec.el.className = `view-tab view-tab-${kind}`;
            host.append(rec.el);
        }
        for (const other of Object.values(st.tabs)) if (other.el) other.el.style.display = other === rec ? "block" : "none";
        this.stop();
        if (!rec.built && h) {
            rec.built = true;
            try { h.build(rec, key); }
            catch (e) { console.warn(`bEpicViewer: ${kind} tab not built`, e); }
        }
        if (h && h.shown) { try { h.shown(rec, key); } catch (e) { console.warn(`bEpicViewer: ${kind} tab not shown`, e); } }
        if (this.barGroupsSync) this.barGroupsSync();
    },

    /** switchTab left a view tab (or the last one closed): the viewport is the picture's again. */
    vtLeave() {
        if (!this._vtOn) return;
        const st = this._vtState();
        this._vtOn = false;
        this.viewport.classList.remove("view-mode");
        if (st.host) st.host.style.display = "none";
        if (this.barGroupsSync) this.barGroupsSync();
    },

    /** closeTab asks first: a page with changes that were not saved says so once and stays. */
    vtTabClosing(key) {
        const kind = this.vtKindOf(key);
        if (!kind) return true;
        const rec = this._vtState().tabs[key];
        const h = this._vtHandler(kind);
        if (rec && h && h.isDirty && h.isDirty(rec) && this._vtCloseAsked !== key) {
            this._vtCloseAsked = key;
            const text = h.dirtyText ? h.dirtyText(rec) : "This tab has changes that were not saved.";
            import("./bEpicViewer_exportUI.js").then((m) => m.notice("warn", "Unsaved changes", `${text} Close the tab again to throw them away.`));
            return false;
        }
        this._vtCloseAsked = null;
        return true;
    },

    /** The tab is gone: so is its page. */
    vtTabClosed(key) {
        const st = this._vtState();
        const rec = st.tabs[key];
        if (!rec) return;
        const h = this._vtHandler(rec.kind);
        if (h && h.dispose) { try { h.dispose(rec); } catch (_) { /* already gone */ } }
        if (rec.el) rec.el.remove();
        delete st.tabs[key];
    },

    /** The open tabs of a kind, in tab-bar order. */
    vtTabsOf(kind) {
        const st = this._vtState();
        return (this.tabOrder || []).filter((k) => st.tabs[k] && st.tabs[k].kind === kind && this.allTabs[k]).map((k) => st.tabs[k]);
    },
};

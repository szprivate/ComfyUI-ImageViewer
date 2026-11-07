// Opening a saved cut, from everywhere a user looks for it.
//
//   The Edit bar's Open button (folder-open, Ctrl+O in the panel) and the caret beside it: Open recent
//   The tab bar's own button, which is there with no cut tab open: its menu is "Open cut..." + the recent
//   Out menu on the Edit bar: "Open cut..." and "Open recent..."
//   An .otio dropped from the desktop onto the viewer or the timeline
//   The agent's show_in_viewer(otio): the page's "imageviewer.edit.open" message (imageViewer.js)
//
// Open recent: the last RECENT_MAX cuts opened or saved, by path, per viewer (the browser's localStorage,
// every access in try/catch). A path whose file is gone is listed greyed (POST /imageviewer/probe_paths).
import { api } from "../../scripts/api.js";
import { notice } from "./imageViewer_exportUI.js";

import { RECENT_KEY, RECENT_MAX, recentWith, norm } from "./imageViewer_editRecent.js";

const dirOf = (p) => {
    const s = String(p || "").replace(/\\/g, "/");
    const i = s.lastIndexOf("/");
    return i > 0 ? s.slice(0, i) : "";
};
const baseOf = (p) => String(p || "").replace(/\\/g, "/").split("/").pop();

export const EditOpenMixin = {
    /** The recent cuts, newest first. */
    editTlRecent() {
        try {
            const raw = JSON.parse(window.localStorage.getItem(RECENT_KEY) || "[]");
            return Array.isArray(raw) ? raw.filter((x) => typeof x === "string").slice(0, RECENT_MAX) : [];
        } catch (_) { return []; }
    },

    _editTlRecentAdd(path) {
        if (!path) return;
        try { window.localStorage.setItem(RECENT_KEY, JSON.stringify(recentWith(this.editTlRecent(), path))); } catch (_) { /* no storage: no list */ }
    },

    editTlRecentClear() {
        try { window.localStorage.removeItem(RECENT_KEY); } catch (_) { /* nothing kept anyway */ }
    },

    /** Which of `paths` no longer exist (a slow or silent answer: none are said to be gone). */
    async _editTlRecentGone(paths) {
        if (!paths.length) return new Set();
        try {
            const ask = api.fetchApi("/imageviewer/probe_paths", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ paths: paths.map((path) => ({ path, external: true })) }),
            }).then((r) => (r.ok ? r.json() : null));
            const win = (this._viewerWindow && this._viewerWindow()) || window;
            const late = new Promise((res) => win.setTimeout(() => res(null), 1200));
            const got = await Promise.race([ask, late]);
            return new Set(((got && got.unreachable) || []).filter((u) => u && u.reason === "gone").map((u) => norm(u.path)));
        } catch (_) { return new Set(); }
    },

    /** Open cut...: pick a saved .otio. It starts in the folder of the cut in the panel, else of the last one opened. */
    editTlOpenDialog() {
        const start = dirOf((this.editTlFilePath && this.editTlFilePath()) || "") || dirOf(this.editTlRecent()[0] || "");
        return this._editTlPicker({
            id: "cut", title: "Open cut", kind: "edit", exts: [".otio"], go: "Open", ...(start ? { start } : {}),
            note: "A cut opens in a tab of its own. Where it was saved is in the Inspector's Timeline section.",
            onPick: async ([f]) => ((await this.editTlOpenPath(f.path)) ? { ok: true } : { ok: false, message: "That timeline could not be read." }),
        });
    },

    /**
     * The Open menu: "Open cut...", then the recent cuts (the missing ones greyed), then Clear.
     * `withOpen` false: the recent only (the Out menu has its own "Open cut...").
     */
    async editTlOpenMenu(anchor, withOpen = true) {
        if (this._previzAddMenu) { this._previzCloseAddMenu(); return; }
        const recent = this.editTlRecent();
        const gone = await this._editTlRecentGone(recent);
        const entries = [];
        if (withOpen) entries.push({ label: "Open cut… (Ctrl+O)", run: () => this.editTlOpenDialog() }, "-");
        if (!recent.length) entries.push({ label: "No recent cuts", disabled: true, run: () => {} });
        for (const p of recent) {
            const missing = gone.has(norm(p));
            entries.push({ label: baseOf(p) + (missing ? " (missing)" : ""), title: p, disabled: missing, run: () => this._editTlOpenRecent(p) });
        }
        if (recent.length) entries.push("-", { label: "Clear recent", run: () => this.editTlRecentClear() });
        const a = anchor.getBoundingClientRect();
        if (!this._previzOpenMenu(entries, a.left, a.bottom + 2, anchor)) this.editTlOpenDialog();
    },

    async _editTlOpenRecent(path) {
        if (!(await this.editTlOpenPath(path))) notice("error", "The cut could not be opened", path);
    },

    /** .otio files dropped from the desktop: kept in the input folder (/imageviewer/timeline_upload), then opened as cuts. */
    async editTlOpenDropped(files) {
        let opened = 0;
        for (const f of Array.from(files || [])) {
            if (!/\.otio$/i.test(f.name || "")) continue;
            const got = await this._editTlUpload(f, f.name);
            if (got && got.path && (await this.editTlOpenPath(got.path))) opened++;
            else notice("error", "The cut could not be opened", f.name);
        }
        return opened;
    },

    /** Do the dropped files include a cut? */
    editTlDropHasCut(files) {
        return Array.from(files || []).some((f) => /\.otio$/i.test(f.name || ""));
    },
};

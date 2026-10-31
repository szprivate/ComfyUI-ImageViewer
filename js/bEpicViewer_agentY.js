// bEpicViewer_agentY.js
// The viewer as agentY's viewer: stage groups in the history strip, "Tag for
// agentY..." and "Approve for agentY" in a thumbnail's right-click menu.
//
// agentY is a separate ComfyUI extension (agentY-comfyuiConnect). The two meet in
// ONE small object it puts on the page, and nothing else is shared:
//
//   window.agentYViewerBridge = {
//     version: 1,
//     state():   { halted: boolean }              // is a review stop waiting?
//     tag({ tag, path, role }):  Promise<{ ok, message, tag }>
//     approve({ files: [path, ...] }): Promise<{ ok, message }>
//     untag({ tag, path }): Promise<{ ok, message, removed, canvas: [{id, title}] }>   (newer)
//     clearCanvasTag({ tag, path }): { ok, message }                              (newer)
//     manageTags({ anchor, tag }): opens agentY's Manage tags page                (newer)
//   }
//
// Without it (agentY not installed, or an older one) the menu rows are simply not
// there, and the group headings, which need nothing from agentY, still are. A tag
// that comes from an `agentY add tag` node on the canvas is never cleared from
// here without asking: untag() names the node, and the dialog asks first.
//
// Pictures arrive grouped when the node that sent them carried a `group` (the
// stage: "Characters", "Places") and a `label` (what it is: a character's name);
// both are stamped onto each frame by bEpicSendToViewer, so they live as long as
// the picture does in the history.

import { app } from "../../scripts/app.js";
import { describeHistorySelection } from "./bEpicViewer_historySelection.js";
import { agentTagKey, agentTagsOfSnapshot, normPath } from "./bEpicViewer_historyAgentTags.js";

/** The tab a send files itself under when it names one but has no node of its own
 *  on the open graph - an agent running a workflow. */
export function namedTabInfo(name) {
    const label = String(name || "").trim();
    const safe = label.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_\-]/g, "");
    return { key: `named:${safe || "agent"}`, label: label || "agent" };
}

/** A tag as agentY writes it: letters, digits, _ and -. */
export function tagNameOf(text) {
    return String(text || "").trim().replace(/^#+/, "").replace(/[^A-Za-z0-9_\-]+/g, "_").replace(/^_+|_+$/g, "");
}

/** The file a picture is, or "" when the viewer only knows it as a ComfyUI
 *  output reference (filename/subfolder/type) with no path on disk. */
export function framePath(fr) {
    return fr && typeof fr.path === "string" ? fr.path : "";
}

function bridge() {
    const b = typeof window !== "undefined" ? window.agentYViewerBridge : null;
    return b && typeof b.tag === "function" && typeof b.approve === "function" ? b : null;
}

/** The bridge, when it can take a tag off a picture (a newer agentY). */
function untagBridge() {
    const b = bridge();
    return b && typeof b.untag === "function" ? b : null;
}

export const AgentYMixin = {

    // ── "show it to me" (POST /bepic/push with focus / panel) ───────────────

    /**
     * An agent asked for what it just pushed to be looked at. `req`:
     * { focus, select (index of the item to show), play, panel: "edit" }.
     * Brings the viewer up (open or closed), goes to the tab, shows the item,
     * plays it, and - for panel "edit" - opens the Edit panel on the cut beside
     * that film.
     */
    async agentOpenRequest(req, key) {
        if (!req || !key || !this.allTabs[key]) return;
        const api = window.bEpicViewerApi || {};
        try { if (api.show) api.show(); } catch (_) { /* already up */ }
        if (this.historyCompare) this.exitHistoryCompare?.();
        const items = this.allTabs[key];
        const index = Math.max(0, Math.min(Number(req.select) || 0, items.length - 1));
        if (this.activeTab !== key) this.switchTab(key);
        if (req.panel === "edit" && this.editTlOpenCutOf) {
            const opened = await this.editTlOpenCutOf(items[index]);
            if (opened) return;            // the cut's own tab is up: the Edit panel is the view
        }
        const bounds = this.getTimelineBounds ? this.getTimelineBounds(items.length) : { min: 0 };
        this.setFrame((bounds.min || 0) + index);
        if (req.play && this.play) this.play();
    },

    agentYAvailable() { return !!bridge(); },

    // ── what is picked in the history strip (window.bEpicViewerApi.historySelection) ──

    /** Whether the user can see the viewer at all: docked / full-screen, or popped out. */
    _agentViewerVisible() {
        if (this.popoutWindow && !this.popoutWindow.closed) return true;
        return !!(this.style && this.style.display !== "none" && this.isConnected);
    },

    /** The history snapshots the user picked in the open tab, as plain data
     *  (see bEpicViewer_historySelection.js for what counts as a pick). */
    agentHistorySelection() {
        const key = this.activeTab;
        const empty = { source: "viewer", tab: String(key || ""), tab_label: "", mode: "", count: 0, items: [] };
        if (!key || !this._agentViewerVisible()) return empty;
        let label = "";
        try { label = this._resolveTabLabel ? this._resolveTabLabel(key) : (this.tabLabels || {})[key] || ""; }
        catch (_) { label = (this.tabLabels || {})[key] || ""; }
        return describeHistorySelection({
            stack: (this.history || {})[key] || [],
            state: {
                key,
                multi: this.historySelectionIndices ? this.historySelectionIndices(key) : [],
                viewing: !!this.isViewingHistory,
                viewingKey: this.currentHistoryKey,
                viewingIndex: this.currentHistoryIndex,
                compare: this.historyCompare || null,
            },
            tab: key,
            tabLabel: label,
            agentTags: this._agentTags || null,
        });
    },

    // ── groups in the history strip ──────────────────────────────────────────

    /** A heading to put before this snapshot's thumbnail, or null. `run` carries
     *  the previous visible snapshot's group between calls. */
    historyGroupHeader(doc, snapshot, run) {
        const group = String((snapshot && snapshot[0] && snapshot[0].group) || "");
        const first = run.group === undefined;
        const changed = !first && group !== run.group;
        run.group = group;
        if (first ? !group : !changed) return null;
        const h = doc.createElement("div");
        h.className = "history-group";
        h.textContent = group || "Other";
        return h;
    },

    /** The caption a thumbnail wears: what the picture is, when its sender said. */
    historyThumbCaption(doc, snapshot) {
        const label = String((snapshot && snapshot[0] && snapshot[0].label) || "");
        if (!label) return null;
        const c = doc.createElement("div");
        c.className = "history-thumb-label";
        c.textContent = label;
        return c;
    },

    /** The agentY tags a picture wears: the ones given here, then every other
     *  source (the canvas's tag nodes, the project's remembered references). */
    agentTagsOf(fr) {
        const out = [];
        const put = (n) => { if (n && !out.some((o) => agentTagKey(o) === agentTagKey(n))) out.push(n); };
        const p = framePath(fr);
        if (p && this._agentTags && this._agentTags[p]) put(this._agentTags[p]);
        if (fr && this._agentTagIndex) agentTagsOfSnapshot(this._agentTagIndex, fr).forEach(put);
        return out;
    },

    /** The "#name" badges on a picture agentY knows by a tag, each with a × that
     *  takes the tag off (when agentY can). */
    historyAgentTagBadge(doc, snapshot) {
        const fr = snapshot && snapshot[0];
        const names = this.agentTagsOf(fr);
        if (!names.length) return null;
        const canRemove = !!(framePath(fr) && untagBridge());
        const box = doc.createElement("div");
        box.className = "history-agent-tags";
        for (const name of names) {
            const b = doc.createElement("div");
            b.className = "history-agent-tag";
            b.title = `agentY tag #${name}`;
            const t = doc.createElement("span");
            t.textContent = `#${name}`;
            b.append(t);
            if (canRemove) {
                const x = doc.createElement("span");
                x.className = "history-agent-tag-x";
                x.textContent = "×";
                x.title = `Take #${name} off this picture`;
                x.addEventListener("mousedown", (e) => e.stopPropagation());
                x.addEventListener("click", (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    this.agentYUntag(fr, name);
                });
                b.append(x);
            }
            box.append(b);
        }
        return box;
    },

    // ── the right-click rows ─────────────────────────────────────────────────

    /** Rows for the thumbnail menu; `indices` are what the menu acts on. */
    agentYMenuItems(doc, menu, key, indices) {
        const b = bridge();
        if (!b) return [];
        const stack = this.history[key] || [];
        const items = [];
        const row = (text, title, enabled, run) => {
            const el = doc.createElement("div");
            el.className = "thumb-ctx-item" + (enabled ? "" : " disabled");
            el.textContent = text;
            el.title = title;
            el.onclick = (e) => {
                e.stopPropagation();
                if (!enabled) return;
                menu.remove();
                run();
            };
            items.push(el);
        };
        if (indices.length === 1) {
            const snap = stack[indices[0]] || [];
            const fr = snap[0];
            const path = framePath(fr);
            row("# Tag for agentY…",
                path ? "Give this picture a name agentY can use as #name in a prompt"
                     : "This picture has no file on disk, so it cannot be tagged",
                !!path, () => this.agentYTagDialog(fr));
            // One row per tag it wears, so with several the user picks which.
            if (path && untagBridge()) {
                for (const name of this.agentTagsOf(fr)) {
                    row(`✕ Remove tag #${name}`, `Take #${name} off this picture`, true,
                        () => this.agentYUntag(fr, name));
                }
            }
        }
        if (typeof b.manageTags === "function") {
            row("🏷 Manage tags…", "Every agentY tag, its pictures, rename, merge and delete", true,
                () => this.agentYManageTags());
        }
        let state = { halted: false };
        try { state = b.state() || state; } catch (e) { /* keep */ }
        const files = this.agentYFilesOf(key, indices);
        const n = indices.length;
        row(n > 1 ? `✔ Approve ${n} for agentY` : "✔ Approve for agentY",
            !state.halted ? "agentY is not waiting at a review stop"
                : !files.length ? "These pictures have no file on disk"
                : "Continue the stopped run with " + (n > 1 ? "these pictures" : "this picture")
                  + " - the same as editing the review collector and pressing Continue",
            !!state.halted && files.length > 0, () => this.agentYApprove(files));
        return items;
    },

    /** The files of the snapshots at `indices`, in strip order, without repeats. */
    agentYFilesOf(key, indices) {
        const stack = this.history[key] || [];
        const out = [];
        for (const i of [...indices].sort((a, b) => a - b)) {
            for (const fr of stack[i] || []) {
                const p = framePath(fr);
                if (p && !out.includes(p)) out.push(p);
            }
        }
        return out;
    },

    async agentYApprove(files) {
        const b = bridge();
        if (!b) return;
        try {
            const r = await b.approve({ files });
            this._agentYNotify(r && r.message ? r.message : (r && r.ok ? "Approved." : "Not approved."),
                               r && r.ok ? "success" : "warn");
        } catch (e) {
            this._agentYNotify(`Could not approve: ${e}`, "error");
        }
    },

    async agentYTag(fr, tag, role) {
        const b = bridge();
        if (!b) return false;
        try {
            const r = await b.tag({ tag, path: framePath(fr), role });
            const ok = !!(r && r.ok);
            if (ok) {
                if (!this._agentTags) this._agentTags = {};
                // A remembered tag names ONE picture: tagging another one moves it.
                const k = agentTagKey(r.tag || tag);
                for (const [p, n] of Object.entries(this._agentTags)) {
                    if (agentTagKey(n) === k) delete this._agentTags[p];
                }
                this._agentTags[framePath(fr)] = r.tag || tag;
                this._historyPanelSig = null;
                this.renderHistoryPanel();
                if (this.refreshAgentTags) this.refreshAgentTags({ fresh: true });
            }
            this._agentYNotify(r && r.message ? r.message : (ok ? `Tagged #${tag}.` : "Could not tag it."),
                               ok ? "success" : "warn");
            return ok;
        } catch (e) {
            this._agentYNotify(`Could not tag it: ${e}`, "error");
            return false;
        }
    },

    /** "Remove tag #name" (menu row or the badge's ×). The remembered tag goes at
     *  once; one that an `agentY add tag` node on the canvas puts there is only
     *  cleared after the user says so (agentYCanvasTagDialog). */
    async agentYUntag(fr, name) {
        const b = untagBridge();
        if (!b) return false;
        const path = framePath(fr);
        let r = null;
        try { r = await b.untag({ tag: name, path }); }
        catch (e) { this._agentYNotify(`Could not remove the tag: ${e}`, "error"); return false; }
        r = r || {};
        if (r.removed || r.notRemembered) this._dropLocalAgentTag(path, name);
        this._historyPanelSig = null;
        this.renderHistoryPanel();
        if (this.refreshAgentTags) this.refreshAgentTags({ fresh: true });
        if (r.canvas && r.canvas.length) {
            this.agentYCanvasTagDialog(fr, name, r);
            return false;
        }
        this._agentYNotify(r.message || (r.ok ? `Removed #${name}.` : "Could not remove the tag."),
                           r.ok ? "success" : "warn");
        return !!r.ok;
    },

    _dropLocalAgentTag(path, name) {
        if (!this._agentTags) return;
        const want = normPath(path);
        for (const [p, n] of Object.entries(this._agentTags)) {
            if (normPath(p) === want && agentTagKey(n) === agentTagKey(name)) delete this._agentTags[p];
        }
    },

    /** The tag comes from a node on the canvas: say which, and offer to clear its
     *  tag field - the user's graph is only changed after they press the button. */
    agentYCanvasTagDialog(fr, name, r) {
        const doc = (this.container && this.container.ownerDocument) || document;
        this.container.querySelector(".agenty-tag-dialog")?.remove();
        const wrap = doc.createElement("div");
        wrap.className = "agenty-tag-dialog agenty-untag-dialog";
        const form = doc.createElement("form");
        const title = doc.createElement("div");
        title.className = "agenty-tag-title";
        title.textContent = `Remove tag #${name}`;
        const text = doc.createElement("div");
        text.className = "agenty-tag-text";
        text.textContent = r.message || "";
        const buttons = doc.createElement("div");
        buttons.className = "agenty-tag-buttons";
        const cancel = doc.createElement("button");
        cancel.type = "button"; cancel.textContent = "Keep it";
        const ok = doc.createElement("button");
        ok.type = "submit";
        const n = (r.canvas || []).length;
        ok.textContent = n > 1 ? `Clear the tag field of ${n} nodes` : `Clear node #${(r.canvas[0] || {}).id}'s tag field`;
        buttons.append(cancel, ok);
        form.append(title, text, buttons);
        wrap.append(form);
        const close = () => wrap.remove();
        cancel.onclick = close;
        wrap.onclick = (e) => { if (e.target === wrap) close(); };
        for (const ev of ["keydown", "keyup", "keypress"]) {
            form.addEventListener(ev, (e) => {
                e.stopPropagation();
                if (ev === "keydown" && e.key === "Escape") close();
            });
        }
        form.onsubmit = (e) => {
            e.preventDefault();
            const b = untagBridge();
            let res = null;
            try { res = b && typeof b.clearCanvasTag === "function" ? b.clearCanvasTag({ tag: name, path: framePath(fr) }) : null; }
            catch (err) { res = { ok: false, message: String(err) }; }
            close();
            res = res || { ok: false, message: "agentY cannot change the canvas from here." };
            if (res.ok) this._dropLocalAgentTag(framePath(fr), name);
            this._historyPanelSig = null;
            this.renderHistoryPanel();
            if (this.refreshAgentTags) this.refreshAgentTags({ fresh: true });
            this._agentYNotify(res.message || "", res.ok ? "success" : "warn");
        };
        this.container.appendChild(wrap);
        ok.focus();
    },

    /** agentY's Manage tags page, opened in the viewer's own root and window. */
    agentYManageTags(tag) {
        const b = bridge();
        if (!b || typeof b.manageTags !== "function") return false;
        try { return b.manageTags({ anchor: this.container, tag: tag || "" }) !== false; }
        catch (e) { this._agentYNotify(`Could not open Manage tags: ${e}`, "error"); return false; }
    },

    /** Show the history item that is this file (agentY's "Open in viewer").
     *  -> whether it was found. */
    agentShowPath(path) {
        const want = normPath(path);
        if (!want) return false;
        for (const [key, stack] of Object.entries(this.history || {})) {
            const idx = (stack || []).findIndex((s) => (s || []).some((fr) => normPath(framePath(fr)) === want));
            if (idx < 0) continue;
            const api = window.bEpicViewerApi || {};
            try { if (api.show) api.show(); } catch (_) { /* already up */ }
            if (this.historyCompare && this.exitHistoryCompare) this.exitHistoryCompare();
            this.openHistorySnapshot(key, idx);
            return true;
        }
        return false;
    },

    _agentYNotify(msg, severity) {
        try {
            const t = app?.extensionManager?.toast;
            if (t && t.add) { t.add({ severity, summary: "agentY", detail: msg, life: 5000 }); return; }
        } catch (e) { /* fall through */ }
        console.log("[bEpic viewer / agentY]", msg);
    },

    /** A small form over the panel: the tag's name, and what the picture is. */
    agentYTagDialog(fr) {
        const doc = (this.container && this.container.ownerDocument) || document;
        this.container.querySelector(".agenty-tag-dialog")?.remove();
        const wrap = doc.createElement("div");
        wrap.className = "agenty-tag-dialog";
        const form = doc.createElement("form");
        const title = doc.createElement("div");
        title.className = "agenty-tag-title";
        title.textContent = "Tag for agentY";
        const mk = (labelText, value, placeholder) => {
            const l = doc.createElement("label");
            l.textContent = labelText;
            const i = doc.createElement("input");
            i.type = "text"; i.value = value; i.placeholder = placeholder;
            i.autocomplete = "off"; i.spellcheck = false;
            l.append(i);
            return [l, i];
        };
        const [nameRow, nameIn] = mk("Name", tagNameOf(fr.label || ""), "hero_face");
        const [roleRow, roleIn] = mk("What it is (optional)", fr.label || "", "the face only, not the hair");
        const hint = doc.createElement("div");
        hint.className = "agenty-tag-hint";
        const showHint = () => {
            const n = tagNameOf(nameIn.value);
            hint.textContent = n ? `In a prompt, write #${n}` : "Letters, digits, _ and -";
        };
        nameIn.oninput = showHint; showHint();
        const buttons = doc.createElement("div");
        buttons.className = "agenty-tag-buttons";
        const cancel = doc.createElement("button");
        cancel.type = "button"; cancel.textContent = "Cancel";
        const ok = doc.createElement("button");
        ok.type = "submit"; ok.textContent = "Tag";
        buttons.append(cancel, ok);
        form.append(title, nameRow, roleRow, hint, buttons);
        wrap.append(form);
        const close = () => wrap.remove();
        cancel.onclick = close;
        wrap.onclick = (e) => { if (e.target === wrap) close(); };
        // The viewer has its own hotkeys; typing a name must not trigger them.
        for (const ev of ["keydown", "keyup", "keypress"]) {
            form.addEventListener(ev, (e) => {
                e.stopPropagation();
                if (ev === "keydown" && e.key === "Escape") close();
            });
        }
        form.onsubmit = async (e) => {
            e.preventDefault();
            const name = tagNameOf(nameIn.value);
            if (!name) { nameIn.focus(); return; }
            ok.disabled = true;
            if (await this.agentYTag(fr, name, roleIn.value.trim())) close();
            else ok.disabled = false;
        };
        this.container.appendChild(wrap);
        nameIn.focus(); nameIn.select();
    },
};

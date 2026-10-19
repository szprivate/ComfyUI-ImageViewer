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
//   }
//
// Without it (agentY not installed, or an older one) the two menu rows are simply
// not there, and the group headings, which need nothing from agentY, still are.
//
// Pictures arrive grouped when the node that sent them carried a `group` (the
// stage: "Characters", "Places") and a `label` (what it is: a character's name);
// both are stamped onto each frame by bEpicSendToViewer, so they live as long as
// the picture does in the history.

import { app } from "../../scripts/app.js";

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

    /** The "#name" badge on a picture that was tagged for agentY here. */
    historyAgentTagBadge(doc, snapshot) {
        const p = framePath(snapshot && snapshot[0]);
        const name = p && this._agentTags ? this._agentTags[p] : "";
        if (!name) return null;
        const b = doc.createElement("div");
        b.className = "history-agent-tag";
        b.textContent = `#${name}`;
        b.title = `Tagged for agentY as #${name}`;
        return b;
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
                this._agentTags[framePath(fr)] = r.tag || tag;
                this._historyPanelSig = null;
                this.renderHistoryPanel();
            }
            this._agentYNotify(r && r.message ? r.message : (ok ? `Tagged #${tag}.` : "Could not tag it."),
                               ok ? "success" : "warn");
            return ok;
        } catch (e) {
            this._agentYNotify(`Could not tag it: ${e}`, "error");
            return false;
        }
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

// bEpicViewer_codePanel.js
// "Agent code": a dock panel (#agent-code-panel, dock id "agentCode") that shows
// the code the agent makes - a script it ran, a custom node, a Remotion
// composition, a fenced block in its reply - and any text file opened from the
// file browser. Read-only.
//
// Snippets arrive two ways, both from viewer_code.py:
//   - live: ComfyUI's "bepic.code.update" message (one snippet), and
//   - on open: GET /bepic/code (the recent ones, newest first), so a viewer
//     opened after the agent worked still has the history.
// Files come from GET /bepic/text?path=.
//
// A snippet is {id, title, language, code, source, conversation, turn, ts}. The
// panel only ever shows it as text. To add "edit and send back to the agent"
// later, register an action: viewer.codePanelAddAction({label, run(snippet)}) -
// it gets a button in the toolbar and receives the snippet shown.
import { api } from "../../scripts/api.js";
import { highlight } from "./bEpicViewer_codeHighlight.js";

const MAX_ITEMS = 200;
const MAX_RENDER_LINES = 6000;
const LANGS = ["python", "javascript", "typescript", "tsx", "json", "shell", "markdown", "html", "css", "yaml", "toml", "text"];
const WRAP_KEY = "bepic.viewer.codeWrap";

function store(get, set) {
    try { return get ? window.localStorage.getItem(get) : (window.localStorage.setItem(set[0], set[1]), null); }
    catch (e) { return null; }
}

function timeText(ts) {
    if (!ts) return "";
    const d = new Date(ts * 1000);
    const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return d.toDateString() === new Date().toDateString() ? hm : `${d.toLocaleDateString()} ${hm}`;
}

export const CodePanelMixin = {

    _codeState() {
        if (!this._code) {
            this._code = { items: [], sel: null, wrap: store(WRAP_KEY) === "1", loaded: false,
                           loading: false, actions: [], unseen: 0, ui: null };
        }
        return this._code;
    },

    /** Add a toolbar button that gets the snippet on show ("send back to agent" later). */
    codePanelAddAction(action) {
        if (!action || typeof action.run !== "function") return;
        this._codeState().actions.push(action);
        this._codeRender();
    },

    /** A snippet from the live message. */
    codePanelReceive(snip) {
        const st = this._codeState();
        if (!snip || typeof snip.code !== "string" || !snip.code.trim()) return;
        const had = st.items.findIndex((s) => s.id === snip.id);
        if (had >= 0) st.items.splice(had, 1);
        st.items.unshift(snip);
        st.items.length = Math.min(st.items.length, MAX_ITEMS);
        if (!this.isPanelDocked || !this.isPanelDocked("agentCode")) {
            st.unseen += 1;
            this._codeMarkUnseen();
        } else {
            // Following along: the newest one is what you are here to see.
            st.sel = snip.id;
        }
        this._codeRender();
    },

    /** The history from the server, merged under what already arrived. */
    async codePanelLoad(force = false) {
        const st = this._codeState();
        if ((st.loaded && !force) || st.loading) return;
        st.loading = true;
        try {
            const res = await api.fetchApi("/bepic/code?limit=100");
            if (res.ok) {
                const data = await res.json();
                const have = new Set(st.items.map((s) => s.id));
                const older = (data.snippets || []).filter((s) => s && !have.has(s.id));
                st.items = [...st.items, ...older].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, MAX_ITEMS);
                st.loaded = true;
            }
        } catch (e) { /* no server route (older viewer backend): the panel just starts empty */ }
        st.loading = false;
        this._codeRender();
    },

    /** Show a file (from the file browser) as a snippet of its own. */
    async codePanelOpenFile(file) {
        if (!file || !file.path) return;
        const st = this._codeState();
        const id = "file:" + file.path;
        try {
            const res = await api.fetchApi(`/bepic/text?path=${encodeURIComponent(file.path)}`);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            const snip = { id, title: data.name || file.name, language: data.language || "text",
                           code: data.code || "", source: "file", conversation: "", turn: "",
                           path: data.path, ts: Date.now() / 1000, note: data.truncated ? "file cut at 1 MB" : "" };
            st.items = [snip, ...st.items.filter((s) => s.id !== id)].slice(0, MAX_ITEMS);
        } catch (e) {
            st.items = [{ id, title: file.name, language: "text", code: "", source: "file", ts: Date.now() / 1000,
                          note: `Cannot show this file: ${e.message || e}` },
                        ...st.items.filter((s) => s.id !== id)];
        }
        st.sel = id;
        if (this.setPanelDocked && !this.isPanelDocked("agentCode")) this.setPanelDocked("agentCode", true);
        else this._codeRender();
    },

    _codeMarkUnseen() {
        const st = this._codeState();
        const btn = this.shadowRoot && this.shadowRoot.getElementById("bar-group-comfy");
        if (btn) { btn.classList.toggle("has-code", st.unseen > 0); btn.title = st.unseen > 0 ? `${st.unseen} new code snippet(s) from the agent (ComfyUI > Agent code)` : btn.title; }
    },

    /** Dock calls this when the panel comes up. */
    _codeOnShown() {
        const st = this._codeState();
        st.unseen = 0;
        this._codeMarkUnseen();
        if (!st.sel && st.items.length) st.sel = st.items[0].id;
        this._codeRender();
        this.codePanelLoad();
    },

    // ── drawing ──────────────────────────────────────────────────────────────

    _codeBuild() {
        const st = this._codeState();
        const host = this.agentCodePanel;
        if (!host) return null;
        if (st.ui && st.ui.host === host && st.ui.root.isConnected) return st.ui;
        const doc = host.ownerDocument;
        const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
        host.querySelectorAll(":scope > .ac-root").forEach((n) => n.remove());
        const root = el("div", "ac-root");
        const list = el("div", "ac-list");
        const split = el("div", "ac-split");
        split.title = "Drag to resize the list";
        const bar = el("div", "ac-bar");
        const title = el("span", "ac-title");
        const lang = el("select", "ac-lang");
        lang.title = "Language used for highlighting";
        for (const l of LANGS) lang.append(new Option(l, l));
        const actions = el("span", "ac-actions");
        const wrap = el("button", "ac-btn", "Wrap");
        wrap.title = "Wrap long lines";
        const copy = el("button", "ac-btn", "Copy");
        copy.title = "Copy the code";
        bar.append(title, lang, actions, wrap, copy);
        const note = el("div", "ac-note");
        const view = el("div", "ac-view");
        const empty = el("div", "ac-empty",
            "Code the agent writes shows up here: scripts it runs, custom nodes, files it saves, " +
            "compositions, and code blocks in its replies.");
        root.append(list, split, bar, note, view, empty);
        host.append(root);

        wrap.onclick = () => { st.wrap = !st.wrap; store(null, [WRAP_KEY, st.wrap ? "1" : "0"]); this._codeRender(); };
        copy.onclick = () => this._codeCopy(copy);
        lang.onchange = () => { const s = this._codeCurrent(); if (s) { s.language = lang.value; this._codeRender(); } };
        split.onpointerdown = (e) => {
            e.preventDefault();
            const y0 = e.clientY, h0 = list.getBoundingClientRect().height;
            const move = (ev) => { list.style.height = `${Math.max(40, Math.min(420, h0 + ev.clientY - y0))}px`; };
            const up = () => { doc.removeEventListener("pointermove", move); doc.removeEventListener("pointerup", up); };
            doc.addEventListener("pointermove", move); doc.addEventListener("pointerup", up);
        };
        st.ui = { host, root, list, bar, title, lang, actions, wrap, copy, note, view, empty };
        return st.ui;
    },

    _codeCurrent() {
        const st = this._codeState();
        return st.items.find((s) => s.id === st.sel) || null;
    },

    _codeRender() {
        if (!this.isPanelDocked || !this.isPanelDocked("agentCode")) return;
        const st = this._codeState();
        const ui = this._codeBuild();
        if (!ui) return;
        const doc = ui.host.ownerDocument;
        if (!st.sel || !st.items.some((s) => s.id === st.sel)) st.sel = st.items.length ? st.items[0].id : null;

        // The list: newest first.
        ui.list.replaceChildren();
        for (const s of st.items) {
            const row = doc.createElement("div");
            row.className = "ac-row" + (s.id === st.sel ? " sel" : "");
            row.dataset.id = s.id;
            const t = doc.createElement("div");
            t.className = "ac-row-title"; t.textContent = s.title || "Code";
            const m = doc.createElement("div");
            m.className = "ac-row-meta";
            m.textContent = [s.language, s.source, s.conversation, s.turn, timeText(s.ts)].filter(Boolean).join(" · ");
            row.append(t, m);
            row.title = m.textContent;
            row.onclick = () => { st.sel = s.id; this._codeRender(); };
            ui.list.append(row);
        }
        const cur = this._codeCurrent();
        ui.root.classList.toggle("has-items", !!cur);
        ui.list.style.display = st.items.length > 1 ? "" : "none";
        ui.root.querySelector(".ac-split").style.display = st.items.length > 1 ? "" : "none";
        ui.empty.style.display = cur ? "none" : "";
        ui.bar.style.display = ui.view.style.display = cur ? "" : "none";
        ui.note.style.display = "none";
        ui.wrap.classList.toggle("on", st.wrap);
        ui.actions.replaceChildren();
        if (!cur) return;

        ui.title.textContent = cur.title || "Code";
        ui.title.title = [cur.source, cur.conversation, cur.turn, timeText(cur.ts)].filter(Boolean).join(" · ");
        ui.lang.value = LANGS.includes(cur.language) ? cur.language : "text";
        for (const a of st.actions) {
            const b = doc.createElement("button");
            b.className = "ac-btn"; b.textContent = a.label; if (a.title) b.title = a.title;
            b.onclick = () => a.run(cur);
            ui.actions.append(b);
        }
        if (cur.note) { ui.note.textContent = cur.note; ui.note.style.display = ""; }
        this._codeDraw(ui.view, cur, st.wrap);
    },

    /** The code as numbered lines. Everything goes in through textContent. */
    _codeDraw(view, snip, wrap) {
        const doc = view.ownerDocument;
        view.classList.toggle("wrap", !!wrap);
        const lines = highlight(snip.code || "", snip.language || "text");
        const shown = Math.min(lines.length, MAX_RENDER_LINES);
        const digits = String(lines.length).length;
        view.style.setProperty("--ac-digits", String(Math.max(2, digits)));
        const frag = doc.createDocumentFragment();
        for (let i = 0; i < shown; i++) {
            const line = doc.createElement("div");
            line.className = "ac-line";
            const text = doc.createElement("span");
            text.className = "ac-text";
            const parts = lines[i];
            if (!parts.length) text.textContent = "\n";
            for (const [type, str] of parts) {
                if (!type) { text.append(doc.createTextNode(str)); continue; }
                const s = doc.createElement("span");
                s.className = "tk-" + type; s.textContent = str;
                text.append(s);
            }
            line.append(text);
            frag.append(line);
        }
        if (shown < lines.length) {
            const more = doc.createElement("div");
            more.className = "ac-more";
            more.textContent = `… ${lines.length - shown} more lines (copy takes all of it)`;
            frag.append(more);
        }
        view.replaceChildren(frag);
        view.scrollTop = 0;
    },

    async _codeCopy(button) {
        const cur = this._codeCurrent();
        if (!cur) return;
        let ok = false;
        try { await navigator.clipboard.writeText(cur.code); ok = true; } catch (e) { /* fall back below */ }
        if (!ok) {
            try {
                const doc = this.shadowRoot.ownerDocument;
                const ta = doc.createElement("textarea");
                ta.value = cur.code; ta.style.cssText = "position:fixed;opacity:0";
                doc.body.append(ta); ta.select();
                ok = doc.execCommand("copy"); ta.remove();
            } catch (e) { ok = false; }
        }
        const was = button.textContent;
        button.textContent = ok ? "Copied" : "Copy failed";
        setTimeout(() => { button.textContent = was; }, 1200);
    },
};

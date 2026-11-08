// imageViewer_depsPanel.js
// "Dependencies": what a file was made from, and what was made from it, as a node graph in a tab of the main
// canvas (imageViewer_viewTabs.js) - "deps:<path>". Read-only.
//
// Files are the nodes (with their thumbnail), "made from" are the edges, TOP TO BOTTOM: the plate on top, its
// mask / depth / pose passes below it, the renders made from those below them (imageViewer_depsLayout.js).
// A node whose source changed since it was made is outlined orange (hover says why); a file that is gone is
// greyed out. More than a few sibling passes of one kind fold into one node; a click unfolds it. The prompts
// a file was made with are text boxes right above it, wired into it (the "Prompts" button hides them).
//
//   click a node        open it in the Viewer tab
//   double-click        make it the root (walk from there)
//   drag a node         move it (a prompt box: by its head); its bottom-right corner resizes it
//   drag / wheel        pan / zoom;  F  fit;  "Tidy" puts every node back where the layout puts it
//
// Moved / resized nodes stay where they were left while the tab is open (also through Reload, unfolding and
// the Prompts button); a new root starts from the layout again.
//
// The record is agentY's: every output it makes keeps what its graph loaded. Data comes from
// GET /imageviewer/deps (deps_relay.py), which asks the agentY host.
import { api } from "../../scripts/api.js";
import { layout, edgePath, applyPlacement } from "./imageViewer_depsLayout.js";

export const DEPS_PREFIX = "deps:";
const baseOf = (p) => String(p || "").split(/[\\/]/).pop();
const SVG = "http://www.w3.org/2000/svg";
const KIND_ICON = {
    source: "\u{1F39E}", render: "✨", mask: "\u{1F3AD}", key: "\u{1F511}", depth: "\u{1F30A}", normals: "\u{1F9ED}",
    pose: "\u{1F9CD}", edges: "✏️", flow: "\u{1F4A8}", camera: "\u{1F3A5}", upscale: "\u{1F50D}", derived: "⚙️",
};

/** May this menu target open a Dependencies tab? Anything with a path or a ComfyUI file reference. */
export const depsMayOpen = (ref) => !!(ref && (typeof ref === "string" ? ref : ref.filename));

export const DepsPanelMixin = {

    // ── the tab kind (ViewTabsMixin) ─────────────────────────────────────────

    _depsTabKind() {
        return {
            restore: (key) => {
                const id = key.slice(DEPS_PREFIX.length);
                const m = /^(output|input|temp)\/(?:(.*)\/)?([^/]+)$/.exec(id);
                if (m && !/^[A-Za-z]:[\\/]/.test(id)) {
                    return { path: "", query: { type: m[1], subfolder: m[2] || "", filename: m[3] }, open: new Set(), graph: null };
                }
                return { path: id, open: new Set(), graph: null };
            },
            build: (rec) => this._depsBuild(rec),
            shown: (rec) => { if (!rec.graph && !rec.loading) this._depsLoad(rec); },
            isDirty: () => false,
            dispose: (rec) => { rec.ui = null; },
        };
    },

    /** Open (or bring forward) the Dependencies tab of a file: a path, or {filename, subfolder, type}. */
    depsOpen(ref) {
        if (!depsMayOpen(ref)) return null;
        const path = typeof ref === "string" ? ref : "";
        const query = typeof ref === "string" ? { path } : { filename: ref.filename, subfolder: ref.subfolder || "", type: ref.type || "output" };
        const id = path || `${query.type}/${query.subfolder ? query.subfolder + "/" : ""}${query.filename}`;
        const key = DEPS_PREFIX + id;
        const { rec, existed } = this.vtOpen("deps", key, baseOf(path || query.filename), { path, query, open: new Set(), graph: null });
        if (existed) this._depsLoad(rec);
        return rec;
    },

    /** "Show dependencies" on a context menu (history thumbs). */
    depsAddMenuItem(menu, ref, before) {
        if (!menu || !depsMayOpen(ref)) return;
        const item = menu.ownerDocument.createElement("div");
        item.className = "thumb-ctx-item deps-menu-item";
        item.textContent = "\u{1F517} Show dependencies";
        item.title = "What this was made from, and what was made from it";
        item.onclick = (ev) => { ev.stopPropagation(); menu.remove(); this.depsOpen(ref); };
        if (before && before.parentNode === menu) menu.insertBefore(item, before); else menu.appendChild(item);
    },

    // ── the page ─────────────────────────────────────────────────────────────

    _depsBuild(rec) {
        const doc = rec.el.ownerDocument;
        rec.el.innerHTML = "";
        const root = doc.createElement("div");
        root.className = "dp-root";
        const bar = doc.createElement("div");
        bar.className = "dp-bar";
        const title = doc.createElement("div");
        title.className = "dp-title";
        const btn = (text, tip, fn) => {
            const b = doc.createElement("button");
            b.className = "ac-btn";
            b.textContent = text;
            b.title = tip;
            b.onclick = (e) => { e.stopPropagation(); fn(); };
            return b;
        };
        const promptsBtn = btn("Prompts", "Show the prompts each file was made with, as text boxes above it", () => {
            rec.prompts = rec.prompts === false;
            promptsBtn.classList.toggle("active", rec.prompts !== false);
            this._depsRender(rec);
            this._depsFit(rec);
        });
        promptsBtn.classList.add("dp-prompts-btn");
        promptsBtn.classList.toggle("active", rec.prompts !== false);
        bar.append(title, promptsBtn,
            btn("Fit", "Fit the graph in the view (F)", () => this._depsFit(rec)),
            btn("Tidy", "Put every moved or resized node back where the layout puts it", () => {
                rec.place = {};
                this._depsRender(rec);
                this._depsFit(rec);
            }),
            btn("Look in folder", "Also record older files in this file's folder, then reload", () => this._depsLoad(rec, { scan: true })),
            btn("Reload", "Read the record again", () => this._depsLoad(rec)));
        const note = doc.createElement("div");
        note.className = "dp-note";
        const view = doc.createElement("div");
        view.className = "dp-view";
        view.tabIndex = 0;
        const stage = doc.createElement("div");
        stage.className = "dp-stage";
        const svg = doc.createElementNS(SVG, "svg");
        svg.classList.add("dp-edges");
        stage.append(svg);
        view.append(stage);
        root.append(bar, note, view);
        rec.el.append(root);
        rec.ui = { title, note, view, stage, svg, scale: 1, tx: 0, ty: 0 };
        this._depsPanZoom(rec);
        this._depsLoad(rec);
    },

    async _depsLoad(rec, { scan = false } = {}) {
        if (!rec || !rec.ui) return;
        rec.loading = true;
        const ui = rec.ui;
        ui.note.textContent = scan ? "Looking through the folder…" : "Reading…";
        ui.note.style.display = "block";
        const q = new URLSearchParams(rec.path ? { path: rec.path } : rec.query);
        if (scan) q.set("scan", "1");
        let data = null, err = "";
        try {
            const res = await api.fetchApi(`/imageviewer/deps?${q}`);
            data = await res.json().catch(() => null);
            if (!res.ok) err = (data && data.error) || `the viewer answered ${res.status}`;
        } catch (e) { err = "the viewer backend did not answer"; }
        rec.loading = false;
        if (err || !data) {
            rec.graph = { nodes: [], edges: [] };
            ui.note.textContent = err || "nothing came back";
            this._depsRender(rec);
            return;
        }
        rec.graph = data;
        if (!rec.path && data.root) rec.path = data.root;
        const lone = (data.nodes || []).length <= 1;
        ui.note.textContent = lone
            ? "Nothing recorded for this file yet: no inputs, and nothing made from it. Files agentY makes record "
              + "this as they are written; “Look in folder” records older ones."
            : (data.truncated ? "The graph is large: only part of it is shown." : "");
        ui.note.style.display = ui.note.textContent ? "block" : "none";
        this._depsRender(rec);
        this._depsFit(rec);
    },

    _depsRender(rec) {
        const ui = rec.ui;
        if (!ui) return;
        const doc = ui.stage.ownerDocument;
        for (const el of [...ui.stage.querySelectorAll(".dp-node")]) el.remove();
        rec.place = rec.place || {};
        rec.base = layout(rec.graph || { nodes: [], edges: [] }, { open: rec.open, prompts: rec.prompts !== false });
        const L = applyPlacement(rec.base, rec.place);
        rec.laid = L;
        const files = L.nodes.filter((x) => !x.prompt).length;
        ui.title.textContent = `${baseOf(rec.path || (rec.query && rec.query.filename))} — ${files} file${files === 1 ? "" : "s"}`;
        this._depsEdges(rec);
        for (const n of L.nodes) ui.stage.append(this._depsNodeEl(rec, n, doc));
    },

    /** The stage's size and the edges, from rec.laid (again on every step of a node drag). */
    _depsEdges(rec) {
        const ui = rec.ui, L = rec.laid;
        const doc = ui.stage.ownerDocument;
        ui.svg.innerHTML = "";
        ui.stage.style.width = `${L.width}px`;
        ui.stage.style.height = `${L.height}px`;
        ui.svg.setAttribute("width", String(L.width));
        ui.svg.setAttribute("height", String(L.height));
        for (const e of L.edges) {
            const p = doc.createElementNS(SVG, "path");
            p.setAttribute("d", edgePath(e));
            p.setAttribute("class", e.kind === "prompt" ? "dp-edge dp-edge-prompt" : "dp-edge");
            ui.svg.append(p);
            if (e.label) {
                const t = doc.createElementNS(SVG, "text");
                t.setAttribute("x", String((e.x1 + e.x2) / 2 + 6));
                t.setAttribute("y", String((e.y1 + e.y2) / 2 + 4));
                t.setAttribute("class", "dp-edge-label");
                t.textContent = String(e.label).slice(0, 28);
                ui.svg.append(t);
            }
        }
    },

    /**
     * Make a node box movable (drag it) and resizable (drag its bottom-right corner). The new box goes into
     * rec.place, so it outlasts a re-render; the edges follow on every step. A drag sets ui.dragged, so the
     * click that ends it does not open the file.
     */
    _depsDraggable(rec, el, n) {
        const doc = el.ownerDocument;
        const grip = doc.createElement("div");
        grip.className = "dp-resize";
        grip.title = "Drag to resize";
        el.append(grip);
        el.addEventListener("mousedown", (e) => {
            if (e.button !== 0 || !rec.ui) return;
            e.stopPropagation();   // not a pan
            e.preventDefault();    // no text selection while dragging
            const ui = rec.ui;
            try { ui.view.focus({ preventScroll: true }); } catch (_) { /* keep F working */ }
            const resize = e.target === grip;
            const box = (rec.laid.nodes.find((x) => x.id === n.id)) || n;
            const start = { cx: e.clientX, cy: e.clientY, x: box.x, y: box.y, w: box.w, h: box.h };
            ui.dragged = false;
            el.classList.add(resize ? "resizing" : "moving");
            const win = doc.defaultView || window;
            const move = (ev) => {
                if (!rec.ui) return;
                const dx = (ev.clientX - start.cx) / ui.scale, dy = (ev.clientY - start.cy) / ui.scale;
                if (!ui.dragged && Math.abs(dx) + Math.abs(dy) < 3 / ui.scale) return;
                ui.dragged = true;
                rec.place[n.id] = resize
                    ? { x: start.x, y: start.y, w: start.w + dx, h: start.h + dy }
                    : { x: start.x + dx, y: start.y + dy, w: start.w, h: start.h };
                rec.laid = applyPlacement(rec.base, rec.place);
                const now = rec.laid.nodes.find((x) => x.id === n.id);
                if (now) {
                    el.style.left = `${now.x}px`;
                    el.style.top = `${now.y}px`;
                    el.style.width = `${now.w}px`;
                    el.style.height = `${now.h}px`;
                }
                this._depsEdges(rec);
            };
            const up = () => {
                win.removeEventListener("mousemove", move);
                win.removeEventListener("mouseup", up);
                el.classList.remove("resizing", "moving");
                // The click after a drag is not a click; clear the flag once it has been seen.
                setTimeout(() => { if (rec.ui) rec.ui.dragged = false; }, 0);
            };
            win.addEventListener("mousemove", move);
            win.addEventListener("mouseup", up);
        });
        return el;
    },

    _depsNodeEl(rec, n, doc) {
        if (n.prompt) return this._depsDraggable(rec, this._depsPromptEl(n, doc), n);
        const el = doc.createElement("div");
        el.className = "dp-node";
        if (n.root) el.classList.add("root");
        if (n.stale) el.classList.add("stale");
        if (n.fold) el.classList.add("fold");
        if (!n.fold && !n.exists) el.classList.add("missing");
        el.style.left = `${n.x}px`;
        el.style.top = `${n.y}px`;
        el.style.width = `${n.w}px`;
        el.style.height = `${n.h}px`;
        const thumb = doc.createElement("div");
        thumb.className = "dp-thumb";
        if (n.fold) {
            thumb.textContent = `${KIND_ICON[n.kind] || ""} ${n.count}`;
        } else if (n.viewable) {
            const img = doc.createElement("img");
            img.loading = "lazy";
            img.draggable = false;
            img.src = api.apiURL(`/imageviewer/thumb?path=${encodeURIComponent(n.id)}`);
            img.onerror = () => { img.remove(); thumb.textContent = KIND_ICON[n.kind] || "\u{1F4C4}"; };
            thumb.append(img);
        } else {
            thumb.textContent = KIND_ICON[n.kind] || "\u{1F4C4}";
        }
        const label = doc.createElement("div");
        label.className = "dp-label";
        label.textContent = n.fold ? `${n.count} ${n.kind || "file"} passes` : (n.file || baseOf(n.id));
        const meta = doc.createElement("div");
        meta.className = "dp-meta";
        meta.textContent = n.fold ? "click to unfold" : [n.kind, n.stale ? "out of date" : "", n.exists ? "" : "gone"].filter(Boolean).join(" · ");
        el.append(thumb, label, meta);
        el.title = n.fold ? `${n.count} ${n.kind} passes made from the same file` : [n.id, n.stale ? `Out of date: ${n.stale}` : ""].filter(Boolean).join("\n");
        el.addEventListener("click", (e) => {
            e.stopPropagation();
            if (rec.ui && rec.ui.dragged) return;
            if (n.fold) { rec.open.add(n.id); this._depsRender(rec); return; }
            if (n.viewable) this._depsShowFile(n.id);
        });
        el.addEventListener("dblclick", (e) => {
            e.stopPropagation();
            if (n.fold || !n.exists) return;
            rec.path = n.id;
            rec.query = null;
            rec.open = new Set();
            rec.place = {};
            this._depsLoad(rec);
        });
        return this._depsDraggable(rec, el, n);
    },

    /** A prompt as a text box: its role on top (with Copy), the text below, selectable and scrollable. */
    _depsPromptEl(n, doc) {
        const el = doc.createElement("div");
        el.className = `dp-node dp-prompt dp-prompt-${n.role === "negative" ? "negative" : "positive"}`;
        el.style.left = `${n.x}px`;
        el.style.top = `${n.y}px`;
        el.style.width = `${n.w}px`;
        el.style.height = `${n.h}px`;
        const head = doc.createElement("div");
        head.className = "dp-prompt-head";
        const role = doc.createElement("span");
        role.className = "dp-prompt-role";
        role.textContent = n.role === "negative" ? "negative prompt" : n.role === "positive" ? "prompt" : "text";
        const copy = doc.createElement("button");
        copy.className = "dp-prompt-copy";
        copy.textContent = "Copy";
        copy.title = "Copy the prompt";
        copy.onmousedown = (e) => e.stopPropagation();
        copy.onclick = (e) => {
            e.stopPropagation();
            const done = () => { copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy"; }, 1200); };
            try { navigator.clipboard.writeText(n.text).then(done, () => {}); } catch (_) { /* no clipboard */ }
        };
        head.append(role, copy);
        const text = doc.createElement("div");
        text.className = "dp-prompt-text";
        text.textContent = n.text;
        // Select and scroll the text without panning the graph.
        text.addEventListener("mousedown", (e) => e.stopPropagation());
        text.addEventListener("wheel", (e) => { if (text.scrollHeight > text.clientHeight) e.stopPropagation(); }, { passive: true });
        el.append(head, text);
        el.title = [n.class ? `${n.class} (node ${n.node})` : "", `into ${baseOf(n.of)}`].filter(Boolean).join(" · ");
        el.addEventListener("click", (e) => e.stopPropagation());
        return el;
    },

    async _depsShowFile(path) {
        try {
            const frames = this._browserFramesFor ? (await this._browserFramesFor([path])).filter(Boolean) : [];
            if (frames.length && this.openExternalFramesInViewer) this.openExternalFramesInViewer(frames, baseOf(path));
        } catch (e) { console.warn("imageViewer: could not open", path, e); }
    },

    // ── pan / zoom ───────────────────────────────────────────────────────────

    _depsApply(rec) {
        const ui = rec.ui;
        ui.stage.style.transform = `translate(${ui.tx}px, ${ui.ty}px) scale(${ui.scale})`;
    },

    _depsFit(rec) {
        const ui = rec.ui, L = rec.laid;
        if (!ui || !L) return;
        const vw = ui.view.clientWidth || 800, vh = ui.view.clientHeight || 600;
        const pad = 32;
        ui.scale = Math.max(0.15, Math.min(1.25, (vw - pad * 2) / Math.max(1, L.width), (vh - pad * 2) / Math.max(1, L.height)));
        ui.tx = (vw - L.width * ui.scale) / 2;
        ui.ty = Math.max(pad, (vh - L.height * ui.scale) / 2);
        this._depsApply(rec);
    },

    _depsPanZoom(rec) {
        const ui = rec.ui;
        let drag = null;
        ui.view.addEventListener("mousedown", (e) => {
            if (e.button !== 0 && e.button !== 1) return;
            drag = { x: e.clientX, y: e.clientY, tx: ui.tx, ty: ui.ty };
            ui.dragged = false;
        });
        const win = ui.view.ownerDocument.defaultView || window;
        win.addEventListener("mousemove", (e) => {
            if (!drag || !rec.ui) return;
            const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
            if (Math.abs(dx) + Math.abs(dy) > 3) ui.dragged = true;
            ui.tx = drag.tx + dx;
            ui.ty = drag.ty + dy;
            this._depsApply(rec);
        });
        win.addEventListener("mouseup", () => { drag = null; setTimeout(() => { if (rec.ui) rec.ui.dragged = false; }, 0); });
        ui.view.addEventListener("wheel", (e) => {
            e.preventDefault();
            const r = ui.view.getBoundingClientRect();
            const mx = e.clientX - r.left, my = e.clientY - r.top;
            const k = Math.exp(-e.deltaY * 0.0015);
            const s = Math.max(0.1, Math.min(3, ui.scale * k));
            ui.tx = mx - (mx - ui.tx) * (s / ui.scale);
            ui.ty = my - (my - ui.ty) * (s / ui.scale);
            ui.scale = s;
            this._depsApply(rec);
        }, { passive: false });
        ui.view.addEventListener("keydown", (e) => {
            if (e.key === "f" || e.key === "F") { e.preventDefault(); e.stopPropagation(); this._depsFit(rec); }
        });
    },
};

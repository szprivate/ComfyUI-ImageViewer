// imageViewer_browserInstance.js
// One file browser: a directory listing, a preview pane, and a drag source. The panel comes in instances
// (Sebastian 2026-11-23: "allow me to create as many instances of the panels as I need"): the first one is the
// markup in imageViewer.html and keeps its state on the viewer (st === viewer, so every older caller of
// this._browserDir / this.browseTo still reads and writes it); every further one is made here, with a state
// object of its own. The dock registers the maker (BrowserMixin._initFileBrowser) and places the element.
//
// Dragging a row carries the same `application/x-imageviewer-history` payload a history thumbnail does:
//   • onto the ComfyUI graph → a path-based loader node (see mixinDnD part 2)
//   • onto the viewport      → the file opens in a new viewer tab
import { api } from "../../scripts/api.js";
import { pref, prefKinds, setPref, PREF } from "./imageViewer_settings.js";

// Containers a <video> will actually play. The rest are listed and can be dragged and opened like anything
// else — only the in-panel preview falls back to a poster frame for them.
const _PLAYABLE_VIDEO = /\.(mp4|m4v|mov|webm|ogv)$/i;
const _KIND_GLYPH = { dir: "📁", image: "🖼", video: "🎬", audio: "🔊", model: "🧊", text: "📝", other: "📄" };
const _OPENABLE = new Set(["image", "video", "audio", "model"]);
const _PLAYABLE_AUDIO = /\.(wav|mp3|flac|ogg|oga|m4a|aac|opus|weba)$/i;
const _SEQ_NAME = /^(.*?)(\d+)(\.[^.]+)$/;
const _FOLD_OPTION = "__fold";
const _PREVIEW_DEFAULT = 190;
const _PREVIEW_MIN     = 90;
const _PREVIEW_MAX     = 640;

const KIND_OPTIONS = [
    ["", "All files"], ["image,video,audio,model", "Media only"], ["image", "Images"],
    ["video", "Video"], ["audio", "Audio"], ["model", "3D models"], ["text", "Text & code"],
    ["other", "Everything else"],
];

export function fmtBytes(n) {
    if (!n || n < 0) return "";
    const u = ["B", "KB", "MB", "GB", "TB"];
    let i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

export function fmtDuration(sec) {
    if (!Number.isFinite(sec) || sec <= 0) return "";
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
}

/** The browser's body, as classes (an instance must not repeat the markup's ids). */
function buildDom(host) {
    const doc = host.ownerDocument;
    const el = (tag, cls, attrs = {}) => {
        const n = doc.createElement(tag);
        if (cls) n.className = cls;
        for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
        return n;
    };
    const header = el("div", "browser-header");
    const upBtn = el("button", "browser-btn", { title: "Parent folder (Backspace)" });
    upBtn.textContent = "\u2191";
    const pathIn = el("input", "browser-path", { type: "text", spellcheck: "false",
        placeholder: "ComfyUI input folder", title: "Type or paste a folder path, then press Enter" });
    const rootSel = el("select", "browser-root-sel", { title: "Go to a folder\u2026" });
    const headOpt = el("option"); headOpt.value = ""; headOpt.textContent = "Go to\u2026";
    rootSel.appendChild(headOpt);
    const refreshBtn = el("button", "browser-btn", { title: "Re-read this folder" });
    refreshBtn.textContent = "\u27f3";
    header.append(upBtn, pathIn, rootSel, refreshBtn);

    const filter = el("div", "browser-filter");
    const filterIn = el("input", "browser-filter-in", { type: "text", spellcheck: "false",
        placeholder: "Filter, e.g. *.exr",
        title: "Show only the files whose name matches. Wildcards work (*.exr, frame_??.png); anything else is a plain substring. Separate several with a space or a comma." });
    const clearBtn = el("button", "browser-btn", { title: "Clear the filter" });
    clearBtn.textContent = "\u2715";
    const kindSel = el("select", "browser-kind-sel", { title: "Which kinds of file to list" });
    for (const [value, label] of KIND_OPTIONS) {
        const o = el("option"); o.value = value; o.textContent = label; kindSel.appendChild(o);
    }
    filter.append(filterIn, clearBtn, kindSel);

    const list = el("div", "browser-list", { tabindex: "0" });
    const split = el("div", "browser-split", { title: "Resize the preview" });
    const stage = el("div", "browser-preview-stage");
    const img = el("img", "", { alt: "" });
    const vid = el("video", "", { playsinline: "", muted: "", loop: "", controls: "" });
    const msg = el("div", "browser-preview-msg");
    stage.append(img, vid, msg);
    const meta = el("div", "browser-preview-meta");
    const actions = el("div", "browser-actions");
    const openBtn = el("button", "browser-open");
    openBtn.textContent = "Open in Viewer";
    actions.appendChild(openBtn);
    host.append(header, filter, list, split, stage, meta, actions);
    return { list, pathIn, rootSel, preview: stage, prevImg: img, prevVid: vid, prevMsg: msg, meta,
             openBtn, filterIn, kindSel, upBtn, clearBtn, refreshBtn, split };
}

/** The ui of the markup that is already there (the first browser), by its classes. */
function existingUi(host) {
    const q = (sel) => host.querySelector(sel);
    const stage = q(".browser-preview-stage");
    return {
        list: q(".browser-list"), pathIn: q(".browser-path"), rootSel: q(".browser-root-sel") || q("#browser-root-sel"),
        preview: stage, prevImg: stage && stage.querySelector("img"), prevVid: stage && stage.querySelector("video"),
        prevMsg: q(".browser-preview-msg"), meta: q(".browser-preview-meta"), openBtn: q(".browser-open"),
        filterIn: q(".browser-filter-in"), kindSel: q(".browser-kind-sel") || q("#browser-kind-sel"),
        upBtn: q(".browser-header .browser-btn"), clearBtn: q(".browser-filter .browser-btn"),
        refreshBtn: q(".browser-header .browser-btn:last-of-type"), split: q(".browser-split"),
    };
}

/**
 * Make a browser in `host`. `st` holds everything this browser keeps of its own (the viewer itself for the
 * first one, a fresh object for every further one); `saved` is what a layout carried for it, if anything.
 * Returns the instance the dock keeps: { el, ui, wake, dispose, save, browseTo, ... }.
 */
export function createBrowserInstance(v, host, st, saved) {
    const ui = host.querySelector(".browser-list") ? existingUi(host) : buildDom(host);
    const doc = () => host.ownerDocument;

    st._browserDirs    = [];
    st._browserFiles   = [];
    st._browserEntries = [];         // what the list shows: a file, or a folded sequence
    st._browserSel     = new Set();  // indices into _browserEntries
    st._browserAnchor  = null;       // for shift-range selection
    st._browserLoaded  = false;
    // A start folder set in Settings wins over the one the last session was left in; a new instance starts
    // where the first one is (the maker passes that as `saved`), then walks on its own.
    st._browserDir = st._browserDir || (saved && saved.dir) || String(pref(PREF.browserStart) || "").trim()
                     || v._savedBrowserDir();
    const savedF = v._savedBrowserFilter();
    st._browserFilter = (saved && typeof saved.filter === "string") ? saved.filter : savedF.text;
    // Kinds and folding are settings the controls write back to; what a session kept is taken over once,
    // while the setting is still at its default.
    if (savedF.kinds && !prefKinds()) setPref(PREF.browserKinds, savedF.kinds);
    if (savedF.fold && !pref(PREF.browserFold)) setPref(PREF.browserFold, true);
    st._browserKinds = (saved && typeof saved.kinds === "string") ? saved.kinds : prefKinds();
    st._browserFold  = saved ? !!saved.fold : !!pref(PREF.browserFold);
    if (ui.filterIn) ui.filterIn.value = st._browserFilter;
    syncFoldOption();
    if (ui.kindSel) ui.kindSel.value = st._browserKinds;
    showPath(st._browserDir);
    bindControls();
    setupResizing();
    setPreviewHeight(st._browserPreviewH || (saved && saved.previewH) || _PREVIEW_DEFAULT);
    renderPreview(null);

    // ── The fold switch (the kind menu's last entry) ─────────────────────────

    function syncFoldOption() {
        const sel = ui.kindSel;
        if (!sel) return;
        let opt = sel.querySelector(`option[value="${_FOLD_OPTION}"]`);
        if (!opt) {
            const sep = doc().createElement("option");
            sep.disabled = true;
            sep.textContent = "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500";
            opt = doc().createElement("option");
            opt.value = _FOLD_OPTION;
            sel.append(sep, opt);
        }
        opt.textContent = `${st._browserFold ? "\u2611" : "\u2610"} Fold image sequences`;
        opt.title = "Show a numbered run of images (shot.1001.exr, shot.1002.exr, \u2026) as one entry";
    }

    function toggleFold(on = !st._browserFold) {
        st._browserFold = !!on;
        setPref(PREF.browserFold, st._browserFold);
        syncFoldOption();
        if (v.queuePersistViewerState) v.queuePersistViewerState();
        buildEntries();
        st._browserSel = new Set();
        st._browserAnchor = null;
        renderList();
        renderPreview(null);
    }

    /** What the list shows: each file on its own, or every numbered run of images as one entry. */
    function buildEntries() {
        const files = st._browserFiles || [];
        if (!st._browserFold) { st._browserEntries = files.map((f) => ({ file: f })); return; }
        const groups = new Map();
        files.forEach((f) => {
            const m = f.kind === "image" && _SEQ_NAME.exec(f.name);
            if (!m) return;
            const key = `${m[1]}\u0000${m[3].toLowerCase()}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push({ f, prefix: m[1], digits: m[2], ext: m[3] });
        });
        const inSeq = new Map();
        for (const members of groups.values()) {
            if (members.length < 2) continue;
            members.sort((a, b) => Number(a.digits) - Number(b.digits));
            const first = Number(members[0].digits), last = Number(members[members.length - 1].digits);
            const pad = Math.min(...members.map((x) => x.digits.length));
            const seq = {
                name: `${members[0].prefix}${"#".repeat(Math.max(1, pad))}${members[0].ext}`,
                files: members.map((x) => x.f),
                first, last,
                gaps: last - first + 1 !== members.length,
                size: members.reduce((n, x) => n + (x.f.size || 0), 0),
            };
            seq.path = members[0].f.path.replace(/[^\\/]*$/, "") + seq.name;
            for (const x of members) inSeq.set(x.f, seq);
        }
        const out = [], placed = new Set();
        for (const f of files) {
            const seq = inSeq.get(f);
            if (!seq) { out.push({ file: f }); continue; }
            if (placed.has(seq)) continue;
            placed.add(seq);
            out.push({ seq });
        }
        st._browserEntries = out;
    }

    const entryFiles = (entry) => (!entry ? [] : entry.seq ? entry.seq.files : [entry.file]);
    const entryPath = (entry) => (!entry ? "" : entry.seq ? entry.seq.path : entry.file.path);

    function filterQuery() {
        const parts = [];
        if (st._browserFilter) parts.push(`filter=${encodeURIComponent(st._browserFilter)}`);
        if (st._browserKinds) parts.push(`kinds=${encodeURIComponent(st._browserKinds)}`);
        return parts;
    }

    /** Re-read the folder through the filter, without racing the typing. */
    function filterChanged({ now = false } = {}) {
        st._browserFilter = ui.filterIn ? ui.filterIn.value.trim() : "";
        st._browserKinds = ui.kindSel ? ui.kindSel.value : "";
        setPref(PREF.browserKinds, st._browserKinds || "all");
        if (v.queuePersistViewerState) v.queuePersistViewerState();
        const win = v._viewerWindow();
        if (st._browserFilterTimer) win.clearTimeout(st._browserFilterTimer);
        const run = () => {
            st._browserFilterTimer = null;
            browseTo(st._browserDir, { force: true });
        };
        if (now) run(); else st._browserFilterTimer = win.setTimeout(run, 220);
    }

    function bindControls() {
        if (ui.upBtn) ui.upBtn.onclick = () => { if (st._browserParent) browseTo(st._browserParent); };
        if (ui.filterIn) {
            ui.filterIn.addEventListener("input", () => filterChanged());
            ui.filterIn.addEventListener("keydown", (e) => {
                if (e.key === "Enter") { e.preventDefault(); filterChanged({ now: true }); }
                else if (e.key === "Escape") {
                    e.preventDefault();
                    ui.filterIn.value = "";
                    filterChanged({ now: true });
                }
                e.stopPropagation();          // the viewer's own hotkeys are not wanted here
            });
        }
        if (ui.kindSel) {
            ui.kindSel.onchange = () => {
                if (ui.kindSel.value === _FOLD_OPTION) {
                    ui.kindSel.value = st._browserKinds;
                    toggleFold();
                    return;
                }
                filterChanged({ now: true });
            };
        }
        if (ui.clearBtn) {
            ui.clearBtn.onclick = () => {
                if (ui.filterIn) ui.filterIn.value = "";
                if (ui.kindSel) ui.kindSel.value = "";
                filterChanged({ now: true });
            };
        }
        if (ui.refreshBtn) ui.refreshBtn.onclick = () => browseTo(st._browserDir, { force: true });
        if (ui.rootSel) {
            ui.rootSel.onchange = () => {
                const val = ui.rootSel.value;
                ui.rootSel.selectedIndex = 0;   // it is a jump menu, not a state
                if (val) browseTo(val);
            };
        }
        if (ui.pathIn) {
            ui.pathIn.addEventListener("keydown", (e) => {
                if (e.key === "Enter") { e.preventDefault(); browseTo(ui.pathIn.value.trim()); }
                else if (e.key === "Escape") { ui.pathIn.blur(); showPath(st._browserDir); }
            });
        }
        if (ui.openBtn) ui.openBtn.onclick = () => openSelection();
        if (ui.list) {
            ui.list.addEventListener("keydown", (e) => onListKey(e));
            ui.list.addEventListener("mousedown", (e) => {
                if (e.target === ui.list) setSelection([]);
            });
        }
    }

    // ── Listing ──────────────────────────────────────────────────────────────

    /** Read `dir` (null → the server's default, ComfyUI's input folder) and draw it. */
    async function browseTo(dir, { force = false } = {}) {
        if (!ui.list) return;
        if (!force && dir && dir === st._browserDir) return;

        const token = (st._browseToken = (st._browseToken || 0) + 1);
        setStatus("Reading…");

        let data = null;
        try {
            const parts = dir ? [`path=${encodeURIComponent(dir)}`] : [];
            parts.push(...filterQuery());
            const q = parts.length ? `?${parts.join("&")}` : "";
            const res = await api.fetchApi(`/imageviewer/browse${q}`);
            data = await res.json();
        } catch (e) {
            if (token !== st._browseToken) return;
            setStatus(`Could not reach the server.\n${e.message || e}`);
            return;
        }
        if (token !== st._browseToken) return;   // a later navigation won

        // A folder that could not be read must NOT become the current one. On the FIRST listing, fall back to
        // the server's default rather than opening on an error; after that a bad path is the user's own typing.
        if (!data || !data.path || data.error) {
            if (dir && !st._browserLoaded) {
                browseTo(null, { force: true });
                return;
            }
            fillRoots(data && data.roots);
            const why = (data && data.error) || "Nothing came back.";
            setStatus([dir, why].filter(Boolean).join("\n"));
            return;
        }

        st._browserDir    = data.path;
        st._browserLoaded = true;
        st._browserParent = data.parent || null;
        st._browserDirs   = Array.isArray(data.dirs) ? data.dirs : [];
        st._browserFiles  = Array.isArray(data.files) ? data.files : [];
        st._browserTrunc  = !!data.truncated;
        st._browserFiltered = !!data.filtered;
        buildEntries();
        st._browserSel    = new Set();
        st._browserAnchor = null;

        showPath(data.path);
        fillRoots(data.roots);
        renderList();
        renderPreview(null);
        v.queuePersistViewerState && v.queuePersistViewerState();
    }

    /** Put `dir` in the path field, scrolled to show the END of it (the folder, not the drive prefix). */
    function showPath(dir) {
        const el = ui.pathIn;
        if (!el) return;
        el.value = dir || "";
        el.title = dir || "";
        if (el === el.ownerDocument.activeElement) return;   // don't fight the caret
        try { el.scrollLeft = el.scrollWidth; } catch (e) {}
    }

    function fillRoots(roots) {
        if (!ui.rootSel || !Array.isArray(roots)) return;
        const sig = roots.map(r => r.path).join("|");
        if (sig === st._browserRootSig) return;   // the roots never move
        st._browserRootSig = sig;
        const d = doc();
        const frag = d.createDocumentFragment();
        const head = d.createElement("option");
        head.value = ""; head.textContent = "Go to…"; head.selected = true;
        frag.appendChild(head);
        roots.forEach((r) => {
            const o = d.createElement("option");
            o.value = r.path;
            o.textContent = r.label;
            o.title = r.path;
            frag.appendChild(o);
        });
        ui.rootSel.innerHTML = "";
        ui.rootSel.appendChild(frag);
    }

    function setStatus(text, { keepList = false } = {}) {
        if (!ui.list) return;
        if (!keepList) ui.list.innerHTML = "";
        const el = doc().createElement("div");
        el.className = "browser-status";
        el.textContent = text;
        ui.list.appendChild(el);
    }

    function renderList() {
        if (!ui.list) return;
        const frag = doc().createDocumentFragment();

        if (st._browserParent) {
            frag.appendChild(makeRow({
                glyph: _KIND_GLYPH.dir, name: "..", cls: "is-dir is-up",
                title: st._browserParent,
                onOpen: () => browseTo(st._browserParent),
            }));
        }

        st._browserDirs.forEach((d) => {
            const row = makeRow({
                glyph: _KIND_GLYPH.dir, name: d.name, cls: "is-dir",
                title: d.path,
                onOpen: () => browseTo(d.path),
            });
            row.addEventListener("contextmenu", (e) => contextMenu(e, [d.path]));
            frag.appendChild(row);
        });

        const hint = "Click to preview · double-click to open in the viewer\nDrag onto the graph for a loader node, or onto the viewer to open it\nCtrl+click to add to the selection, Shift+click for a range · right-click to copy the path";
        st._browserEntries.forEach((entry, idx) => {
            const f = entry.file, seq = entry.seq;
            const row = seq ? makeRow({
                glyph: "\ud83c\udf9e",                               // 🎞
                name: seq.name,
                cls: "is-file is-image is-seq",
                meta: `${seq.first}\u2013${seq.last}${seq.gaps ? "*" : ""} \u00b7 ${seq.files.length}`,
                title: `${seq.path}\n${seq.files.length} frames, ${seq.first}\u2013${seq.last}` +
                       (seq.gaps ? " (with gaps)" : "") + ` \u00b7 ${fmtBytes(seq.size)}\n${hint}`,
                onOpen: () => openSelection(seq.files),
                onSelect: (e) => clickFile(idx, e),
            }) : makeRow({
                glyph: _KIND_GLYPH[f.kind] || _KIND_GLYPH.image,
                name: f.name,
                cls: `is-file is-${f.kind}`,
                meta: fmtBytes(f.size),
                title: `${f.path}\n${hint}`,
                onOpen: () => openSelection([f]),
                onSelect: (e) => clickFile(idx, e),
            });
            row.addEventListener("contextmenu", (e) => {
                const picked = st._browserSel.has(idx) ? [...st._browserSel].sort((a, b) => a - b) : [idx];
                contextMenu(e, picked.map((i) => entryPath(st._browserEntries[i])));
            });
            row.dataset.idx = String(idx);
            if (st._browserSel.has(idx)) row.classList.add("selected");
            makeRowDraggable(row, idx);
            frag.appendChild(row);
        });

        ui.list.innerHTML = "";
        ui.list.appendChild(frag);

        if (st._browserDirs.length === 0 && st._browserEntries.length === 0) {
            setStatus(st._browserFiltered
                ? "Nothing here matches the filter."
                : "This folder is empty.", { keepList: true });
        } else if (st._browserTrunc) {
            setStatus(`Showing the first ${st._browserFiles.length} files — this folder holds more.`,
                      { keepList: true });
        }
        syncOpenButton();
    }

    function makeRow({ glyph, name, cls, meta, title, onOpen, onSelect }) {
        const d = doc();
        const row = d.createElement("div");
        row.className = `browser-row ${cls || ""}`.trim();
        if (title) row.title = title;
        const g = d.createElement("span");
        g.className = "b-glyph";
        g.textContent = glyph;
        row.appendChild(g);
        const n = d.createElement("span");
        n.className = "b-name";
        n.textContent = name;
        row.appendChild(n);
        if (meta) {
            const m = d.createElement("span");
            m.className = "b-meta";
            m.textContent = meta;
            row.appendChild(m);
        }
        // Don't preventDefault on mousedown — that kills the native drag start.
        row.addEventListener("mousedown", (e) => e.stopPropagation());
        row.addEventListener("click", (e) => {
            e.stopPropagation();
            if (onSelect) onSelect(e);
        });
        row.addEventListener("dblclick", (e) => {
            e.preventDefault(); e.stopPropagation();
            if (onOpen) onOpen();
        });
        return row;
    }

    // ── Selection ────────────────────────────────────────────────────────────

    function clickFile(idx, e) {
        if (e && (e.ctrlKey || e.metaKey)) {
            const sel = new Set(st._browserSel);
            if (sel.has(idx)) sel.delete(idx); else sel.add(idx);
            st._browserAnchor = idx;
            setSelection([...sel], { preview: idx });
            return;
        }
        if (e && e.shiftKey && st._browserAnchor != null) {
            const lo = Math.min(st._browserAnchor, idx);
            const hi = Math.max(st._browserAnchor, idx);
            const range = [];
            for (let i = lo; i <= hi; i++) range.push(i);
            setSelection(range, { preview: idx });
            return;
        }
        st._browserAnchor = idx;
        setSelection([idx], { preview: idx });
    }

    function setSelection(indices, { preview } = {}) {
        st._browserSel = new Set(indices.filter(i => st._browserEntries[i]));
        if (!ui.list) return;
        ui.list.querySelectorAll(".browser-row.is-file").forEach((row) => {
            row.classList.toggle("selected", st._browserSel.has(Number(row.dataset.idx)));
        });
        const pv = (preview != null) ? preview
                 : (st._browserSel.size === 1 ? [...st._browserSel][0] : null);
        const entry = pv != null ? st._browserEntries[pv] : null;
        renderPreview(entry ? entryFiles(entry)[0] : null, entry && entry.seq);
        syncOpenButton();
    }

    const selectedFiles = () => [...st._browserSel].sort((a, b) => a - b)
        .flatMap(i => entryFiles(st._browserEntries[i]));

    // ── Right-click ──────────────────────────────────────────────────────────

    function contextMenu(e, paths) {
        e.preventDefault();
        e.stopPropagation();
        paths = paths.filter(Boolean);
        if (!paths.length || !v.container) return;
        const d = v.container.ownerDocument;
        v.container.querySelector("#thumb-ctx-menu")?.remove();
        const menu = d.createElement("div");
        menu.id = "thumb-ctx-menu";
        menu.className = "thumb-ctx-menu";
        const item = d.createElement("div");
        item.className = "thumb-ctx-item";
        item.textContent = paths.length > 1 ? `\ud83d\udccb Copy ${paths.length} paths` : "\ud83d\udccb Copy path";
        item.onclick = (ev) => {
            ev.stopPropagation();
            menu.remove();
            v.copyTextToClipboard(paths.join("\n"));
        };
        menu.appendChild(item);
        if (paths.length === 1 && v.mgAddEditItem) v.mgAddEditItem(menu, paths[0]);
        if (paths.length === 1 && v.paintAddEditItem) v.paintAddEditItem(menu, paths[0]);
        const panelRect = v.container.getBoundingClientRect();
        menu.style.left = `${e.clientX - panelRect.left}px`;
        menu.style.top  = `${e.clientY - panelRect.top}px`;
        v.container.appendChild(menu);
        const dismiss = () => { menu.remove(); v.container.removeEventListener("click", dismiss, true); };
        setTimeout(() => v.container.addEventListener("click", dismiss, true), 0);
    }

    function syncOpenButton() {
        if (!ui.openBtn) return;
        const openable = (en) => !!en && (en.seq ? true : _OPENABLE.has(en.file.kind));
        const n = [...st._browserSel].filter((i) => openable(st._browserEntries[i])).length;
        const total = st._browserEntries.filter(openable).length;
        ui.openBtn.disabled = total === 0 && n === 0;
        ui.openBtn.textContent = n > 0
            ? `Open ${n} in Viewer`
            : (total > 0 ? `Open all ${total} in Viewer` : "Nothing to open");
    }

    function onListKey(e) {
        const rows = st._browserEntries;
        if (e.key === "Backspace") {
            e.preventDefault(); e.stopPropagation();
            if (st._browserParent) browseTo(st._browserParent);
            return;
        }
        if (e.key === "Enter") {
            e.preventDefault(); e.stopPropagation();
            openSelection();
            return;
        }
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        if (rows.length === 0) return;
        e.preventDefault(); e.stopPropagation();
        const cur = st._browserAnchor != null ? st._browserAnchor
                  : (e.key === "ArrowDown" ? -1 : rows.length);
        const next = Math.max(0, Math.min(rows.length - 1, cur + (e.key === "ArrowDown" ? 1 : -1)));
        st._browserAnchor = next;
        setSelection([next], { preview: next });
        const row = ui.list.querySelector(`.browser-row.is-file[data-idx="${next}"]`);
        if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
    }

    // ── Preview ──────────────────────────────────────────────────────────────

    function stopPreview() {
        const vid = ui.prevVid;
        if (!vid) return;
        try { vid.pause(); vid.removeAttribute("src"); vid.load(); } catch (_) {}
        vid.style.display = "none";
        vid.muted = true;
        vid.classList.remove("is-audio");
    }

    function renderPreview(file, seq = null) {
        if (!ui.preview) return;
        const img = ui.prevImg, vid = ui.prevVid, msg = ui.prevMsg;

        stopPreview();
        if (img) { img.style.display = "none"; img.removeAttribute("src"); }
        if (msg) msg.style.display = "none";
        st._browserPreviewPath = file ? file.path : null;

        if (!file) {
            if (msg) { msg.textContent = "Select a file to preview it"; msg.style.display = "block"; }
            if (ui.meta) ui.meta.textContent = "";
            return;
        }

        setMeta(file, "", seq);
        const url = v.buildImgUrl({ path: file.path, external: true });

        if (file.kind === "text") {
            if (msg) { msg.textContent = "Double-click to read it in an Agent code tab."; msg.style.display = "block"; }
            return;
        }
        if (!_OPENABLE.has(file.kind)) {
            if (msg) {
                msg.textContent = `${(file.ext || "This file").replace(/^\./, "").toUpperCase()} — ` +
                                  "nothing this viewer can display.";
                msg.style.display = "block";
            }
            return;
        }
        if (file.kind === "model") {
            if (msg) { msg.textContent = "Double-click to view this model in 3D."; msg.style.display = "block"; }
            if (img) {
                img.onload = () => {
                    if (st._browserPreviewPath !== file.path) return;
                    img.style.display = "block";
                };
                img.onerror = null;
                img.src = v.thumbUrl({ kind: "model", path: file.path });
            }
            return;
        }
        if (file.kind === "audio") {
            if (_PLAYABLE_AUDIO.test(file.name) && vid) {
                vid.preload = "metadata";
                vid.muted = false;
                vid.classList.add("is-audio");
                vid.src = url;
                vid.style.display = "block";
                vid.onloadedmetadata = () => {
                    if (st._browserPreviewPath !== file.path) return;
                    setMeta(file, `sound · ${fmtDuration(vid.duration)}`);
                };
                vid.onerror = () => {
                    if (st._browserPreviewPath !== file.path) return;
                    stopPreview();
                    if (msg) { msg.textContent = "The browser can't decode this sound."; msg.style.display = "block"; }
                };
            } else if (msg) {
                msg.textContent = `${file.ext || "This format"} doesn't play in a browser.`;
                msg.style.display = "block";
            }
            return;
        }
        if (file.kind === "video") {
            if (_PLAYABLE_VIDEO.test(file.name) && vid) {
                vid.preload = "metadata";
                vid.src = url;
                vid.style.display = "block";
                vid.onloadedmetadata = () => {
                    if (st._browserPreviewPath !== file.path) return;
                    setMeta(file, `${vid.videoWidth}×${vid.videoHeight} · ${fmtDuration(vid.duration)}`);
                };
                vid.onerror = () => {
                    if (st._browserPreviewPath !== file.path) return;
                    showPoster(file, "This clip's codec isn't one the browser can decode.");
                };
            } else {
                showPoster(file, `${file.ext || "This format"} doesn't play in a browser.`);
            }
            return;
        }

        if (!img) return;
        img.decoding = "async";
        img.onload = () => {
            if (st._browserPreviewPath !== file.path) return;
            img.style.display = "block";
            setMeta(file, `${img.naturalWidth}×${img.naturalHeight}`, seq);
        };
        img.onerror = () => {
            if (st._browserPreviewPath !== file.path) return;
            img.style.display = "none";
            if (msg) { msg.textContent = "This image could not be read."; msg.style.display = "block"; }
        };
        img.src = url;
    }

    /** Fall back to a server-extracted poster frame for a clip nothing can play. */
    async function showPoster(file, why) {
        const msg = ui.prevMsg;
        stopPreview();
        if (msg) { msg.textContent = `${why}\nFetching a poster frame…`; msg.style.display = "block"; }
        const frames = await framesFor([file.path]);
        if (st._browserPreviewPath !== file.path) return;   // selection moved on
        const frame = frames[0];
        const img = ui.prevImg;
        if (frame && frame.thumb && img) {
            img.onload = () => {
                if (st._browserPreviewPath !== file.path) return;
                img.style.display = "block";
                if (msg) msg.style.display = "none";
            };
            img.onerror = () => {
                if (st._browserPreviewPath !== file.path) return;
                if (msg) { msg.textContent = `${why}\nNo poster frame either — it still opens and drags.`; msg.style.display = "block"; }
            };
            img.src = v.thumbUrl(frame);
        } else if (msg) {
            msg.textContent = `${why}\nIt still opens and drags like any other file.`;
        }
        if (frame) {
            const bits = [];
            if (frame.frames) bits.push(`${frame.frames} frames`);
            if (frame.fps)    bits.push(`${Math.round(frame.fps * 100) / 100} fps`);
            setMeta(file, bits.join(" · "));
        }
    }

    function setMeta(file, extra, seq = null) {
        if (!ui.meta) return;
        const bits = [seq ? seq.name : file.name];
        if (seq) bits.push(`${seq.files.length} frames, ${seq.first}\u2013${seq.last}`);
        if (extra) bits.push(extra);
        const size = seq ? seq.size : file.size;
        if (size) bits.push(fmtBytes(size));
        ui.meta.textContent = bits.join("  ·  ");
        ui.meta.title = seq ? seq.path : file.path;
    }

    // ── Drag out ─────────────────────────────────────────────────────────────

    function dragItem(file) {
        if (!file || !file.path) return null;
        if (!_OPENABLE.has(file.kind)) return null;
        return {
            path: file.path, url: null,
            filename: file.name, subfolder: "", type: null,
            external: true, dropped: false,
            kind: file.kind === "video" || file.kind === "audio" || file.kind === "model" ? file.kind : "image",
            thumb: null, isSequence: false, seqDir: null, seqCount: 0,
        };
    }

    function seqDragItem(seq) {
        const first = seq.files[0];
        return {
            ...dragItem(first),
            isSequence: true,
            seqDir: first.path.replace(/[\\/][^\\/]*$/, ""),
            seqCount: seq.files.length,
        };
    }

    function makeRowDraggable(row, idx) {
        row.draggable = true;
        row.addEventListener("dragstart", (e) => {
            const picked = st._browserSel.has(idx)
                ? [...st._browserSel].sort((a, b) => a - b).map((i) => st._browserEntries[i])
                : [st._browserEntries[idx]];
            const items = picked.filter(Boolean)
                .map((en) => (en.seq ? seqDragItem(en.seq) : dragItem(en.file)))
                .filter(Boolean);
            if (items.length === 0) { e.preventDefault(); return; }
            try {
                e.dataTransfer.setData("application/x-imageviewer-history", JSON.stringify({ items }));
                e.dataTransfer.effectAllowed = "copy";
            } catch (_) {}
        });
    }

    // ── Opening into the viewer ──────────────────────────────────────────────

    /** Frames for `paths`, from the server, so videos arrive with fps and a poster. */
    async function framesFor(paths) {
        if (!paths || paths.length === 0) return [];
        let data = null;
        try {
            const res = await api.fetchApi("/imageviewer/browse_frames", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ paths }),
            });
            data = await res.json();
        } catch (e) {
            console.warn("[ImageViewer] browse_frames failed", e);
            return [];
        }
        const frames = (data && Array.isArray(data.frames)) ? data.frames : [];
        const norm = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();
        const byPath = new Map(frames.map(f => [norm(f.paint || f.path), f]));
        return paths.map(p => byPath.get(norm(p)) || null);
    }

    /** Open the current selection — or the whole folder when nothing is picked. */
    async function openSelection(files) {
        const picked = files || selectedFiles();
        const all    = picked.length > 0 ? picked : st._browserFiles;
        const list   = all.filter((f) => _OPENABLE.has(f.kind));
        const cuts = picked.filter((f) => f.kind === "cut");
        if (list.length === 0 && cuts.length && v.editTlOpenPath) {
            for (const f of cuts) await v.editTlOpenPath(f.path);
            return;
        }
        const paints = picked.filter((f) => f.kind === "paint");
        if (list.length === 0 && paints.length && v.paintOpen) {
            for (const f of paints) await v.paintOpen(f.path);
            return;
        }
        const texts = picked.filter((f) => f.kind === "text");
        if (list.length === 0 && texts.length && /lora_datasets[\\/][^\\/]+[\\/]manifest\.json$/i.test(texts[0].path || "") && v.loraOpen) {
            v.loraOpen(texts[0].path);
            return;
        }
        if (list.length === 0 && texts.length && /\.mgscene\.json$/i.test(texts[0].path || "") && v.mgOpenFile) {
            v.mgOpenFile(texts[0].path);
            return;
        }
        if (list.length === 0 && texts.length && /\.comp\.json$/i.test(texts[0].path || "") && v.compOpenFile) {
            v.compOpenFile(texts[0].path);
            return;
        }
        if (list.length === 0 && texts.length && v.codePanelOpenFile) {
            v.codePanelOpenFile(texts[0]);
            return;
        }
        if (list.length === 0) {
            if (all.length) {
                setStatus(all.length === 1
                    ? "There is nothing to show for that file."
                    : "None of those are files this viewer can open.", { keepList: true });
            }
            return;
        }

        const label = st._browserDir
            ? (st._browserDir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || st._browserDir)
            : "files";

        if (ui.openBtn) ui.openBtn.disabled = true;
        try {
            const frames = (await framesFor(list.map(f => f.path))).filter(Boolean);
            if (frames.length === 0) {
                setStatus("None of those files could be read.", { keepList: true });
                return;
            }
            v.openExternalFramesInViewer(frames, list.length === 1 ? list[0].name : label);
        } finally {
            syncOpenButton();
        }
    }

    // ── Panel sizing ─────────────────────────────────────────────────────────

    function setPreviewHeight(px) {
        const h = Math.round(Math.max(_PREVIEW_MIN, Math.min(_PREVIEW_MAX, px)));
        st._browserPreviewH = h;
        if (ui.preview) ui.preview.style.height = `${h}px`;
    }

    function setupResizing() {
        const win = () => (v.container && v.container.ownerDocument.defaultView) || window;
        if (ui.split) ui.split.onmousedown = (e) => {
            e.preventDefault();
            const w = win();
            const startY = e.clientY;
            const startH = st._browserPreviewH || _PREVIEW_DEFAULT;
            const onMove = (ev) => setPreviewHeight(startH - (ev.clientY - startY));
            const onUp = () => {
                w.removeEventListener("mousemove", onMove);
                w.removeEventListener("mouseup", onUp);
            };
            w.addEventListener("mousemove", onMove);
            w.addEventListener("mouseup", onUp);
        };
    }

    // ── The instance the dock keeps ──────────────────────────────────────────

    return {
        el: host,
        ui,
        browseTo,
        renderList,
        toggleFold,
        filterChanged,
        openSelection,
        stopPreview,
        setPreviewHeight,
        selectedFiles,
        framesFor,
        /** The panel came into view: read the folder the first time, after that the listing it holds is good. */
        wake() {
            if (!st._browserLoaded) browseTo(st._browserDir || null, { force: true });
            else renderList();
        },
        save() {
            return { dir: st._browserDir || null, filter: st._browserFilter || "",
                     kinds: st._browserKinds || "", fold: !!st._browserFold,
                     previewH: st._browserPreviewH || null };
        },
        dispose() {
            stopPreview();
            if (st._browserFilterTimer) {
                try { v._viewerWindow().clearTimeout(st._browserFilterTimer); } catch (_) { /* gone */ }
                st._browserFilterTimer = null;
            }
        },
    };
}
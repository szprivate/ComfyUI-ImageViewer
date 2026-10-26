// bEpicViewer_loraEditor.js
// The Dataset panel: review and edit a LoRA training dataset an agent prepared (DATASET tab) and watch
// the training run that follows (TRAINING tab). The files are the contract in agentY-core
// (agenty_core/tools/lora_training/formats.py); the routes are lora_io.py (/bepic/lora/*).
//
// It is a plain function over a host element - no dependency on the viewer's element or on ComfyUI -
// so the viewer's tab (bEpicViewer_loraPanel.js) and the standalone test page (tests/harness_lora)
// mount the same thing. What it needs from its surroundings arrives in `opts`:
//   api.datasets() / api.dataset(name) / api.save(name, manifest) / api.review(name, action, note, manifest)
//   api.runs() / api.run(name) / api.control(name, keep)            -> Promise<json> (throw on error)
//   fileUrl(path)            -> a url the browser can load for a file under a dataset / run folder
//   notify(text, severity)   -> a toast
//   sendToAgent(text)        -> Promise, tells agentY (when it runs); may be missing
//   isOpen()                 -> is the page on screen (polling backs off when it is not)
//   onDataset(name)          -> a dataset was opened in it (the viewer titles the tab with it)
// The edits themselves are pure functions in bEpicViewer_loraModel.js.
import * as Mo from "./bEpicViewer_loraModel.js";

const ORANGE = "#ff6a1a";
const VIDEO_RE = /\.(mp4|webm|mov|mkv)$/i;

const CSS = `
.lr-root{display:flex;flex-direction:column;height:100%;min-height:0;background:#1b1b1f;color:#d8d8dc;font:12px/1.35 system-ui,Segoe UI,sans-serif;position:relative}
.lr-root *{box-sizing:border-box}
.lr-tabs{display:flex;border-bottom:1px solid #2c2c32;flex:none}
.lr-tab{padding:6px 14px;cursor:pointer;opacity:.6;border-bottom:2px solid transparent;letter-spacing:.06em;font-weight:600;font-size:11px}
.lr-tab.on{opacity:1;border-bottom-color:${ORANGE}}
.lr-spacer{flex:1}
.lr-page{flex:1;min-height:0;display:flex;flex-direction:column}
.lr-bar{display:flex;gap:6px;align-items:center;padding:5px 8px;border-bottom:1px solid #2c2c32;flex-wrap:wrap;flex:none}
.lr-btn{background:#2b2b31;border:1px solid #3a3a42;color:#d8d8dc;border-radius:3px;padding:2px 8px;cursor:pointer;font:inherit}
.lr-btn:hover{background:#35353d}.lr-btn[disabled]{opacity:.4;cursor:default}
.lr-btn.go{background:${ORANGE};border-color:${ORANGE};color:#111;font-weight:600}.lr-btn.go:hover{filter:brightness(1.1)}
.lr-btn.warn{border-color:#8a4a3a;color:#f0a090}
.lr-in{background:#141418;border:1px solid #34343c;color:#e6e6ea;border-radius:2px;padding:1px 4px;font:inherit;min-width:0}
.lr-sel{max-width:240px}
.lr-sum{padding:6px 10px;border-bottom:1px solid #2c2c32;flex:none;line-height:1.5}
.lr-sum b{color:#fff}.lr-pill{display:inline-block;padding:0 6px;border-radius:8px;background:#2b2b31;margin-right:4px;font-size:11px}
.lr-pill.approved{background:#24402a;color:#9fe0ac}.lr-pill.changes{background:#4a3a1c;color:#f5c97a}.lr-pill.cancelled{background:#442626;color:#f0a0a0}
.lr-warn{color:#f5c97a;font-size:11px}
.lr-scroll{flex:1;min-height:0;overflow:auto;padding:8px}
.lr-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:8px}
.lr-card{background:#212126;border:1px solid #2f2f36;border-radius:4px;display:flex;flex-direction:column;overflow:hidden}
.lr-card.sel{border-color:${ORANGE}}
.lr-thumb{position:relative;aspect-ratio:1/1;background:#0f0f12;user-select:none;touch-action:none;cursor:crosshair;overflow:hidden}
.lr-thumb img,.lr-thumb video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none}
.lr-crop{position:absolute;border:1px solid ${ORANGE};box-shadow:0 0 0 999px rgba(0,0,0,.55);pointer-events:none}
.lr-chk{position:absolute;left:4px;top:4px;z-index:2;cursor:pointer}
.lr-id{position:absolute;right:4px;top:4px;z-index:2;font-size:10px;background:rgba(0,0,0,.6);padding:0 4px;border-radius:2px}
.lr-flag{position:absolute;left:4px;bottom:4px;z-index:2;font-size:10px;background:rgba(120,70,0,.85);padding:0 4px;border-radius:2px}
.lr-cap{width:100%;min-height:64px;resize:vertical;border:0;border-top:1px solid #2f2f36;border-radius:0}
.lr-row{display:flex;gap:4px;padding:3px 4px;align-items:center}
.lr-h{margin:12px 0 6px;font-size:11px;text-transform:uppercase;opacity:.6;font-weight:600;letter-spacing:.06em}
.lr-removed{display:flex;gap:8px;align-items:center;padding:3px 0;border-bottom:1px solid #26262c}
.lr-removed img{width:44px;height:44px;object-fit:cover;background:#0f0f12;flex:none}
.lr-removed .why{flex:1;min-width:0;opacity:.8}
.lr-empty{padding:24px;opacity:.6}
.lr-note{position:absolute;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:20}
.lr-note>div{background:#222228;border:1px solid #444;border-radius:4px;padding:12px;width:min(420px,90%);display:flex;flex-direction:column;gap:8px}
.lr-note textarea{height:90px;resize:vertical}
.lr-dirty{color:${ORANGE};font-weight:700}
.lr-card-run{margin:8px;padding:10px;background:#212126;border:1px solid #2f2f36;border-radius:4px}
.lr-prog{height:10px;background:#141418;border-radius:5px;overflow:hidden;margin:6px 0}
.lr-prog>i{display:block;height:100%;background:${ORANGE};transition:width .4s}
.lr-stats{display:flex;gap:14px;flex-wrap:wrap;font-variant-numeric:tabular-nums}
.lr-stats span em{font-style:normal;opacity:.55;margin-right:4px}
.lr-spark{width:100%;height:64px;background:#141418;border:1px solid #2c2c32;margin-top:8px}
.lr-spark path{fill:none;stroke:${ORANGE};stroke-width:1.5;vector-effect:non-scaling-stroke}
.lr-spark path.raw{stroke:#5a5a64;stroke-width:1}
.lr-log{white-space:pre-wrap;font:11px/1.35 Consolas,monospace;background:#101014;border:1px solid #2c2c32;padding:6px;max-height:220px;overflow:auto;margin-top:6px}
.lr-strip{display:flex;gap:6px;overflow-x:auto;padding-bottom:4px}
.lr-step{flex:none;border:1px solid #2f2f36;border-radius:4px;padding:4px;background:#1f1f24}
.lr-step.latest{border-color:${ORANGE}}
.lr-step h5{margin:0 0 3px;font-size:11px;opacity:.7;font-weight:600}
.lr-step .f{display:flex;gap:3px}
.lr-sample{width:96px;height:96px;object-fit:cover;background:#0f0f12;cursor:zoom-in;display:block}
.lr-events{list-style:none;margin:0;padding:0}
.lr-events li{padding:2px 0;border-bottom:1px solid #26262c}
.lr-events .k{display:inline-block;min-width:68px;opacity:.6}
.lr-events .k.failed{color:#f0a0a0}.lr-events .k.finished{color:#9fe0ac}
.lr-light{position:absolute;inset:0;background:rgba(0,0,0,.88);z-index:30;display:flex;gap:10px;align-items:center;justify-content:center;padding:14px;overflow:auto}
.lr-light figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:4px;max-width:48%}
.lr-light.one figure{max-width:90%}
.lr-light img,.lr-light video{max-width:100%;max-height:80vh;object-fit:contain}
.lr-toast{position:absolute;right:8px;bottom:8px;background:#2b2b31;border:1px solid #444;padding:4px 8px;border-radius:3px;z-index:40;max-width:70%}
`;

const el = (doc, tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
};
const isVideo = (path) => VIDEO_RE.test(String(path || ""));
const joinPath = (dir, rel) => `${String(dir).replace(/[\\/]+$/, "")}/${String(rel).replace(/^[\\/]+/, "")}`;
const msgOf = (e) => String((e && e.message) || e || "");

export function createLoraEditor(host, opts) {
    const doc = host.ownerDocument;
    const api = opts.api;
    const storage = (() => { try { return host.ownerDocument.defaultView.localStorage; } catch (_) { return null; } })();
    const store = {
        get: (k) => { try { return storage ? storage.getItem(k) : null; } catch (_) { return null; } },
        set: (k, v) => { try { if (storage) storage.setItem(k, v); } catch (_) { /* no storage */ } },
    };

    const S = {
        tab: "dataset",
        datasets: [], name: "", dir: "", saved: null, m: null, review: { state: "none" },
        selected: new Set(), history: new Mo.History(), find: "", repl: "", rewrite: true,
        runs: [], run: "", runData: null, pickedRun: false, seenRuns: null, offered: "", showLog: false, lastEvent: {}, timer: 0, disposed: false,
        busy: false,
    };

    host.textContent = "";
    const style = el(doc, "style");
    style.textContent = CSS;
    const root = el(doc, "div", "lr-root");
    root.tabIndex = -1;
    host.append(style, root);

    const tabs = el(doc, "div", "lr-tabs");
    const tabDs = el(doc, "div", "lr-tab", "DATASET");
    const tabTr = el(doc, "div", "lr-tab", "TRAINING");
    tabs.append(tabDs, tabTr);
    const pageDs = el(doc, "div", "lr-page");
    const pageTr = el(doc, "div", "lr-page");
    root.append(tabs, pageDs, pageTr);
    // The viewer has its own hotkeys; typing in a caption must not trigger them.
    for (const ev of ["keydown", "keyup", "keypress"]) root.addEventListener(ev, (e) => e.stopPropagation());

    function toast(msg, sev) {
        try { if (opts.notify) { opts.notify(msg, sev); return; } } catch (_) { /* fall through */ }
        const t = el(doc, "div", "lr-toast", msg);
        root.append(t);
        setTimeout(() => t.remove(), 4000);
    }

    function setTab(t) {
        S.tab = t;
        tabDs.classList.toggle("on", t === "dataset");
        tabTr.classList.toggle("on", t === "training");
        pageDs.style.display = t === "dataset" ? "flex" : "none";
        pageTr.style.display = t === "training" ? "flex" : "none";
        if (t === "training") pollNow();
    }
    tabDs.onclick = () => setTab("dataset");
    tabTr.onclick = () => setTab("training");

    // ── DATASET tab ───────────────────────────────────────────────────────────

    const dsBar = el(doc, "div", "lr-bar");
    const picker = el(doc, "select", "lr-in lr-sel");
    const btnRefresh = el(doc, "button", "lr-btn", "Refresh");
    dsBar.append(picker, btnRefresh);
    const dsSum = el(doc, "div", "lr-sum");
    const dsTools = el(doc, "div", "lr-bar");
    const dsScroll = el(doc, "div", "lr-scroll");
    const dsFoot = el(doc, "div", "lr-bar");
    pageDs.append(dsBar, dsSum, dsTools, dsScroll, dsFoot);

    const trigIn = el(doc, "input", "lr-in");
    trigIn.placeholder = "trigger word"; trigIn.size = 12;
    const rewriteChk = el(doc, "input"); rewriteChk.type = "checkbox"; rewriteChk.checked = true;
    const rewriteLbl = el(doc, "label", "", "rewrite captions");
    rewriteLbl.prepend(rewriteChk);
    const findIn = el(doc, "input", "lr-in"); findIn.placeholder = "find"; findIn.size = 12;
    const replIn = el(doc, "input", "lr-in"); replIn.placeholder = "replace with"; replIn.size = 12;
    const btnReplace = el(doc, "button", "lr-btn", "Replace in captions");
    const btnSelAll = el(doc, "button", "lr-btn", "Select all");
    const btnRemove = el(doc, "button", "lr-btn warn", "Remove");
    const btnUndo = el(doc, "button", "lr-btn", "Undo");
    dsTools.append(trigIn, rewriteLbl, el(doc, "span", "lr-spacer"), findIn, replIn, btnReplace,
        el(doc, "span", "lr-spacer"), btnSelAll, btnRemove, btnUndo);

    const dirtyMark = el(doc, "span", "lr-dirty", "");
    const btnSave = el(doc, "button", "lr-btn", "Save");
    const btnApprove = el(doc, "button", "lr-btn go", "Approve & train");
    const btnAsk = el(doc, "button", "lr-btn", "Ask the agent");
    const btnCancel = el(doc, "button", "lr-btn warn", "Cancel");
    dsFoot.append(dirtyMark, btnSave, el(doc, "span", "lr-spacer"), btnAsk, btnCancel, btnApprove);

    const dirty = () => !!(S.m && S.saved && Mo.isDirty(S.saved, S.m));
    const fileUrl = (rel) => opts.fileUrl(joinPath(S.dir, rel));

    function edit(fn) {
        if (!S.m) return;
        S.history.push(S.m);
        const r = fn(S.m);
        Mo.recount(S.m);
        renderDataset();
        return r;
    }

    function renderSummary() {
        dsSum.textContent = "";
        if (!S.m) {
            dsSum.append(el(doc, "span", "", S.datasets.length ? "Pick a dataset." : "No LoRA datasets yet. Ask agentY to prepare one."));
            return;
        }
        const m = S.m, s = Mo.summary(m);
        const line = el(doc, "div");
        const b = (t) => { const x = el(doc, "b", "", t); return x; };
        line.append(b(m.subject || m.name), ` - ${m.kind || ""} LoRA on ${m.model || "?"}  `);
        line.append(el(doc, "span", `lr-pill ${S.review.state}`, `review: ${S.review.state || "none"}`),
            el(doc, "span", "lr-pill", `status: ${m.status || "draft"}`));
        dsSum.append(line);
        const l2 = el(doc, "div");
        const buckets = (m.buckets || []).map((x) => x.join("x")).join(", ") || "-";
        l2.append(b(String(s.included)), ` of ${s.count} items included (${s.removed} removed) - buckets ${buckets} - trigger `,
            b(m.trigger_word || "(none)"), ` - captions: ${m.caption_style || "-"}`);
        dsSum.append(l2);
        const issues = Mo.captionIssues(m);
        const warns = [...s.warnings];
        if (issues.length) warns.push(`${issues.length} caption${issues.length > 1 ? "s" : ""} need a look (empty or without the trigger word)`);
        if (S.review.note && S.review.state === "changes") warns.push(`your note: ${S.review.note}`);
        for (const w of warns) dsSum.append(el(doc, "div", "lr-warn", "! " + w));
    }

    function attachCrop(thumb, it) {
        const rect = el(doc, "div", "lr-crop");
        const paint = () => {
            const c = it.crop;
            rect.style.display = c ? "block" : "none";
            if (c) Object.assign(rect.style, { left: c[0] * 100 + "%", top: c[1] * 100 + "%", width: c[2] * 100 + "%", height: c[3] * 100 + "%" });
        };
        paint();
        thumb.append(rect);
        let start = null;
        const pt = (e) => {
            const r = thumb.getBoundingClientRect();
            return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
        };
        thumb.addEventListener("pointerdown", (e) => {
            if (e.button !== 0 || e.target.closest(".lr-chk")) return;
            start = pt(e);
            thumb.setPointerCapture?.(e.pointerId);
            e.preventDefault();
        });
        thumb.addEventListener("pointermove", (e) => {
            if (!start) return;
            const c = Mo.cropFromDrag(start, pt(e));
            if (c) Object.assign(rect.style, { display: "block", left: c[0] * 100 + "%", top: c[1] * 100 + "%", width: c[2] * 100 + "%", height: c[3] * 100 + "%" });
        });
        const end = (e) => {
            if (!start) return;
            const a = start, b = pt(e);
            start = null;
            thumb.releasePointerCapture?.(e.pointerId);
            if (Math.abs(a[0] - b[0]) < 0.02 && Math.abs(a[1] - b[1]) < 0.02) { paint(); return; }   // a click, not a drag
            const c = Mo.cropFromDrag(a, b);
            edit((m) => Mo.setCrop(m, it.id, c));
        };
        thumb.addEventListener("pointerup", end);
        thumb.addEventListener("pointercancel", () => { start = null; paint(); });
        thumb.addEventListener("dblclick", () => { if (it.crop) edit((m) => Mo.setCrop(m, it.id, null)); });
    }

    function media(it, cls) {
        if (it.kind === "video" || isVideo(it.file)) {
            const v = el(doc, "video", cls);
            v.muted = true; v.loop = true; v.preload = "metadata"; v.src = fileUrl(it.file);
            return v;
        }
        const i = el(doc, "img", cls);
        i.loading = "lazy"; i.draggable = false; i.src = fileUrl(it.file);
        return i;
    }

    function card(it) {
        const c = el(doc, "div", "lr-card" + (S.selected.has(it.id) ? " sel" : ""));
        const thumb = el(doc, "div", "lr-thumb");
        thumb.title = "Drag to crop, double-click to clear the crop";
        const mediaEl = media(it);
        thumb.append(mediaEl);
        if (mediaEl.tagName === "VIDEO") {
            thumb.addEventListener("pointerenter", () => mediaEl.play().catch(() => {}));
            thumb.addEventListener("pointerleave", () => mediaEl.pause());
        }
        const chk = el(doc, "input", "lr-chk"); chk.type = "checkbox"; chk.checked = S.selected.has(it.id);
        chk.onchange = () => { if (chk.checked) S.selected.add(it.id); else S.selected.delete(it.id); c.classList.toggle("sel", chk.checked); updateTools(); };
        thumb.append(chk, el(doc, "div", "lr-id", it.id));
        if (it.crop) thumb.append(el(doc, "div", "lr-flag", "cropped"));
        attachCrop(thumb, it);
        const cap = el(doc, "textarea", "lr-in lr-cap");
        cap.value = it.caption || "";
        cap.placeholder = "caption";
        cap.spellcheck = false;
        let pushed = false;
        cap.addEventListener("input", () => {
            if (!pushed) { S.history.push(S.m); pushed = true; }
            Mo.setCaption(S.m, it.id, cap.value);
            updateDirty();
        });
        cap.addEventListener("change", () => { pushed = false; renderSummary(); });
        const row = el(doc, "div", "lr-row");
        const inc = el(doc, "label", "", "include");
        const incChk = el(doc, "input"); incChk.type = "checkbox"; incChk.checked = true;
        incChk.onchange = () => edit((m) => Mo.toggleItem(m, it.id));
        inc.prepend(incChk);
        const note = el(doc, "span", "", it.size ? `${it.size[0]}x${it.size[1]}` : "");
        note.style.opacity = ".55";
        row.append(inc, el(doc, "span", "lr-spacer"), note);
        if (it.note) c.title = it.note;
        c.append(thumb, cap, row);
        return c;
    }

    function renderItems() {
        dsScroll.textContent = "";
        if (!S.m) { dsScroll.append(el(doc, "div", "lr-empty", "Nothing open.")); return; }
        const { kept, removed } = Mo.split(S.m);
        const grid = el(doc, "div", "lr-grid");
        for (const it of kept) grid.append(card(it));
        if (!kept.length) dsScroll.append(el(doc, "div", "lr-empty", "Every item is removed. Restore some below."));
        dsScroll.append(grid);
        if (removed.length) {
            dsScroll.append(el(doc, "div", "lr-h", `Removed (${removed.length})`));
            for (const it of removed) {
                const r = el(doc, "div", "lr-removed");
                const im = media(it);
                im.removeAttribute("loading");
                const why = el(doc, "div", "why", `${it.id} - removed by ${it.removed_by || "?"}${it.note ? ": " + it.note : ""}`);
                const b = el(doc, "button", "lr-btn", "Restore");
                b.onclick = () => edit((m) => Mo.restoreItem(m, it.id));
                r.append(im, why, b);
                dsScroll.append(r);
            }
        }
    }

    function updateDirty() {
        dirtyMark.textContent = dirty() ? "* unsaved changes " : "";
        btnSave.disabled = !dirty() || S.busy;
        btnUndo.disabled = !S.history.canUndo;
    }

    function updateTools() {
        const has = !!S.m;
        const training = has && S.m.status === "training";
        for (const b of [btnReplace, btnSelAll, btnRemove, btnApprove, btnAsk, btnCancel, trigIn, findIn, replIn]) b.disabled = !has || training || S.busy;
        btnRemove.disabled = btnRemove.disabled || !S.selected.size;
        btnRemove.textContent = S.selected.size ? `Remove ${S.selected.size}` : "Remove";
        btnReplace.textContent = S.selected.size ? `Replace in ${S.selected.size} selected` : "Replace in all captions";
        btnSelAll.textContent = has && S.selected.size === Mo.split(S.m).kept.length ? "Select none" : "Select all";
        updateDirty();
    }

    function renderDataset() {
        for (const id of [...S.selected]) {
            const it = S.m && Mo.itemById(S.m, id);
            if (!it || !Mo.isIncluded(it)) S.selected.delete(id);
        }
        if (S.m && trigIn.getRootNode().activeElement !== trigIn) trigIn.value = S.m.trigger_word || "";
        renderSummary();
        renderItems();
        updateTools();
    }

    function renderPicker() {
        picker.textContent = "";
        const blank = el(doc, "option", "", S.datasets.length ? "- pick a dataset -" : "(no datasets)");
        blank.value = "";
        picker.append(blank);
        for (const d of S.datasets) {
            const o = el(doc, "option", "", `${d.name}  [${d.included}/${d.count}]  ${d.review !== "none" ? d.review : d.status}`);
            o.value = d.name;
            picker.append(o);
        }
        picker.value = S.name;
    }

    async function loadList() {
        try {
            const r = await api.datasets();
            S.datasets = r.datasets || [];
        } catch (e) { toast("Cannot list datasets: " + msgOf(e), "error"); S.datasets = []; }
        renderPicker();
    }

    async function open(name, { force = false } = {}) {
        if (!name) { S.name = ""; S.m = null; S.saved = null; renderPicker(); renderDataset(); return false; }
        if (!force && dirty() && name !== S.name && !confirm("Discard the unsaved changes?")) { picker.value = S.name; return false; }
        try {
            const r = await api.dataset(name);
            S.name = r.name; S.dir = r.dir; S.m = r.manifest; S.review = r.review || { state: "none" };
            S.saved = Mo.clone(r.manifest); S.selected.clear(); S.history = new Mo.History();
        } catch (e) { toast("Cannot open the dataset: " + msgOf(e), "error"); return false; }
        if (!S.datasets.some((d) => d.name === name)) await loadList(); else renderPicker();
        renderDataset();
        if (opts.onDataset) { try { opts.onDataset(S.name); } catch (_) { /* the host's own business */ } }
        return true;
    }

    async function save({ quiet = false } = {}) {
        if (!S.m) return false;
        S.busy = true; updateTools();
        try {
            const r = await api.save(S.name, S.m);
            S.m = r.manifest; S.saved = Mo.clone(r.manifest); S.review = r.review || S.review;
            if (!quiet) toast(r.reset_approval ? "Saved. The dataset was edited after approval, so it needs a new approval." : "Saved.", r.reset_approval ? "warn" : "success");
            return true;
        } catch (e) { toast("Not saved: " + msgOf(e), "error"); return false; }
        finally { S.busy = false; renderDataset(); loadList(); }
    }

    async function review(action, note) {
        if (!S.m) return false;
        S.busy = true; updateTools();
        try {
            const r = await api.review(S.name, action, note || "", S.m);
            S.m = r.manifest; S.saved = Mo.clone(r.manifest); S.review = r.review;
            S.history = new Mo.History();
            const done = { approve: "Approved. agentY can train it now.", ask: "Your note is on its way to the agent.", cancel: "Cancelled." }[action];
            toast(done, "success");
            if (opts.sendToAgent && r.message) {
                try { await opts.sendToAgent(r.message); } catch (_) { /* agentY is optional */ }
            }
            return true;
        } catch (e) { toast(msgOf(e), "error"); return false; }
        finally { S.busy = false; renderDataset(); loadList(); }
    }

    function askNote() {
        const wrap = el(doc, "div", "lr-note");
        const box = el(doc, "div");
        const ta = el(doc, "textarea", "lr-in");
        ta.placeholder = "What should the agent change? (e.g. drop the blurry ones, caption the clothing)";
        const row = el(doc, "div", "lr-row");
        const send = el(doc, "button", "lr-btn go", "Send to the agent");
        const no = el(doc, "button", "lr-btn", "Close");
        row.append(el(doc, "span", "lr-spacer"), no, send);
        box.append(el(doc, "div", "", "Ask the agent"), ta, row);
        wrap.append(box);
        const close = () => wrap.remove();
        no.onclick = close;
        wrap.onclick = (e) => { if (e.target === wrap) close(); };
        send.onclick = async () => {
            const note = ta.value.trim();
            if (!note) { ta.focus(); return; }
            send.disabled = true;
            if (await review("ask", note)) close(); else send.disabled = false;
        };
        root.append(wrap);
        ta.focus();
    }

    picker.onchange = () => open(picker.value);
    btnRefresh.onclick = async () => { await loadList(); if (S.name && !dirty()) open(S.name, { force: true }); };
    trigIn.onchange = () => {
        if (!S.m || trigIn.value.trim() === (S.m.trigger_word || "")) return;
        const r = edit((m) => Mo.setTrigger(m, trigIn.value, rewriteChk.checked));
        if (r && r.changed) toast(`Trigger word changed in ${r.changed} caption${r.changed > 1 ? "s" : ""}.`, "info");
    };
    btnReplace.onclick = () => {
        if (!findIn.value) { findIn.focus(); return; }
        try {
            const ids = S.selected.size ? [...S.selected] : undefined;
            const n = edit((m) => Mo.bulkReplace(m, findIn.value, replIn.value, { ids }));
            toast(n ? `Replaced in ${n} caption${n > 1 ? "s" : ""}.` : "Nothing found.", n ? "success" : "info");
        } catch (e) { toast("Cannot replace: " + msgOf(e), "error"); }
    };
    btnSelAll.onclick = () => {
        const kept = Mo.split(S.m).kept;
        if (S.selected.size === kept.length) S.selected.clear(); else kept.forEach((i) => S.selected.add(i.id));
        renderDataset();
    };
    btnRemove.onclick = () => {
        const ids = [...S.selected];
        const n = edit((m) => Mo.removeItems(m, ids, "removed in the viewer"));
        toast(`Removed ${n}. They stay listed below with a Restore button.`, "info");
    };
    btnUndo.onclick = () => {
        const back = S.history.undo(S.m);
        if (back) { S.m = back; renderDataset(); }
    };
    btnSave.onclick = () => save();
    btnApprove.onclick = async () => {
        try { if (typeof Notification !== "undefined" && Notification.permission === "default") Notification.requestPermission(); } catch (_) { /* optional */ }
        if (await review("approve", "")) { setTab("training"); pollNow(); }
    };
    btnAsk.onclick = () => askNote();
    btnCancel.onclick = () => { if (confirm("Cancel this dataset? The agent is told not to train it.")) review("cancel", ""); };

    // ── TRAINING tab ──────────────────────────────────────────────────────────

    const trBar = el(doc, "div", "lr-bar");
    const runPick = el(doc, "select", "lr-in lr-sel");
    const btnStopDiscard = el(doc, "button", "lr-btn warn", "Stop (discard)");
    const btnStopKeep = el(doc, "button", "lr-btn", "Stop & keep last checkpoint");
    trBar.append(runPick, el(doc, "span", "lr-spacer"), btnStopKeep, btnStopDiscard);
    const trScroll = el(doc, "div", "lr-scroll");
    pageTr.append(trBar, trScroll);

    function sparkSvg(series) {
        const NS = "http://www.w3.org/2000/svg";
        const svg = doc.createElementNS(NS, "svg");
        svg.setAttribute("class", "lr-spark");
        svg.setAttribute("viewBox", "0 0 400 64");
        svg.setAttribute("preserveAspectRatio", "none");
        const add = (pts, cls, range) => {
            const d = Mo.sparkPath(pts, 400, 64, 2, range);
            if (!d) return;
            const p = doc.createElementNS(NS, "path");
            p.setAttribute("d", d);
            if (cls) p.setAttribute("class", cls);
            svg.append(p);
        };
        // Both curves share one scale: the smoothed one is drawn from the raw min/max.
        const sm = Mo.smoothLoss(series);
        const range = Mo.seriesRange(series);
        add(series, "raw", range);
        add(sm, "", range);
        return svg;
    }

    function openLightbox(items) {
        const wrap = el(doc, "div", "lr-light" + (items.length === 1 ? " one" : ""));
        for (const it of items) {
            const fig = el(doc, "figure");
            const m = isVideo(it.path || it.file) ? el(doc, "video") : el(doc, "img");
            if (m.tagName === "VIDEO") { m.controls = true; m.loop = true; m.muted = true; m.autoplay = true; }
            m.src = opts.fileUrl(it.path);
            fig.append(m, el(doc, "figcaption", "", it.caption || ""));
            wrap.append(fig);
        }
        wrap.onclick = (e) => { if (e.target === wrap) wrap.remove(); };
        const onKey = (e) => { if (e.key === "Escape") { wrap.remove(); doc.removeEventListener("keydown", onKey, true); } };
        doc.addEventListener("keydown", onKey, true);
        root.append(wrap);
    }

    function renderRun() {
        trScroll.textContent = "";
        const d = S.runData;
        if (!d) {
            trScroll.append(el(doc, "div", "lr-empty", S.runs.length ? "Pick a run." : "No training runs yet. Approve a dataset and the agent starts one."));
            btnStopKeep.disabled = btnStopDiscard.disabled = true;
            return;
        }
        const p = d.progress || {};
        const live = p.status === "running" || p.status === "starting";
        btnStopKeep.disabled = btnStopDiscard.disabled = !live || !!(d.control && d.control.action === "stop");
        const card = el(doc, "div", "lr-card-run");
        const head = el(doc, "div");
        head.append(el(doc, "b", "", d.name), el(doc, "span", "lr-pill", "run " + Mo.runLabel(d.name, S.runs)), `  ${p.model || (d.job && d.job.model) || ""} on ${p.dataset || (d.job && d.job.dataset) || ""}  `,
            el(doc, "span", `lr-pill ${p.status === "done" ? "approved" : p.status === "failed" ? "cancelled" : ""}`, p.status || "starting"));
        if (d.control && d.control.action === "stop") head.append(el(doc, "span", "lr-pill changes", d.control.keep ? "stopping, keeping the last checkpoint" : "stopping"));
        const pct = Math.max(0, Math.min(1, +p.pct || (p.total ? (p.step || 0) / p.total : 0)));
        const prog = el(doc, "div", "lr-prog"); const bar = el(doc, "i"); bar.style.width = (pct * 100).toFixed(1) + "%"; prog.append(bar);
        const stat = (k, v) => { const s = el(doc, "span"); s.append(el(doc, "em", "", k), v); return s; };
        const stats = el(doc, "div", "lr-stats");
        const f = (v, n) => (Number.isFinite(+v) && v !== null ? (+v).toFixed(n) : "-");
        const lastLoss = Mo.smoothLoss(p.loss_series || []).slice(-1)[0];
        stats.append(stat("step", `${p.step ?? 0} / ${p.total ?? "?"}`), stat("done", (pct * 100).toFixed(1) + "%"),
            stat("ETA", live ? Mo.fmtDuration(p.eta_s) : "-"), stat("elapsed", Mo.fmtDuration(p.elapsed_s)),
            stat("it/s", f(p.it_s, 2)), stat("loss", f(lastLoss ? lastLoss[1] : p.loss, 4)),
            stat("lr", Number.isFinite(+p.lr) && p.lr !== null ? (+p.lr).toExponential(1) : "-"), stat("VRAM", p.vram_gb != null ? f(p.vram_gb, 1) + " GB" : "-"));
        card.append(head, prog, stats);
        if (p.message) { const msg = el(doc, "div", "", p.message); msg.style.opacity = ".7"; card.append(msg); }
        if ((p.loss_series || []).length > 1) card.append(sparkSvg(p.loss_series));
        const logBtn = el(doc, "button", "lr-btn", S.showLog ? "Hide log tail" : "Log tail");
        logBtn.style.marginTop = "8px";
        logBtn.onclick = () => { S.showLog = !S.showLog; renderRun(); };
        card.append(logBtn);
        if (S.showLog) {
            const pre = el(doc, "div", "lr-log", d.log_tail || "(empty)");
            card.append(pre);
            setTimeout(() => { pre.scrollTop = pre.scrollHeight; }, 0);
        }
        trScroll.append(card);

        const steps = Mo.sampleSteps(d.samples);
        trScroll.append(el(doc, "div", "lr-h", `Samples (${steps.length} step${steps.length === 1 ? "" : "s"})`));
        if (steps.length) {
            const bar2 = el(doc, "div", "lr-row");
            const cmp = el(doc, "button", "lr-btn", "Compare first and latest");
            cmp.disabled = steps.length < 2;
            cmp.onclick = () => {
                const a = steps[0], b = steps[steps.length - 1];
                const pairs = [];
                a.files.forEach((fa, i) => { if (b.files[i]) pairs.push({ ...fa, caption: `step ${a.step}: ${fa.prompt || ""}` }, { ...b.files[i], caption: `step ${b.step}: ${b.files[i].prompt || ""}` }); });
                openLightbox(pairs.slice(0, 8));
            };
            bar2.append(cmp);
            trScroll.append(bar2);
            const strip = el(doc, "div", "lr-strip");
            steps.forEach((s, idx) => {
                const col = el(doc, "div", "lr-step" + (idx === steps.length - 1 ? " latest" : ""));
                col.append(el(doc, "h5", "", `step ${s.step}`));
                const files = el(doc, "div", "f");
                for (const fl of s.files) {
                    const m = isVideo(fl.path || fl.file) ? el(doc, "video", "lr-sample") : el(doc, "img", "lr-sample");
                    if (m.tagName === "VIDEO") { m.muted = true; m.loop = true; m.preload = "metadata"; m.onpointerenter = () => m.play().catch(() => {}); m.onpointerleave = () => m.pause(); }
                    m.src = opts.fileUrl(fl.path);
                    m.title = fl.prompt || "";
                    m.onclick = () => openLightbox([{ ...fl, caption: `step ${s.step}: ${fl.prompt || ""}` }]);
                    files.append(m);
                }
                col.append(files);
                strip.append(col);
            });
            trScroll.append(strip);
            setTimeout(() => { strip.scrollLeft = strip.scrollWidth; }, 0);
        } else trScroll.append(el(doc, "div", "lr-empty", "The backend has not rendered a sample yet."));

        trScroll.append(el(doc, "div", "lr-h", "Events"));
        const ul = el(doc, "ul", "lr-events");
        for (const e of [...(d.events || [])].reverse().slice(0, 60)) {
            const li = el(doc, "li");
            li.append(el(doc, "span", "k " + e.kind, e.kind), `${new Date((+e.t || 0) * 1000).toLocaleTimeString()}  ${e.text || ""}`);
            ul.append(li);
        }
        trScroll.append(ul);
        if (d.result && d.result.lora) trScroll.append(el(doc, "div", "lr-h", "Result"), el(doc, "div", "", String(d.result.lora)));
    }

    function renderRunPicker() {
        runPick.textContent = "";
        for (const r of S.runs) {
            const v = Mo.runVersion(r.name);
            const o = el(doc, "option", "", `${v ? v + "  " : ""}${r.name}  ${r.status}  ${r.step}/${r.total}${S.offered === r.name ? "  (new)" : ""}`);
            o.value = r.name;
            runPick.append(o);
        }
        if (!S.runs.length) { const o = el(doc, "option", "", "(no runs)"); o.value = ""; runPick.append(o); }
        runPick.value = S.run;
    }

    function announce(events, runName) {
        const last = S.lastEvent[runName];
        if (last === undefined) {
            // first sight of this run in this page: do not replay what is old (unless the page remembered a mark)
            const mark = parseInt(store.get("bepic.lora.ev." + runName) || "", 10);
            S.lastEvent[runName] = Number.isFinite(mark) ? mark : Mo.maxEventId(events);
        }
        const fresh = Mo.eventsAfter(events, S.lastEvent[runName]);
        if (!fresh.length) { store.set("bepic.lora.ev." + runName, String(S.lastEvent[runName])); return; }
        S.lastEvent[runName] = Mo.maxEventId(events);
        store.set("bepic.lora.ev." + runName, String(S.lastEvent[runName]));
        for (const e of fresh) {
            const sev = e.kind === "failed" ? "error" : e.kind === "finished" ? "success" : e.kind === "stopped" ? "warn" : "info";
            const text = `${runName}: ${e.text || e.kind}`;
            toast(text, sev);
            try {
                if (typeof Notification !== "undefined" && Notification.permission === "granted" && doc.hidden && ["finished", "failed", "stopped"].includes(e.kind)) {
                    new Notification("LoRA training " + e.kind, { body: text });
                }
            } catch (_) { /* optional */ }
        }
    }

    async function pollOnce() {
        try {
            const r = await api.runs();
            S.runs = r.runs || [];
        } catch (_) { return null; }
        const pick = Mo.chooseRun(S.runs, { run: S.run, picked: S.pickedRun, seen: S.seenRuns, dataset: S.name });
        S.seenRuns = pick.seen;
        if (pick.run !== S.run) S.runData = null;
        S.run = pick.run; S.pickedRun = pick.picked;
        if (pick.switched && pick.fresh.length) toast(`New training run ${Mo.runLabel(S.run, S.runs)} started: showing it.`, "info");
        if (pick.offer) toast(`A new training run started: ${Mo.runLabel(pick.offer, S.runs)}. Pick it in the run list to watch it.`, "info");
        S.offered = pick.offer || "";
        renderRunPicker();
        if (!S.run) { S.runData = null; if (S.tab === "training") renderRun(); return "none"; }
        try {
            S.runData = await api.run(S.run);
            announce(S.runData.events || [], S.run);
        } catch (_) { return null; }
        if (S.tab === "training") renderRun();
        return (S.runData.progress || {}).status || "starting";
    }

    function schedule(status) {
        clearTimeout(S.timer);
        if (S.disposed) return;
        const open = opts.isOpen ? opts.isOpen() : true;
        S.timer = setTimeout(tick, Mo.pollDelay(status, open));
    }
    async function tick() {
        if (S.disposed) return;
        const st = await pollOnce();
        schedule(st);
    }
    function pollNow() { clearTimeout(S.timer); tick(); }

    runPick.onchange = () => { S.run = runPick.value; S.pickedRun = true; S.runData = null; pollNow(); };
    const stop = async (keep) => {
        if (!S.run) return;
        if (!confirm(keep ? "Stop the run and keep the last checkpoint?" : "Stop the run and discard it?")) return;
        try { await api.control(S.run, keep); toast("Stop requested.", "info"); } catch (e) { toast("Cannot stop: " + msgOf(e), "error"); }
        pollNow();
    };
    btnStopDiscard.onclick = () => stop(false);
    btnStopKeep.onclick = () => stop(true);

    // ── start ─────────────────────────────────────────────────────────────────

    setTab("dataset");
    renderDataset();
    renderRun();
    loadList();
    tick();

    return {
        root,
        /** Open a dataset by name (e.g. when the agent pushed its manifest.json). */
        async openDataset(name) { setTab("dataset"); return open(name, { force: false }); },
        showTraining() { setTab("training"); },
        refresh() { return loadList(); },
        get dirty() { return dirty(); },
        get name() { return S.name; },
        get manifest() { return S.m; },
        state: S,
        pollNow,
        dispose() { S.disposed = true; clearTimeout(S.timer); host.textContent = ""; },
    };
}

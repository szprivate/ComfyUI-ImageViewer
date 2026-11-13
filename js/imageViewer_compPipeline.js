// imageViewer_compPipeline.js
// The Comp space's pipeline dialogs (CompPipelineMixin, onto the panel beside CompPanelMixin): Render Write nodes,
// Send to the farm, Relink footage, Localise footage; a node's metadata; autosave of unsaved comps and the offer to
// recover one when a comp opens. Server side: comp_routes.py (comp_write, comp_pipeline).
//
// Routes: POST comp_write_plan, comp_write (a job), comp_metadata, comp_relink, comp_localise (a job), comp_farm
// (relayed to agentY's /agentY/comp_farm), GET / POST comp_autosave.
import { api } from "../../scripts/api.js";
import { notice, openFilePicker } from "./imageViewer_exportUI.js";
import { readNodes, writeNodes } from "./imageViewer_compModel.js";

const AUTOSAVE_MS = 30 * 1000;
const baseOf = (p) => String(p || "").split(/[\\/]/).pop();

async function post(route, body) {
    const res = await api.fetchApi(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; e.data = data; throw e; }
    return data;
}

export const CompPipelineMixin = {
    /** A small dialog over a comp tab (the Save as dialog's look): {box, el, field, note, buttons, shut, done}. */
    _cpDlg(rec, title, cls = "") {
        const doc = rec.el.ownerDocument;
        const el = (tag, c, text) => { const e = doc.createElement(tag); if (c) e.className = c; if (text != null) e.textContent = text; return e; };
        const shade = el("div", "cp-dlg-shade");
        const box = el("div", "cp-dlg " + cls);
        box.style.maxHeight = "86%";
        box.style.overflow = "auto";
        box.append(el("h3", "", title));
        shade.append(box);
        let resolve;
        const done = new Promise((r) => { resolve = r; });
        const shut = (v = null) => { shade.remove(); resolve(v); };
        const field = (label, ...parts) => { const r = el("div", "cp-field"); r.append(el("label", "", label), ...parts); box.append(r); return r; };
        const note = el("div", "cp-note");
        const go = el("div", "cp-go");
        const button = (label, fn, on = false) => { const b = el("button", "mg-btn" + (on ? " on" : ""), label); b.addEventListener("click", fn); go.append(b); return b; };
        box.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); shut(); } });
        shade.addEventListener("pointerdown", (e) => { e.stopPropagation(); if (e.target === shade) shut(); });
        const finish = () => { box.append(note, go); rec.el.append(shade); };
        return { doc, el, box, field, note, button, shut, done, finish };
    },

    _cpSay(note, text, error = false) { note.textContent = text; note.classList.toggle("error", !!error); },

    /** Wait for a job route ({job}) to end; progress(done, total). */
    async _cpWait(route, jid, progress) {
        for (;;) {
            await new Promise((r) => setTimeout(r, 300));
            const r = await api.fetchApi(`${route}?job=${encodeURIComponent(jid)}`);
            const s = await r.json().catch(() => ({}));
            if (progress) progress(s.done || 0, s.total || 1);
            if (s.state === "done") return s.result;
            if (s.state !== "running") throw new Error(s.error || (s.state === "stopped" ? "Stopped." : "The job stopped."));
        }
    },

    /** The frames rows the Write dialogs share: which range, and handles. Returns read() -> {first?, last?, handles?}. */
    _cpRangeRows(d, ed) {
        const frames = ed.comp().format.frames;
        const sel = d.el("select");
        const opts = [["own", "Each Write's own range"], ["all", `All frames (0–${frames - 1})`], ["here", `This frame (${ed.state.frame})`]];
        const range = this.playbackRange;
        if (range && range.end > range.start) opts.splice(2, 0, ["range", `In to out (${range.start}–${range.end})`]);
        for (const [v, l] of opts) sel.append(new Option(l, v));
        const handles = d.el("input");
        Object.assign(handles, { type: "number", min: 0, max: 1000, step: 1, placeholder: "own" });
        handles.style.maxWidth = "6em";
        handles.title = "Extra frames before and after; empty: each Write's own handles";
        d.field("Frames", sel);
        d.field("Handles", handles);
        return () => {
            const out = {};
            if (sel.value === "all") Object.assign(out, { first: 0, last: frames - 1 });
            else if (sel.value === "here") Object.assign(out, { first: ed.state.frame, last: ed.state.frame });
            else if (sel.value === "range" && range) Object.assign(out, { first: range.start, last: range.end });
            if (handles.value !== "") out.handles = Math.max(0, Math.round(+handles.value || 0));
            return out;
        };
    },

    /** Checkboxes for the Write nodes (all on, or the ids given); returns () -> [ids]. */
    _cpWriteList(d, comp, ids) {
        const list = d.el("div", "cp-wlist");
        const boxes = [];
        for (const n of writeNodes(comp)) {
            const lab = d.el("label", "rd-inline");
            const cb = d.el("input");
            cb.type = "checkbox";
            cb.checked = !n.disable && (!ids || ids.includes(n.id));
            cb.disabled = !!n.disable;
            cb.dataset.id = n.id;
            lab.append(cb, d.el("span", "", ` ${n.name || n.id}${n.disable ? " (switched off)" : ""} · ${n.file || "beside the comp"} · ${n.file_type || "exr"}${n.channels === "all" ? ", all layers" : ""}`));
            lab.style.display = "block";
            list.append(lab);
            boxes.push(cb);
        }
        d.field("Writes", list);
        return () => boxes.filter((b) => b.checked).map((b) => b.dataset.id);
    },

    /** Render Write nodes…: every checked Write writes its own files here, the frames counted as one job. */
    async compWritesDialog(rec = this._cpActive(), ids = null) {
        if (!rec || !rec.editor || !rec.path) return null;
        const ed = rec.editor;
        const d = this._cpDlg(rec, ids && ids.length === 1 ? "Render this Write" : "Render Write nodes", "cp-writes");
        const picked = this._cpWriteList(d, ed.comp(), ids);
        const range = this._cpRangeRows(d, ed);
        const plan = d.el("div", "cp-note cp-plan");
        d.box.append(plan);
        const showPlan = async () => {
            try {
                const got = await post("/imageviewer/comp_write_plan", { path: rec.path, comp: ed.comp(), writes: picked(), ...range() });
                plan.textContent = got.writes.map((w) => `${w.name}: ${w.count} ${w.film ? "frames into" : "files,"} ${baseOf(w.first_file)}${w.count > 1 && !w.film ? ` … ${baseOf(w.last_file)}` : ""}`).join("\n") + (got.refused ? `\n${got.refused}` : "");
                plan.classList.toggle("error", !!got.refused);
            } catch (e) { plan.textContent = String(e.message || e); plan.classList.add("error"); }
        };
        plan.style.whiteSpace = "pre-wrap";
        d.box.addEventListener("change", () => showPlan());
        let jid = null;
        d.button("Cancel", async () => { if (jid) { await post("/imageviewer/comp_write", { job: jid, cancel: true }).catch(() => {}); } d.shut(); });
        const go = d.button("Render", async () => {
            const writes = picked();
            if (!writes.length) { this._cpSay(d.note, "Tick a Write node.", true); return; }
            go.disabled = true;
            try {
                if (ed.isDirty()) await ed.save();
                if (ed.isDirty()) throw new Error("The comp could not be saved, so it was not rendered.");
                const started = await post("/imageviewer/comp_write", { path: rec.path, writes, ...range() });
                jid = started.job;
                const result = await this._cpWait("/imageviewer/comp_write", jid, (done, total) => this._cpSay(d.note, `Frame ${done} of ${total}`));
                d.shut(result);
                this.compLandWrites(result);
            } catch (e) { go.disabled = false; this._cpSay(d.note, String(e.message || e), true); }
        }, true);
        d.finish();
        showPlan();
        return d.done;
    },

    /** What the Writes wrote: said, and the first file of each in the History. */
    compLandWrites(result) {
        if (!result) return;
        const ws = result.writes || [];
        notice("success", "Writes rendered", ws.map((w) => `${w.name}: ${w.frames} frame${w.frames === 1 ? "" : "s"}`).join("; "));
        if (result.notes && result.notes.length) notice("warn", "Some footage was not there", result.notes.slice(0, 3).join("; "));
        const first = ws.map((w) => (w.files || [])[0]).filter(Boolean);
        if (first.length && this.exportLanded) this.exportLanded(first).catch?.(() => {});
    },

    /** Send to the farm…: the Writes as one Deadline job through agentY (its Deadline settings), in chunks. */
    async compFarmDialog(rec = this._cpActive()) {
        if (!rec || !rec.editor || !rec.path) return null;
        const ed = rec.editor;
        const st = this._cpState();
        const last = st.lastFarm || {};
        const d = this._cpDlg(rec, "Send to the farm", "cp-farm");
        const picked = this._cpWriteList(d, ed.comp(), null);
        const range = this._cpRangeRows(d, ed);
        const input = (value, attrs = {}) => { const i = d.el("input"); Object.assign(i, { value: value ?? "" }, attrs); return i; };
        const chunk = input(last.chunk ?? 10, { type: "number", min: 1, max: 1000, step: 1, title: "Frames per farm task" });
        const pool = input(last.pool || "", { placeholder: "agentY's default pool", spellcheck: false });
        const group = input(last.group || "", { placeholder: "none", spellcheck: false });
        const prio = input(last.priority ?? "", { type: "number", min: 0, max: 100, step: 1, placeholder: "50" });
        d.field("Chunk", chunk);
        d.field("Pool", pool);
        d.field("Group", group);
        d.field("Priority", prio);
        const warn = d.el("div", "cp-note");
        warn.style.whiteSpace = "pre-wrap";
        d.box.append(warn);
        const body = () => ({ path: rec.path, writes: picked(), ...range(), chunk: Math.max(1, Math.round(+chunk.value || 10)), pool: pool.value.trim(),
            group: group.value.trim(), priority: prio.value === "" ? -1 : Math.round(+prio.value) });
        const check = async () => {
            try {
                const got = await post("/imageviewer/comp_farm", { ...body(), dry_run: true });
                const r = got.request;
                warn.textContent = `Deadline frames ${r.frames}${r.frame_offset ? ` (comp frame + ${r.frame_offset})` : ""}, ${r.chunk} a task.`
                    + (got.warnings.length ? "\n" + got.warnings.join("\n") : "");
                warn.classList.toggle("error", got.warnings.length > 0);
            } catch (e) { warn.textContent = String(e.message || e); warn.classList.add("error"); }
        };
        d.box.addEventListener("change", () => check());
        d.button("Cancel", () => d.shut());
        const go = d.button("Submit", async () => {
            const b = body();
            if (!b.writes.length) { this._cpSay(d.note, "Tick a Write node.", true); return; }
            st.lastFarm = { chunk: b.chunk, pool: b.pool, group: b.group, priority: prio.value };
            go.disabled = true;
            this._cpSay(d.note, "Submitting…");
            try {
                if (ed.isDirty()) await ed.save();
                if (ed.isDirty()) throw new Error("The comp could not be saved, so it was not sent.");
                const got = await post("/imageviewer/comp_farm", b);
                if (got.ok === false || got.error) throw new Error(got.error || "agentY did not submit it");
                d.shut(got);
                notice("success", "On the farm", `Deadline job ${got.job_id || "?"}: ${got.tasks || "?"} task(s) in pool ${got.pool || "?"}`);
            } catch (e) { go.disabled = false; this._cpSay(d.note, String(e.message || e), true); }
        }, true);
        d.finish();
        check();
        return d.done;
    },

    /** Relink footage…: the Reads whose files are not there, looked for by name under a folder; one undo step. */
    async compRelinkDialog(rec = this._cpActive()) {
        if (!rec || !rec.editor || !rec.path) return null;
        const ed = rec.editor;
        const d = this._cpDlg(rec, "Relink footage", "cp-relink");
        const list = d.el("div", "cp-wlist");
        d.field("Missing", list);
        const folder = d.el("input");
        folder.spellcheck = false;
        folder.placeholder = "a folder to look in (and below)";
        const browse = d.el("button", "mg-btn", "Browse…");
        d.field("Look in", folder, browse);
        let found = {}, missing = [];
        const draw = () => {
            list.replaceChildren(...(missing.length ? missing.map((m) => {
                const r = d.el("div", "cp-meta-row");
                r.append(d.el("span", "cp-meta-k", m.name), d.el("span", "cp-meta-v", found[m.id] ? `→ ${found[m.id]}` : m.file));
                r.title = m.file;
                return r;
            }) : [d.el("div", "", "Every Read's footage is there.")]));
        };
        const ask = async () => {
            try {
                const got = await post("/imageviewer/comp_relink", { path: rec.path, comp: ed.comp(), folder: folder.value.trim() || undefined });
                missing = got.missing;
                found = got.found || {};
                draw();
                const n = Object.keys(found).length;
                this._cpSay(d.note, folder.value.trim() ? `${n} of ${missing.length} found.` : missing.length ? "Name a folder and Search." : "");
                apply.disabled = !n;
            } catch (e) { this._cpSay(d.note, String(e.message || e), true); }
        };
        browse.addEventListener("click", () => openFilePicker(this.container, {
            id: "compRelink", title: "Look for the footage in", kind: "image", start: folder.value, folder: true, go: "This folder",
            onPick: async ([f]) => { if (f && f.path) { folder.value = f.path; ask(); } return { ok: true }; },
        }));
        d.button("Cancel", () => d.shut());
        d.button("Search", () => ask());
        const apply = d.button("Relink", () => {
            const patches = {};
            for (const [id, file] of Object.entries(found)) patches[id] = { file, local: undefined };
            ed.setNodes(patches);
            d.shut(patches);
            notice("success", "Relinked", `${Object.keys(patches).length} Read(s): undo puts them back`);
        }, true);
        apply.disabled = true;
        d.finish();
        ask();
        return d.done;
    },

    /** Localise footage…: the Reads' files copied into ComfyUI's input folder and read from there (the network path
     *  stays the Read's file; "Use the network" goes back). */
    async compLocaliseDialog(rec = this._cpActive()) {
        if (!rec || !rec.editor || !rec.path) return null;
        const ed = rec.editor;
        const d = this._cpDlg(rec, "Localise footage", "cp-localise");
        const reads = readNodes(ed.comp());
        const list = d.el("div", "cp-wlist");
        const boxes = reads.map((r) => {
            const lab = d.el("label", "rd-inline");
            const cb = d.el("input");
            cb.type = "checkbox";
            cb.checked = !r.local;
            cb.dataset.id = r.id;
            lab.append(cb, d.el("span", "", ` ${r.name} · ${baseOf(r.file)}${r.local ? " (local copy)" : ""}`));
            lab.style.display = "block";
            list.append(lab);
            return cb;
        });
        d.field("Reads", reads.length ? list : d.el("span", "", "No Read has footage."));
        this._cpSay(d.note, "A copy is made in ComfyUI's input/comp_footage and kept up to date by size and time; the render reads it too.");
        const ids = () => boxes.filter((b) => b.checked).map((b) => b.dataset.id);
        let jid = null;
        d.button("Cancel", async () => { if (jid) await post("/imageviewer/comp_localise", { job: jid, cancel: true }).catch(() => {}); d.shut(); });
        d.button("Use the network", () => {
            const patches = {};
            for (const id of ids()) patches[id] = { local: undefined };
            ed.setNodes(patches);
            d.shut(patches);
        });
        const go = d.button("Copy here", async () => {
            const want = ids();
            if (!want.length) { this._cpSay(d.note, "Tick a Read.", true); return; }
            go.disabled = true;
            try {
                const started = await post("/imageviewer/comp_localise", { path: rec.path, comp: ed.comp(), ids: want });
                jid = started.job;
                const r = await this._cpWait("/imageviewer/comp_localise", jid, (done, total) => this._cpSay(d.note, `File ${done} of ${total}`));
                const patches = {};
                for (const [id, local] of Object.entries(r.local || {})) patches[id] = { local };
                if (Object.keys(patches).length) ed.setNodes(patches);
                d.shut(r);
                notice("success", "Footage localised", `${r.copied} of ${r.files} file(s) copied` + (r.skipped && r.skipped.length ? `; ${r.skipped.length} Read(s) skipped` : ""));
            } catch (e) { go.disabled = false; this._cpSay(d.note, String(e.message || e), true); }
        }, true);
        d.finish();
        return d.done;
    },

    /** The metadata of node `id`'s picture at `frame` (the page's graph, unsaved edits included). */
    async _cpMetadata(rec, id, frame) {
        const got = await post("/imageviewer/comp_metadata", { path: rec.path, comp: rec.editor.comp(), node: id, frame });
        return got.metadata || {};
    },

    // ── autosave and recovery ────────────────────────────────────────────────

    /** Every AUTOSAVE_MS, each comp tab with unsaved changes is kept on the server (once per change). */
    _cpAutosaveWatch() {
        if (this._cpAutosaveTimer) return;
        const tick = async () => {
            const st = this._cpState();
            for (const rec of Object.values(st.tabs)) {
                if (!rec || !rec.editor || !rec.path || !rec.editor.isDirty()) continue;
                const text = JSON.stringify(rec.editor.comp());
                if (text === rec.autosaved) continue;
                try {
                    await api.fetchApi("/imageviewer/comp_autosave", { method: "POST", headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ path: rec.path, comp: JSON.parse(text) }) });
                    rec.autosaved = text;
                } catch (_) { /* tried again at the next tick */ }
            }
        };
        this._cpAutosaveTimer = this._viewerWindow().setInterval(tick, AUTOSAVE_MS);
    },

    /** A comp opened with an autosave newer than its file: offer it back (Recover = the autosave, unsaved;
     *  Discard = forget it). */
    async _cpOfferRecovery(rec, autosave) {
        for (let k = 0; k < 100 && !rec.editor; k++) await new Promise((r) => setTimeout(r, 100));
        if (!rec.editor || !rec.el) return;
        const d = this._cpDlg(rec, "Recover unsaved changes?", "cp-recover");
        const when = new Date(autosave.time * 1000);
        this._cpSay(d.note, `${baseOf(rec.path)} has changes kept at ${when.toLocaleString()} that were never saved (the viewer closed, or the tab was closed without saving).`);
        d.button("Discard them", async () => {
            await post("/imageviewer/comp_autosave", { path: rec.path, drop: true }).catch(() => {});
            d.shut(false);
        });
        d.button("Recover", async () => {
            try {
                const r = await api.fetchApi(`/imageviewer/comp_autosave?path=${encodeURIComponent(rec.path)}`);
                const got = await r.json();
                if (!r.ok) throw new Error(got.error || `HTTP ${r.status}`);
                rec.editor.load(got.comp, rec.path);
                rec.editor.setNodes({});        // unsaved: Save writes it into the file
                d.shut(true);
                notice("info", "Recovered", "The kept changes are in the comp; Save writes them into the file.");
            } catch (e) { this._cpSay(d.note, "Not recovered: " + (e.message || e), true); }
        }, true);
        d.finish();
        return d.done;
    },
};

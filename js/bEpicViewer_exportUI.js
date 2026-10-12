// bEpicViewer_exportUI.js
// What every export in the viewer shares: one dialog, one way of saying how it
// went, and one reading of which shot the canvas is about.
//
// The viewer's exports grew one feature at a time - a real dialog here, a
// browser prompt() there, no question at all somewhere else, and five ways of
// reporting the result. This is the one each is moved to (see "Import and
// export" in CLAUDE.md): the same rows in the same order, the place the file
// will land shown BEFORE it is written, and the rules for formats and for
// locations asked from the server (export_rules.py) instead of being repeated
// in every feature.
//
// Plain functions rather than a mixin: nothing here needs the viewer, and two
// mixins sharing method names on one prototype would silently overwrite each
// other. What needs no page is in bEpicViewer_exportData.js and runs under node.
import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";
import { FALLBACK_OPTIONS, cleanName, codecFor, contextFromNodes, videoChoices } from "./bEpicViewer_exportData.js";

export { cleanName, contextFromNodes };

// ── which shot the canvas is about ───────────────────────────────────────────

/** The sequence and shot the open graph names, or null when it names none. */
export function canvasContext() {
    try {
        const nodes = ((app.graph && app.graph._nodes) || []).map((n) => ({
            type: n.type || n.comfyClass || "",
            widgets: Object.fromEntries((n.widgets || []).map((w) => [w.name, w.value])),
        }));
        return contextFromNodes(nodes);
    } catch (_) { return null; }
}

// ── how it went ──────────────────────────────────────────────────────────────

/**
 * Say what an export (or any way in or out) did. One voice for all of them: a
 * toast that goes away by itself - never a blocking alert - with the path as the
 * detail. `severity` is "success", "info", "warn" or "error".
 */
export function notice(severity, summary, detail) {
    const toast = app.extensionManager && app.extensionManager.toast;
    if (toast && toast.add) {
        toast.add({ severity, summary, detail: detail || "", life: severity === "error" ? 8000 : 4500 });
    } else {
        console.log(`[bEpicViewer] ${summary}${detail ? " -- " + detail : ""}`);
    }
}

// ── the rules, from the server ───────────────────────────────────────────────

let _options = null;

/** What a format can be (export_rules.options), asked once. */
export async function exportOptions() {
    if (_options) return _options;
    try {
        const res = await api.fetchApi("/bepic/export_options");
        if (res.ok) _options = await res.json();
    } catch (_) { /* an older server: the fallback below */ }
    return _options || FALLBACK_OPTIONS;
}

/** Where an export would land - nothing is created. Null when the server cannot say. */
export async function exportTarget(kind, name, ext, context, version, sequence) {
    try {
        const res = await api.fetchApi("/bepic/export_target", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind, name, ext, context: context || null, version: version || null,
                                   sequence: !!sequence }),
        });
        return res.ok ? await res.json() : null;
    } catch (_) { return null; }
}

// ── the dialog ───────────────────────────────────────────────────────────────

/**
 * Open the export dialog over `host` (the panel's container).
 *
 *   spec.title      "Export film", "Export annotation", …
 *   spec.kind       what it is, for the location rule: video, image, annotation, scene, stage, edit
 *   spec.name       the name it starts with
 *   spec.formats    video containers offered (["mp4", "mov"]), or
 *   spec.fixed      [{ value, label }] for an export that is not a video (png, usda, json)
 *   spec.values     what was chosen last time: { format, codec, quality }
 *   spec.rows       (make) => [elements] - the feature's own rows, built with the dialog's helpers
 *   spec.note       a line under the rows (what this export leaves out, say)
 *   spec.go         the button's word; "Export" unless it takes long enough to be "Render"
 *   spec.onExport   async (values, ui) => ({ ok, message, error }) - `ui.progress(done, total, text)`
 *
 * Returns { close }. Closing is refused while an export runs.
 */
export async function openExportDialog(host, spec) {
    const doc = host.ownerDocument;
    const win = doc.defaultView || window;
    const el = (tag, cls, text) => {
        const n = doc.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined) n.textContent = text;
        return n;
    };
    const select = (pairs, value) => {
        const s = el("select", "rd-in");
        for (const [v, label] of pairs) s.append(Object.assign(el("option"), { value: String(v), textContent: label }));
        if (pairs.some(([v]) => String(v) === String(value))) s.value = String(value);
        return s;
    };
    const row = (label, ...kids) => {
        const r = el("div", "rd-row");
        r.append(el("span", "rd-label", label), ...kids);
        return r;
    };
    const make = { el, select, row };

    host.querySelectorAll(":scope > .rd-shade.export-dlg").forEach((n) => n.remove());
    const options = spec.fixed ? null : await exportOptions();
    const choices = spec.fixed ? [] : videoChoices(options, spec.formats);
    const last = spec.values || {};
    const context = spec.context === undefined ? canvasContext() : spec.context;

    const shade = el("div", "rd-shade export-dlg");
    const box = el("div", "rd-box");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", spec.title || "Export");
    const head = el("div", "rd-head");
    const x = el("button", "rd-x", "✕");
    x.title = "Close (Esc)";
    head.append(el("span", "rd-title", spec.title || "Export"), x);

    const name = el("input", "rd-in rd-text");
    name.value = spec.name || "";
    name.spellcheck = false;
    const format = spec.fixed
        ? select(spec.fixed.map((f) => [f.value, f.label]), last.format || spec.fixed[0].value)
        : select(choices.map((c) => [c.format, c.label]), last.format || (choices[0] && choices[0].format));
    const codec = el("select", "rd-in");
    const codecWrap = el("span", "rd-inline");
    codecWrap.append(el("span", "rd-sub", "Codec"), codec);
    const quality = select(((options && options.qualities) || []).map((q) => [q, q[0].toUpperCase() + q.slice(1)]),
                           last.quality || "high");
    const qualityWrap = el("span", "rd-inline");
    qualityWrap.append(el("span", "rd-sub", "Quality"), quality);
    const where = el("div", "rd-hint export-where");
    const message = el("div", "rd-message");
    const progress = el("div", "rd-progress");
    const bar = el("div", "rd-bar");
    progress.append(bar);
    const cancel = el("button", "rd-btn", "Cancel");
    const go = el("button", "rd-btn rd-go", spec.go || "Export");
    const foot = el("div", "rd-row export-foot");
    foot.append(cancel, go);

    box.append(head, row("Name", name), row("Format", format, codecWrap, spec.fixed ? "" : qualityWrap));
    for (const extra of (spec.rows ? spec.rows(make) : [])) box.append(extra);
    box.append(row("Goes to", where));
    if (spec.note) box.append(el("div", "rd-hint export-note", spec.note));
    box.append(progress, message, foot);
    shade.append(box);
    host.append(shade);

    let busy = false;
    let asked = 0;
    let picked = "";
    const read = () => {
        const choice = choices.find((c) => c.format === format.value);
        return {
            name: cleanName(name.value, cleanName(spec.name)),
            format: format.value,
            ext: format.value,
            codec: spec.fixed ? "" : codecFor(choice, codec.value),
            quality: spec.fixed ? "" : quality.value,
            context,
        };
    };
    // The codec menu follows the format; a format with one codec has nothing to choose.
    const syncCodec = () => {
        const choice = choices.find((c) => c.format === format.value);
        // Only a codec the user PICKED is carried to another format (or the one
        // they exported with last time). Carrying whatever the menu held made a
        // MOV start as H.264, simply because MP4 has nothing else.
        const keep = picked || last.codec;
        codec.replaceChildren(...((choice && choice.codecs) || []).map((c) =>
            Object.assign(el("option"), { value: c.codec, textContent: c.label })));
        codec.value = codecFor(choice, keep);
        codecWrap.style.display = choice && choice.codecs.length > 1 ? "" : "none";
    };
    // Where it will land, asked from the server so the dialog cannot disagree with the rule.
    const syncWhere = () => {
        const mine = ++asked;
        win.setTimeout(async () => {
            if (mine !== asked) return;
            const v = read();
            const t = await exportTarget(spec.kind, v.name, v.ext, context);
            if (mine !== asked || !shade.isConnected) return;
            where.textContent = t ? "output/" + t.relative : "ComfyUI's output folder";
            where.title = t && t.layout === "shot"
                ? `In the shot's folder (${context && context.source ? context.source + " node" : "the canvas"} names it). Version ${t.version}: the next one free.`
                : "No sequence and shot on the canvas, so it goes to the viewer's own folder. An AYON context or Set Path node on the canvas puts it with the shot.";
        }, 180);
    };
    const close = () => { if (!busy) shade.remove(); };

    codec.addEventListener("change", () => { picked = codec.value; });
    format.addEventListener("change", () => { syncCodec(); syncWhere(); });
    name.addEventListener("input", syncWhere);
    // Nothing typed here is a hotkey - neither the viewer's nor ComfyUI's.
    box.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape") { e.preventDefault(); close(); }
        else if (e.key === "Enter" && e.target === name) { e.preventDefault(); go.click(); }
    });
    shade.addEventListener("pointerdown", (e) => { if (e.target === shade) close(); });
    x.onclick = cancel.onclick = close;
    go.onclick = async () => {
        if (busy) return;
        busy = true;
        const fields = [...box.querySelectorAll("input, select, button")];
        fields.forEach((n) => { n.disabled = true; });
        box.classList.add("rendering");
        message.classList.remove("error");
        message.textContent = "";
        let result = null;
        try {
            result = await spec.onExport(read(), {
                progress: (done, total, text) => {
                    bar.style.width = `${Math.round(100 * done / Math.max(1, total))}%`;
                    if (text) message.textContent = text;
                },
            });
        } catch (e) {
            result = { ok: false, error: true, message: String((e && e.message) || e) };
        }
        busy = false;
        box.classList.remove("rendering");
        fields.forEach((n) => { n.disabled = false; });
        if (result && result.ok) { shade.remove(); return; }
        message.textContent = (result && result.message) || "Nothing was exported.";
        message.classList.toggle("error", !!(result && result.error !== false));
        syncWhere();
    };

    syncCodec();
    syncWhere();
    win.requestAnimationFrame(() => { name.focus(); name.select(); });
    return { close };
}

// ── picking a file that is already there ─────────────────────────────────────

/** The folders a kind of file is looked for in (export_rules.places), best first. */
export async function exportPlaces(kind, context) {
    try {
        const res = await api.fetchApi("/bepic/export_places", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind, context: context || null }),
        });
        return res.ok ? ((await res.json()).places || []) : [];
    } catch (_) { return []; }
}

const _remembered = (id) => {
    try { return localStorage.getItem("bepic.pick." + id) || ""; } catch (_) { return ""; }
};
const _remember = (id, dir) => {
    try { localStorage.setItem("bepic.pick." + id, dir); } catch (_) { /* a private window: start over next time */ }
};
const _size = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : n >= 1024 ? Math.round(n / 1024) + " KB" : n + " B");

/**
 * Open the file picker over `host`: the file browser's listing (the same route,
 * so the same folders and the same refusals) as a question with an answer. It
 * replaces every place a path used to be typed into a browser prompt().
 *
 *   spec.id        what is being picked, to remember the folder by ("scene", "stage", "clip")
 *   spec.title     "Open scene", "Add clips", …
 *   spec.kind      for the shortcuts: where files of this kind are kept (export_rules.places)
 *   spec.exts      [".json"] - the files offered; everything else in a folder is left out
 *   spec.multiple  more than one may be picked
 *   spec.go        the button's word: "Open" or "Add"
 *   spec.note      a line under the list (what picking does)
 *   spec.onPick    async (files) => ({ ok, message }) - files are the listing's { name, path, kind, ext }
 *
 * Returns { close }.
 */
export async function openFilePicker(host, spec) {
    const doc = host.ownerDocument;
    const win = doc.defaultView || window;
    const el = (tag, cls, text) => {
        const n = doc.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined) n.textContent = text;
        return n;
    };
    const exts = new Set((spec.exts || []).map((e) => String(e).toLowerCase()));
    const context = spec.context === undefined ? canvasContext() : spec.context;
    host.querySelectorAll(":scope > .rd-shade.pick-dlg").forEach((n) => n.remove());

    const shade = el("div", "rd-shade pick-dlg");
    const box = el("div", "rd-box pick-box");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", spec.title || "Pick a file");
    const head = el("div", "rd-head");
    const x = el("button", "rd-x", "✕");
    x.title = "Close (Esc)";
    head.append(el("span", "rd-title", spec.title || "Pick a file"), x);
    const jump = el("select", "rd-in pick-jump");
    jump.title = "Where files of this kind are kept, and the folders the viewer may open";
    const up = el("button", "rd-btn", "↑");
    up.title = "The folder above";
    const path = el("input", "rd-in pick-path");
    path.spellcheck = false;
    path.title = "The folder shown. Type or paste one and press Enter.";
    const bar = el("div", "pick-bar");
    bar.append(jump, up, path);
    const list = el("div", "pick-list");
    list.tabIndex = 0;
    const message = el("div", "rd-message");
    const cancel = el("button", "rd-btn", "Cancel");
    const go = el("button", "rd-btn rd-go", spec.go || "Open");
    const foot = el("div", "rd-row export-foot");
    foot.append(cancel, go);
    box.append(head, bar, list);
    if (spec.note) box.append(el("div", "rd-hint pick-note", spec.note));
    box.append(message, foot);
    shade.append(box);
    host.append(shade);

    let busy = false;
    let here = { path: "", parent: null, dirs: [], files: [] };
    let picked = new Set();
    let asked = 0;
    const close = () => { if (!busy) shade.remove(); };
    const chosen = () => here.files.filter((f) => picked.has(f.path));
    const paint = () => {
        for (const row of list.querySelectorAll(".pick-row.file")) row.classList.toggle("sel", picked.has(row.dataset.path));
        go.disabled = busy || picked.size === 0;
    };
    const pick = async () => {
        const files = chosen();
        if (busy || !files.length) return;
        busy = true;
        go.disabled = cancel.disabled = true;
        message.classList.remove("error");
        message.textContent = "";
        let result = null;
        try { result = await spec.onPick(files); }
        catch (e) { result = { ok: false, message: String((e && e.message) || e) }; }
        busy = false;
        cancel.disabled = false;
        if (result && result.ok) { shade.remove(); return; }
        message.textContent = (result && result.message) || "Nothing was picked.";
        message.classList.add("error");
        paint();
    };
    const show = (data) => {
        here = { path: data.path || "", parent: data.parent || null, dirs: data.dirs || [],
                 files: (data.files || []).filter((f) => !exts.size || exts.has(String(f.ext || "").toLowerCase())) };
        picked = new Set();
        path.value = here.path;
        up.disabled = !here.parent;
        path.scrollLeft = path.scrollWidth;          // the end of a long path is the part that tells
        const rows = [];
        for (const d of here.dirs) {
            const row = el("div", "pick-row dir");
            row.append(el("span", "pick-name", "▸ " + d.name));
            row.addEventListener("click", () => open(d.path));
            rows.push(row);
        }
        for (const f of here.files) {
            const row = el("div", "pick-row file");
            row.dataset.path = f.path;
            row.title = f.path;
            const when = f.mtime ? new Date(f.mtime * 1000).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "";
            row.append(el("span", "pick-name", f.name), el("span", "pick-meta", when), el("span", "pick-meta", _size(f.size || 0)));
            row.addEventListener("click", (e) => {
                if (spec.multiple && (e.ctrlKey || e.metaKey || e.shiftKey)) {
                    if (picked.has(f.path)) picked.delete(f.path); else picked.add(f.path);
                } else picked = new Set([f.path]);
                paint();
            });
            row.addEventListener("dblclick", () => { picked = new Set([f.path]); paint(); pick(); });
            rows.push(row);
        }
        if (!rows.length) {
            rows.push(el("div", "pick-empty", exts.size
                ? `Nothing here that can be picked (${[...exts].join(", ")}).` : "This folder is empty."));
        } else if (data.truncated) {
            rows.push(el("div", "pick-empty", "A long folder: not everything in it is listed."));
        }
        list.replaceChildren(...rows);
        list.scrollTop = 0;
        if (data.roots && !jump._filled) fillJump(data.roots);
        paint();
    };
    let places = [];
    const fillJump = (roots) => {
        jump._filled = true;
        const seen = new Set();
        const opts = [Object.assign(el("option"), { value: "", textContent: "Go to…" })];
        for (const one of [...places, ...roots]) {
            const key = String(one.path).replace(/\\/g, "/").toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            opts.push(Object.assign(el("option"), { value: one.path, textContent: one.label }));
        }
        jump.replaceChildren(...opts);
    };
    /** List a folder. Returns whether it could be shown. */
    const open = async (dir, quiet = false) => {
        const mine = ++asked;
        let data = null, status = 0;
        try {
            const res = await api.fetchApi("/bepic/browse?path=" + encodeURIComponent(dir || ""));
            status = res.status;
            data = await res.json();
        } catch (_) { /* said below */ }
        if (mine !== asked || !shade.isConnected) return false;
        if (!data || data.error) {
            if (!quiet) {
                message.textContent = (data && data.error) || `The folder could not be listed (${status || "no answer"}).`;
                message.classList.add("error");
                path.value = here.path;
            }
            if (data && data.roots && !jump._filled) fillJump(data.roots);
            return false;
        }
        message.textContent = "";
        message.classList.remove("error");
        show(data);
        if (spec.id) _remember(spec.id, here.path);
        return true;
    };

    jump.addEventListener("change", () => { const to = jump.value; jump.value = ""; if (to) open(to); });
    up.onclick = () => { if (here.parent) open(here.parent); };
    // Nothing typed here is a hotkey - neither the viewer's nor ComfyUI's.
    box.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape") { e.preventDefault(); close(); }
        else if (e.key === "Enter" && e.target === path) { e.preventDefault(); open(path.value.trim()); }
        else if (e.key === "Enter") { e.preventDefault(); pick(); }
    });
    shade.addEventListener("pointerdown", (e) => { if (e.target === shade) close(); });
    x.onclick = cancel.onclick = close;
    go.onclick = pick;
    go.disabled = true;

    // Where it opens: the folder used last time, else where this kind is kept.
    places = spec.kind ? await exportPlaces(spec.kind, context) : [];
    const starts = [spec.id ? _remembered(spec.id) : "", ...places.map((pl) => pl.path), ""];
    let shown = false;
    for (const start of starts.filter((s, i) => s || i === starts.length - 1)) {
        if (await open(start, true)) { shown = true; break; }
    }
    if (!shown && shade.isConnected) {
        message.textContent = "No folder could be listed.";
        message.classList.add("error");
    }
    win.requestAnimationFrame(() => list.focus());
    return { close };
}

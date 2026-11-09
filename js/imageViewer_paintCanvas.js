// imageViewer_paintCanvas.js
// Paint's Generate workflows and ComfyUI: a workflow kept as the canvas saves it (ComfyUI's own templates, "ui")
// is turned into a prompt by ComfyUI itself in a graph of its own, never put on the user's canvas
// (`promptOffCanvas`); one kept in the API format runs as the server has it. And the settings a dialog offers.
//
// The plain functions are tested under node (tests/test_paint_canvas.mjs); the ones taking `app` need the page.

/** The API graph's inputs that are plain values (not links), in the order to set them: a choice like `model` before its `model.*`. */
export function plainInputs(ins) {
    return Object.entries(ins || {}).filter(([, v]) => !(Array.isArray(v) && v.length === 2))
        .sort(([a], [b]) => (a.split(".").length - b.split(".").length));
}

/** object_info's input specs of a class -> [{name, kind, options?, min?, max?, step?, def}] for a dialog (no sockets). */
export function settingsOf(info, current = {}) {
    const out = [];
    const take = (prefix, group) => {
        for (const [name, spec] of Object.entries(group || {})) {
            if (!Array.isArray(spec)) continue;
            const [type, opts = {}] = spec;
            const full = prefix + name;
            if (Array.isArray(type)) { out.push({ name: full, kind: "combo", options: type.map(String), def: opts.default ?? type[0] }); continue; }
            if (type === "COMBO") { const o = opts.options || []; out.push({ name: full, kind: "combo", options: o.map(String), def: opts.default ?? o[0] }); continue; }
            if (type === "COMFY_DYNAMICCOMBO_V3") {
                const options = (opts.options || []).map((o) => String(o.key));
                const def = current[full] ?? opts.default ?? options[0];
                out.push({ name: full, kind: "combo", options, def });
                const chosen = (opts.options || []).find((o) => String(o.key) === String(def));
                if (chosen && chosen.inputs) { take(full + ".", chosen.inputs.required); take(full + ".", chosen.inputs.optional); }
                continue;
            }
            if (opts.forceInput || opts.socketless === false && !["INT", "FLOAT", "BOOLEAN", "STRING"].includes(type)) continue;
            if (type === "INT" || type === "FLOAT") {
                if (/seed$/i.test(name)) continue;           // Paint draws a new one each run
                out.push({ name: full, kind: type === "INT" ? "int" : "float", min: opts.min, max: opts.max, step: opts.step, def: opts.default ?? 0 });
            } else if (type === "BOOLEAN") out.push({ name: full, kind: "bool", def: !!opts.default });
            else if (type === "STRING" && !opts.multiline) out.push({ name: full, kind: "text", def: opts.default ?? "" });
            else if (type === "STRING" && opts.multiline) out.push({ name: full, kind: "text", def: opts.default ?? "" });
        }
    };
    if (info && info.input) { take("", info.input.required); take("", info.input.optional); }
    return out.map((s) => ({ ...s, value: Object.prototype.hasOwnProperty.call(current, s.name) && !Array.isArray(current[s.name]) ? current[s.name] : s.def }));
}

/** The settings as the paint editor's dialog takes them: [key, label, value, a, b]. */
export function dialogFields(settings, prefix = "t:") {
    return settings.map((s) => {
        const label = s.name.replace(/^model\./, "").replace(/[._]/g, " ");
        if (s.kind === "combo") return [prefix + s.name, label, String(s.value), s.options];
        if (s.kind === "bool") return [prefix + s.name, label, s.value ? "yes" : "no", ["yes", "no"]];
        if (s.kind === "text") return [prefix + s.name, label, String(s.value ?? ""), "text"];
        return [prefix + s.name, label, Number(s.value), Number.isFinite(s.min) ? s.min : -1e9, Number.isFinite(s.max) ? s.max : 1e9];
    });
}

/** The dialog's answer back to typed values: {name: value}. */
export function readFields(settings, v, prefix = "t:") {
    const out = {};
    for (const s of settings) {
        const x = v[prefix + s.name];
        if (x === undefined) continue;
        if (s.kind === "bool") out[s.name] = x === "yes";
        else if (s.kind === "int") out[s.name] = Math.round(Number(x));
        else if (s.kind === "float") out[s.name] = Number(x);
        else out[s.name] = String(x);
    }
    return out;
}

// ── a canvas-format workflow as a prompt (needs ComfyUI's app) ───────────────

/**
 * The prompt ComfyUI makes of a workflow kept as the canvas saves it, WITHOUT putting it on the canvas: the
 * workflow is configured into a graph of its own (the root graph's class, so subgraphs come along) and handed to
 * `app.graphToPrompt(graph)`. The user's canvas is not touched.
 */
export async function promptOffCanvas(app, ui) {
    const root = app && (app.rootGraph || app.graph);
    if (!root || typeof app.graphToPrompt !== "function") throw new Error("ComfyUI's app is not here");
    const Graph = root.constructor;
    const g = new Graph();
    try {
        g.configure(JSON.parse(JSON.stringify(ui)));
        const p = await app.graphToPrompt(g);
        const out = p && p.output;
        if (!out || !Object.keys(out).length) throw new Error("ComfyUI made no prompt of it");
        return out;
    } finally {
        try { if (typeof g.clear === "function") g.clear(); } catch (_) { /* gone with the graph */ }
    }
}

// ── the settings a dialog offers (Upscale…, Select objects…) ─────────────────

/** The node *ref* names in an API graph: its id, else the node of that title (paint_generate.ref_node). */
export function refIn(graph, ref) {
    const r = String(ref);
    if (graph && Object.prototype.hasOwnProperty.call(graph, r)) return r;
    const want = r.trim().toLowerCase();
    for (const [k, v] of Object.entries(graph || {})) {
        const t = v && v._meta && v._meta.title;
        if (t && String(t).trim().toLowerCase() === want) return k;
    }
    return null;
}

/** The class of the node *ref* names in a canvas-format workflow (its root nodes or its subgraphs'), or null. */
export function uiClassOf(ui, ref) {
    const r = String(ref), want = r.trim().toLowerCase();
    const all = [...(ui && ui.nodes || [])];
    for (const sg of (ui && ui.definitions && ui.definitions.subgraphs) || []) all.push(...(sg.nodes || []));
    const hit = all.find((n) => String(n.id) === r) || all.find((n) => n.title && String(n.title).trim().toLowerCase() === want);
    return hit ? hit.type : null;
}

/** Inputs a dialog never offers: what Paint itself fills in each run. */
export const NOT_TUNED = new Set(["image", "images", "filename_prefix", "prompt", "text", "model.prompt", "seed", "noise_seed", "model.seed"]);

/** settingsOf less what Paint fills in (*skip*: more names, e.g. the scale) and less inputs that are links. */
export function tuneSettings(info, current = {}, skip = []) {
    const no = new Set([...NOT_TUNED, ...skip]);
    return settingsOf(info, current).filter((s) => !no.has(s.name) && !Array.isArray(current[s.name]));
}

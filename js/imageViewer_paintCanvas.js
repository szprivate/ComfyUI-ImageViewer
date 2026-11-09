// imageViewer_paintCanvas.js
// Paint's Generate workflows on ComfyUI's canvas: each one is put there once, as a group of its own
// ("Paint · <its name>"), and that group is what runs - so what Generate did can be seen, changed and run again
// on the canvas. A workflow kept as the canvas has it (ComfyUI's own templates, "ui") is pasted as it is
// (the canvas' own paste, subgraphs and all) and turned into a prompt by ComfyUI itself (app.graphToPrompt),
// only its nodes kept; one kept in the API format ("api") is laid out node by node, for the record - the
// server's copy is what runs. The nodes carry `properties.imageviewer_paint` = the workflow's id, which is how
// the group is found again (also after the workflow is saved and opened again).
//
// The plain functions are tested under node (tests/test_paint_canvas.mjs); the ones taking `app` need the page.

export const MARK = "imageviewer_paint";
export const API_ID = "imageviewer_paint_api";
const GAP = 120;

/** A workflow as the canvas saves it -> what the canvas' paste takes ({nodes, links, groups, reroutes, subgraphs}). */
export function toClipboard(ui) {
    const links = (ui.links || []).map((L) => (Array.isArray(L)
        ? { id: L[0], origin_id: L[1], origin_slot: L[2], target_id: L[3], target_slot: L[4], type: L[5] }
        : L));
    const nodes = (ui.nodes || []).map((n) => JSON.parse(JSON.stringify(n)));
    return { nodes, links, groups: [], reroutes: [], subgraphs: JSON.parse(JSON.stringify((ui.definitions && ui.definitions.subgraphs) || [])) };
}

/** The root id of a prompt's node id ("12:5" is node 5 inside the subgraph node 12). */
export const rootId = (k) => String(k).split(":")[0];

/**
 * Only the nodes of one workflow out of the prompt of the whole canvas: those whose root is one of *ids*, and
 * whatever they take from (the user may have wired something in).
 */
export function promptOf(output, ids) {
    const want = new Set([...ids].map(String));
    const keep = new Set(Object.keys(output).filter((k) => want.has(rootId(k))));
    const todo = [...keep];
    while (todo.length) {
        const k = todo.pop();
        for (const v of Object.values((output[k] && output[k].inputs) || {})) {
            if (Array.isArray(v) && v.length === 2 && output[String(v[0])] && !keep.has(String(v[0]))) {
                keep.add(String(v[0]));
                todo.push(String(v[0]));
            }
        }
    }
    const out = {};
    for (const k of Object.keys(output)) if (keep.has(k)) out[k] = output[k];
    return out;
}

/** Where a new group goes: to the right of everything on the canvas, at the top of it. */
export function freeSpot(nodes) {
    if (!nodes.length) return [0, 0];
    let right = -Infinity, top = Infinity;
    for (const n of nodes) {
        right = Math.max(right, n.pos[0] + ((n.size && n.size[0]) || 200));
        top = Math.min(top, n.pos[1]);
    }
    return [right + GAP, top];
}

/** The API graph's inputs that are plain values (not links), in the order to set them: a choice like `model` before its `model.*`. */
export function plainInputs(ins) {
    return Object.entries(ins || {}).filter(([, v]) => !(Array.isArray(v) && v.length === 2))
        .sort(([a], [b]) => (a.split(".").length - b.split(".").length));
}

/** A node's widget by the name its input has in a prompt. */
export function widgetOf(node, name) {
    return (node && node.widgets || []).find((w) => w.name === name) || null;
}

/** Set a widget the way a hand would (so a dynamic combo grows its widgets), without throwing. */
export function setWidget(node, name, value) {
    const w = widgetOf(node, name);
    if (!w) return false;
    if (w.value === value) return true;
    try {
        w.value = value;
        if (typeof w.callback === "function") w.callback(value, null, node);
    } catch (_) { return false; }
    return true;
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

// ── on the canvas (needs ComfyUI's app) ──────────────────────────────────────

const LG = () => (typeof window !== "undefined" && (window.LiteGraph || (window.comfyAPI && window.comfyAPI.litegraph && window.comfyAPI.litegraph.LiteGraph))) || null;

/** The root graph's nodes of workflow *wid*. */
export function nodesOf(app, wid) {
    const g = app && (app.rootGraph || app.graph);
    return ((g && (g._nodes || g.nodes)) || []).filter((n) => n.properties && n.properties[MARK] === wid);
}

function groupAround(app, nodes, title) {
    const L = LG();
    const g = app.rootGraph || app.graph;
    const Group = (L && L.LGraphGroup) || (typeof window !== "undefined" && window.LGraphGroup);
    if (!Group || !g || !nodes.length) return null;
    const grp = new Group(title);
    g.add(grp);
    if (typeof grp.resizeTo === "function") grp.resizeTo(nodes, 20);
    else {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const n of nodes) { x0 = Math.min(x0, n.pos[0]); y0 = Math.min(y0, n.pos[1] - 40); x1 = Math.max(x1, n.pos[0] + n.size[0]); y1 = Math.max(y1, n.pos[1] + n.size[1]); }
        grp.pos = [x0 - 20, y0 - 20];
        grp.size = [x1 - x0 + 40, y1 - y0 + 40];
    }
    return grp;
}

function canvasRoot(app) {
    const c = app && app.canvas;
    if (!c) throw new Error("ComfyUI's canvas is not here");
    const root = app.rootGraph || app.graph;
    if (c.graph && root && c.graph !== root) throw new Error("the canvas shows a subgraph: go back to the main graph first");
    return c;
}

/** Paste a canvas-format workflow as a group: its nodes (root ones, marked). */
export function pasteWorkflow(app, wid, ui, title) {
    const c = canvasRoot(app);
    if (typeof c._deserializeItems !== "function") throw new Error("this ComfyUI's canvas cannot take a workflow from Paint (too old)");
    const g = app.rootGraph || app.graph;
    const pos = freeSpot((g._nodes || g.nodes || []).filter((n) => n.pos));
    const res = c._deserializeItems(toClipboard(ui), { position: pos });
    const made = ((res && res.created) || []).filter((n) => n && n.properties !== undefined && n.pos);
    for (const n of made) n.properties[MARK] = wid;
    groupAround(app, made, title);
    if (c.setDirty) c.setDirty(true, true);
    return made;
}

/** Lay an API-format workflow onto the canvas node by node (for the record): its nodes, marked with their prompt ids. */
export function placeApiWorkflow(app, wid, graph, title) {
    const L = LG();
    canvasRoot(app);
    if (!L || typeof L.createNode !== "function") throw new Error("ComfyUI's LiteGraph is not here");
    const g = app.rootGraph || app.graph;
    const [x0, y0] = freeSpot((g._nodes || g.nodes || []).filter((n) => n.pos));
    const ids = Object.keys(graph).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const made = {};
    ids.forEach((k, i) => {
        const v = graph[k];
        const n = L.createNode(v.class_type);
        if (!n) return;
        if (v._meta && v._meta.title) n.title = v._meta.title;
        n.pos = [x0 + (i % 4) * 340, y0 + Math.floor(i / 4) * 260];
        g.add(n);
        n.properties = n.properties || {};
        n.properties[MARK] = wid;
        n.properties[API_ID] = k;
        for (const [name, val] of plainInputs(v.inputs)) setWidget(n, name, val);
        made[k] = n;
    });
    for (const k of ids) {
        const n = made[k];
        if (!n) continue;
        for (const [name, val] of Object.entries(graph[k].inputs || {})) {
            if (!(Array.isArray(val) && val.length === 2)) continue;
            const src = made[String(val[0])];
            if (!src) continue;
            const slot = typeof n.findInputSlot === "function" ? n.findInputSlot(name) : (n.inputs || []).findIndex((x) => x.name === name);
            try { if (slot >= 0) src.connect(Number(val[1]), n, slot); } catch (_) { /* a socket that is not there: the record stays as it is */ }
        }
    }
    const nodes = Object.values(made);
    groupAround(app, nodes, title);
    const c = app.canvas;
    if (c && c.setDirty) c.setDirty(true, true);
    return nodes;
}

/** The prompt of workflow *wid* as ComfyUI makes it from the canvas (only its nodes). */
export async function promptFromCanvas(app, wid) {
    const nodes = nodesOf(app, wid);
    if (!nodes.length) throw new Error("the workflow is not on the canvas");
    const p = await app.graphToPrompt();
    const output = (p && p.output) || {};
    return promptOf(output, nodes.map((n) => n.id));
}

/** What the server filled in (one variation's graph) written onto the canvas' nodes, so the group shows what ran. */
export function writeBack(app, wid, graph) {
    const g = app && (app.rootGraph || app.graph);
    if (!g) return 0;
    const byApi = {};
    for (const n of nodesOf(app, wid)) byApi[String(n.properties[API_ID] ?? n.id)] = n;
    let k = 0;
    for (const [id, v] of Object.entries(graph || {})) {
        const n = byApi[id];
        if (!n) continue;                               // inside a subgraph: the canvas keeps what the template had
        for (const [name, val] of plainInputs(v.inputs)) if (setWidget(n, name, val)) k++;
    }
    const c = app.canvas;
    if (c && c.setDirty) c.setDirty(true, true);
    return k;
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

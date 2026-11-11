// imageViewer_depsLayout.js
// The Dependencies tab's layout, as data (no DOM): files as nodes, "made from" as edges, laid out TOP TO
// BOTTOM - what was read above, what was made from it below - the way a compositor's node graph reads.
//
// A small layered layout, enough for these graphs (mostly trees, a few merges):
//   1. rank: a node sits one row below the lowest of its inputs (longest path from a source);
//   2. order: within a row, nodes follow the average position of their inputs (two sweeps down, one up);
//   3. fold: more than FOLD_AT siblings of one kind made from the same file, with nothing made from them,
//      become one "5 depth passes" node until it is unfolded - a plate with a dozen passes stays one row wide;
//   4. prompts: the prompts a file was made with become text boxes, one row above that file, wired into it;
//   5. place: rows are centred under each other, at fixed node size.

export const NODE_W = 168;
export const NODE_H = 128;
export const GAP_X = 36;
export const GAP_Y = 64;
export const FOLD_AT = 4;

/** Group id of the folded siblings of `kind` made from `parent`. */
export const foldId = (parent, kind) => `fold:${kind}:${parent}`;

function index(graph) {
    const nodes = new Map();
    for (const n of graph.nodes || []) if (n && n.id) nodes.set(n.id, { ...n });
    const edges = (graph.edges || []).filter((e) => e && nodes.has(e.from) && nodes.has(e.to) && e.from !== e.to);
    return { nodes, edges };
}

/**
 * Fold large sibling sets. `open` is a Set of fold ids the user unfolded.
 * -> { nodes: Map, edges: [] } with fold nodes `{id, fold: true, kind, count, members: [ids]}`.
 */
export function foldGraph(graph, open = new Set()) {
    const { nodes, edges } = index(graph);
    const outDeg = new Map();
    for (const e of edges) outDeg.set(e.from, (outDeg.get(e.from) || 0) + 1);
    const inOf = new Map();
    for (const e of edges) { if (!inOf.has(e.to)) inOf.set(e.to, []); inOf.get(e.to).push(e.from); }
    const groups = new Map();                       // fold id -> member ids
    for (const e of edges) {
        const child = nodes.get(e.to);
        if (!child || child.root || outDeg.get(e.to)) continue;           // only leaves fold
        if ((inOf.get(e.to) || []).length !== 1) continue;               // made from this one file only
        const id = foldId(e.from, child.kind || "");
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(e.to);
    }
    const hidden = new Map();                       // member id -> fold id
    for (const [id, members] of groups) {
        if (members.length <= FOLD_AT || open.has(id)) continue;
        for (const m of members) hidden.set(m, id);
        const first = nodes.get(members[0]);
        nodes.set(id, { id, fold: true, kind: first.kind || "", count: members.length, members,
                        stale: members.some((m) => nodes.get(m).stale) ? "some are out of date" : "" });
    }
    for (const m of hidden.keys()) nodes.delete(m);
    const seen = new Set();
    const out = [];
    for (const e of edges) {
        const to = hidden.get(e.to) || e.to;
        const k = `${e.from}\u0000${to}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ ...e, to, label: hidden.has(e.to) ? (e.kind || e.label || "") : e.label });
    }
    return { nodes, edges: out };
}

/** Id of the text box of prompt `i` of file `id`. */
export const promptId = (id, i) => `prompt:${i}:${id}`;

/**
 * The prompts of each file as nodes of their own: `{id, prompt: true, role, text}`, with an edge (kind
 * "prompt") into the file. Changes `nodes` and `edges` in place; fold nodes carry no prompts.
 */
export function addPrompts(nodes, edges) {
    for (const n of [...nodes.values()]) {
        if (n.fold || !Array.isArray(n.prompts)) continue;
        n.prompts.forEach((p, i) => {
            if (!p || typeof p.text !== "string" || !p.text.trim()) return;
            const id = promptId(n.id, i);
            nodes.set(id, { id, prompt: true, role: p.role || "text", text: p.text, of: n.id, node: p.node || "",
                            class: p.class || "", exists: true });
            edges.push({ from: id, to: n.id, kind: "prompt", label: "" });
        });
    }
}

/** Row of each node: one below the lowest of its inputs. Cycles (should not happen) are cut. */
export function ranks(nodes, edges) {
    const ins = new Map([...nodes.keys()].map((k) => [k, []]));
    for (const e of edges) ins.get(e.to).push(e.from);
    const rank = new Map();
    const visiting = new Set();
    const rankOf = (id) => {
        if (rank.has(id)) return rank.get(id);
        if (visiting.has(id)) return 0;
        visiting.add(id);
        let r = 0;
        for (const p of ins.get(id) || []) r = Math.max(r, rankOf(p) + 1);
        visiting.delete(id);
        rank.set(id, r);
        return r;
    };
    for (const id of nodes.keys()) if (!nodes.get(id).prompt) rankOf(id);
    // A prompt sits right above the file it went into, not at the top with the sources.
    let low = 0;
    for (const [id, n] of nodes) {
        if (!n.prompt) continue;
        const r = (rank.has(n.of) ? rank.get(n.of) : 0) - 1;
        rank.set(id, r);
        low = Math.min(low, r);
    }
    if (low < 0) for (const [id, r] of rank) rank.set(id, r - low);
    return rank;
}

/**
 * Lay the graph out. -> { nodes: [{...node, x, y, w, h, row}], edges: [{...edge, x1, y1, x2, y2}],
 * width, height }. x/y are the node's top-left corner; an edge runs from the bottom middle of its input to
 * the top middle of its output.
 */
export function layout(graph, { open = new Set(), prompts = true } = {}) {
    const { nodes, edges } = foldGraph(graph, open);
    if (prompts) addPrompts(nodes, edges);
    const rank = ranks(nodes, edges);
    const rows = [];
    for (const [id, r] of rank) (rows[r] = rows[r] || []).push(id);
    for (let r = 0; r < rows.length; r++) rows[r] = (rows[r] || []).sort();
    const ins = new Map(), outs = new Map();
    for (const e of edges) {
        (ins.get(e.to) || ins.set(e.to, []).get(e.to)).push(e.from);
        (outs.get(e.from) || outs.set(e.from, []).get(e.from)).push(e.to);
    }
    const pos = new Map();
    const setPos = (row) => row.forEach((id, i) => pos.set(id, i));
    rows.forEach(setPos);
    const bary = (id, nb) => {
        const ps = (nb.get(id) || []).filter((p) => pos.has(p));
        return ps.length ? ps.reduce((s, p) => s + pos.get(p), 0) / ps.length : pos.get(id);
    };
    // Rows `from` up to (not including) `to`, either way. Bounded by the rows that exist, so an empty graph
    // (an error answer) sweeps nothing - a `r !== to` test once spun forever there and froze the page.
    const sweep = (from, to, step, nb) => {
        for (let r = from; step > 0 ? r < to : r > to; r += step) {
            if (r < 0 || r >= rows.length) continue;
            const row = rows[r];
            if (!row) continue;
            row.sort((a, b) => (bary(a, nb) - bary(b, nb)) || (pos.get(a) - pos.get(b)));
            setPos(row);
        }
    };
    for (let k = 0; k < 2; k++) { sweep(1, rows.length, 1, ins); sweep(rows.length - 2, -1, -1, outs); }
    sweep(1, rows.length, 1, ins);
    const widest = Math.max(1, ...rows.map((r) => (r || []).length));
    const width = widest * NODE_W + (widest - 1) * GAP_X;
    const placed = new Map();
    rows.forEach((row, r) => {
        const w = row.length * NODE_W + (row.length - 1) * GAP_X;
        const x0 = (width - w) / 2;
        row.forEach((id, i) => {
            placed.set(id, { ...nodes.get(id), x: x0 + i * (NODE_W + GAP_X), y: r * (NODE_H + GAP_Y),
                             w: NODE_W, h: NODE_H, row: r });
        });
    });
    const height = rows.length * NODE_H + Math.max(0, rows.length - 1) * GAP_Y;
    const laid = edges.map((e) => {
        const a = placed.get(e.from), b = placed.get(e.to);
        return { ...e, x1: a.x + a.w / 2, y1: a.y + a.h, x2: b.x + b.w / 2, y2: b.y };
    });
    return { nodes: [...placed.values()], edges: laid, width, height };
}

export const MIN_W = 96;
export const MIN_H = 72;

/**
 * A laid-out graph with the nodes the user moved or resized put where they left them. *place* is
 * {id: {x?, y?, w?, h?}}; a node it does not name keeps its place, an entry for a node that is not there is
 * ignored. Sizes are held to MIN_W x MIN_H and corners to x, y >= 0 (the stage starts at 0, 0). The edges
 * are worked out again from the new boxes, and width / height grow to hold every node. Pure.
 */
export function applyPlacement(L, place = {}) {
    if (!L || !place || !Object.keys(place).length) return L;
    const nodes = L.nodes.map((n) => {
        const p = place[n.id];
        if (!p) return n;
        const w = Math.max(MIN_W, Number.isFinite(p.w) ? p.w : n.w);
        const h = Math.max(MIN_H, Number.isFinite(p.h) ? p.h : n.h);
        // No bound on where a node goes: left of / above the layout too (the stage is not a frame).
        const x = Number.isFinite(p.x) ? p.x : n.x;
        const y = Number.isFinite(p.y) ? p.y : n.y;
        return { ...n, x, y, w, h, placed: true };
    });
    const at = new Map(nodes.map((n) => [n.id, n]));
    const edges = L.edges.map((e) => {
        const a = at.get(e.from), b = at.get(e.to);
        return a && b ? { ...e, x1: a.x + a.w / 2, y1: a.y + a.h, x2: b.x + b.w / 2, y2: b.y } : e;
    });
    const width = Math.max(L.width, ...nodes.map((n) => n.x + n.w));
    const height = Math.max(L.height, ...nodes.map((n) => n.y + n.h));
    // x0 / y0: where the drawing begins, below 0 when a node was moved left of / above the layout.
    const x0 = Math.min(0, ...nodes.map((n) => n.x));
    const y0 = Math.min(0, ...nodes.map((n) => n.y));
    return { nodes, edges, width, height, x0, y0 };
}

/** The ids of the nodes a box ({x0, y0, x1, y1}, stage pixels, any corner order) touches. Pure. */
export function nodesInBox(L, box) {
    const ax = Math.min(box.x0, box.x1), bx = Math.max(box.x0, box.x1);
    const ay = Math.min(box.y0, box.y1), by = Math.max(box.y0, box.y1);
    return ((L && L.nodes) || []).filter((n) => n.x + n.w > ax && n.x < bx && n.y + n.h > ay && n.y < by).map((n) => n.id);
}

/** An edge as an SVG path: a vertical S-curve from (x1, y1) down to (x2, y2). */
export function edgePath(e) {
    const dy = Math.max(24, (e.y2 - e.y1) / 2);
    return `M${e.x1},${e.y1} C${e.x1},${e.y1 + dy} ${e.x2},${e.y2 - dy} ${e.x2},${e.y2}`;
}

// ── a node's frame: still or film, and the model it was made with ──

const VIDEO_EXT = new Set(["mp4", "mov", "webm", "mkv", "m4v", "avi", "gif"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "exr", "tif", "tiff", "bmp", "dpx", "hdr", "avif", "tga"]);
/** "video", "image" or "" (sound, 3D, anything else gets no frame), by the file's extension. */
export const depsMediaOf = (name) => {
    const ext = String(name || "").split(/[\\/]/).pop().split(".").pop().toLowerCase();
    return VIDEO_EXT.has(ext) ? "video" : IMAGE_EXT.has(ext) ? "image" : "";
};
/** The caption of a node's frame: its main models ("flux1-dev + 2 LoRA"), "" with none. Pure. */
export const depsModelCaption = (models) => {
    const list = Array.isArray(models) ? models : [];
    const main = list.filter((m) => m.role === "model" || m.role === "partner").map((m) => m.name);
    const loras = list.filter((m) => m.role === "lora").length;
    const ups = list.filter((m) => m.role === "upscale").map((m) => m.name);
    const head = main.length ? main.slice(0, 2).join(" + ") + (main.length > 2 ? ` +${main.length - 2}` : "") : ups.slice(0, 1).join("");
    return [head, loras ? `${loras} LoRA` : ""].filter(Boolean).join(" + ");
};

/** The whole caption: a file's tags (the service that made it, e.g. "magnific", then its model) where it
 *  has them, else its models ("flux1-dev + 2 LoRA"). Pure. */
export const depsCaption = (models, tags) => {
    const t = (Array.isArray(tags) ? tags : []).filter(Boolean);
    if (t.length) return t.join(" · ");
    return depsModelCaption(models);
};

// imageViewer_depsLayout.js
// The Dependencies tab's layout, as data (no DOM): files as nodes, "made from" as edges, laid out TOP TO
// BOTTOM - what was read above, what was made from it below - the way a compositor's node graph reads.
//
// A small layered layout, enough for these graphs (mostly trees, a few merges):
//   1. rank: a node sits one row below the lowest of its inputs (longest path from a source);
//   2. order: within a row, nodes follow the average position of their inputs (two sweeps down, one up);
//   3. fold: more than FOLD_AT siblings of one kind made from the same file, with nothing made from them,
//      become one "5 depth passes" node until it is unfolded - a plate with a dozen passes stays one row wide;
//   4. place: rows are centred under each other, at fixed node size.

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
    for (const id of nodes.keys()) rankOf(id);
    return rank;
}

/**
 * Lay the graph out. -> { nodes: [{...node, x, y, w, h, row}], edges: [{...edge, x1, y1, x2, y2}],
 * width, height }. x/y are the node's top-left corner; an edge runs from the bottom middle of its input to
 * the top middle of its output.
 */
export function layout(graph, { open = new Set() } = {}) {
    const { nodes, edges } = foldGraph(graph, open);
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
    const sweep = (from, to, step, nb) => {
        for (let r = from; r !== to; r += step) {
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

/** An edge as an SVG path: a vertical S-curve from (x1, y1) down to (x2, y2). */
export function edgePath(e) {
    const dy = Math.max(24, (e.y2 - e.y1) / 2);
    return `M${e.x1},${e.y1} C${e.x1},${e.y1 + dy} ${e.x2},${e.y2 - dy} ${e.x2},${e.y2}`;
}

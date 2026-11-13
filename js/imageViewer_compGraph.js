// imageViewer_compGraph.js
// Comp: how a graph with groups, dots, backdrops and sticky notes is rendered - by laying it out FLAT first.
// Imports nothing; src/comp_graph.py is the same in Python.
//
// A GROUP node holds a graph of its own (`nodes`), with an Input node per port (`group_input`, `index` = the
// port, in order) and one `group_output`; the group's `inputs` are what comes into those ports. Ids inside a
// group are its own (another level may use the same ones).
// flattenComp(comp) gives the comp the renderers see: every group's nodes at the top level with ids
// "<group id>/<their id>" (nested groups again), every Dot, group Input, group Output and group taken out of
// the wires (a wire to one goes to what it passes on), backdrops and sticky notes left out. A disabled group
// passes its first input. Node ids the editor uses for a node inside a group are these flat ids; flatNode finds
// the node they name in the tree, resolveId what a flat id stands for once Dots and groups are gone.
// Expressions (imageViewer_compExpr.js) name other nodes of the SAME graph, then of the graphs around it:
// each node of a flat comp (and of a tree, bindScopes) carries its graph's scope, `__scope` (not enumerable,
// so never saved).

export const SEP = "/";
/** Nodes that are no picture: drawn in the graph only. */
export const GRAPH_ONLY = new Set(["backdrop", "sticky"]);
/** Nodes the flat comp has no node for: a wire to one goes to what it passes on. */
export const PASSING = new Set(["dot", "group", "group_input", "group_output"]);

/** A group's Input nodes, in the order of its ports. */
export function groupInputs(g) {
    return ((g && g.nodes) || []).map((n, i) => [n, i]).filter(([n]) => n.type === "group_input")
        .sort((a, b) => ((a[0].index ?? 1e9) - (b[0].index ?? 1e9)) || a[1] - b[1]).map(([n]) => n);
}
/** A group's Output node (the first one), or null. */
export function groupOutput(g) { return ((g && g.nodes) || []).find((n) => n.type === "group_output") || null; }

function needsFlat(nodes) {
    for (const n of nodes || []) if (PASSING.has(n.type) || GRAPH_ONLY.has(n.type) || n.expr) return true;
    return false;
}
const hide = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: false, configurable: true, writable: true });

const kept = [];   // the last few flattenings, by what they were made from
/** The comp the renderers see (see the top of the file); the comp itself when it has nothing to flatten. */
export function flattenComp(comp) {
    if (!comp || comp.__flat || !needsFlat(comp.nodes)) return comp;
    const key = JSON.stringify([comp.format, comp.output, comp.nodes]);
    const had = kept.find((k) => k.key === key);
    if (had) return had.flat;
    const nodes = [], alias = new Map();
    const lay = (level, prefix, ins, ports, parent) => {
        const scope = { nodes: new Map(), format: comp.format, parent };
        for (const n of level || []) {
            if (!n || typeof n !== "object") continue;
            const fid = prefix + n.id, t = n.type;
            const up = (i) => (n.inputs && n.inputs[i] ? prefix + n.inputs[i] : null);
            if (GRAPH_ONLY.has(t)) continue;
            if (t === "dot" || t === "group_output") { alias.set(fid, up(0)); continue; }
            if (t === "group_input") { alias.set(fid, ins && ports.has(n.id) ? (ins[ports.get(n.id)] ?? null) : null); continue; }
            if (t === "group") {
                const gi = (n.inputs || []).map((_, i) => up(i));
                if (n.disable) { alias.set(fid, gi[0] ?? null); continue; }
                lay(n.nodes, fid + SEP, gi, new Map(groupInputs(n).map((x, k) => [x.id, k])), scope);
                const go = groupOutput(n);
                alias.set(fid, go ? fid + SEP + go.id : null);
                continue;
            }
            const c = Object.assign({}, n, { id: fid, inputs: (n.inputs || []).map((_, i) => up(i)) });
            // A Paint stroke that follows a Transform names it by its id in this graph.
            if (prefix && Array.isArray(n.strokes) && n.strokes.some((st) => st && typeof st.link === "string" && st.link))
                c.strokes = n.strokes.map((st) => (st && typeof st.link === "string" && st.link ? Object.assign({}, st, { link: prefix + st.link }) : st));
            nodes.push(c);
            scope.nodes.set(n.id, c);
        }
        for (const c of scope.nodes.values()) hide(c, "__scope", scope);
    };
    lay(comp.nodes, "", null, new Map(), null);
    const final = (id) => { let d = 0; while (id && alias.has(id) && d++ < 512) id = alias.get(id); return d >= 512 ? null : id; };
    for (const c of nodes) c.inputs = c.inputs.map(final);
    const flat = Object.assign({}, comp, { nodes, output: final(comp.output) });
    const resolved = new Map([...alias.keys()].map((k) => [k, final(k)]));
    hide(flat, "__flat", true);
    hide(flat, "__alias", resolved);
    kept.push({ key, flat });
    if (kept.length > 6) kept.shift();
    return flat;
}

/** What a flat id stands for in a flat comp (a Dot or a group: the node whose picture it passes on). */
export function resolveId(flat, id) { return flat && flat.__alias && flat.__alias.has(id) ? flat.__alias.get(id) : id; }

/** The graph inside the groups `path` (a list of group ids from the top): the group node, or null for the top. */
export function groupAt(comp, path) {
    let level = comp ? comp.nodes : [], g = null;
    for (const id of path || []) {
        g = (level || []).find((n) => n.id === id && n.type === "group");
        if (!g) return undefined;
        level = g.nodes || (g.nodes = []);
    }
    return g;
}

/**
 * The graph inside the groups `path` as a comp-like object every graph edit of compModel works on (its `nodes`
 * are the group's, read again each time from `root()`, so an undo that swaps the comp is followed). The top
 * level (an empty path) is the comp itself.
 */
export function levelView(root, path) {
    if (!path || !path.length) return root();
    const g = () => groupAt(root(), path) || { nodes: [] };
    return {
        comp: 1,
        get format() { return root().format; },
        get nodes() { return g().nodes || (g().nodes = []); },
        set nodes(v) { g().nodes = v; },
        get output() { const o = groupOutput(g()); return o ? o.id : null; },
        set output(_) { /* a group's output is its Output node */ },
        get __level() { return path; },
    };
}

/** The flat id of node `id` of the graph inside `path`. */
export const flatId = (path, id) => (path && path.length ? path.join(SEP) + SEP : "") + id;

/** The node of the tree a flat id names (trying every group whose id begins it: ids may hold the separator). */
export function flatNode(comp, fid) {
    const find = (level, rest) => {
        for (const n of level || []) {
            if (n.id === rest) return n;
            if (n.type === "group" && rest.startsWith(n.id + SEP)) { const r = find(n.nodes, rest.slice(n.id.length + SEP.length)); if (r) return r; }
        }
        return null;
    };
    return comp && typeof fid === "string" ? find(comp.nodes, fid) : null;
}

/** Gives every node of the tree its graph's scope (for expressions on the stored nodes, as the panel shows them). */
export function bindScopes(comp) {
    const bind = (level, parent) => {
        const scope = { nodes: new Map(), format: comp.format, parent };
        for (const n of level || []) if (n && typeof n === "object") scope.nodes.set(n.id, n);
        for (const n of scope.nodes.values()) { hide(n, "__scope", scope); if (n.type === "group") bind(n.nodes, scope); }
    };
    if (comp) bind(comp.nodes, null);
    return comp;
}

/** A node of a scope by its id: that graph first, then the graphs around it. */
export function scopeNode(scope, id) {
    for (let s = scope; s; s = s.parent) if (s.nodes.has(id)) return s.nodes.get(id);
    return null;
}

/** Every node of the tree with the path of groups it is in: [{node, path}], the top level first. */
export function walkTree(comp) {
    const out = [];
    const go = (level, path) => { for (const n of level || []) { out.push({ node: n, path }); if (n.type === "group") go(n.nodes, [...path, n.id]); } };
    if (comp) go(comp.nodes, []);
    return out;
}

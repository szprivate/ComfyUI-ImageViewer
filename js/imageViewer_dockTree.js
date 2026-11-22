// imageViewer_dockTree.js
// The viewer's panel layout as a tree of splits (Sebastian 2026-11-19: "the main views should become panels as
// well ... more panels side by side, or split panels horizontally and vertically"). Pure: plain objects, no DOM, so
// it runs under node (tests/test_dock_tree.mjs). imageViewer_mixinDock.js draws it.
//
//   layout = { v: 2, root }
//   a split   { split: "row" | "col", children: [node...], size?, px?, rail? }
//   a panel   { id, size?, px?, hidden?, tab?, behind?, collapsed? }
//   the view  { view: true, size? }                    the picture: the viewport and the Source viewer beside it
//
// A child of a split takes the room along the split's direction by `px` (fixed, what the old rails' width / height
// was) or by `size` (a share of what is left, what a panel's share of a rail was). A node that holds the view never
// keeps a fixed size: the picture takes what the panels leave. `rail` names the split that was a rail ("left",
// "right", "bottom"); a panel that comes back to where it shipped goes there.
//
// Tabs are as they were in a rail: children of ONE split that carry the same `tab`, next to each other, one of the
// open ones in front (`behind` on the rest). The view can be one of them (Sebastian 2026-11-20: a panel dropped on
// the main view's middle becomes a tab of it); it is never hidden, so it is always one of the open ones.

export const LAYOUT_VERSION = 2;
export const EDGES = ["left", "right", "top", "bottom"];

export const isSplit = (n) => !!(n && Array.isArray(n.children) && (n.split === "row" || n.split === "col"));
export const isView = (n) => !!(n && n.view === true);
export const isPanel = (n) => !!(n && typeof n.id === "string" && !isSplit(n) && !isView(n));
/** Can the node be a member of a tab group: a panel, or the view. */
export const isTabbable = (n) => isPanel(n) || isView(n);
/** The members of tab group `tab` among a split's children (none for no tab). */
export const tabMates = (list, tab) => (tab ? list.filter((p) => isTabbable(p) && p.tab === tab) : []);
/** The split direction an edge belongs to: beside = a row, above / below = a column. */
export const edgeDir = (edge) => (edge === "left" || edge === "right") ? "row" : "col";
const before = (edge) => edge === "left" || edge === "top";

/** Is the node drawn at all: the view always, a panel while open, a split while anything in it is. */
export function isLive(n) {
    if (isView(n)) return true;
    if (isPanel(n)) return !n.hidden;
    if (isSplit(n)) return n.children.some(isLive);
    return false;
}

/** The children of a split that take room: drawn, and not behind another's tab. */
export function shownChildren(split) {
    return isSplit(split) ? split.children.filter((c) => isLive(c) && !c.behind) : [];
}

export function containsView(n) {
    if (isView(n)) return true;
    return isSplit(n) && n.children.some(containsView);
}

/** Every node, depth first: fn(node, parent, index, depth). */
export function walk(n, fn, parent = null, index = -1, depth = 0) {
    if (!n) return;
    fn(n, parent, index, depth);
    if (isSplit(n)) n.children.slice().forEach((c, i) => walk(c, fn, n, i, depth + 1));
}

/** Every panel entry, in order. */
export function panels(root) {
    const out = [];
    walk(root, (n) => { if (isPanel(n)) out.push(n); });
    return out;
}

/** Where a node is: { node, parent, index } (parent null for the root), or null. `match` is a node, or a panel id. */
export function locate(root, match) {
    let hit = null;
    const want = typeof match === "string" ? (n) => isPanel(n) && n.id === match : (n) => n === match;
    walk(root, (n, parent, index) => { if (!hit && want(n)) hit = { node: n, parent, index }; });
    return hit;
}

export function findView(root) {
    let hit = null;
    walk(root, (n, parent, index) => { if (!hit && isView(n)) hit = { node: n, parent, index }; });
    return hit;
}

/** The chain of splits from the root down to the node (not including it). */
export function ancestors(root, node) {
    const path = [];
    const go = (n) => {
        if (n === node) return true;
        if (!isSplit(n)) return false;
        path.push(n);
        for (const c of n.children) if (go(c)) return true;
        path.pop();
        return false;
    };
    return go(root) ? path : null;
}

/** The split a rail became, or null. */
export function railNode(root, side) {
    let hit = null;
    walk(root, (n) => { if (!hit && isSplit(n) && n.rail === side) hit = n; });
    return hit;
}

/**
 * Which way from the picture a panel is: its rail's side, else the side of the view it lies on at the first split
 * that holds both ("left" / "right" / "top" / "bottom"); null when the panel is not in the layout.
 */
export function sideOf(root, id) {
    const at = locate(root, id);
    if (!at) return null;
    const up = ancestors(root, at.node) || [];
    for (let i = up.length - 1; i >= 0; i--) if (up[i].rail) return up[i].rail;
    for (let i = up.length - 1; i >= 0; i--) {
        const s = up[i];
        const vi = s.children.findIndex(containsView);
        if (vi < 0) continue;
        const pi = s.children.findIndex((c) => ancestors(c, at.node) !== null);
        if (s.split === "row") return pi < vi ? "left" : "right";
        return pi < vi ? "top" : "bottom";
    }
    return "right";
}

// ── Tidying ───────────────────────────────────────────────────────────────

/**
 * Keep the tree well formed: unknown and doubled panels out, empty splits out, a split of one child replaced by that
 * child (a rail keeps its split while it holds a panel), one view, the root always a split, every tab group one
 * piece with one open member in front. `known(id)` says whether a panel id exists. Returns the (maybe new) root.
 */
export function tidy(root, known = () => true) {
    const seen = new Set();
    let views = 0;
    const clean = (n, isRoot) => {
        if (isView(n)) {
            if (views++) return null;
            const v = { view: true };
            if (n.size > 0) v.size = n.size;
            if (typeof n.tab === "string" && n.tab) { v.tab = n.tab; v.behind = !!n.behind; }
            return v;
        }
        if (isPanel(n)) {
            if (!known(n.id) || seen.has(n.id)) return null;
            seen.add(n.id);
            n.hidden = !!n.hidden;
            if (!(n.size > 0)) delete n.size;
            if (!(n.px > 0)) delete n.px;
            if (!n.collapsed) delete n.collapsed;
            return n;
        }
        if (!isSplit(n)) return null;
        n.children = n.children.map((c) => clean(c, false)).filter(Boolean);
        // A split inside a split of the same way, that is no rail and has no fixed size: its children are the parent's.
        const flat = [];
        for (const c of n.children) {
            if (isSplit(c) && c.split === n.split && !c.rail && !(c.px > 0)) {
                const share = c.size > 0 ? c.size : 1;
                const sum = c.children.reduce((s, k) => s + (k.px > 0 ? 0 : (k.size > 0 ? k.size : 1)), 0) || 1;
                for (const k of c.children) {
                    if (!(k.px > 0)) k.size = share * ((k.size > 0 ? k.size : 1) / sum);
                    flat.push(k);
                }
            } else flat.push(c);
        }
        n.children = flat;
        if (!(n.size > 0)) delete n.size;
        if (!(n.px > 0)) delete n.px;
        if (!n.rail) delete n.rail;
        regroupTabs(n);
        if (isRoot) return n;
        if (!n.children.length) return null;
        if (n.children.length === 1 && !(n.rail && isPanel(n.children[0]))) {
            const only = n.children[0];
            // The child takes the split's place, and its room.
            delete only.px; delete only.size;
            if (n.px > 0) only.px = n.px;
            if (n.size > 0) only.size = n.size;
            if (isSplit(only) && !only.rail && n.rail) only.rail = n.rail;
            return only;
        }
        return n;
    };
    if (!isSplit(root)) root = { split: "row", children: root ? [root] : [] };
    root = clean(root, true);
    // A root of one split is that split.
    while (root.children.length === 1 && isSplit(root.children[0])) {
        const only = root.children[0];
        delete only.px; delete only.size;
        root = only;
    }
    delete root.px; delete root.size;
    if (!views) root.children.push({ view: true });
    // The view's chain never has a fixed size.
    const up = ancestors(root, findView(root).node) || [];
    for (const s of up) delete s.px;
    const vat = findView(root);
    delete vat.node.px;
    // ...nor do the panels that share its place as tabs: they take the room the view has.
    if (vat.node.tab && vat.parent) for (const p of tabMates(vat.parent.children, vat.node.tab)) delete p.px;
    return root;
}

/** One split's tab groups: members next to each other where the first is, one open member in front. */
export function regroupTabs(split) {
    const list = split.children;
    const groups = new Map();
    for (const p of list) {
        if (!isTabbable(p)) continue;
        if (typeof p.tab !== "string" || !p.tab) { delete p.tab; if (isView(p)) delete p.behind; else p.behind = false; continue; }
        if (!groups.has(p.tab)) groups.set(p.tab, []);
        groups.get(p.tab).push(p);
    }
    for (const members of groups.values()) {
        if (members.length < 2) {
            delete members[0].tab;
            if (isView(members[0])) delete members[0].behind; else members[0].behind = false;
            continue;
        }
        const open = members.filter((p) => !p.hidden);
        const front = open.find((p) => !p.behind) || open[0];
        for (const p of members) p.behind = p !== front;
    }
    const out = [], done = new Set();
    for (const p of list) {
        if (!isTabbable(p) || !p.tab) { out.push(p); continue; }
        if (done.has(p.tab)) continue;
        done.add(p.tab);
        out.push(...tabMates(list, p.tab));
    }
    split.children = out;
}

// ── Edits ─────────────────────────────────────────────────────────────────

/** Take a node out of the tree (its tab group closes over it). Returns the node, or null. */
export function detach(root, match) {
    const at = locate(root, match);
    if (!at || !at.parent) return null;
    at.parent.children.splice(at.index, 1);
    const n = at.node;
    if (isTabbable(n)) {
        if (n.tab) {
            const mates = tabMates(at.parent.children, n.tab);
            if (!n.behind && !n.hidden) {
                const next = mates.find((p) => !p.hidden);
                if (next) { next.behind = false; if (n.size > 0) next.size = n.size; if (n.px > 0) next.px = n.px; }
            }
        }
        delete n.tab;
        if (isView(n)) delete n.behind; else n.behind = false;
    }
    delete n.px; delete n.size;
    return n;
}

/**
 * Put `node` beside `ref` (a node in the tree) on `edge`. Beside a node of the same way it becomes a sibling;
 * otherwise `ref` is split in two. Beside the picture's chain the newcomer takes a fixed room (`px`), elsewhere a
 * share like its neighbours. Returns the root.
 */
export function insertBeside(root, ref, edge, node, px = 300) {
    const dir = edgeDir(edge);
    const at = locate(root, ref);
    if (!at) return root;
    const sizeNew = (siblings) => {
        if (containsView(ref) || siblings.some((s) => containsView(s))) { node.px = px; delete node.size; return; }
        const shares = siblings.filter((s) => !(s.px > 0) && isLive(s) && !s.behind).map((s) => s.size > 0 ? s.size : 1);
        node.size = shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : 1;
        delete node.px;
    };
    if (at.parent && at.parent.split === dir) {
        const list = at.parent.children;
        // Not into the middle of a tab group: beside the group as a whole.
        let i = at.index;
        if (isTabbable(ref) && ref.tab) {
            const idx = list.map((p, k) => (isTabbable(p) && p.tab === ref.tab ? k : -1)).filter((k) => k >= 0);
            i = before(edge) ? idx[0] : idx[idx.length - 1];
        }
        sizeNew(list);
        list.splice(before(edge) ? i : i + 1, 0, node);
        return root;
    }
    if (!at.parent && isSplit(ref) && ref.split === dir) {
        sizeNew(ref.children);
        if (before(edge)) ref.children.unshift(node); else ref.children.push(node);
        return root;
    }
    // Split `ref` in two: the pair takes its place and its room. A tab group is split as one.
    const holder = at.parent;
    const wrap = { split: dir, children: [] };
    let group = [ref];
    if (holder && isTabbable(ref) && ref.tab) group = tabMates(holder.children, ref.tab);
    const first = holder ? holder.children.indexOf(group[0]) : -1;
    const room = group.find((p) => !p.behind && !p.hidden) || ref;
    if (room.px > 0) wrap.px = room.px;
    if (room.size > 0) wrap.size = room.size;
    for (const g of group) { delete g.px; delete g.size; }
    sizeNew(group);
    if (!group.some(containsView)) { delete node.px; node.size = 1; }
    for (const g of group) if (!containsView(g)) g.size = 1;
    wrap.children = before(edge) ? [node, ...group] : [...group, node];
    if (!holder) {
        // The root itself: the new pair is the root.
        delete wrap.px; delete wrap.size;
        return wrap;
    }
    holder.children = holder.children.filter((c) => !group.includes(c));
    holder.children.splice(first, 0, wrap);
    return root;
}

/** Put a panel into the place of another (a panel id, or the view node), as a tab beside it, in front. */
export function insertAsTab(root, ontoId, node) {
    const at = ontoId === "view" || isView(ontoId) ? findView(root) : locate(root, ontoId);
    if (!at || !at.parent || !isTabbable(at.node)) return root;
    const onto = at.node;
    if (!onto.tab) onto.tab = "t" + (isView(onto) ? "view" : onto.id);
    node.tab = onto.tab;
    node.hidden = false;
    if (onto.px > 0) node.px = onto.px; else delete node.px;
    if (onto.size > 0) node.size = onto.size; else delete node.size;
    const list = at.parent.children;
    let i = at.index;
    list.forEach((p, k) => { if (isTabbable(p) && p.tab === node.tab) i = k; });
    list.splice(i + 1, 0, node);
    for (const p of list) if (isTabbable(p) && p.tab === node.tab) p.behind = p !== node;
    return root;
}

// ── The old shape ─────────────────────────────────────────────────────────

/**
 * A layout of the three rails ({left, right, bottom}: {width | height, panels}) as a tree: the side rails beside the
 * picture, the bottom rail under all three - where they stood.
 */
export function fromRails(old) {
    const rail = (side, dir, px) => {
        const src = (old && old[side]) || {};
        const list = Array.isArray(src.panels) ? src.panels : [];
        const want = side === "bottom" ? src.height : src.width;
        return {
            split: dir, rail: side, px: want > 0 ? want : px,
            children: list.filter((p) => p && typeof p.id === "string").map((p) => ({
                id: p.id, size: p.size > 0 ? p.size : 1, hidden: !!p.hidden,
                ...(typeof p.tab === "string" && p.tab ? { tab: p.tab, behind: !!p.behind } : {}),
                ...(p.collapsed ? { collapsed: true } : {}),
            })),
        };
    };
    const left = rail("left", "col", 88), right = rail("right", "col", 300), bottom = rail("bottom", "row", 240);
    return {
        v: LAYOUT_VERSION,
        root: { split: "col", children: [{ split: "row", children: [left, { view: true }, right] }, bottom] },
    };
}

/** Is this a saved layout of either shape? */
export function isTreeLayout(data) {
    return !!(data && typeof data === "object" && data.v === LAYOUT_VERSION && isSplit(data.root));
}
export function isRailLayout(data) {
    return !!(data && typeof data === "object" && !data.root && (data.left || data.right));
}

/** A deep copy that keeps only the fields a layout is made of. */
export function cleanCopy(n) {
    if (isView(n)) return { view: true, ...(n.size > 0 ? { size: n.size } : {}), ...(n.tab ? { tab: n.tab, behind: !!n.behind } : {}) };
    if (isSplit(n)) {
        return { split: n.split, children: n.children.map(cleanCopy).filter(Boolean),
                 ...(n.size > 0 ? { size: n.size } : {}), ...(n.px > 0 ? { px: Math.round(n.px) } : {}),
                 ...(n.rail ? { rail: n.rail } : {}) };
    }
    if (isPanel(n)) {
        return { id: n.id, hidden: !!n.hidden,
                 ...(n.size > 0 ? { size: n.size } : {}), ...(n.px > 0 ? { px: Math.round(n.px) } : {}),
                 ...(n.tab ? { tab: n.tab, behind: !!n.behind } : {}), ...(n.collapsed ? { collapsed: true } : {}) };
    }
    return null;
}

// ── Sizes ─────────────────────────────────────────────────────────────────

/**
 * The least room a node needs along an axis ("w" or "h"): a panel its own minimum (a folded one its title bar),
 * a split the sum of its shown children's along its own way (plus the splitters) and the largest across it.
 * `minOf(id)` gives a panel's {w, h}.
 */
export function minSize(n, axis, minOf, gap = 5, view = { w: 160, h: 120 }) {
    if (isView(n)) return view[axis];
    if (isPanel(n)) {
        const m = minOf(n.id) || { w: 60, h: 60 };
        // Folded: its title bar's height; across, no wider than a folded bar needs (140), never more than open.
        if (n.collapsed) return axis === "h" ? 26 : Math.min(140, m.w || 140);
        return m[axis] || 0;
    }
    if (!isSplit(n)) return 0;
    const kids = shownChildren(n);
    if (!kids.length) return 0;
    const along = (n.split === "row") === (axis === "w");
    const each = kids.map((k) => minSize(k, axis, minOf, gap, view));
    return along ? each.reduce((a, b) => a + b, 0) + gap * (kids.length - 1) : Math.max(...each);
}

/** Are all of a node's shown parts folded to their title bars? */
export function allFolded(n) {
    if (isPanel(n)) return !!n.collapsed;
    if (isSplit(n)) { const k = shownChildren(n); return k.length > 0 && k.every(allFolded); }
    return false;
}

/**
 * Does a child of a split shrink to its title bars along that split? A folded panel gives up its HEIGHT only, so in a
 * column it takes no more room than its bar; across a row (a pane beside the picture whose panels are all folded) it
 * keeps its width, as an open pane does - it was squeezed to a few pixels before (Sebastian 2026-11-20).
 */
export function foldedAlong(split, k) {
    return split.split !== "row" && allFolded(k);
}

/**
 * How each shown child of a split takes its room: [{node, grow, basis}] for CSS flex (grow 0 + basis px = fixed;
 * basis "auto" = as small as it is). Shares that add up to less than 1 are scaled up (CSS hands out only that part of
 * the free room); with no child left to grow, the fixed ones grow by their sizes.
 */
export function flexOf(split) {
    const kids = shownChildren(split);
    const fixed = (k) => k.px > 0 && !containsView(k);
    const folded = (k) => foldedAlong(split, k);
    const growers = kids.filter((k) => !fixed(k) && !folded(k));
    const sum = growers.reduce((s, k) => s + (k.size > 0 ? k.size : 1), 0);
    const scale = sum > 0 && sum < 1 ? 1 / sum : 1;
    return kids.map((k) => {
        if (folded(k)) return { node: k, grow: 0, basis: "auto" };
        if (fixed(k)) return growers.length ? { node: k, grow: 0, basis: k.px } : { node: k, grow: k.px, basis: 0 };
        return { node: k, grow: (k.size > 0 ? k.size : 1) * scale, basis: 0 };
    });
}

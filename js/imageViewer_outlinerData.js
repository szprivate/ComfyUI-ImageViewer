// imageViewer_outlinerData.js
// What the 3D Outliner shows: which rows, at which depth, given the search
// words, the kinds switched off in its filter and what is folded.
// Pure (no DOM, no three.js), so tests/test_outliner_data.mjs runs it under node.

/** The filter's kinds, in the menu's order. `of` is the item kinds it covers. */
export const OUTLINER_KINDS = [
    { key: "model", label: "Models", of: ["model"] },
    { key: "primitive", label: "Shapes", of: ["primitive"] },
    { key: "camera", label: "Cameras", of: ["camera"] },
    { key: "imageplane", label: "Image planes", of: ["imageplane"] },
    { key: "group", label: "Groups", of: ["group"] },
    { key: "control", label: "Rig controls", of: ["control"] },
    { key: "light", label: "Lights", of: ["light"] },
    { key: "world", label: "World", of: ["environment", "terrain", "scatter", "depthmesh"] },
    { key: "bones", label: "Skeletons", of: [] },
];

/** Which rows by their state: all of them, or only the visible / selected / animated ones. */
export const OUTLINER_STATES = [
    { key: "all", label: "All" },
    { key: "visible", label: "Visible" },
    { key: "selected", label: "Selected" },
    { key: "animated", label: "Animated" },
];

const KIND_KEY = new Map();
for (const k of OUTLINER_KINDS) for (const kind of k.of) KIND_KEY.set(kind, k.key);

/** The filter kind of an item ("model" for anything unknown). */
export function outlinerKindOf(item) {
    return (item && KIND_KEY.get(item.kind)) || "model";
}

/** The filter as kept: { hidden: [kind keys], state }, cleaned. */
export function cleanOutlinerFilter(raw) {
    const known = new Set(OUTLINER_KINDS.map((k) => k.key));
    const states = new Set(OUTLINER_STATES.map((s) => s.key));
    const hidden = raw && Array.isArray(raw.hidden) ? [...new Set(raw.hidden.filter((k) => known.has(k)))] : [];
    const state = raw && states.has(raw.state) ? raw.state : "all";
    return { hidden, state };
}

/** True when the filter shows everything (the funnel is not lit). */
export function outlinerFilterIsOff(filter) {
    const f = cleanOutlinerFilter(filter);
    return !f.hidden.length && f.state === "all";
}

/** The search words as one lower-case needle; "" for none. */
export function searchNeedle(text) {
    return String(text || "").trim().toLowerCase();
}

/** Where `needle` lies in `name`: [start, end) or null. */
export function matchRange(name, needle) {
    if (!needle) return null;
    const i = String(name || "").toLowerCase().indexOf(needle);
    return i < 0 ? null : [i, i + needle.length];
}

/**
 * The bone tree of a model as rows: [{ name, depth, hasKids, open, match, context }].
 * `bones` is [{ name, parent }] parents first; `isClosed(name)` says a bone is folded.
 * With a needle only matching bones and their parents show, all unfolded.
 */
export function boneRows(bones, { needle = "", isClosed = () => false } = {}) {
    const known = new Set(bones.map((b) => b.name));
    const kidsOf = new Map();
    for (const b of bones) {
        const p = b.parent && known.has(b.parent) ? b.parent : null;
        if (!kidsOf.has(p)) kidsOf.set(p, []);
        kidsOf.get(p).push(b.name);
    }
    // With a needle: the bones that match, or have a match below them.
    const keep = new Map();
    const hit = (n) => {
        if (keep.has(n)) return keep.get(n);
        keep.set(n, false);
        let any = !!matchRange(n, needle);
        for (const k of kidsOf.get(n) || []) if (hit(k)) any = true;
        keep.set(n, any);
        return any;
    };
    const rows = [];
    const walk = (parent, depth) => {
        for (const n of kidsOf.get(parent) || []) {
            if (needle && !hit(n)) continue;
            const hasKids = (kidsOf.get(n) || []).length > 0;
            const open = needle ? true : !isClosed(n);
            const match = !!matchRange(n, needle);
            rows.push({ name: n, depth, hasKids, open, match, context: !!needle && !match });
            if (hasKids && open) walk(n, depth + 1);
        }
    };
    walk(null, 0);
    return rows;
}

/**
 * The Outliner's rows, parents before their children.
 *
 * scene: { items: [{ id, kind, name, parent, visible }] }.
 * opts:
 *   needle      - searchNeedle() of the search field
 *   filter      - { hidden: [kind keys], state }
 *   collapsed   - Set of folded item ids
 *   isSelected  - (id) => bool, for the "selected" state
 *   isAnimated  - (item) => bool, for the "animated" state
 *   bonesOf     - (item) => [bone names] of a loaded model (searched too)
 *
 * Returns [{ item, depth, hasKids, open, match, context }]:
 *   hasKids - it has rows below it as the filter stands (the arrow shows)
 *   open    - those rows are drawn (a search opens everything)
 *   match   - its name holds the needle
 *   context - shown only because something below it matches or passes the state filter
 * An item of a hidden kind is left out and its children take its place, a level up.
 */
export function outlinerRows(scene, opts = {}) {
    const items = (scene && Array.isArray(scene.items)) ? scene.items.filter(Boolean) : [];
    const needle = opts.needle || "";
    const filter = cleanOutlinerFilter(opts.filter);
    const hidden = new Set(filter.hidden);
    const collapsed = opts.collapsed || new Set();
    const isSelected = opts.isSelected || (() => false);
    const isAnimated = opts.isAnimated || (() => false);
    const bonesOf = opts.bonesOf || (() => []);
    const ids = new Set(items.map((it) => it.id));
    const kids = new Map();
    for (const it of items) {
        const p = it.parent && ids.has(it.parent) && it.parent !== it.id ? it.parent : null;
        if (!kids.has(p)) kids.set(p, []);
        kids.get(p).push(it);
    }
    const shown = (it) => !hidden.has(outlinerKindOf(it));
    const passState = (it) => {
        switch (filter.state) {
            case "visible": return it.visible !== false;
            case "selected": return !!isSelected(it.id);
            case "animated": return !!isAnimated(it);
            default: return true;
        }
    };
    const own = (it) => {
        if (!shown(it) || !passState(it)) return false;
        if (!needle) return true;
        if (matchRange(it.name, needle)) return true;
        // A model whose bone matches is a hit through its skeleton.
        if (it.kind === "model" && !hidden.has("bones")) {
            for (const b of bonesOf(it) || []) if (matchRange(b, needle)) return true;
        }
        return false;
    };
    // Does an item, or anything below it, pass? Memoised; cycles guarded.
    const memo = new Map();
    const passes = (it, seen = new Set()) => {
        if (memo.has(it.id)) return memo.get(it.id);
        if (seen.has(it.id)) return false;
        seen.add(it.id);
        let any = own(it);
        for (const k of kids.get(it.id) || []) if (passes(k, seen)) any = true;
        memo.set(it.id, any);
        return any;
    };
    // The rows a parent's children give, a hidden-kind child giving its own children instead.
    const visibleKids = (parentId, seen) => {
        const out = [];
        for (const k of kids.get(parentId) || []) {
            if (seen.has(k.id) || !passes(k)) continue;
            if (shown(k)) out.push(k);
            else { seen.add(k.id); out.push(...visibleKids(k.id, seen)); }
        }
        return out;
    };
    const rows = [];
    const walk = (parentId, depth, seen) => {
        for (const it of visibleKids(parentId, seen)) {
            if (seen.has(it.id)) continue;
            const next = new Set(seen).add(it.id);
            const under = visibleKids(it.id, new Set(next));
            const skeleton = it.kind === "model" && !hidden.has("bones") && (bonesOf(it) || []).length > 0;
            const hasKids = under.length > 0 || skeleton;
            const open = hasKids && (needle ? true : !collapsed.has(it.id));
            const match = !!needle && !!matchRange(it.name, needle);
            const context = !own(it) || (!!needle && !match && !(it.kind === "model" && skeleton));
            rows.push({ item: it, depth, hasKids, open, match, context });
            if (open) walk(it.id, depth + 1, next);
        }
    };
    walk(null, 0, new Set());
    return rows;
}

/** Every id below `id` (for a Shift+click on an arrow, which folds the whole branch). */
export function descendantIds(scene, id) {
    const items = (scene && Array.isArray(scene.items)) ? scene.items.filter(Boolean) : [];
    const out = [];
    const seen = new Set([id]);
    const walk = (p) => {
        for (const it of items) {
            if (it.parent === p && !seen.has(it.id)) { seen.add(it.id); out.push(it.id); walk(it.id); }
        }
    };
    walk(id);
    return out;
}

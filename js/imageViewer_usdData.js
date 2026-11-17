// imageViewer_usdData.js
// The scene as a USD stage, as data: the prim each Outliner row becomes, and
// what the Outliner changes INSIDE a model's asset (a prim hidden, switched
// off, a variant picked, the whole payload left unloaded).
//
// Pure (no DOM, no three.js), so tests/test_usd_data.mjs runs it under node.
// The server writes the stage (src/usd_scene.py, src/usd_io.py); the prim
// names here follow its rule (usd_io._prim_name) so a tooltip names the prim
// the saved file really has.
//
// An item's own edits live in `item.usd`:
//   { overs: { "<rel>": { visible: false, active: false } },
//     variants: { "<rel>": { "<set>": "<choice>" } },
//     unloaded: true }
// `rel` is a prim path below the item's prim ("" is the item's prim itself,
// which is the asset's root). On a model whose file is USD these are the
// asset's own prims; on any other file the page's node tree, matched by name
// when the mesh is converted on save. In the stage they are `over`s - the
// asset itself is never written to.

const USD_RE = /\.(usd|usda|usdc|usdz)$/i;

/** True for a src whose file is a USD layer. */
export function isUsdSrc(src) {
    if (!src || typeof src !== "object") return false;
    if (String(src.format || "").toLowerCase() === "usd") return true;
    return USD_RE.test(String(src.path || src.filename || src.name || ""));
}

const REL_MAX = 400;

function cleanRel(rel) {
    const s = String(rel == null ? "" : rel).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    return s.length <= REL_MAX ? s : null;
}

/** `raw.usd` made sane, or null when it says nothing. */
export function readUsdFields(raw) {
    const u = raw && typeof raw === "object" ? raw : null;
    if (!u) return null;
    const out = {};
    const overs = {};
    for (const [rel, o] of Object.entries(u.overs && typeof u.overs === "object" ? u.overs : {}).slice(0, 2000)) {
        const r = cleanRel(rel);
        if (r === null || !o || typeof o !== "object") continue;
        const one = {};
        if (o.visible === false) one.visible = false;
        if (o.active === false) one.active = false;
        if (Object.keys(one).length) overs[r] = one;
    }
    if (Object.keys(overs).length) out.overs = overs;
    const variants = {};
    for (const [rel, v] of Object.entries(u.variants && typeof u.variants === "object" ? u.variants : {}).slice(0, 500)) {
        const r = cleanRel(rel);
        if (r === null || !v || typeof v !== "object") continue;
        const one = {};
        for (const [set, choice] of Object.entries(v)) {
            if (set && typeof choice === "string" && set.length <= 190 && choice.length <= 190) one[set] = choice;
        }
        if (Object.keys(one).length) variants[r] = one;
    }
    if (Object.keys(variants).length) out.variants = variants;
    if (u.unloaded === true) out.unloaded = true;
    return Object.keys(out).length ? out : null;
}

/** The edits inside the asset ({overs, variants}), or null for none. */
export function usdEdits(item) {
    const u = item && item.usd;
    if (!u || (!u.overs && !u.variants)) return null;
    const out = {};
    if (u.overs) out.overs = u.overs;
    if (u.variants) out.variants = u.variants;
    return out;
}

/** The same edits always spelled the same way: what a display copy is keyed by. */
export function editsKey(edits) {
    if (!edits) return "";
    const sort = (o) => (o && typeof o === "object" && !Array.isArray(o)
        ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sort(o[k])])) : o);
    return JSON.stringify(sort(edits));
}

function tidy(item) {
    const u = readUsdFields(item.usd);
    if (u) item.usd = u;
    else delete item.usd;
    return item;
}

/** Hide or show (`visible`), switch off or on (`active`) the prim at `rel`. */
export function setOver(item, rel, patch) {
    const r = cleanRel(rel);
    if (!item || r === null) return item;
    const u = item.usd || (item.usd = {});
    const overs = u.overs || (u.overs = {});
    const one = { ...(overs[r] || {}) };
    for (const k of ["visible", "active"]) {
        if (!(k in (patch || {}))) continue;
        if (patch[k] === false) one[k] = false;
        else delete one[k];
    }
    overs[r] = one;
    return tidy(item);
}

/** Pick `choice` in the variant set `set` of the prim at `rel`; null takes the pick off. */
export function setVariant(item, rel, set, choice) {
    const r = cleanRel(rel);
    if (!item || r === null || !set) return item;
    const u = item.usd || (item.usd = {});
    const variants = u.variants || (u.variants = {});
    const one = { ...(variants[r] || {}) };
    if (typeof choice === "string" && choice) one[set] = choice;
    else delete one[set];
    variants[r] = one;
    return tidy(item);
}

export function setUnloaded(item, unloaded) {
    if (!item) return item;
    const u = item.usd || (item.usd = {});
    if (unloaded) u.unloaded = true;
    else delete u.unloaded;
    return tidy(item);
}

export function isUnloaded(item) {
    return !!(item && item.usd && item.usd.unloaded);
}

/** True when `rel` or a prim above it is hidden or switched off. */
export function hiddenByOvers(item, rel) {
    const overs = (item && item.usd && item.usd.overs) || {};
    let r = cleanRel(rel);
    while (r !== null) {
        const o = overs[r];
        if (o && (o.visible === false || o.active === false)) return true;
        if (!r) break;
        r = r.includes("/") ? r.slice(0, r.lastIndexOf("/")) : "";
    }
    return false;
}

// ── the prim each row becomes ────────────────────────────────────────────────

/** usd_io._prim_name: letters, digits and underscores, never a digit first, unique. */
export function primName(name, used) {
    let out = [...String(name || "Item")].map((c) => (/[\p{L}\p{N}_]/u.test(c) ? c : "_")).join("");
    if (!out || /^\p{N}/u.test(out)) out = "_" + out;
    const base = out;
    let n = 2;
    while (used.has(out)) out = `${base}_${n++}`;
    used.add(out);
    return out;
}

/** Map id -> the prim path the item gets in a saved scene ("/previz/Set/Hero"). */
export function primPaths(scene) {
    const items = (scene && scene.items) || [];
    const byId = new Map(items.map((it) => [it.id, it]));
    const order = [], placed = new Set();
    const place = (it) => {
        if (placed.has(it.id)) return;
        const parent = it.parent ? byId.get(it.parent) : null;
        if (parent && parent !== it && !placed.has(parent.id)) place(parent);
        placed.add(it.id);
        order.push(it);
    };
    for (const it of items) place(it);
    const used = new Set(), out = new Map();
    for (const it of order) {
        const name = primName(it.name, used);
        out.set(it.id, `${out.get(it.parent) || "/previz"}/${name}`);
    }
    return out;
}

/**
 * The prims of an asset as Outliner rows: [{ prim, depth, hasKids, open, match, context }],
 * `prims` parents first ({rel, name, parent}); `isClosed(rel)` says one is folded.
 * With a needle only matching prims and those above them show, all unfolded.
 */
export function contentRows(prims, { needle = "", isClosed = () => false } = {}) {
    const list = Array.isArray(prims) ? prims : [];
    const kids = new Map();
    for (const p of list) {
        const parent = p.parent || "";
        if (!kids.has(parent)) kids.set(parent, []);
        kids.get(parent).push(p);
    }
    const n = String(needle || "").toLowerCase();
    const keep = new Map();
    const hit = (p) => {
        if (keep.has(p.rel)) return keep.get(p.rel);
        const self = !!n && String(p.name).toLowerCase().includes(n);
        let below = false;
        for (const k of kids.get(p.rel) || []) if (hit(k)) below = true;
        const v = self || below;
        keep.set(p.rel, v);
        return v;
    };
    const rows = [];
    const walk = (parent, depth) => {
        for (const p of kids.get(parent) || []) {
            if (n && !hit(p)) continue;
            const hasKids = (kids.get(p.rel) || []).length > 0;
            const open = n ? true : !isClosed(p.rel);
            const match = !!n && String(p.name).toLowerCase().includes(n);
            rows.push({ prim: p, depth, hasKids, open, match, context: !!n && !match });
            if (hasKids && open) walk(p.rel, depth + 1);
        }
    };
    walk("", 0);
    return rows;
}

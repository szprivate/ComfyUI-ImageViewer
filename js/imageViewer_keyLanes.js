// imageViewer_keyLanes.js
// What a timeline of layers with keys shares, between Motion's timeline (imageViewer_mgEditor.js) and the Comp's
// Layers panel (imageViewer_compEditor.js): the ruler's tick step, a layer bar's in / out / move, picking keys with
// the 3D view's modifiers, a box over the lanes, and how the bars and diamonds look.
//
// A key is named {id, prop, f}: the layer or node that holds it, its property, its frame. Moving keys is
// imageViewer_mgModel.js's moveKeys (per holder), through moveKeysMany there.
//
// Written from how layer timelines and dope sheets behave in general, not from any program's code.

/** Pixels a layer bar's end answers to, from either side of it. */
export const EDGE_PX = 5;

/** Frames between two numbered ticks of the ruler, at `k` pixels a frame: the first step at least 42 px wide. */
export function rulerStep(k) {
    return [1, 2, 5, 10, 15, 30, 60, 120, 240, 480].find((s) => s * k >= 42) || 960;
}

/**
 * A layer bar dragged: `part` "in" (its start), "out" (its end) or "move" (the whole bar) by `df` frames.
 * `range` = {in, out}, out the first frame the layer is no longer there; at least one frame long. A trim stays
 * inside [lo, hi] (the comp's length, by default unbounded); a move keeps the length.
 */
export function barEdit(range, part, df, { lo = -Infinity, hi = Infinity } = {}) {
    df = Math.round(df);
    let a = range.in, b = range.out;
    if (part === "move") { a += df; b += df; }
    else if (part === "in") a = Math.max(lo, Math.min(b - 1, a + df));
    else if (part === "out") b = Math.min(hi, Math.max(a + 1, b + df));
    return { in: a, out: b };
}

/** Which part of a bar a pointer at `x` (pixels from the bar's left) presses: "in", "out" or "move". */
export function barPart(x, width, edge = EDGE_PX) {
    if (width < edge * 3) return x < width / 2 ? "in" : "out";
    if (x <= edge) return "in";
    if (x >= width - edge) return "out";
    return "move";
}

/** The 3D view's selection modifiers: plain replaces, Shift toggles, Ctrl takes away, Ctrl+Shift adds. */
export function pickMode(e) {
    const ctrl = !!(e && (e.ctrlKey || e.metaKey)), shift = !!(e && e.shiftKey);
    return ctrl && shift ? "add" : ctrl ? "remove" : shift ? "toggle" : "replace";
}

export const keyName = (k) => `${k.id}\u0000${k.prop}\u0000${k.f}`;

/** The selection after picking `keys` (a diamond stands for one or more) in `mode`. Returns a new list. */
export function pickKeys(sel, keys, mode) {
    const have = new Map(sel.map((k) => [keyName(k), k]));
    const names = keys.map(keyName);
    const allIn = names.length > 0 && names.every((n) => have.has(n));
    if (mode === "replace") return keys.map((k) => ({ ...k }));
    if (mode === "remove" || (mode === "toggle" && allIn)) { for (const n of names) have.delete(n); return [...have.values()]; }
    keys.forEach((k, i) => have.set(names[i], { ...k }));
    return [...have.values()];
}

/** Is every one of `keys` in `sel`? (A diamond is drawn selected then.) */
export function allPicked(sel, keys) {
    if (!keys.length) return false;
    const have = new Set(sel.map(keyName));
    return keys.every((k) => have.has(keyName(k)));
}

/** Do two boxes {left, top, right, bottom} touch? */
export function boxesMeet(a, b) {
    return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

/** The look of the bars, the diamonds and the box (`kl-` classes), for a document or shadow root. */
export const KL_CSS = `
.kl-bar{position:absolute;top:4px;bottom:4px;border-radius:3px;background:#3a4a66;border:1px solid #5a6e94;box-sizing:border-box;cursor:grab;touch-action:none}
.kl-bar.sel{background:#4a5f86;border-color:#8fb0e8}
.kl-bar.off{opacity:.45}
.kl-bar::before,.kl-bar::after{content:"";position:absolute;top:0;bottom:0;width:5px;cursor:ew-resize}
.kl-bar::before{left:-1px;border-left:2px solid #9fb6e0;border-radius:3px 0 0 3px}
.kl-bar::after{right:-1px;border-right:2px solid #9fb6e0;border-radius:0 3px 3px 0}
.kl-bar.dragging{cursor:grabbing}
.kl-foot{position:absolute;top:2px;bottom:2px;background:rgba(160,175,205,.10);border:1px dashed rgba(160,175,205,.28);border-radius:3px;pointer-events:none;box-sizing:border-box}
.kl-dia{position:absolute;top:50%;width:10px;height:10px;margin:-5px 0 0 -5px;transform:rotate(45deg);background:#d9a441;border:1px solid #0009;box-sizing:border-box;cursor:pointer;z-index:2;touch-action:none}
.kl-dia.agg{background:#b8b8c0;width:8px;height:8px;margin:-4px 0 0 -4px}
.kl-dia.sel{background:#fff;border-color:#ff8a3a;box-shadow:0 0 0 1px #ff8a3a}
.kl-dia.lin{border-radius:0}.kl-dia.hold{background:#d96a4a}.kl-dia.hold.sel{background:#fff}
.kl-box{position:absolute;border:1px solid #8fb0e8;background:rgba(143,176,232,.12);pointer-events:none;z-index:6}
`;

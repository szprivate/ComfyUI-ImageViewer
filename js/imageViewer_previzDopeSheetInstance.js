// imageViewer_previzDopeSheetInstance.js
// One Dope Sheet: keys as diamonds on rows over time, for timing rather than values. The panel comes in
// instances (Sebastian 2026-11-23): the first one keeps its state on the viewer (st === viewer, so every older
// caller of this._dsUi / this._dsFolded still reads and writes it); every further one is made here with a state
// object of its own. The dock registers the maker (PrevizDopeSheetMixin) and places the element.
//
// What is per-instance: the folded rows, the All switch, the scroll, the last Offset/Scale numbers, the rows on
// screen. What is shared (one scene per tab): the keys themselves and the key selection, so a click in any sheet
// drives the same selection the commands and the other sheets read.
import * as S from "./imageViewer_scene3d.js";
import * as A from "./imageViewer_animTools.js";

const PROPS = [
    ["position", "translate"], ["rotation", "rotate"], ["scale", "scale"],
    ["pivot", "pivot"], ["fov", "fov"], ["ikfk", "ikBlend"],
];
const PAD = 7;          // px inside each lane's ends, so a key on the last frame is whole
const DRAG_SLOP = 3;
const EASES = [["smooth", "Smooth"], ["linear", "Linear"], ["hold", "Hold (stepped)"]];

/** The objects on a sheet: the selection in scene order, or - with `all` - every animated one. */
export function dsItems(v, all) {
    const scene = v.previzScene && v.previzScene();
    if (!scene) return [];
    const items = scene.items || [];
    if (all) return items.filter((it) => S.keyframeFrames(it).length);
    return items.filter((it) => v.previzIsSelected(it.id));
}

/** The rows, top to bottom; each knows which keys a diamond of it stands for. `folded` is the sheet's own. */
export function dsRows(items, folded) {
    const rows = [{ kind: "summary", label: "Summary", keys: A.keysOf(items) }];
    for (const it of items) {
        rows.push({ kind: "item", item: it, label: it.name, keys: A.keysOf([it]), folded: folded.has(it.id) });
        if (folded.has(it.id)) continue;
        for (const [prop, label] of PROPS) {
            if (!S.isAnimated(it, prop)) continue;
            rows.push({ kind: "prop", item: it, prop, label, keys: A.keysOf([it], [prop]) });
        }
    }
    for (const r of rows) {
        r.byFrame = new Map();
        for (const k of r.keys) {
            if (!r.byFrame.has(k.f)) r.byFrame.set(k.f, []);
            r.byFrame.get(k.f).push(k);
        }
    }
    return rows;
}

/**
 * Make a Dope Sheet in `host`. `st` holds what this sheet keeps of its own (the viewer itself for the first one,
 * a fresh object for every further one); `saved` is what a layout carried for it, if anything. Returns the
 * instance the dock keeps: { el, ui, refresh, wake, save, dispose, geom, placeOverlay }.
 */
export function createDopeSheetInstance(v, host, st, saved) {
    const doc = host.ownerDocument;
    let ro = null;          // the wrap's ResizeObserver; disconnected on rebuild and dispose (it used to leak)
    let dragDone = null;    // the marquee's finish, run by the drag's pointerup

    if (saved) {
        if (typeof saved.all === "boolean") st._dsAll = saved.all;
        if (Array.isArray(saved.folded)) st._dsFolded = new Set(saved.folded);
        if (Number.isFinite(saved.lastStep)) st._dsLastStep = saved.lastStep;
        if (Number.isFinite(saved.lastScale)) st._dsLastScale = saved.lastScale;
    }
    const folded = () => st._dsFolded || (st._dsFolded = new Set());
    const selSet = () => v._dsSelSet();

    build();
    if (saved && Number.isFinite(saved.scrollTop) && st._dsUi) st._dsUi.grid.scrollTop = saved.scrollTop;

    // ── Building ─────────────────────────────────────────────────────────────

    function build() {
        if (st._dsUi && st._dsUi.body.isConnected && st._dsUi.body.parentNode === host) return st._dsUi;
        if (ro) { ro.disconnect(); ro = null; }
        host.querySelectorAll(":scope > .ds-body").forEach((n) => n.remove());
        const el = (tag, cls, text) => {
            const n = doc.createElement(tag);
            if (cls) n.className = cls;
            if (text !== undefined) n.textContent = text;
            return n;
        };
        const body = el("div", "ds-body");
        body.tabIndex = 0;
        const bar = el("div", "ds-bar");
        const btn = (label, title, run) => {
            const b = el("button", "previz-btn ds-btn", label);
            b.title = title;
            b.onclick = (e) => { e.stopPropagation(); run(b); };
            bar.append(b);
            return b;
        };
        const all = btn("All", "Show every animated object, not only the selected ones", () => {
            st._dsAll = !st._dsAll;
            v.previzRefreshDopeSheet();
        });
        btn("Offset…", "Stagger the selected keys: each object starts a few frames after the one before",
            (b) => v._dsAskNumber(b, "Offset each object by (frames)", st._dsLastStep ?? 2,
                                    (n) => { st._dsLastStep = n; v.previzDopeStagger(n); }));
        btn("Scale…", "Scale the selected keys in time (about the first selected key)",
            (b) => v._dsAskNumber(b, "Scale time by (×)", st._dsLastScale ?? 2,
                                    (n) => { st._dsLastScale = n; v.previzDopeScale(n); }, { step: 0.1, min: 0.01 }));
        btn("Ease ▾", "Smooth, linear or stepped from the selected keys on", (b) => {
            const r = b.getBoundingClientRect();
            v._previzOpenMenu(EASES.map(([ease, label]) => ({ label, run: () => v.previzDopeEase(ease) })),
                                 r.left, r.bottom + 2, b);
        });
        btn("Copy", "Copy the selected keys (Ctrl+C)", () => v.previzDopeCopy());
        btn("Paste", "Paste at the playhead (Ctrl+V); a copy of one object pastes onto the selected ones",
            () => v.previzDopePaste());
        btn("Delete", "Delete the selected keys (Del)", () => v.previzDopeDelete());
        const info = el("span", "ds-info");
        bar.append(info);

        const wrap = el("div", "ds-wrap");
        const grid = el("div", "ds-grid");
        const head = el("div", "ds-row ds-head");
        const headName = el("div", "ds-name ds-headname", "");
        const ruler = el("div", "ds-lane ds-ruler");
        head.append(headName, ruler);
        const rows = el("div", "ds-rows");
        grid.append(head, rows);
        const over = el("div", "ds-over");
        const cursor = el("div", "ds-cursor");
        over.append(cursor);
        wrap.append(grid, over);
        const empty = el("div", "curves-empty ds-empty");
        body.append(bar, wrap, empty);
        host.append(body);

        body.addEventListener("pointerdown", (e) => {
            try { body.focus({ preventScroll: true }); } catch (_) { body.focus(); }
            down(e);
        });
        body.addEventListener("dblclick", (e) => {
            const key = e.target.closest && e.target.closest(".ds-key");
            if (key) v.setFrame(Number(key.dataset.f));
        });
        grid.addEventListener("scroll", () => placeOverlay());
        const RO = (doc.defaultView || window).ResizeObserver;
        if (RO) { ro = new RO(() => placeOverlay()); ro.observe(wrap); }
        st._dsUi = { body, bar, all, info, wrap, grid, ruler, rows, over, cursor, empty, headName };
        return st._dsUi;
    }

    // ── Drawing ──────────────────────────────────────────────────────────────

    /** Frame <-> pixel across a lane. */
    function geom() {
        const ui = st._dsUi;
        const b = v.getTimelineBounds();
        const span = Math.max(1, b.max - b.min);
        const r = ui.ruler.getBoundingClientRect();
        const w = Math.max(1, r.width - PAD * 2);
        return {
            min: b.min, max: b.max, span, left: r.left,
            pct: (f) => `calc(${PAD}px + (100% - ${PAD * 2}px) * ${((f - b.min) / span).toFixed(5)})`,
            x: (f) => r.left + PAD + ((f - b.min) / span) * w,
            frameAt: (clientX) => b.min + ((clientX - r.left - PAD) / w) * span,
            perFrame: w / span,
        };
    }

    function draw() {
        const ui = st._dsUi;
        const items = dsItems(v, st._dsAll);
        ui.all.classList.toggle("active", !!st._dsAll);
        const none = !items.length;
        ui.wrap.style.display = none ? "none" : "";
        ui.empty.style.display = none ? "block" : "none";
        if (none) {
            ui.empty.textContent = st._dsAll ? "Nothing in the scene is animated yet."
                : "Select something in the scene (or press All) to see its keys.";
            ui.info.textContent = "";
            return;
        }
        const rows = dsRows(items, folded());
        st._dsRowsNow = rows;
        const sel = selSet();
        const g = geom();

        // The ruler: frame numbers at a step that leaves room for them.
        ui.ruler.innerHTML = "";
        const pxPer = Math.max(1e-6, g.perFrame);
        const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000].find((s) => s * pxPer >= 34) || 1000;
        for (let f = Math.ceil(g.min / step) * step; f <= g.max; f += step) {
            const t = doc.createElement("span");
            t.className = "ds-tick";
            t.style.left = g.pct(f);
            t.textContent = String(f);
            ui.ruler.append(t);
        }
        // The selection's bar, with the two ends that scale it.
        const picked = v.previzDopeSelection();
        const range = A.selectionRange(picked);
        if (!range.empty && range.max > range.min) {
            const bar = doc.createElement("div");
            bar.className = "ds-selbar";
            bar.style.left = g.pct(range.min);
            bar.style.width = `calc((100% - ${PAD * 2}px) * ${((range.max - range.min) / g.span).toFixed(5)})`;
            for (const side of ["lo", "hi"]) {
                const h = doc.createElement("div");
                h.className = `ds-handle ${side}`;
                h.dataset.side = side;
                h.title = "Drag to scale the selected keys in time";
                bar.append(h);
            }
            ui.ruler.append(bar);
        }

        ui.rows.innerHTML = "";
        rows.forEach((row, index) => {
            const r = doc.createElement("div");
            r.className = `ds-row ds-${row.kind}`;
            r.dataset.row = String(index);
            const name = doc.createElement("div");
            name.className = "ds-name";
            if (row.kind === "item") {
                const fold = doc.createElement("span");
                fold.className = "ds-fold";
                fold.textContent = row.folded ? "▸" : "▾";
                fold.dataset.fold = row.item.id;
                name.append(fold);
                name.dataset.item = row.item.id;
                name.title = `${row.item.name}: click to select it in the scene`;
            }
            name.append(doc.createTextNode(row.label));
            const lane = doc.createElement("div");
            lane.className = "ds-lane";
            for (const [f, keys] of row.byFrame) {
                const d = doc.createElement("div");
                const on = keys.filter((k) => sel.has(A.keyId(k))).length;
                d.className = "ds-key" + (on === keys.length ? " on" : on ? " part" : "");
                const ease = keys.length === 1 ? (S.track(S.itemById(v.previzScene(), keys[0].id), keys[0].prop)
                    .find((k) => k.f === f) || {}).ease : null;
                if (ease === "hold") d.classList.add("hold");
                d.style.left = g.pct(f);
                d.dataset.row = String(index);
                d.dataset.f = String(f);
                d.title = `${row.kind === "summary" ? "All" : row.label} · frame ${f}` +
                          `${keys.length > 1 ? ` · ${keys.length} keys` : ""}\n` +
                          "click to select (Shift adds, Ctrl toggles) · drag to move · double-click to go there";
                lane.append(d);
            }
            r.append(name, lane);
            ui.rows.append(r);
        });
        const n = picked.length;
        ui.info.textContent = n ? `${n} key${n === 1 ? "" : "s"} selected` +
            (range.max > range.min ? ` · ${range.min}–${range.max}` : ` · frame ${range.min}`) : "";
        placeOverlay();
    }

    /** The playhead line (and the box being dragged), over the lanes. */
    function placeOverlay() {
        const ui = st._dsUi;
        if (!ui || !ui.body.isConnected) return;
        const wr = ui.wrap.getBoundingClientRect();
        const rr = ui.ruler.getBoundingClientRect();
        ui.over.style.left = `${rr.left - wr.left}px`;
        ui.over.style.width = `${rr.width}px`;
        const g = geom();
        const f = Math.round(v.currentFrame || 0);
        ui.cursor.style.left = `${g.x(f) - rr.left}px`;
        ui.cursor.style.display = f < g.min || f > g.max ? "none" : "";
    }

    function refresh() { build(); draw(); }

    // ── The pointer ──────────────────────────────────────────────────────────

    function keysAt(rowIndex, f) {
        const row = (st._dsRowsNow || [])[rowIndex];
        return row ? (row.byFrame.get(f) || []) : [];
    }

    function down(e) {
        if (e.button !== 0) return;
        const ui = st._dsUi;
        const t = e.target;
        if (t.closest(".ds-bar")) return;
        const fold = t.closest(".ds-fold");
        if (fold) {
            const set = folded();
            const id = fold.dataset.fold;
            if (set.has(id)) set.delete(id); else set.add(id);
            v.previzRefreshDopeSheet();
            return;
        }
        const name = t.closest(".ds-name[data-item]");
        if (name) { v.previzSelect(name.dataset.item, { add: e.shiftKey || e.ctrlKey || e.metaKey }); return; }
        const handle = t.closest(".ds-handle");
        if (handle) { e.preventDefault(); scaleDrag(e, handle.dataset.side); return; }
        const key = t.closest(".ds-key");
        if (key) { e.preventDefault(); keyDown(e, key); return; }
        if (t.closest(".ds-ruler")) { e.preventDefault(); scrub(e); return; }
        if (t.closest(".ds-lane")) { e.preventDefault(); marquee(e); return; }
        if (ui && t.closest(".ds-wrap")) { v._dsSetSelection([]); v.previzRefreshDopeSheet(); }
    }

    function keyDown(e, el) {
        const keys = keysAt(Number(el.dataset.row), Number(el.dataset.f));
        const sel = selSet();
        const ids = keys.map(A.keyId);
        const allOn = ids.every((id) => sel.has(id));
        if (e.ctrlKey || e.metaKey) {
            for (const id of ids) if (allOn) sel.delete(id); else sel.add(id);
        } else if (e.shiftKey) {
            for (const id of ids) sel.add(id);
        } else if (!allOn) {
            v._dsSetSelection(keys);
        }
        v.previzRefreshDopeSheet();
        if ((e.ctrlKey || e.metaKey) && allOn) return;
        moveDrag(e, Number(el.dataset.f));
    }

    /** The tracks of the selection, as they are now - what a live drag starts from every move. */
    function base(sel) {
        const ids = new Set(sel.map((k) => k.id));
        const scene = v.previzScene();
        const out = new Map();
        for (const id of ids) {
            const it = S.itemById(scene, id);
            if (it) out.set(id, JSON.stringify(it.tracks || {}));
        }
        return out;
    }

    function restore(b) {
        const scene = v.previzScene();
        for (const [id, json] of b) {
            const it = S.itemById(scene, id);
            if (it) it.tracks = JSON.parse(json);
        }
    }

    function drag(e, onMove, label) {
        const win = v._viewerWindow();
        const x0 = e.clientX, y0 = e.clientY;
        let started = false;
        const move = (ev) => {
            if (!started) {
                if (Math.abs(ev.clientX - x0) < DRAG_SLOP && Math.abs(ev.clientY - y0) < DRAG_SLOP) return;
                started = true;
                if (label) v.previzBeginDrag(label);
            }
            onMove(ev, x0, y0);
        };
        const up = (ev) => {
            win.removeEventListener("pointermove", move);
            win.removeEventListener("pointerup", up);
            if (started) {
                if (label) v.previzEndDrag();
                if (label) v.previzChanged();
            }
            if (dragDone) { const d = dragDone; dragDone = null; d(started, ev); }
        };
        win.addEventListener("pointermove", move);
        win.addEventListener("pointerup", up);
    }

    function moveDrag(e, fromFrame) {
        const sel = v.previzDopeSelection();
        if (!sel.length) return;
        const items = v.previzScene().items;
        const b = base(sel);
        let last = 0;
        drag(e, (ev) => {
            const g = geom();
            const d = Math.round(g.frameAt(ev.clientX) - fromFrame);
            if (d === last) return;
            last = d;
            restore(b);
            v._dsSetSelection(A.moveKeys(items, sel, d));
            v.previzChanged({ persist: false, light: true });
        }, "move keys");
    }

    function scaleDrag(e, side) {
        const sel = v.previzDopeSelection();
        const range = A.selectionRange(sel);
        if (sel.length < 2 || range.max <= range.min) return;
        const items = v.previzScene().items;
        const b = base(sel);
        const pivot = side === "hi" ? range.min : range.max;
        const end = side === "hi" ? range.max : range.min;
        let last = 1;
        drag(e, (ev) => {
            const g = geom();
            const to = Math.round(g.frameAt(ev.clientX));
            let k = (to - pivot) / (end - pivot);
            if (!(k > 0)) k = 1 / Math.max(1, Math.abs(end - pivot));
            if (k === last) return;
            last = k;
            restore(b);
            v._dsSetSelection(A.scaleKeys(items, sel, k, pivot));
            v.previzChanged({ persist: false, light: true });
        }, "scale keys");
    }

    function scrub(e) {
        const go = (ev) => {
            const g = geom();
            v.setFrame(Math.round(Math.max(g.min, Math.min(g.max, g.frameAt(ev.clientX)))));
        };
        go(e);
        drag(e, go, null);
    }

    /** A box on empty lanes selects the keys inside it (Shift / Ctrl add). */
    function marquee(e) {
        const ui = st._dsUi;
        const add = e.shiftKey || e.ctrlKey || e.metaKey;
        const box = doc.createElement("div");
        box.className = "ds-marquee";
        ui.over.append(box);
        const before = add ? [...selSet()] : [];
        const pick = (ev, x0, y0) => {
            const orr = ui.over.getBoundingClientRect();
            const [l, r] = [Math.min(x0, ev.clientX), Math.max(x0, ev.clientX)];
            const [tp, bt] = [Math.min(y0, ev.clientY), Math.max(y0, ev.clientY)];
            Object.assign(box.style, { left: `${l - orr.left}px`, top: `${tp - orr.top}px`,
                                       width: `${r - l}px`, height: `${bt - tp}px` });
            const sel = new Set(before);
            for (const d of ui.rows.querySelectorAll(".ds-key")) {
                const dr = d.getBoundingClientRect();
                const cx = (dr.left + dr.right) / 2, cy = (dr.top + dr.bottom) / 2;
                if (cx >= l && cx <= r && cy >= tp && cy <= bt) {
                    for (const k of keysAt(Number(d.dataset.row), Number(d.dataset.f))) sel.add(A.keyId(k));
                }
            }
            v._dsSel = sel;
            for (const d of ui.rows.querySelectorAll(".ds-key")) {
                const keys = keysAt(Number(d.dataset.row), Number(d.dataset.f));
                const on = keys.filter((k) => sel.has(A.keyId(k))).length;
                d.classList.toggle("on", on === keys.length);
                d.classList.toggle("part", on > 0 && on < keys.length);
            }
        };
        dragDone = (started) => {
            box.remove();
            if (!started && !add) v._dsSetSelection([]);
            v.previzRefreshDopeSheet();
        };
        drag(e, pick, null);
    }

    // ── The instance the dock keeps ──────────────────────────────────────────

    return {
        el: host,
        get ui() { return st._dsUi; },
        refresh,
        geom,
        placeOverlay,
        wake() { refresh(); },
        save() {
            return { all: !!st._dsAll, folded: [...folded()],
                     scrollTop: st._dsUi ? st._dsUi.grid.scrollTop : 0,
                     lastStep: st._dsLastStep ?? null, lastScale: st._dsLastScale ?? null };
        },
        dispose() {
            if (ro) { ro.disconnect(); ro = null; }
            dragDone = null;
        },
    };
}
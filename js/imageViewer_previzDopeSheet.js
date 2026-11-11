// imageViewer_previzDopeSheet.js
// The 3D space's Dope Sheet: keys as diamonds on rows over time, for timing
// rather than values. A dock panel (`dopeSheet`, #dope-sheet-panel), a tab
// beside the Curve Editor in the strip under the picture.
//
// ROWS
// A Summary row on top (every key of every object shown), then one row per
// object (all its keys), and under it, unless folded, one row per animated
// property (translate, rotate, scale, pivot, fov, ikBlend). A diamond stands
// for every key under its row at that frame, so selecting the Summary
// diamond at frame 12 selects frame 12 on every object.
// What is shown: the objects selected in the scene, or - "All" - every
// animated object of the scene.
//
// EDITS (all in imageViewer_animTools.js, each one undo step)
// - click / Shift+click / Ctrl+click a diamond, or drag a box on empty lanes
// - drag selected diamonds to move them in time (across objects at once)
// - drag the ends of the bar over the ruler to scale the selection in time
// - Offset…: stagger the selection, object after object
// - Scale…: by a factor, about the first key or the playhead
// - Ease ▸, Copy / Paste (at the playhead; onto the selected objects when the
//   copy is of one object), Delete
// - keys while the panel has the focus: Delete, Ctrl+C / Ctrl+V, , and .
//   (a frame; Shift: ten), Ctrl+A, Esc
// Written from how dope sheets behave in general, not from any program's code.
import * as S from "./imageViewer_scene3d.js";
import * as A from "./imageViewer_animTools.js";
import { notice } from "./imageViewer_exportUI.js";

const PROPS = [
    ["position", "translate"], ["rotation", "rotate"], ["scale", "scale"],
    ["pivot", "pivot"], ["fov", "fov"], ["ikfk", "ikBlend"],
];
const ROW_H = 20;
const PAD = 7;          // px inside each lane's ends, so a key on the last frame is whole
const DRAG_SLOP = 3;
const EASES = [["smooth", "Smooth"], ["linear", "Linear"], ["hold", "Hold (stepped)"]];

export const PrevizDopeSheetMixin = {

    // ── What is shown ────────────────────────────────────────────────────────

    /** The objects on the sheet: the selection in scene order, or every animated one. */
    _dsItems() {
        const scene = this.previzScene && this.previzScene();
        if (!scene) return [];
        const all = scene.items || [];
        if (this._dsAll) return all.filter((it) => S.keyframeFrames(it).length);
        return all.filter((it) => this.previzIsSelected(it.id));
    },

    /** The rows, top to bottom; each knows which keys a diamond of it stands for. */
    _dsRows(items) {
        const folded = this._dsFolded || (this._dsFolded = new Set());
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
    },

    _dsSelSet() { return this._dsSel || (this._dsSel = new Set()); },

    /** The selection as keys, only the ones still there. */
    previzDopeSelection() {
        const items = this._dsItems();
        const live = new Set(A.keysOf(items).map(A.keyId));
        const sel = this._dsSelSet();
        for (const id of [...sel]) if (!live.has(id)) sel.delete(id);
        return [...sel].map(A.parseKeyId);
    },

    _dsSetSelection(keys) {
        this._dsSel = new Set((keys || []).map(A.keyId));
    },

    // ── Building and drawing ─────────────────────────────────────────────────

    _dsHost() { return this.dopeSheetPanel || null; },

    /** Called with every refresh of the 3D panels (previzRefreshCurves). */
    previzRefreshDopeSheet() {
        const host = this._dsHost();
        if (!host) return;
        if (!this.isPrevizTab || !this.isPrevizTab()) {
            if (this.isPanelDocked && this.isPanelDocked("dopeSheet")) this.setPanelDocked("dopeSheet", false);
            return;
        }
        if (!this.isPanelDocked || !this.isPanelDocked("dopeSheet")) return;
        if (this.isPanelFront && !this.isPanelFront("dopeSheet")) return;
        const ui = this._dsBuild(host);
        this._dsDraw(ui);
    },

    _dsBuild(host) {
        if (this._dsUi && this._dsUi.body.isConnected && this._dsUi.body.parentNode === host) return this._dsUi;
        host.querySelectorAll(":scope > .ds-body").forEach((n) => n.remove());
        const doc = host.ownerDocument;
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
            this._dsAll = !this._dsAll;
            this.previzRefreshDopeSheet();
        });
        btn("Offset…", "Stagger the selected keys: each object starts a few frames after the one before",
            (b) => this._dsAskNumber(b, "Offset each object by (frames)", this._dsLastStep ?? 2,
                                    (v) => { this._dsLastStep = v; this.previzDopeStagger(v); }));
        btn("Scale…", "Scale the selected keys in time (about the first selected key)",
            (b) => this._dsAskNumber(b, "Scale time by (×)", this._dsLastScale ?? 2,
                                    (v) => { this._dsLastScale = v; this.previzDopeScale(v); }, { step: 0.1, min: 0.01 }));
        btn("Ease ▾", "Smooth, linear or stepped from the selected keys on", (b) => {
            const r = b.getBoundingClientRect();
            this._previzOpenMenu(EASES.map(([ease, label]) => ({ label, run: () => this.previzDopeEase(ease) })),
                                 r.left, r.bottom + 2, b);
        });
        btn("Copy", "Copy the selected keys (Ctrl+C)", () => this.previzDopeCopy());
        btn("Paste", "Paste at the playhead (Ctrl+V); a copy of one object pastes onto the selected ones",
            () => this.previzDopePaste());
        btn("Delete", "Delete the selected keys (Del)", () => this.previzDopeDelete());
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
            this._dsDown(e);
        });
        body.addEventListener("dblclick", (e) => {
            const key = e.target.closest && e.target.closest(".ds-key");
            if (key) this.setFrame(Number(key.dataset.f));
        });
        grid.addEventListener("scroll", () => this._dsPlaceOverlay());
        const RO = (doc.defaultView || window).ResizeObserver;
        if (RO) new RO(() => this._dsPlaceOverlay()).observe(wrap);
        this._dsUi = { body, bar, all, info, wrap, grid, ruler, rows, over, cursor, empty, headName };
        return this._dsUi;
    },

    /** Frame <-> pixel across a lane. */
    _dsGeom() {
        const ui = this._dsUi;
        const b = this.getTimelineBounds();
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
    },

    _dsDraw(ui) {
        const doc = ui.body.ownerDocument;
        const items = this._dsItems();
        ui.all.classList.toggle("active", !!this._dsAll);
        const none = !items.length;
        ui.wrap.style.display = none ? "none" : "";
        ui.empty.style.display = none ? "block" : "none";
        if (none) {
            ui.empty.textContent = this._dsAll ? "Nothing in the scene is animated yet."
                : "Select something in the scene (or press All) to see its keys.";
            ui.info.textContent = "";
            return;
        }
        const rows = this._dsRows(items);
        this._dsRowsNow = rows;
        const sel = this._dsSelSet();
        const g = this._dsGeom();

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
        const picked = this.previzDopeSelection();
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
                const ease = keys.length === 1 ? (S.track(this._dsItemById(keys[0].id), keys[0].prop)
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
        this._dsPlaceOverlay();
    },

    _dsItemById(id) { return S.itemById(this.previzScene(), id); },

    /** The playhead line (and the box being dragged), over the lanes. */
    _dsPlaceOverlay() {
        const ui = this._dsUi;
        if (!ui || !ui.body.isConnected) return;
        const wr = ui.wrap.getBoundingClientRect();
        const rr = ui.ruler.getBoundingClientRect();
        ui.over.style.left = `${rr.left - wr.left}px`;
        ui.over.style.width = `${rr.width}px`;
        const g = this._dsGeom();
        const f = Math.round(this.currentFrame || 0);
        ui.cursor.style.left = `${g.x(f) - rr.left}px`;
        ui.cursor.style.display = f < g.min || f > g.max ? "none" : "";
    },

    // ── The pointer ──────────────────────────────────────────────────────────

    _dsDown(e) {
        if (e.button !== 0) return;
        const ui = this._dsUi;
        const t = e.target;
        if (t.closest(".ds-bar")) return;
        const fold = t.closest(".ds-fold");
        if (fold) {
            const set = this._dsFolded || (this._dsFolded = new Set());
            const id = fold.dataset.fold;
            if (set.has(id)) set.delete(id); else set.add(id);
            this.previzRefreshDopeSheet();
            return;
        }
        const name = t.closest(".ds-name[data-item]");
        if (name) { this.previzSelect(name.dataset.item, { add: e.shiftKey || e.ctrlKey || e.metaKey }); return; }
        const handle = t.closest(".ds-handle");
        if (handle) { e.preventDefault(); this._dsScaleDrag(e, handle.dataset.side); return; }
        const key = t.closest(".ds-key");
        if (key) { e.preventDefault(); this._dsKeyDown(e, key); return; }
        if (t.closest(".ds-ruler")) { e.preventDefault(); this._dsScrub(e); return; }
        if (t.closest(".ds-lane")) { e.preventDefault(); this._dsMarquee(e); return; }
        if (ui && t.closest(".ds-wrap")) { this._dsSetSelection([]); this.previzRefreshDopeSheet(); }
    },

    _dsKeysAt(rowIndex, f) {
        const row = (this._dsRowsNow || [])[rowIndex];
        return row ? (row.byFrame.get(f) || []) : [];
    },

    _dsKeyDown(e, el) {
        const keys = this._dsKeysAt(Number(el.dataset.row), Number(el.dataset.f));
        const sel = this._dsSelSet();
        const ids = keys.map(A.keyId);
        const allOn = ids.every((id) => sel.has(id));
        if (e.ctrlKey || e.metaKey) {
            for (const id of ids) if (allOn) sel.delete(id); else sel.add(id);
        } else if (e.shiftKey) {
            for (const id of ids) sel.add(id);
        } else if (!allOn) {
            this._dsSetSelection(keys);
        }
        this.previzRefreshDopeSheet();
        if ((e.ctrlKey || e.metaKey) && allOn) return;
        this._dsMoveDrag(e, Number(el.dataset.f));
    },

    /** The tracks of the selection, as they are now - what a live drag starts from every move. */
    _dsBase(sel) {
        const ids = new Set(sel.map((k) => k.id));
        const scene = this.previzScene();
        const base = new Map();
        for (const id of ids) {
            const it = S.itemById(scene, id);
            if (it) base.set(id, JSON.stringify(it.tracks || {}));
        }
        return base;
    },

    _dsRestore(base) {
        const scene = this.previzScene();
        for (const [id, json] of base) {
            const it = S.itemById(scene, id);
            if (it) it.tracks = JSON.parse(json);
        }
    },

    _dsDrag(e, onMove, label) {
        const win = this._viewerWindow();
        const x0 = e.clientX, y0 = e.clientY;
        let started = false;
        const move = (ev) => {
            if (!started) {
                if (Math.abs(ev.clientX - x0) < DRAG_SLOP && Math.abs(ev.clientY - y0) < DRAG_SLOP) return;
                started = true;
                if (label) this.previzBeginDrag(label);
            }
            onMove(ev, x0, y0);
        };
        const up = (ev) => {
            win.removeEventListener("pointermove", move);
            win.removeEventListener("pointerup", up);
            if (started) {
                if (label) this.previzEndDrag();
                if (label) this.previzChanged();
            }
            if (this._dsDragDone) { const d = this._dsDragDone; this._dsDragDone = null; d(started, ev); }
        };
        win.addEventListener("pointermove", move);
        win.addEventListener("pointerup", up);
    },

    _dsMoveDrag(e, fromFrame) {
        const sel = this.previzDopeSelection();
        if (!sel.length) return;
        const items = this.previzScene().items;
        const base = this._dsBase(sel);
        let last = 0;
        this._dsDrag(e, (ev) => {
            const g = this._dsGeom();
            const d = Math.round(g.frameAt(ev.clientX) - fromFrame);
            if (d === last) return;
            last = d;
            this._dsRestore(base);
            this._dsSetSelection(A.moveKeys(items, sel, d));
            this.previzChanged({ persist: false, light: true });
        }, "move keys");
    },

    _dsScaleDrag(e, side) {
        const sel = this.previzDopeSelection();
        const range = A.selectionRange(sel);
        if (sel.length < 2 || range.max <= range.min) return;
        const items = this.previzScene().items;
        const base = this._dsBase(sel);
        const pivot = side === "hi" ? range.min : range.max;
        const end = side === "hi" ? range.max : range.min;
        let last = 1;
        this._dsDrag(e, (ev) => {
            const g = this._dsGeom();
            const to = Math.round(g.frameAt(ev.clientX));
            let k = (to - pivot) / (end - pivot);
            if (!(k > 0)) k = 1 / Math.max(1, Math.abs(end - pivot));
            if (k === last) return;
            last = k;
            this._dsRestore(base);
            this._dsSetSelection(A.scaleKeys(items, sel, k, pivot));
            this.previzChanged({ persist: false, light: true });
        }, "scale keys");
    },

    _dsScrub(e) {
        const go = (ev) => {
            const g = this._dsGeom();
            this.setFrame(Math.round(Math.max(g.min, Math.min(g.max, g.frameAt(ev.clientX)))));
        };
        go(e);
        this._dsDrag(e, go, null);
    },

    /** A box on empty lanes selects the keys inside it (Shift / Ctrl add). */
    _dsMarquee(e) {
        const ui = this._dsUi;
        const add = e.shiftKey || e.ctrlKey || e.metaKey;
        const doc = ui.body.ownerDocument;
        const box = doc.createElement("div");
        box.className = "ds-marquee";
        ui.over.append(box);
        const before = add ? [...this._dsSelSet()] : [];
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
                    for (const k of this._dsKeysAt(Number(d.dataset.row), Number(d.dataset.f))) sel.add(A.keyId(k));
                }
            }
            this._dsSel = sel;
            for (const d of ui.rows.querySelectorAll(".ds-key")) {
                const keys = this._dsKeysAt(Number(d.dataset.row), Number(d.dataset.f));
                const on = keys.filter((k) => sel.has(A.keyId(k))).length;
                d.classList.toggle("on", on === keys.length);
                d.classList.toggle("part", on > 0 && on < keys.length);
            }
        };
        this._dsDragDone = (started) => {
            box.remove();
            if (!started && !add) this._dsSetSelection([]);
            this.previzRefreshDopeSheet();
        };
        this._dsDrag(e, pick, null);
    },

    // ── Commands (the bar, the keys, and agents / tests) ─────────────────────

    /** The selection, or - with none - every key on the sheet. */
    _dsTargets() {
        const sel = this.previzDopeSelection();
        return sel.length ? sel : A.keysOf(this._dsItems());
    },

    _dsApply(label, fn) {
        const scene = this.previzScene();
        if (!scene) return null;
        this.previzSnapshot(label);
        const out = fn(scene.items);
        this.previzChanged();
        return out;
    },

    previzDopeMove(delta) {
        const sel = this.previzDopeSelection();
        if (!sel.length || !Math.round(delta)) return 0;
        this._dsApply("move keys", (items) => this._dsSetSelection(A.moveKeys(items, sel, delta)));
        return sel.length;
    },

    previzDopeStagger(step) {
        const sel = this._dsTargets();
        const ids = new Set(sel.map((k) => k.id));
        if (ids.size < 2) {
            notice("info", "Offset", "Select keys on at least two objects (or show them with All).");
            return 0;
        }
        this._dsApply("offset keys", (items) => this._dsSetSelection(A.staggerKeys(items, sel, step)));
        return ids.size;
    },

    previzDopeScale(factor, pivot) {
        const sel = this._dsTargets();
        if (!sel.length || !(factor > 0)) return 0;
        const p = pivot === "playhead" ? Math.round(this.currentFrame || 0)
                : Number.isFinite(pivot) ? pivot : A.selectionRange(sel).min;
        this._dsApply("scale keys", (items) => this._dsSetSelection(A.scaleKeys(items, sel, factor, p)));
        return sel.length;
    },

    previzDopeEase(ease) {
        const sel = this._dsTargets();
        if (!sel.length) return 0;
        return this._dsApply(`${ease} keys`, (items) => A.setKeysEase(items, sel, ease));
    },

    previzDopeDelete() {
        const sel = this.previzDopeSelection();
        if (!sel.length) return 0;
        const n = this._dsApply("delete keys", (items) => A.deleteKeys(items, sel));
        this._dsSetSelection([]);
        this.previzRefreshDopeSheet();
        return n;
    },

    previzDopeCopy() {
        const sel = this.previzDopeSelection();
        if (!sel.length) { notice("info", "Copy keys", "Select some keys first."); return 0; }
        this._dsClip = A.copyKeys(this.previzScene().items, sel);
        notice("info", "Copied", `${this._dsClip.length} key${this._dsClip.length === 1 ? "" : "s"}.`);
        return this._dsClip.length;
    },

    previzDopePaste(frame) {
        const clip = this._dsClip;
        if (!clip || !clip.length) { notice("info", "Paste keys", "Copy some keys first."); return 0; }
        const at = Number.isFinite(frame) ? frame : Math.round(this.currentFrame || 0);
        const targets = this.previzSelectedIds();
        const pasted = this._dsApply("paste keys", (items) => A.pasteKeys(items, clip, at, targets));
        this._dsSetSelection(pasted);
        this.previzRefreshDopeSheet();
        return pasted ? pasted.length : 0;
    },

    previzDopeSelectAll() {
        this._dsSetSelection(A.keysOf(this._dsItems()));
        this.previzRefreshDopeSheet();
    },

    /** The Dope Sheet's keys while it has the focus; true when taken. */
    previzDopeKeyDown(e) {
        const ui = this._dsUi;
        if (!ui || !ui.body.isConnected || !e.composedPath().includes(ui.body)) return false;
        const k = e.key, mod = e.ctrlKey || e.metaKey;
        let done = true;
        if (k === "Delete" || k === "Backspace") this.previzDopeDelete();
        else if (mod && (k === "c" || k === "C")) this.previzDopeCopy();
        else if (mod && (k === "v" || k === "V")) this.previzDopePaste();
        else if (mod && (k === "a" || k === "A")) this.previzDopeSelectAll();
        else if (k === "Escape") { this._dsSetSelection([]); this.previzRefreshDopeSheet(); }
        else if (!mod && (k === "," || k === "<")) this.previzDopeMove(e.shiftKey ? -10 : -1);
        else if (!mod && (k === "." || k === ">")) this.previzDopeMove(e.shiftKey ? 10 : 1);
        else done = false;
        if (done) { e.preventDefault(); e.stopImmediatePropagation(); }
        return done;
    },

    /** A small number field under a button: Enter / OK runs it, Esc goes away. */
    _dsAskNumber(anchor, label, value, run, { step = 1, min = null } = {}) {
        return this._dsAskFields(anchor, [{ name: "v", label, value, step, min }], (v) => run(v.v));
    },

    /**
     * A few fields under a button (numbers, or a checkbox with `type`), in the
     * panel - so it goes along when the viewer is popped out. Enter / OK runs
     * `run({name: value})`, Esc or a click elsewhere puts it away.
     */
    _dsAskFields(anchor, fields, run) {
        const host = anchor.closest(".curves-panel") || anchor.parentNode;
        host.querySelectorAll(".ds-pop").forEach((n) => n.remove());
        const doc = host.ownerDocument;
        const pop = doc.createElement("div");
        pop.className = "ds-pop";
        const inputs = [];
        for (const f of fields) {
            const lab = doc.createElement("label");
            const input = doc.createElement("input");
            input.name = f.name;
            if (f.type === "checkbox") {
                input.type = "checkbox";
                input.checked = !!f.value;
                lab.append(input, doc.createTextNode(" " + f.label));
            } else {
                input.type = "number";
                input.step = String(f.step ?? 1);
                if (f.min !== null && f.min !== undefined) input.min = String(f.min);
                input.value = String(f.value);
                lab.append(doc.createTextNode(f.label), input);
            }
            inputs.push([f, input]);
            pop.append(lab);
        }
        const ok = doc.createElement("button");
        ok.className = "previz-btn";
        ok.textContent = "OK";
        const close = () => { pop.remove(); win.removeEventListener("pointerdown", away, true); };
        const go = () => {
            const out = {};
            for (const [f, input] of inputs) {
                out[f.name] = f.type === "checkbox" ? input.checked : Number(input.value);
                if (f.type !== "checkbox" && !Number.isFinite(out[f.name])) return;
            }
            close();
            run(out);
        };
        ok.onclick = go;
        pop.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter") { e.preventDefault(); go(); }
            else if (e.key === "Escape") { e.preventDefault(); close(); }
        });
        pop.append(ok);
        const win = doc.defaultView || window;
        const away = (e) => { if (!e.composedPath().includes(pop)) close(); };
        win.addEventListener("pointerdown", away, true);
        const hr = host.getBoundingClientRect(), ar = anchor.getBoundingClientRect();
        pop.style.left = `${Math.max(0, Math.min(ar.left - hr.left, hr.width - 220))}px`;
        pop.style.top = `${ar.bottom - hr.top + 2}px`;
        host.append(pop);
        const first = inputs[0] && inputs[0][1];
        if (first) { first.focus(); if (first.select) first.select(); }
        return pop;
    },
};

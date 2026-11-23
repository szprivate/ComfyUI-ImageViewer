// imageViewer_previzDopeSheet.js
// The 3D space's Dope Sheet: keys as diamonds on rows over time, for timing
// rather than values. A dock panel (`dopeSheet`, #dope-sheet-panel), a tab
// beside the Curve Editor in the strip under the picture.
//
// The sheet comes in instances (Sebastian 2026-11-23): the implementation lives in
// imageViewer_previzDopeSheetInstance.js, one closure per sheet with its own folded rows, All switch and scroll.
// This mixin keeps the FIRST one with its state on the viewer as it always was (every older caller of
// this._dsUi / this._dsFolded / this._dsSel reads and writes it still), and registers the maker the dock calls
// for every further one ("dopeSheet@2", ...). The key selection is shared - one scene per tab - so a click in any
// sheet drives the same selection the commands read; a refresh fans out to every sheet that is up.
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
import { createDopeSheetInstance, dsItems, dsRows } from "./imageViewer_previzDopeSheetInstance.js";

export const PrevizDopeSheetMixin = {

    // ── What is shown ────────────────────────────────────────────────────────

    /** The objects on the first sheet: the selection in scene order, or every animated one. */
    _dsItems() { return dsItems(this, this._dsAll); },

    _dsRows(items) { return dsRows(items, this._dsFolded || (this._dsFolded = new Set())); },

    _dsSelSet() { return this._dsSel || (this._dsSel = new Set()); },

    /** The selection as keys, only the ones still there. Shared by every sheet. */
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

    // ── The first sheet, and the maker for the rest ──────────────────────────

    _dsHost() { return this.dopeSheetPanel || null; },

    /** The first sheet, made once; its state is the viewer's own (st === this). */
    _dsPrimary() {
        this._dsRegisterMaker();
        if (this._dsInst) return this._dsInst;
        const host = this._dsHost();
        if (!host) return null;
        this._dsInst = createDopeSheetInstance(this, host, this, null);
        return this._dsInst;
    },

    /** Every further sheet: a panel of its own, seeded like the first, then independent. */
    _dsRegisterMaker() {
        if (!this._dockMakers) return;
        const makers = this._dockMakers();
        if (makers.dopeSheet) return;
        makers.dopeSheet = (v, id, saved) => {
            const d = (v._dockRootEl && v._dockRootEl.ownerDocument)
                || (v.dopeSheetPanel && v.dopeSheetPanel.ownerDocument);
            if (!d) return null;
            const host = d.createElement("div");
            host.className = "curves-panel dope-sheet-panel";
            const seed = saved || { all: !!v._dsAll, folded: [...(v._dsFolded || [])] };
            return createDopeSheetInstance(v, host, {}, seed);
        };
    },

    /** Called with every refresh of the 3D panels (previzRefreshCurves): the first sheet and every instance up. */
    previzRefreshDopeSheet() {
        this._dsRegisterMaker();
        const host = this._dsHost();
        const previz = !!(this.isPrevizTab && this.isPrevizTab());
        if (!previz && host && this.isPanelDocked && this.isPanelDocked("dopeSheet")) {
            this.setPanelDocked("dopeSheet", false);
        }
        if (previz && host && this.isPanelDocked && this.isPanelDocked("dopeSheet")
            && (!this.isPanelFront || this.isPanelFront("dopeSheet"))) {
            const inst = this._dsPrimary();
            if (inst) inst.refresh();
        }
        if (this._dockInstancesOf) {
            for (const { inst } of this._dockInstancesOf("dopeSheet")) inst.refresh();
        }
    },

    _dsBuild(host) {
        const inst = this._dsPrimary();
        return inst ? inst.ui : null;
    },

    /** Frame <-> pixel across the first sheet's lane. */
    _dsGeom() {
        const inst = this._dsPrimary();
        return inst ? inst.geom() : null;
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

    /** The Dope Sheet's keys while one of its sheets has the focus; true when taken. */
    previzDopeKeyDown(e) {
        const path = e.composedPath();
        const focused = (ui) => !!(ui && ui.body && ui.body.isConnected && path.includes(ui.body));
        let hit = focused(this._dsUi);
        if (!hit && this._dockInstancesOf) {
            for (const { inst } of this._dockInstancesOf("dopeSheet")) if (focused(inst.ui)) { hit = true; break; }
        }
        if (!hit) return false;
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
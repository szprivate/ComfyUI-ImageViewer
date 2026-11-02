// bEpicViewer_editPanels.js
// The Edit panel's two companions: the Inspector and Effects.
//
// Both are dock panels of their own (ids "editInspector" and "editEffects") and,
// like the Edit panel, are up only while a cut's tab is. They are drawn from the
// same place the timeline is (editTlRefresh -> editPanelsRefresh) and change the
// cut through the same functions (bEpicViewer_editTimelineData.js), so there is
// one cut and three views of it.
//
// INSPECTOR - what is selected: the clip's name, a row of tabs, and under each
// tab sections that have a switch (off: the section is not applied, its numbers
// are kept) and a reset, with a reset on every row as well. It is drawn in the
// viewer's own look - the panels' ground, the Edit panel's buttons, the cyan
// numbers of every other field here - and deliberately not in any other
// program's: what it borrows from editors is the idea of sections, nothing of
// how one of them looks.
//
//   a clip        Video   Transform (zoom, position, rotation angle, anchor
//                         point, flip) · Cropping · Composite (opacity)
//                 Audio   Volume
//                 Timing  start, source in / out (a slip), length, speed (retime), loop,
//                         the dissolve in, order
//                 File    name, colour, source
//   a text        Title   its words and its look;  Timing
//   a dissolve    Transition  its duration
//
// Every control is something the Edit tab draws and the render writes
// (clipFx / timeline_render.lay): there is no row here that only looks like
// one. What an editor's inspector has and this one does not - pitch and yaw,
// crop softness, dynamic zoom, speed, keyframes - is not shown rather than
// shown dead.
//
// EFFECTS - a toolbox: categories on the left, what is in one on the right.
// An item is dragged onto the timeline, or double-clicked to be applied at the
// selection / the playhead:
//
//   Video Transitions   Cross Dissolve, onto the join between two shots (it is
//                       taken away on its bar, or in the Inspector)
//   Titles              Text, drawn on the picture - by the Edit tab while it
//                       plays and by the render, the same way
//   Generators          a plain colour, as a clip (a PNG made by the server:
//                       a clip is a piece of a file)
import { api } from "../../scripts/api.js";
import * as D from "./bEpicViewer_editTimelineData.js";
import { notice } from "./bEpicViewer_exportUI.js";

const EFFECT_TYPE = "application/x-bepic-effect";

const TOOLBOX = [
    { id: "transitions", name: "Video Transitions", items: [
        { name: "Cross Dissolve \u00bd s", note: "onto the join between two shots", fx: { type: "dissolve", seconds: 0.5 } },
        { name: "Cross Dissolve 1 s", note: "onto the join between two shots", fx: { type: "dissolve", seconds: 1 } },
        { name: "Cross Dissolve 2 s", note: "onto the join between two shots", fx: { type: "dissolve", seconds: 2 } },
    ] },
    { id: "titles", name: "Titles", items: [
        { name: "Text 2 s", note: "words on the picture, low in it", fx: { type: "text", text: "Text", seconds: 2 } },
        { name: "Text 5 s", note: "words on the picture, low in it", fx: { type: "text", text: "Text", seconds: 5 } },
        { name: "Title", note: "large, in the middle", fx: { type: "text", text: "Title", seconds: 3, look: { size: 12, y: 0.5 } } },
    ] },
    { id: "generators", name: "Generators", items: [
        { name: "Solid Black", note: "a plain colour, as a clip", color: "#000000", fx: { type: "solid", color: "#000000", name: "Black" } },
        { name: "Solid White", note: "a plain colour, as a clip", color: "#ffffff", fx: { type: "solid", color: "#ffffff", name: "White" } },
        { name: "Solid Grey", note: "a plain colour, as a clip", color: "#808080", fx: { type: "solid", color: "#808080", name: "Grey" } },
        { name: "Solid Colour", note: "pick it at the right", custom: true, fx: { type: "solid", color: "#2980b9", name: "Colour" } },
    ] },
];

export const EditPanelsMixin = {

    editPanelsRefresh() {
        this._editInspRender();
        this._editFxRender();
    },

    // ── Inspector ────────────────────────────────────────────────────────────

    /** The selected clip and the playhead in its own time: { c, sel, u (frame-snapped, held inside it), inside, start }. */
    _editInspKeying(cut, sel, c) {
        const fps = (cut && cut.fps) || 24;
        const span = D.selSpan(cut, sel) || { start: 0, end: Number(c.length) || 0 };
        const head = this._editTlOnScreen && this._editTlOnScreen() ? (this.currentFrame || 0) / fps : span.start;
        const inside = head >= span.start - 1e-6 && head < span.end - 1e-6;
        const last = Math.max(0, Math.round((span.end - span.start) * fps) - 1) / fps;
        const u = Math.round(Math.max(0, Math.min(last, head - span.start)) * fps) / fps;
        return { c, sel, u: Math.round(u * 10000) / 10000, inside, start: span.start, fps };
    },

    /**
     * A row's keyframe controls, as Resolve's: the diamond (hollow: no keys;
     * filled: a key at the playhead; outlined and lit: keys, but not here) adds or
     * takes away a key at the playhead for the row's params; right-click it: how
     * it goes on to the next (linear, ease in / out / in-out, hold); the arrows go
     * to the key before / after.
     */
    _editInspKeys(doc, k, params, label) {
        const box = doc.createElement("span");
        box.className = "insp-keys";
        const c = k.c;
        const here = D.keyedAt(c, params, k.u) && D.keyTimes(c, params).length > 0;
        const any = D.keyTimes(c, params).length > 0;
        const btn = (cls, text, title, fn, disabled) => {
            const b = doc.createElement("button");
            b.className = "insp-keybtn " + cls;
            b.textContent = text;
            b.title = title;
            b.disabled = !!disabled;
            b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
            return b;
        };
        const go = (dir) => {
            const t = D.nextKeyTime(c, params, k.u, dir);
            if (t != null && this._editTlSeek) this._editTlSeek(k.start + t);
        };
        const prev = btn("prev", "\u25c2", `The key of ${label} before`, () => go(-1), D.nextKeyTime(c, params, k.u, -1) == null);
        const next = btn("next", "\u25b8", `The key of ${label} after`, () => go(1), D.nextKeyTime(c, params, k.u, 1) == null);
        // Several clips selected: the diamond works on every one the playhead lies inside; its state is the primary's.
        const targets = k.targetsFor ? k.targetsFor(params) : [k];
        const reach = targets.some((t) => t.inside);
        const toggleAll = () => {
            let next = this._editTlCut;
            for (const t of targets) {
                if (!t.inside) continue;
                const on = D.keyedAt(D.clipOf(next, t.sel), params, t.u);
                if (here && on) next = D.removeKeys(next, t.sel, params, t.u);
                else if (!here && !on) next = D.toggleKeys(next, t.sel, params, t.u);
            }
            if (next !== this._editTlCut) this._editTlApply(next);
        };
        const dia = btn("insp-diamond" + (here ? " on" : any ? " has" : ""), here ? "\u25c6" : "\u25c7",
            !reach ? `${label}: put the playhead on ${targets.length > 1 ? "one of the selected clips" : "this clip"} to set a keyframe`
                : here ? `${label}: a keyframe here - click to take it away; right-click: how it goes on to the next`
                : `${label}: add a keyframe at the playhead` + (any ? " (it is animated: a change here makes one by itself)" : ""),
            () => { this._editFxLive = null; toggleAll(); }, !reach);
        dia.dataset.state = here ? "on" : any ? "has" : "none";
        dia.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!here) return;
            this._editKeyInterpMenu(e, k.sel, params, k.u);
        });
        box.append(prev, dia, next);
        return box;
    },

    /**
     * The keys of the selected clip, drawn on its block as small diamonds (one per
     * moment that has a key of any param): dragged along the clip they move every
     * key of that moment (snapping to frames and to the playhead; one undo step),
     * a click selects it (Del takes it away, Esc lets it go), right-click: how it
     * goes on to the next.
     */
    _editTlKeyMarks(b, sel, c) {
        const times = D.keyTimes(c);
        if (!times.length) return;
        const doc = b.ownerDocument;
        const len = Math.max(1e-6, Number(c.length) || 0);
        const ks = this._editTlKeySel;
        for (const t of times) {
            const m = doc.createElement("span");
            m.className = "edit-keymark" + (ks && D.sameSel(ks.sel, sel) && Math.abs(ks.t - t) < 1e-6 ? " on" : "");
            m.style.left = Math.max(0, Math.min(100, (t / len) * 100)) + "%";
            m.dataset.t = String(t);
            const how = D.keyInterpAt(c, null, t);
            if (how !== "linear") m.dataset.how = how;
            m.title = `Keyframe at ${D.timecode(t, (this._editTlCut && this._editTlCut.fps) || 24)} into the clip (${how}) - drag to move it, Del takes it away, right-click: ease`;
            m.addEventListener("pointerdown", (e) => this._editTlKeyDown(e, m, sel, t));
            m.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._editTlKeySel = { sel, t };
                this._editKeyInterpMenu(e, sel, null, t);
            });
            b.append(m);
        }
    },

    _editTlKeyDown(e, m, sel, t0) {
        if (e.button !== 0) return;
        const start = this._editTlCut;
        const c = D.clipOf(start, sel);
        const span = D.selSpan(start, sel);
        if (!c || !span) return;
        const fps = start.fps || 24;
        const len = Number(c.length) || 0;
        this._editTlSel = sel;
        this._editTlKeySel = { sel, t: t0 };
        let at = t0;
        this._editTlDrag(e, m, (seconds) => {
            let u = Math.max(0, Math.min(len - 1 / fps, t0 + seconds));
            // Onto the playhead when near it (the snapping distance), else onto a frame.
            const head = this._editTlOnScreen() ? (this.currentFrame || 0) / fps - span.start : null;
            const near = this._editTlLay && this._editTlUi ? D.snapSeconds(D.SNAP_PX, this._editTlLay.total, this._editTlUi.area.getBoundingClientRect().width) : 0;
            const snap = !this._editTlView || this._editTlView.snap !== false;
            if (snap && head != null && Math.abs(u - head) <= near) u = head;
            u = Math.round(Math.max(0, u) * fps) / fps;
            at = Math.round(u * 10000) / 10000;
            this._editTlCut = D.moveKeysAt(start, sel, t0, at);
            this._editTlKeySel = { sel, t: at };
            this.editTlRefresh();
        }, () => { this.editTlRefresh(); });
    },

    /** Del with a key mark selected: every key of that moment taken away (one undo step). True when it did. */
    editTlKeyDelete() {
        const ks = this._editTlKeySel;
        const c = ks && D.clipOf(this._editTlCut, ks.sel);
        if (!c || !D.keyTimes(c).some((t) => Math.abs(t - ks.t) < 1e-6)) { this._editTlKeySel = null; return false; }
        this._editTlKeySel = null;
        this._editTlApply(D.removeKeys(this._editTlCut, ks.sel, D.KEY_PARAMS, ks.t));
        return true;
    },

    /** How the keys at clip time `u` go on to the next: a menu (Inspector diamonds and the timeline's key marks). */
    _editKeyInterpMenu(e, sel, params, u) {
        const c = D.clipOf(this._editTlCut, sel);
        if (!c) return;
        const now = D.keyInterpAt(c, params, u);
        const names = { linear: "Linear", in: "Ease in", out: "Ease out", inout: "Ease in and out", hold: "Hold (a step)" };
        this._previzOpenMenu(D.INTERPS.map((how) => ({
            label: (how === now ? "\u2713 " : "") + names[how],
            run: () => this._editTlApply(D.setKeyInterp(this._editTlCut, sel, params, u, how)),
        })), e.clientX, e.clientY);
    },

    _editInspRender() {
        const host = this.editInspectorPanel;
        if (!host || !this.isPanelDocked || !this.isPanelDocked("editInspector")) return;
        const doc = host.ownerDocument;
        let body = host.querySelector(":scope > .insp-body");
        if (!body) {
            body = doc.createElement("div");
            body.className = "insp-body";
            host.append(body);
        }
        const cut = this._editTlTab ? this._editTlCut : null;
        const sel = cut ? this._editTlSel : null;
        const fps = (cut && cut.fps) || 24;
        const parts = [];
        const el = (tag, cls, text) => {
            const n = doc.createElement(tag);
            if (cls) n.className = cls;
            if (text !== undefined) n.textContent = text;
            return n;
        };
        const quiet = (input) => { input.addEventListener("keydown", (e) => e.stopPropagation()); return input; };
        const apply = (next) => { this._editFxLive = null; this._editTlApply(next); };
        const tip = (n, text) => { n.title = text; return n; };

        // ── the pieces every tab is made of
        const resetBtn = (title, fn) => {
            const b = tip(el("button", "insp-reset", "\u21ba"), title);
            b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
            return b;
        };
        // A section: a switch, its name, a reset; then its rows.
        let into = null;
        const section = (title, opts = {}) => {
            const sec = el("div", "insp-section" + (opts.off ? " off" : ""));
            const bar = el("div", "insp-sec");
            if (opts.toggle) {
                // The same switch a track's header has.
                const sw = tip(el("button", "edit-hbtn insp-switch" + (opts.off ? "" : " on"), "\u25cf"),
                               opts.off ? "Off: not applied, its numbers kept - click to apply it" : "On - click to switch this section off");
                sw.addEventListener("click", () => opts.toggle(!opts.off));
                bar.append(sw);
            }
            bar.append(el("span", "insp-sec-name", title));
            if (opts.reset) bar.append(resetBtn("Reset " + title, opts.reset));
            sec.append(bar);
            parts.push(sec);
            into = sec;
            return sec;
        };
        // A row: its name, its controls, its keyframes (`keys`: the params it animates), its own reset.
        let keying = null;              // { c, sel, u, inside, start } of the selected clip, for the rows' diamonds
        // Several clips selected: a change goes to every one it applies to (video to the pictures, volume to what has
        // sound), as the same absolute value. Without them these are the one selected clip.
        let mixed = () => false;
        let clearRow = (keys) => D.clearKeys(cut, sel, keys);
        const row = (label, controls, reset, keys) => {
            const r = el("div", "insp-row");
            const ctl = el("div", "insp-ctl");
            ctl.append(...[].concat(controls));
            r.append(el("span", "insp-label", label), ctl);
            if (keys && keying) {
                r.append(this._editInspKeys(doc, keying, keys, label));
                r.dataset.keys = keys.join(",");
                // Its reset takes the keys too (one undo step).
                const reach = keying.targetsFor ? keying.targetsFor(keys) : [keying];
                if (reach.some((t) => D.keyTimes(t.c, keys).length)) reset = () => apply(clearRow(keys));
                if (keys.some(mixed)) { r.dataset.mixed = keys.filter(mixed).join(","); r.classList.add("insp-mixedrow"); }
            }
            r.append(reset ? resetBtn("Reset " + label, reset) : el("span", "insp-reset-gap"));
            (into || { append: (n) => parts.push(n) }).append(r);
            return r;
        };
        const numField = (value, digits, commit, o = {}) => {
            const input = quiet(el("input", "insp-num"));
            input.type = "number";
            input.step = String(o.step || 1);
            if (o.min !== undefined) input.min = String(o.min);
            if (o.max !== undefined) input.max = String(o.max);
            input.value = Number(value).toFixed(digits);
            if (o.mixed) {
                // Differs across the selection: no number, a dash; a value typed goes to all of them.
                input.value = "";
                input.placeholder = "—";
                input.classList.add("insp-mixed");
            }
            if (o.title) input.title = o.mixed ? o.title + " (mixed: the selected clips differ)" : o.title;
            input.disabled = !!o.disabled;
            input.addEventListener("change", () => { if (input.value !== "" && Number.isFinite(Number(input.value))) commit(Number(input.value)); });
            return input;
        };
        const axis = (letter) => el("span", "insp-axis", letter);
        // A slider with its number beside it. While it is dragged only the
        // picture follows (`live`); the cut changes when it is let go, or the
        // slider would be redrawn under the pointer.
        const slider = (value, min, max, step, digits, live, commit, title, mixed) => {
            const range = el("input", "insp-range");
            range.type = "range";
            range.min = String(min);
            range.max = String(max);
            range.step = String(step);
            range.value = String(Math.max(min, Math.min(max, value)));
            const num = numField(value, digits, commit, { step, title, mixed });
            if (mixed) range.classList.add("insp-mixed");
            range.addEventListener("input", () => { num.value = Number(range.value).toFixed(digits); num.classList.remove("insp-mixed"); if (live) live(Number(range.value)); });
            range.addEventListener("change", () => commit(Number(range.value)));
            return [range, num];
        };
        const seconds = (value, commit, disabled) => numField(value, 3, (v) => commit(D.toFrame(v, fps)),
                                                              { step: 0.1, min: 0, title: "seconds", disabled });
        const said = (text) => tip(el("span", "insp-said", text), text);
        const button = (label, title, fn, disabled) => {
            const b = tip(el("button", "edit-btn", label), title);
            b.disabled = !!disabled;
            b.addEventListener("click", fn);
            return b;
        };
        // The tabs: [id, name, has it anything for this selection]. The one
        // that was open stays open from one selection to the next.
        const tabs = (list) => {
            const strip = el("div", "insp-tabs");
            const open = list.find((x) => x[0] === this._editInspTab && x[2]) || list.find((x) => x[2]);
            for (const [id, name, has] of list) {
                const b = el("button", "edit-btn insp-tab" + (open && open[0] === id ? " on" : ""), name);
                b.disabled = !has;
                b.addEventListener("click", () => { this._editInspTab = id; this._editInspRender(); });
                strip.append(b);
            }
            parts.push(strip);
            return open ? open[0] : "";
        };
        const head = (text) => parts.push(tip(el("div", "insp-title", text), text));
        const foot = (...buttons) => { const f = el("div", "insp-foot"); f.append(...buttons); parts.push(f); };
        const note = (text) => parts.push(el("div", "insp-note", text));

        if (!cut) {
            parts.push(el("div", "curves-empty", "No cut is open."));
        } else if (sel && (sel.kind === "clip" || sel.kind === "tclip") && D.clipOf(cut, sel)) {
            const c = D.clipOf(cut, sel);
            const placed = sel.kind === "tclip";
            const track = placed ? D.trackOf(cut, sel.track) : null;
            const isSound = !!track && track.kind === "audio";
            const still = D.isStill(c.file) && !isSound;
            head(c.name || String(c.file || "").split(/[\\/]/).pop() || "clip");
            const tab = tabs([["video", "Video", !isSound], ["audio", "Audio", !still], ["timing", "Timing", true], ["file", "File", true]]);
            // The playhead in the clip's own time (frame-snapped): where its keys are made and its numbers read.
            keying = this._editInspKeying(cut, sel, c);
            const u = keying.u;
            const clipSels = this._editTlSelAll().filter((s) => (s.kind === "clip" || s.kind === "tclip") && D.clipOf(cut, s));
            const several = clipSels.length > 1 && clipSels.some((s) => D.sameSel(s, sel));
            const picture = (s) => s.kind === "clip" || (D.trackOf(cut, s.track) || {}).kind !== "audio";
            const sounds = (s) => {
                const k = D.clipOf(cut, s);
                if (s.kind === "tclip" && (D.trackOf(cut, s.track) || {}).kind === "audio") return true;
                return picture(s) && !D.isStill(k.file) && !k.mute;
            };
            // The clips a row's params reach (the selected one always), each with the playhead in its own time.
            const targetsFor = (params) => {
                if (!several) return [keying];
                const want = params.includes("vol") ? sounds : picture;
                return clipSels.filter((s) => D.sameSel(s, sel) || want(s))
                    .map((s) => D.sameSel(s, sel) ? keying : this._editInspKeying(cut, s, D.clipOf(cut, s)));
            };
            keying.targetsFor = targetsFor;
            const valueOf = (t, p) => (p === "vol" ? D.paramAt(t.c, "vol", t.u) : D.rawFx(t.c, t.u)[p]);
            mixed = (p) => {
                const ts = targetsFor([p]);
                return ts.length > 1 && ts.some((t) => { const a = valueOf(t, p), b = valueOf(keying, p); return typeof a === "number" ? Math.abs(a - b) > 1e-6 : !!a !== !!b; });
            };
            clearRow = (keys) => targetsFor(keys).reduce((n, t) => D.clearKeys(n, t.sel, keys), cut);
            const eachTarget = (params, fn) => targetsFor(params).reduce((n, t) => fn(n, t), cut);
            const fx = D.rawFx(c, u);
            // A param with keys gets a key at the playhead; one without, its number (Resolve's auto-key).
            const setFx = (patch) => {
                if (!several) { apply(D.autoKey(cut, sel, patch, u)); return; }
                // Per clip: a keyed param gets a key at the playhead (only where the playhead is inside the clip), the rest their number.
                const put = (params, p) => eachTarget(params, (n, t) => {
                    const mine = D.sameSel(t.sel, sel);
                    const q = {};
                    for (const [k, v] of Object.entries(p)) if (mine || t.inside || !D.keyTimes(t.c, [k]).length) q[k] = v;
                    return Object.keys(q).length ? D.autoKey(n, t.sel, q, t.u) : n;
                });
                const { vol, ...fxPatch } = patch;
                let next = Object.keys(fxPatch).length ? put(Object.keys(fxPatch), fxPatch) : cut;
                if (vol !== undefined) next = targetsFor(["vol"]).reduce((n, t) => {
                    const mine = D.sameSel(t.sel, sel);
                    return mine || t.inside || !D.keyTimes(t.c, ["vol"]).length ? D.autoKey(n, t.sel, { vol }, t.u) : n;
                }, next);
                apply(next);
            };
            const setVol = (v) => setFx({ vol: v });
            const resetFx = (what) => apply(eachTarget(["zx"], (n, t) => D.resetClipFx(n, t.sel, what)));
            const liveFx = (patch) => {
                if (!this.editPlayFxLive) return;
                const f = { ...D.cleanFx(c.fx), ...patch };
                if (f.keys) { f.keys = { ...f.keys }; for (const k of Object.keys(patch)) delete f.keys[k]; }
                this.editPlayFxLive(c, f);
            };
            const pct = (key, label, o = {}) => row(label, slider(fx[key] * 100, 0, 100, 0.1, 1, (v) => liveFx({ [key]: v / 100 }),
                (v) => setFx({ [key]: v / 100 }), o.title || "percent", mixed(key)), () => setFx({ [key]: D.FX[key][0] }), [key]);
            if (several) {
                const m = el("div", "insp-multi", `${clipSels.length} clips`
                    + (tab === "video" || tab === "audio" ? " · a change here goes to all of them (video to the pictures, volume to what has sound)"
                                                          : " · this tab changes the last clicked clip only"));
                m.title = "Several clips are selected: Video and Audio changes are set on every one they apply to, as the same value. Timing (speed, retime, length, order) and File change the last clicked clip only.";
                parts.push(m);
            }
            if (tab === "video") {
                section("Transform", { off: fx.toff, toggle: (off) => setFx({ toff: off }), reset: () => resetFx("transform") });
                const linked = this._editInspUnlinked !== true;
                const link = tip(el("button", "edit-hbtn insp-link" + (linked ? " on" : ""), "="),
                                 linked ? "Zoom X and Y are linked - click to set them apart" : "Link zoom X and Y");
                link.addEventListener("click", () => { this._editInspUnlinked = linked; this._editInspRender(); });
                row("Zoom", [axis("X"), numField(fx.zx, 2, (v) => setFx(linked ? { zx: v, zy: v } : { zx: v }), { step: 0.01, min: 0.01, title: "1 is its own size", mixed: mixed("zx") }),
                             link, axis("Y"), numField(fx.zy, 2, (v) => setFx(linked ? { zx: v, zy: v } : { zy: v }), { step: 0.01, min: 0.01, title: "1 is its own size", mixed: mixed("zy") })],
                    () => setFx({ zx: 1, zy: 1 }), ["zx", "zy"]);
                row("Position", [axis("X"), numField(fx.x * 100, 1, (v) => setFx({ x: v / 100 }), { step: 0.5, title: "percent of the frame's width, to the right", mixed: mixed("x") }),
                                 el("span", "insp-link-gap"), axis("Y"), numField(fx.y * 100, 1, (v) => setFx({ y: v / 100 }), { step: 0.5, title: "percent of the frame's height, up", mixed: mixed("y") })],
                    () => setFx({ x: 0, y: 0 }), ["x", "y"]);
                row("Rotation Angle", slider(fx.rot, -180, 180, 0.1, 1, (v) => liveFx({ rot: v }), (v) => setFx({ rot: v }), "degrees, clockwise", mixed("rot")),
                    () => setFx({ rot: 0 }), ["rot"]);
                row("Anchor Point", [axis("X"), numField(fx.ax * 100, 1, (v) => setFx({ ax: v / 100 }), { step: 0.5, title: "the point it is scaled and turned about: percent of the frame's width from its middle", mixed: mixed("ax") }),
                                     el("span", "insp-link-gap"), axis("Y"), numField(fx.ay * 100, 1, (v) => setFx({ ay: v / 100 }), { step: 0.5, title: "percent of the frame's height from its middle, up", mixed: mixed("ay") })],
                    () => setFx({ ax: 0, ay: 0 }), ["ax", "ay"]);
                const flip = (key, glyph, title) => {
                    const b = tip(el("button", "edit-btn insp-flip" + (fx[key] ? " on" : "") + (mixed(key) ? " insp-mixed" : ""), glyph), title);
                    b.addEventListener("click", () => setFx({ [key]: !fx[key] }));
                    return b;
                };
                row("Flip", [flip("fh", "Horizontal", "Flip left to right"), flip("fv", "Vertical", "Flip top to bottom")],
                    () => setFx({ fh: false, fv: false }));

                section("Cropping", { off: fx.coff, toggle: (off) => setFx({ coff: off }), reset: () => resetFx("crop") });
                pct("cl", "Crop Left", { title: "percent of the picture taken off its left" });
                pct("cr", "Crop Right", { title: "percent of the picture taken off its right" });
                pct("ct", "Crop Top", { title: "percent of the picture taken off its top" });
                pct("cb", "Crop Bottom", { title: "percent of the picture taken off its bottom" });

                section("Composite", { off: fx.ooff, toggle: (off) => setFx({ ooff: off }), reset: () => resetFx("composite") });
                pct("op", "Opacity", { title: "percent" });
                into = null;
                if (!placed) note("This shot is on the cut itself: where it does not cover the frame, the film is black. On a track above, what is under it shows.");
            } else if (tab === "audio") {
                const resetVol = () => apply(eachTarget(["vol"], (n, t) => D.setClipProps(n, t.sel, { volume: 1 })));
                section("Volume", { reset: resetVol });
                const now = D.paramAt(c, "vol", u) * 100;
                row("Volume", slider(now, 0, 100, 1, 0, (v) => {
                    if (this._editTlOnScreen() && this._videoMode && this.videoBase) { try { this.videoBase.volume = v / 100; } catch (_) {} }
                }, (v) => setVol(v / 100), "percent", mixed("vol")), resetVol, ["vol"]);
                into = null;
            } else if (tab === "timing") {
                // Where it is and which part of its source it plays. "Start" and
                // "Source in" keep the length: a move and a slip. Speed keeps the
                // source (retime); a loop plays it again past its out point.
                section("Timing");
                const dur = this._editTlDur ? this._editTlDur() : {};
                const tc = (t) => D.timecode(t, fps);
                const startAt = placed ? Number(c.at) || 0 : D.clipStarts(cut)[sel.i];
                if (placed) row("Start", seconds(c.at, (v) => apply(D.moveTrackClip(cut, sel.track, sel.i, v))));
                else row("Start", said(tc(startAt) + "  (by its place in the order)"));
                row("Source in", seconds(c.in, (v) => apply(D.slipClip(cut, sel, v - (Number(c.in) || 0), dur)), still));
                row("Source out", said(still ? "a still: no source length" : tc(Number(c.in) + D.srcUse(c))));
                row("Length", seconds(c.length, (v) => apply(placed ? D.trimTrackClipEnd(cut, sel.track, sel.i, v, dur)
                                                                    : D.trimEnd(cut, sel.i, v, dur))));
                const sp = D.speedOf(c);
                const speed = numField(sp * 100, 1, (v) => apply(D.setSpeed(cut, sel, v / 100)),
                                       { step: 1, min: D.MIN_SPEED * 100, max: D.MAX_SPEED * 100, disabled: still,
                                         title: "percent of its own speed: its source in and out stay, its length follows (Alt+drag an edge; Shift+R: 100 %)" });
                speed.dataset.field = "speed";
                row("Speed %", speed, sp === 1 ? null : () => apply(D.setSpeed(cut, sel, 1)));
                const fill = seconds(c.length, (v) => apply(D.retimeClip(cut, sel, v)), still);
                fill.title = "a length to fill by retiming: the source stays, the speed follows";
                fill.dataset.field = "fill";
                row("Retime to", fill);
                const loop = quiet(el("select", "insp-select"));
                for (const [v, label] of [["", "Off"], ["loop", "Loop"], ["pingpong", "Ping-pong"]]) {
                    const o = el("option", "", label);
                    o.value = v;
                    loop.append(o);
                }
                loop.value = D.loopOf(c);
                loop.disabled = still;
                loop.title = "Past its source, play it again (Ctrl+drag its out-edge, Ctrl+L: one more turn)";
                loop.addEventListener("change", () => apply(D.setLoop(cut, sel, loop.value)));
                row("Loop", [loop, said(D.loopOf(c) ? `${Math.round(Number(c.length) * sp / Number(c.span) * 100) / 100} turns of ${D.lengthLabel(c.span)}`
                                                  : (still ? "a still: just make it longer" : ""))]);
                if (!placed) {
                    const i = sel.i, n = cut.clips.length;
                    row("Dissolve in", seconds(c.transition || 0, (v) => apply(D.setTransition(cut, i, v)), i === 0), i === 0 ? null : () => apply(D.setTransition(cut, i, 0)));
                    row("Order", [button("\u25c0 Earlier", "Earlier in the order", () => this._editTlMove(i, i - 1), i === 0),
                                  button("Later \u25b6", "Later in the order", () => this._editTlMove(i, i + 1), i === n - 1)]);
                }
                into = null;
            } else {
                section("Clip");
                const name = quiet(el("input", "insp-text"));
                name.type = "text";
                name.value = c.name || "";
                name.addEventListener("change", () => apply(D.setClipProps(cut, sel, { name: name.value })));
                row("Name", name);
                row("Colour", this._editTlSwatches(doc, c, (color) => apply(D.setClipProps(cut, sel, { color }))));
                row("Track", said(placed ? track.name : "V1"));
                section("File");
                const src = said(c.file || "");
                src.classList.add("insp-path");
                row("Source", src);
                into = null;
                foot(button("Remove from the cut", "Take this clip out", () => this._editTlRemove(sel), !placed && cut.clips.length <= 1));
            }
        } else if (sel && sel.kind === "text" && cut.texts[sel.i]) {
            const i = sel.i, x = cut.texts[i];
            head(String(x.text || "Text").split("\n")[0]);
            const tab = tabs([["title", "Title", true], ["timing", "Timing", true]]);
            const look = D.textLook(x);
            const texts = this._editTlSelAll().filter((s) => s.kind === "text" && cut.texts[s.i]);
            const manyTexts = texts.length > 1 && texts.some((s) => s.i === i);
            const setLook = (patch) => apply((manyTexts ? texts : [sel]).reduce((n, s) => D.setTextLook(n, s.i, patch), cut));
            if (manyTexts) parts.push(el("div", "insp-multi", `${texts.length} texts · the look goes to all of them; the words and timing to this one`));
            if (tab === "title") {
                section("Text");
                const area = quiet(el("textarea", "insp-area"));
                area.value = String(x.text || "");
                area.rows = 3;
                area.addEventListener("change", () => apply(D.setText(cut, i, area.value)));
                row("Words", area);
                section("Look", { reset: () => setLook({ ...D.TEXT_LOOK }) });
                row("Size", slider(look.size, 1, 40, 0.1, 1, null, (v) => setLook({ size: v }), "percent of the picture's height"), () => setLook({ size: D.TEXT_LOOK.size }));
                row("Position", [axis("X"), numField(look.x * 100, 1, (v) => setLook({ x: v / 100 }), { step: 0.5, min: 0, max: 100, title: "where its middle is: percent from the left" }),
                                 el("span", "insp-link-gap"), axis("Y"), numField(look.y * 100, 1, (v) => setLook({ y: v / 100 }), { step: 0.5, min: 0, max: 100, title: "percent from the top" })],
                    () => setLook({ x: D.TEXT_LOOK.x, y: D.TEXT_LOOK.y }));
                const ink = quiet(el("input", "insp-color"));
                ink.type = "color";
                ink.value = look.color;
                ink.addEventListener("change", () => setLook({ color: ink.value }));
                row("Colour", ink, () => setLook({ color: D.TEXT_LOOK.color }));
                into = null;
            } else {
                section("Timing");
                row("Starts at", seconds(x.start, (v) => apply(D.moveText(cut, i, v))));
                row("Length", seconds(x.length, (v) => apply(D.resizeText(cut, i, v))));
                into = null;
            }
            foot(button("Remove this text", "Take this text off the film", () => this._editTlRemove(sel)));
        } else if (sel && sel.kind === "mix" && cut.clips[sel.i] && sel.i > 0) {
            const i = sel.i, c = cut.clips[i];
            head("Cross Dissolve");
            tabs([["transition", "Transition", true]]);
            section("Cross Dissolve", { reset: () => apply(D.setTransition(cut, i, 1)) });
            row("Duration", slider(c.transition || 0, 0, Math.max(0.1, Math.min(c.length, cut.clips[i - 1].length) - 0.05), 1 / fps, 3, null,
                                   (v) => apply(D.setTransition(cut, i, D.toFrame(v, fps))), "seconds"));
            row("From", said(cut.clips[i - 1].name || "shot " + i));
            row("To", said(c.name || "shot " + (i + 1)));
            into = null;
            note("For its length the two shots overlap, so the film is shorter by it. On the timeline, drag an edge of its bar.");
            foot(button("Remove this dissolve", "Back to a cut", () => this._editTlRemove(sel)));
        } else {
            head(cut.name || this._editTlFile || "new cut");
            tabs([["timeline", "Timeline", true]]);
            section("Timeline");
            row("Length", said(D.lengthLabel(D.filmLength(cut)) + " \u00b7 " + D.filmFrames(cut) + " frames"));
            row("Frame rate", said(String(Math.round(fps * 1000) / 1000) + " fps"));
            row("Shots", said(String(cut.clips.length)));
            const more = (cut.tracks || []).map((k) => `${k.name} (${k.clips.length})`).join(", ");
            row("File", said(this.editTlFilePath() || "not saved yet"));
            row("Tracks", said("V1" + ((cut.sound || []).length ? ", A1" : "") + (more ? ", " + more : "")));
            into = null;
            note("Select a clip, a text or a dissolve on the timeline to change it here.");
        }
        // Where the user had scrolled to is kept: every change redraws all of it.
        const scrolled = body.scrollTop;
        body.replaceChildren(...parts);
        body.scrollTop = scrolled;
    },

    // ── Effects ──────────────────────────────────────────────────────────────

    _editFxRender() {
        const host = this.editEffectsPanel;
        if (!host || !this.isPanelDocked || !this.isPanelDocked("editEffects")) return;
        // A toolbox does not change with the cut: built once, kept.
        if (host.querySelector(":scope > .fx-body")) return;
        const doc = host.ownerDocument;
        const el = (tag, cls, text) => {
            const n = doc.createElement(tag);
            if (cls) n.className = cls;
            if (text !== undefined) n.textContent = text;
            return n;
        };
        const body = el("div", "fx-body");
        const cats = el("div", "fx-cats");
        const items = el("div", "fx-items");
        const show = (cat) => {
            this._editFxCat = cat.id;
            for (const b of cats.children) b.classList.toggle("on", b.dataset.cat === cat.id);
            items.replaceChildren(...cat.items.map((item) => {
                const fx = { ...item.fx };
                const r = el("div", "fx-item");
                r.draggable = true;
                const mark = el("span", "fx-mark fx-" + fx.type);
                if (item.color) mark.style.background = item.color;
                r.append(mark, el("span", "fx-name", item.name));
                if (item.custom) {
                    const pick = el("input", "fx-color");
                    pick.type = "color";
                    pick.value = fx.color;
                    mark.style.background = fx.color;
                    pick.addEventListener("input", () => { fx.color = pick.value; mark.style.background = pick.value; });
                    pick.addEventListener("click", (e) => e.stopPropagation());
                    r.append(pick);
                }
                r.title = item.name + " - " + item.note + ". Drag onto the timeline, or double-click to apply at the "
                    + (fx.type === "dissolve" ? "selected shot." : "playhead.");
                r.addEventListener("dragstart", (e) => {
                    try {
                        e.dataTransfer.setData(EFFECT_TYPE, JSON.stringify(fx));
                        e.dataTransfer.effectAllowed = "copy";
                    } catch (_) {}
                });
                r.addEventListener("dblclick", () => this.editFxApply(fx, null, ""));
                return r;
            }));
        };
        for (const cat of TOOLBOX) {
            const b = el("button", "fx-cat", cat.name);
            b.dataset.cat = cat.id;
            b.addEventListener("click", () => show(cat));
            cats.append(b);
        }
        body.append(cats, items);
        host.append(body);
        show(TOOLBOX.find((c) => c.id === this._editFxCat) || TOOLBOX[0]);
    },

    /**
     * Apply an effect to the cut: `fx` as the toolbox holds it, at `at` seconds
     * (null: the selection, or the playhead), on `track` where it was dropped on one.
     */
    async editFxApply(fx, at, track) {
        const cut = this._editTlTab ? this._editTlCut : null;
        if (!cut || !fx) return;
        const fps = cut.fps || 24;
        if (fx.type === "dissolve") {
            if (cut.clips.length < 2) { this._editTlSay("a dissolve joins two shots - this cut has one"); return; }
            let i = -1;
            if (at != null) {
                // Dropped: the join nearest to where it fell.
                const starts = D.clipStarts(cut);
                let best = Infinity;
                for (let k = 1; k < starts.length; k++) {
                    const d = Math.abs(starts[k] - at);
                    if (d < best) { best = d; i = k; }
                }
            } else if (this._editTlSel && this._editTlSel.kind === "clip") {
                i = this._editTlSel.i;
            }
            if (i < 1) { this._editTlSay("select the shot the dissolve leads into (not the first), or drag it onto a join"); return; }
            // Selected as what it is, so that its bar is lit and the Inspector has its length.
            this._editTlSel = fx.seconds > 0 ? { kind: "mix", i } : { kind: "clip", i };
            this._editTlApply(D.setTransition(cut, i, fx.seconds));
            return;
        }
        if (fx.type === "text") {
            const start = D.toFrame(at == null ? this._editTlNowSeconds() : at, fps);
            let next = D.addText(cut, fx.text, start, fx.seconds);
            if (fx.look) next = D.setTextLook(next, next.texts.length - 1, fx.look);
            if (next.off && next.off.T) next = D.setTrackOff(next, "T", false);      // a text just added is meant to be seen
            this._editTlSel = { kind: "text", i: next.texts.length - 1 };
            this._editTlApply(next);
            return;
        }
        if (fx.type === "solid") {
            const size = (this._displayedMediaSize && this._displayedMediaSize()) || { w: 1920, h: 1080 };
            let made = null, said = "";
            try {
                const res = await api.fetchApi("/bepic/timeline_solid", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ color: fx.color, width: size.w, height: size.h }),
                });
                if (res.ok) made = await res.json(); else said = await res.text();
            } catch (e) { said = String(e && e.message || e); }
            if (!made || !made.path) { notice("error", "The colour could not be made", said || ""); return; }
            const name = fx.name === "Colour" ? fx.color : fx.name;
            await this._editTlAdd([{ path: made.path, name, kind: "image", color: fx.color }], at, track);
        }
    },
};

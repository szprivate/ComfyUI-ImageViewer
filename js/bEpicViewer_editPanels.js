// bEpicViewer_editPanels.js
// The Edit panel's two companions: the Inspector and Effects.
//
// Both are dock panels of their own (ids "editInspector" and "editEffects") and,
// like the Edit panel, are up only while a cut's tab is. They are drawn from the
// same place the timeline is (editTlRefresh -> editPanelsRefresh) and change the
// cut through the same functions (bEpicViewer_editTimelineData.js), so there is
// one cut and three views of it.
//
// INSPECTOR - what is selected, laid out the way an editor's inspector is: the
// clip's name, a row of tabs, and under each tab sections that have a switch
// (off: the section is not applied, its numbers are kept) and a reset, with a
// reset on every row as well.
//
//   a clip        Video   Transform (zoom, position, rotation angle, anchor
//                         point, flip) · Cropping · Composite (opacity)
//                 Audio   Volume
//                 Timing  in, length, the dissolve in / where it starts, order
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
                const sw = tip(el("button", "insp-switch" + (opts.off ? "" : " on")),
                               opts.off ? "Off: not applied, its numbers kept - click to apply it" : "On - click to switch this section off");
                sw.append(el("i"));
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
        // A row: its name, its controls, its own reset.
        const row = (label, controls, reset) => {
            const r = el("div", "insp-row");
            const ctl = el("div", "insp-ctl");
            ctl.append(...[].concat(controls));
            r.append(el("span", "insp-label", label), ctl);
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
            if (o.title) input.title = o.title;
            input.disabled = !!o.disabled;
            input.addEventListener("change", () => { if (input.value !== "" && Number.isFinite(Number(input.value))) commit(Number(input.value)); });
            return input;
        };
        const axis = (letter) => el("span", "insp-axis", letter);
        // A slider with its number beside it. While it is dragged only the
        // picture follows (`live`); the cut changes when it is let go, or the
        // slider would be redrawn under the pointer.
        const slider = (value, min, max, step, digits, live, commit, title) => {
            const range = el("input", "insp-range");
            range.type = "range";
            range.min = String(min);
            range.max = String(max);
            range.step = String(step);
            range.value = String(Math.max(min, Math.min(max, value)));
            const num = numField(value, digits, commit, { step, title });
            range.addEventListener("input", () => { num.value = Number(range.value).toFixed(digits); if (live) live(Number(range.value)); });
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
                const b = el("button", "insp-tab" + (open && open[0] === id ? " on" : ""), name);
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
            const fx = D.rawFx(c);
            const setFx = (patch) => apply(D.setClipFx(cut, sel, patch));
            const liveFx = (patch) => { if (this.editPlayFxLive) this.editPlayFxLive(c, { ...D.cleanFx(c.fx), ...patch }); };
            const pct = (key, label, o = {}) => row(label, slider(fx[key] * 100, 0, 100, 0.1, 1, (v) => liveFx({ [key]: v / 100 }),
                (v) => setFx({ [key]: v / 100 }), o.title || "percent"), () => setFx({ [key]: D.FX[key][0] }));
            if (tab === "video") {
                section("Transform", { off: fx.toff, toggle: (off) => setFx({ toff: off }), reset: () => apply(D.resetClipFx(cut, sel, "transform")) });
                const linked = this._editInspUnlinked !== true;
                const link = tip(el("button", "insp-link" + (linked ? " on" : ""), "\u26ad"),
                                 linked ? "Zoom X and Y are linked - click to set them apart" : "Link zoom X and Y");
                link.addEventListener("click", () => { this._editInspUnlinked = linked; this._editInspRender(); });
                row("Zoom", [axis("X"), numField(fx.zx, 3, (v) => setFx(linked ? { zx: v, zy: v } : { zx: v }), { step: 0.01, min: 0.01, title: "1 is its own size" }),
                             link, axis("Y"), numField(fx.zy, 3, (v) => setFx(linked ? { zx: v, zy: v } : { zy: v }), { step: 0.01, min: 0.01, title: "1 is its own size" })],
                    () => setFx({ zx: 1, zy: 1 }));
                row("Position", [axis("X"), numField(fx.x * 100, 1, (v) => setFx({ x: v / 100 }), { step: 0.5, title: "percent of the frame's width, to the right" }),
                                 el("span", "insp-link-gap"), axis("Y"), numField(fx.y * 100, 1, (v) => setFx({ y: v / 100 }), { step: 0.5, title: "percent of the frame's height, up" })],
                    () => setFx({ x: 0, y: 0 }));
                row("Rotation Angle", slider(fx.rot, -180, 180, 0.1, 1, (v) => liveFx({ rot: v }), (v) => setFx({ rot: v }), "degrees, clockwise"),
                    () => setFx({ rot: 0 }));
                row("Anchor Point", [axis("X"), numField(fx.ax * 100, 1, (v) => setFx({ ax: v / 100 }), { step: 0.5, title: "the point it is scaled and turned about: percent of the frame's width from its middle" }),
                                     el("span", "insp-link-gap"), axis("Y"), numField(fx.ay * 100, 1, (v) => setFx({ ay: v / 100 }), { step: 0.5, title: "percent of the frame's height from its middle, up" })],
                    () => setFx({ ax: 0, ay: 0 }));
                const flip = (key, glyph, title) => {
                    const b = tip(el("button", "insp-flip" + (fx[key] ? " on" : ""), glyph), title);
                    b.addEventListener("click", () => setFx({ [key]: !fx[key] }));
                    return b;
                };
                row("Flip", [flip("fh", "\u25b6\u25c0", "Flip left to right"), flip("fv", "\u25b2\u25bc", "Flip top to bottom")],
                    () => setFx({ fh: false, fv: false }));

                section("Cropping", { off: fx.coff, toggle: (off) => setFx({ coff: off }), reset: () => apply(D.resetClipFx(cut, sel, "crop")) });
                pct("cl", "Crop Left", { title: "percent of the picture taken off its left" });
                pct("cr", "Crop Right", { title: "percent of the picture taken off its right" });
                pct("ct", "Crop Top", { title: "percent of the picture taken off its top" });
                pct("cb", "Crop Bottom", { title: "percent of the picture taken off its bottom" });

                section("Composite", { off: fx.ooff, toggle: (off) => setFx({ ooff: off }), reset: () => apply(D.resetClipFx(cut, sel, "composite")) });
                pct("op", "Opacity", { title: "percent" });
                into = null;
                if (!placed) note("This shot is on the cut itself: where it does not cover the frame, the film is black. On a track above, what is under it shows.");
            } else if (tab === "audio") {
                section("Volume", { reset: () => apply(D.setClipProps(cut, sel, { volume: 1 })) });
                const now = Math.max(0, Math.min(1, c.volume == null ? 1 : Number(c.volume))) * 100;
                row("Volume", slider(now, 0, 100, 1, 0, (v) => {
                    if (this._editTlOnScreen() && this._videoMode && this.videoBase) { try { this.videoBase.volume = v / 100; } catch (_) {} }
                }, (v) => apply(D.setClipProps(cut, sel, { volume: v / 100 })), "percent"), () => apply(D.setClipProps(cut, sel, { volume: 1 })));
                into = null;
            } else if (tab === "timing") {
                section("Timing");
                if (placed) {
                    row("Starts at", seconds(c.at, (v) => apply(D.moveTrackClip(cut, sel.track, sel.i, v))));
                    row("In", seconds(c.in, (v) => apply(D.trimTrackClipStart(cut, sel.track, sel.i, v - c.in))));
                    row("Length", seconds(c.length, (v) => apply(D.trimTrackClipEnd(cut, sel.track, sel.i, v))));
                } else {
                    const i = sel.i, n = cut.clips.length;
                    row("In", seconds(c.in, (v) => apply(D.setClipIn(cut, i, v))));
                    row("Length", seconds(c.length, (v) => apply(D.trimEnd(cut, i, v))));
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
            const setLook = (patch) => apply(D.setTextLook(cut, i, patch));
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

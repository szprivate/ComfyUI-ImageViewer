// bEpicViewer_editPanels.js
// The Edit panel's two companions: the Inspector and Effects.
//
// Both are dock panels of their own (ids "editInspector" and "editEffects") and,
// like the Edit panel, are up only while a cut's tab is. They are drawn from the
// same place the timeline is (editTlRefresh -> editPanelsRefresh) and change the
// cut through the same functions (bEpicViewer_editTimelineData.js), so there is
// one cut and three views of it.
//
// INSPECTOR - what is selected, as numbers and words, in sections the way an
// editor's inspector has them: the clip (name, colour), its timing, its sound,
// its file. Everything shown is something the preview plays and the render
// writes; there is no row here that only looks like a control.
//
// EFFECTS - a toolbox: categories on the left, what is in one on the right.
// An item is dragged onto the timeline, or double-clicked to be applied at the
// selection / the playhead:
//
//   Video Transitions   Cross Dissolve, onto the join between two shots
//   Titles              Text, a text of the timeline (kept in it; drawn by
//                       whatever makes the film's titles, not by this render)
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
        { name: "Cut", note: "takes a dissolve away", fx: { type: "dissolve", seconds: 0 } },
    ] },
    { id: "titles", name: "Titles", items: [
        { name: "Text 2 s", note: "a text of the timeline", fx: { type: "text", text: "Text", seconds: 2 } },
        { name: "Text 5 s", note: "a text of the timeline", fx: { type: "text", text: "Text", seconds: 5 } },
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
        const section = (title) => parts.push(el("div", "insp-sec", title));
        const row = (label, control, wide) => {
            // (Not a <label>: a click on the word would press the first button in the row.)
            const r = el("div", "insp-row" + (wide ? " wide" : ""));
            r.append(el("span", "insp-label", label), control);
            parts.push(r);
            return control;
        };
        const quiet = (input) => { input.addEventListener("keydown", (e) => e.stopPropagation()); return input; };
        const seconds = (value, onChange, disabled) => {
            const input = quiet(el("input", "insp-num"));
            input.type = "number";
            input.step = "0.1";
            input.min = "0";
            input.value = String(Math.round(value * 1000) / 1000);
            input.disabled = !!disabled;
            input.title = "seconds";
            input.addEventListener("change", () => onChange(D.toFrame(Number(input.value), fps)));
            return input;
        };
        const words = (value, onChange) => {
            const input = quiet(el("input", "insp-text"));
            input.type = "text";
            input.value = value;
            input.addEventListener("change", () => onChange(input.value));
            return input;
        };
        const said = (text) => { const s = el("span", "insp-said", text); s.title = text; return s; };
        const button = (label, title, fn, disabled) => {
            const b = el("button", "edit-btn", label);
            b.title = title;
            b.disabled = !!disabled;
            b.addEventListener("click", fn);
            return b;
        };
        const apply = (next) => this._editTlApply(next);
        const sound = (clip, target) => {
            const wrap = el("span", "insp-slider");
            const input = el("input");
            input.type = "range";
            input.min = "0";
            input.max = "100";
            input.step = "1";
            const now = Math.round(Math.max(0, Math.min(1, clip.volume == null ? 1 : Number(clip.volume))) * 100);
            input.value = String(now);
            const read = el("span", "insp-read", now + " %");
            // While it is dragged only the readout and what is heard follow; the
            // cut is changed when it is let go, or the slider would be redrawn
            // under the pointer.
            input.addEventListener("input", () => {
                read.textContent = input.value + " %";
                if (this._editTlOnScreen() && this._videoMode && this.videoBase) {
                    try { this.videoBase.volume = Number(input.value) / 100; } catch (_) {}
                }
            });
            input.addEventListener("change", () => apply(D.setClipProps(cut, target, { volume: Number(input.value) / 100 })));
            wrap.append(input, read);
            return wrap;
        };

        if (!cut) {
            parts.push(el("div", "curves-empty", "No cut is open."));
        } else if (sel && (sel.kind === "clip" || sel.kind === "tclip") && D.clipOf(cut, sel)) {
            const c = D.clipOf(cut, sel);
            const placed = sel.kind === "tclip";
            const track = placed ? D.trackOf(cut, sel.track) : null;
            const isSound = !!track && track.kind === "audio";
            parts.push(el("div", "insp-title", (placed ? track.name : "V1") + " · " + (c.name || "clip")));
            section("Clip");
            row("Name", words(c.name || "", (v) => apply(D.setClipProps(cut, sel, { name: v }))), true);
            row("Colour", this._editTlSwatches(doc, c, (color) => apply(D.setClipProps(cut, sel, { color }))), true);
            section("Timing");
            if (placed) {
                row("Starts at", seconds(c.at, (v) => apply(D.moveTrackClip(cut, sel.track, sel.i, v))));
                row("In", seconds(c.in, (v) => apply(D.trimTrackClipStart(cut, sel.track, sel.i, v - c.in))));
                row("Length", seconds(c.length, (v) => apply(D.trimTrackClipEnd(cut, sel.track, sel.i, v))));
            } else {
                const i = sel.i, n = cut.clips.length;
                row("In", seconds(c.in, (v) => apply(D.setClipIn(cut, i, v))));
                row("Length", seconds(c.length, (v) => apply(D.trimEnd(cut, i, v))));
                row("Dissolve in", seconds(c.transition || 0, (v) => apply(D.setTransition(cut, i, v)), i === 0));
                const order = el("span", "insp-buttons");
                order.append(button("◀ Earlier", "Earlier in the order", () => this._editTlMove(i, i - 1), i === 0),
                             button("Later ▶", "Later in the order", () => this._editTlMove(i, i + 1), i === n - 1));
                row("Order", order, true);
            }
            if (!D.isStill(c.file) || isSound) {
                section("Audio");
                row("Volume", sound(c, sel), true);
            }
            section("File");
            row("Source", said(c.file || ""), true).classList.add("insp-path");
            const tail = el("div", "insp-foot");
            tail.append(button("Remove from the cut", "Take this clip out", () => this._editTlRemove(sel),
                               !placed && cut.clips.length <= 1));
            parts.push(tail);
        } else if (sel && sel.kind === "text" && cut.texts[sel.i]) {
            const i = sel.i, t = cut.texts[i];
            parts.push(el("div", "insp-title", "Text"));
            section("Text");
            const area = quiet(el("textarea", "insp-area"));
            area.value = String(t.text || "");
            area.rows = 3;
            area.addEventListener("change", () => apply(D.setText(cut, i, area.value)));
            row("Words", area, true);
            section("Timing");
            row("Starts at", seconds(t.start, (v) => apply(D.moveText(cut, i, v))));
            row("Length", seconds(t.length, (v) => apply(D.resizeText(cut, i, v))));
            parts.push(el("div", "insp-note", "A text is kept in the timeline. Its look belongs to what makes the "
                + "film's titles; this viewer's own render does not draw it."));
            const tail = el("div", "insp-foot");
            tail.append(button("Remove this text", "Take this text off the film", () => this._editTlRemove(sel)));
            parts.push(tail);
        } else {
            parts.push(el("div", "insp-title", "Timeline"));
            section("Cut");
            row("Name", said(cut.name || this._editTlFile || "new cut"), true);
            row("Length", said(D.lengthLabel(D.filmLength(cut)) + " · " + D.filmFrames(cut) + " frames"), true);
            row("Frame rate", said(String(Math.round(fps * 1000) / 1000) + " fps"), true);
            row("Shots", said(String(cut.clips.length)), true);
            const more = (cut.tracks || []).map((k) => `${k.name} (${k.clips.length})`).join(", ");
            row("Tracks", said("V1" + ((cut.sound || []).length ? ", A1" : "") + (more ? ", " + more : "")), true);
            parts.push(el("div", "insp-note", "Select a clip or a text on the timeline to change it here."));
        }
        body.replaceChildren(...parts);
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
            this._editTlSel = { kind: "clip", i };
            this._editTlApply(D.setTransition(cut, i, fx.seconds));
            return;
        }
        if (fx.type === "text") {
            const start = D.toFrame(at == null ? this._editTlNowSeconds() : at, fps);
            const next = D.addText(cut, fx.text, start, fx.seconds);
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

// bEpicViewer_editXfade.js
// Audio transitions in the Edit panel, as Resolve's: a crossfade at the cut of
// two sound clips (two films of V1, or two clips of a sound track) and the fade
// handles at a clip's two upper corners. The arithmetic is the data module's
// ("audio transitions and fades": xfadeFrom, addAudioXfade, setFade, audioEnv,
// envGain); this is the drawing and the pointer.
//
//   Shift+T               a crossfade at the selected cut, else at the cut nearest
//                         the playhead (the selected clip's track, else the tracks
//                         whose Auto Track Selector is on: V1, then the sound tracks)
//   the clip's menu       "Add audio crossfade at its start / end"
//   the crossfade's bar   its edges change its length (a centred one both sides at
//                         once), a click selects it - the Inspector has its length,
//                         curve and alignment; right-click: the same, and remove
//   Del                   takes the selected crossfade away
//   a fade handle         the small square at a sound clip's upper corner: dragged
//                         in, a fade in (or out) that long, drawn over the waveform
//
// A video dissolve (V1's Cross Dissolve) already crosses the two shots' own sound,
// so it adds no crossfade, and there is none where a dissolve is; a film whose
// sound was split onto a sound track has its crossfade there.
import * as D from "./bEpicViewer_editTimelineData.js";

const SVG = "http://www.w3.org/2000/svg";
// The fade handles are drawn only on rows at least this tall (and clips this wide).
const FADE_ROW_PX = 18;
const FADE_CLIP_PX = 24;

export const EditXfadeMixin = {

    /** The crossfade bars of row `track` ("V1" or a sound track's id). */
    _editTlXfadeBlocks(doc, track, lay) {
        const cut = this._editTlCut;
        if (!cut || !lay) return [];
        const sel = this._editTlSel;
        return D.xfadeBars(cut, lay.total).filter((x) => x.track === track).map((x) => {
            const b = doc.createElement("div");
            const on = !!sel && sel.kind === "xfade" && sel.track === x.track && sel.i === x.sel.i;
            b.className = "edit-xfade" + (on ? " sel" : "");
            b.style.left = x.left + "%";
            b.style.width = x.width + "%";
            b.title = x.title;
            b.dataset.key = "xf:" + x.track + ":" + x.sel.i;
            b.dataset.curve = x.curve;
            b.dataset.align = x.align;
            b.append(this._editTlXfadeArt(doc, x));
            b.addEventListener("pointerdown", (e) => this._editTlXfadeDown(e, b, x));
            b.addEventListener("pointermove", (e) => { if (!e.buttons) b.style.cursor = this._editTlZone(e, b) === "body" ? "pointer" : "ew-resize"; });
            b.addEventListener("contextmenu", (e) => this._editTlXfadeMenu(e, x));
            return b;
        });
    },

    // The two curves of a crossfade, in a box of 100 x 20: the sound going out falls, the one coming in rises.
    _editTlXfadeArt(doc, x) {
        const svg = doc.createElementNS(SVG, "svg");
        svg.setAttribute("viewBox", "0 0 100 20");
        svg.setAttribute("preserveAspectRatio", "none");
        svg.setAttribute("class", "edit-xfade-art");
        const line = (fn) => {
            const pts = [];
            for (let k = 0; k <= 20; k++) pts.push(`${k * 5},${(20 - 18 * fn(k / 20)).toFixed(2)}`);
            const p = doc.createElementNS(SVG, "polyline");
            p.setAttribute("points", pts.join(" "));
            return p;
        };
        const up = line((p) => D.curveGain(x.curve, p)), down = line((p) => D.curveGain(x.curve, 1 - p));
        up.setAttribute("class", "in");
        down.setAttribute("class", "out");
        svg.append(down, up);
        return svg;
    },

    _editTlXfadeDown(e, el, x) {
        if (e.button !== 0) return;
        const start = this._editTlCut;
        const fps = start.fps || 24;
        const zone = this._editTlZone(e, el);
        const clipSel = D.xfadeClipSel(x.sel);
        this._editTlSel = x.sel;
        this._editTlEditSel = null;
        this._editTlMulti = null;
        const dur = this._editTlDur ? this._editTlDur() : {};
        const k = x.align === "centre" ? 2 : 1;
        this._editTlDrag(e, el, (seconds) => {
            if (zone === "body") return;
            const len = Math.max(D.MIN_XFADE, D.toFrame(x.len + (zone === "end" ? seconds : -seconds) * k, fps));
            const got = D.addAudioXfade(start, clipSel, { len }, dur);
            if (got.cut) this._editTlCut = got.cut;
            this.editTlRefresh();
        }, (moved) => {
            if (!moved) this._editTlSeek(x.cutAt);
            this.editTlRefresh();
        });
    },

    _editTlXfadeMenu(e, x) {
        e.preventDefault();
        e.stopPropagation();
        this._editTlSel = x.sel;
        this.editTlRefresh();
        const cut = this._editTlCut;
        const set = (patch) => {
            const got = D.addAudioXfade(this._editTlCut, D.xfadeClipSel(x.sel), patch, this._editTlDur ? this._editTlDur() : {});
            if (got.error) this._editTlSay(got.error); else this._editTlApply(got.cut);
        };
        const mark = (on) => (on ? "✓ " : " ");
        this._previzOpenMenu([
            ...Object.entries(D.XF_CURVES).map(([v, label]) => ({ label: mark(x.curve === v) + label, run: () => set({ curve: v }) })),
            "-",
            ...Object.entries(D.XF_ALIGNS).map(([v, label]) => ({ label: mark(x.align === v) + label, run: () => set({ align: v }) })),
            "-",
            { label: "Remove this crossfade", run: () => { this._editTlSel = null; this._editTlApply(D.removeAudioXfade(cut, x.sel)); } },
        ], e.clientX, e.clientY);
    },

    /** A crossfade at the cut into clip `sel` (one undo step); says why where there can be none. */
    editTlAddAudioXfade(sel) {
        const cut = this._editTlCut;
        if (!cut || !sel) return false;
        const got = D.addAudioXfade(cut, sel, {}, this._editTlDur ? this._editTlDur() : {});
        if (got.error) { this._editTlSay(got.error); return false; }
        const locked = D.lockViolation(cut, got.cut);
        if (locked) { this._editTlSay(`${locked} is locked`); return false; }
        this._editTlSel = got.sel;
        this._editTlEditSel = null;
        this._editTlMulti = null;
        this._editTlApply(got.cut);
        if (got.fitted) this._editTlSay("not enough media beyond the cut: the crossfade is as long as the media allows");
        return true;
    },

    /** The clip a crossfade added now comes into: the selected cut, else the cut nearest the playhead. */
    _editTlXfadeTarget() {
        const cut = this._editTlCut;
        if (!cut) return null;
        const t = (this.currentFrame || 0) / (cut.fps || 24);
        const point = this._editTlEditPoint ? this._editTlEditPoint() : null;
        if (point) {
            if (point.b && D.xfadeFrom(cut, point.b)) return point.b;
            if (point.side === "end") return D.xfadeInto(cut, point.sel);
            if (D.xfadeFrom(cut, point.sel)) return point.sel;
        }
        const sel = this._editTlSel;
        if (sel && (sel.kind === "clip" || sel.kind === "tclip")) {
            // The selected clip: the cut at its start or its end, whichever is nearer the playhead.
            const c = D.clipOf(cut, sel);
            const at = sel.kind === "clip" ? D.clipStarts(cut)[sel.i] : Number(c.at) || 0;
            const options = [[sel, at], [D.xfadeInto(cut, sel), at + (Number(c.length) || 0)]]
                .filter(([s]) => s && D.xfadeFrom(cut, s)).sort((p, q) => Math.abs(p[1] - t) - Math.abs(q[1] - t));
            if (options.length) return options[0][0];
        }
        const mask = D.editMask(cut);
        const tracks = ["V1", ...(cut.tracks || []).filter((k) => k.kind === "audio").map((k) => k.id)].filter((id) => mask.has(id));
        let best = null, gap = Infinity;
        for (const id of tracks) {
            const s = D.xfadeCutNear(cut, id, t);
            if (!s) continue;
            const at = s.kind === "clip" ? D.clipStarts(cut)[s.i] : Number(D.clipOf(cut, s).at) || 0;
            if (Math.abs(at - t) < gap - 1e-6) { best = s; gap = Math.abs(at - t); }
        }
        return best;
    },

    /** Shift+T: Resolve's "add audio transition". */
    editTlAudioXfadeKey() {
        const target = this._editTlXfadeTarget();
        if (!target) { this._editTlSay("no cut of two sounds here for a crossfade"); return false; }
        return this.editTlAddAudioXfade(target);
    },

    /** The clip menu's entries for its sound's crossfades. */
    _editTlXfadeEntries(sel) {
        const cut = this._editTlCut;
        const c = D.clipOf(cut, sel);
        if (!c) return [];
        const out = [];
        const into = D.xfadeInto(cut, sel);
        if (D.xfadeFrom(cut, sel) && !c.xfade) out.push({ label: "Add audio crossfade at its start (Shift+T)", run: () => this.editTlAddAudioXfade(sel) });
        if (into && !D.clipOf(cut, into).xfade) out.push({ label: "Add audio crossfade at its end (Shift+T)", run: () => this.editTlAddAudioXfade(into) });
        return out;
    },

    /**
     * A sound clip's fade handles and their curves, on its block `b`: `sel` the
     * clip ({ kind: "sound", i } for the bed), `length` its seconds, `height` its row's.
     */
    _editTlFadeHandles(b, sel, length, height) {
        const cut = this._editTlCut;
        if (!cut || !(length > 0) || height < FADE_ROW_PX) return;
        const env = D.audioEnv(cut, sel);
        if (!env) return;
        const doc = b.ownerDocument;
        const share = (s) => Math.max(0, Math.min(100, (s / length) * 100));
        // The faded part: a shade above the line the gain follows (drawn whatever the width).
        if (env.fi > 0 || env.fo > 0) {
            const svg = doc.createElementNS(SVG, "svg");
            svg.setAttribute("viewBox", "0 0 100 100");
            svg.setAttribute("preserveAspectRatio", "none");
            svg.setAttribute("class", "edit-fadecurve");
            const shade = (d) => { const p = doc.createElementNS(SVG, "path"); p.setAttribute("d", d); svg.append(p); };
            if (env.fi > 0) shade(`M0,0 L${share(env.fi)},0 L0,100 Z`);
            if (env.fo > 0) shade(`M100,0 L${100 - share(env.fo)},0 L100,100 Z`);
            b.append(svg);
        }
        b.dataset.fadeIn = String(env.fi || 0);
        b.dataset.fadeOut = String(env.fo || 0);
        const box = b.style.width ? parseFloat(b.style.width) : 0;
        const wide = this._editTlUi && this._editTlUi.area ? this._editTlUi.area.getBoundingClientRect().width * box / 100 : 100;
        if (wide < FADE_CLIP_PX) return;
        for (const which of ["in", "out"]) {
            if ((which === "in" && env.xin) || (which === "out" && env.xout)) continue;   // a crossfade is there
            const h = doc.createElement("div");
            h.className = "edit-fadeh " + which;
            const v = which === "in" ? env.fi : env.fo;
            if (which === "in") h.style.left = `calc(${share(v)}% - 3px)`; else h.style.right = `calc(${share(v)}% - 3px)`;
            h.title = (which === "in" ? "Fade in" : "Fade out") + (v > 0 ? `: ${D.lengthLabel(v)}` : "") + " - drag along the clip";
            h.addEventListener("pointerdown", (e) => this._editTlFadeDown(e, h, sel, which, v, length));
            b.append(h);
        }
    },

    _editTlFadeDown(e, h, sel, which, was, length) {
        if (e.button !== 0) return;
        e.stopPropagation();
        const start = this._editTlCut;
        const fps = start.fps || 24;
        if (sel.kind !== "sound") { this._editTlSel = sel; this._editTlEditSel = null; }
        this._editTlDrag(e, h, (seconds) => {
            const v = Math.max(0, Math.min(length, D.toFrame(was + (which === "in" ? seconds : -seconds), fps)));
            this._editTlCut = D.setFade(start, sel, which, v);
            this._editTlNote = (which === "in" ? "fade in " : "fade out ") + D.lengthLabel(v);
            this.editTlRefresh();
        }, () => this.editTlRefresh());
    },
};

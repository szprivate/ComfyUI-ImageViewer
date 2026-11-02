// bEpicViewer_editTrim.js
// Trimming in the Edit panel the way an editor trims, and the in / out of the
// range played. A mixin onto the panel (bEpicViewer_editTimeline.js), with its
// arithmetic in bEpicViewer_editTimelineData.js.
//
// What a press on a clip does depends on the MODE (as in Resolve: A the
// Selection mode, the default; T the Trim Edit mode; B the blade), on where it
// lands and on what is held - and the pointer says so before the press: its
// cursor, a lit side, a timecode.
//
// Selection mode (A):
//   an edge                trim that side: left of a cut the outgoing shot's
//                          OUT, right of it the incoming shot's IN (the side
//                          that will move is lit). Nothing else moves: a gap
//                          opens, or one is filled (never into a neighbour).
//                          Never past the source's ends; a still has none, so
//                          it grows as far as it is pulled.
//   the middle of a cut    ROLL (ROLL_PX either side of the join of two clips
//                          that touch): the cut moves, the shot before ends
//                          later as the one after begins later in its source
//   the body               move it: on V1 it lies over what is at its new place
//                          (an overwrite) and leaves a gap; Ctrl+Shift+drag puts
//                          it into the order instead (an insert, what follows
//                          moves up)
// Trim Edit mode (T), by the zone of the clip:
//   an edge                RIPPLE trim: the clips after it on its track (and on
//                          the track of its linked sound or picture) move with it
//   the middle of a cut    ROLL
//   the body, upper half   SLIP (the filmstrip)
//   the body, lower half   SLIDE (the name bar): the clip moves, its neighbours
//                          (or the gaps beside it) give and take
// In both modes:
//   a click on an edge     selects that edit point, green on what will move: the
//                          outgoing edge, the incoming edge, or (the middle of a cut)
//                          both, a roll. , / . trim it a frame (Shift: a second) -
//                          rippling in the Trim mode, a gap opening or closing in
//                          Selection; E extends it to the playhead; Shift+A / Shift+S
//                          go on to the edit before / after; Esc lets it go
//   Alt + an edge          RETIME ("trim to fill"): the source in and out stay,
//                          the speed changes to fill the new length
//   Ctrl + the out-edge    LOOP EXTEND: longer than the source, by playing it
//                          again (Ctrl+L one more turn, Ctrl+Shift+L ping-pong)
//   Alt + the body         SLIP: same place, same length, another part of the
//                          source (the picture follows the pointer)
//   Alt+Shift + the body   SLIDE (V1): the shot keeps its source and length and
//                          moves along the film; its neighbours give and take
//   the body               move (V1: reorder; a placed clip: to another moment,
//                          its length kept)
//   a dissolve's bar       its edges: longer / shorter; its body: roll the cut under it
//
// The Trim mode's TWO-UP (bEpicViewer_editTwoUp.js): while an edit is trimmed,
// rolled, slipped or slid - dragged, or nudged with , / . - the viewer shows the
// outgoing clip's last frame and the incoming clip's first side by side (a slip:
// its new first and last), following the edit; put away on release, or a moment
// after the last nudge, or on leaving the Trim mode.
//
// Each drag, key or field is one step of the undo stack.
//
// IN AND OUT are the transport's own range (`playbackRange`, frames, both
// shown), kept per cut (`view.range`) because switching tabs clears it. On the
// ruler: a band with a handle at each end (drag them; they snap to the edit
// points and the playhead), Ctrl+drag draws a new range, right-click sets the in
// or out there or clears both. Loop playback, the transport's own bar, "Export
// film" (in-out only), Auto edit and Detect cuts all use it.
import * as D from "./bEpicViewer_editTimelineData.js";

const EDGE_PX = 7;
const ROLL_PX = 3;

// Cursors drawn as an editor's: a bracket on the side that moves. 15 px on a grid
// of their own - half-pixel coordinates, so that a 1 px stroke falls on whole pixels and stays sharp.
function cursor(paths, color, fallback) {
    const g = (stroke, w) => `<g fill='none' stroke='${stroke}' stroke-width='${w}' stroke-linecap='square' stroke-linejoin='miter'>`
        + paths.map((d) => `<path d='${d}'/>`).join("") + "</g>";
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='15' height='15' viewBox='0 0 15 15'>${g("#000", 2.6)}${g(color, 1)}</svg>`;
    return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") 7 7, ${fallback}`;
}
const LEFT = "M4.5 5.5l-2 2 2 2", RIGHT = "M10.5 5.5l2 2-2 2";
export const TRIM_CURSORS = {
    // A ripple: the bracket of a trim and a bar for what moves with it.
    "ripple-out": cursor(["M8.5 2.5h2v10h-2", "M1.5 7.5h5", "M3.5 5.5l-2 2 2 2", "M4.5 5.5l2 2-2 2", "M13.5 4.5v6"], "#ffe14d", "w-resize"),
    "ripple-in": cursor(["M6.5 2.5h-2v10h2", "M8.5 7.5h5", "M11.5 5.5l2 2-2 2", "M10.5 5.5l-2 2 2 2", "M1.5 4.5v6"], "#ffe14d", "e-resize"),
    "trim-out": cursor(["M8.5 2.5h2v10h-2", "M1.5 7.5h5", "M3.5 5.5l-2 2 2 2", "M4.5 5.5l2 2-2 2"], "#9dff7a", "w-resize"),
    "trim-in": cursor(["M6.5 2.5h-2v10h2", "M8.5 7.5h5", "M11.5 5.5l2 2-2 2", "M10.5 5.5l-2 2 2 2"], "#9dff7a", "e-resize"),
    "roll": cursor(["M6.5 2.5v10", "M8.5 2.5v10", "M1.5 7.5h3", "M10.5 7.5h3", LEFT.replace("4.5 5.5", "3.5 5.5"), RIGHT.replace("10.5 5.5", "11.5 5.5")], "#ffd84d", "col-resize"),
    "retime": cursor(["M7.5 2.5v10", LEFT, RIGHT, "M5.5 7.5h4"], "#ff9a3c", "ew-resize"),
    "loop": cursor(["M4.5 5.5h5a2.5 2.5 0 0 1 0 5h-1", "M6.5 3.5l-2 2 2 2", "M1.5 2.5v10"], "#4de1ff", "ew-resize"),
    "slip": cursor(["M4.5 2.5h-2v10h2", "M10.5 2.5h2v10h-2", "M5.5 7.5h4", "M6.5 6.5l-1 1 1 1", "M8.5 6.5l1 1-1 1"], "#c9a6ff", "ew-resize"),
    "slide": cursor(["M1.5 3.5v8", "M13.5 3.5v8", "M4.5 7.5h6", LEFT.replace("4.5 5.5", "5.5 5.5"), RIGHT.replace("10.5 5.5", "9.5 5.5")], "#c9a6ff", "move"),
};
// The selected edit point, as Resolve marks it.
const EDIT_GREEN = "#35e06f";
const ACT_COLOR = { "trim-out": "#9dff7a", "trim-in": "#9dff7a", "ripple-out": "#ffe14d", "ripple-in": "#ffe14d", roll: "#ffd84d",
                    retime: "#ff9a3c", loop: "#4de1ff", slip: "#c9a6ff", slide: "#c9a6ff" };

export const EditTrimMixin = {

    /** { file: seconds } of the files whose length is known (read by /bepic/timeline_probe). */
    _editTlDur() {
        const out = {};
        if (this._editTlInfo) for (const [p, info] of this._editTlInfo) if (info && info.duration > 0) out[p] = info.duration;
        return out;
    },

    // The lengths of the cut's files are asked for once, in the background, so
    // that a trim knows where a source ends.
    _editTlKnowFiles(cut) {
        const files = new Set();
        for (const c of (cut && cut.clips) || []) if (c.file && !D.isStillImage(c.file)) files.add(c.file);
        for (const k of (cut && cut.tracks) || []) for (const c of k.clips || []) if (c.file && !D.isStillImage(c.file)) files.add(c.file);
        if (!this._editTlAsked) this._editTlAsked = new Set();
        const want = [...files].filter((f) => !this._editTlAsked.has(f) && !(this._editTlInfo && this._editTlInfo.has(f)));
        if (!want.length || !this._editTlProbe) return;
        for (const f of want) this._editTlAsked.add(f);
        this._editTlProbe(want).catch(() => {});
    },

    // ── what a press would do ────────────────────────────────────────────────

    /**
     * What a press at the pointer on clip block `el` (selection `sel`) would do:
     * { act, sel, side, join, a, b } - act is "trim-out", "trim-in", "ripple-out",
     * "ripple-in", "roll", "retime", "loop", "slip", "slide" or "move". A roll
     * names the two clips of its cut: `a` (ending there) and `b` (beginning
     * there); on V1 `join` is b's index too.
     */
    _editTlEdgeAct(e, el, sel) {
        const box = el.getBoundingClientRect();
        const edge = Math.min(EDGE_PX, box.width / 3);
        const x = e.clientX;
        const zone = x - box.left <= edge ? "start" : (box.right - x <= edge ? "end" : "body");
        const alt = !!e.altKey, ctrl = !!(e.ctrlKey || e.metaKey), shift = !!e.shiftKey;
        const trim = !!this._editTlTrimMode;
        if (zone === "body") {
            if (alt && shift) return { act: "slide", sel };
            if (alt) return { act: "slip", sel };
            // The Trim mode: the filmstrip (upper half) slips, the name bar (lower half) slides.
            if (trim && !ctrl && !shift) return { act: e.clientY - box.top < box.height / 2 ? "slip" : "slide", sel };
            return { act: "move", sel };
        }
        if (alt) return { act: "retime", sel, side: zone };
        if (ctrl && zone === "end") return { act: "loop", sel, side: "end" };
        const near = zone === "end" ? box.right - x : x - box.left;
        const pair = near <= ROLL_PX ? this._editTlCutPair(sel, zone) : null;
        if (pair) return { act: "roll", sel, side: zone, ...pair };
        const ripple = trim ? "ripple-" : "trim-";
        return { act: ripple + (zone === "end" ? "out" : "in"), sel, side: zone };
    },

    /** The cut at a clip's edge, where another clip touches it there: { a, b, join } - or null (a gap, a dissolve, nothing). */
    _editTlCutPair(sel, zone) {
        const cut = this._editTlCut;
        if (sel.kind === "clip") {
            const join = zone === "end" ? sel.i + 1 : sel.i;
            const b = cut.clips[join];
            if (!(join >= 1) || !b || Number(b.transition) > 0 || Number(b.gap) > 0) return null;
            return { join, a: { kind: "clip", i: join - 1 }, b: { kind: "clip", i: join } };
        }
        const t = D.touching(cut, sel.track, sel.i);
        if (zone === "end" && t.after >= 0) return { a: sel, b: { kind: "tclip", track: sel.track, i: t.after } };
        if (zone === "start" && t.before >= 0) return { a: { kind: "tclip", track: sel.track, i: t.before }, b: sel };
        return null;
    },

    /** The pointer moves over a clip: the cursor, the lit side and the timecode of what a press would do. */
    _editTlHover(e, el, sel) {
        if (e.buttons || this._editTlDragging || this._editTlBlade) return;
        const info = this._editTlEdgeAct(e, el, sel);
        const want = TRIM_CURSORS[info.act] || "";
        if (el.style.cursor !== want) el.style.cursor = want;
        this._editTlHoverAct = info.act === "move" ? null : info;
        this._editTlTrimShow(info.act === "move" ? null : info, e.clientX);
    },

    _editTlHoverEnd() {
        if (this._editTlDragging) return;
        this._editTlHoverAct = null;
        this._editTlTrimShow(null);
    },

    // Where a clip lies now: { start, length, row (its element) }.
    _editTlPlace(cut, sel) {
        const ui = this._editTlUi;
        const c = D.clipOf(cut, sel);
        if (!ui || !c) return null;
        const start = sel.kind === "clip" ? D.clipStarts(cut)[sel.i] : Number(c.at) || 0;
        const row = ui.rows.querySelector(`.edit-track[data-track="${sel.kind === "clip" ? "V1" : sel.track}"]`);
        return { start, length: Number(c.length) || 0, row, clip: c };
    },

    /**
     * Light the side a press will move, and say where it is: `info` from
     * _editTlEdgeAct (null puts it all away). `drag`: { start (the cut at the
     * press), delta (seconds) } while one goes on.
     */
    _editTlTrimShow(info, clientX, drag) {
        const ui = this._editTlUi;
        const lay = this._editTlLay;
        if (!ui) return;
        const doc = ui.area.ownerDocument;
        const need = (key, cls) => {
            if (!ui[key] || !ui[key].isConnected) { ui[key] = doc.createElement("div"); ui[key].className = cls; ui.area.append(ui[key]); }
            return ui[key];
        };
        const hide = () => { for (const k of ["trimA", "trimB", "trimTip", "slipBand"]) if (ui[k]) ui[k].style.display = "none"; };
        if (!info || !lay || !(lay.total > 0)) { hide(); return; }
        const cut = this._editTlCut;
        const fps = cut.fps || 24;
        const total = lay.total;
        const a = ui.area.getBoundingClientRect();
        const pct = (t) => Math.max(0, Math.min(100, (t / total) * 100)) + "%";
        const light = (key, sel, side, color) => {
            const p = this._editTlPlace(cut, sel);
            const el = need(key, "edit-trimhl");
            if (!p || !p.row) { el.style.display = "none"; return null; }
            const r = p.row.getBoundingClientRect();
            el.style.display = "block";
            el.style.top = (r.top - a.top) + "px";
            el.style.height = r.height + "px";
            el.style.left = pct(p.start);
            el.style.width = pct(p.length);
            el.dataset.side = side;
            el.style.setProperty("--trim", color);
            return p;
        };
        const tc = (t) => D.timecode(t, fps);
        const name = (c) => (c && (c.name || String(c.file || "").split(/[\\/]/).pop())) || "clip";
        const color = ACT_COLOR[info.act] || "#9dff7a";
        let lines = [];
        let row = null;
        if (ui.trimB) ui.trimB.style.display = "none";
        if (ui.slipBand) ui.slipBand.style.display = "none";
        const sel = info.sel;
        const c = D.clipOf(cut, sel);
        if (!c) { hide(); return; }
        if (info.act === "roll") {
            const p = light("trimA", info.a, "end", color);
            const q = light("trimB", info.b, "start", color);
            row = p && p.row;
            const at = q ? q.start : 0;
            lines = [`Roll ${name(D.clipOf(cut, info.a))} | ${name(D.clipOf(cut, info.b))}`, tc(at)];
        } else {
            const side = info.act === "trim-in" || info.act === "ripple-in" || (info.act === "retime" && info.side === "start") ? "start"
                : (info.act === "slip" || info.act === "slide") ? "body" : "end";
            const p = light("trimA", sel, side, color);
            row = p && p.row;
            const start = p ? p.start : 0, len = p ? p.length : 0;
            const srcIn = Number(c.in) || 0, still = D.isStillImage(c.file);
            const srcOut = srcIn + D.srcUse(c);
            if (info.act === "trim-out") lines = [`Out of ${name(c)}`, tc(start + len) + (still ? "" : ` · src ${tc(srcOut)}`)];
            else if (info.act === "trim-in") lines = [`In of ${name(c)}`, tc(start) + (still ? "" : ` · src ${tc(srcIn)}`)];
            else if (info.act === "ripple-out") lines = [`Ripple out of ${name(c)}`, tc(start + len) + (still ? "" : ` · src ${tc(srcOut)}`)];
            else if (info.act === "ripple-in") lines = [`Ripple in of ${name(c)}`, tc(start) + (still ? "" : ` · src ${tc(srcIn)}`)];
            else if (info.act === "retime") lines = [`Retime ${name(c)} (Alt)`, `${Math.round(D.speedOf(c) * 100)} % · ${D.lengthLabel(len)}`];
            else if (info.act === "loop") {
                const turns = D.loopOf(c) ? len * D.speedOf(c) / Number(c.span) : 1;
                lines = [`Loop extend ${name(c)} (Ctrl)`, still ? D.lengthLabel(len) : `${Math.round(turns * 100) / 100} turns · ${D.lengthLabel(len)}`];
            } else if (info.act === "slip") {
                lines = [`Slip ${name(c)}${this._editTlTrimMode ? "" : " (Alt)"}`, still ? "a still has no source to slip" : `src ${tc(srcIn)} – ${tc(srcOut)}`];
                // The whole source, at the timeline's scale, behind the clip: where it can slip to.
                const dur = this._editTlDur()[c.file];
                if (!still && p && p.row) {
                    const band = need("slipBand", "edit-slipband");
                    const sp = D.speedOf(c);
                    const from = start - srcIn / sp, to = dur > 0 ? start + (dur - srcIn) / sp : start + len * 4;
                    const r = p.row.getBoundingClientRect();
                    band.style.display = "block";
                    band.style.top = (r.top - a.top) + "px";
                    band.style.height = r.height + "px";
                    band.style.left = pct(from);
                    band.style.width = `calc(${pct(Math.min(total, to))} - ${pct(Math.max(0, from))})`;
                    band.classList.toggle("open", !(dur > 0));
                }
            } else if (info.act === "slide") {
                lines = [`Slide ${name(c)}${this._editTlTrimMode ? "" : " (Alt+Shift)"}`, `${tc(start)} – ${tc(start + len)}`];
            }
        }
        if (drag) {
            const f = Math.round((Number(drag.delta) || 0) * fps);
            // A slip says how far its SOURCE moved; everything else how far its edge (or the clip) did.
            lines[0] += `  ${info.act === "slip" ? "src " : ""}${f >= 0 ? "+" : "−"}${Math.abs(f)}f`;
            if (drag.held) lines.push(drag.held);
        }
        const tip = need("trimTip", "edit-trimtip");
        tip.replaceChildren(...lines.map((t, k) => { const s = doc.createElement(k ? "div" : "b"); s.textContent = t; return s; }));
        tip.style.display = "block";
        const r = row ? row.getBoundingClientRect() : a;
        const x = clientX == null ? a.left : clientX;
        tip.style.left = Math.max(0, Math.min(a.width - 10, x - a.left + 12)) + "px";
        tip.style.top = Math.max(0, r.top - a.top - 30) + "px";
        tip.style.setProperty("--trim", color);
    },

    // ── the drags ────────────────────────────────────────────────────────────

    /**
     * What an edit `info` comes to, `d` seconds (of the film; a slip's of its
     * source) from the cut `start`: the new cut, with a linked partner following.
     */
    _editTlTrimCompute(info, start, d) {
        const dur = this._editTlDur();
        const sel = info.sel, i = sel.i;
        const c0 = D.clipOf(start, sel);
        if (!c0) return start;
        const len0 = Number(c0.length) || 0;
        const v1 = sel.kind === "clip";
        let next = start;
        switch (info.act) {
            case "trim-out":
                next = v1 ? D.liftTrimEnd(start, i, len0 + d, dur)
                          : D.trimTrackClipEnd(start, sel.track, i, len0 + d, dur);
                break;
            case "trim-in": next = v1 ? D.liftTrimStart(start, i, d) : D.trimTrackClipStart(start, sel.track, i, d); break;
            case "ripple-out":
                next = v1 ? D.trimEnd(start, i, len0 + d, dur)
                          : D.rippleTrackEnd(start, sel.track, i, len0 + d, dur);
                break;
            case "ripple-in": next = v1 ? D.trimStart(start, i, d) : D.rippleTrackStart(start, sel.track, i, d); break;
            case "roll":
                next = info.a.kind === "clip" ? D.rollEdit(start, info.b.i, d, dur) : D.rollTrack(start, info.a.track, info.a.i, info.b.i, d, dur);
                next = D.followLink(start, next, info.a);
                return D.followLink(start, next, info.b);
            case "retime":
                next = D.retimeClip(start, sel, info.side === "start" ? len0 - d : len0 + d, info.side === "start");
                break;
            case "loop": next = D.loopExtend(start, sel, len0 + d, null, dur); break;
            case "slip": next = D.slipClip(start, sel, -d * D.speedOf(c0), dur); break;         // the picture follows the pointer
            case "slide": next = (v1 ? D.slideClip(start, i, d, dur) : D.slideTrackClip(start, sel.track, i, d, dur)) || start; break;
        }
        return D.followLink(start, next, sel, { ripple: info.act.startsWith("ripple") });
    },

    /**
     * Where the moving edit point of `info` lies in the film after `d` - what is
     * snapped - and back: { at(d), back(t) }. Null for an edit with no point to snap (a slip).
     */
    _editTlTrimPoint(info, start) {
        const p = this._editTlPlace(start, info.sel);
        if (!p || info.act === "slip") return null;
        const began = p.start, end = p.start + p.length;
        if (info.act === "roll") { const q = this._editTlPlace(start, info.b); return { t0: q.start, sign: 1 }; }
        if (info.act === "ripple-in") return { t0: end, sign: -1 };               // the clip's start stays: its end moves
        if (info.act === "retime" && info.side === "start" && info.sel.kind === "clip") return { t0: end, sign: -1 };
        if (info.side === "start" || info.act === "trim-in") return { t0: began, sign: 1 };
        if (info.act === "slide") return { t0: began, sign: 1, span: p.length };
        return { t0: end, sign: 1 };
    },

    /** The clips whose edges an edit of `info` must not snap to: itself, its partner, what moves with it. */
    _editTlTrimExclude(info, start) {
        const out = D.snapExclude(start, info.sel);
        if (info.a) out.push(D.selId(info.a), D.selId(info.b));
        if (info.act.startsWith("ripple") || info.act === "slide") {
            const p = this._editTlPlace(start, info.sel);
            const tid = info.sel.kind === "clip" ? "V1" : info.sel.track;
            const list = info.sel.kind === "clip" ? start.clips.map((c, j) => [j, D.clipStarts(start)[j]])
                : D.trackOf(start, tid).clips.map((c, j) => [j, Number(c.at) || 0]);
            for (const [j, at] of list) if (p && at >= p.start - 1e-6) out.push(tid + ":" + j, "gap:" + j);
            if (info.act === "slide" && info.sel.kind === "clip") out.push(tid + ":" + (info.sel.i - 1), "gap:" + info.sel.i, "gap:" + (info.sel.i + 1));
        }
        return out;
    },

    /**
     * A press on a clip (after the blade has had its say): the trims, ripples,
     * roll, retime, loop, slip and slide are done here. False for a plain move,
     * which the panel does itself.
     */
    _editTlTrimDown(e, el, sel) {
        if (e.button !== 0) return false;
        const info = this._editTlEdgeAct(e, el, sel);
        if (info.act === "move") return false;
        const start = this._editTlCut;
        const fps = start.fps || 24;
        const c0 = D.clipOf(start, sel);
        if (!c0) return false;
        if (info.act === "slip" && D.isStillImage(c0.file)) {
            e.preventDefault(); e.stopPropagation();
            this._editTlSel = sel;
            this._editTlSay("a still has no source to slip - drag its edges to make it longer");
            return true;
        }
        if (info.act === "slide" && (sel.kind === "clip" ? !D.slideClip(start, sel.i, 0) : !D.slideTrackClip(start, sel.track, sel.i, 0))) {
            e.preventDefault(); e.stopPropagation();
            this._editTlSel = sel;
            this._editTlSay("a slide needs a shot or a gap on each side - this one is at an end of the cut");
            return true;
        }
        this._editTlSel = sel;
        this._editTlEditSel = null;
        const place = this._editTlPlace(start, sel);
        const began = place ? place.start : 0;
        const len0 = Number(c0.length) || 0;
        // The moving edit point snaps to the targets (bEpicViewer_editTimeline.js: _editTlSnapAt).
        const point = this._editTlTrimPoint(info, start);
        const exclude = this._editTlTrimExclude(info, start);
        const sp = D.speedOf(c0);
        this._editTlDrag(e, el, (seconds, ev) => {
            let d = D.toFrame(seconds, fps);
            if (point) {
                // The EDGE lands on a frame (not the distance, which from an edge off the grid would miss it).
                const raw = point.t0 + point.sign * seconds;
                const landed = point.span ? this._editTlSnapSpanAt(raw, point.span, exclude) : D.toFrame(this._editTlSnapAt(raw, exclude), fps);
                d = (landed - point.t0) * point.sign;
            }
            const next = this._editTlTrimCompute(info, start, d);
            this._editTlCut = next;
            this.editTlRefresh();
            // What it came to - and whether something held it (the source's end, a neighbour, the speed's limits).
            const now = this._editTlPlace(next, sel) || { start: began, length: len0 };
            const c1 = D.clipOf(next, sel) || c0;
            const fromStart = info.side === "start";
            const got = info.act === "slip" ? (Number(c1.in) || 0) - (Number(c0.in) || 0)
                : info.act === "roll" ? this._editTlPlace(next, info.b).start - this._editTlPlace(start, info.b).start
                : info.act === "slide" ? now.start - began
                : fromStart ? (info.act === "ripple-in" || (sel.kind === "clip" && info.act === "retime") ? len0 - now.length : now.start - began)
                : now.length - len0;
            const held = Math.abs(got - (info.act === "slip" ? -d * sp : d)) > 0.5 / fps
                ? "held: " + (info.act === "retime" ? "the speed's limit (10 % to 1000 %)"
                    : info.act === "slip" ? "the end of the source"
                    : info.act === "trim-out" || info.act === "trim-in" ? "the end of the source, a shot's shortest, or the next clip"
                    : "the end of the source, or a shot's shortest")
                : "";
            this._editTlTrimShow(info, ev.clientX, { delta: got, held });
            // The Trim mode: the viewer shows the two frames of the edit as it moves (bEpicViewer_editTwoUp.js).
            if (this._editTlTrimMode && this.editTwoUpShow) this.editTwoUpShow(info, next);
        }, (moved) => {
            this._editTlTrimShow(null);
            this._etuDrag = false;
            if (this.editTwoUpHide) this.editTwoUpHide();
            if (!moved) {
                // A click on an edge, in every mode, selects that edit point (, . trim it; E extends it).
                if (info.act !== "slip" && info.act !== "slide" && info.act !== "retime" && info.act !== "loop") {
                    this._editTlEditSel = info;
                    this._editTlSeek(this._editTlEditTime(info, start));
                } else this._editTlSeek(began);
            }
            this.editTlRefresh();
            if (this.editTwoUpRest) this.editTwoUpRest();            // still on a cut: the view stays
        });
        this._etuDrag = true;
        if (this._editTlTrimMode && this.editTwoUpShow) this.editTwoUpShow(info, start);
        return true;
    },

    /** The edit point selected, while it still names a clip of the cut. */
    _editTlEditPoint() {
        const info = this._editTlEditSel;
        const cut = this._editTlCut;
        if (!info || !cut || !D.clipOf(cut, info.sel) || (info.a && !(D.clipOf(cut, info.a) && D.clipOf(cut, info.b)))) return null;
        return info;
    },

    /** The moment an edit point lies at: the cut of a roll, else its clip's edge. */
    _editTlEditTime(info, cut) {
        if (info.act === "roll") return D.selSpan(cut, info.b).start;
        const span = D.selSpan(cut, info.sel);
        return info.side === "end" ? span.end : span.start;
    },

    /** The selected edit point as what moving it does in the mode that is on. */
    _editTlEditLive(info) {
        return { ...info, act: D.pointAct(info, !!this._editTlTrimMode) };
    },

    /** , and . with an edit point selected: it trims a frame (Shift: a second) as a drag would, never snapped; the playhead stays on it. */
    editTlNudgeEdit(frames) {
        const info = this._editTlEditPoint();
        if (!info) return false;
        const cut = this._editTlCut, fps = cut.fps || 24;
        const live = this._editTlEditLive(info);
        const before = this._editTlEditTime(info, cut);
        const on = this._editTlOnScreen() && Math.abs((this.currentFrame || 0) - Math.round(before * fps)) <= 1;
        const next = this._editTlTrimCompute(live, cut, frames / fps);
        if (D.sameCut(next, cut)) { this._editTlSay("held: the source ends there, a clip is as short as it gets, or the next clip is there"); return true; }
        this._editTlApply(next);
        const after = this._editTlEditTime(info, next);
        // Playing around the edit, the loop follows the cut (_editPlayRange) and the film plays on: neither the
        // playhead nor the two-up is touched then. Stopped, the playhead stays on the cut and the two-up shows it.
        if (on && !this.isPlaying) this._editTlGoFrame(Math.round(after * fps));
        if (this._editTlTrimMode && this.editTwoUpPulse && !this.isPlaying) this.editTwoUpPulse(live, next);
        this._editTlSay(`${live.act.replace("-", " ")}: ${frames >= 0 ? "+" : "\u2212"}${Math.abs(frames)}f \u00b7 ${D.timecode(after, fps)}`);
        return true;
    },

    /**
     * Shift+S / Shift+A: through the cuts of a track in three steps each, as
     * Resolve's edit selection - forwards LEFT (the outgoing clip's out), BOTH (a
     * roll), RIGHT (the incoming clip's in), then the next cut's LEFT; backwards the
     * other way round (D.editSteps / D.nextEditStep). The playhead goes to the cut,
     * the side is marked green, and , / . trim exactly that (both: roll). On the
     * track of the edit point or clip selected, else V1.
     */
    editTlEditStep(dir) {
        const cut = this._editTlCut;
        if (!cut || !this._editTlTransport()) return;
        const point = this._editTlEditPoint();
        const on = point ? point.sel : this._editTlSel;
        const track = on && on.kind === "tclip" ? on.track : "V1";
        const fps = cut.fps || 24;
        const step = D.nextEditStep(D.editSteps(D.editStops(cut, track)), point, this.currentFrame || 0, dir, fps);
        if (!step) { this._editTlSay(dir < 0 ? "no edit before this one" : "no edit after this one"); return; }
        this._editTlEditSel = D.stepPoint(step);
        this._editTlMulti = null;
        this._editTlSel = this._editTlEditSel.sel;
        if (Math.round(step.t * fps) !== (this.currentFrame || 0)) this._editTlGoFrame(Math.round(step.t * fps));
        this._editTlSay({ left: "the out of the clip before the cut", both: "both sides: a roll", right: "the in of the clip after the cut" }[step.state]
                        + ` · ${D.timecode(step.t, fps)}`);
        this.editTlRefresh();
    },

    /** , and . : the edit point selected trims; else the selected clips MOVE a frame (Shift: a second). */
    editTlNudge(frames) {
        if (this.editTlNudgeEdit(frames)) return;
        const cut = this._editTlCut;
        const list = this._editTlSelAll().filter((s) => s.kind !== "gap" && s.kind !== "sound");
        if (!cut || !list.length) { this._editTlSay("select a clip to move it, or click a cut to trim it"); return; }
        const fps = cut.fps || 24;
        const d = frames / fps;
        let next = null, slide = null;
        // The Trim mode: one clip slides, its neighbours giving and taking; at an end of the track, or several, they move.
        if (this._editTlTrimMode && list.length === 1 && D.isClipSel(list[0])) {
            const s = list[0];
            const slid = s.kind === "clip" ? D.slideClip(cut, s.i, d, this._editTlDur()) : D.slideTrackClip(cut, s.track, s.i, d, this._editTlDur());
            if (slid) next = D.followLink(cut, slid, s);
            if (slid) slide = s;
        }
        // Several: they move together over what is there, as a drag of them does (D.moveGroup), in both modes.
        let group = null;
        if (!next && list.filter((x) => x.kind !== "text").length > 1) {
            group = D.moveGroup(cut, list, d, 0);
            if (group) next = group.cut;
        }
        if (!next) next = D.moveSelection(cut, list, d).cut;
        if (D.sameCut(next, cut)) { this._editTlSay(group ? "held: the start of the film" : "held: a clip or the start of the film is in the way"); return; }
        if (group) {
            this._editTlCut = cut;
            this._editTlApply(next);
            this._editTlSetSelList(group.sel, group.moved[D.selId(this._editTlSel)] || null);
            this.editTlRefresh();
            const fpsN = cut.fps || 24;
            this._editTlSay(`moved ${list.length} ${frames >= 0 ? "+" : "\u2212"}${Math.abs(frames)}f` + (group.delta !== d ? ` (held at the start: ${Math.round(group.delta * fpsN)}f)` : ""));
            return;
        }
        this._editTlApply(next);
        if (slide && this.editTwoUpPulse) this.editTwoUpPulse({ act: "slide", sel: slide }, next);
        const span = D.isClipSel(this._editTlSel) ? D.selSpan(next, this._editTlSel) : null;
        this._editTlSay(`moved ${frames >= 0 ? "+" : "\u2212"}${Math.abs(frames)}f` + (span ? ` \u00b7 ${D.timecode(span.start, fps)}` : ""));
    },

    /** E: the selected edit point (or the out of the selected clip) moved to the playhead. */
    editTlExtendEdit() {
        const cut = this._editTlCut;
        if (!cut || !this._editTlOnScreen()) { this._editTlSay("the cut is not on screen: open its tab to extend to the playhead"); return; }
        let info = this._editTlEditPoint();
        if (info) info = this._editTlEditLive(info);
        if (!info && this._editTlSel && D.clipOf(cut, this._editTlSel)) {
            info = { act: this._editTlTrimMode ? "ripple-out" : "trim-out", sel: this._editTlSel, side: "end" };
        }
        if (!info) { this._editTlSay("select an edit point (click a cut) or a clip to extend it"); return; }
        const fps = cut.fps || 24;
        const pt = this._editTlTrimPoint(info, cut);
        if (!pt) return;
        const now = (this.currentFrame || 0) / fps;
        const next = this._editTlTrimCompute(info, cut, D.toFrame((now - pt.t0) * pt.sign, fps));
        if (D.sameCut(next, cut)) { this._editTlSay("held: it cannot reach the playhead"); return; }
        this._editTlApply(next);
    },

    /** The selected edit point, drawn as Resolve's: green on the edge(s) that will move, in every mode, its linked partner's too. */
    _editTlEditMarkDraw() {
        const ui = this._editTlUi, lay = this._editTlLay;
        if (!ui) return;
        const cut = this._editTlCut;
        const info = this._editTlEditPoint();
        const edges = [];
        if (info && lay && lay.total > 0) {
            const of = (sel, side) => {
                const p = this._editTlPlace(cut, sel);
                if (p && p.row) edges.push({ at: side === "end" ? p.start + p.length : p.start, side, row: p.row });
                const partner = D.linkPartner(cut, sel);
                const q = partner && this._editTlPlace(cut, partner);
                if (q && q.row) edges.push({ at: side === "end" ? q.start + q.length : q.start, side, row: q.row });
            };
            if (info.act === "roll") { of(info.a, "end"); of(info.b, "start"); } else of(info.sel, info.side === "end" ? "end" : "start");
        }
        const keys = ["editMark", "editMark2", "editMark3", "editMark4"];
        const a = ui.area.getBoundingClientRect();
        keys.forEach((key, n) => {
            if (!ui[key] || !ui[key].isConnected) {
                ui[key] = ui.area.ownerDocument.createElement("div");
                ui[key].className = "edit-editpoint";
                ui.area.append(ui[key]);
            }
            const el = ui[key], g = edges[n];
            if (!g) { el.style.display = "none"; return; }
            const r = g.row.getBoundingClientRect();
            el.style.display = "block";
            el.style.left = (g.at / lay.total) * 100 + "%";
            el.style.top = (r.top - a.top) + "px";
            el.style.height = r.height + "px";
            el.dataset.side = g.side;
            el.dataset.roll = info.act === "roll" ? "1" : "";
            el.style.setProperty("--trim", EDIT_GREEN);
            el.title = `Selected edit: ${D.pointAct(info, !!this._editTlTrimMode).replace("-", " ")} - , / . trim it, E extends it to the playhead, Esc lets it go`;
        });
        // Play around edit: in the Trim mode the window Space plays (a second either side of the cut), on the ruler.
        const around = this._editPlayAround && this._editTlOnScreen() ? this._editPlayAround() : null;
        if (!ui.around || !ui.around.isConnected || ui.around.parentNode !== ui.ruler) {
            ui.around = ui.ruler.ownerDocument.createElement("div");
            ui.around.className = "edit-around";
            ui.around.title = "Play around edit: Space plays a second before the cut to a second after it, looped; , / . move the cut while it plays";
            ui.ruler.append(ui.around);
        }
        if (!around || !lay || !(lay.total > 0)) ui.around.style.display = "none";
        else {
            const fps = cut.fps || 24;
            ui.around.style.display = "block";
            ui.around.style.left = (around.min / fps / lay.total) * 100 + "%";
            ui.around.style.width = ((around.max + 1 - around.min) / fps / lay.total) * 100 + "%";
            ui.around.dataset.from = String(around.min);
            ui.around.dataset.to = String(around.max);
        }
    },

    /** A dissolve's bar, pressed in its body: roll the cut under it (its edges stay the dissolve's length). */
    _editTlMixRoll(e, el, i) {
        const start = this._editTlCut;
        const fps = start.fps || 24;
        const dur = this._editTlDur();
        const info = { act: "roll", sel: { kind: "clip", i }, join: i, side: "start", a: { kind: "clip", i: i - 1 }, b: { kind: "clip", i } };
        this._editTlSel = { kind: "mix", i };
        const at0 = D.clipStarts(start)[i];
        this._editTlDrag(e, el, (seconds, ev) => {
            this._editTlCut = D.rollEdit(start, i, D.toFrame(seconds, fps), dur);
            this.editTlRefresh();
            this._editTlTrimShow(info, ev.clientX, { delta: D.clipStarts(this._editTlCut)[i] - at0 });
        }, (moved) => {
            this._editTlTrimShow(null);
            if (!moved) this._editTlSeek(at0);
            this.editTlRefresh();
        });
    },

    /** Over a dissolve's bar: its edges change its length; its body rolls the cut under it. */
    _editTlMixHover(e, el, i) {
        if (e.buttons || this._editTlDragging) return;
        const box = el.getBoundingClientRect();
        const edge = Math.min(EDGE_PX, box.width / 3);
        const body = e.clientX - box.left > edge && box.right - e.clientX > edge;
        el.style.cursor = body ? TRIM_CURSORS.roll : "ew-resize";
        const info = { act: "roll", sel: { kind: "clip", i }, join: i, side: "start", a: { kind: "clip", i: i - 1 }, b: { kind: "clip", i } };
        if (body) this._editTlTrimShow(info, e.clientX);
        else this._editTlTrimShow(null);
    },

    /** A clip's speed and loop, said on its block: "62 %", "loop x2.5" - and drawn (CSS: .retimed, .looped). */
    _editTlBadges(b, clip) {
        const sp = D.speedOf(clip), loop = D.loopOf(clip);
        b.classList.toggle("retimed", sp !== 1);
        b.classList.toggle("looped", !!loop);
        if (sp === 1 && !loop) return;
        const doc = b.ownerDocument;
        const tag = doc.createElement("span");
        tag.className = "edit-badge-time";
        const turns = loop ? Math.round(Number(clip.length) * sp / Number(clip.span) * 10) / 10 : 0;
        tag.textContent = [sp !== 1 ? Math.round(sp * 100) + " %" : "", loop ? (loop === "pingpong" ? "⇄ " : "↻ ") + "×" + turns : ""]
            .filter(Boolean).join(" · ");
        tag.title = (sp !== 1 ? `Retimed: ${Math.round(sp * 100)} % of its own speed (Shift+R: back to 100 %). ` : "")
            + (loop ? `${loop === "pingpong" ? "Ping-pong" : "Looped"}: ${turns} turns of ${D.lengthLabel(clip.span)} of source.` : "");
        b.append(tag);
    },

    // ── keys: slip, retime, loop ─────────────────────────────────────────────

    /** Alt+, and Alt+. : slip the selected clip a frame (Shift: a second) - `frames` of its source. */
    editTlSlipBy(frames) {
        const sel = this._editTlSel;
        const cut = this._editTlCut;
        const c = cut && D.clipOf(cut, sel);
        if (!c) { this._editTlSay("select a clip to slip it"); return; }
        if (D.isStillImage(c.file)) { this._editTlSay("a still has no source to slip"); return; }
        const fps = cut.fps || 24;
        const next = D.slipClip(cut, sel, frames / fps, this._editTlDur());
        if (D.sameCut(next, cut)) { this._editTlSay("held: the source ends there"); return; }
        this._editTlApply(next);
        if (this._editTlTrimMode && this.editTwoUpPulse) this.editTwoUpPulse({ act: "slip", sel }, next);
        const d = D.clipOf(next, sel);
        this._editTlSay(`slipped: src ${D.timecode(d.in, fps)} – ${D.timecode(Number(d.in) + D.srcUse(d), fps)}`);
    },

    /** Shift+R: the selected clip back at 100 %. */
    editTlSpeedReset() {
        const sel = this._editTlSel, cut = this._editTlCut;
        const c = cut && D.clipOf(cut, sel);
        if (!c) { this._editTlSay("select a clip to reset its speed"); return; }
        if (D.speedOf(c) === 1) { this._editTlSay("it plays at 100 % already"); return; }
        this._editTlApply(D.setSpeed(cut, sel, 1));
    },

    /** Ctrl+L / Ctrl+Shift+L: one more turn of the selected clip's loop (ping-pong). */
    editTlLoopOnce(mode) {
        const sel = this._editTlSel, cut = this._editTlCut;
        if (!cut || !D.clipOf(cut, sel)) { this._editTlSay("select a clip to loop it"); return; }
        this._editTlApply(D.loopOnce(cut, sel, mode, this._editTlDur()));
    },

    // ── in and out ───────────────────────────────────────────────────────────

    _editTlLast() { return D.filmFrames(this._editTlCut) - 1; },

    /** The range in and out set (frames), or null - the transport's own, while the cut is on screen. */
    _editTlRange() {
        const r = this._editTlOnScreen() ? this.playbackRange : (this._editTlView && this._editTlView.range);
        return r && Number.isFinite(r.start) && Number.isFinite(r.end) && r.end >= r.start ? r : null;
    },

    /** Set the range (null clears it): the transport's, the ruler's, kept with the cut. One place. */
    _editTlSetRange(r) {
        if (!this._editTlTransport()) return;
        const last = this._editTlLast();
        const range = r ? { start: Math.max(0, Math.min(last, Math.round(r.start))), end: Math.max(0, Math.min(last, Math.round(r.end))) } : null;
        if (range && range.end < range.start) range.end = range.start;
        this.playbackRange = range;
        this._editTlView.range = range ? { ...range } : null;
        this._editTlKeep();
        if (this.updateRangeOverlay) this.updateRangeOverlay();
        this._editTlRulerMarks();
    },

    /** The transport's bar changed the range (Ctrl-drag on it): the ruler follows. */
    editTlRangeChanged() {
        if (!this._editTlOnScreen() || !this._editTlView) return;
        const r = this.playbackRange;
        this._editTlView.range = r ? { start: r.start, end: r.end } : null;
        this._editTlKeep();
        this._editTlRulerMarks();
    },

    /** I / O: the in or the out at the playhead. */
    _editTlMark(which) {
        if (!this._editTlTransport()) return;
        this._editTlSetRange(D.setMark(this._editTlRange(), which, this.currentFrame || 0, this._editTlLast()));
    },

    /** X: the in and out around the selected clip - or the shot under the playhead. */
    editTlMarkClip() {
        if (!this._editTlTransport()) return;
        const cut = this._editTlCut;
        let sel = this._editTlSel && (this._editTlSel.kind === "clip" || this._editTlSel.kind === "tclip") ? this._editTlSel : null;
        if (!sel) {
            const at = D.playAt(cut, ((this.currentFrame || 0) + 0.5) / (cut.fps || 24));
            if (at) sel = { kind: "clip", i: at.i };
        }
        const r = sel && D.clipRange(cut, sel, cut.fps || 24);
        if (r) this._editTlSetRange(r);
    },

    /** Shift+I / Shift+O: go to the in / the out. */
    _editTlGoMark(which) {
        const r = this._editTlRange();
        if (!r) { this._editTlSay("no in and out set"); return; }
        this._editTlGoFrame(which === "in" ? r.start : r.end);
    },

    /** Alt+I / Alt+O: take the in (or the out) away - the range then reaches the film's start (end). */
    _editTlClearMark(which) {
        const r = this._editTlRange();
        if (!r) return;
        const last = this._editTlLast();
        const next = which === "in" ? { start: 0, end: r.end } : { start: r.start, end: last };
        this._editTlSetRange(next.start === 0 && next.end === last ? null : next);
    },

    /** A mark's frame snapped (the one snapping: _editTlSnapAt) - an out mark is the frame before the moment it snaps to. */
    _editTlMarkSnap(frame, isOut) {
        const fps = this._editTlCut.fps || 24;
        const t = this._editTlSnapAt((frame + (isOut ? 1 : 0)) / fps, [], { noRange: true });
        return Math.round(t * fps) - (isOut ? 1 : 0);
    },

    /** The ruler's in / out: the band, the two handles, the lines down the tracks. Cheap: redrawn on its own. */
    _editTlRulerMarks() {
        const ui = this._editTlUi, lay = this._editTlLay, cut = this._editTlCut;
        if (!ui || !ui.ruler || !lay || !cut) return;
        const doc = ui.ruler.ownerDocument;
        const r = this._editTlRange();
        const need = (key, cls, parent) => {
            if (!ui[key] || !ui[key].isConnected) {
                ui[key] = doc.createElement("div");
                ui[key].className = cls;
                parent.append(ui[key]);
                if (key === "markIn" || key === "markOut") this._editTlMarkBind(ui[key], key === "markIn" ? "in" : "out");
            }
            return ui[key];
        };
        const parts = [need("range", "edit-range", ui.ruler), need("markIn", "edit-mark in", ui.ruler), need("markOut", "edit-mark out", ui.ruler),
                       need("lineIn", "edit-markline in", ui.area), need("lineOut", "edit-markline out", ui.area)];
        if (!r || !(lay.total > 0)) { for (const p of parts) p.style.display = "none"; return; }
        const fps = cut.fps || 24;
        const a = (r.start / fps) / lay.total * 100, b = ((r.end + 1) / fps) / lay.total * 100;
        const [band, mi, mo, li, lo] = parts;
        band.style.display = mi.style.display = mo.style.display = li.style.display = lo.style.display = "block";
        band.style.left = Math.max(0, a) + "%";
        band.style.width = Math.max(0, Math.min(100, b) - a) + "%";
        mi.style.left = li.style.left = Math.max(0, a) + "%";
        mo.style.left = lo.style.left = Math.min(100, b) + "%";
        mi.title = `In ${D.timecode(r.start / fps, fps)} (frame ${r.start}) - drag it; Alt+I clears it`;
        mo.title = `Out ${D.timecode((r.end + 1) / fps, fps)} (last frame ${r.end}) - drag it; Alt+O clears it`;
    },

    // A handle of the range: dragged along the ruler, snapping.
    _editTlMarkBind(el, which) {
        el.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            const fps = this._editTlCut.fps || 24;
            const move = (ev) => {
                const t = this._editTlTimeAt(ev.clientX);
                if (t == null) return;
                const r = this._editTlRange() || { start: 0, end: this._editTlLast() };
                const f = which === "in" ? this._editTlMarkSnap(Math.round(t * fps), false)
                                         : this._editTlMarkSnap(Math.round(t * fps) - 1, true);
                const next = which === "in" ? { start: Math.min(f, r.end), end: r.end } : { start: r.start, end: Math.max(f, r.start) };
                this._editTlSetRange(next);
            };
            // On the document, not the handle: a redraw of the ruler (ticks are rebuilt, a filmstrip
            // lands) detaches the handle mid-drag and would end the capture with it.
            const doc = el.ownerDocument;
            const up = () => {
                doc.removeEventListener("pointermove", move);
                doc.removeEventListener("pointerup", up);
                doc.removeEventListener("pointercancel", up);
                this._editTlSnapLine(null);
            };
            doc.addEventListener("pointermove", move);
            doc.addEventListener("pointerup", up);
            doc.addEventListener("pointercancel", up);
        });
    },

    /** Ctrl+drag on the ruler: a new range from the press to the pointer (as Ctrl-drag on the transport's bar). */
    _editTlRangeDrag(e) {
        e.preventDefault();
        e.stopPropagation();
        const ruler = this._editTlUi.ruler;
        const fps = this._editTlCut.fps || 24;
        const t0 = this._editTlTimeAt(e.clientX);
        if (t0 == null || !this._editTlTransport()) return;
        const f0 = this._editTlMarkSnap(Math.floor(t0 * fps), false);
        const move = (ev) => {
            const t = this._editTlTimeAt(ev.clientX);
            if (t == null) return;
            const f = this._editTlMarkSnap(Math.floor(t * fps), false);
            this._editTlSetRange({ start: Math.min(f0, f), end: Math.max(f0, f) });
        };
        const up = () => {
            ruler.removeEventListener("pointermove", move);
            ruler.removeEventListener("pointerup", up);
            ruler.removeEventListener("pointercancel", up);
            try { ruler.releasePointerCapture(e.pointerId); } catch (_) {}
            this._editTlSnapLine(null);
        };
        try { ruler.setPointerCapture(e.pointerId); } catch (_) {}
        ruler.addEventListener("pointermove", move);
        ruler.addEventListener("pointerup", up);
        ruler.addEventListener("pointercancel", up);
        move(e);
    },

    /** Right-click on the ruler: the in or the out here, the clip under it, or none. */
    _editTlRulerMenu(e) {
        e.preventDefault();
        e.stopPropagation();
        const t = this._editTlTimeAt(e.clientX);
        if (t == null) return;
        const fps = this._editTlCut.fps || 24;
        const f = Math.floor(t * fps);
        const r = this._editTlRange();
        const at = D.playAt(this._editTlCut, t);
        this._previzOpenMenu([
            { label: `Set in here (${D.timecode(f / fps, fps)})`, run: () => this._editTlSetRange(D.setMark(this._editTlRange(), "in", f, this._editTlLast())) },
            { label: "Set out here", run: () => this._editTlSetRange(D.setMark(this._editTlRange(), "out", f, this._editTlLast())) },
            { label: "Mark the shot here (X)", disabled: !at,
              run: () => this._editTlSetRange(D.clipRange(this._editTlCut, { kind: "clip", i: at.i }, fps)) },
            "-",
            { label: "Clear in–out (Alt+X)", disabled: !r, run: () => this._editTlSetRange(null) },
        ], e.clientX, e.clientY);
    },
};

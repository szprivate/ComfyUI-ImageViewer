// bEpicViewer_editTrim.js
// Trimming in the Edit panel the way an editor trims, and the in / out of the
// range played. A mixin onto the panel (bEpicViewer_editTimeline.js), with its
// arithmetic in bEpicViewer_editTimelineData.js.
//
// What a press on a clip does depends on where it lands and what is held - and
// the pointer says so before the press: its cursor, a lit side, a timecode.
//
//   an edge                trim that side: left of a cut the outgoing shot's
//                          OUT, right of it the incoming shot's IN (the side
//                          that will move is lit). On V1 what follows moves
//                          with it (ripple); on a track of placed clips nothing
//                          else does. Never past the source's ends; a still has
//                          none, so it grows as far as it is pulled.
//   the middle of a cut    ROLL (V1, ROLL_PX either side of the join): the cut
//                          moves, the shot before ends later as the one after
//                          begins later in its source - the film keeps its length
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
const SNAP_PX = 8;

// Cursors drawn as an editor's: a bracket on the side that moves.
function cursor(paths, color, fallback) {
    const g = (stroke, w) => `<g fill='none' stroke='${stroke}' stroke-width='${w}' stroke-linecap='round' stroke-linejoin='round'>`
        + paths.map((d) => `<path d='${d}'/>`).join("") + "</g>";
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'>${g("#000", 3.5)}${g(color, 1.6)}</svg>`;
    return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") 12 12, ${fallback}`;
}
const ARROWS = ["M2 12h20", "M5 9l-3 3 3 3", "M19 9l3 3-3 3"];
export const TRIM_CURSORS = {
    "trim-out": cursor(["M13 4h3v16h-3", "M2 12h9", "M5 9l-3 3 3 3", "M8 9l3 3-3 3"], "#9dff7a", "w-resize"),
    "trim-in": cursor(["M11 4h-3v16h3", "M13 12h9", "M19 9l3 3-3 3", "M16 9l-3 3 3 3"], "#9dff7a", "e-resize"),
    "roll": cursor(["M9 4h2v16h-2", "M15 4h-2v16h2", ...ARROWS], "#ffd84d", "col-resize"),
    "retime": cursor(["M12 4v16", "M7 7l-4 5 4 5", "M17 7l4 5-4 5", "M9 12h6"], "#ff9a3c", "ew-resize"),
    "loop": cursor(["M6 8h9a4 4 0 0 1 0 8h-2", "M9 5l-3 3 3 3", "M2 4v16"], "#4de1ff", "ew-resize"),
    "slip": cursor(["M8 4h-3v16h3", "M16 4h3v16h-3", "M9 12h6", "M11 10l-2 2 2 2", "M13 10l2 2-2 2"], "#c9a6ff", "ew-resize"),
    "slide": cursor(["M4 6v12", "M20 6v12", "M7 12h10", "M10 9l-3 3 3 3", "M14 9l3 3-3 3"], "#c9a6ff", "move"),
};
const ACT_WORD = { "trim-out": "Trim out", "trim-in": "Trim in", roll: "Roll", retime: "Retime", loop: "Loop extend",
                   slip: "Slip", slide: "Slide" };

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
     * { act, sel, side, join } - act is "trim-out", "trim-in", "roll",
     * "retime", "loop", "slip", "slide" or "move".
     */
    _editTlEdgeAct(e, el, sel) {
        const box = el.getBoundingClientRect();
        const edge = Math.min(EDGE_PX, box.width / 3);
        const x = e.clientX;
        const zone = x - box.left <= edge ? "start" : (box.right - x <= edge ? "end" : "body");
        const alt = !!e.altKey, ctrl = !!(e.ctrlKey || e.metaKey), shift = !!e.shiftKey;
        if (zone === "body") {
            if (alt && shift && sel.kind === "clip") return { act: "slide", sel };
            if (alt) return { act: "slip", sel };
            return { act: "move", sel };
        }
        if (alt) return { act: "retime", sel, side: zone };
        if (ctrl && zone === "end") return { act: "loop", sel, side: "end" };
        if (sel.kind === "clip") {
            const cut = this._editTlCut;
            const join = zone === "end" ? sel.i + 1 : sel.i;
            const near = zone === "end" ? box.right - x : x - box.left;
            if (near <= ROLL_PX && join >= 1 && cut.clips[join] && !(Number(cut.clips[join].transition) > 0)) {
                return { act: "roll", sel, join, side: zone };
            }
        }
        return { act: zone === "end" ? "trim-out" : "trim-in", sel, side: zone };
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
        const color = { "trim-out": "#9dff7a", "trim-in": "#9dff7a", roll: "#ffd84d", retime: "#ff9a3c", loop: "#4de1ff",
                        slip: "#c9a6ff", slide: "#c9a6ff" }[info.act] || "#9dff7a";
        let lines = [];
        let row = null;
        if (ui.trimB) ui.trimB.style.display = "none";
        if (ui.slipBand) ui.slipBand.style.display = "none";
        const sel = info.sel;
        const c = D.clipOf(cut, sel);
        if (!c) { hide(); return; }
        if (info.act === "roll") {
            const before = { kind: "clip", i: info.join - 1 }, after = { kind: "clip", i: info.join };
            const p = light("trimA", before, "end", color);
            light("trimB", after, "start", color);
            row = p && p.row;
            const at = D.clipStarts(cut)[info.join];
            lines = [`Roll ${name(cut.clips[info.join - 1])} | ${name(cut.clips[info.join])}`, tc(at)];
        } else {
            const side = info.act === "trim-in" || (info.act === "retime" && info.side === "start") ? "start"
                : (info.act === "slip" || info.act === "slide") ? "body" : "end";
            const p = light("trimA", sel, side, color);
            row = p && p.row;
            const start = p ? p.start : 0, len = p ? p.length : 0;
            const srcIn = Number(c.in) || 0, still = D.isStillImage(c.file);
            const srcOut = srcIn + D.srcUse(c);
            if (info.act === "trim-out") lines = [`Out of ${name(c)}`, tc(start + len) + (still ? "" : ` · src ${tc(srcOut)}`)];
            else if (info.act === "trim-in") lines = [`In of ${name(c)}`, tc(start) + (still ? "" : ` · src ${tc(srcIn)}`)];
            else if (info.act === "retime") lines = [`Retime ${name(c)} (Alt)`, `${Math.round(D.speedOf(c) * 100)} % · ${D.lengthLabel(len)}`];
            else if (info.act === "loop") {
                const turns = D.loopOf(c) ? len * D.speedOf(c) / Number(c.span) : 1;
                lines = [`Loop extend ${name(c)} (Ctrl)`, still ? D.lengthLabel(len) : `${Math.round(turns * 100) / 100} turns · ${D.lengthLabel(len)}`];
            } else if (info.act === "slip") {
                lines = [`Slip ${name(c)} (Alt)`, still ? "a still has no source to slip" : `src ${tc(srcIn)} – ${tc(srcOut)}`];
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
                lines = [`Slide ${name(c)} (Alt+Shift)`, `${tc(start)} – ${tc(start + len)}`];
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
     * A press on a clip (after the blade has had its say): the trims, roll,
     * retime, loop, slip and slide are done here. False for a plain move, which
     * the panel does itself.
     */
    _editTlTrimDown(e, el, sel) {
        if (e.button !== 0) return false;
        const info = this._editTlEdgeAct(e, el, sel);
        if (info.act === "move") return false;
        const start = this._editTlCut;
        const fps = start.fps || 24;
        const c0 = D.clipOf(start, sel);
        if (!c0) return false;
        const dur = this._editTlDur();
        if (info.act === "slip" && D.isStillImage(c0.file)) {
            e.preventDefault(); e.stopPropagation();
            this._editTlSel = sel;
            this._editTlSay("a still has no source to slip - drag its edges to make it longer");
            return true;
        }
        if (info.act === "slide" && !(sel.i > 0 && sel.i < start.clips.length - 1)) {
            e.preventDefault(); e.stopPropagation();
            this._editTlSel = sel;
            this._editTlSay("a slide needs a shot on each side - this one is at an end of the cut");
            return true;
        }
        this._editTlSel = sel;
        const place = this._editTlPlace(start, sel);
        const began = place ? place.start : 0;
        const len0 = Number(c0.length) || 0;
        const edge0 = info.act === "roll" ? D.clipStarts(start)[info.join]
            : info.side === "start" ? began : began + len0;
        // The moving edge snaps to the other edit points and the playhead.
        const points = this._editTlSnapPoints(D.editPoints(start).filter((t) => Math.abs(t - edge0) > 1e-6));
        const tol = this._editTlSnapTolerance();
        const sp = D.speedOf(c0);
        this._editTlDrag(e, el, (seconds, ev) => {
            let d = seconds;
            if (info.act !== "slip" && info.act !== "slide") d = D.snapTime(edge0 + d, points, tol) - edge0;
            d = D.toFrame(d, fps);
            let next = start;
            const i = sel.i;
            switch (info.act) {
                case "trim-out":
                    next = sel.kind === "clip" ? D.trimEnd(start, i, D.toFrame(len0 + d, fps), dur)
                                               : D.trimTrackClipEnd(start, sel.track, i, D.toFrame(len0 + d, fps), dur);
                    break;
                case "trim-in":
                    next = sel.kind === "clip" ? D.trimStart(start, i, d) : D.trimTrackClipStart(start, sel.track, i, d);
                    break;
                case "roll": next = D.rollEdit(start, info.join, d, dur); break;
                case "retime":
                    next = D.retimeClip(start, sel, info.side === "start" ? len0 - d : len0 + d, info.side === "start");
                    break;
                case "loop": next = D.loopExtend(start, sel, D.toFrame(len0 + d, fps), null, dur); break;
                case "slip": next = D.slipClip(start, sel, -d * sp, dur); break;         // the picture follows the pointer
                case "slide": next = D.slideClip(start, i, d, dur) || start; break;
            }
            this._editTlCut = next;
            this.editTlRefresh();
            // What it came to - and whether something held it (the source's end, a neighbour, the speed's limits).
            const now = this._editTlPlace(next, sel) || { start: began, length: len0 };
            const c1 = D.clipOf(next, sel) || c0;
            const fromStart = info.side === "start";
            const got = info.act === "slip" ? (Number(c1.in) || 0) - (Number(c0.in) || 0)
                : info.act === "roll" ? D.clipStarts(next)[info.join] - edge0
                : info.act === "slide" ? now.start - began
                : fromStart ? (sel.kind === "clip" || info.act === "retime" ? len0 - now.length : now.start - began)
                : now.length - len0;
            const held = Math.abs(got - (info.act === "slip" ? -d * sp : d)) > 0.5 / fps
                ? "held: " + (info.act === "retime" ? "the speed's limit (10 % to 1000 %)"
                    : info.act === "slip" ? "the end of the source" : "the end of the source, or a shot's shortest")
                : "";
            this._editTlTrimShow(info, ev.clientX, { delta: got, held });
        }, (moved) => {
            this._editTlTrimShow(null);
            if (!moved) this._editTlSeek(began);
            this.editTlRefresh();
        });
        return true;
    },

    /** A dissolve's bar, pressed in its body: roll the cut under it (its edges stay the dissolve's length). */
    _editTlMixRoll(e, el, i) {
        const start = this._editTlCut;
        const fps = start.fps || 24;
        const dur = this._editTlDur();
        const info = { act: "roll", sel: { kind: "clip", i }, join: i, side: "start" };
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
        const info = { act: "roll", sel: { kind: "clip", i }, join: i, side: "start" };
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

    /** , and . : slip the selected clip a frame (Shift: a second) - `frames` of its source. */
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

    /** The frames a mark snaps to: the edit points and the playhead. */
    _editTlMarkSnap(frame, isOut) {
        const cut = this._editTlCut, fps = cut.fps || 24;
        const pts = D.editPoints(cut).map((t) => Math.round(t * fps) - (isOut ? 1 : 0));
        pts.push((this.currentFrame || 0));
        const tol = Math.max(1, this._editTlSnapTolerance() * fps);
        return D.snapFrame(frame, pts, tol);
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

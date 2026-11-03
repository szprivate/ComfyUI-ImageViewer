// bEpicViewer_editSections.js
// The Edit panel's timeline laid out as Resolve's (a mixin onto the panel, like
// the other edit* files; the arithmetic in bEpicViewer_editTimelineData.js,
// tested in tests/test_edit_tl_layout.mjs, the panel in tests/test_edit_timeline_browser.py,
// its test_26_*):
//
//   the ruler               stays on top whatever the tracks are scrolled to: it is
//                           the area's first row, and the area itself never scrolls
//                           up and down - only sideways, ruler and tracks together
//   the readout             left of the ruler, over the headers: the playhead as a
//                           timecode (HH:MM:SS:FF at the cut's fps) or as a frame number.
//                           Click: the other one; right-click: choose; double-click:
//                           type a timecode or a frame (+n / -n: on / back) and Enter goes
//                           there. Which one is kept per viewer (localStorage)
//   two sections            the video tracks (with the texts) above, the sound below
//                           (A1, the bed, and A2 ...), a splitter between them (drag it;
//                           double-click: back to fitting the video tracks). Each scrolls
//                           up and down on its own - Alt + wheel over the tracks, the wheel
//                           over the headers, the headers' scroll bar - and the video
//                           section stays down at V1 (by the splitter) until it is
//                           scrolled up. The playhead's line, the snap line, the in / out
//                           lines and the marquee lie over both (they are the area's)
//   Shift + wheel           every track of the section under the pointer taller or
//                           lower (over the ruler or the splitter: both sections), within
//                           D.TRACK_MIN_PX..TRACK_MAX_PX; the filmstrips are asked for
//                           once the wheel rests (what is cached is drawn meanwhile)
//   the wheel               along the film (as before; over the ruler too); Ctrl + wheel
//                           zooms about the pointer
//
// The heights and the splitter are the cut's view (_editTlView.heights / .scale /
// .split), kept with it as the zoom is.
import * as D from "./bEpicViewer_editTimelineData.js";
import { ROW_HEIGHT } from "./bEpicViewer_editTimeline.js";

const TC_STORE = "bepic.viewer.editTimecode";    // "tc" | "frames", per viewer
const SIZE_REST_MS = 250;                        // Shift + wheel: the strips are asked for once it rests this long

export const EditSectionsMixin = {

    /** Wire the sections, the splitter and the readout of a freshly built panel `ui` (_editTlBuild). */
    _editTlSecBind(ui) {
        // A section scrolled: its headers with it; what is drawn in the clips, and the marks laid over them, follow.
        const follow = (sec, heads, video) => () => {
            if (Math.abs(heads.scrollTop - sec.scrollTop) > 0.5) this._editTlHeadsTo(heads, sec.scrollTop);
            if (video) ui.vPinned = sec.scrollTop >= sec.scrollHeight - sec.clientHeight - 1;
            this._editTlSecMoved();
        };
        ui.secV.addEventListener("scroll", follow(ui.secV, ui.headsV, true), { passive: true });
        ui.secA.addEventListener("scroll", follow(ui.secA, ui.headsA, false), { passive: true });
        // The headers scrolled by hand (their scroll bar): the tracks with them. Not where the code put them: that
        // event may come in after the section has been scrolled on, and would take it back.
        const lead = (heads, sec) => () => {
            if (Math.abs(heads.scrollTop - heads._bepicSet) < 0.5) return;
            if (Math.abs(sec.scrollTop - heads.scrollTop) > 0.5) sec.scrollTop = heads.scrollTop;
        };
        ui.headsV.addEventListener("scroll", lead(ui.headsV, ui.secV), { passive: true });
        ui.headsA.addEventListener("scroll", lead(ui.headsA, ui.secA), { passive: true });
        for (const bar of [ui.splitter, ui.hsplit]) {
            bar.title = "Drag: the video tracks above, the sound below. Double-click: fit the video tracks";
            bar.addEventListener("pointerdown", (e) => this._editTlSplitDown(e, bar));
            bar.addEventListener("dblclick", (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!this._editTlView) return;
                this._editTlView.split = null;
                this._editTlSecSync();
                this._editTlKeep();
            });
        }
        // The readout: click switches, right-click chooses, double-click types a moment to go to.
        ui.tcLabel = ui.tc.ownerDocument.createElement("span");
        ui.tcLabel.className = "edit-tclabel";
        ui.tc.append(ui.tcLabel);
        ui.tcText = null;
        this._editTlTcTitle();
        ui.tc.addEventListener("click", (e) => {
            if (ui.tcEditing || e.button !== 0) return;
            this._editTlTcSet(this._editTlTcMode() === "frames" ? "tc" : "frames");
        });
        ui.tc.addEventListener("dblclick", (e) => { e.preventDefault(); this._editTlTcEdit(); });
        ui.tc.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const mode = this._editTlTcMode();
            this._previzOpenMenu([
                { label: (mode === "tc" ? "✓ " : "  ") + "Timecode (HH:MM:SS:FF)", run: () => this._editTlTcSet("tc") },
                { label: (mode === "frames" ? "✓ " : "  ") + "Frames", run: () => this._editTlTcSet("frames") },
                "-",
                { label: "Go to…", run: () => this._editTlTcEdit() },
            ], e.clientX, e.clientY);
        });
    },

    /**
     * The sections laid out to the cut as it is drawn: the splitter where it was put
     * (or fitting the video tracks), the headers beside their tracks to the pixel,
     * the video section held down at V1 unless scrolled up. On every redraw and resize.
     */
    _editTlSecSync() {
        const ui = this._editTlUi;
        if (!ui || !ui.secV || !ui.body.isConnected || ui.main.style.display === "none") return;
        const view = this._editTlView || {};
        const content = (sec) => {
            let h = 0, n = 0;
            for (const k of sec.children) { h += k.offsetHeight; n += 1; }
            return h + Math.max(0, n - 1) * 2;            // the sections' gap (CSS .edit-sec)
        };
        const room = Math.max(0, ui.rows.clientHeight - ui.splitter.offsetHeight);
        const h = D.splitHeight(Number.isFinite(view.split) ? view.split : null, room, content(ui.secV), content(ui.secA));
        if (ui.secV.style.height !== h + "px") ui.secV.style.height = h + "px";
        // The headers: the readout as tall as the ruler, each section's beside its tracks.
        ui.tc.style.height = ui.ruler.offsetHeight + "px";
        ui.headsV.style.height = ui.secV.offsetHeight + "px";
        ui.hsplit.style.height = ui.splitter.offsetHeight + "px";
        ui.headsA.style.height = ui.secA.offsetHeight + "px";
        // Held down at V1 until scrolled up (its scroll event says so; a section moved into a popped-out
        // window comes back at the top without one, and is put down again here).
        if (ui.vPinned) ui.secV.scrollTop = ui.secV.scrollHeight;
        this._editTlHeadsTo(ui.headsV, ui.secV.scrollTop);
        this._editTlHeadsTo(ui.headsA, ui.secA.scrollTop);
    },

    /** A headers' column scrolled to `top` by the code (its scroll event is then not taken for a hand's). */
    _editTlHeadsTo(heads, top) {
        heads.scrollTop = top;
        heads._bepicSet = heads.scrollTop;
    },

    /** A section scrolled: the clips' insides, the selected edit's marks (laid over the area) follow; a trim's highlight goes. */
    _editTlSecMoved() {
        if (this.editMediaSchedule) this.editMediaSchedule();
        if (this._editTlEditMarkDraw) this._editTlEditMarkDraw();
        if (!this._editTlDragging && this._editTlTrimShow) this._editTlTrimShow(null);
    },

    /** "video" / "audio": the section under a pointer's y (a section's scroll bar, below it, counts); null over the ruler or the splitter. */
    _editTlSecAt(clientY) {
        const ui = this._editTlUi;
        if (!ui || !ui.secV) return null;
        const sv = ui.secV.getBoundingClientRect(), sa = ui.secA.getBoundingClientRect();
        if (clientY >= sv.top && clientY < sv.bottom) return "video";
        if (clientY >= sa.top && clientY < ui.scroll.getBoundingClientRect().bottom) return "audio";
        return null;
    },

    /**
     * The part of row `row` its section shows, in client pixels ({ top, bottom,
     * height, left, right, width }); null when scrolled out of view - or, with
     * `edge`, a strip at the section's edge it lies beyond (where a ghost is shown).
     */
    _editTlRowBox(row, edge = false) {
        const r = row.getBoundingClientRect();
        const sec = row.closest ? row.closest(".edit-sec") : null;
        if (!sec) return r;
        const s = sec.getBoundingClientRect();
        const top = Math.max(r.top, s.top), bottom = Math.min(r.bottom, s.bottom);
        if (bottom > top) return { top, bottom, height: bottom - top, left: r.left, right: r.right, width: r.width };
        if (!edge) return null;
        const h = Math.max(4, Math.min(r.height, 12));
        const t = r.bottom <= s.top ? s.top : s.bottom - h;
        return { top: t, bottom: t + h, height: h, left: r.left, right: r.right, width: r.width };
    },

    /**
     * The wheel over the timeline (the headers, the ruler, the tracks). Ctrl: zoom
     * about the pointer. Shift: the heights of the section under it (both over the
     * ruler / splitter). Alt, or over the headers: that section up and down. Else
     * along the film - up and down when there is nowhere to go along.
     */
    _editTlWheel(e) {
        const ui = this._editTlUi;
        if (!ui || !this._editTlView || !this._editTlLay) return;
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
        const dx = e.deltaX * unit, dy = e.deltaY * unit;
        const path = e.composedPath ? e.composedPath() : [e.target];
        const overHeads = path.includes(ui.heads);
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            this._editTlZoom(this._editTlView.zoom * (dy < 0 ? 1.25 : 0.8), overHeads ? undefined : e.clientX);
            return;
        }
        const sec = this._editTlSecAt(e.clientY);
        if (e.shiftKey) {
            // (A browser may turn Shift + wheel into a sideways delta: either one is the notch.)
            const d = dy || dx;
            e.preventDefault();
            if (d) this._editTlSizeBy(sec ? [sec] : ["video", "audio"], d < 0 ? 1 : -1);
            return;
        }
        const secEl = sec === "video" ? ui.secV : sec === "audio" ? ui.secA : null;
        if (e.altKey || overHeads) {
            if (secEl) { e.preventDefault(); secEl.scrollTop += dy || dx; }
            return;
        }
        const sc = ui.scroll;
        if (sc.scrollWidth > sc.clientWidth + 1) {
            e.preventDefault();
            sc.scrollLeft += (Math.abs(dx) > Math.abs(dy) ? dx : dy);
        } else if (secEl) {
            e.preventDefault();
            secEl.scrollTop += dy;
        }
    },

    /**
     * Every track of the sections `secs` ("video", "audio") a notch taller (`dir` 1)
     * or lower (-1), and the section's scale for rows with no height of their own.
     * Redrawn once a frame while the wheel turns; the filmstrips for the new height
     * are asked for once it rests (_editTlSizing holds them off, like a drag).
     */
    _editTlSizeBy(secs, dir) {
        const ui = this._editTlUi, view = this._editTlView;
        if (!ui || !view || !this._editTlCut) return;
        view.heights = view.heights || {};
        view.scale = view.scale || {};
        let changed = false;
        for (const sec of secs) {
            const host = sec === "video" ? ui.secV : ui.secA;
            for (const tr of host.querySelectorAll(".edit-track")) {
                const id = tr.dataset.track;
                const kind = tr.classList.contains("edit-k-audio") ? "audio" : tr.classList.contains("edit-k-text") ? "text" : "video";
                const was = this._editTlRowHeight({ id, kind });
                const now = D.stepTrackHeight(was, dir);
                if (now !== was) changed = true;
                view.heights[id] = now;
            }
            const base = ROW_HEIGHT[sec];
            const scale = Number(view.scale[sec]) || 1;
            view.scale[sec] = D.stepTrackHeight(Math.round(base * scale), dir) / base;
        }
        if (!changed) return;
        const win = ui.body.ownerDocument.defaultView || window;
        this._editTlSizing = true;
        if (this._editTlSizeTimer) win.clearTimeout(this._editTlSizeTimer);
        this._editTlSizeTimer = win.setTimeout(() => {
            this._editTlSizeTimer = 0;
            this._editTlSizing = false;
            this.editTlRefresh();
        }, SIZE_REST_MS);
        if (!this._editTlSizeRaf) {
            this._editTlSizeRaf = win.requestAnimationFrame(() => { this._editTlSizeRaf = 0; this.editTlRefresh(); });
        }
    },

    /** The splitter pressed (`bar`: over the tracks or over the headers): dragged, the video section's height. */
    _editTlSplitDown(e, bar) {
        const ui = this._editTlUi, view = this._editTlView;
        if (e.button !== 0 || !ui || !view) return;
        e.preventDefault();
        e.stopPropagation();
        const y0 = e.clientY, h0 = ui.secV.offsetHeight;
        const move = (ev) => {
            const room = Math.max(0, ui.rows.clientHeight - ui.splitter.offsetHeight);
            view.split = D.splitHeight(h0 + (ev.clientY - y0), room, 0, 0);
            this._editTlSecSync();
            if (this.editMediaSchedule) this.editMediaSchedule();
        };
        const up = () => {
            bar.removeEventListener("pointermove", move);
            bar.removeEventListener("pointerup", up);
            bar.removeEventListener("pointercancel", up);
            try { bar.releasePointerCapture(e.pointerId); } catch (_) {}
            ui.body.classList.remove("split-drag");
            this._editTlKeep();
        };
        try { bar.setPointerCapture(e.pointerId); } catch (_) {}
        ui.body.classList.add("split-drag");
        bar.addEventListener("pointermove", move);
        bar.addEventListener("pointerup", up);
        bar.addEventListener("pointercancel", up);
    },

    // ── the playhead readout ─────────────────────────────────────────────────

    /** "tc" or "frames": how the readout shows the playhead (per viewer). */
    _editTlTcMode() {
        if (!this._editTlTcModeNow) {
            let kept = null;
            try { kept = window.localStorage.getItem(TC_STORE); } catch (_) {}
            this._editTlTcModeNow = kept === "frames" ? "frames" : "tc";
        }
        return this._editTlTcModeNow;
    },

    _editTlTcSet(mode) {
        this._editTlTcModeNow = mode === "frames" ? "frames" : "tc";
        try { window.localStorage.setItem(TC_STORE, this._editTlTcModeNow); } catch (_) {}
        if (this._editTlUi) this._editTlUi.tcText = null;
        this._editTlTcTitle();
        this._editTlTcDraw();
    },

    _editTlTcTitle() {
        const ui = this._editTlUi;
        if (!ui || !ui.tc) return;
        ui.tc.dataset.mode = this._editTlTcMode();
        ui.tc.title = (this._editTlTcMode() === "frames" ? "The playhead's frame - click: as a timecode"
                                                         : "The playhead's timecode (HH:MM:SS:FF) - click: as a frame number")
            + ". Double-click: type a timecode or a frame to go to (+n / -n: on / back). Right-click: choose";
    },

    /** The readout written - only when its text changes (it runs on every frame of playback and scrub). */
    _editTlTcDraw() {
        const ui = this._editTlUi;
        if (!ui || !ui.tcLabel || ui.tcEditing) return;
        const cut = this._editTlCut;
        const text = cut && this._editTlOnScreen() ? D.playheadLabel(this.currentFrame || 0, cut.fps || 24, this._editTlTcMode()) : "";
        if (text === ui.tcText) return;
        ui.tcText = text;
        ui.tcLabel.textContent = text;
    },

    /** Double-click on the readout: a field to type a timecode or a frame into; Enter goes there, Esc (or leaving it) does not. */
    _editTlTcEdit() {
        const ui = this._editTlUi, cut = this._editTlCut;
        if (!ui || !ui.tc || ui.tcEditing || !cut) return;
        const doc = ui.tc.ownerDocument;
        const input = doc.createElement("input");
        input.className = "edit-tcinput";
        input.spellcheck = false;
        input.value = ui.tcText || "";
        ui.tcEditing = true;
        ui.tc.replaceChildren(input);
        const done = (go) => {
            if (!ui.tcEditing) return;
            ui.tcEditing = false;
            const typed = input.value;
            ui.tc.replaceChildren(ui.tcLabel);
            ui.tcText = null;
            if (go) {
                const fps = cut.fps || 24;
                const f = D.parsePlayhead(typed, fps, this.currentFrame || 0);
                if (f == null) this._editTlSay(`"${typed}" is not a timecode or a frame`);
                else this._editTlSeek(f / fps);
            }
            this._editTlTcDraw();
            try { ui.body.focus({ preventScroll: true }); } catch (_) {}
        };
        input.addEventListener("keydown", (ev) => {
            ev.stopPropagation();
            if (ev.key === "Enter") { ev.preventDefault(); done(true); }
            else if (ev.key === "Escape") { ev.preventDefault(); done(false); }
        });
        input.addEventListener("blur", () => done(false));
        input.addEventListener("pointerdown", (ev) => ev.stopPropagation());
        try { input.focus(); input.select(); } catch (_) {}
    },
};

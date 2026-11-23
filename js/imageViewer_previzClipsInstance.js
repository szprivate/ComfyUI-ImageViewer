// imageViewer_previzClipsInstance.js
// One Clip Sequencer: clips on tracks that blend, loop, retime and line up. The panel comes in instances
// (Sebastian 2026-11-23): the first one keeps the plain dock id "clips" and its state on the viewer
// (st === viewer, so this._csUI / this._csViewState / this._csSel stay where older callers read them); every
// further one is made here with a state object of its own. The clips themselves live in the scene
// (Q.seqOf, per tab, shared); what an instance keeps of its own is the time zoom, the selection, the focus
// and the span it last drew. The mixin (imageViewer_previzClips.js) is the facade and registers the maker.
//
// Every edit is one undo step of the 3D scene, then previzChanged - so the viewport, the rig, the render and
// the export all see the clips through scene3d.evaluateIn. An edit made in any instance refreshes them all.

import * as S from "./imageViewer_scene3d.js";
import * as R from "./imageViewer_rigData.js";
import * as Q from "./imageViewer_clipSeqData.js";
import { notice } from "./imageViewer_exportUI.js";

const HEAD_W = 200;      // the track headers' column
const ROW_H = 34;
const RULER_H = 20;
const EDGE_PX = 6;
const SNAP_PX = 7;
const MIN_PX = 0.5, MAX_PX = 60;

const STYLE = `
.cs-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; outline: none; position: relative; }
.cs-bar { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; padding: 5px 6px; border-bottom: 1px solid #262626; }
.cs-btn { background: #1e1e1e; color: #ccc; border: 1px solid #383838; border-radius: 4px; font-size: 11px; height: 22px; padding: 0 8px; cursor: pointer; white-space: nowrap; }
.cs-btn:hover { border-color: #f60; color: #fff; }
.cs-btn.on { color: #f60; border-color: #f60; }
.cs-btn[disabled] { opacity: 0.4; cursor: default; }
.cs-sub { color: #888; font-size: 11px; margin-left: auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cs-main { flex: 1 1 auto; min-height: 0; display: flex; overflow: hidden; }
.cs-heads { flex: 0 0 ${HEAD_W}px; overflow: hidden; border-right: 1px solid #262626; }
.cs-heads-in { position: relative; }
.cs-corner { height: ${RULER_H}px; border-bottom: 1px solid #262626; color: #666; font-size: 10px; line-height: ${RULER_H}px; padding-left: 6px; }
.cs-head { height: ${ROW_H}px; box-sizing: border-box; border-bottom: 1px solid #1d1d1d; display: flex; align-items: center; gap: 3px; padding: 0 4px; }
.cs-head.sel { background: #1b1b1b; }
.cs-head .cs-name { flex: 1 1 auto; min-width: 36px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #ccc; font-size: 11px; cursor: default; }
.cs-head input.cs-name { background: #111; border: 1px solid #f60; color: #fff; font-size: 11px; padding: 1px 3px; }
.cs-tb { flex: 0 0 auto; width: 20px; height: 18px; padding: 0; font-size: 10px; background: #1a1a1a; color: #888; border: 1px solid #333; border-radius: 3px; cursor: pointer; }
.cs-tb.on { color: #111; background: #f60; border-color: #f60; }
.cs-tb.solo.on { background: #e8c547; border-color: #e8c547; }
.cs-tb.mode { width: 28px; }
.cs-tb.mode.add { color: #6fd0ff; border-color: #2f6f8f; }
.cs-w { width: 34px; flex: 0 0 auto; background: #111; color: #9cf; border: 1px solid #333; border-radius: 3px; font-size: 10px; padding: 0 2px; height: 18px; }
.cs-scroll { flex: 1 1 auto; min-width: 0; overflow: auto; position: relative; }
.cs-area { position: relative; }
.cs-ruler { position: sticky; top: 0; height: ${RULER_H}px; background: #121212; border-bottom: 1px solid #262626; z-index: 3; cursor: ew-resize; }
.cs-tick { position: absolute; top: 0; bottom: 0; border-left: 1px solid #2a2a2a; color: #777; font-size: 9px; padding-left: 2px; pointer-events: none; }
.cs-tick.minor { top: 13px; color: transparent; }
.cs-shot { position: absolute; top: ${RULER_H}px; bottom: 0; background: rgba(255,255,255,0.025); pointer-events: none; }
.cs-row { position: relative; height: ${ROW_H}px; box-sizing: border-box; border-bottom: 1px solid #1d1d1d; }
.cs-row.locked { background: repeating-linear-gradient(135deg, transparent 0 6px, rgba(255,255,255,0.03) 6px 12px); }
.cs-row.muted .cs-clip { opacity: 0.4; }
.cs-row.landing { background: rgba(255,102,0,0.08); }
.cs-clip { --c: #4f8fd6; position: absolute; top: 3px; height: ${ROW_H - 7}px; box-sizing: border-box; border-radius: 4px; overflow: hidden;
    background: color-mix(in srgb, var(--c) 55%, #111); border: 1px solid color-mix(in srgb, var(--c) 80%, #fff 0%); cursor: grab; }
.cs-clip.sel { border-color: #fff; box-shadow: 0 0 0 1px #f60 inset; }
.cs-clip.mute { opacity: 0.35; }
.cs-clip .cs-cl { position: absolute; left: 5px; right: 4px; top: 2px; font-size: 10px; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; text-shadow: 0 1px 1px #000; }
.cs-clip .cs-badge { position: absolute; right: 4px; bottom: 2px; font-size: 9px; color: #fff; opacity: 0.85; pointer-events: none; }
.cs-clip .cs-seam { position: absolute; top: 0; bottom: 0; border-left: 1px dashed rgba(255,255,255,0.45); pointer-events: none; }
.cs-clip svg.cs-ramp { position: absolute; left: 0; top: 0; width: 100%; height: 100%; pointer-events: none; }
.cs-clip .cs-bh { position: absolute; top: 0; width: 7px; height: 7px; background: #fff; border: 1px solid #000; box-sizing: border-box; cursor: ew-resize; opacity: 0; }
.cs-clip:hover .cs-bh, .cs-clip.sel .cs-bh { opacity: 0.9; }
.cs-head-line { position: absolute; top: 0; bottom: 0; width: 1px; background: #f60; pointer-events: none; z-index: 4; }
.cs-snapline { position: absolute; top: 0; bottom: 0; width: 1px; background: #6fd0ff; pointer-events: none; z-index: 4; }
.cs-props { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; padding: 5px 6px; border-top: 1px solid #262626; color: #999; font-size: 11px; }
.cs-props label { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; }
.cs-props input[type=number], .cs-props input[type=text], .cs-props select { background: #111; color: #9cf; border: 1px solid #333; border-radius: 3px; font-size: 11px; height: 20px; }
.cs-props input[type=number] { width: 52px; }
.cs-props input[type=text] { width: 110px; color: #ddd; }
.cs-empty { padding: 14px; color: #777; font-size: 12px; line-height: 1.5; }
.cs-sources { display: none; }
`;

function fmt(x) { return String(Math.round(x * 100) / 100); }

/** The stylesheet once per root (the shadow root the panels live in); a detached host carries its own. */
function ensureStyle(host) {
    const root = host.getRootNode();
    const scope = (root && root.querySelector) ? root : host;
    if (scope.querySelector("style[data-clipseq]")) return;
    const style = host.ownerDocument.createElement("style");
    style.dataset.clipseq = "1";
    style.textContent = STYLE;
    scope.appendChild(style);
}

/**
 * Make a Clip Sequencer in `host`. `st` holds what this one keeps of its own (the viewer itself for the first
 * one, a fresh object for every further one); `saved` is the time zoom a layout carried for it, if anything.
 * Returns the instance the dock keeps: { el, refresh, frame, keyDown, wake, dispose, save, ... }.
 */
export function createClipsInstance(v, host, st, saved) {
    const doc = host.ownerDocument;
    if (!st._csViewState) st._csViewState = { px: 6, snap: true };
    if (saved) {
        if (typeof saved.px === "number" && Number.isFinite(saved.px)) st._csViewState.px = Math.max(MIN_PX, Math.min(MAX_PX, saved.px));
        if (typeof saved.snap === "boolean") st._csViewState.snap = saved.snap;
    }
    if (st._csSel === undefined) st._csSel = null;

    const view = () => st._csViewState;
    const csX = (f) => (f - st._csSpanNow.lo) * view().px;
    const csF = (x) => x / view().px + st._csSpanNow.lo;

    // ── Build ───────────────────────────────────────────────────────────────

    function ensureUi() {
        if (st._csUI && st._csUI.body.isConnected && st._csUI.body.parentNode === host) return st._csUI;
        ensureStyle(host);
        const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
        host.querySelectorAll(":scope > .cs-body, :scope > style[data-clipseq]").forEach((n) => n.remove());
        const body = el("div", "cs-body");
        body.tabIndex = 0;
        const bar = el("div", "cs-bar");
        const main = el("div", "cs-main");
        const heads = el("div", "cs-heads");
        const headsIn = el("div", "cs-heads-in");
        heads.append(headsIn);
        const scroll = el("div", "cs-scroll");
        const area = el("div", "cs-area");
        scroll.append(area);
        main.append(heads, scroll);
        const props = el("div", "cs-props");
        const empty = el("div", "cs-empty");
        body.append(bar, empty, main, props);
        host.append(body);
        const ui = { host, doc, el, body, bar, main, heads, headsIn, scroll, area, props, empty };
        st._csUI = ui;

        const btn = (label, title, run, cls = "") => {
            const b = el("button", `cs-btn ${cls}`, label);
            b.title = title;
            b.onclick = (e) => { e.stopPropagation(); run(b, e); };
            bar.append(b);
            return b;
        };
        ui.bAddTrack = btn("+ Track", "Add a track above the others", () => addTrack());
        ui.bCapture = btn("Clip from keys", "Move the selection's keys (a whole character's when one is selected) into a new clip", () => fromKeys());
        ui.bSources = btn("Add clip ▾", "Put a clip of an existing source at the playhead, or use a model's own file animations", (b) => sourcesMenu(b));
        ui.bMatch = btn("Match", "Line the selected clip up with the clip before it (position and facing) (M)", () => match());
        ui.bBake = btn("Bake to keys", "Turn what the clips play into keys on the items, and remove the clips (Ctrl+B)", () => bake());
        ui.bSnap = btn("Snap", "Snap to frames, clip edges and the playhead (hold Shift while dragging to switch off)", () => { const vw = view(); vw.snap = !vw.snap; v.previzRefreshClips(); });
        ui.bFit = btn("Fit", "Show the whole sequence (F)", () => fit());
        ui.sub = el("span", "cs-sub");
        bar.append(ui.sub);

        // The headers follow the strip up and down.
        scroll.addEventListener("scroll", () => { headsIn.style.transform = `translateY(${-scroll.scrollTop}px)`; });
        scroll.addEventListener("wheel", (e) => wheel(e), { passive: false });
        heads.addEventListener("wheel", (e) => { scroll.scrollTop += e.deltaY; e.preventDefault(); }, { passive: false });
        area.addEventListener("pointerdown", (e) => areaDown(e));
        area.addEventListener("contextmenu", (e) => e.preventDefault());
        body.addEventListener("pointerdown", () => { st._csFocused = true; body.focus({ preventScroll: true }); }, true);
        body.addEventListener("focusout", (e) => { if (!body.contains(e.relatedTarget)) st._csFocused = false; });
        // One observer per instance, watching this strip; a rebuild watches the new one.
        if (st._csResizeObs) { st._csResizeObs.disconnect(); st._csResizeObs = null; }
        if (typeof ResizeObserver !== "undefined") {
            st._csResizeObs = new ResizeObserver(() => { if (st._csUI) draw(st._csUI); });
            st._csResizeObs.observe(scroll);
        }
        return ui;
    }

    // ── Drawing ─────────────────────────────────────────────────────────────

    function draw(ui) {
        const scene = v._csScene();
        if (!scene) return;
        const q = v._csSeq(false);
        const vw = view();
        const tracks = q ? q.tracks : [];
        const hasAny = tracks.length > 0;
        ui.empty.style.display = hasAny ? "none" : "block";
        ui.main.style.display = hasAny ? "flex" : "none";
        ui.empty.textContent = "No clips yet. Key something (or a whole character), then Clip from keys - the keys move into a clip "
            + "you can move, loop, retime and blend with others. AI motion can land its takes here too (its dialog's “Land as a clip”). "
            + "A model with animations in its file: Add clip ▾.";
        ui.bSnap.classList.toggle("on", vw.snap);
        const sel = q && st._csSel && Q.findClip(q, st._csSel);
        if (!sel) st._csSel = null;
        ui.bMatch.disabled = !sel;
        ui.bBake.disabled = !hasAny;
        const nClips = tracks.reduce((n, t) => n + t.clips.length, 0);
        ui.sub.textContent = hasAny ? `${tracks.length} track${tracks.length === 1 ? "" : "s"} · ${nClips} clip${nClips === 1 ? "" : "s"}` : "";
        // A drag holds the strip's start where it was at the press: the frames under the pointer must not slide.
        const want = v._csSpan(scene, q);
        if (st._csDragSpan) want.lo = st._csDragSpan.lo, want.hi = Math.max(want.hi, st._csDragSpan.hi);
        st._csSpanNow = want;
        const span = st._csSpanNow;
        const width = Math.max(ui.scroll.clientWidth, (span.hi - span.lo) * vw.px);
        ui.area.style.width = `${width}px`;
        ui.area.replaceChildren();
        ui.headsIn.replaceChildren();
        if (!hasAny) { drawProps(ui, q, null); return; }

        // Ruler.
        const ruler = ui.el("div", "cs-ruler");
        const step = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].find((s) => s * vw.px >= 48) || 1000;
        const minor = step >= 5 ? step / 5 : step;
        for (let f = Math.ceil(span.lo / minor) * minor; f <= span.hi; f += minor) {
            const major = Math.abs(f / step - Math.round(f / step)) < 1e-9;
            const t = ui.el("div", major ? "cs-tick" : "cs-tick minor", major ? String(f) : "");
            t.style.left = `${csX(f)}px`;
            ruler.append(t);
        }
        ui.area.append(ruler);
        const shot = ui.el("div", "cs-shot");
        shot.style.left = `${csX(0)}px`;
        shot.style.width = `${(scene.length - 1) * vw.px}px`;
        ui.area.append(shot);
        ui.headsIn.append(ui.el("div", "cs-corner", "Tracks"));

        // Rows: the highest track on top.
        ui.rows = new Map();
        const order = [...tracks].reverse();
        for (const t of order) {
            ui.headsIn.append(head(ui, q, t));
            const row = ui.el("div", "cs-row");
            row.dataset.track = t.id;
            if (t.lock) row.classList.add("locked");
            const live = Q.liveTracks(q);
            if (!live.includes(t)) row.classList.add("muted");
            for (const c of t.clips) row.append(clipEl(ui, q, c));
            ui.area.append(row);
            ui.rows.set(t.id, row);
        }
        const line = ui.el("div", "cs-head-line");
        ui.area.append(line);
        ui.headLine = line;
        playhead(ui);
        drawProps(ui, q, sel ? sel.clip : null);
    }

    function playhead(ui) {
        if (!ui.headLine || !st._csSpanNow) return;
        ui.headLine.style.left = `${csX(Math.round(v.currentFrame || 0))}px`;
    }

    function head(ui, q, t) {
        const h = ui.el("div", "cs-head");
        h.dataset.track = t.id;
        const name = ui.el("span", "cs-name", t.name);
        name.title = `${t.name} - double-click to rename, right-click for more`;
        name.ondblclick = () => renameTrack(h, name, t);
        const tb = (label, cls, on, title, run) => {
            const b = ui.el("button", `cs-tb ${cls}${on ? " on" : ""}`, label);
            b.title = title;
            b.onclick = (e) => { e.stopPropagation(); run(); };
            return b;
        };
        const mode = tb(t.mode === "additive" ? "ADD" : "OVR", `mode${t.mode === "additive" ? " add" : ""}`, false,
            t.mode === "additive" ? "Additive: the clips add their change on top of what is below" : "Override: the clips replace what is below (by their weight)",
            () => trackEdit(t.id, "track mode", (tr) => { tr.mode = tr.mode === "additive" ? "override" : "additive"; }));
        const m = tb("M", "mute", t.mute, "Mute: the track does not play", () => trackEdit(t.id, "mute track", (tr) => { tr.mute = !tr.mute; }, true));
        const s = tb("S", "solo", t.solo, "Solo: only soloed tracks play", () => trackEdit(t.id, "solo track", (tr) => { tr.solo = !tr.solo; }, true));
        const l = tb("\u{1F512}", "lock", t.lock, "Lock: its clips cannot be changed", () => trackEdit(t.id, "lock track", (tr) => { tr.lock = !tr.lock; }, true));
        const w = Object.assign(ui.el("input", "cs-w"), { type: "number", min: 0, max: 100, step: 5, value: Math.round(t.weight * 100) });
        w.title = "Track weight, %";
        w.onchange = () => trackEdit(t.id, "track weight", (tr) => { tr.weight = Math.max(0, Math.min(1, Number(w.value) / 100)); });
        w.onkeydown = (e) => e.stopPropagation();
        h.append(name, mode, w, m, s, l);
        h.oncontextmenu = (e) => {
            e.preventDefault();
            v._previzOpenMenu([
                { label: "Rename…", run: () => renameTrack(h, name, t) },
                { label: "Add track above", run: () => addTrack(t.id) },
                { label: "Move up", run: () => edit("move track", (qq) => Q.moveTrack(qq, t.id, 1)) },
                { label: "Move down", run: () => edit("move track", (qq) => Q.moveTrack(qq, t.id, -1)) },
                "-",
                { label: "Delete track", disabled: t.lock, title: t.lock ? "The track is locked." : "", run: () => edit("delete track", (qq) => Q.removeTrack(qq, t.id)) },
            ], e.clientX, e.clientY);
        };
        return h;
    }

    function renameTrack(h, name, t) {
        const d = h.ownerDocument;
        const input = Object.assign(d.createElement("input"), { className: "cs-name", value: t.name });
        name.replaceWith(input);
        input.focus(); input.select();
        let done = false;
        const finish = (ok) => {
            if (done) return; done = true;
            const val = input.value.trim();
            if (ok && val && val !== t.name) trackEdit(t.id, "rename track", (tr) => { tr.name = val; }, true);
            else v.previzRefreshClips();
        };
        input.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); };
        input.onblur = () => finish(true);
    }

    function clipEl(ui, q, c) {
        const vw = view();
        const b = ui.el("div", "cs-clip");
        b.dataset.clip = c.id;
        b.style.setProperty("--c", Q.clipColor(q, c));
        const x0 = csX(c.start), w = Math.max(3, c.length * vw.px);
        b.style.left = `${x0}px`;
        b.style.width = `${w}px`;
        if (c.id === st._csSel) b.classList.add("sel");
        if (c.mute) b.classList.add("mute");
        const src = Q.sourceById(q, c.source);
        const label = Q.clipLabel(q, c);
        b.append(ui.el("span", "cs-cl", label));
        const bits = [];
        if (Math.abs(c.speed - 1) > 1e-6) bits.push(`${Math.round(c.speed * 100)}%`);
        if (c.loop) bits.push(`${c.loop === "pingpong" ? "⇄" : "↻"}×${Math.round(Q.turnsOf(c) * 10) / 10}`);
        if (c.weight < 1) bits.push(`w ${Math.round(c.weight * 100)}`);
        if (c.offset) bits.push("⌖");
        if (c.target && src && c.target !== src.model) bits.push("→");
        if (bits.length) b.append(ui.el("span", "cs-badge", bits.join(" ")));
        // Where a loop goes round.
        if (c.loop) {
            const turn = Q.clipSpan(c) / c.speed;
            for (let u = turn; u < c.length - 1e-6 && u / turn < 200; u += turn) {
                const s = ui.el("div", "cs-seam");
                s.style.left = `${u * vw.px}px`;
                b.append(s);
            }
        }
        // The ramps, as a shaded triangle at each end.
        const prev = v._csPrevOverlap(q, c);
        const bin = Math.max(c.blendIn, prev), bout = c.blendOut;
        if (bin > 0 || bout > 0) {
            const svg = ui.doc.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.setAttribute("class", "cs-ramp");
            svg.setAttribute("viewBox", `0 0 ${w} 100`);
            svg.setAttribute("preserveAspectRatio", "none");
            const poly = (pts) => {
                const p = ui.doc.createElementNS("http://www.w3.org/2000/svg", "polygon");
                p.setAttribute("points", pts);
                p.setAttribute("fill", "rgba(0,0,0,0.35)");
                svg.append(p);
            };
            if (bin > 0) poly(`0,0 ${bin * vw.px},0 0,100`);
            if (bout > 0) poly(`${w},0 ${w - bout * vw.px},0 ${w},100`);
            b.append(svg);
        }
        for (const side of ["in", "out"]) {
            const h = ui.el("div", "cs-bh");
            h.dataset.blend = side;
            const at = side === "in" ? c.blendIn * vw.px : w - c.blendOut * vw.px - 7;
            h.style.left = `${Math.max(0, Math.min(w - 7, at))}px`;
            h.title = side === "in" ? "Drag: blend in" : "Drag: blend out";
            b.append(h);
        }
        b.title = `${label}\n${src ? `${src.made === "ai" ? "AI motion" : src.kind === "file" ? "file animation" : "keys"} · ` : ""}frames ${fmt(c.start)}–${fmt(Q.clipEnd(c))}`
            + ` · source ${fmt(c.in)}–${fmt(c.out)}\nDrag: move · edges: trim · Alt+edge: retime · Ctrl+right edge: loop · right-click: more`;
        b.ondblclick = (e) => { e.stopPropagation(); v.setFrame(Math.round(c.start)); };
        b.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); select(c.id); clipMenu(c, e.clientX, e.clientY); };
        return b;
    }

    function drawProps(ui, q, c) {
        const props = ui.props;
        props.replaceChildren();
        if (!c) {
            props.append(ui.el("span", "", q && q.tracks.length ? "Select a clip to set its numbers." : ""));
            return;
        }
        const scene = v._csScene();
        const src = Q.sourceById(q, c.source);
        const field = (label, input, title) => { const l = ui.el("label", "", label); l.append(input); if (title) l.title = title; props.append(l); return input; };
        const numIn = (val, step = 1, min = null, max = null) => {
            const i = Object.assign(ui.el("input"), { type: "number", value: fmt(val), step });
            if (min !== null) i.min = min;
            if (max !== null) i.max = max;
            i.onkeydown = (e) => e.stopPropagation();
            return i;
        };
        const set = (label, patch) => edit(label, (qq) => Q.setClip(qq, c.id, patch));
        const name = Object.assign(ui.el("input"), { type: "text", value: c.name || "", placeholder: src ? src.name : "" });
        name.onkeydown = (e) => e.stopPropagation();
        name.onchange = () => set("rename clip", { name: name.value.trim() });
        field("Name", name);
        const start = field("Start", numIn(c.start));
        start.onchange = () => edit("move clip", (qq) => Q.moveClip(qq, c.id, Number(start.value)));
        const inp = field("In", numIn(c.in, 1, 0, src ? src.length : null), "Source frame the clip starts at");
        inp.onchange = () => set("clip in", { in: Math.max(0, Math.min(Number(inp.value), c.out - 1 / 64)) });
        const out = field("Out", numIn(c.out, 1, 0, src ? src.length : null), "Source frame the clip ends at");
        out.onchange = () => set("clip out", { out: Math.max(c.in + 1 / 64, Math.min(Number(out.value), src ? src.length : Infinity)) });
        const sp = field("Speed %", numIn(c.speed * 100, 5, Q.MIN_SPEED * 100, Q.MAX_SPEED * 100));
        sp.onchange = () => {
            const s = Math.max(Q.MIN_SPEED, Math.min(Q.MAX_SPEED, Number(sp.value) / 100));
            if (c.loop) set("clip speed", { speed: s, length: c.length * c.speed / s });
            else set("clip speed", { speed: s });
        };
        const loop = ui.el("select");
        for (const [val, l] of [["", "once"], ["cycle", "cycle"], ["pingpong", "ping-pong"]]) loop.append(Object.assign(ui.el("option", "", l), { value: val, selected: c.loop === val }));
        loop.onchange = () => set("clip loop", { loop: loop.value, length: loop.value ? Math.max(c.length, Q.naturalLength(c)) : undefined });
        field("Loop", loop);
        if (c.loop) {
            const len = field("Length", numIn(c.length, 1, 1));
            len.onchange = () => set("clip length", { length: Math.max(1, Number(len.value)) });
            const acc = Object.assign(ui.el("input"), { type: "checkbox", checked: c.accumulate, disabled: c.loop !== "cycle" });
            acc.onchange = () => set("clip accumulate", { accumulate: acc.checked });
            field("Walk on", acc, "Each turn starts where the last one ended (a walk cycle walks instead of running on the spot)");
        }
        const w = field("Weight %", numIn(c.weight * 100, 5, 0, 100));
        w.onchange = () => set("clip weight", { weight: Math.max(0, Math.min(1, Number(w.value) / 100)) });
        const bi = field("Blend in", numIn(c.blendIn, 1, 0));
        bi.onchange = () => set("blend in", { blendIn: Math.max(0, Number(bi.value)) });
        const bo = field("Blend out", numIn(c.blendOut, 1, 0));
        bo.onchange = () => set("blend out", { blendOut: Math.max(0, Number(bo.value)) });
        const pre = Object.assign(ui.el("input"), { type: "checkbox", checked: c.pre });
        pre.onchange = () => set("hold before", { pre: pre.checked });
        field("Hold before", pre, "Before the clip, hold its first pose");
        const post = Object.assign(ui.el("input"), { type: "checkbox", checked: c.post });
        post.onchange = () => set("hold after", { post: post.checked });
        field("Hold after", post, "After the clip, hold its last pose");
        // Which character it plays on (keys sources made on a rig, or a model's file animations).
        if (src && src.model) {
            const who = ui.el("select");
            const models = scene.items.filter((it) => it.kind === "model" && (src.kind === "file" ? it.id === src.model : R.isRigged(scene, it.id)));
            for (const m of models) who.append(Object.assign(ui.el("option", "", m.name + (m.id === src.model ? " (its own)" : "")), { value: m.id, selected: (c.target || src.model) === m.id }));
            if (!models.some((m) => m.id === src.model)) who.prepend(Object.assign(ui.el("option", "", "(gone)"), { value: src.model, selected: !c.target }));
            who.onchange = () => set("clip character", { target: who.value === src.model ? null : who.value });
            field("Plays on", who, "Play the clip on another rigged character: its controls are matched by role");
        }
        const mb = ui.el("button", "cs-btn", "Match previous");
        mb.title = "Line the clip up with the one before it: where it left the character and the way it faced";
        mb.onclick = () => match(c.id);
        props.append(mb);
        if (c.offset) {
            const cb = ui.el("button", "cs-btn", "Clear offset");
            cb.onclick = () => edit("clear offset", (qq) => { const x = Q.findClip(qq, c.id); if (x) delete x.clip.offset; return true; });
            props.append(cb);
        }
    }

    // ── Edits ───────────────────────────────────────────────────────────────

    /** One undo step: snapshot, `fn(q)` (false / null = nothing done), redraw everything. */
    function edit(label, fn, { make = true, quiet = false } = {}) {
        const scene = v._csScene();
        if (!scene) return null;
        const before = S.serializeScene(scene);
        const q = v._csSeq(make);
        if (!q) return null;
        const r = fn(q);
        if (!r || r.error) {
            // Nothing changed (or it was refused, before changing anything): no undo step for it.
            if (r && r.error && !quiet) notice("info", r.error);
            return r;
        }
        v._csPushUndo(label, before);
        v._csGrowShot(scene, q);
        v.previzChanged();
        v.previzRefreshClips();
        return r;
    }

    function trackEdit(id, label, fn, quiet = false) {
        void quiet;
        return edit(label, (q) => { const t = Q.trackById(q, id); if (!t) return null; fn(t); return t; });
    }

    function select(id) {
        st._csSel = id;
        v.previzRefreshClips();
    }

    function addTrack(above = null) {
        return edit("add track", (q) => Q.addTrack(q, { above }));
    }

    /** Move the selection's keys into a new clip, on a free track, where the keys were. */
    function fromKeys({ lo = null, hi = null, name = null } = {}) {
        const scene = v._csScene();
        if (!scene) return null;
        const t = v._csCaptureTargets();
        let frames = [];
        for (const id of t.ids) frames.push(...S.keyframeFrames(S.itemById(scene, id)));
        frames = frames.sort((a, b) => a - b);
        if (!frames.length) { notice("info", "Nothing keyed to make a clip of", "Key the selection (or a character's controls) first."); return null; }
        const a = lo ?? frames[0], b = hi ?? frames[frames.length - 1];
        if (!(b > a)) { notice("info", "A clip needs keys on at least two frames."); return null; }
        const q0 = v._csSeq(false);
        const n = q0 ? q0.sources.filter((s) => s.name.startsWith(t.name)).length + 1 : 1;
        let made = null;
        edit("clip from keys", (q) => {
            const src = Q.addSource(q, Q.captureSource(scene, t.ids, a, b, { name: name || `${t.name} ${n}`, model: t.model, keepAll: t.keepAll }));
            src.keep = true;
            const track = Q.trackWithRoom(q, a, b);
            made = Q.addClip(q, track.id, src.id, a);
            st._csSel = made.id;
            return made;
        });
        if (made && st === v && !v.isPanelDocked("clips")) v.setPanelDocked("clips", true);
        return made;
    }

    function sourcesMenu(anchor) {
        const scene = v._csScene();
        if (!scene) return;
        const q = v._csSeq(false);
        const at = Math.round(v.currentFrame || 0);
        const entries = [];
        for (const s of (q && q.sources) || []) {
            entries.push({ label: `${s.name} (${fmt(s.length)} f${s.made === "ai" ? ", AI" : s.kind === "file" ? ", file" : ""}) at frame ${at}`,
                run: () => place(s.id, at) });
        }
        const mv = v._modelView && v._modelView();
        const withClips = scene.items.filter((it) => it.kind === "model" && mv && mv._entries && (mv._entries.get(it.id) || {}).clips
            && mv._entries.get(it.id).clips.length);
        if (entries.length && withClips.length) entries.push("-");
        for (const m of withClips) {
            const n = mv._entries.get(m.id).clips.length;
            entries.push({ label: `${m.name}: its ${n} file animation${n === 1 ? "" : "s"} as sources`, run: () => fileSources(m.id) });
        }
        if (!entries.length) entries.push({ label: "No sources yet", disabled: true, title: "Make one with Clip from keys, AI motion (Land as a clip), or load a model with animations." });
        const r = anchor.getBoundingClientRect();
        v._previzOpenMenu(entries, r.left, r.bottom + 2, anchor);
    }

    /** A clip of an existing source at frame `at`, on the selected clip's track when it is free there. */
    function place(sourceId, at = Math.round(v.currentFrame || 0)) {
        return edit("add clip", (q) => {
            const src = Q.sourceById(q, sourceId);
            if (!src) return null;
            const cur = st._csSel && Q.findClip(q, st._csSel);
            const track = Q.trackWithRoom(q, at, at + src.length, cur && cur.track.id);
            const c = Q.addClip(q, track.id, src.id, at);
            st._csSel = c && c.id;
            return c;
        });
    }

    /**
     * A model's own animations (in its file) as sources. A rigged character's are baked onto its controls'
     * channels (so they blend with keyed and AI clips); a plain model's play as they are, weighted.
     */
    function fileSources(modelId) {
        const scene = v._csScene();
        const mv = v._modelView();
        const e = mv._entries.get(modelId);
        const model = S.itemById(scene, modelId);
        if (!e || !e.clips || !e.clips.length || !model) return 0;
        const fps = scene.fps || 24;
        const rigged = R.isRigged(scene, modelId) && e.mixer && e.bones && e.bones.size;
        let made = 0;
        edit("file animations", (q) => {
            e.clips.forEach((clip, i) => {
                const frames = Math.max(1, Math.ceil(clip.duration * fps));
                const name = clip.name || `${model.name} ${i + 1}`;
                if (q.sources.some((s) => s.model === modelId && (s.clip === i || s.fileClip === i))) return;
                let src;
                if (rigged) {
                    src = v._csBakeFileClip(modelId, e, clip, frames, name);
                    if (!src) return;
                    src.fileClip = i;
                } else src = Q.fileSource(model, i, name, frames);
                src.keep = true;
                Q.addSource(q, src);
                made++;
            });
            return made ? q : null;
        });
        if (made) notice("info", `${made} source${made === 1 ? "" : "s"} from ${model.name}'s file`, "Add clip ▾ puts them on the tracks.");
        else notice("info", "Nothing new to add", "Those animations are sources already.");
        return made;
    }

    function match(id = st._csSel) {
        const scene = v._csScene();
        if (!id) { notice("info", "Select the clip to line up."); return null; }
        return edit("match clip", (q) => {
            const at = Q.findClip(q, id);
            if (!at) return null;
            const r = Q.matchToPrevious(scene, q, at.clip);
            return r || { error: "There is no clip before this one on the same character to match to." };
        });
    }

    function bake() {
        const scene = v._csScene();
        let out = null;
        edit("bake clips", () => {
            out = Q.bakeToKeys(scene);
            return out.items ? out : { error: "Nothing to bake: the clips play on nothing that can take keys." };
        });
        if (out && out.items) notice("success", "Clips baked to keys", `${out.keys} keys on ${out.items} item${out.items === 1 ? "" : "s"}.`);
        return out;
    }

    function fit() {
        const ui = st._csUI;
        const scene = v._csScene();
        if (!ui || !scene) return;
        const q = v._csSeq(false);
        const r = q && Q.seqRange(q);
        const lo = Math.min(0, r ? r.lo : 0), hi = Math.max(scene.length, r ? r.hi : 0);
        const vw = view();
        vw.px = Math.max(MIN_PX, Math.min(MAX_PX, (ui.scroll.clientWidth - 20) / Math.max(1, hi - lo + 12)));
        v.previzRefreshClips();
        ui.scroll.scrollLeft = Math.max(0, csX(lo) - 6);
    }

    function clipMenu(c, x, y) {
        const q = v._csSeq(false);
        const at = Q.findClip(q, c.id);
        const locked = at && at.track.lock;
        const f = Math.round(v.currentFrame || 0);
        const lockNote = locked ? { disabled: true, title: "The track is locked." } : {};
        v._previzOpenMenu([
            { label: "Split at the playhead (S)", ...lockNote, disabled: locked || !(f > c.start && f < Q.clipEnd(c)) || !!c.loop,
              title: c.loop ? "A looping clip is not split." : "Put the playhead inside the clip.", run: () => split(c.id) },
            { label: "Duplicate (Ctrl+D)", run: () => edit("duplicate clip", (qq) => { const d = Q.duplicateClip(qq, c.id); st._csSel = d && d.id; return d; }) },
            { label: "Match to previous clip (M)", run: () => match(c.id) },
            "-",
            { label: c.loop === "cycle" ? "✓ Loop: cycle" : "Loop: cycle", run: () => edit("clip loop", (qq) => Q.setClip(qq, c.id, { loop: c.loop === "cycle" ? "" : "cycle", length: Math.max(c.length, Q.naturalLength(c) * 2) })) },
            { label: c.loop === "pingpong" ? "✓ Loop: ping-pong" : "Loop: ping-pong", run: () => edit("clip loop", (qq) => Q.setClip(qq, c.id, { loop: c.loop === "pingpong" ? "" : "pingpong", length: Math.max(c.length, Q.naturalLength(c) * 2) })) },
            { label: "Speed back to 100 %", disabled: Math.abs(c.speed - 1) < 1e-6, run: () => edit("clip speed", (qq) => Q.setClip(qq, c.id, c.loop ? { speed: 1, length: c.length * c.speed } : { speed: 1 })) },
            { label: c.mute ? "Unmute clip" : "Mute clip", run: () => edit("mute clip", (qq) => Q.setClip(qq, c.id, { mute: !c.mute })) },
            "-",
            { label: "Bake this clip to keys", run: () => bakeOne(c.id) },
            { label: "Delete (Del)", ...lockNote, run: () => edit("delete clip", (qq) => Q.removeClip(qq, c.id)) },
        ], x, y);
    }

    function split(id = st._csSel) {
        const f = Math.round(v.currentFrame || 0);
        return edit("split clip", (q) => {
            const r = Q.splitClip(q, id, f);
            if (r && r.b) st._csSel = r.b.id;
            return r;
        });
    }

    /** Bake one clip (alone: every other track muted for the bake) and take it away. */
    function bakeOne(id) {
        const scene = v._csScene();
        edit("bake clip", (q) => {
            const at = Q.findClip(q, id);
            if (!at) return null;
            const keepTracks = q.tracks;
            const c = at.clip;
            q.tracks = [{ ...at.track, clips: [c], mute: false, solo: false }];
            const r = Q.bakeToKeys(scene, { lo: c.start, hi: Q.clipEnd(c), keepClips: true });
            q.tracks = keepTracks;
            if (!r.items) return { error: "Nothing to bake." };
            at.track.clips = at.track.clips.filter((x) => x.id !== id);
            Q.pruneSources(q);
            return r;
        });
    }

    // ── Pointer ─────────────────────────────────────────────────────────────

    function wheel(e) {
        const ui = st._csUI;
        if (!ui) return;
        const vw = view();
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const r = ui.scroll.getBoundingClientRect();
            const x = e.clientX - r.left;
            const f = csF(x + ui.scroll.scrollLeft);
            vw.px = Math.max(MIN_PX, Math.min(MAX_PX, vw.px * Math.exp(-e.deltaY * 0.0015)));
            v.previzRefreshClips();
            ui.scroll.scrollLeft = csX(f) - x;
        } else if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX) && ui.scroll.scrollHeight <= ui.scroll.clientHeight + 1) {
            e.preventDefault();
            ui.scroll.scrollLeft += e.deltaY;
        }
    }

    function frameAt(e) {
        const ui = st._csUI;
        const r = ui.area.getBoundingClientRect();
        return csF(e.clientX - r.left);
    }

    function rowAt(e) {
        const ui = st._csUI;
        if (!ui.rows) return null;
        for (const [id, row] of ui.rows) {
            const r = row.getBoundingClientRect();
            if (e.clientY >= r.top && e.clientY < r.bottom) return id;
        }
        return null;
    }

    /** The moment a moving edge snaps to: whole frames always, edges and the playhead within SNAP_PX. */
    function snap(f, exceptId, e) {
        const vw = view();
        let best = Math.round(f);
        if (!vw.snap || (e && e.shiftKey)) { snapLine(null); return best; }
        const q = v._csSeq(false);
        const targets = [Math.round(v.currentFrame || 0), 0];
        for (const t of q.tracks) for (const c of t.clips) if (c.id !== exceptId) targets.push(c.start, Q.clipEnd(c));
        let hit = null, d = SNAP_PX / vw.px;
        for (const t of targets) if (Math.abs(t - f) < d) { d = Math.abs(t - f); hit = t; }
        snapLine(hit);
        return hit !== null ? hit : best;
    }

    function snapLine(f) {
        const ui = st._csUI;
        if (!ui) return;
        if (f === null) { if (ui.snapLine) ui.snapLine.remove(); ui.snapLine = null; return; }
        if (!ui.snapLine || !ui.snapLine.isConnected) { ui.snapLine = ui.el("div", "cs-snapline"); ui.area.append(ui.snapLine); }
        ui.snapLine.style.left = `${csX(f)}px`;
    }

    function areaDown(e) {
        const ui = st._csUI;
        if (!ui) return;
        const q = v._csSeq(false);
        if (!q) return;
        if (e.target.closest(".cs-ruler")) { if (e.button === 0) scrub(e); return; }
        if (e.button !== 0) return;
        const blk = e.target.closest(".cs-clip");
        if (!blk) {
            // A press on nothing: the selection goes, and it scrubs.
            if (st._csSel) { st._csSel = null; v.previzRefreshClips(); }
            return;
        }
        const id = blk.dataset.clip;
        const at = Q.findClip(q, id);
        if (!at) return;
        if (st._csSel !== id) { st._csSel = id; blk.classList.add("sel"); drawProps(ui, q, at.clip); }
        if (at.track.lock) return;
        const r = blk.getBoundingClientRect();
        const lx = e.clientX - r.left;
        const blend = e.target.closest(".cs-bh");
        let act;
        if (blend) act = blend.dataset.blend === "in" ? "blendIn" : "blendOut";
        else if (lx < EDGE_PX && r.width > EDGE_PX * 3) act = e.altKey ? "retime-in" : "trim-in";
        else if (lx > r.width - EDGE_PX && r.width > EDGE_PX * 3) act = e.altKey ? "retime-out" : (e.ctrlKey || e.metaKey) ? "loop" : "trim-out";
        else act = "move";
        drag(e, at.clip, act);
    }

    function scrub(e) {
        const go = (ev) => v.setFrame(Math.round(frameAt(ev)));
        go(e);
        const t = e.target;
        t.setPointerCapture && t.setPointerCapture(e.pointerId);
        const move = (ev) => go(ev);
        const up = () => { t.removeEventListener("pointermove", move); t.removeEventListener("pointerup", up); t.removeEventListener("pointercancel", up); };
        t.addEventListener("pointermove", move);
        t.addEventListener("pointerup", up);
        t.addEventListener("pointercancel", up);
    }

    /**
     * One drag: the press's scene is kept, every move recomputes from it (so a drag never accumulates
     * rounding), and the release makes it one undo step.
     */
    function drag(e, clip0, act) {
        const ui = st._csUI;
        const scene = v._csScene();
        const before = S.serializeScene(scene);
        const base = JSON.parse(JSON.stringify(Q.seqOf(scene)));
        const f0 = frameAt(e);
        const id = clip0.id;
        const cap = ui.body;
        st._csDragSpan = { ...st._csSpanNow };
        try { cap.setPointerCapture(e.pointerId); } catch (_) { /* a synthetic event */ }
        e.preventDefault();
        let moved = false;
        const apply = (ev) => {
            const q = JSON.parse(JSON.stringify(base));
            const at = Q.findClip(q, id);
            const c0 = at.clip;
            const df = frameAt(ev) - f0;
            if (!moved && Math.abs(df * view().px) < 3) return;
            moved = true;
            if (act === "move") {
                const start = snapMove(c0, c0.start + df, ev);
                const row = rowAt(ev);
                const target = row && Q.trackById(q, row);
                const ok = target && !target.lock ? target.id : at.track.id;
                Q.moveClip(q, id, start, ok);
                if (ui.rows) for (const [tid, rw] of ui.rows) rw.classList.toggle("landing", tid === ok && ok !== at.track.id);
            } else if (act === "trim-in" || act === "retime-in") {
                const edge = snap(c0.start + df, id, ev);
                (act === "trim-in" ? Q.trimClip : Q.retimeClip)(q, id, "in", edge - c0.start);
            } else if (act === "trim-out" || act === "retime-out" || act === "loop") {
                const edge = snap(Q.clipEnd(c0) + df, id, ev);
                const d = edge - Q.clipEnd(c0);
                if (act === "trim-out") Q.trimClip(q, id, "out", d);
                else if (act === "retime-out") Q.retimeClip(q, id, "out", d);
                else Q.loopExtend(q, id, d);
            } else if (act === "blendIn") {
                Q.setClip(q, id, { blendIn: Math.max(0, Math.round(c0.blendIn + df)) });
            } else if (act === "blendOut") {
                Q.setClip(q, id, { blendOut: Math.max(0, Math.round(c0.blendOut - df)) });
            }
            scene.sequencer = q;
            v._csGrowShot(scene, q);
            v.previzChanged({ persist: false, light: true });
            draw(ui);
        };
        const move = (ev) => apply(ev);
        const up = () => {
            cap.removeEventListener("pointermove", move);
            cap.removeEventListener("pointerup", up);
            cap.removeEventListener("pointercancel", up);
            snapLine(null);
            st._csDragSpan = null;
            if (ui.rows) for (const rw of ui.rows.values()) rw.classList.remove("landing");
            if (!moved) { v.previzRefreshClips(); return; }
            v._csPushUndo(act === "move" ? "move clip" : act.startsWith("blend") ? "blend" : act.startsWith("retime") ? "retime clip" : act === "loop" ? "loop clip" : "trim clip", before);
            v.previzChanged();
            v.previzRefreshClips();
        };
        cap.addEventListener("pointermove", move);
        cap.addEventListener("pointerup", up);
        cap.addEventListener("pointercancel", up);
    }

    /** A moved clip snaps by either edge. */
    function snapMove(c, start, e) {
        const vw = view();
        if (!vw.snap || e.shiftKey) { snapLine(null); return Math.round(start); }
        const a = snap(start, c.id, e);
        const dA = Math.abs(a - start);
        const b = snap(start + c.length, c.id, e) - c.length;
        const dB = Math.abs(b - start);
        const snappedA = Math.abs(a - Math.round(start)) > 1e-9 || dA < 1e-9;
        if (!snappedA && dB < SNAP_PX / vw.px && Math.abs(b + c.length - Math.round(start + c.length)) > 1e-9) { snapLine(b + c.length); return b; }
        snap(start, c.id, e);
        return a;
    }

    // ── Keys ────────────────────────────────────────────────────────────────

    /** Asked by the facade's clipSeqKeyDown; true when this panel took the key. */
    function keyDown(e) {
        const ui = st._csUI;
        if (!ui || !st._csFocused || !ui.body.isConnected || !v.isPrevizTab || !v.isPrevizTab()) return false;
        const path = e.composedPath ? e.composedPath() : [];
        if (!path.includes(ui.body)) return false;
        const k = e.key, ctrl = e.ctrlKey || e.metaKey;
        let done = true;
        if ((k === "Delete" || k === "Backspace") && st._csSel) edit("delete clip", (q) => Q.removeClip(q, st._csSel));
        else if (ctrl && (k === "d" || k === "D") && st._csSel) edit("duplicate clip", (q) => { const d = Q.duplicateClip(q, st._csSel); st._csSel = d && d.id; return d; });
        else if (ctrl && (k === "b" || k === "B")) bake();
        else if (!ctrl && (k === "s" || k === "S") && st._csSel) split();
        else if (!ctrl && (k === "m" || k === "M") && st._csSel) match();
        else if (!ctrl && (k === "f" || k === "F")) fit();
        else if (!ctrl && (k === "[" || k === "]")) { const vw = view(); vw.px = Math.max(MIN_PX, Math.min(MAX_PX, vw.px * (k === "]" ? 1.25 : 0.8))); v.previzRefreshClips(); }
        else if (k === "Escape" && st._csSel) { st._csSel = null; v.previzRefreshClips(); }
        else done = false;
        if (done) { e.preventDefault(); e.stopImmediatePropagation(); }
        return done;
    }

    // ── AI motion: a take lands as a clip ─────────────────────────────────────

    function landTake(modelId, from, to, savedTracks, name) {
        const scene = v.previzScene();
        const ctrls = R.controlsOf(scene, modelId);
        const src = Q.captureSource(scene, ctrls.map((c) => c.id), from, to, { name, model: modelId, made: "ai", remove: false, keepAll: true });
        for (const c of ctrls) if (savedTracks.has(c.id)) c.tracks = savedTracks.get(c.id);
        const q = Q.ensureSeq(scene);
        src.keep = true;
        Q.addSource(q, src);
        let track = [...q.tracks].reverse().find((t) => t.name.startsWith("AI takes") && !t.lock && Q.trackFree(t, from, to));
        if (!track) {
            const n = q.tracks.filter((t) => t.name.startsWith("AI takes")).length;
            track = Q.addTrack(q, { name: n ? `AI takes ${n + 1}` : "AI takes" });
        }
        const c = Q.addClip(q, track.id, src.id, from);
        st._csSel = c && c.id;
        v.previzChanged();
        if (v.isPanelDocked && !v.isPanelDocked("clips")) v.setPanelDocked("clips", true);
        v.previzRefreshClips();
        return c;
    }

    // ── The instance the dock keeps ──────────────────────────────────────────

    function refresh() {
        const ui = ensureUi();
        if (ui) draw(ui);
    }

    function frame() {
        const ui = st._csUI;
        if (!ui || !ui.body.isConnected) return;
        playhead(ui);
    }

    return {
        el: host,
        refresh,
        frame,
        keyDown,
        addTrack,
        fromKeys,
        place,
        fileSources,
        match,
        bake,
        fit,
        split,
        bakeOne,
        landTake,
        edit,
        select,
        wake() { refresh(); },
        save() { return { px: view().px, snap: view().snap }; },
        dispose() {
            if (st._csResizeObs) { st._csResizeObs.disconnect(); st._csResizeObs = null; }
        },
    };
}
// imageViewer_compWarpUI.js
// The Comp editor's side of the warps and trackers: their handles on the picture and their sections in the
// Parameters panel. Called by imageViewer_compEditor.js with a context `E` it builds each time (its helpers and
// state), so this file holds only what these nodes need and the editor stays one place for the rest.
//
//   CornerPin       four "to" corners (squares) and four "from" corners (rings) dragged on the picture
//   GridWarp        the destination grid's points dragged; Shift + drag moves a source point
//   LensDistortion  lines drawn along things that are straight (Draw lines), Solve finds k1 / k2 from them
//   Tracker         points placed with + Point and a click, dragged at any frame (a key there), tracked
//                   forward / back on the server (/imageviewer/comp_track, through the host's `track`), baked
//                   into a keyed Transform or CornerPin
//   PlanarTracker   a surface's four corners placed and dragged, tracked the same way, baked into a CornerPin
import * as C from "./imageViewer_compModel.js";
import * as W from "./imageViewer_compWarp.js";

export const CSS = `
.cp-over .cp-wpin{fill:#0009;stroke:#ffcf3a;stroke-width:1.5px;vector-effect:non-scaling-stroke;pointer-events:all;cursor:move}
.cp-over .cp-wpin.from{stroke:#3ad1ff}
.cp-over .cp-wpin:hover{stroke:#fff}
.cp-over .cp-wquad{fill:none;stroke:#ffcf3a;stroke-width:1px;vector-effect:non-scaling-stroke}
.cp-over .cp-wquad.from{stroke:#3ad1ff;stroke-dasharray:4 3}
.cp-over .cp-wlabel{fill:#fff;font:10px system-ui,sans-serif;pointer-events:none;paint-order:stroke;stroke:#000;stroke-width:2px}
.cp-over .cp-wgrid{fill:none;stroke:#ffcf3a;stroke-width:1px;vector-effect:non-scaling-stroke;opacity:.8}
.cp-over .cp-wgrid.src{stroke:#3ad1ff;stroke-dasharray:3 3;opacity:.5}
.cp-over .cp-wpt{fill:#0009;stroke:#ffcf3a;stroke-width:1.5px;vector-effect:non-scaling-stroke;pointer-events:all;cursor:move}
.cp-over .cp-wpt:hover{stroke:#fff}
.cp-over .cp-wline{fill:none;stroke:#ff6a1a;stroke-width:1.5px;vector-effect:non-scaling-stroke}
.cp-over .cp-wcatch{fill:transparent;pointer-events:all;cursor:crosshair}
.cp-over .cp-tbox{fill:none;stroke:#3ad1ff;stroke-width:1px;vector-effect:non-scaling-stroke}
.cp-over .cp-tbox.search{stroke-dasharray:4 3;opacity:.7}
.cp-over .cp-tbox.sel{stroke:#ffcf3a}
.cp-over .cp-tgrab{fill:transparent;pointer-events:all;cursor:move}
.cp-over .cp-tpath{fill:none;stroke:#3ad1ff;stroke-width:1px;vector-effect:non-scaling-stroke;opacity:.6}
.cp-over .cp-tpath.sel{stroke:#ffcf3a;opacity:.9}
.cp-over .cp-tlost{stroke:#ff3b30!important}
.cp-trk{display:flex;flex-direction:column;gap:3px;margin:6px 0}
.cp-trk-row{display:flex;align-items:center;gap:4px;padding:2px 4px;border-radius:3px;cursor:pointer}
.cp-trk-row.sel{background:#ffcf3a22;outline:1px solid #ffcf3a66}
.cp-trk-row input[type=number]{width:46px}
.cp-trk-row .cp-trk-name{flex:1;min-width:40px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cp-trk-row .cp-trk-info{color:#8a8a92;font-size:10px;white-space:nowrap}
.cp-trk-bar{display:flex;flex-wrap:wrap;gap:3px;align-items:center;margin:4px 0}
.cp-trk-bar .mg-btn.on{background:#ffcf3a;color:#111}
.cp-trk-note{color:#9a9aa2;font-size:11px;margin:2px 0 6px}
`;

/** The params these nodes edit in their own sections (not as plain rows). */
export const OWN_KINDS = new Set(["trackpoints", "plane", "lines", "points"]);
const HANDLED = new Set(["cornerpin", "gridwarp", "lensdistortion", "tracker", "planartracker"]);
export const draws = (type) => HANDLED.has(type);
const r3 = (v) => Math.round(v * 1000) / 1000;
const CORNER = ["bottom left", "bottom right", "top right", "top left"];

/** A drag on the picture that changes node `id` through `fn(n, xy0, xy, ev)` (in the pixels of its input): one undo step. */
function drag(E, e, id, fn) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    E.stage.setPointerCapture(e.pointerId);
    const xy0 = E.xy(e);
    let pushed = false;
    E.stage.onpointermove = (ev) => {
        const xy = E.xy(ev);
        if (!pushed) { if (Math.hypot(xy[0] - xy0[0], xy[1] - xy0[1]) * E.z < 2) return; E.begin(); pushed = true; }
        const n = E.node(id);
        if (!n) return;
        fn(n, xy0, xy, ev);
        E.live();
    };
    E.stage.onpointerup = () => {
        E.stage.onpointermove = null; E.stage.onpointerup = null;
        if (pushed) E.end();
    };
}

// ── on the picture ───────────────────────────────────────────────────────────

export function drawHandles(E, n) {
    if (n.type === "cornerpin") return drawPin(E, n);
    if (n.type === "gridwarp") return drawGrid(E, n);
    if (n.type === "lensdistortion") return drawLines(E, n);
    if (n.type === "tracker") return drawTracker(E, n);
    if (n.type === "planartracker") return drawPlane(E, n);
}

const pts = (a) => a.map((p) => `${p[0]},${p[1]}`).join(" ");

function drawPin(E, n) {
    const { from, to } = W.pinCorners((p) => C.paramAt(n, p, E.frame), E.inFmt(n));
    E.layer.append(E.svg("polygon", { class: "cp-wquad from", points: pts(from) }), E.svg("polygon", { class: "cp-wquad", points: pts(to) }));
    const h = 5 / E.z;
    [["from", from, "cp-wpin from"], ["to", to, "cp-wpin"]].forEach(([which, list, cls]) => list.forEach((q, k) => {
        const p = `${which}${k + 1}`;
        const elm = which === "to" ? E.svg("rect", { class: cls, x: q[0] - h, y: q[1] - h, width: 2 * h, height: 2 * h }) : E.svg("circle", { class: cls, cx: q[0], cy: q[1], r: h });
        elm.dataset.param = p;
        E.tip(elm, `${which === "to" ? "Where the" : "The pinned point at the"} ${CORNER[k]} corner ${which === "to" ? "goes" : "(from)"}: drag`);
        elm.addEventListener("pointerdown", (e) => drag(E, e, n.id, (m, xy0, xy) => E.set(m, p, [r3(q[0] + xy[0] - xy0[0]), r3(q[1] + xy[1] - xy0[1])])));
        E.layer.append(elm);
        if (which === "to") { const t = E.svg("text", { class: "cp-wlabel", x: q[0] + 7 / E.z, y: q[1] - 7 / E.z, "font-size": 10 / E.z }); t.textContent = String(k + 1); E.layer.append(t); }
    }));
}

function drawGrid(E, n) {
    const [sp] = C.gridPoints(n, E.frame, E.inFmt(n));
    const cols = Math.max(2, Math.min(16, Math.round(n.cols || 5))), rows = Math.max(2, Math.min(16, Math.round(n.rows || 5)));
    const raw = C.paramAt(n, "dst_points", E.frame);
    const dp = Array.isArray(raw) && raw.length === sp.length ? raw : sp;
    const P = (a, i, j) => [a[2 * (j * cols + i)], a[2 * (j * cols + i) + 1]];
    for (const [a, cls] of [[sp, "cp-wgrid src"], [dp, "cp-wgrid"]]) {
        for (let j = 0; j < rows; j++) E.layer.append(E.svg("polyline", { class: cls, points: pts([...Array(cols)].map((_, i) => P(a, i, j))) }));
        for (let i = 0; i < cols; i++) E.layer.append(E.svg("polyline", { class: cls, points: pts([...Array(rows)].map((_, j) => P(a, i, j))) }));
    }
    const r = 4 / E.z;
    for (let k = 0; k < cols * rows; k++) {
        const q = [dp[2 * k], dp[2 * k + 1]], s = [sp[2 * k], sp[2 * k + 1]];
        const c = E.svg("circle", { class: "cp-wpt", cx: q[0], cy: q[1], r });
        E.tip(c, "Drag: where this point goes · Shift + drag: the source grid's point");
        c.addEventListener("pointerdown", (e) => {
            const src = e.shiftKey;
            drag(E, e, n.id, (m, xy0, xy) => {
                const [s0] = C.gridPoints(m, E.frame, E.inFmt(m));
                const now = C.paramAt(m, "dst_points", E.frame);
                const d0 = Array.isArray(now) && now.length === s0.length ? now.slice() : s0.slice();
                if (src) {
                    const a = (Array.isArray(m.src_points) && m.src_points.length === s0.length ? m.src_points : s0).slice();
                    a[2 * k] = r3(s[0] + xy[0] - xy0[0]); a[2 * k + 1] = r3(s[1] + xy[1] - xy0[1]);
                    m.src_points = a;   // a destination never set follows it (gridPoints)
                    return;
                }
                d0[2 * k] = r3(q[0] + xy[0] - xy0[0]); d0[2 * k + 1] = r3(q[1] + xy[1] - xy0[1]);
                E.set(m, "dst_points", d0);
            });
        });
        E.layer.append(c);
    }
}

function drawLines(E, n) {
    const lines = Array.isArray(n.lines) ? n.lines : [];
    const drawing = E.st.lensDraw === n.id;
    if (drawing) {
        // Clicks anywhere on the picture add a point to the line being drawn; a double-click ends it.
        const F = E.inFmt(n), big = Math.max(F.width, F.height) * 4;
        const catcher = E.svg("rect", { class: "cp-wcatch", x: -big, y: -big, width: 2 * big + F.width, height: 2 * big + F.height });
        E.tip(catcher, "Click: a point on the line · double-click: end the line · Esc: stop drawing");
        catcher.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            e.preventDefault(); e.stopPropagation();
            const xy = E.xy(e).map(r3);
            E.mutate(() => {
                const m = E.node(n.id), ls = Array.isArray(m.lines) ? m.lines.map((l) => l.slice()) : [];
                if (!ls.length || E.st.lensNew) { ls.push([]); E.st.lensNew = false; }
                ls[ls.length - 1].push(xy);
                m.lines = ls;
            }, { structure: false });
        });
        catcher.addEventListener("dblclick", (e) => { e.stopPropagation(); E.st.lensNew = true; E.toast("Line ended: the next click starts another", "info"); });
        E.layer.append(catcher);
    }
    const r = 3.5 / E.z;
    lines.forEach((l, li) => {
        if (!Array.isArray(l) || !l.length) return;
        E.layer.append(E.svg("polyline", { class: "cp-wline", points: pts(l) }));
        l.forEach((q, k) => {
            const c = E.svg("circle", { class: "cp-wpt", cx: q[0], cy: q[1], r });
            E.tip(c, "Drag: move this point · Alt + click: take it away");
            c.addEventListener("pointerdown", (e) => {
                if (e.altKey && e.button === 0) {
                    e.preventDefault(); e.stopPropagation();
                    E.mutate(() => { const m = E.node(n.id); m.lines = m.lines.map((x, i) => (i === li ? x.filter((_, j) => j !== k) : x)).filter((x) => x.length); }, { structure: false });
                    return;
                }
                drag(E, e, n.id, (m, xy0, xy) => {
                    m.lines = m.lines.map((x, i) => (i === li ? x.map((p, j) => (j === k ? [r3(q[0] + xy[0] - xy0[0]), r3(q[1] + xy[1] - xy0[1])] : p)) : x));
                });
            });
            E.layer.append(c);
        });
    });
}

function drawTracker(E, n) {
    const list = (n.points && n.points.points) || [];
    if (E.st.trkPlace === n.id) {
        const F = E.inFmt(n), big = Math.max(F.width, F.height) * 4;
        const catcher = E.svg("rect", { class: "cp-wcatch", x: -big, y: -big, width: 2 * big + F.width, height: 2 * big + F.height });
        E.tip(catcher, "Click: put a point here · Esc: no");
        catcher.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            e.preventDefault(); e.stopPropagation();
            const xy = E.xy(e).map(r3);
            E.st.trkPlace = null;
            E.mutate(() => {
                const m = E.node(n.id), data = { points: ((m.points && m.points.points) || []).map((p) => Object.assign({}, p)) };
                let k = data.points.length + 1;
                while (data.points.some((p) => p.id === `track${k}`)) k++;
                data.points.push({ id: `track${k}`, name: `track ${k}`, on: true, pattern: [21, 21], search: [61, 61], keys: [[E.frame, xy[0], xy[1], 1]] });
                m.points = data;
                E.st.trkSel = `track${k}`;
            }, { structure: false });
        });
        E.layer.append(catcher);
    }
    list.forEach((pt) => {
        const sel = E.st.trkSel === pt.id;
        if (Array.isArray(pt.keys) && pt.keys.length > 1) E.layer.append(E.svg("polyline", { class: "cp-tpath" + (sel ? " sel" : ""), points: pts(pt.keys.map((k) => [k[1], k[2]])) }));
        if (!W.trackHas(pt.keys, E.frame)) return;
        const at = W.trackAt(pt.keys, E.frame);
        const [pw, ph] = pt.pattern || [21, 21], [sw, sh] = pt.search || [61, 61];
        const lost = pt.on === false;
        E.layer.append(E.svg("rect", { class: "cp-tbox search" + (sel ? " sel" : "") + (lost ? " cp-tlost" : ""), x: at[0] - sw / 2, y: at[1] - sh / 2, width: sw, height: sh }));
        const box = E.svg("rect", { class: "cp-tbox" + (sel ? " sel" : "") + (lost ? " cp-tlost" : ""), x: at[0] - pw / 2, y: at[1] - ph / 2, width: pw, height: ph });
        const grab = E.svg("rect", { class: "cp-tgrab", x: at[0] - pw / 2, y: at[1] - ph / 2, width: pw, height: ph });
        E.tip(grab, `${pt.name || pt.id}: drag to place it at this frame (a key here)`);
        grab.addEventListener("pointerdown", (e) => {
            E.st.trkSel = pt.id;
            drag(E, e, n.id, (m, xy0, xy) => {
                const data = { points: m.points.points.map((p) => (p.id === pt.id ? Object.assign({}, p, { keys: W.putKey(p.keys, [E.frame, r3(at[0] + xy[0] - xy0[0]), r3(at[1] + xy[1] - xy0[1]), 1]) }) : p)) };
                m.points = data;
            });
            if (e.button === 0) E.renderOverlay();
        });
        const k = 6 / E.z;
        E.layer.append(box, grab,
            E.svg("line", { class: "cp-hline solid", x1: at[0] - k, y1: at[1], x2: at[0] + k, y2: at[1] }),
            E.svg("line", { class: "cp-hline solid", x1: at[0], y1: at[1] - k, x2: at[0], y2: at[1] + k }));
        const t = E.svg("text", { class: "cp-wlabel", x: at[0] + pw / 2 + 3 / E.z, y: at[1] - ph / 2, "font-size": 10 / E.z });
        t.textContent = pt.name || pt.id;
        E.layer.append(t);
    });
}

function drawPlane(E, n) {
    const keys = n.plane && n.plane.keys;
    if (!Array.isArray(keys) || !keys.length) return;
    const q = W.quadAt(keys, E.frame), known = W.trackHas(keys, E.frame);
    const all = keys.map((k) => [[k[1], k[2]], [k[3], k[4]], [k[5], k[6]], [k[7], k[8]]]);
    for (let c = 0; c < 4; c++) if (all.length > 1) E.layer.append(E.svg("polyline", { class: "cp-tpath", points: pts(all.map((a) => a[c])) }));
    E.layer.append(E.svg("polygon", { class: "cp-wquad" + (known ? "" : " from"), points: pts(q) }));
    const h = 5 / E.z;
    q.forEach((p, k) => {
        const s = E.svg("rect", { class: "cp-wpin", x: p[0] - h, y: p[1] - h, width: 2 * h, height: 2 * h });
        E.tip(s, `The surface's ${CORNER[k]} corner: drag (a key at this frame)`);
        s.addEventListener("pointerdown", (e) => drag(E, e, n.id, (m, xy0, xy) => {
            const cur = W.quadAt(m.plane.keys, E.frame).map((c) => c.slice());
            cur[k] = [r3(p[0] + xy[0] - xy0[0]), r3(p[1] + xy[1] - xy0[1])];
            m.plane = Object.assign({}, m.plane, { keys: W.putKey(m.plane.keys, [E.frame, ...cur.flat(), 1]) });
        }));
        E.layer.append(s);
        const t = E.svg("text", { class: "cp-wlabel", x: p[0] + 7 / E.z, y: p[1] - 7 / E.z, "font-size": 10 / E.z });
        t.textContent = String(k + 1);
        E.layer.append(t);
    });
}

// ── in the Parameters panel ──────────────────────────────────────────────────

export function section(E, n) {
    if (n.type === "tracker") return trackerSection(E, n);
    if (n.type === "planartracker") return planeSection(E, n);
    if (n.type === "lensdistortion") return lensSection(E, n);
    if (n.type === "gridwarp") return gridSection(E, n);
    if (n.type === "cornerpin") E.pane.append(E.el("div", "cp-trk-note", "Drag the squares (where each corner goes) and the rings (the points pinned) on the picture. Corners: 1 bottom left, 2 bottom right, 3 top right, 4 top left."));
    return null;
}

function bakeBar(E, n) {
    const bar = E.el("div", "cp-trk-bar");
    bar.append(E.el("span", "cp-trk-info", "Make:"));
    for (const [how, label, tip] of [["stabilise", "Stabilise", "A keyed Transform (or CornerPin) that holds the picture still"],
        ["match-move", "Match-move", "A keyed Transform (or CornerPin) that moves another picture with the track"],
        ["corner pin", "Corner pin", "A keyed CornerPin from four points (or the surface): put a picture onto what was tracked"]]) {
        if (n.type === "planartracker" && how === "match-move") continue;
        bar.append(E.btn(label, tip, () => {
            let made = null;
            E.mutate(() => { made = C.bakeTrack(E.comp(), n.id, how); if (made) E.st.sel = [made.id]; });
            if (!made) E.toast(how === "corner pin" ? "A corner pin needs four points tracked at the reference frame and the frames to pin" : "Nothing is tracked at the reference frame yet", "warn");
            else E.toast(`${made.name || made.id} made beside the tracker: wire it to the picture it should move`, "success");
        }));
    }
    return bar;
}

/** Track buttons: from the playhead one frame or to the end, either way; Stop while it runs. */
function trackBar(E, n, run) {
    const bar = E.el("div", "cp-trk-bar");
    const running = E.st.trkRun && E.st.trkRun.node === n.id;
    if (running) {
        const r = E.st.trkRun;
        bar.append(E.btn("■ Stop", "Stop tracking (what is tracked stays)", () => { r.cancel = true; }, "on"), E.el("span", "cp-trk-info", `tracking… ${r.done || 0} / ${r.total || "?"}`));
        return bar;
    }
    const last = E.comp().format.frames - 1;
    bar.append(
        E.btn("◀◀", "Track backwards from here to the first frame", () => run(E.frame, 0)),
        E.btn("◀", "Track one frame back", () => run(E.frame, Math.max(0, E.frame - 1))),
        E.btn("▶", "Track one frame on", () => run(E.frame, Math.min(last, E.frame + 1))),
        E.btn("▶▶", "Track forwards from here to the last frame", () => run(E.frame, last)));
    return bar;
}

/** Starts a track job through the host and writes what comes back into the node as it comes (one undo step). */
async function startTrack(E, n, body, apply) {
    if (!E.o.track) { E.toast("Tracking needs the viewer's server", "warn"); return; }
    const run = { node: n.id, cancel: false, done: 0, total: Math.abs(body.to - body.from) + 1 };
    E.st.trkRun = run;
    E.begin();
    E.refresh(["props"]);
    try {
        const got = await E.o.track(Object.assign({ node: E.fid ? E.fid(n.id) : n.id, comp: E.root ? E.root() : E.comp() }, body), (s) => {
            run.done = s.done || 0; run.total = s.total || run.total;
            const m = E.node(n.id);
            if (m) { apply(m, s); E.live(); }
            E.refresh(["props"]);
        }, () => run.cancel);
        const m = E.node(n.id);
        if (got && m) apply(m, got);
        if (got && got.ok === false) E.toast("Tracking stopped: " + (got.message || "?"), "warn");
    } catch (err) {
        E.toast("Tracking failed: " + ((err && err.message) || err), "error");
    } finally {
        E.st.trkRun = null;
        E.end();
    }
}

function trackerSection(E, n) {
    const data = (n.points && n.points.points) || [];
    const box = E.el("div", "cp-trk");
    const head = E.el("div", "cp-trk-bar");
    head.append(E.btn(E.st.trkPlace === n.id ? "Click the picture…" : "+ Point", "Then click the picture where the point should be (at this frame)", () => {
        E.st.trkPlace = E.st.trkPlace === n.id ? null : n.id; E.renderOverlay(); E.refresh(["props"]);
    }, E.st.trkPlace === n.id ? "on" : ""));
    head.append(E.btn("Clear ◀", "Take the selected point's keys before this frame away (all points if none is selected)", () => clearKeys(E, n, "before")),
        E.btn("Clear ▶", "Take the selected point's keys after this frame away (all points if none is selected)", () => clearKeys(E, n, "after")));
    box.append(head);
    if (!data.length) box.append(E.el("div", "cp-trk-note", "No points yet: + Point, then click a corner or a spot with detail on the picture. Show the node above this one (1) if this one moves its picture."));
    data.forEach((pt) => {
        const row = E.el("div", "cp-trk-row" + (E.st.trkSel === pt.id ? " sel" : ""));
        row.onclick = () => { E.st.trkSel = E.st.trkSel === pt.id ? null : pt.id; E.refresh(["props"]); E.renderOverlay(); };
        const on = E.el("input"); on.type = "checkbox"; on.checked = pt.on !== false; on.title = "Used for the motion";
        on.onclick = (e) => e.stopPropagation();
        on.onchange = () => E.mutate(() => editPoint(E, n.id, pt.id, (p) => { if (on.checked) delete p.on; else p.on = false; }), { structure: false });
        const name = E.el("span", "cp-trk-name", pt.name || pt.id);
        const ks = Array.isArray(pt.keys) ? pt.keys : [];
        const info = E.el("span", "cp-trk-info", ks.length ? `${ks[0][0]}–${ks[ks.length - 1][0]}` : "–");
        info.title = "The frames it is known at";
        const size = (label, p, tip) => {
            const i = E.el("input"); i.type = "number"; i.min = 5; i.max = 400; i.step = 2; i.value = (pt[p] || [21, 21])[0]; i.title = tip;
            i.onclick = (e) => e.stopPropagation();
            i.onchange = () => { const v = Math.max(5, Math.min(400, Math.round(parseFloat(i.value) || 0))); E.mutate(() => editPoint(E, n.id, pt.id, (q) => { q[p] = [v, v]; }), { structure: false }); };
            return [E.el("span", "cp-trk-info", label), i];
        };
        const del = E.btn("×", "Take this point away", (e) => { e.stopPropagation(); E.mutate(() => { const m = E.node(n.id); m.points = { points: m.points.points.filter((p) => p.id !== pt.id) }; }, { structure: false }); });
        row.append(on, name, info, ...size("pat", "pattern", "The pattern's size: the box that is looked for, pixels"), ...size("search", "search", "How far it is looked for: the search box, pixels"), del);
        box.append(row);
    });
    const run = (from, to) => {
        const pts0 = data.filter((p) => p.on !== false && (!E.st.trkSel || p.id === E.st.trkSel) && W.trackHas(p.keys, from));
        if (!pts0.length) { E.toast("No point is placed at this frame: place one (+ Point), or go to a frame it is known at", "warn"); return; }
        startTrack(E, n, { from, to, points: pts0.map((p) => { const at = W.trackAt(p.keys, from); return { id: p.id, x: at[0], y: at[1], pattern: p.pattern, search: p.search }; }) },
            (m, s) => {
                if (!s.keys) return;
                m.points = { points: m.points.points.map((p) => {
                    const rows = s.keys[p.id];
                    if (!rows) return p;
                    let keys = p.keys || [];
                    const lo = Math.min(from, to), hi = Math.max(from, to);
                    // What is tracked replaces what was there in the frames it went through (not past where it was lost).
                    const reached = rows[rows.length - 1][0];
                    const a = Math.min(from, reached), b = Math.max(from, reached);
                    keys = keys.filter((k) => k[0] < Math.max(lo, a) || k[0] > Math.min(hi, b) || k[0] === from);
                    for (const r of rows) keys = W.putKey(keys, r);
                    return Object.assign({}, p, { keys });
                }) };
            });
    };
    box.append(trackBar(E, n, run));
    box.append(bakeBar(E, n));
    E.pane.append(box);
}

function editPoint(E, nid, pid, fn) {
    const m = E.node(nid);
    m.points = { points: m.points.points.map((p) => { if (p.id !== pid) return p; const q = Object.assign({}, p); fn(q); return q; }) };
}

function clearKeys(E, n, side) {
    const f = E.frame;
    const keep = (k) => (side === "before" ? k[0] >= f : k[0] <= f);
    E.mutate(() => {
        const m = E.node(n.id);
        if (m.type === "planartracker") { if (m.plane && m.plane.keys) m.plane = Object.assign({}, m.plane, { keys: m.plane.keys.filter(keep) }); return; }
        if (!m.points) return;
        m.points = { points: m.points.points.map((p) => (!E.st.trkSel || p.id === E.st.trkSel ? Object.assign({}, p, { keys: (p.keys || []).filter(keep) }) : p)) };
    }, { structure: false });
}

function planeSection(E, n) {
    const box = E.el("div", "cp-trk");
    const keys = n.plane && n.plane.keys;
    const head = E.el("div", "cp-trk-bar");
    head.append(E.btn(keys && keys.length ? "Place again" : "Place surface", "Four corners at this frame, in the middle of the picture: drag them onto the surface's corners", () => {
        const F = E.inFmt(n), w = F.width, h = F.height;
        E.mutate(() => { E.node(n.id).plane = { keys: [[E.frame, w * 0.3, h * 0.7, w * 0.7, h * 0.7, w * 0.7, h * 0.3, w * 0.3, h * 0.3, 1]] }; }, { structure: false });
    }), E.btn("Clear ◀", "Take the keys before this frame away", () => clearKeys(E, n, "before")), E.btn("Clear ▶", "Take the keys after this frame away", () => clearKeys(E, n, "after")));
    box.append(head);
    box.append(E.el("div", "cp-trk-note", keys && keys.length
        ? `Known at frames ${keys[0][0]}–${keys[keys.length - 1][0]}. Put the corners on a flat surface with detail (a screen, a wall, a sign) and track.`
        : "Place surface, drag the corners onto a flat surface with detail, then track."));
    const run = (from, to) => {
        if (!W.trackHas(keys, from)) { E.toast("The surface is not placed at this frame", "warn"); return; }
        startTrack(E, n, { from, to, quad: W.quadAt(keys, from) }, (m, s) => {
            if (!s.plane || !s.plane.length) return;
            const lo = Math.min(from, to), hi = Math.max(from, to), reached = s.plane[s.plane.length - 1][0];
            const a = Math.min(from, reached), b = Math.max(from, reached);
            let ks = ((m.plane && m.plane.keys) || []).filter((k) => k[0] < Math.max(lo, a) || k[0] > Math.min(hi, b) || k[0] === from);
            for (const r of s.plane) ks = W.putKey(ks, r);
            m.plane = Object.assign({}, m.plane, { keys: ks });
        });
    };
    if (keys && keys.length) box.append(trackBar(E, n, run), bakeBar(E, n));
    E.pane.append(box);
}

function lensSection(E, n) {
    const box = E.el("div", "cp-trk");
    const drawing = E.st.lensDraw === n.id;
    const lines = Array.isArray(n.lines) ? n.lines.filter((l) => l.length) : [];
    const bar = E.el("div", "cp-trk-bar");
    bar.append(E.btn(drawing ? "Done drawing" : "Draw lines", "Click points along something straight in the world (a horizon, a door frame); double-click ends a line. The plate is shown while you draw.", () => {
        if (drawing) { E.st.lensDraw = null; E.st.view = E.st.lensViewBefore || null; }
        else { E.st.lensDraw = n.id; E.st.lensNew = true; E.st.lensViewBefore = E.st.view; if (n.inputs[0]) E.st.view = n.inputs[0]; }
        E.refresh(["props", "stage", "graph"]);
    }, drawing ? "on" : ""));
    bar.append(E.btn("Solve", "Find k1 (and k2, with enough points) that make the lines straight", () => {
        const F = E.inFmt(n);
        const got = W.solveLens(lines, F.width, F.height, C.paramAt(n, "center", E.frame));
        if (got.error === null) { E.toast("Draw at least one line of three points or more first", "warn"); return; }
        E.mutate(() => {
            const m = E.node(n.id);
            m.k1 = Math.round(got.k1 * 1e5) / 1e5; m.k2 = Math.round(got.k2 * 1e5) / 1e5;
            if (m.tracks) { delete m.tracks.k1; delete m.tracks.k2; }
        }, { structure: false });
        E.toast(`k1 ${r3(got.k1)}, k2 ${r3(got.k2)}: the lines are within ${got.error.toFixed(2)} px of straight`, "success");
    }), E.btn("Clear lines", "Take every line away", () => E.mutate(() => { delete E.node(n.id).lines; }, { structure: false })));
    box.append(bar);
    box.append(E.el("div", "cp-trk-note", `${lines.length} line${lines.length === 1 ? "" : "s"}, ${lines.reduce((s, l) => s + l.length, 0)} points. Lines near the edges tell the most; spread them over the frame.`));
    E.pane.append(box);
}

function gridSection(E, n) {
    const bar = E.el("div", "cp-trk-bar");
    bar.append(E.btn("Reset grid", "Both grids even again (the destination's keys too)", () => E.mutate(() => {
        const m = E.node(n.id); delete m.src_points; delete m.dst_points; if (m.tracks) delete m.tracks.dst_points;
    }, { structure: false })), E.btn("Source = destination", "The source grid takes the destination's shape (to warp from there)", () => E.mutate(() => {
        const m = E.node(n.id), [, dp] = C.gridPoints(m, E.frame, E.inFmt(m));
        m.src_points = dp.map(r3); delete m.dst_points; if (m.tracks) delete m.tracks.dst_points;
    }, { structure: false })));
    E.pane.append(bar, E.el("div", "cp-trk-note", "Drag the grid's points on the picture; Shift + drag moves a source point. Changing the points across or down starts the grids again."));
}

/** Esc while placing a point or drawing lines: stop. True when it took the key. */
export function escape(E) {
    if (E.st.trkPlace) { E.st.trkPlace = null; E.refresh(["props", "stage"]); return true; }
    if (E.st.lensDraw) { E.st.lensDraw = null; E.st.view = E.st.lensViewBefore || null; E.refresh(["props", "stage", "graph"]); return true; }
    return false;
}

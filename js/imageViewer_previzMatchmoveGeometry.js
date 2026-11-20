// imageViewer_previzMatchmoveGeometry.js
// Geometry for the solve (PrevizMatchmoveGeometryMixin, onto the panel after PrevizMatchmoveDepthMixin): tracks
// pinned to known spots of geometry already in the 3D space - a box put where the real one stands, an imported
// set model, a scan - the way survey points are used on set.
//
//   Pins     - mm.survey [{id (a track's), X (the 3D space's axes and units), from {item, name, kind}, on}]; a pin
//              is made from the one track picked on the plate and a click on the geometry in the 3D view
//              (Model3DView.pickPointBegin: vertices and edges snap, else the surface), or typed numbers.
//   The solve - mm.settings.geometry off | align | hold; with 3 or more pins mm_solve gets `survey` and answers
//              IN the 3D space (`surveyed`, units "scene", solve.survey.pins how far each one lands off), so the
//              Matchmove group stays where it is (orientation reset) and Build puts the camera straight into the
//              geometry's world. src/matchmove_solve.py survey_fit.
//
// Written from scratch, clean-room.

import * as D from "./imageViewer_matchmoveData.js";
import { notice } from "./imageViewer_exportUI.js";

const GEOMETRY_LABELS = [["off", "Not used"], ["align", "Move the solve onto it"], ["hold", "Hold the solve to it"]];
const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(3) : v.toFixed(4));

const el = (doc, tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
};

export const PrevizMatchmoveGeometryMixin = {
    /** The matchmove's own items in the scene (its group and all under it): a pin never lands on those. */
    _mmBuiltIds(st) {
        const scene = this.previzScene && this.previzScene();
        const gid = st && st.mm.scene && st.mm.scene.group;
        const out = new Set();
        if (!scene || !gid) return out;
        out.add(gid);
        let grew = true;
        while (grew) {
            grew = false;
            for (const it of scene.items || []) if (it.parent && out.has(it.parent) && !out.has(it.id)) { out.add(it.id); grew = true; }
        }
        return out;
    },

    /** Pin track `id` at X (one undo step); answers the pin. */
    matchmovePin(id, X, from = null) {
        const st = this._mmCur();
        let err = null, pin = null;
        this._mmEdit("pin to geometry", (m) => { const r = D.setPin(m, id, X, from); if (r.error) err = r.error; else pin = r.pin; });
        if (err) throw new Error(err);
        if (st) st.pinPick = null;
        this._mmRender();
        this._mmDraw();
        return pin;
    },

    matchmoveUnpin(ids = null) {
        this._mmEdit(ids ? "pin removed" : "pins removed", (m) => D.removePins(m, ids));
        this._mmRender();
        this._mmDraw();
    },

    /**
     * Wait for a click on the geometry in the 3D view and pin track `id` there (the one track picked, when not
     * given). Answers a promise of the pin, or null when stopped (Esc, Stop, another pick).
     */
    matchmovePinPick(id = null) {
        const st = this._mmCur();
        if (!st) throw new Error("Open a 3D tab first.");
        const tid = id || (st.sel.size === 1 ? [...st.sel][0] : null);
        if (!tid) throw new Error("Pick one track on the plate first (the one whose spot you will click on the geometry).");
        const view = this._model3d;
        if (!view || !view.pickPointBegin) throw new Error("The 3D view is not up.");
        if (this.matchmovePlateMain && this._mmPlateMain) this.matchmovePlateMain(false);       // the 3D view must be seen
        return new Promise((resolve) => {
            st.pinPick = { id: tid };
            view.pickPointBegin({
                exclude: this._mmBuiltIds(st),
                onPick: (hit) => {
                    try {
                        resolve(this.matchmovePin(tid, hit.p, { item: hit.item, name: hit.name, kind: hit.kind }));
                    } catch (e) {
                        notice("error", "Not pinned", e.message);
                        resolve(null);
                    }
                },
                onEnd: (picked) => {
                    if (st.pinPick) st.pinPick = null;
                    if (!picked) resolve(null);
                    this._mmRender();
                },
            });
            this._mmRender();
        });
    },

    /** Stop waiting for a click on the geometry. */
    matchmovePinStop() {
        const view = this._model3d;
        if (view && view.pickPointActive && view.pickPointActive()) view.pickPointEnd(false);
        const st = this._mmCur(false);
        if (st) st.pinPick = null;
        this._mmRender();
    },

    /** The Solve step's Geometry fold. */
    _mmGeometrySection(ctx) {
        const { mm, st } = ctx;
        const pins = mm.survey || [];
        const on = pins.filter((p) => p.on !== false).length;
        const sv = mm.solve && mm.solve.survey;
        const summary = !pins.length ? "none" : sv && !sv.error && mm.solve.surveyed ? `${on} pins · placed` : `${on} pin(s)`;
        const g = this._mmFold(ctx, "solve-geometry", "Geometry", summary);
        this._mmNote(g, "Pin tracks to spots on geometry in the 3D space, as survey points. A box set where the real one stands, an imported set model or a scan: with 3 or more pins, not on one line, the solve lands in that space and its units, and Build puts the camera straight into it.");
        const use = this._mmSelect(g, GEOMETRY_LABELS, mm.settings.geometry || "hold",
                                   (v) => this._mmEdit("geometry", (m) => { m.settings.geometry = v; }));
        use.title = "Move the solve onto it: only placed, turned and scaled. Hold the solve to it: the pins also pull inside the solve, so the camera and focal length follow (mends a squashed solve).";
        use.classList.add("mm-geometry-mode");
        this._mmRow(g, "Use", use);
        const one = st.sel.size === 1 ? [...st.sel][0] : null;
        if (st.pinPick) {
            this._mmRow(g, "", el(ctx.doc, "span", "mm-note warn", `Click the spot of ${st.pinPick.id} on the geometry in the 3D view (Esc stops).`),
                        this._mmBtn(g, "Stop", () => this.matchmovePinStop()));
        } else {
            const b = this._mmBtn(g, one ? `Pin ${one} to geometry…` : "Pin to geometry…", () => this.matchmovePinPick(one),
                                  { primary: pins.length < D.MIN_PINS && !!one, disabled: !one,
                                    title: one ? "Then click its spot on a mesh in the 3D view: vertices and edges snap" : "Pick one track on the plate first" });
            b.classList.add("mm-pin-pick");
            this._mmRow(g, "", b);
        }
        // typed numbers, for a measured spot or one read off a plan
        const xyz = st.pinTyped || (st.pinTyped = [null, null, null]);
        const fields = xyz.map((v, k) => this._mmNum(g, v, (n) => { xyz[k] = n; }, { width: "50px" }));
        const typed = this._mmBtn(g, "Pin", () => {
            if (!xyz.every((v) => v !== null)) throw new Error("Type X, Y and Z.");
            this.matchmovePin(one, xyz.slice(), { item: "", name: "", kind: "typed" });
        }, { disabled: !one, title: one ? `Pin ${one} at these numbers (the 3D space's units)` : "Pick one track on the plate first" });
        this._mmRow(g, "At X Y Z", ...fields, typed);
        if (pins.length) {
            const list = el(ctx.doc, "div", "mm-list");
            for (const p of pins) {
                const r = D.pinResult(mm.solve, p.id);
                const li = el(ctx.doc, "div", "mm-li mm-pin", "");
                li.dataset.id = p.id;
                li.classList.toggle("sel", st.sel.has(p.id));
                const cb = el(ctx.doc, "input");
                cb.type = "checkbox";
                cb.checked = p.on !== false;
                cb.title = "Used in the solve";
                cb.onclick = (e) => e.stopPropagation();
                cb.onchange = () => this._mmEdit("pin on / off", (m) => { const q = (m.survey || []).find((x) => x.id === p.id); if (q) q.on = cb.checked; });
                const where = p.from && p.from.name ? ` · ${p.from.kind === "point" ? "a vertex of" : p.from.kind === "edge" ? "an edge of" : "on"} ${p.from.name}` : p.from && p.from.kind === "typed" ? " · typed" : "";
                li.append(cb, el(ctx.doc, "span", "grow", `${p.id} · ${p.X.map(fmt).join(", ")}${where}`));
                li.title = li.lastChild.textContent;
                if (r) li.append(el(ctx.doc, "span", r.used === false ? "mm-note bad" : r.ok ? "mm-good" : "mm-note warn",
                                    r.used === false ? "left out" : r.text));
                li.append(this._mmBtn(g, "×", () => this.matchmoveUnpin([p.id]), { title: "Remove this pin" }));
                li.onclick = () => {
                    st.sel = new Set([p.id]);
                    const t = mm.tracks.find((q) => q.id === p.id);
                    if (t && t.keys.length && this.setFrame) this.setFrame(t.keys[t.keys.length >> 1][0]);
                    this._mmRender(); this._mmDraw();
                };
                list.append(li);
            }
            g.box.append(list);
            if (on < D.MIN_PINS) this._mmNote(g, `${D.MIN_PINS - on} more pin(s) and the solve can use the geometry.`, "warn");
        }
        if (sv && sv.error) this._mmNote(g, `Not placed: ${sv.error}.`, "warn");
        if (mm.solve && mm.solve.mode === "tripod" && pins.length) this._mmNote(g, "A camera that only turns cannot use the pins yet.", "warn");
    },

    /** The Scene step's line for a solve placed on geometry. */
    _mmGeometrySceneNote(ctx) {
        const sv = ctx.mm.solve;
        if (!sv || !sv.surveyed) return;
        this._mmNote(ctx, "Placed on the geometry: Build puts the camera into the 3D space as it is. Setting the ground or the orientation here would move it off the geometry.", "");
    },

    /** The pins drawn on the plate: a ring round each pinned track (thicker when its pin holds). */
    _mmDrawPins(g, st, f, toScreen) {
        const pins = st.mm.survey || [];
        if (!pins.length) return;
        const by = new Map(st.mm.tracks.map((t) => [t.id, t]));
        g.save();
        g.lineWidth = 1.5;
        for (const p of pins) {
            const t = by.get(p.id);
            const k = t && t.keys.find((q) => q[0] === f);
            if (!k) continue;
            const [x, y] = toScreen(k[1], k[2]);
            const r = D.pinResult(st.mm.solve, p.id);
            g.strokeStyle = p.on === false ? "#777" : r && r.used === false ? "#ef6b6b" : "#ffd24a";
            g.beginPath();
            g.arc(x, y, 7, 0, Math.PI * 2);
            g.stroke();
            g.beginPath();
            g.moveTo(x, y - 10); g.lineTo(x, y - 7); g.moveTo(x, y + 7); g.lineTo(x, y + 10);
            g.moveTo(x - 10, y); g.lineTo(x - 7, y); g.moveTo(x + 7, y); g.lineTo(x + 10, y);
            g.stroke();
        }
        g.restore();
    },
};

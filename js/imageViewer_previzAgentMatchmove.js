// imageViewer_previzAgentMatchmove.js
// The agent's hands on the matchmove (imageViewer_previzMatchmove.js): the same steps the guide leads a person
// through - plate, lens, masks, tracks, solve, objects, into the scene - as actions of agentY-core's `matchmove`
// tool. They go the scene agent's road: POST /imageviewer/rig/agent (rig_routes.AGENT_ACTIONS) -> the page's
// previzRigAgentRun -> previzSceneAgent (SCENE_AGENT_ACTIONS) -> _asa_<action> here. Every change is one undo
// step of the Plate panel, as the same edit by hand is, and is saved into the tab's .mm.json; the panels are
// opened so the person sees what the agent does.
//
// Every action answers `info`'s summary (or the parts that changed), so the agent can read how good the track is
// after each step: the tracks a frame, the solve's error, its worst tracks and frames.
import * as D from "./imageViewer_matchmoveData.js";
import { canvasContext } from "./imageViewer_exportUI.js";

export const MATCHMOVE_AGENT_ACTIONS = [
    "matchmove_info", "matchmove_open", "matchmove_camera", "matchmove_lens", "matchmove_lens_export",
    "matchmove_mask", "matchmove_mask_remove", "matchmove_track", "matchmove_track_add", "matchmove_track_delete",
    "matchmove_track_set", "matchmove_solve", "matchmove_object_add", "matchmove_object_track", "matchmove_object_solve",
    "matchmove_build", "matchmove_orient", "matchmove_geometry", "matchmove_save", "matchmove_ground", "matchmove_ai_mask",
    "matchmove_measure",
];

const isNum = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
const round = (v, n = 3) => (isNum(v) ? Math.round(Number(v) * 10 ** n) / 10 ** n : null);
const stemOf = (p) => String(p || "").split(/[\\/]/).pop().replace(/\.mm\.json$|\.[^.]+$/, "").replace(/[.#%]+\d*d?$/, "").replace(/[._-]+$/, "") || "plate";

/** Frame runs [[a, b], ...] where `ok(i)` fails, for a short answer. */
function runsWhere(values, bad) {
    const out = [];
    let a = null;
    values.forEach((v, i) => {
        if (bad(v)) { if (a === null) a = i; }
        else if (a !== null) { out.push([a, i - 1]); a = null; }
    });
    if (a !== null) out.push([a, values.length - 1]);
    return out;
}

/** What the agent reads of a matchmove: enough to judge it, nothing as big as the keys. */
export function matchmoveSummary(mm, st = {}) {
    const out = { file: st.file || null, step: mm.step };
    const p = mm.plate;
    out.plate = p ? { path: p.path, frames: p.frames, width: p.width, height: p.height, fps: p.fps, kind: p.kind } : null;
    const c = mm.camera;
    out.camera = { focal_mm: c.focalMm, sensor_mm: c.sensor, focal_known: !!c.focalKnown, model: c.model || "", lens: c.lens || "",
                   pixel_aspect: D.pixelAspect(mm), preset: c.preset || "" };
    out.measurements = (mm.constraints || []).map((q) => {
        const r = D.constraintResult(mm.solve, q.id);
        return { id: q.id, kind: q.kind, ids: q.ids, ...(q.kind === "distance" ? { metres: q.value } : {}), on: q.on !== false,
                 ...(r ? { holds: r.ok, result: r.text } : {}) };
    });
    const L = mm.lens;
    out.lens = { source: L.source, k1: round(L.k1, 6), k2: round(L.k2, 6), center: L.center, fit_error_px: round(L.error),
                 coverage: round(L.coverage, 2), lines: L.lines.length, notes: L.notes || [],
                 ...(st.lensFocal ? { grid_focal_px: round(st.lensFocal, 1) } : {}) };
    out.masks = mm.masks.map((m) => ({ id: m.id, name: m.name, mode: m.mode, object: m.object || null, on: m.on, keys: m.keys.map((k) => k.f) }));
    out.objects = mm.objects.map((o) => {
        const sol = mm.objectSolves[o.id];
        return { id: o.id, name: o.name, tracks: mm.tracks.filter((t) => t.group === o.id).length,
                 ...(o.scale ? { scale: o.scale } : {}), solved: sol ? { rms: round(sol.rms), frames: Object.keys(sol.frames || {}).length } : null };
    });
    const s = mm.settings;
    out.settings = { features: s.n, min_ncc: s.minNcc, min_dist: s.minDist, from: s.from, to: s.to, mode: s.mode, refine: s.refine };
    if (mm.tracks.length) {
        const ts = D.trackStats(mm);
        out.tracks = { total: ts.tracks, camera: ts.camera, camera_on: ts.on, median_length: ts.medianLength,
                       fewest_on_a_frame: ts.leastPerFrame, thin_frames: ts.thin.slice(0, 12),
                       manual: mm.tracks.filter((t) => t.manual).map((t) => t.id).slice(0, 50) };
    } else out.tracks = { total: 0 };
    const sv = mm.solve;
    if (sv) {
        const per = Array.from({ length: p ? p.frames : 0 }, (_, f) => Number((sv.per_frame || {})[f]) || 0);
        const fmm = D.focalMmOf(sv.focal_px, mm);
        out.solve = {
            rms_px: round(sv.rms), verdict: D.solveVerdict(sv.rms), mode: sv.mode, frames: Object.keys(sv.frames || {}).length,
            focal_px: round(sv.focal_px, 2), focal_mm: fmm ? round(fmm, 2) : null, fov_v: round(sv.fov_v, 2),
            points: (sv.points || []).length,
            worst_tracks: (sv.points || []).slice().sort((a, b) => b.error - a.error).slice(0, 12).map((q) => [q.id, round(q.error, 2)]),
            frames_over_1px: runsWhere(per, (v) => v > 1).slice(0, 12),
            unsolved_frames: p ? runsWhere(per.map((_, f) => (sv.frames || {})[f]), (v) => !v).slice(0, 12) : [],
            notes: sv.notes || [],
            units: sv.units || "",
            ...(sv.focal_check ? { focal_check: sv.focal_check } : {}),
        };
    } else out.solve = null;
    out.built = mm.scene && mm.scene.group ? { group: mm.scene.group, camera: mm.scene.camera, plate: mm.scene.plate || null } : null;
    return out;
}

export const PrevizAgentMatchmoveMixin = {

    /** This tab's matchmove, its file read in; `plate` = one must be set. */
    async _amm({ plate = true, open = true } = {}) {
        const st = this._mmCur && this._mmCur();
        if (!st) throw new Error("the matchmove needs a 3D tab (none could be brought up)");
        if (st.loading) { await st.loading; st.loading = null; }
        if (st.busy) throw new Error(`the matchmove is busy (${st.busy.what}); wait, or ask again when it is done`);
        if (open) this._ammPanels();
        if (plate && !st.mm.plate) throw new Error("no plate yet: matchmove_open with plate = the film or one frame of the sequence");
        return st;
    },

    _ammPanels() {
        if (!this.setPanelDocked) return;
        if (!(this.isPanelDocked && this.isPanelDocked("mmGuide"))) this.setPanelDocked("mmGuide", true);
        if (!this._mmMain && !(this.isPanelDocked && this.isPanelDocked("mmPlate"))) {
            this.setPanelDocked("mmPlate", true);
            if (this.dockTabFront) this.dockTabFront("mmPlate");
        }
    },

    _ammStep(st, step) {
        if (D.STEP_IDS.includes(step)) st.mm.step = step;
        this._mmRender(true);
    },

    _ammAnswer(st, extra = {}) {
        return { ...extra, matchmove: matchmoveSummary(st.mm, st) };
    },

    _ammTrackIds(st, list) {
        const ids = (Array.isArray(list) ? list : [list]).filter((x) => x !== undefined && x !== null && x !== "").map(String);
        const have = new Set(st.mm.tracks.map((t) => t.id));
        const missing = ids.filter((id) => !have.has(id));
        if (missing.length) throw new Error(`no track ${missing.slice(0, 5).join(", ")}`);
        return ids;
    },

    _ammObject(st, w) {
        const os = st.mm.objects;
        if (w === undefined || w === null || w === "") {
            if (os.length === 1) return os[0];
            throw new Error(os.length ? "name the object (there is more than one)" : "there is no object: matchmove_object_add first");
        }
        const s = String(w).toLowerCase();
        const o = os.find((x) => x.id === w) || os.find((x) => x.name.toLowerCase() === s);
        if (!o) throw new Error(`no object ${w}: the objects are ${os.map((x) => x.name).join(", ") || "none"}`);
        return o;
    },

    // ── reading and opening ──────────────────────────────────────────────────

    async _asa_matchmove_info() {
        const st = await this._amm({ plate: false, open: false });
        return this._ammAnswer(st);
    },

    /** {plate} a film or a frame of a sequence: a new matchmove of it; {file} a .mm.json to go on with. */
    async _asa_matchmove_open(scene, a) {
        const st = await this._amm({ plate: false });
        if (a.file) {
            await this._mmLoadFile(st, String(a.file));
            if (st.loadError) { const e = st.loadError; st.loadError = null; throw new Error(e); }
            scene.matchmove = { ...(scene.matchmove || {}), file: st.file };
            if (this.previzPersist) this.previzPersist(st.key);
        } else if (a.plate || a.path) {
            await this.matchmoveSetPlate(String(a.plate || a.path));
            st.mm.step = "lens";
        } else if (!st.mm.plate) throw new Error("name the plate (a film, or one frame of a numbered sequence) or a .mm.json file");
        this._ammStep(st, st.mm.step);
        return this._ammAnswer(st, { facts: st.facts || null });
    },

    /** {preset (an id of CAMERA_PRESETS), focal_mm, sensor: [w, h] mm, known, pixel_aspect}: what the camera was; a known focal length is held by the solve unless refined. */
    async _asa_matchmove_camera(scene, a) {
        const st = await this._amm();
        if (a.preset !== undefined && a.preset !== "" && !D.CAMERA_PRESETS.some((p) => p.id === a.preset)) {
            throw new Error(`no camera preset ${a.preset}: ${D.CAMERA_PRESETS.map((p) => p.id).join(", ")}`);
        }
        if (a.pixel_aspect !== undefined && !(Number(a.pixel_aspect) >= 0.2 && Number(a.pixel_aspect) <= 5)) throw new Error("pixel_aspect is a pixel's width over its height, 0.2 .. 5");
        if (a.preset) this._mmEdit("camera preset", (m) => D.applyCameraPreset(m, a.preset));
        if (a.pixel_aspect !== undefined) this._mmEdit("pixel aspect", (m) => { m.camera.pixelAspect = Number(a.pixel_aspect); });
        if (a.focal_mm !== undefined && a.focal_mm !== null && !(Number(a.focal_mm) > 0)) throw new Error("focal_mm must be over 0 (or null: not known)");
        if (a.sensor !== undefined && !(Array.isArray(a.sensor) && a.sensor.length >= 2 && a.sensor.every((v) => Number(v) > 0))) {
            throw new Error("sensor is [width, height] in mm of the recorded part of the sensor");
        }
        this._mmEdit("camera", (m) => {
            if (a.focal_mm !== undefined) m.camera.focalMm = a.focal_mm === null ? null : Number(a.focal_mm);
            if (a.sensor !== undefined) m.camera.sensor = [Number(a.sensor[0]), Number(a.sensor[1])];
            if (a.known !== undefined) m.camera.focalKnown = !!a.known && !!m.camera.focalMm;
            else if (a.focal_mm !== undefined) m.camera.focalKnown = !!m.camera.focalMm;
        });
        return this._ammAnswer(st);
    },

    // ── the lens ─────────────────────────────────────────────────────────────

    /**
     * how: grid {path (default the plate), frames, kind auto | checker | lines} | lines (the lines drawn, or
     * {lines: [[[x, y], ...], ...]} in plate pixels) | comp {path} | set {k1, k2, center} | none.
     * fit_center, k2 (true / false / null = if the data allows) for grid and lines.
     */
    async _asa_matchmove_lens(scene, a) {
        const st = await this._amm();
        const how = String(a.how || "").toLowerCase();
        const k2 = a.k2 === true || a.k2 === false ? a.k2 : null;
        const fit = !!a.fit_center;
        const p = st.mm.plate;
        if (how === "none") {
            this._mmEdit("lens none", (m) => Object.assign(m.lens, { source: "none", k1: 0, k2: 0, center: null, error: null, coverage: null, notes: [] }));
        } else if (how === "set" || how === "typed") {
            if (!isNum(a.k1)) throw new Error("give k1 (and k2, center [x, y] in pixels if known)");
            const c = Array.isArray(a.center) && a.center.length >= 2 ? [Number(a.center[0]), Number(a.center[1])] : null;
            this._mmEdit("lens typed", (m) => Object.assign(m.lens, { source: "typed", k1: Number(a.k1), k2: Number(a.k2) || 0, center: c,
                                                                      error: null, coverage: null, notes: [] }));
        } else if (how === "grid") {
            const path = String(a.path || (st.mm.lens.grid || {}).path || p.path);
            const frames = (Array.isArray(a.frames) ? a.frames : (st.mm.lens.grid || {}).frames || [0])
                .map(Number).filter((n) => Number.isFinite(n) && n >= 0).slice(0, 12);
            const kind = ["checker", "lines"].includes(a.kind) ? a.kind : "auto";
            const d = await this._mmPost("/imageviewer/mm_lens_grid", { path, frames: frames.length ? frames : [0], kind, fit_center: fit, k2 });
            if (!d.points) throw new Error(`no chart found: ${(d.notes || []).join(" ") || "no checkerboard or grid of lines was seen"}`);
            this._mmEdit("lens from grid", (m) => {
                m.lens.grid = { path, frames, kind };
                Object.assign(m.lens, { k1: d.k1, k2: d.k2, center: d.center || null, error: d.error, coverage: d.coverage ?? null,
                                        notes: d.notes || [], source: "grid" });
            });
            st.lensFocal = d.focal_px || null;
        } else if (how === "lines") {
            let lines = st.mm.lens.lines;
            if (Array.isArray(a.lines)) {
                lines = a.lines.map((l) => (Array.isArray(l) ? l : []).filter((q) => Array.isArray(q) && isNum(q[0]) && isNum(q[1]))
                    .map((q) => [Number(q[0]), Number(q[1])])).filter((l) => l.length >= 3);
                if (!lines.length) throw new Error("each line is 3 or more [x, y] points (plate pixels) along something straight in the world");
            }
            if (!lines.length) throw new Error("no lines: give lines, or draw them in the Plate panel's Lines tool");
            const d = await this._mmPost("/imageviewer/mm_lens_lines", { width: p.width, height: p.height, lines, fit_center: fit, k2 });
            this._mmEdit("lens from lines", (m) => {
                m.lens.lines = lines;
                Object.assign(m.lens, { k1: d.k1, k2: d.k2, center: d.center || null, error: d.error, coverage: null, notes: d.notes || [], source: "lines" });
            });
        } else if (how === "comp") {
            if (!a.path) throw new Error("name the comp (a .comp.json with a Lens Distortion node): path");
            const d = await this._mmGet("/imageviewer/mm_from_comp", { path: String(a.path) });
            this._mmEdit("lens from comp", (m) => Object.assign(m.lens, { k1: d.k1, k2: d.k2, center: d.center || null, source: "comp", error: null,
                                                                          coverage: null, notes: [`From ${String(a.path).split(/[\\/]/).pop()}`] }));
        } else throw new Error("how is grid, lines, comp, set or none");
        st.frames.clear();
        this._ammStep(st, "lens");
        return this._ammAnswer(st);
    },

    /** to: comp (a .comp.json: the plate -> Lens Distortion -> Output) | stmap (an EXR ST map); mode: undistort | redistort. */
    async _asa_matchmove_lens_export(scene, a) {
        const st = await this._amm();
        const mm = st.mm;
        const mode = a.mode === "redistort" ? "redistort" : "undistort";
        let d;
        if ((a.to || "comp") === "comp") {
            d = await this._mmPost("/imageviewer/mm_to_comp", { path: mm.plate.path, lens: this._mmLens(mm), mode,
                                                                name: a.name || `${stemOf(mm.plate.path)}_lens_${mode}`, context: canvasContext() });
            if (a.open && this.compOpenFile) this.compOpenFile(d.path);
        } else if (a.to === "stmap") {
            d = await this._mmPost("/imageviewer/mm_stmap", { width: mm.plate.width, height: mm.plate.height, lens: this._mmLens(mm), mode,
                                                              name: a.name || `${stemOf(mm.plate.path)}_${mode}_stmap`, context: canvasContext() });
            if (this.exportLanded) this.exportLanded([d.path]);
        } else throw new Error("to is comp or stmap");
        return { path: d.path, mode, lens: this._mmLens(mm) };
    },

    // ── masks ────────────────────────────────────────────────────────────────

    /**
     * A mask (new, or {mask} to change one): keys [{frame, points: [[x, y], ...]}] in plate pixels (3+ corners; the
     * shape moves straight between keys, held before the first and after the last), mode exclude (keep tracks out:
     * people, cars, water, reflections, the sky) | object (its tracks are that object's), object, name, on.
     */
    async _asa_matchmove_mask(scene, a) {
        const st = await this._amm();
        const keys = (Array.isArray(a.keys) ? a.keys : []).map((k) => ({
            f: Math.round(Number(k && (k.frame ?? k.f))),
            pts: (Array.isArray(k && (k.points || k.pts)) ? (k.points || k.pts) : []).filter((q) => Array.isArray(q) && isNum(q[0]) && isNum(q[1]))
                .map((q) => [Number(q[0]), Number(q[1])]),
        }));
        if (keys.some((k) => !Number.isFinite(k.f) || k.pts.length < 3)) throw new Error("each key is {frame, points: [[x, y], ...]} with 3 or more corners, plate pixels");
        let obj = null;
        if (a.mode === "object" || a.object) obj = this._ammObject(st, a.object);
        let id = null;
        if (a.mask) {
            const w = String(a.mask).toLowerCase();
            const had = st.mm.masks.find((x) => x.id === a.mask) || st.mm.masks.find((x) => x.name.toLowerCase() === w);
            if (!had) throw new Error(`no mask ${a.mask}`);
            id = had.id;
        } else if (!keys.length) throw new Error("a new mask needs keys");
        this._mmEdit(a.mask ? "mask" : "new mask", (m) => {
            let mask = id && m.masks.find((x) => x.id === id);
            if (!mask) {
                mask = { id: D.newId(m, "k"), name: a.name || `Mask ${m.masks.length + 1}`, mode: "exclude", object: "", on: true, keys: [] };
                m.masks.push(mask);
            }
            if (a.name) mask.name = String(a.name);
            if (a.on !== undefined) mask.on = !!a.on;
            if (obj) { mask.mode = "object"; mask.object = obj.id; } else if (a.mode === "exclude") { mask.mode = "exclude"; mask.object = ""; }
            if (a.replace_keys) mask.keys = [];
            for (const k of keys) D.setMaskKey(mask, k.f, k.pts);
            id = mask.id;
        });
        this._ammStep(st, "masks");
        return this._ammAnswer(st, { mask: id });
    },

    async _asa_matchmove_mask_remove(scene, a) {
        const st = await this._amm();
        const w = String(a.mask || "").toLowerCase();
        const mask = st.mm.masks.find((x) => x.id === a.mask) || st.mm.masks.find((x) => x.name.toLowerCase() === w);
        if (!mask) throw new Error(`no mask ${a.mask}`);
        this._mmEdit("delete mask", (m) => { m.masks = m.masks.filter((x) => x.id !== mask.id); });
        return this._ammAnswer(st);
    },

    // ── tracks ───────────────────────────────────────────────────────────────

    /** Find and follow features: {features, min_ncc, min_dist, from, to}. Run again to add more where the shot is thin. */
    async _asa_matchmove_track(scene, a) {
        const st = await this._amm();
        const last = st.mm.plate.frames - 1;
        this._mmEdit("track settings", (m) => {
            const s = m.settings;
            if (isNum(a.features)) s.n = Math.max(8, Math.min(1000, Math.round(Number(a.features))));
            if (isNum(a.min_ncc)) s.minNcc = Math.max(0.3, Math.min(0.99, Number(a.min_ncc)));
            if (isNum(a.min_dist)) s.minDist = Math.max(0, Number(a.min_dist));
            if (isNum(a.from)) s.from = Math.max(0, Math.min(last, Math.round(Number(a.from))));
            if (a.to === null) s.to = null; else if (isNum(a.to)) s.to = Math.max(0, Math.min(last, Math.round(Number(a.to))));
        });
        const before = st.mm.tracks.length;
        this._ammStep(st, "track");
        await this.matchmoveAutoTrack();
        return this._ammAnswer(st, { added: st.mm.tracks.length - before });
    },

    /** Tracks by hand: points [{x, y, frame}] (frame: where the feature is at x, y; default the frame shown), followed both ways. */
    async _asa_matchmove_track_add(scene, a) {
        const st = await this._amm();
        const pts = Array.isArray(a.points) ? a.points : [];
        if (!pts.length || pts.some((q) => !q || !isNum(q.x) || !isNum(q.y))) throw new Error("points is [{x, y, frame}] in plate pixels");
        const ids = [];
        for (const q of pts.slice(0, 50)) {
            if (isNum(q.frame) && this.setFrame) this.setFrame(Math.max(0, Math.min(st.mm.plate.frames - 1, Math.round(Number(q.frame)))));
            if (a.object) st.trackGroup = this._ammObject(st, a.object).id;
            const before = new Set(st.mm.tracks.map((t) => t.id));
            await this.matchmoveAddTrackAt(Number(q.x), Number(q.y));
            const made = st.mm.tracks.find((t) => !before.has(t.id));
            if (made) ids.push(made.id);
            st.trackGroup = null;
        }
        return this._ammAnswer(st, { added: ids.map((id) => {
            const t = st.mm.tracks.find((x) => x.id === id);
            return { id, frames: t ? t.keys.length : 0 };
        }) });
    },

    /**
     * Delete tracks: ids, worst_share (0..0.5 of the solved tracks, the worst by error), error_over (px), shorter_than
     * (frames), all. Several may be given; what any of them names goes. The solve is kept until solved again.
     */
    async _asa_matchmove_track_delete(scene, a) {
        const st = await this._amm();
        const mm = st.mm;
        const gone = new Set();
        if (a.ids) for (const id of this._ammTrackIds(st, a.ids)) gone.add(id);
        if (isNum(a.worst_share) || isNum(a.error_over)) {
            if (!mm.solve) throw new Error("worst_share and error_over need a solve");
            const share = isNum(a.worst_share) ? Math.max(0, Math.min(0.5, Number(a.worst_share))) : 0;
            const px = isNum(a.error_over) ? Number(a.error_over) : Infinity;
            for (const id of D.withoutMeasured(mm, D.worstTracks(mm.solve, { share, px }))) gone.add(id);
        }
        if (isNum(a.shorter_than)) for (const id of D.shortTracks(mm, Math.round(Number(a.shorter_than)))) gone.add(id);
        if (a.all) for (const t of mm.tracks) gone.add(t.id);
        if (!gone.size) return this._ammAnswer(st, { deleted: 0 });
        this._mmEdit("delete tracks", (m) => { D.removeTracks(m, [...gone]); if (a.all) m.solve = null; });
        for (const id of gone) st.sel.delete(id);
        return this._ammAnswer(st, { deleted: gone.size });
    },

    /** Switch tracks off / on (ids, on) without deleting them; or move them to an object (object) or the camera (object: "camera"). */
    async _asa_matchmove_track_set(scene, a) {
        const st = await this._amm();
        const ids = new Set(this._ammTrackIds(st, a.ids));
        const group = a.object === undefined ? null : a.object === "camera" ? "camera" : this._ammObject(st, a.object).id;
        this._mmEdit("track set", (m) => {
            for (const t of m.tracks) if (ids.has(t.id)) {
                if (a.on !== undefined) t.on = !!a.on;
                if (group) t.group = group;
            }
        });
        return this._ammAnswer(st, { changed: ids.size });
    },

    // ── measurements ─────────────────────────────────────────────────────────

    /**
     * {add: {kind: distance | plane | line | right, ids (tracks, a right angle's in order end, corner, end), metres
     * (a distance)}} | {remove: id} | {clear: true}: real measurements the next solve keeps (distances set the
     * scale and with two or more the proportions; shapes pull the points into them).
     */
    async _asa_matchmove_measure(scene, a) {
        const st = await this._amm();
        let added = null;
        if (a.clear) this._mmEdit("measurements cleared", (m) => { m.constraints = []; });
        if (a.remove !== undefined) {
            if (!st.mm.constraints.some((q) => q.id === String(a.remove))) throw new Error(`no measurement ${a.remove}`);
            this._mmEdit("measurement removed", (m) => { m.constraints = m.constraints.filter((q) => q.id !== String(a.remove)); });
        }
        if (a.add) {
            const ids = this._ammTrackIds(st, a.add.ids || []);
            let err = null;
            this._mmEdit("measurement", (m) => {
                const r = D.addConstraint(m, a.add.kind, ids, a.add.metres ?? a.add.value);
                if (r.error) err = r.error; else added = r.constraint.id;
            });
            if (err) throw new Error(err);
        }
        return this._ammAnswer(st, added ? { added } : {});
    },

    // ── the solve ────────────────────────────────────────────────────────────

    /** {mode: auto | free | tripod, refine: auto | on | off (the focal length)} */
    async _asa_matchmove_solve(scene, a) {
        const st = await this._amm();
        if (st.mm.tracks.filter((t) => t.on).length < 8) throw new Error("a solve needs 8 or more tracks on every frame: matchmove_track first");
        this._mmEdit("solve settings", (m) => {
            if (["auto", "free", "tripod"].includes(a.mode)) m.settings.mode = a.mode;
            if (["auto", "on", "off"].includes(a.refine)) m.settings.refine = a.refine;
        });
        this._ammStep(st, "solve");
        const was = st.mm.solve;
        await this.matchmoveSolve();
        if (!st.mm.solve || st.mm.solve === was) throw new Error("the solve was stopped");
        return this._ammAnswer(st);
    },

    // ── objects ──────────────────────────────────────────────────────────────

    /** {name, keys (its mask, as matchmove_mask's)}: an object that moves on its own. */
    async _asa_matchmove_object_add(scene, a) {
        const st = await this._amm();
        let id;
        this._mmEdit("new object", (m) => {
            id = D.newId(m, "o");
            m.objects.push({ id, name: String(a.name || `Object ${m.objects.length + 1}`) });
        });
        if (Array.isArray(a.keys) && a.keys.length) await this._asa_matchmove_mask(scene, { keys: a.keys, mode: "object", object: id, name: `${a.name || "Object"} mask` });
        this._ammStep(st, "objects");
        return this._ammAnswer(st, { object: id });
    },

    async _asa_matchmove_object_track(scene, a) {
        const st = await this._amm();
        const o = this._ammObject(st, a.object);
        if (!st.mm.masks.some((m) => m.mode === "object" && m.object === o.id && m.on)) throw new Error(`${o.name} has no mask: matchmove_mask with mode object first`);
        const before = st.mm.tracks.length;
        await this.matchmoveTrackObject(o.id);
        return this._ammAnswer(st, { added: st.mm.tracks.length - before });
    },

    /** {object, scale}: its motion through the solved camera; scale = its size against the scene (blank: from the points). */
    async _asa_matchmove_object_solve(scene, a) {
        const st = await this._amm();
        if (!st.mm.solve) throw new Error("solve the camera first");
        const o = this._ammObject(st, a.object);
        if (isNum(a.scale)) this._mmEdit("object scale", (m) => { m.objects.find((x) => x.id === o.id).scale = Number(a.scale); });
        if (st.mm.tracks.filter((t) => t.group === o.id && t.on).length < 6) throw new Error(`${o.name} needs 6 or more tracks`);
        await this.matchmoveSolveObject(o.id);
        return this._ammAnswer(st);
    },

    // ── into the scene ───────────────────────────────────────────────────────

    /** {backplate: true}: the Matchmove group, the camera keyed every frame, the undistorted plate on it, the points. */
    async _asa_matchmove_build(scene, a) {
        const st = await this._amm();
        if (!st.mm.solve) throw new Error("solve the camera first");
        st.backplate = a.backplate !== false;
        this._ammStep(st, "scene");
        await this.matchmoveBuild();
        return this._ammAnswer(st);
    },

    /**
     * {how: ground (3+ points on the floor) | origin (1+, their middle) | x | z (2: the axis from the first to the
     * second) | scale (2, distance = how far apart they are in scene units), points: [track ids]}.
     */
    async _asa_matchmove_orient(scene, a) {
        const st = await this._amm();
        if (!st.mm.solve) throw new Error("solve the camera first");
        const how = String(a.how || "");
        const need = { ground: [3, Infinity], origin: [1, Infinity], x: [2, 2], z: [2, 2], scale: [2, 2] }[how];
        if (!need) throw new Error("how is ground, origin, x, z or scale");
        const solved = new Set((st.mm.solve.points || []).map((q) => q.id));
        const ids = this._ammTrackIds(st, a.points || []);
        const without = ids.filter((id) => !solved.has(id));
        if (without.length) throw new Error(`no 3D point for ${without.slice(0, 5).join(", ")} (deleted from the solve, or tracked after it)`);
        if (ids.length < need[0] || ids.length > need[1]) throw new Error(`${how} takes ${need[0] === need[1] ? need[0] : `${need[0]} or more`} points`);
        if (how === "scale" && !(Number(a.distance) > 0)) throw new Error("scale needs distance (scene units)");
        st.sel = new Set(ids);
        const before = JSON.stringify(st.mm.orient);
        this.matchmoveOrient(how, Number(a.distance) || 1);
        if (JSON.stringify(st.mm.orient) === before) throw new Error("not oriented (the points are in a line, or on one spot)");
        return this._ammAnswer(st, { orient: st.mm.orient });
    },

    /** {kind: plane (3+) | box | locator, points: [track ids]}: geometry on solved points, to check the track sticks. */
    async _asa_matchmove_geometry(scene, a) {
        const st = await this._amm();
        if (!this._mmGroupItem(st)) throw new Error("build into the scene first (matchmove_build)");
        const kind = ["plane", "box", "locator"].includes(a.kind) ? a.kind : null;
        if (!kind) throw new Error("kind is plane, box or locator");
        st.sel = new Set(this._ammTrackIds(st, a.points || []));
        if (this._mmPickedPoints(st).length < (kind === "plane" ? 3 : 1)) throw new Error(`${kind} needs ${kind === "plane" ? 3 : 1} or more solved points`);
        const n = scene.items.length;
        this.matchmoveGeometry(kind);
        const item = scene.items.length > n ? scene.items[scene.items.length - 1] : null;
        return { item: item ? { id: item.id, name: item.name } : null };
    },

    /**
     * {how: auto (every solved point) | points (track ids in `points`) | ai (SAM 3 looks for `prompt`, "ground" by
     * default) | depth (a depth model on a few frames; `workflow` picks it, `metres` (on) scales the world to metres with
     * the Metric one), scale? (ai / depth: the share of the plate's size the model runs at, 0.1..1, 1 = full), tolerance?
     * (% of the scene's size), lift? (scene units, after), flip?}: the world set on the ground.
     */
    async _asa_matchmove_ground(scene, a) {
        const st = await this._amm();
        if (!st.mm.solve) throw new Error("solve the camera first");
        if (!st.mm.scene || !st.mm.scene.group) throw new Error("build it in the scene first (matchmove_build)");
        const how = String(a.how || "auto");
        const tol = isNum(a.tolerance) ? Number(a.tolerance) : undefined;
        const scale = isNum(a.scale) ? Number(a.scale) : null;
        let g;
        if (how === "ai") g = await this.matchmoveGroundAI(a.prompt || "ground", { ask: false, scale });
        else if (how === "depth") g = await this.matchmoveGroundDepth({ workflow: a.workflow || null, metres: a.metres !== false, ask: false, scale });
        else if (how === "points") {
            const ids = this._ammTrackIds(st, a.points || []);
            if (ids.length < 3) throw new Error("points takes three or more track ids");
            g = this.matchmoveGroundFind({ ids, how: "region", tol });
        } else if (how === "auto") g = this.matchmoveGroundFind({ tol });
        else throw new Error("how is auto, points, ai or depth");
        if (!g) throw new Error("not run (stopped, or the model files are not here)");
        if (g.error) throw new Error(g.error);
        if (a.flip) this.matchmoveGroundFlip();
        if (isNum(a.lift) && Number(a.lift)) { st.liftStep = Math.abs(Number(a.lift)); this.matchmoveGroundLift(Math.sign(Number(a.lift))); }
        const gi = st.groundInfo || {};
        return this._ammAnswer(st, { ground: { points: g.count, of: gi.of, tilt: round(g.tilt, 2), below: g.below, ids: how === "depth" ? [] : g.ids.slice(0, 50),
                                               ...(how === "depth" ? { camera_height: round(gi.height, 3), metres_per_unit_before: gi.metres, in_metres: !!gi.metres, model: gi.model } : {}) },
                                     orient: st.mm.orient });
    },

    /**
     * {engine: objects (SAM 3, `prompt` = what to find) | background (a background remover: the subject), step?
     * (every Nth frame, 1), from?, to?, object? (an object's id: its mask), workflow?, scale? (the share of the plate's
     * size the model runs at, 0.1..1, 1 = full)}: a mask over the whole shot
     * from an AI model, one ComfyUI job. Track again after it.
     */
    async _asa_matchmove_ai_mask(scene, a) {
        const st = await this._amm();
        const engine = a.engine === "background" ? "background" : "objects";
        if (engine === "objects" && !String(a.prompt || "").trim()) throw new Error("say what to mask in prompt (person, car, water ...)");
        const id = await this.matchmoveAiMask({ engine, prompt: a.prompt || "", step: isNum(a.step) ? Number(a.step) : 1,
                                                from: isNum(a.from) ? Number(a.from) : 0, to: isNum(a.to) ? Number(a.to) : null,
                                                mode: a.object ? "object" : "exclude", object: String(a.object || ""), workflow: a.workflow || null, ask: false,
                                                scale: isNum(a.scale) ? Number(a.scale) : 1 });
        if (!id) throw new Error("not run (stopped, or the model files are not here: download them in the guide)");
        const m = st.mm.masks.find((q) => q.id === id);
        return this._ammAnswer(st, { mask: { id, name: m.name, frames: m.matte.frames.length } });
    },

    async _asa_matchmove_save() {
        const st = await this._amm();
        const path = await this._mmSave(st);
        if (!path) throw new Error(`not saved: ${st.saveError || "no plate"}`);
        return { path };
    },
};

// imageViewer_previzMatchmoveAI.js
// The Matchmove guide's ground and its AI masks (PrevizMatchmoveAIMixin, onto the panel beside
// PrevizMatchmoveMixin):
//
//   The ground  - found among the solved points by itself (D.findGround: the lowest wide level plane, the cameras
//                 above it), or among the tracks inside a shape drawn round the floor on the plate (the Ground
//                 tool), or among the tracks SAM 3 sees on "the ground" on a few frames (AI); then raised, lowered
//                 or flipped by hand. Each is one undo step of the matchmove and moves the built Matchmove group.
//                 Or from depth: a depth model (Depth Anything 3) on a few frames, each frame's depth scaled onto
//                 the solved tracks and put into the solve's world (POST mm_depth_place), so a floor with no
//                 tracks on it is still there; the Metric model also says how big a scene unit is in metres.
//   AI masks    - a matte over the whole shot from a ComfyUI workflow, ONE job for every frame asked for
//                 (POST /imageviewer/mm_matte, the server's matchmove_matte.py): SAM 3 by words, or a background
//                 remover. The mattes become a mask the tracker keeps features off (or gives to an object).
//
// The workflows are Paint's Generate built-ins, queued as Comp's AI nodes queue theirs (_paintPrompt,
// _paintQueue, _cpAiWaitAll), model files asked for first and fetched through Paint's routes.
// Written from scratch, clean-room.

import { api } from "../../scripts/api.js";
import * as D from "./imageViewer_matchmoveData.js";
import { notice } from "./imageViewer_exportUI.js";
import { showInstallLog } from "./imageViewer_installLog.js";

const AI_GROUND_FRAMES = 5;      // frames SAM 3 looks for the ground on
const AI_GROUND_SHARE = 0.6;     // a track on the ground in this share of the frames it was seen in
const MATTE_CACHE = 24;          // matte pictures kept for drawing
// The share of the plate's size the mask / depth models run at (their answers come back at the plate's size).
const WORK_SCALES = [["1", "Full size"], ["0.5", "Half size"], ["0.25", "Quarter size"]];
const workScale = (v) => { const n = Number(v); return n > 0 && n <= 1 ? n : 1; };

const el = (doc, tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
};

async function post(url, body) {
    const r = await api.fetchApi(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({ error: `${r.status} ${r.statusText}` }));
    if (!r.ok) throw Object.assign(new Error(d.error || `${r.status}`), { data: d, status: r.status });
    return d;
}

const mb = (n) => (n ? (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`) : "size not known");

export const PrevizMatchmoveAIMixin = {

    // ── the ground ───────────────────────────────────────────────────────────

    /** The solve's points as findGround takes them, only `ids` when given. */
    _mmGroundPoints(st, ids) {
        const keep = ids ? new Set(ids) : null;
        return ((st.mm.solve && st.mm.solve.points) || []).filter((q) => !keep || keep.has(q.id))
            .map((q) => ({ id: q.id, p: D.pointToScene(q.X) }));
    },

    /** An orientation made the matchmove's (one undo step) and put on the built group. */
    _mmApplyOrient(st, o, how) {
        this._mmEdit(`orient ${how}`, (m) => { m.orient = { R: o.R.slice(), t: o.t.slice(), s: o.s }; });
        const g = this._mmGroupItem(st);
        if (g) {
            this.previzSnapshot(`matchmove ${how}`);
            Object.assign(g, D.orientToItem(st.mm.orient));
            this.previzChanged();
        }
    },

    /**
     * The ground found and the world set on it: among every solved point, or only `ids` (a drawn region, the AI's
     * pick). Picks its points in the Plate panel, so they can be checked and the ground set again from a few.
     * Answers findGround's result (or {error}).
     */
    matchmoveGroundFind({ ids = null, how = "auto", tol, maxTilt } = {}) {
        const st = this._mmCur();
        if (!st || !st.mm.solve) { notice("warn", "No ground", "Solve the camera first."); return { error: "solve the camera first" }; }
        const pts = this._mmGroundPoints(st, ids);
        const g = D.findGround(pts, D.groundCameras(st.mm.solve), {
            tol: (tol || st.groundTol || 1.5) / 100, maxTilt: maxTilt || (ids ? 75 : 40) });
        if (g.error) {
            st.groundInfo = { how, error: g.error };
            notice("warn", "No ground found", g.error);
            this._mmRender();
            return g;
        }
        const o = D.orientFound(st.mm.orient, g, pts);
        if (o.error) { notice("warn", "Not oriented", o.error); return o; }
        this._mmApplyOrient(st, o, "ground");
        st.sel = new Set(g.ids);
        st.groundInfo = { how, count: g.count, of: pts.length, tilt: g.tilt, below: g.below, rms: g.rms, size: g.size, ids: g.ids.slice() };
        this._mmRender();
        this._mmDraw();
        return g;
    },

    matchmoveGroundLift(dir) {
        const st = this._mmCur();
        if (!st) return;
        const step = st.liftStep > 0 ? st.liftStep : 0.1;
        this._mmApplyOrient(st, D.orientLift(st.mm.orient, dir * step), dir > 0 ? "raise" : "lower");
        this._mmRender();
    },

    matchmoveGroundFlip() {
        const st = this._mmCur();
        if (!st) return;
        this._mmApplyOrient(st, D.orientFlip(st.mm.orient), "flip");
        this._mmRender();
    },

    /** A shape drawn round the floor on the plate (the Ground tool): its tracks are the ground's. */
    matchmoveGroundRegion(poly) {
        const st = this._mmCur();
        if (!st) return null;
        const f = Math.round(this.currentFrame || 0);
        const solved = new Set(((st.mm.solve && st.mm.solve.points) || []).map((q) => q.id));
        const ids = D.tracksInPolygon(st.mm, f, poly).filter((id) => solved.has(id));
        st.groundRegion = { f, pts: poly.map((p) => [p[0], p[1]]) };
        if (ids.length < 3) {
            notice("warn", "Too few points there", `${ids.length} solved track(s) inside the shape: draw round more of the floor, or on a frame with more tracks.`);
            this._mmDraw();
            return null;
        }
        return this.matchmoveGroundFind({ ids, how: "region" });
    },

    /**
     * The ground as SAM 3 sees it: the words (default "ground") looked for on a few frames spread over the solve
     * in ONE job; the solved tracks that stay on what it found are the ground's points, then findGround among them.
     */
    async matchmoveGroundAI(words, { ask = true, scale = null } = {}) {
        const st = this._mmCur();
        if (!st || !st.mm.solve) throw new Error("Solve the camera first.");
        const prompt = String(words || st.groundPrompt || "ground").trim() || "ground";
        const frames = this._mmSpreadFrames(st, AI_GROUND_FRAMES);
        const matte = await this._mmMatteRun(st, { engine: "objects", prompt, frames, what: `Looking for "${prompt}"`, ask,
                                                  scale: scale === null ? workScale(st.groundScale) : workScale(scale) });
        if (!matte) return null;
        const solved = new Set(st.mm.solve.points.map((q) => q.id));
        const points = {};
        for (const f of matte.frames) {
            points[f] = st.mm.tracks.filter((t) => solved.has(t.id)).map((t) => { const k = D.keyAt(t, f); return k ? [t.id, k[1], k[2]] : null; })
                .filter(Boolean);
        }
        const { votes } = await post("/imageviewer/mm_matte_sample", { matte: { ...matte, grow: 0 }, points });
        const ids = D.groundVotes(votes, AI_GROUND_SHARE);
        st.groundMatte = { pattern: matte.pattern, frames: matte.frames, width: matte.width, height: matte.height };
        if (ids.length < 3) {
            const e = `SAM 3 found "${prompt}" under ${ids.length} solved track(s) only: try other words (floor, road, grass), or draw round the floor.`;
            st.groundInfo = { how: "ai", error: e };
            notice("warn", "Not enough ground", e);
            this._mmRender();
            return { error: e };
        }
        return this.matchmoveGroundFind({ ids, how: "ai" });
    },

    /** n solved frames spread evenly over the solve. */
    _mmSpreadFrames(st, n) {
        const solved = Object.keys(st.mm.solve.frames).map(Number).sort((a, b) => a - b);
        const k = Math.min(n, solved.length);
        return [...new Set(Array.from({ length: k }, (_, i) => solved[Math.round((i * (solved.length - 1)) / Math.max(1, k - 1))]))];
    },

    /**
     * The ground from depth: a depth model on a few frames of the solve (one job), each frame's depth scaled onto
     * its solved tracks and taken into the solve's world as points; findGround among them (the cameras above) and
     * the world set on it. With a metric model and `metres`, the world is also scaled so a unit is a metre.
     * Answers findGround's result with {metres, height} (or {error}, or null when not run).
     */
    async matchmoveGroundDepth({ workflow = null, metres = true, ask = true, scale = null } = {}) {
        const st = this._mmCur();
        if (!st || !st.mm.solve) throw new Error("Solve the camera first.");
        const sv = st.mm.solve;
        const frames = this._mmSpreadFrames(st, AI_GROUND_FRAMES);
        const solved = new Map(sv.points.map((q) => [q.id, q.X]));
        const cams = {}, tracks = {};
        for (const f of frames) {
            cams[f] = { R: sv.frames[f].R, t: sv.frames[f].t };
            tracks[f] = st.mm.tracks.filter((t) => solved.has(t.id))
                .map((t) => { const k = D.keyAt(t, f); return k ? [k[1], k[2], ...solved.get(t.id)] : null; }).filter(Boolean);
        }
        const got = await this._mmMatteRun(st, { engine: "depth", frames, workflow, what: "Reading depth", ask,
            scale: scale === null ? workScale(st.groundScale) : workScale(scale),
            place: { url: "/imageviewer/mm_depth_place", body: { cams, tracks, focal: sv.focal_px, center: sv.center || null, lens: st.mm.lens || null } } });
        if (!got) return null;
        const pts = got.points.map((X, i) => ({ id: `d${i}`, p: D.pointToScene(X) }));
        const g = D.findGround(pts, D.groundCameras(sv), { tol: (st.groundTol || 1.5) / 100, maxTilt: 40 });
        if (g.error) {
            st.groundInfo = { how: "depth", error: g.error };
            notice("warn", "No ground in the depth", g.error);
            this._mmRender();
            return g;
        }
        const mpu = metres && got.metric && got.metres_per_unit > 0 ? got.metres_per_unit : null;
        const base = mpu ? { R: st.mm.orient.R.slice(), t: st.mm.orient.t.slice(), s: mpu } : st.mm.orient;
        const o = D.orientFound(base, g, pts);
        if (o.error) { notice("warn", "Not oriented", o.error); return o; }
        this._mmApplyOrient(st, o, mpu ? "ground and metres from depth" : "ground from depth");
        const heights = frames.map((f) => D.orientApply(st.mm.orient, D.cameraToItem(sv.frames[f].R, sv.frames[f].t).position)[1]).sort((a, b) => a - b);
        const height = heights[heights.length >> 1];
        st.groundInfo = { how: "depth", count: g.count, of: pts.length, tilt: g.tilt, below: g.below, rms: g.rms, size: g.size, ids: [],
                          metres: mpu, metric: !!got.metric, height, model: got.workflow, frames: got.frames.length };
        if (got.skipped && got.skipped.length) notice("info", `${got.skipped.length} frame(s) left out`, got.skipped.map((x) => `frame ${x.frame}: ${x.why}`).join("; "));
        this._mmRender();
        this._mmDraw();
        return { ...g, metres: mpu, height };
    },

    /** The Scene step's ground section (after Build). */
    _mmGroundSection(ctx) {
        const { st, doc } = ctx;
        this._mmNote(ctx, "The ground: found by itself, round a shape you draw on the floor, or by SAM 3. It sets the world level, at height 0.");
        const tol = this._mmNum(ctx, st.groundTol || 1.5, (v) => { st.groundTol = v > 0 ? v : 1.5; }, { width: "48px", min: 0.1, max: 20 });
        tol.title = "How far a point may lie off the ground, in % of the scene's size";
        this._mmRow(ctx, "", this._mmBtn(ctx, "Find the ground", () => this.matchmoveGroundFind(), { primary: true, title: "The lowest wide level surface among the solved points" }),
                    tol, el(doc, "span", "", "% off it"));
        this._mmRow(ctx, "", this._mmBtn(ctx, "Draw the ground", () => this.matchmoveTool("ground"), { title: "Click round the floor in the Plate panel, Enter to end" }));
        const words = el(doc, "input");
        words.type = "text";
        words.value = st.groundPrompt || "ground";
        words.style.width = "90px";
        words.onchange = () => { st.groundPrompt = words.value; };
        const ws = this._mmSelect(ctx, WORK_SCALES, String(workScale(st.groundScale)), (v) => { st.groundScale = workScale(v); });
        ws.title = "The size the SAM 3 and depth models see the plate at: smaller is quicker and lighter, with less detail";
        this._mmRow(ctx, "Models at", ws);
        this._mmRow(ctx, "", this._mmBtn(ctx, "Find with AI", () => this.matchmoveGroundAI(words.value), { title: "SAM 3 looks for these words on a few frames; the tracks on it are the ground's" }), words);
        const dl = this._mmMatteLists && this._mmMatteLists.get("depth");
        if (!dl) this._mmMatteList("depth").then(() => this._mmRender()).catch(() => {});
        else if (dl.workflows.length) {
            const dw = st.depthWorkflow && dl.workflows.some((w) => w.id === st.depthWorkflow) ? st.depthWorkflow : dl.choice;
            const pick = this._mmSelect(ctx, dl.workflows.map((w) => [w.id, `${w.label.replace(/\s*\(.*\)$/, "")}${(w.missing || []).some((m) => m.kind !== "node") ? " (downloads)" : ""}`]),
                                        dw, (v) => { st.depthWorkflow = v; this._mmRender(); });
            pick.style.maxWidth = "150px";
            const m = el(doc, "input");
            m.type = "checkbox";
            m.checked = st.depthMetres !== false;
            m.disabled = dw !== "comp_da3_metric";
            m.onchange = () => { st.depthMetres = m.checked; };
            m.title = "Scale the world so one unit is one metre (the Metric model only)";
            this._mmRow(ctx, "", this._mmBtn(ctx, "Find with depth", () => this.matchmoveGroundDepth({ workflow: dw, metres: m.checked }),
                                             { title: "A depth model on a few frames: the floor is found in its depth, even where there are no tracks" }),
                        pick, m, el(doc, "span", "", "metres"));
        } else this._mmNote(ctx, "Find with depth needs ComfyUI's Depth Anything 3 nodes (a recent ComfyUI).");
        const gi = st.groundInfo;
        if (gi && gi.error) this._mmNote(ctx, gi.error, "warn");
        else if (gi) {
            const by = { auto: "found among all points", region: "inside the drawn shape", ai: "on what SAM 3 took for the ground" }[gi.how] || "";
            if (gi.how === "depth") {
                const h = gi.metres ? `${gi.height.toFixed(2)} m` : `${gi.height.toFixed(2)} units`;
                this._mmNote(ctx, `Ground from the depth of ${gi.frames} frame(s): ${gi.count} of ${gi.of} depth points, ${gi.tilt.toFixed(1)}° off level for the cameras. The camera is ${h} above it${gi.metres ? `; one unit is a metre (a solve unit was ${gi.metres.toFixed(3)} m)` : ""}.`,
                             gi.tilt > 15 || gi.height <= 0 ? "warn" : "");
            } else this._mmNote(ctx, `Ground from ${gi.count} of ${gi.of} points (${by}), ${gi.tilt.toFixed(1)}° off level for the cameras${gi.below ? `, ${gi.below} point(s) below it` : ""}. They are picked in the Plate panel: unpick strays and use "Ground from picked".`,
                         gi.tilt > 15 ? "warn" : "");
        }
        const step = this._mmNum(ctx, st.liftStep || 0.1, (v) => { st.liftStep = v > 0 ? v : 0.1; }, { width: "52px", min: 0 });
        step.title = "How far Raise and Lower move the world (scene units)";
        this._mmRow(ctx, "", this._mmBtn(ctx, "Raise", () => this.matchmoveGroundLift(1)), this._mmBtn(ctx, "Lower", () => this.matchmoveGroundLift(-1)), step,
                    this._mmBtn(ctx, "Flip", () => this.matchmoveGroundFlip(), { title: "Upside down: the ground was found from below" }));
    },

    // ── AI mattes over the shot ──────────────────────────────────────────────

    async _mmMatteList(engine) {
        this._mmMatteLists = this._mmMatteLists || new Map();
        if (!this._mmMatteLists.has(engine)) this._mmMatteLists.set(engine, await post("/imageviewer/mm_matte_workflows", { engine }));
        return this._mmMatteLists.get(engine);
    },

    /** A question in the guide, answered by its buttons: true for `ok`. */
    _mmAsk(st, title, text, ok) {
        return new Promise((resolve) => {
            st.ask = { title, text, ok, resolve: (v) => { st.ask = null; this._mmRender(); resolve(v); } };
            this._mmRender();
        });
    },

    _mmAskBox(ctx) {
        const a = ctx.st.ask;
        if (!a) return;
        const box = el(ctx.doc, "div", "mm-facts mm-ask");
        box.append(el(ctx.doc, "div", "mm-title", a.title));
        const t = el(ctx.doc, "div", "mm-help", a.text);
        t.style.whiteSpace = "pre-wrap";
        box.append(t);
        const row = el(ctx.doc, "div", "mm-row");
        const yes = el(ctx.doc, "button", "mm-btn primary", a.ok);
        yes.onclick = () => a.resolve(true);
        const no = el(ctx.doc, "button", "mm-btn", "Not now");
        no.onclick = () => a.resolve(false);
        row.append(yes, no);
        box.append(row);
        ctx.box.append(box);
    },

    /** The workflow's model files: asked for, then fetched (Paint's routes). False when not now or stopped. */
    async _mmModelsReady(st, item, busy, ask = true) {
        const gone = (item.missing || []).filter((m) => m.kind !== "node");
        if (!gone.length) return true;
        if (!ask) throw new Error(`the model files it needs are not on this machine: ${gone.map((m) => `${m.what} (${m.folder})`).join(", ")} - download them from the Matchmove guide (Masks step) first`);
        const plan = await post("/imageviewer/paint/models", { workflow: item.id });
        const files = (plan.files || []).filter((f) => f.url);
        if (!files.length) return true;                 // nothing offered: the run says what is missing
        const list = files.map((f) => `• ${f.name} (${mb(f.size)}) into models/${f.folder}`).join("\n");
        if (!(await this._mmAsk(st, "Download the models?", `${item.label} needs model files that are not on this machine:\n${list}\nTogether ${mb(plan.total)}, from Hugging Face.`, "Download"))) return false;
        const { job } = await post("/imageviewer/paint/download", { workflow: item.id });
        showInstallLog(job, { host: this.container });
        busy.stop = () => { post("/imageviewer/paint/download", { job, cancel: true }).catch(() => {}); };
        let s;
        for (;;) {
            await new Promise((r) => setTimeout(r, 1000));
            s = await post("/imageviewer/paint/download", { job });
            busy.done = s.files.reduce((t, f) => t + (f.done || 0), 0);
            busy.total = s.files.reduce((t, f) => t + (f.size || 0), 0);
            busy.what = `Downloading ${item.label}`;
            this._mmRender();
            if (s.state !== "running") break;
        }
        busy.stop = null;
        if (s.state === "done") { this._mmMatteLists && this._mmMatteLists.clear(); return true; }
        if (s.state === "stopped" || busy.stopped) return false;
        throw new Error("the download did not work: " + (s.error || s.state));
    },

    /**
     * One AI matte job over `frames` of the plate: {pattern, frames, width, height, covered, ...} or null when not
     * run (models not fetched, stopped before anything came). Shows as the guide's busy line, Stop stops it.
     */
    async _mmMatteRun(st, { engine, prompt = "", frames, workflow = null, what = "AI mask", ask = true, place = null, scale = 1 }) {
        if (st.busy) throw new Error("Something runs already.");
        const mm = st.mm;
        const list = await this._mmMatteList(engine);
        const wid = workflow && list.workflows.some((w) => w.id === workflow) ? workflow : list.choice;
        if (!wid) throw new Error({ objects: "SAM 3 is not in this ComfyUI (its SAM3 nodes are needed).", depth: "Depth Anything 3 is not in this ComfyUI (a recent ComfyUI has its nodes)." }[engine] || "No background remover is installed in this ComfyUI.");
        const item = list.workflows.find((w) => w.id === wid);
        const busy = st.busy = { what, done: 0, total: frames.length, stop: null, stopped: false };
        this._mmRender();
        try {
            if (!(await this._mmModelsReady(st, item, busy, ask))) return null;
            busy.what = `${what}: preparing ${frames.length} frame(s)`;
            busy.total = frames.length;
            busy.done = 0;
            this._mmRender();
            const graph = await this._paintPrompt(item, () => {});
            const tune = (item.tune && item.tune.length && this._paintTune(wid)) || null;
            const prep = await post("/imageviewer/mm_matte", { path: mm.plate.path, engine, prompt, frames, workflow: wid, graph, tune, scale: workScale(scale) });
            if (busy.stopped) return null;
            const pid = await this._paintQueue(prep.graph);
            busy.what = `${what} (${item.label})`;
            this._mmRender();
            const run = { stop: null };
            busy.stop = () => { if (run.stop) run.stop(); };
            let images;
            try {
                images = await this._cpAiWaitAll(pid, prep.outputs, run, (k) => { busy.done = k; this._mmProgress(); });
            } catch (e) {
                if (!(e.images && Object.keys(e.images).length)) throw e;
                images = e.images;                         // stopped part way: keep what came
                notice("info", "Stopped", `${Object.keys(images).length} of ${prep.frames.length} frame(s) came back.`);
            }
            const placed = await post(place ? place.url : "/imageviewer/mm_matte_place", { ...(place ? place.body : {}), run: prep.run, images });
            if (prep.skipped && prep.skipped.length) notice("warn", `${prep.skipped.length} frame(s) left out`, prep.skipped.slice(0, 3).map((x) => `frame ${x.frame}: ${x.why}`).join("; "));
            return { ...placed, workflow: wid, engine, prompt, scale: prep.scale, work: [prep.work_width, prep.work_height] };
        } catch (e) {
            const miss = e.data && e.data.missing;
            if (miss && miss.length) throw new Error(`The workflow needs what is not here: ${miss.map((m) => (m.kind === "model" ? `${m.what} (${m.folder})` : `node ${m.what}`)).join(", ")}`);
            if (busy.stopped) return null;
            throw e;
        } finally {
            if (st.busy === busy) st.busy = null;
            this._mmRender();
        }
    },

    /**
     * An AI mask over the shot: the matte of every `step`-th frame (all of them by default; a frame in between takes
     * the one before) as a new mask - exclude, or an object's when `object` names one. Answers the mask's id.
     */
    async matchmoveAiMask({ engine = "objects", prompt = "", step = 1, from = 0, to = null, mode = "exclude", object = "", workflow = null, name = "", ask = true, scale = 1 } = {}) {
        const st = this._mmCur();
        if (!st || !st.mm.plate) throw new Error("Pick the plate first.");
        const last = st.mm.plate.frames - 1;
        const a = Math.max(0, Math.min(last, Math.round(from))), b = Math.max(a, Math.min(last, to === null ? last : Math.round(to)));
        const list = await this._mmMatteList(engine);
        const item = list.workflows.find((w) => w.id === (workflow || list.choice));
        // a video workflow takes the stretch as a film: every frame
        const k = item && item.video ? 1 : Math.max(1, Math.round(step) || 1);
        const frames = [];
        for (let f = a; f <= b; f += k) frames.push(f);
        if (frames[frames.length - 1] !== b) frames.push(b);
        const words = String(prompt || "").trim();
        const label = engine === "objects" ? (words || "objects") : "the subject";
        const got = await this._mmMatteRun(st, { engine, prompt: words, frames, workflow, what: `Masking ${label}`, ask, scale: workScale(scale) });
        if (!got) return null;
        let id;
        this._mmEdit("AI mask", (m) => {
            id = D.newId(m, "k");
            const obj = mode === "object" && m.objects.find((o) => o.id === object);
            m.masks.push(D.cleanMask({ id, name: name || (obj ? `${obj.name} (AI)` : `${engine === "objects" ? words || "Objects" : "Subject"} (AI)`),
                                       mode: obj ? "object" : "exclude", object: obj ? obj.id : "", on: true, keys: [],
                                       matte: { pattern: got.pattern, frames: got.frames, width: got.width, height: got.height,
                                                engine, prompt: words, grow: 6, threshold: 0.5 } }));
        });
        st.maskSel = id;
        this._mmRender();
        this._mmDraw();
        notice("info", "AI mask made", `${got.frames.length} frame(s) of ${label}${got.scale < 1 && got.work[0] ? `, run at ${got.work[0]} x ${got.work[1]}` : ""}; the tracker keeps features off it.`);
        return id;
    },

    /** The Masks step's AI section. */
    _mmMatteSection(ctx) {
        const { st, doc } = ctx;
        const o = st.aiMask || (st.aiMask = { engine: "objects", prompt: "person", step: 1 });
        this._mmNote(ctx, "Or let a model mask what moves over the whole shot, frame by frame, in one job:");
        const eng = this._mmSelect(ctx, Object.entries(D.MATTE_ENGINES), o.engine, (v) => { o.engine = v; o.workflow = null; this._mmRender(); });
        this._mmRow(ctx, "Model", eng);
        if (o.engine === "objects") {
            const words = el(doc, "input");
            words.type = "text";
            words.value = o.prompt || "";
            words.placeholder = "person, car, water…";
            words.style.width = "130px";
            words.onchange = () => { o.prompt = words.value; };
            this._mmRow(ctx, "What", words);
        }
        const list = this._mmMatteLists && this._mmMatteLists.get(o.engine);
        if (list) {
            if (!list.workflows.length) this._mmNote(ctx, o.engine === "objects" ? "SAM 3 is not in this ComfyUI: its SAM3 nodes (ComfyUI's own, recent) are needed." : "No background remover is installed (ComfyUI-RMBG, or ComfyUI's BiRefNet nodes).", "warn");
            else if (list.workflows.length > 1) {
                this._mmRow(ctx, "Workflow", this._mmSelect(ctx, list.workflows.map((w) => [w.id, `${w.label}${(w.missing || []).some((m) => m.kind !== "node") ? " (downloads its model)" : ""}`]),
                                                            o.workflow || list.choice, (v) => { o.workflow = v; this._mmRender(); }));
            }
        } else this._mmMatteList(o.engine).then(() => this._mmRender()).catch(() => {});
        const ws = this._mmSelect(ctx, WORK_SCALES, String(workScale(o.scale)), (v) => { o.scale = workScale(v); });
        ws.title = "The size the model sees the plate at: smaller is quicker and lighter; the mask comes back at the plate's size, softer at the edges";
        this._mmRow(ctx, "Model at", ws);
        const picked = list && list.workflows.find((w) => w.id === (o.workflow || list.choice));
        if (picked && picked.video) this._mmNote(ctx, `${picked.label.replace(/\s*\(.*\)$/, "")} reads the shot as a film, every frame, so its mask holds together from frame to frame (at most ${picked.max_seconds} s of plate).`);
        else this._mmRow(ctx, "Every", this._mmNum(ctx, o.step || 1, (v) => { o.step = v >= 1 ? Math.round(v) : 1; }, { width: "48px", min: 1, step: 1 }),
                    el(doc, "span", "", "frame(s)"));
        this._mmRow(ctx, "", this._mmBtn(ctx, "Mask with AI", () => this.matchmoveAiMask({ ...o, workflow: o.workflow || null }), { title: "One ComfyUI job for every frame" }));
    },

    /** A matte mask's settings in the mask list (threshold, grow, invert). */
    _mmMatteRow(ctx, m) {
        const { doc } = ctx;
        const row = el(doc, "div", "mm-row");
        row.style.paddingLeft = "18px";
        const set = (label, fn) => this._mmEdit(label, (q) => { const x = q.masks.find((y) => y.id === m.id); if (x && x.matte) fn(x.matte); });
        row.append(el(doc, "span", "mm-note", `AI · ${m.matte.frames.length} frame(s)`),
                   el(doc, "span", "", "grow"), this._mmNum(ctx, m.matte.grow, (v) => set("mask grow", (t) => { t.grow = Math.max(0, Math.min(64, Math.round(v || 0))); }), { width: "44px", min: 0, max: 64, step: 1 }));
        const inv = el(doc, "input");
        inv.type = "checkbox";
        inv.checked = !!m.matte.invert;
        inv.title = "Invert: mask what the model did NOT find";
        inv.onchange = () => set("mask invert", (t) => { t.invert = inv.checked; });
        row.append(inv, el(doc, "span", "", "invert"));
        ctx.box.append(row);
    },

    // ── drawing a matte on the plate ─────────────────────────────────────────

    /** A matte frame as a tinted canvas (red = exclude, blue = object), or null while it loads. */
    _mmMatteCanvas(m, f, doc) {
        const mf = D.matteFrameAt(m.matte, f);
        if (mf === null) return null;
        const path = D.mattePath(m.matte.pattern, mf);
        const col = m.mode === "object" ? [80, 160, 255] : [255, 60, 60];
        const key = `${path}|${m.mode}|${m.matte.invert ? 1 : 0}|${m.on ? 1 : 0}`;
        const cache = this._mmMattes || (this._mmMattes = new Map());
        const got = cache.get(key);
        if (got) return got.canvas || null;
        const rec = { canvas: null };
        cache.set(key, rec);
        while (cache.size > MATTE_CACHE) cache.delete(cache.keys().next().value);
        const img = new ((doc.defaultView || window).Image)();
        img.onload = () => {
            const c = doc.createElement("canvas");
            c.width = img.naturalWidth; c.height = img.naturalHeight;
            const g = c.getContext("2d");
            g.drawImage(img, 0, 0);
            const d = g.getImageData(0, 0, c.width, c.height);
            const a = m.on ? 0.38 : 0.12;
            for (let i = 0; i < d.data.length; i += 4) {
                let v = d.data[i] / 255;
                if (m.matte.invert) v = 1 - v;
                d.data[i] = col[0]; d.data[i + 1] = col[1]; d.data[i + 2] = col[2]; d.data[i + 3] = Math.round(v * a * 255);
            }
            g.putImageData(d, 0, 0);
            rec.canvas = c;
            this._mmDraw();
        };
        img.onerror = () => { rec.failed = true; };
        img.src = api.apiURL(`/imageviewer/view_file?${new URLSearchParams({ path, raw: 1 })}`);
        return null;
    },
};

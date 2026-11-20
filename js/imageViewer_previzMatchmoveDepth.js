// imageViewer_previzMatchmoveDepth.js
// Depth for the TRACK itself (PrevizMatchmoveDepthMixin, onto the panel after PrevizMatchmoveAIMixin): the
// Solve step's "Depth" rows and the Track step's depth check.
//
//   The solve    - with a depth source chosen (settings.depth: the phone film's own depth track, or an AI depth
//                  run kept with the matchmove as mm.depthRun), mm_solve gets `depth` and pulls each solved point
//                  towards the depth the pictures saw it at, frame by frame and in proportion (a depth picture has
//                  no units: each frame is scaled onto the solve). A solve whose depth came out inside out - near
//                  and far swapped, which a shot with little camera movement allows - is started again from the
//                  depth. The answer's `depth` and notes say how well the two agree (src/matchmove_depth.py).
//   AI depth     - a depth workflow (Depth Anything 3, the comp list's depth models) on a dozen frames spread over
//                  the tracked range, ONE ComfyUI job (_mmMatteRun), its maps kept by POST mm_depth_keep. They
//                  are the solve's extra key frames.
//   Depth check  - POST mm_depth_edges: the tracks sitting on a depth edge (a corner in front of something far,
//                  where a feature slides between the two) or whose depth jumps against the rest; picked on the
//                  plate, then deleted as one undo step (measured tracks kept).
//
// Written from scratch, clean-room.

import * as D from "./imageViewer_matchmoveData.js";

const WORK_SCALES = [["1", "Full size"], ["0.5", "Half size"], ["0.25", "Quarter size"]];
const workScale = (v) => { const n = Number(v); return n > 0 && n <= 1 ? n : 1; };

const el = (doc, tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
};

export const PrevizMatchmoveDepthMixin = {
    /** Which depth this plate can have: {phone: a Cinematic film's depth track, ai: an AI depth run kept}. */
    _mmDepthHas(st) {
        const ph = st && st.facts && st.facts.phone;
        return { phone: !!(ph && ph.depth && ph.tracks), ai: !!(st && st.mm && st.mm.depthRun) };
    },

    /** The source the depth check reads: the solve's choice, else the phone's track, else an AI run. */
    _mmDepthCheckSource(st) {
        const has = this._mmDepthHas(st);
        const s = st.mm.settings.depth;
        if (s !== "off" && has[s]) return s;
        return has.phone ? "phone" : has.ai ? "ai" : null;
    },

    /** Frames spread evenly over the tracked range (where the tracks are), n at most. */
    _mmDepthFrames(st, n = D.AI_DEPTH_FRAMES) {
        const seen = new Set();
        for (const t of st.mm.tracks) if (t.on !== false && (t.group || "camera") === "camera") for (const k of t.keys) seen.add(k[0]);
        const all = [...seen].sort((a, b) => a - b);
        if (!all.length) {
            const last = Math.max(0, (st.mm.plate.frames || 1) - 1);
            for (let f = 0; f <= last; f++) all.push(f);
        }
        const k = Math.min(n, all.length);
        return [...new Set(Array.from({ length: k }, (_, i) => all[Math.round((i * (all.length - 1)) / Math.max(1, k - 1))]))];
    },

    /**
     * An AI depth run for the solve: the depth workflow on `frames` (default a dozen over the tracked range), its
     * maps kept with the matchmove (mm.depthRun, one undo step) and the solve set to use them. Answers
     * {frames, workflow} or null when not run.
     */
    async matchmoveDepthRun({ workflow = null, frames = null, ask = true, scale = null } = {}) {
        const st = this._mmCur();
        if (!st || !st.mm.plate) throw new Error("Load a plate first.");
        const fr = frames && frames.length ? frames : this._mmDepthFrames(st);
        const got = await this._mmMatteRun(st, { engine: "depth", frames: fr, workflow: workflow || st.depthWorkflow || null,
                                                 what: "Reading depth for the solve", ask,
                                                 scale: scale === null ? workScale(st.depthScale) : workScale(scale),
                                                 place: { url: "/imageviewer/mm_depth_keep", body: {} } });
        if (!got) return null;
        this._mmEdit("AI depth", (m) => {
            m.depthRun = D.cleanDepthRun({ workflow: got.workflow, images: got.images });
            if (m.settings.depth === "off") m.settings.depth = "ai";
        });
        this._mmRender();
        return { frames: got.frames, workflow: got.workflow };
    },

    /** The Solve step's depth rows (before Solve). */
    _mmDepthSection(ctx) {
        const { mm, st, doc } = ctx;
        const has = this._mmDepthHas(st);
        const opts = [["off", "Not used"]];
        if (has.phone || mm.settings.depth === "phone") opts.push(["phone", "The phone's depth track"]);
        opts.push(["ai", "AI depth"]);
        const pick = this._mmSelect(ctx, opts, mm.settings.depth, (v) => this._mmEdit("depth", (m) => { m.settings.depth = v; }));
        pick.title = "Pull the solve into the depth the plate was seen at: helps a shot with little camera movement, whose depth is otherwise squashed, stretched or inside out";
        pick.classList.add("mm-depth-source");
        const strength = this._mmNum(ctx, mm.settings.depthStrength, (v) => v && this._mmEdit("depth strength", (m) => { m.settings.depthStrength = Math.max(0.1, Math.min(10, v)); }),
                                     { step: 0.1, min: 0.1, max: 10, width: "48px" });
        strength.title = "How hard the depth pulls (1: as much as the depth agrees with itself; more for a shot that hardly moves)";
        this._mmRow(ctx, "Depth", pick, mm.settings.depth !== "off" ? strength : null);
        if (mm.settings.depth === "phone" && !has.phone) this._mmNote(ctx, "This plate has no depth track (only an iPhone's Cinematic films carry one).", "warn");
        if (mm.settings.depth === "ai") {
            const dl = this._mmMatteLists && this._mmMatteLists.get("depth");
            if (!dl) this._mmMatteList("depth").then(() => this._mmRender()).catch(() => {});
            else if (!dl.workflows.length) this._mmNote(ctx, "AI depth needs ComfyUI's Depth Anything 3 nodes (a recent ComfyUI).", "warn");
            else {
                const dw = st.depthWorkflow && dl.workflows.some((w) => w.id === st.depthWorkflow) ? st.depthWorkflow : dl.choice;
                const wf = this._mmSelect(ctx, dl.workflows.map((w) => [w.id, `${w.label.replace(/\s*\(.*\)$/, "")}${(w.missing || []).some((m) => m.kind !== "node") ? " (downloads)" : ""}`]),
                                          dw, (v) => { st.depthWorkflow = v; this._mmRender(); });
                wf.style.maxWidth = "150px";
                const ws = this._mmSelect(ctx, WORK_SCALES, String(workScale(st.depthScale)), (v) => { st.depthScale = workScale(v); });
                ws.title = "The size the depth model sees the plate at";
                const run = this._mmBtn(ctx, mm.depthRun ? "Run again" : `Run on ${D.AI_DEPTH_FRAMES} frames`, () => this.matchmoveDepthRun({ workflow: dw }),
                                        { title: "The depth model on frames spread over the tracks: one ComfyUI job" });
                run.classList.add("mm-depth-run");
                this._mmRow(ctx, "", run, wf, ws);
            }
            const r = mm.depthRun;
            this._mmNote(ctx, r ? `AI depth on ${Object.keys(r.images).length} frame(s)${r.workflow ? ` (${r.workflow})` : ""}: they are the solve's key frames.`
                                : "No AI depth yet: Solve runs it first.", r ? "" : "warn");
        }
    },

    /** The depth line of a solve's facts. */
    _mmDepthFacts(ctx, facts, sv) {
        const d = sv && sv.depth;
        if (!d) return;
        if (d.error) { facts.append(el(ctx.doc, "div", "mm-note warn mm-depth-facts", `Depth not used: ${d.error}`)); return; }
        const good = d.agreement !== null && d.agreement <= 0.15;
        facts.append(el(ctx.doc, "div", `${good ? "mm-good" : "mm-note warn"} mm-depth-facts`,
            `Depth (${d.source === "ai" ? "AI" : "phone"}, read as ${d.reading}): ${d.turned ? "the solve was turned the right way round, " : ""}near-to-far order ${Number(d.order).toFixed(2)}, off by ${(d.agreement * 100).toFixed(1)} % (was ${(d.agreement_before * 100).toFixed(1)} %) over ${d.frames} frames`));
    },

    /**
     * The tracks the depth says not to trust - on a depth edge, or jumping in depth against the rest - picked on
     * the plate (st.depthEdges keeps the answer). With `remove` they are deleted at once (one undo step, measured
     * tracks kept). Answers {tracks, frames, sampled_tracks, source, removed?}.
     */
    async matchmoveDepthEdges({ source = null, remove = false, edgeTol = null } = {}) {
        const st = this._mmCur();
        if (!st || !st.mm.tracks.length) throw new Error("Track the plate first.");
        const src = source || this._mmDepthCheckSource(st);
        if (src === "ai" && !st.mm.depthRun) await this.matchmoveDepthRun({ ask: true });
        const depth = D.depthRequest(st.mm, src);
        if (!depth) throw new Error("No depth for this plate: an iPhone Cinematic film's depth track, or run AI depth in the Solve step.");
        const p = st.mm.plate;
        st.busy = { what: "Checking the tracks against the depth" };
        this._mmRender();
        let got;
        try {
            got = await this._mmPost("/imageviewer/mm_depth_edges", {
                width: p.width, height: p.height, depth, ...(edgeTol ? { edge_tol: edgeTol } : {}),
                tracks: st.mm.tracks.filter((t) => t.on !== false && (t.group || "camera") === "camera"),
            });
        } finally {
            st.busy = null;
        }
        st.depthEdges = got;
        const ids = D.withoutMeasured(st.mm, got.tracks.map((t) => t.id));
        st.sel = new Set(ids);
        if (remove && ids.length) {
            this._mmEdit("delete tracks on depth edges", (m) => D.removeTracks(m, ids));
            st.sel.clear();
            got.removed = ids;
            this._mmChanged(st);
        }
        this._mmRender();
        this._mmDraw();
        return got;
    },

    /** The Track step's depth check rows. */
    _mmDepthCheckSection(ctx) {
        const { st } = ctx;
        const src = this._mmDepthCheckSource(st);
        const b = this._mmBtn(ctx, "Tracks on depth edges", () => this.matchmoveDepthEdges(),
                              { title: src ? `Pick the tracks the ${src === "ai" ? "AI" : "phone's"} depth says not to trust: on a depth edge (a corner in front of something far) or jumping in depth`
                                           : "Needs depth: an iPhone Cinematic film, or AI depth run in the Solve step", disabled: !src });
        b.classList.add("mm-depth-edges");
        this._mmRow(ctx, "Depth check", b);
        const r = st.depthEdges;
        if (!r) return;
        const ids = D.withoutMeasured(st.mm, r.tracks.map((t) => t.id)).filter((id) => st.mm.tracks.some((t) => t.id === id));
        const edges = r.tracks.filter((t) => t.why === "edge").length;
        this._mmNote(ctx, `${r.tracks.length} of ${r.sampled_tracks} track(s) look wrong in the depth (${edges} on an edge, ${r.tracks.length - edges} jumping), over ${r.frames} frame(s).`,
                     r.tracks.length ? "warn" : "");
        if (ids.length) this._mmRow(ctx, "", this._mmBtn(ctx, `Delete them (${ids.length})`, () => {
            this._mmEdit("delete tracks on depth edges", (m) => D.removeTracks(m, ids));
            st.sel.clear();
            st.depthEdges = null;
            this._mmChanged(st);
            this._mmRender();
        }));
    },
};

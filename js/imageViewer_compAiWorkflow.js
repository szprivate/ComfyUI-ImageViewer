// imageViewer_compAiWorkflow.js
// A ComfyUI workflow of the user's own in a Comp AI node (Sebastian 2026-11-23): taken from the open canvas, from a
// workflow saved in ComfyUI, or from a .json file on this computer, and kept INSIDE the comp on the node (`custom`,
// made by the server's comp_ai_workflow.make_custom). A workflow as the canvas saves it is turned into a prompt by
// ComfyUI itself off the canvas (paintCanvas' promptOffCanvas), so both formats work. Running it: the server fills
// the workflow in for every frame and lays the frames into ONE prompt (POST comp_ai_custom), the page queues it as
// Paint's Generate does and hands every output's pictures back (POST comp_ai_custom_place); the node's results are
// its frames and, on an AI Workflow node, a layer per further output. One `this` with the viewer panel.
import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";
import { notice } from "./imageViewer_exportUI.js";
import { promptOffCanvas } from "./imageViewer_paintCanvas.js";
import { isCanvasFormat, outputRefs } from "./imageViewer_compExtra.js";

async function post(route, body) {
    const res = await api.fetchApi(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; e.data = data; throw e; }
    return data;
}

/** The workflow name ComfyUI's tab bar shows for the canvas, else "canvas". */
function canvasName() {
    try {
        const w = app.extensionManager && app.extensionManager.workflow && app.extensionManager.workflow.activeWorkflow;
        const n = w && (w.filename || w.path || w.key);
        if (n) return String(n).replace(/^.*[\\/]/, "").replace(/\.json$/i, "");
    } catch (_) { /* older frontend */ }
    return "canvas";
}

/** A prompt (API format) of JSON in either format: a canvas-format workflow through ComfyUI, off the canvas. */
export async function asPrompt(j) {
    if (isCanvasFormat(j)) return promptOffCanvas(app, j);
    if (j && typeof j === "object" && j.output && typeof j.output === "object" && !Array.isArray(j.output)) return j.output;
    return j;
}

export const CompAiWorkflowMixin = {
    /** The workflows saved in ComfyUI (its user folder's workflows/): their names, newest first if known. */
    async _cpWfSaved() {
        try {
            const res = await api.fetchApi("/userdata?dir=workflows&recurse=true&split=false&full_info=true");
            if (!res.ok) return [];
            const got = await res.json();
            const rows = (Array.isArray(got) ? got : []).map((x) => (typeof x === "string" ? { path: x } : x)).filter((x) => x && /\.json$/i.test(x.path || ""));
            rows.sort((a, b) => (b.modified || 0) - (a.modified || 0) || String(a.path).localeCompare(String(b.path)));
            return rows.map((x) => String(x.path).replace(/\\/g, "/"));
        } catch (_) { return []; }
    },

    /** A .json file chosen on this computer: {json, name} or null. */
    _cpWfBrowse() {
        return new Promise((done) => {
            const doc = this.container.ownerDocument;
            const inp = doc.createElement("input");
            inp.type = "file"; inp.accept = ".json,application/json"; inp.style.display = "none";
            inp.addEventListener("change", async () => {
                const f = inp.files && inp.files[0];
                inp.remove();
                if (!f) { done(null); return; }
                try { done({ json: JSON.parse(await f.text()), name: f.name }); }
                catch (e) { notice("error", `${f.name} is not JSON`, String(e.message || e)); done(null); }
            });
            inp.addEventListener("cancel", () => { inp.remove(); done(null); });
            this.container.append(inp);
            inp.click();
        });
    },

    /**
     * Take a workflow for an AI node: *how* is {how: "canvas"} (the open canvas, as ComfyUI would queue it),
     * {how: "saved", path} (a workflow saved in ComfyUI, "<sub>/<name>.json" below workflows/) or {how: "file"} (a
     * .json on this computer). Answers what the node keeps ({graph, name, source, path, sig, inputs, outputs,
     * params}) or null when nothing was taken (said in a notice).
     */
    async compAiTakeWorkflow(how) {
        let json = null, name = "", source = "file", path = "";
        try {
            if (how.how === "canvas") {
                const p = await app.graphToPrompt();
                json = p && p.output ? p.output : p;
                name = canvasName(); source = "canvas";
            } else if (how.how === "saved") {
                path = String(how.path || "");
                const res = await api.fetchApi(`/userdata/${encodeURIComponent("workflows/" + path)}`);
                if (!res.ok) throw new Error(`${path} could not be read (HTTP ${res.status})`);
                json = await res.json();
                name = path.replace(/^.*\//, "").replace(/\.json$/i, "");
                source = "saved";
            } else {
                const got = await this._cpWfBrowse();
                if (!got) return null;
                json = got.json; name = got.name.replace(/\.json$/i, ""); path = got.name;
            }
            const graph = await asPrompt(json);
            const { custom } = await post("/imageviewer/comp_ai_inspect", { graph, name, source: source === "saved" ? "file" : source, path });
            if (source === "saved") custom.source = "saved";
            return custom;
        } catch (e) {
            notice("error", "The workflow was not taken", String(e.message || e));
            return null;
        }
    },

    /** The node's workflow again from where it came (the canvas, the saved workflow, or a file chosen again). */
    compAiReloadWorkflow(c) {
        if (!c) return Promise.resolve(null);
        if (c.source === "canvas") return this.compAiTakeWorkflow({ how: "canvas" });
        if (c.source === "saved" && c.path) return this.compAiTakeWorkflow({ how: "saved", path: c.path });
        return this.compAiTakeWorkflow({ how: "file" });
    },

    /**
     * Wait for a prompt: every output node's pictures, {node id: [refs]}. *want* is the output node ids; *onCount(k)*
     * is told how many have answered. Rejects on an error or a stop (what came before is in the error's `images`).
     */
    _cpAiWaitNodes(id, want, run, onCount) {
        return new Promise((resolve, reject) => {
            const wanted = new Set(want.map(String));
            const got = {};
            let over = false, running = false, timer = null;
            const take = (node, out) => {
                const k = String(node), refs = outputRefs(out);
                if (!wanted.has(k) || !refs.length || got[k]) return;
                got[k] = refs;
                try { onCount(Object.keys(got).length); } catch (_) { /* only the bar */ }
            };
            const end = (fn, v) => {
                if (over) return;
                over = true;
                clearInterval(timer);
                for (const [k, f] of hooks) api.removeEventListener(k, f);
                run.stop = null;
                fn(v);
            };
            const fromHistory = async (final) => {
                const asIs = () => { if (final && Object.keys(got).length) end(resolve, got); };
                try {
                    const res = await api.fetchApi(`/history/${encodeURIComponent(id)}`);
                    if (!res.ok) { asIs(); return; }
                    const h = (await res.json())[id];
                    if (!h) { asIs(); return; }
                    for (const [node, out] of Object.entries(h.outputs || {})) { delete got[String(node)]; take(node, out); }
                    const st = h.status || {};
                    if (st.status_str === "error") {
                        const msg = (st.messages || []).find((m) => m[0] === "execution_error");
                        end(reject, Object.assign(new Error(msg ? msg[1].exception_message : "the workflow failed"), { images: got }));
                    } else if (st.completed || final) {
                        if (Object.keys(got).length) end(resolve, got);
                        else if (st.completed) end(reject, new Error("the workflow gave no pictures"));
                    }
                } catch (_) { asIs(); }
            };
            const hooks = [
                ["executed", (e) => { const d = e.detail || {}; if (d.prompt_id === id) take(d.node, d.output); }],
                ["execution_start", (e) => { const d = e.detail || {}; if (d.prompt_id === id) running = true; }],
                ["execution_error", (e) => { const d = e.detail || {}; if (d.prompt_id === id) end(reject, Object.assign(new Error(d.exception_message || "the workflow failed"), { images: got })); }],
                ["execution_interrupted", (e) => { const d = e.detail || {}; if (d.prompt_id === id) end(reject, Object.assign(new Error("stopped"), { images: got })); }],
                // The history has every picture of an output (the socket's message may carry only the last batch).
                ["execution_success", (e) => { const d = e.detail || {}; if (d.prompt_id === id) fromHistory(true); }],
            ];
            for (const [k, f] of hooks) api.addEventListener(k, f);
            run.stop = async () => {
                try { await api.fetchApi("/queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: [id] }) }); } catch (_) { /* gone */ }
                if (running && !over) {
                    try { await api.fetchApi("/interrupt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt_id: id }) }); } catch (_) { /* nothing */ }
                }
                end(reject, Object.assign(new Error("stopped"), { images: got }));
            };
            timer = setInterval(() => fromHistory(false), 5000);
        });
    },

    /**
     * Run an AI node's own workflow on these frames: ONE ComfyUI job (or jobs of the node's `per_job` frames). The
     * answers come back beside the comp and become the node's results (one undo step a job). Answers as _cpAiRun.
     */
    async _cpAiRunCustom(rec, id, frames, { agent = false } = {}) {
        const ed = rec.editor;
        const runs = this._cpAiRuns || (this._cpAiRuns = new Map());
        if (runs.has(id)) return { done: 0, error: "the node is running already" };
        const n0 = ed.node(id);
        const label = `${n0.name || n0.id}`;
        const all = [...new Set(frames)].sort((x, y) => x - y);
        const per = Math.max(0, Math.round(n0.per_job || 0));
        const chunks = [];
        for (let i = 0; i < all.length; i += per || all.length) chunks.push(all.slice(i, i + (per || all.length)));
        const run = { stopped: false, stop: null };
        runs.set(id, run);
        const busy = () => [...runs.keys(), ...(this._cpAiBusy || [])];
        const shared = this._cpAiProgress || (this._cpAiProgress = {});
        const tell = (text) => { shared[id] = text; if (rec.editor) ed.setAiBusy(busy(), Object.assign({}, shared)); };
        tell(`0 / ${all.length}`);
        let done = 0, failed = null, skipped = [], jobs = 0;
        try {
            for (const part of chunks) {
                if (run.stopped || !rec.editor || !ed.node(id)) break;
                tell(`${done} / ${all.length} · preparing`);
                const key = ed.aiKeyNow(id);
                const prep = await post("/imageviewer/comp_ai_custom", { path: rec.path, comp: ed.comp(), node: id, frames: part });
                skipped = skipped.concat(prep.skipped || []);
                if (run.stopped) break;
                jobs++;
                const pid = await this._paintQueue(prep.graph);
                const outs = Object.keys(prep.outputs || {});
                const land = async (images) => {
                    const placed = await post("/imageviewer/comp_ai_custom_place", { run: prep.run, images });
                    if (rec.editor && ed.node(id)) ed.aiResults(id, placed.frames, key, { layers: placed.layers, width: placed.width, height: placed.height });
                    done += prep.mode === "once" ? part.length : Object.keys(placed.frames).length;
                    tell(`${Math.min(done, all.length)} / ${all.length}`);
                };
                let images;
                const base = done;
                const each = prep.mode === "frames" ? Math.max(1, outs.length / Math.max(1, prep.frames.length)) : outs.length;
                try {
                    images = await this._cpAiWaitNodes(pid, outs, run, (k) => tell(`${base + Math.floor(k / each) * (prep.mode === "frames" ? 1 : part.length)} / ${all.length}`));
                } catch (e) {
                    if (e.images && Object.keys(e.images).length) { try { await land(e.images); } catch (_) { /* the error below says it */ } }
                    throw e;
                }
                await land(images);
            }
        } catch (e) {
            failed = e;
            const miss = e.data && e.data.missing;
            if (run.stopped) notice("info", `${label}: stopped`, done ? `${done} frame(s) came back before it stopped.` : "");
            else if (miss && miss.length) {
                const list = miss.map((m) => (m.kind === "model" ? `${m.what} (${m.folder})` : `node ${m.what}`)).join(", ");
                notice("error", "The workflow needs what is not here", `${list} - install the node pack or put the model file into its ComfyUI folder, or pick another file on the node`);
            } else if (!agent) notice("error", `${label} did not run`, String(e.message || e));
        } finally {
            runs.delete(id);
            delete shared[id];
            if (rec.editor) ed.setAiBusy(busy(), Object.assign({}, shared));
        }
        if (skipped.length) notice("warn", `${label}: ${skipped.length} frame(s) left out`, skipped.slice(0, 3).map((x) => `frame ${x.frame}: ${x.why}`).join("; "));
        if (!failed && done && !agent) notice("info", `${label}: ${done === 1 ? "the result is in" : `${done} frames are in`} (${jobs === 1 ? "one job" : `${jobs} jobs`})`, "Save the comp to keep them.");
        return { done, of: all.length, jobs, workflow: "custom", skipped,
                 error: failed ? String(failed.message || failed) : (run.stopped ? "stopped" : null),
                 ...(failed && failed.data && failed.data.missing ? { missing: failed.data.missing } : {}) };
    },
};


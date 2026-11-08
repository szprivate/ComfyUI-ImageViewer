/**
 * Paint's Generate, seen while it runs: the button pressed is marked busy at once, and a bar over the status line
 * says what is going on - getting the picture ready, waiting in ComfyUI's queue, which node runs and how far
 * (ComfyUI's own `progress` events), laying the result in, done or failed - with Stop beside it.
 *
 * The editor only draws; the viewer's side (imageViewer_paintPanel.js `_paintRun`) tells it. Every run is a job:
 *   const id = editor.genBegin(kind, "Generative fill: a red ball");
 *   editor.genUpdate(id, { text: "Waiting in ComfyUI's queue", share: null, stop: () => ... });
 *   editor.genEnd(id, true | false, "the message");
 * `share` is 0..1 for a bar that fills, null for one that only moves (an API node says nothing of how far it is).
 */

export const GEN_DONE_MS = 4000;      // how long a finished run's line stays
export const GEN_FAILED_MS = 9000;    // and a failed one's

export const GEN_CSS = `
.paint-genbar { flex: 0 0 auto; display: none; align-items: center; gap: 8px; padding: 3px 8px; background: #26221d;
  border-top: 1px solid #4a3520; color: #ddd; font-size: 11px; white-space: nowrap; overflow: hidden; }
.paint-genbar.on { display: flex; }
.paint-genbar.done { background: #1d2620; border-top-color: #2f5a3a; }
.paint-genbar.failed { background: #2a1d1d; border-top-color: #6a2b2b; }
.paint-genbar .gen-dot { flex: 0 0 auto; width: 10px; height: 10px; border-radius: 50%; border: 2px solid #f60; border-right-color: transparent;
  box-sizing: border-box; animation: paint-gen-spin .8s linear infinite; }
.paint-genbar.done .gen-dot { animation: none; border-color: #5c5; background: #5c5; }
.paint-genbar.failed .gen-dot { animation: none; border-color: #e55; background: #e55; }
.paint-genbar .gen-what { color: #f60; font-weight: 600; overflow: hidden; text-overflow: ellipsis; max-width: 40%; }
.paint-genbar.done .gen-what { color: #7d7; }
.paint-genbar.failed .gen-what { color: #f77; }
.paint-genbar .gen-text { overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 0 1 auto; }
.paint-genbar .gen-track { flex: 1 1 80px; min-width: 60px; max-width: 260px; height: 5px; border-radius: 3px; background: #3a3a40; overflow: hidden; position: relative; }
.paint-genbar .gen-fill { position: absolute; left: 0; top: 0; bottom: 0; width: 0; background: #f60; transition: width .2s; }
.paint-genbar .gen-track.moving .gen-fill { width: 30% !important; animation: paint-gen-slide 1.2s ease-in-out infinite; }
.paint-genbar.done .gen-track, .paint-genbar.failed .gen-track { display: none; }
.paint-genbar .gen-more { color: #999; }
.paint-genbar .gen-stop { flex: 0 0 auto; padding: 0 8px; }
.paint-genbar .gen-time { color: #999; flex: 0 0 auto; }
.paint-gen .paint-btn.busy { border-color: #f60 !important; color: #f60; position: relative; padding-left: 20px; }
.paint-gen .paint-btn.busy::before { content: ""; position: absolute; left: 6px; top: 50%; width: 8px; height: 8px; margin-top: -5px;
  border-radius: 50%; border: 2px solid #f60; border-right-color: transparent; animation: paint-gen-spin .8s linear infinite; }
.paint-gen .paint-btn.pressed { background: #f60; color: #111; }
@keyframes paint-gen-spin { to { transform: rotate(360deg); } }
@keyframes paint-gen-slide { 0% { left: -30%; } 100% { left: 100%; } }
`;

/** "1:05" from seconds. */
export function genClock(s) {
    s = Math.max(0, Math.floor(s));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The line of one job: "KSampler 12 / 40" from ComfyUI's progress, or what it was told. */
export function genLine(job) {
    if (!job) return "";
    let t = job.text || "";
    if (job.value != null && job.max) t += ` ${job.value} / ${job.max}`;
    return t;
}

export const GenStatusMixin = {
    _genBar() {
        if (this._genEl) return this._genEl;
        const bar = this.el("div", "paint-genbar");
        const ui = {
            bar, dot: this.el("span", "gen-dot"), what: this.el("span", "gen-what"), text: this.el("span", "gen-text"),
            track: this.el("span", "gen-track"), fill: this.el("i", "gen-fill"), more: this.el("span", "gen-more"),
            time: this.el("span", "gen-time"),
            stop: this.el("button", "paint-btn gen-stop", { type: "button", text: "Stop", title: "Stop this run (it is taken out of ComfyUI's queue, or interrupted)" }),
        };
        ui.track.append(ui.fill);
        ui.stop.addEventListener("click", () => {
            const j = this._genShown();
            if (j && j.stop) { ui.stop.disabled = true; try { j.stop(); } catch (_) { /* told by the run */ } }
        });
        bar.append(ui.dot, ui.what, ui.text, ui.track, ui.time, ui.more, ui.stop);
        if (this.status && this.status.parentNode) this.status.parentNode.insertBefore(bar, this.status);
        this._genEl = ui;
        return ui;
    },

    /** A run starts: its button is marked busy and the bar comes up. Returns its id. */
    genBegin(kind, what) {
        this._gen = this._gen || new Map();
        this._genN = (this._genN || 0) + 1;
        const id = this._genN;
        this._gen.set(id, { id, kind, what: what || kind, text: "Getting the picture ready", share: null, at: Date.now(), state: "run" });
        this._genPress(kind);
        this._genDraw();
        return id;
    },

    /** What it is doing now: { text, share, value, max, stop }. */
    genUpdate(id, patch) {
        const j = this._gen && this._gen.get(id);
        if (!j || j.state !== "run") return;
        Object.assign(j, patch);
        this._genDraw();
    },

    /** It is over: ok, or failed with *msg*. Its line stays a moment, then goes. */
    genEnd(id, ok, msg) {
        const j = this._gen && this._gen.get(id);
        if (!j) return;
        Object.assign(j, { state: ok ? "done" : "failed", text: msg || (ok ? "Done" : "Did not work"), stop: null, ended: Date.now() });
        this._genDraw();
        const win = this.root.ownerDocument.defaultView || window;
        win.setTimeout(() => { if (this._gen && this._gen.get(id) === j) { this._gen.delete(id); this._genDraw(); } }, ok ? GEN_DONE_MS : GEN_FAILED_MS);
    },

    /** The running jobs, oldest first. */
    genRunning() {
        return this._gen ? [...this._gen.values()].filter((j) => j.state === "run") : [];
    },

    /** The job the bar shows: the newest running one, else the newest finished one. */
    _genShown() {
        if (!this._gen || !this._gen.size) return null;
        const all = [...this._gen.values()];
        const run = all.filter((j) => j.state === "run");
        return (run.length ? run : all)[(run.length ? run : all).length - 1];
    },

    /** A pressed button flashes, so that the press is seen even before the bar has anything to say. */
    _genPress(kind) {
        const root = this.parts && this.parts.generate;
        if (!root) return;
        for (const b of root.querySelectorAll(`[data-gen="${kind}"]`)) {
            b.classList.add("pressed");
            (this.root.ownerDocument.defaultView || window).setTimeout(() => b.classList.remove("pressed"), 180);
        }
    },

    /** The bar and the busy buttons as the jobs stand. */
    _genDraw() {
        const ui = this._genBar();
        const j = this._genShown();
        const run = this.genRunning();
        // Busy buttons: every kind that has a run going (the section may have been rebuilt since).
        const busy = new Set(run.map((r) => r.kind));
        const root = this.parts && this.parts.generate;
        if (root) for (const b of root.querySelectorAll("[data-gen]")) b.classList.toggle("busy", busy.has(b.dataset.gen));
        ui.bar.classList.toggle("on", !!j);
        if (!j) { this._genStopTick(); return; }
        ui.bar.classList.toggle("done", j.state === "done");
        ui.bar.classList.toggle("failed", j.state === "failed");
        ui.bar.dataset.state = j.state;
        ui.what.textContent = j.what;
        ui.text.textContent = genLine(j);
        ui.bar.title = `${j.what}: ${genLine(j)}`;
        const moving = j.share == null;
        ui.track.classList.toggle("moving", moving);
        ui.fill.style.width = moving ? "" : `${Math.round(Math.max(0, Math.min(1, j.share)) * 100)}%`;
        ui.more.textContent = run.length > 1 ? `+${run.length - 1} more` : "";
        ui.stop.style.display = j.state === "run" && j.stop ? "" : "none";
        ui.stop.disabled = false;
        const tick = () => {
            const k = this._genShown();
            ui.time.textContent = k ? genClock(((k.ended || Date.now()) - k.at) / 1000) : "";
        };
        tick();
        if (run.length && !this._genTick) {
            this._genTickWin = this.root.ownerDocument.defaultView || window;
            this._genTick = this._genTickWin.setInterval(tick, 1000);
        } else if (!run.length) this._genStopTick();
    },

    _genStopTick() {
        if (this._genTick) this._genTickWin.clearInterval(this._genTick);
        this._genTick = null;
    },
};

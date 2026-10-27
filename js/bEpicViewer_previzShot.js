// bEpicViewer_previzShot.js
// A shot an agent asked for: the server (previz_shot.py) sent the scene as the
// tab `previz:<name>` and a "bepic.previz.render" message; this plays the shot
// through the camera it names, exactly as Export > Render does, and reports
// progress and the result back so the agent can wait for the file.
import { api } from "../../scripts/api.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(test, timeoutMs, what) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        const v = test();
        if (v) return v;
        await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}`);
}

export const PrevizShotMixin = {

    async _previzShotReport(id, body) {
        try {
            await fetch(api.apiURL("/bepic/previz_shot_done"), {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id, ...body }),
            });
        } catch (e) { console.warn("bEpicViewer: previz shot report failed", e); }
    },

    /** req: { id, key, name, render, add_node } from "bepic.previz.render". */
    async previzShotRun(req) {
        if (!req || !req.id) return;
        const report = (body) => this._previzShotReport(req.id, body);
        try {
            const apiv = window.bEpicViewerApi || {};
            try { if (apiv.show) apiv.show(); } catch (_) { /* already up */ }
            await waitFor(() => this.allTabs[req.key] && this.previzScene(req.key), 15000, "the scene tab");
            if (this._previzRendering) throw new Error("another render is running in the viewer");
            if (this.activeTab !== req.key) this.switchTab(req.key);
            await waitFor(() => this.activeTab === req.key && this.isPrevizTab(), 10000, "the 3D view");
            const view = this._modelView();
            await waitFor(() => view.scene3d === this.previzScene(req.key), 15000, "the 3D view to take the scene");
            if (!(await view.whenLoaded(180000))) throw new Error("the scene's models did not finish loading");
            // A model that failed in an earlier job (or before its folder was allowed) gets one more
            // try now, so a refused path never poisons the jobs after it.
            const failed = [...view._entries.values()].filter((e) => e.error && e.item && e.item.kind === "model");
            for (const e of failed) await view.reloadModel(e.item.id);
            const bad = [...view._entries.values()].filter((e) => e.error).map((e) => `${e.item.name}: ${e.error}`);
            if (bad.length) throw new Error("could not load: " + bad.join("; "));
            await report({ state: "rendering", done: 0 });
            let last = 0;
            const res = await this.previzRender(
                { ...req.render, name: req.name, addNode: req.add_node !== false },
                { onProgress: (done, total) => {
                    const now = Date.now();
                    if (now - last > 1500) { last = now; report({ state: "rendering", done, total }); }
                } });
            if (!res) throw new Error("the viewer could not start the render");
            const path = (res.landed && res.landed[0]) || "";
            await report({ state: res.ok && !res.stopped ? "done" : "error", done: res.frames, total: res.frames,
                           path, where: res.where || "", message: res.message || "" });
        } catch (e) {
            console.warn("bEpicViewer: previz shot failed", e);
            await report({ state: "error", message: (e && e.message) || String(e) });
        }
    },
};

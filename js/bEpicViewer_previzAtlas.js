// bEpicViewer_previzAtlas.js
// "Render with Atlas" in the Previz panel. With a World Labs Atlas world open (a model called world.glb
// from an Atlas folder), the user navigates the camera and presses the button: the camera they are
// looking through goes to the server (POST /bepic/atlas_render -> the agentY host), Atlas paints that
// view, and the picture comes back into a new viewer tab, shown large, and onto the canvas.
import { api } from "../../scripts/api.js";
import { notice } from "./bEpicViewer_exportUI.js";
import * as A from "./bEpicViewer_atlasRender.js";

async function asJson(res) {
    let body = {};
    try { body = await res.json(); } catch (_) { /* not JSON */ }
    if (!res.ok) throw new Error(body.error || `the viewer server answered ${res.status}`);
    return body;
}

const postRender = async (body) => asJson(await api.fetchApi("/bepic/atlas_render", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}));
const getRender = async (id) => asJson(await api.fetchApi(`/bepic/atlas_render?id=${encodeURIComponent(id)}`));

export const PrevizAtlasMixin = {

    /** The scene item holding an Atlas world, or null (the button shows only then). */
    previzAtlasItem(key = this.activeTab) {
        return A.atlasWorldItem(this.previzScene(key));
    },

    /** Open the dialog: upscale choice, add-to-world, Render. */
    previzAtlasDialog() {
        if (!this.isPrevizTab()) return;
        if (this._atlasDlg && this._atlasDlg.isConnected) { if (!this._atlasBusy) this._atlasDlg.remove(); return; }
        const item = this.previzAtlasItem();
        const host = this.container;
        if (!item || !host) { notice("warn", "Render with Atlas", "Open an Atlas world (atlas_open_in_viewer) first."); return; }
        const doc = host.ownerDocument;
        const el = (tag, cls, text) => {
            const n = doc.createElement(tag);
            if (cls) n.className = cls;
            if (text !== undefined) n.textContent = text;
            return n;
        };
        const worldName = A.atlasWorldName(item.src.path);
        const shade = el("div", "rd-shade atlas-dlg");
        const box = el("div", "rd-box");
        box.setAttribute("role", "dialog");
        box.setAttribute("aria-label", "Render with Atlas");
        const head = el("div", "rd-head");
        const x = el("button", "rd-x", "✕");
        x.title = "Close (Esc)";
        head.append(el("span", "rd-title", `Render with Atlas — ${worldName}`), x);

        const row = (label, ...kids) => {
            const r = el("div", "rd-row");
            r.append(el("span", "rd-label", label), ...kids);
            return r;
        };
        const camInfo = el("div", "rd-hint");
        const view = this._modelView();
        const refreshCamera = () => {
            try {
                const c = A.captureCamera(view, item);
                camInfo.textContent = c.gated
                    ? `The camera you look through ("${c.label}", 16:9): the picture is what its frame shows.`
                    : c.label ? `The camera you look through ("${c.label}"): the 16:9 picture covers what its frame shows.`
                    : "The free camera: the 16:9 picture covers what you see in the view.";
                return c;
            } catch (e) { camInfo.textContent = (e && e.message) || String(e); return null; }
        };
        refreshCamera();

        const up = el("select", "rd-in");
        for (const [v, label] of A.UPSCALE_CHOICES) up.append(Object.assign(el("option"), { value: String(v), textContent: label }));
        const add = el("input");
        add.type = "checkbox";
        const addWrap = el("label", "rd-inline");
        addWrap.append(add, el("span", "rd-sub", "Add this view to the world (later renders stay consistent with it)"));
        const hint = el("div", "rd-hint", "Atlas paints one new 1280 × 720 view from this camera — it bills the World Labs "
            + "credits (one task) and takes up to a few minutes. Upscaling needs ComfyUI and an upscale model.");
        const message = el("div", "rd-message");
        const progress = el("div", "rd-progress");
        const bar = el("div", "rd-bar");
        progress.append(bar);
        const cancel = el("button", "rd-btn", "Close");
        const go = el("button", "rd-btn rd-go", "Render view with Atlas");
        const foot = el("div", "rd-row export-foot");
        foot.append(cancel, go);
        box.append(head, camInfo, row("Upscale", up), row("", addWrap), hint, progress, message, foot);
        shade.append(box);
        host.append(shade);
        this._atlasDlg = shade;

        const win = this._viewerWindow ? this._viewerWindow() : window;
        const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
        const close = () => {
            if (this._atlasBusy) return;
            shade.remove();
            win.removeEventListener("keydown", onKey, true);
        };
        win.addEventListener("keydown", onKey, true);
        x.onclick = close;
        cancel.onclick = close;

        go.onclick = async () => {
            if (this._atlasBusy) return;
            const cam = refreshCamera();      // the camera as it is NOW
            if (!cam) return;
            this._atlasBusy = true;
            go.disabled = up.disabled = add.disabled = true;
            box.classList.add("rendering");
            message.classList.remove("error");
            message.textContent = "Sending the camera to agentY…";
            try {
                const state = await A.runAtlasRender({
                    post: postRender, get: getRender,
                    request: A.buildRequest(item, cam, { upscale: up.value, addToWorld: add.checked }),
                    onState: (s) => {
                        message.textContent = `${s.phase || "Atlas is painting the view"}… ${A.clock(s.elapsed)}`;
                    },
                });
                const where = await this.previzAtlasShow(state, worldName);
                message.textContent = state.message ? `Done, but: ${state.message}` : "Done — " + where;
                notice(state.message ? "warn" : "success", "Atlas render ready", state.path || "");
                if (add.checked && state.added_to_world) {
                    const fresh = await this.previzAtlasReloadWorld(item);
                    notice("info", "World updated", fresh
                        ? "The rebuilt mesh is showing: the newly filled areas are there."
                        : "The view was added; the rebuilt mesh could not be reloaded here - re-open the world to see it.");
                }
                this._atlasBusy = false;
                close();
            } catch (e) {
                message.classList.add("error");
                message.textContent = A.explainError(e);
                box.classList.remove("rendering");
                go.disabled = up.disabled = add.disabled = false;
                this._atlasBusy = false;
            }
        };
    },

    /** Read the world's mesh again, in place: same item, camera, selection and scene. True when it is showing. */
    async previzAtlasReloadWorld(item) {
        try {
            return !!(await this._modelView().reloadModel(item.id));
        } catch (e) {
            return false;
        }
    },

    /** The finished picture, into its own tab, selected and shown large. */
    async previzAtlasShow(state, worldName) {
        if (!state || !state.path) return "the file is under the world's renders folder";
        try {
            const res = await api.fetchApi("/bepic/push", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ paths: [state.path], tab_name: `Atlas: ${worldName}`.slice(0, 60),
                                       group: "Atlas renders", label: "Atlas render", focus: true }),
            });
            const body = await res.json().catch(() => ({}));
            if (res.ok && body.shown) return `shown in the "Atlas: ${worldName}" tab.`;
            return body.refused && body.refused.length
                ? `saved to ${state.path} (the viewer may not open that folder).` : "saved.";
        } catch (e) {
            return `saved to ${state.path}.`;
        }
    },
};

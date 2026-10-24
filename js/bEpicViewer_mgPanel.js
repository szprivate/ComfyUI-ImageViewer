// bEpicViewer_mgPanel.js
// "Motion": a dock panel (#motion-panel, dock id "motionGfx") that edits an agent's
// motion-graphics scene (*.mgscene.json): layers, preview, timeline, keyframes, curves,
// on-canvas gizmos. The editor itself is bEpicViewer_mgEditor.js (it does not know about
// the viewer); this mixin is the glue: opening a file, saving it, resolving its assets,
// the Render button (relayed to agentY, see mg_render.py) and the "agent opened a scene"
// message (ComfyUI's "bepic.mg.open", from POST /bepic/push with a .mgscene.json path).
import { api } from "../../scripts/api.js";
import { createMgEditor } from "./bEpicViewer_mgEditor.js";
import { notice } from "./bEpicViewer_exportUI.js";

const dirOf = (p) => String(p || "").replace(/[\\/][^\\/]*$/, "");
const isUrl = (s) => /^(https?:|data:|blob:)/i.test(s);

export const MgPanelMixin = {

    _mgState() {
        if (!this._mg) this._mg = { editor: null, pending: null, path: "", polling: 0 };
        return this._mg;
    },

    /** Load a scene file into the panel (and show the panel). */
    async mgOpenFile(path) {
        const st = this._mgState();
        try {
            const res = await api.fetchApi(`/bepic/mgscene?path=${encodeURIComponent(path)}`);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            st.pending = { scene: data.scene, path: data.path };
        } catch (e) {
            notice("error", "Cannot open the scene", String(e.message || e));
            return false;
        }
        if (this.setPanelDocked && !this.isPanelDocked("motionGfx")) this.setPanelDocked("motionGfx", true);
        else this._mgOnShown();
        return true;
    },

    /** Does this PNG carry a motion-graphics scene (a poster written next to a rendered video)? */
    async _mgPngHasScene(path) {
        try {
            const res = await api.fetchApi(`/bepic/mgscene?path=${encodeURIComponent(path)}&probe=1`);
            const data = await res.json().catch(() => ({}));
            return !!(res.ok && data.has_scene);
        } catch (_) { return false; }
    },

    /** Dropping a file-browser / history PNG onto the panel opens the scene it carries. */
    _mgWireDrop(host) {
        if (host.__mgDropWired) return;
        host.__mgDropWired = true;
        const TYPE = "application/x-bepic-history";
        const has = (e) => Array.from(e.dataTransfer?.types || []).includes(TYPE);
        host.addEventListener("dragover", (e) => { if (has(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
        host.addEventListener("drop", (e) => {
            if (!has(e)) return;
            let payload = null;
            try { payload = JSON.parse(e.dataTransfer.getData(TYPE)); } catch (_) {}
            const items = payload && Array.isArray(payload.items) ? payload.items : [];
            const png = items.find((it) => it && /\.png$/i.test(String(it.path || "")));
            if (!png) return;
            e.preventDefault(); e.stopPropagation();
            this.mgOpenFile(png.path);
        });
    },

    /** The dock calls this when the panel comes up. */
    _mgOnShown() {
        const st = this._mgState();
        const host = this.motionPanel;
        if (!host) return;
        this._mgWireDrop(host);
        if (!st.editor || st.host !== host) {
            if (st.editor) st.editor.dispose();
            st.host = host;
            st.editor = createMgEditor(host, {
                assetUrl: (src) => this._mgAssetUrl(src),
                save: (path, scene) => this._mgSave(path, scene),
                render: (path) => this._mgRender(path),
                notify: (m, sev) => notice(sev || "info", m),
            });
            if (!st.pending && st.path && st.lastScene) st.pending = { scene: st.lastScene, path: st.path };
        }
        if (st.pending) {
            const { scene, path } = st.pending;
            st.pending = null;
            st.path = path;
            const check = st.editor.load(scene, path);
            if (!check.ok) notice("warn", "The scene has problems", check.errors.slice(0, 3).map((x) => x.message).join("; "));
        }
    },

    /** A url the browser can load for a scene asset: relative paths are beside the scene file. */
    _mgAssetUrl(src) {
        if (!src || isUrl(src)) return src;
        const st = this._mgState();
        const abs = /^([a-zA-Z]:[\\/]|\/)/.test(src) ? src : `${dirOf(st.path)}/${src}`;
        return api.apiURL(`/bepic/view_file?path=${encodeURIComponent(abs)}&raw=1`);
    },

    async _mgSave(path, scene) {
        const res = await api.fetchApi("/bepic/mgscene", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, scene }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        this._mgState().lastScene = scene;
    },

    /** Ask agentY's host to render the saved scene; poll it and tell the user when the file exists. */
    async _mgRender(path) {
        const res = await api.fetchApi("/bepic/mg_render", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, format: "mp4" }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        const id = data.id;
        const st = this._mgState();
        const poll = async () => {
            try {
                const r = await api.fetchApi(`/bepic/mg_render?id=${encodeURIComponent(id)}`);
                const d = await r.json().catch(() => ({}));
                if (d.state === "done") {
                    notice("success", "Render finished", d.path || "");
                    return;
                }
                if (d.state === "error" || !r.ok) { notice("error", "Render failed", d.error || ""); return; }
                st.polling = setTimeout(poll, 1500);
            } catch (e) { notice("error", "Render status lost", String(e.message || e)); }
        };
        st.polling = setTimeout(poll, 1500);
        return { message: "Rendering with agentY... you will get a note when the video is ready." };
    },
};

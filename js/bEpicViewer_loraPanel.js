// bEpicViewer_loraPanel.js
// "Dataset": a dock panel (#lora-panel, dock id "loraDataset") to review a LoRA training dataset an
// agent prepared and to watch the training run. The editor itself is bEpicViewer_loraEditor.js (it does
// not know about the viewer); this mixin is the glue: the /bepic/lora/* calls (lora_io.py), file urls,
// the "agent opened a dataset" message (ComfyUI's "bepic.lora.open", from POST /bepic/push with a
// lora dataset's manifest.json) and the note to agentY after Approve / Ask / Cancel.
// agentY is optional: without it the panel works the same and the note simply is not sent.
import { api } from "../../scripts/api.js";
import { createLoraEditor } from "./bEpicViewer_loraEditor.js";
import { notice } from "./bEpicViewer_exportUI.js";

async function call(path, body) {
    const res = await api.fetchApi(path, body === undefined ? {} : {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}
const q = encodeURIComponent;

export const LORA_API = {
    datasets: () => call("/bepic/lora/datasets"),
    dataset: (name) => call(`/bepic/lora/dataset?name=${q(name)}`),
    save: (name, manifest) => call("/bepic/lora/dataset_save", { name, manifest }),
    review: (name, action, note, manifest) => call("/bepic/lora/review", { name, action, note, manifest }),
    runs: () => call("/bepic/lora/runs"),
    run: (name) => call(`/bepic/lora/run?name=${q(name)}`),
    control: (name, keep) => call("/bepic/lora/control", { name, action: "stop", keep: !!keep }),
};

/** The dataset name in a pushed manifest.json path (or a bare name). */
export function datasetNameOf(ref) {
    const m = String(ref || "").replace(/\\/g, "/").match(/lora_datasets\/([^/]+)(?:\/manifest\.json)?$/i);
    return m ? m[1] : String(ref || "");
}

/** Tell agentY (the same way "Send to agentY" does), if its panel is loaded. Never throws. */
async function sendToAgent(text) {
    const b = typeof window !== "undefined" ? window.agentYViewerBridge : null;
    if (!b || typeof b.feedback !== "function") return false;
    try { const r = await b.feedback({ text, files: [] }); return !!(r && r.ok); } catch (_) { return false; }
}

export const LoraPanelMixin = {

    _loraState() {
        if (!this._lora) this._lora = { editor: null, host: null, pending: "" };
        return this._lora;
    },

    /** Open a dataset by name or by the path of its manifest.json (and show the panel). */
    async loraOpen(ref) {
        const st = this._loraState();
        st.pending = datasetNameOf(ref);
        if (this.setPanelDocked && !this.isPanelDocked("loraDataset")) this.setPanelDocked("loraDataset", true);
        else this._loraOnShown();
        return true;
    },

    /** The dock calls this when the panel comes up. */
    _loraOnShown() {
        const st = this._loraState();
        const host = this.loraPanel;
        if (!host) return;
        if (!st.editor || st.host !== host) {
            if (st.editor) st.editor.dispose();
            st.host = host;
            st.editor = createLoraEditor(host, {
                api: LORA_API,
                fileUrl: (p) => api.apiURL(`/bepic/lora/file?path=${q(p)}`),
                notify: (m, sev) => notice(sev || "info", m),
                sendToAgent,
                isOpen: () => !!(this.isPanelDocked && this.isPanelDocked("loraDataset")),
            });
        }
        if (st.pending) {
            const name = st.pending;
            st.pending = "";
            st.editor.openDataset(name);
        } else {
            st.editor.refresh();
        }
    },
};

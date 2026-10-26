// bEpicViewer_loraPanel.js
// "Dataset": a LoRA training dataset an agent prepared, to review, and the training run that follows, as a TAB of
// the main canvas ("dataset:<name>", bEpicViewer_viewTabs.js) the way a Motion scene is one. Several can be open at
// once. The editor itself is bEpicViewer_loraEditor.js (it does not know about the viewer, and brings its own
// DATASET / TRAINING pages); this mixin is the glue: the /bepic/lora/* calls (lora_io.py), file urls,
// the "agent opened a dataset" message (ComfyUI's "bepic.lora.open", from POST /bepic/push with a
// lora dataset's manifest.json) and the note to agentY after Approve / Ask / Cancel.
// agentY is optional: without it the tab works the same and the note simply is not sent.
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

export const LORA_PREFIX = "dataset:";

export const LoraPanelMixin = {

    // ── the tab kind (ViewTabsMixin) ─────────────────────────────────────────

    _loraTabKind() {
        return {
            restore: (key) => ({ name: key.slice(LORA_PREFIX.length), editor: null }),
            build: (rec, key) => {
                rec.editor = createLoraEditor(rec.el, {
                    api: LORA_API,
                    fileUrl: (p) => api.apiURL(`/bepic/lora/file?path=${q(p)}`),
                    notify: (m, sev) => notice(sev || "info", m),
                    sendToAgent,
                    isOpen: () => this.activeTab === key,
                    // A dataset picked inside the tab is what the tab is called from then on.
                    onDataset: (name) => { if (name && name !== rec.shownName) { rec.shownName = name; rec.name = name; this.vtRelabel(key, name); } },
                });
                if (rec.name) rec.editor.openDataset(rec.name); else rec.editor.refresh();
            },
            shown: (rec) => {
                // Back to the front: the lists are read again (a run may have come, a dataset may have changed).
                if (rec.seen && rec.editor) rec.editor.refresh();
                rec.seen = true;
            },
            isDirty: (rec) => !!(rec.editor && rec.editor.dirty),
            dirtyText: (rec) => `The dataset ${(rec.editor && rec.editor.name) || rec.name || ""} has edits that were not saved.`,
            dispose: (rec) => { if (rec.editor) rec.editor.dispose(); rec.editor = null; },
        };
    },

    /** The dataset tab that shows `name`, if one is open. */
    _loraTabFor(name) {
        return this.vtTabsOf("dataset").find((r) => (r.editor && r.editor.name === name) || r.name === name) || null;
    },

    /** Open a dataset by name or by the path of its manifest.json, in a tab of the main canvas. */
    async loraOpen(ref) {
        const name = datasetNameOf(ref);
        if (!name) return this.loraBarOpen();
        const have = this._loraTabFor(name);
        if (have) {
            this.vtOpen("dataset", have.key, name);
            // A tab already showing it reads it again, unless there are edits to protect.
            if (have.editor && !have.editor.dirty) have.editor.openDataset(name);
            return true;
        }
        this.vtOpen("dataset", LORA_PREFIX + name, name, { name, editor: null });
        return true;
    },

    /** The bar's "Dataset": a tab that is open, else one that lists the datasets. */
    loraBarOpen() {
        const open = this.vtTabsOf("dataset");
        const active = open.find((r) => r.key === this.activeTab) || open[0];
        if (active) { this.vtOpen("dataset", active.key, active.name || "Dataset"); return true; }
        this.vtOpen("dataset", LORA_PREFIX, "Dataset", { name: "", editor: null });
        return true;
    },
};

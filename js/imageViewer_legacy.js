// imageViewer_legacy.js    What is left of the viewer's old name
//
// Until 1.18 the viewer was called "bEpic" (bEpicViewer.js, bEpicSendToViewer,
// Settings → bEpic Viewer, localStorage "bepic.*"). Everything is called
// ComfyUI Image Viewer now; this module carries what a user saved under the old
// names over to the new ones, once, so nothing is lost:
//   - localStorage keys (moved, not copied: the viewer's state can be large);
//   - ComfyUI settings "bEpic.Viewer.*" and keybindings on "bEpic.*" commands;
//   - node types in a workflow as it loads (the server also still runs the old
//     ids, nodes.py LEGACY_NODE_IDS, for prompts that skip the page);
//   - window.bEpicViewerApi, for a page script that still looks for it.
// It is imported first by imageViewer.js, so the keys are moved before any
// other module reads them.

/** Old node type → new one (the same table as nodes.py LEGACY_NODE_IDS). */
export const LEGACY_NODE_TYPES = {
    bEpicSendToViewer:             "ImageViewerSend",
    bEpicImageViewerRoto:          "ImageViewerRoto",
    bEpicImageViewerSAM3Collector: "ImageViewerSAM3Collector",
    bEpicScene3D:                  "ImageViewerScene3D",
};

const OLD_SETTING = "bEpic.Viewer.";
const NEW_SETTING = "ImageViewer.";
const OLD_COMMANDS = { "bEpic.toggleViewer": "ImageViewer.toggleViewer",
                       "bEpic.sendSelectionToViewer": "ImageViewer.sendSelectionToViewer" };

/** The name a localStorage key has now, or null when it never had the old name. */
export function renamedStorageKey(key) {
    const k = String(key);
    if (k.startsWith("bEpicViewer")) return "imageViewer" + k.slice("bEpicViewer".length);
    if (/^bepic[.\-_]/.test(k)) return "imageviewer" + k.slice(5);
    return null;
}

/** Move every old localStorage key to its new name (a key already there wins). */
export function migrateStorage(store) {
    let moved = 0;
    try {
        const keys = [];
        for (let i = 0; i < store.length; i++) keys.push(store.key(i));
        for (const old of keys) {
            const now = renamedStorageKey(old);
            if (!now) continue;
            if (store.getItem(now) === null) { store.setItem(now, store.getItem(old)); moved++; }
            store.removeItem(old);
        }
    } catch (e) { console.warn("[ImageViewer] could not move the old localStorage keys:", e); }
    return moved;
}

/** The new command id for an old one, or the id unchanged. */
export function renamedCommandId(id) {
    const s = String(id || "");
    if (OLD_COMMANDS[s]) return OLD_COMMANDS[s];
    if (s.startsWith(OLD_SETTING)) return NEW_SETTING + s.slice(OLD_SETTING.length);
    return s;
}

/** Rename old node types in a workflow (and its subgraphs) in place; how many. */
export function renameLegacyNodes(graph) {
    let n = 0;
    const walk = (g) => {
        if (!g || typeof g !== "object") return;
        for (const node of Array.isArray(g.nodes) ? g.nodes : []) {
            const now = node && LEGACY_NODE_TYPES[node.type];
            if (now) { node.type = now; n++; }
        }
        for (const sub of g.definitions?.subgraphs || []) walk(sub);
    };
    walk(graph);
    return n;
}

/**
 * Carry ComfyUI settings saved under "bEpic.Viewer.*" over to "ImageViewer.*",
 * and keybindings on the old command ids to the new ones. `setting` is
 * app.extensionManager.setting ({ get, set }); ids are the new setting ids.
 */
export async function migrateSettings(setting, ids) {
    if (!setting || typeof setting.get !== "function") return 0;
    let n = 0;
    for (const id of ids || []) {
        if (!String(id).startsWith(NEW_SETTING)) continue;
        const old = OLD_SETTING + String(id).slice(NEW_SETTING.length);
        let was;
        try { was = setting.get(old); } catch (e) { continue; }
        if (was === undefined || was === null) continue;
        try { await setting.set(id, was); await setting.set(old, null); n++; } catch (e) {}
    }
    for (const list of ["Comfy.Keybinding.NewBindings", "Comfy.Keybinding.UnsetBindings"]) {
        let binds;
        try { binds = setting.get(list); } catch (e) { continue; }
        if (!Array.isArray(binds)) continue;
        let changed = false;
        const next = binds.map((b) => {
            const id = b && b.commandId;
            const now = renamedCommandId(id);
            if (!id || now === id) return b;
            changed = true;
            return { ...b, commandId: now };
        });
        if (changed) { try { await setting.set(list, next); n++; } catch (e) {} }
    }
    return n;
}

/** window.bEpicViewerApi keeps answering, as window.imageViewerApi. */
export function aliasOldApi(win) {
    try {
        if (!win || Object.getOwnPropertyDescriptor(win, "bEpicViewerApi")) return;
        Object.defineProperty(win, "bEpicViewerApi", {
            configurable: true,
            get() { return win.imageViewerApi; },
            set(v) { win.imageViewerApi = v; },
        });
    } catch (e) {}
}

try { if (typeof localStorage !== "undefined") migrateStorage(localStorage); } catch (e) {}
try { if (typeof window !== "undefined") aliasOldApi(window); } catch (e) {}

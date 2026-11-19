// imageViewer_paramLocks.js
// A lock on any parameter of the Parameters panel (Sebastian 2026-11-19).
//
// A locked parameter keeps its value: its field in the panel is greyed out,
// an edit made with several nodes selected passes it by, its keys cannot be
// set or removed, and its widget on the canvas is disabled as well. The locks
// live on the node, in `node.properties.imageviewer_locked` (a list of widget
// names), so they are saved with the workflow and come back with it
// (`applyWidgetLocks`, from the extension's loadedGraphNode).
import { app } from "../../scripts/app.js";

const PROP = "imageviewer_locked";

/** The names of a node's locked parameters. */
export function lockedNames(node) {
    const list = node && node.properties && node.properties[PROP];
    return Array.isArray(list) ? list.filter((n) => typeof n === "string") : [];
}

export function isParamLocked(node, name) {
    return lockedNames(node).includes(name);
}

/** Lock or unlock one parameter; the canvas widget follows. */
export function setParamLocked(node, name, on) {
    if (!node) return;
    const set = new Set(lockedNames(node));
    if (on) set.add(name); else set.delete(name);
    if (!node.properties) node.properties = {};
    if (set.size) node.properties[PROP] = [...set];
    else delete node.properties[PROP];
    applyWidgetLocks(node);
}

/**
 * The canvas widgets of a node as its locks say: a locked one disabled. Only
 * what a lock disabled is enabled again (`_ivLockDisabled`), so a widget that
 * was disabled for another reason stays so.
 */
export function applyWidgetLocks(node) {
    if (!node || !Array.isArray(node.widgets)) return;
    const locked = new Set(lockedNames(node));
    for (const w of node.widgets) {
        if (locked.has(w.name)) {
            if (!w.disabled) { w.disabled = true; w._ivLockDisabled = true; }
        } else if (w._ivLockDisabled) {
            w.disabled = false;
            delete w._ivLockDisabled;
        }
    }
    app.graph?.setDirtyCanvas?.(true, true);
}

export const ParamLocksMixin = {
    /** Is `name` locked on the node the panel shows (or `node`)? */
    paramLocked(name, node = null) {
        const n = node || app.graph?.getNodeById?.(this.currentParamNodeId);
        return isParamLocked(n, name);
    },

    paramToggleLock(name) {
        const node = app.graph?.getNodeById?.(this.currentParamNodeId);
        if (!node) return;
        setParamLocked(node, name, !isParamLocked(node, name));
        this.paramLocksDecorate();
        this.paramAnimDecorate?.();
    },

    /**
     * Give each row of the panel its padlock, and grey out the locked ones.
     * Runs after every rebuild (ParamsMixin.updateParamsPanel); the buttons are
     * made once per row and then only updated.
     */
    paramLocksDecorate() {
        const content = this.paramsContent;
        if (!content) return;
        const node = app.graph?.getNodeById?.(this.currentParamNodeId);
        if (!node) return;
        const locked = new Set(lockedNames(node));
        const doc = content.ownerDocument;
        for (const row of content.querySelectorAll(".param-row")) {
            const name = row.dataset.paramName;
            const on = locked.has(name);
            row.classList.toggle("param-locked", on);
            const label = row.querySelector(".param-label");
            let btn = label && label.querySelector(".param-lock");
            if (label && !btn) {
                btn = doc.createElement("button");
                btn.type = "button";
                btn.className = "param-lock";
                btn.onclick = (e) => {
                    e.preventDefault(); e.stopPropagation();
                    this.paramToggleLock(name);
                };
                label.appendChild(btn);
            }
            if (btn) {
                this._setIcon?.(btn, on ? "icon-lock" : "icon-unlock");
                btn.classList.toggle("on", on);
                btn.title = on ? `Unlock ${name}` : `Lock ${name}: keep its value`;
                btn.setAttribute("aria-pressed", on ? "true" : "false");
            }
            // The field: a lock disables it; unlocked it is as the panel built it
            // (a connected input stays disabled).
            for (const input of row.querySelectorAll("input, select, textarea")) {
                if (on) {
                    if (!input.disabled) { input.disabled = true; input.dataset.lockDisabled = "1"; }
                } else if (input.dataset.lockDisabled) {
                    input.disabled = false;
                    delete input.dataset.lockDisabled;
                }
            }
        }
    },
};

// imageViewer_paramsInstance.js
// One Parameters view. The FIRST one is the panel in imageViewer.html and stays the rendezvous it always was:
// a drawing tool, the Channel Box or a comp's node settings take its body over (ToolsMixin._toolShowDock,
// previzChannels._cbParams, compPanel._cpParams), and its state lives on the viewer. Every FURTHER one
// (Sebastian 2026-11-23: panels come in instances) is a node-parameters view of its own: it follows the canvas
// selection until its padlock pins it to a node, and its edits go to the node IT shows, not to the selection.
// The key bar, the animation decoration and the curves stay with the first one.
import { app } from "../../scripts/app.js";
import { isParamLocked } from "./imageViewer_paramLocks.js";

/** The input element for one widget; `apply(name, value)` writes the value where this view wants it. */
export function buildParamInput(w, node, isConnected, apply, doc, contentEl) {
    let input;

    if (w.type === "toggle" || w.type === "BOOLEAN") {
        input = doc.createElement("input");
        input.type    = "checkbox";
        input.checked = !!w.value;
        input.onchange = (e) => { apply(w.name, e.target.checked); };

    } else if (w.type === "combo" || (w.options && w.options.values)) {
        input = doc.createElement("select");
        input.className = "param-input";
        const frag = doc.createDocumentFragment();
        (w.options.values || []).forEach(o => {
            const opt = doc.createElement("option");
            opt.value = o; opt.innerText = o;
            if (o === w.value) opt.selected = true;
            frag.appendChild(opt);
        });
        input.appendChild(frag);
        input.onchange = (e) => { apply(w.name, e.target.value); };

    } else if (w.type === "number" || typeof w.value === "number") {
        input = doc.createElement("input");
        input.className = "param-input";
        input.type  = "number";
        input.value = w.value;
        if (w.options) {
            if (w.options.min  !== undefined) input.min  = w.options.min;
            if (w.options.max  !== undefined) input.max  = w.options.max;
            if (w.options.step !== undefined) input.step = w.options.step;
        }
        const intStep = w.options && Number.isInteger(w.options.step);
        input.oninput = (e) => {
            const val = intStep ? parseInt(e.target.value) : parseFloat(e.target.value);
            apply(w.name, val);
        };

    } else {
        const wantsMultiline = (w.options && w.options.multiline) ||
                               (typeof w.value === 'string' &&
                                (w.value.includes('\n') || w.value.length > 50));
        if (wantsMultiline) {
            input = doc.createElement("textarea");
            input.rows = 4;
        } else {
            input = doc.createElement("input");
            input.type = "text";
        }
        input.className = "param-input";
        input.value     = w.value != null ? w.value : "";
        input.oninput   = (e) => { apply(w.name, e.target.value); };

        if (typeof w.value === 'string') {
            const len = w.value.length;
            if (len > 100) {
                const maxW   = contentEl ? contentEl.clientWidth - 20 : null;
                let estWidth = Math.min(800, Math.max(200, len * 7));
                if (maxW && estWidth > maxW) estWidth = maxW;
                input.style.width = `${estWidth}px`;
            }
            if (input.tagName === 'TEXTAREA') {
                input.rows = Math.min(10, Math.max(4, w.value.split("\n").length));
            }
        }
    }

    if (isConnected) {
        input.disabled    = true;
        input.title       = "Controlled by input connection";
        input.style.opacity = "0.5";
    }

    return input;
}

/**
 * Make a Parameters view in `host` with its own pin and text sizes. `saved` is what a layout carried for it.
 * Returns the instance the dock keeps; the viewer's selection monitor calls tick() on it every frame.
 */
export function createParamsInstance(v, host, st, saved) {
    const doc = host.ownerDocument;
    st.locked = !!(saved && saved.locked);
    st.nodeId = (saved && saved.nodeId) || null;
    st.textSizes = {};
    st.observers = [];

    const header = doc.createElement("div");
    header.className = "params-header";
    const title = doc.createElement("span");
    title.className = "params-title";
    title.textContent = "No Node Selected";
    const lock = doc.createElement("button");
    lock.className = "params-lock-btn sprite-icon";
    header.append(title, lock);
    const content = doc.createElement("div");
    content.className = "params-content";
    host.append(header, content);

    const syncLock = () => {
        if (v._setIcon) v._setIcon(lock, st.locked ? "icon-lock" : "icon-unlock");
        lock.style.color = st.locked ? "#f60" : "";
        lock.title = st.locked ? "Unlock – follow canvas selection" : "Lock – freeze to currently selected node";
        lock.classList.toggle("locked", st.locked);
    };
    lock.onclick = () => {
        st.locked = !st.locked;
        syncLock();
        if (!st.locked) tick();
        v.queuePersistViewerState && v.queuePersistViewerState();
    };
    syncLock();

    /** The node this view shows: its pin while locked, else the canvas selection (or the tab's fallback). */
    function targetNode() {
        if (st.locked) return st.nodeId;
        const selected = (app && app.canvas) ? app.canvas.selected_nodes : null;
        if (selected && Object.keys(selected).length) {
            const ids = Object.keys(selected);
            return ids[ids.length - 1];
        }
        return v._resolveFallbackParamNodeId ? v._resolveFallbackParamNodeId() : null;
    }

    function apply(name, value) {
        const n = app.graph.getNodeById(st.nodeId);
        if (!n || isParamLocked(n, name)) return;
        if (v.paramAnimApply && v.paramAnimApply(n, name, value)) return;
        const w = n.widgets && n.widgets.find(x => x.name === name);
        if (w) { w.value = value; w.callback?.(w.value); }
        app.graph.setDirtyCanvas(true, true);
    }

    function rebuild() {
        const node = app.graph.getNodeById(st.nodeId);
        try { st.observers.forEach(o => o.disconnect()); } catch (e) {}
        st.observers = [];
        if (!node) {
            title.textContent = "No Node Selected";
            content.innerHTML = "";
            return;
        }
        title.textContent = node.title || node.type;
        const frag = doc.createDocumentFragment();
        (node.widgets || []).forEach(w => {
            if (w.type === "button" || w.hidden) return;
            const row = doc.createElement("div");
            row.className = "param-row";
            row.dataset.paramName = w.name;
            const label = doc.createElement("div");
            label.className = "param-label";
            label.innerText = w.name;
            row.appendChild(label);
            const isConnected = node.inputs && node.inputs.some(i => i.name === w.name && i.link != null);
            const input = buildParamInput(w, node, isConnected, apply, doc, content);
            const stored = st.textSizes[node.id] && st.textSizes[node.id][w.name];
            if (stored) {
                const maxW = content.clientWidth - 20;
                if (stored.width > 0) input.style.width = Math.min(stored.width, maxW || stored.width) + "px";
                if (input.tagName === "TEXTAREA" && stored.height > 20) input.style.height = stored.height + "px";
            }
            if (input.tagName === "TEXTAREA" || input.type === "text") {
                try {
                    const ro = new ResizeObserver(entries => {
                        for (const ent of entries) {
                            const rect = ent.target.getBoundingClientRect();
                            if (rect.width <= 0 || rect.height <= 0) continue;
                            if (!st.textSizes[node.id]) st.textSizes[node.id] = {};
                            st.textSizes[node.id][w.name] = { width: Math.round(rect.width), height: Math.round(rect.height) };
                        }
                    });
                    ro.observe(input);
                    st.observers.push(ro);
                } catch (e) { /* ResizeObserver unavailable */ }
            }
            row.appendChild(input);
            frag.appendChild(row);
        });
        content.innerHTML = "";
        content.appendChild(frag);
    }

    /** Every frame of the viewer's selection monitor: follow the selection unless pinned. */
    function tick() {
        const id = targetNode();
        if (id === st.nodeId) return;
        st.nodeId = id;
        rebuild();
    }

    if (st.nodeId) rebuild();

    return {
        el: host,
        tick,
        wake() { if (st.locked) rebuild(); else { st.nodeId = null; tick(); } },
        save() { return { locked: st.locked, nodeId: st.nodeId }; },
        dispose() { try { st.observers.forEach(o => o.disconnect()); } catch (e) {} st.observers = []; },
    };
}
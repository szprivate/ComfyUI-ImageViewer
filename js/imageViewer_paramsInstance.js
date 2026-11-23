// imageViewer_paramsInstance.js
// One Parameters view. The FIRST one is the panel in imageViewer.html and stays the rendezvous it always was:
// a drawing tool, the Channel Box or a comp's node settings take its body over (ToolsMixin._toolShowDock,
// previzChannels._cbParams, compPanel._cpParams), and its state lives on the viewer. Every FURTHER one
// (Sebastian 2026-11-23: panels come in instances) shows what the space shows — the Channel Box on a 3D tab,
// the comp's node properties on a Comp tab, ComfyUI's node widgets on the Viewer — and its padlock pins it to
// the selection it had when locked. The Channel Box is the viewer's own, driven through a context of this
// instance's (its selection, its body); the comp's properties are the editor's, rendered into this view
// (editor.renderPropsInto / addPropsView). A drawing tool's options are one body for the one tool: they stay
// with the first panel, and this one says so.
import { app } from "../../scripts/app.js";
import { isParamLocked } from "./imageViewer_paramLocks.js";
import * as S from "./imageViewer_scene3d.js";

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
 * Make a Parameters view in `host`. `saved` is what a layout carried for it ({locked, pin}).
 * Returns the instance the dock keeps; the viewer's selection monitor calls tick() on it every frame.
 */
export function createParamsInstance(v, host, st, saved, id) {
    const doc = host.ownerDocument;
    st.instId = id;
    st.locked = !!(saved && saved.locked);
    st.pin = (saved && saved.pin) || {};
    st.mode = null;
    st.targetKey = null;
    st.textSizes = {};
    st.observers = [];
    let cbCtx = null, propsFn = null, propsEd = null;

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
        lock.title = st.locked ? "Unlock – follow the selection again" : "Lock – freeze to the current selection";
        lock.classList.toggle("locked", st.locked);
    };
    lock.onclick = () => {
        st.locked = !st.locked;
        if (st.locked) {
            const m = currentMode();
            st.pin = m === "cb" ? { itemId: (v.previzSelectedIds() || []).slice(-1)[0] || null }
                : m === "comp" ? { compIds: compEditor() ? compEditor().selection() : [] }
                : { nodeId: st.nodeId || null };
        }
        syncLock();
        st.mode = null; st.targetKey = null;
        tick();
        v.queuePersistViewerState && v.queuePersistViewerState();
    };
    syncLock();

    // ── What this view shows now ─────────────────────────────────────────────

    const currentMode = () => (v._cpParamsMode ? "comp" : v._cbParamsMode ? "cb" : v._paramsToolMode ? "tool" : "node");
    const compEditor = () => { const rec = v._cpActive && v._cpActive(); return rec && rec.editor; };

    function nodeTarget() {
        if (st.locked) return st.pin.nodeId || null;
        const selected = (app && app.canvas) ? app.canvas.selected_nodes : null;
        if (selected && Object.keys(selected).length) {
            const ids = Object.keys(selected);
            return ids[ids.length - 1];
        }
        return v._resolveFallbackParamNodeId ? v._resolveFallbackParamNodeId() : null;
    }

    function targetKey(m) {
        if (m === "node") return "node:" + (nodeTarget() || "");
        if (m === "cb") return "cb:" + (st.locked ? (st.pin.itemId || "") : (v.previzSelectedIds() || []).join(","));
        if (m === "comp") {
            const ed = compEditor();
            return "comp:" + (st.locked ? (st.pin.compIds || []).join(",") : ed ? ed.selection().join(",") : "");
        }
        return "tool";
    }

    function teardown() {
        try { st.observers.forEach(o => o.disconnect()); } catch (e) {}
        st.observers = [];
        if (propsFn && propsEd) { try { propsEd.removePropsView(propsFn); } catch (_) { /* gone */ } }
        propsFn = null; propsEd = null;
        cbCtx = null;
        content.replaceChildren();
    }

    // ── ComfyUI node widgets ─────────────────────────────────────────────────

    function applyToNode(name, value) {
        const n = app.graph.getNodeById(st.nodeId);
        if (!n || isParamLocked(n, name)) return;
        if (v.paramAnimApply && v.paramAnimApply(n, name, value)) return;
        const w = n.widgets && n.widgets.find(x => x.name === name);
        if (w) { w.value = value; w.callback?.(w.value); }
        app.graph.setDirtyCanvas(true, true);
    }

    function rebuildNode() {
        const node = app.graph.getNodeById(st.nodeId);
        if (!node) {
            title.textContent = "No Node Selected";
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
            const input = buildParamInput(w, node, isConnected, applyToNode, doc, content);
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
        content.appendChild(frag);
    }

    // ── The Channel Box, through a context of this instance's ────────────────
    // The viewer's own Channel Box machinery (previzChannels) reads the selection and writes through it;
    // this context answers with THIS view's item (its pin while locked) and builds into THIS view's body,
    // so every row, scrub and key acts on the item shown here.
    function rebuildCb() {
        title.textContent = "Parameters";
        const ctx = Object.create(v);
        ctx._isParamsCtx = true;
        ctx.channelsPanel = content;
        ctx.isPanelDocked = (id) => v.isPanelDocked(id === "params" ? st.instId : id);
        ctx.previzSelectedIds = () => (st.locked ? (st.pin.itemId ? [st.pin.itemId] : []) : v.previzSelectedIds());
        ctx.previzSelectedItem = () => {
            const ids = ctx.previzSelectedIds();
            return ids.length ? S.itemById(v.previzScene(), ids[ids.length - 1]) : null;
        };
        cbCtx = ctx;
        v._cbBuild.call(ctx);
        v._previzRenderChannels.call(ctx);
    }

    // ── The comp's node properties ───────────────────────────────────────────

    function rebuildComp() {
        const ed = compEditor();
        if (!ed || !ed.renderPropsInto) {
            title.textContent = "Comp";
            const n = doc.createElement("div");
            n.className = "mg-note";
            n.textContent = "The comp's node properties are in the first Parameters panel.";
            content.append(n);
            return;
        }
        const ids = st.locked ? (st.pin.compIds || []) : null;
        const draw = () => {
            const shown = st.locked ? (st.pin.compIds || []) : null;
            ed.renderPropsInto(content, shown);
            const first = content.querySelector(".cp-pane .cp-panename");
            title.textContent = first ? (first.value || "Comp") : "Comp";
        };
        draw();
        propsEd = ed;
        propsFn = draw;
        ed.addPropsView(propsFn);
    }

    function rebuild() {
        teardown();
        const m = currentMode();
        // A lock holds what was selected in the mode it was taken in; another mode starts following again.
        if (st.locked) {
            const has = m === "cb" ? st.pin.itemId : m === "comp" ? (st.pin.compIds || []).length : m === "node" ? st.pin.nodeId : false;
            if (!has) { st.locked = false; syncLock(); }
        }
        st.mode = m;
        if (m === "node") { st.nodeId = nodeTarget(); rebuildNode(); }
        else if (m === "cb") rebuildCb();
        else if (m === "comp") rebuildComp();
        else {
            title.textContent = "Tool options";
            const n = doc.createElement("div");
            n.className = "mg-note";
            n.textContent = "The drawing tool's options are in the first Parameters panel.";
            content.append(n);
        }
    }

    /** Every frame of the viewer's selection monitor: follow the selection unless pinned. */
    function tick() {
        const m = currentMode();
        const key = targetKey(m);
        if (m === st.mode && key === st.targetKey) return;
        st.targetKey = key;
        rebuild();
    }

    return {
        el: host,
        tick,
        /** The Channel Box's values move with playback and edits: the viewer's render fans out here. */
        cbRefresh() { if (st.mode === "cb" && cbCtx) v._previzRenderChannels.call(cbCtx); },
        wake() { st.mode = null; st.targetKey = null; tick(); },
        save() { return { locked: st.locked, pin: st.pin }; },
        dispose() { teardown(); },
    };
}
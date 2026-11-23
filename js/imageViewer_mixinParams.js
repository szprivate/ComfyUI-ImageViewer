// imageViewer_mixinParams.js
// Parameters panel: rendering node widgets, monitoring canvas selection. The panel comes in instances
// (imageViewer_paramsInstance.js): this one stays the timeshare slot it always was (tools, Channel Box and
// comp settings take its body over); every further one is a node view of its own, pinned by its own padlock.
import { app } from "../../scripts/app.js";
import { isParamLocked } from "./imageViewer_paramLocks.js";
import { createParamsInstance, buildParamInput } from "./imageViewer_paramsInstance.js";

export const ParamsMixin = {

    _resolveFallbackParamNodeId() {
        try {
            const toExistingNodeId = (val) => {
                if (val === null || val === undefined) return null;
                const asNum = Number(val);
                if (Number.isFinite(asNum) && app?.graph?.getNodeById?.(asNum)) return String(asNum);
                const asStr = String(val);
                if (app?.graph?.getNodeById?.(asStr)) return asStr;
                return null;
            };

            if (this.activeTab && this.tabSourceNodeIds && Object.prototype.hasOwnProperty.call(this.tabSourceNodeIds, this.activeTab)) {
                const mapped = toExistingNodeId(this.tabSourceNodeIds[this.activeTab]);
                if (mapped) return mapped;
            }

            if (this.activeTab && this.activeTab.startsWith('send_')) {
                const direct = this.activeTab.replace('send_', '').trim();
                const id = toExistingNodeId(direct);
                if (id) return id;
            }

            if (this.viewerNode && this.viewerNode.id != null) {
                const id = toExistingNodeId(this.viewerNode.id);
                if (id) return id;
            }

            if (this.activeTab) {
                const id = toExistingNodeId(this.activeTab);
                if (id) return id;
            }
        } catch (e) { /* ignore */ }

        return null;
    },

    toggleParamsLock() {
        this.paramsLocked = !this.paramsLocked;
        // Unlocked, catch up with whatever was selected meanwhile: the tool
        // follows the selection again, and rebinds to a node picked while held.
        if (!this.paramsLocked) { this._toolFollowSig = null; this._toolSelSig = null; }
        if (this.paramsLockBtn) {
            this._setIcon(this.paramsLockBtn, this.paramsLocked ? 'icon-lock' : 'icon-unlock');
            this.paramsLockBtn.style.color = this.paramsLocked ? '#f60' : '';
            this.paramsLockBtn.title = this.paramsLocked
                ? 'Unlock – follow canvas selection'
                : 'Lock – freeze to currently selected node';
        }
    },

    applyToSelectedNodes(name, value) {
        if (!this.selectedNodeIds) return;
        this.selectedNodeIds.forEach(id => {
            const n = app.graph.getNodeById(id);
            // A locked parameter keeps its value (imageViewer_paramLocks.js).
            if (!n || isParamLocked(n, name)) return;
            // An animated parameter takes the value as a key at this frame
            // (ParamAnimMixin), not into its widget.
            if (n && this.paramAnimApply && this.paramAnimApply(n, name, value)) return;
            if (n && n.widgets) {
                const w = n.widgets.find(x => x.name === name);
                if (w) { w.value = value; w.callback?.(w.value); }
            }
        });
        app.graph.setDirtyCanvas(true, true);
    },

    saveCurrentParamSizes() {
        if (!this.currentParamNodeId || !this.paramsContent) return;
        const nodeId = this.currentParamNodeId;
        const maxW   = this.paramsContent.clientWidth - 20;
        this.paramsContent.querySelectorAll('.param-row').forEach(r => {
            const name  = r.dataset.paramName;
            if (!name) return;
            const input = r.querySelector('textarea.param-input');
            if (!input) return;
            const rect = input.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return;
            let wval = Math.round(rect.width);
            if (maxW && wval > maxW) wval = maxW;
            if (!this.paramTextSizes[nodeId]) this.paramTextSizes[nodeId] = {};
            this.paramTextSizes[nodeId][name] = { width: wval, height: Math.round(rect.height) };
        });
    },

    updateParamsHeader() {
        if (this._paramsToolMode) return;        // the header names the tool
        const node = app.graph.getNodeById(this.currentParamNodeId);
        if (!node) return;
        const title = node.title || node.type;
        if (this.selectedNodeIds && this.selectedNodeIds.length > 1) {
            // textContent + an element, never innerHTML: a node title is whatever
            // the workflow file (or the agent) said, and this page holds tokens.
            this.paramsTitle.textContent = title;
            const count = document.createElement("span");
            count.style.cssText = "color:#f60;font-weight:bold;margin-left:5px;";
            count.textContent = `[${this.selectedNodeIds.length}]`;
            this.paramsTitle.appendChild(document.createTextNode(" "));
            this.paramsTitle.appendChild(count);
        } else {
            this.paramsTitle.innerText = title;
        }
    },

    // ── Canvas selection monitor ─────────────────────────────────────────────
    // Uses rAF instead of setInterval so it runs at display rate and doesn't
    // compete with layout work during idle cycles.

    startParamMonitor() {
        // Further Parameters views: each follows the selection until its own padlock pins it to a node.
        this._dockMakers().params = (v, id, saved) => {
            const d = (v._dockRootEl && v._dockRootEl.ownerDocument) || (v.paramsPanel && v.paramsPanel.ownerDocument) || document;
            const host = d.createElement("div");
            host.className = "params-panel";
            return createParamsInstance(v, host, {}, saved, id);
        };
        let running = true;
        const tick  = () => {
            if (!running) return;
            requestAnimationFrame(tick);

            // A selected Roto / SAM3 Collector node brings its tool up, panel
            // open or not (ToolsMixin._toolFollowSelection).
            try { this._toolFollowSelection?.(app?.canvas?.selected_nodes); }
            catch (e) { console.warn("imageViewer: tool selection follow failed", e); }

            // The instances follow the selection on their own, whatever mode this panel is in.
            if (this._dockInstancesOf) {
                for (const { inst } of this._dockInstancesOf("params")) {
                    try { inst.tick(); } catch (e) { console.warn("imageViewer: a parameters instance failed to follow", e); }
                }
            }

            if (!this.isPanelDocked || !this.isPanelDocked("params")) return;
            // A drawing tool has the panel (ToolsMixin._toolShowDock).
            if (this.paramsLocked || this._paramsToolMode || this._cpParamsMode || this._cbParamsMode) return;

            const selected = (app && app.canvas) ? app.canvas.selected_nodes : null;
            // If there's no canvas selection available (standalone viewer page),
            // try to fall back to the active tab or the last viewer node so
            // parameters are still displayed when opened via the /imageviewer URL.
            if ((!selected || Object.keys(selected).length === 0)) {
                const fallbackNodeId = this._resolveFallbackParamNodeId();

                if (!fallbackNodeId) {
                    if (this.currentParamNodeId !== null) {
                        this.saveCurrentParamSizes();
                        try { this.paramResizeObservers.forEach(o => o.disconnect()); } catch (e) {}
                        this.paramResizeObservers       = [];
                        this.currentParamNodeId         = null;
                        this.selectedNodeIds            = [];
                        this.paramsTitle.innerText      = "No Node Selected";
                        this.paramsContent.innerHTML    = "";
                        this.keyBarSync?.();
                        this.paramRefreshCurves?.();
                    }
                    return;
                }

                // Simulate a single selection using the fallback node id
                const ids = [fallbackNodeId];
                const nodeId = ids[ids.length - 1];
                const prevCount = this.selectedNodeIds ? this.selectedNodeIds.length : 0;
                this.selectedNodeIds = ids;

                if (this.currentParamNodeId !== nodeId) {
                    this.currentParamNodeId = nodeId;
                    this.updateParamsPanel(true);
                } else if (ids.length !== prevCount) {
                    this.updateParamsHeader();
                }

                return;
            }

            const ids    = Object.keys(selected);
            const nodeId = ids[ids.length - 1];
            const prevCount = this.selectedNodeIds ? this.selectedNodeIds.length : 0;
            this.selectedNodeIds = ids;

            if (this.currentParamNodeId !== nodeId) {
                this.currentParamNodeId = nodeId;
                this.updateParamsPanel(true);
            } else if (ids.length !== prevCount) {
                this.updateParamsHeader();
            }
        };
        requestAnimationFrame(tick);
        // Expose a way to stop the monitor if ever needed
        this._stopParamMonitor = () => { running = false; };
    },

    // ── Panel rebuild ────────────────────────────────────────────────────────

    updateParamsPanel(fullRebuild = false) {
        const node = app.graph.getNodeById(this.currentParamNodeId);
        if (!node) return;

        this.updateParamsHeader();
        if (!fullRebuild) return;

        // Disconnect previous observers
        try { this.paramResizeObservers.forEach(o => o.disconnect()); } catch (e) {}
        this.paramResizeObservers = [];

        const frag = document.createDocumentFragment();
        if (node.widgets) {
            node.widgets.forEach(w => {
                // Hidden ones too, as on the canvas: a Roto / SAM3 node's stores
                // (roto_data, sam3_*) are the tools' business, not the user's.
                if (w.type === "button" || w.hidden) return;

                const row = document.createElement("div");
                row.className       = "param-row";
                row.dataset.paramName = w.name;

                const label = document.createElement("div");
                label.className  = "param-label";
                label.innerText  = w.name;
                row.appendChild(label);

                const isConnected = node.inputs && node.inputs.some(i => i.name === w.name && i.link != null);
                const input = this._buildParamInput(w, node, isConnected);

                // Restore saved size
                try {
                    const stored = this.paramTextSizes[node.id] && this.paramTextSizes[node.id][w.name];
                    if (stored) {
                        const maxW = this.paramsContent ? this.paramsContent.clientWidth - 20 : null;
                        if (stored.width > 0) {
                            let wval = stored.width;
                            if (maxW && wval > maxW) wval = maxW;
                            input.style.width = wval + "px";
                        }
                        if (input.tagName === 'TEXTAREA' && stored.height > 20) {
                            input.style.height = stored.height + "px";
                        }
                    }
                } catch (e) { /* ignore */ }

                // Observe resize on text controls
                const isTextControl = input.tagName === 'TEXTAREA' || input.type === 'text';
                if (isTextControl) {
                    try {
                        const ro = new ResizeObserver(entries => {
                            for (const ent of entries) {
                                const rect = ent.target.getBoundingClientRect();
                                if (rect.width <= 0 || rect.height <= 0) continue;
                                if (!this.paramTextSizes[node.id]) this.paramTextSizes[node.id] = {};
                                this.paramTextSizes[node.id][w.name] = { width: Math.round(rect.width), height: Math.round(rect.height) };
                            }
                        });
                        ro.observe(input);
                        this.paramResizeObservers.push(ro);
                    } catch (e) { /* ResizeObserver unavailable */ }

                    input.addEventListener('mouseup', () => {
                        const rect = input.getBoundingClientRect();
                        if (rect.width <= 0 || rect.height <= 0) return;
                        if (!this.paramTextSizes[node.id]) this.paramTextSizes[node.id] = {};
                        this.paramTextSizes[node.id][w.name] = { width: Math.round(rect.width), height: Math.round(rect.height) };
                    });
                }

                row.appendChild(input);
                frag.appendChild(row);
            });
        }

        this.paramsContent.innerHTML = '';
        this.paramsContent.appendChild(frag);
        // Key toggles and values at the frame for an animatable node; the key
        // bar, the timeline ticks and the curves follow the node shown.
        this.paramAnimDecorate?.();
        // A padlock on every row; a locked one greyed out (imageViewer_paramLocks.js).
        this.paramLocksDecorate?.();
        this.keyBarSync?.();
        this.paramRefreshCurves?.();
    },

    // Build the appropriate input element for a given widget (shared with the instances; this one's edits
    // go to the canvas selection).
    _buildParamInput(w, node, isConnected) {
        return buildParamInput(w, node, isConnected,
            (name, value) => this.applyToSelectedNodes(name, value), document, this.paramsContent);
    },
};

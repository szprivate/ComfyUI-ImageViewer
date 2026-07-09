// bEpicViewer_tools.js
// ToolsMixin — the in-viewer editing tools layer shared by the Roto and
// SAM3-points tools, plus the full SAM3 points tool implementation.
//
// Responsibilities:
//   * Build a tool overlay (an aligned <svg> for coordinate mapping + a
//     screen-space <svg> for drawing handles) and a small toolbar/panel.
//   * Map between normalized image coords ([0,1]) and screen coords using the
//     reference svg's getScreenCTM(), so zoom/pan/fit are handled for free.
//   * Bind the active viewer tab to its source bEpicSendToViewer node and
//     load/save tool data through that node's hidden widgets.
//   * Implement the SAM3 points tool end-to-end.
//
// The Roto tool lives in bEpicViewer_roto.js and plugs into the hooks here
// (_rotoActivate / _rotoDeactivate / _rotoRender / _rotoPointerDown / ...).

import {
    resolveSendNodeForTab,
    readToolStore,
    writeToolStore,
    SAM3_POS_WIDGET,
    SAM3_NEG_WIDGET,
} from "./bEpicViewer_nodeTools.js";

const SVGNS = "http://www.w3.org/2000/svg";

export function svgEl(tag, attrs) {
    const el = document.createElementNS(SVGNS, tag);
    if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
}

function elWith(tag, props, style) {
    const el = document.createElement(tag);
    if (props) Object.assign(el, props);
    if (style) Object.assign(el.style, style);
    return el;
}

export const ToolsMixin = {

    // ── bootstrap ────────────────────────────────────────────────────────────
    _initTools() {
        this._toolState = { active: "none", node: null };
        this._sam3 = { pos: [], neg: [], drag: null, hover: null };

        this._injectToolStyles();
        this._buildToolOverlay();
        this._buildToolbar();
        this._wireToolPointer();

        // Roto mixin one-time setup (state containers).
        this._rotoInit?.();

        // Keep the overlay aligned when the viewport resizes.
        try {
            this._toolResizeObs = new ResizeObserver(() => this.updateToolOverlay());
            this._toolResizeObs.observe(this.viewport);
        } catch (e) {}

        this.setActiveTool("none");
    },

    _injectToolStyles() {
        if (this.shadowRoot.getElementById("bepic-tool-style")) return;
        const s = document.createElement("style");
        s.id = "bepic-tool-style";
        s.textContent = `
            #bepic-tool-ref { position:absolute; top:0; left:0; pointer-events:none;
                z-index:40; overflow:visible; opacity:0; }
            #bepic-tool-draw { position:absolute; inset:0; z-index:41;
                pointer-events:none; overflow:visible; }
            #bepic-tool-draw.active { pointer-events:auto; }
            /* While a tool is on, stop the viewport's grab/grabbing hand from
               bleeding through (esp. the :active grabbing cursor during drags). */
            .viewport.bepic-tool-on, .viewport.bepic-tool-on:active { cursor:default; }
            .bepic-toolbar { position:absolute; top:44px; left:8px; z-index:60;
                display:flex; flex-direction:column; gap:4px; }
            .bepic-toolbar button { width:30px; height:30px; border:1px solid #444;
                background:rgba(24,24,24,.9); color:#ccc; border-radius:4px;
                cursor:pointer; font-size:15px; line-height:1; padding:0;
                display:flex; align-items:center; justify-content:center; }
            .bepic-toolbar button:hover { background:#333; color:#fff; }
            .bepic-toolbar button.active { color:#f60; border-color:#f60; }
            .bepic-tool-panel { position:absolute; top:44px; left:46px; z-index:60;
                min-width:190px; max-width:230px; background:rgba(20,20,20,.94);
                border:1px solid #444; border-radius:6px; padding:8px;
                color:#ddd; font-family:sans-serif; font-size:12px; display:none; }
            .bepic-tool-panel.show { display:block; }
            .bepic-tool-panel h4 { margin:0 0 6px; font-size:12px; color:#f60;
                text-transform:uppercase; letter-spacing:.4px; }
            .bepic-tool-panel .row { display:flex; align-items:center;
                justify-content:space-between; gap:6px; margin:4px 0; }
            .bepic-tool-panel .row label { color:#aaa; flex:0 0 auto; }
            .bepic-tool-panel input[type=range] { flex:1; min-width:0; }
            .bepic-tool-panel input[type=number] { width:52px; background:#111;
                color:#0ce; border:1px solid #444; border-radius:3px; }
            .bepic-tool-panel button.bepic-act { width:100%; margin-top:4px;
                padding:5px; background:#2a2a2a; color:#ddd; border:1px solid #555;
                border-radius:4px; cursor:pointer; }
            .bepic-tool-panel button.bepic-act:hover { background:#3a3a3a; }
            .bepic-tool-panel button.bepic-danger:hover { background:#5a2020;
                border-color:#a33; color:#fff; }
            .bepic-tool-hint { color:#888; font-size:11px; margin-top:6px;
                line-height:1.35; }
            .bepic-tool-disabled { opacity:.45; }
            .bepic-layer-list { max-height:150px; overflow:auto; margin:4px 0;
                border:1px solid #333; border-radius:4px; }
            .bepic-layer-row { display:flex; align-items:center; gap:4px;
                padding:3px 5px; cursor:pointer; border-bottom:1px solid #262626; }
            .bepic-layer-row.sel { background:#3a2a10; }
            .bepic-layer-row .nm { flex:1; overflow:hidden; text-overflow:ellipsis;
                white-space:nowrap; }
            .bepic-layer-row .vis { cursor:pointer; opacity:.85; }
            .bepic-layer-row .del { cursor:pointer; color:#c66; }
        `;
        this.shadowRoot.appendChild(s);
    },

    _buildToolOverlay() {
        // Reference svg (aligned to the drawn image) used only for coord mapping.
        this._toolRef = svgEl("svg", { id: "bepic-tool-ref", preserveAspectRatio: "none" });
        // Inner <g> lives in the viewBox (image-pixel) coordinate system; its
        // getScreenCTM() unambiguously includes the viewBox transform.
        this._toolRefG = svgEl("g");
        this._toolRef.appendChild(this._toolRefG);
        // Screen-space svg where all handles/shapes are drawn.
        this._toolDraw = svgEl("svg", { id: "bepic-tool-draw" });
        this.viewport.appendChild(this._toolRef);
        this.viewport.appendChild(this._toolDraw);
        this._toolDrawRect = null;
    },

    _buildToolbar() {
        const bar = elWith("div", { className: "bepic-toolbar" });
        const mk = (tool, glyph, title) => {
            const b = elWith("button", { title, textContent: glyph });
            b.dataset.tool = tool;
            b.onclick = () => this.setActiveTool(this._toolState.active === tool ? "none" : tool);
            bar.appendChild(b);
            return b;
        };
        this._toolBtns = {
            roto: mk("roto", "✎", "Roto tool"),
            sam3: mk("sam3", "◉", "SAM3 points tool"),
        };
        this.viewport.appendChild(bar);
        this._toolbar = bar;

        this._toolPanel = elWith("div", { className: "bepic-tool-panel" });
        this.viewport.appendChild(this._toolPanel);
    },

    // ── geometry / mapping ────────────────────────────────────────────────────
    _toolImgSize() {
        const w = this.imgBase?.naturalWidth || 0;
        const h = this.imgBase?.naturalHeight || 0;
        return { w, h };
    },

    // Keep the reference svg aligned to the drawn image (mirrors #img-frame).
    updateToolOverlay() {
        const ref = this._toolRef, draw = this._toolDraw, f = this.imgFrame;
        if (!ref || !draw) return;
        const { w, h } = this._toolImgSize();
        const usable = f && f.style.display !== "none" && w > 0 && h > 0
            && this.sliderMode !== "contact";
        if (!usable) {
            ref.style.display = "none";
            if (this._toolState.active !== "none") this._toolClearDraw();
            return;
        }
        ref.style.display = "block";
        ref.style.left = f.style.left;
        ref.style.top = f.style.top;
        ref.style.width = f.style.width;
        ref.style.height = f.style.height;
        ref.style.transform = f.style.transform || "";
        ref.setAttribute("viewBox", `0 0 ${w} ${h}`);

        this._toolDrawRect = draw.getBoundingClientRect();
        this._toolRedraw();
    },

    _refCTM() {
        try { return this._toolRefG.getScreenCTM(); } catch (e) { return null; }
    },

    // normalized [0,1] -> client px
    _normToClient(nx, ny) {
        const ctm = this._refCTM();
        const { w, h } = this._toolImgSize();
        if (!ctm || !w || !h) return null;
        const p = this._toolRef.createSVGPoint();
        p.x = nx * w; p.y = ny * h;
        const s = p.matrixTransform(ctm);
        return { x: s.x, y: s.y };
    },

    // client px -> normalized [0,1]
    _clientToNorm(cx, cy) {
        const ctm = this._refCTM();
        const { w, h } = this._toolImgSize();
        if (!ctm || !w || !h) return null;
        const p = this._toolRef.createSVGPoint();
        p.x = cx; p.y = cy;
        const u = p.matrixTransform(ctm.inverse());
        return { x: u.x / w, y: u.y / h };
    },

    // normalized -> local coords of the draw svg (for placing elements)
    _normToDraw(nx, ny) {
        const c = this._normToClient(nx, ny);
        if (!c) return null;
        const r = this._toolDrawRect || (this._toolDrawRect = this._toolDraw.getBoundingClientRect());
        return { x: c.x - r.left, y: c.y - r.top };
    },

    _eventToNorm(e) {
        return this._clientToNorm(e.clientX, e.clientY);
    },

    // Screen-px distance between two normalized points.
    _screenDist(nA, nB) {
        const a = this._normToClient(nA.x, nA.y);
        const b = this._normToClient(nB.x, nB.y);
        if (!a || !b) return Infinity;
        return Math.hypot(a.x - b.x, a.y - b.y);
    },

    // ── tool activation ───────────────────────────────────────────────────────
    _toolActive() {
        return this._toolState.active !== "none"
            && !!this._toolState.node
            && !this.isComparing
            && this.sliderMode !== "contact";
    },

    setActiveTool(tool) {
        const prev = this._toolState.active;
        if (prev === "roto" && tool !== "roto") this._rotoDeactivate?.();
        this._toolState.active = tool;

        for (const k in this._toolBtns) this._toolBtns[k].classList.toggle("active", k === tool);
        this._toolDraw.classList.toggle("active", tool !== "none");
        this._updateToolCursor();

        this._bindToolsToActiveTab();

        // Panel content
        this._toolPanel.classList.toggle("show", tool !== "none");
        if (tool === "sam3") this._sam3BuildPanel();
        else if (tool === "roto") this._rotoActivate?.(this._toolPanel);
        else this._toolPanel.innerHTML = "";

        this.updateToolOverlay();
    },

    // Cursor while a tool is active: arrow for roto (all modes), crosshair for
    // point placing. The bepic-tool-on class also suppresses the viewport grab.
    _updateToolCursor() {
        const active = this._toolState.active;
        this.viewport.classList.toggle("bepic-tool-on", active !== "none");
        let c = "default";
        if (active === "sam3") c = "crosshair";
        this._toolDraw.style.cursor = c;
    },

    // Bind the current active tab to its send-node and load tool data.
    _bindToolsToActiveTab() {
        const node = resolveSendNodeForTab(this, this.activeTab);
        this._toolState.node = node;
        if (node) {
            this._sam3Load(node);
            this._rotoLoadFromNode?.(node);
        } else {
            this._sam3 = { pos: [], neg: [], drag: null, hover: null };
            this._rotoClearState?.();
        }
        // Reflect availability
        const disabled = !node;
        this._toolPanel.classList.toggle("bepic-tool-disabled", disabled);
        this._toolRedraw();
    },

    _toolClearDraw() {
        while (this._toolDraw.firstChild) this._toolDraw.removeChild(this._toolDraw.firstChild);
    },

    _toolRedraw() {
        this._toolClearDraw();
        if (!this._toolActive()) return;
        this._toolDrawRect = this._toolDraw.getBoundingClientRect();
        if (this._toolState.active === "sam3") this._sam3Render();
        else if (this._toolState.active === "roto") this._rotoRender?.();
    },

    // ── pointer dispatch (integrates with existing pan/zoom) ──────────────────
    _wireToolPointer() {
        const origDown = this.viewport.onmousedown;
        this.viewport.onmousedown = (e) => {
            if (this._toolActive() && e.button === 0 && !e.altKey) {
                if (e.target && e.target.closest && e.target.closest(
                    ".bepic-toolbar,.bepic-tool-panel,#exposure-control,#compare-slider")) {
                    return origDown ? origDown.call(this.viewport, e) : undefined;
                }
                e.preventDefault();
                e.stopPropagation();
                this._onToolPointerDown(e);
                return;
            }
            return origDown ? origDown.call(this.viewport, e) : undefined;
        };
    },

    _onToolPointerDown(e) {
        this.updateToolOverlay();
        if (this._toolState.active === "sam3") this._sam3PointerDown(e);
        else if (this._toolState.active === "roto") this._rotoPointerDown?.(e);
    },

    // Attach a window-level drag loop; onMove/onUp receive the raw event.
    _toolDrag(onMove, onUp) {
        const win = this.container.ownerDocument.defaultView || window;
        const move = (ev) => { ev.preventDefault(); onMove(ev); };
        const up = (ev) => {
            win.removeEventListener("mousemove", move);
            win.removeEventListener("mouseup", up);
            onUp && onUp(ev);
        };
        win.addEventListener("mousemove", move);
        win.addEventListener("mouseup", up);
    },

    // ═══════════════════════════════════════════════════════════════════════
    //  SAM3 POINTS TOOL
    // ═══════════════════════════════════════════════════════════════════════
    _sam3Load(node) {
        const parse = (name) => {
            try {
                const arr = JSON.parse(readToolStore(node, name, "[]"));
                return Array.isArray(arr)
                    ? arr.filter((p) => p && isFinite(p.x) && isFinite(p.y))
                          .map((p) => ({ x: +p.x, y: +p.y }))
                    : [];
            } catch (e) { return []; }
        };
        this._sam3 = {
            pos: parse(SAM3_POS_WIDGET),
            neg: parse(SAM3_NEG_WIDGET),
            drag: null, hover: null,
        };
    },

    _sam3Save() {
        const node = this._toolState.node;
        if (!node) return;
        writeToolStore(node, SAM3_POS_WIDGET, this._sam3.pos);
        writeToolStore(node, SAM3_NEG_WIDGET, this._sam3.neg);
        this._sam3UpdateCount();
    },

    _sam3HitTest(nx, ny) {
        const th = 9; // screen px
        const scan = (arr, type) => {
            for (let i = arr.length - 1; i >= 0; i--) {
                if (this._screenDist({ x: nx, y: ny }, arr[i]) <= th) return { type, i };
            }
            return null;
        };
        return scan(this._sam3.pos, "pos") || scan(this._sam3.neg, "neg");
    },

    _sam3PointerDown(e) {
        const n = this._eventToNorm(e);
        if (!n) return;
        const hit = this._sam3HitTest(n.x, n.y);

        // Right-click / ctrl-click on a point removes it.
        if (hit && (e.button === 2 || e.ctrlKey)) {
            (hit.type === "pos" ? this._sam3.pos : this._sam3.neg).splice(hit.i, 1);
            this._sam3Save(); this._toolRedraw();
            return;
        }

        if (hit) {
            // Begin dragging an existing point.
            this._sam3.drag = hit;
            this._toolDrag(
                (ev) => {
                    const m = this._eventToNorm(ev);
                    if (!m) return;
                    const arr = hit.type === "pos" ? this._sam3.pos : this._sam3.neg;
                    arr[hit.i] = { x: clamp01(m.x), y: clamp01(m.y) };
                    this._toolRedraw();
                },
                () => { this._sam3.drag = null; this._sam3Save(); this._toolRedraw(); },
            );
            return;
        }

        // Add a new point. Shift = negative, else positive.
        const p = { x: clamp01(n.x), y: clamp01(n.y) };
        if (e.shiftKey) this._sam3.neg.push(p);
        else this._sam3.pos.push(p);
        this._sam3Save();
        this._toolRedraw();
    },

    _sam3Render() {
        const draw = (arr, color) => {
            for (const pt of arr) {
                const d = this._normToDraw(pt.x, pt.y);
                if (!d) continue;
                const c = svgEl("circle", {
                    cx: d.x, cy: d.y, r: 6, fill: color,
                    stroke: "#000", "stroke-width": 1.5,
                });
                this._toolDraw.appendChild(c);
            }
        };
        draw(this._sam3.pos, "#28d17c");
        draw(this._sam3.neg, "#e5484d");
    },

    _sam3BuildPanel() {
        const p = this._toolPanel;
        p.innerHTML = "";
        p.appendChild(elWith("h4", { textContent: "SAM3 Points" }));

        if (!this._toolState.node) {
            p.appendChild(elWith("div", {
                className: "bepic-tool-hint",
                textContent: "Active tab has no 'Send to bEpic Viewer' node, so points can't be saved. Switch to a tab produced by that node.",
            }));
            return;
        }

        this._sam3CountEl = elWith("div", { className: "bepic-tool-hint" });
        p.appendChild(this._sam3CountEl);

        const clearBtn = elWith("button", { className: "bepic-act bepic-danger", textContent: "Clear points" });
        clearBtn.onclick = () => {
            this._sam3.pos = []; this._sam3.neg = [];
            this._sam3Save(); this._toolRedraw();
        };
        p.appendChild(clearBtn);

        p.appendChild(elWith("div", {
            className: "bepic-tool-hint",
            innerHTML: "L-click: <b style='color:#28d17c'>positive</b><br>Shift+click: <b style='color:#e5484d'>negative</b><br>R-click / Ctrl+click a dot: delete<br>Drag a dot to move. Alt+drag pans.",
        }));
        this._sam3UpdateCount();
    },

    _sam3UpdateCount() {
        if (this._sam3CountEl) {
            this._sam3CountEl.textContent =
                `${this._sam3.pos.length} positive · ${this._sam3.neg.length} negative`;
        }
    },
};

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

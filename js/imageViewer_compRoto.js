// imageViewer_compRoto.js
// CompRotoMixin - Comp's Roto node is edited by the viewer's own Roto tool (imageViewer_roto.js), so the
// two are one feature: the same shapes, keys, feathers and modes, the same panel, the same matte code.
//
// While a Roto node is the comp node on show in the Parameters panel:
//   * the tool is bound to a stand-in node (`_cpRoto.fake`) whose roto_data widget reads and writes the
//     comp node's `roto` param (editor.setRoto: changes close together are one undo step of the comp),
//   * the tool's overlay (the reference svg, the draw layer, the mask preview) is seated in the comp's
//     stage and laid over the comp's picture (`_cpRotoOverlay`), so its coordinates are shares of the comp's
//     frame and its sizes comp pixels - what roto_raster.py reads when the server renders the node,
//   * its options go into the node's section of the Parameters panel (editor's rotoSection slot).
// The preview's matte is `rotoMatte` (the viewer's mask preview code), the render's roto_raster.rasterize.
import { rotoMatte } from "./imageViewer_roto.js";
import { ROTO_WIDGET } from "./imageViewer_nodeTools.js";

const MATTES = 16;   // mattes kept for the preview (a scrub back and forth draws each frame once)

export const CompRotoMixin = {

    /** The preview's matte of roto data at a frame, W x H of a cw x ch comp (kept, by data and size). */
    _cpRotoMatte(roto, frame, cw, ch, W, H, doc) {
        if (!roto || !Array.isArray(roto.layers) || !roto.layers.length) return null;
        const kept = this._cpMattes || (this._cpMattes = new Map());
        const key = `${frame}|${W}x${H}|${cw}x${ch}|${JSON.stringify(roto)}`;
        if (kept.has(key)) { const m = kept.get(key); kept.delete(key); kept.set(key, m); return m; }
        const m = rotoMatte(roto, frame, cw, ch, W, H, doc);
        kept.set(key, m);
        while (kept.size > MATTES) kept.delete(kept.keys().next().value);
        return m;
    },

    /** The editor shows Roto node `n` in the Parameters panel: the tool on it, its options into `slot`. */
    _cpRotoMount(rec, n, slot) {
        const ed = rec && rec.editor;
        if (!ed) return;
        const now = () => { const c = ed.node(n.id); return JSON.stringify((c && c.roto) || null); };
        let b = this._cpRoto;
        if (!b || b.rec !== rec || b.id !== n.id) {
            this._cpRotoUnmount();
            const self = this;
            const fake = {
                id: n.id, title: n.name || n.id, type: "Roto", _compRoto: true,
                setDirtyCanvas() {},
                widgets: [{
                    name: ROTO_WIDGET,
                    get value() { const c = ed.node(n.id); return c && c.roto ? JSON.stringify(c.roto) : ""; },
                    set value(v) {
                        let obj = null;
                        try { obj = v ? JSON.parse(v) : null; } catch (e) { return; }
                        if (self._cpRoto && self._cpRoto.fake === fake) self._cpRoto.last = JSON.stringify(obj);
                        ed.setRoto(n.id, obj);
                    },
                }],
            };
            b = this._cpRoto = { rec, id: n.id, fake, last: now() };
            this._cpRotoSeat(rec, true);
            ed.setToolOn(true);
            this._toolBySelection = false;
            if (this._toolState.active === "roto") { this._bindActiveTool(); this._toolRefreshPanel(); }
            else this.setActiveTool("roto");
        } else {
            b.fake.title = n.name || n.id;
            const cur = now();
            if (cur !== b.last) {          // undone, redone, or changed elsewhere: the tool takes it again
                b.last = cur;
                this._rotoLoadFromNode(b.fake);
                this._rotoRefreshPanel();
            }
        }
        if (this._toolPanel && this._toolPanel.parentNode !== slot) slot.append(this._toolPanel);
        this.updateToolOverlay();
    },

    /** No Roto node on show any more (another node, another tab, off the comp): the tool goes off it. */
    _cpRotoUnmount() {
        const b = this._cpRoto;
        if (!b) return;
        this._cpRoto = null;
        if (b.rec.editor) b.rec.editor.setToolOn(false);
        if (this._toolState && this._toolState.active === "roto") this.setActiveTool("none");
        this._cpRotoSeat(b.rec, false);
        this._toolPlacePanel();
    },

    /** The tool's overlay into the comp's stage, or back into the viewport. */
    _cpRotoSeat(rec, on) {
        const host = on && rec.editor ? rec.editor.stage : this.viewport;
        const els = [this._toolRef, this._rotoMaskCanvas, this._toolDraw].filter(Boolean);
        for (const e of els) if (e.parentNode !== host) host.append(e);
        const draw = this._toolDraw;
        if (!draw) return;
        if (!this._cpRotoDown) {
            // Inside the comp the viewport's mousedown never hears it (the comp stops it): the draw layer asks itself.
            this._cpRotoDown = (e) => {
                if (!this._cpRoto || !this._toolActive() || (e.button !== 0 && e.button !== 2)) return;
                if (this._onToolPointerDown(e)) { e.preventDefault(); e.stopPropagation(); }
            };
            this._cpRotoMenu = (e) => { if (this._cpRoto) e.preventDefault(); };
        }
        // In the viewport the draw layer keeps its default 300 x 150 (the viewport hears the presses); in the
        // stage it has to cover the picture itself.
        draw.style.width = on ? "100%" : "";
        draw.style.height = on ? "100%" : "";
        if (on) {
            draw.addEventListener("mousedown", this._cpRotoDown);
            draw.addEventListener("contextmenu", this._cpRotoMenu);
        } else {
            draw.removeEventListener("mousedown", this._cpRotoDown);
            draw.removeEventListener("contextmenu", this._cpRotoMenu);
        }
    },

    /** Lay the tool's reference over the comp's picture (from updateToolOverlay). False when it is not the comp's. */
    _cpRotoOverlay() {
        const b = this._cpRoto;
        const ed = b && b.rec.editor;
        if (!ed || !ed.comp()) return false;
        const box = ed.canvasBox(), ref = this._toolRef;
        if (!ref) return true;
        ref.style.display = "block";
        ref.style.left = box.x + "px";
        ref.style.top = box.y + "px";
        ref.style.width = box.w + "px";
        ref.style.height = box.h + "px";
        ref.style.transform = "";
        ref.setAttribute("viewBox", `0 0 ${box.cw} ${box.ch}`);
        this._toolDrawRect = this._toolDraw.getBoundingClientRect();
        this._toolRedraw();
        return true;
    },

    /** The comp's frame size, for the tool (from _toolImgSize). */
    _cpRotoImgSize() {
        const b = this._cpRoto;
        const c = b && b.rec.editor && b.rec.editor.comp();
        return c ? { w: c.format.width, h: c.format.height } : null;
    },
};

// imageViewer_paintBrushDrag.js
// Paint: change the brush's size and opacity on the canvas while painting, as Photoshop's Alt+right-drag does
// (Windows; Ctrl+Option+drag on a Mac): hold B (or Alt and the right mouse button) and move the mouse -
// sideways the size, up and down the opacity (Shift held: the hardness). Every brush tool, the eraser on a
// mask and Quick Mask included, and Liquify (its strength). `brushDragValues` is the arithmetic (pure, tested
// in tests/test_paint_brushdrag.mjs); `BrushDragMixin` goes onto the editor. Written from what the tool does.

/** The largest brush the drag makes (as [ and ]). */
export const DRAG_MAX_SIZE = 2000;
/** Screen pixels of vertical drag for the whole 0..100 of opacity / hardness. */
export const DRAG_PX_PER_100 = 200;
/** How far the pointer moves (screen px) while B is held before it is a drag and not a tap (a tap picks the brush). */
export const DRAG_TAP_PX = 4;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/**
 * The brush's values after a drag of dx, dy screen pixels from where it began (`start`: the values then).
 * Sideways: the size follows the pointer - the circle's edge stays under it (the diameter grows by twice the
 * distance, in picture pixels at `zoom`). Up: more opacity (or hardness with `shift`), down: less.
 * `kind`: "brush" (size, opacity, hardness) or "liquify" (size, strength).
 */
export function brushDragValues(start, dx, dy, zoom, shift, kind = "brush") {
    const z = zoom > 0 ? zoom : 1;
    const out = { ...start };
    out.size = clamp(Math.round(start.size + (2 * dx) / z), 1, DRAG_MAX_SIZE);
    const dv = (-dy * 100) / DRAG_PX_PER_100;
    if (kind === "liquify") out.strength = clamp(Math.round(start.strength + dv), 1, 100);
    else if (shift) { out.hardness = clamp(Math.round(start.hardness + dv), 0, 100); out.opacity = start.opacity; }
    else { out.opacity = clamp(Math.round(start.opacity + dv), 1, 100); out.hardness = start.hardness; }
    return out;
}

/** The line the drag shows beside the circle. */
export function brushDragLabel(v, kind = "brush", shift = false) {
    if (kind === "liquify") return `Size ${v.size} px · Strength ${v.strength}%`;
    return shift ? `Size ${v.size} px · Hardness ${v.hardness}%` : `Size ${v.size} px · Opacity ${v.opacity}%`;
}

export const BrushDragMixin = {
    /** The tool whose size the drag changes (null: the tool has no brush). */
    _bdTool(tool = this.tool) {
        return this._brushTools.includes(tool) || tool === "liquify" ? tool : null;
    },

    /** Begin a drag at the pointer (screen point `c` = {clientX, clientY}); `by` "key" or "mouse". */
    _bdBegin(c, by, tap = null) {
        const tool = this._bdTool();
        if (!tool || !this.doc || !c) return false;
        const o = this.opts[tool], kind = tool === "liquify" ? "liquify" : "brush";
        const r = this.wrap.getBoundingClientRect();
        this._bd = { tool, kind, by, tap, moved: false, cx: c.clientX, cy: c.clientY, sx: c.clientX - r.left, sy: c.clientY - r.top,
                     start: kind === "liquify" ? { size: o.size, strength: o.strength } : { size: o.size, opacity: o.opacity, hardness: o.hardness },
                     shift: false };
        // The key's release may never come here (the window left with B down): leaving the window ends it too.
        const win = this.d.defaultView;
        const off = () => { win.removeEventListener("blur", off); if (this._bd === b) this._bdEnd(); };
        const b = this._bd;
        win.addEventListener("blur", off);
        this.drawOverlay();
        return true;
    },

    /** The pointer moved while the drag is on: the values follow. True when it took the move. */
    _bdMove(e) {
        const b = this._bd;
        if (!b) return false;
        const dx = e.clientX - b.cx, dy = e.clientY - b.cy;
        if (!b.moved && Math.hypot(dx, dy) < DRAG_TAP_PX) return true;
        b.moved = true;
        b.shift = !!e.shiftKey;
        const v = brushDragValues(b.start, dx, dy, this.view.zoom, b.shift, b.kind);
        Object.assign(this.opts[b.tool], v);
        this.drawOverlay();
        return true;
    },

    /** The drag ends (the key or the button let go, the window left). A B that was only tapped picks the brush. */
    _bdEnd() {
        const b = this._bd;
        if (!b) return false;
        this._bd = null;
        if (!b.moved && b.tap) b.tap();
        else this.refreshProps();
        this.drawOverlay();
        return true;
    },

    /** The circle at where the drag began, its values beside it (drawn by drawOverlay in place of the pointer's). */
    _bdDraw(c) {
        const b = this._bd;
        const o = this.opts[b.tool], R = Math.max(1, (o.size / 2) * this.view.zoom);
        // The hardness as a soft fill inside (Photoshop shows a red one): the hard part full, fading to the edge.
        if (b.kind === "brush") {
            const g = c.createRadialGradient(b.sx, b.sy, 0, b.sx, b.sy, R);
            const a = 0.15 + 0.35 * (o.opacity / 100), h = Math.min(0.999, o.hardness / 100);
            g.addColorStop(0, `rgba(255,60,40,${a})`); g.addColorStop(h, `rgba(255,60,40,${a})`); g.addColorStop(1, "rgba(255,60,40,0)");
            c.fillStyle = g;
            c.beginPath(); c.arc(b.sx, b.sy, R, 0, Math.PI * 2); c.fill();
        }
        c.lineWidth = 1;
        c.strokeStyle = "rgba(255,255,255,.95)"; c.beginPath(); c.arc(b.sx, b.sy, R, 0, Math.PI * 2); c.stroke();
        c.strokeStyle = "rgba(0,0,0,.6)"; c.beginPath(); c.arc(b.sx, b.sy, R + 1, 0, Math.PI * 2); c.stroke();
        const text = brushDragLabel(o, b.kind, b.shift);
        c.font = "12px system-ui, 'Segoe UI', sans-serif";
        const w = c.measureText(text).width + 12;
        const W = c.canvas.width / (this.d.defaultView.devicePixelRatio || 1);
        const x = Math.min(Math.max(4, b.sx + R + 10), Math.max(4, W - w - 4)), y = Math.max(4, b.sy - 11);
        c.fillStyle = "rgba(20,20,24,.88)"; c.fillRect(x, y, w, 22);
        c.strokeStyle = "#f60"; c.strokeRect(x + 0.5, y + 0.5, w - 1, 21);
        c.fillStyle = "#fff"; c.textBaseline = "middle"; c.fillText(text, x + 6, y + 11);
    },
};

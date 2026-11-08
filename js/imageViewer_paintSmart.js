// Paint's smart filters: filters kept as settings on a pixel layer (`L.filters`), drawn in the composite, so
// they can be changed, switched off, reordered or taken away at any time. The ones that have a twin on the
// server (Gaussian blur, Sharpen, the adjustments) - src/paint_smart.py is the same arithmetic, compared
// pixel by pixel by tests/test_paint_parity.py. Written from what the feature does, not from any other
// program's code.
//
// Nothing here is used while the module is first read: paintData imports it and it imports paintData.
import * as D from "./imageViewer_paintData.js";
import { BUF_VER } from "./imageViewer_paintStyle.js";

export const MAX_SMART = 20;
export const SMART_LABELS = { blur: "Gaussian blur", sharpen: "Sharpen" };
export const SMART_FIELDS = {
    blur: [["radius", "Radius (px)", 0.1, 250, 0.1]],
    sharpen: [["radius", "Radius (px)", 0.1, 100, 0.1], ["amount", "Amount", 0, 10, 0.05]],
};
const SMART_DEFAULTS = { blur: { radius: 4 }, sharpen: { radius: 2, amount: 1 } };

/** What a smart filter can be: blur, sharpen, or an adjustment (D.ADJUST_TYPES). */
export const smartTypes = () => ["blur", "sharpen", ...D.ADJUST_TYPES];
export const smartLabel = (t) => SMART_LABELS[t] || D.ADJUST_LABELS[t] || t;
/** Its number fields: [key, label, min, max, step] (an adjustment's are D.ADJUST_FIELDS). */
export const smartFields = (t) => SMART_FIELDS[t] || D.ADJUST_FIELDS[t] || [];

/** One filter held to what it may be, or null. */
export function cleanSmart(f) {
    if (!f || typeof f !== "object" || !smartTypes().includes(f.type)) return null;
    const p = f.params && typeof f.params === "object" ? f.params : {};
    let params;
    if (SMART_FIELDS[f.type]) {
        params = {};
        for (const [k, , lo, hi] of SMART_FIELDS[f.type]) params[k] = D.num(p[k], SMART_DEFAULTS[f.type][k], lo, hi);
    } else params = D.cleanAdjust(f.type, p);
    return { type: f.type, on: f.on !== false, params };
}

/** A layer's filters held to what they may be; null when none is left. */
export function cleanFilters(list) {
    if (!Array.isArray(list)) return null;
    const out = list.slice(0, MAX_SMART).map(cleanSmart).filter(Boolean);
    return out.length ? out : null;
}

/** Does this layer draw a smart filter? */
export function smartOn(L) {
    return !!L && L.kind === "pixel" && Array.isArray(L.filters) && L.filters.some((f) => f.on);
}

/**
 * The layer's pixels through its filters, in their order, as a canvas-sized picture (W x H RGBA): a blur
 * reaches past the layer's own box, as it would on a layer as big as the canvas.
 */
export function smartPixels(W, H, L, px) {
    let buf = new Uint8ClampedArray(W * H * 4);
    const x0 = Math.max(0, L.x), y0 = Math.max(0, L.y), x1 = Math.min(W, L.x + L.w), y1 = Math.min(H, L.y + L.h);
    if (x1 > x0) for (let y = y0; y < y1; y++) buf.set(px.subarray(((y - L.y) * L.w + x0 - L.x) * 4, ((y - L.y) * L.w + x1 - L.x) * 4), (y * W + x0) * 4);
    for (const f of L.filters) {
        if (!f.on) continue;
        if (f.type === "blur") buf = D.blurPixels(buf, W, H, f.params.radius);
        else if (f.type === "sharpen") buf = D.sharpenPixels(buf, W, H, f.params.radius, f.params.amount);
        else buf = D.adjustPixels(buf, W, H, f.type, f.params);
    }
    return buf;
}

const cache = new WeakMap();

/** [the layer as drawn, its pixels]: a smart-filtered layer becomes canvas-sized, kept until it changes. */
export function smartLayer(W, H, L, px) {
    if (!px || !smartOn(L)) return [L, px];
    const sig = `${W}x${H}|${L.x},${L.y},${L.w},${L.h}|${BUF_VER.get(px) || 0}|${JSON.stringify(L.filters)}`;
    let c = cache.get(px);
    if (!c || c.sig !== sig) { c = { sig, out: smartPixels(W, H, L, px) }; cache.set(px, c); }
    return [{ ...L, x: 0, y: 0, w: W, h: H }, c.out];
}

export const SmartMixin = {
    /** Add a smart filter (its defaults) to the active pixel layer and open it in Properties: one undo step. */
    addSmartFilter(type, params = {}) {
        const L = this.active();
        if (!L || L.kind !== "pixel") { this._notify("Smart filters go on a pixel layer.", "info"); return false; }
        const f = cleanSmart({ type, on: true, params });
        if (!f) return false;
        if ((L.filters || []).length >= MAX_SMART) { this._notify(`At most ${MAX_SMART} smart filters on a layer.`, "warn"); return false; }
        const ok = this.change("Smart filter", () => { L.filters = cleanFilters([...(L.filters || []), f]); });
        if (ok) { this._smartOpen = L.id; if (this.host.showPanel) this.host.showPanel("effects"); this.refreshProps(); }
        return ok;
    },

    /** Change the i-th filter (a patch of {on, params}), move it (by -1 / +1), or take it away (null): one step. */
    setSmartFilter(L, i, patch, label = "Smart filter") {
        if (!L || !L.filters || !L.filters[i]) return false;
        return this.change(label, () => {
            const list = L.filters.slice();
            if (patch === null) list.splice(i, 1);
            else if (patch.move) { const j = i + patch.move; if (j < 0 || j >= list.length) return false; [list[i], list[j]] = [list[j], list[i]]; }
            else list[i] = { ...list[i], ...patch, params: { ...list[i].params, ...(patch.params || {}) } };
            const c = cleanFilters(list);
            if (c) L.filters = c; else delete L.filters;
        });
    },

    clearSmartFilters(L) {
        if (!L || !L.filters) return false;
        return this.change("Clear smart filters", () => { delete L.filters; });
    },

    /** The filters baked into the layer's pixels (it then holds what it showed): one step. */
    bakeSmartFilters(L) {
        if (!L || !L.filters) return false;
        const W = this.doc.w, H = this.doc.h;
        return this.change("Bake smart filters", () => {
            if (smartOn(L)) {
                const out = smartPixels(W, H, L, this.pix.get(L.id));
                this.pix.set(L.id, out);
                Object.assign(L, { x: 0, y: 0, w: W, h: H });
            }
            delete L.filters;
        });
    },

    /** Pick which adjustment to add as a smart filter. */
    smartAdjustDialog() {
        const ts = D.ADJUST_TYPES;
        this.dialog("Smart filter", [["type", "Adjustment", ts[0], ts]], (v) => this.addSmartFilter(v.type),
                    "Kept as a setting on the layer: change it, switch it off or take it away later in Properties.");
    },

    _smartMenu() {
        const L = this.active(), ok = !!L && L.kind === "pixel";
        return [...smartTypes().map((t) => ({ label: `Smart ${smartLabel(t)}`, disabled: !ok, run: () => this.addSmartFilter(t) }))];
    },

    /** The Properties section: each filter's switch, ▲ ▼ ×, its numbers (live while dragged, one step when let go). */
    _smartSection(L) {
        const s = this.el("div", "paint-sect paint-smart");
        s.append(this.el("h4", "", { text: "Smart filters" }));
        (L.filters || []).forEach((f, i) => {
            const head = this.el("div", "paint-field paint-smart-f");
            const on = this.el("input", "smart-on", { type: "checkbox", checked: f.on });
            on.dataset.i = String(i);
            on.addEventListener("change", () => this.setSmartFilter(L, i, { on: on.checked }));
            const lab = this.el("label", "paint-check");
            lab.append(on, this.el("span", "", { text: smartLabel(f.type) }));
            head.append(lab);
            for (const [t, title, fn] of [["▲", "Earlier", () => this.setSmartFilter(L, i, { move: -1 })], ["▼", "Later", () => this.setSmartFilter(L, i, { move: 1 })],
                                          ["×", "Take this filter off", () => this.setSmartFilter(L, i, null)]]) {
                const b = this.el("button", "paint-btn smart-btn", { type: "button", text: t, title });
                b.addEventListener("click", fn);
                head.append(b);
            }
            s.append(head);
            if (!f.on) return;
            if (D.ADJUST_TYPES.includes(f.type) && this._adjustEditor) {
                // An adjustment: the same editor as an adjustment layer's, the histogram of the layer's own pixels.
                let hk = null, hv = null;
                const hist = () => {
                    const b = this.pix.get(L.id);
                    const key = b ? `${this.bufVer.get(b) || 0}` : "";
                    if (hk !== b || hv?.key !== key) { hk = b; hv = { key, h: b ? this._adjHistOf(b) : null }; }
                    return hv.h;
                };
                const cur = () => { const X = this.active(); return X && X.filters && X.filters[i] ? X.filters[i].params : f.params; };
                s.append(this._adjustEditor(f.type, cur, (patch) => {
                    this.liveBegin();
                    const X = this.active();
                    if (!X || !X.filters || !X.filters[i]) return;
                    X.filters[i] = cleanSmart({ ...X.filters[i], params: { ...X.filters[i].params, ...patch } });
                    this.requestRedraw();
                }, () => this.liveEnd("Smart filter"), hist));
                return;
            }
            for (const [k, label, lo, hi, step] of smartFields(f.type)) {
                const v = Array.isArray(f.params[k]) ? f.params[k][0] : f.params[k];
                this._slider(s, label, v, lo, hi, step, (x) => {
                    this.liveBegin();
                    const X = this.active();
                    if (!X || !X.filters || !X.filters[i]) return;
                    const p = { ...X.filters[i].params, [k]: Array.isArray(X.filters[i].params[k]) ? [x, x, x] : x };
                    X.filters[i] = cleanSmart({ ...X.filters[i], params: p });
                    this.requestRedraw();
                }, () => this.liveEnd("Smart filter"));
            }
        });
        const row = this.el("div", "paint-field");
        const add = this.el("button", "paint-btn", { type: "button", text: "Add…" });
        add.addEventListener("click", (e) => { e.stopPropagation(); this._menu(add, this._smartMenu()); });
        const bake = this.el("button", "paint-btn", { type: "button", text: "Bake into the pixels" });
        bake.addEventListener("click", () => { this.bakeSmartFilters(L); this.refreshProps(); });
        row.append(add);
        if (L.filters) row.append(bake);
        s.append(row);
        s.append(this.el("div", "paint-note", { text: "Settings, not pixels: the layer keeps its own pixels and the filters are drawn over them, in this order. The .ora keeps them; a .psd gets them baked in." }));
        return s;
    },
};

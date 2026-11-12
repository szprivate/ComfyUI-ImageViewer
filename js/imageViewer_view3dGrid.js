// imageViewer_view3dGrid.js
// The 3D space's grid: its size and spacing (Sebastian 2026-11-12).
//
// The grid was a fixed 20 x 20 units, scaled by powers of ten to the model
// on Frame all. Now it has options: how far it reaches (size), the distance
// between its lines (spacing), how many cells between the brighter lines
// (major), and whether it still scales with the model. They are opened from
// the ▾ beside the Grid button and from View > Grid options…, and kept per
// viewer in localStorage.
//
// The world origin is marked (Sebastian 2026-11-12, "Show origin", on by
// default): the X axis drawn red and the Z axis blue across the grid, a short
// green Y stub and a dot where they meet - its own object beside the grid, in
// world axes, so a flat pane's turned grid does not turn it.
//
// The pure part (cleanGridOptions, gridLayout) is tested under node in
// tests/test_view3d_grid.mjs; the mixin goes onto Model3DView.

export const GRID_KEY = "imageviewer.viewer.grid3d";

export const GRID_DEFAULTS = Object.freeze({ size: 20, spacing: 1, major: 10, auto: true, origin: true });

// The origin's colours: the axes as the gizmo and the orientation axes draw them.
export const ORIGIN_COLORS = Object.freeze({ x: 0xe0464b, y: 0x5ec461, z: 0x4a86e8 });

// Limits: a grid of more than MAX_LINES lines per side is drawn as that many
// (the spacing grows), so a typo cannot build a million-line helper.
export const GRID_LIMITS = Object.freeze({
    size: [0.01, 100000], spacing: [0.001, 10000], major: [0, 100],
});
export const MAX_LINES = 1000;

const num = (v, [lo, hi], fallback) => {
    const n = typeof v === "string" ? parseFloat(v.replace(",", ".")) : Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
};

/** Options as they may be used: every field present and in range. */
export function cleanGridOptions(o) {
    const src = o && typeof o === "object" ? o : {};
    return {
        size: num(src.size, GRID_LIMITS.size, GRID_DEFAULTS.size),
        spacing: num(src.spacing, GRID_LIMITS.spacing, GRID_DEFAULTS.spacing),
        major: Math.round(num(src.major, GRID_LIMITS.major, GRID_DEFAULTS.major)),
        auto: src.auto === undefined ? GRID_DEFAULTS.auto : !!src.auto,
        origin: src.origin === undefined ? GRID_DEFAULTS.origin : !!src.origin,
    };
}

/**
 * How the grid is drawn: `divisions` cells across, `size` its whole width
 * (a whole number of cells, so every line lies on a multiple of the spacing
 * from the origin), `spacing` the cell actually drawn (larger than asked when
 * the lines would be more than MAX_LINES), and `majors`: the line indices
 * from the centre (positive) that are brighter.
 */
/**
 * The origin marker's lines, in the grid's units before its scale: the X axis
 * and the Z axis across the grid (from edge to edge), and Y a stub of two cells
 * up from the floor. Each is [from, to, axis].
 */
export function originLines(lay) {
    const h = lay.size / 2;
    const up = Math.min(h, lay.spacing * 2);
    return [
        [[-h, 0, 0], [h, 0, 0], "x"],
        [[0, 0, 0], [0, up, 0], "y"],
        [[0, 0, -h], [0, 0, h], "z"],
    ];
}

export function gridLayout(opts) {
    const o = cleanGridOptions(opts);
    let spacing = o.spacing;
    let half = Math.max(1, Math.round(o.size / 2 / spacing));
    if (half * 2 > MAX_LINES) {
        const k = Math.ceil((half * 2) / MAX_LINES);
        spacing *= k;
        half = Math.max(1, Math.round(o.size / 2 / spacing));
    }
    return { divisions: half * 2, size: half * 2 * spacing, spacing, half, major: o.major };
}

function loadOptions() {
    try {
        const raw = localStorage.getItem(GRID_KEY);
        return cleanGridOptions(raw ? JSON.parse(raw) : null);
    } catch (_) { return cleanGridOptions(null); }
}

function saveOptions(o) {
    try { localStorage.setItem(GRID_KEY, JSON.stringify(o)); } catch (_) { /* private window: not kept */ }
}

const fmt = (n) => String(Math.round(n * 1000) / 1000);

export const View3DGridMixin = {

    gridOptions() {
        if (!this._gridOpts) this._gridOpts = loadOptions();
        return { ...this._gridOpts };
    },

    /** Change some of the grid's options; the grid is drawn again at once. */
    setGridOptions(patch) {
        const next = cleanGridOptions({ ...this.gridOptions(), ...(patch || {}) });
        this._gridOpts = next;
        saveOptions(next);
        if (!next.auto) this._gridAutoScale = 1;
        this._gridRebuild();
        this._gridOriginSync();
        this._gridMenuSync();
        return { ...next };
    },

    resetGridOptions() { return this.setGridOptions({ ...GRID_DEFAULTS }); },

    /** The grid's scale after Frame all: a power of ten when it follows the model, else 1. */
    _gridSetAutoScale(scale) {
        this._gridAutoScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
        if (this.grid) this.grid.scale.setScalar(this.gridOptions().auto ? this._gridAutoScale : 1);
        this._gridOriginSync();
    },

    /**
     * The world origin's marker: made (or remade, when the grid's layout
     * changed) beside the grid, scaled and shown with it.
     */
    _gridOriginSync() {
        if (!this.libs || !this.scene || !this.grid) return;
        const { THREE } = this.libs;
        const lay = this.grid.userData.gridLayout || gridLayout(this.gridOptions());
        const key = `${lay.size}|${lay.spacing}`;
        let o = this.gridOrigin;
        if (o && o.userData.key !== key) {
            o.parent && o.parent.remove(o);
            o.traverse((c) => { c.geometry && c.geometry.dispose(); c.material && c.material.dispose(); });
            o = this.gridOrigin = null;
        }
        if (!o) {
            o = new THREE.Group();
            o.name = "gridorigin";
            o.userData.key = key;
            const pos = [], col = [];
            for (const [a, b, axis] of originLines(lay)) {
                const c = new THREE.Color(ORIGIN_COLORS[axis]);
                pos.push(...a, ...b);
                col.push(c.r, c.g, c.b, c.r, c.g, c.b);
            }
            const geo = new THREE.BufferGeometry();
            geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
            geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
            const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true }));
            lines.name = "gridorigin-axes";
            // Drawn after the grid, so on its centre lines the colour wins (equal depth passes).
            lines.renderOrder = 1;
            const dotGeo = new THREE.BufferGeometry();
            dotGeo.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0], 3));
            const dot = new THREE.Points(dotGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 6, sizeAttenuation: false }));
            dot.name = "gridorigin-dot";
            dot.renderOrder = 1;
            o.add(lines, dot);
            this.scene.add(o);
            this.gridOrigin = o;
        }
        // The scene can be made again under it (two calls racing to load three).
        if (o.parent !== this.scene) this.scene.add(o);
        o.scale.copy(this.grid.scale);
        o.visible = !!(this.grid.visible && this.gridOptions().origin);
        this.requestRender && this.requestRender();
    },

    /** A THREE.GridHelper for the options, with brighter lines every `major` cells. */
    _gridMake(THREE) {
        const lay = gridLayout(this.gridOptions());
        const geo = new THREE.BufferGeometry();
        const pos = [];
        const col = [];
        // three's GridHelper drew its lines 0x888888 and the centre 0x444444; the
        // minor lines a little dimmer now so the major ones read.
        const minor = new THREE.Color(0x707070);
        const major = new THREE.Color(0xa8a8a8);
        const axis = new THREE.Color(0x444444);
        const h = lay.size / 2;
        for (let i = -lay.half; i <= lay.half; i++) {
            const p = i * lay.spacing;
            const c = i === 0 ? axis : (lay.major > 0 && i % lay.major === 0) ? major : minor;
            pos.push(-h, 0, p, h, 0, p, p, 0, -h, p, 0, h);
            for (let k = 0; k < 4; k++) col.push(c.r, c.g, c.b);
        }
        geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
        const mat = new THREE.LineBasicMaterial({ vertexColors: true });
        const grid = new THREE.LineSegments(geo, mat);
        grid.type = "GridHelper";
        grid.name = "grid";
        grid.userData.gridLayout = lay;
        return grid;
    },

    _gridRebuild() {
        if (!this.libs || !this.scene || !this.grid) return;
        const old = this.grid;
        const grid = this._gridMake(this.libs.THREE);
        grid.visible = old.visible;
        grid.rotation.copy(old.rotation);
        grid.layers.mask = old.layers.mask;
        grid.renderOrder = old.renderOrder;
        grid.scale.setScalar(this.gridOptions().auto ? (this._gridAutoScale || 1) : 1);
        (old.parent || this.scene).add(grid);
        old.parent && old.parent.remove(old);
        old.geometry && old.geometry.dispose();
        old.material && old.material.dispose();
        this.grid = grid;
        this.requestRender();
    },

    /** The line actually drawn, in scene units (spacing x the model scale). */
    gridEffective() {
        const o = this.gridOptions();
        const lay = gridLayout(o);
        const s = o.auto ? (this._gridAutoScale || 1) : 1;
        return { size: lay.size * s, spacing: lay.spacing * s, scale: s };
    },

    // ── The options popover ─────────────────────────────────────────────

    toggleGridMenu(open) {
        if (!this.root || !this.ui) return;
        const was = !!this._gridMenu;
        const want = open === undefined ? !was : !!open;
        if (was) { this._gridMenu.remove(); this._gridMenu = null; this._gridMenuOff && this._gridMenuOff(); }
        if (!want) return;
        if (this.toggleDisplayMenu && this._dispMenu) this.toggleDisplayMenu(false);
        const d = this.doc;
        const mk = (tag, cls, text) => {
            const n = d.createElement(tag);
            if (cls) n.className = cls;
            if (text !== undefined) n.textContent = text;
            return n;
        };
        const menu = mk("div", "model-display-menu model-grid-menu");
        menu.addEventListener("pointerdown", (e) => e.stopPropagation());
        // Keys typed into the fields are the fields', not the viewport's (W, E, R, F ...).
        menu.addEventListener("keydown", (e) => { if (e.key !== "Escape") e.stopPropagation(); });
        const syncs = [];

        const show = mk("label", "model-display-row");
        const showBox = mk("input");
        showBox.type = "checkbox";
        showBox.dataset.grid = "show";
        showBox.onchange = () => this.setGrid(showBox.checked);
        show.append(showBox, mk("span", "", "Show grid"));
        syncs.push(() => { showBox.checked = !!this.showGrid; });
        menu.append(show, mk("div", "model-display-sep"));

        const field = (key, label, tip, step) => {
            const r = mk("label", "model-grid-row");
            r.title = tip;
            const inp = mk("input", "model-grid-in");
            inp.type = "number";
            inp.step = String(step);
            inp.min = String(GRID_LIMITS[key][0]);
            inp.max = String(GRID_LIMITS[key][1]);
            inp.dataset.grid = key;
            const commit = () => {
                // An empty or half-typed field keeps the number it had.
                if (!Number.isFinite(parseFloat(String(inp.value).replace(",", ".")))) {
                    inp.value = fmt(this.gridOptions()[key]);
                    return;
                }
                this.setGridOptions({ [key]: inp.value });
            };
            inp.addEventListener("change", commit);
            inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { commit(); inp.select(); } });
            r.append(mk("span", "", label), inp);
            syncs.push(() => { if (d.activeElement !== inp) inp.value = fmt(this.gridOptions()[key]); });
            menu.append(r);
            return inp;
        };
        field("size", "Size", "How far the grid reaches, edge to edge, in scene units", 1);
        field("spacing", "Spacing", "The distance between two lines, in scene units", 0.1);
        field("major", "Major line every", "Every how many cells a brighter line is drawn (0: none)", 1);

        const auto = mk("label", "model-display-row");
        auto.title = "On Frame all, scale the grid by powers of ten to the model's size, "
            + "so a model in millimetres or kilometres still sits on a readable grid";
        const autoBox = mk("input");
        autoBox.type = "checkbox";
        autoBox.dataset.grid = "auto";
        autoBox.onchange = () => this.setGridOptions({ auto: autoBox.checked });
        auto.append(autoBox, mk("span", "", "Scale with the model"));
        syncs.push(() => { autoBox.checked = this.gridOptions().auto; });
        menu.append(mk("div", "model-display-sep"), auto);

        const origin = mk("label", "model-display-row");
        origin.title = "Mark the world origin: the X axis red and the Z axis blue across the grid, Y a short green line up";
        const originBox = mk("input");
        originBox.type = "checkbox";
        originBox.dataset.grid = "origin";
        originBox.onchange = () => this.setGridOptions({ origin: originBox.checked });
        origin.append(originBox, mk("span", "", "Show origin"));
        syncs.push(() => { originBox.checked = this.gridOptions().origin; });
        menu.append(origin);

        const note = mk("div", "model-grid-note");
        syncs.push(() => {
            const e = this.gridEffective();
            const lay = gridLayout(this.gridOptions());
            const bits = [];
            if (e.scale !== 1) bits.push(`×${fmt(e.scale)} to fit the model`);
            if (lay.spacing !== this.gridOptions().spacing) bits.push(`spacing raised to keep it under ${MAX_LINES} lines`);
            note.textContent = `Drawn: ${fmt(e.size)} across, a line every ${fmt(e.spacing)}`
                + (bits.length ? ` (${bits.join("; ")})` : "");
        });
        menu.append(note);

        const reset = mk("button", "model-btn model-grid-reset", "Reset");
        reset.title = "Back to 20 units, a line every unit, scaled with the model, the origin shown";
        reset.onclick = () => this.resetGridOptions();
        menu.append(reset);

        menu._sync = () => syncs.forEach((f) => f());
        menu._sync();
        this.ui.look.append(menu);
        this._gridMenu = menu;
        const win = this.win;
        const close = (e) => {
            if (e.type === "keydown") {
                if (e.key === "Escape") this.toggleGridMenu(false);
                return;
            }
            const path = e.composedPath ? e.composedPath() : [e.target];
            if (path.includes(menu) || path.includes(this.ui.gridMoreBtn)) return;
            this.toggleGridMenu(false);
        };
        win.addEventListener("pointerdown", close, true);
        win.addEventListener("keydown", close, true);
        this._gridMenuOff = () => {
            win.removeEventListener("pointerdown", close, true);
            win.removeEventListener("keydown", close, true);
            this._gridMenuOff = null;
        };
        const first = menu.querySelector("input[data-grid=size]");
        if (first) { first.focus(); first.select(); }
    },

    _gridMenuSync() {
        if (this._gridMenu && this._gridMenu._sync) this._gridMenu._sync();
    },
};

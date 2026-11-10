// imageViewer_theme.js    Settings → ComfyUI Image Viewer → Colours
//
// The viewer's colours as settings: the panels' backgrounds, the bars, the
// buttons, and the Edit page's own (timeline, track headers, clips, playhead).
// Asked for by Sebastian 2026-11-10 ("change the colors of the UI elements,
// including the backgrounds of the panels").
//
// The stylesheets (imageViewer.css, Paint's in imageViewer_paintEditor.js) keep
// their colours as they are. Each colour adds rules here, with the SAME selector
// as the rule it changes, in a <style> appended after the stylesheet: same
// specificity, later, so it wins exactly where the original rule applied and
// nowhere else (a `.pt-btn` stays transparent when the buttons' colour changes).
// `base` is the colour the stylesheet has; `def` the default, the Paint preset.
//
// Presets (Sebastian 2026-11-10: "a color preset selector, with the typical
// presets, including the one that the Paint space currently uses (make this the
// new default)"): `PRESETS`, every colour of each. Picking one in Settings writes
// its colours into the colour settings, which stay editable; a colour changed by
// hand makes the preset read "Custom" (`matchPreset`). "Classic" is `base`.
//
// Two groups:
//   - "edit": the Edit page's own parts (they exist only on a cut's tab), always on;
//   - "chrome": everything else - panels, bars, buttons, Paint, Dependencies.
//     With "Use the colours" = "On the Edit page" they are on only while a cut's
//     tab is up (`_themeSync`, from editTlTabShown / editTlTabHidden); with
//     "Everywhere" (the default) always.
//
// Pure (no ComfyUI import), so tests/test_theme.mjs runs it under node.

export const THEME_SCOPE_ID = "ImageViewer.Colours.Scope";

// The panels the dock moves; each draws its own background.
const PANELS = [".params-panel", ".history-panel", ".browser-panel", ".previz-panel", ".curves-panel"];
const sel = (list) => list.join(", ");

/** "#rrggbb" t of the way from a to b. */
export function mix(a, b, t) {
    const p = (h) => { const n = parseInt(String(h).replace(/^#/, ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
    const x = p(a), y = p(b);
    return "#" + x.map((c, i) => Math.round(c + (y[i] - c) * t).toString(16).padStart(2, "0")).join("");
}

/** "#rrggbb" a shade towards white (amt > 0) or black (amt < 0), for hover and stripes. */
export function shade(hex, amt) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
        Math.round(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt)));
    return "#" + ch.map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0")).join("");
}

// key, name, base (the stylesheet's, no "#"), group, tooltip,
// rules(c, v) -> [[selector, declarations]] (v: every colour by key, "#rrggbb")
export const THEME = [
    // ── The viewer around the Edit page ──
    { key: "window", name: "Window background", base: "1a1a1a", group: "chrome",
      tip: "Behind everything: what shows between and around the panels.",
      rules: (c) => [[":host", `background: ${c}`], [".stack-splitter", `background: ${shade(c, -0.35)}`],
                     [".paint-root", `background: ${c}`], [".paint-view", `background: ${shade(c, -0.1)}`]] },
    { key: "panel", name: "Panel background", base: "0d0d0d", group: "chrome",
      tip: "Every dock panel: History, Parameters, files, the Edit panels (unless the timeline has its own below).",
      rules: (c) => [[sel(PANELS), `background: ${c}`], [".insp-tabs", `background: ${c}`],
                     [".src-monitor", `background: ${c}`],
                     [".paint-panel", `background: ${c}`], [".paint-part-panel > .paint-slot", `background: ${c}`],
                     [".paint-dlg", `background: ${shade(c, 0.03)}`],
                     [".dp-node", `background: ${shade(c, -0.05)}`], [".dp-node.fold", `background: ${shade(c, 0.04)}`]] },
    { key: "title", name: "Panel title bars", base: "141414", group: "chrome",
      rules: (c) => [[".panel-titlebar", `background: ${c}`],
                     [".panel-titlebar:hover", `background: ${shade(c, 0.04)}`],
                     [".pt-tab.on", `background: ${shade(c, 0.08)}`],
                     [".paint-bar", `background: ${c}`], [".paint-tools", `background: ${c}`],
                     [".paint-status", `background: ${c}`], [".paint-flyout", `background: ${c}`],
                     [".paint-optbar", `background: ${shade(c, -0.12)}`]] },
    { key: "tabbar", name: "Tab bar (top)", base: "111111", group: "chrome",
      rules: (c) => [[".tab-bar", `background: ${c}`], [".dp-bar", `background: ${c}`]] },
    { key: "lowerbar", name: "Lower bar (playback)", base: "222222", group: "chrome",
      rules: (c) => [[".controls", `background: ${c}`]] },
    { key: "button", name: "Buttons", base: "333333", group: "chrome",
      tip: "Plain buttons and drop-downs. Icon buttons that are transparent stay so.",
      rules: (c) => [["button, select", `background: ${c}; border-color: ${shade(c, 0.08)}`]] },
    { key: "text", name: "Text", base: "dddddd", group: "chrome",
      rules: (c) => [[sel(PANELS), `color: ${c}`], ["button, select", `color: ${c}`],
                     [".panel-titlebar", `color: ${shade(c, -0.3)}`], [".edit-headrow", `color: ${shade(c, -0.15)}`],
                     [".paint-root", `color: ${c}`], [".paint-panel", `color: ${c}`], [".paint-dlg", `color: ${c}`],
                     [".dp-title", `color: ${c}`], [".dp-label", `color: ${c}`]] },
    { key: "border", name: "Borders", base: "333333", group: "chrome",
      rules: (c) => [[sel(PANELS), `border-color: ${c}`], [".tab-bar", `border-bottom-color: ${c}`],
                     [".controls", `border-top-color: ${c}`], [".dock-rail.bottom", `border-top-color: ${c}`],
                     [".panel-titlebar", `border-bottom-color: ${c}`],
                     [".paint-bar", `border-bottom-color: ${c}`], [".paint-optbar", `border-bottom-color: ${c}`],
                     [".paint-tools", `border-right-color: ${c}`], [".paint-status", `border-top-color: ${c}`],
                     [".paint-lhead", `border-bottom-color: ${c}`], [".paint-sect", `border-bottom-color: ${c}`],
                     [".paint-lfoot", `border-top-color: ${c}`],
                     [".dp-bar", `border-bottom-color: ${c}`], [".dp-node", `border-color: ${shade(c, 0.05)}`]] },
    { key: "accent", name: "Accent", base: "ff6600", group: "chrome",
      tip: "The tab that is up, the panel name in front, the outline of a button under the pointer.",
      rules: (c, v) => [[".tab.active", `color: ${c}; border-color: ${c}`],
                     ["button:hover, select:hover", `border-color: ${c}`],
                     [".pt-tab.on", `box-shadow: inset 0 2px 0 ${c}`],
                     [".paint-btn:hover", `border-color: ${c}`], [".paint-btn.on", `border-color: ${c}`],
                     [".paint-optbar .paint-otool", `color: ${c}`], [".paint-status b", `color: ${c}`],
                     [".paint-sect h4", `color: ${c}`], [".paint-dlg h3", `color: ${c}`], [".paint-dlg", `border-color: ${c}`],
                     [".paint-row.drop-inside", `box-shadow: inset 0 0 0 2px ${c}`],
                     [".tab.paint-dirty::after", `color: ${c}`],
                     [".dp-node.root", `border-color: ${c}; box-shadow: 0 0 0 1px ${c}`],
                     // Paint's "on" / picked rows are the accent sunk into the panel
                     [".paint-btn.on", `background: ${mix(v.panel, c, 0.18)}`],
                     [".paint-row.active", `background: ${mix(v.panel, c, 0.18)}`],
                     [".paint-row.picked", `background: ${mix(v.panel, c, 0.1)}`]] },
    { key: "viewer", name: "Picture background", base: "000000", group: "chrome",
      tip: "Behind the picture: the viewer, the Source viewer, Paint's canvas area, the Dependencies graph.",
      rules: (c) => [[".viewport", `background: ${c}`], [".paint-wrap", `background: ${c}`],
                     [".dp-view", `background: ${c} radial-gradient(${shade(c, 0.07)} 1px, transparent 1px) 0 0 / 22px 22px`]] },
    // ── The Edit page's own ──
    { key: "timeline", name: "Edit: timeline background", base: "0d0d0d", group: "edit",
      tip: "The Edit panel; over the panel background above.",
      rules: (c) => [[".curves-panel.edit-panel", `background: ${c}`]] },
    { key: "lanes", name: "Edit: track lanes", base: "0d0d0d", group: "edit",
      tip: "The strip each track's clips lie on.",
      rules: (c) => [[".edit-track", `background: ${c}`]] },
    { key: "ruler", name: "Edit: ruler", base: "0d0d0d", group: "edit",
      rules: (c) => [[".edit-ruler", `background: ${c}`]] },
    { key: "heads", name: "Edit: track headers", base: "171717", group: "edit",
      rules: (c) => [[".edit-headrow", `background: ${c}`], [".edit-split", `background: ${shade(c, 0.03)}`]] },
    { key: "inspector", name: "Edit: Inspector section headers", base: "1c1c1c", group: "edit",
      rules: (c) => [[".insp-sec", `background: ${c}`], [".mix-strip", `background: ${c}`]] },
    { key: "clip", name: "Edit: video clips (V1)", base: "2b3a4a", group: "edit",
      tip: "A clip you coloured yourself keeps its colour.",
      rules: (c) => [[".edit-shot", `background: ${c}; border-color: ${shade(c, 0.22)}`],
                     [".edit-shot:nth-child(even)", `background: ${shade(c, 0.06)}`],
                     [".edit-shot.on", `background: ${shade(c, 0.18)}`]] },
    { key: "tclip", name: "Edit: clips on higher video tracks", base: "3a4a2b", group: "edit",
      rules: (c) => [[".edit-tclip", `background: ${c}; border-color: ${shade(c, 0.22)}`]] },
    { key: "sclip", name: "Edit: sound clips", base: "2f5a45", group: "edit",
      rules: (c) => [[".edit-sclip", `background: ${c}; border-color: ${shade(c, 0.22)}`],
                     [".edit-snd", `background: ${c}`]] },
    { key: "select", name: "Edit: selection", base: "00e5ff", group: "edit",
      rules: (c) => [[".edit-shot.sel, .edit-text.sel", `border-color: ${c}; box-shadow: inset 0 0 0 1px ${c}`],
                     [".edit-shot.msel", `border-color: ${c}; box-shadow: inset 0 0 0 1px ${c}`],
                     [".edit-headrow.sel", `border-color: ${c}`]] },
    { key: "playhead", name: "Edit: playhead", base: "ffffff", group: "edit",
      rules: (c) => [[".edit-head", `background: ${c}`]] },
];
for (const t of THEME) t.id = "ImageViewer.Colours." + t.key[0].toUpperCase() + t.key.slice(1);

export const THEME_PRESET_ID = "ImageViewer.Colours.Preset";

// The Edit page's own colours that follow a preset's chrome; the clip colours
// stay the classic ones unless a preset says otherwise.
const editFrom = (v, own = {}) => ({
    timeline: v.panel, lanes: shade("#" + v.window, -0.08).slice(1), ruler: v.title, heads: v.title,
    inspector: shade("#" + v.panel, 0.05).slice(1),
    clip: "2b3a4a", tclip: "3a4a2b", sclip: "2f5a45", select: "00e5ff", playhead: "ffffff", ...own,
});
const preset = (name, chrome, own) => ({ name, values: { ...chrome, ...editFrom(chrome, own) } });

/** Every preset, every colour of it (no "#"). The first is the default. */
export const PRESETS = {
    paint: preset("Paint (dark grey)", {
        window: "151518", panel: "1b1b1f", title: "1d1d21", tabbar: "19191d", lowerbar: "1d1d21",
        button: "2a2a30", text: "dddddd", border: "2b2b30", accent: "ff6600", viewer: "232327" }),
    classic: { name: "Classic (the viewer before presets)",
               values: Object.fromEntries(THEME.map((t) => [t.key, t.base])) },
    grey: preset("Medium grey", {
        window: "2b2b2b", panel: "333333", title: "3a3a3a", tabbar: "262626", lowerbar: "363636",
        button: "4a4a4a", text: "e0e0e0", border: "454545", accent: "f08a3a", viewer: "1e1e1e" }),
    darkest: preset("Darkest", {
        window: "080808", panel: "0b0b0b", title: "101010", tabbar: "060606", lowerbar: "121212",
        button: "1f1f1f", text: "cfcfcf", border: "1f1f1f", accent: "ff6600", viewer: "000000" }),
    midnight: preset("Midnight blue", {
        window: "121620", panel: "171c27", title: "1c2230", tabbar: "10131b", lowerbar: "1a2030",
        button: "29334a", text: "d6deea", border: "283147", accent: "4c9aff", viewer: "0b0e15" },
        { clip: "2c3e5c", select: "7fd0ff" }),
    contrast: preset("High contrast", {
        window: "000000", panel: "000000", title: "0d0d0d", tabbar: "000000", lowerbar: "0d0d0d",
        button: "1c1c1c", text: "ffffff", border: "808080", accent: "ffd400", viewer: "000000" },
        { clip: "1f4f8f", tclip: "3f7f1f", sclip: "1f7f5f", select: "00ffff", playhead: "ffff00" }),
};
// The default of every colour is the default preset's.
for (const t of THEME) t.def = PRESETS.paint.values[t.key];

/** The preset whose colours these are (by key or setting id), or "custom". */
export function matchPreset(values) {
    for (const [k, p] of Object.entries(PRESETS)) {
        if (THEME.every((t) => cleanColor(pick(values, t)) === "#" + p.values[t.key])) return k;
    }
    return "custom";
}

// ── "Follow ComfyUI" (Sebastian 2026-11-10: "Comfyui has its own color themes by
// now - let's have the viewer just follow those by default") ──
// Not a table: the colours are read off ComfyUI's page whenever its palette
// changes. ComfyUI (Settings > Appearance > Color palette) writes its palette as
// CSS variables on <html>: the newer frontends their theme tokens (--background,
// --foreground, --card, --secondary, --border, --primary; resolvePaletteTheme in
// the frontend's colorPaletteTheme), older ones only the comfy_base ones
// (--comfy-menu-bg, --fg-color, ...), and the canvas colour is LiteGraph's
// CLEAR_BACKGROUND_COLOR. Each colour takes the first of its list that is there.
export const COMFY = "comfy";
export const COMFY_NAME = "Follow ComfyUI";

// The variables read (without "--"), in order of preference.
export const COMFY_VARS = {
    panel: ["interface-panel-surface", "background", "comfy-menu-bg"],
    card: ["card", "comfy-menu-secondary-bg"],
    button: ["secondary", "comfy-input-bg", "card"],
    text: ["foreground", "fg-color", "input-text"],
    border: ["border", "interface-stroke", "border-color"],
    accent: ["primary", "p-primary-color"],
    canvas: ["bg-color"],
};

/** Every colour (no "#") from ComfyUI's palette. `read(name)` gives the CSS
 *  variable --name as "#rrggbb", or null when the page has none; `canvas` is the
 *  graph's background colour, if known. Null when there is no palette to follow
 *  (no ComfyUI page), so the caller keeps what it has. */
export function comfyValues(read, canvas) {
    const get = (k) => {
        for (const n of COMFY_VARS[k]) { const c = cleanColor(read(n)); if (c) return c; }
        return null;
    };
    const panel = get("panel");
    if (!panel) return null;
    const card = get("card") || shade(panel, 0.08);
    const fg = get("text") || "#dddddd";
    const light = lightness(panel) > 0.5;
    const viewer = cleanColor(canvas) || get("canvas") || shade(panel, light ? -0.1 : -0.25);
    const chrome = {
        window: shade(panel, light ? -0.06 : -0.12),
        panel,
        title: mix(panel, card, 0.4),
        tabbar: shade(panel, light ? -0.03 : -0.06),
        lowerbar: mix(panel, card, 0.4),
        button: get("button") || card,
        text: mix(fg, panel, 0.12),
        border: get("border") || mix(panel, fg, 0.15),
        accent: get("accent") || "#" + BASE_ACCENT,
        viewer,
    };
    const v = Object.fromEntries(Object.entries(chrome).map(([k, c]) => [k, c.slice(1)]));
    return { ...v, ...editFrom(v, light ? { playhead: fg.slice(1), select: "0077cc" } : { playhead: fg.slice(1) }) };
}

/** 0..1, how light a "#rrggbb" is (sRGB luma). */
export function lightness(hex) {
    const n = parseInt(String(hex).replace(/^#/, ""), 16);
    return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

/** A reader for comfyValues: CSS variables of `doc`'s <html> as "#rrggbb", whatever
 *  they hold (a hex, rgb(), var(), color-mix()) - the browser resolves them on a
 *  probe and a 1-pixel canvas spells the result. Browser only. */
export function cssColourReader(doc) {
    const win = doc.defaultView;
    const root = doc.documentElement;
    const own = win.getComputedStyle(root);
    let probe = null, ctx = null;
    const read = (name) => {
        if (!String(own.getPropertyValue("--" + name) || "").trim()) return null;
        if (!probe) {
            probe = doc.createElement("div");
            probe.style.cssText = "display:none";
            root.appendChild(probe);
            const cv = doc.createElement("canvas");
            cv.width = cv.height = 1;
            ctx = cv.getContext("2d", { willReadFrequently: true });
        }
        probe.style.color = "";
        probe.style.color = `var(--${name})`;
        return spell(ctx, win.getComputedStyle(probe).color);
    };
    read.done = () => { if (probe) probe.remove(); probe = null; };
    return read;
}

/** Any CSS colour -> "#rrggbb" (null when see-through). */
export function spell(ctx, colour) {
    if (!ctx || !colour) return null;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    if (d[3] < 8) return null;
    return "#" + [d[0], d[1], d[2]].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** ComfyUI's colours now, from the main window: null without a palette. */
export function readComfyColours(doc, canvasColour) {
    if (!doc || !doc.defaultView) return null;
    const read = cssColourReader(doc);
    try { return comfyValues(read, canvasColour); }
    finally { read.done(); }
}

const pick = (values, t) => (values ? (values[t.key] !== undefined ? values[t.key] : values[t.id]) : undefined);

/** A colour as a setting holds it ("rrggbb", "#rrggbb", anything else) -> "#rrggbb", or null. */
export function cleanColor(v) {
    const s = String(v == null ? "" : v).trim().replace(/^#/, "").toLowerCase();
    if (/^[0-9a-f]{6}$/.test(s)) return "#" + s;
    if (/^[0-9a-f]{3}$/.test(s)) return "#" + s.split("").map((x) => x + x).join("");
    return null;
}

/** The CSS for the colours: {edit, chrome}. `values` maps a THEME key (or its
 *  setting id) to a colour; one missing or not a colour is its default. */
export function themeCss(values) {
    const out = { edit: "", chrome: "" };
    const v = {};
    for (const t of THEME) v[t.key] = cleanColor(pick(values, t)) || "#" + t.def;
    for (const t of THEME) {
        for (const [s, d] of t.rules(v[t.key], v)) out[t.group] += `${s} { ${d}; }\n`;
    }
    return out;
}

/** The stylesheet's own orange, as the browser spells it in a rule. */
export const BASE_ACCENT = "ff6600";
const ACCENT_RE = /rgba?\(255, 102, 0(?:, ([\d.]+))?\)/g;

/** A declaration's value with the stylesheet's orange made `accent` ("#rrggbb"). */
export function swapAccent(value, accent) {
    const n = parseInt(accent.slice(1), 16);
    const rgb = `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
    return String(value).replace(ACCENT_RE, (m, a) => (a === undefined ? `rgb(${rgb})` : `rgba(${rgb}, ${a})`));
}

/** Same-selector rules for every declaration of these style rules that uses the
 *  stylesheet's orange: the accent reaches the many places that have it (the lit
 *  buttons of the bar, Paint's sliders, ...) without a table of them. Rules
 *  inside @media and the like are left alone. */
export function accentRules(rules, accent) {
    let out = "";
    for (const rule of rules || []) {
        if (!rule || !rule.selectorText || !rule.style) continue;
        const decls = [];
        for (let i = 0; i < rule.style.length; i++) {
            const prop = rule.style[i];
            const v = rule.style.getPropertyValue(prop);
            ACCENT_RE.lastIndex = 0;
            if (!ACCENT_RE.test(v)) continue;
            const imp = rule.style.getPropertyPriority(prop) ? " !important" : "";
            decls.push(`${prop}: ${swapAccent(v, accent)}${imp}`);
        }
        if (decls.length) out += `${rule.selectorText} { ${decls.join("; ")}; }\n`;
    }
    return out;
}

/** The panel side: two <style>s after the stylesheet, refreshed on a change.
 *  `readComfy()` gives ComfyUI's colours now (comfyValues) or null; with the
 *  preset "Follow ComfyUI" those are the colours, and `onFollow(values)` is told
 *  them (the settings write them into the colour rows). */
export function makeThemeMixin(readPref, readComfy = () => null, onFollow = () => {}) {
    return {
        /** The colours to use now, by key. */
        _themeValues() {
            if (readPref(THEME_PRESET_ID) === COMFY) {
                this._themeWatchComfy();
                const c = readComfy();
                if (c) { onFollow(c); return c; }
            }
            const values = {};
            for (const t of THEME) values[t.key] = readPref(t.id);
            return values;
        },

        _themeApply() {
            const root = this.shadowRoot;
            if (!root) return;
            const values = this._themeValues();
            const css = themeCss(values);
            const accent = cleanColor(values.accent) || "#" + BASE_ACCENT;
            if (accent !== "#" + BASE_ACCENT) {
                for (const sheet of root.styleSheets || []) {
                    const own = sheet.ownerNode;
                    if (own && own.dataset && own.dataset.ivTheme) continue;
                    let rules = null;
                    try { rules = sheet.cssRules; } catch (e) { continue; }
                    // Before the theme's own, which say the same for the parts they name.
                    css.chrome = accentRules(rules, accent) + css.chrome;
                }
            }
            this._themeCss = css;
            this._themeWindow = cleanColor(values.window) || "#" + THEME[0].def;
            for (const host of this._themeHosts()) {
                for (const g of ["edit", "chrome"]) {
                    let el = host.querySelector(`style[data-iv-theme="${g}"]`);
                    if (!el) {
                        el = (host.ownerDocument || host).createElement("style");
                        el.dataset.ivTheme = g;
                    }
                    // Always last, so it comes after any style a feature appended meanwhile.
                    host.appendChild(el);
                    if (el.textContent !== css[g]) el.textContent = css[g];
                }
            }
            const pop = this._themePopoutDoc();
            // The popped-out window's body is what :host is in the page.
            if (pop && pop.body) pop.body.style.backgroundColor = this._themeWindow;
            this._themeSync();
        },

        /** Where the two styles go: the shadow root, and while the viewer is popped
         *  out the other window's <head> - the styles were copied there when it was
         *  undocked, so a change made later reaches it only by being written there too. */
        _themeHosts() {
            const out = [this.shadowRoot];
            const pop = this._themePopoutDoc();
            if (pop && pop.head) out.push(pop.head);
            return out;
        },

        _themePopoutDoc() {
            const w = this.popoutWindow;
            try {
                if (!w || w.closed || !this.container || this.container.ownerDocument !== w.document) return null;
                return w.document;
            } catch (e) { return null; }
        },

        /** ComfyUI's palette is watched while the preset follows it: <html>'s inline
         *  style (the variables), its class and data-theme, and <head>'s styles. */
        _themeWatchComfy() {
            if (this._themeComfyObs) return;
            const doc = this.ownerDocument || (typeof document !== "undefined" ? document : null);
            const MO = doc && doc.defaultView && doc.defaultView.MutationObserver;
            if (!MO) return;
            let timer = null;
            const fire = () => {
                timer = null;
                if (readPref(THEME_PRESET_ID) !== COMFY) return;
                const c = readComfy();
                const sig = c ? JSON.stringify(c) : "";
                if (sig === this._themeComfySig) return;
                this._themeComfySig = sig;
                this._themeApply();
            };
            const obs = new MO(() => { if (!timer) timer = setTimeout(fire, 30); });
            obs.observe(doc.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
            if (doc.head) obs.observe(doc.head, { childList: true });
            this._themeComfyObs = obs;
            const c = readComfy();
            this._themeComfySig = c ? JSON.stringify(c) : "";
        },

        /** The viewer's colours are on everywhere, or only while a cut's tab is up. */
        //  `onEdit`: whether a cut's tab is (about to be) up; left out, the tab that is up says.
        _themeSync(onEdit) {
            if (onEdit !== undefined) this._themeOnEdit = !!onEdit;
            if (!this.shadowRoot) return;
            const everywhere = readPref(THEME_SCOPE_ID) === "all";
            const edit = onEdit !== undefined ? !!onEdit
                : this._themeOnEdit !== undefined ? this._themeOnEdit
                : !!(this.isEditTab && this.isEditTab(this.activeTab));
            const on = everywhere || edit;
            for (const host of this._themeHosts()) {
                const el = host.querySelector('style[data-iv-theme="chrome"]');
                if (el) el.media = on ? "all" : "not all";
            }
        },
    };
}

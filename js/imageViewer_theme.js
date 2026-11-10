// imageViewer_theme.js    Settings → ComfyUI Image Viewer → Colours
//
// The viewer's colours as settings: the panels' backgrounds, the bars, the
// buttons, and the Edit page's own (timeline, track headers, clips, playhead).
// Asked for by Sebastian 2026-11-10 ("change the colors of the UI elements,
// including the backgrounds of the panels").
//
// The stylesheet (imageViewer.css) keeps its colours as they are. A colour that
// is changed adds ONE rule here, with the SAME selector as the rule it changes,
// in a <style> appended after the stylesheet: same specificity, later, so it
// wins exactly where the original rule applied and nowhere else (a `.pt-btn`
// stays transparent when the buttons' colour changes). A colour left at its
// default writes nothing, so an untouched viewer is the viewer as it was.
//
// Two groups:
//   - "edit": the Edit page's own parts (they exist only on a cut's tab), always on;
//   - "chrome": the viewer around them (panels, title bars, bars, buttons). With
//     "Use the colours" = "On the Edit page" they are on only while a cut's tab
//     is up (`_themeSync`, from editTlTabShown / editTlTabHidden); with
//     "Everywhere" always.
//
// Pure (no ComfyUI import), so tests/test_theme.mjs runs it under node.

export const THEME_SCOPE_ID = "ImageViewer.Colours.Scope";

// The panels the dock moves; each draws its own background.
const PANELS = [".params-panel", ".history-panel", ".browser-panel", ".previz-panel", ".curves-panel"];
const sel = (list) => list.join(", ");

/** "#rrggbb" a shade towards white (amt > 0) or black (amt < 0), for hover and stripes. */
export function shade(hex, amt) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
        Math.round(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt)));
    return "#" + ch.map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0")).join("");
}

// key, setting id suffix, name, default (no "#"), group, tooltip, rules(c) -> [[selector, declarations]]
export const THEME = [
    // ── The viewer around the Edit page ──
    { key: "window", name: "Window background", def: "1a1a1a", group: "chrome",
      tip: "Behind everything: what shows between and around the panels.",
      rules: (c) => [[":host", `background: ${c}`], [".stack-splitter", `background: ${shade(c, -0.35)}`]] },
    { key: "panel", name: "Panel background", def: "0d0d0d", group: "chrome",
      tip: "Every dock panel: History, Parameters, files, the Edit panels (unless the timeline has its own below).",
      rules: (c) => [[sel(PANELS), `background: ${c}`], [".insp-tabs", `background: ${c}`],
                     [".src-monitor", `background: ${c}`]] },
    { key: "title", name: "Panel title bars", def: "141414", group: "chrome",
      rules: (c) => [[".panel-titlebar", `background: ${c}`],
                     [".panel-titlebar:hover", `background: ${shade(c, 0.04)}`],
                     [".pt-tab.on", `background: ${shade(c, 0.08)}`]] },
    { key: "tabbar", name: "Tab bar (top)", def: "111111", group: "chrome",
      rules: (c) => [[".tab-bar", `background: ${c}`]] },
    { key: "lowerbar", name: "Lower bar (playback)", def: "222222", group: "chrome",
      rules: (c) => [[".controls", `background: ${c}`]] },
    { key: "button", name: "Buttons", def: "333333", group: "chrome",
      tip: "Plain buttons and drop-downs. Icon buttons that are transparent stay so.",
      rules: (c) => [["button, select", `background: ${c}; border-color: ${shade(c, 0.08)}`]] },
    { key: "text", name: "Text", def: "dddddd", group: "chrome",
      rules: (c) => [[sel(PANELS), `color: ${c}`], ["button, select", `color: ${c}`],
                     [".panel-titlebar", `color: ${shade(c, -0.3)}`], [".edit-headrow", `color: ${shade(c, -0.15)}`]] },
    { key: "border", name: "Borders", def: "333333", group: "chrome",
      rules: (c) => [[sel(PANELS), `border-color: ${c}`], [".tab-bar", `border-bottom-color: ${c}`],
                     [".controls", `border-top-color: ${c}`], [".dock-rail.bottom", `border-top-color: ${c}`],
                     [".panel-titlebar", `border-bottom-color: ${c}`]] },
    { key: "accent", name: "Accent", def: "ff6600", group: "chrome",
      tip: "The tab that is up, the panel name in front, the outline of a button under the pointer.",
      rules: (c) => [[".tab.active", `color: ${c}; border-color: ${c}`],
                     ["button:hover, select:hover", `border-color: ${c}`],
                     [".pt-tab.on", `box-shadow: inset 0 2px 0 ${c}`]] },
    { key: "viewer", name: "Picture background", def: "000000", group: "chrome",
      tip: "Behind the picture in the viewer (the timeline's viewer and the Source viewer).",
      rules: (c) => [[".viewport", `background: ${c}`]] },
    // ── The Edit page's own ──
    { key: "timeline", name: "Edit: timeline background", def: "0d0d0d", group: "edit",
      tip: "The Edit panel. Unchanged, it is the panel background above.",
      rules: (c) => [[".curves-panel.edit-panel", `background: ${c}`]] },
    { key: "lanes", name: "Edit: track lanes", def: "0d0d0d", group: "edit",
      tip: "The strip each track's clips lie on. Unchanged, the lanes show the timeline's background.",
      rules: (c) => [[".edit-track", `background: ${c}`]] },
    { key: "ruler", name: "Edit: ruler", def: "0d0d0d", group: "edit",
      tip: "Unchanged, the ruler shows the timeline's background.",
      rules: (c) => [[".edit-ruler", `background: ${c}`]] },
    { key: "heads", name: "Edit: track headers", def: "171717", group: "edit",
      rules: (c) => [[".edit-headrow", `background: ${c}`], [".edit-split", `background: ${shade(c, 0.03)}`]] },
    { key: "inspector", name: "Edit: Inspector section headers", def: "1c1c1c", group: "edit",
      rules: (c) => [[".insp-sec", `background: ${c}`], [".mix-strip", `background: ${c}`]] },
    { key: "clip", name: "Edit: video clips (V1)", def: "2b3a4a", group: "edit",
      tip: "A clip you coloured yourself keeps its colour.",
      rules: (c) => [[".edit-shot", `background: ${c}; border-color: ${shade(c, 0.22)}`],
                     [".edit-shot:nth-child(even)", `background: ${shade(c, 0.06)}`],
                     [".edit-shot.on", `background: ${shade(c, 0.18)}`]] },
    { key: "tclip", name: "Edit: clips on higher video tracks", def: "3a4a2b", group: "edit",
      rules: (c) => [[".edit-tclip", `background: ${c}; border-color: ${shade(c, 0.22)}`]] },
    { key: "sclip", name: "Edit: sound clips", def: "2f5a45", group: "edit",
      rules: (c) => [[".edit-sclip", `background: ${c}; border-color: ${shade(c, 0.22)}`],
                     [".edit-snd", `background: ${c}`]] },
    { key: "select", name: "Edit: selection", def: "00e5ff", group: "edit",
      rules: (c) => [[".edit-shot.sel, .edit-text.sel", `border-color: ${c}; box-shadow: inset 0 0 0 1px ${c}`],
                     [".edit-shot.msel", `border-color: ${c}; box-shadow: inset 0 0 0 1px ${c}`],
                     [".edit-headrow.sel", `border-color: ${c}`]] },
    { key: "playhead", name: "Edit: playhead", def: "ffffff", group: "edit",
      rules: (c) => [[".edit-head", `background: ${c}`]] },
];
for (const t of THEME) t.id = "ImageViewer.Colours." + t.key[0].toUpperCase() + t.key.slice(1);

/** A colour as a setting holds it ("rrggbb", "#rrggbb", anything else) -> "#rrggbb", or null. */
export function cleanColor(v) {
    const s = String(v == null ? "" : v).trim().replace(/^#/, "").toLowerCase();
    if (/^[0-9a-f]{6}$/.test(s)) return "#" + s;
    if (/^[0-9a-f]{3}$/.test(s)) return "#" + s.split("").map((x) => x + x).join("");
    return null;
}

/** The CSS for the colours that differ from their defaults: {edit, chrome}.
 *  `values` maps a THEME key (or its setting id) to a colour. */
export function themeCss(values) {
    const out = { edit: "", chrome: "" };
    for (const t of THEME) {
        const raw = values ? (values[t.key] !== undefined ? values[t.key] : values[t.id]) : undefined;
        const c = cleanColor(raw);
        if (!c || c === "#" + t.def) continue;
        for (const [s, d] of t.rules(c)) out[t.group] += `${s} { ${d}; }\n`;
    }
    return out;
}

/** The panel side: two <style>s after the stylesheet, refreshed on a change. */
export function makeThemeMixin(readPref) {
    return {
        _themeApply() {
            const root = this.shadowRoot;
            if (!root) return;
            const values = {};
            for (const t of THEME) values[t.key] = readPref(t.id);
            const css = themeCss(values);
            for (const g of ["edit", "chrome"]) {
                let el = root.querySelector(`style[data-iv-theme="${g}"]`);
                if (!el) {
                    el = root.ownerDocument.createElement("style");
                    el.dataset.ivTheme = g;
                }
                // Always last, so it comes after any style a feature appended meanwhile.
                root.appendChild(el);
                if (el.textContent !== css[g]) el.textContent = css[g];
            }
            this._themeSync();
        },

        /** The viewer's colours are on everywhere, or only while a cut's tab is up. */
        //  `onEdit`: whether a cut's tab is (about to be) up; left out, the tab that is up says.
        _themeSync(onEdit) {
            if (onEdit !== undefined) this._themeOnEdit = !!onEdit;
            const el = this.shadowRoot && this.shadowRoot.querySelector('style[data-iv-theme="chrome"]');
            if (!el) return;
            const everywhere = readPref(THEME_SCOPE_ID) === "all";
            const edit = onEdit !== undefined ? !!onEdit
                : this._themeOnEdit !== undefined ? this._themeOnEdit
                : !!(this.isEditTab && this.isEditTab(this.activeTab));
            const on = everywhere || edit;
            el.media = on ? "all" : "not all";
        },
    };
}

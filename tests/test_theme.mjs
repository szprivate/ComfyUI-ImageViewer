import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { THEME, PRESETS, themeCss, matchPreset, cleanColor, shade, mix, swapAccent, accentRules,
         comfyValues, COMFY_VARS, lightness } from "../js/imageViewer_theme.js";

// The viewer's stylesheet and Paint's (a string in the editor's module).
const CSS = readFileSync(new URL("../js/imageViewer.css", import.meta.url), "utf8") + "\n" +
            readFileSync(new URL("../js/imageViewer_paintEditor.js", import.meta.url), "utf8");

test("the default is the Paint preset, and missing colours are their defaults", () => {
    const defs = Object.fromEntries(THEME.map((t) => [t.key, t.def]));
    assert.deepEqual(defs, PRESETS.paint.values);
    assert.deepEqual(themeCss({}), themeCss(defs));
    assert.match(themeCss({}).chrome, /\.paint-root \{ background: #151518; \}/);
    // ComfyUI keeps colours without "#"; with one, or upper case, is the same colour.
    assert.deepEqual(themeCss({ panel: "#1B1B1F" }), themeCss({}));
});

test("a colour writes its rules into its group, by key or by setting id", () => {
    const a = themeCss({ panel: "404040", clip: "#aa2200" });
    assert.match(a.chrome, /\.curves-panel[^{]*\{ background: #404040; \}/);
    assert.match(a.chrome, /\.paint-panel \{ background: #404040; \}/);
    assert.equal(a.edit.includes(".edit-shot { background: #aa2200"), true);
    const panelId = THEME.find((t) => t.key === "panel").id;
    assert.equal(themeCss({ [panelId]: "404040" }).chrome, a.chrome);
    assert.deepEqual(themeCss({ panel: "not a colour" }), themeCss({}));
});

test("the colours reach Paint and the Dependencies tab", () => {
    const css = themeCss({ ...PRESETS.midnight.values }).chrome;
    for (const s of [".paint-root", ".paint-panel", ".paint-bar", ".paint-wrap", ".paint-btn:hover", ".dp-view", ".dp-node", ".dp-bar"]) {
        assert.equal(css.includes(s + " {"), true, s);
    }
    assert.match(css, /\.paint-btn:hover \{ border-color: #4c9aff; \}/);
});

test("every selector is one a stylesheet has, so a rule changes only what it was", () => {
    // Its own on purpose: the Edit panel's background over the panels' one.
    const OWN = new Set([".curves-panel.edit-panel"]);
    const all = Object.fromEntries(THEME.map((t) => [t.key, "#123456"]));
    for (const t of THEME) {
        for (const [selector] of t.rules("#123456", all)) {
            for (const one of selector.split(",").map((s) => s.trim())) {
                if (OWN.has(one)) continue;
                const esc = one.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                assert.match(CSS, new RegExp(`(^|[\\s,}])${esc}\\s*[,{]`, "m"), `${t.key}: ${one} not in a stylesheet`);
            }
        }
    }
});

test("presets: every colour of each, the classic one is the stylesheet's, and a set is recognised", () => {
    for (const [k, p] of Object.entries(PRESETS)) {
        assert.equal(typeof p.name, "string");
        for (const t of THEME) assert.equal(cleanColor(p.values[t.key]), "#" + p.values[t.key], `${k}.${t.key}`);
        assert.equal(matchPreset(p.values), k);
    }
    for (const t of THEME) assert.equal(PRESETS.classic.values[t.key], t.base);
    assert.equal(matchPreset({ ...PRESETS.grey.values, accent: "123456" }), "custom");
    const ids = Object.fromEntries(THEME.map((t) => [t.id, PRESETS.darkest.values[t.key]]));
    assert.equal(matchPreset(ids), "darkest");
});

test("setting ids are unique and under ImageViewer.Colours", () => {
    const ids = THEME.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, /^ImageViewer\.Colours\.[A-Z]\w+$/);
    for (const t of THEME) assert.equal(cleanColor(t.def), "#" + t.def);
});

test("cleanColor, shade and mix", () => {
    assert.equal(cleanColor("ABC"), "#aabbcc");
    assert.equal(cleanColor(""), null);
    assert.equal(shade("#000000", 0.5), "#808080");
    assert.equal(shade("#ffffff", -0.5), "#808080");
    assert.equal(shade("#123456", 0), "#123456");
    assert.equal(mix("#000000", "#ffffff", 0.5), "#808080");
    assert.equal(mix("#102030", "#ffffff", 0), "#102030");
});

test("the accent takes the stylesheet's orange wherever a rule has it", () => {
    assert.equal(swapAccent("0 0 0 1px rgb(255, 102, 0)", "#4c9aff"), "0 0 0 1px rgb(76, 154, 255)");
    assert.equal(swapAccent("rgba(255, 102, 0, 0.15)", "#4c9aff"), "rgba(76, 154, 255, 0.15)");
    const style = (o, imp = {}) => Object.assign(Object.keys(o), {
        getPropertyValue: (p) => o[p], getPropertyPriority: (p) => (imp[p] ? "important" : "") });
    const rules = [
        { selectorText: ".bar-group.active", style: style({ color: "rgb(255, 102, 0)", "font-size": "12px" }) },
        { selectorText: ".x", style: style({ stroke: "rgb(255, 102, 0)" }, { stroke: true }) },
        { selectorText: ".plain", style: style({ color: "rgb(1, 2, 3)" }) },
        { media: "print", cssRules: [] },
    ];
    assert.equal(accentRules(rules, "#4c9aff"),
                 ".bar-group.active { color: rgb(76, 154, 255); }\n.x { stroke: rgb(76, 154, 255) !important; }\n");
});

test("Follow ComfyUI: every colour from its palette, the newer tokens before the older names", () => {
    const vars = (o) => (n) => (n in o ? o[n] : null);
    // No palette on the page (not ComfyUI): nothing to follow.
    assert.equal(comfyValues(vars({})), null);
    // ComfyUI's own dark palette (1.58): theme tokens and the older comfy_base names both there.
    const dark = { background: "#171718", "comfy-menu-bg": "#171718", card: "#262729", secondary: "#262729",
                   foreground: "#ffffff", border: "#494a50", "border-color": "#4e4e4e", primary: "#0b8ce9",
                   "bg-color": "#202020" };
    const v = comfyValues(vars(dark), "#141414");
    for (const t of THEME) assert.equal(cleanColor(v[t.key]), "#" + v[t.key], t.key);
    assert.equal(v.panel, "171718");
    assert.equal(v.button, "262729");
    assert.equal(v.border, "494a50", "the token, not the older name");
    assert.equal(v.accent, "0b8ce9");
    assert.equal(v.viewer, "141414", "the graph's background");
    assert.equal(v.timeline, v.panel);
    // An older frontend: only the comfy_base names.
    const old = comfyValues(vars({ "comfy-menu-bg": "#242730", "fg-color": "#fff", "border-color": "#6e7581" }));
    assert.equal(old.panel, "242730");
    assert.equal(old.border, "6e7581");
    assert.equal(old.accent, "ff6600", "no primary colour: the viewer's own orange");
    assert.equal(old.viewer, shade("#242730", -0.25).slice(1));
    // A light palette: the playhead is the text colour, not white on white.
    const light = comfyValues(vars({ background: "#ffffff", foreground: "#171718" }));
    assert.ok(lightness("#" + light.panel) > 0.5);
    assert.equal(light.playhead, "171718");
    assert.equal(matchPreset(light), "custom");
    for (const list of Object.values(COMFY_VARS)) assert.ok(list.length > 0);
});

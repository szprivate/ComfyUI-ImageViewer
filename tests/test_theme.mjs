import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { THEME, PRESETS, themeCss, matchPreset, cleanColor, shade, mix, swapAccent, accentRules } from "../js/imageViewer_theme.js";

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

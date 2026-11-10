import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { THEME, themeCss, cleanColor, shade } from "../js/imageViewer_theme.js";

const CSS = readFileSync(new URL("../js/imageViewer.css", import.meta.url), "utf8");

test("colours left at their defaults write no CSS", () => {
    assert.deepEqual(themeCss({}), { edit: "", chrome: "" });
    const defs = Object.fromEntries(THEME.map((t) => [t.key, t.def]));
    assert.deepEqual(themeCss(defs), { edit: "", chrome: "" });
    // ComfyUI keeps colours without "#"; with one, or upper case, is the same colour.
    assert.deepEqual(themeCss({ panel: "#0D0D0D" }), { edit: "", chrome: "" });
});

test("a changed colour writes its rules into its group, by key or by setting id", () => {
    const a = themeCss({ panel: "404040", clip: "#aa2200" });
    assert.match(a.chrome, /\.curves-panel[^{]*\{ background: #404040; \}/);
    assert.equal(a.edit.includes(".edit-shot { background: #aa2200"), true);
    const panelId = THEME.find((t) => t.key === "panel").id;
    assert.equal(themeCss({ [panelId]: "404040" }).chrome, a.chrome);
    assert.deepEqual(themeCss({ panel: "not a colour" }), { edit: "", chrome: "" });
});

test("every selector is one the stylesheet has, so a rule changes only what it was", () => {
    // Its own on purpose: the Edit panel's background over the panels' one.
    const OWN = new Set([".curves-panel.edit-panel"]);
    for (const t of THEME) {
        for (const [selector] of t.rules("#123456")) {
            for (const one of selector.split(",").map((s) => s.trim())) {
                if (OWN.has(one)) continue;
                const esc = one.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                assert.match(CSS, new RegExp(`(^|[\\s,}])${esc}\\s*[,{]`, "m"), `${t.key}: ${one} not in imageViewer.css`);
            }
        }
    }
});

test("setting ids are unique and under ImageViewer.Colours", () => {
    const ids = THEME.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, /^ImageViewer\.Colours\.[A-Z]\w+$/);
    for (const t of THEME) assert.equal(cleanColor(t.def), "#" + t.def);
});

test("cleanColor and shade", () => {
    assert.equal(cleanColor("ABC"), "#aabbcc");
    assert.equal(cleanColor(""), null);
    assert.equal(shade("#000000", 0.5), "#808080");
    assert.equal(shade("#ffffff", -0.5), "#808080");
    assert.equal(shade("#123456", 0), "#123456");
});

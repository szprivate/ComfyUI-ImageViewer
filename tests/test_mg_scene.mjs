// node --test tests/test_mg_scene.mjs
// The viewer's copy of the shared scene module answers the same golden vectors and
// validation cases as agentY-core's, and is the same file when the sibling checkout is here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as M from "../js/bEpicViewer_mgScene.js";

const here = (p) => new URL(p, import.meta.url);
const close = (a, b, eps = 1e-6) => {
    if (Array.isArray(a)) { a.forEach((x, i) => close(x, b[i], eps)); return; }
    if (typeof a === "string") { assert.equal(a, b); return; }
    assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
};

test("golden vectors", () => {
    for (const c of JSON.parse(fs.readFileSync(here("./mg/golden.json")))) {
        c.frames.forEach((f, i) => close(M.valueAt({ tracks: { [c.prop]: c.keys } }, c.prop, f), c.expect[i]));
    }
});

test("validation cases", () => {
    for (const c of JSON.parse(fs.readFileSync(here("./mg/validate_cases.json")))) {
        const r = M.validateScene(c.scene);
        assert.deepEqual(r.errors.map((e) => e.code).sort(), [...c.errors].sort(), c.name);
        assert.deepEqual(r.warnings.map((e) => e.code).sort(), [...c.warnings].sort(), c.name);
    }
});

test("identical to agentY-core's canonical copy (when the checkout is next door)", (t) => {
    const canon = new URL("../../agentY-core/agenty_core/motion_graphics/renderer/src/mgscene.js", import.meta.url);
    if (!fs.existsSync(canon)) return t.skip("agentY-core is not checked out beside the viewer");
    const norm = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
    assert.equal(norm(here("../js/bEpicViewer_mgScene.js")), norm(canon),
        "copy agentY-core/agenty_core/motion_graphics/renderer/src/mgscene.js over js/bEpicViewer_mgScene.js");
});

test("scene values cannot break out of the markup they are put into", () => {
    // A scene file is the agent's (or anyone's) JSON; its SVG lands in innerHTML.
    const scene = {
        mgscene: 1, comp: { width: 100, height: 100, fps: 24, duration: 10 },
        assets: { f: { type: "font", src: "x.ttf", family: 'A"}</style><img src=x onerror=alert(1)>',
                       weight: '400;}</style><script>', style: "x;}</style>" } },
        layers: [{ id: "t", type: "text", text: "hi", weight: '400" onmouseover="alert(1)' }],
    };
    const css = M.fontFaceCss(scene, () => "u");
    assert.ok(!/[<>]/.test(css), css);
    const res = M.evaluateScene(scene, 0)[0];
    const out = M.layerSvg(scene, res, {});
    assert.ok(!out.includes("onmouseover"), out);
    assert.ok(out.includes('font-weight="400"'), out);
});

// The render settings of the second renderer (path traced; imageViewer_view3dPathTrace.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSettings, RENDER_DEFAULTS, RENDERERS } from "../js/imageViewer_scene3d.js";

test("a shot renders raster unless it says otherwise", () => {
    const st = renderSettings({});
    assert.equal(st.renderer, "raster");
    assert.equal(st.samples, RENDER_DEFAULTS.samples);
    assert.equal(st.bounces, RENDER_DEFAULTS.bounces);
    assert.deepEqual(RENDERERS, ["raster", "pathtraced"]);
});

test("path traced settings are kept and held in range", () => {
    const st = renderSettings({ render: { renderer: "pathtraced", samples: "512", bounces: 99 } });
    assert.equal(st.renderer, "pathtraced");
    assert.equal(st.samples, 512);
    assert.equal(st.bounces, 32);
    const bad = renderSettings({ render: { renderer: "cycles", samples: -4, bounces: "x" } });
    assert.equal(bad.renderer, "raster");
    assert.equal(bad.samples, 1);
    assert.equal(bad.bounces, RENDER_DEFAULTS.bounces);
});

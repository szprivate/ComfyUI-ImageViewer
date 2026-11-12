// The light kinds as data (imageViewer_worldData.js): types, defaults, the rows a type shows, the studio rule.
// Run: node --test tests/test_world_lights.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { lightSettings, makeLightItem, worldFields, studioLightsOn, LIGHT_TYPES } from "../js/imageViewer_worldData.js";

test("the World kit's Lamp keeps its old numbers and fixture", () => {
    const lamp = makeLightItem("light");
    assert.equal(lamp.name, "Lamp");
    assert.equal(lamp.light.type, "point");
    assert.equal(lamp.light.intensity, 18);
    assert.equal(lamp.light.distance, 14);
    assert.equal(lamp.light.fixture.shape, "tube");
    // A lamp saved before light types existed reads the same.
    const old = lightSettings({ light: { color: "#fff6e8", intensity: 18, distance: 14, decay: 2, shadows: false,
                                         fixture: { shape: "panel", size: [1, 0.1, 0.1], emissive: 6 } } });
    assert.equal(old.type, "point");
    assert.equal(old.fixture.shape, "panel");
});

test("each Create > Light type starts as itself, with no fixture", () => {
    for (const t of LIGHT_TYPES) {
        const it = makeLightItem("l", t);
        assert.equal(it.kind, "light");
        assert.equal(it.light.type, t);
        assert.equal(it.light.fixture.shape, "none");
    }
    assert.equal(lightSettings({ light: { type: "bogus" } }).type, "point");
    // Area and dome lights cast no shadows in three.js.
    assert.equal(lightSettings({ light: { type: "area", shadows: true } }).shadows, false);
    assert.equal(lightSettings({ light: { type: "spot", shadows: true } }).shadows, true);
    assert.equal(lightSettings({ light: { type: "spot", angle: 200 } }).angle, 89);
});

test("the channel box rows follow the light's type", () => {
    const rows = (t) => worldFields(makeLightItem("l", t)).map((f) => f.path);
    assert.ok(rows("spot").includes("light.angle"));
    assert.ok(!rows("point").includes("light.angle"));
    assert.ok(rows("area").includes("light.width"));
    assert.ok(!rows("area").includes("light.shadows"));
    assert.ok(rows("dome").includes("light.ground"));
    assert.ok(!rows("spot").includes("light.fixture.emissive"));
    assert.ok(worldFields(makeLightItem("l")).map((f) => f.path).includes("light.fixture.emissive"));
});

test("the studio lights step aside for the scene's own", () => {
    const scene = { items: [] };
    assert.equal(studioLightsOn(scene), true);
    assert.equal(studioLightsOn(scene, true), false);
    scene.items.push(makeLightItem("l", "spot"));
    assert.equal(studioLightsOn(scene), false);
    scene.items[0].visible = false;
    assert.equal(studioLightsOn(scene), true);
    scene.defaultLights = "off";
    assert.equal(studioLightsOn(scene), false);
    scene.defaultLights = "on";
    scene.items[0].visible = true;
    assert.equal(studioLightsOn(scene, true), true);
});

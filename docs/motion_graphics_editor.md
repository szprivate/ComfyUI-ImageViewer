# Editable motion graphics ("level 2")

The agent writes motion graphics as a **scene description** (data, `*.mgscene.json`), not as React.
One generic Remotion composition renders any scene; the viewer edits the same file in a layer /
timeline / keyframe editor. User and agent edit one file, and the preview is the render.

## What exists today (investigated)

- **Remotion in agentY**: only a skill (`agentY/skills/orchestrator-skills/remotion`) that drives the
  third-party `remotion-mcp` server (`init_remotion_project`, `update_composition`, `render_video`).
  The agent writes *free React* per video into `D:\AI\agentY\output\remotion\<project>` (each has its own
  `node_modules`, ~hundreds of MB). Nothing is editable afterwards except by editing code. The promo
  (`agentY-promo/video`, Remotion 4.0.532, React 19) is hand code: `PlayUI`, `NodeTag`, `Tech`, `Themes*`
  - all `useCurrentFrame()` + `interpolate`. Renders run `npx remotion render <entry> <id> out.mp4`.
  `run_script` has no node, so a core tool must spawn node itself.
- **Viewer**: ES-module mixins on one `<bepic-viewer-panel>` custom element (`js/bEpicViewer.js`),
  docked panels declared in `DOCK_PANELS` (`mixinDock.js`), opened from the bar groups
  (`barGroups.js`). Previz scene = pure data + pure functions (`scene3d.js`: tracks of `{f,v,ease,ti,to}`,
  Hermite segments), edited by the Outliner / Channel Box / **Curve Editor** (`previzCurves.js`, built from
  `curveUI.js` + `eulerFilter.js`). Files: `/bepic/text` reads, `/bepic/scene_save`-style routes write;
  `/bepic/push` (agent tool `show_in_viewer`) opens things; heavy work goes to the agentY host through
  a relay (`atlas_render.py` -> `/agent/host_info` -> `/agentY/...`). Tests: `node --test tests/*.mjs`,
  pytest for the Python side, `tests/harness*` standalone pages for UI.

## Decisions

1. **Format**: JSON, `"mgscene": 1`, after AE/Lottie concepts. Flat layers (like previz items): static
   values on the layer, animated ones in `tracks: {prop: [{f, v, ease, ti?, to?}]}`; `f` = comp frame.
   Layer types `text`, `shape` (rect / ellipse / path), `image`, `video`, `group` (a null / parent),
   `component` (reserved: a named code component, e.g. the promo's NodeTag, with `params`).
   Props: anchor, position, scale (%), rotation, opacity (%), fill, stroke, strokeWidth, size, radius,
   fontSize, tracking, `reveal` (wipe 0..1, `revealDir`), `trimStart/trimEnd` (stroke draw-on), `blend`,
   `in`/`out`, `parent`. Painter's order (first = bottom; the editor lists top first). Parenting passes
   the transform, not opacity (AE). Keys use the **previz key model** (`ease` + optional Hermite
   tangents `ti/to`), so the existing curve-editor parts and Euler/tangent math apply; extra ease names
   (`easeIn/Out/InOut`, `backOut`, `expoOut`, `[x1,y1,x2,y2]` css bezier) are sugar for the same thing.
   Lottie export is possible later: every concept maps (transform, keyframes with bezier, trim paths, masks as clip).
2. **One shared module** `mgscene.js` (no deps, no DOM): validation, interpolation, matrices, and
   `layerSvg()` - the SVG markup of a layer at a frame. The renderer injects exactly that string, the viewer
   preview injects exactly that string, in Chromium both: preview == render. Canonical copy in
   **agenty_core** (`motion_graphics/renderer/src/mgscene.js`); the viewer carries a byte-identical copy
   (`js/bEpicViewer_mgScene.js`, a test compares them when the sibling checkout exists). Both run the
   same golden vectors (`renderer/test/golden.json`) and a Python validator (`schema.py`) is checked
   against the same case list as the JS one. Video / component layers are HTML boxes placed with the same
   matrix (`htmlLayerStyle`): `OffthreadVideo` in the render, `<video>` in the preview.
3. **Renderer lives in agenty_core** (`agenty_core/motion_graphics/renderer`): the tool layer is
   what runs the render for both agentY and agentY-mcp, and it is a pip-installed package; the viewer
   (a ComfyUI custom node) never needs node. `render.mjs` uses `@remotion/bundler` + `@remotion/renderer`
   programmatically (progress callbacks, `publicDir` for local assets). Composition size / fps / duration
   come from the scene via `calculateMetadata`. **node_modules**: not committed; `ensure_installed()` runs
   `npm ci` once (needs Node >= 18 on PATH; Remotion fetches its headless Chrome on the first render) into the
   package folder, or into `~/.agenty/mg_renderer` when that is read-only. Override: `AGENTY_MG_HOME`.
4. **Agent side** (agenty_core tools, wired into agentY via `_SHARED_CORE_TOOLS` + a tool pack, and into
   agentY-mcp automatically): `mg_scene_validate(path)`, `mg_render(scene_path, out_path?, ...)`,
   `mg_scene_preview_frame(path, frame)` (a PNG to look at). Skill `motion-graphics-scene`: WRITE the scene
   JSON, validate, look at a still, open it in the viewer (`show_in_viewer` -> the Motion panel), render
   on request.
5. **Viewer editor** = a docked panel "Motion" (`bEpicViewer_mgEditor.js`): preview stage (SVG from
   `layerSvg`, zoom to fit, safe margins), layer list (select / hide / lock / reorder / rename / add),
   timeline (playhead, play, per-layer rows with key diamonds - click, drag, shift-multi, copy/paste, delete),
   properties (numbers and colours at the playhead; editing an animated property sets a key, the stopwatch
   toggles animation), **curve editor** for the selected property (the previz curve panel parts: value over
   time, tangent handles, ease presets), on-canvas gizmo (move / scale / rotate / anchor of the selected
   layer; writes a key when the property is animated or auto-key is on). Edits are pure functions on the
   scene (`bEpicViewer_mgModel.js`, node-tested) with an undo stack; Save writes the same file
   (`POST /bepic/mgscene_save`, allowed folders only). **Render** relays to the agentY host (like Atlas render)
   which runs `mg_render`.

   **Poster PNG**: every video `mg_render` writes also gets a `<name>.png` beside it, a still of the scene (its
   `comp.poster` frame, else the middle) that carries the whole scene in an iTXt chunk `mgscene` and the source
   scene file's absolute path in a tEXt chunk `mgscene_path` (like ComfyUI's workflow PNGs), so the video stays
   editable when only the PNG travels. `GET /bepic/mgscene?path=<file>.png` reads the chunk (up to IDAT, no image
   decoding) and answers `{path, scene}`: the source scene file when it still exists, is in an allowed folder and
   holds the same scene (Save then writes the real file), otherwise the embedded scene as
   `<png folder>/<png stem>.mgscene.json` (Save creates it there; assets are relative to the scene file, so they
   resolve when the PNG sits next to them). GET never writes; `&probe=1` only answers `{has_scene}`. In the UI: a
   PNG still opens as an image on double-click; right-click it in the file browser and choose **Edit in Motion**
   (offered only when the PNG carries a scene), or drag a PNG from the browser onto the Motion panel.
6. **Phases**: (1) schema + shared module + validator + tests; (2) renderer + `mg_render` + real render;
   (3) editor; (4) skill + wiring + examples. Left for later: precomps, masks beyond reveal, text animators
   (per-character), motion paths with auto-orient, Lottie export, audio, per-component previews.

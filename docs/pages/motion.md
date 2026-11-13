# Motion

[Home](../index.md)

Edits motion graphics scenes (`*.mgscene.json`) written by an agent: text, shapes, images and video layers with keyframes. Preview and render use the same drawing code, so the preview matches the final video.

## Opening

- **Open Motion…** in the lower bar's Motion menu: the open scene, otherwise the last one.
- Double-click a `*.mgscene.json` in the file browser, or have agentY open it.
- A rendered video's poster `.png` contains its scene: right-click it in the file browser ▸ **Edit in Motion**.

## Editing

- **Preview**: drag the handles to move, scale and rotate a layer or to move its anchor point.
- **Timeline** panel: the layer list on the left (select, visibility, lock, rename by double-click, drag to reorder; **+** adds text, rectangle, ellipse or group) and the keyframes per row (click, drag, copy, paste, delete).
- **Properties** panel: the selected layer's values at the playhead. Changing an animated value sets a key; the stopwatch toggles animation. The curve below shapes the selected key's easing.
- The viewer transport plays the scene; the fps field and the last frame number set the scene's frame rate and length.

## Saving and rendering

**Save** writes the scene file. **Render** has agentY render the saved scene to a video with a poster `.png` next to it.

File format and renderer: [dev/motion-graphics-design.md](dev/motion-graphics-design.md).

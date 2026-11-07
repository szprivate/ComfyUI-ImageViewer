# Motion

[Home](index.md)

Motion edits motion graphics an agent wrote as a scene file (`*.mgscene.json`): text, shapes, pictures and videos with keyframes. What you see is what renders, because the preview and the render draw the same way.

## Opening

- **Open Motion…** in the lower bar's Motion menu: the open scene, else the last one.
- Double-click a `*.mgscene.json` in the file browser, or let agentY show it.
- A rendered video's poster `.png` carries its scene: right-click it in the file browser ▸ **Edit in Motion**.

## Working

- **The preview** fills the canvas. Drag the handles to move, scale, rotate, or move the anchor.
- **Timeline** (a panel): its left column is the layer list. Click to select, eye and lock per row, double-click to rename, drag to reorder. **+** adds text, a rectangle, an ellipse or a group. The rows carry the keys: click, drag, copy, paste, delete.
- **Properties** (a panel): the selected layer's values at the playhead. Changing an animated value sets a key; the stopwatch turns animation on and off. The curve under it shapes the selected key.
- The viewer's own transport plays the scene. The fps box and the last frame number edit the scene's rate and length.

## Saving and rendering

**Save** writes the scene file. **Render** has agentY render the saved scene to a video, with a poster `.png` beside it.

How the format and renderer work: [dev/motion-graphics-design.md](dev/motion-graphics-design.md).

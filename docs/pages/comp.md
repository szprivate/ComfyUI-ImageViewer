# Comp

[Home](../index.md)

A node-based compositor for stills, films and image sequences. It works in linear, premultiplied float, and every parameter can be keyed. A comp is a file (`*.comp.json`); its nodes are independent of the ComfyUI graph.

![A comp with a lens flare node selected, its parameters on the right and the node graph below](../images/comp.jpg)

## Opening

- **Open Comp…** or **New comp** in the lower bar's Comp menu. With a shot context on the canvas, a new comp is created in that shot's `comps` folder.
- Double-click a `*.comp.json` in the file browser.
- The bar above the picture has New, Open and Save; Save's menu holds Save as…, Render… and the script export.

## The node graph

The graph flows from top to bottom: inputs on the top edge of a node, the output at the bottom.

| Action | Input |
|---|---|
| Add a node | <kbd>Tab</kbd>, **Add** or right-click, then type to search |
| Connect / disconnect | Drag from an output to an input / drag an input away |
| Insert into a connection | Drop a free node onto the wire |
| Cut connections | Hold <kbd>Y</kbd> and drag across wires |
| Arrange in a row or column | Hold <kbd>A</kbd> and drag |
| View a node | <kbd>1</kbd>, or the eye on its right edge |
| Disable / delete / frame all | <kbd>D</kbd> / <kbd>Del</kbd> / <kbd>F</kbd> |
| Grid / snap | <kbd>G</kbd> / <kbd>S</kbd> |
| Add footage | Drop History thumbnails or file browser rows on the graph |

The selected nodes' parameters appear in the **Parameters** panel, one section per node, and their handles are drawn over the picture (transform jack, crop box, flare position). **Layers** and the **Curve Editor** sit behind the graph as tabs. The graph can also be shown in ComfyUI's bottom panel (**Comp** tab).

## Layers

The same graph as a stack of layers on a timeline: each Merge on the main pipe is a layer, its A input the layer's picture. A layer row has the visibility switch, the merge operation and the opacity on the left, and on the right a bar from the layer's first to its last frame. Outside its bar the Merge passes its B input unchanged. A Read's footage is drawn as a dashed band behind the bar.

| Action | Input |
|---|---|
| Slide a layer (footage and keys move with it) | Drag the middle of its bar |
| Trim the start / end | Drag an end of the bar (snaps to the playhead, <kbd>Shift</kbd> to place freely) |
| Trim the start / end to the playhead | <kbd>[</kbd> / <kbd>]</kbd> |
| Show the animated parameters | The arrow left of the layer: one row per keyed parameter of the Merge and its A branch |
| Select keys | Click; <kbd>Shift</kbd> toggles, <kbd>Ctrl</kbd> removes, <kbd>Ctrl</kbd>+<kbd>Shift</kbd> adds; drag a box on empty lanes; <kbd>Ctrl</kbd>+<kbd>A</kbd> |
| Move keys | Drag them, or <kbd>,</kbd> / <kbd>.</kbd> (<kbd>Shift</kbd>: 10 frames) |
| Delete keys / interpolation | <kbd>Del</kbd> / right-click a key |
| Move time | Click or drag in the ruler, or click an empty lane |
| Zoom | <kbd>Ctrl</kbd>+wheel, or − / + / Fit in the bar |

A layer's frames are the Merge's `in` and `out` in the file (`out` is the first frame without the layer); the script export turns them into an expression on the Merge's disable.

## Nodes

| Category | Nodes |
|---|---|
| Input / output | Read, Constant, Roto (drawn with the viewer's Roto tool), Output |
| Merging | Merge (over, plus, multiply, screen, in, out, atop, mask, stencil …), Copy, ChannelMerge, ChannelMath |
| Geometry | Transform, Reformat, Crop |
| Colour | Grade, ColorCorrect (per-range HSL / RGB, hue wheels, two secondaries), OCIOColorSpace, OCIODisplay |
| Keying | Keyer, LumaKeyer, ChromaKeyer, Erode/Dilate, Premult, Unpremult |
| Filter and light | Blur, MotionBlur, DepthBlur, Defocus, Glow, LensFlare, Laplacian |
| Time | Retime, Vectors (optical flow) |
| Channels | Shuffle, AddChannels, Remove |

Each image keeps its own resolution; images of different sizes are aligned at the bottom-left corner. Extra channels (`depth.z`, `mask.a` …) travel down the graph with the image.

## Colour

The working space is the scene-linear role of the OCIO config. The display menu in the bar views the image through any display / view of the config; the viewer's exposure and channel controls also sit in the bar and only affect the display.

## Output

- **Render…**: every still format of the Send To Image Viewer node (PNG, EXR, TIFF …) or an MP4 / MOV / WebM film, rendered at full resolution on the server. The result is versioned, added to the History and placed on the canvas as a loader node.
- **Script export** (Save menu): writes an `.nk` script. Nodes with a direct equivalent are translated; the rest are rendered to EXR sequences next to the script and read back in.

All nodes are written from published formulas and observed behaviour; no third-party code or assets are used.

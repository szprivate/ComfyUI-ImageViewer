# Comp

[Home](../index.md)

A node-based compositor for stills, films and image sequences. It works in linear, premultiplied float, and every parameter can be keyed. A comp is a file (`*.comp.json`); its nodes are independent of the ComfyUI graph.

![A comp with a lens flare node selected, its parameters on the right and the node graph below](../images/comp.jpg)

## Opening

- **Open Comp…** or **New comp** in the lower bar's Comp menu. With a shot context on the canvas, a new comp is created in that shot's `comps` folder.
- Double-click a `*.comp.json` in the file browser.
- The bar above the picture has New, Open and Save; Save's menu holds Save as…, the renders, the farm, the script export, and Relink / Localise footage.
- Unsaved changes are kept aside every 30 seconds. If the viewer closes before you save (a crash, a closed tab), opening the comp again offers them back.

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
| Input / output | Read, Constant, Roto (drawn with the viewer's Roto tool), Paint, Write, Metadata, Output |
| Merging | Merge (over, plus, multiply, screen, in, out, atop, mask, stencil …), Copy, ChannelMerge, ChannelMath |
| Geometry | Transform, Reformat, Crop |
| Colour | Grade, ColorCorrect (per-range HSL / RGB, hue wheels, two secondaries), OCIOColorSpace, OCIODisplay |
| Keying | Keyer, LumaKeyer, ChromaKeyer, Erode/Dilate, Premult, Unpremult |
| Filter and light | Blur, MotionBlur, DepthBlur, Defocus, Glow, LensFlare, Laplacian |
| Time | Retime, Vectors (optical flow) |
| Channels | Shuffle, AddChannels, Remove |

Most colour, filter, keying and channel nodes have a **mask** input (the last one) and a **mix**. Mix 0 passes the input through unchanged; with a mask connected, the node acts only where the chosen mask channel (alpha by default, or any extra channel such as `mask.a`) is above 0, and **invert mask** flips that. The mask's channel and invert rows appear once something is plugged into the mask input. A mask of another size is aligned at the bottom-left corner, like any other image.

## Footage

- A Read takes stills, films, image sequences (`shot.####.exr`, `shot.%04d.exr`) and other comps (`*.comp.json`): a comp read this way is rendered as it stands, so a precomp updates whenever it is saved.
- A sequence with holes in it is fine. The Read's **Missing frames** setting picks what a hole shows: black, the nearest frame before it, or an error that stops the render.
- **Show metadata** on a Read, Write or Metadata node lists what the image carries at the current frame: the file's own header (EXR attributes, film tags), timecode, and anything set further up. A **Metadata** node sets keys (`key = value`, `[frame]` is the frame number) or removes them (`exr/*` patterns work).
- **Relink footage…** looks for missing files by name under a folder you pick (a sequence by its name around the frame number) and points the Reads at them, as one undo step.
- **Localise footage…** copies the footage of the Reads into a local cache and uses the copies from then on; the Read keeps its original path, and a copy is refreshed when the original changes.

Each image keeps its own resolution; images of different sizes are aligned at the bottom-left corner. Extra channels (`depth.z`, `mask.a` …) travel down the graph with the image.

## Working speed

Every node's result is kept in memory while you work (up to about 640 MB). Changing a node remakes only what lies downstream of it, and a frame you have already seen comes back at once. Each image also knows the box its visible pixels lie in, so a small element, roto shape or blurred patch over a large plate is only worked out inside that box (about eight times faster for a small blurred element over a 1080p plate). When nothing else is happening, the next frames of the picture on screen are rendered ahead. Frames that are ready are marked on the timeline, so playback over them runs at speed. The proxy menu in the bar sets the working resolution; the render is always full size.

## Paint

The Paint node lays strokes on the picture that comes into it. Select it and its section in **Parameters** holds the tools, the brush and the list of strokes; drag on the picture to paint.

| Tool | What a stroke does |
|---|---|
| Brush | Paints a colour |
| Clone | Copies the picture from another place: <kbd>Alt</kbd>+click sets where from, the offset is kept for the next strokes. *From frame* copies from another frame (-1: the one before) |
| Reveal | Paints the node's second input (**reveal**) through, with the same offset and frame settings |
| Eraser | Removes colour and alpha |
| Select | Click a stroke to edit it; <kbd>Del</kbd> deletes it |

Each stroke has its own size, hardness, opacity and spacing, and lives on **all frames**, **this frame**, **from here on**, **up to here** or a range of frames. A stroke can **follow** a Transform node: it moves with that node's animation, counted from the frame it was painted on. <kbd>[</kbd> and <kbd>]</kbd> change the brush size. Strokes are stored in the comp and rendered on the server like every other node.

## Viewer tools

The **Viewer** menu in the bar holds the tools for looking at the picture. None of them changes the comp or the render.

| Tool | Use |
|---|---|
| Compare | Select a node and press <kbd>2</kbd> to make it **B** (tagged in the graph). The picture shows A (the viewed node) against B as a **wipe** (drag the handle; <kbd>Shift</kbd>+drag turns the line, double-click centres it), their **difference** or a 50 % **mix**. <kbd>W</kbd> on the picture turns the wipe on and off |
| Pixel sampler | <kbd>I</kbd>. Shows the values under the pointer in the working space (premultiplied and straight) and as displayed; <kbd>Shift</kbd>+drag a box for its mean, minimum and maximum |
| Scopes | Histogram, waveform (click it to switch between luma and RGB) and vectorscope, read from the picture as displayed |
| Out-of-range colours | Stripes over values above 1 (red) and below 0 (blue), yellow for an alpha outside 0–1; the info line counts the pixels |
| Guides | The format's box (anything outside it is overscan), action safe (93 %) and title safe (90 %), and the centre |

The sampler and the scopes read the preview at its proxy size.

## Colour

The working space is the scene-linear role of the OCIO config. The display menu in the bar views the image through any display / view of the config; the viewer's exposure and channel controls also sit in the bar and only affect the display.

## Output

- **Render…**: every still format of the Send To Image Viewer node (PNG, EXR, TIFF …) or an MP4 / MOV / WebM film, rendered at full resolution on the server. The result is versioned, added to the History and placed on the canvas as a loader node.
- **Write nodes** write files from anywhere in the graph, each with its own path, format and frame range. A path may hold `####` (the frame number at the node's padding), `{comp}`, `{name}` and `{version}`; a relative path lies beside the comp, and an empty one gives `<comp>_<name>/<name>.####.exr` there. EXR is written as half or full float with ZIP, ZIPS or no compression; **Channels: all** puts every extra channel into the same file as its own layer. Handles add frames on each side of the range, and the file numbers follow the comp frames (comp frame 0 is the first number, 1001 by default). Timecode and the image's metadata go into the EXR header. **Render Write nodes…** renders the ticked ones in one pass.
- **Send to the farm…** sends the Write nodes to the render farm (Deadline) through agentY, as one job split into chunks of frames; the dialog warns about any comp, footage or output path that only this machine can see.
- **Script export** (Save menu): writes an `.nk` script. Nodes with a direct equivalent are translated; the rest are rendered to EXR sequences next to the script and read back in.

## Scripting

Comps can be built and rendered without the viewer:

- `python scripts/comp_render.py shot.comp.json` renders every Write node; `--writes`, `--first`, `--last`, `--handles`, `--frames 1001-1010 --frame-offset 1001` (one farm chunk) and `--output out/shot.####.exr` (the Output node) narrow it, and `--list` prints what would be written. Use ComfyUI's Python; nothing of ComfyUI itself is loaded.
- `src/comp_api.py` is the Python API behind it: `Comp.open` / `Comp.new`, `add`, `connect`, `set`, `key`, `remove`, `apply(ops)` (a list of edits, all or nothing), `save`, `render`, `render_output`.
- agentY has the same edits as tools (create, read, edit, render, send to the farm); an open comp tab takes the agent's changes in at once.

All nodes are written from published formulas and observed behaviour; no third-party code or assets are used.

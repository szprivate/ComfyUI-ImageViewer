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
| Input / output | Read, Constant, Roto (drawn with the viewer's Roto tool), Paint, Output |
| Merging | Merge (over, plus, multiply, screen, in, out, atop, mask, stencil …), Copy, ChannelMerge, ChannelMath |
| Geometry | Transform, Reformat, Crop |
| Warping | CornerPin, STMap, VectorWarp, GridWarp, LensDistortion |
| Tracking | Tracker (1–4 points), PlanarTracker |
| Colour | Grade, ColorCorrect (per-range HSL / RGB, hue wheels, two secondaries), CDL, LUT, HueCurves, Clamp, Log/Lin, ColorMatch, OCIOColorSpace, OCIODisplay |
| Keying | Keyer, LumaKeyer, ChromaKeyer, DifferenceKeyer, Despill, CoreEdge, EdgeExtend, LightWrap, Erode/Dilate, Premult, Unpremult |
| Filter and light | Blur, MotionBlur, DepthBlur, Defocus, Glow, LensFlare, Laplacian, Grain, Denoise, Sharpen, Median, EdgeDetect, EdgeBlur |
| Time | Retime (nearest, mix or vector blend), Vectors (optical flow), FrameHold, FrameRange, TimeOffset, AppendClip, TimeBlur |
| Channels | Shuffle, AddChannels, Remove |
| AI | AI Matte, AI Depth, AI Relight, AI Inpaint, AI Upscale |

Most colour, filter, keying and channel nodes have a **mask** input (the last one) and a **mix**. Mix 0 passes the input through unchanged; with a mask connected, the node acts only where the chosen mask channel (alpha by default, or any extra channel such as `mask.a`) is above 0, and **invert mask** flips that. The mask's channel and invert rows appear once something is plugged into the mask input. A mask of another size is aligned at the bottom-left corner, like any other image.

Each image keeps its own resolution; images of different sizes are aligned at the bottom-left corner. Extra channels (`depth.z`, `mask.a` …) travel down the graph with the image.

A few notes on the newer nodes:

- **DifferenceKeyer** keys against a clean plate on its second input. **Despill** pulls the screen colour back and can put a replacement colour in its place. **CoreEdge** splits a matte into a solid core and a soft edge; **EdgeExtend** pushes the colours inside a matte outwards so a soft edge has the right colour under it; **LightWrap** lets the background bleed over the foreground's edge.
- **Grain** is seeded per frame. With a plate on its second input it measures how strong that plate's grain is and scales its own to match. **Denoise** is an edge-preserving guided filter.
- **TimeBlur** averages frames across a shutter; **AppendClip** plays one input after the other with an optional dissolve. Retime's **vectors** blend warps the two frames on either side along their optical flow.
- **CDL** applies slope, offset, power and saturation, forwards or inverse. Its Parameters section reads a `.cc`, `.cdl` or `.ccc` (the first correction) and writes one next to the comp. **LUT** reads a `.cube` file directly; with OpenColorIO on the server it also reads `.3dl`, `.spi3d`, `.csp`, `.clf` and the other formats OCIO knows. **Log/Lin** converts between scene-linear and Cineon, LogC3, S-Log3 or ACEScct.

### AI nodes

AI nodes send the image coming into them through a ComfyUI workflow and keep the answer. They use the same workflows as Paint's Generate, so the workflow picked there for background removal, image edit, fill / remove or upscale is the one that runs (Matte uses background removal, Depth and Relight an image edit with words, Inpaint fill or remove inside the alpha of its mask input, Upscale the upscalers).

Nothing runs by itself. In the node's Parameters section, **This frame** runs it on the frame at the playhead and **All frames** on every frame, one after the other. Each answer is saved next to the comp as `<comp>_ai/<node>/<node>_<kind>.<frame>_<run>.png` and stored in the node, so it travels with the comp (one undo step per frame). A frame without its own result shows the nearest earlier one; before the first run the node passes its input through. When the input or the prompt changes afterwards, Parameters marks the results as out of date; they stay until they are run again. **Forget** removes them from the node and leaves the files.

## Working speed

Every node's result is kept in memory while you work (up to about 640 MB). Changing a node remakes only what lies downstream of it, and a frame you have already seen comes back at once. Each image also knows the box its visible pixels lie in, so a small element, roto shape or blurred patch over a large plate is only worked out inside that box (about eight times faster for a small blurred element over a 1080p plate). When nothing else is happening, the next frames of the picture on screen are rendered ahead. Frames that are ready are marked on the timeline, so playback over them runs at speed. The proxy menu in the bar sets the working resolution; the render is always full size.

The **GPU** button in the bar (on by default) works the per-pixel nodes on the graphics card: Constant, Merge, Grade, Premult, Unpremult, Transform, Reformat, Crop, Blur, and the mask and mix of any node. Other nodes and footage are still prepared on the CPU and passed in. When you zoom in so that only part of the picture is on screen, only that part is worked out (the region of interest), and panning beyond it works out the new part. A comp that carries extra channels stays on the CPU. The info line under the picture shows which path made the frame.

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

## Tracking and warps

- **Tracker**: **+ Point**, then click the picture. Each point has a pattern box (what is followed) and a search box (how far it may move in a frame), sized in its panel; dragging a point on the picture keys it there at the current frame. The arrows in its panel track one frame or to the end, either way; tracking runs on the server at full resolution and the keys appear as they come. A point whose match falls below a threshold stops there. The node itself can stabilise or match-move (translate, rotate, scale or perspective, from the points it has), or hand that over to a new node: **Make** builds a keyed Transform or CornerPin beside it.
- **PlanarTracker**: **Place surface**, drag its four corners onto a flat surface, then track. The corners follow the surface as a whole, so it keeps going when parts of it are covered. **Make** gives a keyed CornerPin.
- **CornerPin**: drag the squares (where the corners go) and the rings (the points they come from). Corners count 1 bottom left, 2 bottom right, 3 top right, 4 top left.
- **STMap / VectorWarp**: move the picture by a map from a second input: absolute UV coordinates (0–1, bottom left origin) or pixel offsets.
- **GridWarp**: a source and a destination grid; drag the destination points, Shift+drag the source points. The warp is smooth between them.
- **LensDistortion**: undistort or redistort with k1 / k2 about a centre, or output the matching ST map. **Draw lines** along things that are straight in the world (double-click ends a line), then **Solve** finds the coefficients.

## Colour

The working space is the scene-linear role of the OCIO config. The display menu in the bar views the image through any display / view of the config; the viewer's exposure and channel controls also sit in the bar and only affect the display.

## Output

- **Render…**: every still format of the Send To Image Viewer node (PNG, EXR, TIFF …) or an MP4 / MOV / WebM film, rendered at full resolution on the server. The result is versioned, added to the History and placed on the canvas as a loader node.
- **Script export** (Save menu): writes an `.nk` script. Nodes with a direct equivalent are translated; the rest are rendered to EXR sequences next to the script and read back in.

All nodes are written from published formulas and observed behaviour; no third-party code or assets are used.

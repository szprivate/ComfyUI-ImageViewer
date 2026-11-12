# Comp

[Home](../index.md)

Layers pictures, films and image sequences in a node graph, as Nuke does, in linear float with keys over time. A comp is a file (`*.comp.json`); its nodes never go onto ComfyUI's canvas.

![A comp: the picture with its handles, the node's Parameters, the Node Graph below](../images/comp.png)

## Opening

- **Open Comp…** / **New comp** in the lower bar's Comp menu. A new comp goes into the shot's `comps` folder when the canvas names a shot.
- Double-click a `*.comp.json` in the file browser.
- The picture's bar has New, Open and Save (its menu: Save as…, Render…, Export to Nuke…).

## The node graph

Runs top to bottom: inputs on a node's top edge, its output at the bottom.

| To | Do |
|---|---|
| Add a node | <kbd>Tab</kbd>, **Add**, or right-click; type to find it |
| Connect / disconnect | Drag from an output to an input / drag an input away |
| Put a node into a wire | Drop it on the wire |
| Cut wires | Hold <kbd>Y</kbd> and drag across them |
| Lay nodes out in a row or column | Hold <kbd>A</kbd> and drag |
| View a node | <kbd>1</kbd>, or the eye on its right edge |
| Switch off / delete / frame all | <kbd>D</kbd> / <kbd>Del</kbd> / <kbd>F</kbd> |
| Grid and snap | <kbd>G</kbd> / <kbd>S</kbd> |
| Read footage | Drop History thumbnails or file browser rows on the graph |

The selected nodes' settings are in the **Parameters** panel, one panel per node. Their handles are on the picture (a Transform's jack, a Crop's box, a flare's light). The **Curve Editor** is a tab behind the graph; **Layers** shows the graph as a stack. The graph can also sit in ComfyUI's bottom panel (its **Comp** tab).

## Nodes

| Kind | Nodes |
|---|---|
| In and out | Read, Constant, Roto (drawn with the viewer's Roto tool), Output |
| Layering | Merge (Nuke's operations), Copy, ChannelMerge, ChannelMath |
| Shape | Transform, Reformat, Crop |
| Colour | Grade, ColorCorrect (Color Finesse-style: ranges, wheels, secondaries), OCIOColorSpace, OCIODisplay |
| Keying | Keyer, LumaKeyer, ChromaKeyer, Erode/Dilate, Premult, Unpremult |
| Blur and light | Blur, MotionBlur, DepthBlur, Defocus, Glow, LensFlare, Laplacian |
| Time | Retime, Vectors (optical flow) |
| Channels | Shuffle, AddChannels, Remove |

Every picture has its own size; pictures of other sizes meet at the bottom left. Extra channels (`depth.z`, `mask.a`) flow down the graph with the picture.

## Colour

The working space is the OCIO config's scene-linear space. The bar's display menu shows the picture through a display and view; the viewer's exposure and channel controls sit in the bar and change only what is shown.

## Rendering and Nuke

- **Render…**: every still format of the Send To Image Viewer node (PNG, EXR, TIFF …) or an MP4 / MOV / WebM film, at full size on the server. The result is versioned, joins the History and lands on the canvas as a loader node.
- **Export to Nuke…**: a `.nk` script; nodes Nuke has become that node, the rest are baked to EXR sequences beside it.

Every node is written from published maths and how compositing tools behave; no code or assets come from other programs.

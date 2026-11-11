# Comp

[Home](index.md)

Comp layers pictures, films and image sequences in a node graph, the way Nuke does: Merge, Transform, Grade and Blur, keyed over time, in linear float. A comp is a file (`*.comp.json`). It has nothing to do with ComfyUI's workflow: its nodes live in the comp, never on the canvas, and Run does not touch them.

![A comp: the picture, its Properties and Layers, and the Node Graph under it](images/comp.png)

## Opening

- The picture's bar starts with **New**, **Open** and **Save**, as Paint's: Save opens a menu with Save (Ctrl+S), **Save as…** (Ctrl+Shift+S: a name and a folder; the tab goes on with the new file), Render…, Export to Nuke…, Open… (Ctrl+O) and New comp.
- **Open Comp…** in the lower bar's Comp menu: the open comp, else the last one, else a tab that offers **New comp** and **Open…**.
- **New comp** in the same menu: a new file in your shot's `comps` folder when the canvas names a sequence and shot, else in `output/imageviewer/comps/`. It starts as a black background going into an Output.
- Double-click a `*.comp.json` in the file browser, or let agentY show it.

## The node graph

The **Node Graph** panel is up when a comp opens. The picture runs from top to bottom: a node's inputs are on its top edge, its output at the bottom.

- The **Curve Editor** sits as a tab behind the Node Graph (or the Comp menu's *Curve Editor*). It lists every animated parameter of the selected nodes (a position or a colour as one curve per axis); click a name to show it alone, Shift / Ctrl+click to add or remove one. Drag a key to change its frame and value (Shift keeps the value), drag a tangent handle to shape the curve (Alt breaks the pair, a double-click on a handle makes it automatic again), double-click a key to delete it, double-click the graph to go to that frame. Each drag is one undo step.
- Drag a node that is not connected yet onto a **wire**: the wire lights up, and letting go puts the node into it.
- The graph has a **grid** (its button, or G) and nodes **snap** to it (the magnet, or S; hold Shift while dragging to place one freely). **Align** lines the selected nodes up in a column or a row, by their edges, or spreads three or more out evenly; with nothing selected, *Snap every node to the grid* tidies the whole graph. Each is one undo step.
- **Tab**, the **Add** button and a right-click on the graph open the node menu. Type to find a node by its name, its category or its id; the arrow keys and Enter pick one, and the list scrolls. With a node selected, a node from Tab or Add goes in under it; from a right-click on an empty spot it lands where you clicked. A right-click on a node puts that node's actions (view, disable, rename, delete) at the top of the same menu.
- **Hold A and drag** over the graph to lay the selected nodes out: a drag across puts them in one row, a drag down in one column, in the order you picked them (click one, then Ctrl / Shift+click the rest; nodes picked together by one box keep their order on screen). They glide into place, and the row or column follows the drag while it lasts. One undo step.
- **Hold Y and drag** a stroke across wires: the wires it crosses light red and are cut when you let go. One undo step.
- Drag a node to move it. Drag on empty space to select several, or Alt-drag or middle-drag to pan. The wheel zooms.
- Drag from an output to an input to connect them. Drag a connected input away to take the wire off.
- **1**, or the eye at a node's right edge, shows that node in the picture: it gets a red outline and a VIEWER tag, and the eye again (or viewing the Output) goes back to the comp. **D** switches a node off, **Del** deletes it (what read it reads its first input instead), **F** frames the whole graph.
- Drop History thumbnails or file browser rows on the graph to make Read nodes. A frame of a numbered sequence brings the whole sequence (`shot.####.exr`).

| Node | What it does |
|---|---|
| Read | A picture, a film or a numbered sequence. *Offset* slides it in time; *Colourspace* auto treats EXR and HDR as linear, everything else as sRGB, or pick any colourspace of the OCIO config to have it converted into the working space; *Fit* lays a picture of another size into the comp |
| Constant | A colour over the whole frame |
| Roto | Shapes drawn on the picture with the viewer's Roto tool. Without an input it is a white matte, with one it cuts its input out. Each shape has a mode (union, plus, minus, intersection, xor), a feather and can be animated |
| Merge | Lays A over B (or plus, multiply, screen, in, out, atop, mask, stencil, and the rest of Nuke's operations), with a mix and an optional mask input |
| Copy | B with some of its channels taken from A (for example A's alpha) |
| Transform | Moves, rotates, scales and skews about a centre (a jack on the picture) |
| Reformat | Lays the picture into a box: a width x height, or the comp's size times *scale*. *Resize* fits it inside, fills the box, matches its width or height, distorts to it, or leaves the size alone; *flip*, *flop* and *turn* (90° anticlockwise) as well. The comp keeps one size (its format), so the box sits inside it, in the middle or at the bottom left; *black outside* clears the rest. To render at another size, change the comp's format |
| Crop | Keeps a box of the picture, with a soft edge if you like |
| Grade | Black and white point, lift, gain, multiply, offset, gamma, saturation, mix |
| ColorCorrect | A colour corrector laid out like After Effects' Color Finesse. **HSL** (hue, saturation, brightness, contrast about a centre) and **RGB** (gain, gamma, pedestal, for all channels and for R, G, B) for Master, Highlights, Midtones and Shadows. **Hue offsets** has a colour wheel per range: drag to push that range towards a colour, double-click to reset. **Luma ranges** sets where shadows end and highlights start, with the curves drawn. **Secondaries** A and B each correct one colour (picked with ⌖), qualified by hue, saturation and luma. *View* shows a range or a secondary's matte as grey |
| OCIOColorSpace | Converts from one colourspace of the OCIO config to another (empty: the working space) |
| OCIODisplay | Applies a display and view of the OCIO config (for a look baked into the picture) |
| Keyer | Chroma (a screen colour, picked from the picture with ⌖) or luma, with tolerance, softness and despill |
| LumaKeyer | A matte from brightness (luminance, the largest channel, or one channel): transparent below *low*, solid from *low* + *low soft*, and transparent again past *high*. *Clip black* / *clip white* firm it up; *output* matte shows it as grey |
| ChromaKeyer | A colour-difference key. Pick the screen with ⌖. *Screen gain* takes more as screen, *clip black* cleans the screen and *clip white* firms up the subject. *Despill* holds the screen's channel to the larger (or the mean) of the other two. *Output* gives the keyed picture, the matte, or despill only |
| Blur | A Gaussian blur, its size in pixels of the comp |
| MotionBlur | Blurs along the motion while the shutter is open. It takes motion vectors from a Vectors node in its second input, or works them out itself |
| DepthBlur | Blurs by the distance from the focus, read from a depth map in its second input (red, any channel, or luminance). *Filter* lens blurs through a disc, as Defocus does |
| Defocus | A lens out of focus: every pixel spread over the aperture, a disc or a polygon of 3 to 16 blades (*rotation*, *aspect* for an anamorphic lens). *Bloom* brightens what is above the *threshold* first, so highlights become bright bokeh |
| Erode/Dilate | Shrinks (size below 0) or grows (above 0) the picture's light parts, by a box or a disc; *channels* alpha works on the matte alone. Fractional sizes are smooth |
| Laplacian | *laplacian*: the edges, the picture less its neighbours, after a blur by *size* (a Laplacian of Gaussian). *highpass*: the picture less its blur. Then *gain* and *offset* (0.5 for the usual grey) |
| Shuffle | One layer (rgba, or an extra one) from any channel, 0, 1, or not written |
| AddChannels | Adds extra channels (see *Channels*) |
| Remove | Takes channels away, or keeps only the ones named |
| ChannelMerge | One channel of A with one of B (union, plus, minus, from, multiply, divide, in, out, stencil, max, min, absminus, xor) into B's alpha, a colour channel, rgb or rgba |
| ChannelMath | Arithmetic on the chosen channels: add, multiply, power, invert, clamp, min, max, abs, threshold, set |
| Glow | What is brighter than the *threshold* (reached over *softness*), tinted and blurred at *steps* sizes, each half the one before, then added to the picture. *Effect only* gives the glow alone |
| LensFlare | A flare from a light at *position*: a glow round it, rays (*streak_count*, as many as the aperture has blades), a halo split into its colours, bokeh ghosts along the line through the frame's middle (discs or polygons of *blades*, from the *seed*), and dust on the glass lit by the light: the *dirt* input's brightness, or spots from the seed. On the *src* input it is added to the picture; alone, its brightness is its alpha |
| Premult / Unpremult | Multiply the colour by the alpha, or divide it back |
| Retime | Plays its input faster, slower or backwards (*speed*, *start*, *offset*), the nearest frame or two mixed |
| Vectors | Motion vectors measured from the footage (optical flow): red and green where each pixel goes in the next frame, blue and alpha where it came from. *Detail* half (the default) measures on a picture half the size, which is much faster |
| Output | What the comp renders |

Vectors, MotionBlur, DepthBlur and Defocus take seconds a frame at full size. The picture keeps their results while you work further down the graph.

### Handles on the picture

The selected node's handles are drawn over the picture, as a compositor's viewer has them. Each drag is one undo step, and sets a key at the playhead when the value is animated.

- **Transform**: a jack where the picture's centre is. Drag the middle (or anywhere inside the ring) to move it; Shift keeps the move along one axis; Ctrl+drag moves only the centre it turns and scales about, and the picture stays where it is. Drag the ring to scale evenly, a square on it to scale one axis (Shift: evenly), the bar to the right to turn it (Shift: in 15° steps), the bar at the top sideways to skew it.
- **Crop**: a box. Drag an edge or a corner to move those sides, the inside to move the box.
- **LensFlare**: the light, dragged where it should be.

### Drawing a Roto shape

The Roto node is drawn with the viewer's own **Roto tool**, the same one the Roto node on the ComfyUI canvas uses. Select the Roto node: the tool comes up over the comp's picture and its options (the shapes list, modes, feather, blur, dilate, the global matte, Roto Curves) are in the node's Parameters. **+ Shape**, then click the points (drag to pull out a curve) and click the first one to close it. Everything else works as in the viewer: drag a vertex, Ctrl+drag pulls out its feather, Alt+click an edge inserts a point, right-click deletes one, a box around several points moves, scales and turns them; keys come from the key buttons beside the timeline. Middle-drag pans the picture, the wheel zooms it.

The shapes are kept in the comp as the viewer keeps them (coordinates as shares of the frame, sizes in comp pixels), and Ctrl+Z in the comp takes a change back. The picture shows the matte as the viewer's mask preview draws it; Render and Export to Nuke make it with the code the ComfyUI Roto node renders with (`roto_raster.py`), so the two agree.

## Properties

The selected node's values at the playhead. They work as in Motion: the stopwatch animates a value, and changing an animated value sets a key there. With several nodes selected each has a panel of its own, stacked as in Nuke's Properties bin: the one picked last on top, a click on a panel's title folds it, its × takes the node out of the selection, and a change goes to that node only. With nothing selected the panel holds the comp's size, frame rate and length.

## Channels

Beside red, green, blue and alpha a picture can carry any number of **extra channels**, named `layer.channel` (`mask.a`, `depth.z`, `motion.r`). They flow down the graph with the picture: Transform, Reformat, Crop and Blur move them with it, Retime takes them from the same frames, a Merge or Copy brings B's and A's, and every other node passes them on.

- **AddChannels** adds the channels it lists (a layer name adds its r g b a), filled with a value.
- **Remove** takes the channels it lists away, or with *keep* everything else. Red, green, blue and alpha cannot go: they turn black.
- **Shuffle** writes one layer (rgba, or an extra layer it makes) from any channel of what comes in, 0, 1, or `-` (not written).
- Every node that makes something (Constant, Roto, the keyers, Vectors, LensFlare) has a **channel** menu: *rgba* is its whole picture, as before; a single channel takes the node's channel of the same letter (any other name its alpha); a layer takes its r g b a. Everything else of what comes in passes. *New channel or layer…* types a new name.
- **Roto** has a **premult** switch too. On, what comes in is cut by the matte; off, its colour stays as it is and the matte only goes into the channel chosen (the alpha, for rgba).
- The bar's **layer** menu shows an extra layer in the picture (a layer of one channel as grey); the viewer's R G B A keys pick within it.

Extra channels are not written into renders or the Nuke script yet: a render writes the rgba, and a Shuffle or Constant that writes into extra channels is baked for Nuke.

## Layers

The **Layers** panel (Comp menu ▸ Layers) shows the same graph as a stack of layers. Each Merge on the main pipe is a layer, its A branch is the layer's picture, and what is at the top of the pipe is the background. Reorder, switch off, change the operation or the mix, or add footage or a solid on top: each one is a change to the graph, so the two views always agree. A branch with a Merge of its own shows as a group.

## The picture and time

The picture fills the canvas. **Proxy** draws it smaller while you work (it is always rendered full size), **A** shows the alpha, **Fit** fits it in the window. The viewer's own transport plays the comp; its fps box and last-frame number edit the comp's rate and length.

## In ComfyUI's bottom panel

ComfyUI's bottom panel (the strip under the canvas with the Terminal and the Logs) has a **Comp** tab. It shows the node graph of the comp the viewer is on, with play, step, the frame and a button that brings the viewer up. It is the same graph, moved there while the tab is open, so you can work on the comp beside your workflow. Drag the panel's edge up to give it room. **Show it here** in the viewer's Node Graph panel takes it back.

## Colour (OCIO)

Comp uses the same OpenColorIO config as the viewer: `$OCIO`, else OpenColorIO's built-in one. Its working space is the config's scene-linear space (ACEScg in the ACES configs). The bar's display menu shows the picture as plain sRGB, or through any display and view of the config; it is remembered. The viewer's own exposure bar sits in the Comp bar, after the display menu, and works as it does in the viewer: the slider in stops, a click on the bar or a right-click sets it back to 0, E held while dragging on the picture changes it, and the channel menu shows RGB, Red, Green, Blue or Alpha (R, G, B and A on the picture do the same, and again goes back to RGB). Both change only what is shown, never the comp or its render. If the display can't be made, the line under the picture says why. In the picture, OCIO transforms are drawn through a LUT made on the server (a matrix where the transform is one), so they are close but not exact. The render applies them exactly. Without OpenColorIO on the server, the OCIO nodes pass their picture through.

## Rendering

**Render…** (in Save's menu) opens the export dialog with the formats and options of the **Send to Viewer** node, written by the same code: every still format that node offers on this ComfyUI (PNG, EXR, TIFF, JPEG, DPX, TGA, HDR, BMP, WebP - DPX, TGA and HDR need OpenImageIO; without it EXR is still written, as plain half float) with the node's per-format rows (bit depth, compression, quality, compress level), or an MP4, MOV (ProRes or H.264) or WebM film with its quality and codec. Several frames are numbered as the node numbers a sequence: from its *first frame* (1001) at its *padding* (4). A float file (EXR, HDR, a float TIFF) holds the working space's linear values, premultiplied as compositors keep them; every other file is display values - plain sRGB or a display and view of the OCIO config (*Colour*) - with straight alpha, JPEG and BMP over black. All frames, the in-out range, or just this frame. It saves the comp first and renders it on the server at full size, by the same arithmetic as the preview. The result lands where every export goes (versioned, in the shot's folder when there is one), joins the History, and is put on the ComfyUI canvas as a loader node, ready to wire into a workflow. (Films are encoded in-process through PyAV by the export rule's settings, not through the node's imageio path, which would start an ffmpeg process.)

## Export to Nuke

**Export to Nuke…** (in Save's menu) writes the comp as a Nuke script (`.nk`), versioned like every export, with a README beside it. Nodes Nuke has a stock node for become that node: Read, Constant, Merge, Transform, Reformat, Crop, Grade, Blur, Shuffle, Copy, Premult, Unpremult, Retime (as TimeWarp), ChannelMath (as Expression), ChannelMerge, the OCIO nodes, Erode/Dilate and the Output (a Write of EXRs beside the script). Keyed values come along as a key on every frame. The rest (Glow, LensFlare, the keyers, Defocus, Vectors and so on) is **baked**: rendered here into an EXR sequence beside the script, and read back there by a Read in its place. Switch *Bake* off to get a NoOp in their place instead. The README names what is baked and what is close but not the same arithmetic (Nuke's filters are cubic, the comp's bilinear).

## Clean room

Every node is written here from published maths and from how compositing tools behave: Porter–Duff and the usual Merge and Grade formulas, Horn–Schunck optical flow, colour-difference keying, box and Gaussian filters. No code, shaders or assets come from Nuke, After Effects, Color Finesse, Keylight, any other program, or GPL sources.


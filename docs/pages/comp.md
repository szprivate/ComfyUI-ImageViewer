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

The selected nodes' parameters appear in the **Parameters** panel, one section per node, and their handles are drawn over the picture (transform jack, crop box, flare position). The **Curve Editor** sits behind the graph as a tab; **Layers** shows the same graph as a layer stack. The graph can also be shown in ComfyUI's bottom panel (**Comp** tab).

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
| 3D | Camera, Card, Geometry (cube, sphere, cylinder), Scene, Project, PointCloud, Render |
| Deep | DeepRead, DeepFromImage, DeepMerge, DeepHoldout, DeepCrop, DeepFlatten |
| Views | OneView, JoinViews, Anaglyph, SideBySide |

Each image keeps its own resolution; images of different sizes are aligned at the bottom-left corner. Extra channels (`depth.z`, `mask.a` …) travel down the graph with the image.

## 3D

A small scene renderer inside the comp: Y up, the camera looking down -Z, rotations in degrees applied X, then Y, then Z.

- **Card** puts an image on a plane (its height follows the image's aspect); **Geometry** wraps an image, or plain white, round a cube, sphere or cylinder. Both have translate, rotate, scale and a uniform scale.
- **Project** paints an image onto whatever it is attached to, from a Camera; *front* keeps it off faces turned away from that camera.
- **PointCloud** turns an image and its depth channel (`depth.z` by default, read as distance or 1 / distance) into points seen from a Camera.
- **Scene** gathers up to four of these; **Render** draws a Scene (or one piece) through a Camera over an optional background, with 1 to 4 samples per pixel each way. It writes `depth.z` too. Fed into a Deep node, it gives one sample per object per pixel.
- **Camera** has a focal length and a film back, near and far planes, and an interaxial and convergence for stereo. Its **import** row takes keys from a camera of a shot open in a 3D tab (place, turn and lens, one key a frame) or from a camera text file: `.chan`, one line a frame with `frame tx ty tz rx ry rz` and optionally the vertical field of view.

## Deep

A deep image holds any number of samples per pixel, each a premultiplied colour at a depth. **DeepRead** reads the first deep part of an OpenEXR file (R G B A Z ZBack; a missing A counts as 1). **DeepFromImage** makes one sample per pixel from a flat image and its depth channel, or at a set depth. **DeepMerge** combines up to four, **DeepHoldout** dims one by what another has in front of it, **DeepCrop** keeps the samples between two depths (or outside them), and **DeepFlatten**, or any flat node after a deep one, lays them front to back. A sample's back depth is kept but not used to split it.

## Views

The view menu in the bar turns a comp into a stereo pair (left, right) or any list of views; the picture shows the view picked there. Then:

- `%V` in a Read's file name stands for the view's name and `%v` for its first letter, so one Read reads a file per view.
- **Split** in a node's parameters gives it different settings in the view on show; **Join** takes them away.
- A Camera's eyes sit interaxial apart, with zero parallax at the convergence distance.
- **OneView** picks a view, **JoinViews** takes a different input per view, **Anaglyph** and **SideBySide** show two views in one image.
- **Render…** writes every view, each as its own versioned output named `<name>_<view>`.

## Colour

The working space is the scene-linear role of the OCIO config. The display menu in the bar views the image through any display / view of the config; the viewer's exposure and channel controls also sit in the bar and only affect the display.

## Output

- **Render…**: every still format of the Send To Image Viewer node (PNG, EXR, TIFF …) or an MP4 / MOV / WebM film, rendered at full resolution on the server. The result is versioned, added to the History and placed on the canvas as a loader node.
- **Script export** (Save menu): writes an `.nk` script. Nodes with a direct equivalent are translated; the rest are rendered to EXR sequences next to the script and read back in. Cameras, 3D pieces and deep nodes only appear as part of the image rendered from them.

All nodes are written from published formulas and observed behaviour; no third-party code or assets are used.

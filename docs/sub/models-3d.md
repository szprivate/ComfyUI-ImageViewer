# 3D Models

← [Back to index](../index.md)

---

The viewer shows 3D models in a tab of their own, the way ComfyUI's **Save 3D Model** / **Load 3D** nodes do: same lighting, grid, camera and material modes, and it follows ComfyUI's *Load 3D* settings for background colour, grid and light intensity.

Supported formats: **GLB**, **glTF**, **FBX**, **OBJ**, **STL**, **PLY** (meshes and point clouds) and **USD** (`.usd`, `.usda`, `.usdc`, `.usdz` — see [USD](#usd)).

## Getting a Model into the Viewer

| From | How |
|---|---|
| A 3D node's output | Wire a `MESH` or 3D-file output (`FILE_3D`, `FILE_3D_GLB`, `FILE_3D_FBX`, …) into **bEpic Send To Image Viewer** |
| Any node with a 3D output | Right-click it → **Send to Image Viewer (run branch)** |
| **Load 3D**, and other loaders naming a model file | Right-click → **Send to Image Viewer** |
| Disk | Open it from the [File Browser](other.md#file-browser) (🧊 rows), or drag it in from Explorer / Finder |

A mesh batch opens as one tab; the timeline steps through its models.

## Saving

Turn on **save_to_output** on the send node and the model is written the way **Save 3D Model** writes it:

- a `MESH` is saved as **GLB**, one file per batch item, with its UVs, colours, normals, textures and material;
- a 3D file keeps its own format, so an **FBX stays an FBX**. The viewer doesn't convert between formats; ComfyUI has no FBX writer.

Files are named `<filename_prefix>_00001_.glb` (use a prefix like `3d/ComfyUI` to land them in `output/3d`), carry the workflow in the GLB's metadata unless ComfyUI runs with `--disable-metadata`. Like the node's other saves, they aren't previewed on the node itself. `file_format` and `fps` don't apply to models.

With **save_to_output** off, the model is only previewed from ComfyUI's temp folder.

## In the Viewer

| Action | How |
|---|---|
| Tumble (orbit) | <kbd>Alt</kbd>+left-drag |
| Track (pan) | <kbd>Alt</kbd>+middle-drag, or right-drag |
| Dolly (zoom) | <kbd>Alt</kbd>+right-drag, or the mouse wheel |
| Frame the model again | **Reset view**, or <kbd>F</kbd> |
| Material | **Original**, **Clay**, **Normal** or **Wireframe** from the toolbar |
| Grid | **Grid** toggles it |
| Animation | FBX / glTF animations play on their own; the ▶ / ❚❚ button pauses them |
| Info | The shape overlay (toolbar button) shows vertex, triangle and point counts |

The first time a model is shown, the viewer keeps a snapshot of it as its history thumbnail. Until then the tile shows a cube.

Compare, contact sheet and the drawing tools don't apply to a model tab. Neither do [exposure and channel isolation](channels-exposure.md) — a render is not a photograph — so the exposure bar is hidden on a 3D tab and its keys are left to ComfyUI.

## Previz: Building a Scene

**Every 3D tab is a scene.** Opening one model gives you a scene holding that model — same outliner, same gizmo, same timeline — and a scene is also what you get from a *bEpic 3D Scene (Previz)* node or from a USD stage. There is no mode to turn on and nothing to switch back to: add a second model, a camera or a shape whenever the shot asks for one.

A model that carries its own animation (an FBX clip) is scrubbed by the timeline like everything else, and an untouched shot grows to fit the clip rather than cutting it short. Once you have keyed something, or typed a length yourself, the length is yours and stays put.

### The Panel

The previz panel is a docked panel like the file browser: it opens in a rail with the first 3D tab, and can be moved, stacked and resized like any other — see [Docking Panels](interface.md#docking-panels). Its **✕** puts it away, and it stays away until you ask for it again.

That is what the two icons in the 3D toolbar are for, and they are the only way back to either panel: the **cube** shows and hides the previz panel, the **curve graph** shows and hides the [Animation Curves](#the-curve-editor). They sit over the canvas they belong to — neither has anything to say about a picture, so neither clutters the playback bar. Both close with the 3D tab.

| Part | What it does |
|---|---|
| **New** | Empties the scene and starts again. It is one undo step like any other, so there is nothing to confirm. |
| **+** | One menu for everything a scene can gain. **Model…** adds the model selected in the [File Browser](other.md#file-browser) — you can also drag models straight into the 3D view, from the browser, the history strip or your desktop. **Camera** adds a camera where the view is right now. **Group** adds an empty one to hang things under. Then a box, sphere, plane, cylinder, cone or torus — no file needed, for blocking a scene out; it lands where the view is looking. Last, the two ways a whole scene arrives: **Import USD…** and **Load scene…**. |
| **Export** | The other direction: **Save scene…** writes the scene as a file, **Export USD…** as a stage, and **Render…** turns the shot into an mp4 or a PNG sequence. |
| **Right-click an item** | **Group**, **Duplicate** or **Delete**. A row inside the current selection acts on all of it — the menu says how many — and a row outside it selects itself first. A group takes what is inside it either way. |
| **↩ / ↪** | Undo and redo the last previz edit — see [Undoing](#undoing). Their tooltips name what they would take back. |
| **Move / Rotate / Scale** | Which gizmo the selected item gets. |
| **Globe** | The gizmo's axes: the world's, or — with the globe crossed out — the item's own. |
| The list | The scene as a tree. Click to select, <kbd>Shift</kbd>+click to select several, **◉** hides and shows, **▣** looks through a camera, **•** marks an item that has keyframes, and **▾** folds a group away. |
| Transform fields | The selected item's position, rotation (degrees) and scale — and a camera's field of view, or a shape's colour. |

The shot's **frame rate and length live on the timeline**, not in the panel: while previz is on, the **fps** box in the transport is the rate the shot plays, renders and exports at, and the **frame number at the end of the timeline** is its last frame — type a new one to make the shot longer or shorter. Everywhere else that number is the readout it has always been.

Navigation follows Maya: hold <kbd>Alt</kbd> and the left button tumbles, the middle button tracks and the right button dollies. The pointer says which it is — an arrow that picks and drags, a hand while <kbd>Alt</kbd> is held. Without <kbd>Alt</kbd> the left button belongs to the scene — click an object in the viewport to select it, or a camera's frustum lines, and drag the gizmo to move it. The numbers follow, and so does the scene. It is the same on every 3D tab, whether it holds one model or fifty.

| Key | Tool |
|---|---|
| <kbd>Q</kbd> | Select — puts the gizmo away |
| <kbd>W</kbd> | Move |
| <kbd>E</kbd> | Rotate |
| <kbd>R</kbd> | Scale |
| <kbd>X</kbd> | Switch the gizmo between **World** and **Local** axes |

These only answer on a previz tab, so <kbd>R</kbd> is still the red channel and <kbd>E</kbd> still the exposure drag on a picture. Like every viewer hotkey they can be rebound in **Settings → Keybinding**.

**Local / World** is the globe button next to the tool buttons. Local (the default, a crossed-out globe) lines the handles up with the item's own axes, so something you have turned still moves the way it faces; World (a globe) lines them up with the grid. Scaling is always along the item's own axes, as it is in every 3D app.

### Cameras

**▣** looks through a camera. Tumbling, tracking and dollying then move *that* camera — the panel's numbers follow as you drag — so lining up a shot is the same as looking at it. **▣** again returns to the free view, where cameras are drawn as frustums you can pick and move like anything else.

While you are looking through a camera it has no gizmo: there would be no handles on screen to grab. Step outside with **▣** to move it by hand.

### Shapes

The bottom half of the **+** menu drops a primitive into the scene: **Box**, **Sphere**, **Plane**, **Cylinder**, **Cone** or **Torus**. They need no file and are saved with the scene like anything else, so they cost nothing to keep around.

Each is built at unit size — a 1-unit box, a half-unit radius — and sized by its **Scale**, so the scale gizmo is also the size gizmo. A plane arrives lying flat and 10 units across, ready to be a floor, and is visible from both sides. Give a shape a **Colour** in the panel to tell your blocking apart; they animate exactly like a loaded model.

### Animation

Keyframes are per item and per property.

| Action | How |
|---|---|
| Key the selection where it stands | **Key @ *frame*** |
| Key one property only | The **◆** next to that row |
| Autokey | **Auto** — every move you make from then on keys the property it changed |
| Change a key | Go to its frame, move the item |
| Remove a key | **Delete key**, or double-click its tick on the timeline |
| Interpolation | **Smooth** (default), **Linear** or **Hold**, applied to new keys and to any key on the current frame |

Keyframes show as orange ticks under the timeline; click one to jump to it. Play, scrub and step work as they do for footage. A model's own clip is scrubbed by the same timeline, so the whole shot stays frame-accurate — there is no second clock playing underneath.

Rotations interpolate the short way round, so a turn from 350° to 10° moves 20°, not 340°.

### Groups

A **group** is a transform and nothing else — no geometry, no file. Move, rotate or scale it and everything inside moves with it; hide it and they all go; key it and they all follow. It is the same thing a USD `Xform` is, and an imported stage arrives as exactly that (see [USD](#usd)).

| To | Do |
|---|---|
| Group what is selected | Right-click one of them → **Group** |
| Make an empty one | **+ → Group** |
| Put something in it | Drag the item's row onto the group's row in the outliner |
| Take it out again | Drag the row onto the empty space below the tree |
| Fold it away | The **▾** at the left of its row |
| Delete the lot | Right-click the group → **Delete** — what it holds goes with it, and one undo brings all of it back |

Select several first — <kbd>Shift</kbd>+click in the outliner, or <kbd>Shift</kbd>+click objects in the viewport; every one of them is lit in the list and outlined in orange in the scene, while the last one clicked keeps the gizmo and the transform fields. **Group** then puts the lot under one new group, which is made with no transform of its own, so nothing moves.

An item's numbers are **local** to its group, exactly as in Maya, Houdini or USD: a chair at `x = -2` inside a set at `z = 10` stands at `-2, 0, 10` in the shot, and its own fields still read `-2, 0, 0`. Nothing can be dropped inside itself or inside its own contents, so the tree stays a tree.

A camera inside a group is carried by it like anything else, and still tumbles the way it always did — looking through it moves the camera, not the group.

### Undoing

Every previz edit can be taken back: adding, deleting and duplicating, a gizmo drag, a typed number, keying, retiming, the frame rate and the shot's length.

| Action | How |
|---|---|
| Undo | <kbd>Ctrl</kbd>+<kbd>Z</kbd>, or the ↩ button |
| Redo | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> or <kbd>Ctrl</kbd>+<kbd>Y</kbd>, or the ↪ button |

A whole drag is a single step, however many times the mouse moved. The buttons' tooltips name what they would undo or redo, and the last fifty steps are kept per tab. The keys answer only while a previz tab is hovered, so <kbd>Ctrl</kbd>+<kbd>Z</kbd> still belongs to the node graph everywhere else.

### The Curve Editor

Keys are also shown as a graph, in an **Animation Curves** panel of its own — a dock panel like the others, opened with the **curve graph** icon in the 3D toolbar. It used to share the strip above the timeline with the [Roto tool](other.md); a graph you drag keys around in wants height, and in a rail it can have it. Drag the bar between the panel and the picture to give it more, or stack it under the previz panel to work on one shot with both open.

The panel stays put while you click around the scene: with nothing animated selected it says so rather than disappearing.

It plots **value over time** — one curve per channel. That's the difference from Roto's editor: roto animates one shape, so its graph is about timing, while here every channel is a plain number in world units or degrees, and the useful question is what the number does.

#### Channels

The column down the left lists them the way a DCC does — **translate.x**, **rotate.y**, **scale.z**, and **fov** on a camera — each in the colour its curve is drawn in. Any set of them can be on screen at once, which is the point of a graph editor: translate.x against rotate.y is a question you can now ask.

| Action | How |
|---|---|
| Show one channel | Click its name |
| Add or remove one | <kbd>Shift</kbd>+click (or <kbd>Ctrl</kbd>+click) |
| What you get by default | Every channel the selected item animates |

A channel with no keys still draws, as the flat line its static value is — useful for seeing where a move would start from. Names in brighter text are the ones that have keys.

#### Keys and tangents

| Action | How |
|---|---|
| Retime a key | Drag it sideways. All three axes move together — one key holds the whole property, as it does everywhere else. |
| Change a value | Drag a key up or down; only the channel you grabbed changes. Hold <kbd>Shift</kbd> to retime without touching the value. |
| Remove a key | Double-click it |
| Show its tangents | Click it — the key takes a white ring and its handles appear |
| Shape the curve | Drag a handle. Both sides move together, so the curve stays smooth through the key. |
| Break the pair | <kbd>Alt</kbd>+drag a handle — the two sides then go their own way, for a corner |
| Back to the ease | Double-click a handle |

A key you have not touched has no tangents of its own: it behaves exactly as its ease says, and **Smooth**, **Linear** and **Hold** are drawn here as the curves they are. Dragging a handle writes the number that word was standing in for, so nothing switches mode — **Hold** stays stepped whatever the handles say, because a step has no curve to shape.

The white line is the current frame, and the graph spans the timeline's range.

### Rendering the Shot Back Into ComfyUI

The **bEpic 3D Scene (Previz)** node holds the scene and hands the rendered shot to your workflow.

1. Drop the node in and press **Open in Image Viewer** on it. The viewer opens on that node's tab as an empty scene — no run needed.
2. Build the shot. The scene is stored on the node, so it is saved with the workflow.
3. Set **render_name** on the node (the folder under `output/previz`).
4. Pick **Export → Render…**, set a size (1920×1080 to start with) and a format, and press **Go**. The viewer plays the shot through the active camera.
5. Run the workflow. The node reads the render back as `images`, plus `frame_count` and `fps`.

**MP4** is the usual choice: the frames are encoded into **`output/previz/<render_name>.mp4`** at the scene's frame rate and then deleted, so a take leaves one clip behind rather than a folder of stills. Encoding needs `imageio-ffmpeg`, the same encoder the viewer's video saving already uses. **PNG** skips the encoding and keeps the stills in **`output/previz/<render_name>/`** as `frame_0000.png` onwards — what you want for a single frame, or to take the render into another tool. A one-frame shot offers PNG first for that reason.

Either way the node reads what is there, and a new take clears whatever the last one left, so the two never mix. Frames travel to the server one at a time — a canvas can only hand over one picture — so a render interrupted part-way still leaves the frames it managed, and the node reads those.

The render is what the viewport draws, at the size you asked for — so it carries the same materials, grid and lighting you see. Hide the grid first if you don't want it in the render.

**Export → Save scene…** and **+ → Load scene…** keep a scene as a file in `output/3d_scenes`, for reuse across workflows.

### Where a Scene Lives

| Scene on… | Kept in | Survives |
|---|---|---|
| a **bEpic 3D Scene** node | the node, in the workflow | saving and reopening the workflow, and other machines |
| any other 3D tab | the viewer's own state | reloading the page |
| a saved scene file | `output/3d_scenes/<name>.json` | anything |

Models are referenced by path, not copied into the scene — so a scene opened on another machine needs those files at the same paths, or in [a folder the viewer may read](other.md#which-folders-the-viewer-can-open). A model dragged in from the desktop is the exception: it only exists in the browser, so it is copied into `input/3d` (where **Load 3D** reads from) to give the scene something it can find again.

An item whose file can't be loaded shows a red **!** in the list, with the reason behind it — rather than an empty spot in the scene.

## USD

Previz stages are read and written as **USD**, so a shot can leave this viewer for the rest of the pipeline and come back. `.usd`, `.usda`, `.usdc` and `.usdz` also open as ordinary 3D tabs.

### Viewing a stage

Open one like any other model — from the file browser, a drop, a loader node, or **+ → Model…** in previz. The stage is composed on the server (layers, references, payloads and variants all resolve through OpenUSD) and handed to the viewport as a flattened glTF copy, cached until the file changes. That copy is for looking at only; what the scene stores, and what is exported again, is the stage itself.

The flattening keeps geometry, transforms, visibility and `displayColor`, prefers the proxy purpose, and skips `guide` prims. Shading beyond `displayColor` is not carried — previz is about staging, and a viewport material would only pretend to be the look.

### Exporting a shot

**Export → Export USD…** writes the scene as a stage:

```
/previz                 Xform, the default prim, fps and range on the stage
  /previz/Set           Xform — a group, with what it holds beneath it
    /previz/Set/Hero    Xform + payload → hero.usd
    /previz/Set/Floor   UsdGeomPlane, displayColor
  /previz/ShotCam       UsdGeomCamera, focalLength on a 36×24 back
```

[Groups](#groups) go out as nested `Xform`s and each item keeps its local transform, so the stage another application opens has the hierarchy you built rather than a flattened list.

Assets arrive as **payloads**, not references, so the stage opens instantly and an application loads only what it needs — which is what a previz stage is for.

Animation is **baked per frame**, because USD interpolates linearly between time samples and has no concept of easing: a Smooth key would otherwise arrive somewhere else. The scene's own keys ride along in `customData`, so re-importing a stage this viewer wrote restores the exact keys rather than a per-frame bake.

Give a plain name and the stage lands in `output/3d_scenes`; give a full path ending in `.usda` or `.usdc` and it writes there, as long as it is [a folder the viewer may write to](other.md#which-folders-the-viewer-can-open).

### Importing a stage

**+ → Import USD…** builds the scene from a stage — one made here, or one from anywhere else:

| In the stage | Becomes |
|---|---|
| `UsdGeomCamera` | a previz camera, its focal length read back as a field of view |
| A prim with a payload or reference | one item, drawn from that prim |
| A prim marked `component` in the model hierarchy | one item — an asset is a thing you move, not a hundred things |
| Geometry with no such ancestor | one item of its own |
| Every `Xform` above one of those | a [group](#groups), so the stage's hierarchy is the outliner's |
| `Cube`, `Sphere`, `Cylinder`, `Cone`, `Plane` | the matching previz shape, with its `displayColor` |
| Time samples on the transforms | keyframes, with linear easing — which is what USD samples mean |
| `timeCodesPerSecond`, start and end | the shot's fps and length |

Nothing below a chosen prim is taken again, so a kitchen arrives as its furniture rather than as every cupboard door.

Each item keeps the **local** transform it was authored with, and the groups above it carry the rest — the same arrangement the stage has, so moving a set moves its furniture and a group that animates animates what it holds. Geometry is addressed as the stage plus that prim path: the server flattens only that subtree, in the prim's own space, and the stage's composition — variants, nested payloads, the transforms inside the asset — is what you see.

Files are fetched by their own path, so a stage anywhere in your [allowed folders](other.md) can be imported, not only one under ComfyUI's output.

Payloads are composed while reading, since a layout stage keeps its geometry behind them. A prim whose asset can't be composed — a missing file, or a type the local prim overrides — is still kept, showing as an empty item with a red **!** and the reason, rather than quietly disappearing from the layout.

### What doesn't survive

- An **FBX or GLB** asset can't be payloaded — USD payloads point at USD layers. Those items export as an empty xform with the file path in `customData`: this viewer finds them again, another application sees an empty group where they sit.
- Materials, lights, variants and per-prim purposes in an imported stage are left in the stage; previz only takes transforms, cameras and geometry.
- Easing is this viewer's own idea, so a stage read by another application sees the baked frames.

USD support needs `usd-core`, which installs with the node.

## Moving Models Onto the Graph

Drag a model's history thumbnail or browser row onto the graph and you get a **Load 3D** node holding it. Drop it onto an existing Load 3D node to swap that node's model. Load 3D reads from `input/3d`, so the file is copied there.

## Limits

- A glTF's `.bin` and textures and an FBX's external textures are looked up next to the model file. A model dropped in from the desktop has no folder, so it shows without them.
- OBJ files show their geometry only; an `.mtl` material file isn't read.
- Draco- and KTX2-compressed glTF files aren't supported yet.
- A USD stage is shown through a flattened copy, so its materials and variants are not visible in the viewport.
- Gaussian splats and USDZ can be saved but not shown.
- three.js (r180, the version ComfyUI uses) ships with the node and only loads when a model tab first opens.
- Previz has no lights of its own yet: a scene is lit by the same fixed rig ComfyUI's *Load 3D* uses.
- Compare, contact sheet and the drawing tools don't apply to a 3D tab.

---

← [Other Features](other.md) | Next: [Node Reference](nodes.md)

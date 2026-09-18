# 3D Models

← [Back to index](../index.md)

---

The viewer shows 3D models in a tab of their own, the way ComfyUI's **Save 3D Model** / **Load 3D** nodes do: same lighting, grid, camera and material modes, and it follows ComfyUI's *Load 3D* settings for background colour, grid and light intensity.

Supported formats: **GLB**, **glTF**, **FBX**, **OBJ**, **STL** and **PLY** (meshes and point clouds).

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

A 3D tab starts with one model. Press **Previz** in the 3D toolbar and that tab becomes a scene you can build on: several models, cameras, and keyframes on the viewer's own timeline. Pressing it again leaves previz — the scene is kept, so you can go back to it.

### The Panel

| Part | What it does |
|---|---|
| **+ Model** | Adds the model selected in the [File Browser](other.md#file-browser). You can also drag models straight into the 3D view, from the browser, the history strip or your desktop. |
| **+ Camera** | Adds a camera where the view is right now. |
| **Duplicate / Delete** | Copies or removes the selected item, animation included. |
| **Move / Rotate / Scale** | Which gizmo the selected item gets. |
| The list | Every item in the scene. Click to select, **◉** hides and shows, **▣** looks through a camera, **•** marks an item that has keyframes. |
| Transform fields | The selected item's position, rotation (degrees) and scale — and a camera's field of view. |
| **fps / frames** | The shot's frame rate and length. The viewer's timeline covers exactly this range while previz is on. |

Navigation follows Maya: hold <kbd>Alt</kbd> and the left button tumbles, the middle button tracks and the right button dollies. Without <kbd>Alt</kbd> the left button belongs to the scene — click an object in the viewport to select it, or a camera's frustum lines, and drag the gizmo to move it. The numbers follow, and so does the scene. (On a plain one-model tab there is nothing to select, so left-drag orbits there as it always did.)

| Key | Tool |
|---|---|
| <kbd>Q</kbd> | Select — puts the gizmo away |
| <kbd>W</kbd> | Move |
| <kbd>E</kbd> | Rotate |
| <kbd>R</kbd> | Scale |
| <kbd>X</kbd> | Switch the gizmo between **World** and **Local** axes |

These only answer on a previz tab, so <kbd>R</kbd> is still the red channel and <kbd>E</kbd> still the exposure drag on a picture. Like every viewer hotkey they can be rebound in **Settings → Keybinding**.

**World / Local** is also a button next to the tool buttons. World lines the handles up with the grid; Local lines them up with the item's own axes. Scaling is always along the item's own axes, as it is in every 3D app.

### Cameras

**▣** looks through a camera. Orbiting, panning and zooming then move *that* camera, so lining up a shot is the same as looking at it. **▣** again returns to the free view, where cameras are drawn as frustums you can pick and move like anything else.

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

Keyframes show as orange ticks under the timeline; click one to jump to it. Play, scrub and step work as they do for footage. A model with its own animation (an FBX clip) is scrubbed by the timeline too, so the whole shot stays frame-accurate.

Rotations interpolate the short way round, so a turn from 350° to 10° moves 20°, not 340°.

### Rendering the Shot Back Into ComfyUI

The **bEpic 3D Scene (Previz)** node holds the scene and hands the rendered shot to your workflow.

1. Drop the node in and press **Open in Image Viewer** on it. The viewer opens on that node's tab as an empty scene — no run needed.
2. Build the shot. The scene is stored on the node, so it is saved with the workflow.
3. Set **render_name** on the node (the folder under `output/previz`).
4. Press **Render…** in the panel, set a size, and press **Go**. The viewer plays the shot through the active camera and the server encodes it into **`output/previz/<render_name>.mp4`** at the scene's frame rate.
5. Run the workflow. The node reads that clip back as `images`, plus `frame_count` and `fps`.

Frames travel to the server one at a time — a canvas can only hand over one picture — and are deleted once the clip is written, so a take leaves one mp4 behind rather than a folder of stills. If a render is interrupted before it finishes, the frames it did upload stay in `output/previz/<render_name>/` and the node reads those instead, so nothing is lost. Encoding needs `imageio-ffmpeg`, the same encoder the viewer's video saving already uses.

The render is what the viewport draws, at the size you asked for — so it carries the same materials, grid and lighting you see. Hide the grid first if you don't want it in the render.

**Save** and **Load** keep a scene as a file in `output/3d_scenes`, for reuse across workflows.

### Where a Scene Lives

| Scene on… | Kept in | Survives |
|---|---|---|
| a **bEpic 3D Scene** node | the node, in the workflow | saving and reopening the workflow, and other machines |
| any other 3D tab | the viewer's own state | reloading the page |
| a saved scene file | `output/3d_scenes/<name>.json` | anything |

Models are referenced by path, not copied into the scene — so a scene opened on another machine needs those files at the same paths, or in [a folder the viewer may read](other.md#which-folders-the-viewer-can-open). A model dragged in from the desktop is the exception: it only exists in the browser, so it is copied into `input/3d` (where **Load 3D** reads from) to give the scene something it can find again.

An item whose file can't be loaded shows a red **!** in the list, with the reason behind it — rather than an empty spot in the scene.

## Moving Models Onto the Graph

Drag a model's history thumbnail or browser row onto the graph and you get a **Load 3D** node holding it. Drop it onto an existing Load 3D node to swap that node's model. Load 3D reads from `input/3d`, so the file is copied there.

## Limits

- A glTF's `.bin` and textures and an FBX's external textures are looked up next to the model file. A model dropped in from the desktop has no folder, so it shows without them.
- OBJ files show their geometry only; an `.mtl` material file isn't read.
- Draco- and KTX2-compressed glTF files aren't supported yet.
- Gaussian splats and USDZ can be saved but not shown.
- three.js (r180, the version ComfyUI uses) ships with the node and only loads when a model tab first opens.
- Previz has no lights of its own yet: a scene is lit by the same fixed rig as a single model.
- Compare, contact sheet and the drawing tools don't apply to a previz tab.

---

← [Other Features](other.md) | Next: [Node Reference](nodes.md)

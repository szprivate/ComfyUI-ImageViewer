# ComfyUI Image Viewer — Documentation

A professional floating image viewer for ComfyUI — one shared history in groups, side-by-side comparison, playback timeline, exposure/channel controls, and a live parameter panel.

![ComfyUI Image Viewer main interface](screenshots/viewer_2d_canvas.jpg)

---

## What is ComfyUI Image Viewer?

ComfyUI Image Viewer is a custom node extension for [ComfyUI](https://github.com/comfyanonymous/ComfyUI) that replaces the built-in preview with a powerful, dockable viewer panel. Instead of hunting through tiny preview nodes scattered across your canvas, every output is routed here — sorted into named groups, kept in a scrollable history, and ready for detailed inspection.

## Key Features

| Feature | Description |
|---|---|
| **One Viewer, Grouped** | Every picture, video and sound goes into the Viewer tab; each Send node's renders are a named group. Documents (cuts, Paint, 3D, Motion) get tabs of their own. |
| **History Snapshots** | One History for all tabs, 100 snapshots by default, in groups you fold, rename and drag thumbnails between. Navigate with ↑ ↓. |
| **Sound Files** | WAV, MP3, FLAC, OGG, M4A, AAC and Opus play with their waveform on screen. |
| **Overlays & Full Screen** | <kbd>S</kbd> hides everything drawn over the picture; <kbd>Shift</kbd>+<kbd>F</kbd> makes the canvas fill the screen. |
| **Dependencies** | With agentY: what a file was made from and what was made from it, as a top-to-bottom node graph with out-of-date files marked. |
| **Image Comparison** | Vertical or horizontal split with a draggable divider. Compare tabs or history items. |
| **Playback & Timeline** | Play image sequences, set FPS, loop modes, scrub frames, select sub-ranges. |
| **Exposure & Channels** | ±4 EV exposure slider. Isolate R/G/B channels for data inspection. |
| **Parameter Panel** | Live widget values for the selected ComfyUI node — editable in the viewer. |
| **File Browser** | Browse ComfyUI's folders — and any you allow — in a panel: every file listed, a wildcard filter and a kind filter, previews of images and video, and drag files into the viewer or onto the graph. |
| **Send from Any Node** | Right-click a VHS / native / AYON loader → *Send to Image Viewer*, or any image-producing node to run just its branch. |
| **Frame to Graph** | Shift-drag the timeline onto the graph for a Load Image node holding the frame on screen — a video frame is extracted to a PNG beside the clip, or to `output/extracted_frames` for clips outside ComfyUI's folders. |
| **Dockable Panels** | Drag any panel by its title bar to either side of the picture, or stack it above another. Splitters between them, arrangement remembered. |
| **3D Models** | View GLB, glTF, FBX, OBJ, STL, PLY and Alembic (`.abc`) caches like ComfyUI's Save 3D Model does, and save meshes and 3D files from the send node. |
| **3D Previz** | Build a scene from models and primitive shapes in a Maya-style **Outliner** (groups, drag to reorder and reparent, rename) and **Channel Box**; move, rotate and scale with a gizmo, pivots included; tumble about what is under the cursor; keyframe on a curve editor with tangents; cameras with a **resolution gate**; **Freeze Transformations**; and render the shot back into the workflow from a **render dialog** — MP4, MOV, WebM or PNG, any camera, any range, anti-aliased. |
| **Hotkeys for Everything** | Every viewer and 3D function is a ComfyUI command you can bind in Settings → Keybinding. |
| **History & Assets** | What *Send To Image Viewer* writes is reported to ComfyUI like a save node's output — it shows up in the queue history, the Assets panel, and to any tool reading them. |
| **Image Planes** | Stand a picture in a scene — the plate you are matching, a reference, or a backplate parented to a camera. |
| **USD Stages** | Open `.usd` / `.usdz` assets, and export or import whole previz shots as USD — payloaded assets, baked animation, cameras. |
| **Undock / Multi-Monitor** | Pop the viewer into its own browser window for a second screen. |

## How It Works

The extension registers a floating panel (`<comfyui-image-viewer-panel>`) using the Web Components API with Shadow DOM — so its styles never conflict with ComfyUI's own UI. On the backend, a **Send To Image Viewer** node converts image tensors to PNG, saves them to ComfyUI's temp directory, and pushes a `imageviewer.viewer.update` WebSocket message to the frontend. The viewer picks it up and populates the relevant tab automatically.

All viewer state — open tabs, history stacks, panel positions, layouts — is persisted to `localStorage` so your workspace survives page reloads.

## Quick Start

1. Install the extension via ComfyUI Manager or git clone into `custom_nodes/`. See [Installation](../README.md#installation).
2. Click **Image Viewer** in the ComfyUI action bar to open the panel.
3. Add a **Send To Image Viewer** node to your workflow and connect any image output to its `input` pin.
4. Set an optional `group` on the node, then run your workflow. The image appears in the viewer instantly, under that group.
5. Hover the panel and press `?` for the built-in hotkey overlay at any time.

## Documentation

| Page | What you will learn |
|---|---|
| [Viewer Interface](sub/interface.md) | Anatomy of every panel and control |
| [Tabs & History](sub/tabs-history.md) | The Viewer tab, groups, navigating history, context menu, Dependencies, working with agentY |
| [Image Comparison](sub/comparison.md) | Split view, contact sheet, comparing history snapshots |
| [Playback Controls](sub/playback.md) | Playing sequences, timeline scrubbing, loop modes, sub-range |
| [Channels & Exposure](sub/channels-exposure.md) | Exposure slider, RGB isolation, interactive E-drag |
| [Parameter Panel](sub/params-panel.md) | Live node params, lock, dock, resize |
| [3D Models & Previz](sub/models-3d.md) | Viewing and saving meshes; building, animating and rendering a previz shot; USD |
| [Other Features](sub/other.md) | File browser, send from loader nodes, undocking, layouts, cache management |
| [Node Reference](sub/nodes.md) | Full input/output spec for the ImageViewerSend node |
| [Keyboard Shortcuts](sub/hotkeys.md) | Complete hotkey reference, and how to rebind the keys in ComfyUI's keybinding editor |




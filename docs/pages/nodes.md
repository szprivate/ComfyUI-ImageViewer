# Nodes

[Home](../index.md)

## Send To Image Viewer

Shows images, masks, videos, sounds and 3D models in the viewer. Its output, `image`, is the input passed through.

| Input | What it does |
|---|---|
| `group` | The History group its renders go into. Empty: named after the node feeding it |
| `label` | Shown on the thumbnail |
| `save_to_output` | Also write the result to ComfyUI's output folder |
| `file_format` | png, exr, tiff, jpg, dpx, tga, webp, mp4, mov, webm; for 3D: glb, gltf, obj, ply, stl, usd |
| `filename_prefix` | Where and under what name it saves, e.g. `shots/shotA` |
| `is_sequence` | Name still frames for a VFX pipeline: `shotA_v001.1001.png`. Each run is a new version, never overwritten |
| `first_frame_number`, `padding` | With `is_sequence`: the first frame's number (1001) and its digits (4) |

Only the settings the chosen format has are shown (bit depth, compression, quality). Saved PNGs carry the workflow, like Save Image; a video gets a PNG beside it that does. What the node writes is reported to ComfyUI like a save node's output, so it shows in the queue history and the Assets panel.

A 3D input opens as a [3D tab](3d.md). A video with an odd width or height is padded by one pixel so it can be encoded.

Workflows saved with the old `tab_name` field still load; its value is used as the group.

## Roto and SAM3 Collector

**Image Viewer Roto** takes an `image` and outputs `roto_mask` (the matte you draw) and the `image`. **Image Viewer SAM3 Collector** takes an `image` and outputs positive and negative points and boxes, shaped for ComfyUI-SAM3.

You draw with the viewer's Roto and SAM3 tools; the shapes are stored on the node and travel with the workflow. The tool works on the node selected on the graph. With none, pressing the tool's button adds one, wired to the selected node or to the picture on screen.

## Image Viewer 3D Scene (Previz)

Holds a [previz scene](3d.md) and hands its render to the workflow.

| | |
|---|---|
| Inputs | `render_name` (the render's folder under `output/previz`), `model` (optional, added to the scene) |
| Outputs | `images`, `frame_count`, `fps` |

**Open in Image Viewer** on the node opens its scene. Until you render (**Export ▸ Render…**), it outputs one black frame.

# ComfyUI Image Viewer

A panel for [ComfyUI](https://github.com/comfyanonymous/ComfyUI) to look at what a workflow makes, compare it, cut it, paint on it, comp it and stage 3D shots, without leaving the graph.

![The Viewer with the History beside it](docs/images/viewer.png)

## Spaces

| Space | For |
|---|---|
| [Viewer](docs/pages/viewer.md) | Pictures, sequences, videos and sounds: zoom, compare, contact sheets, exposure, OCIO, roto / SAM3 / annotation tools |
| [Edit](docs/pages/edit.md) | Cutting films on an OpenTimelineIO timeline, with sound, titles and effects; export a film or to DaVinci Resolve |
| [Paint](docs/pages/paint.md) | A picture in layers, with masks, adjustments and AI fills; saves `.ora` and `.psd` |
| [3D](docs/pages/3d.md) | GLB, FBX, USD, Alembic and splats; previz shots, rigs and animation rendered back into the workflow |
| [Motion](docs/pages/motion.md) | Motion graphics scenes an agent wrote |
| [Comp](docs/pages/comp.md) | A node graph of pixel operations in linear float; renders frames or a film, exports to Nuke |

## Panels

[History](docs/pages/history.md) (every render, in groups), the [file browser](docs/pages/workspace.md#file-browser), [Parameters](docs/pages/workspace.md#parameters), [Agent code](docs/pages/agent-code.md) and [Dataset](docs/pages/dataset.md), docked where you like. The viewer docks beside the canvas or opens in its own window.

Also: [Dependencies](docs/pages/dependencies.md) (what a file was made from) and [agentY](docs/pages/agentY.md) integration.

**All the docs: [docs/index.md](docs/index.md).**

## Installation

### ComfyUI Manager (recommended)

1. Open the **ComfyUI Manager**, search for **ComfyUI-ImageViewer** and click **Install**.
2. Restart ComfyUI.

### Manual

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/szprivate/ComfyUI-ImageViewer.git
pip install -r ComfyUI-ImageViewer/requirements.txt
```

Restart ComfyUI. Use ComfyUI's own Python for the `pip install`.

Saving videos and previz renders needs `imageio-ffmpeg` (VideoHelperSuite installs it, or `pip install imageio-ffmpeg`).

### First steps

Click **Image Viewer** in ComfyUI's top bar, wire a **Send To Image Viewer** node into your workflow and run it. Hover the panel and press <kbd>?</kbd> for the keys.

## Trademarks and independence

ComfyUI Image Viewer is an independent project. It is not affiliated with, endorsed by, sponsored by or otherwise connected to Adobe Inc. or any other software maker named in this repository.

Adobe and Photoshop are trademarks or registered trademarks of Adobe Inc. in the United States and/or other countries. DaVinci Resolve, Krita, GIMP and other names are trademarks of their owners. They are named here only to say which file formats and workflows the viewer works with, or to describe a feature by the behaviour people know from them. Naming them does not claim any connection to their owners.

Paint is a clean-room implementation. It contains no source code, binaries, brushes, presets, icons or other assets from Adobe products, and no code taken from other image editors. Its tools are written from how they behave and from publicly available sources, such as published research papers (for example "Poisson Image Editing", Pérez et al., 2003) and Adobe's publicly published Photoshop file-format specification for reading and writing `.psd` files. Reading `.abr` brush files only reads the brush shapes stored in files you provide yourself. No Adobe brushes ship with this project.

Paint's Generate workflows (`src/paint_workflows/`) are copies of workflows from ComfyUI's official workflow templates (Comfy-Org/workflow_templates), trimmed and with their inputs named for Paint. They name model files and where to download them; no model weights are part of this repository.

If you own rights in something in this repository and think it should not be here, please open an issue and it will be looked at promptly.

## License, contributing

Copyright © 2026 bEpic GmbH / Sebastian Zilius

**Free for personal and non-commercial use.**

- ✅ Personal projects, research, education, and non-commercial creative work
- ✅ Feel free to create your own fork and make updates - this is OpenSource, happy to include your Pull Requests if they're good!

- ❌ Commercial use of any kind is **prohibited** without explicit written permission from the author

Redistribution, modification, and use in source and binary forms are permitted **for non-commercial purposes only**, provided that this copyright notice is retained in all copies or substantial portions of the software.

For commercial licensing enquiries, contact the repository owner.

THIS SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.

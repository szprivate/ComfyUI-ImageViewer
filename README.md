# ComfyUI Image Viewer

A viewer panel for [ComfyUI](https://github.com/comfyanonymous/ComfyUI): look at what your workflow makes, compare it, cut it, paint on it and stage 3D shots, without leaving the graph.

![The Viewer with the History beside it](docs/images/viewer.png)

## Features

- **Viewer**: pictures, image sequences, videos and sounds. Zoom, full screen, exposure, single channels, OpenColorIO input colourspaces.
- **Compare**: wipe two renders, or lay up to 16 side by side on a contact sheet. Videos play in step.
- **History**: every render from every tab, kept in groups you can fold, rename and drag between.
- **Editor**: cut films on a timeline (OpenTimelineIO), with sound, titles, effects and keyframes. Export the film, or hand it to DaVinci Resolve.
- **Paint**: a picture in layers, with brushes, selections, masks, adjustment layers and text. Saves `.ora` and `.psd`.
- **3D & Previz**: open GLB, FBX, OBJ, USD, Alembic and Gaussian splats, build and animate a shot, render it back into the workflow.
- **Motion**: edit motion graphics scenes an agent wrote.
- **Drawing tools**: roto mattes, SAM3 prompts and annotations, straight onto the picture.
- **Panels**: a file browser, the selected node's Parameters, Agent code and Dataset, docked where you like. The viewer docks beside the canvas or opens in its own window.
- **Dependencies**: what a file was made from and what was made from it, from the workflows saved with the files.
- **agentY**: tags, approvals and AI edits when [agentY](https://github.com/szprivate/agentY) is running.

How it all works: **[the docs](docs/index.md)**.

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

## License, contributing

Copyright © 2026 bEpic GmbH / Sebastian Zilius

**Free for personal and non-commercial use.**

- ✅ Personal projects, research, education, and non-commercial creative work
- ✅ Feel free to create your own fork and make updates - this is OpenSource, happy to include your Pull Requests if they're good!

- ❌ Commercial use of any kind is **prohibited** without explicit written permission from the author

Redistribution, modification, and use in source and binary forms are permitted **for non-commercial purposes only**, provided that this copyright notice is retained in all copies or substantial portions of the software.

For commercial licensing enquiries, contact the repository owner.

THIS SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.

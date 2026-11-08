# Reference

[Home](index.md)

## Folders

The viewer opens files only from ComfyUI's input, output and temp folders and the folders you allow, and writes only into ComfyUI's own folders. A workflow's loader nodes are not limited by this.

Allow more folders in **Settings ▸ ComfyUI Image Viewer ▸ Folders**, or:

- list them, one per line, in `~/.comfyui_image_viewer/roots.txt` on the ComfyUI machine, or
- set `IMAGE_VIEWER_ROOTS` (separated by `;` on Windows, `:` elsewhere).

Both are read on every request, so no restart is needed.

## Environment variables

| Variable | What it does |
|---|---|
| `IMAGE_VIEWER_ROOTS` | Extra folders the viewer may open |
| `IMAGE_VIEWER_ROOTS_FILE` | Another file instead of `roots.txt` |
| `IMAGE_VIEWER_ROOTS_LOCKED=1` | Folders can't be changed from the settings page |
| `IMAGE_VIEWER_ROOTS_REMOTE_EDIT=1` | Folders can be changed from another machine's browser |
| `IMAGE_VIEWER_SETTINGS` | Another file for the per-user settings (default `~/.comfyui_image_viewer/settings.json`) |
| `IMAGE_VIEWER_TEMP_BUDGET_MB` | Preview frames kept per node, in MB (default 4096) |
| `IMAGE_VIEWER_TEMP_MAX_RUNS` | Renders kept per node (default 20) |

## Temp files

What a Send node shows is written to ComfyUI's temp folder as `ImageViewer_*` files. Each node keeps its newest renders within the two limits above and deletes older ones. The trash button in the lower bar deletes them all and clears the History.

## Python packages

`requirements.txt` installs Pillow, numpy, usd-core and trimesh. Optional:

- `imageio-ffmpeg` for saving videos and previz renders (VideoHelperSuite installs it),
- OpenImageIO for EXR, TIFF and DPX settings,
- PyOpenColorIO for the input colourspace menu (without it: sRGB and Linear only).

## For scripts and agents

- `POST /imageviewer/push` shows files in the viewer: `{paths, group, label, focus, play, panel}`. A path can be a file, a folder, an image sequence (`f_%04d.png`) or an `.otio`. `panel: "edit"` opens the cut beside the first film, `panel: "paint"` opens the picture in Paint.
- `POST /imageviewer/deps` with `{"path": <file>}` (or `filename` / `subfolder` / `type`, and `scan`) returns the Dependencies graph, read in ComfyUI.
- `POST /imageviewer/previz_shot` opens and renders a previz shot; poll `GET /imageviewer/previz_shot?id=`.
- `GET /imageviewer/health` answers 200 when the viewer is running.
- In the page, `window.imageViewerApi.viewerState()` says what is on screen, and `.annotations()` the marks on it.

Every route that takes a path obeys the folder rules above. Routes that change something are POST only. No route starts a process.

## Design notes

- [Motion graphics: format and renderer](dev/motion-graphics-design.md)
- [Dataset: files and routes](dev/lora-dataset-design.md)

# Node Reference

← [Back to index](../index.md)

---

## bEpic Send To Image Viewer

Sends images to the Image Viewer. Lay down the node in the canvas, connect an image / mask to the node's input, and set the tab_name to any name you want.
If you don't specify a name, the name of the connected node will be used.

### Category

---

## Backend API Endpoints

The extension registers the following HTTP routes on the ComfyUI server. These are used internally by the viewer frontend but can also be called directly.

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/bepic/open_path` | Open a folder path in the OS file explorer |
| GET | `/bepic/raw_view?path=…` | Serve a bEpic temp PNG securely |
| GET | `/bepic/view_file?path=…` | Serve an external image file |
| GET | `/bepic/pick_folder` | Open a native folder picker dialog |
| GET | `/bepic/clear_cache` | Delete all `bEpic_*` temp files |
| GET | `/bepic/viewer` | Standalone viewer-only HTML page |
| GET | `/bepic/health` | Health check — returns 200 if running |

---

← [Advanced Features](advanced.md) | Next: [Keyboard Shortcuts](hotkeys.md)
